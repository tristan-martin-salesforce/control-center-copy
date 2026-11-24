/**
 * rankWorkV2: priority@2 (lane 07 §4.1–4.2, H-8 all seven decisions). The same deterministic pipeline as priority@1.1
 * (policy rules, kick-off-first sequencing, never_above, Top N, lanes, the day plan and capacity: rank.ts), with:
 *
 *  1. need-by = the earliest of the due date, the served meeting (a prep rule's ready-before; an onsite pulls it to the
 *     working day before), the policy's SLA rules and the owed-reply SLA by the asker's tier;
 *  2. start-by planned backwards from the need-by through working hours minus meetings minus committed work
 *     (startby.ts), over 10 working days;
 *  3. P = V × (floor + U) + the policy's rule effects + your manual adjustment (terms.ts);
 *  4. admin as one quiet batch (admin.ts): never in the Top N, promoted to today's load only when due soon;
 *  5. capacity honesty: "Overbooked by N min" and a Make room list (capacity.ts); waiting on others → a chase.
 *
 * The why keeps the shape p0 shipped (why.ts): *matters* = the top two value terms, *now* = the need-by and start-by.
 * Pure: the persona's config comes in `inputs.priorityConfig`; no persona-specific code lives here.
 */
import type { Meeting, PersonLite, StakeholderTier } from '@/engines/types';
import { rankWork, type RankEngine } from '../rank';
import { effectiveDeadline, type Prepared, type ScoreContext } from '../score';
import { lateState } from '../why';
import { formatLocalWhen, freeIntervals, isBusy, localDayStart, DAY_MS, MINUTE_MS, toMs, workingWindows, type Interval } from '../time';
import type { PriorityInputs, PriorityItemV2, RankingResult, RankReason, ScoredItem, ScoreComponent } from '../types';
import { mattersFrom } from '../why';
import { adminBatchOf, adminClassOf, type AdminMember } from './admin';
import { makeRoom } from './capacity';
import { DEFAULT_PRIORITY_CONFIG, VALUE_TERMS, type AdminClassId, type PriorityConfig, type PriorityTerm, type ValueTerm } from './config';
import { isCustomerMeeting, onsiteDays, prepAdjust } from './prep';
import { freeMinutesBetween, planBackwards, type PlanJob } from './startby';
import { dealTerm, goalTerm, importanceTerm, KIND_LABEL, kindTerm, priorityOf, tierOfPerson, urgencyOf, valueOf, valuePoints, whoTerm, type KindClass, type UrgencyBucket, type ValueTerms } from './terms';

export const PRIORITY_ENGINE_VERSION_V2 = 'priority@2';

export type NeedBySource = 'due' | 'meeting' | 'sla' | 'reply_sla' | 'prep_rule' | 'onsite';

/** What priority@2 computed for one item (`ScoredItem.v2`; stored as `priority_scores.value`, `urgency`, `terms`). */
export interface V2Facts {
  value: number;
  urgency: number;
  floor: number;
  bucket: UrgencyBucket;
  /** Raw term values in [0, 1] (urgency included). */
  terms: Record<PriorityTerm, number>;
  /** weight · term per value term. */
  points: ValueTerms;
  labels: Partial<Record<ValueTerm, string>>;
  kindClass: KindClass;
  adminClass: AdminClassId | null;
  needBy: { at: string; source: NeedBySource; label: string } | null;
  /** The backward plan's start-by, and whether the work still fits before the need-by. */
  startBy: string | null;
  fits: boolean;
  /** Free working minutes between now and the start-by. */
  slackWorkMin: number | null;
  /** Σ policy rule effects (boost, penalty, SLA) + your manual adjustment. */
  ruleEffects: number;
}

export interface Chase {
  workItemId: string;
  title: string;
  /** The expected reply time (asked or waiting since + the reply SLA by tier, in working hours). */
  at: string;
  label: string;
}

/** Hands-on minutes per size class (lane 07 §4.1). */
export const SIZE_MIN = { xs: 10, s: 30, m: 90, l: 180, xl: 360 } as const;

const NEED_PREF: Record<NeedBySource, number> = { due: 0, meeting: 1, prep_rule: 2, onsite: 3, sla: 4, reply_sla: 5 };

/** `minutes` of working time after `fromMs` (an instant inside or before the windows). */
export function addWorkingMinutes(fromMs: number, minutes: number, windows: readonly { start: string; end: string }[]): number | null {
  let left = minutes * MINUTE_MS;
  for (const w of windows) {
    const s = Math.max(toMs(w.start), fromMs);
    const e = toMs(w.end);
    if (e <= s) continue;
    if (e - s >= left) return s + left;
    left -= e - s;
  }
  return null;
}

