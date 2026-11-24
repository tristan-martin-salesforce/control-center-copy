/**
 * Work-item closure state machine: DATA-MODEL §4.1 + R-UI-20 (reopen vs sibling) + R-UI-22
 * (resolution, involvement, loop-back). The scanner emits signals; this decides (SCANNER.md §3).
 *
 *   applySignal(item, signal, settings) → ClosureDecision
 *
 * Rules (docs/reference/ENGINES.md §3):
 * - Sure completion auto-closes as done with an inferred resolution and its evidence (L4 internal,
 *   undoable). Likely → likely_done ("Confirm"). Guess → evidence only.
 * - R1, the correction rule Settle shares (correction.ts): an item the user reopened, kept or marked Not done, or one on
 *   their ask-first lists (`mayAutoClose: false`), is never closed for them: a Sure completion only asks (Likely).
 * - R2: a follow-up from the asker after a close for you (`contradiction` with `follow_up:`) reopens it within the
 *   reopen window: "Reopened: PERSON wrote again · Undo".
 * - A reply after an ask closes the ask deterministically (`reply_in_thread`).
 * - Drive alone never closes: an edit is progress, "updates made" is likely done (R-UI-15).
 * - A Slack "done" is completion evidence (Sure closes, Likely asks).
 * - Done + new requirement: same deliverable and closed ≤ reopen.window_days ago → reopen;
 *   otherwise a sibling under the same initiative/parent. Labels say why; every case is undoable.
 * - Handed off / not mine: context only, except a direct ask of me → "Looped back in" (reopen, or a
 *   sibling when the original is old).
 * - A change to a user-locked field becomes a proposal, never a write.
 * - Claude session waiting → waiting_on_me with a reason; done → done_review (app runs) plus a
 *   likely-done check (or the deterministic `claude_session_completed` closure test).
 * - Snoozed wakes on its timer or a direct ask. Dismissed stays dismissed unless looped back.
 * - Engines move items forward only; backward moves go through a reopen decision.
 */
import { cleanLikelyReason } from '../home/looks-done';
import { blockText, REOPEN_BRAKE_TEXT, reopenBrake } from './correction';
import type {
  ClosureItem,
  ClosureSettings,
  Confidence,
  LoopBackSignal,
  PersonLite,
  RequirementsChangeSignal,
  Resolution,
  ResolutionDetail,
  RunState,
  Signal,
  WorkItemStatus,
} from '@/engines/types';
import { DEFAULT_CLOSURE_SETTINGS } from '@/engines/types';
import type { ClosureDecision, ClosureField, FieldChange, Label, ProposalSpec, ReopenDecision } from './types';

