/**
 * Health's Ranking and Resolution check lines in plain words (18-ui-polish.md): no engine version ("priority@2") and no
 * "shadow" on screen; the server's wording stays as it is for logs.
 */
import { describe, expect, it } from 'vitest';
import { healthPlain } from '@/components/health/plain';

describe('healthPlain', () => {
  it('the ranking line', () => {
    expect(healthPlain('Ranking: priority@2 in shadow · no runs yet')).toBe('Ranking: the new ranking, previewed beside your list · no runs yet');
    expect(healthPlain('Ranking: priority@2 on · agrees 0.67 on the Top 3 over 7 days (3 runs)')).toBe('Ranking: the new ranking, as your list · agrees on 67% of the Top 3 over 7 days (3 runs)');
    expect(healthPlain('Ranking: priority@1.1 (priority@2 is off)')).toBe('Ranking: your current ranking (the new ranking is off)');
  });

  it('the resolution check line', () => {
    expect(healthPlain('Resolution check (shadow): no checks this week yet')).toBe('Resolution check (watch only): no checks this week yet');
  });

  it('never leaves an engine id or "shadow" behind', () => {
    for (const s of ['Ranking: priority@2 in shadow · agrees 0.5 on the Top 3', 'Resolution check (shadow): 12 checks this week']) {
      expect(healthPlain(s)).not.toMatch(/priority@|shadow/);
    }
    expect(healthPlain(null)).toBeNull();
  });
});
