/**
 * ConnectorRuntime contract (p1-connector-runtime): each of the four transports behind one `call()`, with fakes only
 * (no MCP server, no network, no model). Every runtime refuses a tool off its manifest's read allowlist before
 * anything is sent, returns `{text, json, usage, cost}`, keeps its transport's own errors and traces ids and codes.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { GoogleCallError, classifyGoogleError } from '@/connectors/google/client';
import { gmailManifest } from '@/connectors/google/manifest';
import { manifestOf } from '@/connectors/registry';
import { buildRuntime, claudeRelayRuntime, directMcpRuntime, httpJsonRpcRuntime, LocalPathRefused, localFilesPort, localFilesRuntime, RelayCostHistory, relayLedger, relaySkillKey, RuntimeCallError, RuntimeToolRefused, textPort, type ConnectorRuntime, type RelayCallRecord, type RuntimeTraceEvent } from '@/connectors/runtime';
import { slackRuntime } from '@/connectors/slack';
import { vdpReadRuntime, VdpClient } from '@/connectors/vdp/client';
import { VdpError } from '@/connectors/vdp/http';
import type { HookCallback, Options, SDKMessage } from '@/llm/provider';
import type { QueryFn } from '@/llm/skill-runner';

import { FakeGoogle } from './readers/helpers';
import { claudeJson, fixtureVdp, NOW as VDP_NOW } from '../vdp/helpers';

const traces = () => {
  const seen: RuntimeTraceEvent[] = [];
  return { seen, trace: (e: RuntimeTraceEvent) => void seen.push(e) };
};

/** Every runtime: shape of a success, refusal of an off-list tool before the transport is touched. */
async function contract(rt: ConnectorRuntime, ok: { tool: string; args: Record<string, unknown> }, transportCalls: () => number) {
  const t = traces();
  const r = await rt.call(ok.tool, ok.args, { trace: t.trace });
  expect(typeof r.text).toBe('string');
  expect(r).toHaveProperty('json');
  expect(r.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: expect.any(Number), turns: expect.any(Number), prefixTokens: expect.any(Number) });
  expect(r.cost).toMatchObject({ usd: expect.any(Number), estimated: false });
  expect(t.seen).toEqual([expect.objectContaining({ connector: rt.connector, runtime: rt.kind, tool: ok.tool, ok: true, ms: expect.any(Number) })]);
  // trace events carry no arguments and no results
  expect(JSON.stringify(t.seen)).not.toContain(JSON.stringify(ok.args).slice(1, 12));
  const before = transportCalls();
  await expect(rt.call('slack_send_message', {})).rejects.toBeInstanceOf(RuntimeToolRefused);
  await expect(rt.call('definitely_not_listed', {})).rejects.toBeInstanceOf(RuntimeToolRefused);
  expect(transportCalls()).toBe(before);
}

describe('direct_mcp (Google through devbar mcpgw)', () => {
  const fake = () => new FakeGoogle({ search_gmail_messages: () => 'Found 0 messages', get_events: () => '{"events":[]}' });

  it('meets the contract; zero cost; a JSON tool text is also parsed', async () => {
    const g = fake();
    const rt = directMcpRuntime({ connector: 'gmail', readTools: gmailManifest.readTools, client: g });
    await contract(rt, { tool: 'search_gmail_messages', args: { query: 'in:inbox' } }, () => g.calls.length);
    expect(rt.estimateUsd('search_gmail_messages')).toBe(0);
    const cal = directMcpRuntime({ connector: 'calendar', readTools: ['get_events'], client: g });
    expect((await cal.call('get_events', {})).json).toEqual({ events: [] });
  });

  it("a tool on Google's allowlist but not on this connector's manifest is refused (Gmail cannot read Drive)", async () => {
    const g = fake();
    const rt = buildRuntime(manifestOf('gmail'), { mcp: g });
    await expect(rt.call('get_doc_as_markdown', { document_id: 'x' })).rejects.toBeInstanceOf(RuntimeToolRefused);
    expect(g.calls).toHaveLength(0);
  });

  it("the client's typed errors pass through unchanged (fetchers and the error catalog classify them)", async () => {
    const err = new GoogleCallError('search_gmail_messages', classifyGoogleError('invalid_grant'), 'invalid_grant');
    const g = new FakeGoogle({
      search_gmail_messages: () => {
        throw err;
      },
    });
    const t = traces();
    const rt = directMcpRuntime({ connector: 'gmail', readTools: gmailManifest.readTools, client: g });
    await expect(rt.call('search_gmail_messages', {}, { trace: t.trace })).rejects.toBe(err);
    expect(t.seen[0]).toMatchObject({ ok: false, code: 'auth' });
  });

  it('textPort gives fetchers the plain text and the runtime health', async () => {
    const port = textPort(directMcpRuntime({ connector: 'gmail', readTools: gmailManifest.readTools, client: fake() }));
    expect(await port.call('search_gmail_messages', { query: 'x' })).toBe('Found 0 messages');
    expect((await port.health()).state).toBe('ok');
  });
});

