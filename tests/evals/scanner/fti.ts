/**
 * The FTI (fetch-then-interpret) side of the scanner evals: the golden cases through the real interpret step (rules,
 * candidates, the batched classifier replayed from hand-written cassettes, the cc handlers), next to the oracle
 * agent, with recall, precision and an estimated cost per item for each path (the A/B gate, review 04 §4.6 #6).
 *
 * Cassettes: tests/fixtures/scanner-golden/cassettes-fti/<case>.json, keyed by the classifier's ledger hash
 * (`ledgerHash(model, classify-items@version, system, user)`, the same mechanism as the completion cassettes). After a
 * prompt or skill change, re-key them offline: `CC_EVAL_REKEY=1 npm run test:evals` (matches by label: the pass and
 * the refs of the batch, no message text).
 *
 * Costs are estimates from token counts (no gateway here): src/scanner/interpret/estimate.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

import { commonSkillPathFor, loadSkill, renderContextPack } from '@/llm/skill-loader';
import { cassetteModel, type Cassette, type CassetteEntry, type CassetteFile } from '@/scanner/completion/cassette';
import type { CompletionModel, CompletionModelRequest } from '@/scanner/completion/types';
import { CLASSIFY_SKILL_PATH, interpretRun, type ClassifierCall, type ClassifierModel, type InterpretResult } from '@/scanner/interpret';
import { agenticRunUsd, AGENTIC_HIDDEN_TOKENS, classifierUsd, dataTokens, proseTokens, relayUsd } from '@/scanner/interpret/estimate';
import type { ConnectorId } from '@/scanner/types';

import { GOLDEN_DIR, type GoldenCase } from './golden';
import { inboxQueries, renderSlackHit, runCase, type CaseRun } from './harness';

export const FTI_CASSETTE_DIR = path.join(GOLDEN_DIR, 'cassettes-fti');
export const ftiCassettePath = (caseId: string) => path.join(FTI_CASSETTE_DIR, `${caseId}.json`);
export const ftiSkillVersion = () => loadSkill(CLASSIFY_SKILL_PATH).versionTag;

/** A classifier call's cassette label: its pass and the refs it asks about (no message text). */
export function ftiLabel(req: Pick<CompletionModelRequest, 'user'>): string {
  const pass = /second look/.test(req.user.split('\n')[0] ?? '') ? 'reclassify' : 'classify';
  const refs = [...req.user.matchAll(/^### \[([^\]]+)\]/gm)].map((m) => m[1]);
  return `${pass} | ${refs.join(' , ')}`;
}

/**
 * W12-3: closures the agentic path passes and FTI is known to miss today, by `<case>/<item>`, each with why. The A/B
 * compares both paths on the other closures; fti.eval.ts fails when one of these flips (FTI passes: remove it) or the
 * agentic path stops passing it. Fix the product, not this list.
 */
export const FTI_AGENTIC_ONLY_CLOSURES: Readonly<Record<string, string>> = {
  'scn-4-chase-after-close/i1':
    'FTI gap (SCN-4 again): the classifier reads the chase ("that link doesn\'t open, can you re-share") as an `ask` linked to the done item, and src/scanner/interpret/apply.ts links an ask on a candidate as `origin` (R5 step 4), so nothing reopens it; the agentic path proposes it and DUP-1 links it as a contradiction, which reopens. Fix in apply: an ask or commitment from someone else on a done candidate is a contradiction.',
};
export const ftiAgenticOnly = (caseId: string, item: string) => `${caseId}/${item}` in FTI_AGENTIC_ONLY_CLOSURES;

export interface FtiCaseRun {
  run: CaseRun;
  calls: Array<ClassifierCall & { at: string; systemChars: number; userChars: number }>;
  results: InterpretResult[];
  cassette: Cassette;
  file: CassetteFile;
}

export function loadFtiCassette(caseId: string): CassetteFile {
  const p = ftiCassettePath(caseId);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as CassetteFile) : { version: 1, entries: [] };
}

/** Run one case through FTI. `rekey`: match entries by label and update their hashes (written by the caller). */
export async function runFtiCase(c: GoldenCase, completion: CompletionModel, o: { rekey?: boolean } = {}): Promise<FtiCaseRun> {
  const file = loadFtiCassette(c.id);
  const cassette = cassetteModel({ skill: ftiSkillVersion(), entries: file.entries, labelOf: ftiLabel, mode: o.rekey ? 'rekey' : 'strict' });
  const calls: FtiCaseRun['calls'] = [];
  const results: InterpretResult[] = [];
  const sent: Array<{ s: number; u: number }> = [];
  const model: ClassifierModel = async (req) => {
    sent.push({ s: req.system.length, u: req.user.length });
    return cassette.model(req);
  };
  const run = await runCase(c, completion, {
    interpret: async (a) => {
      const r = await interpretRun({ store: a.store, state: a.state, ctx: a.ctx, window: a.window, fresh: a.fresh, model, mode: 'incremental', trigger: 'eval' });
      results.push(r);
      for (const call of r.calls) calls.push({ ...call, at: a.window.to, systemChars: 0, userChars: 0 });
    },
  });
  // the model saw the calls in the same order they were booked
  calls.forEach((x, i) => {
    x.systemChars = sent[i]?.s ?? 0;
    x.userChars = sent[i]?.u ?? 0;
  });
  return { run, calls, results, cassette, file };
}

export function writeFtiCassette(caseId: string, file: CassetteFile): void {
  fs.mkdirSync(FTI_CASSETTE_DIR, { recursive: true });
  fs.writeFileSync(ftiCassettePath(caseId), `${JSON.stringify(file, null, 2)}\n`);
}

// ------------------------------------------------------------------------------------------------- cost estimates

const FIVE_MIN = 5 * 60_000;

/** The scans of a case: one per `seen_at`, its connectors and Slack rows (what each path reads). */
function scansOf(c: GoldenCase) {
  const times = [...new Set(c.sources.map((s) => s.seen_at))].sort();
  return times.map((at) => ({ at, rows: c.sources.filter((s) => s.seen_at === at) }));
}

/**
 * The agentic path's estimated cost on a case: per scan and connector one traversal run (the hidden prefix +
 * _scanner-common + the scan skill + the context pack; one read turn whose output is the rendered hits; two turns per
 * scripted action, find candidates and propose or link; coverage and finish), plus a Slack triage pass (its own
 * prefix, three turns) when a Slack message needed a verdict. Cold when the same skill ran more than 5 minutes before.
 */
export function agenticCaseUsd(c: GoldenCase, run: CaseRun): number {
  const byId = new Map(c.sources.map((s) => [s.id, s]));
  const common = loadSkill(commonSkillPathFor('skills/scan-slack.md')).body.length;
  const triage = loadSkill('skills/triage-slack.md').body.length;
  const last = new Map<string, number>();
  let total = 0;
  const cold = (skill: string, at: number) => {
    const prev = last.get(skill);
    last.set(skill, at);
    return prev === undefined || at - prev > FIVE_MIN;
  };
  for (const scan of scansOf(c)) {
    const at = Date.parse(scan.at);
    for (const connector of [...new Set(scan.rows.map((r) => r.source))]) {
      const rows = scan.rows.filter((r) => r.source === connector);
      const skillPath = `skills/scan-${connector.replace('_', '-')}.md`;
      const skill = loadSkill(skillPath).body.length;
      const pack = renderContextPack({ scope: { connector: connector as ConnectorId, scope: 'golden' }, cursor: null, gaps: [], me: { userId: 'u', name: c.me.name, email: c.me.email, slackId: c.me.slackId }, watchList: [], aliases: { accounts: [], channels: [] }, openItems: run.store.listWorkItems().slice(0, 60).map((w) => ({ ...w })), initiatives: [], skillVersion: 'x' }).length;
      const prefix = AGENTIC_HIDDEN_TOKENS + proseTokens(common + skill) + dataTokens(pack);
      const reads = connector === 'slack' ? rows.map((s) => renderSlackHit(s, c, s.thread_of ? byId.get(s.thread_of) : undefined).length * Math.max(1, inboxQueries(s, c.me.slackId).length)).reduce((a, b) => a + b, 0) : rows.reduce((a, s) => a + s.body.length + 400, 0);
      const actions = rows.reduce((a, s) => a + s.agent.length, 0);
      const turns = (connector === 'slack' ? 1 : 0) + 2 * actions + 2 + 1;
      const outputs = connector === 'slack' ? [dataTokens(reads)] : [];
      total += agenticRunUsd({ prefixTokens: connector === 'slack' ? prefix : prefix + dataTokens(reads), turns, toolOutputTokens: outputs, cold: cold(skillPath, at) });
      if (connector === 'slack' && rows.some((s) => !s.from_me || /\b(i'?ll|i will|let me)\b/i.test(s.body))) {
        total += agenticRunUsd({ prefixTokens: 20_000 + proseTokens(common + triage), turns: 3, toolOutputTokens: [], cold: cold('triage', at) });
      }
    }
  }
  return total;
}

/**
 * The FTI path's estimated cost on a case: the relay reads a live Slack scan makes (S1–S3, S4 when it found a message
 * of mine; warm when the previous read was under 5 minutes before), and each classifier call from its real rendered
 * prompt (system cached when the previous call was under 5 minutes before). Gmail, Drive and notes reads are direct MCP
 * (no model).
 */
export function ftiCaseUsd(c: GoldenCase, calls: FtiCaseRun['calls']): number {
  let total = 0;
  let lastRelay: number | undefined;
  for (const scan of scansOf(c)) {
    const at = Date.parse(scan.at);
    const slack = scan.rows.filter((r) => r.source === 'slack');
    if (!slack.length) continue;
    const reads = 3 + (slack.some((s) => s.from_me) ? 1 : 0);
    for (let i = 0; i < reads; i++) {
      total += relayUsd(i === 0 && (lastRelay === undefined || at - lastRelay > FIVE_MIN));
    }
    lastRelay = at;
  }
  let lastCall: number | undefined;
  for (const x of calls) {
    const at = Date.parse(x.at);
    total += classifierUsd({ systemTokens: Math.ceil(x.systemChars / 3.2), userTokens: Math.ceil(x.userChars / 3.2), verdicts: x.itemsIn, cold: lastCall === undefined || at - lastCall > FIVE_MIN });
    lastCall = at;
  }
  return total;
}

export type { CassetteEntry };
