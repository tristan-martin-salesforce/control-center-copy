/**
 * Live eval runner for the judgment-layer skills. Calls the real models through the Agent SDK
 * (no tools, no settings, one turn per call, at most one repair per scenario) and scores every
 * scenario's expected properties. Nothing is sent anywhere; outputs are written outside the repo.
 *
 *   npx vite-node tests/skills/run-evals.ts [--only id1,id2] [--budget 2.75]
 *
 * Output: a summary on stdout and a JSON report in $CC_STATE_DIR/evals/ (default
 * ~/Library/Application Support/command-center/evals/). Placeholder data only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBriefPrompt, parseBriefReply, type BriefValidation } from '../../src/engines/briefs/prompt/build';
import type { Complete } from '../../src/engines/nba/prompt/complete';
import { buildIntentsPrompt, buildRankPrompt, parseIntentsReply, parseRankReply, type ParseResult } from '../../src/engines/nba/prompt/enrich';
import type { Issue } from '../../src/engines/nba/prompt/json';
import { generateNba, repairUserMessage } from '../../src/engines/nba/prompt/run';
import { docToPlainText } from '../../src/engines/nba/prompt/tiptap';
import { stateDir } from '../../src/engines/voice/store';
import { agentSdkComplete } from '../../src/llm/complete-sdk';
import { exampleVoice, nbaCtx, type Check, type CheckResult } from './eval-kit';
import { SCENARIOS } from './scenarios';

interface ScenarioResult {
  id: string;
  kind: string;
  model: string;
  attempts: number;
  costUsd: number;
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
  checks: Array<{ name: string; pass: boolean; detail?: string }>;
  pass: boolean;
  output?: unknown;
  raw: string[];
  skipped?: string;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function runChecks<C>(checks: Check<C>[], ctx: C): ScenarioResult['checks'] {
  return checks.map((ch) => {
    let r: CheckResult;
    try {
      r = ch.fn(ctx);
    } catch (e) {
      r = `threw: ${(e as Error).message}`;
    }
    return r === true ? { name: ch.name, pass: true } : { name: ch.name, pass: false, detail: String(r).slice(0, 300) };
  });
}

/** One call plus at most one repair, for the non-NBA prompts. */
async function callWithRepair<T>(
  complete: Complete,
  p: { system: string; user: string; model: string; maxOutputTokens: number },
  parse: (raw: string) => ParseResult<T> | BriefValidation,
): Promise<{ result: ParseResult<T> | BriefValidation; cost: number; raw: string[] }> {
  let cost = 0;
  const raw: string[] = [];
  let user = p.user;
  let result: ParseResult<T> | BriefValidation = { ok: false, errors: [{ code: 'not_run', message: '' }], warnings: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await complete({ system: p.system, user, model: p.model, maxOutputTokens: p.maxOutputTokens, maxBudgetUsd: 0.35 });
    cost += res.costUsd;
    raw.push(res.text);
    if (!res.ok) return { result: { ok: false, errors: [{ code: 'llm', message: res.error ?? 'failed' }], warnings: [] }, cost, raw };
    result = parse(res.text);
    if (result.ok) break;
    user = repairUserMessage(p.user, res.text, result.errors);
  }
  return { result, cost, raw };
}

