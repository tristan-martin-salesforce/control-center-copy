/**
 * Scanner wiring for the worker: BE-2a's ScannerRuntime over the DbScannerStore and the Postgres job queue.
 *
 *   tick (every 15 s):  queue.enqueue(await scanner.planJobs(now))     cadence, off-hours, quiet backoff, budget pause,
 *                                                                     and on the first call the resume plan (head → backfill)
 *   job row:            scanner.executeJob(payload, signal)            via src/jobs/scan.ts
 *   Claude file watch:  an incremental claude_sessions job (coalesces with the scheduled poll)
 *   wake / big gap:     immediate re-plan + a reconcile job (unlinked, stale_active)
 *
 * Scan mode (`CC_SCAN_MODE`, src/scanner/runtime/mode.ts): `fti` (default) reads Slack and Org62 by code through their
 * `claude_relay` runtimes and interprets in batched, tool-less classifier calls (src/scanner/interpret), with the
 * agentic runner as the fallback for what FTI does not cover; `agentic` is the skill-agent traversal as before.
 */
import { dbSpendGovernor } from '@/server/datasource/db/spend';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import { CalendarFetcher } from '@/connectors/google/calendar';
import type { GoogleTools } from '@/connectors/google/client';
import { manifestOf } from '@/connectors/registry';
import { buildRuntime, type RuntimeDeps } from '@/connectors/runtime/build';
import type { ConnectorRuntime } from '@/connectors/runtime/types';
import { textPort } from '@/connectors/runtime/direct-mcp';
import { GeminiNotesFetcher } from '@/connectors/google/gemini-notes';
import { GmailFetcher, type Me } from '@/connectors/google/gmail';
import { TrainingsFetcher } from '@/connectors/google/trainings';
import { ClaudeSessionsFetcher, FileSessionStateStore, type ClaudeSessionsOptions } from '@/connectors/claude/sessions';
import { VdpClient, vdpCookieSecondsLeft } from '@/connectors/vdp/client';
import { vdpCallLimiter } from '@/connectors/vdp/limiter';
import { VdpFetcher } from '@/connectors/vdp/fetcher';
import { dbVdpSink } from '@/server/datasource/db/store/vdp';
import { enqueueCompletionCheck } from '@/jobs/handlers/completion';
import type { Db } from '@/db/client';
import { PgRuntimeJobQueue } from '@/jobs/runtime-queue';
import { DeferredSkillRunner, pgReevaluateEnqueuer, type ScanHandlerDeps } from '@/jobs/scan';
import { defaultScannerCwd } from '@/llm/env';
import { AgentSdkSkillRunner } from '@/llm/skill-runner';
import { stateDir } from '@/ops/paths';
import { DriveFetcher, FileDigestStore } from '@/scanner/drive-digest';
import { DEFAULT_WORK_HOURS, SIGNAL_CADENCE, type WorkHours } from '@/scanner/runtime/cadence';
import { cadenceSeedFrom, defaultCadenceFile, readCadenceSnapshot, snapshotOf, writeCadenceSnapshot } from '@/scanner/runtime/cadence-state';
import { ftiDeterministicOverrides, ftiTraversalOverrides } from '@/scanner/runtime/fti-specs';
import { scanModeOf, type ScanMode } from '@/scanner/runtime/mode';
import { stateWriteFailed } from '@/scanner/runtime/state-write';
import { FtiSkillRunner, type ClassifierModel } from '@/scanner/interpret';
import type { Clock } from '@/scanner/runtime/clock';
import type { FirstScan } from '@/scanner/runtime/first-scan';
import { deterministicSpec, org62Spec, slackSpec, type ConnectorSpec, type PrecheckInput } from '@/scanner/runtime/connectors';
import { runSlackPrecheck } from '@/scanner/precheck/slack';
import { runOneReadLookup } from '@/server/onboarding/identity';
import { PRIORITY, scanJob, type ReconcileJob } from '@/scanner/runtime/jobs';
import { ScannerRuntime } from '@/scanner/runtime/scanner-runtime';
import { logFields } from '@/scanner/trace';
import type { DbScannerStore } from '@/scanner/store-db';
import type { ConnectorId, DeterministicFetcher, FetchResult, SkillRunner, TimeWindow } from '@/scanner/types';

