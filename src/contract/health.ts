/**
 * Health: connectors (state, cursor, re-auth), scan ledger, jobs, event log, spend (R-UI-12, R-BE-3).
 */
import { z } from 'zod';
import { SpendAsk } from './spend';
import { ConnectorState, Id, IsoDate, IsoDateTime, ReauthKind, SourceKind } from './common';
import { PriorityHealth } from './priority';

export const ReauthAffordance = z.object({
  kind: ReauthKind,
  label: z.string(), // "Re-auth Slack", "Reconnect Google", "Connect Zscaler"
  /** For terminal_command / refresh_script: the exact command (never contains secrets). */
  command: z.string().nullable().default(null),
  instructions: z.string().nullable().default(null),
});
export type ReauthAffordance = z.infer<typeof ReauthAffordance>;

export const Connector = z.object({
  id: Id, // "slack", "gmail", "calendar", "drive", "gemini", "org62", "vdp", "claude"
  label: z.string(),
  source: SourceKind,
  state: ConnectorState,
  since: IsoDateTime,
  lastSuccessAt: IsoDateTime.nullable(),
  /** "Slack through 10:41" */
  cursor: z.object({ label: z.string(), at: IsoDateTime.nullable() }),
  backlog: z.number().int().default(0),
  itemsToday: z.number().int().default(0),
  /** 0–100 while catching_up (header "Catching up: Slack 60%"). */
  catchUpPct: z.number().min(0).max(100).nullable().default(null),
  lastError: z
    .object({ class: z.enum(['auth', 'transient', 'rate_limited', 'bug', 'offline']), message: z.string(), at: IsoDateTime, count: z.number().int() })
    .nullable()
    .default(null),
  /** What today's data is affected, for banners ("Email items after 09:40 may be missing"). */
  impact: z.string().nullable().default(null),
  reauth: ReauthAffordance.nullable().default(null),
  /** Panels/topics whose items get StaleMarks when this connector breaks. */
  affects: z.array(z.string()).default([]),
  /**
   * Signal-driven cadence (review 04 §4.1 #6): when the source is checked next (its earliest unpaused scope) and in how
   * many whole minutes ("next check in N min"). Data only; null or absent when nothing is planned (worker down, paused).
   */
  nextCheckAt: IsoDateTime.nullable().optional(),
  nextCheckInMin: z.number().int().min(0).nullable().optional(),
});
export type Connector = z.infer<typeof Connector>;

export const ScanRunStatus = z.enum(['queued', 'running', 'ok', 'partial', 'auth_failed', 'transient_failed', 'budget_exceeded', 'aborted']);
export type ScanRunStatus = z.infer<typeof ScanRunStatus>;

export const ScanRun = z.object({
  id: Id,
  connectorId: Id,
  scope: z.string(), // "dms_to_me", "#acme-ext", "inbox"
  kind: z.enum(['poll', 'head', 'backfill', 'reconcile', 'manual']),
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  status: ScanRunStatus,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  itemsSeen: z.number().int(),
  itemsNew: z.number().int(),
  itemsChanged: z.number().int(),
  costUsd: z.number(),
  model: z.string().nullable(),
  error: z.string().nullable().default(null),
});
export type ScanRun = z.infer<typeof ScanRun>;

export const JobStatus = z.enum(['queued', 'running', 'retrying', 'succeeded', 'dead', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: Id,
  type: z.string(), // "reevaluate", "scan.slack", "nba.generate", "brief.generate"
  status: JobStatus,
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  runAt: IsoDateTime,
  startedAt: IsoDateTime.nullable().default(null),
  finishedAt: IsoDateTime.nullable().default(null),
  dedupeKey: z.string().nullable().default(null),
  generation: z.number().int().nullable().default(null),
  entity: z.object({ type: z.string(), id: Id, label: z.string() }).nullable().default(null),
  error: z.string().nullable().default(null),
});
export type Job = z.infer<typeof Job>;

export const EventLogEntry = z.object({
  id: Id,
  at: IsoDateTime,
  level: z.enum(['info', 'warn', 'error']),
  source: z.string(), // connector id, "worker", "nba", …
  code: z.string(), // "auth_needed", "job_dead_lettered", "parse_drift"
  message: z.string(),
  count: z.number().int().default(1),
  lastSeenAt: IsoDateTime,
  suggestedAction: z.string().nullable().default(null),
  acknowledged: z.boolean().default(false),
  acknowledgedAt: IsoDateTime.nullable().default(null),
});
export type EventLogEntry = z.infer<typeof EventLogEntry>;

