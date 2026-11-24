/**
 * The spend governor (src/llm/spend; holistic review 2026-11-20, H-5) over its memory store: the estimator with and
 * without samples, hold arithmetic (p90 headroom, the user's budget, daily aggregation across scopes), the ask /
 * continue transitions and the three answers, settle, the sweep, the first-scan estimator and the worker's day gate.
 * Amounts only; no model, no database.
 */
import { describe, expect, it } from 'vitest';

import {
  askMoreUsd,
  askQuestion,
  dayHeadroom,
  defaultEstimate,
  deliverAnswer,
  estimateFirstScan,
  estimateFromSamples,
  exceededOf,
  firstScanLine,
  gateJobStart,
  holdAmount,
  holdGate,
  MemorySpendStore,
  MIN_SAMPLES,
  quantile,
  SpendGovernor,
  waitForAnswer,
  answerHold,
} from '@/llm/spend';

const T0 = new Date('2026-11-20T15:00:00.000Z');
const gov = (o: ConstructorParameters<typeof MemorySpendStore>[0] = {}) => new SpendGovernor(new MemorySpendStore({ now: () => T0, today: () => '2026-11-20', ...o }));

describe('estimate', () => {
  it('quantiles interpolate', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([0, 10], 0.9)).toBe(9);
    expect(quantile([], 0.5)).toBe(0);
  });

  it('under 10 samples the static table answers; with them, p50 / p90 of the samples', async () => {
    const g = gov({ samples: { 'scan_run|scan-slack': [0.01, 0.02, 0.03] } });
    const few = await g.estimate({ scope: 'scan_run', jobKey: 'j', skill: 'scan-slack' });
    expect(few).toEqual({ ...defaultEstimate('scan_run', 'scan-slack'), basis: 'default', n: 0 });
    expect(few.p50).toBe(0.012);
    const xs = Array.from({ length: 20 }, (_, i) => (i + 1) / 100); // 0.01 … 0.20
    (g.store as MemorySpendStore).samples['scan_run|scan-slack'] = xs;
    const e = await g.estimate({ scope: 'scan_run', jobKey: 'j', skill: 'scan-slack' });
    expect(e.basis).toBe('history');
    expect(e.n).toBe(20);
    expect(e.p50).toBeCloseTo(0.105, 6);
    expect(e.p90).toBeCloseTo(0.181, 6);
    expect(MIN_SAMPLES).toBe(10);
  });

  it('per-item scopes scale with items (table and history)', async () => {
    expect(defaultEstimate('settle_pass', undefined, 50).p90).toBeCloseTo(0.6, 6);
    const g = gov({ samples: { 'settle_pass|settle-item': Array(12).fill(0.002) } });
    const e = await g.estimate({ scope: 'settle_pass', jobKey: 'p', skill: 'settle-item', items: 30 });
    expect(e).toMatchObject({ basis: 'history', p50: 0.06, p90: 0.06 });
  });

  it('bad samples are ignored, and p90 is never below p50', () => {
    const e = estimateFromSamples([NaN, -1, ...Array(10).fill(0.5)], defaultEstimate('job'));
    expect(e).toMatchObject({ basis: 'history', n: 10, p50: 0.5, p90: 0.5 });
  });
});

describe('hold arithmetic', () => {
  it('holds p90 (never the worst case) or the unit budget the user set', () => {
    expect(holdAmount({ p90: 0.03 })).toBe(0.03);
    expect(holdAmount({ p90: 0.03 }, 0.25)).toBe(0.25);
    expect(holdAmount({ p90: 0 })).toBe(0.0001);
  });

  it('aggregates every live hold of the day across scopes, and refuses only past the hard cap', async () => {
    const g = gov({ day: () => ({ spentUsd: 9, softUsd: 5, hardUsd: 10 }) });
    const scan = await g.hold({ scope: 'scan_run', jobKey: 'scan:slack:inbox:1' }, { p50: 0.1, p90: 0.4, basis: 'default', n: 0 });
    const chat = await g.hold({ scope: 'chat_message', jobKey: 'm1' }, { p50: 0.1, p90: 0.3, basis: 'default', n: 0 }, { budgetUsd: 0.25 });
    expect(scan.ok && chat.ok).toBe(true);
    const day = await g.store.dayStatus();
    expect(day.heldUsd).toBeCloseTo(0.65, 6);
    expect(dayHeadroom(day, 0.3)).toMatchObject({ ok: true, leftUsd: 0.35 });
    // a relay that would pass $10: refused, with the day it saw
    const relay = await g.hold({ scope: 'relay', jobKey: 'r' }, { p50: 0.2, p90: 0.4, basis: 'default', n: 0 });
    expect(relay).toMatchObject({ ok: false, reason: 'day_budget', wantUsd: 0.4 });
    // a settled hold releases its share
    if (scan.ok) await g.settle(scan.hold, 0.12);
    expect((await g.store.dayStatus()).heldUsd).toBeCloseTo(0.25, 6);
    // first-scan holds never count on the day; an interactive hold may skip the check
    expect((await g.hold({ scope: 'scan_run', jobKey: 'fs', budget: 'first_scan' }, { p50: 3, p90: 5, basis: 'default', n: 0 })).ok).toBe(true);
    expect((await g.hold({ scope: 'chat_message', jobKey: 'm2' }, { p50: 3, p90: 5, basis: 'default', n: 0 }, { skipDayCheck: true })).ok).toBe(true);
    expect((await g.store.dayStatus()).heldUsd).toBeCloseTo(5.25, 6);
  });
});

