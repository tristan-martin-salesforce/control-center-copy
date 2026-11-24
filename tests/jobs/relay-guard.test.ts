/**
 * post-relay-holds: `relayGuard` with a job hold (the start gate's, or the one a continuation carries) books every
 * lookup into it and opens none of its own; past it, it asks once at the next lookup and queues the continuation on
 * the same hold. With no job hold (a direct call, no gate) it keeps the per-lookup hold. Memory store, fake lookups.
 */
import { describe, expect, it, vi } from 'vitest';

import { RELAY_DONE_VAR, relayGuard } from '@/jobs/handlers/relay-guard';
import type { JobContext } from '@/jobs/types';
import { gateJobStart, MemorySpendStore, SPEND_HOLD_VAR, SpendGovernor } from '@/llm/spend';

const T0 = new Date('2026-11-21T15:00:00.000Z');

/** A memory store that also answers `jobSpend` (what the lookups booked in llm_calls, by job id). */
class BookedStore extends MemorySpendStore {
  booked = new Map<string, number>();
  async jobSpend(jobId: number | string): Promise<number> {
    return this.booked.get(String(jobId)) ?? 0;
  }
  book(jobId: number | string, usd: number) {
    this.booked.set(String(jobId), Math.round(((this.booked.get(String(jobId)) ?? 0) + usd) * 1e6) / 1e6);
  }
}

function setup(o: { id?: number; payload?: Record<string, unknown> } = {}) {
  const store = new BookedStore({ now: () => T0, today: () => '2026-11-21' });
  const gov = new SpendGovernor(store);
  const id = o.id ?? 7;
  const enqueue = vi.fn(async () => ({ id: 99, inserted: true }));
  const ctx = {
    job: { id, kind: 'org62.readback', queue: 'maintenance', payload: o.payload ?? {}, maxAttempts: 3, timeoutSeconds: 600 },
    db: {},
    userId: 'u-placeholder',
    clock: () => T0,
    log: () => {},
    heartbeat: async () => {},
    enqueue,
    signal: new AbortController().signal,
    services: {},
  } as unknown as JobContext;
  const scanner = { reserveSpend: vi.fn(async () => ({ ok: true as const, release: async () => {} })), recordDecision: vi.fn(async () => {}) };
  const guard = relayGuard(ctx, 'org62-readback', { spend: gov, store: scanner as never });
  const lookup = (usd: number) => guard.run(async () => (store.book(id, usd), 'rows'));
  return { store, gov, ctx, enqueue, scanner, guard, lookup };
}