const DAY_MS = 86_400_000;
const toMs = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid instant: ${iso}`);
  return t;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base(reason: string, extra: Partial<ClosureDecision> = {}): ClosureDecision {
  return {
    kind: 'none',
    reason,
    transition: null,
    fieldChanges: [],
    proposals: [],
    sibling: null,
    reopenDecision: null,
    resolution: null,
    labels: [],
    recordAs: null,
    runState: null,
    redirectTo: null,
    undoable: true,
    actor: 'engine',
    ...extra,
  };
}

const none = (reason: string, label?: Label, extra: Partial<ClosureDecision> = {}): ClosureDecision =>
  base(reason, { labels: label ? [label] : [], ...extra });

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field changes that actually change something. */
function changes(item: ClosureItem, patch: Partial<Record<ClosureField, unknown>>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [field, after] of Object.entries(patch) as Array<[ClosureField, unknown]>) {
    const before = item[field];
    if (!same(before, after)) out.push({ field, before, after });
  }
  return out;
}

function transition(
  item: ClosureItem,
  to: WorkItemStatus,
  reason: string,
  evidenceId: string | null,
  patch: Partial<Record<ClosureField, unknown>> = {},
  extra: Partial<ClosureDecision> = {},
): ClosureDecision {
  return base(reason, {
    kind: 'transition',
    transition: { from: item.status, to, actor: 'engine', reason, evidenceId, autonomy: null },
    fieldChanges: changes(item, patch),
    ...extra,
  });
}

function update(item: ClosureItem, reason: string, patch: Partial<Record<ClosureField, unknown>>, extra: Partial<ClosureDecision> = {}): ClosureDecision {
  const fc = changes(item, patch);
  if (fc.length === 0) return base(reason, extra);
  return base(reason, { kind: 'update', fieldChanges: fc, ...extra });
}

export function personName(p?: PersonLite | null): string {
  if (!p) return 'someone';
  return p.isMe ? 'you' : p.name;
}

export function isLocked(item: ClosureItem, field: string): boolean {
  const locked = item.userLockedFields ?? [];
  if (field === 'status' || field === 'state') return locked.includes('status') || locked.includes('state');
  return locked.includes(field);
}

/** Handed off, done by someone else, declined, or I'm only watching: new info is context (R-UI-22). */
export function isNotMine(item: ClosureItem): boolean {
  if (item.resolution === 'handed_off' || item.resolution === 'done_by_other' || item.resolution === 'declined') return true;
  return item.involvement === 'watcher' || item.involvement === 'not_involved';
}

function daysSince(fromIso: string | null | undefined, atIso: string): number | null {
  if (!fromIso) return null;
  return (toMs(atIso) - toMs(fromIso)) / DAY_MS;
}

const fmtDays = (d: number | null): string => (d === null ? 'unknown' : `${Math.max(0, Math.floor(d))}d`);

const RESOLUTION_TEXT: Record<Resolution, (d: ResolutionDetail) => string> = {
  done_by_me: () => 'Done by you',
  handed_off: (d) => `Handed off → ${d.personName ?? 'teammate'}`,
  done_by_other: (d) => `Done by ${d.personName ?? 'someone else'}`,
  not_needed: () => 'Not needed',
  duplicate: (d) => `Duplicate of ${d.relatedItemId ?? 'another item'}`,
  declined: () => 'Declined',
  superseded: (d) => `Superseded by ${d.relatedItemId ?? 'a newer item'}`,
};

export const resolutionText = (r: Resolution, d: ResolutionDetail): string => RESOLUTION_TEXT[r](d);

// ---------------------------------------------------------------------------
// Signal normalization
// ---------------------------------------------------------------------------

const LOOP_BACK_PREFIX = 'loop_back:';

/** SCANNER.md §4.5: an `origin` with reason prefix `loop_back:` is a direct ask of me. */
export function normalizeSignal(s: Signal): Signal {
  if (s.type !== 'evidence' || s.role !== 'origin' || !s.reason) return s;
  const r = s.reason.trimStart();
  if (!r.toLowerCase().startsWith(LOOP_BACK_PREFIX)) return s;
  const text = r.slice(LOOP_BACK_PREFIX.length).trim();
  const named = /^(.+?)\s+(?:asked|wants|needs|pinged|mentioned|@)/i.exec(text)?.[1];
  const from: PersonLite = s.actor ?? { name: named ?? 'someone' };
  const out: LoopBackSignal = { type: 'loop_back', evidenceId: s.evidenceId, at: s.at, from, reason: text, summary: text };
  if (s.source) out.source = s.source;
  if (s.actor) out.actor = s.actor;
  return out;
}

// ---------------------------------------------------------------------------
// Completion, reopen/sibling, wake
// ---------------------------------------------------------------------------

function inferResolution(s: Signal): { resolution: Resolution; detail: ResolutionDetail } {
  let resolution: Resolution;
  let person: PersonLite | undefined;
  if (s.type === 'evidence' && s.resolution) {
    resolution = s.resolution;
    person = s.resolutionPerson ?? (s.actor && !s.actor.isMe ? s.actor : undefined);
  } else if (s.type === 'drive_digest') {
    resolution = s.editedByMe ? 'done_by_me' : 'done_by_other';
    person = s.editedByMe ? undefined : { name: s.editorName ?? 'someone else' };
  } else if (s.type === 'evidence' && s.actor && !s.actor.isMe) {
    resolution = 'done_by_other';
    person = s.actor;
  } else {
    // My reply, an email I sent, my session, my own "done".
    resolution = 'done_by_me';
  }
  const detail: ResolutionDetail = { inferred: true, evidenceIds: s.evidenceId ? [s.evidenceId] : [] };
  if (person && (resolution === 'handed_off' || resolution === 'done_by_other')) {
    detail.personName = person.name;
    if (person.id) detail.personId = person.id;
  }
  if ((resolution === 'duplicate' || resolution === 'superseded') && s.type === 'evidence' && s.relatedItemId) detail.relatedItemId = s.relatedItemId;
  if (s.reason) detail.note = s.reason;
  return { resolution, detail };
}

function completion(
  item: ClosureItem,
  s: Signal,
  confidence: Confidence,
  settings: ClosureSettings,
  why: string,
  extraLabels: Label[] = [],
): ClosureDecision {
  const evidenceId = s.evidenceId;
  if (confidence === 'guess') {
    return none(`Possible completion (guess): ${why}. Attached as evidence only`, undefined, { labels: [{ kind: 'guess', text: `Maybe done? ${why}` }, ...extraLabels] });
  }
  const res = inferResolution(s);
  const corrected = confidence === 'sure' && settings.autoCloseSure && item.mayAutoClose === false;
  // W0-4: no re-close on what a reopen overruled, and ask-only after two reopens
  const brake = confidence === 'sure' && settings.autoCloseSure && !corrected ? reopenBrake(item, s.at) : null;
  const autoClose = confidence === 'sure' && settings.autoCloseSure && item.autoCloseAllowed !== false && item.mayAutoClose !== false && !brake;
  if (corrected) why = `${why} (not closed for you: ${blockText(item.autoCloseBlock)})`;
  else if (brake) why = `${why} (not closed for you: ${REOPEN_BRAKE_TEXT[brake]})`;
  if (autoClose) {
    const text = resolutionText(res.resolution, res.detail);
    const patch: Partial<Record<ClosureField, unknown>> = {
      doneAt: s.at,
      doneBy: 'engine',
      resolution: res.resolution,
      resolutionDetail: res.detail,
      likelyDone: null,
      likelyDoneAt: null,
      likelyDoneFromStatus: null,
      waitingReason: null,
      waitingSince: null,
    };
    if (res.resolution === 'handed_off') patch.involvement = settings.handoffInvolvement;
    // DONE-2: the evidence reason without its writer's prefixes (`triage:`, `done_check:`, `delivered_with_attachment:`),
    // and said once: an asker's own settling message already reads "Resolved by NAME: …" (MIN-16).
    const said = cleanLikelyReason(why, { fallback: why, max: 400, capitalize: false });
    const reason = /^resolved by /i.test(said) ? said : `${text}: ${said}`;
    const d = transition(item, 'done', reason, evidenceId, patch, {
      resolution: res,
      labels: [{ kind: 'auto_closed', text: `Closed for you · ${reason}` }, ...extraLabels],
    });
    d.transition!.autonomy = 'L4_auto';
    return d;
  }
  if (item.status === 'likely_done') {
    return none(`Already likely done: ${why}`, undefined, { labels: extraLabels });
  }
  const reason = `Likely done: ${why}`;
  return transition(
    item,
    'likely_done',
    reason,
    evidenceId,
    {
      likelyDoneAt: s.at,
      likelyDoneFromStatus: item.status,
      likelyDone: { reason: why, evidenceId, proposedResolution: res.resolution },
    },
    { resolution: null, labels: [{ kind: 'likely_done', text: `Likely done · Confirm: ${why}` }, ...extraLabels] },
  );
}

function reopenOrSibling(
  item: ClosureItem,
  s: Signal,
  settings: ClosureSettings,
  opts: { sameDeliverable: boolean; cause: 'requirement' | 'contradiction' | 'follow_up' | 'loop_back'; by: string; summary?: string },
): ClosureDecision {
  const windowDays = settings.reopenWindowDays;
  const closedAt = item.status === 'done' ? (item.doneAt ?? item.statusChangedAt) : (item.dismissedAt ?? item.statusChangedAt);
  const days = daysSince(closedAt, s.at);
  // Only something said after the close can bring an item back. The close is the boundary: your click when you closed
  // it (everything older was in front of you), or the completion message's own time when the engine did (doneAt =
  // that message), so anything older was overtaken by it. A message scanned or linked late (a thread re-read, a
  // backfill) keeps its own time, so it attaches as context and never reopens.
  if (days !== null && days <= 0) {
    const text = `Already ${item.status === 'done' ? 'done' : 'closed'}: this message is from before it was closed`;
    return none(text, { kind: 'already_done', text }, { recordAs: 'context', reopenDecision: { outcome: 'ignored', ruleKey: 'older_than_close', explanation: `Not reopened: ${opts.by}'s message predates the close`, daysSinceClosed: days, windowDays } });
  }
  const recent = days !== null && days <= windowDays;
  const handedOff = isNotMine(item);

  const headline =
    opts.cause === 'loop_back'
      ? handedOff
        ? `Looped back in: ${opts.by} asked you directly`
        : `Reopened: ${opts.by} asked you directly`
      : opts.cause === 'contradiction'
        ? `Reopened: ${opts.by} says it isn't done`
        : opts.cause === 'follow_up'
          ? `Reopened: ${opts.by} wrote again`
          : `Reopened: new requirement from ${opts.by}`;

  if (opts.sameDeliverable && recent) {
    const ruleKey = opts.cause === 'loop_back' ? 'loop_back_recent' : 'same_deliverable_recent';
    const explanation = `${headline} (${opts.cause === 'loop_back' ? 'same item' : 'same deliverable'}, closed ${fmtDays(days)} ago)`;
    const patch: Partial<Record<ClosureField, unknown>> = {
      doneAt: null,
      doneBy: null,
      dismissedAt: null,
      resolution: null,
      resolutionDetail: null,
      reopenedCount: (item.reopenedCount ?? 0) + 1,
      lastReopenedAt: s.at,
    };
    if (opts.cause === 'loop_back') {
      patch.involvement = 'owner';
      patch.loopedBackIn = { at: s.at, byPersonName: opts.by, evidenceId: s.evidenceId };
    }
    const reopenDecision: ReopenDecision = { outcome: 'reopened', ruleKey, explanation, daysSinceClosed: days, windowDays };
    const kind = opts.cause === 'loop_back' && handedOff ? 'looped_back_in' : 'reopened';
    return transition(item, 'open', explanation, s.evidenceId, patch, {
      reopenDecision,
      labels: [{ kind, text: `${headline} · Undo` }],
    });
  }

  const ruleKey = opts.cause === 'loop_back' ? 'loop_back_outside_window' : !opts.sameDeliverable ? 'different_deliverable' : 'outside_window';
  const why = !opts.sameDeliverable && opts.cause !== 'loop_back' ? 'different deliverable' : `original closed ${fmtDays(days)} ago`;
  const siblingHeadline =
    opts.cause === 'loop_back'
      ? handedOff
        ? `Looped back in: ${opts.by} asked you directly`
        : `New task: ${opts.by} asked you directly`
      : `New task: ${opts.cause === 'contradiction' ? `${opts.by} says it isn't done` : opts.cause === 'follow_up' ? `${opts.by} wrote again` : `new requirement from ${opts.by}`}`;
  const explanation = `${siblingHeadline} (${why})`;
  const label: Label = { kind: opts.cause === 'loop_back' && handedOff ? 'looped_back_in' : 'new_sibling', text: `${siblingHeadline} · Undo` };
  return base(explanation, {
    kind: 'sibling',
    sibling: {
      kind: item.kind,
      title: opts.summary ?? `Follow-up: ${item.title}`,
      status: 'open',
      initiativeId: item.initiativeId ?? null,
      parentId: item.parentId ?? null,
      relation: { kind: 'follow_up_of', toWorkItemId: item.id },
      involvement: 'owner',
      originEvidenceId: s.evidenceId,
      label,
    },
    reopenDecision: { outcome: 'new_sibling', ruleKey, explanation, daysSinceClosed: days, windowDays },
    labels: [label],
  });
}

