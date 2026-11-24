/**
 * FTI Slack fetch: code issues the scan-slack §2 queries through the relay runtime, pages them, opens threads per §3,
 * and REC-1 records every message. Parity: the rows are exactly the ones REC-1 records when the agent makes the same
 * reads (same dedupe keys, content hashes, excerpts and payloads), because both feed the same tool output to the same
 * recorder (src/llm/slack-rec.ts).
 */
import { describe, expect, it } from 'vitest';

import { createRunState } from '@/llm/cc-tools';
import { SlackAutoRecorder } from '@/llm/slack-rec';
import { fetchSlackScope, slackCursorOf, slackQueries, threadsToOpen } from '@/scanner/fetch';
import type { InMemoryScannerStore } from '@/scanner/store-memory';

import { corpusRelay, corpusSearch, corpusStore, fakeRelay, loadCorpus } from './helpers';

const corpus = loadCorpus();
const ME = corpus.me.slackId;
const WINDOW = { from: '2026-10-31T00:00:00.000Z', to: '2026-11-06T18:00:00.000Z' };

async function ftiFetch(store: InMemoryScannerStore, relay = corpusRelay(corpus), scope = 'inbox', mode = 'incremental') {
  const { runId } = await store.startRun({ scope: { connector: 'slack', scope }, trigger: 'schedule', window: WINDOW });
  const ctx = await store.getContext({ connector: 'slack', scope });
  const state = createRunState({ runId, connector: 'slack', window: WINDOW, context: ctx });
  const r = await fetchSlackScope({ scope, window: WINDOW, mode, ctx, vars: {}, runtime: relay, store, state, signal: new AbortController().signal });
  return { r, state, relay };
}

const rows = (s: InMemoryScannerStore) =>
  [...((s as unknown as { sourceItems: Map<string, { dedupeKey: string; contentHash: string; excerpt?: string; payload?: unknown; threadRef?: string; author?: unknown }> }).sourceItems.values())]
    .map((x) => ({ dedupeKey: x.dedupeKey, contentHash: x.contentHash, excerpt: x.excerpt, payload: x.payload, threadRef: x.threadRef, author: x.author }))
    .sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));

describe('slack queries (scan-slack §2 verbatim)', () => {
  it('inbox: S1–S4 with the skill parameters and the 2-minute overlap', () => {
    const q = slackQueries('inbox', WINDOW, {}, ME)!;
    expect(q.map((x) => x.ref)).toEqual(['search:dm', 'search:mentions', 'search:mine', 'search:mine:files']);
    expect(q[0]!.args).toMatchObject({ filters: `-from:<@${ME}>`, channel_types: 'im,mpim', sort: 'timestamp', sort_dir: 'asc', limit: 20, include_context: false, response_format: 'detailed', after: String(Date.parse(WINDOW.from) / 1000 - 120), before: String(Date.parse(WINDOW.to) / 1000) });
    expect(q[1]!.args).toMatchObject({ keywords: [`<@${ME}>`], channel_types: 'public_channel,private_channel' });
    expect(q[1]!.args).not.toHaveProperty('filters'); // a mention in filters returns the whole workspace
    expect(q[3]!.args).toMatchObject({ filters: `from:<@${ME}> has:file` });
  });
  it('channel: C1 by name, C1′ read_channel without one; thread: T1; no Slack id: the agent', () => {
    expect(slackQueries('channel:C0ACME001', WINDOW, { 'channel.label': 'acme-account' }, ME)![0]!.args).toMatchObject({ filters: 'in:#acme-account' });
    expect(slackQueries('channel:C0ACME001', WINDOW, {}, ME)![0]).toMatchObject({ tool: 'slack_read_channel', args: { channel_id: 'C0ACME001', limit: 100 } });
    expect(slackQueries('thread:C0ACME001:1793815200.000100', WINDOW, {}, ME)![0]).toMatchObject({ tool: 'slack_read_thread', kind: 'thread', ref: 'slack:C0ACME001:1793815200.000100' });
    expect(slackQueries('inbox', WINDOW, {}, undefined)).toBeNull();
  });
  it('reads a next-page cursor in both formats', () => {
    expect(slackCursorOf(JSON.stringify({ results: '', pagination_info: 'For the next page of results use cursor `PAGE:2`' }))).toBe('PAGE:2');
    expect(slackCursorOf(JSON.stringify({ messages: '', pagination_info: 'next cursor: `abc=`' }))).toBe('abc=');
    expect(slackCursorOf(JSON.stringify({ results: '', pagination_info: 'End of results' }))).toBeUndefined();
  });
});

