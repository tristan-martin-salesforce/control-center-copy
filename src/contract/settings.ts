/**
 * Settings sections and the per-user priority policy (R-UI-16).
 */
import { z } from 'zod';
import { AutonomyLevel, ChatModel, DispatchMode, Id, IsoDate, IsoDateTime, SaveModel, SourceKind, Version, WorkKind } from './common';
import { DEFAULT_FEEDBACK_SETTINGS, FeedbackSettings } from './feedback';
import { DEFAULT_GUIDE_SETTINGS, GuideSettings } from './guide';
import { DEFAULT_PERSONA_SETTINGS, PersonaSettings, PersonaSettingsPatch } from './persona';
import { DEFAULT_PRIORITY_SETTINGS, PrioritySettings } from './priority';

// ---------------------------------------------------------------------------
// Priority policy
// ---------------------------------------------------------------------------

/**
 * Named weights the priority engine multiplies against per-item features in [0,1]:
 * customer_facing (item touches a customer) · meeting_proximity (serves a meeting soon) ·
 * due_urgency (due soon / overdue) · manager_ask (asked by my manager) · deal_value (opp amount) ·
 * lead_time (long agent time + a meeting ahead: kick it off first) · age (old items rise slowly) ·
 * effort_fit (small items fit gaps).
 */
export const PolicyWeightKey = z.enum(['customer_facing', 'meeting_proximity', 'due_urgency', 'manager_ask', 'deal_value', 'lead_time', 'age', 'effort_fit']);
export type PolicyWeightKey = z.infer<typeof PolicyWeightKey>;

const Weight = z.number().min(0).max(10);
/** Every key is required (0 disables a factor). */
export const PolicyWeights = z.object({
  customer_facing: Weight,
  meeting_proximity: Weight,
  due_urgency: Weight,
  manager_ask: Weight,
  deal_value: Weight,
  lead_time: Weight,
  age: Weight,
  effort_fit: Weight,
});
export type PolicyWeights = z.infer<typeof PolicyWeights>;

