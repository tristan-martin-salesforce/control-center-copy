/**
 * BE-CHAT on the mock DataSource: the real chat runner (Agent SDK options, guards, budget, streaming)
 * over the deterministic fake model, with the real chat tools on the in-process MCP server.
 *
 * Covers: proposal → apply (one audit entry, actor chat) → receipt → undo; rescan enqueues a job and its
 * `slack.scan` row reports tool-progress until done; a draft card, Add to Outbox (POST /drafts/:id/queue)
 * and Undo (never sent); a session card with no URL opening; cancel (Stop and a newer message); the
 * per-message and daily budget caps; the tool allowlist; redaction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const trap =
    (name: string) =>
    (...args: unknown[]) => {
      spawned.n += 1;
      throw new Error(`child_process.${name} called in a chat test: ${String(args[0])}`);
    };
  return { ...real, default: { ...real, spawn: trap('spawn'), exec: trap('exec'), execFile: trap('execFile') }, spawn: trap('spawn'), exec: trap('exec'), execFile: trap('execFile') };
});

import { ChatThreadDetail, type ChatPart, type Receipt } from '@/contract';
import { createFakeChatQuery } from '@/llm/chat/fake';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentSdkChatRunner, STEP_LIMIT_CODE, stoppedAtStepLimit, type ChatQueryFn } from '@/llm/chat/runner';
import { CHAT_ALLOWED_TOOLS } from '@/llm/chat/tools';
import { MockDataSource } from '@/server/datasource/mock';
import { until } from '../support/until';
import { cards, collect, fast, mockWith, of, seed, textOf, type Seen } from './helpers';

type G = { __ccDataSource?: unknown };
let ds: MockDataSource;
const envBefore = { ...process.env };

function useDs(d: MockDataSource) {
  ds?.dispose();
  ds = d;
  (globalThis as G).__ccDataSource = ds;
}

beforeEach(() => {
  spawned.n = 0;
  useDs(mockWith());
});
afterEach(() => {
  delete (globalThis as G).__ccDataSource;
  ds.dispose();
  process.env = { ...envBefore };
});

const ask = (text: string, extra: { threadId?: string; signal?: AbortSignal; model?: 'sonnet' | 'opus' } = {}) =>
  collect(ds.chat({ body: { text, context: [], ...(extra.threadId ? { threadId: extra.threadId } : {}), ...(extra.model ? { model: extra.model } : {}) }, signal: extra.signal ?? new AbortController().signal } as never));

async function lastAssistant(threadId?: string) {
  const id = threadId ?? (await ds.listChatThreads({} as never)).threads.find((t) => t.isDefault)!.id;
  const d = await ds.getChatThread({ params: { id } } as never);
  expect(ChatThreadDetail.safeParse(d).success).toBe(true);
  return d.messages.filter((m) => m.role === 'assistant').at(-1)!;
}

describe('BE-CHAT runner (mock DataSource, fake model)', { timeout: 300_000 }, () => {
  it('passes the restricted Agent SDK options: chat tools only, no built-ins, dontAsk, clean env, skill + pack in the system prompt', async () => {
    const seen: Seen = { calls: 0 };
    useDs(mockWith({ seen }));
    process.env.CLAUDE_CODE_FAKE_PARENT = 'leak';
    const evs = await ask('What are my top 3 today and why?');
    expect(of(evs, 'done')).toHaveLength(1);
    const o = seen.options!;
    expect(o.model).toBe('claude-sonnet-5-5');
    expect(o.tools).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe('dontAsk');
    // Assistant v2 (H-6): one SDK session per thread, started with its own id and resumed on the next message
    expect(o.persistSession).toBe(true);
    expect(o.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(o.resume).toBeUndefined();
    expect(o.includePartialMessages).toBe(true);
    expect(o.skills).toEqual([]);
    expect(Object.keys(o.mcpServers!)).toEqual(['chat']);
    expect([...(o.allowedTools ?? [])].sort()).toEqual([...CHAT_ALLOWED_TOOLS].sort());
    expect((o.allowedTools ?? []).every((t) => t.startsWith('mcp__chat__'))).toBe(true);
    expect(o.maxTurns).toBe(200); // a runaway guard only (lane 05 §3a): cost bounds a turn
    // H-5: the message holds its $0.25 budget (and asks past it); the SDK's budget is the day line, the runaway guard
    expect(o.maxBudgetUsd).toBeCloseTo(3);
    expect(Object.keys(o.env!).some((k) => k.startsWith('CLAUDE_CODE_'))).toBe(false);
    const sp = o.systemPrompt as string[];
    expect(sp[0]).toContain('Command Center assistant');
    expect(sp[1]).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    // v2: nothing per turn before the boundary; the header (now, looking at, the compact pack) rides in the message
    expect(sp[2]).not.toContain('## Now');
    expect(seen.prompt).toMatch(/## Now\n2026-\d\d-\d\dT\d\d:\d\d:\d\d-0[67]:00 \(America\/Denver\)/);
    expect(seen.prompt).toContain('"top3"');
    expect(seen.prompt).toContain('## Message\nWhat are my top 3 today and why?');
    // the answer streamed as text, with a tool row
    expect(of(evs, 'tool-start').map((t) => t.name)).toEqual(['today.read']);
    expect(textOf(evs)).toMatch(/^Your top \d today:/);
    const msg = await lastAssistant();
    expect(msg).toMatchObject({ status: 'complete', model: 'sonnet', route: { intent: 'explain', tier: 'balanced', model: 'sonnet' } });
    expect(msg.usage).toMatchObject({ model: 'claude-sonnet-5-5', tier: 'balanced', steps: 1, resumed: false });
    const firstSession = seen.options!.sessionId;
    expect(msg.parts.find((p) => p.type === 'tool')).toMatchObject({ name: 'today.read', ok: true });
    // opus when the message asks for it; the thread's session resumes (no re-sent history)
    await ask('top 3 again', { model: 'opus' });
    expect(seen.options!.model).toBe('claude-opus-5-5');
    expect(seen.options!.resume).toBe(firstSession);
    expect(seen.prompt).not.toContain('## Thread so far');
    expect((await lastAssistant()).usage).toMatchObject({ resumed: true });
  });

  it('act: "snooze X" runs at once (one audit entry, actor chat) with a receipt that undoes it', async () => {
    const before = (await ds.getItem({ params: { id: 'w_vdp_globex' } })).item;
    const auditBefore = ds.audit.entries.length;
    const evs = await ask('snooze the Globex VDP update until 14:00');
    expect(of(evs, 'start')[0]!.route).toMatchObject({ intent: 'act', tier: 'fast', model: 'haiku' });
    const receipts = of(evs, 'receipt');
    expect(receipts).toHaveLength(1);
    expect(textOf(evs)).toMatch(/Snoozed \*\*Update the VDP for the Globex expansion\*\* until 14:00\. Undo is on the receipt/);
    const after = (await ds.getItem({ params: { id: 'w_vdp_globex' } })).item;
    expect(after.state).toBe('snoozed');
    expect(ds.audit.entries.slice(auditBefore).filter((e) => e.action === 'chat.apply')).toHaveLength(1);
    expect(ds.audit.entries.slice(auditBefore).find((e) => e.action === 'chat.apply')).toMatchObject({ actor: 'chat', undoable: true });
    await ds.undoAudit({ params: { id: receipts[0]!.receipt.changes[0]!.auditId }, body: {} } as never);
    expect((await ds.getItem({ params: { id: 'w_vdp_globex' } })).item.state).toBe(before.state);
  });

  it('proposal → Apply (one audit entry, actor chat) → receipt part → Undo; nothing changes before Apply', async () => {
    const before = (await ds.getItem({ params: { id: 'w_vdp_globex' } })).item;
    const evs = await ask('propose: snooze the Globex VDP update until 14:00');
    const props = of(evs, 'proposal');
    expect(props).toHaveLength(1);
    const p = props[0]!.proposal;
    expect(p).toMatchObject({ status: 'pending', actor: 'chat', entity: { type: 'work_item', id: 'w_vdp_globex' } });
    expect(p.changes.map((c) => c.field)).toEqual(['state', 'snoozedUntil']);
    const until = p.changes[1]!.after as string;
    expect(until).toMatch(/T14:00:00-0[67]:00$/);
    expect(props[0]!.summary).toMatch(/^Snooze "Update the VDP for the Globex expansion" until 14:00\?$/);
    expect(textOf(evs)).toMatch(/Nothing changes until you do/);
    // staged only
    expect((await ds.getItem({ params: { id: 'w_vdp_globex' } })).item.state).toBe(before.state);
    let msg = await lastAssistant();
    const part = msg.parts.find((x): x is Extract<ChatPart, { type: 'proposal' }> => x.type === 'proposal')!;
    expect(part).toMatchObject({ status: 'pending', changes: [{ op: 'snooze', itemId: 'w_vdp_globex', until }] });
    // nor is it an item-card proposal
    expect((await ds.getItem({ params: { id: 'w_vdp_globex' } })).proposals.some((x) => x.id === p.id)).toBe(false);

    const auditBefore = ds.audit.entries.length;
    const applied = await ds.applyProposal({ params: { id: p.id }, body: {} } as never);
    expect(ds.audit.entries.length).toBe(auditBefore + 1);
    const entry = ds.audit.entries.at(-1)!;
    expect(entry).toMatchObject({ id: applied.auditId, actor: 'chat', action: 'chat.apply', undoable: true });
    expect(applied.entity.status).toBe('applied');
    const receipt = applied.receipt as Receipt;
    expect(receipt.changes.map((c) => c.field).sort()).toEqual(['snoozedUntil', 'state']);
    expect(receipt.changes.every((c) => c.auditId === applied.auditId)).toBe(true);
    const after = (await ds.getItem({ params: { id: 'w_vdp_globex' } })).item;
    expect(after).toMatchObject({ state: 'snoozed', snoozedUntil: until, snoozedFrom: before.state });
    expect(after.userLockedFields).toEqual(before.userLockedFields); // chat adds no locks
    await expect(ds.applyProposal({ params: { id: p.id }, body: {} } as never)).rejects.toMatchObject({ code: 'validation' });

    // reload: the card reads applied and the receipt sits right after it
    msg = await lastAssistant();
    const i = msg.parts.findIndex((x) => x.type === 'proposal');
    expect(msg.parts[i]).toMatchObject({ status: 'applied' });
    expect(msg.parts[i + 1]).toMatchObject({ type: 'receipt', receipt: { id: receipt.id, actor: 'chat' } });

    // Undo the whole change set
    const u = await ds.undoAudit({ params: { id: applied.auditId! }, body: {} } as never);
    expect(u.auditId).toBeTruthy();
    expect((await ds.getItem({ params: { id: 'w_vdp_globex' } })).item).toMatchObject({ state: before.state, snoozedUntil: before.snoozedUntil });
    msg = await lastAssistant();
    const r = msg.parts.find((x): x is Extract<ChatPart, { type: 'receipt' }> => x.type === 'receipt')!;
    expect(r.receipt.changes.every((c) => !!c.undoneAt && !!c.undoAuditId)).toBe(true);
    expect(msg.parts.find((x) => x.type === 'proposal')).toMatchObject({ status: 'applied' }); // redo is the receipt's undo chain
  });

  it('"snooze the VDP re-auth": a connector alert becomes a proposed task, snoozed; Dismiss leaves everything as it was', async () => {
    const evs = await ask('snooze the VDP re-auth until 14:00');
    const p = of(evs, 'proposal')[0]!.proposal;
    expect(p.entity.type).toBe('chat_thread');
    expect(p.changes).toEqual([
      { field: 'title', label: 'New task', before: null, after: 'Re-auth VDP' },
      expect.objectContaining({ field: 'snoozedUntil', label: 'New task · Snoozed until' }),
    ]);
    expect(textOf(evs)).toMatch(/connector alert, not a task/);
    const count = (await ds.listItems({ query: { tab: 'snoozed' } } as never)).items.length;
    const dismissed = await ds.rejectProposal({ params: { id: p.id }, body: {} } as never);
    expect(dismissed).toMatchObject({ entity: { status: 'rejected' }, auditId: null });
    expect((await lastAssistant()).parts.find((x) => x.type === 'proposal')).toMatchObject({ status: 'dismissed' });
    expect((await ds.listItems({ query: { tab: 'snoozed' } } as never)).items.length).toBe(count);

    // apply path: the new item exists snoozed, undo removes it
    const evs2 = await ask('snooze the VDP re-auth until 14:00');
    const p2 = of(evs2, 'proposal')[0]!.proposal;
    const applied = await ds.applyProposal({ params: { id: p2.id }, body: {} } as never);
    const created = applied.receipt!.changes.find((c) => c.label === 'Created')!;
    expect((await ds.getItem({ params: { id: created.entity.id } })).item).toMatchObject({ title: 'Re-auth VDP', state: 'snoozed', why: 'Created from chat', userLockedFields: [] });
    await ds.undoAudit({ params: { id: applied.auditId! }, body: {} } as never);
    await expect(ds.getItem({ params: { id: created.entity.id } })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a stale proposal fails to apply with 409 and changes nothing', async () => {
    const p = of(await ask('propose: snooze the Globex VDP update until 14:00'), 'proposal')[0]!.proposal;
    const cur = (await ds.getItem({ params: { id: 'w_vdp_globex' } })).item;
    await ds.itemAction({ params: { id: 'w_vdp_globex', verb: 'done' }, body: { ifVersion: cur.version } } as never);
    await expect(ds.applyProposal({ params: { id: p.id }, body: {} } as never)).rejects.toMatchObject({ code: 'conflict' });
    expect((await ds.getItem({ params: { id: 'w_vdp_globex' } })).item.state).toBe('done');
  });

  it('rescan enqueues a manual scan job (trigger chat); its slack.scan row reports tool-progress until the run is done', async () => {
    const evs = await ask('rescan slack for the last 48 hours');
    const start = of(evs, 'tool-start').find((t) => t.name === 'slack.scan')!;
    expect(start.summary).toBe('Re-reading slack over the last 48 h (2d)');
    const progress = of(evs, 'tool-progress').filter((e) => e.id === start.id);
    expect(progress[0]).toMatchObject({ done: 0, total: 3 });
    expect(progress.at(-1)).toMatchObject({ done: 3, total: 3 });
    expect(progress.map((p) => p.done)).toEqual([...progress.map((p) => p.done)].sort((a, b) => a - b)); // never goes back
    const result = of(evs, 'tool-result').find((e) => e.id === start.id)!;
    expect(result).toMatchObject({ ok: true, summary: 'Slack scan done: 12 seen · 1 new · 2 changed' });
    expect(evs.findIndex((e) => e === result)).toBeGreaterThan(evs.findIndex((e) => e === progress.at(-1))); // progress, then the result
    const scanId = JSON.parse(result.result!).scanId as string;
    const job = (await ds.getJobs({} as never)).jobs.find((j) => j.id === scanId)!;
    expect(job).toMatchObject({ type: 'scan.slack', status: 'succeeded', dedupeKey: expect.stringContaining(':chat:48h') });
    expect((await ds.getScans({ query: { limit: 20 } } as never)).runs.some((r) => r.scope === 'chat:48h' && r.status === 'ok')).toBe(true);
    const row = (await lastAssistant()).parts.find((p): p is Extract<ChatPart, { type: 'tool' }> => p.type === 'tool' && p.name === 'slack.scan')!;
    expect(row).toMatchObject({ ok: true, progress: { done: 3, total: 3 } });
    expect(of(evs, 'resource')).toHaveLength(0); // the row is the scan; no extra link
  });

  it('a scan still running when the turn ends closes its row as continuing; a thread read refreshes it to done', async () => {
    // scan steps 250 ms apart, the turn follows it for only 20 ms
    const runner = createAgentSdkChatRunner({ queryFn: createFakeChatQuery(), scanPollMs: 5, scanFollowMs: 20 });
    useDs(new MockDataSource({ seed: structuredClone(seed), delays: { enrichMs: 1e8, stepMs: 250, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 }, autoplay: false, clockMode: 'seed', chatRunner: runner }));
    const evs = await ask('rescan gmail for the last 6 hours');
    const start = of(evs, 'tool-start').find((t) => t.name === 'gmail.scan')!;
    const result = of(evs, 'tool-result').find((e) => e.id === start.id)!;
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/continues in the background/);
    // each thread read refreshes the row; read until the scan (two chained 250 ms steps) has finished, never a fixed sleep
    const gmailRow = async () => (await lastAssistant()).parts.find((p): p is Extract<ChatPart, { type: 'tool' }> => p.type === 'tool' && p.name === 'gmail.scan')!;
    const row = await until(async () => {
      const r = await gmailRow();
      return /^Gmail scan done/.test(r.summary ?? '') ? r : null;
    }, { what: 'the gmail scan row refreshed to done' });
    expect(row).toMatchObject({ ok: true, summary: 'Gmail scan done: 12 seen · 1 new · 2 changed', progress: { done: 3, total: 3 } });
  });

  it('a rescan of a connector that needs re-auth says so instead of queueing', async () => {
    const jobs = (await ds.getJobs({} as never)).jobs.length;
    const evs = await ask('rescan vdp for the last 24 hours');
    const row = of(evs, 'tool-result')[0]!;
    expect(row).toMatchObject({ ok: false, summary: expect.stringContaining('needs re-auth') });
    expect(of(evs, 'tool-progress')).toHaveLength(0);
    expect((await ds.getJobs({} as never)).jobs.length).toBe(jobs);
  });

  it('a draft card (drafting, never sent) → Add to Outbox (POST /drafts/:id/queue) → pending approval; Undo takes it back out', async () => {
    const pending = (await ds.getOutbox({} as never)).counts.pending_approval ?? 0;
    const evs = await ask('draft a slack reply to #acme-ext saying the demo moves to Thursday');
    const d = cards(evs, 'draft')[0]!.draft;
    expect(d).toMatchObject({ channel: 'slack', to: '#acme-ext', status: 'drafting', href: `/outbox?draft=${d.draftId}` });
    expect(of(evs, 'resource')[0]!.resource).toMatchObject({ kind: 'draft', id: d.draftId });
    expect(of(evs, 'tool-start')[0]!.name).toBe('slack.draft');
    expect(textOf(evs)).toMatch(/nothing was sent/);
    expect(ds.audit.entries.at(-1)).toMatchObject({ actor: 'chat', action: 'chat.draft' });
    expect((await ds.getOutbox({} as never)).counts.pending_approval ?? 0).toBe(pending); // not in the Outbox yet

    const draft = await ds.getDraft({ params: { id: d.draftId } } as never);
    await expect(ds.queueDraft({ params: { id: d.draftId }, body: { ifVersion: draft.version + 5 } } as never)).rejects.toMatchObject({ code: 'conflict' });
    const q = await ds.queueDraft({ params: { id: d.draftId }, body: { ifVersion: draft.version } } as never);
    expect(q.entity).toMatchObject({ status: 'ready', version: draft.version + 1, attempts: [] });
    expect(q.auditId).toBeTruthy();
    expect(ds.audit.entries.at(-1)).toMatchObject({ id: q.auditId, actor: 'user', action: 'draft.queue', undoable: true });
    const outbox = await ds.getOutbox({} as never);
    expect(outbox.counts.pending_approval ?? 0).toBe(pending + 1);
    expect(outbox.groups.find((g) => g.group === 'pending_approval')!.items.some((i) => i.draft.id === d.draftId)).toBe(true);
    // idempotent on ready
    const again = await ds.queueDraft({ params: { id: d.draftId }, body: { ifVersion: 1 } } as never);
    expect(again).toMatchObject({ entity: { status: 'ready', version: draft.version + 1 }, auditId: null });
    // undo → drafting again
    await ds.undoAudit({ params: { id: q.auditId! }, body: {} } as never);
    expect((await ds.getDraft({ params: { id: d.draftId } } as never)).status).toBe('drafting');
  });

  it('queueDraft refuses any status but drafting / ready with a 409 that carries the current draft', async () => {
    const sent = seed.drafts.find((x) => x.status === 'sent' || x.status === 'verified' || x.status === 'failed');
    expect(sent).toBeTruthy();
    const err = await ds.queueDraft({ params: { id: sent!.id }, body: { ifVersion: sent!.version } } as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'conflict', details: { current: { id: sent!.id, status: sent!.status } } });
  });

  it('a session card carries the claude:// deep link with [cc:<id>]; nothing is opened or spawned', async () => {
    const evs = await ask('start a claude code session in command-center: fix the flaky chat test');
    const s = cards(evs, 'session')[0]!.session;
    expect(s.url.startsWith('claude://code/new?folder=')).toBe(true);
    expect(decodeURIComponent(s.url)).toContain(`fix the flaky chat test\n\n[cc:${s.id}]`);
    expect(s).toMatchObject({ state: 'prepared', repo: 'command-center' });
    // the resource link is the in-app run page, never the deep link itself
    expect(of(evs, 'resource')[0]!.resource).toMatchObject({ kind: 'agent_run', id: s.id, href: `/agents?run=${s.id}` });
    const run = (await ds.getAgents({} as never)).runs.find((r) => r.id === s.id)!;
    expect(run).toMatchObject({ kind: 'claude_session', state: 'queued', deepLink: s.url });
    expect(spawned.n).toBe(0);
  });

  it('Stop cancels the turn: no done, the message persists as stopped, the model is not called further', async () => {
    useDs(mockWith({ fake: { delayMs: 40 } }));
    const ac = new AbortController();
    const evs = await collect(ds.chat({ body: { text: 'snooze the Globex VDP update until 14:00', context: [] }, signal: ac.signal } as never), {
      onEvent: (e) => {
        if (e.type === 'tool-start') ac.abort();
      },
    });
    expect(of(evs, 'done')).toHaveLength(0);
    expect(of(evs, 'proposal')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(ds.be6.plans.size).toBe(0);
    expect((await lastAssistant()).status).toBe('stopped');
  });

  it('a newer message in the same thread cancels the running turn', async () => {
    useDs(mockWith({ fake: { delayMs: 30 } }));
    const threadId = (await ds.listChatThreads({} as never)).threads.find((t) => t.isDefault)!.id;
    // the second message goes in while the first turn is mid-tool (its first tool-start), not after a fixed sleep
    let b: ReturnType<typeof ask> | null = null;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const a = collect(ds.chat({ body: { text: 'snooze the Globex VDP update until 14:00', context: [], threadId }, signal: new AbortController().signal } as never), {
      onEvent: (e) => {
        if (e.type === 'tool-start' && !b) started();
      },
    });
    await Promise.race([running, a]); // a turn that ends with no tool fails the assertions below, it never hangs here
    b = ask('top 3 today', { threadId });
    const [ea, eb] = await Promise.all([a, b]);
    expect(of(ea, 'done')).toHaveLength(0);
    expect(of(eb, 'done')).toHaveLength(1);
    const msgs = (await ds.getChatThread({ params: { id: threadId } } as never)).messages.filter((m) => m.role === 'assistant');
    expect(msgs.slice(-2).map((m) => m.status).sort()).toEqual(['complete', 'stopped']);
  });

  it('with spend asks off, the per-message cost cap aborts the turn with budget_exceeded', async () => {
    process.env.CC_SPEND_ASK_TIMEOUT_MS = '0';
    process.env.CC_CHAT_MESSAGE_USD = '0.01';
    useDs(mockWith({ fake: { usage: { input_tokens: 20_000, output_tokens: 2_000 } } }));
    const evs = await ask('snooze the Globex VDP update until 14:00', { model: 'sonnet' });
    const err = of(evs, 'error')[0]!.error;
    expect(err).toMatchObject({ code: 'budget_exceeded', retryable: false });
    expect(err.message).toMatch(/cost limit/);
    expect(of(evs, 'proposal')).toHaveLength(0); // stopped before the second model call
    expect(of(evs, 'receipt')).toHaveLength(0);
    expect((await lastAssistant()).status).toBe('error');
  });

  it('the step guard (caps audit F-1): the stop names Steps per message and where it lives, and asks to continue', async () => {
    process.env.CC_CHAT_MAX_TURNS = '7';
    // a model that runs out of steps: the SDK ends the run with error_max_turns
    const outOfSteps: ChatQueryFn = () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'fake-steps', mcp_servers: [], tools: [] } as unknown as SDKMessage;
        yield { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 7, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, modelUsage: {}, permission_denials: [], errors: [] } as unknown as SDKMessage;
      })();
    useDs(new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed', chatRunner: createAgentSdkChatRunner({ scanPollMs: 5, scanFollowMs: 400, queryFn: outOfSteps }) }));
    const err = of(await ask('dig through everything'), 'error')[0]!.error;
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('Stopped after 7 steps');
    expect(err.message).toContain('Steps per message');
    expect(err.message).toContain('Settings ▸ Budgets ▸ Assistant limits');
    expect(err.message).toMatch(/continue/);
  });

  it('P31-1: the step-stop carries RATE.CHAT.STEP_LIMIT, and "continue" picks the stopped answer up on its model', async () => {
    process.env.CC_CHAT_MAX_TURNS = '7';
    // no CC_CHAT_LLM: the mock sends a "continue" after a step-stop to the runner on its own (P31 follow-up 2)
    const calls: Array<{ prompt: string; model: string | undefined }> = [];
    const q: ChatQueryFn = ({ prompt, options }) =>
      (async function* () {
        calls.push({ prompt, model: options.model });
        yield { type: 'system', subtype: 'init', session_id: `fake-steps-${calls.length}`, mcp_servers: [], tools: [] } as unknown as SDKMessage;
        if (calls.length === 1) yield { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 7, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, modelUsage: {}, permission_denials: [], errors: [] } as unknown as SDKMessage;
        else yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, modelUsage: {}, permission_denials: [] } as unknown as SDKMessage;
      })();
    useDs(new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed', chatRunner: createAgentSdkChatRunner({ scanPollMs: 5, scanFollowMs: 400, queryFn: q }) }));
    const err = of(await ask('dig through everything we did with Globex'), 'error')[0]!.error;
    expect(err).toMatchObject({ code: 'internal', retryable: true, details: { catalogCode: STEP_LIMIT_CODE } });
    const stopped = await lastAssistant();
    expect(stopped.route!.model).toBe('opus');
    expect(stoppedAtStepLimit(stopped)).toBe(true);
    const evs = await ask('continue');
    expect(of(evs, 'done')).toHaveLength(1);
    expect(calls).toHaveLength(2);
    // the same model as the stopped turn, and the stopped answer rides as the continuation
    expect(calls[1]!.model).toBe(calls[0]!.model);
    expect((await lastAssistant()).route).toMatchObject({ model: 'opus', why: expect.stringMatching(/follow-up to research/) });
    expect(calls[1]!.prompt).toMatch(/## Continue your stopped answer\nYour previous answer stopped at your Steps per message limit/);
    expect(calls[1]!.prompt).not.toMatch(/stopped at its cost limit/);
  });

  it('P31-1, mock mode: the fake model answers a "continue" after a step-stop like any follow-up; with no stop it stays the scripted demo', async () => {
    process.env.CC_CHAT_MAX_TURNS = '7';
    delete process.env.CC_CHAT_LLM;
    const fake = createFakeChatQuery();
    const prompts: string[] = [];
    // the first turn runs out of steps; every later one is the deterministic fake the mock app uses
    const q: ChatQueryFn = (args) => {
      prompts.push(args.prompt);
      if (prompts.length > 1) return fake(args);
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'fake-steps', mcp_servers: [], tools: [] } as unknown as SDKMessage;
        yield { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 7, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, modelUsage: {}, permission_denials: [], errors: [] } as unknown as SDKMessage;
      })();
    };
    useDs(new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed', chatRunner: createAgentSdkChatRunner({ scanPollMs: 5, scanFollowMs: 400, queryFn: q }) }));
    // before any stop, "continue" is not the runner's (the scripted demos answer it)
    await ask('continue');
    expect(prompts).toHaveLength(0);
    expect(of(await ask('dig through everything we did with Globex'), 'error')[0]!.error.details).toMatchObject({ catalogCode: STEP_LIMIT_CODE });
    expect(prompts).toHaveLength(1);
    expect(stoppedAtStepLimit(await lastAssistant())).toBe(true);
    const evs = await ask('continue');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/## Continue your stopped answer\nYour previous answer stopped at your Steps per message limit/);
    expect(of(evs, 'error')).toHaveLength(0);
    expect(of(evs, 'done')).toHaveLength(1);
    expect(of(evs, 'tool-start').length).toBeGreaterThan(0); // the fake's follow-up reads the app
    const answer = await lastAssistant();
    expect(answer.status).not.toBe('error');
    expect(answer.route).toMatchObject({ model: 'opus', why: expect.stringMatching(/follow-up to research/) });
  });

  it("the chat's daily line blocks the turn before any model call", async () => {
    process.env.CC_CHAT_DAILY_USD = '0';
    const seen: Seen = { calls: 0 };
    useDs(mockWith({ seen }));
    const evs = await ask('top 3 today');
    expect(of(evs, 'error')[0]!.error).toMatchObject({ code: 'budget_exceeded' });
    expect(seen.calls).toBe(0);
    expect(of(evs, 'tool-start')).toHaveLength(0);
  });

  it('spend is recorded under its own line (chat) in the Health projection', async () => {
    useDs(mockWith({ fake: { usage: { input_tokens: 1000, output_tokens: 100 } } }));
    const before = (await ds.getHealth({} as never)).spend;
    await ask('top 3 today');
    const after = (await ds.getHealth({} as never)).spend;
    expect(after.today.usd).toBeGreaterThan(before.today.usd);
    expect(after.byScanner.find((s) => s.name === 'chat')!.usd).toBeGreaterThan(0);
    expect((await lastAssistant()).usage!.costUsd).toBeGreaterThan(0);
  });

  it('a non-allowlisted tool call aborts the turn and runs nothing after it', async () => {
    useDs(mockWith({ fake: { inject: [{ tool: 'Bash', input: { command: 'open https://example.invalid' } }] } }));
    const evs = await ask('snooze the Globex VDP update until 14:00');
    expect(of(evs, 'error')[0]!.error.message).toMatch(/outside the chat allowlist \(Bash\)/);
    expect(of(evs, 'tool-start')).toHaveLength(0);
    expect(ds.be6.plans.size).toBe(0);
    const evs2 = await (async () => {
      useDs(mockWith({ fake: { inject: [{ tool: 'mcp__slack__slack_send_message', input: { channel_id: 'C1', text: 'hi' } }] } }));
      return ask('top 3 today');
    })();
    expect(of(evs2, 'error')[0]!.error.message).toMatch(/slack_send_message/);
    expect(spawned.n).toBe(0);
  });

  it('credential-like text is redacted in persisted tool args, results and the draft itself', async () => {
    // an invented token, joined at run time so no token-shaped literal is committed (GitHub push protection)
    const token = ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-');
    const evs = await ask(`draft a slack reply to #acme-ext saying the new token: ${token} works now`);
    const msg = await lastAssistant();
    const tool = msg.parts.find((p): p is Extract<ChatPart, { type: 'tool' }> => p.type === 'tool')!;
    expect(tool.name).toBe('slack.draft');
    expect(JSON.stringify(msg)).not.toContain('xoxb-1234567890');
    expect(JSON.stringify(evs)).not.toContain('xoxb-1234567890');
    expect(tool.args).toContain('[REDACTED');
    const d = cards(evs, 'draft')[0]!.draft;
    expect((await ds.getDraft({ params: { id: d.draftId } } as never)).plainText).not.toContain('xoxb-1234567890');
  });

  it('the scripted demos still answer every other prompt (mock UI work)', async () => {
    const seen: Seen = { calls: 0 };
    useDs(mockWith({ seen }));
    const evs = await ask('why is the ACME build first?');
    expect(seen.calls).toBe(0);
    expect(of(evs, 'done')).toHaveLength(1);
  });
});
