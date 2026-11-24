// @vitest-environment jsdom
/**
 * P33-2 (33-post20-review-2.md): an answer stopped at Steps per message shows "Continue", and the button continues that
 * answer (`continueMessageId`, no re-send of the question), live or after the thread has reconciled. Any other
 * retryable error still re-sends the question under "Retry".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody, ChatMessage, ChatThread } from '@/contract';
import { $, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';
import { InlineError } from '@/components/chat/ChatMessages';
import { STEP_LIMIT_CODE } from '../turn';
import { useChatStream, type ChatStreamApi } from '../useChatStream';

const at = '2026-11-21T12:00:00.000Z';
const THREAD: ChatThread = { id: 'th_1', title: 'Today', isDefault: true, createdAt: at, updatedAt: at, messageCount: 0, lastMessagePreview: null };
const STEP_STOP: ApiErrorBody = { code: 'internal', message: 'Stopped after 1 steps without finishing. Say "continue" to go on.', retryable: true, details: { catalogCode: STEP_LIMIT_CODE } };
const OTHER: ApiErrorBody = { code: 'upstream_unavailable', message: 'The model is unavailable.', retryable: true };

let posts: Array<Record<string, unknown>>;
let messages: ChatMessage[];
/** Persist the turn on the server (the thread then reconciles) or not (the live turn stays on screen). */
let persistTurns: boolean;
let nextError: ApiErrorBody | null;

const sse = (events: unknown[]) =>
  new Response(new ReadableStream({ start: (c) => { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  posts = [];
  messages = [];
  persistTurns = false;
  nextError = STEP_STOP;
  localStorage.clear();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    if (url.pathname.endsWith('/chat/threads')) return json({ threads: [THREAD] });
    if (url.pathname.endsWith(`/chat/threads/${THREAD.id}`)) return json({ thread: THREAD, messages });
    if (url.pathname.endsWith('/chat') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      const n = posts.length;
      const err = nextError;
      if (persistTurns) {
        messages = [
          ...messages,
          { id: `u${n}`, threadId: THREAD.id, role: 'user', at, text: String(body.text), parts: [], context: [], isMorningBrief: false },
          { id: `a${n}`, threadId: THREAD.id, role: 'assistant', at, text: 'Partial', parts: err ? [{ type: 'error', error: err }] : [], context: [], isMorningBrief: false },
        ] as ChatMessage[];
      }
      return sse([{ type: 'start', threadId: THREAD.id, messageId: `a${n}`, userMessageId: `u${n}`, model: 'haiku' }, err ? { type: 'error', error: err } : { type: 'done', threadId: THREAD.id, messageId: `a${n}`, userMessageId: `u${n}` }]);
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route', retryable: false } }), { status: 404 });
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

async function mount(): Promise<{ api: () => ChatStreamApi }> {
  let api: ChatStreamApi | null = null;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  function Harness() {
    const chat = useChatStream({ persist: false, reconnect: { attempts: 0, baseMs: 1 } });
    useEffect(() => {
      api = chat;
    });
    const err = chat.turn?.error ?? null;
    return err ? h(InlineError, { error: err, onRetry: chat.retry }) : null;
  }
  await render(h(QueryClientProvider, { client: qc }, h(Harness)));
  await waitFor(() => api?.threadId === THREAD.id);
  return { api: () => api! };
}

describe('Steps per message stop: the button continues the answer', () => {
  it('live: the card says Continue, and one click sends one continuation and not the question again', async () => {
    const { api } = await mount();
    api().send('what is on my calendar tomorrow');
    const btn = await waitFor(() => $('[data-retry]'));
    expect(btn.textContent).toBe('Continue');
    expect(posts).toHaveLength(1);

    nextError = null;
    await click(btn);
    await waitFor(() => posts.length === 2 && api().status === 'done');
    expect(posts[1]).toMatchObject({ threadId: THREAD.id, text: 'Continue', continueMessageId: 'a1' });
    expect(posts.filter((p) => p.text === 'what is on my calendar tomorrow')).toHaveLength(1);
  });

  it('reconciled: after the thread holds the stopped answer, retry still continues it', async () => {
    persistTurns = true;
    const { api } = await mount();
    api().send('what is on my calendar tomorrow');
    await waitFor(() => posts.length === 1 && api().turn === null && api().messages.some((m) => m.id === 'a1'));

    nextError = null;
    api().retry();
    await waitFor(() => posts.length === 2);
    expect(posts[1]).toMatchObject({ text: 'Continue', continueMessageId: 'a1' });
    expect(posts.filter((p) => p.text === 'what is on my calendar tomorrow')).toHaveLength(1);
  });

  it('any other retryable error keeps Retry, which asks the question again', async () => {
    nextError = OTHER;
    const { api } = await mount();
    api().send('what is on my calendar tomorrow');
    const btn = await waitFor(() => $('[data-retry]'));
    expect(btn.textContent).toBe('Retry');
    nextError = null;
    await click(btn);
    await waitFor(() => posts.length === 2);
    expect(posts[1]).toMatchObject({ text: 'what is on my calendar tomorrow' });
    expect(posts[1]!.continueMessageId).toBeUndefined();
  });
});