import { notifyClaudeSessions, type NotifierLike } from './notify';
import { closeInterruptedEvent, closeInterruptedRuns } from './recovery';
import type { TickHook } from './runtime';
import { recordSettingsSourcesEvent } from '@/jobs/handlers/doctor';
import { noteScanOutcome, settingsSourcesSuspect } from '@/ops/scanner-auth';

const DRIVE_ID = /^[A-Za-z0-9_-]{15,}$/;

export interface LiveFetcherOptions {
  google: GoogleTools;
  me: Me;
  store: DbScannerStore;
  /** Limit to these connectors (CC_WORKER_SOURCES). */
  only?: Set<ConnectorId>;
  dir?: string;
  /** The runtime's clock. Fetchers compute "now"-relative ranges (Calendar lookahead, Gemini's meeting-ended test) from it. */
  clock?: Clock;
  /** Claude-sessions source overrides (transcript/registry dirs; the stress harness replays snapshots). */
  claude?: Partial<ClaudeSessionsOptions>;
  /** The VDP mirror (scan.vdp) writes vdp_records here. Absent: no VDP source. */
  vdp?: { db: Db; userId: string; client?: VdpClient };
}

/** BE-2b's read-only fetchers. Local derived state (Drive digests, transcript parse state) lives under the state dir. */
export function buildLiveFetchers(o: LiveFetcherOptions): DeterministicFetcher[] {
  const dir = o.dir ?? stateDir();
  const want = (c: ConnectorId) => !o.only || o.only.has(c);
  const out: DeterministicFetcher[] = [];
  const clock = o.clock ? () => o.clock!.now() : undefined;
  // registry dispatch: each Google fetcher reads through its manifest's runtime (direct_mcp over the one shared client,
  // its own read allowlist). Which fetcher class to build stays per source: each takes its own dependencies.
  const google = (c: ConnectorId) => textPort(buildRuntime(manifestOf(c), { mcp: o.google }));
  if (want('gmail')) out.push(new GmailFetcher({ google: google('gmail'), me: o.me, clock }));
  if (want('calendar')) out.push(new CalendarFetcher({ google: google('calendar'), me: o.me, clock }));
  if (want('gemini_notes')) out.push(new GeminiNotesFetcher({ google: google('gemini_notes'), me: o.me, clock }));
  if (want('drive')) {
    out.push(
      new DriveFetcher({
        google: google('drive'),
        me: o.me,
        clock,
        store: new FileDigestStore(join(dir, 'drive-digests')),
        // Files linked to open work items (deliverables, links, evidence) are sampled on top of "files I edited".
        linked: async () => {
          // every open item's files (caps audit 2026-11-21: the newest 500 only)
          const ctx = await o.store.getContext({ connector: 'drive', scope: 'tracked' }, { maxOpenItems: Number.POSITIVE_INFINITY });
          return [...new Set(ctx.openItems.flatMap((i) => i.fileRefs).filter((f) => DRIVE_ID.test(f)))];
        },
      }),
    );
  }
  if (want('trainings')) out.push(new TrainingsFetcher({ google: google('trainings'), me: o.me, clock }));
  // VDP: only when vdp-app-fir is configured with a PAT (a lapsed cookie still runs, and fails as "needs re-auth").
  if (want('vdp') && o.vdp && (o.vdp.client || vdpCookieSecondsLeft().configured)) {
    out.push(new VdpFetcher({ client: o.vdp.client ?? new VdpClient({ limiter: vdpCallLimiter }), sink: dbVdpSink(o.vdp.db, o.vdp.userId), myEmails: [o.me.email, ...(o.me.aliases ?? [])].filter((e) => e.includes('@')), clock }));
  }
  if (want('claude_sessions')) {
    out.push(
      new ClaudeSessionsFetcher({
        stateStore: new FileSessionStateStore(join(dir, 'claude-session-state')),
        excludeCwdPrefixes: [defaultScannerCwd()],
        // D3: new content in a session linked to an open item is worth a model look; elsewhere only status changes are.
        linkedSessions: () => o.store.linkedClaudeSessions(),
        ...(clock ? { clock } : {}),
        ...o.claude,
      }),
    );
  }
  return out;
}

