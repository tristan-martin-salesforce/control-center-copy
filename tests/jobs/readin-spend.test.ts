/**
 * Caps audit 26 F-4: the read-in research agent (also Find assets') under the job's spend hold. The per-run $ and the
 * 14 turns stop being where it fails: past the hold it raises one hand and ends `paused_for_spend`; the SDK budget
 * is the runaway guard (4x the hold), never past the day line that is left (a user budget); turns are a runaway
 * guard. Without a hold the old cap still stops it. Scripted SDK, placeholder data.
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { holdGate, MemorySpendStore, PAUSED_FOR_SPEND, RUNAWAY_TURNS, SpendGovernor } from '../../src/llm/spend';
import { SdkResearchAgent } from '../../src/llm/readin/agent';
import { createReadInTools, createToolState } from '../../src/llm/readin/tools';
import { fakeQuery, finishInput, T } from '../readin/fake-sdk';

const T0 = new Date('2026-11-20T15:00:00.000Z');

function input(over: Partial<Parameters<SdkResearchAgent['run']>[0]> = {}) {
  const state = createToolState([]);
  const handlers = createReadInTools({ google: null, ledger: { search: async () => [] } }, state);
  return { runId: 'r1', model: 'claude-sonnet-5-5', systemPrompt: ['s'], prompt: 'p', mcpServers: {}, externalTools: [T.slackRead], handlers, state, maxTurns: 14, costCapUsd: 0.35, signal: new AbortController().signal, ...over };
}

async function gateOf(heldUsd: number) {
  const store = new MemorySpendStore({ now: () => T0, today: () => '2026-11-20' });
  const gov = new SpendGovernor(store);
  const r = await gov.hold({ scope: 'research', jobKey: 'readin.generate:1' }, { p50: heldUsd / 2, p90: heldUsd, basis: 'default', n: 0 });
  if (!r.ok) throw new Error('no hold');
  return { gate: holdGate(gov, r.hold), store };
}

describe('read-in agent on the spend governor (F-4)', () => {
  it('past the hold: one ask, the run ends paused_for_spend (not cost_cap)', async () => {
    const { gate, store } = await gateOf(0.05);
    const agent = new SdkResearchAgent({ queryFn: fakeQuery({ usage: { input_tokens: 30_000, output_tokens: 3_000 }, steps: [{ tool: T.ledger, input: { text: 'Dana' } }, { tool: T.ledger, input: { text: 'more' } }, { tool: T.finish, input: finishInput() }] }) });
    const res = await agent.run(input({ spend: gate, userLineUsd: 2 }));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(PAUSED_FOR_SPEND);
    expect(gate.hold.state).toBe('asked');
    expect([...store.events.values()].filter((e) => e.code === 'SPEND.ASK')).toHaveLength(1);
  });

  it('the SDK budget is 4x the hold, never past the day line left; turns are the runaway guard', async () => {
    const seen: Options[] = [];
    const capture = ((a: { options: Options }) => {
      seen.push(a.options);
      return fakeQuery({ steps: [{ tool: T.finish, input: finishInput() }] })(a as never);
    }) as never;
    const { gate } = await gateOf(0.5);
    await new SdkResearchAgent({ queryFn: capture }).run(input({ spend: gate, userLineUsd: 5 }));
    expect(seen[0]!.maxBudgetUsd).toBeCloseTo(2, 6);
    expect(seen[0]!.maxTurns).toBe(RUNAWAY_TURNS);
    const { gate: g2 } = await gateOf(0.5);
    await new SdkResearchAgent({ queryFn: capture }).run(input({ spend: g2, userLineUsd: 0.6 }));
    expect(seen[1]!.maxBudgetUsd).toBeCloseTo(0.6, 6);
  });

  it("the day line left is still a line: passing it stops the run as cost_cap, with no ask", async () => {
    const { gate, store } = await gateOf(5);
    const agent = new SdkResearchAgent({ queryFn: fakeQuery({ usage: { input_tokens: 30_000, output_tokens: 3_000 }, steps: [{ tool: T.ledger, input: { text: 'Dana' } }, { tool: T.finish, input: finishInput() }] }) });
    const res = await agent.run(input({ spend: gate, userLineUsd: 0.01 }));
    expect(res.error?.code).toBe('cost_cap');
    expect([...store.events.values()]).toEqual([]);
  });

  it('without a hold the per-read-in cap stops it as before', async () => {
    const agent = new SdkResearchAgent({ queryFn: fakeQuery({ usage: { input_tokens: 30_000, output_tokens: 3_000 }, steps: [{ tool: T.ledger, input: { text: 'Dana' } }, { tool: T.finish, input: finishInput() }] }) });
    const res = await agent.run(input({ costCapUsd: 0.05 }));
    expect(res.error?.code).toBe('cost_cap');
  });
});
