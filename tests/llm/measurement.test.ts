/**
 * Phase 0 of the holistic review's LLM cost lane (04 §4.5, §4.6 #1-3, #12), offline: the per-request meter, the
 * measurement on a skill run and its `pass` trace row, the tool-output digest (COST-2), the prompt guard that stops a
 * run before Haiku's 100K long-prompt tier, `settingSources: []` (COST-8), the D1 cache split, the ledger-gap rule and
 * the yield table. Fakes only: no model, no MCP server, no network. Placeholders only.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { HookCallback, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { ledgerGaps, measurementOf } from '../../src/db/ledger';
import { aggregateYield, firstScanPerSourceDay, renderYield, type YieldCall } from '../../src/engines/spend-audit/yield';
import { scannerSettingSources } from '../../src/llm/claude-env';
import { longPromptThresholdOf } from '../../src/llm/models';
import { runOneToolCall } from '../../src/llm/one-call';
import type { LoadedSkill } from '../../src/llm/skill-loader';
import { AgentSdkSkillRunner, type QueryFn, type ScanSkillRunInput } from '../../src/llm/skill-runner';
import { normalizeItem } from '../../src/llm/cc-tools';
import { digestToolOutput, EXCERPT_MAX_CHARS, slackDigest, soqlDigest, toolOutputText } from '../../src/llm/tool-digest';
import { RequestMeter, splitResultUsage } from '../../src/llm/usage';
import { restrictedTools } from '../../src/llm/mcp-config';
import { FakeClock } from '../../src/scanner/runtime/clock';
import { runSpend } from '../../src/scanner/runtime/spend';
import { InMemoryScannerStore } from '../../src/scanner/store-memory';
import { MemoryTraceSink, setTraceSink } from '../../src/scanner/trace';
import { PROFILE } from '../scanner/runtime/helpers/world';

const WINDOW = { from: '2026-11-04T16:00:00.000Z', to: '2026-11-04T18:00:00.000Z' };
const ME = 'U0ME00001';
const HAIKU = 'claude-haiku-5-5';

/** Slack's detailed search output for `n` placeholder DMs (the shape src/connectors/slack/parse.ts reads). */
function slackSearchRaw(n: number, pad = 0): { results: string; pagination_info: string } {
  const blocks: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = `${1793808000 + i * 60}.000100`;
    blocks.push(
      [
        `### Result ${i + 1} of ${n}`,
        'Channel: DM (ID: D0DMPLACE1)',
        `Participants: PERSON_A (ID: U0PERSONA), ME (ID: ${ME})`,
        'From: PERSON_A <person.a@example.invalid> (ID: U0PERSONA)',
        'Time: 2026-11-04 09:00:00 MST',
        `Message_ts: ${t}`,
        `Permalink: [link](https://example.slack.com/archives/D0DMPLACE1/p${t.replace('.', '')})`,
        'Text:',
        `PLACEHOLDER_${i} can you send the deck? ${'x'.repeat(pad)}`,
        '',
        '---',
        '',
      ].join('\n'),
    );
  }
  return { results: blocks.join(''), pagination_info: n ? 'For the next page of results use cursor `PAGE:2`' : '' };
}

const asBlocks = (o: unknown) => [{ type: 'text', text: JSON.stringify(o) }];

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
interface FakeStep {
  tool: string;
  input: Record<string, unknown>;
  usage: Usage;
  /** The tool's raw output (cc tools run on the real in-process server). */
  response?: unknown;
}
interface Seen {
  options?: Options;
  post: Array<Record<string, unknown>>;
  /** What reached the model as each tool result (after any digest). */
  sent: unknown[];
  executed: string[];
}