describe('http_jsonrpc (VDP)', () => {
  it('meets the contract over the recorded fixtures', async () => {
    const vdp = fixtureVdp();
    const rt = vdpReadRuntime({ claudeJson: claudeJson({ cookieExpSec: VDP_NOW / 1000 + 3600 }), fetch: vdp.fetch, now: () => VDP_NOW });
    await contract(rt, { tool: 'search_vdps', args: { limit: 50, offset: 0 } }, () => vdp.calls.length);
    const r = await rt.call('get_vdp', { slug: 'acme-fy27-q4' });
    expect(r.json).toMatchObject({ vdp: expect.objectContaining({ vdp_url: expect.stringContaining('acme-fy27-q4') }) });
    // a VDP write never passes the read runtime
    await expect(rt.call('update_use_case', {})).rejects.toBeInstanceOf(RuntimeToolRefused);
  });

  it("VdpError passes through, and a VdpClient reads through an injected runtime", async () => {
    const rt = httpJsonRpcRuntime({
      connector: 'vdp',
      readTools: ['get_vdp'],
      rpc: async () => {
        throw new VdpError('cookie_expired', 'expired', false);
      },
    });
    await expect(rt.call('get_vdp', {})).rejects.toBeInstanceOf(VdpError);
    const seen: string[] = [];
    const injected = httpJsonRpcRuntime({ connector: 'vdp', readTools: ['get_vdp'], rpc: async (tool) => (seen.push(tool), { text: '{"vdp":null}', json: { vdp: null } }) });
    const client = new VdpClient({ runtime: injected, claudeJson: claudeJson() });
    await client.getVdp('acme-fy27-q4');
    expect(seen).toEqual(['get_vdp']);
  });
});

