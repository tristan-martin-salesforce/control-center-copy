import { describe, expect, it } from 'vitest';
import { budgetSegments, filterEvents, groupJobs, topWithOther } from '@/components/health/derive';

describe('health derive', () => {
  it('groups jobs with dead-letter first and filters events', () => {
    const j = (id: string, status: string) => ({ id, status }) as never;
    expect(groupJobs([j('1', 'queued'), j('2', 'dead')]).map((g) => g.status)).toEqual(['dead', 'queued']);
    const e = (id: string, level: string, source: string, acknowledged = false, lastSeenAt = '2026-11-05T10:00:00Z') => ({ id, level, source, acknowledged, lastSeenAt }) as never;
    const rows = [e('a', 'warn', 'slack'), e('b', 'error', 'gmail'), e('c', 'error', 'gmail', true)];
    expect(filterEvents(rows, { level: 'error', source: 'all', showAcknowledged: false }).map((x) => x.id)).toEqual(['b']);
    expect(filterEvents(rows, { level: 'all', source: 'all', showAcknowledged: true }).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('folds long spend lists into Other and places the soft line on the cap bar', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, usd: i + 1 }));
    const top = topWithOther(rows, 6);
    expect(top).toHaveLength(6);
    expect(top[5]).toEqual({ name: 'Other', usd: 6 }); // 3+2+1
    expect(budgetSegments({ usd: 3, softBudgetUsd: 5, hardCapUsd: 15, pct: 60 })).toEqual({ usedPct: 20, softPct: (5 / 15) * 100 });
  });
});
