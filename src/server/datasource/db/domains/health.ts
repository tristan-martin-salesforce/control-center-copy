/**
 * The db DataSource, health domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res } from '../shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { enqueueJob } from '@/db/queue';
import { changeSets, connectors, dealContributionRequests, jobs } from '@/db/schema';
import { healthForPersona, personaOf } from '@/personas';
import { isNoUserError, noUserHealth } from '@/server/health-no-user';
import { buildInfo, migrationTagFor, versionPayload, versionSettings, versionUpdateOf } from '@/server/version';
import { readUpdateStatus } from '@/ops/release';
import { guidePayload } from '@/guide/checklist';
import { readReadme } from '@/server/guide';
import { AppError, invalid, notFound } from '@/server/errors';
import { PgRuntimeJobQueue } from '@/jobs/runtime-queue';
import { scanJob } from '@/scanner/runtime/jobs';
import { connectorOfName, normalizeScanScope, ORG62_READBACK_SCOPE, placeholderScopeId } from '@/scanner/scope-catalog';
import { enqueueOrg62Readback } from '@/jobs/handlers/org62-readback';
import type { ConnectorId } from '@/scanner/types';
import { answerHold } from '@/llm/spend';
import { cancelSpendJob, requeueSpendJob, spendAskOf, spendHoldsPayload, spendHoldView } from '../spend';
import { loadFirstScanProgress } from '../first-scan';
import { mockCadenceSnapshot, readWorkerCadence, withNextChecks } from '../scan-cadence';
import { uuidFor } from '../ids';
import type { ReadModel } from '../model';
import { everything, GUIDE, HEALTH } from '../reads/scope';
import * as resolution from '../resolution';
import { priorityHealth } from '../priority';
import { ackEvent as ackEventRow, countJobs, insertScanRun, JOBS_FINISHED_LIMIT, loadJobs, loadScanRuns, requeueJob, updateConnector } from '../store/health';
import { autopilotHealth } from '@/engines/vdp/autopilot';
import { healthSummary } from '../views';
import { loadSpendAudit, loadSpendAuditDetail } from '../store/spend-audit';
import { mockSpendAudit, mockSpendAuditDetail } from '../../mock/spend-audit';
import { SCHEMA_EVENT_FINGERPRINT } from '@/db/migration-state';
import { dbHealthSetup } from '../health-setup';
import { mockHealthSetup } from '../../mock/health-setup';
import { doctorPayload } from '@/ops/doctor-service';
import { runClaudeSmoke } from '@/ops/smoke';
import { eventLogView, scanPage } from '@/server/views/health';

/** UI source → the scanner scope a Health "Rescan" runs (the same map as chat's rescan in chat-be6.ts). */
const RESCAN_SCOPE: Record<string, { connector: ConnectorId; scope: string }> = {
  slack: { connector: 'slack', scope: 'inbox' },
  gmail: { connector: 'gmail', scope: 'inbox' },
  calendar: { connector: 'calendar', scope: 'primary' },
  drive: { connector: 'drive', scope: 'tracked' },
  gemini: { connector: 'gemini_notes', scope: 'poll' },
  claude: { connector: 'claude_sessions', scope: 'all' },
  org62: { connector: 'org62', scope: 'opps' },
  vdp: { connector: 'vdp', scope: 'mine' },
};

/**
 * Connectors that share a source with another scanner (Trainings reads Gmail and Calendar, Watch reads Slack) are
 * targeted by their row name, never by source: before, a Trainings or Watch Rescan rescanned the Gmail or Slack inbox
 * (go-live finding RS-2). `null` = no worker spec yet (Watch, WATCH-1): the Rescan is cancelled as "no scanner".
 */
const RESCAN_BY_NAME: Record<string, Array<{ connector: ConnectorId; scope: string }> | null> = {
  trainings: [
    { connector: 'trainings', scope: 'gmail' },
    { connector: 'trainings', scope: 'calendar' },
  ],
  watch: null,
};

