// Closure records: the engine state mapping and what a user decision records. Split from closure.ts (max-lines); closure.ts re-exports the public names.
import type { WorkItemRecord, WorkState } from '@/contract';
import type { ClosureDecision } from '@/engines/closure/types';
import type { ClosureItem, PersonLite, WorkItemStatus } from '@/engines/types';

const TO_ENGINE: Record<WorkState, WorkItemStatus> = {
  suggested: 'suggested',
  open: 'open',
  in_progress: 'in_progress',
  waiting_on_me: 'waiting_on_me',
  waiting_on_others: 'waiting_on_others',
  likely_done: 'likely_done',
  done: 'done',
  reopened: 'open',
  snoozed: 'snoozed',
  dismissed: 'dismissed',
};
/** Engine status → contract state. The contract has no `merged` (a merged item reads as dismissed). */
export function stateFromEngine(s: WorkItemStatus): WorkState {
  return s === 'merged' ? 'dismissed' : s;
}
const LOCK_ALIAS: Record<string, string> = { state: 'status' };
export function closureItemOf(w: WorkItemRecord, me: { id: string; name: string }): ClosureItem {
  const owner: PersonLite | null = w.owner ? { id: w.owner.id, name: w.owner.name, isMe: w.owner.id === me.id } : null;
  return {
    id: w.id,
    version: w.version,
    kind: w.kind,
    status: TO_ENGINE[w.state],
    statusChangedAt: w.updatedAt,
    title: w.title,
    initiativeId: w.initiativeId,
    resolution: w.resolution,
    resolutionDetail: w.resolutionDetail,
    involvement: w.involvement,
    owner,
    doneAt: w.doneAt,
    doneBy: w.doneBy,
    dismissedAt: w.dismissed?.at ?? null,
    deliverableRefs: w.deliverable?.assetId ? [w.deliverable.assetId] : [],
    snoozedUntil: w.snoozedUntil,
    snoozedFromStatus: w.snoozedFrom ? TO_ENGINE[w.snoozedFrom] : null,
    waitingReason: w.waiting?.reason ?? null,
    waitingSince: w.waiting?.since ?? null,
    likelyDone: w.likelyDone,
    loopedBackIn: w.loopedBackIn,
    linkedSessionIds: w.runIds,
    // the machine checks `status` (and W0's `state`) plus the side fields a target state needs
    userLockedFields: w.userLockedFields.flatMap((f) => (LOCK_ALIAS[f] ? [f, LOCK_ALIAS[f]!] : [f])),
  };
}
/**
 * The record after a transition / update decision. Status moves keep the contract's invariants: leaving
 * done clears the resolution; a done/dismissed item that opens again is `reopened`; waiting fields follow
 * the waiting states.
 */
export function recordAfterDecision(cur: WorkItemRecord, d: ClosureDecision, at: string, me?: { id: string; name: string }): WorkItemRecord {
  const next: WorkItemRecord = { ...cur };
  const f = new Map(d.fieldChanges.map((c) => [c.field, c.after]));
  const to = d.transition ? d.transition.to : TO_ENGINE[cur.state];
  const closedBefore = cur.state === 'done' || cur.state === 'dismissed';
  let state = stateFromEngine(to);
  if (d.transition && state === 'open' && (closedBefore || d.labels.some((l) => l.kind === 'reopened' || l.kind === 'looped_back_in'))) state = 'reopened';
  next.state = state;

  if (f.has('involvement')) next.involvement = f.get('involvement') as WorkItemRecord['involvement'];
  if (f.has('owner')) {
    const o = f.get('owner') as PersonLite | null;
    next.owner = o ? { id: o.id ?? cur.owner?.id ?? o.name, name: o.name } : cur.owner;
  } else if (me && next.involvement === 'owner' && cur.involvement !== 'owner' && cur.owner && cur.owner.id !== me.id) {
    // Looped back in (R-UI-22): I own it again, so the teammate a hand-off made owner stops being it.
    next.owner = { id: me.id, name: me.name };
  }
  if (f.has('loopedBackIn')) next.loopedBackIn = (f.get('loopedBackIn') as WorkItemRecord['loopedBackIn']) ?? null;
  if (f.has('snoozedUntil')) next.snoozedUntil = (f.get('snoozedUntil') as string | null) ?? null;
  if (f.has('snoozedFromStatus')) {
    const s = f.get('snoozedFromStatus') as WorkItemStatus | null;
    next.snoozedFrom = s ? stateFromEngine(s) : null;
  }
  if (f.has('likelyDone')) next.likelyDone = (f.get('likelyDone') as WorkItemRecord['likelyDone']) ?? null;
  const waitingReason = f.has('waitingReason') ? (f.get('waitingReason') as string | null) : (cur.waiting?.reason ?? null);
  const waitingSince = f.has('waitingSince') ? (f.get('waitingSince') as string | null) : (cur.waiting?.since ?? null);

  if (state === 'done') {
    next.doneAt = (f.get('doneAt') as string | undefined) ?? cur.doneAt ?? at;
    next.doneBy = 'engine';
    next.closedReason = d.reason;
    next.likelyDone = null;
    next.waiting = null;
    next.snoozedUntil = null;
    if (d.resolution) {
      next.resolution = d.resolution.resolution;
      next.resolutionDetail = { ...d.resolution.detail, inferred: d.resolution.detail.inferred ?? true };
    }
  } else {
    if (d.transition && cur.state === 'done') {
      next.doneAt = null;
      next.doneBy = null;
      next.closedReason = null;
      next.resolution = null;
      next.resolutionDetail = null;
    }
    if (state === 'waiting_on_me' || state === 'waiting_on_others') {
      next.waiting = waitingReason ? { ...(cur.waiting ?? {}), on: state === 'waiting_on_me' ? 'me' : 'others', reason: waitingReason, since: waitingSince ?? at } : cur.waiting;
    } else if (d.transition) next.waiting = null;
    if (state !== 'snoozed' && d.transition && cur.state === 'snoozed') next.snoozedUntil = null;
    if (state === 'likely_done' && !next.likelyDone) next.likelyDone = { reason: d.reason, evidenceId: d.transition?.evidenceId ?? null };
    if (state !== 'likely_done' && d.transition) next.likelyDone = null;
  }
  if (state === 'reopened') {
    next.reopened = { reason: d.labels.find((l) => l.kind === 'reopened' || l.kind === 'looped_back_in')?.text ?? d.reason, at };
    next.dismissed = null;
  }
  return next;
}
/** R2: an engine-closed item a follow-up shows is still mine, reopened (Settle's reopen; Undo on its change set). */
export function reopenedFromDone(cur: WorkItemRecord, reason: string, at: string): WorkItemRecord {
  return { ...cur, state: 'reopened', doneAt: null, doneBy: null, closedReason: null, resolution: null, resolutionDetail: null, likelyDone: null, reopened: { reason, at } };
}