/** A CLI stand-in that, unlike the be2a fake, runs the PostToolUse hook and honours its output (continue, updatedToolOutput). */
function cli(steps: FakeStep[], seen: Seen, o: { contextUsage?: boolean } = {}): QueryFn {
  return ({ options }) => {
    seen.options = options;
    const gen = async function* (): AsyncGenerator<SDKMessage> {
      const signal = options.abortController!.signal;
      const cc = (options.mcpServers as Record<string, { instance: { connect: (t: unknown) => Promise<void> } }>).cc!.instance;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await cc.connect(st);
      const client = new Client({ name: 'fake-cli', version: '1' });
      await client.connect(ct);
      yield { type: 'system', subtype: 'init', mcp_servers: [{ name: 'slack', status: 'connected' }], tools: ['mcp__slack__slack_search_public_and_private', 'mcp__cc__cc_finish', 'mcp__cc__cc_report_coverage'] } as unknown as SDKMessage;
      let n = 0;
      for (const s of steps) {
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        n += 1;
        const id = `tu_${n}`;
        yield { type: 'assistant', message: { id: `msg_${n}`, model: options.model, content: [{ type: 'tool_use', id, name: s.tool, input: s.input }], usage: s.usage } } as unknown as SDKMessage;
        await new Promise((r) => setTimeout(r, 0)); // let the context-usage answer land, as the CLI's would
        const pre = options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
        const p = (await pre({ hook_event_name: 'PreToolUse', tool_name: s.tool, tool_input: s.input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '' } as never, id, { signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
        if (p?.hookSpecificOutput?.permissionDecision === 'deny') continue;
        seen.executed.push(s.tool);
        const response = s.tool.startsWith('mcp__cc__') ? ((await client.callTool({ name: s.tool.slice('mcp__cc__'.length), arguments: s.input })) as { content: unknown }).content : s.response;
        const post = options.hooks!.PostToolUse![0]!.hooks[0] as HookCallback;
        const out = (await post({ hook_event_name: 'PostToolUse', tool_name: s.tool, tool_input: s.input, tool_response: response, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '' } as never, id, { signal })) as Record<string, unknown>;
        seen.post.push(out);
        const replaced = (out.hookSpecificOutput as { updatedToolOutput?: unknown } | undefined)?.updatedToolOutput;
        seen.sent.push(replaced ?? response);
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: replaced ?? response }] } } as unknown as SDKMessage;
        if (out.continue === false) break;
      }
      yield { type: 'result', subtype: 'success', is_error: false, num_turns: n, result: 'DONE', total_cost_usd: 0.002, usage: { input_tokens: 10, output_tokens: 10 }, modelUsage: {}, permission_denials: [] } as unknown as SDKMessage;
      await client.close();
    };
    const q = gen() as ReturnType<QueryFn>;
    if (o.contextUsage) {
      q.getContextUsage = async () => ({
        totalTokens: 21_000,
        categories: [
          { id: 'system_prompt', tokens: 9_000, kind: 'used' },
          { id: 'system_tools', tokens: 4_000, kind: 'used' },
          { id: 'mcp_tools', tokens: 3_000, kind: 'used' },
          { id: 'mcp_tools_deferred', tokens: 50_000, kind: 'deferred' },
          { id: 'messages', tokens: 5_000, kind: 'used' },
        ],
      });
    }
    return q;
  };
}

async function setup(model = HAIKU) {
  const store = new InMemoryScannerStore({ clock: new FakeClock(WINDOW.to), profile: structuredClone(PROFILE) });
  const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
  const context = await store.getContext({ connector: 'slack', scope: 'inbox' });
  const input: ScanSkillRunInput = {
    skillPath: 'skills/scan-slack.md',
    model,
    mcpServers: { slack: { type: 'http', url: 'https://mcp.example.invalid/mcp' } },
    allowedTools: restrictedTools('slack').allowedTools,
    runId,
    context,
    maxTurns: 20,
    costCapUsd: 5,
    signal: new AbortController().signal,
    window: WINDOW,
    mode: 'incremental',
    autoRecord: 'slack',
  };
  return { store, input, runId };
}

const SEARCH = 'mcp__slack__slack_search_public_and_private';
const finish: FakeStep = { tool: 'mcp__cc__cc_finish', input: { cursor: { value: '1793815200.000000', at: WINDOW.to }, complete: true }, usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 9_000 } };
const coverage: FakeStep = {
  tool: 'mcp__cc__cc_report_coverage',
  input: { windows: ['search:dm', 'search:mentions', 'search:mine'].map((ref) => ({ ref, from: WINDOW.from, to: WINDOW.to })) },
  usage: { input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 8_000 },
};
const fresh = (): Seen => ({ post: [], sent: [], executed: [] });

