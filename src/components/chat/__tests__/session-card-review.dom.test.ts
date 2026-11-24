// @vitest-environment jsdom
/**
 * 24-visual-qa, surface 2: the Assistant's session card reviews the prompt the way the Review prompt dialog does.
 * Reviewed, it says how many lines the whole prompt has, shows every character the session starts with (the
 * report-back tag too: the preview drops it, the review does not), and puts "runs with your permissions" above
 * Open in Claude, not under it.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, cleanup, click, render } from '@/components/composer/__tests__/dom';

const prompt = 'Refactor the importer.\nStep two.\nFinally: run the tests.\n\n[cc:run_1]';
const run = {
  id: 'run_1',
  kind: 'claude_session',
  title: 'Refactor the importer',
  state: 'queued',
  startedAt: '2026-11-21T09:00:00.000Z',
  updatedAt: '2026-11-21T09:00:00.000Z',
  deepLink: `claude://code/new?folder=${encodeURIComponent('/tmp/repo')}&q=${encodeURIComponent(prompt)}`,
  cwd: '/tmp/repo',
};
vi.mock('@/client/hooks', () => ({ useApi: () => ({ data: { runs: [run] }, isSuccess: true, isError: false }) }));

const { SessionCard } = await import('@/components/chat/ChatActionCards');

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('SessionCard review', () => {
  it('line count, the whole prompt with its tag, and the permissions line before the buttons', async () => {
    await render(h(SessionCard, { resource: { kind: 'session', id: 'run_1', label: 'Refactor the importer', href: '/agents?run=run_1' } as never }));
    expect(document.body.textContent).not.toContain('[cc:run_1]');
    await click($('[data-open-claude]'));
    expect(document.body.textContent).toContain('The whole prompt · 5 lines');
    expect($('[data-prompt-whole]')!.textContent).toContain('[cc:run_1]');
    const note = $('[data-launch-permissions]')!;
    expect(note.textContent).toMatch(/runs it with your permissions/);
    expect(note.compareDocumentPosition($('[data-open-claude]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
