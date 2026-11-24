'use client';
// Composer's send status line and result link. Split from Composer.tsx (max-lines).
import { type Destination, type Draft, type TipTapDoc, isAdminDraft } from '@/contract';
import { serialize } from '@/lib/compose';
import { toComposeDestination } from './destination';
import type { SendState } from './send-flow';
import { Icon } from '@/ui';
import { cx } from './_bits';
import { stagedLine } from './Composer.types';

export function plainOf(doc: TipTapDoc, d: Destination): string {
  return String((serialize(doc, toComposeDestination(d)).payload as { text?: string }).text ?? '');
}
/** The persistent outcome line next to the footer actions (UI-SPEC §9: anything needing action persists). */
export function SendStatus(props: { state: SendState; draft: Draft; channel: string; inline?: boolean; onRetry: () => void; onDismiss: () => void }) {
  const body = sendStatusBody(props);
  if (!body) return null;
  return (
    <div
      data-tone={body.tone}
      className={cx(
        'flex min-w-0 items-center border-t border-line',
        props.inline ? 'px-2.5 py-1' : 'px-3 py-1.5',
        body.tone === 'risk' ? 'bg-danger-50' : body.tone === 'warn' ? 'bg-warning-50' : body.tone === 'ok' ? 'bg-success-50' : 'bg-surface-muted',
      )}
    >
      {body.node}
    </div>
  );
}
function sendStatusBody({ state, draft, channel, onRetry, onDismiss }: { state: SendState; draft: Draft; channel: string; onRetry: () => void; onDismiss: () => void }): { tone: 'risk' | 'warn' | 'ok' | 'neutral'; node: React.ReactNode } | null {
  if (state.phase === 'error' && state.error) {
    const e = state.error;
    const msg =
      e.stage === 'save'
        ? e.message
        : e.stage === 'preview'
          ? `Couldn't prepare the preview: ${e.message}`
          : e.code === 'upstream_unavailable'
            ? isAdminDraft(draft)
              ? `Couldn't apply it in ${channel}: ${e.message}. Nothing changed; it waits on Activity to Apply again.`
              : `Couldn't deliver to ${channel}: ${e.message}. Nothing was sent; it waits in the Outbox under Failed.`
            : e.message;
    // A failed dispatch is retried through a fresh preview + confirm (single-use confirm tokens, BE-OUTBOX).
    const retryLabel = e.stage === 'dispatch' ? 'Review and confirm again' : 'Retry';
    return { tone: 'risk', node: (
      <span role="alert" data-testid="send-status" data-outcome="error" data-reconfirm={e.stage === 'dispatch' || undefined} className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-danger-700">
        <Icon name="error" size="xs" />
        <span className="min-w-0">{msg}</span>
        <button type="button" onClick={onRetry} data-testid="send-retry" className="shrink-0 font-bold hover:underline focus-visible:shadow-focus focus-visible:outline-none">
          {retryLabel}
        </button>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 text-muted hover:text-fg">
          <Icon name="close" size="xs" className="size-2.5" />
        </button>
      </span>
    ) };
  }
  if (state.phase === 'done' && state.outcome) {
    if (state.outcome === 'dry_run') {
      return { tone: 'warn', node: (
        <span role="status" data-testid="send-status" data-outcome="dry_run" className="inline-flex items-center gap-1.5 text-caption text-warning-700">
          <Icon name="lock" size="xs" />
          Dry run: payload rendered, nothing sent
        </span>
      ) };
    }
    const v = draft.verification;
    const verified = v?.state === 'verified';
    const action = draft.destination.kind === 'action';
    // an action (a canvas, a VDP change, the feedback post) is applied, and its result is one click away once it exists
    // a pushed draft waits in its app for you to send it: say where ("Saved as Slack draft · find it in Slack ▸ Drafts")
    const head = action ? (draft.status === 'sending' ? 'Applying' : 'Applied') : state.outcome === 'staged' ? stagedLine(draft.destination, channel) : 'Sent';
    const tail = verified ? 'Verified ✓' : v?.state === 'pending' || !v ? 'Verifying…' : action ? 'Not verified' : 'Not verified · check Outbox';
    return { tone: verified ? 'ok' : 'neutral', node: (
      <span role="status" data-testid="send-status" data-outcome={state.outcome} className={cx('inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption', verified ? 'text-success-700' : 'text-muted')}>
        <Icon name={verified ? 'success' : 'send'} size="xs" />
        {head} · {tail}
        {draft.resultUrl ? <ResultLink href={draft.resultUrl} /> : null}
      </span>
    ) };
  }
  if (state.phase === 'idle' && state.undone) {
    return { tone: 'neutral', node: (
      <span role="status" data-testid="send-status" data-outcome="undone" className="inline-flex items-center gap-1.5 text-caption text-muted">
        <Icon name="undo" size="xs" />
        Undone. Nothing was sent.
      </span>
    ) };
  }
  if (['sent', 'verified', 'staged', ...(draft.destination.kind === 'action' ? ['sending', 'verify_failed'] : [])].includes(draft.status)) {
    const verified = draft.verification?.state === 'verified';
    const action = draft.destination.kind === 'action';
    return { tone: verified ? 'ok' : 'neutral', node: (
      <span data-testid="send-status" data-outcome={draft.status} className={cx('inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption', verified ? 'text-success-700' : 'text-muted')}>
        <Icon name={verified ? 'success' : 'send'} size="xs" />
        {action ? (draft.status === 'sending' ? 'Applying…' : 'Applied') : draft.status === 'staged' ? stagedLine(draft.destination, channel) : 'Sent'}
        {verified ? ' · Verified ✓' : action && draft.status === 'verify_failed' ? ' · Not verified' : ''}
        {draft.resultUrl ? <ResultLink href={draft.resultUrl} /> : null}
      </span>
    ) };
  }
  return null;
}
/** "Open ↗": where the applied or sent result lives (`Draft.resultUrl`). */
function ResultLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" data-testid="send-result-link" title={href} className="inline-flex items-center gap-1 font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
      · Open <Icon name="new_window" size="xs" />
    </a>
  );
}