export const SpendSummary = z.object({
  today: z.object({
    usd: z.number(),
    softBudgetUsd: z.number(),
    hardCapUsd: z.number(),
    pct: z.number(), // of soft budget
  }),
  /** ok < 80% · soft_alert ≥ 80% (header chip) · capped ≥ hard cap (banner; scanners deterministic-only). */
  state: z.enum(['ok', 'soft_alert', 'capped']),
  last7d: z.array(z.object({ day: IsoDate, usd: z.number() })),
  byScanner: z.array(z.object({ name: z.string(), usd: z.number() })),
  byModel: z.array(z.object({ model: z.string(), usd: z.number() })),
  /**
   * Spend governor: what a day of background scanning is estimated to cost (p50 / p90 of the last 14 days' daily
   * scanning, the static table before there are 5 days), and what live holds hold right now.
   */
  background: z.object({ p50: z.number().min(0), p90: z.number().min(0), basis: z.enum(['history', 'default']), heldUsd: z.number().min(0) }).nullable().optional(),
});
export type SpendSummary = z.infer<typeof SpendSummary>;

export const HealthSummary = z.object({
  ok: z.number().int(),
  total: z.number().int(),
  /** Worst state across connectors drives the health-dot colour. */
  worst: ConnectorState,
  broken: z.array(z.object({ id: Id, label: z.string(), state: ConnectorState })),
});
export type HealthSummary = z.infer<typeof HealthSummary>;

/** One scope of the first scan (B-080): its own floor, whether its backfill is done, and how much of it is covered. */
export const FirstScanScope = z.object({
  scope: z.string(), // "slack:inbox", "gmail:inbox", "org62:opps"
  connector: z.string(),
  status: z.enum(['pending', 'done']),
  floorAt: IsoDateTime,
  /** Committed coverage of [floor, first-scan start), 0–100; null before the scope's first run. */
  coveredPct: z.number().min(0).max(100).nullable(),
  replans: z.number().int().default(0),
  /** FS-LATE: when a channel joined the first scan after it had finished (its coverage counts from here); null otherwise. */
  joinedAt: IsoDateTime.nullable().default(null),
  /** One-time (first-scan budget) spend of this scope's runs. */
  spentUsd: z.number().default(0),
});
export type FirstScanScope = z.infer<typeof FirstScanScope>;

/** FTI first scan: what one source read and found so far ("Slack: 1,240 messages read, 31 asks found, $0.42 so far"). */
export const FirstScanSource = z.object({
  connector: z.string(),
  itemsRead: z.number().int().min(0),
  asksFound: z.number().int().min(0),
  linked: z.number().int().min(0),
  spentUsd: z.number().min(0),
  runs: z.number().int().min(0),
  /** The progress line, as data (the surfaces chunk owns how it is shown). */
  line: z.string(),
});
export type FirstScanSource = z.infer<typeof FirstScanSource>;

/** The first scan's progress (worker state file `first-scan.json`, read server-side). */
export const FirstScanProgress = z.object({
  status: z.enum(['active', 'done', 'exhausted']),
  lookbackDays: z.number(),
  startedAt: IsoDateTime,
  floorAt: IsoDateTime,
  budgetUsd: z.number(),
  spentUsd: z.number(),
  doneAt: IsoDateTime.nullable().default(null),
  scopes: z.array(FirstScanScope),
  /** Per source, in source order (FTI first scan); absent before any first-scan run counted one. */
  sources: z.array(FirstScanSource).optional(),
});
export type FirstScanProgress = z.infer<typeof FirstScanProgress>;

// ---------------------------------------------------------------------------------------------------------------
// Setup (11 R6/R7): one row per dependency of this Mac, with its state machine and the error catalog's next step.
// ---------------------------------------------------------------------------------------------------------------

/** missing → installed → signed_out → expired → ok, plus offline (network) and unknown (the probe failed; never "broken"). */
export const DependencyState = z.enum(['missing', 'installed', 'signed_out', 'expired', 'ok', 'offline', 'unknown']);
export type DependencyState = z.infer<typeof DependencyState>;

