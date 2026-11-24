/**
 * Time, read side (R7 step 3): the week, the ledger and a row's opportunity picker, over the same read source in both
 * DataSources (the week: docs/reviews/2026-11-20-holistic/19-read-twins.md). What only a store knows comes in as
 * `TimeWeekReads`.
 */
import { isSameDay } from 'date-fns';

import type { ActivityEntry, OnsiteDay, RouteInput, RouteOutput, TimelineLane, TimeWeek } from '@/contract';
import { personaTargetH, withPersonaTarget } from '@/engines/activity/persona';
import { canvasHolds, markCanvasHolds } from '@/lib/canvas/payload';
import { buildOppOptions } from '@/lib/opp-options';
import { personaOf } from '@/personas';
import { quarterTotal } from '@/server/datasource/db/quarter';
import { logCanvasesOf, type CanvasProgressSources } from '@/server/datasource/log-canvases';
import { buildTimeLedger } from '@/server/datasource/time-ledger';
import { inTimeWeek, timeWeekBounds, weekTotals } from '@/server/time/week';

import type { ReadSource } from './source';

/** GET /time/ledger. */
export function timeLedgerView(src: ReadSource, query: RouteInput<'getTimeLedger'>['query'], now: Date): RouteOutput<'getTimeLedger'> {
  const { timezone, workingHours } = src.settings().profile;
  return buildTimeLedger(src.all('activity'), query, { meta: withPersonaTarget(src.meta(), personaOf(src.settings())), now, tz: timezone, dayEnd: workingHours.end });
}

/** GET /time/opp-options: every opp ranked for the row (`entry`, already looked up), `today` as the user's local day. */
export function oppOptionsView(src: ReadSource, entry: ActivityEntry | null, today: string): RouteOutput<'getOppOptions'> {
  return buildOppOptions({
    entry,
    opps: src.all('opps'),
    accounts: src.all('accounts'),
    events: src.all('events'),
    people: src.all('people'),
    assets: src.all('assets'),
    runs: src.all('agentRuns'),
    workItems: src.all('workItems'),
    activity: src.all('activity'),
    today,
  });
}

/** What only the store knows for GET /time. */
export interface TimeWeekReads {
  /** The rows that need an opp, with their suggestions (src/lib/time-suggest.ts over the store's suggest context). */
  suggested: (entries: ActivityEntry[]) => ActivityEntry[];
  /** The week's onsite chips (first and last day inclusive), in day order: the db's stored overrides, the mock's chips. */
  onsite: (from: string, to: string) => OnsiteDay[];
  /** Each created canvas's progress sources; omitted, `progress` stays null (the db adds it after its own loads). */
  progress?: CanvasProgressSources;
}

const LANE_LABELS = { focus: 'Your focus work', claude: 'Agent time (Claude)', drive: 'Drive edits', slack: 'Slack bursts' } as const;

/** GET /time: one week (`week`, any day in it; else this week), in the profile timezone (TL-34), never the server's. */
export function timeWeekView(src: ReadSource, reads: TimeWeekReads, week: string | undefined, now: Date): TimeWeek {
  const profile = src.settings().profile;
  const wb = timeWeekBounds(week, now, profile.timezone);
  const inWeek = (iso: string) => inTimeWeek(wb, iso);
  const meta = src.meta();
  const entries = reads.suggested(markCanvasHolds(src.all('activity').filter((a) => inWeek(a.start)), canvasHolds(src.all('drafts')))).sort((a, b) => a.start.localeCompare(b.start));
  const lanes: TimelineLane[] = [
    {
      id: 'meetings',
      label: 'Meetings',
      blocks: src
        .all('events')
        // meetings I attend; tentative / unanswered invites are Today's (shown, not blocking), not logged time
        .filter((e) => inWeek(e.start) && e.attendance !== 'cancelled' && e.attendance !== 'declined' && e.myResponse !== 'tentative' && e.myResponse !== 'needs_action')
        .sort((a, b) => a.start.localeCompare(b.start))
        // activity sources point at the meeting by its calendar (external) id
        .map((e) => ({ id: e.id, start: e.start, end: e.end, label: e.title, activityId: entries.find((a) => a.sources.some((s) => s.externalId === (e.source.externalId ?? e.id)))?.id ?? null, hatched: false }))
        // travel and onsite frames sit with the meetings (onsite lane): time with the customer, never "focus"
        .concat(
          src
            .all('timeBlocks')
            .filter((b) => b.lane === 'meetings' && inWeek(b.start))
            .map(({ lane: _l, ...b }) => b),
        )
        .sort((a, b) => a.start.localeCompare(b.start)),
    },
  ];
  for (const lane of ['focus', 'claude', 'drive', 'slack'] as const) {
    lanes.push({
      id: lane,
      label: LANE_LABELS[lane],
      blocks: src
        .all('timeBlocks')
        .filter((b) => b.lane === lane && inWeek(b.start))
        .sort((a, b) => a.start.localeCompare(b.start))
        .map(({ lane: _l, ...b }) => ({ ...b, hatched: lane === 'claude' ? true : b.hatched })),
    });
  }
  // the quarter total counts this fiscal quarter's logged rows only (past quarters' rows stay on their weeks)
  const qt = quarterTotal(meta, src.all('activity'), now, profile.timezone, profile.workingHours.end);
  const readbacks = entries.filter((e) => e.status === 'logged' || e.status === 'verified').map((e) => e.updatedAt).sort();
  return {
    weekStart: wb.start,
    weekEnd: wb.end,
    timeline: lanes,
    entries,
    onsite: reads.onsite(wb.start, wb.end),
    // TL-45: the one status → count map (a legacy Event, one deleted in Org62, a row not in Org62 never count)
    totals: weekTotals(entries),
    quarter: { label: qt.q.label, loggedH: qt.loggedH, targetH: personaTargetH(personaOf(src.settings()), qt.q.targetH), due: qt.q.due },
    canvas: {
      lastSyncedAt: meta.canvas.lastSyncedAt,
      rowsChangedSince: entries.filter((e) => e.status === 'approved' && (!meta.canvas.lastSyncedAt || e.updatedAt > meta.canvas.lastSyncedAt)).length + meta.canvas.rowsChangedSince,
      confirmRequired: !meta.canvas.lastSyncedAt || !isSameDay(new Date(meta.canvas.lastSyncedAt), now),
      label: meta.canvas.label,
    },
    // a row read from Org62 is confirmed by definition: only rows written from here wait for the read-back
    org62: { lastReadbackAt: readbacks[readbacks.length - 1] ?? null, verified: entries.filter((e) => e.status === 'verified').length, pending: entries.filter((e) => ['approved', 'synced_to_canvas', 'logged'].includes(e.status) && !e.fromOrg62).length },
    // D-47 / D-52: the logging canvases waiting for Apply and the applied ones (receipts, the Confirm step)
    logCanvases: logCanvasesOf(src.all('drafts'), src.all('activity'), now, reads.progress),
  };
}
