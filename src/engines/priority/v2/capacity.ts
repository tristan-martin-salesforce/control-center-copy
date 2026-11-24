/**
 * Capacity honesty (lane 07 §4.2, PRIO-3): today's load (Σ hands-on minutes of what is due today, must start today
 * or is pinned to today: the p0 rule) against the free minutes the calendar leaves. When the load does not fit, the
 * copy everywhere is "Overbooked by N min" (never "fits"), and v2 proposes what to move: lowest value first, latest
 * deadline first among equals, until the overflow is covered ("Make room"). Data only; Home draws the card.
 * Pure. Nothing is moved: the user picks (*Nothing leaves without approval* holds trivially: nothing leaves).
 */
import { formatLocalWhen } from '../time';

/** The one wording for an overbooked day, everywhere (Today, Home, the capacity meter). */
export function overbookedLabel(overByMin: number): string {
  return `Overbooked by ${Math.max(1, Math.round(overByMin))} min`;
}

export interface MakeRoomCandidate {
  id: string;
  title: string;
  youMin: number;
  /** V (0–100): what it is worth, independent of time. */
  value: number;
  /** Its need-by, or null when undated (an undated item is the easiest to move). */
  needByMs: number | null;
  /** Pinned by the user, or late: never proposed. */
  locked?: boolean;
}

export interface MakeRoomRow {
  itemId: string;
  title: string;
  youMin: number;
  value: number;
  needBy: string | null;
  /** "lowest value · due Fri 17:00". */
  reason: string;
}

export interface MakeRoom {
  overByMin: number;
  label: string;
  rows: MakeRoomRow[];
  /** Minutes the rows free; ≥ overByMin when the list covers the overflow. */
  freesMin: number;
}

/** What to move when the day is overbooked: lowest value × latest deadline first, until the overflow is covered. */
export function makeRoom(candidates: readonly MakeRoomCandidate[], overByMin: number, o: { nowMs: number; utcOffsetMinutes: number; max?: number }): MakeRoom | null {
  if (!(overByMin > 0)) return null;
  const pool = candidates
    .filter((c) => !c.locked && c.youMin > 0)
    .sort((a, b) => a.value - b.value || (b.needByMs ?? Infinity) - (a.needByMs ?? Infinity) || a.id.localeCompare(b.id));
  const rows: MakeRoomRow[] = [];
  let frees = 0;
  const max = o.max ?? 5;
  for (const c of pool) {
    if (frees >= overByMin || rows.length >= max) break;
    rows.push({
      itemId: c.id,
      title: c.title,
      youMin: c.youMin,
      value: c.value,
      needBy: c.needByMs === null ? null : new Date(c.needByMs).toISOString(),
      reason: `${rows.length === 0 ? 'lowest value' : 'low value'}${c.needByMs === null ? ' · undated' : ` · due ${formatLocalWhen(c.needByMs, o.nowMs, o.utcOffsetMinutes)}`}`,
    });
    frees += c.youMin;
  }
  return { overByMin: Math.round(overByMin), label: overbookedLabel(overByMin), rows, freesMin: frees };
}
