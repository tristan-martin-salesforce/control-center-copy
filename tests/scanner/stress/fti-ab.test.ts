/**
 * The FTI A/B on the stress fixture (the recorded-shape Slack corpus, tests/fixtures/scanner/slack/corpus.v1.json):
 * a first scan of the inbox through the real ScannerRuntime, read by code through a fake relay that serves the
 * recorded output format, interpreted by the classifier replayed from a hand-written cassette
 * (tests/fixtures/scanner-golden/cassettes-fti/stress-slack-corpus.json). The agentic side is the oracle agent: every
 * expected item proposed from its own message (a perfect model), priced with the agentic run anatomy on the same runs.
 *
 *   gate  recall ≥ the agentic path's · precision not lower · estimated $ per item found ≤ 1/5
 *
 * `CC_EVAL_REKEY=1` re-keys the cassette by label; `CC_EVAL_DISCOVER=<file>` writes every classifier prompt.
 */
import fs from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { commonSkillPathFor, loadSkill } from '@/llm/skill-loader';
import { cassetteModel, type CassetteFile } from '@/scanner/completion/cassette';
import { CLASSIFY_SKILL_PATH, FtiSkillRunner, type ClassifierModel } from '@/scanner/interpret';
import { agenticRunUsd, AGENTIC_HIDDEN_TOKENS, classifierUsd, dataTokens, proseTokens, relayUsd } from '@/scanner/interpret/estimate';
import { SIGNAL_CADENCE } from '@/scanner/runtime/cadence';
import { slackSpec } from '@/scanner/runtime/connectors';
import { FirstScan, MemoryFirstScanLedger } from '@/scanner/runtime/first-scan';
import { ftiTraversalOverrides } from '@/scanner/runtime/fti-specs';
import type { RuntimeJob } from '@/scanner/runtime/jobs';
import { ScannerRuntime } from '@/scanner/runtime/scanner-runtime';
import type { SkillRunner } from '@/scanner/types';

import { ftiLabel } from '../../evals/scanner/fti';
import { corpusRelay, corpusStore, loadCorpus } from '../helpers';

const corpus = loadCorpus();
const NOW = '2026-11-06T18:00:00.000Z';
const CASSETTE = 'tests/fixtures/scanner-golden/cassettes-fti/stress-slack-corpus.json';
const REKEY = process.env.CC_EVAL_REKEY === '1';
const DISCOVER = process.env.CC_EVAL_DISCOVER;

/** The answer key: which messages are someone's ask of me or my promise (one item each), and what is not. */
const EXPECTED: Record<string, RegExp> = {
  'weekend-ask': /GLOBEX sizing sheet/i,
  'promise-desktop': /desktop app/i,
  'deck-ask': /ACME demo deck/i,
  'pricing-ask': /pricing slide/i,
};

const fallback: SkillRunner = {
  async run() {
    throw new Error('the stress A/B runs no agent');
  },
};

