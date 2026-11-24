/**
 * Refresh the scanner eval cassettes (tests/fixtures/scanner-golden/cassettes/<case>.json).
 *
 *   npm run eval:record                       offline: re-key hand-written entries after a prompt or skill change
 *                                             (matched by label: pass time + item titles), list calls with no entry
 *   npm run eval:record -- --show-missing     offline: also print each missing call's user prompt (placeholder data)
 *                                             so a person can hand-write its reply
 *   npm run eval:record -- --live --yes-spend COSTS MONEY: replays every golden case against the live completion
 *                                             model (Haiku, via the Claude gateway) and overwrites the cassettes with
 *                                             its replies. Every call is booked in llm_calls (DATABASE_URL required).
 *                                             Never run in CI; refuses without a configured gateway.
 *   --case <id>                               only that case
 *
 * Reads and writes only fixture files (and, live, the ledger). Prints ids, hashes, labels and counts; never tokens.
 */
import fs from 'node:fs';

import { claudeGatewayConfig } from '../../src/llm/claude-env';
import { CassetteMissError, cassetteModel, recordingModel, type CassetteEntry, type CassetteFile } from '../../src/scanner/completion/cassette';
import { COMPLETION_SKILL_KEY, COMPLETION_SKILL_PATH } from '../../src/scanner/completion/pass';
import type { CompletionModel } from '../../src/scanner/completion/types';
import { loadSkill } from '../../src/llm/skill-loader';
import { cassettePath, loadGoldenCases, type GoldenCase } from '../../tests/evals/scanner/golden';
import { completionLabel, runCase } from '../../tests/evals/scanner/harness';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const only = args.includes('--case') ? args[args.indexOf('--case') + 1] : undefined;
const skill = loadSkill(COMPLETION_SKILL_PATH).versionTag;

function readCassette(id: string): CassetteFile {
  const p = cassettePath(id);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as CassetteFile) : { version: 1, entries: [] };
}

function writeCassette(id: string, c: CassetteFile): void {
  fs.writeFileSync(cassettePath(id), `${JSON.stringify(c, null, 2)}\n`);
}

const cases = loadGoldenCases().filter((c) => !only || c.id === only);
if (only && !cases.length) {
  console.error(`eval:record: no golden case ${only}`);
  process.exit(2);
}

async function offline(): Promise<number> {
  let missing = 0;
  for (const c of cases) {
    const file = readCassette(c.id);
    const cas = cassetteModel({ skill, entries: file.entries, labelOf: completionLabel, mode: 'rekey' });
    const prompts = new Map<string, string>();
    // A miss answers "no verdicts" here so the rest of the case still runs and every missing call is listed.
    const model: CompletionModel = async (req) => {
      try {
        return await cas.model(req);
      } catch (err) {
        if (!(err instanceof CassetteMissError)) throw err;
        prompts.set(err.hash, req.user);
        return { ok: true, text: '{"verdicts":[]}', costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }
    };
    await runCase(c, model);
    const unused = file.entries.filter((e) => !e.hash || !cas.used.has(e.hash));
    if (cas.rekeyed.length) writeCassette(c.id, file);
    console.log(`${c.id}: ${cas.used.size} replayed, ${cas.rekeyed.length} re-keyed, ${cas.misses.length} missing, ${unused.length} unused`);
    for (const m of cas.misses) {
      missing += 1;
      console.log(`  missing ${m.hash}  label "${m.label}"`);
      if (flag('--show-missing')) console.log(`    user prompt: ${prompts.get(m.hash)}`);
    }
    for (const u of unused) console.log(`  unused  ${u.hash ?? '(no hash)'}  label "${u.label}"`);
  }
  return missing ? 1 : 0;
}

async function live(): Promise<number> {
  if (process.env.CI) {
    console.error('eval:record --live refuses to run in CI: it calls a paid model.');
    return 2;
  }
  if (!flag('--yes-spend')) {
    console.error('eval:record --live calls the live completion model and COSTS MONEY (about $0.01-0.05 per golden case). Re-run with --yes-spend to confirm.');
    return 2;
  }
  const gw = claudeGatewayConfig();
  if (!Object.keys(gw.env).length && !gw.apiKeyHelper) {
    console.error('eval:record --live: no Claude gateway is configured on this machine (no env or apiKeyHelper in the Claude settings file). Nothing was called. Run it on a machine with the gateway set up.');
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error('eval:record --live: DATABASE_URL is required so every call is booked in llm_calls. Nothing was called.');
    return 2;
  }
  const [{ agentSdkCompletionModel }, { createDb }, { insertLlmCall, ledgerHash }, { sql }] = await Promise.all([import('../../src/scanner/completion/llm'), import('../../src/db/client'), import('../../src/db/ledger'), import('drizzle-orm')]);
  const h = createDb({ max: 2, applicationName: 'command-center-eval-record' });
  try {
    const owner = ((await h.db.execute(sql`select id::text as id from users order by created_at limit 1`)).rows[0] as { id?: string } | undefined)?.id;
    if (!owner) {
      console.error('eval:record --live: no user in the database to book calls against. Nothing was called.');
      return 2;
    }
    const base = agentSdkCompletionModel();
    // Book every call before its reply is used (D0 audit fields: trigger, model reason, outcome, content hash).
    const booked: CompletionModel = async (req) => {
      const started = new Date();
      const res = await base(req);
      await insertLlmCall(h.db, {
        ownerUserId: owner,
        purpose: 'other',
        model: req.model,
        skillKey: COMPLETION_SKILL_KEY,
        promptVersion: skill,
        status: res.ok ? 'ok' : 'error',
        ...(res.ok ? {} : { errorCode: res.error?.errorClass ?? 'unknown' }),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        cacheReadTokens: res.cacheReadTokens ?? 0,
        cacheWriteTokens: res.cacheWriteTokens ?? 0,
        costUsd: res.costUsd,
        budgetDay: started.toISOString().slice(0, 10),
        startedAt: started,
        finishedAt: new Date(),
        trigger: 'eval_record',
        modelReason: 'default',
        contentHash: ledgerHash(req.model, skill, req.system, req.user),
        outcome: res.ok ? 'ok' : `error:${res.error?.errorClass ?? 'unknown'}`,
      });
      return res;
    };
    let total = 0;
    for (const c of cases as GoldenCase[]) {
      const rec = recordingModel(booked, { skill, labelOf: completionLabel });
      await runCase(c, rec.model);
      total += rec.costUsd();
      const entries: CassetteEntry[] = rec.entries;
      writeCassette(c.id, { version: 1, note: `recorded live with ${skill}`, entries });
      console.log(`${c.id}: ${entries.length} calls recorded, $${rec.costUsd().toFixed(4)}`);
    }
    console.log(`eval:record --live: $${total.toFixed(4)} spent, booked in llm_calls (trigger eval_record).`);
    return 0;
  } finally {
    await h.close();
  }
}

process.exitCode = await (flag('--live') ? live() : offline());
