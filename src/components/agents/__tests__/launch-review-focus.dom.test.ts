// @vitest-environment jsdom
/**
 * 24-visual-qa, surface 2: Review prompt gives focus back to what you clicked.
 * The dialog usually opens after POST /agents/launch, and the button that started it is disabled meanwhile (a browser
 * then drops its focus to the page), so the overlay's own restore found the body: Home's Coming builds and the
 * Details panel's Start in Claude both left focus on the page after Not now / Esc.
 */
import { createElement as h, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { $, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';
import { LaunchReviewDialog } from '@/components/agents/LaunchReview';

const LINK = `claude://code/new?folder=${encodeURIComponent('/tmp/repo')}&q=${encodeURIComponent('Build the demo org\n[cc:w_1]')}`;

/** A launch button like Home's: disabled (and so blurred) while the request runs, then the review opens. */
function Harness({ swap }: { swap?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  return h(
    'div',
    { 'data-row': true },
    swap && started
      ? h('button', { type: 'button', 'data-after': true }, 'Open in Claude')
      : h(
          'button',
          {
            type: 'button',
            'data-trigger': true,
            disabled: busy,
            onClick: (e: { currentTarget: HTMLButtonElement }) => {
              e.currentTarget.blur();
              setBusy(true);
              setTimeout(() => {
                setBusy(false);
                setStarted(true);
                setUrl(LINK);
              }, 5);
            },
          },
          'Review prompt',
        ),
    h(LaunchReviewDialog, { url, title: 'Demo org', onOpen: () => undefined, onClose: () => setUrl(null) }),
  );
}

afterEach(async () => {
  await cleanup();
});

const notNow = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Not now') ?? null;

describe('Review prompt: focus returns on close', () => {
  it('to the button that opened it, though the launch blurred it', async () => {
    await render(h(Harness));
    await click($('[data-trigger]'));
    await waitFor(() => notNow());
    await click(notNow());
    await waitFor(() => (document.activeElement === $('[data-trigger]') ? true : null));
  });

  it('to the control that replaced it, when the launch swapped the button', async () => {
    await render(h(Harness, { swap: true }));
    await click($('[data-trigger]'));
    await waitFor(() => notNow());
    await click(notNow());
    await waitFor(() => (document.activeElement === $('[data-after]') ? true : null));
    expect(document.activeElement).not.toBe(document.body);
  });
});
