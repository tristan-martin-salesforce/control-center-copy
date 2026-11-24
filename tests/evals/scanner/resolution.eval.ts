/**
 * The resolution check (src/engines/resolution) over every golden case, LIVE in the harness (it replaces the completion
 * pass after each scan), with its own cassettes (offline, free): triggers → pack → rules D1–D6 → cheap model → narrow
 * escalation → closure machine / Settle policy. Same gates as golden.eval.ts, plus the check's own:
 *
 *   gate  item recall ≥ 0.9, 0 wrong closes on still-owed items (as the legacy closers)
 *   gate  median estimated cost per model-judged check < $0.005 on Haiku (cached system prefix, pack only)
 *   gate  every expected `rule` is what the ladder's rules decided
 *   track checks, decided by rules, model calls, escalations
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RESOLUTION_SKILL_PATH } from '@/engines/resolution/types';
import { loadSkill } from '@/llm/skill-loader';
import { estimateCallCostUsd } from '@/llm/models';
import { cassetteModel, type Cassette, type CassetteFile } from '@/scanner/completion/cassette';
import type { CompletionModel } from '@/scanner/completion/types';

import { loadGoldenCases } from './golden';
import { runCase, type CaseRun } from './harness';
import { readResolutionCassette, resolutionLabel, resolutionSkillTag } from './resolution-cassettes';
import { RECALL_GATE, WRONG_CLOSE_GATE, judgeClosure, renderTable, score } from './score';

export const CHECK_COST_GATE_USD = 0.005;

const cases = loadGoldenCases();
const skill = resolutionSkillTag();
const runs = new Map<string, CaseRun>();
const cassettes = new Map<string, { file: CassetteFile; cas: Cassette }>();
/** Estimated cost of each model call, per item (tokens ≈ chars / 4; the system prompt a cache read after the first call). */
const perCheckUsd: number[] = [];

beforeAll(async () => {
  const system = loadSkill(RESOLUTION_SKILL_PATH).body;
  for (const c of cases) {
    const file = readResolutionCassette(c.id);
    const cas = cassetteModel({ skill, entries: file.entries, labelOf: resolutionLabel });
    const model: CompletionModel = async (req) => {
      const res = await cas.model(req);
      const items = (JSON.parse(req.user) as { items: unknown[] }).items.length;
      const usd = estimateCallCostUsd(req.model, { input_tokens: Math.ceil(req.user.length / 4), cache_read_input_tokens: Math.ceil(system.length / 4), output_tokens: Math.ceil(res.text.length / 4) });
      for (let i = 0; i < items; i++) perCheckUsd.push(usd / items);
      return res;
    };
    cassettes.set(c.id, { file, cas });
    runs.set(c.id, await runCase(c, model, { closer: 'resolution' }));
  }
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};

afterAll(() => {
  if (runs.size !== cases.length) return;
  const all = [...runs.values()];
  const checks = all.flatMap((r) => r.checks);
  const byRule = checks.filter((c) => c.decidedBy === 'rule').length;
  const esc = checks.filter((c) => c.escalated).length;
  console.log(
    renderTable(score(all), {
      title: 'Resolution check evals (golden cases, live in the harness, cassette model)',
      extra: [
        ['checks (decided by rules)', `${checks.length} (${byRule})`, 'tracked', '-'],
        ['escalations', String(esc), 'tracked', '-'],
        ['median $/model check (est.)', `$${median(perCheckUsd).toFixed(5)}`, `< ${CHECK_COST_GATE_USD}`, median(perCheckUsd) < CHECK_COST_GATE_USD ? 'PASS' : 'FAIL'],
        ['max pack tokens', String(Math.max(0, ...checks.map((c) => c.packTokens))), 'tracked', '-'],
      ],
    }),
  );
});

describe('resolution check on the golden cases', () => {
  for (const c of cases) {
    describe(c.id, () => {
      it('replays from its cassette with no miss and no stale entry', () => {
        const { file, cas } = cassettes.get(c.id)!;
        expect(cas.misses).toEqual([]);
        expect(file.entries.filter((e) => !e.hash || !cas.used.has(e.hash)).map((e) => e.label)).toEqual([]);
      });
      for (const it_ of c.items_expected.filter((i) => !i.knownGap)) {
        it(`item ${it_.id} is found`, () => expect(runs.get(c.id)!.itemIds.has(it_.id), runs.get(c.id)!.why.get(it_.id)).toBe(true));
      }
      for (const cl of c.closures_expected.filter((x) => !x.knownGap)) {
        it(`item ${cl.item} ends ${cl.expect}${cl.reopened ? ' (after a reopen)' : ''}${cl.cite ? `, citing ${cl.cite}` : ''}`, () => {
          expect(judgeClosure(runs.get(c.id)!, cl).problems).toEqual([]);
        });
        if (cl.rule && cl.rule !== 'none') {
          it(`item ${cl.item}: the ladder's rules decided ${cl.rule}`, () => {
            const run = runs.get(c.id)!;
            const wid = run.itemIds.get(cl.item);
            expect(run.checks.some((k) => k.workItemId === wid && k.ruleHit === cl.rule)).toBe(true);
          });
        }
      }
      it('records one closure_checks row per check, with no message text', () => {
        const run = runs.get(c.id)!;
        for (const k of run.checks) {
          expect(k.packDigest).toMatch(/^[0-9a-f]{16}$/);
          expect(k.engineVersion).toMatch(/^resolution@/);
          for (const v of Object.values(k)) if (typeof v === 'string') expect(v.length).toBeLessThan(200);
        }
      });
    });
  }
});

describe('resolution check scores', () => {
  it(`recall ≥ ${RECALL_GATE}, ${WRONG_CLOSE_GATE} wrong closes, median check under $${CHECK_COST_GATE_USD}`, () => {
    const s = score([...runs.values()]);
    expect(s.recall.value).toBeGreaterThanOrEqual(RECALL_GATE);
    expect(s.wrongCloses).toEqual([]);
    expect(perCheckUsd.length).toBeGreaterThan(0);
    expect(median(perCheckUsd)).toBeLessThan(CHECK_COST_GATE_USD);
  });
  it('the rules decide some checks without a model', () => {
    expect([...runs.values()].flatMap((r) => r.checks).some((k) => k.decidedBy === 'rule')).toBe(true);
  });
});