/** Work hours from the app's Settings section `settings.profile` (legacy key `profile`) or the users row. */
export async function loadWorkHours(db: Db, userId: string): Promise<WorkHours> {
  const r = await db.execute<{ tz: string; profile: { timezone?: string; workingHours?: { start?: string; end?: string; days?: number[] } } | null }>(sql`
    select u.timezone as tz, (select s.value from user_settings s where s.owner_user_id = u.id and s.key in ('settings.profile', 'profile') order by (s.key = 'settings.profile') desc limit 1) as profile
      from users u where u.id = ${userId}`);
  const row = r.rows[0];
  const wh = row?.profile?.workingHours;
  const hour = (s: string | undefined, d: number) => (s && /^\d{1,2}:\d{2}$/.test(s) ? Number(s.split(':')[0]) : d);
  return {
    startHour: hour(wh?.start, DEFAULT_WORK_HOURS.startHour),
    endHour: hour(wh?.end, DEFAULT_WORK_HOURS.endHour),
    days: Array.isArray(wh?.days) && wh!.days.length ? wh!.days : DEFAULT_WORK_HOURS.days,
    timeZone: row?.profile?.timezone || row?.tz || DEFAULT_WORK_HOURS.timeZone,
  };
}

/**
 * Contract adapter between BE-2b fetchers and the store's cursor rules (S8/S9), applied to every fetcher:
 *  - `cursor.at` must lie within the run window (S8b). Snapshot fetchers (Calendar, Drive, Gemini notes, Claude
 *    sessions, trainings' calendar scope) put it at "now" whatever the window, which fails backfill windows in the
 *    past. The opaque value is kept (a newer snapshot is safe to resume from); only `at` is clamped to window.to.
 *  - Per-object ranges that end before the window (Claude sessions report each transcript's first → last turn, so
 *    an old session is a range days back) would pull the scope's low watermark behind holes, so the cursor could
 *    never initialize (S9). Ranges wholly before window.from become points at their `to` (still object coverage
 *    for reconcile, no longer time coverage). Ranges that overlap the window keep their start: a first Drive feed
 *    or the Calendar lookback really did cover that span.
 *  - Ranges past the window end (Calendar and trainings' calendar scope claim now → now + 14 d) are clamped to
 *    window.to, and wholly-future ranges become points. Otherwise the scope never has a gap after its cursor, so the
 *    runtime never plans the next poll (found in the BE-1a live check: Calendar stopped after its first runs).
 */
export function windowAligned(f: DeterministicFetcher): DeterministicFetcher {
  return {
    connector: f.connector,
    scopes: (ctx) => f.scopes(ctx),
    health: () => f.health(),
    ...(f.listForReconcile ? { listForReconcile: (scope: string, w: TimeWindow, o: { signal: AbortSignal }) => f.listForReconcile!(scope, w, o) } : {}),
    async fetch(scope, cursor, window, opts) {
      const r = await f.fetch(scope, cursor, window, opts);
      return alignToWindow(r, window);
    },
  };
}

