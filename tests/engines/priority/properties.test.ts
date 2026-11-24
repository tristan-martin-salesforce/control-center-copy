/** Hand-rolled property tests for the priority engine: random days, invariants that must always hold. */
import { describe, expect, it } from 'vitest';
import type { EstimateKind } from '@/engines/priority/estimate';
import { evalPredicate, SE_IC_POLICY, SE_MANAGER_POLICY } from '@/engines/priority/policy';
import { rankWork } from '@/engines/priority/rank';
import { rerank } from '@/engines/priority/stability';
import type { CapacityChore, PriorityInputs, RankingResult, RunningAgent } from '@/engines/priority/types';
import { PRIORITY_LANES, WORK_ITEM_STATUSES, type Meeting, type PriorityItem, type StakeholderTier, type WorkItemKind } from '@/engines/types';
import { HOURS, int, pick, rng, shuffle } from './fixtures';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CHORE_KINDS: EstimateKind[] = ['approve', 'approve', 'approve', 'reauth', 'review'];
const KINDS: WorkItemKind[] = ['task', 'commitment', 'ask', 'training', 'follow_up', 'travel', 'deliverable'];
const TIERS: StakeholderTier[] = ['leader', 'manager', 'ae', 'teammate', 'customer_exec', 'customer', 'partner', 'normal', 'low'];
const NOWS = ['2026-11-05T08:30:00.000Z', '2026-11-05T09:00:00.000Z', '2026-11-05T10:15:00.000Z', '2026-11-05T13:40:00.000Z', '2026-11-05T17:50:00.000Z', '2026-11-07T11:00:00.000Z'];

function gen(seed: number): PriorityInputs {
  const r = rng(seed);
  const now = pick(r, NOWS);
  const nowMs = Date.parse(now);
  const iso = (ms: number) => new Date(Math.round(ms / (5 * MIN)) * 5 * MIN).toISOString();
  const meetings: Meeting[] = Array.from({ length: int(r, 0, 6) }, (_, i) => {
    const start = nowMs + int(r, -120, 3 * 24 * 60) * MIN;
    return {
      id: `m${i}`,
      title: `Meeting ${i}`,
      start: iso(start),
      end: iso(start + int(r, 15, 120) * MIN),
      hasExternalAttendees: r() < 0.4,
      ...(r() < 0.1 ? { status: 'cancelled' as const } : {}),
      ...(r() < 0.1 ? { myResponse: 'declined' as const } : {}),
      ...(r() < 0.1 ? { eventType: 'focus_time' as const } : {}),
      ...(r() < 0.2 ? { prepItemIds: [`i${int(r, 0, 14)}`] } : {}),
    };
  });
  const items: PriorityItem[] = Array.from({ length: int(r, 0, 15) }, (_, i) => {
    const kind = pick(r, KINDS);
    const it: PriorityItem = {
      id: `i${i}`,
      title: `Item ${i}`,
      kind,
      status: r() < 0.7 ? pick(r, ['open', 'open', 'in_progress', 'waiting_on_me', 'likely_done'] as const) : pick(r, WORK_ITEM_STATUSES),
      effort: { youMin: pick(r, [0, 5, 10, 15, 25, 30, 45, 60, 120, 240]), agentMin: pick(r, [0, 0, 0, 30, 90, 180]) },
      importance: pick(r, ['critical', 'high', 'normal', 'low'] as const),
      createdAt: iso(nowMs - int(r, 0, 100 * 24 * 60) * MIN),
      stakeholders: Array.from({ length: int(r, 0, 2) }, (_, k) => ({
        name: `P${k}`,
        tier: pick(r, TIERS),
        isManager: r() < 0.15,
        isExternal: r() < 0.3,
      })),
    };
    if (r() < 0.5) it.due = iso(nowMs + int(r, -24 * 60, 96 * 60) * MIN);
    if (r() < 0.3) it.dueKind = pick(r, ['hard', 'soft', 'inferred'] as const);
    if (r() < 0.4 && meetings.length) it.servesEventId = pick(r, meetings).id;
    if (kind === 'training') it.training = { mandatory: r() < 0.6, requiredBy: iso(nowMs + int(r, -48 * 60, 10 * 24 * 60) * MIN) };
    if (r() < 0.1) it.isBackground = true;
    if (r() < 0.3) it.oppAmount = int(r, 0, 2_000_000);
    if (r() < 0.1) it.userAdjustment = int(r, -20, 20);
    if (r() < 0.2) it.agentStarted = true;
    if (r() < 0.2) it.askedAt = iso(nowMs - int(r, 0, 72 * 60) * MIN);
    return it;
  });
  const ids = items.map((i) => i.id);
  const pinnedToday = ids.length && r() < 0.3 ? [pick(r, ids)] : undefined;
  const chores: CapacityChore[] = Array.from({ length: r() < 0.5 ? int(r, 1, 4) : 0 }, (_, k) => ({
    id: `c${k}`,
    kind: pick(r, CHORE_KINDS),
    title: `Chore ${k}`,
    workItemId: ids.length && r() < 0.3 ? pick(r, ids) : null,
    ...(r() < 0.2 ? { youMin: int(r, 1, 20) } : {}),
  }));
  const runningAgents: RunningAgent[] = Array.from({ length: r() < 0.3 ? int(r, 1, 2) : 0 }, (_, k) => ({
    id: `run${k}`,
    workItemId: ids.length && r() < 0.7 ? pick(r, ids) : null,
    agentMinLeft: r() < 0.7 ? int(r, 5, 120) : null,
  }));
  return {
    now,
    items,
    meetings,
    policy: r() < 0.7 ? SE_IC_POLICY : SE_MANAGER_POLICY,
    workingHours: HOURS,
    ...(pinnedToday ? { pinnedToday } : {}),
    ...(chores.length ? { chores } : {}),
    ...(runningAgents.length ? { runningAgents } : {}),
  };
}

