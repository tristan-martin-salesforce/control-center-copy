/**
 * Post-contract-bounds (26-caps-audit.md, "Contract bounds"): the user-entered bounds that were arbitrary are lifted.
 * Each lift is additive: values under the old bound still parse, and a value past it parses too.
 */
import { describe, expect, it } from 'vitest';
import { ClosingSettings, DEFAULT_TIME_SETTINGS, RETENTION_DAYS_MAX, RetentionSettings, TimeSettings } from '@/contract';
import { cutoff } from '@/db/retention/policy';

const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));

describe('TimeSettings.dcProducts', () => {
  it('takes more than the old 30 products', () => {
    const products = many(45, (i) => `Product ${i}`);
    expect(TimeSettings.parse({ ...DEFAULT_TIME_SETTINGS, dcProducts: products }).dcProducts).toEqual(products);
    expect(TimeSettings.parse({ ...DEFAULT_TIME_SETTINGS, dcProducts: products.slice(0, 30) }).dcProducts).toHaveLength(30);
  });

  it('still checks each product name', () => {
    expect(TimeSettings.safeParse({ ...DEFAULT_TIME_SETTINGS, dcProducts: ['x'] }).success).toBe(false);
  });
});

describe('TimeSettings.coveredAes', () => {
  it('takes more than the old 50 AEs', () => {
    const aes = many(60, (i) => `AE ${i}`).map((name) => ({ name, enabled: true }));
    expect(TimeSettings.parse({ ...DEFAULT_TIME_SETTINGS, coveredAes: aes }).coveredAes).toHaveLength(60);
  });
});

describe('ClosingSettings ask-first lists', () => {
  it('take more than the old 50 people and channels', () => {
    const people = many(70, (i) => `Person ${i}`);
    const channels = many(70, (i) => `#channel-${i}`);
    const c = ClosingSettings.parse({ version: 1, askFirstPeople: people, askFirstChannels: channels });
    expect(c.askFirstPeople).toHaveLength(70);
    expect(c.askFirstChannels).toHaveLength(70);
  });
});

describe('ClosingSettings.oldAskDays', () => {
  it('takes more than the old 365 days, still 3 or more whole days', () => {
    expect(ClosingSettings.parse({ version: 1, oldAskDays: 730 }).oldAskDays).toBe(730);
    for (const n of [2, 3.5]) expect(ClosingSettings.safeParse({ version: 1, oldAskDays: n }).success).toBe(false);
  });
});

describe('RetentionSettings horizons', () => {
  it('take more than the old 10 years (3,650 days)', () => {
    const r = RetentionSettings.parse({ llmTextDays: 3651, traceDays: 5000, eventsDays: 7300, orphanSourceDays: 36_500 });
    expect([r.llmTextDays, r.traceDays, r.eventsDays, r.orphanSourceDays]).toEqual([3651, 5000, 7300, 36_500]);
  });

  it('stop where the cut-off date would stop being a date', () => {
    expect(() => cutoff(new Date('2026-11-21T00:00:00Z'), RETENTION_DAYS_MAX)).not.toThrow();
    expect(RetentionSettings.safeParse({ llmTextDays: RETENTION_DAYS_MAX + 1 }).success).toBe(false);
  });
});
