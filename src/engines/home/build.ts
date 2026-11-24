/**
 * Home aggregation (design v2): a pure function from the store's entities to the HomePayload contract
 * (src/contract/home.ts). No I/O, no clock: `input.now` is the only "now". The mock DataSource calls it
 * today; the db DataSource can call it with its read model later.
 *
 * Rules (each is named so a row can say why it is there):
 * - Today scope: due today, start-by today, or pinned to today (a `work`/`focus` spine slot). Overdue and
 *   later work is never load; it goes to Think ahead or "pull forward".
 * - A meeting holds its work: an item that is the ready prep of one of today's meetings costs no hands-on time.
 * - Blocked: an item whose NBA offers wait / nudge while one of its people owes you an answer (a live
 *   waiting_on_others item). It never takes a Do now slot; it shows in Reply & approve as Blocked.
 * - Capacity counts hands-on minutes only (estimate.ts) and "fits" = youMinToday ≤ freeMin.
 * - Do now: ranked today work, with the Outbox approvals as #2 (minutes of work that unblock others).
 * - Nothing is listed twice: Do now → Log & fix (gap rules consume their items) → Reply & approve →
 *   Chase → Think ahead.
 * - Planning ahead (`input.day = 'next'`): Home as the next working day starts (its working-hours start is "now"):
 *   that day's meetings and capacity, what is due or starts then, plus today's open work carried over and anything
 *   moved there (a snooze that wakes by its end). No now line, no since-you-left, no Outbox card (approvals are for
 *   now; Reply & approve still offers them). Every day label names that day ("Tomorrow turns on…").
 */
import type {
  HomeCard, HomeDayRef, HomeNextDay, HomePayload, HomeRow, HomeSection, HomeSectionId, WorkItem,
} from '@/contract';
import { closedForYouSince } from './closed';
import { looksDoneEvidence } from './looks-done';
import { plural } from './text';
import { HOUR_MS, isWorkingDay, nextWorkingDay, offsetMin, toMs, workingDayAt, type WorkingDay } from './time';
import { valueFromReasons } from '@/engines/priority/why';
import { makeRoom } from '@/engines/priority/v2/capacity';
import { adminClassOf } from '@/engines/priority/v2/admin';
import { DEFAULT_PRIORITY_CONFIG } from '@/engines/priority/v2/config';
import { adminOf, buildsOf, closedNowOf, moveItOf, respondOf, watchingOf } from './briefing';
import { connectorRowsFor } from '@/personas';
import type { HomeInput } from './types';
import {
  makeCtx, HOME_CAPS, todayItems, byRank, freeIntervals, SECTION_TITLE, SECTION_EMPTY, LIVE, TIME_WEEK, type Ctx,
  msOrNull, itemHref,
} from './build.ctx';
import { gapRules } from './build.gaps';
import { type Need, replyRows, chaseRows, aheadRows, initiativeRows } from './build.rows';
import { itemCard, outboxCard } from './build.cards';
import { buildRibbon, buildStrip, buildMasthead, elsewhereText, attachReadIns, buildFooter } from './build.sections';
export {
  TIME_WEEK, HOME_CAPS, PROMISE_MIN_AGE_D, FOLD_AT, PROMISE_RISK_AGE_D, OPEN_BLOCK_MIN, SECTION_TITLE,
} from './build.ctx';
export { gapRuleOn } from './build.gaps';

// ---------------------------------------------------------------------------
// The whole page
// ---------------------------------------------------------------------------

