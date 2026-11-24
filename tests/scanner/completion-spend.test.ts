/**
 * Caps audit 26 F-4: the completion judge under the spend governor. Each call reports the pass's spend to the job's
 * hold; past it, with items still to judge, the pass raises one hand (SPEND.ASK) and stops, the rest pending for the
 * continuation; one call's SDK budget is the runaway guard, not $0.05. Without a hold it runs as before.
 * In-memory store, a fake model, placeholder data only.
 */
import { describe, expect, it } from 'vitest';

import { holdGate, MemorySpendStore, SpendGovernor } from '../../src/llm/spend';
import { runCompletionPass, type CompletionModel, type CompletionModelRequest } from '../../src/scanner/completion';
import { InMemoryScannerStore } from '../../src/scanner/store-memory';
import type { NormalizedSourceItem } from '../../src/scanner/types';

const T0 = Date.parse('2026-11-02T16:00:00.000Z');
const ts = (min: number) => ((T0 + min * 60_000) / 1000).toFixed(6);
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ASKER = { name: 'PERSON_A', externalId: 'U0PERSONA' };
const ME = { name: 'ME', externalId: 'U0ME00001', isMe: true };

async function world(n: number) {
  let now = T0;
  const store = new InMemoryScannerStore({ clock: { now: () => new Date(now) }, profile: { me: { userId: 'u1', name: 'ME', slackId: 'U0ME00001' }, watchList: [], aliases: { accounts: [], channels: [] } } });
  const msg = (min: number, ch: string, text: string, author: typeof ASKER | typeof ME): NormalizedSourceItem => ({
    connector: 'slack',
    kind: 'message',
    externalId: `${ch}:${ts(min)}`,
    dedupeKey: `slack:${ch}:${ts(min)}`,
    contentHash: `h-${ch}-${min}`,
    occurredAt: iso(min),
    threadRef: `slack:${ch}:${ts(min)}`,
    excerpt: text,
    author,
    participants: [ASKER, ME],
  });
  const scan = async (atMin: number, items: NormalizedSourceItem[], title?: string) => {
    now = T0 + atMin * 60_000;
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: { from: iso(atMin - 5), to: iso(atMin) } });
    const rec = await store.recordSourceItems(runId, items);
    if (title) await store.proposeItem(runId, { kind: 'ask', title, evidence: [{ sourceItemId: rec[0]!.sourceItemId, role: 'origin', reason: 'direct ask' }], confidence: 'sure' });
    await store.reportCoverage(runId, [{ kind: 'query_window', ref: 'search:dm', from: iso(atMin - 5), to: iso(atMin) }]);
    await store.finishRun(runId, { cursor: { value: ts(atMin), at: iso(atMin) }, stats: { fetched: items.length, new: items.length, changed: 0, linked: 0, proposed: title ? 1 : 0, unlinked: 0, costUsd: 0 } });
  };
  for (let i = 0; i < n; i += 1) await scan(i, [msg(i, `D0DM${String(i).padStart(5, '0')}`, `Can you send deck ${i}?`, ASKER)], `Send deck ${i}`);
  for (let i = 0; i < n; i += 1) await scan(100 + i, [msg(100 + i, `D0DM${String(i).padStart(5, '0')}`, `Here is deck ${i}`, ME)]);
  now = T0 + 300 * 60_000;
  return { store, now: () => new Date(now) };
}

function model(costUsd: number) {
  const calls: CompletionModelRequest[] = [];
  const m: CompletionModel = async (req) => {
    calls.push(req);
    const r = JSON.parse(req.user) as { items: Array<{ id: string }> };
    return { ok: true, text: JSON.stringify({ verdicts: r.items.map((it) => ({ item: it.id, verdict: 'not_done', basis: 'none', confidence: 0.2, reason: 'not yet' })) }), costUsd, inputTokens: 4000, outputTokens: 120 };
  };
  return { m, calls };
}

const gov = () => new SpendGovernor(new MemorySpendStore({ now: () => new Date(T0), today: () => '2026-11-02' }));

describe('completion pass under the spend governor (F-4)', () => {
  it('past the hold with items left: one ask, the rest pending, no follow-up page; the call budget is the runaway guard', async () => {
    const w = await world(13);
    const g = gov();
    const held = await g.hold({ scope: 'job', jobKey: 'completion.check:1', skill: 'completion-check' }, { p50: 0.01, p90: 0.015, basis: 'default', n: 0 });
    if (!held.ok) throw new Error('no hold');
    const gate = holdGate(g, held.hold);
    const { m, calls } = model(0.02);
    const out = await runCompletionPass({ store: w.store, model: m, now: w.now(), watermark: null, limits: { settleMs: 0, itemsPerCall: 6 }, spend: gate });
    expect(out.withCandidates).toBe(13);
    expect(calls).toHaveLength(1);
    // the runaway guard: 4× the hold, not the old $0.05 per call
    expect(calls[0]!.maxBudgetUsd).toBeCloseTo(0.06, 6);
    expect(out).toMatchObject({ status: 'partial', pausedForSpend: true, more: false });
    expect(Object.keys(out.watermark.pending)).toHaveLength(7);
    expect(held.hold.state).toBe('asked');
    const ev = [...(g.store as MemorySpendStore).events.values()].filter((e) => e.code === 'SPEND.ASK');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.message).toMatch(/^This job has used \$0\.02 of its \$0\.0\d estimate and is 33% done; allow \$0\.\d\d more\?$/);
  });

  it('under the hold the pass runs to the end and never asks', async () => {
    const w = await world(13);
    const g = gov();
    const held = await g.hold({ scope: 'job', jobKey: 'completion.check:2' }, { p50: 0.1, p90: 0.4, basis: 'default', n: 0 });
    if (!held.ok) throw new Error('no hold');
    const { m, calls } = model(0.001);
    const out = await runCompletionPass({ store: w.store, model: m, now: w.now(), watermark: null, limits: { settleMs: 0, itemsPerCall: 6 }, spend: holdGate(g, held.hold) });
    expect(calls).toHaveLength(3);
    expect(out.pausedForSpend).toBeUndefined();
    expect(held.hold.state).toBe('open');
  });

  it('the last call passing the hold asks nothing (nothing is left to judge)', async () => {
    const w = await world(6);
    const g = gov();
    const held = await g.hold({ scope: 'job', jobKey: 'completion.check:3' }, { p50: 0.001, p90: 0.001, basis: 'default', n: 0 });
    if (!held.ok) throw new Error('no hold');
    const { m, calls } = model(0.02);
    const out = await runCompletionPass({ store: w.store, model: m, now: w.now(), watermark: null, limits: { settleMs: 0, itemsPerCall: 6 }, spend: holdGate(g, held.hold) });
    expect(calls).toHaveLength(1);
    expect(out.pausedForSpend).toBeUndefined();
    expect(held.hold.state).toBe('open');
  });

  it('without a hold: the per-call line stays $0.05 (tests, evals, the mock)', async () => {
    const w = await world(2);
    const { m, calls } = model(0.001);
    await runCompletionPass({ store: w.store, model: m, now: w.now(), watermark: null, limits: { settleMs: 0 } });
    expect(calls[0]!.maxBudgetUsd).toBe(0.05);
  });
});
