/**
 * Caps audit 26 F-4: the diagnose run (D-56, src/server/feedback/agent.ts) on the spend governor. Past its hold, at the
 * next tool call, it raises a hand (SPEND.ASK, Health ▸ Spend) and waits there for the answer in this process, as the
 * Assistant does: Allow continues the same query, Stop ends it (the app's own reading is the report). The $0.40 and
 * 14 turns are then the runaway guard; the day line left is still a line. Scripted query, no SDK.
 */
import path from 'node:path';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { answerHold, holdGate, MemorySpendStore, PAUSED_FOR_SPEND, RUNAWAY_TURNS, SpendGovernor } from '../../../src/llm/spend';
import { SdkFeedbackAgent, type FeedbackQueryFn, type FeedbackRunInput } from '../../../src/server/feedback/agent';
import type { FeedbackReads } from '../../../src/server/feedback/reads';

const ROOT = path.resolve(__dirname, '../../..');
const reads: FeedbackReads = { eventLog: async () => [], jobs: async () => ({ counts: {}, failing: [] }), health: async () => ({ connectors: [] }), scans: async () => [], trace: async () => null, page: async () => ({ read: 'getTime', payload: {} }), entity: async () => null };
const input = (over: Partial<FeedbackRunInput> = {}): FeedbackRunInput => ({ runId: 'fb_spend', systemPrompt: ['skill', 'BOUNDARY', 'run'], prompt: 'The Time page is empty', reads, repoRoot: ROOT, costCapUsd: 0.4, signal: new AbortController().signal, ...over });
const pre = (tool_name: string) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: {}, session_id: 's', transcript_path: '', cwd: ROOT, tool_use_id: 't' }) as never;
const T0 = new Date('2026-11-20T15:00:00.000Z');

async function gate(heldUsd: number) {
  const gov = new SpendGovernor(new MemorySpendStore({ now: () => T0, today: () => '2026-11-20' }));
  const r = await gov.hold({ scope: 'feedback', jobKey: 'feedback:t' }, { p50: heldUsd / 2, p90: heldUsd, basis: 'default', n: 0 });
  if (!r.ok) throw new Error('no hold');
  return { gov, g: holdGate(gov, r.hold, { minCeilingUsd: 0.4 }) };
}

/** One expensive turn, then a tool call (the safe point), then a finish attempt; records the hook's answer. */
function script(seen: unknown[]): FeedbackQueryFn {
  return ({ options, handlers }) =>
    (async function* () {
      const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
      yield { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 200_000, output_tokens: 10 } } } as unknown as SDKMessage;
      seen.push(await hook(pre('mcp__cc_feedback__feedback_jobs'), 't1', { signal: new AbortController().signal }));
      await handlers.feedback_finish({ title: 'Time empty', summary: 'The Time page is empty.', steps: ['Open Time'], expected: 'Rows', actual: 'None', diagnosis: { cause: 'buildTime drops rows', files: ['src/components/time/TimePage.tsx'], confidence: 'medium' } });
      yield { type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.4, num_turns: 3, modelUsage: {}, permission_denials: [] } as unknown as SDKMessage;
    })();
}

describe('diagnose on the spend governor (F-4)', () => {
  it('past the hold it asks at the next tool call and waits; Allow continues the same run', async () => {
    const { gov, g } = await gate(0.1);
    const seen: unknown[] = [];
    let opts: { maxTurns?: number; maxBudgetUsd?: number } = {};
    const q: FeedbackQueryFn = (a) => ((opts = a.options), script(seen)(a));
    const run = new SdkFeedbackAgent({ queryFn: q }).run(input({ spend: g, userLineUsd: 3 }));
    // the run waits at the ask; answer it the way Health does
    for (let i = 0; i < 50 && g.hold.state !== 'asked'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(g.hold.state).toBe('asked');
    expect([...(gov.store as MemorySpendStore).events.values()].map((e) => e.code)).toEqual(['SPEND.ASK']);
    await answerHold(gov, g.hold.id, { answer: 'approve', usd: 1 });
    const r = await run;
    expect(r.ok).toBe(true);
    expect(seen[0]).toEqual({});
    expect(opts.maxTurns).toBe(RUNAWAY_TURNS);
    expect(opts.maxBudgetUsd).toBeCloseTo(0.4, 6);
  });

  it('Stop ends it as paused_for_spend (the service then reports the app’s own reading)', async () => {
    const { gov, g } = await gate(0.1);
    const seen: unknown[] = [];
    const run = new SdkFeedbackAgent({ queryFn: script(seen) }).run(input({ spend: g, userLineUsd: 3 }));
    for (let i = 0; i < 50 && g.hold.state !== 'asked'; i++) await new Promise((r) => setTimeout(r, 5));
    await answerHold(gov, g.hold.id, { answer: 'deny' });
    const r = await run;
    expect(r.error?.code).toBe(PAUSED_FOR_SPEND);
    expect(seen[0]).toMatchObject({ continue: false });
  });

  it('the day line left is a line: passing it stops the run as cost_cap, with no ask', async () => {
    const { gov, g } = await gate(5);
    const r = await new SdkFeedbackAgent({ queryFn: script([]) }).run(input({ spend: g, userLineUsd: 0.05 }));
    expect(r.error?.code).toBe('cost_cap');
    expect([...(gov.store as MemorySpendStore).events.values()]).toEqual([]);
  });
});