function wake(item: ClosureItem, s: Signal, why: string, extraPatch: Partial<Record<ClosureField, unknown>> = {}): ClosureDecision {
  const to = item.snoozedFromStatus ?? 'open';
  return transition(item, to, `Woke: ${why}`, s.evidenceId, { snoozedUntil: null, snoozedFromStatus: null, ...extraPatch }, {
    labels: [{ kind: 'woke', text: `Woke: ${why}` }],
  });
}

function sameDeliverable(item: ClosureItem, s: RequirementsChangeSignal): boolean {
  if (s.sameDeliverable !== undefined) return s.sameDeliverable;
  if (!s.deliverableRef) return true;
  const refs = [...(item.deliverableRefs ?? []), ...(item.closureTarget ? [item.closureTarget] : [])];
  return refs.length === 0 || refs.includes(s.deliverableRef);
}

// ---------------------------------------------------------------------------
// Routing by state
// ---------------------------------------------------------------------------

function onLoopBack(item: ClosureItem, s: LoopBackSignal, settings: ClosureSettings): ClosureDecision {
  const by = personName(s.from);
  const handedOff = isNotMine(item);
  const owner: Partial<Record<ClosureField, unknown>> = handedOff
    ? { involvement: 'owner', loopedBackIn: { at: s.at, byPersonName: by, evidenceId: s.evidenceId } }
    : {};
  switch (item.status) {
    case 'done':
    case 'dismissed':
      return reopenOrSibling(item, s, settings, { sameDeliverable: true, cause: 'loop_back', by, ...(s.summary ? { summary: s.summary } : {}) });
    case 'snoozed':
      return wake(item, s, `${by} asked you directly`, owner);
    case 'suggested':
      return none(`In Triage: ${by} asked you directly`, { kind: 'direct_ask', text: `${by} asked you directly` });
    case 'merged':
      return none(`Merged: the ask routes to the surviving item`, { kind: 'routes_to_survivor', text: 'Routes to the surviving item' }, { redirectTo: item.mergedIntoId ?? null });
    default:
      if (handedOff)
        return update(item, `Looped back in: ${by} asked you directly`, owner, {
          labels: [{ kind: 'looped_back_in', text: `Looped back in: ${by} asked you directly · Undo` }],
        });
      return none(`Direct ask from ${by}`, { kind: 'direct_ask', text: `Direct ask from ${by}` });
  }
}

