/**
 * The two item menus (01-ui-audit R6): **Done ▾** and **Later ▾** replace the five near-synonym verbs (Done, Resolve,
 * Snooze, Not now, plus Accept/Dismiss outside Triage). The API does not change: each choice maps onto one existing
 * `POST /items/:id/actions/:verb` call (src/components/detail/lib/mutations.ts → useItemAction), so this module is pure
 * labels and request bodies.
 *
 *   Done ▾   done by me      → done                      (key d)
 *            someone else    → resolve · done_by_other   (optionally who)
 *            not mine        → not-now · not_mine        (dismissed with the reason)
 *            not needed      → resolve · not_needed
 *   Later ▾  tomorrow        → snooze until tomorrow 09:00              (key l opens the menu)
 *            next week       → snooze until Monday 09:00
 *            pick a date     → snooze until that day 09:00
 *            not now         → not-now · later, until the next working day 09:00
 *
 * ⇧D opens Done ▾ (the old Resolve picker's place). Times are wall-clock in the profile zone (tz.ts).
 */
import type { ItemActionRequest } from '@/contract';
import { fromWall, wallParts } from '@/components/detail/lib/tz';

export type DoneChoice = 'by_me' | 'someone_else' | 'not_mine' | 'not_needed';
export type LaterChoice = 'tomorrow' | 'next_week' | 'pick' | 'not_now';
export type MenuVerb = 'done' | 'resolve' | 'snooze' | 'not-now';

export interface MenuRequest {
  verb: MenuVerb;
  body: Omit<ItemActionRequest, 'ifVersion'>;
}

export const DONE_CHOICES: ReadonlyArray<{ choice: DoneChoice; label: string; description: string; kbd?: string }> = [
  { choice: 'by_me', label: 'Done by me', description: 'I finished it', kbd: 'd' },
  { choice: 'someone_else', label: 'Done by someone else', description: 'Someone else took care of it' },
  { choice: 'not_mine', label: 'Not mine', description: 'It was never mine to do' },
  { choice: 'not_needed', label: 'Not needed', description: 'Nobody needs to do it any more' },
];

export const LATER_CHOICES: ReadonlyArray<{ choice: LaterChoice; label: string }> = [
  { choice: 'tomorrow', label: 'Tomorrow' },
  { choice: 'next_week', label: 'Next week' },
  { choice: 'pick', label: 'Pick a date' },
  { choice: 'not_now', label: 'Not now' },
];

/** The request a Done ▾ choice sends. `personName` names who did it (someone else). */
export function doneRequest(choice: DoneChoice, opts: { personName?: string } = {}): MenuRequest {
  switch (choice) {
    case 'by_me':
      return { verb: 'done', body: {} };
    case 'someone_else':
      return { verb: 'resolve', body: { resolution: 'done_by_other', ...(opts.personName ? { detail: { personName: opts.personName } } : {}) } };
    case 'not_mine':
      return { verb: 'not-now', body: { reason: 'not_mine' } };
    case 'not_needed':
      return { verb: 'resolve', body: { resolution: 'not_needed' } };
  }
}

const at9 = (y: number, m: number, d: number, tz?: string) => fromWall(y, m, d, 9, 0, tz).toISOString();

/** Tomorrow 09:00 in `tz`. */
export function tomorrowAt9(now: Date | string, tz?: string): string {
  const w = wallParts(now, tz);
  return at9(w.y, w.m, w.d + 1, tz);
}

/** Next week: the coming Monday 09:00 (a week on when today is Monday). */
export function nextMondayAt9(now: Date | string, tz?: string): string {
  const w = wallParts(now, tz);
  const toMonday = (8 - w.weekday) % 7 || 7;
  return at9(w.y, w.m, w.d + toMonday, tz);
}

/** The next working day (Mon–Fri) 09:00: Friday, Saturday and Sunday go to Monday. */
export function nextWorkingDayAt9(now: Date | string, tz?: string): string {
  const w = wallParts(now, tz);
  const ahead = w.weekday === 5 ? 3 : w.weekday === 6 ? 2 : 1;
  return at9(w.y, w.m, w.d + ahead, tz);
}

/** A picked day ("2026-11-24") at 09:00 in `tz`; null when it does not parse or is not after now. */
export function pickedDayAt9(day: string, now: Date | string, tz?: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const iso = at9(Number(m[1]), Number(m[2]), Number(m[3]), tz);
  return Date.parse(iso) > new Date(now).getTime() ? iso : null;
}

/** When each fixed Later ▾ choice wakes the item (the menu's descriptions). */
export function laterTargets(now: Date | string, tz?: string): Record<Exclude<LaterChoice, 'pick'>, string> {
  return { tomorrow: tomorrowAt9(now, tz), next_week: nextMondayAt9(now, tz), not_now: nextWorkingDayAt9(now, tz) };
}

/**
 * The request a Later ▾ choice sends. `pick` needs `picked` (an ISO time, see pickedDayAt9); without it there is
 * nothing to send (null).
 */
export function laterRequest(choice: LaterChoice, now: Date | string, tz?: string, picked?: string | null): MenuRequest | null {
  switch (choice) {
    case 'tomorrow':
      return { verb: 'snooze', body: { until: tomorrowAt9(now, tz) } };
    case 'next_week':
      return { verb: 'snooze', body: { until: nextMondayAt9(now, tz) } };
    case 'pick':
      return picked ? { verb: 'snooze', body: { until: picked } } : null;
    case 'not_now':
      return { verb: 'not-now', body: { reason: 'later', until: nextWorkingDayAt9(now, tz) } };
  }
}