/** Local day bounds of `now` (HOURS is UTC in these fixtures, but keep the offset honest). */
function dayOf(inp: PriorityInputs): { start: number; end: number } {
  const off = inp.workingHours.utcOffsetMinutes * MIN;
  const start = Math.floor((Date.parse(inp.now) + off) / DAY) * DAY - off;
  return { start, end: start + DAY };
}

/** MIN-22: the first working day after `now`'s day. */
function nextWorkdayOf(inp: PriorityInputs): { start: number; end: number } {
  const off = inp.workingHours.utcOffsetMinutes * MIN;
  const today = dayOf(inp);
  for (let d = 1; d <= 7; d++) {
    const start = today.start + d * DAY;
    if (inp.workingHours.days.includes(new Date(start + off).getUTCDay())) return { start, end: start + DAY };
  }
  throw new Error('no working day in a week');
}

/** The capacity contract (DESIGN-V2): today-scoped, hands-on only, agent time never counts. */
function checkCapacity(inp: PriorityInputs, res: RankingResult): void {
  const c = res.capacity;
  // MIN-22: once today's working time is over the same rules count the next working day
  const { start, end } = c.day === 'next' ? nextWorkdayOf(inp) : dayOf(inp);
  const pinned = new Set(inp.pinnedToday ?? []);
  const today = new Set(c.todayItemIds);

  if (c.day === 'next') {
    expect(res.gaps).toEqual([]); // nothing left of today's working time
    expect(c.dayLabel).toBe(start === dayOf(inp).end ? 'tomorrow' : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(start + inp.workingHours.utcOffsetMinutes * MIN).getUTCDay()]);
  } else expect(c.freeMin).toBe(res.gaps.reduce((a, g) => a + g.minutes, 0));
  const itemMin = c.todayItemIds.reduce((a, id) => a + res.scores[id]!.effort.youMin, 0);
  expect(c.youMinToday).toBe(itemMin + c.chores.reduce((a, ch) => a + ch.youMin, 0));
  expect(c.openMin).toBe(c.freeMin - c.youMinToday);
  expect(c.fits).toBe(c.youMinToday <= c.freeMin);
  // legacy fields, filled consistently
  expect(c.focusMinLeft).toBe(c.freeMin);
  expect(c.plannedMin).toBe(c.youMinToday);
  expect(c.overByMin).toBe(c.youMinToday - c.freeMin);
  // never overbooked when today-scoped hands-on ≤ free
  if (c.youMinToday <= c.freeMin) {
    expect(c.fits).toBe(true);
    expect(c.overByMin).toBeLessThanOrEqual(0);
  }

  for (const s of Object.values(res.scores)) {
    expect(s.effort.youMin).toBeGreaterThan(0); // every item carries a hands-on estimate (its own or a default)
    if (s.lane === 'hidden') {
      expect(today.has(s.workItemId)).toBe(false);
      continue;
    }
    const d = s.deadline ? Date.parse(s.deadline.at) : null;
    const startBy = s.startBy ? Date.parse(s.startBy) : null;
    // PRIO-3 (lane 07): a start-by at or before the end of today is today's load, whenever the item is due
    const expected =
      s.status !== 'likely_done' &&
      (pinned.has(s.workItemId) || (d !== null && d >= start && d < end) || (d !== null && d >= end && startBy !== null && startBy < end));
    expect(today.has(s.workItemId), s.workItemId).toBe(expected);
    // an item due tomorrow is in youMinToday only when it must start today (or you pinned it to today)
    if (d !== null && d >= end && d < end + DAY && !pinned.has(s.workItemId)) expect(today.has(s.workItemId)).toBe(startBy !== null && startBy < end);
  }

  // chores: a draft of an item that is already today's load is not counted twice
  for (const ch of c.chores) for (const id of ch.choreIds) {
    const src = inp.chores!.find((x) => x.id === id)!;
    if (src.workItemId) expect(today.has(src.workItemId)).toBe(false);
  }

  // pull forward: not today's load, rank order, at most 5, nothing when the day is full
  expect(c.pullForward.length).toBeLessThanOrEqual(5);
  if (c.openMin <= 0) expect(c.pullForward).toEqual([]);
  const ranks = c.pullForward.map((p) => res.scores[p.itemId]!.rank!);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  for (const p of c.pullForward) expect(today.has(p.itemId)).toBe(false);

  // background lane: kick-offs among today's load plus runs in flight
  const kickoffs = c.todayItemIds.filter((id) => {
    const it = inp.items.find((i) => i.id === id)!;
    return !it.agentStarted && it.effort.agentMin > 0 && ['open', 'in_progress', 'waiting_on_me'].includes(it.status);
  });
  const running = (inp.runningAgents ?? []).filter((x) => !(x.workItemId && kickoffs.includes(x.workItemId)));
  expect(c.agentRunsBackground).toBe(kickoffs.length + running.length);
  expect(c.agentMinQueued).toBe(kickoffs.reduce((a, id) => a + inp.items.find((i) => i.id === id)!.effort.agentMin, 0));
  expect(c.agentMinBackground).toBe(c.agentMinQueued + running.reduce((a, x) => a + (x.agentMinLeft ?? 0), 0));
}

