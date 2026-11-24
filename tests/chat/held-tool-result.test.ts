/**
 * A guard that held a tool call for the user (SEC-8 `remember`, SEC-9 `run reauth`) is flagged `held` on the
 * tool-result event and on the persisted tool part, so the row reads neutral without parsing its summary.
 */
import { describe, expect, it } from 'vitest';
import { ChatMessage, type ChatSseEvent } from '@/contract';
import type { ChatRunStep } from '@/llm/chat/types';
import { runTurn } from '@/server/chat/turn';

async function* stepsOf(list: ChatRunStep[]) {
  for (const s of list) yield s;
}

describe('held tool results', () => {
  it('runTurn passes held through to the SSE event and the stored part; a plain failure carries none', async () => {
    let n = 0;
    let stored: ChatMessage | null = null;
    const steps: ChatRunStep[] = [
      { type: 'tool-start', id: 'a', name: 'assistant.remember', summary: 'Remembering' },
      { type: 'tool-result', id: 'a', summary: 'Not kept (say it in your words)', ok: false, held: true },
      { type: 'tool-start', id: 'b', name: 'slack.search', summary: 'Searching Slack' },
      { type: 'tool-result', id: 'b', summary: 'Failed: timeout', ok: false },
    ];
    const evs: ChatSseEvent[] = [];
    const ids = { threadId: 't1', messageId: 'm1', userMessageId: 'u1', model: 'sonnet' as const };
    const opts = { signal: new AbortController().signal, now: () => '2026-11-21T12:00:00.000Z', newId: () => `id${++n}`, persist: (m: ChatMessage) => void (stored = m) };
    for await (const e of runTurn(ids, stepsOf(steps), opts)) evs.push(e);
    const results = evs.filter((e): e is Extract<ChatSseEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    expect(results.map((e) => e.held)).toEqual([true, undefined]);
    const parts = ChatMessage.parse(stored).parts.filter((p): p is Extract<ChatMessage['parts'][number], { type: 'tool' }> => p.type === 'tool');
    expect(parts.map((p) => [p.ok, p.held])).toEqual([[false, true], [false, undefined]]);
  });
});
