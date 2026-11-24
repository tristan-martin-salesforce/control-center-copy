'use client';
/**
 * The Outbox in drain mode (02-ui-research P1, P3, P10, P11; 01-ui-audit R2): "Review" on the page opens the kit's
 * ReviewQueue over the drafts that wait on you (Approve, then Retry), one card at a time, with the Outbox's own verbs:
 *
 *   a  Approve        the same path as the row: preview → confirm → undo window → dispatch (useOutboxSend), one draft
 *                     at a time, so *Nothing leaves without approval* holds; in dry run it only renders the payload
 *   e  Edit           the draft in the docked panel (the composer)
 *   x  Reject         POST /drafts/:id/reject: it leaves the Outbox, nothing is sent, the task stays open
 *   j/k skip / back · z undo the open batch · Esc back to the list
 *
 * There is no snooze for a draft in the API; j skips it and it stays in the Outbox. Undo takes back what has not left:
 * the countdown on screen and the approves still waiting their turn, or the rejects (their audit ids). A cancelled
 * confirm, an undone countdown or a failed send comes back as a Retry card. The list stays the default view.
 *
 * D-90 release items: the announcement approves like any post; the upload hand-off's approve is "Mark uploaded" (its
 * card has "Copy upload instructions"), which records the hand-off and sends nothing.
 */
import { useMemo, useRef } from 'react';
import type { OutboxItem } from '@/contract';
import { api } from '@/client/api';
import { destinationLabel, RecipientPreview } from '@/components/composer';
import { StatusBadge } from '@/components/domain';
import { ReplyingTo } from '@/components/detail/ReplyingTo';
import { ReviewQueue, type ReviewAdapter } from '@/components/kit';
import { approveLabel, lastDryRun } from '@/components/lists/outbox';
import { AppLink } from '@/components/shell/AppLink';
import type { DocNode } from '@/lib/compose';
import { fmtAgo, fmtClock, Icon } from '@/ui';
import { rowSource } from './OutboxRow';
import { releaseApproveKind, releaseRowView } from './release';
import { copyInstructions, markUploaded, ReleaseFacts } from './ReleaseParts';
import type { OutboxSend } from './useOutboxSend';

type Draftable = OutboxItem & { id: string };

/** The drafts the drain walks: what waits on you (Approve, then Retry), in the page's order. */
export function reviewableDrafts(items: readonly OutboxItem[]): Draftable[] {
  const rank = (g: OutboxItem['group']) => (g === 'pending_approval' ? 0 : g === 'failed' ? 1 : -1);
  return items
    .filter((i) => rank(i.group) >= 0 && i.draft.status !== 'sending')
    .map((i) => ({ ...i, id: i.draft.id }))
    .sort((a, b) => rank(a.group) - rank(b.group));
}

export interface OutboxAdapterDeps {
  send: Pick<OutboxSend, 'approveAndWait' | 'undoPending'>;
  reject: (draftId: string) => Promise<{ auditId: string | null }>;
  /** D-90: "Mark uploaded" on a release upload hand-off (no tool call). */
  markUploaded?: (it: OutboxItem) => Promise<void>;
  undoAudit: (auditId: string) => Promise<unknown>;
  edit: (draftId: string) => void;
  refetch: () => void;
  dryRun: boolean;
}

/** The Outbox's verbs as a ReviewQueue adapter (pure wiring, unit-tested). */
export function outboxAdapter(deps: OutboxAdapterDeps, audits: Map<string, string>): ReviewAdapter<Draftable> {
  return {
    approve: async (it) => {
      if (releaseApproveKind(it) !== 'mark') return deps.send.approveAndWait(it.draft);
      if (!deps.markUploaded) throw new Error('Mark uploaded is not available here. Nothing was sent.');
      await deps.markUploaded(it);
      deps.refetch();
      return 'sent';
    },
    dismiss: async (it) => {
      const r = await deps.reject(it.draft.id);
      if (r.auditId) audits.set(it.draft.id, r.auditId);
      deps.refetch();
    },
    edit: (it) => deps.edit(it.draft.id),
    undo: async ({ verb, items }) => {
      if (verb === 'approve') {
        const gone = deps.send.undoPending(items.map((i) => i.draft.id));
        if (gone.length) throw new Error(`${gone.length} already ${deps.dryRun ? 'rendered' : 'went out'}; the rest are back.`);
        return;
      }
      const ids = items.map((i) => audits.get(i.draft.id)).filter((x): x is string => !!x);
      await Promise.all(ids.map((id) => deps.undoAudit(id)));
      for (const i of items) audits.delete(i.draft.id);
      deps.refetch();
    },
    labels: { approve: deps.dryRun ? 'Approve (dry run)' : 'Approve', dismiss: 'Reject' },
    past: { approve: deps.dryRun ? 'Rendered' : 'Approved', dismiss: 'Rejected' },
  };
}

