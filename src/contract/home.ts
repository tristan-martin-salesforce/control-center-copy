/**
 * Home (design v2, "Morning paper"): the most important things across every tab and every day, on one
 * screen with no page scroll. GET /home composes it from the store with the pure engine in
 * src/engines/home (the mock and, later, the db DataSource share it).
 *
 *   masthead     one sentence for today + one for the days ahead, the date, since-you-left counts
 *   ribbon       today's working hours: meetings, declined ghosts, open blocks, the now line
 *   capacity     today-scoped, hands-on minutes only (agent time is a background lane)
 *   doNow        up to 3 lead cards, plus where the next ranks live ("#4 is in Reply & approve")
 *   sections     verb columns: reply · ahead · fix · chase · initiatives (rows capped server-side)
 *   aheadStrip   14 days of {count, risk}
 *   footer       "That's everything for today." + one quiet status line
 *
 * Color is an indicator, never identity: `state` is the one color signal a row may carry.
 */
import { z } from 'zod';
import { EntityType, Id, IsoDate, IsoDateTime, Minutes, Progress, SourceKind, Version } from './common';
import { NeedResolve } from './needs';
import { ReadInState } from './readin';
import { NowCard, TodayHeader } from './views';
import { MakeRoom } from './priority';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** The one color signal a card, row or block may carry (DESIGN-V2 principle 8). Null = neutral. */
export const HomeState = z.enum(['now', 'overdue', 'blocked', 'risk', 'ready', 'ai']);
export type HomeState = z.infer<typeof HomeState>;

/** What the Details panel opens for a card or row: `useRightPanel().openDetails({kind, id, label})`. */
export const HomeEntity = z.object({ kind: EntityType, id: Id, label: z.string().optional() });
export type HomeEntity = z.infer<typeof HomeEntity>;

/**
 * The verb behind a row's quiet action (and the filled button when selected). Every verb is an explicit
 * click; nothing here sends anything:
 * open_in_claude → POST /agents/launch (deep link only on that click) · review → the Outbox review link ·
 * send / draft → the item's composer · nudge → the nudge draft · reauth → POST /connectors/:id/reauth
 * (health flow) · confirm / map → the Time page · open → navigate to `href` or open Details.
 */
export const HomeAction = z.enum(['open_in_claude', 'review', 'send', 'draft', 'nudge', 'reauth', 'confirm', 'map', 'plan', 'open']);
export type HomeAction = z.infer<typeof HomeAction>;

export const HomeVerb = z.object({
  label: z.string(), // "Open in Claude", "Review 3", "Send draft", "Re-auth", "Do or drop"
  action: HomeAction,
  /** Where an explicit click lands when the verb navigates (Outbox, the item page, Time, Health…). */
  href: z.string().nullable().default(null),
  /** The entity the verb acts on: a work item (open_in_claude), a connector (reauth), a draft (nudge / send). */
  targetId: Id.nullable().default(null),
});
export type HomeVerb = z.infer<typeof HomeVerb>;

/** A text run. Sentences are arrays of segments so emphasis and state markers never live in markup. */
export const HomeSegment = z.object({
  text: z.string(),
  /** Bold: times, accounts, the day's anchors. Neutral color (accounts are never colored). */
  em: z.boolean().default(false),
  /** Optional state marker (blue now, amber risk, red overdue), at most one per sentence part. */
  mark: z.enum(['now', 'risk', 'overdue']).nullable().default(null),
});
export type HomeSegment = z.infer<typeof HomeSegment>;

/** A work item's id and version, so quiet actions (done, snooze) can send `ifVersion`. */
export const HomeItemRef = z.object({ id: Id, version: Version });
export type HomeItemRef = z.infer<typeof HomeItemRef>;

// ---------------------------------------------------------------------------
// Masthead
// ---------------------------------------------------------------------------