let sink: MemoryTraceSink | null = null;
afterEach(() => {
  setTraceSink(null);
  sink = null;
});

describe('RequestMeter', () => {
  it('measures each request once (same id = same request), and projects the next one from the last reply and pending tool output', () => {
    const m = new RequestMeter(longPromptThresholdOf);
    expect(m.measure()).toEqual({});
    expect(m.projectedNext()).toBe(0);
    m.observe('a', HAIKU, { input_tokens: 100, cache_read_input_tokens: 40_000, output_tokens: 50 });
    m.observe('a', HAIKU, { input_tokens: 100, cache_read_input_tokens: 40_000, output_tokens: 80 }); // same request, later block
    m.addPending(2_000);
    expect(m.projectedNext()).toBe(40_100 + 80 + 2_000);
    m.observe('b', HAIKU, { input_tokens: 10, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 101_000, output_tokens: 10 });
    expect(m.projectedNext()).toBe(103_010 + 10); // the pending output went into request b
    m.observe('c', 'claude-sonnet-5-5', { input_tokens: 150_000, output_tokens: 1 }); // no tier on Sonnet
    expect(m.measure()).toEqual({ firstPromptTokens: 40_100, maxPromptTokens: 150_000, longTierRequests: 1, turns: 3 });
    expect(m.threshold(HAIKU)).toBeNull(); // the last request was Sonnet's
  });

  it('long-prompt thresholds come from the price table (Haiku 5.5: 100K; Sonnet and Opus: none)', () => {
    expect(longPromptThresholdOf(HAIKU)).toBe(100_000);
    expect(longPromptThresholdOf('claude-sonnet-5-5')).toBeNull();
    expect(longPromptThresholdOf('unknown-model')).toBeNull();
  });
});

