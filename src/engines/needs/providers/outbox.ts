/**
 * outbox_draft: one row per message waiting for your approval or failed to send (GET /outbox; never an admin item,
 * D-75). The verb is Review, everywhere (01 R2): approving stays the Outbox's own path with its preview, confirm and
 * undo window (*tenet: Nothing leaves without approval*), so the queue only links there. Reject is the Outbox's
 * reject (nothing is sent, Undo on the toast).
 */
import type { Draft, NeedRow, OutboxItem } from '@/contract';
import { callVerb, isSnoozed, needRow, sinceOf, verb } from '../row';
import type { NeedProvider, NeedsContext } from '../types';
import { KIND_URGENCY } from '../urgency';

function whereTo(d: Draft): string {
  const dest = d.destination;
  if (dest.kind === 'slack') return dest.channelName;
  if (dest.kind === 'email') return dest.to[0]?.name ?? dest.to[0]?.email ?? 'email';
  return dest.target.label;
}

function rowOf(it: OutboxItem, ctx: NeedsContext): NeedRow {
  const d = it.draft;
  const failed = it.group === 'failed';
  const to = whereTo(d);
  const first = it.previewText.split('\n').find((l) => l.trim())?.trim() ?? '';
  return needRow({
    kind: 'outbox_draft',
    sourceId: d.id,
    title: it.workItem ? `${failed ? 'Retry' : 'Approve'}: ${it.workItem.title}` : `${failed ? 'Retry' : 'Approve'} to ${to}`,
    why: failed ? `Failed to send to ${to}. Review it in the Outbox to retry.` : `Draft to ${to}${first ? `: ${first}` : ''}`,
    verbs: [
      verb({ id: 'review', label: 'Review', kbd: 'a', primary: true, href: `/outbox?draft=${encodeURIComponent(d.id)}` }),
      callVerb({ id: 'reject', label: 'Reject', kbd: 'x', route: 'rejectDraft', params: { id: d.id }, body: { ifVersion: d.version }, undoable: true }),
    ],
    groupKey: 'today',
    urgency: failed ? 0.8 : KIND_URGENCY.outbox_draft,
    since: sinceOf([d.createdAt], ctx.nowMs),
    source: it.source?.url ? { label: it.source.label, url: it.source.url } : null,
    estimateMin: 2,
    subject: d.workItemId ? `item:${d.workItemId}` : null,
  });
}

export const outboxDraftProvider: NeedProvider = {
  kind: 'outbox_draft',
  run(ctx) {
    const out: NeedRow[] = [];
    for (const g of ctx.outbox?.groups ?? []) {
      if (g.group !== 'pending_approval' && g.group !== 'failed') continue;
      for (const it of g.items) if (!isSnoozed(ctx, 'outbox_draft', it.draft.id)) out.push(rowOf(it, ctx));
    }
    return out;
  },
};