export function alignToWindow(r: FetchResult, window: TimeWindow): FetchResult {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return r;
  const coverage = r.coverage.map((c) => {
    const cf = c.from ? Date.parse(c.from) : NaN;
    const ct = c.to ? Date.parse(c.to) : NaN;
    if (!Number.isFinite(cf) || !Number.isFinite(ct) || ct <= cf) return c;
    if (ct <= from) return { ...c, from: c.to }; // wholly before the window
    if (cf >= to) return { ...c, to: c.from }; // wholly after the window
    if (ct > to + 1000) return { ...c, to: new Date(to).toISOString() };
    return c;
  });
  const at = Date.parse(r.nextCursor.at);
  const nextCursor = Number.isFinite(at) && at > to + 1000 ? { ...r.nextCursor, at: new Date(to).toISOString() } : r.nextCursor;
  return { ...r, coverage, nextCursor };
}

/** The Health error feed's "stopped at the daily cost cap" event (deduped per connector scope while unresolved). */
async function budgetStopEvent(db: Db, userId: string, connector: ConnectorId, scope: string, todayUsd: number | undefined): Promise<void> {
  const sid = `${connector}:${scope}`;
  await db.execute(sql`
    insert into app_events (owner_user_id, severity, component, code, error_class, message, entity_type, entity_id, detail, fingerprint)
    values (${userId}, 'warn', ${`scanner.${connector}`}, 'budget_hard_cap', 'budget', ${`${connector} ${scope}: paused at the daily LLM hard cap; resumes tomorrow`.slice(0, 200)},
            'scope', ${sid}, ${JSON.stringify({ todayUsd: todayUsd ?? null, suggestedAction: 'Raise the hard cap in Settings, or wait for the next budget day' })}::jsonb,
            ${`scanner.${connector}|budget_hard_cap|${sid}`})
    on conflict (fingerprint) where resolved_at is null
    do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now()`);
}

/** W0-7: a scope paused because one window is too large to read even in smaller pages (one open event per scope). */
async function promptCapEvent(db: Db, userId: string, connector: ConnectorId, scope: string): Promise<void> {
  const sid = `${connector}:${scope}`;
  await db.execute(sql`
    insert into app_events (owner_user_id, severity, component, code, message, entity_type, entity_id, detail, fingerprint)
    values (${userId}, 'warn', ${`scanner.${connector}`}, 'DATA.PROMPT_CAP', ${`${connector} ${scope}: one message set is too large to read, even in smaller pages; paused`.slice(0, 200)},
            'scope', ${sid}, ${JSON.stringify({ suggestedAction: 'Report this' })}::jsonb,
            ${`scanner.${connector}|DATA.PROMPT_CAP|${sid}`})
    on conflict (fingerprint) where resolved_at is null
    do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now()`);
}

export interface ScanningOptions {
  db: Db;
  userId: string;
  store: DbScannerStore;
  clock: Clock;
  fetchers: DeterministicFetcher[];
  /** LLM linking + traversal sources (Slack, Org62). Off: deterministic scans record and defer linking. */
  llm: boolean;
  runner?: SkillRunner;
  /** Per-connector spec overrides (the stress harness swaps the Slack/Org62 MCP transport for a replay server). */
  specOverrides?: Partial<Record<ConnectorId, Partial<ConnectorSpec>>>;
  workHours?: WorkHours;
  notifier?: NotifierLike;
  planEveryMs?: number;
  /**
   * CMP-1 completion pass: queue a `completion.check` after a scan that stored new items or touched work items, at
   * worker start and on wake (catch-up). Default: on when LLM linking is on with the real skill runner (the check
   * is a model call; a test or harness runner opts in explicitly).
   */
  completionCheck?: boolean;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
  /** B-080: first-scan lookback (days) when CC_FIRST_SCAN_LOOKBACK_DAYS / --lookback-days are unset (the worker: 30). */
  firstScanDefaultDays?: number;
  /** B-079: the first scan as configured (onboarding choice, env over it; src/worker/first-scan-config.ts). */
  firstScan?: FirstScan | null;
  /**
   * D5: the Slack no-op pre-check before scheduled polls (src/scanner/precheck/slack.ts). Default: on in the live
   * worker with LLM linking (CC_SLACK_PRECHECK=0 turns it off); tests and harnesses opt in explicitly.
   */
  slackPrecheck?: boolean;
  /** `fti` (fetch then interpret) or `agentic`; default `CC_SCAN_MODE`, else `fti`. */
  scanMode?: ScanMode;
  /** FTI: the relay runtime deps (tests and the stress harness pass a fake query or runtime). */
  relay?: RuntimeDeps['relay'];
  /** FTI: the runtimes of the relayed sources (overrides `relay`). */
  relayRuntimes?: Partial<Record<'slack' | 'org62', ConnectorRuntime>>;
  /** FTI: the classifier model (default: the active provider's `complete()`). */
  classifier?: ClassifierModel;
  /** Where the cadence snapshot goes (Health's "next check in N min"); null: not written. Default the state dir. */
  cadenceFile?: string | null;
}

