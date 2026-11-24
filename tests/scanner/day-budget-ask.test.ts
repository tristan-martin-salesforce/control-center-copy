/**
 * W12-1: the scanner's daily hard cap raises a hand through the spend governor instead of pausing silently until
 * tomorrow. Cap hit → one SPEND.DAY_BUDGET event (the day gate's fingerprint) and one asked hold, the scope stays
 * `paused: 'budget'` while it is open; Allow for today → the scope plans again on the next tick and runs past the cap;
 * Stop → it waits for tomorrow. Runtime fakes only (in-memory stores, scripted runner). Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import { MemorySpendStore, SpendGovernor, answerHold, dayBudgetFingerprint, SCAN_DAY_BUDGET_PREFIX } from '@/llm/spend';
import { spendAskOf } from '@/server/datasource/db/spend';
import { slackSpec } from '@/scanner/runtime/connectors';
import { ScannerRuntime } from '@/scanner/runtime/scanner-runtime';
import { FakeClock } from '@/scanner/runtime/clock';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import { PROFILE } from './runtime/helpers/world';
import { slackAgent } from './runtime/helpers/agents';
import { ScriptedSkillRunner } from './runtime/helpers/scripted-runner';

const NOW = '2026-11-05T16:00:00.000Z';

async function world() {
  const clock = new FakeClock(NOW);
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 15 });
  // the governor's day reads the scanner store's day (as the DB store does through budgetStatus)
  const spendStore = new MemorySpendStore({ now: () => clock.now(), today: () => clock.now().toISOString().slice(0, 10), day: () => ({ spentUsd: store.dailySpendToday(), softUsd: store.softCapUsd, hardUsd: store.hardCapUsd }) });
  const raise = spendStore.raiseToday.bind(spendStore);
  // "Allow for today" raises today's cap the scanner reads too (the DataSource's raiseBudgetToday)
  spendStore.raiseToday = async (addUsd: number, reason: string) => {
    store.hardCapUsd += addUsd;
    await raise(addUsd, reason);
  };
  const gov = new SpendGovernor(spendStore);
  const runner = new ScriptedSkillRunner(slackAgent());
  const runtime = new ScannerRuntime({ store, runner, specs: [slackSpec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {}, spend: gov });
  await store.recordSpend({ connector: 'chat', model: 'claude-sonnet-5-5', costUsd: 15.2, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
  return { clock, store, spendStore, gov, runtime };
}

const slackJobs = <T extends { kind: string }>(jobs: T[]) => jobs.filter((j) => j.kind === 'scan' && (j as { connector?: string }).connector === 'slack');
const dayAsks = (s: MemorySpendStore) => [...s.holds.values()].filter((h) => h.jobKey.startsWith(SCAN_DAY_BUDGET_PREFIX));

describe('scanner day cap → spend governor ask (W12-1)', () => {
  it('cap hit: one SPEND.DAY_BUDGET event and one asked hold, the scope paused for budget while it is open', async () => {
    const { runtime, spendStore, store } = await world();
    expect(slackJobs(await runtime.planJobs())).toEqual([]);
    expect(slackJobs(await runtime.planJobs())).toEqual([]); // a second tick asks nothing new
    const asks = dayAsks(spendStore);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ state: 'asked', scope: 'scan_run', budget: 'daily' });
    const events = [...spendStore.events.values()];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ code: 'SPEND.DAY_BUDGET', fingerprint: dayBudgetFingerprint('2026-11-05'), count: 1 });
    expect(events[0]!.detail).toMatchObject({ holdId: asks[0]!.id, connector: 'slack' });
    const slack = runtime.status().filter((s) => s.connector === 'slack');
    expect(slack.length).toBeGreaterThan(0);
    expect(slack.every((s) => s.paused === 'budget')).toBe(true);
    expect(store.latestHealth('slack')).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/Allow for today/) });
    // Health's row: the plain day-cap question (its buttons: Allow $Z more · Allow for today · Stop)
    expect(spendAskOf(asks[0]!).question).toMatch(/paused at today's spend cap/);
  });

  it('Allow for today: the scope runs again on the next tick, past the cap, without asking again today', async () => {
    const { runtime, spendStore, gov, clock } = await world();
    await runtime.planJobs();
    const [ask] = dayAsks(spendStore);
    await answerHold(gov, ask!.id, { answer: 'today' });
    expect(spendStore.raises).toHaveLength(1);
    const jobs = slackJobs(await runtime.planJobs());
    expect(jobs.length).toBeGreaterThan(0);
    expect(runtime.status().filter((s) => s.connector === 'slack').every((s) => s.paused === undefined)).toBe(true);
    expect((await gov.store.getHold(ask!.id))!.state).toBe('settled');
    const out = await runtime.executeJob(jobs[0] as never);
    expect(out.status).not.toBe('paused');
    clock.advance(60 * 60_000);
    await runtime.planJobs();
    expect(dayAsks(spendStore)).toHaveLength(1); // no second ask today
  });

  it('Stop: scans wait until tomorrow; the next day the cap resets and they resume', async () => {
    const { runtime, spendStore, gov, clock } = await world();
    await runtime.planJobs();
    const [ask] = dayAsks(spendStore);
    await answerHold(gov, ask!.id, { answer: 'deny' });
    expect(slackJobs(await runtime.planJobs())).toEqual([]);
    expect(dayAsks(spendStore)).toHaveLength(1);
    clock.advance(24 * 3600_000);
    expect(slackJobs(await runtime.planJobs()).length).toBeGreaterThan(0);
  });
});