export const HomeMasthead = z.object({
  /** "Today turns on the 13:30 Acme review: smoke-test both demos by 08:35, approve 3 drafts, and …" */
  sentence: z.array(HomeSegment),
  date: IsoDateTime,
  /** IANA zone of the labels ("America/Denver") and its short name ("MT"). */
  timezone: z.string(),
  tzLabel: z.string(),
  since: z.object({ changed: z.number().int(), closed: z.number().int(), new: z.number().int(), show: z.boolean() }),
  /** "Tomorrow: Q4 log due 12:00, 18.5 of 60 h in. Thu 11/12: Globex QBR and …, both still need prep." */
  ahead: z.array(HomeSegment),
});
export type HomeMasthead = z.infer<typeof HomeMasthead>;

// ---------------------------------------------------------------------------
// Day ribbon
// ---------------------------------------------------------------------------

export const HomeBlockKind = z.enum(['meeting', 'work', 'agent', 'open', 'declined']);
export type HomeBlockKind = z.infer<typeof HomeBlockKind>;

export const HomeRibbonBlock = z.object({
  id: Id,
  kind: HomeBlockKind,
  start: IsoDateTime,
  end: IsoDateTime,
  /** Short label for the block ("Acme review"); `fullTitle` goes in the tooltip. */
  title: z.string(),
  fullTitle: z.string(),
  /** open: the pull-forward item a click opens · meeting: its prep item (a click opens the meeting, which links it). */
  itemId: Id.nullable().default(null),
  eventId: Id.nullable().default(null),
  /** now = happening now · risk = prep missing · null = neutral. */
  state: HomeState.nullable().default(null),
  /** "huddle with Sam", "prep", "Pull forward: Q4 log confirm ~30m" */
  note: z.string().nullable().default(null),
  /** A meeting an initiative is aiming at (★). */
  star: z.boolean().default(false),
});
export type HomeRibbonBlock = z.infer<typeof HomeRibbonBlock>;

export const HomeRibbon = z.object({
  /** The visible window: working hours, widened to the hour that holds the first meeting / now. */
  start: IsoDateTime,
  end: IsoDateTime,
  now: IsoDateTime,
  blocks: z.array(HomeRibbonBlock),
});
export type HomeRibbon = z.infer<typeof HomeRibbon>;

// ---------------------------------------------------------------------------
// Capacity: picked from TodayHeader.capacity (the CAPACITY engine), so Home and Today show the same numbers
// ---------------------------------------------------------------------------

export const HomeCapacity = TodayHeader.shape.capacity.pick({
  day: true,
  dayLabel: true,
  youMinToday: true,
  freeMin: true,
  openMin: true,
  fits: true,
  agentMinBackground: true,
  agentRunsBackground: true,
  pullForward: true,
});
export type HomeCapacity = z.infer<typeof HomeCapacity>;
export type HomePullForward = HomeCapacity['pullForward'][number];

// ---------------------------------------------------------------------------
// Do now
// ---------------------------------------------------------------------------

export const HomeDraftLine = z.object({
  draftId: Id,
  /** "Mia", "Dana", "#team-updates" */
  who: z.string(),
  source: SourceKind,
  /** Subject for email, first line for Slack. */
  text: z.string(),
  at: IsoDateTime,
  ready: z.boolean(),
});
export type HomeDraftLine = z.infer<typeof HomeDraftLine>;