/** A plain-language rule with a deterministic effect the engine (and the mock) can apply. */
export const PolicyRule = z.object({
  id: Id,
  text: z.string(), // "Customer-facing beats internal"
  enabled: z.boolean(),
  when: z.object({
    kinds: z.array(WorkKind).optional(),
    customerFacing: z.boolean().optional(),
    fromManager: z.boolean().optional(),
    sources: z.array(SourceKind).optional(),
    /** Only when due within this many hours. */
    dueWithinH: z.number().optional(),
  }),
  /** Score delta when the rule matches (negative demotes). */
  boost: z.number().min(-10).max(10),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PriorityPolicy = z.object({
  id: Id,
  version: Version,
  name: z.string(),
  role: z.enum(['se_ic', 'se_manager', 'ae', 'custom']),
  weights: PolicyWeights,
  rules: z.array(PolicyRule),
  updatedAt: IsoDateTime,
  note: z.string().nullable().default(null),
});
export type PriorityPolicy = z.infer<typeof PriorityPolicy>;

export const PolicyVersion = z.object({
  version: Version,
  at: IsoDateTime,
  by: z.enum(['user', 'chat', 'system']),
  note: z.string(),
  policy: PriorityPolicy,
});
export type PolicyVersion = z.infer<typeof PolicyVersion>;

export const RankRow = z.object({
  workItemId: Id,
  title: z.string(),
  rank: z.number().int(),
  score: z.number(),
  /** Positive = moved up vs the current ranking. */
  moved: z.number().int(),
  topReason: z.string().nullable(),
});
export type RankRow = z.infer<typeof RankRow>;

export const PolicyPreview = z.object({
  basedOnVersion: Version,
  before: z.array(RankRow), // current Top 10
  after: z.array(RankRow), // proposed Top 10
  changedCount: z.number().int(),
  summary: z.string(), // "3 items move; ACME prep takes #1"
});
export type PolicyPreview = z.infer<typeof PolicyPreview>;

export const PolicyVersionsPayload = z.object({ current: Version, versions: z.array(PolicyVersion) });
export type PolicyVersionsPayload = z.infer<typeof PolicyVersionsPayload>;

// ---------------------------------------------------------------------------
// Settings sections
// ---------------------------------------------------------------------------

export const ProfileSettings = z.object({
  version: Version,
  name: z.string(),
  email: z.string(),
  role: z.enum(['se_ic', 'se_manager']),
  timezone: z.string(), // IANA
  workingHours: z.object({ start: z.string(), end: z.string(), days: z.array(z.number().int().min(0).max(6)) }),
  managerName: z.string().nullable().default(null),
});
export type ProfileSettings = z.infer<typeof ProfileSettings>;

export const AgentBehaviorSettings = z.object({
  version: Version,
  voice: z.object({ samples: z.array(z.string()), style: z.string() }),
  autonomy: z.record(z.string(), AutonomyLevel), // per action type: "slack_reply", "email_reply", "canvas_rewrite", "tool_launch" …
  taskCapture: z.array(z.string()), // "what counts as a task" rules, plain language
  watchedSources: z.array(z.string()),
  drafting: z.object({ tone: z.enum(['crisp', 'warm', 'formal']), length: z.enum(['short', 'medium', 'long']), signoff: z.string() }),
});
export type AgentBehaviorSettings = z.infer<typeof AgentBehaviorSettings>;

/**
 * BE-OUTBOX: per-channel delivery mode (Settings → Sending). `draft` creates a native draft (Slack message
 * draft / Gmail draft); `send` posts or sends. It is the default for the composer's Draft ↔ Send toggle on
 * that channel; the mode the user confirms is what runs. Either way delivery happens only after the explicit
 * confirm in the Outbox, and only when global dry-run is off.
 */
export const SendingChannelKey = z.enum(['slack', 'gmail', 'vdp', 'slack_canvas']);
export type SendingChannelKey = z.infer<typeof SendingChannelKey>;
export const SendingChannel = z.object({ mode: DispatchMode });
export type SendingChannel = z.infer<typeof SendingChannel>;
/** The most autopilot writes per local day (D-60), by default. */
export const DEFAULT_VDP_AUTOPILOT_CAP = 40;
/**
 * VDP's row (D-60). VDP has no drafts: its mode is `send` (= Apply on one item), still behind dry-run and the Outbox's
 * approval gate. `autopilot` lets the app apply, by itself, only the items it can fix with known values (create the
 * company or the VDP, add an opp, the account id and fiscal period from Org62, strong assets, TA = me, Generate once
 * the inputs are filled): each is still an Outbox action, applied by the worker under the autonomy policy, with the
 * read-back, the History entry and the daily cap. Off for every new user and persona preset; turning it on needs
 * `confirm: true`.
 */
export const VdpSendingChannel = SendingChannel.extend({
  autopilot: z.boolean().default(false),
  dailyCap: z.number().int().min(1).max(500).default(DEFAULT_VDP_AUTOPILOT_CAP),
});
export type VdpSendingChannel = z.infer<typeof VdpSendingChannel>;
/** A logging canvas has no draft either: Apply creates it (private), behind dry-run and the confirm. */
export const DEFAULT_SENDING_CHANNELS: { slack: SendingChannel; gmail: SendingChannel; vdp: VdpSendingChannel; slack_canvas: SendingChannel } = { slack: { mode: 'draft' }, gmail: { mode: 'draft' }, vdp: { mode: 'send', autopilot: false, dailyCap: DEFAULT_VDP_AUTOPILOT_CAP }, slack_canvas: { mode: 'send' } };
export const SendingChannels = z.object({
  slack: SendingChannel.default(() => ({ ...DEFAULT_SENDING_CHANNELS.slack })),
  gmail: SendingChannel.default(() => ({ ...DEFAULT_SENDING_CHANNELS.gmail })),
  vdp: VdpSendingChannel.default(() => ({ ...DEFAULT_SENDING_CHANNELS.vdp })),
  slack_canvas: SendingChannel.default(() => ({ ...DEFAULT_SENDING_CHANNELS.slack_canvas })),
});
export type SendingChannels = z.infer<typeof SendingChannels>;

/**
 * VDP autopilot's trusted asset sites (D-60 amended 2026-11-21, SEC-6). Autopilot adds an asset link by itself only when
 * it is an https link whose host is one of these, or a subdomain of one (no port, no user:password@, no IP address);
 * any other link waits for your Apply with "Held for you: link is on <host>, not a trusted site". Lower-case host
 * names (IDN as punycode), never a scheme, path or wildcard.
 */
export const DEFAULT_AUTOPILOT_ASSET_HOSTS: readonly string[] = Object.freeze(['salesforce.com', 'force.com', 'my.salesforce.com', 'salesforce-sites.com', 'trailhead.com', 'sfdcstatic.com', 'drive.google.com', 'docs.google.com', 'slides.google.com']);
/** One trusted site: a DNS host name (letters, digits, hyphens, dots; the last label starts with a letter). */
export const AutopilotAssetHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'a site name such as docs.google.com');

export const SendingSettings = z.object({
  version: Version,
  defaultMode: DispatchMode,
  /** Global dry-run switch. Defaults ON; turning it off needs an explicit Save + confirm. */
  dryRun: z.boolean(),
  verifyReadback: z.boolean(),
  /** Kept at 60 s: the send waits on the open composer's timer (send-flow.ts); a longer hold is Draft mode. */
  undoWindowSec: z.number().int().min(0).max(60),
  /** BE-OUTBOX (additive): per-channel mode. Optional on input (older seeds and rows): both default to `draft`. */
  channels: SendingChannels.default(() => ({ slack: { ...DEFAULT_SENDING_CHANNELS.slack }, gmail: { ...DEFAULT_SENDING_CHANNELS.gmail }, vdp: { ...DEFAULT_SENDING_CHANNELS.vdp }, slack_canvas: { ...DEFAULT_SENDING_CHANNELS.slack_canvas } })),
  /**
   * SEC-6 (additive): the sites VDP autopilot adds asset links from by itself; anything else waits for your Apply. No
   * count limit (P25-11, no arbitrary caps): it is your list, and each name is checked on its own.
   */
  autopilotAssetHosts: z.array(AutopilotAssetHost).default(() => [...DEFAULT_AUTOPILOT_ASSET_HOSTS]),
});
export type SendingSettings = z.infer<typeof SendingSettings>;
/** Safe defaults: dry-run ON, message channels in `draft` (VDP: `send` = Apply, autopilot off), read-back on, 10 s undo window. */
export const DEFAULT_SENDING_SETTINGS: SendingSettings = {
  version: 1,
  defaultMode: 'draft',
  dryRun: true,
  verifyReadback: true,
  undoWindowSec: 10,
  channels: { slack: { mode: 'draft' }, gmail: { mode: 'draft' }, vdp: { mode: 'send', autopilot: false, dailyCap: DEFAULT_VDP_AUTOPILOT_CAP }, slack_canvas: { mode: 'send' } },
  autopilotAssetHosts: [...DEFAULT_AUTOPILOT_ASSET_HOSTS],
};
/**
 * PATCH /settings/sending body: any subset; `channels` may name one channel (the other keeps its mode). VDP's row takes
 * only `autopilot` and `dailyCap` (its mode is always send): `{ channels: { vdp: { autopilot: true } }, confirm: true }`.
 */
export const SendingSettingsPatch = SendingSettings.omit({ version: true, channels: true })
  .partial()
  .extend({
    channels: z
      .object({
        slack: SendingChannel.optional(),
        gmail: SendingChannel.optional(),
        vdp: z.object({ mode: DispatchMode.optional(), autopilot: z.boolean().optional(), dailyCap: z.number().int().min(1).max(500).optional() }).optional(),
      })
      .optional(),
  });
export type SendingSettingsPatch = z.infer<typeof SendingSettingsPatch>;

/**
 * A higher (or lower) limit for ONE local day: Settings ▸ Budgets ▸ "Today only". It applies while `day` is today in the
 * user's time zone and is ignored from midnight on, so the standing limits never need raising and lowering again.
 */
export const BudgetDayOverride = z.object({
  day: IsoDate,
  softUsd: z.number().min(0),
  hardUsd: z.number().min(0),
  /** The assistant's own day line; null keeps settings.chat.dailyUsd. */
  chatUsd: z.number().min(0).nullable().default(null),
  /** Why today's limits were raised (the latest raise's reason; every raise is kept in `BudgetSettings.raises`). */
  reason: z.string().max(200).default(''),
});
export type BudgetDayOverride = z.infer<typeof BudgetDayOverride>;

/**
 * One "Raise today's cap" (Health ▸ Spend, the capped banner, Settings ▸ Budgets): from → to, why, and when. Append
 * only and written by the server, so a costly day keeps its story ("raised $15 → $25: first AE forecast run").
 */
export const BudgetRaise = z.object({
  day: IsoDate,
  at: IsoDateTime,
  fromSoftUsd: z.number().min(0),
  toSoftUsd: z.number().min(0),
  fromHardUsd: z.number().min(0),
  toHardUsd: z.number().min(0),
  reason: z.string().min(1).max(200),
});
export type BudgetRaise = z.infer<typeof BudgetRaise>;
/** POST /budgets/raise-today: a higher hard cap for today (and optionally soft), with a reason. */
export const RaiseBudgetTodayRequest = z.object({
  hardUsd: z.number().positive().max(1000),
  /** Default: the soft budget moves up by as much as the hard cap does (never above it). */
  softUsd: z.number().min(0).max(1000).optional(),
  reason: z.string().trim().min(3, 'Say why (a few words)').max(200),
});
export type RaiseBudgetTodayRequest = z.infer<typeof RaiseBudgetTodayRequest>;
/** Raises kept (oldest drop first): about a year of the occasional raise. */
export const BUDGET_RAISES_KEPT = 200;

export const BudgetSettings = z.object({
  version: Version,
  softUsd: z.number().min(0),
  hardUsd: z.number().min(0),
  alertPct: z.number().min(0).max(100),
  /** Daily cap for automatic read-ins (BE-READIN, additive); the global hardUsd still applies. */
  readinUsdPerDay: z.number().min(0).default(2),
  /**
   * D6 (audit 2026-11-13): the most Slack triage may spend per day on the stronger model for unsure messages. Past it,
   * unsure messages go to Triage for you to decide (llm_decisions: escalation_day_cap); the hard cap still applies.
   */
  triageEscalationUsdPerDay: z.number().min(0).default(1),
  today: BudgetDayOverride.nullable().default(null),
  /** Every "Raise today's cap", newest last (server-written; PATCH ignores it). */
  raises: z.array(BudgetRaise).default([]),
});
export type BudgetSettings = z.infer<typeof BudgetSettings>;

/** The limits in force on `day` (YYYY-MM-DD, the user's local day): the "Today only" override when it is for that day. */
export function budgetsForDay<T extends { softUsd: number; hardUsd: number; today?: Pick<BudgetDayOverride, 'day' | 'softUsd' | 'hardUsd'> & { chatUsd?: number | null } | null }>(b: T, day: string): T & { overridden: boolean; chatUsd: number | null } {
  const t = b.today;
  if (t && t.day === day) return { ...b, softUsd: t.softUsd, hardUsd: t.hardUsd, chatUsd: (t.chatUsd as number | null | undefined) ?? null, overridden: true };
  return { ...b, chatUsd: null, overridden: false };
}

const fmtCap = (n: number) => '$' + n.toFixed(2).replace(/\.00$/, '');
/** The audit / History line for a raise: "Raised today's cap $15 → $25: first AE forecast run". */
export function raiseSummary(r: Pick<BudgetRaise, 'fromHardUsd' | 'toHardUsd' | 'reason'>): string {
  return `Raised today's cap ${fmtCap(r.fromHardUsd)} → ${fmtCap(r.toHardUsd)}: ${r.reason}`.slice(0, 200);
}

/**
 * "Raise today's cap": the next budgets section and the raise it records. Raise only: the new hard cap must be above
 * the one in force today (a lower day limit stays a Settings ▸ Budgets edit). Throws a user-facing message otherwise.
 * Shared by both DataSources so they agree.
 */
export function raiseBudgetToday(cur: BudgetSettings, req: RaiseBudgetTodayRequest, day: string, atIso: string): { next: BudgetSettings; raise: BudgetRaise } {
  const eff = budgetsForDay(cur, day);
  const reason = req.reason.trim();
  if (reason.length < 3) throw new Error('Say why you are raising the cap (a few words).');
  if (!(req.hardUsd > eff.hardUsd)) throw new Error(`Today's hard cap is already ${fmtCap(eff.hardUsd)}: raise it above that.`);
  const toSoft = req.softUsd ?? Math.min(req.hardUsd, eff.softUsd + (req.hardUsd - eff.hardUsd));
  if (toSoft > req.hardUsd) throw new Error("Today's soft budget can't be above today's hard cap.");
  const raise: BudgetRaise = { day, at: atIso, fromSoftUsd: eff.softUsd, toSoftUsd: toSoft, fromHardUsd: eff.hardUsd, toHardUsd: req.hardUsd, reason };
  const today: BudgetDayOverride = { day, softUsd: toSoft, hardUsd: req.hardUsd, chatUsd: cur.today && cur.today.day === day ? (cur.today.chatUsd ?? null) : null, reason };
  const raises = [...(cur.raises ?? []), raise].slice(-BUDGET_RAISES_KEPT);
  return { next: { ...cur, today, raises, version: cur.version + 1 }, raise };
}

/**
 * "Allow $N more today" (Find assets for all, the user's click): today's assistant line goes up by `addUsd`, and
 * today's hard cap with it when the hard cap would stop the extra spend first (`hardLeftUsd`: what is left under it).
 * Today only; recorded as a raise with its reason. Shared by both DataSources so they agree.
 */
export function allowAssistantToday(cur: BudgetSettings, o: { day: string; atIso: string; addUsd: number; lineUsd: number; assistantLeftUsd: number; hardLeftUsd: number; reason: string }): { next: BudgetSettings; raise: BudgetRaise } {
  if (!(o.addUsd > 0)) throw new Error('Say how much more to allow today.');
  const eff = budgetsForDay(cur, o.day);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const chatUsd = r2(o.lineUsd + o.addUsd);
  const hardMore = r2(Math.max(0, o.assistantLeftUsd + o.addUsd - o.hardLeftUsd));
  const toHard = r2(eff.hardUsd + hardMore);
  const toSoft = r2(Math.min(toHard, eff.softUsd + hardMore));
  const reason = `${o.reason.trim()} · assistant line ${fmtCap(o.lineUsd)} → ${fmtCap(chatUsd)}`.slice(0, 200);
  const raise: BudgetRaise = { day: o.day, at: o.atIso, fromSoftUsd: eff.softUsd, toSoftUsd: toSoft, fromHardUsd: eff.hardUsd, toHardUsd: toHard, reason };
  const today: BudgetDayOverride = { day: o.day, softUsd: toSoft, hardUsd: toHard, chatUsd, reason };
  const raises = [...(cur.raises ?? []), raise].slice(-BUDGET_RAISES_KEPT);
  return { next: { ...cur, today, raises, version: cur.version + 1 }, raise };
}

/** Color scheme (design v2: dark first). `system` follows the OS. */
export const DisplayScheme = z.enum(['dark', 'light', 'system']);
export type DisplayScheme = z.infer<typeof DisplayScheme>;
/** Root text size in px (design v2 §5: every token is rem, so the root sets the scale). */
export const DisplayTextSize = z.union([z.literal(15), z.literal(16), z.literal(18)]);
export type DisplayTextSize = z.infer<typeof DisplayTextSize>;
/** `<html data-text>` value for each text size (brief 14 §6.2: sm = 15 px, md = 16 px, lg = 18 px). */
export const DISPLAY_TEXT_ATTR: Record<DisplayTextSize, 'sm' | 'md' | 'lg'> = { 15: 'sm', 16: 'md', 18: 'lg' };

export const DisplaySettings = z.object({
  version: Version,
  density: z.enum(['compact', 'comfortable']),
  /**
   * v1 brand ramp (Lightning Blue or Cosmos). Design v2 has one theme, so nothing reads or offers it any
   * more; it stays so older stored values still parse.
   */
  theme: z.enum(['lightning', 'cosmos']).default('lightning'),
  shortcutsEnabled: z.boolean(),
  /** Additive (P-SETTINGS, design v2). Older rows without it read as dark. */
  scheme: DisplayScheme.default('dark'),
  /** Additive (P-SETTINGS, design v2). Older rows without it read as 16 px. */
  textSize: DisplayTextSize.default(16),
});
export type DisplaySettings = z.infer<typeof DisplaySettings>;

/** Chat (CONTRACT-1). `defaultModel` answers when a ChatRequest has no `model`. */
export const ChatSettings = z.object({
  version: Version,
  defaultModel: ChatModel,
  /** The assistant's own spend per day (USD), inside the global hard cap. */
  dailyUsd: z.number().min(0).max(100).default(3),
  /** Cost cap per message, by model (USD). A capped message offers a one-time "allow more". */
  messageUsd: z.object({ sonnet: z.number().min(0.01).max(10), opus: z.number().min(0.01).max(10), haiku: z.number().min(0.01).max(10).default(0.05) }).default({ sonnet: 0.25, opus: 0.6, haiku: 0.05 }),
  /**
   * Model steps (tool rounds) per message: a runaway guard only (Assistant v2, lane 05 §3a: cost bounds a turn, through
   * the governor's estimate → raise a hand → continue). Any positive whole number (caps audit F-1: no fixed ceiling;
   * the Assistant stops and asks when a message reaches it). A stored value is kept.
   */
  maxSteps: z.number().int().positive().default(200),
  /**
   * One deep research run (chat_research: live Slack, Gmail, Calendar, Drive, Org62): its own line per run (D-51), on
   * the assistant's day line, never taken from what is left of the message's cap (ASSIST-1, 2026-11-20).
   */
  researchUsd: z.number().min(0.05).max(5).default(0.5),
  /**
   * Assistant v2 (H-6): which model answers. `auto` routes each turn (src/llm/chat/router.ts: Haiku for lookups and
   * actions, Sonnet for drafts and explanations, Opus for research synthesis and multi-step plans); the others are
   * the owner's override ("Always Sonnet"). A message's own choice (the composer menu) still wins for that message.
   */
  routing: z.enum(['auto', 'haiku', 'sonnet', 'opus']).default('auto'),
});
export type ChatSettings = z.infer<typeof ChatSettings>;
export const DEFAULT_CHAT_SETTINGS: ChatSettings = { version: 1, defaultModel: 'sonnet', dailyUsd: 3, messageUsd: { sonnet: 0.25, opus: 0.6, haiku: 0.05 }, maxSteps: 200, researchUsd: 0.5, routing: 'auto' };

/**
 * Settings ▸ Time (onsite lane): onsite days and travel. Onsite hours are "HH:MM" in the trip's time zone; the
 * airport buffer is the time before a flight and after landing that counts as Travel.
 */
const HmSetting = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
/**
 * Settings ▸ Time ▸ Logging: how approved time reaches Org62. The app never writes Org62; it prepares a canvas that
 * Slackbot executes ("Execute this canvas"), and the Org62 check flags anything that didn't land.
 *  - `mode`: `on_demand` (default): a batch only when the user starts one (Time, or the Assistant); `automatic`: a
 *    batch every weekday at `autoAt`. The Org62 check runs in both modes.
 *  - `canvas`: `per_batch` (default): a new private canvas each batch; `shared`: rewrite one canvas (`sharedCanvasId`).
 *  - `approveComplete`: a batch also takes proposed rows that are complete (task type + WhatId) and approves them.
 *  - `org62RecordTypeId`: the Solutions Event record type; found in Org62 on the first batch and kept here.
 */
export const LoggingSettings = z.object({
  mode: z.enum(['on_demand', 'automatic']),
  canvas: z.enum(['per_batch', 'shared']),
  autoAt: HmSetting,
  approveComplete: z.boolean(),
  sharedCanvasId: z.string().regex(/^F[A-Z0-9]{6,}$/, 'a Slack canvas id starts with F').nullable(),
  org62RecordTypeId: z.string().regex(/^012[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/, 'a record type id starts with 012').nullable(),
  /** The Slackbot work-order canvas Time links to ("Work-order canvas ↗"); null hides the link. Per person: each teammate has their own. */
  workOrderCanvasUrl: z.string().trim().max(400).regex(/^https:\/\/\S+$/, 'a link starts with https://').nullable().default(null),
});
export type LoggingSettings = z.infer<typeof LoggingSettings>;
export const DEFAULT_LOGGING_SETTINGS: LoggingSettings = { mode: 'on_demand', canvas: 'per_batch', autoAt: '17:30', approveComplete: true, sharedCanvasId: null, org62RecordTypeId: null, workOrderCanvasUrl: null };

/**
 * Settings ▸ Time ▸ Overlapping meetings (D-18 amended 2026-11-11, the default for every persona and new user):
 *  - `log_all_accepted` (default): every accepted meeting logs, even double-booked (each row says what it overlaps),
 *    and an onsite day logs in full with the meetings during it. Day and week totals can exceed the wall clock.
 *  - `count_once`: overlapping time counts once: meetings win, a double-booked loser is excluded as an overlap, the
 *    onsite frame fills only the gaps between sessions.
 * Estimates (focused work, Slack, Claude hands-on) yield to meetings and onsite days either way.
 */
export const TimeOverlaps = z.enum(['log_all_accepted', 'count_once']);
export type TimeOverlaps = z.infer<typeof TimeOverlaps>;

/**
 * Settings ▸ Time ▸ AEs I cover (holistic review 2026-11-20, H-9): the AEs whose deals the attribution engine, Org62
 * discovery and DC suggestions include, each toggled on or off. Default: none.
 */
/** D-103 (a): an AE I support (`ae`), a teammate I cover while they are out (`ooo`), or a subject-matter assist (`sme`). */
export const CoverageKind = z.enum(['ae', 'ooo', 'sme']);
export type CoverageKind = z.infer<typeof CoverageKind>;
const IsoDateSetting = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-03');

export const CoveredAe = z.object({
  name: z.string().trim().min(2).max(120),
  org62UserId: z
    .string()
    .regex(/^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/, 'an Org62 user id starts with 005')
    .nullable()
    .optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  enabled: z.boolean().default(true),
  /**
   * D-103 (a): what the coverage is. `ae` (default): an AE I support; their deals are suggested as DCs without a touch
   * (unticked). `ooo`: covering for a teammate while they are out. `sme`: a subject-matter assist. `ooo` and `sme`
   * matches still need evidence of my work to be suggested.
   */
  kind: CoverageKind.optional(),
  /** When the coverage holds (ISO dates, `to` inclusive, open-ended without it). `ooo` and `sme` usually have one. */
  window: z.object({ from: IsoDateSetting, to: IsoDateSetting.optional() }).refine((w) => !w.to || w.to >= w.from, 'to must be on or after from').optional(),
  /** The default DC split for a deal matched through this row. Absent: 100 for `ae`, 50 for `ooo`, 25 for `sme`. */
  creditShare: z.union([z.literal(100), z.literal(50), z.literal(25)]).optional(),
  /** One line: "covering for <TA> OOO", "SME on Data Cloud call". */
  note: z.string().trim().max(120).optional(),
});
export type CoveredAe = z.infer<typeof CoveredAe>;

/** The default credit share of a coverage kind (D-103 (a)). */
export const COVERAGE_DEFAULT_SHARE: Readonly<Record<CoverageKind, 100 | 50 | 25>> = { ae: 100, ooo: 50, sme: 25 };

/** The products a DC counts for by default (today's D360 sweep words): Settings ▸ Time ▸ DC products changes them. */
export const DEFAULT_DC_PRODUCTS: readonly string[] = ['Data 360', 'Data Cloud', 'D360', 'Data Services', 'Private Connect', 'Marketing Data Bundle'];

export const TimeSettings = z.object({
  version: Version,
  detectOnsite: z.boolean(),
  onsiteHours: z.object({ start: HmSetting, end: HmSetting }).refine((h) => h.end > h.start, 'end must be after start'),
  /**
   * Legacy symmetric airport buffer (before 2026-11-14), still read: when the two sides below are absent, a value
   * other than the old default 60 applies to both (src/engines/activity/onsite.ts `airportBuffers`).
   */
  airportBufferMin: z.number().int().min(0).max(240),
  /**
   * Travel before a flight's departure, minutes. Absent: 120 (2026-11-14). The 360 (240 legacy) bounds are safety: each
   * buffer becomes Travel proposals split at midnight (propose.meetings.ts), so an unbounded one would propose days of travel.
   */
  airportBufferBeforeMin: z.number().int().min(0).max(360).optional(),
  /** Travel after a flight lands, minutes. Absent: 60. */
  airportBufferAfterMin: z.number().int().min(0).max(360).optional(),
  dinnersCustomerFacing: z.boolean(),
  logging: LoggingSettings.default(() => ({ ...DEFAULT_LOGGING_SETTINGS })),
  /** Optional on input (rows saved before D-18 was amended): every accepted meeting logs. */
  overlaps: TimeOverlaps.default('log_all_accepted'),
  /** AEs I cover (attribution, discovery and DC suggestions include their deals while toggled on). Absent: none. No count bound (owner reads go 200 ids a query; the team read is one IN list, see 26-caps-audit). */
  coveredAes: z.array(CoveredAe).optional(),
  /** Products a DC suggestion counts for (a product's or the opp's words; empty: every product; no count bound, matched locally). Absent: DEFAULT_DC_PRODUCTS. */
  dcProducts: z.array(z.string().trim().min(2).max(60)).optional(),
  /** A suggested DC's default split: 100% (`full`, default: a lower split keeps a use case off Org62) or its evidence share. */
  dcSplit: z.enum(['full', 'evidence']).optional(),
  /** How often the app looks in Org62 for deals it doesn't have yet (my teams, accounts I engaged, my covered AEs). Absent: daily. */
  discovery: z.enum(['daily', 'weekly', 'off']).optional(),
});
export type TimeSettings = z.infer<typeof TimeSettings>;

/** The attribution settings with their defaults (Settings ▸ Time). */
export function attributionSettingsOf(t: Partial<Pick<TimeSettings, 'coveredAes' | 'dcProducts' | 'dcSplit' | 'discovery'>> | null | undefined): { coveredAes: CoveredAe[]; dcProducts: string[]; dcSplit: 'full' | 'evidence'; discovery: 'daily' | 'weekly' | 'off' } {
  return { coveredAes: t?.coveredAes ?? [], dcProducts: t?.dcProducts ?? [...DEFAULT_DC_PRODUCTS], dcSplit: t?.dcSplit ?? 'full', discovery: t?.discovery ?? 'daily' };
}
export const DEFAULT_TIME_SETTINGS: TimeSettings = { version: 1, detectOnsite: true, onsiteHours: { start: '08:00', end: '17:00' }, airportBufferMin: 60, dinnersCustomerFacing: true, logging: { ...DEFAULT_LOGGING_SETTINGS }, overlaps: 'log_all_accepted' };

/**
 * Settings ▸ Scanning (SCAN-SET): what the scanner turns into work. The scanner reads `settings.scanning` on every run;
 * the cc tools enforce it, so a change applies from the next run.
 *  - `channelAsks`: an ask to a whole channel (@channel, @here) or a list of people. `ask` (default): it lands in
 *    Triage for me to decide; `mine`: like an ask of me; `ignore`: never an item.
 *  - `meetingCatchUps`: "Catch up: <meeting>" items for meetings I missed (Gemini notes, Calendar). Default off.
 *  - `oppTeamCatchUps`: "Get up to speed on <opp>" when I am added to an opp team. Default off.
 *  - `mappingQuestions`: "Where does this belong?" in Triage after the relinks fail: only for my asks and commitments
 *    (default), for anything unlinked, or never.
 */
/** Where VDP's cookie refresh script lives by default (it ships with the vdp-app repo's refresh-fir-mcp-cookie skill). */
export const DEFAULT_VDP_REFRESH_SCRIPT = '~/.claude/scripts/refresh_vdp_fir_cookie.py';
/** A .py file under your home (`~/…`) or an absolute path; plain path characters only (it is run, never spliced into a shell). */
export const VDP_REFRESH_SCRIPT_RE = /^(~\/|\/)[A-Za-z0-9._\/ -]+\.py$/;
/** An interpreter path or name (`python3`, `/usr/bin/python3`); empty = the first python3 on this Mac with Playwright. */
export const VDP_PYTHON_RE = /^(|[A-Za-z0-9._\/-]+)$/;

export const ScanningSettings = z.object({
  version: Version,
  channelAsks: z.enum(['ask', 'mine', 'ignore']).default('ask'),
  meetingCatchUps: z.boolean().default(false),
  oppTeamCatchUps: z.boolean().default(false),
  mappingQuestions: z.enum(['mine', 'all', 'never']).default('mine'),
  /** VDP re-auth (Settings ▸ Sources): the cookie refresh script Health's "Run refresh" runs. */
  vdpRefreshScript: z.string().trim().regex(VDP_REFRESH_SCRIPT_RE, 'A .py path that starts with ~/ or /').default(DEFAULT_VDP_REFRESH_SCRIPT),
  /** The Python that runs it (it needs Playwright). Empty: the first python3 on this Mac that has Playwright. */
  vdpPython: z.string().trim().regex(VDP_PYTHON_RE, 'A python path or name, like /usr/bin/python3').default(''),
});
export type ScanningSettings = z.infer<typeof ScanningSettings>;
export const DEFAULT_SCANNING_SETTINGS: ScanningSettings = { version: 1, channelAsks: 'ask', meetingCatchUps: false, oppTeamCatchUps: false, mappingQuestions: 'mine', vdpRefreshScript: DEFAULT_VDP_REFRESH_SCRIPT, vdpPython: '' };

/** The command Health shows (and Copy copies) for VDP's re-auth: the refresh script, opening a browser for MFA. */
export function vdpRefreshCommand(s: Pick<ScanningSettings, 'vdpRefreshScript' | 'vdpPython'> | null | undefined): string {
  const script = s?.vdpRefreshScript || DEFAULT_VDP_REFRESH_SCRIPT;
  return `${s?.vdpPython || 'python3'} ${/\s/.test(script) ? `"${script.replace(/^~\//, '$HOME/')}"` : script}`;
}


/**
 * Closing work (SETTLE-1): what the app may close for you after reading everything around an item. Configured by
 * *reason*, not by item kind: why it closed and who it involves say more about the risk than ask vs task.
 */
export const ClosingReason = z.enum(['done_by_you', 'resolved_by_other', 'moment_passed', 'not_yours', 'not_an_ask', 'duplicate', 'superseded', 'gone_quiet']);
export type ClosingReason = z.infer<typeof ClosingReason>;
/** close: closed for you (Auto-closed list, Undo) · ask: Triage asks you · leave: stays as it is. */
export const ClosingAction = z.enum(['close', 'ask', 'leave']);
export type ClosingAction = z.infer<typeof ClosingAction>;
/** Confidence the check needs before it acts; calibrated on the answer key (docs/archive/2026-build/FIRST-SCAN-RAMP.md §7). */
export const ClosingStrictness = z.enum(['cautious', 'balanced', 'eager']);
/** Which closer acts (ClosingSettings.resolutionEngine). */
export const ResolutionEngineMode = z.enum(['legacy', 'shadow', 'live']);
export type ResolutionEngineMode = z.infer<typeof ResolutionEngineMode>;
export type ClosingStrictness = z.infer<typeof ClosingStrictness>;

export const DEFAULT_CLOSING_REASONS: Record<ClosingReason, ClosingAction> = {
  done_by_you: 'close',
  resolved_by_other: 'close',
  moment_passed: 'close',
  not_yours: 'close',
  not_an_ask: 'close',
  duplicate: 'close',
  superseded: 'close',
  gone_quiet: 'close',
};

export const ClosingSettings = z.object({
  version: Version,
  /** Close finished work for me. Off: every verdict only asks (Looks done / Still needed?). */
  enabled: z.boolean().default(true),
  reasons: z
    .object(Object.fromEntries(ClosingReason.options.map((r) => [r, ClosingAction.default(DEFAULT_CLOSING_REASONS[r])])) as Record<ClosingReason, z.ZodDefault<typeof ClosingAction>>)
    .default({ ...DEFAULT_CLOSING_REASONS }),
  strictness: ClosingStrictness.default('balanced'),
  /** Always ask before closing a commitment to someone outside the company (a customer or partner). */
  askFirstExternalCommitments: z.boolean().default(true),
  /** Always ask before closing anything involving these people (names) or channels (#name). No count bound (matched locally). */
  askFirstPeople: z.array(z.string().trim().min(1).max(120)).default([]),
  askFirstChannels: z.array(z.string().trim().min(1).max(120)).default([]),
  /** Your rules, added to the check's instructions (the built-in instructions stay fixed). */
  rules: z.string().max(1000).default(''),
  /**
   * Reopen an item closed for you when someone writes again in its conversation addressing you (R2: read by the scanner's
   * DUP-1 check, which then links the chase as a `follow_up:` contradiction, and by Settle's selection of engine-closed items).
   */
  reopenOnFollowUp: z.boolean().default(true),
  /** An ask older than this when first found goes to Still needed? unless the check settles it (DEEP-1; read by the scanner stores). */
  oldAskDays: z.number().int().min(3).default(30),
  /** Use the stronger model for unclear cases, up to this much a day. */
  strongerModelForUnclear: z.boolean().default(true),
  strongerModelUsdPerDay: z.number().min(0).max(20).default(1),
  /** Home's "Closed N for you since you left" line. */
  tellMeWhatClosed: z.boolean().default(true),
  /**
   * The resolution check (src/engines/resolution), the one closer that replaces the completion pass and Settle's decision
   * (holistic review H-7, R8). `shadow` (1.x default): it runs and records to closure_checks while the legacy closers
   * still act, and Health compares them. `live`: it acts and the legacy completion pass and Settle's decision stop.
   * `legacy`: it does not run.
   */
  resolutionEngine: ResolutionEngineMode.default('shadow'),
});
export type ClosingSettings = z.infer<typeof ClosingSettings>;
export const DEFAULT_CLOSING_SETTINGS: ClosingSettings = ClosingSettings.parse({ version: 1 });


export const SettingsSectionKey = z.enum(['profile', 'agentBehavior', 'sending', 'budgets', 'display', 'chat', 'time', 'scanning', 'closing', 'persona', 'feedback', 'guide', 'priority']);
export type SettingsSectionKey = z.infer<typeof SettingsSectionKey>;

/** Save model per section (UI-SPEC §8). Policy is separate: preview → explicit Apply. */
export const SETTINGS_SAVE_MODEL: Record<SettingsSectionKey | 'policy', SaveModel> = {
  profile: 'explicit_save',
  agentBehavior: 'explicit_save',
  sending: 'explicit_save',
  budgets: 'explicit_save',
  display: 'instant',
  chat: 'instant',
  time: 'explicit_save',
  scanning: 'instant',
  closing: 'explicit_save',
  persona: 'explicit_save',
  feedback: 'explicit_save',
  guide: 'instant',
  priority: 'instant',
  policy: 'explicit_apply',
};

/**
 * D-90 (H-12): where compiled releases are published and announced. The Drive folder holds the builds and the
 * release feed (`manifest.json`); the worker's daily update check reads that feed through the devbar Drive read path,
 * and `npm run release -- <bump> --publish` stages the upload handoff and the announcement draft for this folder and
 * channel. Ids only (no links with credentials, no tokens). Empty here falls back to config/team.json
 * (`distributionDriveFolderId`, `distributionAnnounceChannel`), so a team sets it once.
 */
export const DistributionSettings = z.object({
  version: z.literal(1).default(1),
  /** The shared Google Drive folder's id (the part after /folders/ in its link). */
  driveFolderId: z.string().trim().regex(/^([A-Za-z0-9_-]{10,})?$/).default(''),
  /** The Slack channel id the release announcement is drafted to (C…/G…). */
  announceChannel: z.string().trim().regex(/^([CG][A-Z0-9]{8,})?$/).default(''),
  announceChannelName: z.string().trim().max(80).default(''),
  /** stable (default) or beta: which releases this install's update check offers. */
  channel: z.enum(['stable', 'beta']).default('stable'),
  /** The daily update check (a read of one small JSON file; nothing is downloaded or installed by it). */
  checkForUpdates: z.boolean().default(true),
});
export type DistributionSettings = z.infer<typeof DistributionSettings>;
export const DEFAULT_DISTRIBUTION_SETTINGS: DistributionSettings = { version: 1, driveFolderId: '', announceChannel: '', announceChannelName: '', channel: 'stable', checkForUpdates: true };

export const Settings = z.object({
  profile: ProfileSettings,
  policy: PriorityPolicy,
  agentBehavior: AgentBehaviorSettings,
  sending: SendingSettings,
  budgets: BudgetSettings,
  display: DisplaySettings,
  /** Optional on input (older seeds and rows): defaults to Sonnet. */
  chat: ChatSettings.default(() => ({ ...DEFAULT_CHAT_SETTINGS })),
  /** Optional on input (older seeds and rows): onsite detection on, 08:00–17:00, 60 min airport buffer, dinners CF. */
  time: TimeSettings.default(() => ({ ...DEFAULT_TIME_SETTINGS, onsiteHours: { ...DEFAULT_TIME_SETTINGS.onsiteHours } })),
  /** SCAN-SET (additive): optional on input; older seeds and rows read as the defaults. */
  scanning: ScanningSettings.default(() => ({ ...DEFAULT_SCANNING_SETTINGS })),
  /** Optional on input (older rows): the defaults. */
  closing: ClosingSettings.default(() => ({ ...DEFAULT_CLOSING_SETTINGS })),
  /** D-55: changes to the persona's preset. Optional on input: the SE persona, level from `profile.role`. */
  persona: PersonaSettings.default(() => structuredClone(DEFAULT_PERSONA_SETTINGS)),
  /** D-56: the feedback channel. Optional on input: from config/team.json. */
  feedback: FeedbackSettings.default(() => ({ ...DEFAULT_FEEDBACK_SETTINGS })),
  /** Guidance seen and dismissed. Optional on input: nothing seen yet. */
  guide: GuideSettings.default(() => structuredClone(DEFAULT_GUIDE_SETTINGS)),
  /** priority@2 (lane 07 R8): which engine ranks: v1, shadow (default: v2 beside v1, recorded), v2. Optional on input. */
  priority: PrioritySettings.default(() => ({ ...DEFAULT_PRIORITY_SETTINGS })),
  /** D-90: release distribution (Drive folder, announcement channel, update channel). Optional: absent = team defaults. */
  distribution: DistributionSettings.optional(),
});
export type Settings = z.infer<typeof Settings>;

/**
 * Data retention knobs (`settings.retention`, Settings ▸ Data). The rules live in src/db/retention/policy.ts; these are
 * the horizons the user may change. Stored under `user_settings` key `retention`; absent = these defaults.
 */
/**
 * The longest horizon a date can express (no product bound; was 10 years): the nightly cut-off is `now − days`, and an
 * ECMAScript Date reaches ±100,000,000 days from 1970, so a horizon past this would make the cut-off an invalid date.
 * "Keep everything" is `enabled: false`.
 */
export const RETENTION_DAYS_MAX = 100_000_000;
export const RetentionSettings = z.object({
  enabled: z.boolean().default(true),
  llmTextDays: z.number().int().min(1).max(RETENTION_DAYS_MAX).default(30),
  traceDays: z.number().int().min(1).max(RETENTION_DAYS_MAX).default(14),
  eventsDays: z.number().int().min(1).max(RETENTION_DAYS_MAX).default(30),
  orphanSourceDays: z.number().int().min(7).max(RETENTION_DAYS_MAX).default(90),
});
export type RetentionSettings = z.infer<typeof RetentionSettings>;

/** POST /retention/run: "Run retention now" (`dry`: the plan only, nothing changes). */
export const RunRetentionRequest = z.object({ dry: z.boolean().default(false) });
export type RunRetentionRequest = z.infer<typeof RunRetentionRequest>;
export const RetentionRunPayload = z.object({
  dry: z.boolean(),
  skipped: z.enum(['disabled', 'scan_active']).optional(),
  tables: z.array(z.object({ rule: z.string(), table: z.string(), action: z.string(), rows: z.number().int().nullable(), note: z.string().optional() })),
  bytesBefore: z.number(),
  bytesAfter: z.number(),
  estimatedReclaimBytes: z.number(),
  settings: RetentionSettings,
});
export type RetentionRunPayload = z.infer<typeof RetentionRunPayload>;

/** Partial patch schemas per section (used to validate PATCH /settings/:section bodies). */
export const SETTINGS_SECTION_SCHEMAS = {
  profile: ProfileSettings.omit({ version: true }).partial(),
  agentBehavior: AgentBehaviorSettings.omit({ version: true }).partial(),
  sending: SendingSettingsPatch,
  budgets: BudgetSettings.omit({ version: true, raises: true }).partial(),
  display: DisplaySettings.omit({ version: true }).partial(),
  chat: ChatSettings.omit({ version: true }).partial(),
  time: TimeSettings.omit({ version: true }).partial(),
  scanning: z
    .object({
      channelAsks: z.enum(['ask', 'mine', 'ignore']),
      meetingCatchUps: z.boolean(),
      oppTeamCatchUps: z.boolean(),
      mappingQuestions: z.enum(['mine', 'all', 'never']),
      vdpRefreshScript: z.string().trim().regex(VDP_REFRESH_SCRIPT_RE, 'A .py path that starts with ~/ or /'),
      vdpPython: z.string().trim().regex(VDP_PYTHON_RE, 'A python path or name, like /usr/bin/python3'),
    })
    .partial(),
  closing: ClosingSettings.omit({ version: true }).partial(),
  persona: PersonaSettingsPatch,
  feedback: FeedbackSettings.omit({ version: true }).partial(),
  guide: GuideSettings.omit({ version: true }).partial(),
  priority: PrioritySettings.omit({ version: true }).partial(),
} as const;
