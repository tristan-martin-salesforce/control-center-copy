/**
 * `npm run worker`: the always-on background process (R-UI-7, R-BE-4). See docs/reference/WORKER.md.
 *
 * Startup: single-instance lock (pid file + Postgres advisory lock), heartbeat file, user, stores, live
 * events, scanner, job runtime; then the resume plan (reaper → ScannerRuntime head-first catch-up → claims).
 * Shutdown (SIGTERM/SIGINT): stop claiming, abort runs, release leases, final "stopped" heartbeat.
 * Wake from sleep (clock jump): extend own leases, reap, re-plan immediately, plus a reconcile pass.
 */
import { spendStartGate } from '@/server/datasource/db/spend';
import { hostname } from 'node:os';

import { Client } from 'pg';
import { sql } from 'drizzle-orm';

import { ClaudeSessionWatcher } from '@/connectors/claude/watcher';
import { GoogleWorkspaceClient } from '@/connectors/google/client';
import { manifestOf } from '@/connectors/registry';
import { closeIdleBursts } from '@/db/changeset';
import { createDb, databaseName, type Db } from '@/db/client';
import { createDefaultRegistry } from '@/jobs';
import { allHandlers, realDeps as realReauthDeps, reauthStarter } from '@/reauth';
import { reevaluateHandler } from '@/jobs/handlers/reevaluate';
import { readInPlanHook } from '@/llm/readin/planner';
import { errorFields, logger } from '@/lib/log';
import { bugEvent, CRASH_LOOP, countWorkerStart, forgetWorkerStart, installCrashHandlers } from '@/ops/crash';
import { HeartbeatWriter, type Heartbeat } from '@/ops/heartbeat';
import { waitForUser } from '@/ops/user-wait';
import { Lifecycle, SingleInstanceLock, WakeDetector } from '@/ops/lifecycle';
import { Notifier } from '@/ops/notify';
import { liveOutboxTransport, OutboxGateway, outboxJobDef, parseJobPayload, runOutboxJob } from '@/outbox';
import { feedbackChannelFor } from '@/server/feedback/channel';
import { releaseChannelFor } from '@/server/datasource/db/outbox-release';
import { projectionsHook } from '@/projections';
import { firstScanFor } from './first-scan-config';
import { firstScanRerankHook } from './first-scan-rerank';
import { settleHook } from './settle-hook';
import { activityNotesHook } from '@/jobs/handlers/activity-notes';
import { extractUseCasesHook } from '@/jobs/handlers/use-cases-extract';
import { activitySuggestHook, configureActivitySuggest } from '@/jobs/handlers/activity-suggest';
import { vdpAssetsHook } from '@/server/datasource/db/store/vdp-assets';
import { vdpAutopilotJobDef } from '@/jobs/handlers/vdp-autopilot';
import { vdpAesHook, vdpAutopilotHook, vdpHierarchyHook, vdpIdentityHook, vdpWithdrawHook } from './vdp-autopilot-hook';
import { vdpPushJobDef } from '@/jobs/handlers/vdp-push';
import { configureVdpIdentityJob } from '@/jobs/handlers/vdp-identity';
import { activitySyncJobDef, canvasAppliedRecheck } from '@/jobs/handlers/activity-sync';
import { resolutionCheckJobDef } from '@/jobs/handlers/resolution-check';
import { settleJobDef } from '@/jobs/handlers/settle';
import { dbRerankDeps, rerankHook, rerankJobDef } from '@/jobs/handlers/rerank';
import { priorityFeedbackJobDef } from '@/jobs/handlers/priority-feedback';
import { enqueueHygieneSweep } from '@/jobs/handlers/hygiene';
import { enqueueKvBackfill } from '@/jobs/handlers/kv-backfill';
import { systemClock } from '@/scanner/runtime/clock';
import { DbScannerStore } from '@/scanner/store-db';
import { flushTrace, installDbTraceSink, logFields } from '@/scanner/trace';
import { catchUpSignature, writeCatchUpFile } from '@/server/datasource/db/catch-up';
import { dbOutboxPort } from '@/server/datasource/db/outbox';
import { ensureExtractor } from '@/server/datasource/db/seed';
import { withdrawClosedItemDrafts } from '@/server/datasource/db/store/withdraw';
import { closeLiveEventBus, getLiveEventBus } from '@/server/events';

