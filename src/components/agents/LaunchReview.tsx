'use client';
/**
 * SEC-10 (docs/reviews/2026-11-20-holistic/17-security-review.md): a prepared Claude Code session runs with your
 * permissions, so before one opens you see the whole prompt it carries. The same two steps as the Assistant's
 * session card (`SessionCard`, src/components/chat/ChatActionCards.tsx): the first click is **Review prompt** (this
 * view: the folder and every line of the prompt, never a preview), and only the next click, **Open in Claude**,
 * hands the claude:// link to the OS. One component for every launch path: Agents (a run row's and the run panel's
 * Start in Claude, the header's Start in Claude) and Home (a card's Open in Claude, Coming builds).
 *
 * A claude://code/continue or needs-input link resumes a session you already opened and reviewed; it carries no
 * prompt, so it opens on its click as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, Icon } from '@/ui';
import { parseNewLink, shortPath } from './claude';

export const REVIEW_PROMPT_LABEL = 'Review prompt';
export const OPEN_IN_CLAUDE_LABEL = 'Open in Claude';
export const RUNS_WITH_YOUR_PERMISSIONS = 'This is the whole prompt the session starts with. Claude Code runs it with your permissions: open it only if it is what you want.';

/** A claude://code/new link carries a prompt, so it is reviewed first; continue / needs-input links resume a session. */
export function needsReview(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^claude:\/\/code\/new\?/.test(url);
}

/** The folder and the whole prompt of a claude://code/new link, with the permissions line. */
export function LaunchPromptReview({ url }: { url: string }) {
  const parsed = useMemo(() => parseNewLink(url), [url]);
  if (!parsed) return <p className="text-body text-muted">This link has no prompt to review.</p>;
  const lines = parsed.prompt ? parsed.prompt.replace(/\r\n/g, '\n').split('\n').length : 0;
  return (
    <div className="flex flex-col gap-2" data-testid="launch-preview" data-launch-review>
      <div>
        <p className="text-caption text-muted">Repo folder</p>
        <p className="font-mono text-caption text-fg" data-testid="launch-folder">
          {parsed.folder ? shortPath(parsed.folder) : 'Claude’s default folder'}
        </p>
      </div>
      <div>
        <p className="text-caption text-muted">{lines ? `The whole prompt · ${lines} line${lines === 1 ? '' : 's'}` : 'No prompt: a blank session'}</p>
        {parsed.prompt ? (
          <pre className="cc-scroll max-h-[50vh] overflow-auto rounded-md bg-surface-muted p-2 font-mono text-caption whitespace-pre-wrap text-fg" data-testid="launch-prompt" data-prompt-whole>
            {parsed.prompt}
          </pre>
        ) : null}
      </div>
      <p className="flex items-start gap-1.5 text-caption text-fg" data-launch-permissions>
        <Icon name="info" size="xs" className="mt-0.5 shrink-0" />
        {RUNS_WITH_YOUR_PERMISSIONS}
      </p>
    </div>
  );
}

/** Review prompt as a dialog: its one confirm is Open in Claude, which calls `onOpen` (the caller's opener). */
export function LaunchReviewDialog({ url, title, onOpen, onClose }: { url: string | null; title?: string; onOpen: (url: string) => void; onClose: () => void }) {
  // Focus goes back to what you clicked. The dialog often opens after a request (POST /agents/launch), and the
  // button that started it is disabled meanwhile, so the overlay's own restore finds the page body: remember the
  // last control clicked before the dialog opened and focus it on close when nothing else holds focus.
  // When the click swapped the control itself (Start in Claude becomes Open in Claude once the run exists), the
  // first control in its nearest ancestor still on the page takes focus instead.
  const trigger = useRef<HTMLElement[]>([]);
  const isOpen = !!url;
  useEffect(() => {
    if (isOpen) return;
    const remember = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.('button, a, [role="button"], [tabindex]');
      if (!(el instanceof HTMLElement)) return;
      const chain: HTMLElement[] = [el];
      for (let n = el.parentElement; n && chain.length < 4; n = n.parentElement) chain.push(n);
      trigger.current = chain;
    };
    document.addEventListener('click', remember, true);
    return () => document.removeEventListener('click', remember, true);
  }, [isOpen]);
  const close = () => {
    onClose();
    const chain = trigger.current;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const [el, ...up] = chain;
        if (el && document.contains(el)) return el.focus({ preventScroll: true });
        const near = up.find((n) => document.contains(n));
        near?.querySelector<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')?.focus({ preventScroll: true });
      }),
    );
  };
  return (
    <Dialog
      open={isOpen}
      onClose={close}
      title={title ? `${REVIEW_PROMPT_LABEL}: ${title}` : REVIEW_PROMPT_LABEL}
      width={600}
      confirmLabel={OPEN_IN_CLAUDE_LABEL}
      cancelLabel="Not now"
      onConfirm={() => {
        if (url) onOpen(url);
        close();
      }}
    >
      {url ? <LaunchPromptReview url={url} /> : null}
    </Dialog>
  );
}

/**
 * The two steps as a hook: `review(url, title)` shows the dialog for a link with a prompt, and opens any other
 * claude:// link at once (a resume). Render `dialog` once.
 */
export function useLaunchReview(open: (url: string) => void): { review: (url: string, title?: string) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<{ url: string; title?: string } | null>(null);
  const review = useCallback(
    (url: string, title?: string) => {
      if (needsReview(url)) setPending({ url, ...(title ? { title } : {}) });
      else open(url);
    },
    [open],
  );
  const dialog = <LaunchReviewDialog url={pending?.url ?? null} title={pending?.title} onOpen={open} onClose={() => setPending(null)} />;
  return { review, dialog };
}
