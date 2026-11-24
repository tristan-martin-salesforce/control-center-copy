/**
 * "Raise today's cap": raise only, a reason required, every raise kept (budgets.raises), the day's limits in force, and
 * PATCH /settings/budgets can't rewrite the history. The mock DataSource runs the same rule (raiseBudgetToday).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BudgetSettings, budgetsForDay, raiseBudgetToday, raiseSummary, Seed, SETTINGS_SECTION_SCHEMAS } from '@/contract';
import { MockDataSource } from '@/server/datasource/mock';
import { AppError } from '@/server/errors';

const base = BudgetSettings.parse({ version: 3, softUsd: 5, hardUsd: 15, alertPct: 80 });
const DAY = '2026-11-11';
const AT = '2026-11-11T18:00:00.000Z';

describe('raiseBudgetToday (the shared rule)', () => {
  it('raises the hard cap for today, moves the soft budget up by as much, and keeps the raise', () => {
    const { next, raise } = raiseBudgetToday(base, { hardUsd: 25, reason: 'first AE forecast run' }, DAY, AT);
    expect(raise).toEqual({ day: DAY, at: AT, fromSoftUsd: 5, toSoftUsd: 15, fromHardUsd: 15, toHardUsd: 25, reason: 'first AE forecast run' });
    expect(next.version).toBe(4);
    expect(next.today).toMatchObject({ day: DAY, softUsd: 15, hardUsd: 25, reason: 'first AE forecast run' });
    expect(budgetsForDay(next, DAY)).toMatchObject({ hardUsd: 25, softUsd: 15, overridden: true });
    // the standing limits are untouched, and tomorrow is back to them
    expect(next).toMatchObject({ softUsd: 5, hardUsd: 15 });
    expect(budgetsForDay(next, '2026-11-12')).toMatchObject({ hardUsd: 15, overridden: false });
    expect(raiseSummary(raise)).toBe("Raised today's cap $15 → $25: first AE forecast run");
  });

  it('a second raise the same day starts from the raised cap and keeps both', () => {
    const one = raiseBudgetToday(base, { hardUsd: 25, reason: 'catching up' }, DAY, AT).next;
    const { next, raise } = raiseBudgetToday(one, { hardUsd: 40, softUsd: 30, reason: 'still catching up' }, DAY, '2026-11-11T20:00:00.000Z');
    expect(raise).toMatchObject({ fromHardUsd: 25, toHardUsd: 40, fromSoftUsd: 15, toSoftUsd: 30 });
    expect(next.raises.map((r) => r.toHardUsd)).toEqual([25, 40]);
  });

  it('refuses a lower or equal cap, a missing reason, and soft above hard', () => {
    expect(() => raiseBudgetToday(base, { hardUsd: 15, reason: 'same' }, DAY, AT)).toThrow(/already \$15/);
    expect(() => raiseBudgetToday(base, { hardUsd: 10, reason: 'lower' }, DAY, AT)).toThrow(/raise it above/);
    expect(() => raiseBudgetToday(base, { hardUsd: 25, reason: '  ' }, DAY, AT)).toThrow(/Say why/);
    expect(() => raiseBudgetToday(base, { hardUsd: 25, softUsd: 30, reason: 'too soft' }, DAY, AT)).toThrow(/soft budget/);
  });

  it("yesterday's raise is history, not today's limit", () => {
    const y = raiseBudgetToday(base, { hardUsd: 25, reason: 'yesterday' }, '2026-11-10', AT).next;
    const { raise, next } = raiseBudgetToday(y, { hardUsd: 20, reason: 'today' }, DAY, AT);
    expect(raise.fromHardUsd).toBe(15);
    expect(next.raises.map((r) => r.day)).toEqual(['2026-11-10', DAY]);
  });

  it('PATCH /settings/budgets cannot rewrite the raise history', () => {
    const parsed = SETTINGS_SECTION_SCHEMAS.budgets.parse({ softUsd: 6, raises: [] }) as Record<string, unknown>;
    expect(parsed).toEqual({ softUsd: 6 });
  });
});

describe('POST /budgets/raise-today on the mock DataSource', () => {
  let ds: MockDataSource | null = null;
  afterEach(() => ds?.dispose());

  it('raises, records the raise, updates the spend line, and refuses a lower cap', async () => {
    const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
    ds = new MockDataSource({ seed: structuredClone(seed), delays: { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 }, autoplay: false, clockMode: 'seed' });
    const before = (await ds.getSettings({} as never)).budgets;
    const cap = (await ds.getHealth({} as never)).spend.today.hardCapUsd;
    const r = await ds.raiseBudgetToday({ body: { hardUsd: cap + 10, reason: 'demo day' } } as never);
    expect(r.auditId).toBeTruthy();
    expect(r.entity.raises.at(-1)).toMatchObject({ fromHardUsd: cap, toHardUsd: cap + 10, reason: 'demo day' });
    expect(r.entity.version).toBe(before.version + 1);
    expect((await ds.getHealth({} as never)).spend.today.hardCapUsd).toBe(cap + 10);
    await expect(ds.raiseBudgetToday({ body: { hardUsd: cap, reason: 'lower' } } as never)).rejects.toBeInstanceOf(AppError);
  });
});