export const HomeCard = z.object({
  /** 1-based position across every tab. */
  rank: z.number().int().min(1),
  kind: z.enum(['item', 'outbox']),
  id: Id,
  entity: HomeEntity,
  /** Neutral tag: the account, the initiative, or "Outbox". */
  tag: z.string().nullable(),
  title: z.string(),
  /** The extractor's (or the NBA's) sentence: the card's detail line under the ranking's two-part why. */
  why: z.string().nullable(),
  /** Lane 07 R7: why it matters, from the ranking's top value terms (who, deal, kind): "Brendan (customer) · opp $780k". */
  whyMatters: z.string().nullable().default(null),
  /** Lane 07 R7: why now, from its time terms (late, deadline, start-by, free time): "due Thu 09:30 · start by 13:00". */
  whyNow: z.string().nullable().default(null),
  state: HomeState.nullable(),
  /** "Start by 08:35", "Due 13:00" */
  stateLabel: z.string().nullable(),
  /** Violet AI marker text: "Drafted for you", "Draft ready". */
  aiLabel: z.string().nullable(),
  /** Readiness of the meeting this card preps ("Review prep · ✓ slides · ○ smoke test"). */
  prep: z.object({ label: z.string(), steps: z.array(z.object({ label: z.string(), done: z.boolean() })) }).nullable(),
  /** One muted context line ("Initiative: Globex expansion sizing"). */
  context: z.string().nullable(),
  /** The first three drafts (display); `draftIds` holds the whole queue. */
  drafts: z.array(HomeDraftLine),
  /**
   * The Outbox card's approval queue: every ready draft, in the Outbox's pending-approval order (most recently
   * updated first), so the panel can step through all of them. `drafts` is its first three. Empty on item cards.
   */
  draftIds: z.array(Id).default([]),
  youMin: Minutes,
  agentMin: Minutes,
  due: IsoDateTime.nullable(),
  /** Muted footer text ("Due 17:00 · you ~50m", "Nothing sends until you approve"). */
  foot: z.string().nullable(),
  /**
   * Planning the next day (`?day=next`): why this card is on a day it wasn't due. `from_today`: today's work still
   * open, carried over · `moved`: you moved it here ("Move to Thu", a snooze that wakes that day). Null otherwise.
   */
  carried: z.enum(['from_today', 'moved']).nullable().default(null),
  verb: HomeVerb,
  /** Item cards reuse the Today NOW card (item + NBA + draft + run + proposals). Null for the Outbox card. */
  now: NowCard.nullable(),
  /** The item's read-in (BE-READIN, `WorkItemRecord.readInState`); the TL;DR lives in Details. */
  readInState: ReadInState.optional(),
});
export type HomeCard = z.infer<typeof HomeCard>;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const HomeSectionId = z.enum(['reply', 'ahead', 'fix', 'chase', 'initiatives']);
export type HomeSectionId = z.infer<typeof HomeSectionId>;

export const HomeRowKind = z.enum(['item', 'draft', 'gap', 'promise', 'waiting', 'event', 'initiative']);
export type HomeRowKind = z.infer<typeof HomeRowKind>;

export const HomeRow = z.object({
  id: Id,
  kind: HomeRowKind,
  title: z.string(),
  /** ONE muted line. */
  why: z.string(),
  state: HomeState.nullable(),
  /** The badge word that pairs with the color ("Blocked", "Expired 10/26", "Not started", "114 d"). */
  stateLabel: z.string().nullable(),
  due: IsoDateTime.nullable(),
  youMin: Minutes.nullable(),
  verb: HomeVerb,
  /** Full page for the row (See all / ⇧Enter). */
  href: z.string(),
  entity: HomeEntity,
  /** Work-item rows: id + version for done / snooze. Null for gaps, events, folded rows. */
  item: HomeItemRef.nullable().default(null),
  /** A progress meter (the quarter log row). */
  progress: Progress.nullable().default(null),
  /** Initiative rows: hot · at_risk · drifting · paused. */
  heat: z.enum(['hot', 'at_risk', 'drifting', 'paused']).nullable().default(null),
  /** Right-aligned short date for compact rows ("13:30", "11/12", "no date", "69 d"). */
  dateLabel: z.string().nullable().default(null),
  /** The item's read-in state: "✦ Read-in ready" is the row's one color signal only when `state` is null. */
  readInState: ReadInState.optional(),
  /** Log & fix rows: how the row can be set aside (Not now until a date, or Not needed with a reason). */
  resolve: NeedResolve.nullable().default(null),
});
export type HomeRow = z.infer<typeof HomeRow>;

