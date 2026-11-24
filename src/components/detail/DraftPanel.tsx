'use client';
/**
 * DraftPanel: the v2 docked panel's Details renderer for a `draft` entity (a read-in's suggested reply, an
 * Outbox draft opened from anywhere). V2-SHELL registers it: `registerDetailRenderer('draft', (e) => renderDraftPanel(e.id))`.
 *
 * Same calm anatomy as the work-item panel: a small head (section · channel · status), the message it replies to
 * ("Replying to", rich, with Open in Slack / Gmail), the draft in the composer, and the sticky footer holding the ONE
 * filled action (the composer's Send / Push as draft, and the countdown's Undo) plus a quiet way to the task it
 * belongs to. Nothing sends until you confirm; dry run shows beside the Draft/Send toggle.
 *
 * The approval queue (lib/draft-queue): when the page that opened this draft published a queue holding it
 * (Home's "Approve N drafts" card), the head shows "‹ 3 of 29 ›" and, once this draft leaves `ready` (pushed,
 * sent, scheduled or rejected here), the panel moves on to the next ready draft. Plain j/k stay the page's.
 *
 * An admin item (a logging or forecast canvas, a VDP change, the feedback post) names its action family and target in
 * the head ("Logging canvas · Slack"), and after Apply it stays on the item: the outcome (applying, applied, verified),
 * "Open ↗" to the result and a canvas's Slackbot prompt, with Next for the rest of the queue. Only Reject moves on.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Draft, DraftStatus, Tone } from '@/contract';
import { adminSurfaceOf } from '@/contract';
import { api, queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { Composer, destinationLabel, SendCountdownToast, type ComposerHandle, type ComposerPrimaryState } from '@/components/composer';
import { useFollowWhenGone } from '@/components/lists/panel';
import { markGone } from '@/components/lists/gone';
import { isLocalChange } from '@/client/intent';
import { useRightPanel } from '@/components/shell/panel';
import { Button, EmptyState, IconButton, PanelBoundary, PanelError, Skeleton, StatePill, useTimeZone } from '@/ui';
import { CanvasRunStatus } from '@/components/time/CanvasRuns';
import { isWithdrawnDraft } from '@/outbox/withdraw';
import { isReleaseItem, releaseRowFacts } from '@/outbox/adapters/release-handoff';
import { actionHeading } from '@/lib/actions';
import { maybeDelivered } from '@/lib/canvas/payload';
import { CopyPromptButton, OpenResult, useCanvasPromptOf } from '@/components/domain/ResultLinks';
import { queuePosition, useDraftQueue } from './lib/draft-queue';
import { stagedLabel, stagedWhere } from '@/components/lists/outbox';
import { ReplyingTo } from './ReplyingTo';

const STATUS: Partial<Record<DraftStatus, { tone: Tone; label: string }>> = {
  drafting: { tone: 'ai', label: '✦ Drafted for you' },
  ready: { tone: 'ok', label: '✓ Ready to approve' },
  scheduled: { tone: 'neutral', label: '◷ Scheduled' },
  sending: { tone: 'brand', label: '● Sending' },
  sent: { tone: 'ok', label: '✓ Sent' },
  staged: { tone: 'ok', label: '✓ Saved as draft' },
  verified: { tone: 'ok', label: '✓ Verified' },
  verify_failed: { tone: 'warn', label: '▲ Not verified' },
  failed: { tone: 'risk', label: '✕ Failed' },
  rejected: { tone: 'neutral', label: '– Rejected' },
  discarded: { tone: 'neutral', label: '– Discarded' },
};
/** OUTBOX-W: a pending draft the app withdrew when its to-do closed (the reason says why; reopening keeps it out). */
const WITHDRAWN = { tone: 'neutral' as Tone, label: '– Withdrawn: the to-do closed' };

export interface DraftPanelProps {
  draftId: string;
  /** Open the task the draft belongs to (default: the panel retargets to it). */
  onOpenItem?: (workItemId: string) => void;
  /** Open another draft of the queue (default: the panel retargets to it). */
  onOpenDraft?: (draftId: string) => void;
}

/**
 * Statuses that take a draft out of the approval queue, with the toast shown when the panel moves on (null: the
 * action already said so, as Reject's toast does). A failed send stays put, so you see why.
 */
const LEFT_QUEUE: Partial<Record<DraftStatus, string | null>> = {
  sending: 'Sending',
  sent: 'Sent',
  staged: 'Saved as draft',
  verified: 'Sent',
  verify_failed: 'Sent',
  scheduled: 'Scheduled',
  rejected: null,
  discarded: null,
};

