/**
 * Caps audit 26 F-4: VDP Find assets hands the job's spend hold and the user budget left to its research run (the
 * read-in agent, whose ask is pinned in readin-spend.test.ts), and a run that paused for spend comes back as such,
 * with no drafts. Without a hold nothing changes. Fake agent, placeholder data.
 */
import { describe, expect, it } from 'vitest';

import type { ResearchAgent, ResearchRunInput } from '../../src/llm/readin/agent';
import { runVdpAssetResearch } from '../../src/llm/research/vdp-assets';
import { holdGate, MemorySpendStore, PAUSED_FOR_SPEND, SpendGovernor } from '../../src/llm/spend';

const NOW = new Date('2026-11-20T15:00:00.000Z');
const target = { key: 'example-fy27', vdpSlug: 'example-fy27', accountId: null, companyName: 'Example Co', names: ['Example Co'], known: [], inVdp: [] };

function agent(result: Partial<Awaited<ReturnType<ResearchAgent['run']>>>) {
  const seen: ResearchRunInput[] = [];
  const a: ResearchAgent = {
    run: async (input) => {
      seen.push(input);
      return { ok: false, output: null, costUsd: 0.6, inputTokens: 100, outputTokens: 10, turns: 3, toolCalls: [], ...result };
    },
  };
  return { a, seen };
}

describe('Find assets on the spend governor (F-4)', () => {
  it('passes the hold and the user line to the run; a paused run comes back paused, with nothing drafted', async () => {
    const gov = new SpendGovernor(new MemorySpendStore({ now: () => NOW, today: () => '2026-11-20' }));
    const r = await gov.hold({ scope: 'research', jobKey: 'vdp.assets.find:1' }, { p50: 0.2, p90: 0.45, basis: 'default', n: 0 });
    if (!r.ok) throw new Error('no hold');
    const gate = holdGate(gov, r.hold);
    const { a, seen } = agent({ error: { code: PAUSED_FOR_SPEND, message: 'paused for spend', errorClass: 'config' } });
    const run = await runVdpAssetResearch(target, { now: NOW, timezone: 'America/Denver', google: null, ledger: null, costCapUsd: 0.5, signal: new AbortController().signal, agent: a, spend: gate, userLineUsd: 3 });
    expect(seen[0]!.spend).toBe(gate);
    expect(seen[0]!.userLineUsd).toBe(3);
    expect(seen[0]!.costCapUsd).toBe(0.5);
    expect(run.error?.code).toBe(PAUSED_FOR_SPEND);
    expect(run.drafts).toEqual([]);
  });

  it('without a hold the run is what it was', async () => {
    const { a, seen } = agent({});
    await runVdpAssetResearch(target, { now: NOW, timezone: 'America/Denver', google: null, ledger: null, costCapUsd: 0.5, signal: new AbortController().signal, agent: a });
    expect(seen[0]!.spend).toBeUndefined();
    expect(seen[0]!.userLineUsd).toBeUndefined();
  });
});
