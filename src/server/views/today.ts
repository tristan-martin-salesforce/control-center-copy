/**
 * Today, read side (R7 step 3): the spine, the NOW stack, More today, the shelves, the rail and the badges, over the
 * same read source in both DataSources (docs/reviews/2026-11-20-holistic/19-read-twins.md). What only a store knows
 * comes in as `TodayReads`: its ranker's Top 3 over its stored order (the db's DbRanker over Q1; the mock's scorer),
 * each engine close's undo id, the since-you-left digest (its audit), and the capacity when the ranker has no plan.
 */
import { endOfDay, startOfDay } from 'date-fns';

import type { ActivityEntry, RailEntry, RailLane, ShelfEntry, SinceDigest, TodayPayload } from '@/contract';
import { adminDraftHref, isAdminDraft } from '@/contract';
import { loggingProfile, personaTargetH } from '@/engines/activity/persona';
import { toLogCount, type CanvasLike } from '@/engines/activity/to-log-count';
import { rowsIn, toLogBase, toLogRange } from '@/engines/activity/to-log-rows';
import { actionApp } from '@/lib/actions';
import { adminWaitingBySurface, connectorRowsFor, draftHasSurface, personaOf } from '@/personas';
import { quarterTotal } from '@/server/datasource/db/quarter';
import { logCanvasesOf } from '@/server/datasource/log-canvases';
import type { TodayRank } from '@/server/datasource/db/rank';

import { healthSummary } from './health';
import { fmtHM, hrefFor, isLive, itemRef, plural } from './refs';
import type { ReadSource } from './source';
import { triageView } from './triage';
import { hydrateItem, nowCardFor } from './work';

/** LD-1: the Top 3 without likely-done items, refilled from the rest in order (they stay in the rest). */
export function topWithoutLikelyDone<T extends { id: string; state: string }>(top: T[], rest: T[]): { top: T[]; rest: T[] } {
  if (!top.some((w) => w.state === 'likely_done')) return { top, rest };
  const kept = top.filter((w) => w.state !== 'likely_done');
  const fill = rest.filter((w) => w.state !== 'likely_done').slice(0, Math.max(0, top.length - kept.length));
  const fillIds = new Set(fill.map((w) => w.id));
  return { top: [...kept, ...fill], rest: [...top.filter((w) => w.state === 'likely_done'), ...rest.filter((w) => !fillIds.has(w.id))] };
}

/** What only the store knows, computed by its DataSource before the view runs. */
export interface TodayReads {
  /** The store's ranker over its stored order: Top 3, the rest, "re-rank ready", and ENGINES-core's plan when it has one. */
  rank: TodayRank;
  /** Work item id → the undo id of its latest engine close (null: no Undo, Reopen instead). */
  closeUndo: (itemId: string) => string | null;
  since: SinceDigest;
  /** The CAPACITY engine's numbers, read only when the ranker has no plan (the plan carries its own). */
  capacity: () => TodayPayload['header']['capacity'];
}

function minutesBetween(a: string | Date, b: string | Date): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