function onTimer(item: ClosureItem, s: Signal): ClosureDecision {
  const at = toMs(s.at);
  if (item.status === 'snoozed' && item.snoozedUntil && toMs(item.snoozedUntil) <= at) return wake(item, s, 'snooze ended');
  if (item.status === 'waiting_on_others' && item.nudgeAt && toMs(item.nudgeAt) <= at) {
    return transition(item, 'open', 'Nudge due: no reply yet', null, {}, { labels: [{ kind: 'nudge_due', text: 'Nudge due: no reply yet' }] });
  }
  return none('Timer: nothing due');
}

function contextOnly(item: ClosureItem): ClosureDecision {
  const who =
    item.resolution === 'handed_off'
      ? `handed off to ${item.resolutionDetail?.personName ?? item.owner?.name ?? 'a teammate'}`
      : item.resolution === 'done_by_other'
        ? `done by ${item.resolutionDetail?.personName ?? 'someone else'}`
        : item.resolution === 'declined'
          ? 'you declined it'
          : item.involvement === 'watcher'
            ? "you're watching it"
            : "you're not involved";
  const text = `Context only: ${who}`;
  return none(text, { kind: 'context_only', text }, { recordAs: 'context' });
}

function onDone(item: ClosureItem, s: Signal, settings: ClosureSettings): ClosureDecision {
  if (s.type === 'requirements_change') {
    return reopenOrSibling(item, s, settings, { sameDeliverable: sameDeliverable(item, s), cause: 'requirement', by: personName(s.actor), summary: s.summary });
  }
  if (s.type === 'evidence' && s.role === 'contradiction') {
    const followUp = /^follow_up:/i.test((s.reason ?? '').trimStart());
    return reopenOrSibling(item, s, settings, { sameDeliverable: true, cause: followUp ? 'follow_up' : 'contradiction', by: personName(s.actor) });
  }
  return none('Already done: evidence attached', { kind: 'already_done', text: 'Already done' });
}

