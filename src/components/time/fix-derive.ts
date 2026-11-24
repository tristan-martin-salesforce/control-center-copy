/**
 * Lane 1 of To log, Fix or approve (D-102; Activity-at-scale C4, AX-1, AX-3, §3.4): the rows that cannot log yet, in
 * groups a whole of which is one click. Pure; tested in tests/time/review.test.ts.
 *
 *   by suggestion (default)   "Suggested: <account · opp>" (Accept N takes those suggestions), "Suggested: Internal"
 *                             (Accept logs them as internal; the internal rows the app suggests are never counted as
 *                             needing you), "No suggestion: pick an opp", "Missing a task type", "Hours to check",
 *                             "Check and approve"
 *   by day / account / opp    the same rows by their day, account or (suggested) opportunity; Internal stays a group
 *
 * A row from an earlier fiscal quarter (F1: the lanes reach back to the oldest row that needs you) groups apart under
 * its quarter ("Q3 FY27 · Suggested: …", by day "Q3 · Tue 20 Oct"), so it reads why it is there.
 *
 * C11, two bands by confidence: **Accept** (a suggestion at or over the settle line with no close second, compact-derive
 * `settled`, and the Internal group: the header's "Accept N suggestions" takes this band only, so accept-all never
 * takes a guess) and **Review** (a guess under the line, no suggestion, a missing type or hours, a row to check:
 * grayed, never in Accept N, each row its own pick or Accept). A grouping splits a group across the bands ("r|" ids).
 *
 * Order: the Accept band, then Review; inside a band the group whose rows' quarter is due soonest first; then the group with the most likely suggestion; then the
 * most hours; rows inside a group oldest first. Rows Org62 lacks after their batch ran are not here (lane 3), so the
 * count is `lanesOf(...).fix` (./lanes-derive.ts).
 */
import type { ActivityEntry } from '@/contract';
import { dayLabel } from '@/components/domain/lib/time';
import { fiscalQuarterOfDay } from '@/engines/activity/to-log-rows';
import { hasTarget } from '@/lib/time-internal';
import { DEFAULT_WEIGHTS } from '@/engines/attribution/weights';
import { accountOpp, settled } from './compact-derive';
import { fixRowsOf } from './lanes-derive';
import type { FixPatch, InternalGroup, NeedKind, NeedsYou } from './path-derive';
import { acceptPatch, completeForApprove } from './rows-derive';

export type FixGroupBy = 'suggestion' | 'day' | 'account' | 'opp';
export const FIX_GROUP_BY: readonly FixGroupBy[] = ['suggestion', 'day', 'account', 'opp'];
export const FIX_GROUP_BY_LABEL: Record<FixGroupBy, string> = { suggestion: 'Suggestion', day: 'Day', account: 'Account', opp: 'Opportunity' };

/** Rows per group before "Show N more in this group". */
export const FIX_STEP = 8;
/** Groups open at once; the rest are header lines with their counts. */
export const FIX_OPEN_MAX = 4;

export type FixGroupKind = 'suggested' | 'internal' | 'pick' | 'type' | 'hours' | 'check' | 'day' | 'account' | 'opp';

export interface FixGroup {
  /** Stable per grouping ("sugg:006A", "internal", "pick", "day:2026-11-10"). */
  id: string;
  kind: FixGroupKind;
  /** "Suggested: Globex · Data 360 Expansion" (the count shows beside it). */
  label: string;
  /** The account · opp the label names: a row in this group does not repeat it. */
  target: string | null;
  rows: ActivityEntry[];
  ids: string[];
  hours: number;
  /** The rows the group's Accept acts on. */
  accept: ActivityEntry[];
  /** False for the Internal group (never in the lane's count). */
  counted: boolean;
  /** The soonest quarter end among its rows (YYYY-MM-DD). */
  due: string;
  /** The most likely suggestion among its rows (0 when none). */
  top: number;
  /** C11: Accept (a sure suggestion, or Internal) or Review (a guess, no suggestion, something missing). */
  band: FixBand;
}

