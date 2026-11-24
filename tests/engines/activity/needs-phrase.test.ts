/**
 * Activity's Needs-you sentence (24-visual-qa surface 5): one plain sentence for 0, 1 or many of each part, the use
 * cases said once ("6 rows, 1 use case and 3 use cases to add need you" named them twice).
 */
import { describe, expect, it } from 'vitest';

import { needsYouCount, needsYouPhrase } from '@/engines/activity/needs-count';

const say = (rows: number, useCases: number, candidates: number) => needsYouPhrase(needsYouCount({ rows, useCases, candidates }));

describe('needsYouPhrase', () => {
  it('the QA case reads as one sentence, use cases once', () => {
    expect(say(6, 1, 3)).toBe('6 rows and 4 use cases (3 to add) need you');
  });

  it('every mix of 0, 1 and many reads correctly', () => {
    const cases: [number, number, number, string | null][] = [
      [0, 0, 0, null],
      [1, 0, 0, '1 row needs you'],
      [6, 0, 0, '6 rows need you'],
      [0, 1, 0, '1 use case needs you'],
      [0, 3, 0, '3 use cases need you'],
      [0, 0, 1, '1 use case to add needs you'],
      [0, 0, 3, '3 use cases to add need you'],
      [0, 1, 1, '2 use cases (1 to add) need you'],
      [0, 2, 3, '5 use cases (3 to add) need you'],
      [1, 1, 0, '1 row and 1 use case need you'],
      [1, 0, 1, '1 row and 1 use case to add need you'],
      [1, 1, 1, '1 row and 2 use cases (1 to add) need you'],
      [6, 0, 3, '6 rows and 3 use cases to add need you'],
      [6, 3, 0, '6 rows and 3 use cases need you'],
    ];
    for (const [rows, useCases, candidates, want] of cases) expect(say(rows, useCases, candidates), `${rows}/${useCases}/${candidates}`).toBe(want);
  });

  it('never repeats "use case" and never lists with a comma', () => {
    for (const r of [0, 1, 4]) for (const u of [0, 1, 4]) for (const k of [0, 1, 4]) {
      const s = say(r, u, k);
      if (!s) continue;
      expect(s.match(/use case/g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(s).not.toContain(',');
    }
  });
});