describe('ask / continue', () => {
  it('continues under the hold, asks past it, and the plain question names the numbers', async () => {
    const g = gov();
    const r = await g.hold({ scope: 'scan_run', jobKey: 'scan:slack:inbox:x' }, { p50: 0.02, p90: 0.04, basis: 'history', n: 12 });
    if (!r.ok) throw new Error('refused');
    const h = r.hold;
    expect(g.tick(h, 0.03, 'c1')).toBe('continue');
    expect(g.tick(h, 0.02, 'c2')).toBe('ask');
    expect(h.callIds).toEqual(['c1', 'c2']);
    expect(askMoreUsd(h)).toBe(0.02);
    expect(askQuestion(h, 62, 0.02)).toBe('This scan has used $0.05 of its $0.04 estimate and is 62% done; allow $0.02 more?');
    const a = await g.ask(h, { pctDone: 62 });
    expect(a.hold.state).toBe('asked');
    const store = g.store as MemorySpendStore;
    expect([...store.events.values()][0]).toMatchObject({ code: 'SPEND.ASK', severity: 'warn', detail: { holdId: h.id, pctDone: 62 } });
  });

  it('Allow $Z more raises the hold; Allow for today never asks again; Stop is denied and settled', async () => {
    const g = gov({ day: () => ({ spentUsd: 14.9, softUsd: 5, hardUsd: 15 }) });
    const mk = async (k: string) => {
      const r = await g.hold({ scope: 'scan_run', jobKey: k }, { p50: 0.02, p90: 0.04, basis: 'default', n: 0 }, { skipDayCheck: true });
      if (!r.ok) throw new Error('refused');
      g.tick(r.hold, 0.05);
      await g.ask(r.hold);
      return r.hold;
    };
    const a = await mk('a');
    const more = await g.answer(a.id, { kind: 'approve', usd: 0.02 });
    expect(more).toMatchObject({ state: 'approved', answerUsd: 0.02, heldUsd: 0.06 });
    expect(exceededOf({ ...more!, spentUsd: 0.05 })).toBe('continue');
    expect(exceededOf({ ...more!, spentUsd: 0.07 })).toBe('ask'); // past the raise, it asks again

    const b = await mk('b');
    const today = await g.answer(b.id, { kind: 'today' });
    expect(today).toMatchObject({ state: 'approved', answerUsd: null });
    expect(exceededOf({ ...today!, spentUsd: 99 })).toBe('continue');
    // the day had no room for it: today's cap moved up by its hold, today only
    expect((g.store as MemorySpendStore).raises).toEqual([{ addUsd: 0.04, reason: 'Allowed for today from a spend ask' }]);

    const c = await mk('c');
    const stop = await g.answer(c.id, { kind: 'deny' });
    expect(stop).toMatchObject({ state: 'denied' });
    expect(stop!.settledAt).not.toBeNull();
    expect(exceededOf(stop!)).toBe('ask');
    // settle keeps denied; the ask's event is resolved
    expect((await g.settle(stop!, 0.05)).state).toBe('denied');
    expect([...(g.store as MemorySpendStore).events.values()].every((e) => e.resolved)).toBe(true);
    // a settled hold takes no more answers
    expect((await g.answer(c.id, { kind: 'approve', usd: 1 }))!.state).toBe('denied');
    expect(await g.answer('missing', { kind: 'deny' })).toBeNull();
  });

  it('a waiting run takes the answer in process; otherwise the job is re-queued (or cancelled on Stop)', async () => {
    const g = gov();
    const r = await g.hold({ scope: 'chat_message', jobKey: 'm' }, { p50: 0.1, p90: 0.3, basis: 'default', n: 0 }, { budgetUsd: 0.25 });
    if (!r.ok) throw new Error('refused');
    g.tick(r.hold, 0.3);
    await g.ask(r.hold);
    const waiting = waitForAnswer(r.hold.id, { timeoutMs: 1000 });
    const res = await answerHold(g, r.hold.id, { answer: 'approve', usd: 0.13 });
    expect(res).toMatchObject({ resumed: true });
    expect(await waiting).toEqual({ kind: 'approve', usd: 0.13 });
    // nobody waits: the job is re-queued with the answer
    const r2 = await g.hold({ scope: 'scan_run', jobKey: 's' }, { p50: 0.1, p90: 0.3, basis: 'default', n: 0 });
    if (!r2.ok) throw new Error('refused');
    await g.ask(r2.hold);
    const seen: string[] = [];
    const res2 = await answerHold(g, r2.hold.id, { answer: 'deny' }, { requeue: async (h) => void seen.push(`requeue:${h.id}`), cancel: async (h) => void seen.push(`cancel:${h.id}`) });
    expect(res2).toMatchObject({ resumed: false });
    expect(seen).toEqual([`cancel:${r2.hold.id}`]);
    expect(deliverAnswer('nobody', { kind: 'deny' })).toBe(false);
    expect(await waitForAnswer('times-out', { timeoutMs: 5 })).toBeNull();
  });

  it('the scan gate sees the run across queries and holds a runaway ceiling, not the soft line', async () => {
    const g = gov();
    const r = await g.hold({ scope: 'scan_run', jobKey: 'k' }, { p50: 0.01, p90: 0.03, basis: 'default', n: 0 });
    if (!r.ok) throw new Error('refused');
    const gate = holdGate(g, r.hold, { minCeilingUsd: 0.05 });
    expect(gate.ceilingUsd()).toBeCloseTo(0.12, 6); // 4 × the hold
    expect(gate.observe(0.02)).toBe('continue');
    gate.endQuery(0.02);
    expect(gate.observe(0.011)).toBe('ask'); // 0.02 + 0.011 > 0.03
    await gate.ask({ pctDone: 40 });
    expect(r.hold.state).toBe('asked');
    expect(gate.observe(0)).toBe('ask');
  });

  it('the sweep abandons holds nobody settled', async () => {
    let now = T0;
    const store = new MemorySpendStore({ now: () => now, today: () => '2026-11-20' });
    const g = new SpendGovernor(store);
    const r = await g.hold({ scope: 'job', jobKey: 'j' }, { p50: 0.1, p90: 0.2, basis: 'default', n: 0 });
    now = new Date(T0.getTime() + 7 * 3600_000);
    expect(await g.sweep()).toBe(1);
    expect((await store.getHold(r.ok ? r.hold.id : ''))!.state).toBe('abandoned');
    expect((await store.dayStatus()).heldUsd).toBe(0);
  });

  it('caps audit: the sweep and listHolds see every hold, not the newest 200 or 500', async () => {
    let now = T0;
    const store = new MemorySpendStore({ now: () => now, today: () => '2026-11-20' });
    const g = new SpendGovernor(store);
    for (let i = 0; i < 620; i += 1) await g.hold({ scope: 'job', jobKey: `j${i}` }, { p50: 0.0005, p90: 0.001, basis: 'default', n: 0 });
    expect(await store.listHolds({})).toHaveLength(620);
    expect(await store.listHolds({ limit: 1 })).toHaveLength(1);
    now = new Date(T0.getTime() + 7 * 3600_000);
    expect(await g.sweep()).toBe(620);
    expect((await store.dayStatus()).heldUsd).toBe(0);
  });
});

