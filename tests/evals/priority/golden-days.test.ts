/**
 * Golden days (lane 07 R9, §4.5, PRIO-15): "for this realistic day, is the Top N right?". Each fixture in
 * ./golden-days names a moment in the synthetic sample database and what a good first screen holds (from
 * sample-data/CAST-work.md). Both engines run over the sample through the prod input builder in milliseconds:
 *
 * - priority@2 (the shadow engine, `settings.priority.engine`) is the gate: every expectation holds, or it is marked
 *   `knownGap` with the version expected to close it;
 * - priority@1.1 (the shown ranking until v2 is switched on) is measured and printed next to it, never gated here
 *   (its own invariants live in tests/engines/priority/*).
 *
 * The test prints agreement@3 per day for v1 and v2. CI gate: an engine or policy change may not turn a passing v2
 * expectation into a failure.
 */
import { describe, expect, it } from 'vitest';
import { rankWork } from '@/engines/priority/rank';
import { rankWorkV2 } from '@/engines/priority/v2/rank';
import { comparisonTable, report, scoreDay, type DayScore } from './golden';
import { goldenInputs, loadGoldenDays } from './sample-day';

const days = loadGoldenDays();

describe('priority golden days', () => {
  it('has the four days (sample Wednesday, Friday blueprint, Monday onsite, overbooked Tuesday)', () => {
    expect(days.map((d) => d.name)).toEqual(['sample-wednesday', 'friday-blueprint', 'monday-onsite', 'overbooked-tuesday']);
  });

  const v1: DayScore[] = [];
  const v2: DayScore[] = [];
  for (const day of days) {
    it(`${day.name}: every expectation holds under priority@2 or is a recorded known gap`, () => {
      const t0 = performance.now();
      const { inputs, keyOf } = goldenInputs(day);
      const s2 = scoreDay(day, rankWorkV2(inputs), keyOf);
      v2.push(s2);
      v1.push(scoreDay(day, rankWork(inputs), keyOf));
      expect(performance.now() - t0).toBeLessThan(2_000); // milliseconds in practice; generous for a cold CI box
      expect(s2.failures.map((f) => `${f.expectation.kind}: ${f.detail}`)).toEqual([]);
      expect(s2.fixedGaps.map((f) => `${f.expectation.kind}: ${f.detail}`)).toEqual([]); // a gap that closed drops its marker
    });
  }

  it('prints agreement@3, priority@1.1 vs priority@2', () => {
    console.log(comparisonTable(v1, v2));
    console.log(report(v2));
    expect(v2.length).toBe(days.length);
    // the Friday blueprint stays perfect under v2
    expect(v2.find((s) => s.name === 'friday-blueprint')?.agreement3).toBe(1);
  });
});