export const HomeSection = z.object({
  id: HomeSectionId,
  title: z.string(), // "Reply & approve"
  /** Everything in the section, not just the rows shown. */
  count: z.number().int().min(0),
  /** Muted header note ("next 14 days"). */
  sub: z.string().nullable().default(null),
  /** Capped server-side: 3, or 5 with ?wide=1. */
  rows: z.array(HomeRow),
  seeAllHref: z.string(),
  seeAllLabel: z.string(), // "See all 4 in Outbox"
  /** Section-header batch action ("Approve 3 ready"). */
  batch: z.object({ label: z.string(), href: z.string() }).nullable().default(null),
  /** Calm copy for an empty section. */
  empty: z.string(),
});
export type HomeSection = z.infer<typeof HomeSection>;

// ---------------------------------------------------------------------------
// Ahead strip and footer
// ---------------------------------------------------------------------------

export const HomeAheadDay = z.object({
  date: IsoDate,
  /** Things to think about that day (dated items, meetings with prep, closes). */
  count: z.number().int().min(0),
  /** How many of them are at risk or overdue. */
  risk: z.number().int().min(0),
  weekend: z.boolean(),
  /** The heaviest day in the window (bold label). */
  big: z.boolean(),
  /** Tooltip: "Thu 11/12: Globex QBR (at risk) · Initech workshop". */
  summary: z.string(),
});
export type HomeAheadDay = z.infer<typeof HomeAheadDay>;

export const HomeFooter = z.object({
  sources: z.object({ live: z.number().int(), total: z.number().int() }),
  /** Only the broken parts ("VDP needs re-auth"); empty = quiet. */
  alerts: z.array(z.object({ id: Id, label: z.string(), href: z.string() })),
  spend: z.object({ usd: z.number(), budgetUsd: z.number() }),
  dryRun: z.boolean(),
  briefs: z.object({ count: z.number().int(), href: z.string() }),
  agentRuns: z.object({ count: z.number().int(), href: z.string() }),
  /** Folded Chase line for the panel-open layout ("Chase 9: Dana, Lee, +7"). */
  chase: z.object({ count: z.number().int(), names: z.array(z.string()), href: z.string() }),
});
export type HomeFooter = z.infer<typeof HomeFooter>;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Which day Home shows. `today` (the default) · `next`: the next working day (Friday → Monday), planned ahead: that
 * day's meetings, its capacity, what is due or starts then, today's open work carried over and anything moved there.
 * Home never switches by itself; late in the day it suggests planning (`HomeNextDay.nudge`).
 */
export const HomeDay = z.enum(['today', 'next']);
export type HomeDay = z.infer<typeof HomeDay>;

/** A day Home names: "Tomorrow" (or "Monday") · "Thu 11/12" · when its working hours start. */
export const HomeDayRef = z.object({
  date: IsoDate,
  /** "Tomorrow" when it is the next calendar day, else the weekday ("Monday"). */
  label: z.string(),
  /** "Thu 11/12" */
  short: z.string(),
  /** Its working-hours start (UTC instant). */
  startsAt: IsoDateTime,
});
export type HomeDayRef = z.infer<typeof HomeDayRef>;

export const HomeNextDay = HomeDayRef.extend({
  /** Late in the working day (from an hour before it ends), after it, or on a day off: suggest planning it. */
  nudge: z.boolean(),
});
export type HomeNextDay = z.infer<typeof HomeNextDay>;

export const HomeQuery = z.object({
  /** 1 = the ≥ 2,400 px layout: 5 rows per section and the Initiatives column. */
  wide: z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  day: HomeDay.optional(),
});
export type HomeQuery = z.infer<typeof HomeQuery>;

/**
 * LD-1: work the engine thinks is finished (`likely_done`), kept out of Do now and the sections and gathered into one
 * small "Looks done: confirm" group: the badge word, one evidence line, and one-click Confirm or Not done.
 */
export const HomeLooksDoneRow = z.object({
  id: Id,
  title: z.string(),
  /** One muted line: what made it look done ("You replied 'Yep here you go!'", "Resolved by PERSON: …"). */
  evidence: z.string(),
  href: z.string(),
  item: HomeItemRef,
});
export type HomeLooksDoneRow = z.infer<typeof HomeLooksDoneRow>;