export type FixBand = 'accept' | 'review';

export interface FixModel {
  groups: FixGroup[];
  /** Lane 1's count: lanesOf's fix rows (never Internal, never not found in Org62). */
  count: number;
  hours: number;
  /** Every counted row of the Accept band the header's "Accept N suggestions" acts on (never a guess). */
  suggested: ActivityEntry[];
  /**
   * Counted rows per band, for the band headers (R3-4): Accept + Review = `count`. `internal` is the Internal rows the
   * app suggests (in the Accept band, never counted): the Accept header names them apart ("Accept 12 · Internal 14").
   */
  bands: Record<FixBand, number> & { internal: number };
}

/** The band a row of lane 1 sits in: Accept only for a sure suggestion of an opp (or Internal); everything else Review. */
export function bandOf(e: ActivityEntry, kind: FixGroupKind | 'internal', settle: number): FixBand {
  if (kind === 'internal') return 'accept';
  const s = e.suggestion;
  return !hasTarget(e) && s && s.kind === 'opp' && s.oppId && settled(e, settle) ? 'accept' : 'review';
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const sumH = (xs: readonly Pick<ActivityEntry, 'durationH'>[]) => r2(xs.reduce((s, e) => s + e.durationH, 0));
const byStart = (a: ActivityEntry, b: ActivityEntry) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id);

/** The last day of the Salesforce fiscal quarter a day falls in (FY from 1 February: quarters end Apr, Jul, Oct, Jan). */
export function quarterEndOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1; // 0-based
  const into = (m - 1 + 12) % 3; // months into the quarter (Feb, May, Aug and Nov start one)
  return new Date(Date.UTC(y, m + (2 - into) + 1, 0)).toISOString().slice(0, 10);
}

/** An internal row the app suggests (proposed, Related To empty): Accept approves it as it is. */
const isSuggestedInternal = (e: ActivityEntry) => e.internal && e.status === 'proposed';

/**
 * The patch a row's Accept sends: an internal row the app suggests is approved as it is; a row with no opportunity
 * takes the app's suggestion (rows-derive acceptPatch, the path Accept has always used); a complete held row is
 * approved. Null: nothing to accept.
 */
export function fixAcceptPatch(e: ActivityEntry, taskTypeRequired = true): FixPatch | null {
  if (isSuggestedInternal(e)) return { status: 'approved' };
  if (!hasTarget(e)) return acceptPatch(e, taskTypeRequired);
  return e.status === 'needs_input' && completeForApprove(e, taskTypeRequired) ? { status: 'approved' } : null;
}

const BAND_ORDER: Record<FixBand, number> = { accept: 0, review: 1 };
const KIND_ORDER: Record<FixGroupKind, number> = { suggested: 0, internal: 1, pick: 2, type: 3, hours: 4, check: 5, day: 0, account: 0, opp: 0 };
const KIND_LABEL = { internal: 'Suggested: Internal', pick: 'No suggestion: pick an opp', type: 'Missing a task type', hours: 'Hours to check', check: 'Check and approve' } as const;

interface Slot {
  id: string;
  kind: FixGroupKind;
  label: string;
  target: string | null;
  rows: ActivityEntry[];
}

const INTERNAL_SLOT: Omit<Slot, 'rows'> = { id: 'internal', kind: 'internal', label: KIND_LABEL.internal, target: 'Internal' };

