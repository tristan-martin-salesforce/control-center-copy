/**
 * The priority engine's item and meeting inputs from contract records: one pure builder used by the db DataSource
 * (`db/rank.ts` `priorityInputs`), the mock's capacity (through the same function) and the golden-day evals
 * (`tests/evals/priority`), so a test can't drift from prod (lane 07 R9, §4.5).
 *
 * R2 (PRIO-6, PRIO-9): the judgment inputs reach the scorer instead of being dropped:
 * - `importance` and `dueKind` from the item (the extractor's, never a function of rank);
 * - `askedAt` = the earliest origin evidence's time (SLA rules count from the ask, not from when the app saw it);
 * - people's `tier` (leader, customer exec…) first, the role-text guess only when the tier is the default;
 * - `fromManager` only when the manager is the asker (the origin evidence's author) or the counterparty, or the
 *   extractor said so; the manager merely being on the item no longer counts;
 * - `customerFacing` from the extractor when it said so, else left to the engine (stakeholders, meeting).
 */
import type { CalendarEvent, WorkItemRecord, WorkState } from '@/contract';
import type { Meeting, PersonLite, StakeholderTier, WorkItemStatus } from '@/engines/types';
import type { PriorityItemV2 } from './types';

/** The fields of a work item the builder reads. */
export type PriorityItemRecord = Pick<
  WorkItemRecord,
  | 'id'
  | 'title'
  | 'kind'
  | 'state'
  | 'due'
  | 'effort'
  | 'people'
  | 'counterparty'
  | 'accountId'
  | 'oppId'
  | 'initiativeId'
  | 'servesEventId'
  | 'createdAt'
  | 'isBackground'
  | 'signals'
  | 'training'
  | 'sources'
> &
  Partial<Pick<WorkItemRecord, 'importance' | 'dueKind'>> & {
    /**
     * priority@2 reads these when a record carries them (the resolution check / extractor add them later; lane 07
     * §4.3): absent = no size class, awaiting none.
     */
    size?: PriorityItemV2['size'];
    awaiting?: PriorityItemV2['awaiting'];
    awaitingSince?: string | null;
    adminClass?: string | null;
  };

/** A directory person as the builder needs it (contract `Person` fits). */
export interface PriorityPerson {
  role?: string;
  title?: string;
  isManager?: boolean;
  isExternal?: boolean;
  tier?: StakeholderTier;
}

/** Evidence as the builder needs it (contract `Evidence` fits). */
export interface PriorityEvidence {
  workItemId: string;
  role: string;
  at: string;
  source?: { at?: string };
  author?: string | null;
}

export interface PriorityItemSource {
  items: readonly PriorityItemRecord[];
  person: (id: string) => PriorityPerson | undefined;
  oppAmount: (id: string) => number | null | undefined;
  evidence: readonly PriorityEvidence[];
  /** True once the item's agent run has started (a linked session or tool run is past queued). */
  agentStarted?: (w: PriorityItemRecord) => boolean;
}

const ENGINE_STATUS: Record<WorkState, WorkItemStatus> = {
  suggested: 'suggested',
  open: 'open',
  in_progress: 'in_progress',
  waiting_on_me: 'waiting_on_me',
  waiting_on_others: 'waiting_on_others',
  likely_done: 'likely_done',
  done: 'done',
  reopened: 'open', // "reopened" is a label on open (ENGINES.md §5)
  snoozed: 'snoozed',
  dismissed: 'dismissed',
};

/** The role-text guess, used only when the person's stored tier is the default (`normal`) or absent. */
export function guessTier(p: { role?: string; title?: string; isManager?: boolean; isExternal?: boolean }): StakeholderTier | undefined {
  const role = `${p.role ?? ''} ${p.title ?? ''}`.trim().toLowerCase();
  if (p.isManager) return 'manager';
  if (p.isExternal) return /\b(vp|chief|cxo|ceo|cio|cto|cdo|head|director|exec)/.test(role) ? 'customer_exec' : 'customer';
  if (/\bae\b|account exec/.test(role)) return 'ae';
  if (/partner|\bsi\b/.test(role)) return 'partner';
  if (/leader|\brvp\b|\bavp\b/.test(role)) return 'leader';
  return role ? 'teammate' : undefined;
}