export const HomeLooksDone = z.object({ count: z.number().int().min(0), rows: z.array(HomeLooksDoneRow) });
export type HomeLooksDone = z.infer<typeof HomeLooksDone>;

/**
 * SETTLE-1: "Closed 12 for you since you left · Review", one quiet line by Do now. Engine closes since you left
 * (`cc.meta.lastActiveAt`); null when Settings ▸ Closing work ▸ "Tell me what closed" is off or nothing closed.
 */
export const HomeClosedForYou = z.object({ count: z.number().int().min(1), since: IsoDateTime, href: z.string() });
export type HomeClosedForYou = z.infer<typeof HomeClosedForYou>;

// ---------------------------------------------------------------------------
// The briefing (phase 3, 01 R2/R3, 07 R6): Respond chips, Coming builds, the Admin row, "what to move", closed now
// ---------------------------------------------------------------------------

/**
 * A reply the app drafted or can draft, as one chip ("Reply to Dana · Send", "Draft ready", "Retry"). A chip only
 * opens: the Outbox row (a draft, with its own preview, confirm and undo window) or the item (to draft it). Nothing
 * sends from Home.
 */
export const HomeRespondChip = z.object({
  id: Id,
  kind: z.enum(['draft', 'reply']),
  /** "Dana", "#team-updates" */
  who: z.string(),
  /** Email subject, a Slack line or the item title (the tooltip). */
  text: z.string(),
  /** ready: waiting for your approval · failed: the send failed (Retry) · drafting: being written · can_draft: no draft yet. */
  state: z.enum(['ready', 'failed', 'drafting', 'can_draft']),
  /** The chip's verb word: "Send" (a ready draft), "Retry", "Drafting", "Draft". */
  verb: z.string(),
  /** Where the click lands: `/outbox?draft=<id>` or the item page. */
  href: z.string(),
  entity: HomeEntity,
});
export type HomeRespondChip = z.infer<typeof HomeRespondChip>;

export const HomeRespond = z.object({
  /** Everything the strip stands for (drafts waiting or failed, replies to write), not just the chips shown. */
  count: z.number().int().min(0),
  ready: z.number().int().min(0),
  failed: z.number().int().min(0),
  chips: z.array(HomeRespondChip),
  /** "Review N" (the Outbox); null when no draft waits. */
  review: z.object({ label: z.string(), href: z.string() }).nullable(),
});
export type HomeRespond = z.infer<typeof HomeRespond>;

/** An agent run in flight (a demo-org build, a dataset), one row each: its ETA and "Open in Claude". */
export const HomeBuild = z.object({
  id: Id,
  title: z.string(),
  state: z.enum(['queued', 'running', 'waiting_on_you']),
  /** "ETA 10:40", "Needs your answer", "Queued". */
  etaLabel: z.string(),
  eta: IsoDateTime.nullable(),
  /** "2 of 6 · Loading profiles" (null without progress). */
  progressLabel: z.string().nullable(),
  workItemId: Id.nullable(),
  /** The session's claude:// link; opened only on an explicit click. */
  deepLink: z.string().nullable(),
});
export type HomeBuild = z.infer<typeof HomeBuild>;

/**
 * Admin as one quiet row (07 R6): "Admin: 4 items · ~25m · next due Fri 16:00", expanding to its items. `batch` with
 * priority@2 shown (its batch math: promoted, minutes, next due); `rule` with priority@1.1 (the persona's admin rules
 * list the items, no batch math).
 */
export const HomeAdmin = z.object({
  mode: z.enum(['batch', 'rule']),
  label: z.string(),
  count: z.number().int().min(1),
  /** Today's load (due within the persona's window, late, or must start today). Batch mode only. */
  promoted: z.boolean(),
  rows: z.array(z.object({ id: Id, title: z.string(), kind: z.string(), dueLabel: z.string().nullable(), href: z.string(), item: HomeItemRef })),
  href: z.string(),
});
export type HomeAdmin = z.infer<typeof HomeAdmin>;

