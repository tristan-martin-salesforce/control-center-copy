/**
 * Persisted sessions and compaction (H-6): the runner starts an SDK session per thread, resumes it, rebuilds the thread
 * from the stored history when the transcript is gone (older turns summarized into chat_memory once, pinned notes kept),
 * and drops a session whose resume failed. Fake model and a fake summarizer: no LLM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ChatUsage } from '@/contract';
import { costText } from '@/components/chat/ChatMessages';
import { createFakeChatQuery } from '@/llm/chat/fake';
import { runChatTurn, sessionTranscriptPath, type ChatQueryFn } from '@/llm/chat/runner';
import type { ChatHost, ChatRunStep } from '@/llm/chat/types';
import type { CompleteResult } from '@/llm/provider/types';
import { createChatHost } from '@/server/chat/host';
import type { MockDataSource } from '@/server/datasource/mock';
import { MockChatMemory } from '@/server/datasource/mock/chat-memory';
import { mockWith } from '../../chat/helpers';

let ds: MockDataSource;
let memory: MockChatMemory;
beforeEach(() => {
  ds = mockWith();
  memory = new MockChatMemory(() => new Date('2026-11-20T12:00:00Z'));
});
afterEach(() => ds.dispose());

const msg = (n: number, text: string): ChatMessage => ({ id: `m${n}`, threadId: 'th1', role: n % 2 ? 'assistant' : 'user', at: `2026-11-20T10:${String(n % 60).padStart(2, '0')}:00.000Z`, text, parts: [], context: [], isMorningBrief: false });

function hostWith(history: ChatMessage[] = []): ChatHost {
  return { ...createChatHost(ds, { ...ds.be6.backend(), memory }, () => ds.now()), history: async () => history } as ChatHost;
}
function spy() {
  const seen: Array<{ prompt: string; resume?: string; sessionId?: string; persistSession?: boolean }> = [];
  const fake = createFakeChatQuery();
  const q: ChatQueryFn = (p) => {
    seen.push({ prompt: p.prompt, resume: p.options.resume, sessionId: p.options.sessionId, persistSession: p.options.persistSession });
    return fake(p);
  };
  return { seen, q };
}
const turn = async (host: ChatHost, o: Parameters<typeof runChatTurn>[2], text = 'top 3 today') => {
  const steps: ChatRunStep[] = [];
  for await (const s of runChatTurn({ threadId: 'th1', messageId: `msg_${Math.random().toString(36).slice(2)}`, userMessageId: 'u', text, context: [], model: 'haiku', signal: new AbortController().signal }, host, { scanPollMs: 5, ...o })) steps.push(s); // no scans here: never sit out the 1.5 s scan poll
  return steps;
};

describe('SDK sessions per thread', () => {
  it('the first message starts a session with its own id and keeps it; the next resumes it with no re-sent history', async () => {
    const { seen, q } = spy();
    const history = [msg(0, 'what is first?'), msg(1, 'The ACME build.')];
    const host = hostWith(history);
    await turn(host, { queryFn: q, sessionExists: () => false });
    expect(seen[0]).toMatchObject({ persistSession: true, resume: undefined });
    expect(seen[0]!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]!.prompt).toContain('## Thread so far'); // no session yet: rebuilt from the stored history
    expect(await memory.sessionOf('th1')).toBe(seen[0]!.sessionId);
    const steps = await turn(host, { queryFn: q, sessionExists: () => true });
    expect(seen[1]).toMatchObject({ resume: seen[0]!.sessionId, sessionId: undefined });
    expect(seen[1]!.prompt).not.toContain('## Thread so far');
    expect(steps.find((s) => s.type === 'usage')).toMatchObject({ usage: { resumed: true, tier: 'fast' } });
  });

  it('a session whose transcript is gone is rebuilt from the thread (a new session id)', async () => {
    const { seen, q } = spy();
    await memory.setSession('th1', '00000000-0000-4000-8000-00000000dead');
    await turn(hostWith([msg(0, 'hi'), msg(1, 'hello')]), { queryFn: q, sessionExists: () => false });
    expect(seen[0]!.resume).toBeUndefined();
    expect(seen[0]!.sessionId).not.toBe('00000000-0000-4000-8000-00000000dead');
    expect(seen[0]!.prompt).toContain('## Thread so far\nUser: hi');
  });

  it('a resume that fails before any answer drops the session, so the next message rebuilds', async () => {
    await memory.setSession('th1', 's-old');
    const failing: ChatQueryFn = () =>
      (async function* () {
        yield { type: 'result', subtype: 'error_during_execution', errors: ['No conversation found with session ID: s-old'], num_turns: 0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] } as never;
      })();
    const steps = await turn(hostWith([]), { queryFn: failing });
    expect(steps.find((s) => s.type === 'error')).toBeTruthy();
    expect(await memory.sessionOf('th1')).toBeNull();
  });

  it('sessions off (CC_CHAT_SESSIONS=0): nothing persists and the thread is rebuilt each time', async () => {
    const { seen, q } = spy();
    await turn(hostWith([msg(0, 'hi'), msg(1, 'hello')]), { queryFn: q, sessions: false });
    expect(seen[0]).toMatchObject({ persistSession: false, resume: undefined, sessionId: undefined });
    expect(await memory.sessionOf('th1')).toBeNull();
  });

  it('the transcript lives under the chat cwd’s project folder of the Claude config', () => {
    expect(sessionTranscriptPath('abc', '/Users/x/Library/Application Support/command-center/chat-cwd', { CLAUDE_CONFIG_DIR: '/cfg' } as never)).toBe('/cfg/projects/-Users-x-Library-Application-Support-command-center-chat-cwd/abc.jsonl');
  });
});

describe('compaction', () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => msg(i, `${i}: ${'detail '.repeat(3_000)}`)); // ~21K chars each

  it('a rebuilt thread over the trigger summarizes the older turns once (fast tier, booked), keeps the recent ones whole', async () => {
    const { seen, q } = spy();
    const summarize = vi.fn(async (): Promise<CompleteResult> => ({ ok: true, text: '- The user asked about ACME 10 times.', usage: { provider: 'fake', model: 'claude-haiku-5-5', inputTokens: 50_000, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.005, costEstimated: false } }));
    const recorded: string[] = [];
    const host = { ...hostWith(long(14)), recordUsage: async (u: { skill?: string }) => void recorded.push(u.skill ?? '') } as ChatHost;
    const steps = await turn(host, { queryFn: q, sessionExists: () => false, summarize });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect((summarize.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe('fast');
    const summaries = (await memory.list('th1')).filter((e) => e.kind === 'summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.coversThroughSeq).toBe(7); // 14 messages, the last 6 kept whole
    expect(seen[0]!.prompt).toContain('Summary of the earlier conversation (messages 1-8):\n- The user asked about ACME 10 times.');
    expect(seen[0]!.prompt).not.toContain('User: 0:');
    expect(seen[0]!.prompt).toContain('User: 8:');
    expect(recorded).toContain('chat-compact@1');
    // the summary's cost is part of the message's receipt
    expect(steps.find((s) => s.type === 'usage')).toMatchObject({ usage: { subRunUsd: 0.005 } });
    // the next rebuild reuses it (no second summary)
    await turn(host, { queryFn: q, sessionExists: () => false, summarize });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('W12-8: the summary call books its own llm_calls row with the thread id, and the receipt says "summarised N turns"', async () => {
    const { q } = spy();
    const summarize = vi.fn(async (): Promise<CompleteResult> => ({ ok: true, text: '- Earlier: ACME pricing asked twice.', usage: { provider: 'fake', model: 'claude-haiku-5-5', inputTokens: 40_000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.004, costEstimated: false } }));
    const booked: Array<{ threadId?: string; messageId?: string; skill?: string; costUsd: number; model: string }> = [];
    const host = { ...hostWith(long(14)), recordUsage: async (u: (typeof booked)[number]) => void booked.push(u) } as unknown as ChatHost;
    const steps = await turn(host, { queryFn: q, sessionExists: () => false, summarize });
    const compactRow = booked.find((u) => u.skill === 'chat-compact@1');
    expect(compactRow).toMatchObject({ threadId: 'th1', costUsd: 0.004, model: 'claude-haiku-5-5', messageId: expect.stringMatching(/^msg_/) });
    // one row for the summary, one for the answer: never folded into the answer's own row
    expect(booked.filter((u) => u.skill !== 'chat-compact@1')).toHaveLength(1);
    const usage = (steps.find((s) => s.type === 'usage') as { usage: ChatUsage }).usage;
    expect(usage).toMatchObject({ summarizedTurns: 8, subRunUsd: 0.004 });
    expect(costText({ streaming: false, usage })).toMatch(/ · summarised 8 turns$/);
    // the next rebuild reuses the summary: no new call, nothing on the receipt
    const again = await turn(host, { queryFn: q, sessionExists: () => false, summarize });
    expect((again.find((s) => s.type === 'usage') as { usage: ChatUsage }).usage.summarizedTurns).toBeUndefined();
    expect(booked.filter((u) => u.skill === 'chat-compact@1')).toHaveLength(1);
  });

  it('pinned notes and preferences ride on every turn; a summary that fails keeps the whole thread (never drops)', async () => {
    await memory.add({ threadId: 'th1', kind: 'note', text: 'The Globex sponsor is Dana', pinned: true });
    await memory.add({ threadId: null, kind: 'preference', text: 'Log in 15-minute steps', pinned: true });
    const { seen, q } = spy();
    const summarize = vi.fn(async (): Promise<CompleteResult> => ({ ok: false, text: '', usage: { provider: 'fake', model: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costEstimated: false }, error: 'unavailable' }));
    await turn(hostWith(long(14)), { queryFn: q, sessionExists: () => false, summarize });
    expect(seen[0]!.prompt).toMatch(/## Remembered\n- note \(pinned\): The Globex sponsor is Dana\n- preference \(pinned\): Log in 15-minute steps/);
    expect(seen[0]!.prompt).toContain('User: 0:');
    expect((await memory.list('th1')).filter((e) => e.kind === 'summary')).toHaveLength(0);
  });
});
