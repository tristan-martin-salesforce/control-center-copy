/**
 * A row's urgency (0–1). A row that stands for a work item takes priority@2's urgency term (src/engines/priority/v2/
 * terms.ts `urgencyOf`: start-by passed 1, later today .8 → 1, next working day .5, within 3 working days .3, later .1,
 * nothing dated .05; late hard deadlines 1 for a working day then .6; waiting on others ×.3). Every other kind has a
 * default here: a run that waits on your answer is the most urgent thing that is not a deadline.
 */
import type { NeedGroupKey, NeedKind, WorkItemRecord } from '@/contract';
import type { WorkingHours } from '@/engines/types';
import { localDayStart } from '@/engines/priority/time';
import { lateState } from '@/engines/priority/why';
import { DEFAULT_PRIORITY_CONFIG } from '@/engines/priority/v2/config';
import { urgencyOf } from '@/engines/priority/v2/terms';
import type { NeedsContext } from './types';

const MIN = 60_000;
const DAY = 86_400_000;

/** The kind's urgency when the fact is not a dated work item. */
export const KIND_URGENCY: Readonly<Record<NeedKind, number>> = {
  spend_ask: 0.9,
  setup_step: 0.7,
  outbox_draft: 0.6,
  reopen_review: 0.6,
  triage_guess: 0.5,
  mapping_question: 0.4,
  time_ready_to_log: 0.4,
  resolution_confirm: 0.3,
  dc_suggestion: 0.3,
  vdp_change: 0.3,
  use_case_candidate: 0.3,
};

/** The kinds that are admin by nature (a page's Admin group); deal kinds group under Deal. */
const ADMIN: ReadonlySet<NeedKind> = new Set(['time_ready_to_log', 'vdp_change', 'setup_step', 'spend_ask']);
const DEAL: ReadonlySet<NeedKind> = new Set(['dc_suggestion', 'use_case_candidate']);

/** Mon–Fri 09:00–18:00 in the user's offset: the horizon priority@2 plans in when Settings has nothing better. */
function hoursOf(ctx: Pick<NeedsContext, 'utcOffsetMinutes' | 'timeZone'>): WorkingHours {
  return { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], utcOffsetMinutes: ctx.utcOffsetMinutes, timeZone: ctx.timeZone };
}

/** The end (a UTC instant) of the n-th working day from today (0 = today). */
function workDayEnd(nowMs: number, offset: number, n: number): number {
  let start = localDayStart(nowMs, offset);
  let left = n;
  while (left > 0) {
    start += DAY;
    const dow = new Date(start + offset * MIN).getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return start + DAY;
}

/** The next working morning at 09:00 local, as an ISO instant (Later's default). */
export function nextWorkingMorning(ctx: Pick<NeedsContext, 'nowMs' | 'utcOffsetMinutes'>): string {
  let start = localDayStart(ctx.nowMs, ctx.utcOffsetMinutes) + DAY;
  while ([0, 6].includes(new Date(start + ctx.utcOffsetMinutes * MIN).getUTCDay())) start += DAY;
  return new Date(start + 9 * 60 * MIN).toISOString();
}

const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** priority@2's urgency for a work item, from its due date, start-by, deadline kind and whether it waits on others. */
export function workItemUrgency(w: Pick<WorkItemRecord, 'due' | 'startBy' | 'dueKind' | 'waiting'>, ctx: Pick<NeedsContext, 'nowMs' | 'utcOffsetMinutes' | 'timeZone'>): number {
  const cfg = DEFAULT_PRIORITY_CONFIG;
  const needByMs = toMs(w.due);
  const startByMs = toMs(w.startBy) ?? needByMs;
  const dueKind = needByMs === null ? null : (w.dueKind ?? 'hard');
  const late = needByMs !== null && needByMs <= ctx.nowMs ? lateState(needByMs, ctx.nowMs, dueKind, hoursOf(ctx)) : null;
  const off = ctx.utcOffsetMinutes;
  const slack = startByMs === null ? 0 : Math.max(0, (startByMs - ctx.nowMs) / MIN);
  return urgencyOf(
    {
      nowMs: ctx.nowMs,
      needByMs,
      startByMs: late ? null : startByMs,
      late,
      dueKind,
      awaitingThem: !!w.waiting,
      slackWorkMin: slack,
      workdayMin: cfg.urgency.laterTodaySlackMin,
      todayEndMs: workDayEnd(ctx.nowMs, off, 0),
      nextWorkDayEndMs: workDayEnd(ctx.nowMs, off, 1),
      thirdWorkDayEndMs: workDayEnd(ctx.nowMs, off, 3),
    },
    cfg,
  ).value;
}

/**
 * Where a page puts the row: admin kinds under Admin, DC and use-case kinds under Deal, the rest by when it bites
 * (Today when it is urgent or due today, else This week).
 */
export function groupKeyOf(kind: NeedKind, urgency: number, dueIso: string | null | undefined, ctx: Pick<NeedsContext, 'nowMs' | 'utcOffsetMinutes'>): NeedGroupKey {
  if (ADMIN.has(kind)) return 'admin';
  if (DEAL.has(kind)) return 'deal';
  const due = toMs(dueIso);
  if (urgency >= 0.8 || (due !== null && due < workDayEnd(ctx.nowMs, ctx.utcOffsetMinutes, 0))) return 'today';
  return 'this_week';
}
