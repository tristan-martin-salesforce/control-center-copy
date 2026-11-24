// @vitest-environment jsdom
/**
 * "Why is this still open?" (W0-3): when the payload carries `reopenUndoId` the panel says "You reopened it" and offers
 * Undo reopen, which posts the existing POST /audit/:id/undo; without it there is no such affordance.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $, cleanup, click, render, waitFor } from '../../src/components/composer/__tests__/dom';

const { WhyOpen } = await import('@/components/detail/sections/why-open');

let calls: Array<{ method: string; path: string }>;
let reopenUndoId: string | null;

const check = {
  at: '2026-11-20T10:00:00.000Z', trigger: 'new_evidence', mode: 'live', decidedBy: 'rule', ruleHit: 'D1', verdict: 'done_sure', confidence: 0.9,
  outcome: 'left', blockedBy: 'user_reopened', escalated: false, costUsd: 0, citeSourceItemId: null, citeUrl: null, why: 'Checked: you reopened it.',
};

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/resolution-check')) return json({ itemId: 'w1', mode: 'live', last: check, history: [], nextCheck: 'when something new arrives', reopenUndoId });
    return json({ entity: { id: 'a1' }, auditId: 'a2' });
  });
});
afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, h(WhyOpen, { itemId: 'w1', now: '2026-11-21T10:00:00.000Z' })));

describe('WhyOpen: Undo reopen', () => {
  it('offers Undo reopen when you reopened it, wired to the existing undo route', async () => {
    reopenUndoId = '11111111-1111-4111-8111-111111111111';
    const { container } = await mount();
    await waitFor(() => $('[data-why-open-reopened]', container));
    expect($('[data-why-open-reopened]', container)!.textContent).toContain('You reopened it');
    await click($('[data-why-open-reopened] button', container)!);
    await waitFor(() => calls.some((c) => c.method === 'POST' && c.path.endsWith(`/audit/${reopenUndoId}/undo`)));
  });

  it('offers nothing when it was not reopened', async () => {
    reopenUndoId = null;
    const { container } = await mount();
    await waitFor(() => $('[data-why-open]', container));
    expect($('[data-why-open-reopened]', container)).toBeNull();
  });
});
