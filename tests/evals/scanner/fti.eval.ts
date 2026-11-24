/**
 * The FTI A/B gate over the golden cases (review 04 §4.6 #6, holistic build p2-fetch-then-interpret):
 *
 *   agentic   the oracle agent (scripted actions of each case: a perfect model, so it measures the code's losses)
 *   fti       fetch → rules → candidates → the batched classifier replayed from hand-written cassettes → apply
 *
 *   gate  FTI item recall ≥ the agentic path's, on the same cases (knownGap excluded)
 *   gate  FTI precision (found / everything proposed) not lower than the agentic path's
 *   gate  FTI estimated $ per item found ≤ 1/5 of the agentic path's (token-count estimates, src/scanner/interpret/estimate.ts)
 *   gate  FTI closures passed ≥ the agentic path's, on the same closures (W12-3); a closure FTI is known to miss is listed
 *         in fti.ts FTI_AGENTIC_ONLY_CLOSURES with its reason: the agentic path must still pass it, and FTI passing it
 *         fails the run until the mark is removed (a flip, as with knownGap)
 *   track extra items, model calls
 *
 * Modes: `CC_EVAL_REKEY=1` re-keys the FTI cassettes by label after a prompt change and writes them; `CC_EVAL_DISCOVER=<file>`
 * answers every call with no verdict and writes each call's label and prompt to <file> (for writing a new case's
 * cassette by hand). Neither ever calls a model.
 */
import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cassetteModel } from '@/scanner/completion/cassette';
import { COMPLETION_SKILL_PATH } from '@/scanner/completion/pass';
import type { CompletionModel } from '@/scanner/completion/types';
import { loadSkill } from '@/llm/skill-loader';
import { interpretRun } from '@/scanner/interpret';

import { cassettePath, loadGoldenCases } from './golden';
import { agenticCaseUsd, FTI_AGENTIC_ONLY_CLOSURES, ftiAgenticOnly, ftiCaseUsd, ftiLabel, ftiSkillVersion, loadFtiCassette, runFtiCase, writeFtiCassette, type FtiCaseRun } from './fti';
import { completionLabel, runCase, type CaseRun } from './harness';
import { score } from './score';

const cases = loadGoldenCases();
const completionSkill = loadSkill(COMPLETION_SKILL_PATH).versionTag;
const REKEY = process.env.CC_EVAL_REKEY === '1';
const DISCOVER = process.env.CC_EVAL_DISCOVER;
const agentic = new Map<string, { run: CaseRun; usd: number }>();
const fti = new Map<string, FtiCaseRun & { usd: number }>();

/** A completion cassette, matched by label for FTI (its titles are the classifier's, its prompt carries other evidence). */
const completionFor = (id: string, mode: 'strict' | 'rekey') => {
  const p = cassettePath(id);
  const entries = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as { entries: [] }).entries : [];
  return cassetteModel({ skill: completionSkill, entries: structuredClone(entries), labelOf: completionLabel, mode });
};

/**
 * The completion model of an FTI run: its cassette by label, and "not done" for a pass the cassette has no entry for
 * (its item list differs from the oracle's). Closures are tracked, not gated, in this A/B.
 */
const ftiCompletion = (id: string): CompletionModel => {
  const cas = completionFor(id, 'rekey');
  return async (req) => {
    try {
      return await cas.model(req);
    } catch {
      const items = (JSON.parse(req.user) as { items?: Array<{ id: string }> }).items ?? [];
      return { ok: true, text: JSON.stringify({ verdicts: items.map((i) => ({ item: i.id, verdict: 'not_done', basis: 'none', confidence: 0 })) }), costUsd: 0, inputTokens: 0, outputTokens: 0 };
    }
  };
};

export interface AbRow {
  path: 'agentic' | 'fti';
  found: number;
  expected: number;
  recall: number;
  proposed: number;
  extra: number;
  precision: number;
  closuresPassed: number;
  closures: number;
  modelCalls: number;
  usd: number;
  usdPerItem: number;
}

function row(pathName: AbRow['path'], runs: CaseRun[], usd: number, modelCalls: number): AbRow {
  const s = score(runs);
  const found = s.recall.found;
  const extra = s.extraItems;
  const proposed = found + extra;
  // W12-3: both paths are compared on the same closures; the FTI-agentic-only ones (fti.ts) are tracked apart
  const gatedClosures = s.closures.filter((c) => !c.closure.knownGap && !ftiAgenticOnly(c.caseId, c.closure.item));
  return { path: pathName, found, expected: s.recall.expected, recall: s.recall.value, proposed, extra, precision: proposed ? found / proposed : 1, closuresPassed: gatedClosures.filter((c) => c.pass).length, closures: gatedClosures.length, modelCalls, usd, usdPerItem: found ? usd / found : 0 };
}