/** D5: CC_SLACK_PRECHECK, else on in production (the launchd worker). */
export function slackPrecheckOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CC_SLACK_PRECHECK ?? (env.NODE_ENV === 'production' ? '1' : '0');
  return v === '1' || v === 'true';
}

export interface Scanning {
  scanner: ScannerRuntime;
  queue: PgRuntimeJobQueue;
  specs: ConnectorSpec[];
  handlerDeps: ScanHandlerDeps;
  planHook: TickHook;
  /** Cancel queued scans a previous worker planned; the first planJobs() re-plans from the ledger. */
  dropStalePlans(): Promise<number>;
  enqueueFileWatch(): Promise<boolean>;
  enqueueResumeReconcile(tag: string): Promise<void>;
}

/** COST-2: the least time between two file-watch scans of Claude sessions (seconds; `CC_CLAUDE_WATCH_MIN_S` overrides). */
export const FILE_WATCH_MIN_S = 300;

/**
 * When the next file-watch scan may run (pure):
 *  - one is already scheduled for later (`nowMs < lastAt`): that one (this change joins it, never pushing it out);
 *  - the last one ran less than `minMs` ago: the end of its window;
 *  - otherwise now.
 */
export function nextFileWatchAt(lastAt: number, nowMs: number, minMs: number): number {
  if (!Number.isFinite(lastAt)) return nowMs;
  if (nowMs < lastAt) return lastAt;
  return nowMs < lastAt + minMs ? lastAt + minMs : nowMs;
}