describe('D1: one-shot usage is split, never folded into input', () => {
  it('splitResultUsage keeps uncached input, cache reads and cache writes apart', () => {
    expect(splitResultUsage({ input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 700 })).toEqual({ inputTokens: 12, outputTokens: 34, cacheReadTokens: 5_000, cacheWriteTokens: 700 });
    expect(splitResultUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe('COST-8: scanners and relays load no Claude settings files', () => {
  it('defaults to none; CC_SCANNER_SETTING_SOURCES restores user (known values only)', () => {
    expect(scannerSettingSources({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(scannerSettingSources({ CC_SCANNER_SETTING_SOURCES: 'user' } as unknown as NodeJS.ProcessEnv)).toEqual(['user']);
    expect(scannerSettingSources({ CC_SCANNER_SETTING_SOURCES: 'user, bogus,local,user' } as unknown as NodeJS.ProcessEnv)).toEqual(['user', 'local']);
  });
});

describe('tool digest (COST-2)', () => {
  it('Slack: one block per message with its ref, author and full text; permalinks and e-mails dropped; pagination kept; smaller', () => {
    const raw = asBlocks(slackSearchRaw(3));
    const d = slackDigest(SEARCH, {}, raw, { me: ME })!;
    expect(d).toMatchObject({ kind: 'slack', items: 3 });
    expect(d.chars).toBeLessThan(d.rawChars);
    const text = toolOutputText(d.output);
    expect(Array.isArray(d.output)).toBe(true); // same wrapper as the tool's output
    expect(text).toContain('[Digest of slack_search_public_and_private: 3 message(s).');
    expect(text).toContain('D0DMPLACE1:1793808000.000100');
    expect(text).toContain('PLACEHOLDER_2 can you send the deck?');
    expect(text).toContain('from PERSON_A (U0PERSONA)');
    expect(text).toContain('with: PERSON_A (U0PERSONA), ME (U0ME00001)');
    expect(text).toContain('cursor `PAGE:2`');
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('Permalink');
  });

  it('Slack: a 3,500-character message reaches the model whole; the digest and the stored excerpt share one 4,000 cap (W0-5)', () => {
    expect(EXCERPT_MAX_CHARS).toBe(4_000);
    const raw = slackSearchRaw(1, 3_500);
    const text = toolOutputText(slackDigest(SEARCH, {}, asBlocks(raw), { me: ME })!.output);
    const msg = `PLACEHOLDER_0 can you send the deck? ${'x'.repeat(3_500)}`;
    expect(text).toContain(msg);
    expect(text).not.toContain('…(cut)');
    const long = toolOutputText(slackDigest(SEARCH, {}, asBlocks(slackSearchRaw(1, 5_000)), { me: ME })!.output);
    expect(long).toContain(`${'x'.repeat(EXCERPT_MAX_CHARS - 40)}`);
    expect(long).toContain('…(cut)');
    const stored = normalizeItem('slack', { kind: 'message', externalId: 'D0DMPLACE1:1793808000.000100', occurredAt: '2026-11-04T16:00:00.000Z', excerpt: 'y'.repeat(5_000) });
    expect(stored.excerpt?.length).toBe(EXCERPT_MAX_CHARS);
  });

  it('Slack: nothing parsed (no results, an error text) → no digest, the raw result stands', () => {
    expect(slackDigest(SEARCH, {}, asBlocks({ results: 'No results found', pagination_info: '' }))).toBeNull();
    expect(slackDigest('mcp__slack__slack_send_message', {}, asBlocks(slackSearchRaw(2)))).toBeNull();
    expect(digestToolOutput(SEARCH, {}, asBlocks(slackSearchRaw(2)), { slackRecorded: false })).toBeNull(); // not recorded: raw
  });

  it('SOQL: compact JSON without each row’s attributes.url (the type stays); not a result → null', () => {
    const body = { totalSize: 2, done: true, records: [{ attributes: { type: 'Opportunity', url: '/services/data/v60.0/sobjects/Opportunity/006XX0000000001' }, Id: '006XX0000000001', Name: 'PLACEHOLDER', Account: { attributes: { type: 'Account', url: '/x' }, Name: 'ACME' } }] };
    const d = soqlDigest('mcp__org62__soqlQuery', [{ type: 'text', text: JSON.stringify(body, null, 2) }])!;
    expect(d.kind).toBe('soql');
    const j = JSON.parse(toolOutputText(d.output));
    expect(j).toEqual({ totalSize: 2, done: true, records: [{ attributes: { type: 'Opportunity' }, Id: '006XX0000000001', Name: 'PLACEHOLDER', Account: { attributes: { type: 'Account' }, Name: 'ACME' } }] });
    expect(soqlDigest('mcp__org62__soqlQuery', 'INVALID_FIELD: no such column')).toBeNull();
    expect(soqlDigest('mcp__org62__find', JSON.stringify(body))).toBeNull();
  });
});

describe('skill runner: measurement, digest and prompt guard', () => {
  it('settingSources is [] and the PostToolUse hook is always installed', async () => {
    const { store, input } = await setup();
    const seen = fresh();
    await new AgentSdkSkillRunner({ prefixTripwireTokens: 500_000, queryFn: cli([coverage, finish], seen) }).run(input, store);
    expect(seen.options!.settingSources).toEqual([]);
    expect(seen.options!.hooks!.PostToolUse).toHaveLength(1);
  });

  it('measures the run: first / max prompt, long-tier requests, turns, tools, schema tokens, prefix hash, items; the pass row carries it', async () => {
    sink = new MemoryTraceSink();
    setTraceSink(sink);
    const { store, input, runId } = await setup();
    const seen = fresh();
    const steps: FakeStep[] = [
      { tool: SEARCH, input: { query: `-from:<@${ME}>` }, usage: { input_tokens: 300, output_tokens: 40, cache_creation_input_tokens: 30_000 }, response: asBlocks(slackSearchRaw(4)) },
      { ...coverage, usage: { input_tokens: 50, output_tokens: 40, cache_read_input_tokens: 105_000 } }, // one request in the tier
      finish,
    ];
    const r = await new AgentSdkSkillRunner({ prefixTripwireTokens: 500_000, queryFn: cli(steps, seen, { contextUsage: true }), promptGuard: false }).run(input, store);
    expect(r.ok).toBe(true);
    expect(r.measure).toMatchObject({ firstPromptTokens: 30_300, maxPromptTokens: 105_050, longTierRequests: 1, turns: 3, toolCount: 3, toolSchemaTokens: 7_000, itemsIn: 4, itemsOut: 0 });
    expect(r.measure!.prefixHash).toMatch(/^[0-9a-f]{32}$/);
    const pass = sink.of(runId).find((e) => e.kind === 'pass')!;
    expect(measurementOf(pass.payload.m)).toEqual(r.measure);
    const ctx = sink.of(runId).find((e) => e.kind === 'context')!;
    expect(ctx.payload).toMatchObject({ total: 21_000 });
    // REC-1 recorded the raw messages before the model got the digest
    expect(r.counts?.recorded).toBe(4);
    expect(toolOutputText(seen.sent[0])).toContain('[Digest of slack_search_public_and_private: 4 message(s).');
    const call = sink.of(runId).find((e) => e.kind === 'tool_call' && e.payload.tool === 'slack_search_public_and_private')!;
    expect(call.payload).toMatchObject({ digest: true });
    expect(Number(call.payload.rawSize)).toBeGreaterThan(Number(call.payload.size));
    // the same skill, tools and scope: the same prefix (cache identity), whatever the run
    const again = await setup();
    const r2 = await new AgentSdkSkillRunner({ prefixTripwireTokens: 500_000, queryFn: cli([coverage, finish], fresh()) }).run(again.input, again.store);
    expect(r2.measure!.prefixHash).toBe(r.measure!.prefixHash);
  });

  it('CC_TOOL_DIGEST off: the raw result reaches the model', async () => {
    const { store, input } = await setup();
    const seen = fresh();
    const raw = asBlocks(slackSearchRaw(2));
    await new AgentSdkSkillRunner({ prefixTripwireTokens: 500_000, queryFn: cli([{ tool: SEARCH, input: { query: `-from:<@${ME}>` }, usage: { input_tokens: 10, output_tokens: 10 }, response: raw }, coverage, finish], seen), toolDigest: false }).run(input, store);
    expect(seen.sent[0]).toBe(raw);
  });

  it('stops before a request would pass the 100K tier: the run ends "prompt cap" (a planned split), no long-tier request is made', async () => {
    sink = new MemoryTraceSink();
    setTraceSink(sink);
    const { store, input, runId } = await setup();
    const seen = fresh();
    const big = asBlocks(slackSearchRaw(30, 900)); // ~30K characters even as a digest: ~12K tokens at the guard's rate
    const steps: FakeStep[] = [
      { tool: SEARCH, input: { query: `-from:<@${ME}>` }, usage: { input_tokens: 500, output_tokens: 300, cache_read_input_tokens: 90_000 }, response: big },
      coverage,
      finish,
    ];
    const r = await new AgentSdkSkillRunner({ prefixTripwireTokens: 500_000, queryFn: cli(steps, seen) }).run(input, store);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/^prompt cap: the next request would be about \d+ tokens, past the 100000-token long-prompt tier$/);
    expect(r.error?.errorClass).toBe('config');
    expect(seen.post[0]).toMatchObject({ continue: false, stopReason: 'prompt cap' });
    expect(seen.executed).toEqual([SEARCH]); // nothing after the guard
    expect(r.measure).toMatchObject({ turns: 1, longTierRequests: 0, maxPromptTokens: 90_500 });
    // the raw messages were still recorded (nothing read is lost; the split windows re-read and dedupe)
    expect(r.counts?.recorded).toBe(30);
    expect(sink.of(runId).find((e) => e.kind === 'prompt_guard')!.payload).toMatchObject({ limit: 100_000, finished: false });
  });

  it('the guard does not trip on a model without a long-prompt tier, nor when turned off', async () => {
    const steps = (): FakeStep[] => [
      { tool: SEARCH, input: { query: `-from:<@${ME}>` }, usage: { input_tokens: 500, output_tokens: 300, cache_read_input_tokens: 90_000 }, response: asBlocks(slackSearchRaw(30, 900)) },
      coverage,
      finish,
    ];
    const sonnet = await setup('claude-sonnet-5-5');
    expect((await new AgentSdkSkillRunner({ prefixTripwireTokens: 500_000, queryFn: cli(steps(), fresh()) }).run(sonnet.input, sonnet.store)).ok).toBe(true);
    const off = await setup();
    expect((await new AgentSdkSkillRunner({ prefixTripwireTokens: 500_000, queryFn: cli(steps(), fresh()), promptGuard: false }).run(off.input, off.store)).ok).toBe(true);
  });

  it('a run that already finished is only stopped, not failed, when its closing reply would cross the tier', async () => {
    const { store, input } = await setup();
    const seen = fresh();
    const steps: FakeStep[] = [coverage, { ...finish, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 99_000 } }];
    const r = await new AgentSdkSkillRunner({ prefixTripwireTokens: 500_000, queryFn: cli(steps, seen) }).run(input, store);
    expect(r.ok).toBe(true);
    expect(seen.post.at(-1)).toMatchObject({ continue: false });
  });

  it('runSpend carries the measurement to the ledger row that no pass row covers', async () => {
    const { store, input } = await setup();
    const r = await new AgentSdkSkillRunner({ prefixTripwireTokens: 500_000, queryFn: cli([coverage, finish], fresh()) }).run(input, store);
    const b = runSpend(r, { connector: 'slack', model: HAIKU, trigger: 'schedule', modelReason: 'default', hashOf: ['x'] });
    expect(b.measure).toEqual(r.measure);
    expect(ledgerGaps({ ...b, costUsd: 0.01, inputTokens: 1 })).toEqual([]);
  });
});

describe('one-call relay measurement', () => {
  it('measures the relay’s requests and prefix, and loads no settings files', async () => {
    let opts: Options | undefined;
    const FULL = 'mcp__slack__slack_search_public_and_private';
    const SKILL = { frontmatter: { model: HAIKU, max_turns: 2, budget_usd_per_run: 1 }, body: 'relay' } as unknown as LoadedSkill;
    const queryFn: QueryFn = ({ options }) => {
      opts = options;
      return (async function* () {
        yield { type: 'system', subtype: 'init', tools: [FULL] } as unknown as SDKMessage;
        yield { type: 'assistant', message: { id: 'm1', model: HAIKU, content: [], usage: { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 6_000 } } } as unknown as SDKMessage;
        yield { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'No results found' }] }] } } as unknown as SDKMessage;
        yield { type: 'result', total_cost_usd: 0.0002, modelUsage: { [HAIKU]: { inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 6_000, cacheCreationInputTokens: 0, costUSD: 0.0002 } } } as unknown as SDKMessage;
      })();
    };
    const r = await runOneToolCall({ servers: {}, fullTool: FULL, args: { query: 'x' }, allowedTools: [FULL], disallowedTools: [], skill: SKILL, queryFn, timeoutMs: 5_000 });
    expect(opts!.settingSources).toEqual([]);
    expect(r).toMatchObject({ code: 'ok', cacheReadTokens: 6_000, inputTokens: 40 });
    expect(r.measure).toMatchObject({ firstPromptTokens: 6_040, maxPromptTokens: 6_040, longTierRequests: 0, turns: 1, toolCount: 1 });
    expect(r.measure!.prefixHash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('ledger gaps (0027)', () => {
  const ok = { trigger: 'schedule', modelReason: 'default', outcome: 'ok', contentHash: 'h', costUsd: 0.01, inputTokens: 10 };
  it('a call that booked turns must say how big its first request was', () => {
    expect(ledgerGaps({ ...ok, measure: { turns: 3, firstPromptTokens: 4_000 } })).toEqual([]);
    expect(ledgerGaps({ ...ok, measure: { turns: 3 } })).toEqual(['turns without first_prompt_tokens']);
    expect(ledgerGaps({ ...ok, measure: { turns: 0 } })).toEqual([]);
    expect(ledgerGaps(ok)).toEqual([]); // older writers: no measurement at all is fine
  });

  it('measurementOf keeps known keys, clamps numbers, drops junk', () => {
    expect(measurementOf({ turns: '4', firstPromptTokens: 1200.6, longTierRequests: -2, prefixHash: 'abc', body: 'never', toolCount: 'x' })).toEqual({ turns: 4, firstPromptTokens: 1201, longTierRequests: 0, prefixHash: 'abc' });
    expect(measurementOf(null)).toBeUndefined();
    expect(measurementOf({ nothing: 1 })).toBeUndefined();
  });
});

describe('scan:report --yield (pure part)', () => {
  const call = (o: Partial<YieldCall>): YieldCall => ({ skill: 'scan-slack', connector: 'slack', usd: 0.01, inputTokens: 100, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 100, outcome: 'nothing_new', runId: null, turns: null, longTierRequests: null, itemsOut: null, itemsIn: null, escalationChangedItems: null, ...o });

  it('per skill and source: $, calls, runs, $/run, empty runs, cache hit, long tier, $/found, $/closed, escalation changes', () => {
    const calls = [
      call({ runId: 'r1', usd: 0.02, turns: 4, longTierRequests: 1 }),
      call({ runId: 'r2', usd: 0.01, turns: 6, longTierRequests: 0 }),
      call({ runId: 'r3', usd: 0.01 }),
      call({ skill: 'triage-slack', runId: 'r1', usd: 0.004 }),
      call({ skill: 'triage-slack', runId: 'r1', usd: 0.004 }), // a second batch of the same run: still one run
      call({ skill: 'triage-slack', runId: 'r1', usd: 0.03, itemsIn: 2, escalationChangedItems: 1 }),
      call({ skill: 'readin-ask', connector: null, usd: 0.05, itemsOut: 1, outcome: 'ready' }),
      call({ skill: 'readin-ask', connector: null, usd: 0.05, outcome: 'unchanged' }),
    ];
    const runs = [
      { id: 'r1', changed: 3, found: 2, closed: 1 },
      { id: 'r2', changed: 0, found: 0, closed: 0 },
      { id: 'r3', changed: 1, found: 0, closed: 0 },
    ];
    const rows = aggregateYield(calls, runs);
    const slack = rows.find((r) => r.skill === 'scan-slack')!;
    expect(slack).toMatchObject({ connector: 'slack', calls: 3, runs: 3, emptyRuns: 1, measuredCalls: 2, turns: 10, longTierRequests: 1, found: 2, closed: 1, escalation: null });
    expect(slack.usd).toBeCloseTo(0.04, 9);
    expect(slack.usdPerRun).toBeCloseTo(0.04 / 3, 9);
    expect(slack.emptyPct).toBeCloseTo(100 / 3, 6);
    expect(slack.cacheHitPct).toBeCloseTo(80, 6);
    expect(slack.longTierPct).toBeCloseTo(10, 6);
    expect(slack.usdPerFound).toBeCloseTo(0.02, 9);
    expect(slack.usdPerClosed).toBeCloseTo(0.04, 9);
    const triage = rows.find((r) => r.skill === 'triage-slack')!;
    expect(triage).toMatchObject({ calls: 3, runs: 1, found: 2, closed: 1, longTierPct: null, escalation: { items: 2, changed: 1, changedPct: 50 } });
    const readin = rows.find((r) => r.skill === 'readin-ask')!;
    expect(readin).toMatchObject({ connector: null, runs: 2, emptyRuns: 1, found: 1, closed: 0, usdPerClosed: null });
    expect(rows[0]!.skill).toBe('readin-ask'); // largest spend first
  });

  it('first scan: $ per source per day of history; the table renders every row', () => {
    const first = firstScanPerSourceDay([
      { connector: 'slack', usd: 3, from: '2026-10-05T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z' },
      { connector: null, usd: 0.5, from: null, to: null },
    ]);
    expect(first[0]).toMatchObject({ connector: 'slack', days: 30, usdPerDay: 0.1 });
    expect(first[1]).toMatchObject({ connector: null, days: null, usdPerDay: null });
    const lines = renderYield(aggregateYield([call({ runId: null, turns: 2, longTierRequests: 1 })], []), first, { since: 'S', until: 'U', dbName: 'db' });
    expect(lines[0]).toBe('yield · db · S → U');
    expect(lines[1]).toMatch(/skill\s+source\s+\$\s+calls/);
    expect(lines[2]).toMatch(/scan-slack\s+slack\s+\$0\.0100\s+1\s+1 .* 50% \(1\/2\)/);
    expect(lines.some((l) => l.includes('slack') && l.includes('over 30 d = $0.10/day'))).toBe(true);
    expect(renderYield([], [], { since: 'S', until: 'U', dbName: 'db' })).toContain('  (no model calls in this period)');
  });
});
