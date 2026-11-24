/**
 * Spend governor in the Assistant (H-5, holistic review 2026-11-20): a message holds its per-message budget; past it the
 * turn raises a hand at its next tool call (SSE `spend-ask`), the SDK query alive, and the card's answer (POST
 * /chat/spend-answer) lets it continue or wrap up. `usage-delta` carries the hold. Mock DataSource, fake model. The messages
 * ask for Sonnet: under Auto a snooze is a Haiku turn, far under a $0.01 hold.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatSpendAnswerRequest, routes, type ChatSseEvent } from '@/contract';
import type { MockDataSource } from '@/server/datasource/mock';
import { collect, mockWith, of, type Seen } from './helpers';

type G = { __ccDataSource?: unknown };
let ds: MockDataSource;
const envBefore = { ...process.env };

function useDs(d: MockDataSource) {
  ds?.dispose();
  ds = d;
  (globalThis as G).__ccDataSource = ds;
}
beforeEach(() => {
  process.env.CC_CHAT_MESSAGE_USD = '0.01';
  useDs(mockWith({ fake: { usage: { input_tokens: 20_000, output_tokens: 2_000 } } }));
});
afterEach(() => {
  delete (globalThis as G).__ccDataSource;
  ds.dispose();
  process.env = { ...envBefore };
});

/** Send a message; answer its first spend-ask with `answer` (the card's click). */
async function askAndAnswer(text: string, answer: (ask: Extract<ChatSseEvent, { type: 'spend-ask' }>) => Promise<unknown>) {
  const answered: unknown[] = [];
  const evs = await collect(ds.chat({ body: { text, context: [], model: 'sonnet' }, signal: new AbortController().signal } as never), {
    onEvent: (e) => {
      if (e.type === 'spend-ask') answered.push(answer(e));
    },
  });
  return { evs, results: await Promise.all(answered) };
}

