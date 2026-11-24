/**
 * The Time page for one week: time blocks (meetings, hands-on and agent Claude time, Drive edits, Slack bursts) and
 * activity entries (the engine's proposals plus what Org62 already has), from the week's projected rows. Pure.
 *
 *  1. Evidence → `proposeActivity` (src/engines/activity): blocks with overlap resolution (tenet: Hours are human
 *     hours: meetings win, agent time counts only as the engaged-time model's share), meeting classification, solo
 *     work as engaged time from my own actions (prompts, Slack and email sent, Drive edits; engaged.ts). No caps.
 *     Never hands-off here: approval stays the user's (tenet: Nothing leaves without approval).
 *  2. Read-back (`verifyReadback`): an Org62 Event that matches a row the user approved moves that row to logged /
 *     verified / verify_failed. An Org62 Event that matches a proposal replaces it (the proposal is "already in
 *     Org62"); every other Org62 Event of the week is its own `logged` row. So SE activity already in Org62 shows as
 *     logged, once.
 *  3. Overlaps between rows, by `cfg.overlaps` (D-18 amended). `count_once`: counted rows never overlap: rows the user
 *     owns first, then Org62's, then meetings, then evidence guesses; a later row that would overlap is excluded as
 *     `overlap`, with the reason. `log_all_accepted` (default): the same, except that an accepted meeting and an onsite
 *     frame log even where they overlap other rows (an accepted meeting always logs; an onsite day logs in full); only
 *     a twin (the same row, or an Org62 Event of the same slot) stands in for them. Estimates still yield to them.
 *     The database's exclusion constraint covers non-calendar rows only (migration 0013).
 *  4. D-64: internal-only work (the engine's `internal` rows) has no WhatId, CF / CR off and its internal type. A row
 *     whose source a "Dismiss all from …" rule covers (`dismissRules`: one repo, unmapped Drive docs, a recurring
 *     series) is written `dismissed` with the rule's flag, and never takes time from a row that logs. A meeting I
 *     declined has no row: a row the projection owns simply goes; one I own goes too (`declined`: remove), unless it is
 *     handed off (on a canvas, or in Org62) or waits in a canvas item, which is flagged and never deleted from Org62.
 *  5. D-66: every row the app proposes carries its Org62 Description note (`logNote`): the cheap model's over the
 *     meeting's notes where `activity.notes` made one, else the template over the row's own evidence (the meeting's
 *     title and attendee domains, the sessions, docs and channels, the opp's VDP use case, the notes' next step).
 */
import { localDay } from './util';
export { ENGINE_VERSION, OWNED_ACTIVITY_PREFIXES, ENGINE_STATUSES, sessionInWindow } from './activity.model';
export type {
  WeekEvent, WeekSession, WeekEmail, WeekDriveEdit, WeekOrg62Event, FixedEntry, DesiredEntry, DeclinedMove,
  ReviveMove, ReadbackMove, RekeyMove, CoverMove, FlagMove, DesiredBlock, WeekInput, WeekPlan,
} from './activity.model';
export { calKeyOf, noteFactsOf } from './activity.moves';
export { slackActions, slackBursts, toEvidence, planWeek } from './activity.plan';

/** The local days [Mon, Sun] of the week containing `iso` in `tz`. */
export function weekOf(iso: string, tz: string): { start: string; end: string } {
  const day = localDay(iso, tz);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  const mon = new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
  const sun = new Date(t + (6 - dow) * 86_400_000).toISOString().slice(0, 10);
  return { start: mon, end: sun };
}