/** Working windows covering at least `workDays` working days from the day of `nowMs` (and the days before it for SLAs). */
function horizonWindows(inputs: PriorityInputs, nowMs: number, workDays: number) {
  const back = 14;
  const all = workingWindows(inputs.workingHours, nowMs - back * DAY_MS, back + Math.ceil(workDays * 1.6) + 4);
  const today = localDayStart(nowMs, inputs.workingHours.utcOffsetMinutes);
  const ahead = all.filter((w) => toMs(w.end) > today);
  const cut = ahead[Math.min(ahead.length, workDays + 1) - 1];
  return { past: all, ahead: cut ? ahead.filter((w) => toMs(w.start) <= toMs(cut.start)) : ahead };
}

/** The persona's customer-facing tiers decide it (the SE: customers; the AE: customers and partners). */
function customerFacingOf(item: PriorityItemV2, meeting: Meeting | null, cfg: PriorityConfig): boolean {
  if (item.customerFacing) return true;
  if (cfg.oppIsCustomerWork && item.oppId) return true;
  if (meeting && isCustomerMeeting(meeting)) return true;
  return (item.stakeholders ?? []).some((p) => !p.isMe && (cfg.customerFacingTiers.includes(tierOfPerson(p)) || (p.isExternal && cfg.customerFacingTiers.includes('customer'))));
}

function bestTier(stakeholders: readonly PersonLite[], cfg: PriorityConfig): StakeholderTier | null {
  let best: StakeholderTier | null = null;
  for (const p of stakeholders) {
    if (p.isMe) continue;
    const t = tierOfPerson(p);
    if (best === null || cfg.whoTier[t] > cfg.whoTier[best]) best = t;
  }
  return best;
}

const VALUE_KEY: Record<ValueTerm, string> = { who: 'value.who', deal: 'value.deal', kind: 'value.kind', importance: 'value.importance', goal: 'value.goal' };
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const usdShort = (amount: number): string => (amount >= 1_000_000 ? `$${Math.round(amount / 10_000) / 100}M` : `$${Math.round(amount / 1000)}k`);

const ADMIN_LABEL: Record<AdminClassId, string> = { logging: 'logging', dc: 'deal contributions', vdp: 'VDP', use_case: 'use cases', expense: 'expenses', training: 'training', forecast: 'forecast', sweep: 'sweep' };

interface State {
  facts: Map<string, V2Facts>;
  placed: Map<string, Interval[]>;
  free: Interval[];
  aheadWindows: ReturnType<typeof horizonWindows>['ahead'];
  pastWindows: ReturnType<typeof horizonWindows>['past'];
  promotedAdmin: Set<string>;
  adminMembers: AdminMember[];
  pinned: Set<string>;
  waiting: PriorityItemV2[];
}