describe('spend asks in the Assistant', { timeout: 60_000 }, () => {
  it('the contract has the answer route and a valid spend-ask event', () => {
    expect(routes.chatSpendAnswer.path).toBe('/chat/spend-answer');
    expect(routes.chatSpendAnswer.method).toBe('POST');
    expect(ChatSpendAnswerRequest.safeParse({ holdId: 'h', answer: 'approve' }).success).toBe(false); // approve needs usd
    expect(ChatSpendAnswerRequest.safeParse({ holdId: 'h', answer: 'deny' }).success).toBe(true);
  });

  it('past its hold the turn asks, waits, and on Allow $Z more continues to the end (nothing re-run)', async () => {
    const seen: Seen = { calls: 0 };
    useDs(mockWith({ seen, fake: { usage: { input_tokens: 20_000, output_tokens: 2_000 } } }));
    const { evs, results } = await askAndAnswer('snooze the Globex VDP update until 14:00', (a) => ds.chatSpendAnswer({ body: { holdId: a.holdId, answer: 'approve', usd: 5 } } as never));
    const ask = of(evs, 'spend-ask')[0]!;
    expect(ask.question).toMatch(/^This answer has used \$0\.\d+ of its \$0\.01 limit; allow \$\d+\.\d{2} more\?$/);
    expect(ask.moreUsd).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ resumed: true, hold: { state: 'approved', answerUsd: 5 } });
    expect(of(evs, 'error')).toHaveLength(0);
    expect(of(evs, 'done')).toHaveLength(1);
    expect(of(evs, 'proposal').length + of(evs, 'receipt').length).toBeGreaterThan(0); // the work went on
    expect(seen.calls).toBe(1); // one query, kept alive while it waited
    // usage-delta carries the hold: asked while it waited, approved after
    const states = of(evs, 'usage-delta').map((e) => e.hold?.state);
    expect(states).toContain('asked');
    expect(states).toContain('approved');
    // the receipt: the hold settled with what the message spent
    const holds = await ds.listSpendHolds({ query: {} } as never);
    const h = holds.holds.find((x) => x.id === ask.holdId)!;
    expect(h.state).toBe('settled');
    expect(h.spentUsd).toBeGreaterThan(0.01);
    expect(holds.summary).toMatchObject({ asked: 1, approved: 1, denied: 0 });
    expect(holds.asks).toHaveLength(0);
  });

  it('Stop wraps the turn up from what it has: the next tool is denied, the answer still finishes', async () => {
    const { evs, results } = await askAndAnswer('snooze the Globex VDP update until 14:00', (a) => ds.chatSpendAnswer({ body: { holdId: a.holdId, answer: 'deny' } } as never));
    expect(results[0]).toMatchObject({ resumed: true, hold: { state: 'denied' } });
    expect(of(evs, 'error')).toHaveLength(0);
    expect(of(evs, 'done')).toHaveLength(1);
    expect(of(evs, 'proposal')).toHaveLength(0); // nothing staged after the stop
    const h = (await ds.listSpendHolds({ query: {} } as never)).holds[0]!;
    expect(h.state).toBe('denied');
    expect((await ds.listSpendHolds({ query: {} } as never)).summary.denied).toBe(1);
  });

  it('while it waits, the ask is on Health and Health can answer it', async () => {
    let health: Awaited<ReturnType<MockDataSource['getHealth']>> | null = null;
    const { evs } = await askAndAnswer('snooze the Globex VDP update until 14:00', async (a) => {
      health = await ds.getHealth({} as never);
      return ds.answerSpendHold({ params: { id: a.holdId }, body: { answer: 'today' } } as never);
    });
    expect(health!.spendAsks).toHaveLength(1);
    expect(health!.spendAsks![0]!.question).toMatch(/allow \$/);
    expect(of(evs, 'done')).toHaveLength(1);
    expect(of(evs, 'spend-ask')).toHaveLength(1); // allowed for today: no second ask
    expect((await ds.getHealth({} as never)).spendAsks).toHaveLength(0);
  });

  it('unanswered, it ends as the budget stop that "Allow more" continues', async () => {
    useDs(mockWith({ runner: { askTimeoutMs: 50 }, fake: { usage: { input_tokens: 20_000, output_tokens: 2_000 } } }));
    const evs = await collect(ds.chat({ body: { text: 'snooze the Globex VDP update until 14:00', context: [], model: 'sonnet' }, signal: new AbortController().signal } as never));
    expect(of(evs, 'spend-ask')).toHaveLength(1);
    expect(of(evs, 'error')[0]!.error).toMatchObject({ code: 'budget_exceeded', details: { allowMore: { scope: 'message' } } });
    const h = (await ds.listSpendHolds({ query: {} } as never)).holds[0]!;
    expect(h.state).toBe('settled');
    expect((await ds.getHealth({} as never)).spendAsks).toHaveLength(0);
  });

  it('an answer for a turn no longer waiting says so (resumed false)', async () => {
    useDs(mockWith({ runner: { askTimeoutMs: 20 }, fake: { usage: { input_tokens: 20_000, output_tokens: 2_000 } } }));
    const evs = await collect(ds.chat({ body: { text: 'snooze the Globex VDP update until 14:00', context: [], model: 'sonnet' }, signal: new AbortController().signal } as never));
    const ask = of(evs, 'spend-ask')[0]!;
    const r = await ds.chatSpendAnswer({ body: { holdId: ask.holdId, answer: 'approve', usd: 1 } } as never);
    expect(r.resumed).toBe(false);
    await expect(ds.chatSpendAnswer({ body: { holdId: '00000000-0000-0000-0000-000000000000', answer: 'deny' } } as never)).rejects.toThrow(/not found/i);
  });

  it('under its hold nothing asks', async () => {
    process.env.CC_CHAT_MESSAGE_USD = '5';
    const evs = await collect(ds.chat({ body: { text: 'snooze the Globex VDP update until 14:00', context: [], model: 'sonnet' }, signal: new AbortController().signal } as never));
    expect(of(evs, 'spend-ask')).toHaveLength(0);
    expect(of(evs, 'done')).toHaveLength(1);
    expect(of(evs, 'usage-delta').filter((e) => e.hold).at(-1)!.hold).toMatchObject({ state: 'open', held: 3 }); // the message's $5, within the $3 day line
  });
});
