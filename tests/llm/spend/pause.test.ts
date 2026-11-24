/**
 * The skill runner's pause path (spend governor, H-5) with a fake SDK: past its hold a run stops at the next turn
 * boundary (the next tool never runs), raises a hand (SPEND.ASK) and ends `paused_for_spend`; the scanner runtime
 * then re-queues the same window as a held retry carrying the hold, never a failure (no health change, no split).
 * The answer (Allow $Z more) lets the re-run go on with the larger hold, and it settles. Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CanUseTool, HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { MemorySpendStore, PAUSED_FOR_SPEND, SpendGovernor, holdGate } from '@/llm/spend';
import { AgentSdkSkillRunner, type QueryFn, type ScanSkillRunInput } from '@/llm/skill-runner';
import { restrictedTools } from '@/llm/mcp-config';
import { slackSpec } from '@/scanner/runtime/connectors';
import { retryJobOf, type ScanJob } from '@/scanner/runtime/jobs';
import { ScannerRuntime } from '@/scanner/runtime/scanner-runtime';
import { FakeClock } from '@/scanner/runtime/clock';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import { INBOX } from '../../scanner/runtime/helpers/world';
import { PROFILE } from '../../scanner/runtime/helpers/world';

const WINDOW = { from: '2026-11-04T16:00:00.000Z', to: '2026-11-04T18:00:00.000Z' };
const SEARCH = 'mcp__slack__slack_search_public_and_private';
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
type Step = { tool: string; input: Record<string, unknown>; usage: Usage };

/** A CLI stand-in that asks the PreToolUse hook and then the canUseTool gate before every tool, like the real CLI. */
function cli(steps: Step[], seen: { executed: string[]; options?: Options }): QueryFn {
  return ({ options }) => {
    seen.options = options;
    const gen = async function* (): AsyncGenerator<SDKMessage> {
      const signal = options.abortController!.signal;
      const cc = (options.mcpServers as Record<string, { instance: { connect: (t: unknown) => Promise<void> } }>).cc!.instance;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await cc.connect(st);
      const client = new Client({ name: 'fake-cli', version: '1' });
      await client.connect(ct);
      yield { type: 'system', subtype: 'init', mcp_servers: [{ name: 'slack', status: 'connected' }], tools: [SEARCH, 'mcp__cc__cc_finish', 'mcp__cc__cc_report_coverage'] } as unknown as SDKMessage;
      let n = 0;
      let cost = 0;
      try {
        for (const s of steps) {
          if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          n += 1;
          yield { type: 'assistant', message: { id: `msg_${n}`, model: options.model, content: [{ type: 'tool_use', id: `tu_${n}`, name: s.tool, input: s.input }], usage: s.usage } } as unknown as SDKMessage;
          cost += (s.usage.input_tokens * 0.1 + s.usage.output_tokens * 0.5) / 1e6;
          const pre = options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
          await pre({ hook_event_name: 'PreToolUse', tool_name: s.tool, tool_input: s.input, tool_use_id: `tu_${n}`, session_id: 's', transcript_path: '', cwd: '' } as never, `tu_${n}`, { signal });
          const gate = (await (options.canUseTool as CanUseTool)(s.tool, s.input, { signal, toolUseID: `tu_${n}` } as never)) as { behavior: string; interrupt?: boolean };
          if (gate.behavior === 'deny') {
            if (gate.interrupt) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            continue;
          }
          seen.executed.push(s.tool);
          if (s.tool.startsWith('mcp__cc__')) await client.callTool({ name: s.tool.slice('mcp__cc__'.length), arguments: s.input });
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_${n}`, content: [{ type: 'text', text: '{"results":"","pagination_info":""}' }] }] } } as unknown as SDKMessage;
        }
        yield { type: 'result', subtype: 'success', is_error: false, num_turns: n, result: 'DONE', total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 10 }, modelUsage: {}, permission_denials: [] } as unknown as SDKMessage;
      } finally {
        await client.close();
      }
    };
    return gen();
  };
}

const big: Usage = { input_tokens: 20_000, output_tokens: 50_000 }; // ~$0.027 a request on Haiku's base rate
const steps: Step[] = [
  { tool: SEARCH, input: { query: 'to:me' }, usage: big },
  { tool: SEARCH, input: { query: 'from:me' }, usage: big },
  { tool: 'mcp__cc__cc_report_coverage', input: { windows: ['search:dm', 'search:mentions', 'search:mine'].map((ref) => ({ ref, from: WINDOW.from, to: WINDOW.to })) }, usage: { input_tokens: 100, output_tokens: 50 } },
  { tool: 'mcp__cc__cc_finish', input: { cursor: { value: '1793815200.000000', at: WINDOW.to }, complete: true }, usage: { input_tokens: 100, output_tokens: 50 } },
];

async function world() {
  const clock = new FakeClock(WINDOW.to);
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
  const spendStore = new MemorySpendStore({ now: () => clock.now(), today: () => '2026-11-04' });
  const gov = new SpendGovernor(spendStore);
  return { clock, store, gov, spendStore };
}

describe('the skill runner pauses for spend', () => {
  it('past its hold it stops before the next tool, asks once and ends paused_for_spend', async () => {
    const { store, gov, spendStore } = await world();
    const { runId } = await store.startRun({ scope: INBOX, trigger: 'schedule', window: WINDOW });
    const r = await gov.hold({ scope: 'scan_run', jobKey: 'scan:slack:inbox:x' }, { p50: 0.01, p90: 0.02, basis: 'history', n: 14 });
    if (!r.ok) throw new Error('refused');
    const seen = { executed: [] as string[] };
    const runner = new AgentSdkSkillRunner({ queryFn: cli(steps, seen), timeoutMs: 5000 });
    const input: ScanSkillRunInput = {
      skillPath: 'skills/scan-slack.md',
      model: 'claude-haiku-5-5',
      mcpServers: {},
      allowedTools: restrictedTools('slack').allowedTools,
      runId,
      context: await store.getContext(INBOX),
      maxTurns: 20,
      costCapUsd: 0.25,
      signal: new AbortController().signal,
      window: WINDOW,
      spend: holdGate(gov, r.hold, { minCeilingUsd: 0.25 }),
    };
    const out = await runner.run(input, store);
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/^paused for spend/);
    expect(PAUSED_FOR_SPEND).toBe('paused_for_spend');
    expect(seen.executed).toEqual([]); // the first request alone passed $0.02: the search never ran
    expect(r.hold.state).toBe('asked');
    expect(r.hold.spentUsd).toBeGreaterThan(0.02);
    const ev = [...spendStore.events.values()];
    expect(ev).toHaveLength(1);
    expect(ev[0]!.message).toMatch(/^This scan has used \$0\.\d\d of its \$0\.02 estimate and is 0% done; allow \$0\.\d\d more\?$/);
    // the SDK budget is the runaway guard (≥ the run's own ceiling), never the soft line
    expect((seen as { options?: Options }).options!.maxBudgetUsd).toBeGreaterThanOrEqual(0.25);
  });

  it('without a gate the old cap still applies (no ask)', async () => {
    const { store } = await world();
    const { runId } = await store.startRun({ scope: INBOX, trigger: 'schedule', window: WINDOW });
    const seen = { executed: [] as string[] };
    const runner = new AgentSdkSkillRunner({ queryFn: cli(steps, seen), timeoutMs: 5000 });
    const out = await runner.run({ skillPath: 'skills/scan-slack.md', model: 'claude-haiku-5-5', mcpServers: {}, allowedTools: restrictedTools('slack').allowedTools, runId, context: await store.getContext(INBOX), maxTurns: 20, costCapUsd: 0.01, signal: new AbortController().signal, window: WINDOW }, store);
    expect(out.error?.message).toMatch(/cost cap exceeded/);
  });
});

describe('the scanner runtime re-queues a paused run', () => {
  it('paused (not failed), a held retry with its hold id; Allow $Z more and the re-run finishes and settles', async () => {
    const { clock, store, gov, spendStore } = await world();
    // ten measured runs at ~$0.02 (p90 $0.02): the estimate the hold uses
    spendStore.samples['scan_run|scan-slack'] = Array(12).fill(0.02);
    const seen = { executed: [] as string[] };
    const runner = new AgentSdkSkillRunner({ queryFn: cli(steps, seen), timeoutMs: 5000 });
    const runtime = new ScannerRuntime({ store, runner, specs: [slackSpec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {}, spend: gov });
    const [out] = await runtime.runScope(INBOX, 'manual', WINDOW);
    expect(out).toMatchObject({ status: 'paused', held: true, detail: expect.stringMatching(/^paused_for_spend/) });
    expect(store.getRun(out!.runId!)!.error ?? '').toMatch(/^cancelled: paused for spend/); // the db store records it cancelled
    expect(store.latestHealth('slack')?.state ?? 'ok').not.toBe('degraded');
    const [hold] = await spendStore.listHolds({});
    expect(hold).toMatchObject({ state: 'asked', scope: 'scan_run', estimate: { basis: 'history', p90: 0.02 } });
    // the queue gets the same window back, held, carrying the hold
    const job = { kind: 'scan', id: 'scan:slack:inbox:manual', connector: 'slack', scope: 'inbox', window: WINDOW, mode: 'manual', trigger: 'manual', priority: 1, runAt: WINDOW.to, dedupeKey: 'k', vars: { spendHoldId: hold!.id } } as ScanJob;
    expect(retryJobOf(job, out!).vars?.spendHoldId).toBe(hold!.id);

    // a new run of the same scope while the ask is open waits with it (one question per scope; no model call)
    const before = seen.executed.length;
    expect(await runtime.executeJob({ ...job, id: 'scan:slack:inbox:other', vars: {} })).toMatchObject({ status: 'paused', detail: 'spend_ask_open' });
    expect(seen.executed.length).toBe(before);
    // the answer: Allow $1 more → the re-run resumes the hold and finishes
    await gov.answer(hold!.id, { kind: 'approve', usd: 1 });
    const again = await runtime.executeJob({ ...job, mode: 'retry' as const });
    expect(again.status).toBe('succeeded');
    expect(seen.executed).toContain('mcp__cc__cc_finish');
    const settled = (await spendStore.getHold(hold!.id))!;
    expect(settled.state).toBe('settled');
    expect(settled.heldUsd).toBeCloseTo(1.02, 6);
  });

  it('Stop: the waiting job is skipped; an unanswered ask keeps waiting', async () => {
    const { clock, store, gov, spendStore } = await world();
    const runner = new AgentSdkSkillRunner({ queryFn: cli(steps, { executed: [] }), timeoutMs: 5000 });
    const runtime = new ScannerRuntime({ store, runner, specs: [slackSpec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {}, spend: gov });
    await runtime.runScope(INBOX, 'manual', WINDOW);
    const [hold] = await spendStore.listHolds({});
    const job = { kind: 'scan', id: 'scan:slack:inbox:w', connector: 'slack', scope: 'inbox', window: WINDOW, mode: 'retry', trigger: 'manual', priority: 1, runAt: WINDOW.to, dedupeKey: 'k2', vars: { spendHoldId: hold!.id } } as ScanJob;
    expect(await runtime.executeJob(job)).toMatchObject({ status: 'skipped', held: true });
    await gov.answer(hold!.id, { kind: 'deny' });
    expect(await runtime.executeJob(job)).toMatchObject({ status: 'skipped', detail: 'stopped from a spend ask' });
  });
});
