// @vitest-environment jsdom
/**
 * SEC-10 on the Agents page: Start in Claude on a run row (and the run panel, which renders the same dialog) is
 * Review prompt first: the whole prompt, not a 20-line preview, and "runs with your permissions"; only its Open in
 * Claude click hands the claude:// link on. A resume link (claude://code/continue) carries no prompt and opens on its
 * click as before.
 */
import { act, createElement as h, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, $$, cleanup, click, render } from '@/components/composer/__tests__/dom';
import { LaunchReviewDialog, needsReview, useLaunchReview } from '@/components/agents/LaunchReview';
import { StartConfirmDialog } from '@/components/agents/StartInClaude';

const lines = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: do the next thing.`);
const prompt = `${lines.join('\n')}\nFinally: run the tests.\n\n[cc:wi_1]`;
const url = `claude://code/new?folder=${encodeURIComponent('/Users/someone/Projects/repo')}&q=${encodeURIComponent(prompt)}`;

afterEach(async () => {
  await cleanup();
  delete window.__ccOpenUrl;
});

const confirmButton = () => $$('button').find((b) => b.textContent?.trim() === 'Open in Claude');

describe('Agents ▸ Start in Claude (SEC-10)', () => {
  it('the run row’s dialog is Review prompt with the whole prompt; Open in Claude opens it once', async () => {
    const opened: string[] = [];
    window.__ccOpenUrl = (u) => opened.push(u);
    await render(h(StartConfirmDialog, { url, title: 'Refactor the importer', onClose: () => {} }));
    expect(document.body.textContent).toContain('Review prompt: Refactor the importer');
    const whole = $('[data-prompt-whole]')!;
    expect(whole.textContent).toContain('Step 40: do the next thing.');
    expect(whole.textContent).toContain('Finally: run the tests.');
    expect(document.body.textContent).toContain('The whole prompt · 43 lines');
    expect($('[data-launch-permissions]')!.textContent).toMatch(/Claude Code runs it with your permissions/);
    expect($('[data-testid="launch-folder"]')!.textContent).toBe('~/Projects/repo');
    expect(opened).toEqual([]);
    await click(confirmButton());
    expect(opened).toEqual([url]);
  });

  it('Not now closes it and nothing opens', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    await render(h(LaunchReviewDialog, { url, title: 'x', onOpen, onClose }));
    await click($$('button').find((b) => b.textContent?.trim() === 'Not now'));
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('useLaunchReview: a new-session link is reviewed first; a resume link opens on the click', async () => {
    const onOpen = vi.fn();
    let api: ReturnType<typeof useLaunchReview> | null = null;
    function Harness() {
      const r = useLaunchReview(onOpen);
      useEffect(() => {
        api = r;
      });
      return h('div', null, r.dialog);
    }
    await render(h(Harness));
    await act(async () => api!.review('claude://code/continue?session=local_1', 'Resume'));
    expect(onOpen).toHaveBeenCalledWith('claude://code/continue?session=local_1');
    expect($('[data-launch-review]')).toBeNull();
    await act(async () => api!.review(url, 'New one'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect($('[data-launch-review]')).not.toBeNull();
    await click(confirmButton());
    expect(onOpen).toHaveBeenLastCalledWith(url);
    expect(needsReview(url) && !needsReview('claude://code/needs-input')).toBe(true);
  });
});