/**
 * Overbooked → what to move (07 §4.2): the briefing sentence names the first makeRoom row ("Move the Umbrella deck to
 * Monday to fit") and "Move it" runs the existing snooze verb to `to.startsAt` (audited, Undo). `item` null: nothing
 * can move (everything left is pinned or due today), and the sentence says so.
 */
export const HomeMoveIt = z.object({
  label: z.string(),
  sentence: z.string(),
  item: HomeItemRef.nullable(),
  title: z.string().nullable(),
  to: HomeDayRef.nullable(),
  /** Minutes moving it frees, and whether that covers the overflow. */
  freesMin: z.number().int().min(0),
  covers: z.boolean(),
});
export type HomeMoveIt = z.infer<typeof HomeMoveIt>;

/** Closed for you in the last few hours: a card that leaves this way stays in place with its tag and Undo. */
export const HomeClosedNow = z.object({ id: Id, title: z.string(), badge: z.string(), why: z.string(), version: Version });
export type HomeClosedNow = z.infer<typeof HomeClosedNow>;

export const HomePayload = z.object({
  now: IsoDateTime,
  wide: z.boolean(),
  /** The day shown: today, or the next working day being planned (`?day=next`). */
  day: HomeDay.default('today'),
  /** The next working day after today: the toggle's label, and the late-day nudge. Null: no working days set. */
  nextDay: HomeNextDay.nullable().default(null),
  /**
   * Where Home's "Move to …" (the quiet snooze, `s`) sends an item: the working-day start after the day shown, so a
   * moved item shows up when you plan that day. Null: the client's fallback (tomorrow 08:00).
   */
  moveTo: HomeDayRef.nullable().default(null),
  masthead: HomeMasthead,
  ribbon: HomeRibbon,
  capacity: HomeCapacity,
  doNow: z.object({
    /** Everything that needs you today across every tab ("Top 3 of 5"). */
    total: z.number().int().min(0),
    cards: z.array(HomeCard).max(3),
    /** Where ranks 4 and 5 live: [{rank: 4, section: 'reply'}, …]. */
    elsewhere: z.array(z.object({ rank: z.number().int(), section: HomeSectionId, label: z.string() })),
    /** "#4 is in Reply & approve, #5 in Log & fix." (empty when nothing is elsewhere) */
    elsewhereNote: z.string(),
  }),
  sections: z.array(HomeSection),
  /** LD-1: likely-done work to confirm (never in Do now or the sections). */
  looksDone: HomeLooksDone.default({ count: 0, rows: [] }),
  /** SETTLE-1: what closed for you since you left (null: off, or nothing). */
  closedForYou: HomeClosedForYou.nullable().default(null),
  aheadStrip: z.array(HomeAheadDay).length(14),
  footer: HomeFooter,
  /**
   * priority@2 capacity honesty: when today is overbooked, what to move (lowest value × latest deadline first) and the
   * one wording ("Overbooked by 45 min"). Null when the day fits. Data only: the Home briefing chunk draws the card.
   */
  makeRoom: MakeRoom.nullable().default(null),
  /** The briefing (phase 3): drafts and replies as chips. */
  respond: HomeRespond.default({ count: 0, ready: 0, failed: 0, chips: [], review: null }),
  /** Agent runs in flight (empty: the row is collapsed). */
  builds: z.array(HomeBuild).default([]),
  /** Admin as one quiet row (null: no admin open). */
  admin: HomeAdmin.nullable().default(null),
  /** Overbooked: what to move, drawn in the briefing (null: the day fits). */
  moveIt: HomeMoveIt.nullable().default(null),
  /** Closed for you in the last few hours (the in-place tag on a card that just left). */
  closedNow: z.array(HomeClosedNow).default([]),
  /** What the app is watching (the empty-day line): source names, e.g. ["Slack", "Gmail", "Calendar"]. */
  watching: z.array(z.string()).default([]),
});
export type HomePayload = z.infer<typeof HomePayload>;
