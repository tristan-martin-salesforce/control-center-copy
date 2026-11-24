/**
 * BE-READIN unit tests (no database): state derivation, output mapping and redaction, the research agent's
 * guards with a scripted SDK (allowlist abort, cost cap, cancel), the tools, the allowlists and the skills.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { ReadIn, ReadInEntity } from '../../src/contract';
import { GOOGLE_READ_TOOLS } from '../../src/connectors/google/client';
import { loadSkill } from '../../src/engines/nba/prompt/skills';
import { READIN_ORG62_TOOLS, READIN_SLACK_TOOLS } from '../../src/jobs/handlers/readin';
import { assertReadOnly, ORG62_SCAN_TOOLS, SLACK_SCAN_TOOLS } from '../../src/llm/mcp-config';
import { SdkResearchAgent } from '../../src/llm/readin/agent';
import { parseSlackPermalink } from '../../src/llm/readin/context';
import { docFromReplyText, toReadIn } from '../../src/llm/readin/map';
import { buildReadInPrompt, stepForTool } from '../../src/llm/readin/prompt';
import { deriveReadIn, emptyReadIn, type ReadInJobSnap, type StoredReadIn } from '../../src/llm/readin/state';
import { createReadInTools, createToolState, READIN_ALLOWED_TOOLS, READIN_GOOGLE_TOOLS } from '../../src/llm/readin/tools';
import { ReadInOutput, type ReadInContext } from '../../src/llm/readin/types';

import { fakeQuery, finishInput, SLACK_THREAD_RESULT, T } from './fake-sdk';

const E: ReadInEntity = { type: 'work_item', id: 'w_dana' };
const at = (m: number) => new Date(Date.UTC(2026, 10, 5, 15, m)).toISOString();

function ready(gen = 1, generatedAt = at(10)): StoredReadIn {
  return { v: 1, outcome: 'ready', jobId: 10, readIn: { ...emptyReadIn(E, generatedAt), state: 'ready', tldr: 'Dana asks', generation: gen, generatedAt } };
}
function job(over: Partial<ReadInJobSnap>): ReadInJobSnap {
  return { id: 11, status: 'queued', generation: 1, trigger: 'on_demand', progress: null, cancelRequested: false, skipped: null, lastErrorCode: null, updatedAt: at(20), ...over };
}

const ctx = (): ReadInContext => ({
  entity: E,
  skill: 'readin-ask',
  generation: 3,
  trigger: 'direct_ask',
  now: at(30),
  timezone: 'America/Denver',
  me: { name: 'Alex Example' },
  item: { id: 'w_dana', title: 'Answer Dana', purpose: null, kind: 'ask', state: 'open', due: null, createdAt: at(0), rank: 2, why: 'Dana asked', counterparty: { name: 'Dana Lee', external: true }, people: [] },
  evidence: [{ id: 'ev1', role: 'origin', at: at(1), source: { kind: 'slack', label: '#acme-ext', url: 'https://example.slack.com/archives/C0ACME0001/p1793893334322509' }, author: 'Dana Lee', fromMe: false, text: 'Can we also cover pricing?' }],
  siblings: [{ id: 'w_sib', title: 'Smoke-test the demo org', kind: 'task', state: 'open', due: null }],
  related: [],
  saidBefore: [],
  reply: { kind: 'slack', target: 'thread', channelId: 'C0ACME0001', channelName: '#acme-ext', threadTs: '1793893334.322509' },
  voice: null,
  initiative: null,
  account: null,
  opp: null,
});

describe('state transitions (deriveReadIn)', () => {
  it('none → queued → researching → ready → stale → queued (refresh keeps content) → failed', () => {
    expect(deriveReadIn(E, null, null, null)).toBeNull();
    const q = deriveReadIn(E, null, job({ status: 'queued' }), null)!;
    expect(q.state).toBe('queued');
    expect(q.progress?.step).toBe('queued');
    const r = deriveReadIn(E, null, job({ status: 'running', progress: { step: 'slack', label: 'Reading the Slack thread', done: 1, total: 6 } }), null)!;
    expect(r.state).toBe('researching');
    expect(r.progress?.label).toBe('Reading the Slack thread');
    const s = ready(1);
    expect(deriveReadIn(E, s, job({ id: 10, status: 'succeeded' }), { generation: 1, lastNewInfoAt: at(5) })!.state).toBe('ready');
    const stale = deriveReadIn(E, s, null, { generation: 2, lastNewInfoAt: at(15), newSince: 2 })!;
    expect(stale.state).toBe('stale');
    expect(stale.staleReason).toMatch(/^2 new updates since/);
    const refresh = deriveReadIn(E, s, job({ id: 12, status: 'running' }), { generation: 2, lastNewInfoAt: at(15) })!;
    expect(refresh.state).toBe('researching');
    expect(refresh.tldr).toBe('Dana asks');
    expect(deriveReadIn(E, null, job({ status: 'dead', lastErrorCode: 'disallowed_tool' }), null)).toMatchObject({ state: 'failed', error: { code: 'disallowed_tool', retryable: false } });
  });

  it('a budget skip keeps older content with an error, or fails when there is none', () => {
    expect(deriveReadIn(E, ready(1), job({ id: 12, status: 'succeeded', skipped: 'budget' }), { generation: 1, lastNewInfoAt: null })).toMatchObject({ state: 'ready', error: { code: 'budget' } });
    expect(deriveReadIn(E, null, job({ status: 'succeeded', skipped: 'budget' }), null)).toMatchObject({ state: 'failed', error: { code: 'budget' } });
  });

  it('a superseded running job reads as queued (its successor is next)', () => {
    expect(deriveReadIn(E, null, job({ status: 'running', cancelRequested: true }), null)!.state).toBe('queued');
  });
});

describe('output mapping', () => {
  it('drops links the agent was never shown, redacts credential-like text, resolves ledger refs', () => {
    const out = ReadInOutput.parse(finishInput({ background: [...(finishInput().background as unknown[]), { text: 'Smoke test still open.', workItemId: 'w_sib', source: 'ledger' }] }));
    const seen = new Set(['https://example.slack.com/archives/C0ACME0001/p1793893334322509']);
    const r = toReadIn(out, ctx(), { trigger: 'direct_ask', generatedAt: at(31), costUsd: 0.123456, model: 'claude-sonnet-5-5', skillVersion: 'readin-ask@1', seenUrls: seen, suggestedReply: null });
    expect(r.background[0]!.source?.url).toBe('https://example.slack.com/archives/C0ACME0001/p1793893334322509');
    expect(r.background[1]!.source?.url).toBeUndefined();
    expect(r.background[2]!.text).not.toContain('abcd1234efgh5678ijkl');
    expect(r.background[2]!.text).toContain('[REDACTED]');
    expect(r.background[3]!.ref).toMatchObject({ type: 'work_item', id: 'w_sib', label: 'Smoke-test the demo org' });
    expect(r.background[3]!.source?.kind).toBe('manual');
    expect(r.generation).toBe(3);
    expect(r.costUsd).toBe(0.1235);
    expect(r.state).toBe('ready');
  });

  it('turns the reply text into a TipTap doc (paragraphs and bullet lines)', () => {
    const d = docFromReplyText('Yes, happy to.\n\n- the profile\n- the handoff\n\nThanks!');
    expect(d.content.map((n) => n.type)).toEqual(['paragraph', 'bulletList', 'paragraph']);
  });

  it('parses Slack permalinks into channel + thread', () => {
    expect(parseSlackPermalink('https://example.slack.com/archives/C0ACME0001/p1793893334322509?thread_ts=1793890000.000100&cid=C0ACME0001')).toEqual({ channelId: 'C0ACME0001', ts: '1793893334.322509', threadTs: '1793890000.000100' });
  });
});

describe('allowlists (read tools only, never widened)', () => {
  it('Slack, Org62 and Google read-in tools are subsets of the existing read allowlists', () => {
    for (const t of READIN_SLACK_TOOLS) expect(SLACK_SCAN_TOOLS as readonly string[]).toContain(t);
    for (const t of READIN_ORG62_TOOLS) expect(ORG62_SCAN_TOOLS as readonly string[]).toContain(t);
    for (const t of READIN_GOOGLE_TOOLS) expect(GOOGLE_READ_TOOLS.has(t)).toBe(true);
    expect(() => assertReadOnly([...READIN_ALLOWED_TOOLS, T.slackRead, T.slackSearch, T.soql])).not.toThrow();
    expect(() => assertReadOnly([T.slackSend])).toThrow(/write-like/);
  });
});

function agentInput(over: Partial<Parameters<SdkResearchAgent['run']>[0]> = {}) {
  const state = createToolState(['https://example.slack.com/archives/C0ACME0001/p1793893334322509']);
  const google = { call: async (tool: string) => `Found 1 messages\nMessage ID: m1\nWeb Link: https://mail.google.com/mail/u/0/#all/m1\n(tool ${tool}) password: hunter2hunter2`, health: async () => ({ state: 'ok' as const, checkedAt: at(0) }) };
  const handlers = createReadInTools({ google, ledger: { search: async () => [{ kind: 'message', at: at(2), label: 'slack', text: 'pricing stays with Sam', fromMe: true }] } }, state);
  return { runId: 'r1', model: 'claude-sonnet-5-5', systemPrompt: ['s'], prompt: 'p', mcpServers: {}, externalTools: [T.slackRead, T.slackSearch, T.soql], handlers, state, maxTurns: 10, costCapUsd: 0.3, signal: new AbortController().signal, ...over };
}

describe('research agent guards (scripted SDK)', () => {
  it('runs the skill steps, reports progress per tool and returns the validated output', async () => {
    const seen: string[] = [];
    const agent = new SdkResearchAgent({ queryFn: fakeQuery({ steps: [{ tool: T.ledger, input: { text: 'Dana Lee pricing' } }, { tool: T.slackRead, input: { channel_id: 'C0ACME0001' }, result: SLACK_THREAD_RESULT }, { tool: T.gmailSearch, input: { query: 'from:dana@example.com newer_than:30d' } }, { tool: T.finish, input: finishInput() }] }) });
    const input = agentInput({ onTool: (n) => seen.push(stepForTool(n)?.step ?? '?') });
    const res = await agent.run(input);
    expect(res.ok).toBe(true);
    expect(res.output?.tldr).toMatch(/pricing/);
    expect(seen).toEqual(['ledger', 'slack', 'gmail', 'writing']);
    expect(res.toolCalls).toHaveLength(4);
    expect(res.costUsd).toBeGreaterThan(0);
    // Gmail results were redacted before the model saw them, and their links are now citable.
    expect(input.state.seenUrls.has('https://mail.google.com/mail/u/0/#all/m1')).toBe(true);
  });

  it('READIN-1: the canUseTool gate decides every call (no bare allowedTools, no dontAsk)', async () => {
    let opts: Options | undefined;
    const capture = ((a: { options: Options }) => {
      opts = a.options;
      return fakeQuery({ steps: [{ tool: T.finish, input: finishInput() }] })(a as never);
    }) as never;
    await new SdkResearchAgent({ queryFn: capture }).run(agentInput());
    expect(opts!.allowedTools).toBeUndefined();
    expect(opts!.permissionMode).toBe('default');
    const gate = (t: string) => opts!.canUseTool!(t, {}, { signal: new AbortController().signal, toolUseID: 'tu_gate' } as never);
    expect(await gate(T.slackRead)).toMatchObject({ behavior: 'allow' });
    expect(await gate(T.slackSend)).toMatchObject({ behavior: 'deny' });
    expect(opts!.disallowedTools).toEqual(expect.arrayContaining([T.slackSend]));
  });

  it('a call to a non-allowlisted tool aborts the whole run', async () => {
    const agent = new SdkResearchAgent({ queryFn: fakeQuery({ steps: [{ tool: T.ledger, input: { text: 'Dana' } }, { tool: T.slackSend, input: { channel_id: 'C0ACME0001', message: 'hi' } }, { tool: T.finish, input: finishInput() }] }) });
    const input = agentInput();
    const res = await agent.run(input);
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: 'disallowed_tool', disallowedTool: T.slackSend });
    expect(input.state.output).toBeNull(); // never reached readin_finish
  });

  it('stops at the per-read-in cost cap', async () => {
    const agent = new SdkResearchAgent({ queryFn: fakeQuery({ usage: { input_tokens: 30_000, output_tokens: 3_000 }, steps: [{ tool: T.ledger, input: { text: 'Dana' } }, { tool: T.finish, input: finishInput() }] }) });
    const res = await agent.run(agentInput({ costCapUsd: 0.05 }));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('cost_cap');
  });

  it('a cancel (superseded) aborts the run', async () => {
    const ac = new AbortController();
    const agent = new SdkResearchAgent({ queryFn: fakeQuery({ blockAfter: 1, onBlocked: () => ac.abort(), steps: [{ tool: T.ledger, input: { text: 'Dana' } }, { tool: T.finish, input: finishInput() }] }) });
    const res = await agent.run(agentInput({ signal: ac.signal }));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('cancelled');
  });

  it('an invalid readin_finish is rejected so the agent can fix it', async () => {
    const state = createToolState();
    const h = createReadInTools({}, state);
    const bad = await h.readin_finish({ tldr: 'x' });
    expect(bad.isError).toBe(true);
    expect(state.output).toBeNull();
    expect((await h.readin_gmail_search({ query: 'from:dana@example.com' })).text).toMatch(/not available/);
  });
});

describe('skills and prompt', () => {
  it('readin skills parse, carry a version and name every tool they use', () => {
    for (const name of ['readin-ask', 'readin-meeting']) {
      const s = loadSkill(name);
      expect(s.version).toMatch(/^\d+/);
      for (const t of ['readin_ledger_search', 'slack_read_thread', 'readin_gmail_search', 'readin_drive_search', 'soqlQuery', 'readin_finish']) expect(s.body).toContain(t);
      expect(s.body).not.toMatch(/web ?search tool|WebSearch|WebFetch/);
    }
  });

  it('the system prompt has the static skill + draft style first, then the context pack', () => {
    const p = buildReadInPrompt(ctx(), { runId: 'r1', maxTurns: 14, costCapUsd: 0.35, externalTools: [T.slackRead] });
    expect(p.systemPrompt[0]).toContain('Read-in: someone asked me something');
    expect(p.systemPrompt[0]).toContain('Draft style: Slack');
    expect(p.systemPrompt[2]).toContain('"id":"w_dana"');
    expect(p.prompt).toContain(T.slackRead);
    expect(p.skillVersion).toBe('readin-ask@2');
  });

  it('skills, fixtures and tests carry placeholders only (optional private denylist outside the repo)', () => {
    const files = ['skills/readin-ask.md', 'skills/readin-meeting.md', 'tests/readin/fake-sdk.ts', 'tests/readin/unit.test.ts', 'tests/readin/mock.test.ts', 'tests/db/readin/db.test.ts'];
    const org62Id = /\b(00[0-9][A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)\b/g;
    const email = /\b[\w.+-]+@([\w-]+\.[\w.]+)\b/g;
    const host = /https?:\/\/([a-z0-9.-]+)/gi;
    const denyFile = process.env.CC_PRIVATE_DENYLIST ?? path.join(process.env.HOME ?? '', 'Library/Application Support/command-center/fixtures/denylist.txt');
    const deny = fs.existsSync(denyFile) ? fs.readFileSync(denyFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : [];
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(org62Id)) expect(m[1]!.slice(3, 5), `${f}: ${m[1]}`).toBe('XX');
      for (const m of text.matchAll(email)) expect(/(^|\.)example(\.(com|invalid|org))?$/.test(m[1]!), `${f}: ${m[1]}`).toBe(true);
      for (const m of text.matchAll(host)) expect(/(^|\.)(example\.(com|invalid)|example\.slack\.com|mail\.google\.com|docs\.google\.com)$/.test(m[1]!), `${f}: ${m[1]}`).toBe(true);
      for (const d of deny) expect(text.toLowerCase().includes(d.toLowerCase()), `${f} contains a denylisted term`).toBe(false);
    }
  });
});

export type { ReadIn };
