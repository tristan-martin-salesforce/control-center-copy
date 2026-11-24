/**
 * Settings ▸ Budgets ▸ "Today only": one rule (budgetsForDay) decides which limits are in force on a local day.
 */
import { describe, expect, it } from 'vitest';

import { BudgetSettings, budgetsForDay } from '@/contract';

const base = BudgetSettings.parse({ version: 1, softUsd: 5, hardUsd: 15, alertPct: 80 });

describe('budgetsForDay', () => {
  it('uses the standing limits when there is no override, or the override is for another day', () => {
    expect(base.today).toBeNull();
    expect(budgetsForDay(base, '2026-11-10')).toMatchObject({ softUsd: 5, hardUsd: 15, chatUsd: null, overridden: false });
    const yesterday = { ...base, today: { day: '2026-11-09', softUsd: 20, hardUsd: 30, chatUsd: 6 } };
    expect(budgetsForDay(yesterday, '2026-11-10')).toMatchObject({ softUsd: 5, hardUsd: 15, chatUsd: null, overridden: false });
  });

  it("uses today's override on its own day, including the assistant's line", () => {
    const b = { ...base, today: { day: '2026-11-10', softUsd: 20, hardUsd: 30, chatUsd: 6 } };
    expect(budgetsForDay(b, '2026-11-10')).toMatchObject({ softUsd: 20, hardUsd: 30, chatUsd: 6, overridden: true, alertPct: 80 });
    expect(budgetsForDay({ ...b, today: { ...b.today, chatUsd: null } }, '2026-11-10').chatUsd).toBeNull();
  });
});