import { loadWorkerConfig, type WorkerConfig } from './config';
import { connectorHealthNotifier, notifyDeadTop3, NullNotifier, type NotifierLike } from './notify';
import { WorkerRuntime } from './runtime';
import { buildLiveFetchers, buildScanning, loadWorkHours } from './scanning';
import { DEFAULT_FIRST_SCAN_DAYS } from '../scanner/runtime/first-scan';
import { ensureSchedules, tickSchedules } from './schedules';
import { guardOwner, SchemaGuard } from './schema-guard';
import { recoverInterruptedWork } from './recovery';
import { waitForDatabase } from './db-wait';
import { dbWaitedEvent, watchStateWrites } from './health-events';
import { projectionStore } from '@/server/datasource/db/store/projections.run';

/**
 * One JSON line per event (pino, src/lib/log.ts; PKG R9): `{"level":"info","time":…,"component":"worker","msg":…}`.
 * Inside a job the line carries its correlation fields (runId, jobId, connector, scope; AUDIT), so every line about a
 * run can be grepped by run or job. Ids and codes only; credential-shaped keys are redacted.
 */
const workerLog = logger('worker');
const log = (msg: string, detail?: Record<string, unknown>) => {
  workerLog.info({ ...logFields(), ...detail }, msg);
};

/** PKG R9: a worker bug as one Health event (Needs you), owned by the app's user, deduplicated by fingerprint. */
export async function recordWorkerBug(db: Db, ev: ReturnType<typeof bugEvent>, email: string | undefined): Promise<void> {
  const owner = await guardOwner(db, email).catch(() => null);
  await db.execute(sql`
    insert into app_events (owner_user_id, severity, component, code, error_class, message, detail, fingerprint)
    values (${owner}, 'critical', 'worker', ${ev.code}, 'bug', ${ev.message}, ${JSON.stringify(ev.detail)}::jsonb, ${ev.fingerprint})
    on conflict (fingerprint) where resolved_at is null
    do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now(), message = excluded.message,
                  detail = excluded.detail, owner_user_id = coalesce(excluded.owner_user_id, app_events.owner_user_id)`);
}

/** Set once the database handle exists, so the crash handler can write its event. */
const crashCtx: { db: Db | null; email: string | undefined } = { db: null, email: undefined };

/** The user this worker scans for: CC_USER_EMAIL (created if missing), else the first active user. */
export async function resolveUser(db: Db, cfg: Pick<WorkerConfig, 'userEmail' | 'userName'>): Promise<{ id: string; email: string; name: string } | null> {
  if (cfg.userEmail) {
    await db.execute(sql`
      insert into users (email, display_name, timezone)
      values (${cfg.userEmail.toLowerCase()}, ${cfg.userName ?? null}, ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Denver'})
      on conflict (email) do nothing`);
  }
  const r = await db.execute<{ id: string; email: string; name: string | null }>(sql`
    select id, email, display_name as name from users
     where is_active ${cfg.userEmail ? sql`and lower(email) = ${cfg.userEmail.toLowerCase()}` : sql``}
     order by created_at limit 1`);
  const u = r.rows[0];
  return u ? { id: u.id, email: u.email, name: u.name ?? cfg.userName ?? u.email } : null;
}

