/**
 * Lane 2, Ready to log (Activity-at-scale C5, AX-4, §3.3, §3.4; D-102), pure; tests/time/review.test.ts. The lane is
 * the Review page's model (./review-derive.ts: who is ticked, the re-check, the stage request, the result lines) laid
 * out at scale:
 *
 *   READY TO LOG · 12 rows · 14.5 h · 1 use case             [Log 12 rows · 1 use case]
 *   ☑ Mon 16 Nov · 3 rows · 4.5 h                     (by day, how Org62 reads it; Account the alternative)
 *     ☑ Mon 16 09:00  ACME weekly sync   1 h  ACME · Platform  ›
 *     … 8 rows a group, then Show more; at most 4 groups open, the rest as headers with counts
 *   ☐ ▸ Use cases  1                                  (rows of their own, at the end; ticked once open)
 *   ☐ ▸ Events in Org62  1
 *
 * F3 (R2-3): the header counts what the button can log, extras named ("2 rows · 2 h · 29 use cases"); the button says
 * what it stages ("Log 2 rows · 29 use cases", or "Log 2 rows · 2 h" with no extras ticked). On To log the extras start
 * unticked until their group is open (a user never stages what they have not seen); on the Review page they are open.
 */
import { fmtH } from './derive';
import { canCheck, canTickExtra, logButton, type ReviewEntry, type ReviewExtra } from './review-derive';

export type ReadyGroupBy = 'day' | 'account';

/** Rows a group shows before "Show more". */
export const READY_STEP = 8;
/** Groups open at once; the rest are header lines with their counts. */
export const READY_OPEN_MAX = 4;