function slotOf(e: ActivityEntry, need: NeedKind, by: FixGroupBy, taskTypeRequired: boolean): Omit<Slot, 'rows'> {
  const s = e.suggestion;
  const sugg = need === 'opp' && s && s.kind === 'opp' && s.oppId && acceptPatch(e, taskTypeRequired) ? s : null;
  if (need === 'opp' && s?.kind === 'internal') return INTERNAL_SLOT;
  if (by === 'day') return { id: `day:${e.date}`, kind: 'day', label: dayLabel(`${e.date}T12:00:00Z`, 'UTC'), target: null };
  if (by === 'account') {
    const acct = e.accountName ?? sugg?.accountName ?? null;
    return acct ? { id: `acct:${acct}`, kind: 'account', label: acct, target: null } : { id: 'acct:', kind: 'account', label: 'No account yet', target: null };
  }
  if (by === 'opp') {
    if (e.oppId) return { id: `opp:${e.oppId}`, kind: 'opp', label: accountOpp(e.accountName, e.oppName), target: accountOpp(e.accountName, e.oppName) };
    if (sugg) return { id: `opp:${sugg.oppId}`, kind: 'opp', label: `Suggested: ${accountOpp(sugg.accountName, sugg.oppName)}`, target: accountOpp(sugg.accountName, sugg.oppName) };
    return { id: 'opp:', kind: 'opp', label: 'No opportunity yet', target: null };
  }
  if (sugg) {
    const target = accountOpp(sugg.accountName, sugg.oppName);
    return { id: `sugg:${sugg.oppId}`, kind: 'suggested', label: `Suggested: ${target}`, target };
  }
  const kind = need === 'opp' ? 'pick' : need === 'type' ? 'type' : need === 'hours' ? 'hours' : 'check';
  return { id: kind, kind, label: KIND_LABEL[kind], target: null };
}

/** Group order: quarter due soonest, then the kind (by suggestion), then the most likely suggestion, then the most hours. */
export function compareGroups(a: FixGroup, b: FixGroup): number {
  return a.due.localeCompare(b.due) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.top - a.top || b.hours - a.hours || a.label.localeCompare(b.label);
}

export interface FixInput {
  needs: Pick<NeedsYou, 'groups'>;
  internal: Pick<InternalGroup, 'rows'>;
  by?: FixGroupBy;
  taskTypeRequired?: boolean;
  /** The settle line (review-derive settleLineFor): a suggestion at or over it is in the Accept band. */
  settle?: number;
  /**
   * Today (YYYY-MM-DD): a row from an earlier fiscal quarter (F1: the lanes reach back to the oldest row that still
   * needs you) groups apart under its quarter ("Q3 FY27 · Suggested: …", "Q3 · Tue 20 Oct"). Absent: the latest row's.
   */
  today?: string;
}

/** A slot for a row of an earlier quarter: its own group, the quarter named first. */
function inQuarter(k: Omit<Slot, 'rows'>, q: string, by: FixGroupBy): Omit<Slot, 'rows'> {
  return { ...k, id: `${k.id}@${q}`, label: by === 'day' ? `${q.split(' ')[0]} · ${k.label}` : `${q} · ${k.label}` };
}

