/**
 * The one wording for an estimate's median and p90 (24-visual-qa surface 3): Getting started, onboarding (both through
 * firstScanLine) and Health ▸ Spend say "usually about $A, up to $B", never "(p50–p90)".
 */
import { describe, expect, it } from 'vitest';

import { firstScanLine, usualCost } from '@/llm/spend/first-scan';

describe('usualCost', () => {
  it('says the usual cost and the most it is likely to reach, in plain words', () => {
    expect(usualCost(12.81, 20.33)).toBe('usually about $12.81, up to $20.33');
    expect(firstScanLine({ p50: 12.81, p90: 20.33, minutes: 240 }, () => 'about 4 h')).toBe('First scan: usually about $12.81, up to $20.33, about 4 h');
  });

  it('one number when both read the same; never an upper bound below the usual; the caller’s money format', () => {
    expect(usualCost(3.1, 3.1)).toBe('about $3.10');
    expect(usualCost(3.104, 3.101)).toBe('about $3.10');
    expect(usualCost(5, 4)).toBe('about $5.00');
    expect(usualCost(0.38, 0.61, (n) => `$${n.toFixed(3)}`)).toBe('usually about $0.380, up to $0.610');
  });

  it('carries no percentile words', () => {
    for (const [a, b] of [[0, 0], [0.01, 2], [12.81, 20.33]] as const) expect(usualCost(a, b)).not.toMatch(/p50|p90|percentile|–/);
  });
});
