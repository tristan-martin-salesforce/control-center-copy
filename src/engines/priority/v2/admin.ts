/**
 * Admin batching (lane 07 R6, H-8 decision 3, PRIO-12): logging time, VDP updates, deal-contribution sweeps, trainings
 * and similar admin never rank individually in the Top N. They become one quiet "Admin block" row, placed in the
 * day's lowest-value free slot. The block is promoted to today's load only when an item in it is due within the
 * persona's `promoteWithinH`, or must start today (a pay-linked deadline at risk).
 *
 * Classification is deterministic: an explicit `adminClass` on the item, else the persona's class rules (kinds and
 * title patterns, *Config over code*). Pure.
 */
import type { PriorityItem } from '@/engines/types';
import { formatDuration, formatLocalWhen, HOUR_MS, MINUTE_MS, type Interval } from '../time';
import type { AdminClassId, PriorityConfig } from './config';

export function adminClassOf(item: Pick<PriorityItem, 'kind' | 'title'> & { adminClass?: string | null }, cfg: Pick<PriorityConfig, 'admin'>): AdminClassId | null {
  if (item.adminClass) return item.adminClass as AdminClassId;
  for (const c of cfg.admin.classes) {
    if (c.kinds?.includes(item.kind)) return c.id;
    if (c.titlePattern && new RegExp(c.titlePattern, 'i').test(item.title)) return c.id;
  }
  return null;
}

export interface AdminMember {
  id: string;
  title: string;
  cls: AdminClassId;
  youMin: number;
  /** The need-by (null when undated). */
  dueMs: number | null;
  /** The backward plan's start-by (null when undated or late). */
  startByMs: number | null;
  late: boolean;
}

/** Due within the promote window, late, or must start today: today's load. */
export function adminPromoted(m: AdminMember, o: { nowMs: number; todayEndMs: number; promoteWithinH: number }): boolean {
  if (m.late) return true;
  if (m.dueMs !== null && m.dueMs - o.nowMs <= o.promoteWithinH * HOUR_MS) return true;
  return m.startByMs !== null && m.startByMs < o.todayEndMs;
}

export interface AdminBatch {
  /** All admin items, in need-by order. */
  itemIds: string[];
  /** The ones that are today's load (promoted). */
  promotedIds: string[];
  count: number;
  /** Hands-on minutes of the promoted items (the block's length today). */
  youMin: number;
  /** Hands-on minutes of all of them. */
  totalMin: number;
  nextDue: string | null;
  promoted: boolean;
  /** "Admin: 4 items · ~25 min · next due Fri 16:00". */
  label: string;
  /** Where the block goes today (the lowest-value free slot), when promoted and a slot exists. */
  slot: { start: string; end: string } | null;
}

/**
 * The lowest-value free slot today: among today's free intervals long enough for `needMin` (else all of them), the one
 * whose time the backward plan values least (Σ value × planned minutes per free minute); ties go to the later slot.
 */
export function lowestValueSlot(today: readonly Interval[], committed: ReadonlyArray<{ placed: readonly Interval[]; value: number }>, needMin: number): Interval | null {
  if (!today.length) return null;
  const long = today.filter((i) => (i.endMs - i.startMs) / MINUTE_MS >= needMin);
  const pool = long.length ? long : today;
  let best: { i: Interval; density: number } | null = null;
  for (const i of pool) {
    let weighted = 0;
    for (const c of committed)
      for (const p of c.placed) {
        const s = Math.max(p.startMs, i.startMs);
        const e = Math.min(p.endMs, i.endMs);
        if (e > s) weighted += c.value * ((e - s) / MINUTE_MS);
      }
    const density = weighted / Math.max(1, (i.endMs - i.startMs) / MINUTE_MS);
    if (!best || density < best.density - 1e-9 || (Math.abs(density - best.density) <= 1e-9 && i.startMs > best.i.startMs)) best = { i, density };
  }
  if (!best) return null;
  const end = Math.min(best.i.endMs, best.i.startMs + Math.max(needMin, 5) * MINUTE_MS);
  return { startMs: best.i.startMs, endMs: end };
}

export function adminBatchOf(
  members: readonly AdminMember[],
  o: { nowMs: number; todayEndMs: number; utcOffsetMinutes: number; promoteWithinH: number; todayFree: readonly Interval[]; committed: ReadonlyArray<{ placed: readonly Interval[]; value: number }> },
): AdminBatch | null {
  if (!members.length) return null;
  const sorted = [...members].sort((a, b) => (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity) || a.id.localeCompare(b.id));
  const promoted = sorted.filter((m) => adminPromoted(m, o));
  const youMin = promoted.reduce((s, m) => s + m.youMin, 0);
  const totalMin = sorted.reduce((s, m) => s + m.youMin, 0);
  const next = sorted.find((m) => m.dueMs !== null && m.dueMs > o.nowMs);
  const late = sorted.filter((m) => m.late).length;
  const nextDue = next?.dueMs ? new Date(next.dueMs).toISOString() : null;
  const slot = promoted.length ? lowestValueSlot(o.todayFree, o.committed, youMin) : null;
  const n = sorted.length;
  const minutes = promoted.length ? youMin : totalMin;
  const label = `Admin: ${n} item${n === 1 ? '' : 's'} · ~${formatDuration(minutes)}${promoted.length && promoted.length < n ? ` today (${promoted.length} of ${n})` : ''}${late ? ` · ${late} late` : ''}${next?.dueMs ? ` · next due ${formatLocalWhen(next.dueMs, o.nowMs, o.utcOffsetMinutes)}` : ''}`;
  return {
    itemIds: sorted.map((m) => m.id),
    promotedIds: promoted.map((m) => m.id),
    count: n,
    youMin,
    totalMin,
    nextDue,
    promoted: promoted.length > 0,
    label,
    slot: slot ? { start: new Date(slot.startMs).toISOString(), end: new Date(slot.endMs).toISOString() } : null,
  };
}