/** An action is applied, not sent: its head pill says so. */
const ACTION_STATUS: Partial<Record<DraftStatus, { tone: Tone; label: string }>> = {
  ready: { tone: 'ok', label: '✓ Ready to apply' },
  sending: { tone: 'brand', label: '● Applying' },
  sent: { tone: 'ok', label: '✓ Applied' },
  staged: { tone: 'ok', label: '✓ Applied' },
  verified: { tone: 'ok', label: '✓ Applied · verified' },
  verify_failed: { tone: 'warn', label: '▲ Applied · not verified' },
};

/** A release item whose folder or channel isn't set (D-90). */
const SET_UP_FIRST: { tone: Tone; label: string } = { tone: 'warn', label: '▲ Set up first' };

/** An admin item stays put after Apply (it shows the outcome); only these take it out of the queue. */
const ACTION_LEFT_QUEUE: ReadonlySet<DraftStatus> = new Set(['rejected', 'discarded']);

/** An applied action's outcome line (the panel's body, once Apply ran). */
const ACTION_OUTCOME: Partial<Record<DraftStatus, string>> = {
  sending: 'Applying: on its way. The result links here once it exists.',
  sent: 'Applied.',
  staged: 'Applied.',
  verified: 'Applied and read back ✓',
  verify_failed: 'Applied, but the read-back did not confirm it: open it to check.',
  failed: "Couldn't apply it: nothing changed. Apply again shows a fresh preview.",
};

/** B3: the last Apply got no answer (or the app stopped mid-way): it may have landed. */
function maybeApplied(d: Draft): string {
  const dest = d.destination;
  if (dest.kind === 'action' && dest.action === 'slack_canvas.create') return "No answer to the last Apply: the canvas may have been created. Check Slack first; Apply again only if it isn't there (a second canvas would be a second work order).";
  const where = dest.kind === 'action' && dest.action.startsWith('vdp.') ? 'VDP' : 'Slack';
  return `No answer to the last Apply: it may have gone through. Check ${where} first; Apply again only if it isn't there.`;
}

export function DraftPanel(props: DraftPanelProps) {
  return (
    <PanelBoundary name="draft.panel" resetKeys={[props.draftId]}>
      <DraftPanelBody {...props} />
    </PanelBoundary>
  );
}

function DraftPanelBody({ draftId, onOpenItem, onOpenDraft }: DraftPanelProps) {
  const q = useApi('getDraft', { params: { id: draftId } });
  if (q.isLoading)
    return (
      <div className="space-y-4 p-6" aria-busy aria-label="Loading draft">
        <Skeleton variant="line" className="w-48" />
        <Skeleton variant="line" className="w-3/4" />
        <Skeleton variant="block" className="h-40 w-full" />
      </div>
    );
  if (q.error && !q.data)
    return (
      <div className="p-6">
        {q.error.code === 'not_found' ? (
          <EmptyState size="panel" icon="search" title="This draft no longer exists" body="It may have been sent, discarded or merged." />
        ) : (
          <PanelError title="This draft failed to load" error={q.error} onRetry={() => void q.refetch()} />
        )}
      </div>
    );
  if (!q.data) return <EmptyState size="panel" icon="email" title="Nothing to show" body="Pick a draft to review it." />;
  return <Loaded draft={q.data} onOpenItem={onOpenItem} onOpenDraft={onOpenDraft} />;
}

