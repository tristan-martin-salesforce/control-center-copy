/**
 * The spend-ask cards (H-5): the Assistant's raise-hand card in the stream and Health's needs-you row. A neutral
 * question with Allow $Z more · Stop (the Assistant) or Allow $Z more · Allow for today · Stop (Health); never a red
 * error. Static markup, placeholder ids only.
 */
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { SpendAskCard } from '@/components/chat/SpendAskCard';
import { SpendAskRows } from '@/components/health/SpendAsks';
import { reduceTurn, startTurn } from '@/client/chat/turn';

(globalThis as { React?: typeof React }).React = React;

const ask = { holdId: 'h1', question: 'This answer has used $0.27 of its $0.25 limit; allow $0.13 more?', spentUsd: 0.27, heldUsd: 0.25, moreUsd: 0.13 };

describe('the Assistant raise-hand card', () => {
  it('asks the plain question with Allow $Z more and Stop, not as an alert', () => {
    const html = renderToStaticMarkup(createElement(SpendAskCard, { ask }));
    expect(html).toContain(ask.question);
    expect(html).toContain('Allow $0.13 more');
    expect(html).toContain('data-spend-allow="0.13"');
    expect(html).toContain('Stop');
    expect(html).not.toContain('role="alert"');
  });

  it('the live turn keeps the ask from `spend-ask` until the hold moves on', () => {
    let t = startTurn({ threadId: 't', text: 'q', context: [], baseIds: [] });
    t = reduceTurn(t, { type: 'start', threadId: 't', messageId: 'm', userMessageId: 'u', model: 'sonnet' });
    t = reduceTurn(t, { type: 'spend-ask', messageId: 'm', ...ask });
    expect(t.spendAsk).toMatchObject({ holdId: 'h1', moreUsd: 0.13 });
    t = reduceTurn(t, { type: 'usage-delta', messageId: 'm', spentUsd: 0.27, model: 'claude-sonnet-5-5', hold: { p50: 0.1, p90: 0.35, spent: 0.27, held: 0.38, state: 'approved' } });
    expect(t.spendAsk).toBeNull();
    expect(t.hold).toMatchObject({ state: 'approved', held: 0.38 });
  });
});

describe("Health's needs-you row", () => {
  it('lists each open ask with its three answers', () => {
    const qc = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement('ul', null, createElement(SpendAskRows, { asks: [{ ...ask, scope: 'scan_run', question: 'This scan has used $0.05 of its $0.04 estimate and is 62% done; allow $0.02 more?', moreUsd: 0.02, askedAt: '2026-11-20T15:00:00.000Z' }] }))));
    expect(html).toContain('This scan has used $0.05 of its $0.04 estimate and is 62% done; allow $0.02 more?');
    expect(html).toContain('Allow $0.02 more');
    expect(html).toContain('Allow for today');
    expect(html).toContain('data-spend-stop');
  });
});