const laneIdx = (l: string) => PRIORITY_LANES.indexOf(l as (typeof PRIORITY_LANES)[number]);

function checkInvariants(inp: PriorityInputs, res: RankingResult): void {
  const ids = inp.items.map((i) => i.id).sort();
  // Every item lands exactly once: ranked, background, hidden (rule) or excluded (status).
  const placed = [...res.ranked.map((s) => s.workItemId), ...res.lanes.background, ...res.excluded.map((e) => e.workItemId)].sort();
  expect(placed).toEqual(ids);
  expect(res.lanes.hidden.every((id) => res.excluded.some((e) => e.workItemId === id))).toBe(true);

  // Ranks are 1..n in order; lanes are monotonic; Top 3 is the head of the ranking.
  res.ranked.forEach((s, i) => expect(s.rank).toBe(i + 1));
  for (let i = 1; i < res.ranked.length; i++) expect(laneIdx(res.ranked[i]!.lane)).toBeGreaterThanOrEqual(laneIdx(res.ranked[i - 1]!.lane));
  expect(res.top3.length).toBeLessThanOrEqual(inp.policy.top3Size);
  expect(res.top3).toEqual(res.ranked.filter((s) => s.lane === 'top3').map((s) => s.workItemId));
  expect(res.top3).toEqual(res.ranked.slice(0, res.top3.length).map((s) => s.workItemId));
  for (const id of res.top3) expect(res.scores[id]!.top3Eligible).toBe(true);

  for (const s of Object.values(res.scores)) {
    expect(s.policyVersion).toBe(inp.policy.version);
    expect(s.policyId).toBe(inp.policy.id);
    expect(Number.isFinite(s.total)).toBe(true);
    expect(s.components).toHaveLength(11);
    if (s.deadline && s.startBy) expect(Date.parse(s.startBy)).toBeLessThanOrEqual(Date.parse(s.deadline.at));
    if (s.startBy) expect(s.slackMinutes).toBe(Math.round((Date.parse(s.startBy) - Date.parse(inp.now)) / MIN));
  }

  // never_above holds in the final order (likely-done items are no longer protected).
  for (const rule of inp.policy.rules) {
    if (rule.kind !== 'never_above' || !rule.enabled || !rule.otherCondition) continue;
    const other = rule.otherCondition;
    const as = res.ranked.filter((s) => evalPredicate(rule.condition, s.features) && !evalPredicate(other, s.features));
    const bs = res.ranked.filter((s) => s.status !== 'likely_done' && evalPredicate(other, s.features));
    for (const a of as) for (const b of bs) expect(a.rank!).toBeGreaterThan(b.rank!);
  }

  // Sequencing never puts a kick-off below an item it was moved above.
  for (const s of res.ranked) {
    if (!s.sequencing) continue;
    expect(s.sequencing.movedAbove.length).toBeGreaterThan(0);
    for (const x of s.sequencing.movedAbove) expect(s.rank!).toBeLessThan(res.scores[x]!.rank!);
  }

  // Background: oldest first, never ranked.
  const bgAges = res.background.map((b) => b.ageDays);
  expect(bgAges).toEqual([...bgAges].sort((a, b) => b - a));

  // Plan: no overlapping slots, all inside today's gaps; fit-ins inside their gap and off the Top 3.
  const slots = res.spine.map((s) => [Date.parse(s.start), Date.parse(s.end)] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < slots.length; i++) expect(slots[i]![0]).toBeGreaterThanOrEqual(slots[i - 1]![1]);
  for (const [s, e] of slots) expect(res.gaps.some((g) => Date.parse(g.start) <= s && e <= Date.parse(g.end))).toBe(true);
  for (const f of res.fitIns) {
    expect(res.top3).not.toContain(f.workItemId);
    expect(Date.parse(f.plannedStart)).toBeGreaterThanOrEqual(Date.parse(f.gap.start));
    expect(Date.parse(f.plannedEnd)).toBeLessThanOrEqual(Date.parse(f.gap.end));
    expect(f.youMin).toBeLessThanOrEqual(inp.policy.tuning.fitIn.maxYouMin);
  }
  checkCapacity(inp, res);
}