function onLive(item: ClosureItem, s: Signal, settings: ClosureSettings): ClosureDecision {
  const by = personName(s.actor);
  switch (s.type) {
    case 'evidence':
      switch (s.role) {
        case 'origin':
          return none('New info attached', { kind: 'new_info', text: 'New info' });
        case 'progress':
          if (item.status === 'open') return transition(item, 'in_progress', `In progress: ${s.reason ?? 'progress evidence'}`, s.evidenceId, {}, { labels: [{ kind: 'progress', text: `In progress: ${s.reason ?? 'progress'}` }] });
          return none('Progress noted', { kind: 'progress', text: s.reason ?? 'Progress' });
        case 'completion':
          return completion(item, s, s.confidence, settings, s.reason ?? (s.source === 'slack' ? `${by} said it's done in Slack` : 'completion evidence'));
        case 'context':
          return none('Context attached');
        case 'contradiction':
          if (item.status === 'likely_done') {
            // Step back to where it was; waiting_on_me needs a reason (DB check), else in_progress.
            const from = item.likelyDoneFromStatus ?? 'in_progress';
            const back = from === 'waiting_on_me' && !item.waitingReason ? 'in_progress' : from;
            return transition(item, back, `Not done: ${s.reason ?? `${by} contradicts it`}`, s.evidenceId, { likelyDone: null, likelyDoneAt: null, likelyDoneFromStatus: null }, {
              labels: [{ kind: 'not_done', text: `Not done: ${s.reason ?? `${by} contradicts it`}` }],
            });
          }
          return none('Contradicting info attached', { kind: 'new_info', text: `Contradicting info from ${by}` });
      }
      break;
    case 'requirements_change':
      if (item.status === 'likely_done') {
        return transition(item, 'in_progress', `New requirement from ${by}: not done yet`, s.evidenceId, { likelyDone: null, likelyDoneAt: null, likelyDoneFromStatus: null }, {
          labels: [{ kind: 'new_requirement', text: `New requirement from ${by}: ${s.summary}` }],
        });
      }
      return none(`New requirement from ${by}: ${s.summary}`, { kind: 'new_requirement', text: `New requirement from ${by}: ${s.summary}` });
    case 'session': {
      if (s.status === 'waiting') {
        const reason = s.waitingReason ?? 'Session needs your input';
        if (item.status === 'waiting_on_me')
          return update(item, `Waiting on you: ${reason}`, { waitingReason: reason }, { labels: [{ kind: 'waiting_on_me', text: `Waiting on you: ${reason}` }] });
        return transition(item, 'waiting_on_me', `Waiting on you: ${reason}`, s.evidenceId, { waitingReason: reason, waitingSince: s.at }, {
          labels: [{ kind: 'waiting_on_me', text: `Waiting on you: ${reason}` }],
        });
      }
      if (s.status === 'running') {
        if (item.status === 'waiting_on_me')
          return transition(item, 'in_progress', 'Session resumed', s.evidenceId, { waitingReason: null, waitingSince: null }, { labels: [{ kind: 'resumed', text: 'Session resumed' }] });
        if (item.status === 'open')
          return transition(item, 'in_progress', 'Linked session started', s.evidenceId, {}, { labels: [{ kind: 'progress', text: 'Linked session started' }] });
        return none('Session running');
      }
      if (s.status === 'done') {
        const deterministic = item.closureKind === 'claude_session_completed';
        const confidence = s.confidence ?? (deterministic ? 'sure' : 'likely');
        const extra: Label[] = s.launchedByApp ? [{ kind: 'run_done_review', text: 'Run finished · Review' }] : [];
        return completion(item, s, confidence, settings, s.reason ?? 'the linked Claude session finished', extra);
      }
      // failed
      if (item.status === 'waiting_on_me')
        return transition(item, 'in_progress', 'Linked session failed', s.evidenceId, { waitingReason: null, waitingSince: null }, {
          labels: [{ kind: 'run_failed', text: 'Agent run failed · Retry or open in Claude' }],
        });
      return none('Linked session failed', { kind: 'run_failed', text: 'Agent run failed · Retry or open in Claude' });
    }
    case 'drive_digest': {
      const who = s.editedByMe ? 'you' : (s.editorName ?? 'someone else');
      if (s.updatesMade === 'yes') return completion(item, s, 'likely', settings, `requested updates made in the file (edited by ${who})`);
      if (s.updatesMade === 'partial') {
        if (item.status === 'open') return transition(item, 'in_progress', `In progress: some requested updates made (by ${who})`, s.evidenceId, {}, { labels: [{ kind: 'progress', text: 'Some requested updates made' }] });
        if (item.status === 'likely_done')
          return transition(item, 'in_progress', 'Not done: only some requested updates are in the file', s.evidenceId, { likelyDone: null, likelyDoneAt: null, likelyDoneFromStatus: null }, {
            labels: [{ kind: 'not_done', text: 'Only some requested updates are in the file' }],
          });
        return none('Some requested updates made', { kind: 'progress', text: 'Some requested updates made' });
      }
      // unknown: an edit with no judgment.
      if (!s.editedByMe) return none(`Edited by ${who}`, { kind: 'new_info', text: `Edited by ${who}` }, { recordAs: 'context' });
      if (item.status === 'open') return transition(item, 'in_progress', 'In progress: you edited the file', s.evidenceId, {}, { labels: [{ kind: 'progress', text: 'You edited the file' }] });
      return none('You edited the file', { kind: 'progress', text: 'You edited the file' });
    }
    case 'reply':
      if (s.by === 'me') {
        if (item.kind === 'ask' || item.closureKind === 'reply_in_thread') return completion(item, s, 'sure', settings, s.reason ?? 'you replied in the thread after the ask');
        if (item.status === 'open') return transition(item, 'in_progress', 'In progress: you replied', s.evidenceId, {}, { labels: [{ kind: 'progress', text: 'You replied' }] });
        return none('You replied');
      }
      if (item.status === 'waiting_on_others')
        return transition(item, 'open', `Reply from ${by}`, s.evidenceId, { waitingReason: null, waitingSince: null, nudgeAt: null }, { labels: [{ kind: 'reply_arrived', text: `Reply from ${by}` }] });
      return none(`Reply from ${by}`, { kind: 'new_info', text: `Reply from ${by}` });
    case 'email_sent': {
      const attached = s.hasAttachment && (s.attachmentRefs ?? []).some((r) => (item.deliverableRefs ?? []).includes(r));
      const why = s.reason ?? (attached ? 'you sent it with the file attached' : s.hasAttachment ? 'you sent the email with an attachment' : 'you sent the email');
      const extra: Label[] = s.hasAttachment ? [{ kind: 'sent_with_attachment', text: attached ? 'Sent with the file attached' : 'Sent with an attachment' }] : [];
      return completion(item, s, s.confidence, settings, why, extra);
    }
    case 'loop_back':
    case 'timer':
      break; // routed earlier
  }
  return none('No change');
}