/** The error catalog's button (src/errors/catalog.ts): reauth = a src/reauth kind, run = a command, open = a route. */
export const CatalogAction = z.object({ kind: z.enum(['reauth', 'run', 'open', 'link', 'report']), ref: z.string(), label: z.string() });
export type CatalogAction = z.infer<typeof CatalogAction>;

export const SetupDependency = z.object({
  id: z.string(), // "claude", "llm", "slack", "org62", "google", "vdp", "database", "worker", "node"
  label: z.string(),
  /** Why the app needs it, in the user's words. */
  why: z.string(),
  state: DependencyState,
  /** The catalog code when not ok. */
  code: z.string().optional(),
  /** The catalog's one next step when not ok. */
  nextStep: z.string().optional(),
  action: CatalogAction.optional(),
  /** When this was last checked (the worker's doctor run, or a Check again); null: not checked yet. */
  lastChecked: IsoDateTime.nullable(),
});
export type SetupDependency = z.infer<typeof SetupDependency>;

export const SetupSection = z.object({ dependencies: z.array(SetupDependency) });
export type SetupSection = z.infer<typeof SetupSection>;

export const DoctorCheck = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'warn', 'fail', 'skip']),
  detail: z.string(),
  fix: z.string().optional(),
  code: z.string().optional(),
  state: DependencyState.optional(),
  /** The catalog's title and next step for `code`. */
  title: z.string().optional(),
  nextStep: z.string().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorQuery = z.object({
  /** 1 = run the checks now instead of the worker's last result (kept up to 20 minutes). */
  fresh: z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  /** db = only what needs no database (the DB-down page asks this). */
  only: z.enum(['all', 'db']).optional().default('all'),
});
export type DoctorQuery = z.infer<typeof DoctorQuery>;

export const DoctorPayload = z.object({
  generatedAt: IsoDateTime,
  ok: z.boolean(),
  /** Mock mode: fixture states; nothing on this Mac was checked. */
  simulated: z.boolean().default(false),
  /** True when this is the worker's (or an earlier) stored run, not one made for this request. */
  cached: z.boolean(),
  summary: z.object({ ok: z.number().int(), warn: z.number().int(), fail: z.number().int(), skip: z.number().int() }),
  /** "12 ok, 1 warnings, 0 failed, 3 skipped · DEP.DEVBAR.MISSING" */
  summaryLine: z.string(),
  checks: z.array(DoctorCheck),
  dependencies: z.array(SetupDependency),
  /** Set when the app database is unreachable (the DB-down page renders it; the rest of the app can't load). */
  database: z.object({ code: z.string(), title: z.string(), text: z.string(), nextStep: z.string(), command: z.string().nullable() }).nullable(),
});
export type DoctorPayload = z.infer<typeof DoctorPayload>;

/** POST /doctor/claude-smoke: the one user-initiated `claude -p "reply OK"` (never automatic). */
export const ClaudeSmokeResult = z.object({
  status: z.enum(['ok', 'failed', 'refused', 'simulated']),
  /** The catalog code when not ok (refused without a gateway: AUTH.LLM.NO_GATEWAY). */
  code: z.string().nullable(),
  message: z.string(),
  nextStep: z.string().nullable(),
  /** What the check costs (shown before the click), and what it cost (null when it did not run). */
  estimateUsd: z.number(),
  costUsd: z.number().nullable(),
  model: z.string(),
  checkedAt: IsoDateTime,
});
export type ClaudeSmokeResult = z.infer<typeof ClaudeSmokeResult>;
/**
 * The resolution check's shadow comparison (H-7, R8): while `settings.closing.resolutionEngine` is `shadow`, how its
 * verdicts compare with what the legacy closers closed this week. Null when it is not in shadow.
 */
export const ResolutionShadow = z.object({
  line: z.string(),
  legacyCloses: z.number().int(),
  checked: z.number().int(),
  agreeRate: z.number().nullable(),
  wouldCloseMore: z.number().int(),
  wouldReopen: z.number().int(),
  checks: z.number().int(),
});
export type ResolutionShadow = z.infer<typeof ResolutionShadow>;