async function main(): Promise<void> {
  // PKG R9: count this start before anything can fail (only under the LaunchAgent: `tsx watch` restarts on every save)
  const startedAt = Date.now();
  const starts = process.env.CC_SUPERVISED === '1' ? countWorkerStart(undefined, startedAt) : null;
  const cfg = loadWorkerConfig();
  const life = new Lifecycle({ log: (m) => log(m) });
  life.installSignalHandlers();
  // ON-30: a requested stop (SIGTERM from bootout/kickstart, or SIGINT) is not a crash: take this start back out
  if (starts) life.onShutdown('forget this start', (reason) => (reason === 'SIGTERM' || reason === 'SIGINT' ? forgetWorkerStart(startedAt) : undefined));

  const handle = createDb({ url: cfg.databaseUrl, applicationName: 'command-center-worker' });
  const db = handle.db;
  crashCtx.db = db;
  crashCtx.email = cfg.userEmail;
  // ask #14 (W6): the pid file first (a second worker exits before it waits), then wait for the database with backoff
  // instead of exiting into launchd's restart loop; the heartbeat names what it waits for (DEP.DB.DOWN / MISSING)
  const pidLock = new SingleInstanceLock({});
  const pidGot = await pidLock.acquire();
  if (!pidGot.acquired) {
    log('another worker is running; exiting', { reason: pidGot.reason, holderPid: pidGot.holderPid });
    await handle.close();
    process.exit(0);
  }
  const hb = new HeartbeatWriter({
    appVersion: cfg.appVersion,
    onBeat: (b: Heartbeat) => db.execute(sql`update worker_instances set last_beat_at = now() where id = ${b.instance_id}`).then(() => undefined),
  });
  hb.setState('starting');
  const dbWait = await waitForDatabase({
    probe: async () => {
      const c = new Client({ connectionString: cfg.databaseUrl, application_name: 'command-center-worker-probe' });
      c.on('error', () => undefined);
      try {
        await c.connect();
        await c.query('select 1');
      } finally {
        await c.end().catch(() => undefined);
      }
    },
    stopping: () => life.stopping,
    onWait: (e) => {
      hb.lastErrorCode = e.code;
      hb.beat();
      log('database not answering; waiting', { code: e.code, errCode: e.errCode, attempt: e.attempt, retryInMs: e.delayMs });
    },
  });
  if (!dbWait.ok) {
    hb.stop();
    await pidLock.release();
    await handle.close();
    return;
  }
  hb.lastErrorCode = null;

  const lockClient = new Client({ connectionString: cfg.databaseUrl, application_name: 'command-center-worker-lock' });
  // ask #14 (W6): the lock's connection dropped (Postgres restarted): the advisory lock went with it. Drain and exit;
  // launchd starts the worker again, which waits for the database above. Before: an unhandled 'error' crashed it.
  lockClient.on('error', (err: Error & { code?: string }) => {
    log('database connection lost; restarting the worker', { code: err.code ?? err.name });
    void life.shutdown('database connection lost').then((code) => process.exit(code));
  });
  await lockClient.connect();
  const lock = new SingleInstanceLock({ client: lockClient });
  const got = await lock.acquire();
  if (!got.acquired) {
    log('another worker is running; exiting', { reason: got.reason, holderPid: got.holderPid });
    hb.stop();
    await lockClient.end().catch(() => undefined);
    await handle.close();
    process.exit(0);
  }

  // PKG R9: more than 5 starts in 10 minutes is a crash loop. Say so once on Health, then wait before working (the
  // process stays up, so launchd stops restarting it every few seconds).
  if (starts?.loop) {
    log('crash loop: waiting before starting work', { code: 'BUG.WORKER_CRASH_LOOP', starts: starts.starts.length, waitMs: CRASH_LOOP.backoffMs });
    await recordWorkerBug(db, bugEvent('BUG.WORKER_CRASH_LOOP', { starts: starts.starts.length }), cfg.userEmail).catch((err: unknown) => log('recording the crash loop failed', errorFields(err)));
    hb.state = 'blocked';
    hb.lastErrorCode = 'crash_loop';
    hb.beat();
    const until = Date.now() + CRASH_LOOP.backoffMs;
    while (!life.stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    if (life.stopping) return;
  }

  // Lane E (E1): nothing below runs on a schema this build wasn't made for. Wait (heartbeat `blocked`, one Health
  // event) instead of exiting, so launchd's KeepAlive never turns a pending migration into a crash loop.
  const schema = new SchemaGuard({ db, log, ownerUserId: () => guardOwner(db, cfg.userEmail) });
  let started = false;
  life.onShutdown('release (still waiting for the schema)', async () => {
    if (started) return; // the full shutdown below releases everything
    hb.stop();
    await lock.release();
    await lockClient.end().catch(() => undefined);
    await handle.close();
  });
  const blocked = () => {
    hb.state = 'blocked';
    hb.lastErrorCode = 'schema_mismatch';
    hb.beat();
  };
  if (!(await schema.waitForMatch({ stopping: () => life.stopping, onBlocked: blocked }))) return;
  started = true;
  hb.lastErrorCode = null;
  const prev = await db.execute<{ last: string | null }>(sql`select max(last_beat_at) as last from worker_instances where role = 'worker'`);
  await db.execute(sql`
    insert into worker_instances (id, role, hostname, pid, app_version) values (${hb.instanceId}, 'worker', ${hostname()}, ${process.pid}, ${cfg.appVersion})
    on conflict (id) do nothing`);
  log('started', { db: databaseName(cfg.databaseUrl), live: cfg.live, llm: cfg.llm, lastBeat: prev.rows[0]?.last ?? null });
  if (dbWait.attempts > 1) await dbWaitedEvent(db, await guardOwner(db, cfg.userEmail).catch(() => null), dbWait.waitedMs, dbWait.code);

  const user = await waitForUser({ resolve: () => resolveUser(db, cfg), stopping: () => life.stopping, beat: () => void hb.beat(), log });
  if (!user) return;

  // AUDIT: the scan run trace (scan_run_events), written in the background; a trace failure never fails a run.
  installDbTraceSink(db, { log });
  // ask #14 (W5): a full disk (state folder or the database's) is one Health row, never a crash
  const ownerId = user.id;
  watchStateWrites(db, () => ownerId, log);
  const notifier: NotifierLike = cfg.notify ? new Notifier() : new NullNotifier();
  const store = new DbScannerStore({ db, userId: user.id, onHealthChange: connectorHealthNotifier(notifier) });
  getLiveEventBus({ db, url: cfg.databaseUrl }); // LISTEN + publish every change-set commit from this process
  const google = cfg.live ? new GoogleWorkspaceClient() : undefined;
  const fetchers = google ? buildLiveFetchers({ google, me: { email: user.email, name: user.name, aliases: cfg.meAliases }, store, only: cfg.sources, vdp: { db, userId: user.id } }) : [];
  const workHours = await loadWorkHours(db, user.id);
  const scanning = buildScanning({ db, userId: user.id, store, clock: systemClock, fetchers, llm: cfg.llm, workHours, notifier, log, firstScanDefaultDays: DEFAULT_FIRST_SCAN_DAYS, firstScan: await firstScanFor(db, user.id, { log, stopping: () => life.stopping }) });
  // Health ▸ re-auth: the job starts the sign-in itself (VDP: the refresh script; MFA opens Terminal), then re-probes
  const reauth = reauthStarter((vdp) => allHandlers(realReauthDeps(), { vdp }));
  const registry = createDefaultRegistry({ scan: scanning.handlerDeps, reauth });
  registry.wire('reevaluate', reevaluateHandler(), 'work item re-evaluation: closure machine + re-eval planner (BE-3)');
  // Outbox delivery after the user's confirm. The live transport is fail-closed for Slack and Gmail in this build
  // (BE-OUTBOX); VDP items go to vdp-app-fir after the user's Apply with dry-run off (approved 2026-11-10).
  // D-56: the one live Slack post is the feedback report, to the configured channel only (re-read at the post).
  const feedbackUser = user.id;
  // D-56 feedback post and D-90 release announcement: the two live Slack sends, each only to its configured channel
  const outboxGateway = new OutboxGateway(liveOutboxTransport({ feedback: { channel: () => feedbackChannelFor(db, feedbackUser) }, release: { channel: () => releaseChannelFor(db, feedbackUser) } }));
  registry.register(outboxJobDef({ port: (ctx) => dbOutboxPort(ctx.db, ctx.userId, { extractorId: () => ensureExtractor(ctx.db), now: ctx.clock }), gateway: outboxGateway, onCanvasApplied: canvasAppliedRecheck(handle) }));
  // D-60: VDP autopilot, only while Settings ▸ Sending ▸ VDP autopilot is on; through the same Outbox gateway
  // told once per pause (the change of reason); Health and the VDP view keep showing it
  registry.register(
    vdpAutopilotJobDef({
      handle,
      gateway: outboxGateway,
      notify: async (why) =>
        void (await notifier
          .notify({ kind: 'connector_broken', entityId: 'vdp.autopilot', transition: `paused:${why}`, title: why === 'reauth' ? 'VDP autopilot is paused: re-auth VDP' : 'VDP autopilot is paused', body: why === 'reauth' ? 'Health ▸ VDP ▸ Run refresh signs you in again; what it would apply waits.' : why === 'dry_run' ? 'Dry run is on (Settings ▸ Sending).' : "Today's cap is reached; the rest waits for tomorrow.", url: '/activity?view=vdp' })
          .catch(() => undefined)),
    }),
  );
  // D-63: "Push N to VDP" in order (each item approved by the push, new ids passed down), through the same gateway
  registry.register(vdpPushJobDef({ handle, gateway: outboxGateway }));
  // SETTLE-1: the Settle pass (queue `settle`, concurrency 1), queued by settleHook below.
  registry.register(settleJobDef({ handle }));
  // H-7: the resolution check (queue `settle`), queued per item by the scan-run triggers, nightly by its sweep
  registry.register(resolutionCheckJobDef({ handle }));
  // priority@2 (lane 07 R4, R8): the auto re-rank (queue `priority`) and the nightly learning pass
  registry.register(rerankJobDef(dbRerankDeps(handle)));
  registry.register(priorityFeedbackJobDef());
  // D-69: the identity judgment reads its pending units through the VDP view's own computation (same keys and hashes)
  configureVdpIdentityJob({ handle });
  configureActivitySuggest({ handle }); // the rows' opportunity suggestions read the same read model as GET /time
  // Logging (D-48): in automatic mode the weekday 17:30 run stages the batch for Apply; on demand it does nothing.
  registry.register(activitySyncJobDef({ handle }));
  await ensureSchedules(db, user.id, registry, workHours.timeZone, new Date());
  // HYG-1: one dead-data sweep a minute after every start (the first worker after a deploy cleans what is there)
  await enqueueHygieneSweep(db, user.id, 'start').catch((err: unknown) => log('queueing the hygiene sweep failed', { code: (err as { code?: string }).code ?? (err as Error).name }));
  // D-98 / 0036: the kv side-car → columns backfill after every start (it returns at once once done)
  await enqueueKvBackfill(db, user.id, 'start').catch((err: unknown) => log('queueing the kv backfill failed', { code: (err as { code?: string }).code ?? (err as Error).name }));
  // ask #14: what a worker that stopped without draining left (its jobs' leases, its runs and their spend, its holds),
  // put right before anything is planned; Health says which scope stopped (src/worker/recovery.ts)
  await recoverInterruptedWork({ db, userId: user.id, workerId: hb.instanceId, store, log });
  const dropped = await scanning.dropStalePlans();
  if (dropped) log('dropped stale scan plans from a previous run', { dropped });
  // OUTBOX-W: pending drafts of to-dos that closed before closing withdrew them (or that raced a close) leave the Outbox
  const withdrawn = await withdrawClosedItemDrafts(db, user.id, { ref: 'worker.start' }).catch((err: unknown) => {
    log('withdrawing drafts of closed to-dos failed', { code: (err as { code?: string }).code ?? (err as Error).name });
    return [];
  });
  if (withdrawn.length) log('withdrew drafts of closed to-dos', { drafts: withdrawn.length });

  const userId = user.id;
  let lastCatchUp = '';
  /** B3: resolve stopped Outbox deliveries (recoverOnly: never a write): "check before you try again", or "nothing was sent". */
  const recoverOutbox = async (jobs: ReadonlyArray<{ ownerUserId: string; payload: Record<string, unknown> }>) => {
    for (const j of jobs) {
      const p = parseJobPayload(j.payload);
      if (!p) continue;
      const out = await runOutboxJob(p, dbOutboxPort(db, j.ownerUserId, { extractorId: () => ensureExtractor(db), now: () => new Date() }), null, { now: () => new Date(), recoverOnly: true }).catch((err: unknown) => ({ error: (err as Error).name }));
      log('resolved a stopped Outbox delivery', { draftId: p.draftId, ...out });
    }
  };
  const runtime: WorkerRuntime = new WorkerRuntime({
    db,
    userId,
    workerId: hb.instanceId,
    registry,
    services: { store, scanning },
    // H-5: jobs that call a model hold their estimate first; none starts past today's hard cap (one SPEND.DAY_BUDGET event)
    startGate: spendStartGate(db, userId),
    listenUrl: cfg.databaseUrl,
    log,
    hooks: [
      // Lane E (E1): someone migrated while this worker ran (or rolled the build back): hold claims until they match.
      {
        name: 'schema',
        everyMs: 60_000,
        whileHeld: true,
        run: async () => {
          const s = await schema.check();
          if (!s) return;
          if (s.state === 'match') runtime.release();
          else runtime.hold('schema_mismatch');
        },
      },
      scanning.planHook,
      { name: 'schedules', everyMs: 30_000, run: async (now) => void (await tickSchedules(db, userId, now)) },
      projectionsHook(projectionStore(db), userId, log), // source items → calendar events, deals, sessions, assets, time (src/projections)
      { name: 'bursts', everyMs: 30_000, run: async () => void (await closeIdleBursts(db)) },
      readInPlanHook(db, userId, log), // BE-READIN: automatic read-in triggers (direct asks, top N, meeting prep)
      firstScanRerankHook(handle, userId, log), // HOME-1b: one initial ranking when the first scan completes
      settleHook(db, userId, log), // SETTLE-1: judge items with their whole conversation; close for you, ask or leave
      rerankHook(db, userId, log), // priority@2 R4: inputs changed (scan, calendar sync, closure, edits) → one debounced re-rank
      vdpAssetsHook(db, userId, log), // new Drive files, Slack / Gmail links, meeting attachments → VDP asset candidates (no model call)
      vdpAutopilotHook(db, userId, log), // D-60: after each VDP read and every 30 min, while VDP autopilot is on
      vdpWithdrawHook(handle, userId, log), // D-60: after each VDP read, staged VDP changes VDP already has are withdrawn
      vdpAesHook(db, userId, log), // D-63: after an Org62 read, who the VDP AEs are (the Specialist Forecasts of my 100%-DC opps)
      vdpHierarchyHook(db, userId, log), // D-69: after an Org62 read, the account hierarchy (parents up to five levels)
      vdpIdentityHook(db, userId, log, { handle }), // D-69: after a VDP or hierarchy read, the judgment for ambiguous company identities (the view's own units)
      activityNotesHook(db, userId, log), // D-66: after new meeting notes, the cheap model's Org62 Description note for their rows
      extractUseCasesHook(db, userId, log), // use cases to add: after new notes, meetings, Slack or mail land, the candidates pass
      activitySuggestHook(db, userId, log), // Time: after the rows change, the cheap model's suggestion (internal, or which opp) for rows the rules can't place
      {
        name: 'heartbeat',
        everyMs: 15_000,
        whileHeld: true,
        run: async () => {
          const s = runtime.status();
          hb.activeJobs = s.activeJobs;
          hb.state = s.state === 'draining' ? 'draining' : runtime.held ? 'blocked' : scanning.scanner.isCatchingUp() ? 'catching_up' : s.state === 'running' ? 'running' : 'idle';
          hb.lastErrorCode = runtime.held ? 'schema_mismatch' : null;
          hb.beat();
          const progress = await scanning.scanner.catchUpProgress();
          writeCatchUpFile(progress); // B-079: Health's catching_up + catchUpPct (db/catch-up.ts)
          // Live pass: the file is read on each Health read, so say when it moved (per 5 %, and when it ends): the
          // sidebar's "Catching up · Gmail 40 %" follows without polling.
          const sig = catchUpSignature(progress);
          if (sig !== lastCatchUp) {
            lastCatchUp = sig;
            getLiveEventBus().publish({ topic: 'health', ids: [], reason: 'catchup.progress' });
          }
        },
      },
    ],
    onDead: async (job) => {
      await notifyDeadTop3(db, typeof job.payload.work_item_id === 'string' ? job.payload.work_item_id : undefined, job.kind, notifier);
      // B3: an Outbox delivery that died (its one attempt) is resolved without writing, never left "sending"
      if (job.kind.startsWith('outbox.')) await recoverOutbox([{ ownerUserId: job.ownerUserId, payload: job.payload }]);
    },
    // B3: the reaper never requeues an Outbox delivery; its item is resolved here without writing again
    onReapedOutbox: (jobs) => recoverOutbox(jobs),
  });
  await runtime.start();
  hb.setState(scanning.scanner.isCatchingUp() ? 'catching_up' : 'idle');

  const wake = new WakeDetector(
    (e) =>
      void (async () => {
        await runtime.onWake(e.gapMs);
        if (e.gapMs > 30 * 60_000) await scanning.enqueueResumeReconcile(`wake:${new Date().toISOString().slice(0, 13)}`);
      })().catch((err) => log('wake handling failed', { code: (err as Error).name })),
    { intervalMs: 5000, thresholdMs: 60_000 },
  );
  wake.start();

  // registry dispatch: a live source the file watcher feeds (Claude sessions' manifest: scan.watcher)
  const watcher = cfg.live && fetchers.some((f) => manifestOf(f.connector).scan.watcher)
    ? new ClaudeSessionWatcher({ onChange: () => void scanning.enqueueFileWatch().then((queued) => (queued ? runtime.pollOnce() : 0)).catch(() => undefined) })
    : undefined;
  watcher?.start();

  life.onShutdown('stop timers', () => {
    wake.stop();
    watcher?.stop();
    hb.setState('draining');
  });
  life.onShutdown('drain jobs', async (reason) => {
    const r = await runtime.stop(reason);
    log('drained', r);
  });
  life.onShutdown('release', async (reason) => {
    hb.stop();
    await flushTrace();
    await db.execute(sql`update worker_instances set stopped_at = now(), stop_reason = ${reason.slice(0, 60)} where id = ${hb.instanceId}`).catch(() => undefined);
    await closeLiveEventBus();
    await (google as GoogleWorkspaceClient | undefined)?.close().catch(() => undefined);
    await lock.release();
    await lockClient.end().catch(() => undefined);
    await handle.close();
  });
  if (cfg.runForMs) {
    setTimeout(() => void life.shutdown('run_for elapsed').then((code) => process.exit(code)), cfg.runForMs).unref();
  }
}

const invokedDirectly = /(^|[\\/])worker[\\/]index\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? '');
if (invokedDirectly) {
  // PKG R9: an error nothing caught becomes a Health event (BUG.UNHANDLED), then the worker exits 1 and launchd restarts it
  const onCrash = installCrashHandlers(process, {
    record: async (ev) => {
      if (crashCtx.db) await recordWorkerBug(crashCtx.db, ev, crashCtx.email);
    },
    log,
    exit: (code) => process.exit(code),
  });
  main().catch((err: unknown) => void onCrash('fatal', err));
}