function route(item: ClosureItem, s: Signal, settings: ClosureSettings): ClosureDecision {
  if (item.status === 'merged')
    return none('Merged: evidence routes to the surviving item', { kind: 'routes_to_survivor', text: 'Routes to the surviving item' }, { redirectTo: item.mergedIntoId ?? null });
  if (s.type === 'loop_back') return onLoopBack(item, s, settings);
  if (s.type === 'timer') return onTimer(item, s);
  if (isNotMine(item)) return contextOnly(item);
  if (item.resolution === 'duplicate' || item.resolution === 'superseded') {
    const to = item.resolutionDetail?.relatedItemId ?? null;
    return none('Closed as duplicate/superseded: evidence routes to the surviving item', { kind: 'routes_to_survivor', text: 'Routes to the surviving item' }, { redirectTo: to });
  }
  switch (item.status) {
    case 'suggested':
      return none('Suggested: evidence attached; it stays in Triage until you accept it', { kind: 'triage', text: 'In Triage' });
    case 'dismissed':
      return none('Dismissed: stays dismissed (only a direct ask brings it back)', { kind: 'stays_dismissed', text: 'Stays dismissed' });
    case 'snoozed':
      if (settings.snoozeWakeOnNewInfo && s.evidenceId) return wake(item, s, 'new info arrived');
      return none(`Snoozed until ${item.snoozedUntil ?? 'later'}: evidence attached`, { kind: 'stays_snoozed', text: 'New info while snoozed' });
    case 'done':
      return onDone(item, s, settings);
    default:
      return onLive(item, s, settings);
  }
}

