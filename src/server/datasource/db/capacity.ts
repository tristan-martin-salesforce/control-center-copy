/**
 * Capacity inputs for the priority engine, from the read model (shared by the db and mock DataSources so
 * both show the engine's capacity; DESIGN-V2 "Capacity and estimates").
 *
 * - `pinnedToday`: items whose start-by the user set to today (start-by in `userLockedFields`), e.g. a
 *   "Pull in". They are today's load whatever their due date.
 * - `chores`: Outbox drafts waiting for approval (one "Approve N drafts" batch in the engine) and
 *   connectors that need a re-auth.
 * - `runningAgents`: queued or running agent runs linked to a live work item (background only).
 * - `estimates.actuals`: recorded hands-on minutes for calibration: items whose effort the user set
 *   (effort in `userLockedFields`), done ones as completions and open ones as corrections, last 60 days.
 *
 * Pure: no I/O.
 */
import type { TodayHeader, WorkItemRecord } from '@/contract';
import { estimateKindOf, type EffortActual } from '@/engines/priority/estimate';
import type { Capacity, CapacityChore, PriorityInputs, RunningAgent } from '@/engines/priority/types';

import type { ReadModel } from './model';
import { connectorRowsFor, personaOf } from '@/personas';

const LIVE = new Set(['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done', 'reopened']);
const RANKABLE = new Set(['open', 'in_progress', 'waiting_on_me', 'reopened']);
const IN_FLIGHT = new Set(['queued', 'running']);
const ACTUALS_WINDOW_MS = 60 * 86_400_000;
const DAY_MS = 86_400_000;

/** The read-model surface the engine inputs need (the mock Store provides the same). */
export type CapacitySource = Pick<ReadModel, 'all' | 'get' | 'settings'>;

/** Local day [start, end) for `now` at a fixed UTC offset (minutes east of UTC). */
export function localDay(now: Date, utcOffsetMinutes: number): { startMs: number; endMs: number } {
  const off = utcOffsetMinutes * 60_000;
  const startMs = Math.floor((now.getTime() + off) / DAY_MS) * DAY_MS - off;
  return { startMs, endMs: startMs + DAY_MS };
}

/** A work item counts as started for its agent part only when a linked run was active after the item existed. */
export function agentStartedFor(w: WorkItemRecord, m: CapacitySource, started: ReadonlySet<string>): boolean {
  const created = Date.parse(w.createdAt);
  return w.runIds.some((id) => {
    const r = m.get('agentRuns', id);
    if (!r || !started.has(r.state)) return false;
    // A run that went quiet before this item was created (a resumable session reused for the next step)
    // did not do this item's agent work.
    return Number.isNaN(created) || Date.parse(r.updatedAt) >= created;
  });
}

export function capacityInputs(m: CapacitySource, now: Date, utcOffsetMinutes: number): Pick<PriorityInputs, 'pinnedToday' | 'chores' | 'runningAgents' | 'estimates'> {
  const items = m.all('workItems');
  const day = localDay(now, utcOffsetMinutes);

  const pinnedToday = items
    .filter((w) => RANKABLE.has(w.state) && w.userLockedFields.includes('startBy') && w.startBy !== null)
    .filter((w) => {
      const t = Date.parse(w.startBy!);
      return t >= day.startMs && t < day.endMs;
    })
    .map((w) => w.id)
    .sort();

  const chores: CapacityChore[] = [];
  for (const d of m.all('drafts')) {
    if (d.status !== 'ready') continue;
    chores.push({ id: d.id, kind: 'approve', title: 'Approve draft', workItemId: d.workItemId });
  }
  // D-55: no re-auth chore for a source the persona hasn't activated
  for (const c of connectorRowsFor(m.all('connectors'), personaOf(m.settings()))) {
    if (c.state !== 'auth_needed') continue;
    chores.push({ id: `reauth:${c.id}`, kind: 'reauth', title: `Re-auth ${c.label}`, workItemId: null });
  }
  chores.sort((a, b) => a.id.localeCompare(b.id));

  const runningAgents: RunningAgent[] = [];
  for (const r of m.all('agentRuns')) {
    if (!IN_FLIGHT.has(r.state) || !r.workItemId) continue;
    const w = m.get('workItems', r.workItemId);
    if (!w || !LIVE.has(w.state)) continue;
    runningAgents.push({ id: r.id, workItemId: w.id, agentMinLeft: w.effort.agentMin > 0 ? w.effort.agentMin : null });
  }
  runningAgents.sort((a, b) => a.id.localeCompare(b.id));

  const since = now.getTime() - ACTUALS_WINDOW_MS;
  const actuals: EffortActual[] = items
    .filter((w) => w.userLockedFields.includes('effort') && w.effort.youMin > 0 && Date.parse(w.updatedAt) >= since && w.state !== 'dismissed')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((w) => ({
      estimateKind: estimateKindOf({ kind: w.kind, title: w.title, effort: w.effort }),
      youMin: w.effort.youMin,
      source: w.state === 'done' ? ('completed' as const) : ('correction' as const),
      at: w.updatedAt,
    }));

  return { pinnedToday, chores, runningAgents, estimates: { actuals } };
}

/** The engine's capacity in the contract's shape (`TodayHeader.capacity`): whole minutes. */
export function toContractCapacity(c: Capacity): TodayHeader['capacity'] {
  const youMinToday = Math.round(c.youMinToday);
  const freeMin = Math.round(c.freeMin);
  return {
    day: c.day,
    dayLabel: c.dayLabel,
    youMinToday,
    freeMin,
    openMin: freeMin - youMinToday,
    fits: youMinToday <= freeMin,
    agentMinBackground: Math.round(c.agentMinBackground),
    agentRunsBackground: c.agentRunsBackground,
    pullForward: c.pullForward.map((p) => ({ itemId: p.itemId, title: p.title, youMin: Math.round(p.youMin), due: p.due })),
    focusMinLeft: freeMin,
    plannedMin: youMinToday,
    overByMin: youMinToday - freeMin,
  };
}