export interface ReadyGroup {
  /** The day (`2026-11-16`) or `acct|<account>`. */
  key: string;
  /** "Mon, Nov 16" is drawn by the lane from the key; for an account, the account's name. */
  label: string;
  rows: ReviewEntry[];
  hours: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const sumH = (rows: readonly ReviewEntry[]) => r2(rows.reduce((s, r) => s + r.entry.durationH, 0));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const accountOf = (r: ReviewEntry): string => {
  const e = r.entry;
  if (e.internal) return 'Internal (no opportunity)';
  if (e.accountName?.trim()) return e.accountName.trim();
  if (r.kind === 'suggested' && e.suggestion?.kind === 'opp' && e.suggestion.accountName) return e.suggestion.accountName;
  return 'No account yet';
};

/**
 * The lane's groups. By day: oldest day first, rows oldest first. By account: the account with the most hours first
 * (Internal and "No account yet" last), rows oldest first.
 */
export function readyGroups(rows: readonly ReviewEntry[], by: ReadyGroupBy): ReadyGroup[] {
  const sorted = [...rows].sort((a, b) => a.entry.start.localeCompare(b.entry.start));
  const m = new Map<string, ReadyGroup>();
  for (const r of sorted) {
    const label = by === 'day' ? r.entry.date : accountOf(r);
    const key = by === 'day' ? r.entry.date : `acct|${label}`;
    const g = m.get(key) ?? { key, label, rows: [], hours: 0 };
    g.rows.push(r);
    m.set(key, g);
  }
  const out = [...m.values()].map((g) => ({ ...g, hours: sumH(g.rows) }));
  if (by === 'day') return out.sort((a, b) => a.key.localeCompare(b.key));
  const last = (g: ReadyGroup) => (g.label === 'Internal (no opportunity)' || g.label === 'No account yet' ? 1 : 0);
  return out.sort((a, b) => last(a) - last(b) || b.hours - a.hours || a.label.localeCompare(b.label));
}

/** The groups open when the lane opens: the first READY_OPEN_MAX. */
export const defaultOpen = (groups: readonly ReadyGroup[]): Set<string> => new Set(groups.slice(0, READY_OPEN_MAX).map((g) => g.key));

/** Lane 2's count per kind (C11): what the header names and the button stages, every kind by name. */
export interface ReadyKinds {
  rows: number;
  hours: number;
  dcs: number;
  useCases: number;
  events: number;
}

export function readyKinds(rows: readonly ReviewEntry[], extras: readonly ReviewExtra[] = []): ReadyKinds {
  const take = rows.filter(canCheck);
  const n = (k: ReviewExtra['kind']) => extras.filter((x) => x.kind === k).length;
  return { rows: take.length, hours: sumH(take), dcs: n('dc'), useCases: n('useCase'), events: n('update') };
}

/** "3 DCs · 29 use cases · 3 Event changes": the extras named by kind (never folded into "rows"). */
function extrasWords(extras: readonly ReviewExtra[]): string[] {
  const k = readyKinds([], extras);
  return [k.dcs ? plural(k.dcs, 'DC') : null, k.useCases ? plural(k.useCases, 'use case') : null, k.events ? plural(k.events, 'Event change') : null].filter((x): x is string => !!x);
}

/**
 * The lane header's count, what the button can log (F3, R2-3): "2 rows · 2 h · 29 use cases" (the extras named after
 * the time rows), "29 use cases" with no rows, or "Nothing ready". Unsure rows are not counted.
 */
export function laneCount(all: readonly ReviewEntry[], extras: readonly ReviewExtra[] = []): string {
  // F5 (R2-6): an unsure row (the Review page's pick-an-opp rows) can't be logged until picked: lane 2's count leaves it
  // out, so Review's header and To log's lane header say the same
  const rows = all.filter(canCheck);
  const parts = [...(rows.length ? [plural(rows.length, 'row'), fmtH(sumH(rows))] : []), ...extrasWords(extras)];
  return parts.length ? parts.join(' · ') : 'Nothing ready';
}

/**
 * The lane's one button says what it stages (F3, R2-3): "Log 2 rows · 2 h" with only time rows ticked, "Log 2 rows ·
 * 29 use cases" when extras are ticked too, "Log 29 use cases" with extras only; off with why when nothing is ticked.
 */
export function laneButton(rows: readonly ReviewEntry[], checked: ReadonlySet<string>, extras: readonly ReviewExtra[] = []): { label: string; disabled: boolean; why: string | null; count: number; hours: number } {
  const b = logButton(rows, checked, extras);
  if (b.disabled) return { ...b, label: 'Log' };
  const n = rows.filter((r) => checked.has(r.id) && canCheck(r)).length;
  const more = extrasWords(extras.filter((x) => checked.has(x.id) && canTickExtra(x)));
  const label = more.length ? [...(n ? [plural(n, 'row')] : []), ...more].join(' · ') : `${plural(n, 'row')} · ${fmtH(b.hours)}`;
  return { ...b, label: `Log ${label}` };
}

/**
 * Beside the button (R3-5): what is ticked per kind, of what the header counts, so header, line and button tell one
 * story: "2 rows · 2 h · 2 DCs · 8 of 29 use cases ticked" (a kind all ticked reads its count; "0 of 3 Event changes"
 * when none of it is). Empty when the lane has nothing to log.
 */
export function tickedLine(rows: readonly ReviewEntry[], checked: ReadonlySet<string>, extras: readonly ReviewExtra[] = []): string {
  const share = (t: number, n: number, one: string) => (t === n ? plural(n, one) : `${t} of ${plural(n, one)}`);
  const take = rows.filter(canCheck);
  const on = take.filter((r) => checked.has(r.id));
  const parts = take.length ? [share(on.length, take.length, 'row'), ...(on.length ? [fmtH(sumH(on))] : [])] : [];
  for (const [kind, one] of [['dc', 'DC'], ['useCase', 'use case'], ['update', 'Event change']] as const) {
    const all = extras.filter((x) => x.kind === kind);
    if (all.length) parts.push(share(all.filter((x) => checked.has(x.id) && canTickExtra(x)).length, all.length, one));
  }
  return parts.length ? `${parts.join(' · ')} ticked` : '';
}

export interface ExtraGroup {
  key: 'dc' | 'useCase' | 'update';
  /** "DCs to claim", "Use cases", "Events in Org62" (the header draws the count beside it: "Use cases 29"). */
  label: string;
  items: ReviewExtra[];
}

const EXTRA_LABEL: Record<ExtraGroup['key'], string> = { dc: 'DCs to claim', useCase: 'Use cases', update: 'Events in Org62' };

/** After the time rows, in this order (C11): DCs to claim, use cases ready for Org62, changes to Events in Org62. */
export function extraGroups(extras: readonly ReviewExtra[]): ExtraGroup[] {
  return (['dc', 'useCase', 'update'] as const).map((key) => ({ key, label: EXTRA_LABEL[key], items: extras.filter((x) => x.kind === key) })).filter((g) => g.items.length);
}

/** The items of a group a user has seen: the first `shown` of an open group, none of a folded one (F3, per group). */
export const seenItems = (g: ExtraGroup, open: boolean, shown: number): ReviewExtra[] => (open ? g.items.slice(0, shown) : []);

/** A group header's tick: all of its tickable ids ticked, some (mixed), or none. */
export function groupTick(ids: readonly string[], checked: ReadonlySet<string>): { checked: boolean; mixed: boolean } {
  const n = ids.filter((id) => checked.has(id)).length;
  return { checked: !!ids.length && n === ids.length, mixed: n > 0 && n < ids.length };
}

/** The tickable ids of a group (an unsure row needs its pick first). */
export const tickable = (rows: readonly ReviewEntry[]): string[] => rows.filter(canCheck).map((r) => r.id);

const GROUP_KEY = 'cc:activity:ready-group';

/** The viewer's grouping (localStorage, per viewer; day when unset or unreadable). */
export function readGroupBy(): ReadyGroupBy {
  try {
    return localStorage.getItem(GROUP_KEY) === 'account' ? 'account' : 'day';
  } catch {
    return 'day';
  }
}

export function writeGroupBy(by: ReadyGroupBy): void {
  try {
    localStorage.setItem(GROUP_KEY, by);
  } catch {
    /* memory only */
  }
}