function runStateOf(s: Signal): RunState | null {
  if (s.type !== 'session') return null;
  switch (s.status) {
    case 'waiting':
      return 'waiting_on_you';
    case 'running':
      return 'running';
    case 'done':
      return s.launchedByApp ? 'done_review' : 'done';
    case 'failed':
      return 'failed';
  }
}

/** Side fields a target status needs (DATA-MODEL CHECKs: done ⇔ done_at + done_by; waiting_on_me ⇒ reason). */
const REQUIRED_WITH: Partial<Record<WorkItemStatus, ClosureField[]>> = {
  done: ['doneAt', 'doneBy'],
  waiting_on_me: ['waitingReason'],
};

/** User-locked fields (R-UI-20): an engine change to a locked field becomes a proposal, never a write. */
function enforceLocks(item: ClosureItem, s: Signal, d: ClosureDecision): ClosureDecision {
  const groupId = `${item.id}:${s.evidenceId ?? s.at}`;
  const confidence: Confidence | null = 'confidence' in s && s.confidence ? s.confidence : null;
  const proposal = (field: string, currentValue: unknown, proposedValue: unknown): ProposalSpec => ({
    entityType: 'work_items',
    entityId: item.id,
    groupId,
    field,
    currentValue: currentValue ?? null,
    proposedValue: proposedValue ?? null,
    reason: d.reason,
    evidenceId: s.evidenceId,
    baseVersion: item.version,
    confidence,
  });
  // A transition whose DB-required side field is locked can't be half-applied: propose all of it.
  const required = d.transition ? (REQUIRED_WITH[d.transition.to] ?? []) : [];
  const blocked = d.fieldChanges.some((c) => required.includes(c.field) && isLocked(item, c.field));
  if (d.transition && (isLocked(item, 'status') || blocked)) {
    const proposals = [proposal('status', d.transition.from, d.transition.to), ...d.fieldChanges.map((c) => proposal(c.field, c.before, c.after))];
    return {
      ...d,
      kind: 'proposal',
      transition: null,
      fieldChanges: [],
      proposals,
      resolution: null,
      reopenDecision: d.reopenDecision ? { ...d.reopenDecision, outcome: 'ignored' } : null,
      labels: [{ kind: 'proposal', text: `New info → update? ${d.reason}` }],
    };
  }
  const lockedChanges = d.fieldChanges.filter((c) => isLocked(item, c.field));
  if (lockedChanges.length === 0) return d;
  const kept = d.fieldChanges.filter((c) => !isLocked(item, c.field));
  const proposals = lockedChanges.map((c) => proposal(c.field, c.before, c.after));
  const kind = d.transition ? 'transition' : kept.length > 0 ? 'update' : 'proposal';
  return {
    ...d,
    kind,
    fieldChanges: kept,
    proposals,
    labels: [...d.labels, { kind: 'proposal', text: `New info → update ${lockedChanges.map((c) => c.field).join(', ')}?` }],
  };
}

export function applySignal(item: ClosureItem, signal: Signal, settings: ClosureSettings = DEFAULT_CLOSURE_SETTINGS): ClosureDecision {
  const s = normalizeSignal(signal);
  const decided = enforceLocks(item, s, route(item, s, settings));
  return { ...decided, runState: runStateOf(s) };
}
