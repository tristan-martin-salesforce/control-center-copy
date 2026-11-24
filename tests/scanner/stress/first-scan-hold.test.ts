/**
 * ORG-7 / MIN-17 (placeholders only): in the first scan, `org62:opps` waits for `org62:book`, so Q2 (opps on my
 * accounts) reads the accounts the book projects instead of the few known at startup. Stage 2 read the newest week's
 * Q2 with 2 account ids of 37, and the window counted as covered for every account.
 */
import { describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../../src/scanner/runtime/clock';
import { org62Spec } from '../../../src/scanner/runtime/connectors';
import { FirstScan, MemoryFirstScanLedger } from '../../../src/scanner/runtime/first-scan';
import { retryJobOf, scanJob } from '../../../src/scanner/runtime/jobs';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { withTraceContext } from '../../../src/scanner/trace';
import { ScriptedSkillRunner, type Script } from '../runtime/helpers/scripted-runner';
import { PROFILE } from '../runtime/helpers/world';

const NOW = '2026-11-06T15:00:00.000Z';
const MIN = 60_000;
const W = { from: '2026-10-30T15:00:00.000Z', to: '2026-11-06T15:00:00.000Z' };

const finish: Script = async (api) => {
  const w = api.input.window!;
  await api.call('cc_report_coverage', { windows: [{ ref: 'soql:OpportunityTeamMember', from: w.from, to: w.to }, { ref: 'soql:Opportunity:accounts', from: w.from, to: w.to }] });
  await api.call('cc_finish', { cursor: { value: w.to, at: w.to }, complete: true });
};

function world() {
  const clock = new FakeClock(NOW);
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
  const runner = new ScriptedSkillRunner(finish);
  const ledger = new MemoryFirstScanLedger();
  ledger.state = { lookbackDays: 1, budgetUsd: 100, startedAt: NOW, floorAt: W.from, spentUsd: 0, byDay: {}, scopes: { 'org62:book': 'pending', 'org62:opps': 'pending', 'org62:events': 'pending' }, status: 'active' };
  const firstScan = new FirstScan({ lookbackDays: 1, budgetUsd: 100, connectors: ['org62'] }, ledger);
  const runtime = new ScannerRuntime({ store, runner, specs: [org62Spec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {}, firstScan });
  return { clock, store, runner, firstScan, runtime };
}
const job = (scope: string) => scanJob({ connector: 'org62', scope, window: W, mode: 'backfill', trigger: 'catch_up', runAt: NOW, budget: 'first_scan' });
const withAccounts = (store: InMemoryScannerStore, ids: string[]) => {
  const real = store.getContext.bind(store);
  vi.spyOn(store, 'getContext').mockImplementation(async (scope) => {
    const c = await real(scope);
    return { ...c, aliases: { ...c.aliases, accounts: ids.map((id, i) => ({ accountId: `00000000-0000-4000-a000-00000000000${i}`, names: [`PLACEHOLDER ${i}`, `org62:${id}`] })) } } as typeof c;
  });
};

describe('ORG-7: the first scan holds org62:opps until the book has projected accounts', () => {
  it('held while org62:book is pending: nothing runs, the job comes back in a minute, the scope stays pending', async () => {
    const w = world();
    const out = await w.runtime.executeJob(job('opps'));
    expect(out).toMatchObject({ status: 'skipped', held: true, followUps: [] });
    expect(Date.parse(out.retryAt!) - Date.parse(NOW)).toBe(MIN);
    expect(w.store.listRuns()).toHaveLength(0);
    expect(w.firstScan.state()!.scopes['org62:opps']).toBe('pending');
    // other Org62 scopes are not held
    expect((await w.runtime.executeJob(job('events'))).held).toBeUndefined();
  });

  it('book done and accounts projected: it runs', async () => {
    const w = world();
    w.firstScan.state()!.scopes['org62:book'] = 'done';
    withAccounts(w.store, ['001XX0000000001AAA', '001XX0000000002AAA']);
    const out = await w.runtime.executeJob(job('opps'));
    expect(out.held).toBeUndefined();
    expect(out.status).toBe('succeeded');
  });

  it('book done but no accounts yet: held up to 5 minutes, then it runs (a user with no accounts is not blocked)', async () => {
    const w = world();
    w.firstScan.state()!.scopes['org62:book'] = 'done';
    withAccounts(w.store, []);
    expect((await w.runtime.executeJob(job('opps'))).held).toBe(true);
    w.clock.advance(6 * MIN);
    expect((await w.runtime.executeJob(job('opps'))).held).toBeUndefined();
  });

  it('never held past 30 minutes from the first scan start, and never once the first scan is done', async () => {
    const w = world();
    w.clock.advance(31 * MIN);
    expect((await w.runtime.executeJob(job('opps'))).held).toBeUndefined();
    const v = world();
    v.firstScan.state()!.status = 'done';
    expect((await v.runtime.executeJob(job('opps'))).held).toBeUndefined();
  });

  it('a hold is not an attempt: the held job keeps its attempt and a stable key', () => {
    const j = { ...job('opps'), attempt: 2 };
    const h1 = retryJobOf(j, { retryAt: NOW, held: true });
    const h2 = retryJobOf(h1, { retryAt: NOW, held: true });
    expect([h1.attempt, h2.attempt, h2.held]).toEqual([2, 2, 2]);
    expect(h2.dedupeKey).toBe(`${j.dedupeKey}#held2`);
    const r = retryJobOf(j, { retryAt: NOW });
    expect([r.attempt, r.dedupeKey]).toEqual([3, `${j.dedupeKey}#retry`]);
  });

});

describe('BUD-1: first-scan spend has its own budget', () => {
  it('a $20 first-scan spend today leaves the daily cap untouched: a daily job is not over budget, a $16 daily spend is', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 15, softCapUsd: 5 });
    await withTraceContext({ budget: 'first_scan' }, () => store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 20, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' }));
    expect(store.spendToday()).toBe(20);
    expect(await store.budgetStatus()).toMatchObject({ todayUsd: 0, state: 'ok' });
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(finish), specs: [org62Spec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {}, firstScan: null });
    const daily = scanJob({ connector: 'org62', scope: 'events', window: W, mode: 'incremental', trigger: 'schedule', runAt: NOW });
    expect((await runtime.executeJob(daily)).detail).not.toBe('budget_hard_cap');
    await store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 16, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    expect((await store.budgetStatus()).state).toBe('capped');
    expect((await runtime.executeJob(daily)).detail).toBe('budget_hard_cap');
  });
});
