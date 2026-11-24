/**
 * Work-list grouping (pure): by initiative (rank order of first appearance, "No initiative" last) or by due.
 */
import type { EntityRef } from '@/contract';
import { dayDiff } from './time';

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'later' | 'none';

export const DUE_ORDER: DueBucket[] = ['overdue', 'today', 'tomorrow', 'this_week', 'later', 'none'];
export const DUE_LABEL: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  this_week: 'This week',
  later: 'Later',
  none: 'No date',
};

export function dueBucket(due: string | null | undefined, now: string, tz?: string): DueBucket {
  if (!due) return 'none';
  if (Date.parse(due) < Date.parse(now)) return 'overdue';
  const d = dayDiff(now, due, tz);
  if (d <= 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d <= 7) return 'this_week';
  return 'later';
}

export interface Group<T> {
  key: string;
  label: string;
  /** Initiative id for initiative groups. */
  entityId: string | null;
  items: T[];
}

export function groupByDue<T extends { due: string | null }>(items: T[], now: string, tz?: string): Group<T>[] {
  const buckets = new Map<DueBucket, T[]>();
  for (const it of items) {
    const b = dueBucket(it.due, now, tz);
    const list = buckets.get(b) ?? [];
    list.push(it);
    buckets.set(b, list);
  }
  return DUE_ORDER.filter((b) => buckets.has(b)).map((b) => ({ key: `due:${b}`, label: DUE_LABEL[b], entityId: null, items: buckets.get(b)! }));
}

export function groupByInitiative<T extends { refs: { initiative: EntityRef | null } }>(items: T[]): Group<T>[] {
  const map = new Map<string, Group<T>>();
  for (const it of items) {
    const ini = it.refs.initiative;
    const key = ini ? `ini:${ini.id}` : 'ini:none';
    let g = map.get(key);
    if (!g) {
      g = { key, label: ini?.label ?? 'No initiative', entityId: ini?.id ?? null, items: [] };
      map.set(key, g);
    }
    g.items.push(it);
  }
  const all = [...map.values()];
  return [...all.filter((g) => g.entityId), ...all.filter((g) => !g.entityId)];
}

// ── v2: verb-named focus sections (DESIGN-V2 principle 3) ─────────────────────────────────────

export type FocusSection = 'looks_done' | 'do_now' | 'this_week' | 'chase' | 'think_ahead' | 'fit_in';

/** LD-1: likely-done work first, out of Do now: it waits for one click (Confirm or Not done), not for work. */
export const FOCUS_ORDER: FocusSection[] = ['looks_done', 'do_now', 'this_week', 'chase', 'think_ahead', 'fit_in'];
/** "Due today", not "Do now": Home's Do now is the top 3, so the same words never name a list of 9 (01-ui-audit UI-17, R3). */
export const FOCUS_LABEL: Record<FocusSection, string> = {
  looks_done: 'Looks done: confirm',
  do_now: 'Due today',
  this_week: 'Do this week',
  chase: 'Chase',
  think_ahead: 'Think ahead',
  fit_in: 'Fit in',
};
/** One quiet line after each section's count. */
export const FOCUS_SUB: Record<FocusSection, string> = {
  looks_done: 'the evidence says finished: one click each',
  do_now: 'late, or starts or is due today',
  this_week: 'the next 7 days',
  chase: 'waiting on someone else',
  think_ahead: 'more than a week out',
  fit_in: 'no date: pull in when there is time',
};

type FocusItem = { state: string; startBy: string | null; due: string | null };

/** Which section an open item belongs to: waiting on others → Chase; else by its start-by (or due) date. */
export function focusSection(item: FocusItem, now: string, tz?: string): FocusSection {
  if (item.state === 'likely_done') return 'looks_done';
  if (item.state === 'waiting_on_others') return 'chase';
  const b = dueBucket(item.startBy ?? item.due, now, tz);
  if (b === 'overdue' || b === 'today') return 'do_now';
  if (b === 'tomorrow' || b === 'this_week') return 'this_week';
  if (b === 'later') return 'think_ahead';
  return 'fit_in';
}

/** Work in verb sections, in focus order; empty sections are dropped and list order is kept inside each. */
export function groupByFocus<T extends FocusItem>(items: T[], now: string, tz?: string): Group<T>[] {
  const buckets = new Map<FocusSection, T[]>();
  for (const it of items) {
    const s = focusSection(it, now, tz);
    const list = buckets.get(s) ?? [];
    list.push(it);
    buckets.set(s, list);
  }
  return FOCUS_ORDER.filter((s) => buckets.has(s)).map((s) => ({ key: `focus:${s}`, label: FOCUS_LABEL[s], entityId: null, items: buckets.get(s)! }));
}

/** Rows a section shows: everything when expanded, else 3 (5 at 2,400 px and wider). DESIGN-V2 principle 2. */
export function shownCount(total: number, opts: { expanded?: boolean; wide?: boolean; cap?: number; capWide?: number }): number {
  if (opts.expanded) return total;
  return Math.min(total, opts.wide ? (opts.capWide ?? 5) : (opts.cap ?? 3));
}
