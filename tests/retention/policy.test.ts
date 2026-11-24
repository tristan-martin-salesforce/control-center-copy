import { describe, expect, it } from 'vitest';

import { RetentionSettings } from '@/contract/settings';
import { backupsToPrune, DELEGATED_RULES, referencedIdsUnion, RETENTION_DEFAULTS, SQL_RULES } from '@/db/retention/policy';

describe('retention policy (pure)', () => {
  it('defaults match the brief', () => {
    expect(RETENTION_DEFAULTS).toEqual({ enabled: true, llmTextDays: 30, traceDays: 14, eventsDays: 30, orphanSourceDays: 90 });
    expect(RetentionSettings.parse({})).toEqual(RETENTION_DEFAULTS);
  });

  it('every rule names its table once', () => {
    const tables = [...SQL_RULES.map((r) => r.table), ...DELEGATED_RULES.map((r) => r.table)];
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('the reference union names every column it is given', () => {
    const text = JSON.stringify(referencedIdsUnion([{ table: 'a', column: 'x', fk: true }, { table: 'b', column: 'ys', array: true, fk: false }]));
    expect(text).toContain('"a"');
    expect(text).toContain('unnest');
  });

  const name = (d: string) => `command_center-${d}-030000.dump`;
  it('keeps the newest 7 daily and the newest of each of 4 earlier weeks', () => {
    const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 10, 20) - i * 86_400_000).toISOString().slice(0, 10).replaceAll('-', ''));
    const doomed = new Set(backupsToPrune(days.map(name)));
    const kept = days.filter((d) => !doomed.has(name(d)));
    expect(kept.slice(0, 7)).toEqual(days.slice(0, 7));
    expect(kept.length).toBe(7 + 4);
    // one per distinct week beyond the daily ones
    expect(kept.length).toBeLessThan(days.length);
  });

  it('never touches names it does not understand, and keeps everything when few', () => {
    expect(backupsToPrune(['notes.txt', name('20261101')])).toEqual([]);
    expect(backupsToPrune([])).toEqual([]);
  });
});