async function runScenario(s: (typeof SCENARIOS)[number], complete: Complete): Promise<ScenarioResult> {
  const base = { id: s.id, kind: s.kind };
  if (s.kind === 'nba') {
    const g = await generateNba(s.input, complete, { repairs: 1, maxBudgetUsd: 0.35 });
    const validation = { ok: g.ok, errors: g.errors, warnings: g.warnings, ...(g.output ? { output: g.output } : {}) };
    const checks = g.output ? runChecks(s.checks, nbaCtx(s.input, g.output, validation)) : [{ name: 'output', pass: false, detail: g.errors.map((e) => e.message).join('; ') }];
    return { ...base, model: g.prompt.model, attempts: g.attempts, costUsd: g.costUsd, valid: g.ok, errors: g.errors, warnings: g.warnings, checks, pass: checks.every((c) => c.pass), output: g.output, raw: g.raw };
  }
  if (s.kind === 'brief') {
    const p = buildBriefPrompt(s.input);
    const { result, cost, raw } = await callWithRepair(complete, p, (r) => parseBriefReply(r, s.input));
    const out = (result as BriefValidation).output;
    const checks = out ? runChecks(s.checks, { input: s.input, output: out, validation: result as BriefValidation }) : [{ name: 'output', pass: false, detail: result.errors.map((e) => e.message).join('; ') }];
    return { ...base, model: p.model, attempts: raw.length, costUsd: cost, valid: result.ok, errors: result.errors, warnings: result.warnings, checks, pass: checks.every((c) => c.pass), output: out, raw };
  }
  if (s.kind === 'enrich_intents') {
    const p = buildIntentsPrompt(s.input);
    const { result, cost, raw } = await callWithRepair(complete, p, (r) => parseIntentsReply(r));
    const out = (result as ReturnType<typeof parseIntentsReply>).output;
    const checks = out ? runChecks(s.checks, { input: s.input, output: out }) : [{ name: 'output', pass: false, detail: result.errors.map((e) => e.message).join('; ') }];
    return { ...base, model: p.model, attempts: raw.length, costUsd: cost, valid: result.ok, errors: result.errors, warnings: result.warnings, checks, pass: result.ok && checks.every((c) => c.pass), output: out, raw };
  }
  const p = buildRankPrompt(s.input, s.parsed, s.candidates, { voice: exampleVoice('internal') });
  const { result, cost, raw } = await callWithRepair(complete, p, (r) => parseRankReply(r, s.input, s.parsed, s.candidates));
  const out = (result as ReturnType<typeof parseRankReply>).output;
  const checks = out
    ? runChecks(s.checks, { input: s.input, output: out, candidates: s.candidates, draftText: out.nba.draft ? docToPlainText(out.nba.draft.doc) : '' })
    : [{ name: 'output', pass: false, detail: result.errors.map((e) => e.message).join('; ') }];
  return { ...base, model: p.model, attempts: raw.length, costUsd: cost, valid: result.ok, errors: result.errors, warnings: result.warnings, checks, pass: result.ok && checks.every((c) => c.pass), output: out, raw };
}

async function main() {
  const only = argValue('only')?.split(',');
  const budget = Number(argValue('budget') ?? process.env.EVAL_BUDGET_USD ?? 2.75);
  const concurrency = Number(argValue('concurrency') ?? 4);
  const list = SCENARIOS.filter((s) => !only || only.includes(s.id));
  const results: ScenarioResult[] = [];
  let spent = 0;
  let next = 0;
  const started = Date.now();
  async function worker() {
    while (next < list.length) {
      const s = list[next++]!;
      if (spent >= budget) {
        results.push({ id: s.id, kind: s.kind, model: '-', attempts: 0, costUsd: 0, valid: false, errors: [], warnings: [], checks: [], pass: false, raw: [], skipped: `budget ${budget} reached` });
        continue;
      }
      try {
        const r = await runScenario(s, agentSdkComplete);
        spent += r.costUsd;
        results.push(r);
        console.error(`${r.pass ? 'PASS' : 'FAIL'} ${s.id} (${r.model}, ${r.attempts} call${r.attempts === 1 ? '' : 's'}, $${r.costUsd.toFixed(4)})`);
      } catch (e) {
        results.push({ id: s.id, kind: s.kind, model: '-', attempts: 0, costUsd: 0, valid: false, errors: [{ code: 'runner', message: (e as Error).message }], warnings: [], checks: [], pass: false, raw: [] });
        console.error(`ERROR ${s.id}: ${(e as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  results.sort((a, b) => list.findIndex((s) => s.id === a.id) - list.findIndex((s) => s.id === b.id));

  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.pass).length;
  const checksTotal = ran.reduce((n, r) => n + r.checks.length, 0);
  const checksPassed = ran.reduce((n, r) => n + r.checks.filter((c) => c.pass).length, 0);
  const summary = {
    at: new Date().toISOString(),
    scenarios: list.length,
    ran: ran.length,
    passed,
    passRate: ran.length ? Math.round((passed / ran.length) * 1000) / 1000 : 0,
    checkPassRate: checksTotal ? Math.round((checksPassed / checksTotal) * 1000) / 1000 : 0,
    firstPassValid: ran.filter((r) => r.valid && r.attempts === 1).length,
    repaired: ran.filter((r) => r.valid && r.attempts > 1).length,
    costUsd: Math.round(spent * 10000) / 10000,
    seconds: Math.round((Date.now() - started) / 1000),
    failures: ran.filter((r) => !r.pass).map((r) => ({ id: r.id, failed: r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail ?? ''}`), errors: r.errors.map((e) => e.code) })),
  };
  const dir = process.env.EVAL_OUT ?? join(stateDir(), 'evals');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `skills-${summary.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ summary, results }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, report: file }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
