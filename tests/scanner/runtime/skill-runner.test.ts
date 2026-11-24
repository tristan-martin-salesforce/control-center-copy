/**
 * AgentSdkSkillRunner with a fake `query()`: the fake plays the CLI. It calls the runner's PreToolUse
 * hook like the CLI does, executes cc tools through the REAL in-process MCP server (InMemoryTransport),
 * and emits init / assistant / result messages in the SDK shapes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { AgentSdkSkillRunner, type ScanSkillRunInput } from '../../../src/llm/skill-runner';
import { fakeQuery, type Step } from './helpers/fake-query';
import { restrictedTools } from '../../../src/llm/mcp-config';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { PROFILE } from './helpers/world';

const WINDOW = { from: '2026-11-04T16:00:00.000Z', to: '2026-11-04T18:00:00.000Z' };

async function setup(scope = 'inbox', connector: 'slack' | 'watch' = 'slack') {
  const store = new InMemoryScannerStore({ clock: new FakeClock('2026-11-04T18:00:00Z'), profile: structuredClone(PROFILE) });
  const { runId } = await store.startRun({ scope: { connector, scope }, trigger: 'schedule', window: WINDOW });
  const context = await store.getContext({ connector, scope });
  const input: ScanSkillRunInput = {
    skillPath: 'skills/scan-slack.md',
    model: 'claude-haiku-5-5',
    mcpServers: { slack: { type: 'http', url: 'https://mcp.example.invalid/mcp' } },
    allowedTools: restrictedTools('slack').allowedTools,
    runId,
    context,
    maxTurns: 10,
    costCapUsd: 0.05,
    signal: new AbortController().signal,
    window: WINDOW,
    mode: 'incremental',
  };
  return { store, input, runId };
}

const finishSteps: Step[] = [
  { tool: 'mcp__cc__cc_report_coverage', input: { windows: [{ ref: 'search:dm', from: WINDOW.from, to: WINDOW.to }, { ref: 'search:mentions', from: WINDOW.from, to: WINDOW.to }, { ref: 'search:mine', from: WINDOW.from, to: WINDOW.to }] } },
  { tool: 'mcp__cc__cc_finish', input: { cursor: { value: '1793815200.000000', at: WINDOW.to }, complete: true } },
];

afterEach(() => {
  delete process.env.CLAUDE_CODE_FAKE_PARENT;
});

describe('AgentSdkSkillRunner', () => {
  it('runs one query() with the restricted config and captures cost, tokens, turns and cursor', async () => {
    process.env.CLAUDE_CODE_FAKE_PARENT = 'leak';
    const { store, input } = await setup();
    const seen = { toolResults: [] as string[] } as { options?: Options; prompt?: string; toolResults: string[] };
    const runner = new AgentSdkSkillRunner({ gateway: { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' }, apiKeyHelper: 'example-helper' }, queryFn: fakeQuery({ steps: [{ tool: 'mcp__slack__slack_search_public_and_private', input: { query: '-from:<@U0ME00001>' } }, ...finishSteps] }, seen) });
    const r = await runner.run(input, store);
    // D0: cache reads and writes are their own fields, not input (100 uncached + 6000 read + 2500 written)
    expect(r).toMatchObject({ ok: true, costUsd: 0.0031, turns: 3, inputTokens: 100, cacheReadTokens: 6000, cacheWriteTokens: 2500, outputTokens: 200, complete: true, proposedCursor: { value: '1793815200.000000', at: WINDOW.to } });
    const o = seen.options!;
    expect(o.tools).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe('default'); // the canUseTool gate approves every call (SDK-1)
    expect(o.persistSession).toBe(false);
    expect(o.settingSources).toEqual([]); // COST-8: no settings files; the gateway env and apiKeyHelper are passed explicitly
    expect(o.effort).toBe('low');
    expect(o.maxTurns).toBe(10);
    expect(o.maxBudgetUsd).toBe(0.05);
    expect(Object.keys(o.mcpServers!).sort()).toEqual(['cc', 'slack']);
    // No bare allowedTools: they would auto-approve before the gate (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED).
    expect(o.allowedTools).toBeUndefined();
    const gate = (t: string) => o.canUseTool!(t, {}, { signal: new AbortController().signal, toolUseID: 'tu_gate' } as never);
    for (const t of ['mcp__slack__slack_search_public_and_private', 'mcp__cc__cc_finish', 'mcp__cc__cc_record_brief_highlights']) expect((await gate(t))?.behavior, t).toBe('allow');
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['mcp__slack__slack_send_message', 'mcp__slack__slack_add_reaction', 'mcp__slack__slack_mark_read']));
    expect(o.disallowedTools).not.toContain('mcp__slack__slack_read_thread');
    expect(Object.keys(o.env!).some((k) => k.startsWith('CLAUDE_CODE_'))).toBe(false); // host-session vars never leak
    expect(o.env!.ANTHROPIC_BASE_URL).toBe('https://gateway.example.invalid'); // gateway env from the user's settings
    expect(o.settings).toEqual({ apiKeyHelper: 'example-helper' });
    expect(o.skills).toEqual([]);
    const sp = o.systemPrompt as string[];
    expect(sp[1]).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    expect(sp[0]).toContain('Command Center scanner: shared rules');
    expect(sp[0]).toContain('scan-slack: Slack traversal scanner');
    expect(sp[0]).not.toContain('U0ME00001'); // static prefix: no per-user values
    expect(sp[2]).toContain('"slackId":"U0ME00001"');
    expect(seen.prompt).toContain('{{me.slackId}} = U0ME00001');
    expect(seen.prompt).toContain(`{{window.afterUnix}} = ${Math.floor(Date.parse(WINDOW.from) / 1000) - 120}`);
    expect(seen.toolResults.at(-1)).toContain('"ok":true');
  });

  it('aborts the whole run on a non-allowlisted tool (PreToolUse hook)', async () => {
    const { store, input } = await setup();
    const seen = { toolResults: [] as string[] };
    const runner = new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [{ tool: 'mcp__slack__slack_send_message', input: { channel_id: 'D1', text: 'hi' } }, ...finishSteps] }, seen) });
    const r = await runner.run(input, store);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ errorClass: 'config', disallowedTool: 'mcp__slack__slack_send_message' });
    expect(r.proposedCursor).toBeUndefined();
    expect(seen.toolResults).toHaveLength(0); // never reached cc_finish
  });

  it('aborts on a hallucinated tool seen in an assistant tool_use block, even without a hook call', async () => {
    const { store, input } = await setup();
    const runner = new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [{ tool: 'Bash', input: { command: 'ls' }, viaHook: false }, ...finishSteps] }, { toolResults: [] }) });
    const r = await runner.run(input, store);
    expect(r.error?.disallowedTool).toBe('Bash');
  });

  it('tolerates a tool name that matches no tool (the CLI rejects it), and still finishes', async () => {
    const { store, input } = await setup();
    const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [{ tool: 'cc_propose_item_placeholder', input: {}, viaHook: false }, ...finishSteps] }, { toolResults: [] }) }).run(input, store);
    expect(r.ok).toBe(true);
    const r2 = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [{ tool: 'mcp__other__anything', input: {}, viaHook: false }, ...finishSteps] }, { toolResults: [] }) }).run((await setup()).input, store);
    expect(r2.error?.disallowedTool).toBe('mcp__other__anything');
  });

  it('classifies needs-auth at init as auth', async () => {
    const { store, input } = await setup();
    const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: finishSteps, mcpStatus: 'needs-auth' }, { toolResults: [] }) }).run(input, store);
    expect(r.error).toMatchObject({ errorClass: 'auth' });
  });

  it('classifies the gateway "Invalid API key" result as auth', async () => {
    const { store, input } = await setup();
    const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: finishSteps, result: { is_error: true, result: 'Invalid API key · Fix external API key' } }, { toolResults: [] }) }).run(input, store);
    expect(r.error).toMatchObject({ errorClass: 'auth' });
  });

  it('aborts when the running cost estimate crosses the per-run cap, and on the prefix tripwire', async () => {
    const { store, input } = await setup();
    const big: Step = { usage: { input_tokens: 5_000, output_tokens: 90_000, cache_read_input_tokens: 10_000 } }; // ≈ $0.046 → over $0.03
    const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [{ usage: { input_tokens: 100, output_tokens: 10 } }, big, big, ...finishSteps] }, { toolResults: [] }) }).run({ ...input, costCapUsd: 0.03 }, store);
    expect(r.error?.message).toMatch(/cost cap exceeded/);
    expect(r.error?.errorClass).toBe('config');
    const s2 = await setup();
    // well past the limit (the context pack and the Persona block, D-55, count toward it)
    const r2 = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [{ usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 60_000 } }, ...finishSteps] }, { toolResults: [] }) }).run(s2.input, s2.store);
    expect(r2.error?.message).toMatch(/prefix tripwire/);
  });

  it('fails a run that ends without cc_finish, and propagates an external abort', async () => {
    const { store, input } = await setup();
    const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [finishSteps[0]!] }, { toolResults: [] }) }).run(input, store);
    expect(r).toMatchObject({ ok: false, error: { message: 'run ended without cc_finish' } });
    const s2 = await setup();
    const ac = new AbortController();
    ac.abort();
    const r2 = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: finishSteps }, { toolResults: [] }) }).run({ ...s2.input, signal: ac.signal }, s2.store);
    expect(r2.error).toMatchObject({ errorClass: 'transient', message: 'aborted by caller' });
  });

  it('records prefetched items first and puts their sourceItemIds and the header into the prompt', async () => {
    const { store, input } = await setup();
    const seen = { toolResults: [] as string[] } as { prompt?: string; toolResults: string[] };
    const prefetched = [{ connector: 'slack' as const, kind: 'message' as const, externalId: 'D0DM00002:1793811720.000100', dedupeKey: 'slack:D0DM00002:1793811720.000100', contentHash: 'h', occurredAt: '2026-11-04T17:02:00.000Z', excerpt: "I'll send it", payload: { direction: 'sent', bodyNew: 'x' } }];
    const cov = [{ kind: 'query_window' as const, ref: 'search:dm', from: WINDOW.from, to: WINDOW.to }];
    const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [finishSteps[1]!] }, seen as any) }).run({ ...input, prefetched, preReportedCoverage: cov }, store);
    expect(r.ok).toBe(true);
    const id = store.getSourceItemByDedupe('slack:D0DM00002:1793811720.000100')!.id;
    expect(seen.prompt).toContain(`"sourceItemId":"${id}"`);
    expect(seen.prompt).toContain('"bodyNew":"x"');
    expect(seen.prompt).toContain('Fetcher coverage');
    expect(r.counts).toMatchObject({ recorded: 1, new: 1, coverage: 1 });
  });

  it('falls back to the HIGHLIGHTS v1 block for watch runs that did not call the tool', async () => {
    const { store, input } = await setup('slack:channel:C0WATCH01', 'watch');
    const steps: Step[] = [
      { tool: 'mcp__cc__cc_record_source_items', input: { items: [{ kind: 'message', externalId: 'C0WATCH01:1793812000.000100', occurredAt: '1793812000.000100', excerpt: 'Private Connect GA' }] } },
      { tool: 'mcp__cc__cc_report_coverage', input: { windows: [{ kind: 'channel_range', ref: 'C0WATCH01', from: WINDOW.from, to: WINDOW.to }] } },
      { tool: 'mcp__cc__cc_finish', input: { cursor: { value: '1793815200.000000', at: WINDOW.to }, summary: 'One launch.\nHIGHLIGHTS v1\n1793812000.000100|https://example.slack.com/p1|Private Connect GA this week|matched=ACME|why=open ACME item' } },
    ];
    const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps }, { toolResults: [] }) }).run({ ...input, skillPath: 'skills/scan-slack.md' }, store);
    expect(r.ok).toBe(true);
    expect(store.listBriefs()[0]).toMatchObject({ subscription: { kind: 'channel', ref: 'C0WATCH01' }, summary: 'One launch.', highlights: [{ relevance: 'high', title: 'Private Connect GA this week' }] });
    expect(store.listBriefs()[0]!.highlights[0]!.sourceItemIds).toHaveLength(1);
  });
});
