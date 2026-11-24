/**
 * Caps audit 26 F-4: FTI on the spend governor. Every paid call reports the run's spend to its hold (before, the FTI
 * runner never told the gate anything, so its hold never asked); past it, the run stops before its next classifier
 * batch, raises one hand and ends `paused for spend` (the runtime's paused path), keeping what earlier batches applied
 * and their verdicts. Under the hold nothing changes. In-memory store, fake classifier, placeholder data.
 */
import { describe, expect, it } from 'vitest';

import { holdGate, MemorySpendStore, SpendGovernor } from '@/llm/spend';
import { FtiSkillRunner, type ClassifierModel } from '@/scanner/interpret';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import type { NormalizedSourceItem } from '@/scanner/types';

const NOW = Date.parse('2026-11-18T18:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const WINDOW = { from: iso(NOW - 3 * 3_600_000), to: iso(NOW) };

const items = (n: number): NormalizedSourceItem[] =>
  Array.from({ length: n }, (_, i) => ({
    connector: 'gmail' as const,
    kind: 'email' as const,
    externalId: `spend-msg-${i + 1}`,
    dedupeKey: `gmail:spend-msg-${i + 1}`,
    contentHash: `spend-msg-${i + 1}`,
    occurredAt: iso(NOW - 2 * 3_600_000 + i * 60_000),
    title: `Placeholder request ${i + 1}`,
    excerpt: `Could you send the example deck ${i + 1}?`,
    author: { name: 'Example Person', email: 'person@example.com', isMe: false, isExternal: true },
    threadRef: `gmail-thread:spend-${i + 1}`,
  }));

function classifier() {
  const calls: number[] = [];
  const model: ClassifierModel = async (req) => {
    const refs = [...req.user.matchAll(/^### \[([^\]]+)\]/gm)].map((m) => m[1]!);
    calls.push(refs.length);
    return { ok: true, costUsd: 0.01, inputTokens: 100, outputTokens: 10, text: JSON.stringify({ verdicts: refs.map((ref) => ({ ref, v: 'ask', kind: 'ask', title: `Send ${ref}`, who: 'Example Person', cite: 'send the deck', conf: 0.9, why: 'an ask' })) }) };
  };
  return { model, calls };
}

async function run(heldUsd: number, n = 60) {
  const store = new InMemoryScannerStore({ clock: { now: () => new Date(NOW) }, profile: { me: { userId: 'u1', name: 'ME', email: 'me@example.com' }, watchList: [], aliases: { accounts: [], channels: [] } } });
  const gov = new SpendGovernor(new MemorySpendStore({ now: () => new Date(NOW), today: () => '2026-11-18' }));
  const held = await gov.hold({ scope: 'scan_run', jobKey: 'scan:gmail:inbox:1' }, { p50: heldUsd / 2, p90: heldUsd, basis: 'default', n: 0 });
  if (!held.ok) throw new Error('no hold');
  const gate = holdGate(gov, held.hold);
  const { model, calls } = classifier();
  const runner = new FtiSkillRunner({ fallback: { run: async () => ({ ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, error: { message: 'no agent' } }) }, runtimeFor: () => null, model, modelId: 'claude-haiku-5-5' });
  const scope = { connector: 'gmail' as const, scope: 'inbox' };
  const { runId } = await store.startRun({ scope, trigger: 'schedule', window: WINDOW });
  const res = await runner.run({ skillPath: 'skills/scan-gmail.md', model: 'claude-haiku-5-5', mcpServers: {}, allowedTools: [], runId, context: await store.getContext(scope), prefetched: items(n), maxTurns: 4, costCapUsd: 0.02, signal: new AbortController().signal, window: WINDOW, mode: 'incremental', spend: gate }, store);
  const verdicts = (await store.triageVerdicts?.([...(store as unknown as { sourceItems: Map<string, { id: string }> }).sourceItems.values()].map((x) => x.id))) ?? new Map();
  return { res, gate, calls, verdicts, gov };
}

describe('FTI on the spend governor (F-4)', () => {
  it('past the hold: one ask before the next batch; the run ends paused; batch 1 keeps its verdicts', async () => {
    const r = await run(0.005);
    expect(r.calls.length).toBe(1);
    expect(r.res.ok).toBe(false);
    expect(r.res.error?.message).toMatch(/^paused for spend: \$0\.0100 of a \$0\.0050 hold$/);
    expect(r.gate.hold.state).toBe('asked');
    expect([...(r.gov.store as MemorySpendStore).events.values()].filter((e) => e.code === 'SPEND.ASK')).toHaveLength(1);
    expect(r.verdicts.size).toBe(r.calls[0]);
    // what it paid is still the run's cost (booked by the runtime from the pass rows)
    expect(r.res.costUsd).toBeCloseTo(0.01, 6);
  });

  it('under the hold: every batch, no ask', async () => {
    const r = await run(1);
    expect(r.calls.length).toBeGreaterThan(1);
    expect(r.calls.reduce((a, b) => a + b, 0)).toBe(60);
    expect(r.res.ok).toBe(true);
    expect(r.gate.hold.state).toBe('open');
    expect(r.gate.hold.spentUsd).toBeCloseTo(0.01 * r.calls.length, 6);
  });
});