describe('fetch parity with the agentic path (REC-1, same rows)', () => {
  it('records the same source_items rows, keys and hashes as REC-1 on the same tool outputs', async () => {
    // FTI: code fetches
    const a = corpusStore(corpus);
    const fti = await ftiFetch(a);
    // agentic: the agent makes the same reads; the runner's PostToolUse hook hands each result to REC-1
    const b = corpusStore(corpus);
    const { runId } = await b.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
    const ctx = await b.getContext({ connector: 'slack', scope: 'inbox' });
    const state = createRunState({ runId, connector: 'slack', window: WINDOW, context: ctx });
    const rec = new SlackAutoRecorder(b, state, ctx);
    for (const [i, c] of fti.relay.calls.entries()) {
      const out = c.tool === 'slack_search_public_and_private' ? corpusSearch(corpus, c.args) : await corpusRelay(corpus).call(c.tool, c.args).then((r) => r.text);
      // the SDK hands the hook MCP content blocks; the relay hands code the tool's text: REC-1 reads both the same
      await rec.onToolResult(`mcp__slack__${c.tool}`, c.args, [{ type: 'text', text: out }], `tu_${i}`);
    }
    expect(rows(a).length).toBeGreaterThan(5);
    expect(rows(a)).toEqual(rows(b));
  });

  it('S1–S3 always, S4 only when S3 found a message of mine; coverage per the skill; complete cursor at the window end', async () => {
    const { r, relay } = await ftiFetch(corpusStore(corpus));
    const searches = relay.calls.filter((c) => c.tool === 'slack_search_public_and_private').map((c) => String(c.args.filters ?? c.args.keywords));
    expect(searches).toEqual([`-from:<@${ME}>`, `<@${ME}>`, `from:<@${ME}>`, `from:<@${ME}> has:file`]);
    expect(r.coverage.filter((c) => c.kind === 'query_window').map((c) => c.ref)).toEqual(['search:dm', 'search:mentions', 'search:mine', 'search:mine:files']);
    expect(r.complete).toBe(true);
    expect(r.cursor).toEqual({ value: `${Math.floor(Date.parse(WINDOW.to) / 1000)}.000000`, at: WINDOW.to });
    expect(r.calls.every((c) => c.ok && c.usd > 0 && c.contentHash.length === 32)).toBe(true);
  });

  it('an empty S3 vouches for S4 with no call', async () => {
    const quiet = { ...corpus, messages: corpus.messages.filter((m) => m.from !== ME) };
    const { r, relay } = await ftiFetch(corpusStore(quiet), corpusRelay(quiet));
    expect(relay.calls.filter((c) => String(c.args.filters ?? '').includes('has:file'))).toHaveLength(0);
    expect(r.coverage.find((c) => c.ref === 'search:mine:files')).toMatchObject({ meta: { vouchedBy: 'search:mine' } });
  });

  it('a paged-out query finishes incomplete at its last message, with coverage to there', async () => {
    const many = { ...corpus, messages: Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, channel: 'D0DM00002', from: 'U0PERSOND', ts: `${1793811600 + i * 60}.000100`, text: `question ${i}?` })) };
    const { r } = await ftiFetch(corpusStore(many), corpusRelay(many), 'inbox', 'incremental');
    // limit 20, 5 pages live: 45 messages fit, so complete
    expect(r.complete).toBe(true);
    const capped = await (async () => {
      const s = corpusStore(many);
      const { runId } = await s.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
      const ctx = await s.getContext({ connector: 'slack', scope: 'inbox' });
      return fetchSlackScope({ scope: 'inbox', window: WINDOW, mode: 'incremental', ctx, vars: {}, runtime: corpusRelay(many), store: s, state: createRunState({ runId, connector: 'slack', window: WINDOW, context: ctx }), signal: new AbortController().signal, maxPages: 2 });
    })();
    expect(capped.complete).toBe(false);
    expect(capped.cursor.value).toBe(`${1793811600 + 39 * 60}.000100`);
    expect(capped.coverage.find((c) => c.ref === 'search:dm')!.to).toBe(new Date((1793811600 + 39 * 60) * 1000).toISOString());
  });

  it('a relay failure stops the fetch with its class and books what it read', async () => {
    const s = corpusStore(corpus);
    const { runId } = await s.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
    const ctx = await s.getContext({ connector: 'slack', scope: 'inbox' });
    let n = 0;
    const relay = fakeRelay('slack', (_tool, args) => {
      n += 1;
      if (n === 2) throw Object.assign(new Error('x'), { code: 'needs_auth' });
      return corpusSearch(corpus, args);
    });
    const err = await fetchSlackScope({ scope: 'inbox', window: WINDOW, mode: 'incremental', ctx, vars: {}, runtime: relay, store: s, state: createRunState({ runId, connector: 'slack', window: WINDOW, context: ctx }), signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ScopeFetchError', errorClass: 'auth', code: 'needs_auth' });
    expect((err as { calls: unknown[] }).calls).toHaveLength(2);
  });
});