/** `people.tier` when it says something, else the guess. A manager flag always reads as the manager. */
export function tierFor(p: PriorityPerson): StakeholderTier | undefined {
  if (p.tier && p.tier !== 'normal') return p.isManager && p.tier !== 'leader' ? 'manager' : p.tier;
  return guessTier(p);
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Origin evidence per item: the earliest ask time and its author. */
function originsOf(evidence: readonly PriorityEvidence[]): Map<string, { at: string; author: string | null }> {
  const out = new Map<string, { at: string; author: string | null }>();
  for (const e of evidence) {
    if (e.role !== 'origin') continue;
    const at = e.source?.at ?? e.at;
    const cur = out.get(e.workItemId);
    if (!cur || at < cur.at) out.set(e.workItemId, { at, author: e.author ?? null });
  }
  return out;
}

export function priorityItemsFrom(src: PriorityItemSource): PriorityItemV2[] {
  const lastEvidence = new Map<string, string>();
  for (const e of src.evidence) if (!lastEvidence.has(e.workItemId) || e.at > lastEvidence.get(e.workItemId)!) lastEvidence.set(e.workItemId, e.at);
  const origins = originsOf(src.evidence);
  return src.items.map((w) => {
    const refs = [...w.people, ...(w.counterparty && !w.people.some((p) => p.id === w.counterparty!.id) ? [w.counterparty] : [])];
    const stakeholders: PersonLite[] = refs.map((p) => {
      const full = src.person(p.id);
      const ref: PriorityPerson = { ...(p.role ? { role: p.role } : {}), ...(p.isManager ? { isManager: true } : {}), ...(p.isExternal ? { isExternal: true } : {}), ...(full ?? {}) };
      const tier = tierFor(ref);
      return { id: p.id, name: p.name, isManager: !!ref.isManager, isExternal: !!ref.isExternal, ...(tier ? { tier } : {}) };
    });
    const isMgr = (id: string | undefined) => !!id && stakeholders.some((s) => s.id === id && (s.isManager || s.tier === 'manager'));
    const origin = origins.get(w.id);
    const askerIsManager = !!origin?.author && stakeholders.some((s) => (s.isManager || s.tier === 'manager') && norm(s.name) === norm(origin.author));
    const fromManager = !!w.signals.fromManager || isMgr(w.counterparty?.id) || askerIsManager;
    return {
      id: w.id,
      title: w.title,
      kind: w.kind,
      status: ENGINE_STATUS[w.state],
      due: w.due,
      dueKind: w.dueKind ?? null,
      importance: w.importance ?? 'normal',
      effort: { youMin: w.effort.youMin, agentMin: w.effort.agentMin },
      stakeholders,
      accountId: w.accountId,
      oppId: w.oppId,
      oppAmount: w.oppId ? (src.oppAmount(w.oppId) ?? null) : null,
      initiativeId: w.initiativeId,
      servesEventId: w.servesEventId,
      createdAt: w.createdAt,
      askedAt: origin && origin.at < w.createdAt ? origin.at : null,
      lastEvidenceAt: lastEvidence.get(w.id) ?? null,
      isBackground: w.isBackground,
      ...(w.signals.customerFacing ? { customerFacing: true } : {}),
      fromManager,
      userAdjustment: w.signals.boost,
      agentStarted: src.agentStarted ? src.agentStarted(w) : false,
      training: w.training ? { mandatory: !!w.training.dueDate || w.training.overdue, requiredBy: w.training.dueDate ? `${w.training.dueDate}T23:59:00.000Z` : null } : null,
      source: w.sources[0]?.kind ?? null,
      counterpartyId: w.counterparty?.id ?? null,
      ...(w.size ? { size: w.size } : {}),
      ...(w.awaiting ? { awaiting: w.awaiting } : {}),
      ...(w.awaitingSince ? { awaitingSince: w.awaitingSince } : {}),
      ...(w.adminClass ? { adminClass: w.adminClass } : {}),
    };
  });
}

/** A calendar event as the engine's meeting. */
export function meetingOf(e: CalendarEvent): Meeting {
  return {
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    attendance: e.attendance === 'attended' || e.attendance === 'missed' || e.attendance === 'upcoming' ? e.attendance : 'unknown',
    hasExternalAttendees: e.attendees.some((a) => a.isExternal),
    isCustomerFacing: e.isCustomerFacing,
    accountId: e.accountId,
    oppId: e.oppId,
    status: e.attendance === 'cancelled' ? 'cancelled' : 'confirmed',
    // the invite's own answer when the event carries it (tentative / unanswered never block: isBusy)
    myResponse: e.attendance === 'declined' ? 'declined' : (e.myResponse ?? 'accepted'),
    isAllDay: e.isAllDay ?? false,
    eventType: e.eventType ?? 'default',
    prepItemIds: e.prep?.workItemId ? [e.prep.workItemId] : [],
  };
}

/**
 * Meetings from a day before `now` to `days` days after (default 5: priority@1.1's planning horizon plus the served
 * meetings; priority@2 plans back over 10 working days and asks for 16).
 */
export function meetingsFrom(events: readonly CalendarEvent[], now: Date, days = 5): Meeting[] {
  const from = now.getTime() - 86_400_000;
  const to = now.getTime() + days * 86_400_000;
  return events.filter((e) => Date.parse(e.start) >= from && Date.parse(e.start) <= to).map(meetingOf);
}