/** A rescan window: everything since the cursor and at least the last hour, at most the last 24 h. */
function rescanWindow(cursorAt: string | null | undefined, now: Date): { from: string; to: string } {
  const t = now.getTime();
  const cur = cursorAt ? Date.parse(cursorAt) : Number.NaN;
  const from = Math.max(t - 24 * 3_600_000, Math.min(Number.isFinite(cur) ? cur : t, t - 3_600_000));
  return { from: new Date(from).toISOString(), to: now.toISOString() };
}

export class DbHealth {
  constructor(private readonly ctx: DbCtx) {}

  async getHealth(i: I<'getHealth'>): Promise<Res<'getHealth'>> {
    // ON-24: before Getting started there is no user; answer the no-user state (the worker's beat), not a 500
    const noUser = await this.ctx.userId().then(
      () => false,
      (e: unknown) => (isNoUserError(e) ? true : Promise.reject(e)),
    );
    if (noUser) {
      const [hb] = await this.ctx.db.execute<{ at: Date | null }>(sql`select max(last_beat_at) as at from worker_instances where stopped_at is null`).then((r) => r.rows).catch(() => [{ at: null }]);
      return noUserHealth(hb?.at ? new Date(hb.at) : null);
    }
    return this.ctx.read(HEALTH, (m) => this.healthPage(m, i));
  }