describe('§3 thread reads', () => {
  it('opens the thread of a reply to me or by me whose parent this run has not read, at most `max`', () => {
    const state = createRunState({ runId: 'r', connector: 'slack', window: WINDOW, context: { scope: { connector: 'slack', scope: 'inbox' }, cursor: null, gaps: [], me: { userId: 'u', name: 'ME', slackId: ME }, watchList: [], aliases: { accounts: [], channels: [] }, openItems: [], initiatives: [], skillVersion: 'x' } });
    const item = (ch: string, ts: string, threadTs: string, isMe: boolean, toMe: boolean, text = 'ok') => ({ connector: 'slack' as const, kind: 'message' as const, externalId: `${ch}:${ts}`, dedupeKey: `slack:${ch}:${ts}`, contentHash: 'h', occurredAt: WINDOW.from, excerpt: text, author: { isMe }, payload: { channelId: ch, ts, threadTs, isReply: true, ...(toMe ? { toMe } : {}) } });
    state.items.set('a', item('C1', '2.0', '1.0', false, true));
    state.items.set('b', item('C2', '4.0', '3.0', true, false));
    state.items.set('c', item('C3', '6.0', '5.0', false, false));
    state.recorded.set('slack:C2:3.0', 'sid-parent');
    expect(threadsToOpen({ state, ctx: state.context, mode: 'incremental', window: WINDOW, scope: 'inbox' }, 5)).toEqual([{ channel: 'C1', ts: '1.0' }]);
    state.items.set('d', item('C2', '4.5', '3.0', true, false, 'Done, here it is'));
    expect(threadsToOpen({ state, ctx: state.context, mode: 'incremental', window: WINDOW, scope: 'inbox' }, 5)).toEqual([{ channel: 'C1', ts: '1.0' }, { channel: 'C2', ts: '3.0' }]);
    expect(threadsToOpen({ state, ctx: state.context, mode: 'incremental', window: WINDOW, scope: 'inbox' }, 1)).toHaveLength(1);
  });

  it('caps audit: every thread the run found is opened (was the oldest 5) and a long thread is paged, not cut at 30', async () => {
    const s = corpusStore(corpus);
    const { runId } = await s.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
    const ctx = await s.getContext({ connector: 'slack', scope: 'inbox' });
    const state = createRunState({ runId, connector: 'slack', window: WINDOW, context: ctx });
    for (let i = 1; i <= 7; i += 1) state.items.set(`r${i}`, { connector: 'slack', kind: 'message', externalId: `C${i}:${i}.5`, dedupeKey: `slack:C${i}:${i}.5`, contentHash: 'h', occurredAt: WINDOW.from, excerpt: 'ok', author: { isMe: false }, payload: { channelId: `C${i}`, ts: `${i}.5`, threadTs: `${i}.0`, isReply: true, toMe: true } } as never);
    expect(threadsToOpen({ state, ctx, mode: 'incremental', window: WINDOW, scope: 'inbox' })).toHaveLength(7);
    const relay = fakeRelay('slack', (tool, args) => {
      if (tool !== 'slack_read_thread') return JSON.stringify({ messages: [] });
      // C1's thread is long: a second page behind a cursor
      return JSON.stringify(args.channel_id === 'C1' && !args.cursor ? { messages: [], pagination_info: 'More: cursor: `p2`' } : { messages: [] });
    });
    await fetchSlackScope({ scope: 'inbox', window: WINDOW, mode: 'incremental', ctx, vars: {}, runtime: relay, store: s, state, signal: new AbortController().signal });
    const reads = relay.calls.filter((c) => c.tool === 'slack_read_thread');
    expect(new Set(reads.map((c) => c.args.channel_id))).toEqual(new Set(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']));
    expect(reads.every((c) => c.args.limit === 100)).toBe(true);
    expect(reads.filter((c) => c.args.channel_id === 'C1').map((c) => c.args.cursor ?? null)).toEqual([null, 'p2']);
  });
});
