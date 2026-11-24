/**
 * Caps audit 26 F-4: reconcile's relink on the spend governor. Each relink run holds its estimate (the old $0.05 cap
 * until it has history) and hands the gate to the runner; a run that asks ends paused, its connector's other batches
 * wait, the next pass waits too (no second ask), and once allowed the next pass runs on the approved hold and settles
 * it. Without a governor the fixed cap is the run's line as before. In-memory store, a fake runner, placeholder data.
 */
import { describe, expect, it } from 'vitest';

import { MemorySpendStore, SpendGovernor } from '@/llm/spend';
import type { ScanSkillRunInput } from '@/llm/skill-runner';
import { Reconciler } from '@/scanner/reconcile/reconciler';
import { FakeClock } from '@/scanner/runtime/clock';
import { deterministicSpec } from '@/scanner/runtime/connectors';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import type { DeterministicFetcher, SkillRunner } from '@/scanner/types';

import { PROFILE } from './runtime/helpers/world';

const NOW = '2026-10-28T12:00:00.000Z';
const fetcher = { connector: 'gmail', scopes: async () => ['inbox'], health: async () => ({ state: 'ok', checkedAt: '' }), fetch: async () => ({ items: [], coverage: [], nextCursor: { value: '', at: '' }, complete: true }) } as unknown as DeterministicFetcher;
const job = () => ({ kind: 'reconcile' as const, id: 'r', passes: ['unlinked' as const], trigger: 'reconcile' as const, priority: 20, runAt: NOW, dedupeKey: 'r' });

async function world(n: number) {
  const clock = new FakeClock(NOW);
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
  const { runId } = await store.startRun({ scope: { connector: 'gmail', scope: 'inbox' }, trigger: 'schedule', window: { from: '2026-10-28T11:00:00.000Z', to: NOW } });
  const rec = await store.recordSourceItems(runId, Array.from({ length: n }, (_, i) => ({ connector: 'gmail' as const, kind: 'email' as const, externalId: `x${i}`, dedupeKey: `gmail:x${i}`, contentHash: `h${i}`, occurredAt: '2026-10-28T11:30:00.000Z' })));
  for (const r of rec) await store.flagUnlinked(runId, { sourceItemId: r.sourceItemId, reason: 'PLACEHOLDER relevant FYI about ACME' });
  return { clock, store };
}

/** Like the agentic runner with a gate: reports `usd`, and past the hold asks and ends paused for spend. */
function runner(usd: number) {
  const seen: ScanSkillRunInput[] = [];
  const r: SkillRunner = {
    run: async (raw) => {
      const input = raw as ScanSkillRunInput;
      seen.push(input);
      if (input.spend && input.spend.observe(usd) === 'ask') {
        await input.spend.ask({ pctDone: null });
        return { ok: false, costUsd: usd, inputTokens: 100, outputTokens: 10, turns: 1, error: { message: `paused for spend: $${usd} of a hold`, errorClass: 'config' } };
      }
      return { ok: true, costUsd: usd, inputTokens: 100, outputTokens: 10, turns: 1 };
    },
  };
  return { r, seen };
}

describe('relink on the spend governor (F-4)', () => {
  it('a relink past its hold asks once; its other batches and the next pass wait; Allow resumes on the same hold', async () => {
    const { clock, store } = await world(30);
    const spend = new SpendGovernor(new MemorySpendStore({ now: () => clock.now(), today: () => '2026-10-28' }));
    const { r, seen } = runner(0.08);
    const rec = new Reconciler({ store, runner: r, clock, specs: [deterministicSpec(fetcher)], spend, relinkBatch: 12 });
    const report = await rec.run(job(), new AbortController().signal);
    expect(seen).toHaveLength(1);
    // the runaway guard: 4x the $0.05 estimate, the old cap its floor
    expect(seen[0]!.costCapUsd).toBe(0.05);
    expect(seen[0]!.spend?.ceilingUsd()).toBeCloseTo(0.2, 6);
    expect(report.findings.some((f) => /^paused: a relink passed its spend estimate/.test(f.detail))).toBe(true);
    const holds = [...(spend.store as MemorySpendStore).holds.values()];
    expect(holds.map((h) => h.state)).toEqual(['asked']);

    // the next pass: still unanswered, nothing runs and nothing new is asked
    const again = await rec.run(job(), new AbortController().signal);
    expect(seen).toHaveLength(1);
    expect(again.findings.some((f) => /^deferred: a relink asked to allow more spend/.test(f.detail))).toBe(true);

    // Allow $0.20 more: the next pass runs on the approved hold (no second hold) and settles it
    await spend.answer(holds[0]!.id, { kind: 'approve', usd: 0.2 });
    const r2 = runner(0.01);
    const rec2 = new Reconciler({ store, runner: r2.r, clock, specs: [deterministicSpec(fetcher)], spend, relinkBatch: 12 });
    await rec2.run(job(), new AbortController().signal);
    expect(r2.seen.length).toBeGreaterThan(0);
    expect(r2.seen[0]!.spend?.hold.id).toBe(holds[0]!.id);
    expect((spend.store as MemorySpendStore).holds.get(holds[0]!.id)!.state).toBe('settled');
  });

  it('under its hold a relink settles with what it cost; without a governor it runs on the fixed cap', async () => {
    const { clock, store } = await world(3);
    const spend = new SpendGovernor(new MemorySpendStore({ now: () => clock.now(), today: () => '2026-10-28' }));
    const { r, seen } = runner(0.01);
    await new Reconciler({ store, runner: r, clock, specs: [deterministicSpec(fetcher)], spend }).run(job(), new AbortController().signal);
    expect(seen).toHaveLength(1);
    expect([...(spend.store as MemorySpendStore).holds.values()].map((h) => [h.state, h.spentUsd])).toEqual([['settled', 0.01]]);

    const w = await world(3);
    const plain = runner(0.01);
    await new Reconciler({ store: w.store, runner: plain.r, clock: w.clock, specs: [deterministicSpec(fetcher)] }).run(job(), new AbortController().signal);
    expect(plain.seen[0]!.spend).toBeUndefined();
    expect(plain.seen[0]!.costCapUsd).toBe(0.05);
  });
});