/** One resolution check, as "Why is this still open?" shows it (ids and plain words; no message text). */
export const ResolutionCheckView = z.object({
  at: IsoDateTime,
  trigger: z.string(),
  mode: z.enum(['shadow', 'live']),
  decidedBy: z.enum(['rule', 'model', 'escalation', 'skip', 'failed']),
  ruleHit: z.string().nullable(),
  verdict: z.string().nullable(),
  confidence: z.number().nullable(),
  outcome: z.enum(['closed', 'likely', 'asked', 'left', 'reopened']),
  blockedBy: z.string().nullable(),
  escalated: z.boolean(),
  costUsd: z.number(),
  /** The cited line's source item and link, when there is one. */
  citeSourceItemId: Id.nullable(),
  citeUrl: z.string().nullable(),
  /** One line in plain words ("Checked: still yours"). */
  why: z.string(),
});
export type ResolutionCheckView = z.infer<typeof ResolutionCheckView>;

export const ResolutionCheckPayload = z.object({
  itemId: Id,
  mode: z.enum(['legacy', 'shadow', 'live']),
  last: ResolutionCheckView.nullable(),
  /** Older checks, newest first (at most 5). */
  history: z.array(ResolutionCheckView),
  /** What would trigger the next check, in plain words. */
  nextCheck: z.string(),
  /** "You reopened it": the audit id of your Undo of a close for you, so the panel can offer Undo reopen (an undo of that undo). */
  reopenUndoId: Id.nullable().optional(),
});
export type ResolutionCheckPayload = z.infer<typeof ResolutionCheckPayload>;

export const HealthPayload = z.object({
  connectors: z.array(Connector),
  summary: HealthSummary,
  spend: SpendSummary,
  worker: z.object({
    alive: z.boolean(),
    lastHeartbeatAt: IsoDateTime.nullable(),
    queueDepth: z.number().int(),
    /**
     * Lane E (E1): the worker runs but claims nothing, because the database schema differs from its build (a pending
     * migration, a newer version's, one drizzle skipped). Null or absent when it isn't waiting.
     */
    blocked: z.object({ message: z.string(), fix: z.string().nullable(), since: IsoDateTime }).nullable().optional(),
  }),
  dryRun: z.boolean(),
  /** First-scan progress per scope while one ran on this install; null otherwise. */
  firstScan: FirstScanProgress.nullable().default(null),
  /**
   * D-60: VDP autopilot while it is on (null when off): paused why ("VDP autopilot is paused: re-auth VDP") and its
   * one line ("Autopilot: on · 12 applied today").
   */
  vdpAutopilot: z.object({ paused: z.enum(['reauth', 'dry_run', 'cap']).nullable(), line: z.string() }).nullable().optional(),
  /**
   * Health ▸ Setup (11 R6/R7): this Mac's dependencies with their state and the catalog's next step. Both DataSources
   * fill it; optional so a payload built elsewhere (fixtures, the kit) stays valid.
   */
  setup: SetupSection.optional(),
  /** Spend governor (H-5): runs that passed their estimate and wait for the user (Allow $Z more · Allow for today · Stop). */
  spendAsks: z.array(SpendAsk).optional(),
  /** H-7: the resolution check in shadow vs the legacy closers this week (null or absent outside shadow mode). */
  resolutionShadow: ResolutionShadow.nullable().optional(),
  /**
   * priority@2 (lane 07 R8): the shadow ranking's agreement@3 with the shown one over 7 days, the biggest disagreements,
   * and at most one suggested rule from your moves (one click). Absent: older payloads.
   */
  priority: PriorityHealth.nullable().optional(),
  /** ON-24: `no_user` before Getting started made the user (a fresh install): the rest is empty, not an error. */
  reason: z.literal('no_user').optional(),
});
export type HealthPayload = z.infer<typeof HealthPayload>;

export const ReauthResult = z.object({
  connector: Connector,
  /** in_app: simulated/handled in-app · terminal_command: the command to open in Terminal · instructions: text only. */
  action: ReauthAffordance,
  started: z.boolean(),
});
export type ReauthResult = z.infer<typeof ReauthResult>;

/** One page of the scan ledger (GET /scans): `nextCursor` null on the last page; `total` counts every run (caps audit F-2, additive). */
export const ScansPayload = z.object({ runs: z.array(ScanRun), nextCursor: z.string().nullable().optional(), total: z.number().int().optional() });
export const JobsPayload = z.object({ jobs: z.array(Job), counts: z.record(JobStatus, z.number().int()) });
export const EventLogPayload = z.object({ entries: z.array(EventLogEntry), unacknowledged: z.number().int() });
export type ScansPayload = z.infer<typeof ScansPayload>;
export type JobsPayload = z.infer<typeof JobsPayload>;
export type EventLogPayload = z.infer<typeof EventLogPayload>;