describe('priority engine properties (500 random days)', () => {
  it('holds every invariant and is independent of input order', () => {
    const seen = { sequenced: 0, preempt: 0, fitIns: 0, background: 0, neverAbove: 0, todayLoad: 0, pinnedLoad: 0, chores: 0, pullForward: 0, overbooked: 0, fitsWithLoad: 0, runningAgents: 0 };
    for (let seed = 1; seed <= 500; seed++) {
      const inp = gen(seed);
      const res = rankWork(inp);
      checkInvariants(inp, res);
      seen.sequenced += res.ranked.filter((s) => s.sequencing).length;
      seen.preempt += res.ranked.filter((s) => s.preempt).length;
      seen.fitIns += res.fitIns.length;
      seen.background += res.background.length;
      seen.neverAbove += res.ranked.filter((s) => s.ruleHits.some((h) => h.kind === 'never_above')).length;
      seen.todayLoad += res.capacity.todayItemIds.length;
      seen.pinnedLoad += res.capacity.todayItemIds.filter((id) => inp.pinnedToday?.includes(id)).length;
      seen.chores += res.capacity.chores.length;
      seen.pullForward += res.capacity.pullForward.length;
      seen.overbooked += res.capacity.fits ? 0 : 1;
      seen.fitsWithLoad += res.capacity.fits && res.capacity.youMinToday > 0 ? 1 : 0;
      seen.runningAgents += inp.runningAgents?.length ?? 0;
      const r = rng(seed * 7919);
      const shuffled = { ...inp, items: shuffle(r, inp.items), meetings: shuffle(r, inp.meetings) };
      expect(rankWork(shuffled)).toEqual(res);
    }
    // The generator actually exercises each mechanism (the properties aren't vacuous).
    for (const [k, n] of Object.entries(seen)) expect(n, k).toBeGreaterThan(0);
  }, 60_000); // 500 generated days; slow under a loaded full-suite run

  it('agent minutes never change fits: background time never counts against capacity', () => {
    let changedBackground = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const inp = gen(seed);
      const res = rankWork(inp);
      const r = rng(seed * 104729);
      // Change agent minutes wherever they can't move a start-by (the agent already started, or no deadline),
      // keeping zero as zero, and add or drop runs in flight.
      const items = inp.items.map((it) => {
        const free = it.agentStarted || res.scores[it.id]?.deadline === null;
        if (!free || it.effort.agentMin === 0) return it;
        return { ...it, effort: { ...it.effort, agentMin: pick(r, [1, 15, 45, 240, 900]) } };
      });
      const runningAgents = r() < 0.5 ? [] : [{ id: 'bg-run', workItemId: null, agentMinLeft: int(r, 1, 600) }];
      const res2 = rankWork({ ...inp, items, runningAgents });
      const pick5 = (x: RankingResult) => ({ you: x.capacity.youMinToday, free: x.capacity.freeMin, open: x.capacity.openMin, fits: x.capacity.fits, over: x.capacity.overByMin, today: x.capacity.todayItemIds });
      expect(pick5(res2)).toEqual(pick5(res));
      if (res2.capacity.agentMinBackground !== res.capacity.agentMinBackground) changedBackground++;
    }
    expect(changedBackground).toBeGreaterThan(0); // the background lane did move
  }, 60_000);

  // PRIO-3 (lane 07, docs/reviews/2026-11-20-holistic/07-prioritization.md): this test used to lock the opposite
  // ("an item due tomorrow is never in youMinToday, however big or urgent it is"), which let Home say "fits, 35 min
  // open" on the day a 150-minute demo build due tomorrow 09:30 had to be built. Work that must start today is
  // today's load, and when it does not fit the day reads overbooked, never "fits".
  it('an item due tomorrow that must start today is in youMinToday, and an overbooked day never fits', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const inp = gen(seed);
      const { end } = dayOf(inp);
      const tomorrow = new Date(end + 10 * 60 * MIN).toISOString(); // 10:00 tomorrow
      const big = { id: 'zz-tomorrow', title: 'Due tomorrow', kind: 'ask' as const, status: 'open' as const, due: tomorrow, effort: { youMin: 600, agentMin: 600 }, importance: 'critical' as const, createdAt: inp.now };
      const res = rankWork({ ...inp, items: [...inp.items, big], pinnedToday: (inp.pinnedToday ?? []).filter((id) => id !== big.id) });
      const s = res.scores[big.id]!;
      const mustStartToday = s.startBy !== null && Date.parse(s.startBy) < end;
      if (res.capacity.day !== 'today') continue; // after hours the next working day is counted (MIN-22)
      expect(res.capacity.todayItemIds.includes(big.id)).toBe(mustStartToday);
      const without = rankWork(inp);
      if (mustStartToday) expect(res.capacity.youMinToday).toBe(without.capacity.youMinToday + s.effort.youMin);
      else expect(res.capacity.youMinToday).toBe(without.capacity.youMinToday);
      expect(res.capacity.fits).toBe(res.capacity.youMinToday <= res.capacity.freeMin);
    }
  }, 60_000);

  it('rerank keeps a valid, stable Top 3', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const inp = gen(seed);
      const res = rankWork(inp);
      const r = rng(seed * 31);
      const prev = shuffle(r, inp.items.map((i) => i.id)).slice(0, int(r, 0, 3));
      const out = rerank(prev, res, r() < 0.3 ? { actedOn: prev.slice(0, 1) } : {});
      expect(new Set(out.top3).size).toBe(out.top3.length);
      expect(out.top3.length).toBeLessThanOrEqual(res.top3Size);
      for (const id of out.top3) expect(res.scores[id]?.top3Eligible).toBe(true);
      expect(rerank(prev, res, { explicitApply: true }).top3).toEqual(res.top3);
      // Already showing the new Top 3 with nothing urgent: nothing to announce.
      const steady = rerank(res.top3, res);
      expect(steady.top3).toEqual(res.top3);
      expect(steady.rerankReady).toBe(0);
    }
  });
});