async function ftiFirstScan() {
  const store = corpusStore(corpus, NOW);
  const relay = corpusRelay(corpus);
  const file: CassetteFile = fs.existsSync(CASSETTE) ? (JSON.parse(fs.readFileSync(CASSETTE, 'utf8')) as CassetteFile) : { version: 1, entries: [] };
  const cas = cassetteModel({ skill: loadSkill(CLASSIFY_SKILL_PATH).versionTag, entries: file.entries, labelOf: ftiLabel, mode: REKEY || DISCOVER ? 'rekey' : 'strict' });
  const prompts: string[] = [];
  const sizes: Array<{ s: number; u: number; n: number }> = [];
  const model: ClassifierModel = async (req) => {
    sizes.push({ s: req.system.length, u: req.user.length, n: [...req.user.matchAll(/^### \[/gm)].length });
    try {
      const r = await cas.model(req);
      prompts.push(`=== ${ftiLabel(req)} | replayed\n${req.user}\n`);
      return r;
    } catch (e) {
      if (!DISCOVER) throw e;
      prompts.push(`=== ${ftiLabel(req)} | MISS\n${req.user}\n`);
      return { ok: true, text: '{"verdicts":[]}', costUsd: 0, inputTokens: 0, outputTokens: 0 };
    }
  };
  const rt = new ScannerRuntime({
    store,
    runner: new FtiSkillRunner({ fallback, runtimeFor: (c) => (c === 'slack' ? relay : null), model }),
    specs: [slackSpec({ ...ftiTraversalOverrides('slack'), scopes: () => ['inbox'] })],
    reevaluate: async () => undefined,
    clock: { now: () => new Date(NOW), sleep: async () => undefined } as never,
    cadence: SIGNAL_CADENCE,
    firstScan: new FirstScan({ lookbackDays: 8, budgetUsd: 5, connectors: ['slack'] }, new MemoryFirstScanLedger()),
  });
  const queue: RuntimeJob[] = await rt.planJobs(new Date(NOW));
  const runs: Array<{ from: string; to: string; recorded: number }> = [];
  while (queue.length) {
    const j = queue.shift()!;
    const before = store.counts().sourceItems;
    const out = await rt.executeJob(j);
    if (j.kind === 'scan') runs.push({ from: j.window.from, to: j.window.to, recorded: store.counts().sourceItems - before });
    queue.push(...out.followUps);
  }
  if (REKEY && cas.rekeyed.length) fs.writeFileSync(CASSETTE, `${JSON.stringify(file, null, 2)}\n`);
  if (DISCOVER) fs.writeFileSync(DISCOVER, prompts.join('\n'));
  return { store, relay, cas, file, sizes, runs };
}

const result = await ftiFirstScan();

/** Which expected items exist as their own work item, through their origin message; the rest are extras. */
function scoreFti() {
  const byExt = new Map(corpus.messages.map((m) => [`${m.channel}:${m.ts}`, m.id]));
  const found = new Set<string>();
  let extra = 0;
  for (const w of result.store.listWorkItems()) {
    const origins = result.store.evidenceFor(w.workItemId).filter((e) => e.role === 'origin').map((e) => byExt.get(result.store.getSourceItem(e.sourceItemId)!.externalId));
    const hit = origins.find((o) => o && EXPECTED[o] && EXPECTED[o]!.test(w.title));
    if (hit) found.add(hit);
    else extra += 1;
  }
  return { found: found.size, expected: Object.keys(EXPECTED).length, extra };
}

/**
 * The agentic path on the same runs: one traversal per run (the hidden prefix + _scanner-common + scan-slack, the
 * read turn's output = what the run recorded, two turns per expected item it proposes, coverage and finish) and a
 * triage pass on any run that recorded a message, priced warm within 5 minutes of the previous run (a first scan's
 * runs follow each other) and cold otherwise.
 */
function agenticUsd() {
  const common = loadSkill(commonSkillPathFor('skills/scan-slack.md')).body.length;
  const skill = loadSkill('skills/scan-slack.md').body.length;
  const triage = loadSkill('skills/triage-slack.md').body.length;
  const prefix = AGENTIC_HIDDEN_TOKENS + proseTokens(common + skill) + 2_000;
  let usd = 0;
  result.runs.forEach((r, i) => {
    const items = corpus.messages.filter((m) => Date.parse(r.from) <= Number(m.ts) * 1000 && Number(m.ts) * 1000 < Date.parse(r.to));
    const acts = items.filter((m) => EXPECTED[m.id]).length;
    usd += agenticRunUsd({ prefixTokens: prefix, turns: 1 + 1 + 2 * acts + 2, toolOutputTokens: [dataTokens(items.length * 700)], cold: i === 0 });
    if (items.length) usd += agenticRunUsd({ prefixTokens: 20_000 + proseTokens(common + triage), turns: 3, toolOutputTokens: [], cold: i === 0 });
  });
  return usd;
}

function ftiUsd() {
  // a first scan's reads follow each other: the relay prefix is written once, then read
  const relay = result.relay.calls.reduce((s, _c, i) => s + relayUsd(i === 0), 0);
  const classify = result.sizes.reduce((s, x, i) => s + classifierUsd({ systemTokens: Math.ceil(x.s / 3.2), userTokens: Math.ceil(x.u / 3.2), verdicts: x.n, cold: i === 0 }), 0);
  return { relay, classify, total: relay + classify };
}

afterAll(() => {
  if (DISCOVER) return;
  const f = scoreFti();
  const a = { found: Object.keys(EXPECTED).length, expected: Object.keys(EXPECTED).length, extra: 0 };
  const ag = agenticUsd();
  const fu = ftiUsd();
  console.log(
    [
      '',
      'FTI A/B (stress fixture: the Slack corpus, a first scan of the inbox; agentic = oracle agent; $ estimated from token counts)',
      '| path | recall | precision | extra items | runs | relay reads | classifier calls | est. $ | est. $/item found |',
      '|---|---|---|---|---|---|---|---|---|',
      `| agentic | ${a.found}/${a.expected} | ${a.found}/${a.found + a.extra} | ${a.extra} | ${result.runs.length} | - | - | ${ag.toFixed(4)} | ${(ag / a.found).toFixed(5)} |`,
      `| fti | ${f.found}/${f.expected} | ${f.found}/${f.found + f.extra} | ${f.extra} | ${result.runs.length} | ${result.relay.calls.length} | ${result.sizes.length} | ${fu.total.toFixed(4)} | ${(fu.total / Math.max(1, f.found)).toFixed(5)} |`,
      '',
      `FTI $/item = ${(fu.total / Math.max(1, f.found) / (ag / a.found)).toFixed(3)} × agentic (gate ≤ 0.200); relay $${fu.relay.toFixed(4)}, classifier $${fu.classify.toFixed(4)}`,
    ].join('\n'),
  );
});

describe.skipIf(!!DISCOVER)('FTI A/B on the Slack stress corpus', () => {
  it('replays every classifier call from the cassette (no miss, no stale entry)', () => {
    expect(result.cas.misses).toEqual([]);
    expect(result.file.entries.filter((e) => !e.hash || !result.cas.used.has(e.hash)).map((e) => e.label)).toEqual([]);
  });
  it('gate: recall ≥ agentic, precision not lower, estimated $/item ≤ 1/5', () => {
    const f = scoreFti();
    expect(f.found).toBe(f.expected);
    expect(f.extra).toBe(0);
    expect(ftiUsd().total / f.found).toBeLessThanOrEqual(agenticUsd() / Object.keys(EXPECTED).length / 5);
  });
  it('the credential in a DM was redacted at record, never read by a model as a task', () => {
    const rows = [...(result.store as unknown as { sourceItems: Map<string, { excerpt?: string }> }).sourceItems.values()];
    expect(rows.some((r) => /Hunter2/.test(r.excerpt ?? ''))).toBe(false);
  });
});

describe.runIf(!!DISCOVER)('FTI A/B discovery', () => {
  it('wrote the prompts', () => expect(fs.existsSync(DISCOVER!)).toBe(true));
});
