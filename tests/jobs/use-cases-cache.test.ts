/**
 * Caps audit 26 F-3: `use_cases.extract` keeps each confirm answer per (source, prompt version, statements), so the
 * next pass asks only what it never answered or what changed, a page at a time (the fixed 12 calls a pass are gone:
 * before, every pass re-asked the same first 12 unsure sources and never reached the rest). An unusable answer is kept
 * as none; a failed call is asked again. Past the hold it asks once; while that ask is open no pass calls the model.
 * Memory cache and spend store, a fake model, placeholder data.
 */
import { describe, expect, it } from 'vitest';

import type { ConfirmedItem, UcMention } from '../../src/engines/use-cases';
import { confirmWith, PAGE_CALLS, type ConfirmCache, type ConfirmPage } from '../../src/jobs/handlers/use-cases-extract';
import type { JobContext } from '../../src/jobs/types';
import { MemorySpendStore, SpendGovernor } from '../../src/llm/spend';
import type { CompletionModel } from '../../src/scanner/completion/types';

const mention = (key: string, statement: string): UcMention => ({ sourceKey: key, statement, title: statement.slice(0, 30), problem: statement, products: [], track: null, outcome: '', stageHint: null, cue: 'asked for', certainty: 'unsure' });
const unsureOf = (n: number, tweak: (i: number) => string = (i) => `Customer ${i} asked for follow-up question support`) => new Map(Array.from({ length: n }, (_, i) => [`s${i}`, [mention(`s${i}`, tweak(i))]] as const));
const YES = '{"items":[{"i":1,"useCase":true,"title":"Follow-up questions","problem":"p","product":"Agentforce","outcome":""}]}';

function memCache(): ConfirmCache & { map: Map<string, ConfirmedItem[]>; saves: number } {
  const map = new Map<string, ConfirmedItem[]>();
  const c = {
    map,
    saves: 0,
    get: (k: string) => map.get(k),
    set: (k: string, v: ConfirmedItem[]) => void map.set(k, v),
    save: async (keys: ReadonlySet<string>) => {
      for (const k of [...map.keys()]) if (!keys.has(k)) map.delete(k);
      c.saves += 1;
    },
  };
  return c;
}

function ctxOf(payload: Record<string, unknown> = {}) {
  const db = { execute: async () => ({ rows: [{ id: '1' }] }) };
  return { job: { id: 7, ownerUserId: 'u1', kind: 'use_cases.extract', queue: 'maintenance', payload }, signal: new AbortController().signal, db, userId: 'u1', clock: () => new Date('2026-11-18T16:00:00Z'), heartbeat: async () => {} } as unknown as JobContext;
}

function model(text: (n: number) => string | null, costUsd = 0.001) {
  let n = 0;
  const m: CompletionModel = async () => {
    n += 1;
    const t = text(n);
    return t === null ? { ok: false, text: '', costUsd, inputTokens: 10, outputTokens: 0, error: { message: 'overloaded', errorClass: 'transient' } } : { ok: true, text: t, costUsd, inputTokens: 100, outputTokens: 10 };
  };
  return { m, calls: () => n };
}

const newPage = (): ConfirmPage => ({ left: 0, stoppedAtPage: false, progressed: 0, askedHold: null });
const gov = () => new SpendGovernor(new MemorySpendStore({ now: () => new Date('2026-11-18T16:00:00Z'), today: () => '2026-11-18' }));

describe('use-case confirm answers are kept (F-3)', () => {
  it('a page asks 12; the next pass asks only the 3 never answered; a third pass asks nothing', async () => {
    const cache = memCache();
    const g = gov();
    const u = unsureOf(15);
    const a = model(() => YES);
    const p1 = newPage();
    const r1 = await confirmWith(ctxOf(), a.m, g, { day: '2026-11-18', cache, page: p1 })(u, ['Agentforce']);
    expect(PAGE_CALLS).toBe(12);
    expect(r1.calls).toBe(12);
    expect(p1).toMatchObject({ stoppedAtPage: true, left: 3, progressed: 12, askedHold: null });
    const p2 = newPage();
    const r2 = await confirmWith(ctxOf(), a.m, g, { day: '2026-11-18', cache, page: p2 })(u, ['Agentforce']);
    expect(r2.calls).toBe(3);
    expect(r2.confirmed.size).toBe(15);
    expect(p2).toMatchObject({ stoppedAtPage: false, left: 0 });
    const r3 = await confirmWith(ctxOf(), a.m, g, { day: '2026-11-18', cache, page: newPage() })(u, ['Agentforce']);
    expect(r3.calls).toBe(0);
    expect(r3.confirmed.size).toBe(15);
    expect(a.calls()).toBe(15);
  });

  it('an unusable answer is kept as none; a failed call is asked again; a changed source is asked again; gone ones are dropped', async () => {
    const cache = memCache();
    const u = unsureOf(3);
    // call 1 unusable, call 2 fails, call 3 yes
    const a = model((n) => (n === 1 ? 'not json' : n === 2 ? null : YES));
    await confirmWith(ctxOf(), a.m, null, { day: '2026-11-18', cache })(u, []);
    expect(cache.map.size).toBe(2);
    const b = model(() => YES);
    const r = await confirmWith(ctxOf(), b.m, null, { day: '2026-11-18', cache })(u, []);
    expect(b.calls()).toBe(1); // only the failed one
    expect(r.confirmed.has('s0')).toBe(false); // the unusable answer stays a none
    const edited = unsureOf(2, (i) => (i === 0 ? 'Customer 0 asked for a digest of unanswered questions' : `Customer ${i} asked for follow-up question support`));
    const c = model(() => YES);
    await confirmWith(ctxOf(), c.m, null, { day: '2026-11-18', cache })(edited, []);
    expect(c.calls()).toBe(1);
    expect(cache.map.size).toBe(2);
  });

  it('past the hold it asks once, keeps what it answered, and the hold waits asked; while it is open, no pass calls the model', async () => {
    const cache = memCache();
    const g = gov();
    const u = unsureOf(5);
    const pricey = model(() => YES, 1);
    const p = newPage();
    const r = await confirmWith(ctxOf(), pricey.m, g, { day: '2026-11-18', cache, page: p })(u, []);
    expect(r.calls).toBe(1);
    expect(r.deferred).toBe('spend_ask');
    expect(p.askedHold?.state).toBe('asked');
    expect(cache.map.size).toBe(1);
    const store = g.store as MemorySpendStore;
    expect([...store.events.values()].filter((e) => e.code === 'SPEND.ASK')).toHaveLength(1);
    expect(store.holds.get(p.askedHold!.id)!.state).toBe('asked');

    const next = model(() => YES);
    const r2 = await confirmWith(ctxOf(), next.m, g, { day: '2026-11-18', cache, page: newPage() })(u, []);
    expect(next.calls()).toBe(0);
    expect(r2.deferred).toBe('spend_ask_open');
    expect(r2.confirmed.size).toBe(1);

    // Allow: the continuation (carrying the hold) asks the rest on the same hold and settles it
    await g.answer(p.askedHold!.id, { kind: 'approve', usd: 10 });
    const r3 = await confirmWith(ctxOf({ vars: { spendHoldId: p.askedHold!.id } }), next.m, g, { day: '2026-11-18', cache, page: newPage() })(u, []);
    expect(r3.calls).toBe(4);
    expect(store.holds.get(p.askedHold!.id)!.state).toBe('settled');
    expect(store.holds.size).toBe(1);
  });
});