function Loaded({ draft, onOpenItem, onOpenDraft }: { draft: Draft; onOpenItem?: (workItemId: string) => void; onOpenDraft?: (draftId: string) => void }) {
  const panel = useRightPanel();
  const qc = useQueryClient();
  const ref = useRef<ComposerHandle>(null);
  const [p, setP] = useState<ComposerPrimaryState | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const task = useApi('getItem', { params: { id: draft.workItemId ?? '' } }, { enabled: !!draft.workItemId });
  // a release item with no Drive folder / channel can't go (D-90): it says what to set, never "Ready to apply"
  const releaseMissing = draft.status === 'ready' && draft.destination.kind === 'action' && isReleaseItem(draft.destination) ? releaseRowFacts(draft.destination).missing : null;
  const status = isWithdrawnDraft(draft) ? WITHDRAWN : releaseMissing ? SET_UP_FIRST : ((draft.destination.kind === 'action' ? ACTION_STATUS[draft.status] : undefined) ?? STATUS[draft.status]);
  const channel = draft.destination.kind === 'slack' ? 'Slack' : 'Email';
  const openItem = draft.workItemId ? () => (onOpenItem ? onOpenItem(draft.workItemId!) : panel.openDetails({ kind: 'work_item', id: draft.workItemId! })) : null;

  // ---- the approval queue -------------------------------------------------------------------------
  const queue = useDraftQueue();
  const { openDetails } = panel;
  const openDraft = useCallback((id: string) => (onOpenDraft ? onOpenDraft(id) : openDetails({ kind: 'draft', id })), [onOpenDraft, openDetails]);
  const pos = queue && queue.ids.length > 1 ? queuePosition(queue.ids, draft.id) : null;
  // This draft counts as gone from the queue the moment it is pushed, sent, scheduled or rejected here, before
  // the page refetches; then the panel moves on to its neighbour (useFollowWhenGone, as the Outbox's list does).
  // An admin item stays after Apply, showing its outcome and link; Next (or the queue arrows) moves on.
  const isAction = draft.destination.kind === 'action';
  const gone = isAction ? ACTION_LEFT_QUEUE.has(draft.status) : draft.status in LEFT_QUEUE;
  const live = useMemo(() => (queue ? queue.ids.filter((id) => id !== draft.id || !gone) : []), [queue, draft.id, gone]);
  const advance = useCallback(
    (next: string) => {
      const done = LEFT_QUEUE[draft.status];
      // a pushed draft: say where it waits ("Saved as Slack draft", find it in Slack ▸ Drafts)
      const where = draft.status === 'staged' ? stagedWhere(draft.destination) : null;
      if (done) toast({ key: `draft-queue:${draft.id}`, title: draft.status === 'staged' ? (stagedLabel(draft.destination) ?? done) : done, body: `${where ? `Find it ${where}. ` : ''}On to the next draft.`, tone: 'success' });
      openDraft(next);
    },
    [draft.id, draft.status, draft.destination, openDraft],
  );
  // Sent or applied elsewhere (not from this panel): stay on it and say so (docs/UX.md "Live updates").
  useFollowWhenGone(live, draft.id, advance, queue?.owner ?? '', { goneTitle: 'Sent or applied elsewhere', goneBody: 'This draft changed somewhere else while it was open here. It stays open so you can read it.', nextLabel: 'Next draft' });
  // Open from any page (the Outbox lists sent drafts too, so the row only moves): a draft sent, pushed or removed
  // elsewhere while you have it open says so in the panel, never with a toast (docs/UX.md "Live updates").
  const lastStatus = useRef<{ id: string; status: DraftStatus }>({ id: draft.id, status: draft.status });
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = { id: draft.id, status: draft.status };
    if (was.id !== draft.id || was.status === draft.status) return;
    const leftNow = isAction ? ACTION_LEFT_QUEUE.has(draft.status) : draft.status in LEFT_QUEUE;
    const leftBefore = isAction ? ACTION_LEFT_QUEUE.has(was.status) : was.status in LEFT_QUEUE;
    if (!leftNow || leftBefore || isLocalChange(draft.id)) return;
    const removed = draft.status === 'rejected' || draft.status === 'discarded';
    markGone(draft.id, {
      title: removed ? 'Removed elsewhere' : 'Sent or applied elsewhere',
      body: removed ? 'This draft was rejected or withdrawn somewhere else while it was open here.' : 'This draft went out from somewhere else while it was open here. Nothing more to approve; it stays open so you can read it.',
    });
  }, [draft.id, draft.status, isAction]);

  const reject = async () => {
    setRejecting(true);
    try {
      const r = await api('rejectDraft', { params: { id: draft.id }, body: {} });
      qc.setQueryData(queryKey('getDraft', { params: { id: draft.id } }), r.entity);
      void qc.invalidateQueries({ queryKey: ['outbox'] });
      void qc.invalidateQueries({ queryKey: ['home'] });
      toast({ key: `outbox:${draft.id}`, title: 'Draft rejected', body: 'Nothing was sent. The task stays open.', ...(r.auditId ? { undo: { auditId: r.auditId } } : {}) });
    } catch (err) {
      toast({ key: `outbox:${draft.id}`, tone: 'error', title: "Couldn't reject the draft", body: err instanceof Error ? err.message : undefined, durationMs: null });
    } finally {
      setRejecting(false);
    }
  };
  const busy = !!p?.countdown || !!p?.busyLabel;
  const heading = draft.destination.kind === 'action' ? actionHeading(draft.destination) : null;
  const prompt = useCanvasPromptOf()(draft);
  const tz = useTimeZone();
  // B3: no answer to the last Apply (or the app stopped mid-way): it may exist, so never "nothing changed"
  const outcome = isAction ? (maybeDelivered(draft) ? maybeApplied(draft) : ACTION_OUTCOME[draft.status]) : undefined;
  const nextInQueue = isAction && outcome && draft.status !== 'failed' && pos?.next ? pos.next : null;

  return (
    <div
      tabIndex={-1}
      data-draft-panel={draft.id}
      className="@container/panel flex h-full min-h-0 flex-col bg-surface focus:outline-none"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.defaultPrevented) {
          e.preventDefault();
          if (!releaseMissing) ref.current?.send();
        }
      }}
    >
      <header className="shrink-0 space-y-2 border-b border-line px-6 pt-4 pb-4">
        <div className="flex min-w-0 items-center gap-2 text-caption text-muted">
          <span className="shrink-0" data-draft-kind>{heading ? heading.kind : 'Reply and approve'}</span>
          <span className="inline-flex h-6 shrink-0 items-center rounded-sm border border-line-strong bg-surface-sunken px-2 text-caption font-bold text-fg">{heading ? heading.where : channel}</span>
          {status ? <StatePill tone={status.tone} icon={false} label={status.label} size="md" /> : null}
          {pos ? (
            <nav aria-label="Drafts to approve" data-draft-queue className="ml-auto flex shrink-0 items-center gap-0.5">
              <IconButton icon="chevronleft" label="Previous draft" title="Previous draft" size="sm" disabled={!pos.prev} onClick={() => pos.prev && openDraft(pos.prev)} data-queue="prev" />
              <span className="px-1 text-caption text-muted tabular-nums" aria-live="polite" data-queue-position>
                {pos.index + 1} of {pos.total}
              </span>
              <IconButton icon="chevronright" label="Next draft" title="Next draft" size="sm" disabled={!pos.next} onClick={() => pos.next && openDraft(pos.next)} data-queue="next" />
            </nav>
          ) : null}
        </div>
        {/* The task it answers (the composer shows where it goes and the trust line). */}
        <h2 className="text-title font-bold text-balance text-fg-heading">{task.data?.item.title ?? destinationLabel(draft.destination)}</h2>
        {task.data?.item.purpose ? <p className="max-w-[68ch] text-body text-muted">{task.data.item.purpose.replace(/^For:\s*/i, '')}</p> : null}
      </header>
      <div className="cc-scroll relative min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6">
        {/* The message it answers, readable here, with the one-click way to the original (admin items answer nothing). */}
        {draft.destination.kind !== 'action' ? <ReplyingTo key={`src:${draft.id}`} draftId={draft.id} className="mb-4" /> : null}
        {/* a logging canvas: the same run Time ▸ Log it lists (staged → applied → Slackbot told → in Org62, why its rows are read only) */}
        {adminSurfaceOf(draft) === 'log' ? <CanvasRunStatus draftId={draft.id} tz={tz} /> : null}
        {outcome ? (
          <div role="status" data-testid="action-outcome" data-outcome={draft.status} className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface-muted px-3 py-2 text-body text-fg">
            <span className="min-w-0">{outcome}</span>
            {draft.resultUrl && draft.status !== 'failed' ? <OpenResult href={draft.resultUrl} testId="action-result-link" /> : null}
            {prompt && draft.status !== 'failed' && draft.status !== 'sending' ? <CopyPromptButton prompt={prompt} title={draft.destination.kind === 'action' ? draft.destination.target.label : ''} testId="action-copy-prompt" /> : null}
          </div>
        ) : null}
        {releaseMissing ? (
          <p role="alert" className="mb-4 rounded-md border border-line bg-surface-muted px-3 py-2 text-body text-fg" data-testid="release-missing-panel">
            {releaseMissing}
          </p>
        ) : null}
        <Composer key={draft.id} draft={draft} ref={ref} variant="inline" primaryPlacement="external" onPrimaryChange={setP} />
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-2 border-t border-line bg-surface px-6 py-4" data-panel-footer>
        {p?.countdown ? (
          <SendCountdownToast deadline={p.countdown.deadline} durationMs={p.countdown.durationMs} label={p.countdown.label} dryRun={p.countdown.dryRun} onUndo={() => ref.current?.undo()} className="mr-1 max-w-full min-w-72" />
        ) : p?.busyLabel ? (
          <span role="status" className="mr-1 inline-flex h-9 items-center gap-2 rounded-md bg-surface-muted px-3 text-body text-muted">
            <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
            {p.busyLabel}
          </span>
        ) : p && !p.hidden ? (
          <Button variant="primary" size="md" disabled={p.disabled || !!releaseMissing} loading={p.loading} title={releaseMissing ?? (p.disabled && p.blockedReason ? p.blockedReason : `${p.label} (⌘↵)`)} onClick={() => ref.current?.send()} className="mr-1" data-panel-primary>
            {p.label}
          </Button>
        ) : null}
        {nextInQueue && !busy ? (
          <Button variant="primary" size="md" onClick={() => openDraft(nextInQueue)} className="mr-1" data-action="next">
            Next
          </Button>
        ) : null}
        {draft.status === 'ready' && !busy ? (
          <Button variant="ghost" size="xs" loading={rejecting} onClick={() => void reject()} title="Turn it down: nothing is sent and the task stays open" data-action="reject">
            Reject
          </Button>
        ) : null}
        {openItem ? (
          <Button variant="ghost" size="xs" onClick={openItem}>
            Open the task
          </Button>
        ) : null}
        <span className="ml-auto hidden text-caption text-faint @min-[34rem]/panel:inline">Esc to close</span>
      </footer>
    </div>
  );
}
