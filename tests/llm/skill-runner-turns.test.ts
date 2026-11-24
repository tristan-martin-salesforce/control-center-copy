/**
 * Ask #14 (28-crash-resume.md Remaining 4, EDGE-CASES WK-15): the Agent SDK runner traces each paid request as a
 * `turn` row as the SDK reports its usage, before the next tool runs; the query's end `pass` row carries the same key
 * (`q`) and the governor's hold, so recovery can tell a query that ended (booked by its pass row) from one a kill cut
 * short (booked from its turns). The crash drill (tests/db/worker/crash-resume.test.ts) kills a real worker mid-query.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { restrictedTools } from '@/llm/mcp-config';
import { estimateCallCostUsd } from '@/llm/models';
import { AgentSdkSkillRunner, type QueryFn } from '@/llm/skill-runner';
import { TurnTracer } from '@/llm/skill-runner.turns';
import { holdGate, MemorySpendStore, SpendGovernor } from '@/llm/spend';
import { FakeClock } from '@/scanner/runtime/clock';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import { MemoryTraceSink, setTraceSink } from '@/scanner/trace';

import { INBOX, PROFILE } from '../scanner/runtime/helpers/world';

const MODEL = 'claude-haiku-5-5';
const WINDOW = { from: '2026-11-04T16:00:00.000Z', to: '2026-11-04T18:00:00.000Z' };
const U = { input_tokens: 2000, output_tokens: 200 };
const USD = estimateCallCostUsd(MODEL, U);

afterEach(() => {
  setTraceSink(null);
});

describe('TurnTracer', () => {
  it('one row per message as its usage arrives; a repeated message adds only what grew', async () => {
    const sink = new MemoryTraceSink();
    setTraceSink(sink);
    const t = new TurnTracer({ runId: 'run-1', pass: 'traversal', mode: 'incremental', holdId: 'hold-1' });
    await t.observe('msg_1', MODEL, U);
    await t.observe('msg_1', MODEL, U); // the SDK repeats a message once per content block
    await t.observe('msg_2', MODEL, U);
    await t.observe('msg_2', MODEL, { ...U, output_tokens: 400 }); // a later copy with more output: the difference
    const rows = sink.of('run-1');
    expect(rows.map((e) => e.kind)).toEqual(['turn', 'turn', 'turn']);
    expect(rows.map((e) => e.payload.turn)).toEqual([1, 2, 2]);
    expect(rows.every((e) => e.payload.q === t.q && e.payload.hold === 'hold-1' && e.payload.model === MODEL)).toBe(true);
    expect(rows[0]!.payload).toMatchObject({ costUsd: USD, inputTokens: 2000, outputTokens: 200, turns: 1, m: { turns: 1, firstPromptTokens: 2000 } });
    expect(rows[2]!.payload).toMatchObject({ inputTokens: 0, outputTokens: 200, turns: 0 });
    const sum = rows.reduce((a, e) => a + Number(e.payload.costUsd), 0);
    expect(sum).toBeCloseTo(USD + estimateCallCostUsd(MODEL, { ...U, output_tokens: 400 }), 6);
    expect(t.usd).toBeCloseTo(sum, 6);
  });

  it('a request without cost traces nothing', async () => {
    const sink = new MemoryTraceSink();
    setTraceSink(sink);
    const t = new TurnTracer({ runId: 'run-2', pass: 'triage', mode: 'incremental', holdId: null });
    await t.observe('msg_1', MODEL, {});
    expect(sink.events).toEqual([]);
  });
});

/** A CLI stand-in: each turn's assistant message twice (two content blocks, one usage), then the tool, then a result. */
function cli(seen: { flushedBeforeTool: number[] }, sink: MemoryTraceSink, runId: string): QueryFn {
  return ({ options }: { prompt: string; options: Options }) => {
    const gen = async function* (): AsyncGenerator<SDKMessage> {
      const signal = options.abortController!.signal;
      const cc = (options.mcpServers as Record<string, { instance: { connect: (t: unknown) => Promise<void> } }>).cc!.instance;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await cc.connect(st);
      const client = new Client({ name: 'fake-cli', version: '1' });
      await client.connect(ct);
      const steps = [
        { tool: 'mcp__cc__cc_report_coverage', input: { windows: ['search:dm', 'search:mentions', 'search:mine'].map((ref) => ({ ref, from: WINDOW.from, to: WINDOW.to })) } },
        { tool: 'mcp__cc__cc_finish', input: { cursor: { value: '1793815200.000000', at: WINDOW.to }, complete: true } },
      ];
      yield { type: 'system', subtype: 'init', mcp_servers: [], tools: steps.map((s) => s.tool) } as unknown as SDKMessage;
      let n = 0;
      try {
        for (const s of steps) {
          n += 1;
          const msg = { id: `msg_${n}`, model: options.model, usage: U };
          yield { type: 'assistant', message: { ...msg, content: [{ type: 'text', text: 'next' }] } } as unknown as SDKMessage;
          yield { type: 'assistant', message: { ...msg, content: [{ type: 'tool_use', id: `tu_${n}`, name: s.tool, input: s.input }] } } as unknown as SDKMessage;
          // what reached the trace before the tool runs (the runner awaited the flush before taking the next message)
          seen.flushedBeforeTool.push(sink.of(runId).filter((e) => e.kind === 'turn').length);
          await (options.canUseTool as CanUseTool)(s.tool, s.input, { signal, toolUseID: `tu_${n}` } as never);
          await client.callTool({ name: s.tool.slice('mcp__cc__'.length), arguments: s.input });
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_${n}`, content: [{ type: 'text', text: 'ok' }] }] } } as unknown as SDKMessage;
        }
        yield { type: 'result', subtype: 'success', is_error: false, num_turns: n, result: 'DONE', total_cost_usd: Math.round(n * USD * 1e6) / 1e6, usage: { input_tokens: n * 2000, output_tokens: n * 200 }, modelUsage: {}, permission_denials: [] } as unknown as SDKMessage;
      } finally {
        await client.close();
      }
    };
    return gen();
  };
}

describe('the Agent SDK runner traces each turn as the SDK reports it', () => {
  it('a turn row per request, written before its tool runs; the end pass row has the same key and hold and the whole cost', async () => {
    const sink = new MemoryTraceSink();
    setTraceSink(sink);
    const clock = new FakeClock(WINDOW.to);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
    const { runId } = await store.startRun({ scope: INBOX, trigger: 'schedule', window: WINDOW });
    const gov = new SpendGovernor(new MemorySpendStore({ now: () => clock.now(), today: () => '2026-11-04' }));
    const held = await gov.hold({ scope: 'scan_run', jobKey: 'scan:slack:inbox:turns' }, { p50: 0.5, p90: 1, basis: 'default', n: 0 });
    if (!held.ok) throw new Error('refused');
    const seen = { flushedBeforeTool: [] as number[] };
    const out = await new AgentSdkSkillRunner({ queryFn: cli(seen, sink, runId), timeoutMs: 5000, prefixTripwireTokens: 500_000 }).run(
      { skillPath: 'skills/scan-slack.md', model: MODEL, mcpServers: {}, allowedTools: restrictedTools('slack').allowedTools, runId, context: await store.getContext(INBOX), maxTurns: 20, costCapUsd: 1, signal: new AbortController().signal, window: WINDOW, spend: holdGate(gov, held.hold, { minCeilingUsd: 1 }) },
      store,
    );
    expect(out.ok).toBe(true);
    expect(seen.flushedBeforeTool).toEqual([1, 2]);
    const turns = sink.of(runId).filter((e) => e.kind === 'turn');
    const pass = sink.of(runId).filter((e) => e.kind === 'pass');
    expect(turns).toHaveLength(2);
    expect(pass).toHaveLength(1);
    expect(turns.every((e) => e.payload.q === pass[0]!.payload.q && e.payload.hold === held.hold.id)).toBe(true);
    expect(pass[0]!.payload.hold).toBe(held.hold.id);
    expect(Number(pass[0]!.payload.costUsd)).toBeCloseTo(turns.reduce((a, e) => a + Number(e.payload.costUsd), 0), 6);
    expect(turns[0]!.payload.contentHash).toBe(pass[0]!.payload.contentHash);
  });
});