  private async healthPage(m: ReadModel, _i: I<'getHealth'>): Promise<Res<'getHealth'>> {
    // PERF-1: queued + retrying (jobStatusFromDb: 'retrying' is a queued job after a failure), counted in SQL
    const [depth] = await this.ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where owner_user_id = ${m.ctx.userId} and status = 'queued'`).then((r) => r.rows);
    const [hb] = await this.ctx.db.execute<{ at: Date | null }>(sql`select max(last_beat_at) as at from worker_instances where stopped_at is null`).then((r) => r.rows).catch(() => [{ at: null }]);
    const last = hb?.at ? new Date(hb.at) : null;
    // lane E (E1): the worker's open "waiting for the schema" event (it is global: any owner, or none yet)
    const [wait] = await this.ctx.db
      .execute<{ message: string; fix: string | null; since: Date | string }>(sql`
        select message, detail->>'suggestedAction' as fix, first_occurred_at as since from app_events
         where fingerprint = ${SCHEMA_EVENT_FINGERPRINT} and resolved_at is null order by id desc limit 1`)
      .then((r) => r.rows)
      .catch(() => []);
    const health: Res<'getHealth'> = {
      // FTI: "next check in N min" per source, from the worker's cadence snapshot; a seeded database has no worker, so it
      // gets the mock's cadence-default next checks (mock parity, like its spend)
      connectors: withNextChecks(m.all('connectors'), (m.meta() as { seedHash?: string }).seedHash ? mockCadenceSnapshot(m.all('connectors'), this.ctx.now()) : readWorkerCadence(), this.ctx.now()),
      summary: healthSummary(m),
      spend: m.spend(),
      worker: {
        alive: !!last && Date.now() - last.getTime() < 120_000,
        lastHeartbeatAt: last ? last.toISOString() : null,
        queueDepth: depth?.n ?? 0,
        blocked: wait ? { message: wait.message, fix: wait.fix ?? null, since: new Date(wait.since).toISOString() } : null,
      },
      dryRun: m.settings().sending.dryRun,
      // AUDIT: a live install's first-scan progress per scope (a seeded database has no first scan).
      firstScan: (m.meta() as { seedHash?: string }).seedHash ? null : await loadFirstScanProgress(this.ctx.db, await this.ctx.userId()).catch(() => null),
      // D-60: "VDP autopilot is paused: re-auth VDP" while it is on and VDP's sign-in lapsed
      vdpAutopilot: autopilotHealth(await this.ctx.ds.vdp.vdpAutopilotInputs(m)),
      // 11 R6: this Mac's dependencies from the worker's last doctor run (a file; no extra query)
      // (a seeded database is a demo: the mock's fixture states, like its spend; parity)
      setup: (m.meta() as { seedHash?: string }).seedHash ? mockHealthSetup(m.all('connectors'), this.ctx.now()) : dbHealthSetup(),
      // Spend governor: open asks (needs-you rows) and a day of background scanning's estimate
      spendAsks: await this.ctx.spendGovernor(m.ctx.userId).store.listHolds({ states: ['asked'] }).then((hs) => hs.map((h) => spendAskOf(h))).catch(() => []),
      // H-7: the resolution check in shadow vs the legacy closers this week (src/server/datasource/db/resolution.ts)
      resolutionShadow: m.settings().closing.resolutionEngine === 'shadow' ? await resolution.resolutionShadowComparison(this.ctx.db, await this.ctx.userId(), this.ctx.now()).catch(() => null) : null,
      // priority@2 (R8): agreement@3 with the shown ranking over 7 days, the biggest disagreements, one suggested rule
      priority: await priorityHealth(this.ctx.db, m.ctx.userId, m, this.ctx.now()).catch(() => null),
    };
    {
      const bg = await this.ctx.spendGovernor(m.ctx.userId).store.backgroundEstimate().catch(() => null);
      if (bg) health.spend = { ...health.spend, background: bg };
    }
    // D-55: a source the persona has not activated has no Health row (it is listed in Settings ▸ Role & rules)
    return healthForPersona(health, personaOf(m.settings()));
  }

  async getSpendAudit({ query }: I<'getSpendAudit'>): Promise<Res<'getSpendAudit'>> {
    const m = await this.ctx.model(WHOLE);
    const timezone = m.settings().profile.timezone;
    // A seeded database has no ledger: like Health's spend, it shows the seed's numbers (mock parity).
    if ((m.meta() as { seedHash?: string }).seedHash) return mockSpendAudit(m.spend(), query ?? {}, { now: this.ctx.now(), timezone });
    return loadSpendAudit(this.ctx.db, await this.ctx.userId(), query ?? {}, { now: this.ctx.now(), timezone });
  }

  async getSpendAuditDetail({ query }: I<'getSpendAuditDetail'>): Promise<Res<'getSpendAuditDetail'>> {
    const m = await this.ctx.model(WHOLE);
    if ((m.meta() as { seedHash?: string }).seedHash) return mockSpendAuditDetail(m.spend(), query);
    return loadSpendAuditDetail(this.ctx.db, await this.ctx.userId(), query);
  }

  async getReadme(_i: I<'getReadme'>): Promise<Res<'getReadme'>> {
    return readReadme();
  }

  async getGuide(_i: I<'getGuide'>): Promise<Res<'getGuide'>> {
    return this.ctx.read(GUIDE, (m) => this.guideOf(m));
  }

  private async guideOf(m: ReadModel): Promise<Res<'getGuide'>> {
    const settings = m.settings();
    const userId = await this.ctx.userId();
    // what the user typed to the Assistant (assistant replies and tool turns don't count)
    const [chat] = await this.ctx.db
      .execute<{ n: number }>(sql`select count(*)::int as n from chat_messages cm join chat_threads ct on ct.id = cm.thread_id where ct.owner_user_id = ${userId} and cm.role = 'user'`)
      .then((r) => r.rows)
      .catch(() => [{ n: 0 }]);
    const seeded = Boolean((m.meta() as { seedHash?: string }).seedHash);
    // the Getting started DC outcome ticks on a DC request made in the app (any state)
    const [dc] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(dealContributionRequests)
      .where(eq(dealContributionRequests.ownerUserId, userId))
      .catch(() => [{ n: 0 }]);
    return guidePayload({
      connectors: m.all('connectors'),
      drafts: m.all('drafts'),
      assistantMessages: chat?.n ?? 0,
      firstScan: seeded ? null : await loadFirstScanProgress(this.ctx.db, userId).catch(() => null),
      persona: personaOf(settings),
      personaVersion: settings.persona.version,
      guide: settings.guide,
      dcRequests: dc?.n ?? 0,
    });
  }

  /** 11 R6: no database access of its own (doctor's checks connect themselves), so it answers while Postgres is down. */
  async getDoctor({ query }: I<'getDoctor'>): Promise<Res<'getDoctor'>> {
    return doctorPayload({ fresh: query?.fresh ?? false, only: query?.only ?? 'all' });
  }

  async smokeClaude(_i: I<'smokeClaude'>): Promise<Res<'smokeClaude'>> {
    return runClaudeSmoke();
  }

  async checkForUpdates(_i: I<'checkForUpdates'>): Promise<Res<'checkForUpdates'>> {
    // D-90: the worker reads the feed (devbar's Drive read path); one queued check at a time
    const r = await enqueueJob(this.ctx.db, { ownerUserId: await this.ctx.userId(), kind: 'update.check', queue: 'maintenance', payload: { trigger: 'manual' }, dedupeKey: 'update.check:manual', maxAttempts: 1 });
    return { queued: true, jobId: r.id, update: versionUpdateOf(readUpdateStatus(), buildInfo().version) };
  }

  async getVersion(_i: I<'getVersion'>): Promise<Res<'getVersion'>> {
    // ON-17: no user yet (before Getting started) answers with the default persona
    const settings = await versionSettings({ userId: () => this.ctx.userId(), settings: async () => (await this.ctx.model(WHOLE)).settings() });
    // drizzle records each applied migration's journal `when` as created_at (bigint → text over the wire)
    const [mig] = await this.ctx.db.execute<{ at: string | null }>(sql`select max(created_at)::text as at from drizzle.__drizzle_migrations`).then((r) => r.rows).catch(() => [{ at: null }]);
    // the live worker: the newest instance still beating (a crashed one never set stopped_at, so it has to be recent too)
    const [w] = await this.ctx.db
      .execute<{ v: string }>(sql`select app_version as v from worker_instances where role = 'worker' and stopped_at is null and last_beat_at > now() - interval '5 minutes' order by last_beat_at desc limit 1`)
      .then((r) => r.rows)
      .catch(() => []);
    return versionPayload({ build: buildInfo(), migration: migrationTagFor(mig?.at ? Number(mig.at) : null), persona: personaOf(settings), workerVersion: w?.v ?? null, dataSource: 'db' });
  }

  async reauthConnector({ params }: I<'reauthConnector'>): Promise<Res<'reauthConnector'>> {
    const m0 = await this.ctx.model(WHOLE);
    const c = m0.get('connectors', params.id);
    if (!c) throw notFound('Connector', params.id);
    const action = c.reauth ?? { kind: 'instructions' as const, label: 'No re-auth needed', command: null, instructions: `${c.label} does not need re-auth` };
    const started = action.kind === 'in_app' || action.kind === 'refresh_script' || action.kind === 'terminal_command';
    if (started) {
      await this.ctx.mutate({ action: 'connector.reauth', summary: `Re-auth started: ${c.label}`, entity: { type: 'connector', id: c.id }, undoable: false }, async (w, model) => {
        const cur = model.get('connectors', c.id)!;
        await updateConnector(w, cur, { ...cur, state: 'catching_up', since: w.now.toISOString(), catchUpPct: 0, impact: `Catching up ${cur.label}…` });
        // the worker starts the sign-in (VDP: the refresh script; MFA opens Terminal and a browser), then re-probes
        // until it works: 8 tries with backoff outlast a slow MFA (src/reauth/run.ts)
        await enqueueJob(w.tx, { ownerUserId: w.userId, kind: 'connector.reauth', payload: { connectorId: c.id, kind: action.kind }, dedupeKey: `reauth:${c.id}`, maxAttempts: 8 });
      });
      this.ctx.bus.publishTables(['jobs'], [c.id], 'connector.reauth');
    }
    return { connector: (await this.ctx.model(WHOLE)).get('connectors', c.id)!, action, started };
  }

  async scanConnector({ params, body }: I<'scanConnector'>): Promise<Res<'scanConnector'>> {
    const { run, auditId } = await this.scanInternal(params.id, body.scope ?? 'manual', 'user');
    return { entity: run, auditId };
  }

  /**
   * Health "Rescan" (and the old chat-ops scan): a queued placeholder run the UI shows at once, plus a real manual
   * RuntimeJob on the Postgres queue (as BE-CHAT's `rescan()`), linked by `scan_runs.job_id`. The worker's first
   * run of that job adopts the placeholder, so the UI sees ONE run going queued → running → done. Before, the job
   * carried `{connectorId, scanRunId, scope}`, which the worker's scan handler rejected (`bad_payload`), and the
   * placeholder stayed queued forever. A connector that needs re-auth fails at once (`auth_failed`, no job).
   */
  async scanInternal(connectorId: string, scope: string, actor: 'user' | 'chat') {
    const scanId = crypto.randomUUID();
    // HYG-1: the scope is checked against the connector's real scope list before anything is written. An optional
    // `<connector>:` prefix is dropped once (`org62:events` = `events`); anything else unknown is a 400 that lists the
    // valid scopes. Before, `org62:events` ran as `org62:org62:events`, read nothing and said succeeded.
    const [row0] = await this.ctx.db
      .select({ name: connectors.name, kind: connectors.kind })
      .from(connectors)
      .where(and(eq(connectors.id, uuidFor(connectorId)), eq(connectors.ownerUserId, await this.ctx.userId())))
      .limit(1);
    if (!row0) throw notFound('Connector', connectorId);
    const runtime = connectorOfName(row0.name) ?? connectorOfName(row0.kind);
    // chat's `/rescan slack 2d` (ChatOps.scan) labels its scope `chat:<window>`: the connector's default scope(s)
    const check = runtime && !(actor === 'chat' && scope.startsWith('chat:')) ? normalizeScanScope(runtime, scope) : ({ ok: true, scope: null } as const);
    if (!check.ok) throw invalid(`Unknown scope "${check.scope}" for ${row0.name}. Valid scopes: ${check.valid.join(', ')}`, { scope: check.scope, valid: check.valid });
    const r = await this.ctx.mutate({ action: actor === 'chat' ? 'chat.scan' : 'connector.scan', summary: 'Scan', entity: { type: 'connector', id: connectorId }, undoable: false, actor }, async (w, model) => {
      const c = model.get('connectors', connectorId);
      if (!c) throw notFound('Connector', connectorId);
      const now = w.now.toISOString();
      const authBroken = c.state === 'auth_needed';
      const [row] = await w.tx.select({ name: connectors.name }).from(connectors).where(eq(connectors.id, uuidFor(c.id))).limit(1);
      const byName = row ? RESCAN_BY_NAME[row.name.toLowerCase()] : undefined;
      const all = byName !== undefined ? (byName ?? []) : RESCAN_SCOPE[c.source] ? [RESCAN_SCOPE[c.source]!] : [];
      // one named scope runs alone (Trainings `gmail` runs its Gmail half only); no scope runs the connector's default(s)
      const targets = check.scope && all.length ? [{ connector: all[0]!.connector, scope: check.scope }] : all;
      const target = targets[0];
      const window = rescanWindow(c.cursor.at, w.now);
      await w.tx.update(changeSets).set({ summary: `Scan ${c.label}` }).where(eq(changeSets.id, w.cs.id));
      await insertScanRun(w, {
        id: scanId,
        connectorId: c.id,
        // the ledger's scope id (`<connector>:<scope>`), as the worker's run writes it: never a bare `dcs` or `manual`
        scope: target ? `${target.connector}:${target.scope}` : runtime ? placeholderScopeId(runtime, check.scope) : scope,
        kind: 'manual',
        windowStart: c.cursor.at ?? now,
        windowEnd: now,
        status: authBroken ? 'auth_failed' : 'queued',
        startedAt: now,
        endedAt: authBroken ? now : null,
        itemsSeen: 0,
        itemsNew: 0,
        itemsChanged: 0,
        costUsd: 0,
        model: c.source === 'slack' || c.source === 'org62' ? 'haiku' : null,
        error: authBroken ? `${c.label} needs re-auth` : null,
      });
      // domain: the Org62 read-back reconcile (my logged Events and DCs by Id) is an Org62 job, not a transport choice
      if (!authBroken && target && target.connector === 'org62' && target.scope === ORG62_READBACK_SCOPE) {
        // Health ▸ Org62 ▸ "Re-check Org62 records": the read-back reconcile job (re-reads my logged Events and DCs by Id)
        const job = await enqueueOrg62Readback(w.tx, w.userId, { trigger: actor === 'chat' ? 'chat' : 'manual' });
        await w.tx.execute(sql`update scan_runs set job_id = ${job.id} where id = ${scanId}`);
      } else if (!authBroken && target) {
        const trigger = actor === 'chat' ? 'chat' : 'manual';
        const job = scanJob({ connector: target.connector, scope: target.scope, window, mode: 'manual', trigger, runAt: now });
        const more = targets.slice(1).map((t) => scanJob({ connector: t.connector, scope: t.scope, window, mode: 'manual', trigger, runAt: now }));
        await new PgRuntimeJobQueue(this.ctx.db, w.userId).enqueue([job, ...more], w.tx);
        const [row] = await w.tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.ownerUserId, w.userId), eq(jobs.dedupeKey, job.dedupeKey), eq(jobs.status, 'queued'))).orderBy(desc(jobs.id)).limit(1);
        if (!row) throw new AppError('internal', 'scan job was not enqueued');
        await w.tx.execute(sql`update scan_runs set job_id = ${row.id} where id = ${scanId}`);
      } else if (!authBroken) {
        await w.tx.execute(sql`update scan_runs set status = 'cancelled', finished_at = ${now}::timestamptz, error_message = ${`${c.label} has no scanner`} where id = ${scanId}`);
      }
    });
    this.ctx.bus.publishTables(['scan_runs', 'jobs'], [scanId], actor === 'chat' ? 'chat.scan' : 'connector.scan');
    const m = await this.ctx.model(everything('jobs ledger'), this.ctx.db, !this.ctx.fixedUser, true);
    return { run: m.get('scanRuns', scanId)!, auditId: r.auditId };
  }

  // PERF-1: the scan ledger and the jobs list read their own table, not the whole read model
  async getScans({ query }: I<'getScans'>): Promise<Res<'getScans'>> {
    const runs = await loadScanRuns({ db: this.ctx.db, userId: await this.ctx.userId() });
    return scanPage(runs, query); // caps audit F-2: a page with a cursor, never a cut
  }

  async getJobs(_i: I<'getJobs'>): Promise<Res<'getJobs'>> {
    // MIN-28: succeeded and cancelled come as the latest JOBS_FINISHED_LIMIT (and each kind's newest); counts are full
    const rc = { db: this.ctx.db, userId: await this.ctx.userId() };
    const [list, counts] = await Promise.all([loadJobs(rc, { finishedLimit: JOBS_FINISHED_LIMIT }), countJobs(rc)]);
    return { jobs: list.sort((a, b) => b.runAt.localeCompare(a.runAt)), counts };
  }

  async retryJob({ params }: I<'retryJob'>): Promise<Res<'retryJob'>> {
    const r = await this.ctx.mutate({ action: 'job.retry', summary: 'Requeued', entity: { type: 'job', id: params.id }, ops: true }, async (w, model) => {
      const j = model.get('jobs', params.id);
      if (!j) throw notFound('Job', params.id);
      if (!['dead', 'cancelled', 'retrying'].includes(j.status)) throw invalid(`Job is ${j.status}`);
      // B3: a delivery is never re-run from here (it may have reached the destination): the item's own Apply checks first
      if (j.type.startsWith('outbox.')) throw invalid('An Outbox delivery is never re-run from Health: open the item, check the destination, and Apply it again from there');
      await w.tx.update(changeSets).set({ summary: `Requeued ${j.type}` }).where(eq(changeSets.id, w.cs.id));
      await requeueJob(w, j.id);
    });
    this.ctx.bus.publishTables(['jobs'], [params.id], 'job.retry');
    // jobs is not an audited table, so a requeue has no undo (auditId null)
    return { entity: (await this.ctx.model(everything('jobs ledger'), this.ctx.db, !this.ctx.fixedUser, true)).get('jobs', params.id)!, auditId: r.undoable ? r.auditId : null };
  }

  async getEventLog(_i: I<'getEventLog'>): Promise<Res<'getEventLog'>> {
    return eventLogView(await this.ctx.model(WHOLE));
  }

  async ackEvent({ params }: I<'ackEvent'>): Promise<Res<'ackEvent'>> {
    const r = await this.ctx.mutate({ action: 'event.ack', summary: 'Acknowledged', entity: { type: 'event_log', id: params.id } }, async (w, model) => {
      const e = model.get('eventLog', params.id);
      if (!e) throw notFound('Event', params.id);
      await w.tx.update(changeSets).set({ summary: `Acknowledged ${e.code}` }).where(eq(changeSets.id, w.cs.id));
      await ackEventRow(w, e.id);
    });
    this.ctx.bus.publishTables(['app_events'], [params.id], 'event.ack');
    // app_events is not an audited table, so an acknowledgement has no undo (auditId null)
    return { entity: (await this.ctx.model(WHOLE)).get('eventLog', params.id)!, auditId: r.undoable ? r.auditId : null };
  }

  async listSpendHolds({ query }: I<'listSpendHolds'>): Promise<Res<'listSpendHolds'>> {
    const userId = await this.ctx.userId();
    const gov = this.ctx.spendGovernor(userId);
    await gov.sweep().catch(() => 0);
    const since = query?.since ?? new Date(this.ctx.now().getTime() - 7 * 86_400_000).toISOString();
    // every hold in the window counts in the summary; every open ask is listed (caps audit 2026-11-21)
    const holds = await gov.store.listHolds({ since, ...(query?.state ? { states: [query.state] } : {}) });
    const open = await gov.store.listHolds({ states: ['asked'] });
    return spendHoldsPayload(holds, open);
  }

  async answerSpendHold({ params, body }: I<'answerSpendHold'>): Promise<Res<'answerSpendHold'>> {
    const userId = await this.ctx.userId();
    const r = await answerHold(this.ctx.spendGovernor(userId), params.id, body, {
      requeue: async (h) => void (await requeueSpendJob(this.ctx.db, userId, h.id)),
      cancel: async (h) => void (await cancelSpendJob(this.ctx.db, userId, h.id)),
    });
    if (!r) throw notFound('Spend hold', params.id);
    return { hold: spendHoldView(r.hold), resumed: r.resumed };
  }

  async chatSpendAnswer({ body }: I<'chatSpendAnswer'>): Promise<Res<'chatSpendAnswer'>> {
    return this.answerSpendHold({ params: { id: body.holdId }, body: { answer: body.answer, ...(body.usd !== undefined ? { usd: body.usd } : {}) } } as never);
  }
}
