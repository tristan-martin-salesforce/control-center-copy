/**
 * 01 UI-3: one "needs you" count on Activity. The header said "6 rows need you" while the Needs-you tab said 7 (6 rows
 * plus 1 use-case question). Both now read needsYouCount, so they cannot differ; the header names what it counts.
 */
import { describe, expect, it } from 'vitest';

import { needsYouCount, needsYouPhrase } from '../../src/engines/activity/needs-count';

describe('needsYouCount', () => {
  it('the header and the tab share one total: rows plus use-case questions', () => {
    const c = needsYouCount({ rows: 6, useCases: 1 });
    expect(c).toEqual({ rows: 6, useCases: 1, candidates: 0, total: 7 });
    expect(needsYouPhrase(c)).toBe('6 rows and 1 use case need you'); // the number the tab shows (7) is in the sentence's parts
  });

  it('says only what waits, and agrees in number', () => {
    expect(needsYouPhrase(needsYouCount({ rows: 6, useCases: 0 }))).toBe('6 rows need you');
    expect(needsYouPhrase(needsYouCount({ rows: 1, useCases: 0 }))).toBe('1 row needs you');
    expect(needsYouPhrase(needsYouCount({ rows: 0, useCases: 1 }))).toBe('1 use case needs you');
    expect(needsYouPhrase(needsYouCount({ rows: 0, useCases: 3 }))).toBe('3 use cases need you');
    expect(needsYouPhrase(needsYouCount({ rows: 0, useCases: 0 }))).toBeNull();
  });

  it('is total for any parts, and never negative or fractional', () => {
    for (const [rows, useCases] of [[0, 0], [2, 5], [71, 3]] as const) expect(needsYouCount({ rows, useCases }).total).toBe(rows + useCases);
    expect(needsYouCount({ rows: -2, useCases: 1.9 })).toEqual({ rows: 0, useCases: 1, candidates: 0, total: 1 });
  });
});
