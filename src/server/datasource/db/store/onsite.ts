/**
 * Onsite days (onsite lane): the user's corrections and the projections' per-week record, both in `user_settings`.
 *
 *   cc.onsite.overrides         { days: OnsiteDayOverride[], trips: OnsiteTripOverride[] } — the day chips (Confirm,
 *                                Not onsite, Change account, Adjust hours) and Mark trip. user_settings is audited, so
 *                                a correction is one change set and Undo reverts it (tenet: Suggest, then learn).
 *   cc.onsite.week/<Monday>     what the week pass decided (engine change set, not undoable), with the hash of the
 *                                corrections it saw: a correction (or its Undo) that the hash does not match makes the
 *                                projections recompute that week.
 * The read side (Time, History, the attendance of a trip's meetings) reads the week records only.
 */
import type { OnsiteCorrection, OnsiteDay as ContractOnsiteDay } from '@/contract';
import { addDays } from '@/engines/activity/time';
import type { OnsiteDay as EngineOnsiteDay, OnsiteDayOverride, OnsiteOverrides, OnsiteTripOverride } from '@/engines/activity/onsite';

import { canon } from '../ext';

export const ONSITE_OVERRIDES_KEY = 'cc.onsite.overrides';
export const ONSITE_WEEK_PREFIX = 'cc.onsite.week/';
export const onsiteWeekKey = (weekStart: string) => `${ONSITE_WEEK_PREFIX}${weekStart}`;

export interface OnsiteWeekRecord {
  version: 1;
  weekStart: string;
  /** overridesHash(overridesForWeek(...)) when the week was computed. */
  overridesHash: string;
  days: (EngineOnsiteDay & { accountName: string | null })[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The stored corrections (tolerant: a malformed entry is dropped, never thrown). */
export function readOnsiteOverrides(kv: Map<string, unknown>): OnsiteOverrides {
  const v = kv.get(ONSITE_OVERRIDES_KEY);
  if (!isObj(v)) return { days: [], trips: [] };
  const days = (Array.isArray(v.days) ? v.days : []).filter((d): d is OnsiteDayOverride => isObj(d) && typeof d.day === 'string' && typeof d.onsite === 'boolean');
  const trips = (Array.isArray(v.trips) ? v.trips : []).filter((t): t is OnsiteTripOverride => isObj(t) && typeof t.from === 'string' && typeof t.to === 'string' && typeof t.id === 'string');
  return { days, trips };
}

/** The corrections a week's pass can see: its days plus the context it reads (8 days each side). */
export function overridesForWeek(o: OnsiteOverrides | null | undefined, weekStart: string): OnsiteOverrides {
  const lo = addDays(weekStart, -8);
  const hi = addDays(weekStart, 14);
  return {
    days: (o?.days ?? []).filter((d) => d.day >= lo && d.day <= hi).sort((a, b) => a.day.localeCompare(b.day) || a.at.localeCompare(b.at)),
    trips: (o?.trips ?? []).filter((t) => t.from <= hi && t.to >= lo).sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id)),
  };
}

