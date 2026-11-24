/**
 * ASSIST-9 (2026-11-20): the live spend of a turn (`usage-delta`) folds into the live view, the settled message keeps
 * its usage, and the cost line reads "model · $ so far" while it runs and "model · $ actual" (plus the stopped answer's
 * cost when it continued one, ASSIST-2) once it is settled.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSseEvent } from '@/contract';
import { ChatSseEvent as ChatSseEventSchema } from '@/contract';
import { costText, modelLabel } from '@/components/chat/ChatMessages';
import { parseChatFrame } from '../sse';
import { mergeMessages, reduceTurn, startTurn, viewOfServer } from '../turn';

const ev = (e: ChatSseEvent) => e;

describe('usage-delta', () => {
  it('is a contract event older clients can drop, and the parser reads it', () => {
    const delta = { type: 'usage-delta', messageId: 'm1', spentUsd: 0.0123, model: 'claude-sonnet-5-5' };
    expect(ChatSseEventSchema.safeParse(delta).success).toBe(true);
    expect(parseChatFrame({ event: 'usage-delta', data: JSON.stringify(delta) })).toEqual(delta);
    expect(ChatSseEventSchema.safeParse({ ...delta, spentUsd: -1 }).success).toBe(false);
  });

  it('folds into the live turn: the assistant view shows the spend so far', () => {
    let t = startTurn({ threadId: 't1', text: 'hi', context: [], baseIds: [] });
    t = reduceTurn(t, ev({ type: 'start', threadId: 't1', messageId: 'm1', userMessageId: 'u1', model: 'sonnet' }));
    t = reduceTurn(t, ev({ type: 'usage-delta', messageId: 'm1', spentUsd: 0.004, model: 'claude-sonnet-5-5' }));
    t = reduceTurn(t, ev({ type: 'usage-delta', messageId: 'm1', spentUsd: 0.019, model: 'claude-sonnet-5-5' }));
    const views = mergeMessages([], t);
    const a = views.find((v) => v.role === 'assistant')!;
    expect(a).toMatchObject({ spentUsd: 0.019, spentModel: 'claude-sonnet-5-5', streaming: true });
    expect(costText(a)).toBe('Sonnet · $0.019 so far');
  });

  it('the settled message shows the receipt line, with what the stopped answer cost when it continued one', () => {
    const m: ChatMessage = { id: 'm2', threadId: 't1', role: 'assistant', at: '2026-11-05T16:00:00.000Z', text: 'Done.', parts: [], context: [], isMorningBrief: false, status: 'complete', usage: { model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, costUsd: 0.12, turns: 2 } };
    expect(costText(viewOfServer(m))).toBe('Sonnet · $0.12');
    const cont = viewOfServer({ ...m, usage: { ...m.usage!, costUsd: 0.08, continuedFromUsd: 0.26 } });
    expect(costText(cont)).toBe('Sonnet · $0.080 (+ $0.26 before Allow more = $0.34)');
    expect(costText(viewOfServer({ ...m, usage: undefined }))).toBeNull();
    expect(modelLabel('claude-opus-5-5')).toBe('Opus');
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku');
  });
});
