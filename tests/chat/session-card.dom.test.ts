// @vitest-environment jsdom
/**
 * SEC-10: the session card shows the whole prompt before Claude Code opens it. The first click on the primary is
 * Review prompt (the clamp lifts, the note says it runs with your permissions); only the next click opens the link.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { $, cleanup, click, render } from '@/components/composer/__tests__/dom';

const prompt = `Refactor the importer.\n${'Step detail line. '.repeat(40)}\nFinally: run the tests.`;
const run = {
  id: 'run_1',
  kind: 'claude_session',
  title: 'Refactor the importer',
  state: 'queued',
  startedAt: '2026-11-21T09:00:00.000Z',
  updatedAt: '2026-11-21T09:00:00.000Z',
  deepLink: `claude://code/new?folder=${encodeURIComponent('/tmp/repo')}&q=${encodeURIComponent(`${prompt}\n\n[cc:run_1]`)}`,
  cwd: '/tmp/repo',
};
vi.mock('@/client/hooks', () => ({ useApi: () => ({ data: { runs: [run] }, isSuccess: true, isError: false }) }));

const { SessionCard } = await import('@/components/chat/ChatActionCards');

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('SessionCard (SEC-10)', () => {
  it('Review prompt first, then Open in Claude; the deep link opens only on the second click', async () => {
    const opened: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      if (this.dataset.ccDeepLink) opened.push(this.href);
    });
    await render(h(SessionCard, { resource: { kind: 'session', id: 'run_1', label: 'Refactor the importer', href: '/agents?run=run_1' } as never }));
    const primary = () => $('[data-open-claude]')!;
    expect(primary().textContent).toBe('Review prompt');
    expect($('[data-prompt-whole]')).toBeNull();
    await click(primary());
    expect(opened).toEqual([]);
    expect($('[data-prompt-whole]')!.textContent).toContain('Finally: run the tests.');
    expect(document.body.textContent).toMatch(/whole prompt the Assistant wrote in this thread/);
    expect(primary().textContent).toBe('Open in Claude');
    await click(primary());
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^claude:\/\/code\/new\?/);
  });
});
