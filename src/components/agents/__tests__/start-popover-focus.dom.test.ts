// @vitest-environment jsdom
/**
 * 24-visual-qa, surface 2: the Agents header's Start in Claude popover. Review prompt replaces the form (and the
 * button you pressed), so focus moves to Not now, as the Review prompt dialog's does, instead of falling to the page
 * (Esc then had nothing to close from). The title reads like the dialog's: "Review prompt: <title>", no quotes.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';

const url = `claude://code/new?folder=${encodeURIComponent('/tmp/repo')}&q=${encodeURIComponent('Do the thing')}`;
vi.mock('@/client/hooks', () => ({ useApi: () => ({ data: { items: [] }, isSuccess: true }) }));
vi.mock('@/client/api', async (orig) => ({ ...(await orig<typeof import('@/client/api')>()), api: async () => ({ url, run: { title: 'Fix the importer' } }) }));
vi.mock('@tanstack/react-query', async (orig) => ({ ...(await orig<typeof import('@tanstack/react-query')>()), useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }) }));

const { StartInClaude } = await import('@/components/agents/StartInClaude');

afterEach(async () => {
  await cleanup();
});

describe('Start in Claude popover', () => {
  it('Review prompt focuses Not now and titles the review like the dialog', async () => {
    await render(h(StartInClaude, { open: true, onOpenChange: () => {} }));
    const review = await waitFor(() => $('[data-testid="start-claude-review"]'));
    review.focus();
    await click(review);
    const notNow = await waitFor(() => $('[data-testid="start-claude-not-now"]'));
    await waitFor(() => (document.activeElement === notNow ? true : null));
    expect(document.body.textContent).toContain('Review prompt: Fix the importer');
    expect(document.body.textContent).not.toContain('“Fix the importer”');
  });
});