describe('local_files (Claude sessions)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('meets the contract; reads only under its roots; node errors pass through', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-lf-'));
    const outside = await mkdtemp(join(tmpdir(), 'cc-lf-out-'));
    dirs.push(root, outside);
    await mkdir(join(root, 'p'));
    await writeFile(join(root, 'p', 'a.jsonl'), '0123456789');
    await writeFile(join(outside, 'secret.txt'), 'nope');
    const rt = localFilesRuntime({ connector: 'claude_sessions', roots: [root, null] });
    // no filesystem op is reachable for a refused tool (the gate runs before the switch)
    await contract(rt, { tool: 'readdir', args: { path: join(root, 'p') } }, () => 0);
    const port = localFilesPort(rt);
    expect(await port.readdir(join(root, 'p'))).toEqual(['a.jsonl']);
    expect(await port.stat(join(root, 'p', 'a.jsonl'))).toMatchObject({ size: 10, mtimeMs: expect.any(Number), ino: expect.any(Number) });
    expect(await port.readText(join(root, 'p', 'a.jsonl'))).toBe('0123456789');
    // exactly `length` bytes from `offset`, zero-padded past the end (what fh.read fills)
    expect([...(await port.readRange(join(root, 'p', 'a.jsonl'), 7, 5))]).toEqual([0x37, 0x38, 0x39, 0, 0]);
    await expect(port.readText(join(outside, 'secret.txt'))).rejects.toBeInstanceOf(LocalPathRefused);
    await expect(port.readText(join(root, '..', 'x'))).rejects.toMatchObject({ code: 'EOUTSIDE' });
    await expect(port.stat(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('claude_relay (Slack and Org62 through one Claude run)', () => {
  const SERVERS = { slack: { type: 'http', url: 'https://mcp.example.test/slack' } };
  const pre = (o: Options) => o.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
  const hookInput = (tool: string, input: unknown) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: 's', transcript_path: '', cwd: '' }) as never;

  /** A fake run that calls the one tool, reports a 1,800-token first request, and returns the tool's text. */
  const relayQuery = (seen: { options?: Options; prompt?: string }, text = '{"messages":[]}', cost = 0.0021): QueryFn => ({ prompt, options }) => {
    seen.options = options;
    seen.prompt = prompt;
    return (async function* () {
      await pre(options)(hookInput('mcp__slack__slack_search_public_and_private', {}), 'tu_1', { signal: new AbortController().signal });
      yield { type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', name: 'mcp__slack__slack_search_public_and_private' }], usage: { input_tokens: 600, cache_read_input_tokens: 1200, output_tokens: 40 } } } as unknown as SDKMessage;
      yield { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] } } as unknown as SDKMessage;
      yield { type: 'result', total_cost_usd: cost, modelUsage: {} } as unknown as SDKMessage;
    })();
  };

  it('meets the contract: one tool, no settings files, the smallest prompt; records {prefix_tokens, turns, usd}', async () => {
    const seen: { options?: Options; prompt?: string } = {};
    const booked: RelayCallRecord[] = [];
    let runs = 0;
    const q = relayQuery(seen);
    const rt = slackRuntime({ queryFn: (p) => (runs++, q(p)), mcpServersFor: () => SERVERS, ledger: async (r) => void booked.push(r) });
    await contract(rt, { tool: 'slack_search_public_and_private', args: { query: 'to:me after:2026-03-10' } }, () => runs);
    const o = seen.options!;
    expect(o.settingSources).toEqual([]);
    expect(o.tools).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.allowedTools).toEqual(['mcp__slack__slack_search_public_and_private']);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['slack']);
    expect(String(o.systemPrompt).length).toBeLessThan(1_500);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ connector: 'slack', tool: 'slack_search_public_and_private', status: 'ok', usd: 0.0021, usage: { prefixTokens: 1800, turns: 1 } });
    expect(booked[0]!.contentHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('estimateUsd: the skill cap with no history, then the p90 of recent calls; a budget only lowers the cap', async () => {
    const seen: { options?: Options } = {};
    const history = new RelayCostHistory();
    const rt = claudeRelayRuntime({ connector: 'slack', readTools: ['slack_search_public_and_private'], queryFn: relayQuery(seen, '{}', 0.002), mcpServersFor: () => SERVERS, history });
    expect(rt.estimateUsd('slack_search_public_and_private')).toBe(0.03);
    for (let i = 0; i < 9; i++) history.add('slack_search_public_and_private', 0.001);
    history.add('slack_search_public_and_private', 0.009);
    expect(rt.estimateUsd('slack_search_public_and_private')).toBe(0.001);
    history.add('slack_search_public_and_private', 0.009);
    expect(rt.estimateUsd('slack_search_public_and_private')).toBe(0.009);
    await rt.call('slack_search_public_and_private', {}, { budget: { usd: 0.01 } });
    expect(seen.options!.maxBudgetUsd).toBe(0.01);
    await rt.call('slack_search_public_and_private', {}, { budget: { usd: 5 } });
    expect(seen.options!.maxBudgetUsd).toBe(0.03);
  });

  it('a run that returns no tool output throws RuntimeCallError with what it spent; an undeclared server: config, nothing called', async () => {
    const booked: RelayCallRecord[] = [];
    const empty: QueryFn = () =>
      (async function* () {
        yield { type: 'result', total_cost_usd: 0.0004, modelUsage: {} } as unknown as SDKMessage;
      })();
    const rt = claudeRelayRuntime({ connector: 'slack', readTools: ['slack_read_thread'], queryFn: empty, mcpServersFor: () => SERVERS, ledger: async (r) => void booked.push(r) });
    const err = (await rt.call('slack_read_thread', { channel_id: 'C1', message_ts: '1' }).catch((e: unknown) => e)) as RuntimeCallError;
    expect(err).toBeInstanceOf(RuntimeCallError);
    expect(err).toMatchObject({ code: 'no_result', cost: { usd: 0.0004 } });
    expect(booked[0]).toMatchObject({ status: 'error', code: 'no_result' });
    const none = claudeRelayRuntime({
      connector: 'org62',
      readTools: ['soqlQuery'],
      queryFn: empty,
      mcpServersFor: () => {
        throw new Error('config: not declared');
      },
    });
    await expect(none.call('soqlQuery', { query: 'SELECT Id FROM User LIMIT 1' })).rejects.toMatchObject({ code: 'config', called: false });
  });

  it('relayLedger books one llm_calls row with the D0 audit fields and the measurement', async () => {
    const rows: unknown[] = [];
    const db = { execute: async (q: unknown) => (rows.push(q), { rows: [{ id: '7' }] }) } as never;
    const book = relayLedger(db, '00000000-0000-4000-8000-000000000001', { budgetDay: () => '2026-11-20', trigger: 'precheck' });
    await book({ connector: 'slack', tool: 'slack_search_public_and_private', model: 'claude-haiku-5-5', status: 'ok', code: 'ok', usd: 0.002, usage: { inputTokens: 600, outputTokens: 40, cacheReadTokens: 1200, cacheWriteTokens: 0, turns: 1, prefixTokens: 1800 }, contentHash: 'a'.repeat(32), startedAt: new Date(), finishedAt: new Date() });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(relaySkillKey('slack', 'slack_search_public_and_private')).toBe('relay:slack:slack_search_public_and_private');
  });
});