const ymdUtc = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The rows Activity ▸ To log reads, the one row set (src/engines/activity/to-log-rows.ts, F1): the quarter so far (or
 * three weeks before this week's Monday when that is earlier) through this week's Sunday, widened back to the quarter
 * of the oldest row that still needs you.
 */
export function toLogRows(rows: readonly ActivityEntry[], quarterStart: string, now: Date, canvases: readonly CanvasLike[] | null, taskTypeRequired: boolean): ActivityEntry[] {
  const today = ymdUtc(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
  return rowsIn(rows, toLogRange({ rows, canvases, taskTypeRequired, base: toLogBase(today, quarterStart) }));
}

/** GET /today without the counts its DataSource adds (VDPs, canvases waiting, staged Assistant cards). */
export function todayView(m: ReadSource, inp: TodayReads, now: Date): TodayPayload {
  const meta = m.meta();
  const settings = m.settings();
  const policy = settings.policy;
  const nowIso = now.toISOString();
  const dayStart = startOfDay(now).getTime();
  const dayEnd = endOfDay(now).getTime();

  const events = m
    .all('events')
    .filter((e) => Date.parse(e.start) >= dayStart && Date.parse(e.start) <= dayEnd)
    .sort((a, b) => a.start.localeCompare(b.start));
  const plan = inp.rank.plan;
  const seededSlots = m
    .all('slots')
    .filter((s) => Date.parse(s.start) >= dayStart && Date.parse(s.start) <= dayEnd)
    .sort((a, b) => a.start.localeCompare(b.start));
  const slots = plan ? plan.slots : seededSlots;

  // LD-1: a likely-done item never takes a NOW slot (it waits for Confirm in Home's and Triage's Looks done group)
  const { top, rest: restRanked } = topWithoutLikelyDone(inp.rank.top, inp.rank.rest);
  const topIds = new Set(top.map((i) => i.id));
  const cards = top.map((i) => nowCardFor(m, i));
  const moreTodayItems = restRanked.slice(0, 12);

  const gaps = slots.filter((s) => s.kind === 'gap' && Date.parse(s.end) > now.getTime());
  const listed = new Set([...topIds, ...moreTodayItems.map((i) => i.id)]);
  const tz = settings.profile.timezone;
  const planned = (xs: { id: string; hint: string }[], action: (x: { id: string; hint: string }) => ShelfEntry['action']): ShelfEntry[] =>
    xs.flatMap((x) => {
      const w = m.get('workItems', x.id);
      return w ? [{ item: hydrateItem(m, w), hint: x.hint, action: action(x) }] : [];
    });
  const fitIns: ShelfEntry[] = plan
    ? planned(plan.fitIns, () => ({ label: 'Start', verb: 'start' }))
    : m
    .all('workItems')
    .filter((i) => isLive(i) && !listed.has(i.id) && !i.isBackground && (i.kind === 'training' || (i.effort.youMin <= 30 && i.priority === 'high')))
    .sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'))
    .map((i) => {
      const gap = gaps.find((g) => minutesBetween(g.start, g.end) >= i.effort.youMin);
      const hint = gap ? `fits your ${fmtHM(gap.start, tz)} gap` : i.training?.overdue ? 'overdue' : `${i.effort.youMin}m`;
      return { item: hydrateItem(m, i), hint, action: { label: 'Start', verb: 'start' as const } };
    });
  const promises: ShelfEntry[] = plan
    ? planned(plan.promises, (x) => ((x as { verb?: string }).verb === 'renegotiate' ? { label: 'Renegotiate', verb: 'renegotiate' } : { label: 'Kick off', verb: 'kick_off' }))
    : m
    .all('workItems')
    .filter((i) => isLive(i) && i.isBackground)
    .sort((a, b) => b.ageDays - a.ageDays)
    .map((i) => ({ item: hydrateItem(m, i), hint: `promised ${i.ageDays}d ago`, action: { label: 'Kick off', verb: 'kick_off' as const } }));

  // tentative / unanswered invites show on the spine but are not "your next meeting" (they never block time)
  const upcoming = events.filter((e) => Date.parse(e.start) > now.getTime() && e.attendance === 'upcoming' && e.myResponse !== 'tentative' && e.myResponse !== 'needs_action');
  const next = upcoming[0];
  const activity = m.all('activity');
  // this fiscal quarter's logged rows only (projections keep every quarter's rows for past weeks and History)
  const { q: quarter, loggedH } = quarterTotal(meta, activity, now, tz, settings.profile.workingHours.end);
  // D-55: only the persona's active sources show as catching up
  const catching = connectorRowsFor(m.all('connectors'), personaOf(m.settings())).filter((c) => c.state === 'catching_up');

  const rail: RailLane[] = [];
  const since = inp.since;
  rail.push({
    lane: 'since_you_left',
    label: 'SINCE YOU LEFT',
    count: since.entries.length,
    summary: `${since.counts.changed} changed · ${since.counts.closed} closed · ${since.counts.new} new`,
    entries: since.entries.slice(0, 2).map((e, i) => ({ id: `since-${i}`, ref: e.ref, title: e.title, detail: e.detail, at: e.at, tone: 'neutral', action: null, evidence: null })),
    href: '/?sheet=since',
    visible: since.show,
  });

  const waitingRuns = m.all('agentRuns').filter((r) => r.state === 'waiting_on_you');
  const pendingDrafts = m.all('drafts').filter((d) => d.status === 'ready' && draftHasSurface(d, personaOf(m.settings())));
  const waitingEntries: RailEntry[] = [
    ...waitingRuns.map((r) => ({
      id: r.id,
      ref: { type: 'agent_run' as const, id: r.id, label: r.title, href: hrefFor({ type: 'agent_run', id: r.id }) },
      title: r.title,
      detail: r.waiting?.question ?? r.waiting?.reason ?? r.lastEvent,
      at: r.waiting?.since ?? r.updatedAt,
      tone: 'warn' as const,
      action:
        r.kind === 'claude_session'
          ? { kind: 'open_in_claude' as const, label: 'Open in Claude', href: r.deepLink, auditId: null, choices: [] }
          : { kind: 'answer' as const, label: 'Answer', href: null, auditId: null, choices: r.waiting?.choices ?? [] },
      evidence: null,
    })),
    ...pendingDrafts.map((d) => ({
      id: d.id,
      ref: { type: 'draft' as const, id: d.id, label: d.plainText.slice(0, 60), href: isAdminDraft(d) ? adminDraftHref(d) : hrefFor({ type: 'draft', id: d.id }) },
      title: `${isAdminDraft(d) ? 'Apply' : 'Approve'}: ${d.destination.kind === 'slack' ? d.destination.channelName : d.destination.kind === 'action' ? `${actionApp(d.destination.action)} · ${d.destination.target.label}` : d.destination.subject}`,
      detail: d.plainText.split('\n')[0] ?? null,
      at: d.updatedAt,
      tone: 'brand' as const,
      action: { kind: 'approve' as const, label: 'Review', href: isAdminDraft(d) ? adminDraftHref(d) : hrefFor({ type: 'draft', id: d.id }), auditId: null, choices: [] },
      evidence: null,
    })),
  ];
  rail.push({
    lane: 'waiting_on_you',
    label: 'WAITING ON YOU',
    count: waitingEntries.length,
    summary: `${plural(waitingRuns.length, 'session')} · ${plural(pendingDrafts.length, 'approval')}`,
    entries: waitingEntries,
    href: '/agents?state=waiting_on_you',
    visible: true,
  });

  const runs = m.all('agentRuns');
  const running = runs.filter((r) => r.state === 'running');
  const review = runs.filter((r) => r.state === 'done_review');
  const latest = [...running, ...review].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  rail.push({
    lane: 'agents',
    label: 'AGENTS',
    count: running.length + review.length,
    summary: `${running.length} running · ${review.length} to review`,
    entries: latest.slice(0, 2).map((r) => ({
      id: r.id,
      ref: { type: 'agent_run', id: r.id, label: r.title, href: hrefFor({ type: 'agent_run', id: r.id }) },
      title: r.title,
      detail: r.lastEvent,
      at: r.updatedAt,
      tone: r.state === 'running' ? 'brand' : 'ai',
      action: r.state === 'done_review' ? { kind: 'review', label: 'Review', href: hrefFor({ type: 'agent_run', id: r.id }), auditId: null, choices: [] } : null,
      evidence: null,
    })),
    href: '/agents',
    visible: true,
  });

  const waitingOthers = m
    .all('workItems')
    .filter((i) => i.state === 'waiting_on_others')
    .sort((a, b) => (a.waiting?.since ?? a.updatedAt).localeCompare(b.waiting?.since ?? b.updatedAt));
  rail.push({
    lane: 'waiting_on_others',
    label: 'WAITING ON OTHERS',
    count: waitingOthers.length,
    summary: waitingOthers[0] ? `oldest: ${waitingOthers[0].title} · ${Math.max(0, Math.round((now.getTime() - Date.parse(waitingOthers[0].waiting?.since ?? waitingOthers[0].updatedAt)) / 86_400_000))}d` : 'nothing pending',
    entries: waitingOthers.slice(0, 2).map((i) => ({
      id: i.id,
      ref: itemRef(i),
      title: i.title,
      detail: i.waiting?.reason ?? null,
      at: i.waiting?.since ?? null,
      tone: 'neutral',
      action: { kind: 'nudge', label: 'Nudge', href: null, auditId: null, choices: [] },
      evidence: null,
    })),
    href: '/work?tab=all_open&state=waiting_on_others',
    visible: true,
  });

  const closed = m
    .all('workItems')
    .filter((i) => i.state === 'done' && i.doneBy === 'engine' && i.doneAt && Date.parse(i.doneAt) >= Date.parse(meta.lastActiveAt) - 12 * 3_600_000)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  rail.push({
    lane: 'closed_for_you',
    label: 'CLOSED FOR YOU',
    count: closed.length,
    summary: `${closed.length} closed · undo z`,
    entries: closed.map((i) => {
      const auditId = inp.closeUndo(i.id);
      const ev = m.all('evidence').find((e) => e.workItemId === i.id && e.role === 'completion');
      return {
        id: i.id,
        ref: itemRef(i),
        title: i.title,
        detail: i.closedReason,
        at: i.doneAt,
        tone: 'ok' as const,
        action: auditId ? { kind: 'undo' as const, label: 'Undo', href: null, auditId, choices: [] } : null,
        evidence: ev?.source ?? null,
      };
    }),
    href: '/work?tab=done',
    visible: true,
  });

  const health = healthSummary(m);
  const brokenConn = m.all('connectors').filter((c) => health.broken.some((b) => b.id === c.id));
  rail.push({
    lane: 'health',
    label: 'HEALTH',
    count: health.broken.length,
    summary: health.broken.length ? `${health.broken.map((b) => b.label).join(', ')} needs attention` : `● ${health.ok}/${health.total}`,
    entries: brokenConn.map((c) => ({
      id: c.id,
      ref: { type: 'connector', id: c.id, label: c.label, href: hrefFor({ type: 'connector', id: c.id }) },
      title: `${c.label}: ${c.state.replace('_', ' ')}`,
      detail: c.impact ?? c.lastError?.message ?? null,
      at: c.since,
      tone: c.state === 'auth_needed' || c.state === 'error' ? 'risk' : 'warn',
      action: c.reauth ? { kind: 'reauth', label: c.reauth.label, href: null, auditId: null, choices: [] } : null,
      evidence: null,
    })),
    href: '/health',
    visible: true,
  });

  const briefs = m.all('briefs');
  const unreadBriefs = briefs.filter((b) => b.unread);
  const worth = briefs.reduce((s, b) => s + b.highlights.filter((h) => h.status === 'new' || h.status === 'seen').length, 0);
  rail.push({
    lane: 'briefs',
    label: 'BRIEFS',
    count: unreadBriefs.length,
    summary: `${unreadBriefs.length} new · ${worth} worth a look`,
    entries: unreadBriefs.slice(0, 2).map((b) => ({
      id: b.id,
      ref: { type: 'brief', id: b.id, label: b.title, href: hrefFor({ type: 'brief', id: b.id }) },
      title: b.title,
      detail: `${b.highlights.length} highlights`,
      at: b.through,
      tone: 'neutral',
      action: { kind: 'open', label: 'Read', href: hrefFor({ type: 'brief', id: b.id }), auditId: null, choices: [] },
      evidence: null,
    })),
    href: '/briefs',
    visible: true,
  });

  // every suggestion counts: the model holds them all (a row limit once hid the oldest when DEEP-1 filled Triage)
  const triageCount = triageView(m).count;
  const spend = m.spend();
  const pulseConn = m.all('connectors').find((c) => c.source === 'slack') ?? m.all('connectors')[0];
  const deadline = quarter;

  return {
    now: nowIso,
    header: {
      date: nowIso,
      nextMeeting: next ? { eventId: next.id, title: next.title, start: next.start, minutesUntil: Math.max(0, minutesBetween(now, next.start)) } : null,
      capacity: plan ? plan.capacity : inp.capacity(),
      nearestDeadline: { label: `${deadline.label} log`, due: deadline.due, progress: { done: loggedH, total: personaTargetH(personaOf(m.settings()), deadline.targetH), label: 'h' } },
      catchUp: catching.length ? { sources: catching.map((c) => ({ connectorId: c.id, label: c.label, pct: c.catchUpPct, done: false })) } : null,
    },
    spine: { events, slots, later: { fitIns: fitIns.length, promises: promises.length } },
    nowStack: { rankedAt: meta.rankedAt, rerankReady: inp.rank.rerankReady, cards },
    moreToday: { count: restRanked.length, items: moreTodayItems.map((i) => hydrateItem(m, i)) },
    triageCount: triageCount,
    shelves: { fitIns: fitIns.slice(0, 2), promises: promises.slice(0, 2) },
    rail,
    rankMeta: { policyVersion: policy.version, policyName: policy.name, rankedAt: meta.rankedAt },
    health,
    spend: { today: spend.today, state: spend.state },
    dryRun: settings.sending.dryRun,
    navCounts: {
      triage: triageCount,
      agentsWaiting: waitingRuns.length,
      outbox: m.all('drafts').filter((d) => (d.status === 'ready' || d.status === 'failed') && !isAdminDraft(d)).length,
      // the items Time shows (D-52): logging canvases, forecast canvases and VDP changes while the persona has them
      adminWaiting: adminWaitingBySurface(m.all('drafts'), personaOf(m.settings())).total,
      // D-60: by the tab that holds them, so the badge lands where its items are
      adminBySurface: (({ log, forecast, vdp }) => ({ log, forecast, vdp }))(adminWaitingBySurface(m.all('drafts'), personaOf(m.settings()))),
      briefsUnread: unreadBriefs.length,
      // D-59: getToday fills it from the VDP coverage summary
      vdpOpen: 0,
      // 2026-11-13 audit C2, C8: getToday fills them (DC requests and use cases waiting for a canvas; staged Assistant cards)
      waitingForCanvas: { dcs: 0, useCases: 0 },
      assistantPending: 0,
      // C10: To log's one count (the tab badge's rule, src/engines/activity/to-log-count.ts) over the rows To log reads
      toLog: ((canvases, req) => toLogCount({ rows: toLogRows(activity, quarter.start, now, canvases, req), canvases, taskTypeRequired: req }).badge)(logCanvasesOf(m.all('drafts'), activity, now), loggingProfile(personaOf(settings)).taskTypeRequired),
    },
    scannerPulse: pulseConn
      ? { label: pulseConn.state === 'catching_up' ? `Catching up · ${pulseConn.catchUpPct ?? 0}%` : `Live · ${Math.max(0, Math.round((now.getTime() - Date.parse(pulseConn.lastSuccessAt ?? nowIso)) / 1000))}s`, state: pulseConn.state }
      : { label: 'Idle', state: 'ok' },
  };
}
