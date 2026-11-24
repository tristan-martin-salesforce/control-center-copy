/**
 * reopen_review: work the app reopened after it was closed (a follow-up came in, H-7 reopen on follow-up), until you
 * have looked at it: `reopened.at` after your last `seenAt`. Open shows it; Got it marks it seen (it stays open work,
 * ranked as usual); Done closes it again (Undo on the toast). Under *Suggest, then learn* a reopened item is never
 * closed for you again, so this row is how you hear that it came back.
 */
import type { NeedRow, WorkItem } from '@/contract';
import { callVerb, needRow, refOf, sinceOf, sourceOf, verb } from '../row';
import type { NeedProvider, NeedsContext } from '../types';
import { groupKeyOf, KIND_URGENCY, workItemUrgency } from '../urgency';

const CLOSED = new Set<string>(['done', 'dismissed', 'snoozed']);

function unseenReopen(w: WorkItem): boolean {
  if (!w.reopened || CLOSED.has(w.state)) return false;
  const at = Date.parse(w.reopened.at);
  const seen = w.seenAt ? Date.parse(w.seenAt) : NaN;
  return !Number.isFinite(seen) || seen < at;
}

function rowOf(w: WorkItem, ctx: NeedsContext): NeedRow {
  const urgency = Math.max(KIND_URGENCY.reopen_review, workItemUrgency(w, ctx));
  const src = w.reopened?.from?.url ? { label: w.reopened.from.label, url: w.reopened.from.url } : sourceOf(w.sources);
  return needRow({
    kind: 'reopen_review',
    sourceId: w.id,
    title: w.title,
    why: `Reopened: ${w.reopened!.reason}`,
    who: w.counterparty ? { id: w.counterparty.id, label: w.counterparty.name, href: null } : null,
    account: refOf(w.refs.account),
    opp: refOf(w.refs.opp),
    verbs: [
      verb({ id: 'open', label: 'Open', kbd: 'a', primary: true, href: `/work/${encodeURIComponent(w.id)}` }),
      callVerb({ id: 'seen', label: 'Got it', kbd: 'n', route: 'markItemSeen', params: { id: w.id }, body: {} }),
      callVerb({ id: 'done', label: 'Done', kbd: 'd', route: 'itemAction', params: { id: w.id, verb: 'done' }, body: { ifVersion: w.version }, undoable: true }),
    ],
    groupKey: groupKeyOf('reopen_review', urgency, w.due, ctx),
    urgency,
    since: sinceOf([w.reopened!.at], ctx.nowMs),
    source: src,
    estimateMin: w.effort.youMin,
    confidence: w.confidence,
    subject: `item:${w.id}`,
  });
}

export const reopenReviewProvider: NeedProvider = {
  kind: 'reopen_review',
  run: (ctx) => (ctx.items?.items ?? []).filter(unseenReopen).map((w) => rowOf(w, ctx)),
};