export function renderAb(rows: AbRow[]): string {
  const f = (x: number, d = 2) => x.toFixed(d);
  const out = ['', 'FTI A/B (golden cases; agentic = oracle agent, fti = classifier cassettes; $ estimated from token counts)', '| path | recall | precision | extra items | closures | model calls | est. $ | est. $/item found |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) out.push(`| ${r.path} | ${r.found}/${r.expected} = ${f(r.recall)} | ${r.found}/${r.proposed} = ${f(r.precision)} | ${r.extra} | ${r.closuresPassed}/${r.closures} | ${r.modelCalls} | ${f(r.usd, 4)} | ${f(r.usdPerItem, 5)} |`);
  const [a, b] = rows;
  if (a && b && a.usdPerItem) out.push('', `FTI $/item = ${f(b.usdPerItem / a.usdPerItem, 3)} × agentic (gate ≤ 0.200)`);
  return out.join('\n');
}

beforeAll(async () => {
  const discovered: string[] = [];
  for (const c of cases) {
    const a = await runCase(c, completionFor(c.id, 'strict').model);
    agentic.set(c.id, { run: a, usd: agenticCaseUsd(c, a) });
    if (DISCOVER) {
      // iterative: replay what the cassette has (by label), log the rest and answer it with no verdict
      const cas = cassetteModel({ skill: ftiSkillVersion(), entries: loadFtiCassette(c.id).entries, labelOf: ftiLabel, mode: 'rekey' });
      await runCase(c, ftiCompletion(c.id), {
        interpret: async (x) => {
          await interpretRun({
            store: x.store,
            state: x.state,
            ctx: x.ctx,
            window: x.window,
            fresh: x.fresh,
            mode: 'incremental',
            trigger: 'eval',
            model: async (req) => {
              try {
                const hit = await cas.model(req);
                discovered.push(`=== ${c.id} | ${ftiLabel(req)} | replayed\n${req.user}\n`);
                return hit;
              } catch {
                discovered.push(`=== ${c.id} | ${ftiLabel(req)} | MISS\n${req.user}\n`);
                return { ok: true, text: '{"verdicts":[]}', costUsd: 0, inputTokens: 0, outputTokens: 0 };
              }
            },
          });
        },
      });
      continue;
    }
    const r = await runFtiCase(c, ftiCompletion(c.id), { rekey: REKEY });
    if (REKEY && r.cassette.rekeyed.length) writeFtiCassette(c.id, r.file);
    fti.set(c.id, { ...r, usd: ftiCaseUsd(c, r.calls) });
  }
  if (DISCOVER) fs.writeFileSync(DISCOVER, discovered.join('\n'));
});

afterAll(() => {
  if (fti.size !== cases.length) return;
  const rows = [row('agentic', [...agentic.values()].map((x) => x.run), [...agentic.values()].reduce((s, x) => s + x.usd, 0), [...agentic.values()].reduce((s, x) => s + x.run.calls, 0)), row('fti', [...fti.values()].map((x) => x.run), [...fti.values()].reduce((s, x) => s + x.usd, 0), [...fti.values()].reduce((s, x) => s + x.calls.length + x.run.calls, 0))];
  console.log(renderAb(rows));
  const only = Object.keys(FTI_AGENTIC_ONLY_CLOSURES);
  if (only.length) console.log(`Closures FTI misses today (agentic only, tracked apart; fti.ts): ${only.join(', ')}`);
});

describe.skipIf(!!DISCOVER)('FTI golden cases', () => {
  for (const c of cases) {
    describe(c.id, () => {
      it('replays its classifier calls from the FTI cassette, no miss and no stale entry', () => {
        const r = fti.get(c.id)!;
        expect(r.cassette.misses).toEqual([]);
        expect(r.file.entries.filter((e) => !e.hash || !r.cassette.used.has(e.hash)).map((e) => e.label)).toEqual([]);
      });
      for (const it_ of c.items_expected.filter((i) => !i.knownGap)) {
        it(`item ${it_.id} is found through FTI: ${it_.title}`, () => {
          const run = fti.get(c.id)!.run;
          expect(run.itemIds.has(it_.id), run.why.get(it_.id)).toBe(true);
          const title = run.store.getWorkItem(run.itemIds.get(it_.id)!)!.title.toLowerCase();
          for (const k of it_.keywords) expect(title).toContain(k.toLowerCase());
        });
      }
    });
  }

  it('A/B gate: FTI recall ≥ agentic, precision not lower, estimated $/item ≤ 1/5', () => {
    const a = row('agentic', [...agentic.values()].map((x) => x.run), [...agentic.values()].reduce((s, x) => s + x.usd, 0), 0);
    const b = row('fti', [...fti.values()].map((x) => x.run), [...fti.values()].reduce((s, x) => s + x.usd, 0), 0);
    expect(b.recall).toBeGreaterThanOrEqual(a.recall);
    expect(b.precision).toBeGreaterThanOrEqual(a.precision);
    expect(b.usdPerItem).toBeLessThanOrEqual(a.usdPerItem / 5);
    expect(b.closures).toBe(a.closures);
    expect(b.closuresPassed).toBeGreaterThanOrEqual(a.closuresPassed);
  });

  it('FTI-agentic-only closures: still pass on the agentic path, still fail on FTI (remove the mark when it flips)', () => {
    const judge = (runs: CaseRun[]) => new Map(score(runs).closures.map((c) => [`${c.caseId}/${c.closure.item}`, c.pass]));
    const a = judge([...agentic.values()].map((x) => x.run));
    const b = judge([...fti.values()].map((x) => x.run));
    for (const k of Object.keys(FTI_AGENTIC_ONLY_CLOSURES)) {
      expect(a.get(k), `${k}: the agentic path must pass it`).toBe(true);
      expect(b.get(k), `${k}: FTI passes it now: remove it from FTI_AGENTIC_ONLY_CLOSURES`).toBe(false);
    }
  });

  it('every classifier call books items in, items decided by rules (first call of a run) and items out', () => {
    for (const r of fti.values()) for (const x of r.results) for (const call of x.calls) expect(call.itemsIn).toBeGreaterThan(0);
  });
});

describe.runIf(!!DISCOVER)('FTI discovery', () => {
  it('wrote every classifier prompt with its label', () => {
    expect(fs.existsSync(DISCOVER!)).toBe(true);
  });
});
