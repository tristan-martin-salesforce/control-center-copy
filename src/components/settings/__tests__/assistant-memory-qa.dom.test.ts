// @vitest-environment jsdom
/**
 * 24-visual-qa, surface 1: Settings ▸ Budgets ▸ What the Assistant remembers.
 * - Forget for good removes the row and its button; focus moves to the next entry's Forget (else the list), never
 *   to the page body.
 * - The block sits after the Budgets sections on the same pane, so it keeps the section gutter (it touched the
 *   pane's edge, with Forget clipped at the right).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $, $$, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';
import { AssistantMemoryBlock } from '@/components/settings/AssistantMemory';

const entry = (id: string, text: string) => ({ id, threadId: null, kind: 'preference', text, pinned: true, coversThroughSeq: null, createdAt: '2026-11-05T15:58:00Z', source: null });
let entries: ReturnType<typeof entry>[];

beforeEach(() => {
  entries = [entry('mem_1', 'Short replies'), entry('mem_2', 'Sonnet for drafts')];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      const id = url.pathname.split('/').at(-2);
      entries = entries.filter((e) => e.id !== id);
      return new Response(JSON.stringify({ deleted: true }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ entries }), { headers: { 'content-type': 'application/json' } });
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } }) }, h(AssistantMemoryBlock)));

describe('What the Assistant remembers: focus after Forget for good', () => {
  it('moves to the next entry’s Forget, then to the list when the last one goes', async () => {
    await mount();
    await waitFor(() => ($$('[data-memory]').length === 2 ? true : null));
    const forget = (id: string) => $(`[data-memory="${id}"] [data-memory-forget]`) as HTMLElement;
    await click(forget('mem_1'));
    await click(forget('mem_1'));
    await waitFor(() => (!$('[data-memory="mem_1"]') ? true : null));
    await waitFor(() => (document.activeElement === forget('mem_2') ? true : null));

    await click(forget('mem_2'));
    await click(forget('mem_2'));
    await waitFor(() => ($('[data-memory-empty]') ? true : null));
    await waitFor(() => (document.activeElement === $('[data-testid="assistant-memory"]') ? true : null));
  });
});

describe('a block after a section keeps the section gutter', () => {
  it('settings.module.css pads a pane-level block like .sec', () => {
    const css = readFileSync(path.join(__dirname, '..', 'settings.module.css'), 'utf8');
    const sec = /\.sec \{\s*padding: 0 (\d+)px/.exec(css)?.[1];
    const block = /\.spane > \.block \{\s*padding-left: (\d+)px;\s*padding-right: (\d+)px/.exec(css);
    expect(sec).toBeDefined();
    expect(block?.[1]).toBe(sec);
    expect(block?.[2]).toBe(sec);
  });
});