export function createV2Engine(cfgIn?: PriorityConfig): RankEngine & { state: State } {
  const cfg = cfgIn ?? DEFAULT_PRIORITY_CONFIG;
  const state: State = { facts: new Map(), placed: new Map(), free: [], aheadWindows: [], pastWindows: [], promotedAdmin: new Set(), adminMembers: [], pinned: new Set(), waiting: [] };

  const engine: RankEngine & { state: State } = {
    version: PRIORITY_ENGINE_VERSION_V2,
    state,
    afterPrepare(prepared: Prepared[], ctx: ScoreContext, inputs: PriorityInputs) {
      const nowMs = ctx.nowMs;
      const off = ctx.utcOffsetMinutes;
      const hw = horizonWindows(inputs, nowMs, cfg.horizonWorkDays);
      state.aheadWindows = hw.ahead;
      state.pinned = new Set(inputs.pinnedToday ?? []);
      state.waiting = inputs.waitingItems ?? inputs.items.filter((i) => i.status === 'waiting_on_others');
      // the extractor's size class when the item has no estimate of its own (lane 07 §4.1; Hours are human hours)
      for (const p of prepared) {
        const size = (p.item as PriorityItemV2).size;
        if (size && p.effortSource !== 'item') {
          p.youMin = SIZE_MIN[size];
          p.effortSource = 'item';
        }
      }
      state.pastWindows = hw.past;
      const meetings = [...(inputs.horizonMeetings ?? inputs.meetings)].sort((a, b) => toMs(a.start) - toMs(b.start) || a.id.localeCompare(b.id));
      const busy = meetings.filter(isBusy).map((m) => ({ startMs: toMs(m.start), endMs: toMs(m.end) }));
      state.free = freeIntervals(hw.ahead, busy, nowMs, 5);
      const horizonEnd = hw.ahead.length ? toMs(hw.ahead[hw.ahead.length - 1]!.end) : nowMs;
      const onsite = onsiteDays(meetings, cfg, off, isBusy);
      const todayEndMs = localDayStart(nowMs, off) + DAY_MS;
      const futureDays = [...new Set(hw.ahead.map((w) => localDayStart(toMs(w.start), off)))].filter((d) => d >= todayEndMs).sort((a, b) => a - b);
      const nextWorkDayEndMs = (futureDays[0] ?? todayEndMs) + DAY_MS;
      const thirdWorkDayEndMs = (futureDays[2] ?? futureDays[futureDays.length - 1] ?? todayEndMs) + DAY_MS;

      // 1. need-by per item
      const focusStart = new Map<string, number | null>();
      const attend = cfg.attendPattern ? new RegExp(cfg.attendPattern, 'i') : null;
      interface Need {
        p: Prepared;
        item: PriorityItemV2;
        ms: number | null;
        source: NeedBySource | null;
        label: string | null;
        importance: NonNullable<PriorityItemV2['importance']>;
        dueKind: 'hard' | 'soft' | 'inferred' | null;
        adminClass: AdminClassId | null;
        awaitingThem: boolean;
      }
      const needs: Need[] = prepared.map((p) => {
        const item = p.item as PriorityItemV2;
        // a focus block, OOO or working-location event is planned time, never a deadline: you blocked it to do the
        // work, so it is a start-by hint instead (the work starts by the block)
        let focusStartMs: number | null = null;
        if (p.meeting && p.meeting.eventType && p.meeting.eventType !== 'default') {
          const startMs = toMs(p.meeting.start);
          if (p.meeting.eventType === 'focus_time' && startMs > nowMs) focusStartMs = startMs;
          const d = effectiveDeadline(item, null, p.features, ctx);
          p.meeting = null;
          p.deadline = d.deadline;
          p.deadlineMs = d.ms;
          p.late = d.ms !== null && d.ms <= nowMs && d.deadline ? lateState(d.ms, nowMs, d.deadline.source === 'due' ? (item.dueKind ?? null) : 'hard', ctx.workingHours) : null;
        }
        focusStart.set(item.id, focusStartMs);
        // the meeting holds the work when the item is attending it: no hands-on minutes before it
        if (p.meeting && attend && attend.test(item.title) && p.youMin <= (toMs(p.meeting.end) - toMs(p.meeting.start)) / MINUTE_MS) p.youMin = 0;
        const cands: Array<{ ms: number; source: NeedBySource; label: string }> = [];
        if (p.deadline && p.deadlineMs !== null) cands.push({ ms: p.deadlineMs, source: p.deadline.source, label: p.deadline.label });
        let importance = item.importance ?? 'normal';
        if (p.meeting) {
          const adj = prepAdjust({ importance }, p.meeting, cfg, { onsiteDayStarts: onsite, windows: hw.past, utcOffsetMinutes: off });
          importance = adj.importance;
          if (adj.needByMs !== toMs(p.meeting.start)) {
            cands.push({
              ms: adj.needByMs,
              source: adj.onsite ? 'onsite' : 'prep_rule',
              label: adj.onsite ? `ready before ${p.meeting.title} (onsite) · ${formatLocalWhen(adj.needByMs, nowMs, off)}` : `ready for ${p.meeting.title} ${formatLocalWhen(toMs(p.meeting.start), nowMs, off)}`,
            });
          }
        }
        // an owed reply with no date of its own: the asker's tier sets when it is due (working hours)
        if (item.kind === 'ask' && !item.due && item.awaiting !== 'them' && !p.late) {
          const tier = bestTier(item.stakeholders ?? [], cfg);
          const h = tier ? cfg.replySlaWorkH[tier] : undefined;
          if (h !== undefined) {
            const at = addWorkingMinutes(toMs(item.askedAt ?? item.createdAt), h * 60, hw.past);
            if (at !== null && at > nowMs) cands.push({ ms: at, source: 'reply_sla', label: `reply by ${formatLocalWhen(at, nowMs, off)} (your ${h}h rule for a ${tier!.replace('_', ' ')})` });
          }
        }
        // a passed SLA doesn't make it late while a concrete deadline is ahead (v1's rule, kept)
        const ahead = cands.filter((c) => c.ms > nowMs);
        const pool = ahead.length && p.late === null ? ahead : cands;
        pool.sort((a, b) => a.ms - b.ms || NEED_PREF[a.source] - NEED_PREF[b.source]);
        const first = pool[0] ?? null;
        return {
          p,
          item,
          ms: first?.ms ?? null,
          source: first?.source ?? null,
          label: first?.label ?? null,
          importance,
          dueKind: first?.source === 'due' ? (item.dueKind ?? null) : null,
          adminClass: adminClassOf(item, cfg),
          awaitingThem: item.awaiting === 'them',
        };
      });

      // 2. start-by planned backwards through free time and committed work
      const jobs: PlanJob[] = [];
      for (const n of needs) {
        if (n.ms === null || n.p.late || n.ms <= nowMs || n.ms > horizonEnd + DAY_MS) continue;
        if (n.p.excluded) continue;
        // your minutes go into working time before the need-by (minus the buffer); an agent run is wall-clock time in
        // the background, so it only bounds the kick-off below (it never takes your hours: Hours are human hours)
        jobs.push({ id: n.item.id, needByMs: n.ms - ctx.policy.tuning.bufferMin * MINUTE_MS, effortMin: n.p.youMin });
      }
      const plan = planBackwards(jobs, state.free, { nowMs, reservePct: cfg.reservePct });

      // 3. terms, value, urgency, P
      for (const n of needs) {
        const { p, item } = n;
        const planned = plan.get(item.id);
        let plannedStart = planned ? planned.startByMs : n.ms !== null && n.ms > nowMs && !p.late ? n.ms : null;
        if (plannedStart !== null && n.ms !== null && p.agentRemainingMin > 0) {
          const kickoff = n.ms - (ctx.policy.tuning.bufferMin + p.agentRemainingMin + p.youMin) * MINUTE_MS;
          plannedStart = Math.max(nowMs, Math.min(plannedStart, kickoff));
        }
        const focus = focusStart.get(item.id) ?? null;
        const startByMs = focus !== null && !p.late && (plannedStart === null || focus < plannedStart) ? focus : plannedStart;
        if (planned) state.placed.set(item.id, planned.placed);
        const slackWorkMin = startByMs === null ? null : freeMinutesBetween(state.free, nowMs, startByMs);
        const cf = customerFacingOf(item, p.meeting, cfg);
        const customerPrep = !!p.meeting && (isCustomerMeeting(p.meeting) || cf);
        const who = whoTerm(item.stakeholders ?? [], !!p.features.from_manager, cfg, !!(item.accountId || item.oppId));
        const deal = dealTerm(item.oppAmount, cfg);
        const kind = kindTerm({ kind: item.kind, customerFacing: cf, customerPrep, admin: n.adminClass !== null }, cfg);
        const imp = importanceTerm(n.importance, cfg);
        const atRisk = n.adminClass !== null && (p.late !== null || (startByMs !== null && startByMs < todayEndMs) || (n.ms !== null && n.ms - nowMs <= cfg.admin.promoteWithinH * 3_600_000));
        const goal = goalTerm({ payLinked: n.adminClass !== null && cfg.admin.payLinked.includes(n.adminClass), atRisk }, cfg);
        const terms: ValueTerms = { who: who.value, deal, kind: kind.value, importance: imp, goal };
        const value = valueOf(terms, cfg.weights);
        const points = valuePoints(terms, cfg.weights);
        const u = urgencyOf(
          { nowMs, needByMs: n.ms, startByMs: p.late ? null : startByMs, late: p.late, dueKind: n.dueKind, awaitingThem: n.awaitingThem, slackWorkMin: slackWorkMin ?? 0, workdayMin: cfg.urgency.laterTodaySlackMin, todayEndMs, nextWorkDayEndMs, thirdWorkDayEndMs },
          cfg,
        );
        const superseded = new Set(cfg.supersededRuleEffects);
        const ruleEffects = round3(p.ruleHits.reduce((s, h) => s + ((h.kind === 'boost' || h.kind === 'penalty' || h.kind === 'sla') && !superseded.has(h.ruleKey) ? (h.effect ?? 0) : 0), 0) + (item.userAdjustment ?? 0));
        const total = priorityOf(value, u.value, cfg.urgency.floor, ruleEffects);
        const amount = item.oppAmount ?? 0;
        const labels: Partial<Record<ValueTerm, string>> = {
          ...(who.label ? { who: who.label } : {}),
          ...(amount > 0 ? { deal: `opp ${usdShort(amount)}` } : {}),
          ...(KIND_LABEL[kind.cls] ? { kind: n.adminClass ? `admin: ${ADMIN_LABEL[n.adminClass]}` : KIND_LABEL[kind.cls]! } : {}),
          ...(n.importance === 'critical' || n.importance === 'high' ? { importance: `importance: ${n.importance}` } : {}),
          ...(goal > 0 ? { goal: 'pay-linked, at risk' } : {}),
        };

        // rewrite what the shared pipeline orders by
        p.total = total;
        p.startByMs = p.late ? null : startByMs;
        p.slackMinutes = p.startByMs === null ? null : Math.round((p.startByMs - nowMs) / MINUTE_MS);
        p.preempt = item.status === 'open' && n.ms !== null && n.ms > nowMs && p.startByMs !== null && p.startByMs <= nowMs + ctx.policy.tuning.preemptGraceMin * MINUTE_MS;
        if (n.ms !== null && n.source && n.label && (n.source === 'reply_sla' || n.source === 'prep_rule' || n.source === 'onsite')) {
          p.deadline = { at: new Date(n.ms).toISOString(), source: n.source === 'reply_sla' ? 'sla' : 'meeting', label: n.label, ...(p.meeting ? { eventId: p.meeting.id } : {}) };
          p.deadlineMs = n.ms;
        }
        p.freeBeforeMin = n.ms !== null && n.ms > nowMs ? freeMinutesBetween(state.free, nowMs, n.ms) : null;
        const keep = p.components.filter((c) => c.key === 'userAdjustment' || c.key === 'penalty');
        const comps: ScoreComponent[] = [
          { key: 'stakeholderImportance', feature: who.value, weight: cfg.weights.who, points: points.who, reason: labels.who ?? null },
          { key: 'dealValue', feature: deal, weight: cfg.weights.deal, points: points.deal, reason: labels.deal ?? null },
          { key: 'commitmentWeight', feature: kind.value, weight: cfg.weights.kind, points: points.kind, reason: labels.kind ?? null },
          { key: 'obligationBoost', feature: goal, weight: cfg.weights.goal, points: points.goal, reason: labels.goal ?? null },
          ...keep,
        ];
        p.components = comps;

        state.facts.set(item.id, {
          value,
          urgency: u.value,
          floor: cfg.urgency.floor,
          bucket: u.bucket,
          terms: { ...terms, urgency: u.value },
          points,
          labels,
          kindClass: kind.cls,
          adminClass: n.adminClass,
          needBy: n.ms !== null && n.source && n.label ? { at: new Date(n.ms).toISOString(), source: n.source, label: n.label } : null,
          startBy: p.startByMs === null ? null : new Date(p.startByMs).toISOString(),
          fits: planned ? planned.fits : true,
          slackWorkMin,
          ruleEffects,
        });

        if (n.adminClass && !p.excluded) {
          const m: AdminMember = { id: item.id, title: item.title, cls: n.adminClass, youMin: p.youMin, dueMs: n.ms, startByMs: p.startByMs, late: p.late !== null };
          state.adminMembers.push(m);
          if (m.late || (m.dueMs !== null && m.dueMs - nowMs <= cfg.admin.promoteWithinH * 3_600_000) || (m.startByMs !== null && m.startByMs < todayEndMs)) state.promotedAdmin.add(item.id);
        }
      }
    },
    // after the main list: re-date rows (a late soft or inferred date: a ten-second decision, not work), then the
    // admin batch (never individually in the Top N)
    tail: (p) => (state.facts.get(p.item.id)?.adminClass != null ? 2 : p.late?.kind === 'redate' && !p.laneFloor ? 1 : 0),
    topNEligible: (p) => state.facts.get(p.item.id)?.adminClass == null,
    // a hard deadline past its grace day asks "do now or re-date": it leaves the Now lane for Next
    lane: (p, base) => (p.late?.kind === 'late' && !p.laneFloor && base === 'now' ? 'next' : base),
    // kick-off-first moves only work that matters: a long agent run on a low-value item never jumps the list
    canKickOff: (p) => (state.facts.get(p.item.id)?.value ?? 0) >= cfg.kickoffMinValue && state.facts.get(p.item.id)?.adminClass == null,
    extraToday: () => state.promotedAdmin,
    decorate(s: ScoredItem, p: Prepared): ScoredItem {
      const f = state.facts.get(p.item.id);
      if (!f) return s;
      const reasons: RankReason[] = [];
      for (const t of VALUE_TERMS) if (f.points[t] > 0 && f.labels[t]) reasons.push({ key: VALUE_KEY[t], label: f.labels[t]!, contribution: f.points[t] });
      for (const h of s.ruleHits) if (h.kind !== 'penalty') reasons.push({ key: `rule:${h.ruleKey}`, label: h.explanation, contribution: h.effect ?? 0 });
      if (s.sequencing) reasons.unshift({ key: 'sequencing', label: s.sequencing.reason, contribution: 0 });
      reasons.sort((a, b) => (a.key === 'sequencing' ? -1 : b.key === 'sequencing' ? 1 : b.contribution - a.contribution || a.key.localeCompare(b.key)));
      // why.now came from the shared whyOf over the rewritten need-by, start-by and free time
      return { ...s, reasons, explanation: reasons.slice(0, 3).map((r) => r.label).join(' · '), why: { matters: mattersFrom(reasons), now: s.why.now }, v2: f };
    },
    finish(r: RankingResult, st): RankingResult {
      const nowMs = st.ctx.nowMs;
      const off = st.ctx.utcOffsetMinutes;
      const todayStart = localDayStart(nowMs, off);
      const todayEnd = todayStart + DAY_MS;
      const todayFree = state.free.filter((i) => i.startMs < todayEnd);
      const committed = [...state.placed].map(([id, placed]) => ({ placed, value: state.facts.get(id)?.value ?? 0 }));
      const adminBatch = adminBatchOf(state.adminMembers.filter((m) => r.scores[m.id]), { nowMs, todayEndMs: todayEnd, utcOffsetMinutes: off, promoteWithinH: cfg.admin.promoteWithinH, todayFree, committed });
      const pinned = state.pinned;
      // a hard deadline later today can't be moved to make room (renegotiating it is the user's call, not a suggestion)
      const hardDueToday = (p: Prepared) => p.deadline?.source === 'due' && (p.item.dueKind ?? 'hard') === 'hard' && p.deadlineMs !== null && p.deadlineMs < todayEnd;
      const room =
        !r.capacity.fits && r.capacity.day === 'today'
          ? makeRoom(
              st.today.map((p) => {
                const f = state.facts.get(p.item.id);
                return { id: p.item.id, title: p.item.title, youMin: p.youMin, value: f?.value ?? 0, needByMs: f?.needBy ? toMs(f.needBy.at) : null, locked: pinned.has(p.item.id) || (p.late !== null && p.late.kind !== 'redate') || hardDueToday(p) };
              }),
              r.capacity.youMinToday - r.capacity.freeMin,
              { nowMs, utcOffsetMinutes: off },
            )
          : null;
      const chases: Chase[] = [];
      const chaseOf = (item: PriorityItemV2) => {
        const tier = bestTier(item.stakeholders ?? [], cfg);
        const h = (tier ? cfg.replySlaWorkH[tier] : undefined) ?? 24;
        const since = toMs(item.awaitingSince ?? item.lastEvidenceAt ?? item.askedAt ?? item.createdAt);
        const at = addWorkingMinutes(since, h * 60, state.pastWindows.length ? state.pastWindows : state.aheadWindows);
        if (at === null) return;
        const who = (item.stakeholders ?? []).find((p) => !p.isMe && tierOfPerson(p) === tier)?.name.split(' ')[0];
        chases.push({ workItemId: item.id, title: item.title, at: new Date(at).toISOString(), label: `Chase${who ? ` ${who}` : ''} ${at <= nowMs ? 'now' : formatLocalWhen(at, nowMs, off)}` });
      };
      for (const p of st.prepared) if ((p.item as PriorityItemV2).awaiting === 'them') chaseOf(p.item as PriorityItemV2);
      for (const w of state.waiting) chaseOf(w);
      chases.sort((a, b) => a.at.localeCompare(b.at) || a.workItemId.localeCompare(b.workItemId));
      return { ...r, adminBatch, makeRoom: room, chases };
    },
  };
  return engine;
}

/** priority@2 over the same inputs as priority@1.1 (the persona's config in `inputs.priorityConfig`). */
export function rankWorkV2(inputs: PriorityInputs): RankingResult {
  return rankWork(inputs, createV2Engine(inputs.priorityConfig));
}