/** A short stable hash of a set of corrections ("none" when there are none). */
export function overridesHash(o: OnsiteOverrides): string {
  if (!o.days.length && !o.trips.length) return 'none';
  const s = canon(o);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function toContractOnsiteDay(d: OnsiteWeekRecord['days'][number]): ContractOnsiteDay {
  return {
    day: d.day,
    status: d.status,
    accountId: d.accountKey,
    accountName: d.accountName,
    whatOrg62Id: d.whatId,
    whatName: d.whatName,
    city: d.city,
    timezone: d.timezone,
    frame: d.frame ? { start: new Date(d.frame.startsAt).toISOString(), end: new Date(d.frame.endsAt).toISOString() } : null,
    hoursLabel: d.hoursLabel,
    signals: d.signals.map((s) => ({ kind: s.kind, label: s.label, used: s.used })),
    trip: d.tripFrom && d.tripTo ? { from: d.tripFrom, to: d.tripTo } : null,
    locked: d.locked,
  };
}

/** The stored onsite days with from <= day <= to, from the week records. */
export function onsiteDaysIn(kv: Map<string, unknown>, from: string, to: string): ContractOnsiteDay[] {
  const out: ContractOnsiteDay[] = [];
  for (const [k, v] of kv) {
    if (!k.startsWith(ONSITE_WEEK_PREFIX) || !isObj(v) || !Array.isArray(v.days)) continue;
    for (const d of v.days as OnsiteWeekRecord['days']) if (d && d.day >= from && d.day <= to) out.push(toContractOnsiteDay(d));
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export interface CorrectionContext {
  /** The day as the chip shows it now (what Confirm freezes). */
  current: ContractOnsiteDay | null;
  /** accountId / oppId (contract ids) → the Org62 id and name the frame logs to. */
  what: (accountId: string, oppId: string | null | undefined) => { whatId: string | null; whatName: string | null } | null;
  now: string;
}

/**
 * One day-chip correction applied to the stored set. Confirm freezes what the chip shows (account, opp, city, zone),
 * so a later recompute cannot move it; Change account and Adjust hours keep the rest of an earlier correction;
 * Clear drops the day's correction (detection decides again).
 */
export function applyOnsiteCorrection(o: OnsiteOverrides, day: string, c: OnsiteCorrection, ctx: CorrectionContext): OnsiteOverrides {
  const days = o.days.filter((d) => d.day !== day);
  const prev = o.days.find((d) => d.day === day) ?? null;
  const cur = ctx.current;
  // Clear: back to detection for this day, and a trip you marked over it goes too
  if (c.action === 'clear') return { days, trips: o.trips.filter((t) => day < t.from || day > t.to) };
  if (c.action === 'not_onsite') return { days: [...days, { day, onsite: false, at: ctx.now }], trips: o.trips };
  const base: OnsiteDayOverride = {
    day,
    onsite: true,
    accountKey: prev?.accountKey ?? cur?.accountId ?? null,
    whatId: prev?.whatId ?? cur?.whatOrg62Id ?? null,
    whatName: prev?.whatName ?? cur?.whatName ?? null,
    hours: prev?.hours ?? null,
    city: prev?.city ?? cur?.city ?? null,
    timezone: prev?.timezone ?? cur?.timezone ?? null,
    at: ctx.now,
  };
  if (c.action === 'change_account') {
    if (!c.accountId) throw new Error('change_account needs accountId');
    const w = ctx.what(c.accountId, c.oppId);
    Object.assign(base, { accountKey: c.accountId, whatId: w?.whatId ?? null, whatName: w?.whatName ?? null });
    // one account for the whole trip: the trip's other corrected days (and a marked trip) follow
    const trip = cur?.trip;
    if (trip) {
      const inTrip = (d: string) => d >= trip.from && d <= trip.to;
      const move = <T extends { accountKey?: string | null; whatId?: string | null; whatName?: string | null }>(x: T): T => ({ ...x, accountKey: c.accountId!, whatId: w?.whatId ?? null, whatName: w?.whatName ?? null });
      return {
        days: [...days.map((d) => (d.onsite && inTrip(d.day) ? move(d) : d)), base],
        trips: o.trips.map((t) => (t.from <= trip.to && t.to >= trip.from ? move(t) : t)),
      };
    }
  }
  if (c.action === 'adjust_hours') {
    if (!c.start || !c.end || c.end <= c.start) throw new Error('adjust_hours needs start < end (HH:MM)');
    base.hours = { start: c.start, end: c.end };
  }
  return { days: [...days, base], trips: o.trips };
}

/** Mark trip: one trip override; it replaces an earlier one that overlaps it. */
export function addTripOverride(o: OnsiteOverrides, t: Omit<OnsiteTripOverride, 'id' | 'at'>, now: string): OnsiteOverrides {
  const trips = o.trips.filter((x) => x.to < t.from || x.from > t.to);
  return { days: o.days, trips: [...trips, { ...t, id: `trip-${t.from}-${t.to}`, at: now }] };
}

/** The local days of [from, to], inclusive (at most 31). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 31; d = addDays(d, 1)) out.push(d);
  return out;
}