export interface OutboxReviewProps {
  items: readonly OutboxItem[];
  send: OutboxSend;
  dryRun: boolean;
  now: string;
  tz?: string;
  onEdit: (draftId: string) => void;
  onExit: () => void;
  refetch: () => void;
}

export function OutboxReview({ items, send, dryRun, now, tz, onEdit, onExit, refetch }: OutboxReviewProps) {
  const drafts = useMemo(() => reviewableDrafts(items), [items]);
  const audits = useRef(new Map<string, string>()).current;
  const adapter = useMemo(
    () =>
      outboxAdapter(
        {
          send,
          dryRun,
          edit: onEdit,
          refetch,
          reject: (id) => api('rejectDraft', { params: { id }, body: {} }),
          markUploaded: (it) => markUploaded(it.draft),
          undoAudit: (id) => api('undoAudit', { params: { id }, body: {} }),
        },
        audits,
      ),
    [send, dryRun, onEdit, refetch, audits],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="outbox-review">
      <ReviewQueue
        title="Review drafts"
        items={drafts}
        adapter={adapter}
        onExit={onExit}
        renderCard={(it) => <DraftCard item={it} dryRun={dryRun} now={now} tz={tz} />}
      />
    </div>
  );
}

function DraftCard({ item, dryRun, now, tz }: { item: OutboxItem; dryRun: boolean; now: string; tz?: string }) {
  const d = item.draft;
  const src = rowSource(item);
  const dry = lastDryRun(d);
  const rel = releaseRowView(d);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="review-draft" data-draft-id={d.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="min-w-0 truncate text-title font-bold text-fg-heading">{destinationLabel(d.destination)}</h2>
        {item.group === 'failed' ? (
          <StatusBadge tone="danger" icon="error">
            Not sent
          </StatusBadge>
        ) : dry ? (
          <StatusBadge tone="neutral" icon="lock">
            Dry run · rendered {fmtClock(dry.at, tz)}
          </StatusBadge>
        ) : null}
        <span className="ml-auto text-caption text-muted tabular-nums">
          drafted {fmtAgo(d.createdAt, new Date(now))}
          {d.userTouched ? ' · edited by you' : ''}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-body text-muted">
        {item.workItem ? (
          <AppLink href={`/work/${item.workItem.id}`} className="max-w-[40ch] truncate hover:text-fg hover:underline" title={item.workItem.title}>
            For: {item.workItem.title}
          </AppLink>
        ) : null}
        {src ? (
          <a href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-sm font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none" title={`${src.label}: the message this answers in ${src.where}`}>
            <Icon name="new_window" size="xs" />
            {src.label}
          </a>
        ) : null}
      </div>
      {d.destination.kind !== 'action' ? <ReplyingTo draftId={d.id} compact className="max-w-[44rem]" /> : null}
      {rel ? (
        <section className="min-w-0">
          <ReleaseFacts draft={d} />
          {rel.kind === 'upload' ? (
            <button type="button" onClick={() => void copyInstructions(d)} data-testid="release-copy" className="mt-2 rounded-sm font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
              Copy upload instructions
            </button>
          ) : null}
        </section>
      ) : (
        <section className="min-w-0">
          <h3 className="mb-1.5 text-caption font-bold text-muted">{d.destination.kind === 'slack' ? 'Exactly what they will see' : d.destination.kind === 'action' ? 'Exactly what changes' : 'Exactly what the recipient will see'}</h3>
          <RecipientPreview doc={d.doc as unknown as DocNode} destination={d.destination} className="max-w-[44rem]" />
        </section>
      )}
      <p className="text-caption text-muted">
        {rel?.kind === 'upload'
          ? 'Approve marks it uploaded: you put the files in the folder yourself (or with Claude Code). The app has no Drive write and sends nothing.'
          : dryRun
            ? 'Dry run: approving renders the exact payload and records it. Nothing leaves this machine.'
            : `${approveLabel(d, item.group, false)} shows the payload and asks you to confirm; then you have a few seconds to undo.`}
      </p>
    </div>
  );
}
