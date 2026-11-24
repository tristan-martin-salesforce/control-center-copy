/**
 * Golden scanner evals, end to end with the cassette model (offline, free): every golden case through the real
 * fetch → record → propose → completion pass → closure machine path, then the scores, gated and printed.
 *
 *   gate  item recall on golden asks ≥ 0.9 (knownGap excluded)
 *   gate  0 wrong closes on still-owed items (knownGap excluded)
 *   track close rate on settled items, clicks left, extra items, model calls
 *
 * Expectations marked `knownGap` are scored and listed but never fail the run; one that starts passing is listed as
 * "flip" so the chunk that fixed it removes the mark.
 */
import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cassetteModel, type Cassette, type CassetteFile } from '@/scanner/completion/cassette';
import { COMPLETION_SKILL_PATH } from '@/scanner/completion/pass';
import { loadSkill } from '@/llm/skill-loader';

import { cassettePath, loadGoldenCases } from './golden';
import { completionLabel, runCase, type CaseRun } from './harness';
import { RECALL_GATE, WRONG_CLOSE_GATE, judgeClosure, renderTable, score } from './score';

const cases = loadGoldenCases();
const skill = loadSkill(COMPLETION_SKILL_PATH).versionTag;
const runs = new Map<string, CaseRun>();
const cassettes = new Map<string, { file: CassetteFile; cas: Cassette }>();

beforeAll(async () => {
  for (const c of cases) {
    const p = cassettePath(c.id);
    const file: CassetteFile = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as CassetteFile) : { version: 1, entries: [] };
    const cas = cassetteModel({ skill, entries: file.entries, labelOf: completionLabel });
    cassettes.set(c.id, { file, cas });
    runs.set(c.id, await runCase(c, cas.model));
  }
});

afterAll(() => {
  if (runs.size === cases.length) console.log(renderTable(score([...runs.values()])));
});

describe('golden cases', () => {
  it('there are golden cases, covering every storyline and SCN regression the eval was asked for', () => {
    const ids = cases.map((c) => c.id);
    for (const want of ['wi-002', 'wi-004', 'wi-006', 'wi-060', 'wi-008', 'wi-016', 'scn-1-', 'scn-4-', 'scn-9-', 'scn-14-', 'scn-11-']) expect(ids.some((id) => id.startsWith(want)), want).toBe(true);
  });

  for (const c of cases) {
    describe(c.id, () => {
      it('replays from its cassette with no miss and no stale entry', () => {
        const { file, cas } = cassettes.get(c.id)!;
        expect(cas.misses).toEqual([]);
        expect(file.entries.filter((e) => !e.hash || !cas.used.has(e.hash)).map((e) => e.label)).toEqual([]);
      });

      const items = c.items_expected.filter((i) => !i.knownGap);
      for (const it_ of items) {
        it(`item ${it_.id} is found: ${it_.title}`, () => {
          const run = runs.get(c.id)!;
          expect(run.itemIds.has(it_.id), run.why.get(it_.id)).toBe(true);
          const title = run.store.getWorkItem(run.itemIds.get(it_.id)!)!.title.toLowerCase();
          for (const k of it_.keywords) expect(title).toContain(k.toLowerCase());
        });
      }
      for (const cl of c.closures_expected.filter((x) => !x.knownGap)) {
        it(`item ${cl.item} ends ${cl.expect}${cl.reopened ? ' (after a reopen)' : ''}${cl.cite ? `, citing ${cl.cite}` : ''}`, () => {
          const r = judgeClosure(runs.get(c.id)!, cl);
          expect(r.problems).toEqual([]);
        });
      }
    });
  }
});

describe('scores', () => {
  it(`item recall on golden asks ≥ ${RECALL_GATE} and ${WRONG_CLOSE_GATE} wrong closes on still-owed items`, () => {
    const s = score([...runs.values()]);
    expect(s.recall.value).toBeGreaterThanOrEqual(RECALL_GATE);
    expect(s.wrongCloses).toEqual([]);
    expect(s.recall.expected).toBeGreaterThan(0);
  });

  it('known gaps are recorded with their SCN id (not gated), and none passes unflipped', () => {
    const s = score([...runs.values()]);
    for (const g of s.knownGaps) expect(g.gap).toMatch(/^SCN-\d+$/);
    expect(s.knownGaps.filter((g) => g.status !== 'still failing').map((g) => `${g.caseId} ${g.what}`), 'remove the knownGap mark').toEqual([]);
  });
});