describe('relayGuard under a job hold', () => {
  it("books every lookup into the start gate's hold and opens none of its own", async () => {
    const { store, gov, guard, lookup, scanner } = setup();
    const g = await gateJobStart(gov, { id: 7, kind: 'org62.readback', payload: {} });
    expect(g.start && g.hold).toBeTruthy();
    expect(await guard.start!()).toBeNull();
    for (let i = 0; i < 5; i++) expect(await lookup(0.002)).toBe('rows');
    expect(store.holds.size).toBe(1); // the gate's; no per-lookup hold
    expect(scanner.reserveSpend).not.toHaveBeenCalled();
    expect(await guard.finish!()).toEqual({});
    // the gate settles its own hold (with the job's booked spend); the guard leaves it open
    expect([...store.holds.values()].map((h) => h.state)).toEqual(['open']);
    expect(store.events.size).toBe(0);
  });

  it('past the hold: one ask at the next lookup, nothing more runs, the continuation carries the hold', async () => {
    const { store, gov, guard, lookup, enqueue } = setup();
    await gateJobStart(gov, { id: 7, kind: 'org62.readback', payload: {} });
    const [hold] = [...store.holds.values()];
    expect(hold!.heldUsd).toBeCloseTo(0.06, 6); // org62-readback's row of the static table
    expect(await lookup(0.04)).toBe('rows');
    expect(await lookup(0.04)).toBe('rows'); // $0.08 of $0.06
    expect(await guard.run(async () => 'never', { pctDone: 40 })).toBeNull();
    expect(guard.stop).toBe('spend');
    expect(await guard.run(async () => 'never')).toBeNull();
    const asks = [...store.events.values()].filter((e) => e.code === 'SPEND.ASK');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.message).toBe('This lookup has used $0.08 of its $0.06 estimate and is 40% done; allow $0.04 more?');
    expect(store.holds.get(hold!.id)).toMatchObject({ state: 'asked', spentUsd: 0.08 });
    const r = await guard.finish!({ payload: { trigger: 'spend_continue' } });
    expect(r).toMatchObject({ paused: 'spend', holdId: hold!.id, queued: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const c = (enqueue.mock.calls[0] as unknown as [{ payload: Record<string, Record<string, unknown>> }])[0];
    expect(c.payload.trigger).toBe('spend_continue');
    expect(c.payload.vars).toEqual({ [SPEND_HOLD_VAR]: hold!.id, [RELAY_DONE_VAR]: 2 });
    expect(store.holds.size).toBe(1);
  });

  // P33-3: a lookup counts only once it returns, and the count stops at the first throw, so the continuation (which
  // resumes by position) starts at the failed batch instead of skipping it
  it('a lookup that threw is not counted done: the continuation resumes at it', async () => {
    const { gov, guard, lookup, enqueue } = setup();
    await gateJobStart(gov, { id: 7, kind: 'org62.readback', payload: {} });
    expect(await lookup(0.01)).toBe('rows'); // batch 1
    await expect(guard.run(async () => { throw new Error('transport'); })).rejects.toThrow('transport'); // batch 2 (the handler catches and goes on)
    expect(await lookup(0.01)).toBe('rows'); // batch 3: read, but past the failure (read again on the continuation)
    expect(await lookup(0.05)).toBe('rows'); // batch 4: $0.07 of $0.06
    expect(await guard.run(async () => 'never')).toBeNull(); // batch 5 asks
    expect(guard.stop).toBe('spend');
    await guard.finish!();
    const c = (enqueue.mock.calls[0] as unknown as [{ payload: Record<string, Record<string, unknown>> }])[0];
    expect(c.payload.vars![RELAY_DONE_VAR]).toBe(1); // only batch 1: the continuation starts at batch 2
  });

  it('a continuation resumes the allowed hold, reads on, and settles it with the whole spend', async () => {
    const first = setup();
    await gateJobStart(first.gov, { id: 7, kind: 'org62.readback', payload: {} });
    const [hold] = [...first.store.holds.values()];
    await first.lookup(0.07);
    expect(await first.lookup(0.01)).toBeNull();
    await first.guard.finish!();
    await first.gov.answer(hold!.id, { kind: 'approve', usd: 0.05 });

    // the continuation: another job id on the same store, carrying the hold and where it stopped
    const { store } = first;
    const gov = first.gov;
    const enqueue = vi.fn();
    const ctx = { ...first.ctx, job: { ...first.ctx.job, id: 8, payload: { vars: { [SPEND_HOLD_VAR]: hold!.id, [RELAY_DONE_VAR]: 1 } } }, enqueue } as unknown as JobContext;
    const guard = relayGuard(ctx, 'org62-readback', { spend: gov, store: first.scanner as never });
    expect(guard.resumeAt).toBe(1);
    expect(await guard.start!()).toBeNull();
    expect(await guard.run(async () => (store.book(8, 0.02), 'rows'))).toBe('rows');
    expect(await guard.finish!()).toEqual({});
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.holds.size).toBe(1);
    expect(store.holds.get(hold!.id)).toMatchObject({ state: 'settled', spentUsd: 0.09 });
  });

  it('a continuation whose ask is unanswered waits; one answered Stop ends quietly', async () => {
    const a = setup();
    await gateJobStart(a.gov, { id: 7, kind: 'org62.readback', payload: {} });
    const [hold] = [...a.store.holds.values()];
    await a.gov.ask(hold!);
    const waiting = relayGuard({ ...a.ctx, job: { ...a.ctx.job, id: 8, payload: { vars: { [SPEND_HOLD_VAR]: hold!.id } } } } as JobContext, 'org62-readback', { spend: a.gov, store: a.scanner as never });
    expect(await waiting.start!()).toMatchObject({ skipped: 'spend_ask_open', holdId: hold!.id });
    await a.gov.answer(hold!.id, { kind: 'deny' });
    const stopped = relayGuard({ ...a.ctx, job: { ...a.ctx.job, id: 9, payload: { vars: { [SPEND_HOLD_VAR]: hold!.id } } } } as JobContext, 'org62-readback', { spend: a.gov, store: a.scanner as never });
    expect(await stopped.start!()).toEqual({ skipped: 'spend_stopped', holdId: hold!.id });
    expect(a.store.holds.size).toBe(1);
  });
});

describe('relayGuard with no job hold (a direct call, no start gate)', () => {
  it('keeps the per-lookup hold: each lookup holds and settles its own', async () => {
    const { store, guard, lookup } = setup();
    expect(await guard.start!()).toBeNull();
    await lookup(0.002);
    await lookup(0.003);
    const holds = [...store.holds.values()];
    expect(holds).toHaveLength(2);
    expect(holds.map((h) => [h.jobKey, h.state, h.spentUsd])).toEqual([
      ['org62.readback:7', 'settled', 0.002],
      ['org62.readback:7', 'settled', 0.003],
    ]);
    expect(await guard.finish!()).toEqual({});
  });
});
