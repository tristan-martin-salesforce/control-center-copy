/**
 * routeChatTurn (src/server/chat/route.ts): the router's thread and day-line inputs, as both DataSources read them.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@/contract';
import type { ChatBudget } from '@/llm/chat/types';
import { chatDayLeftUsd, routeChatTurn } from '@/server/chat/route';

import { collect, mockWith, of } from './helpers';

const budget = (chatTodayUsd: number, chatDailyUsd = 3) => vi.fn(async (): Promise<ChatBudget> => ({ chatTodayUsd, chatDailyUsd, totalTodayUsd: chatTodayUsd, hardCapUsd: 20, perMessageUsd: 0.25, maxTurns: 200 }));
const draftTurn = (): Pick<ChatMessage, 'role' | 'route' | 'text' | 'status' | 'parts'> => ({ role: 'assistant', text: 'Here is a draft.', status: 'complete', parts: [], route: { intent: 'draft', tier: 'balanced', model: 'sonnet', why: 'a draft', override: false } });

describe('routeChatTurn: the day line', () => {
  it('reads what is left today and steps Auto down to the tier whose per-message line fits', async () => {
    expect(await chatDayLeftUsd(budget(2.9))).toBeCloseTo(0.1);
    expect(await chatDayLeftUsd(budget(5))).toBe(0); // over the line: nothing left, never negative
    expect(await chatDayLeftUsd(undefined)).toBeNull();
    expect(await chatDayLeftUsd(async () => Promise.reject(new Error('db down')))).toBeNull();
    const base = { choice: null, setting: 'auto' as const, messages: [] };
    expect(await routeChatTurn({ ...base, text: 'why is Globex first?', budget: budget(0) })).toMatchObject({ model: 'sonnet' });
    expect(await routeChatTurn({ ...base, text: 'why is Globex first?', budget: budget(2.9) })).toMatchObject({ model: 'haiku', why: expect.stringMatching(/\$0\.10 left today$/) });
    expect(await routeChatTurn({ ...base, text: 'have I ever met Initech?', budget: budget(2.6) })).toMatchObject({ model: 'sonnet' });
    // the per-message lines come from Settings
    expect(await routeChatTurn({ ...base, text: 'have I ever met Initech?', budget: budget(2.6), messageUsd: { opus: 0.3 } })).toMatchObject({ model: 'opus' });
  });

  it("a model the user chose is not stepped down, and the budget isn't read for it", async () => {
    const b = budget(2.99);
    expect(await routeChatTurn({ text: 'have I ever met Initech?', choice: 'opus', setting: 'auto', messages: [], budget: b })).toMatchObject({ model: 'opus', override: true });
    expect(await routeChatTurn({ text: 'why?', choice: null, setting: 'sonnet', messages: [], budget: b })).toMatchObject({ model: 'sonnet' });
    expect(b).not.toHaveBeenCalled();
  });

  it("reads the thread's previous assistant turn", async () => {
    expect(await routeChatTurn({ text: 'make it shorter', choice: null, setting: 'auto', messages: [{ role: 'user', text: 'draft a reply to Dana', parts: [] }, draftTurn()] })).toMatchObject({ intent: 'draft', model: 'sonnet', why: 'a follow-up to a draft' });
  });
});

describe('the mock DataSource routes a follow-up as a follow-up', { timeout: 30_000 }, () => {
  it('a draft, then "make it shorter" in the same thread: the second start is Sonnet, a follow-up to a draft', async () => {
    const ds = mockWith();
    try {
      const send = (text: string) => collect(ds.chat({ body: { text, context: [] }, signal: new AbortController().signal } as never));
      const first = of(await send('draft a reply to Dana about the pricing'), 'start')[0]!;
      expect(first.route).toMatchObject({ intent: 'draft', model: 'sonnet' });
      const second = of(await send('make it shorter'), 'start')[0]!;
      expect(second.route).toMatchObject({ intent: 'draft', tier: 'balanced', model: 'sonnet', why: 'a follow-up to a draft' });
    } finally {
      ds.dispose();
    }
  });
});