export function buildHome(raw: HomeInput): HomePayload {
  // D-55: only the sources the persona has active have a daily surface (re-auth rows, the footer's source count)
  const input: HomeInput = raw.persona ? { ...raw, connectors: connectorRowsFor(raw.connectors, raw.persona) } : raw;
  const c = makeCtx(input);
  const cap = input.wide ? HOME_CAPS.rowsWide : HOME_CAPS.rows;

  // 1. Log & fix first: gap rules claim the items they stand for.
  // A row set aside (Not now, Not needed) is not drawn but keeps its items, so they don't pop up elsewhere.
  const allGaps = gapRules(c);
  const consumed = new Set(allGaps.flatMap((g) => g.consumes));
  const gaps = allGaps.filter((g) => !g.hidden);

  // 2. Today's needs, ranked across every tab: ranked today work, then broken connectors. Phase 3 (01 R2): the
  // Outbox approvals take the third slot ("Approve N drafts"), so the first two are always the ranking's own work.
  // priority@2 shown: admin never takes a Do-now slot (07 R6); it is the one Admin row.
  const engine = input.priorityEngine ?? 'shadow';
  const adminCfg = input.persona?.priority;
  const isAdmin = (w: WorkItem) => engine === 'v2' && adminClassOf(w, adminCfg ?? DEFAULT_PRIORITY_CONFIG) !== null;
  const today = todayItems(c).filter((w) => !consumed.has(w.id) && !isAdmin(w));
  const needs: Need[] = today.map((item) => ({ kind: 'item', item }));
  for (const g of gaps.filter((x) => x.rule === 'connector_auth')) needs.push({ kind: 'gap', gap: g });
  // Approvals are for now: a planned day leaves them in Respond and Reply & approve ("Approve N").
  const draftsCard = c.readyDrafts.length > 0 && !c.plan;
  const itemSlots = draftsCard ? 2 : 3;

  const cards: HomeCard[] = [];
  const elsewhereNeeds: Need[] = [];
  for (const n of needs) {
    if (cards.length < itemSlots && n.kind === 'item' && !c.blockedBy(n.item)) cards.push(itemCard(c, n.item, cards.length + 1));
    else elsewhereNeeds.push(n);
  }
  // Fewer than the item slots today: fill with the next ranked work (never blocked, waiting or background). HOME-1:
  // work the ranker has not ranked yet (a fresh first scan ranks nothing until a re-rank) follows the ranked work by its
  // due date, as Today's fallback order does: before, a new user's Do now said "Nothing else needs you now" over 29 open
  // replies.
  if (cards.length < itemSlots) {
    const inCards = new Set(cards.map((k) => k.id));
    for (const w of c.live.filter((x) => !inCards.has(x.id) && !consumed.has(x.id) && !x.isBackground && x.state !== 'waiting_on_others' && !c.blockedBy(x) && !c.heldByMeeting(x) && !today.includes(x) && !isAdmin(x)).sort(byRank)) {
      if (cards.length >= itemSlots) break;
      cards.push(itemCard(c, w, cards.length + 1));
    }
  }
  if (draftsCard) cards.push(outboxCard(c.readyDrafts, cards.length + 1));
  const taken = new Set<string>([...consumed, ...cards.filter((k) => k.kind === 'item').map((k) => k.id)]);
  // Items the meetings hold are covered by the ribbon.
  for (const w of c.live) if (c.heldByMeeting(w)) taken.add(w.id);
  // 07 R6: admin is one quiet row, listed nowhere else.
  const admin = c.plan
    ? null
    : adminOf(
        c.live.filter((w) => !taken.has(w.id) && !w.isBackground && w.state !== 'waiting_on_others').map((item) => ({ item, youMin: c.handsOn(item) })),
        { engine, config: adminCfg, nowMs: c.nowMs, todayEndMs: c.todayEnd, tz: c.tz, todayFree: freeIntervals(c), href: '/work?tab=all_open' },
      );
  for (const r of admin?.rows ?? []) taken.add(r.id);
  const outboxIds = new Set(cards.some((k) => k.kind === 'outbox') ? c.readyDrafts.map((d) => d.id) : []);

  // 3. Reply & approve.
  const reply = replyRows(c, taken, outboxIds);
  for (const r of reply) taken.add(r.id);

  // 4. Chase (waiting on others + promises).
  const blocks = new Map<string, WorkItem>();
  for (const w of c.live) {
    const b = c.blockedBy(w);
    if (b) blocks.set(b.id, w);
  }
  const chase = chaseRows(c, taken, blocks);
  for (const r of chase.rows) taken.add(r.id);
  for (const r of chase.rows) if (r.id.startsWith('fold:')) for (const w of c.live) if (w.initiativeId === r.entity.id && w.kind === 'commitment' && !w.due) taken.add(w.id);

  // 5. Think ahead (14 days).
  const ahead = aheadRows(c, taken, outboxIds);

  // 6. Initiatives.
  const riskItems = new Set<string>([
    ...ahead.filter((a) => a.row.state === 'risk' || a.row.state === 'overdue').map((a) => a.row.item?.id ?? a.row.entity.id),
    ...gaps.filter((g) => g.row.state === 'risk' || g.row.state === 'overdue').flatMap((g) => g.consumes),
  ]);
  const inis = initiativeRows(c, riskItems);

  // 7. Capacity (from the CAPACITY engine, the same numbers as Today) and the ribbon.
  const capacity = input.capacity;
  const ribbon = buildRibbon(c, { free: freeIntervals(c), youMinToday: capacity.youMinToday, pullForward: capacity.pullForward });
  const room = c.plan ? null : makeRoomData(c, capacity);

  // 8. Strip + masthead.
  const dated = [
    ...ahead.map((a) => ({ at: a.at, label: a.row.title, risk: a.row.state === 'risk' || a.row.state === 'overdue', cf: a.cf, meeting: a.row.id.startsWith('event:') })),
    ...gaps.filter((g) => g.row.due).map((g) => ({ at: toMs(g.row.due!), label: g.row.title, risk: g.row.state === 'risk', cf: false, meeting: false })),
    ...reply.filter((r) => r.due).map((r) => ({ at: toMs(r.due!), label: r.title, risk: r.state === 'blocked' || r.state === 'overdue', cf: false, meeting: false })),
  ].filter((d) => d.at >= c.todayEnd);
  const aheadStrip = buildStrip(c, dated);
  const masthead = buildMasthead(c, cards, gaps, ahead, aheadStrip);

  // 9. Sections (rows capped), and where the next ranks live.
  const section = (id: HomeSectionId, rows: HomeRow[], count: number, seeAllHref: string, extra: Partial<HomeSection> = {}): HomeSection => ({
    id,
    title: SECTION_TITLE[id],
    count,
    sub: null,
    rows: rows.slice(0, id === 'initiatives' ? (input.wide ? HOME_CAPS.initiativesWide : HOME_CAPS.initiatives) : cap),
    seeAllHref,
    seeAllLabel: `See all ${count}`,
    batch: null,
    empty: SECTION_EMPTY[id],
    ...extra,
  });
  const sections: HomeSection[] = [
    // HOME-3: these rows are replies with no draft in the Outbox yet, so "See all 152 in Outbox" led to 18 drafts. The
    // link goes where the asks live (Work ▸ Asked of me) and says that tab's own count; Approve N still opens the Outbox.
    section('reply', reply, reply.length, '/work?tab=asked_of_me', { seeAllLabel: `See all ${input.items.filter((w) => w.kind === 'ask' && LIVE.has(w.state)).length} asks`, batch: !outboxIds.size && c.readyDrafts.length > 1 ? { label: `Approve ${c.readyDrafts.length}`, href: '/outbox' } : null }),
    section('ahead', ahead.map((a) => a.row), ahead.length, '/work?tab=all_open', { sub: `next ${HOME_CAPS.aheadDays} days` }),
    // 2026-11-13 audit C2: rows set aside (Not now) are still work: the empty line never says "Nothing missing" over them
    section('fix', gaps.map((g) => g.row), gaps.length, TIME_WEEK, allGaps.length > gaps.length && !gaps.length ? { empty: `Nothing to fix now · ${plural(allGaps.length - gaps.length, 'row')} set aside (back on its date)` } : {}),
    section('chase', chase.rows, chase.count, '/work?tab=all_open&state=waiting_on_others'),
    section('initiatives', inis, inis.length, '/work'),
  ];

  const sectionOf = (entityId: string, rowId: string): HomeSectionId | null => {
    for (const s of [{ id: 'reply' as const, rows: reply }, { id: 'fix' as const, rows: gaps.map((g) => g.row) }, { id: 'chase' as const, rows: chase.rows }, { id: 'ahead' as const, rows: ahead.map((a) => a.row) }]) {
      if (s.rows.some((r) => r.id === rowId || r.entity.id === entityId || r.item?.id === entityId)) return s.id;
    }
    return null;
  };
  const elsewhere = elsewhereNeeds
    .map((n, i) => {
      const rank = cards.length + i + 1;
      const sec = n.kind === 'item' ? sectionOf(n.item.id, n.item.id) : n.kind === 'gap' ? 'fix' : 'reply';
      return sec ? { rank, section: sec, label: SECTION_TITLE[sec] } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, 2);
  const elsewhereNote = elsewhereText(elsewhere);

  attachReadIns(c, cards, sections);
  const looksDone = looksDoneGroup(c);
  const closedForYou = c.plan ? null : closedLine(input);
  const days = dayRefs(c);
  return {
    now: new Date(c.realNowMs).toISOString(),
    wide: input.wide,
    day: c.plan ? 'next' : 'today',
    nextDay: days.nextDay,
    moveTo: days.moveTo,
    masthead,
    ribbon,
    // planning: the planned day's capacity (the datasource computed it at that day's start), named for that day
    capacity: { day: c.plan ? 'next' : capacity.day, dayLabel: c.plan ? (c.plan.label === 'Tomorrow' ? 'tomorrow' : c.plan.label) : capacity.dayLabel, youMinToday: capacity.youMinToday, freeMin: capacity.freeMin, openMin: capacity.openMin, fits: capacity.fits, agentMinBackground: capacity.agentMinBackground, agentRunsBackground: capacity.agentRunsBackground, pullForward: capacity.pullForward.slice(0, HOME_CAPS.pullForward) },
    doNow: { total: Math.max(needs.length + (draftsCard ? 1 : 0), cards.length), cards, elsewhere, elsewhereNote },
    sections,
    looksDone,
    closedForYou,
    aheadStrip,
    footer: buildFooter(c, chase),
    makeRoom: room,
    // the briefing (phase 3): drafts and replies as chips, builds in flight, admin as one row, what to move
    respond: respondOf(input.drafts, reply, new Set(cards.filter((k) => k.kind === 'item').flatMap((k) => [k.id, ...(k.now?.draft ? [k.now.draft.id] : [])]))),
    builds: c.plan ? [] : buildsOf(input.agentRuns, c.byId, c.realNowMs, c.tz),
    admin,
    moveIt: moveItOf(room, c.byId, days.moveTo),
    closedNow: c.plan ? [] : closedNowOf(input.items, c.realNowMs),
    watching: watchingOf(input.connectors),
  };
}

/**
 * priority@2 capacity honesty: today overbooked → what to move, lowest value × latest deadline first (the engine's
 * `makeRoom` over today's load), never a pinned item or a hard deadline later today. Value comes from the item's rank
 * reasons (the ranking's own terms). Data only; the Home briefing chunk draws the card.
 */
function makeRoomData(c: Ctx, capacity: HomeInput['capacity']): HomePayload['makeRoom'] {
  if (capacity.day !== 'today' || capacity.fits) return null;
  const pinned = new Set(c.input.slots.filter((s) => (s.kind === 'work' || s.kind === 'focus') && s.workItemId).map((s) => s.workItemId!));
  const rows = todayItems(c).map((w) => {
    const dueMs = msOrNull(w.due);
    const hardToday = dueMs !== null && dueMs < c.todayEnd && (w.dueKind ?? 'hard') === 'hard';
    return { id: w.id, title: w.title, youMin: c.handsOn(w), value: valueFromReasons(w.rankReasons), needByMs: dueMs, locked: pinned.has(w.id) || hardToday };
  });
  return makeRoom(rows, capacity.youMinToday - capacity.freeMin, { nowMs: c.nowMs, utcOffsetMinutes: offsetMin(c.realNowMs, c.tz) });
}

const dayRef = (d: WorkingDay): HomeDayRef => ({ date: d.date, label: d.label, short: d.short, startsAt: new Date(d.startMs).toISOString() });

/**
 * The next working day (the toggle, and the nudge from an hour before today's working hours end, after them, or on a
 * day off), and where "Move to …" sends an item: the working day after the day shown.
 */
function dayRefs(c: Ctx): { nextDay: HomeNextDay; moveTo: HomeDayRef } {
  const wh = c.input.workingHours;
  const next = c.plan ?? nextWorkingDay(c.realNowMs, c.tz, wh);
  const today = workingDayAt(c.realNowMs, c.tz, wh);
  const nudge = !isWorkingDay(c.realNowMs, c.tz, wh.days) || c.realNowMs >= today.endMs - HOUR_MS;
  return { nextDay: { ...dayRef(next), nudge }, moveTo: dayRef(c.plan ? nextWorkingDay(c.plan.startMs, c.tz, wh) : next) };
}

/** SETTLE-1: engine closes since you left, for the "Closed N for you since you left · Review" line. */
function closedLine(input: HomeInput): HomePayload['closedForYou'] {
  const since = input.closedSince ? Date.parse(input.closedSince) : NaN;
  if (!Number.isFinite(since)) return null;
  const n = closedForYouSince(input.items, since).length;
  return n ? { count: n, since: new Date(since).toISOString(), href: '/triage#closed_for_you' } : null;
}

/** LD-1: likely-done work, newest first, a few rows (the rest are one click away in Triage). */
function looksDoneGroup(c: Ctx): HomePayload['looksDone'] {
  const all = c.input.items.filter((w) => w.state === 'likely_done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const cap = c.input.wide ? HOME_CAPS.looksDoneWide : HOME_CAPS.looksDone;
  return {
    count: all.length,
    rows: all.slice(0, cap).map((w) => ({ id: w.id, title: w.title, evidence: looksDoneEvidence(w), href: itemHref(w.id), item: { id: w.id, version: w.version } })),
  };
}