describe('first scan (COST-9)', () => {
  it('per-source $/day × days, measured medians where there are enough days, plus read-ins', () => {
    const e = estimateFirstScan(['slack', 'gmail'], { days: 14 });
    expect(e.basis).toBe('default');
    expect(e.p50).toBeCloseTo(0.26 * 14 + 0.019 * 14 + 1.5, 1);
    expect(e.p90).toBeGreaterThan(e.p50);
    expect(e.minutes).toBe(114);
    const m = estimateFirstScan(['slack', 'gmail'], { days: 14 }, { slack: { p50: 0.1, p90: 0.2, n: 9 }, gmail: { p50: 1, p90: 1, n: 2 } });
    expect(m.basis).toBe('mixed');
    expect(m.bySource.find((s) => s.source === 'slack')).toMatchObject({ basis: 'history', p50: 1.4, p90: 2.8 });
    expect(firstScanLine({ p50: 3.1, p90: 5.4, minutes: 240 }, () => 'about 4 h')).toBe('First scan: usually about $3.10, up to $5.40, about 4 h');
  });
});

describe("the worker's day gate", () => {
  it('starts an LLM job with a hold, declines it with one SPEND.DAY_BUDGET event past the cap, ignores other jobs', async () => {
    let spent = 0;
    const g = gov({ day: () => ({ spentUsd: spent, softUsd: 5, hardUsd: 1 }) });
    const ok = await gateJobStart(g, { id: 1, kind: 'brief.generate' });
    expect(ok).toMatchObject({ start: true });
    expect(ok.start && ok.hold?.scope).toBe('job');
    expect(await gateJobStart(g, { id: 2, kind: 'backup.nightly' })).toEqual({ start: true, hold: null });
    spent = 0.99;
    const no = await gateJobStart(g, { id: 3, kind: 'org62.readback' });
    expect(no).toMatchObject({ start: false, reason: 'day_budget' });
    await gateJobStart(g, { id: 4, kind: 'activity.notes' });
    const evs = [...(g.store as MemorySpendStore).events.values()].filter((e) => e.code === 'SPEND.DAY_BUDGET');
    expect(evs).toHaveLength(1);
    expect(evs[0]!.count).toBe(2);
    expect(evs[0]!.message).toMatch(/wait until tomorrow or a higher cap/);
    // a first-scan job spends its own envelope
    expect(await gateJobStart(g, { id: 5, kind: 'settle.check', payload: { budget: 'first_scan' } })).toMatchObject({ start: true });
  });
});