/** Lane 1's groups, in order, and its count. */
export function fixLane({ needs, internal, by = 'suggestion', taskTypeRequired = true, settle = DEFAULT_WEIGHTS.settle, today }: FixInput): FixModel {
  const counted = fixRowsOf(needs);
  const latest = today ?? needs.groups.flatMap((g) => g.rows.map((e) => e.date)).sort().at(-1);
  const current = latest ? fiscalQuarterOfDay(latest) : null;
  const slot = (e: ActivityEntry, k0: Omit<Slot, 'rows'>) => {
    const q = fiscalQuarterOfDay(e.date);
    const k = current && q !== current && k0.kind !== 'internal' ? inQuarter(k0, q, by) : k0;
    // a row under the settle line (or with no suggestion) sits in the Review band: its own group there
    return bandOf(e, k.kind, settle) === 'review' ? { ...k, id: `r|${k.id}` } : k;
  };
  const countedIds = new Set(counted.map((e) => e.id));
  const slots = new Map<string, Slot>();
  const seen = new Set<string>();
  const put = (e: ActivityEntry, k: Omit<Slot, 'rows'>) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    const s = slots.get(k.id) ?? { ...k, rows: [] };
    s.rows.push(e);
    slots.set(k.id, s);
  };
  for (const g of needs.groups) {
    if (g.kind === 'org62') continue; // lane 3's failures
    // an internal row held for a type or hours has no opportunity by design and is never counted: the Internal group
    for (const e of g.rows) put(e, countedIds.has(e.id) ? slot(e, slotOf(e, g.kind, by, taskTypeRequired)) : INTERNAL_SLOT);
  }
  for (const e of internal.rows) put(e, INTERNAL_SLOT);

  const groups = [...slots.values()]
    .map((s): FixGroup => {
      const rows = [...s.rows].sort(byStart);
      const top = Math.max(0, ...rows.map((e) => (e.suggestion && !hasTarget(e) ? e.suggestion.confidence : 0)));
      const internalOnly = s.kind === 'internal' && rows.every((e) => !countedIds.has(e.id));
      return {
        id: s.id,
        kind: s.kind,
        label: s.label,
        target: s.target,
        rows,
        ids: rows.map((e) => e.id),
        hours: sumH(rows),
        accept: rows.filter((e) => !!fixAcceptPatch(e, taskTypeRequired)),
        counted: !internalOnly,
        due: rows.map((e) => quarterEndOf(e.date)).sort()[0] ?? '',
        top,
        band: s.kind === 'internal' || !s.id.startsWith('r|') ? 'accept' : 'review',
      };
    })
    .sort((a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || (by === 'day' ? (a.kind === 'internal' ? 1 : 0) - (b.kind === 'internal' ? 1 : 0) || a.id.localeCompare(b.id) : compareGroups(a, b)));
  const inAccept = new Set(groups.filter((g) => g.band === 'accept').flatMap((g) => g.ids));
  const suggested = counted.filter((e) => inAccept.has(e.id) && !!e.suggestion && !!fixAcceptPatch(e, taskTypeRequired));
  const inBand = (b: FixBand) => groups.filter((g) => g.band === b).reduce((n, g) => n + g.rows.filter((e) => countedIds.has(e.id)).length, 0);
  const bands = { accept: inBand('accept'), review: inBand('review'), internal: groups.reduce((n, g) => n + g.rows.filter((e) => !countedIds.has(e.id)).length, 0) };
  return { groups, count: counted.length, hours: sumH(counted), suggested, bands };
}

/** The groups open at first: the first FIX_OPEN_MAX in order. */
export const initialOpen = (groups: readonly Pick<FixGroup, 'id'>[]): string[] => groups.slice(0, FIX_OPEN_MAX).map((g) => g.id);

/** Toggle a group: an opened one joins the open ones, and the one opened longest ago closes past FIX_OPEN_MAX. */
export function toggleGroup(open: readonly string[], id: string): string[] {
  if (open.includes(id)) return open.filter((x) => x !== id);
  const next = [...open, id];
  return next.length > FIX_OPEN_MAX ? next.slice(next.length - FIX_OPEN_MAX) : next;
}

/** Shift-click: every id between the last ticked and this one (inclusive), in the order shown. */
export function rangeIds(order: readonly string[], from: string | null, to: string): string[] {
  const a = from ? order.indexOf(from) : -1;
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** "3 ticked · 4.5 h" */
export const tickedLine = (rows: readonly Pick<ActivityEntry, 'durationH'>[]): string => `${rows.length} ticked · ${sumH(rows)} h`;

/** The group header's verb, "Accept 9" (null when nothing in it can be accepted, and in the Review band: row by row). */
export const groupVerbLabel = (g: Pick<FixGroup, 'accept'> & Partial<Pick<FixGroup, 'band'>>): string | null => (g.band !== 'review' && g.accept.length ? `Accept ${g.accept.length}` : null);

/**
 * The band headers: "Accept 12 · Internal 14" and "Review 62" (R3-4: the counted rows, so Accept + Review = the lane's
 * count; the Internal rows the app suggests are named apart, never in it). A band with no rows has none.
 */
export const bandLabel = (band: FixBand, n: number, internal = 0): string => (band === 'accept' ? `Accept ${n}${internal ? ` · Internal ${internal}` : ''}` : `Review ${n}`);
