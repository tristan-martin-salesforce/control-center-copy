// @vitest-environment jsdom
/**
 * SEC-10 in the Assistant's thread pane ("In this thread"): a session row whose run carries a claude://code/new link
 * says Review prompt and shows the whole prompt first; only the dialog's Open in Claude opens it. A resume link opens
 * on its click.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, $$, cleanup, click, render } from '@/components/composer/__tests__/dom';

const prompt = `Refactor the importer.\n${'Step detail line.\n'.repeat(30)}Finally: run the tests.`;
const runs = [
  { id: 'run_new', kind: 'claude_session', title: 'Refactor the importer', state: 'queued', deepLink: `claude://code/new?folder=%2Ftmp%2Frepo&q=${encodeURIComponent(prompt)}` },
  { id: 'run_live', kind: 'claude_session', title: 'Live one', state: 'running', deepLink: 'claude://code/continue?session=local_9' },
];
vi.mock('@/client/hooks', () => ({ useApi: () => ({ data: { runs }, isPending: false, isSuccess: true, isError: false }) }));

const { SessionRow } = await import('@/components/chat/ThreadContextPane');

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('Thread pane ▸ session row (SEC-10)', () => {
  it('Review prompt first for a prepared session; a running one opens on its click', async () => {
    const opened: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      opened.push(this.href);
    });
    await render(h('ul', null, h(SessionRow, { resource: { kind: 'agent_run', id: 'run_new', label: 'x', href: '/agents' } as never }), h(SessionRow, { resource: { kind: 'agent_run', id: 'run_live', label: 'y', href: '/agents' } as never })));
    const [fresh, live] = $$('[data-open-claude]');
    expect(fresh!.textContent).toBe('Review prompt');
    expect(live!.textContent).toBe('Open in Claude');
    await click(live);
    expect(opened).toEqual(['claude://code/continue?session=local_9']);
    await click(fresh);
    expect($('[data-launch-review] [data-prompt-whole]')!.textContent).toContain('Finally: run the tests.');
    expect($('[data-launch-permissions]')!.textContent).toMatch(/runs it with your permissions/);
    expect(opened).toHaveLength(1);
    await click($$('[role="alertdialog"] button').find((b) => b.textContent?.trim() === 'Open in Claude'));
    expect(opened).toHaveLength(2);
    expect(opened[1]).toMatch(/^claude:\/\/code\/new\?/);
  });
});