export function buildScanning(o: ScanningOptions): Scanning {
  const queue = new PgRuntimeJobQueue(o.db, o.userId);
  const ov = (c: ConnectorId) => (o.specOverrides?.[c] ?? {}) as Record<string, unknown>;
  // FTI with LLM linking on: Slack and Org62 are fetched by code, so the D5 pre-check (the same searches) is not run
  const fti = o.llm && (o.scanMode ?? scanModeOf()) === 'fti';
  const specs: ConnectorSpec[] = [
    ...(o.llm
      ? [
          slackSpec({
            ...(fti ? ftiTraversalOverrides('slack') : (o.slackPrecheck ?? slackPrecheckOn()) ? { precheck: (i: PrecheckInput) => runSlackPrecheck(i, (look) => runOneReadLookup(look, { skillPath: 'skills/read-lookup.md', timeoutMs: 60_000 })) } : {}),
            ...ov('slack'),
          }),
          org62Spec({ ...(fti ? ftiTraversalOverrides('org62') : {}), ...ov('org62') }),
        ]
      : []),
    ...o.fetchers.map((f) => deterministicSpec(windowAligned(f), { ...(fti ? ftiDeterministicOverrides(f.connector) : {}), ...ov(f.connector) })),
  ];
  const agentic = o.runner ?? (o.llm ? new AgentSdkSkillRunner({ logger: (e) => (e.event === 'error' || e.event === 'denied' ? o.log?.(`skill ${e.event}`, { ...logFields(), runId: e.runId, code: e.code, tool: e.tool }) : undefined) }) : new DeferredSkillRunner());
  // FTI books every relay read as a `pass` row of its run (src/scanner/interpret/runner.ts), so the relay runtimes get
  // no ledger of their own (one row per read, never two)
  const relays: Partial<Record<'slack' | 'org62', ConnectorRuntime>> = fti ? { slack: o.relayRuntimes?.slack ?? buildRuntime(manifestOf('slack'), { relay: o.relay ?? {} }), org62: o.relayRuntimes?.org62 ?? buildRuntime(manifestOf('org62'), { relay: o.relay ?? {} }) } : {};
  const runner = fti
    ? new FtiSkillRunner({
        fallback: agentic,
        runtimeFor: (c) => (c === 'slack' || c === 'org62' ? (relays[c] ?? null) : null),
        ...(o.classifier ? { model: o.classifier } : {}),
        log: (e) => (e.event === 'error' ? o.log?.('fti error', { ...logFields(), runId: e.runId, code: e.code }) : undefined),
      })
    : agentic;
  const cadenceFile = o.cadenceFile === undefined ? defaultCadenceFile() : o.cadenceFile;
  const scanner = new ScannerRuntime({
    store: o.store,
    runner,
    specs,
    reevaluate: pgReevaluateEnqueuer(o.db, o.userId),
    clock: o.clock,
    queue,
    cadence: { ...(o.workHours ? { workHours: o.workHours } : {}), ...(fti ? SIGNAL_CADENCE : {}) },
    ...(fti && cadenceFile !== null ? { cadenceSeed: cadenceSeedFrom(readCadenceSnapshot(cadenceFile), o.clock.now()) } : {}),
    firstScanDefaultDays: o.firstScanDefaultDays,
    ...(o.firstScan !== undefined ? { firstScan: o.firstScan } : {}),
    // W0-1: a Slack/Org62 sign-in failure that follows the settingSources change gets its own Health event
    onScanOutcome: async (e) => {
      const s = noteScanOutcome(e);
      if (e.ok || !s) return;
      const suspect = settingsSourcesSuspect(s);
      if (suspect) await recordSettingsSourcesEvent(o.db, o.userId, suspect);
    },
    // H-5: each run holds its estimate and asks past it (paused, re-queued) instead of failing at a cap
    spend: dbSpendGovernor({ db: o.db, userId: o.userId, ...(o.clock ? { clock: () => o.clock!.now() } : {}) }),
    onFinding: async (f) => {
      if (f.kind === 'unlinked_item') return; // the store already records those
      await o.db.execute(sql`
        insert into app_events (owner_user_id, severity, component, code, message, detail, fingerprint)
        values (${o.userId}, ${f.kind === 'skill_upgrade' ? 'info' : 'warn'}, ${`scanner.${f.connector}`}, ${`reconcile_${f.kind}`},
                ${`${f.connector}${f.scope ? `:${f.scope}` : ''}: ${f.kind}`.slice(0, 200)},
                ${JSON.stringify({ gap: f.gap, workItemId: f.workItemId, sourceItemId: f.sourceItemId, actions: f.actions?.length })}::jsonb,
                ${`scanner.${f.connector}|reconcile_${f.kind}|${f.scope ?? ''}`})
        on conflict (fingerprint) where resolved_at is null
        do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now()`);
    },
    log: (e) => {
      if (e.event === 'run_fail' || e.event === 'paused' || e.event === 'resumed' || e.event === 'plan' || e.event === 'skip') o.log?.(`scanner ${e.event}`, { ...logFields(), connector: e.connector, scope: e.scope, ...(e.runId ? { runId: e.runId } : {}), ...(e.mode ? { mode: e.mode } : {}), code: e.code, detail: e.event === 'plan' ? e.detail : undefined });
      // AUDIT: a traversal scope paused at the daily hard cap shows in Health's error feed (one open event per scope).
      if (e.event === 'paused' && e.code === 'budget_hard_cap' && e.connector) void budgetStopEvent(o.db, o.userId, e.connector, e.scope ?? '', e.costUsd).catch(() => undefined);
      if (e.event === 'paused' && e.code === 'DATA.PROMPT_CAP' && e.connector) void promptCapEvent(o.db, o.userId, e.connector, e.scope ?? '').catch(() => undefined);
    },
  });
  // registry dispatch: the source a file watcher feeds between sweeps (Claude sessions)
  const watched = specs.find((s) => manifestOf(s.connector).scan.watcher)?.connector ?? null;
  let lastFileWatchAt = Number.NEGATIVE_INFINITY;
  let lastCadenceWrite = Number.NEGATIVE_INFINITY;
  const fileWatchMinMs = Math.max(0, Number(process.env.CC_CLAUDE_WATCH_MIN_S ?? FILE_WATCH_MIN_S)) * 1000;
  // Default: only with the real LLM runner (the production worker passes none); tests and the harness opt in.
  const completionOn = o.completionCheck ?? (o.llm && !o.runner);
  /** CMP-1: a check after a run that stored new or changed items, or touched work items (cheap when nothing relates). */
  const queueCompletion = async (job: Parameters<NonNullable<ScanHandlerDeps['afterRun']>>[0], outcome: Parameters<NonNullable<ScanHandlerDeps['afterRun']>>[1]) => {
    if (!completionOn || outcome.status !== 'succeeded') return;
    let stored = 0;
    if (outcome.runId) {
      const r = await o.db.execute<{ n: number }>(sql`select (items_new + items_updated)::int as n from scan_runs where id = ${outcome.runId}`);
      stored = Number(r.rows[0]?.n ?? 0);
    }
    if (stored > 0 || (outcome.touchedWorkItemIds?.length ?? 0) > 0) {
      await enqueueCompletionCheck(o.db, o.userId, { trigger: 'scan', connector: job.kind === 'scan' ? job.connector : 'reconcile', runId: outcome.runId });
    }
  };
  const handlerDeps: ScanHandlerDeps = {
    scanner,
    queue,
    afterRun: async (job, outcome) => {
      // ask #14: the scope a stopped worker interrupted is read again: its Health row says so and closes (never throws)
      if (job.kind === 'scan' && outcome.status === 'succeeded') await closeInterruptedEvent(o.db, o.userId, job.connector, job.scope);
      // domain: the session-status notifications (waiting on me, done) are about Claude sessions themselves
      if (o.notifier && job.kind === 'scan' && job.connector === 'claude_sessions' && outcome.runId && outcome.status === 'succeeded') {
        await notifyClaudeSessions(o.db, o.userId, outcome.runId, o.notifier);
      }
      await queueCompletion(job, outcome);
    },
  };
  return {
    scanner,
    queue,
    specs,
    handlerDeps,
    planHook: {
      name: 'scanner.plan',
      everyMs: o.planEveryMs ?? 15_000,
      run: async (now) => {
        const jobs = await scanner.planJobs(now);
        if (jobs.length) await queue.enqueue(jobs);
        // Health's "next check in N min" per source, and the backoff a restart resumes from (at most once a minute)
        if (cadenceFile !== null && now.getTime() - lastCadenceWrite >= 60_000) {
          lastCadenceWrite = now.getTime();
          try {
            writeCadenceSnapshot(snapshotOf(scanner.status(), now), cadenceFile);
          } catch (err) {
            o.log?.('cadence snapshot not written', { code: (err as NodeJS.ErrnoException)?.code ?? 'error' });
            stateWriteFailed('the scan schedule', err);
          }
        }
      },
    },
    async dropStalePlans() {
      // The new runtime re-plans every scope from its cursor, so queued plan jobs from [cursor, now] are stale. A
      // backfill or continuation window that lies BEHIND the cursor is not: a cold start sets the cursor at now after
      // its head run, so a restart during the lookback backfill would lose those windows for good (only the nightly,
      // budget-gated reconcile could find the hole). They stay queued and run as-is (idempotent). Stress finding RS-1.
      const r = await o.db.execute(sql`
        update jobs j set status = 'cancelled', finished_at = now(), cancel_reason = 're-planned at worker start', updated_at = now()
         where j.owner_user_id = ${o.userId} and j.status = 'queued' and j.kind like 'scan.%' and j.payload->>'kind' = 'scan'
           and j.payload->>'trigger' in ('schedule', 'catch_up') and j.payload->>'mode' in ('incremental', 'head', 'backfill', 'continuation')
           and not (
             j.payload->>'mode' in ('backfill', 'continuation') and exists (
               select 1 from scan_cursors sc join connectors c on c.id = sc.connector_id
                where sc.owner_user_id = j.owner_user_id and c.kind::text = j.payload->>'connector'
                  and sc.scope = (j.payload->>'connector') || ':' || (j.payload->>'scope')
                  and sc.high_watermark_at is not null
                  and (j.payload->'window'->>'to')::timestamptz <= sc.high_watermark_at + interval '1 second'))`);
      // Scan runs a killed worker left `running` (its in-memory staged coverage is gone; the job re-runs under a new
      // run). The single-instance lock guarantees no other worker owns them. Before: they stayed `running` forever on
      // Health (stress finding W-3). Never-committed coverage is simply absent, so cursors are unaffected. What their
      // model calls cost is booked once, and Health says which scope stopped (src/worker/recovery.ts).
      await closeInterruptedRuns({ db: o.db, userId: o.userId, store: o.store, ...(o.log ? { log: o.log } : {}) }, o.clock.now());
      // CMP-1 catch-up after downtime: one completion check once the head scans had a moment to run.
      if (completionOn) await enqueueCompletionCheck(o.db, o.userId, { trigger: 'catch_up', delaySeconds: 120 });
      return r.rowCount ?? 0;
    },
    async enqueueFileWatch() {
      if (!watched) return false;
      const scope = manifestOf(watched).scopes[0]!;
      const now = o.clock.now();
      const cursor = await o.store.getCursor({ connector: watched, scope });
      const from = cursor?.at ?? new Date(now.getTime() - 24 * 3600_000).toISOString();
      if (Date.parse(from) >= now.getTime() - 1000) return false;
      // COST-2: busy Claude sessions write transcripts nonstop, and a scan per 5 s debounce cost $6/day (3,142 runs). A
      // file-watch scan runs at most once per window; changes in between coalesce into the one queued job (same dedupe
      // key: the queue keeps the earliest run_at and the latest window end).
      const at = nextFileWatchAt(lastFileWatchAt, now.getTime(), fileWatchMinMs);
      lastFileWatchAt = at;
      await queue.enqueue([scanJob({ connector: watched, scope, window: { from, to: now.toISOString() }, mode: 'incremental', trigger: 'file_watch', runAt: new Date(at).toISOString() })]);
      return at <= now.getTime();
    },
    async enqueueResumeReconcile(tag: string) {
      const id = `reconcile:${tag}:unlinked+stale_active`;
      const job: ReconcileJob = { kind: 'reconcile', id, passes: ['unlinked', 'stale_active'], trigger: 'reconcile', priority: PRIORITY.reconcile, runAt: o.clock.now().toISOString(), dedupeKey: id };
      await queue.enqueue([job]);
      if (completionOn) await enqueueCompletionCheck(o.db, o.userId, { trigger: 'catch_up', delaySeconds: 120 });
    },
  };
}
