/**
 * Scans through BE-2a's ScannerRuntime: every `scan.<connector>` / `scan.reconcile` job row carries a RuntimeJob.
 *
 *   outcome = await scanner.executeJob(job, signal)
 *   enqueue outcome.followUps (continuations, split windows, targeted rescans)
 *   outcome.retryAt → enqueue the same job at that time (`<dedupeKey>#retry`, attempt + 1)
 *
 * Scan failures are scan-level (scan_runs, connector health, the runtime's own retry policy), so the job row
 * itself succeeds with the outcome as its result. Only exceptions escaping executeJob use the job retry /
 * dead-letter path.
 *
 * Linking seam (`linkWithSkill`): deterministic scans hand their prefetched items to the same SkillRunner
 * the traversal scans use (src/llm/skill-runner.ts). With LLM scanning off (CC_SCAN_LLM=0) the
 * DeferredSkillRunner records items and coverage and flags new/changed items `deferred:` for reconcile.
 */
import { sql } from 'drizzle-orm';

import { redact } from '@/connectors/redact';
import type { Db } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import type { ScanSkillRunInput } from '@/llm/skill-runner';
import type { ScanSkillRunResult } from '@/scanner/runtime/contract-ext';
import { toInterpret } from '@/scanner/runtime/reread';
import { retryJobOf, type JobOutcome, type RuntimeJob } from '@/scanner/runtime/jobs';
import type { ScannerRuntime } from '@/scanner/runtime/scanner-runtime';
import type { ConnectorId, ReevaluateEnqueuer, ScannerStore, SkillRunner } from '@/scanner/types';

import type { PgRuntimeJobQueue } from './runtime-queue';
import { JobError, type JobContext, type JobHandler } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SkillRunner without an LLM: records what the fetcher found and defers linking to reconcile (SCANNER.md §7). */
export class DeferredSkillRunner implements SkillRunner {
  constructor(private readonly reason = 'deferred: LLM linking is off (CC_SCAN_LLM=0)') {}

  async run(input: ScanSkillRunInput, store: ScannerStore): Promise<ScanSkillRunResult> {
    const counts = { recorded: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, coverage: 0 };
    const base = { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
    // Reconcile relinks with the LLM off are a no-op, not a failure: before, each one failed a run and bumped the
    // connector's consecutive_failures, so Health showed healthy connectors as failing (stress finding D-1).
    // Items keep their `deferred:` reason, which never counts as an attempt (S6).
    if (input.mode === 'relink' || input.mode === 'relink_escalated') return { ok: true, ...base, counts, summary: 'deferred: LLM linking is off' };
    if (!input.prefetched) return { ok: false, ...base, counts, error: { message: 'LLM scanning is off: traversal sources need the skill agent', errorClass: 'config' } };
    const res = await store.recordSourceItems(input.runId, input.prefetched);
    // ask #14 (W2): a message an interrupted run stored but nobody judged is flagged too, not only new or changed ones
    const flag = new Set((await toInterpret(store, res)).map((r) => r.sourceItemId));
    for (const r of res) {
      counts.recorded += 1;
      if (r.isNew) counts.new += 1;
      if (r.changed) counts.changed += 1;
      if (flag.has(r.sourceItemId)) {
        await store.flagUnlinked(input.runId, { sourceItemId: r.sourceItemId, reason: this.reason });
        counts.unlinked += 1;
      }
    }
    if (input.preReportedCoverage?.length) {
      await store.reportCoverage(input.runId, input.preReportedCoverage);
      counts.coverage = input.preReportedCoverage.length;
    }
    return { ok: true, ...base, counts };
  }
}

/** ReevaluateEnqueuer over the jobs table: coalesces with W2 (same dedupe key), fenced on the current generation. */
export function pgReevaluateEnqueuer(db: Db, userId: string): ReevaluateEnqueuer {
  return async (ids, reason) => {
    const valid = [...new Set(ids)].filter((id) => UUID.test(id));
    if (!valid.length) return;
    const gens = await db.execute<{ id: string; g: string }>(sql`
      select id, reeval_generation as g from work_items where owner_user_id = ${userId}
         and id in (${sql.join(
           valid.map((v) => sql`${v}::uuid`),
           sql`, `,
         )})`);
    for (const r of gens.rows) {
      await enqueueJob(db, {
        ownerUserId: userId,
        kind: 'reevaluate',
        queue: 'engine',
        // catching_up lets BE-3 hold re-ranks while a connector catches up (SCANNER.md §5); it was dropped here (RE-1).
        payload: { work_item_id: r.id, run_id: reason.runId, connector: reason.connector, ...(reason.catchingUp ? { catching_up: true } : {}), ...(reason.trigger ? { trigger: reason.trigger } : {}) },
        dedupeKey: `reeval:work_item:${r.id}`,
        generation: Number(r.g),
        supersedesRunning: true,
        delaySeconds: 2,
      });
    }
  };
}

export interface ScanHandlerDeps {
  scanner: ScannerRuntime;
  queue: PgRuntimeJobQueue;
  /** Post-run hook (notifications for Claude sessions waiting on me, …). Errors are logged, never fail the job. */
  afterRun?: (job: RuntimeJob, outcome: JobOutcome, ctx: JobContext) => Promise<void>;
}

/**
 * LEGACY shape the DB DataSource used to enqueue for Health "Rescan" (`scan.<source>` with
 * `{connectorId, scanRunId, scope}`): not a RuntimeJob. Before stress finding W-1 these dead-lettered as
 * `bad_payload`, the UI's queued scan_runs row stayed queued forever, and an auth-paused connector never resumed.
 * The DataSource now enqueues a real manual RuntimeJob whose first run adopts the placeholder run (scanInternal,
 * store startRun); this path only drains jobs of the old shape still queued in an existing database.
 */
export interface UiScanRequest {
  connectorId: string;
  scanRunId?: string;
  scope?: string;
  trigger?: 'manual' | 'chat';
}

export function isUiScanRequest(p: unknown): p is UiScanRequest {
  const x = p as Record<string, unknown> | null;
  return !!x && typeof x === 'object' && x.kind === undefined && typeof x.connectorId === 'string';
}

async function connectorName(ctx: JobContext, connectorId: string): Promise<ConnectorId | undefined> {
  if (!UUID.test(connectorId)) return connectorId as ConnectorId; // already a connector name
  const r = await ctx.db.execute<{ name: string }>(sql`select name from connectors where id = ${connectorId} and owner_user_id = ${ctx.userId}`);
  return r.rows[0]?.name as ConnectorId | undefined;
}

/** Health "Rescan" / chat `/rescan`: run the connector's scopes now (clears an auth pause on success), close the UI's run row. */
async function runUiScan(deps: ScanHandlerDeps, ctx: JobContext, req: UiScanRequest): Promise<Record<string, unknown>> {
  const name = await connectorName(ctx, req.connectorId);
  const spec = name ? deps.scanner.spec(name) : undefined;
  const known = name ? deps.scanner.scopesOf(name) : [];
  const scopes = req.scope && known.includes(req.scope) ? [req.scope] : known.length ? known : spec ? [spec.type === 'traversal' ? (name === 'org62' ? 'opps' : 'inbox') : 'all'] : [];
  const outcomes: JobOutcome[] = [];
  if (spec) {
    deps.scanner.resumeConnector(name!);
    for (const scope of scopes) {
      if (ctx.signal.aborted) break;
      outcomes.push(...(await deps.scanner.runScope({ connector: name!, scope }, req.trigger === 'chat' ? 'chat' : 'manual', undefined, ctx.signal)));
    }
  }
  const ok = !!spec && outcomes.length > 0 && outcomes.every((o) => o.status === 'succeeded' || o.status === 'skipped');
  const error = !spec ? `no scanner is running for connector ${name ?? req.connectorId}` : ok ? null : redact(outcomes.find((o) => o.status !== 'succeeded')?.detail ?? 'scan failed').text.slice(0, 300);
  if (req.scanRunId && UUID.test(req.scanRunId)) {
    await ctx.db.execute(sql`
      update scan_runs set status = ${ok ? 'succeeded' : 'failed'}, finished_at = ${ctx.clock().toISOString()}::timestamptz,
             error_message = ${error}, cost_usd = ${outcomes.reduce((a, o) => a + (o.costUsd ?? 0), 0)}
       where id = ${req.scanRunId} and owner_user_id = ${ctx.userId} and status in ('queued', 'running')`);
  }
  return { status: ok ? 'succeeded' : 'failed', connector: name, scopes, runs: outcomes.length, detail: error ?? undefined };
}

/**
 * `connector.reauth` (Health "Re-auth"). The DataSource enqueues it when the user STARTS re-auth, which completes
 * where they are (Claude /mcp, devbar, browser). Resume the connector and probe its primary scope; while the probe
 * still fails on auth, throw a retryable error so the queue retries with backoff until re-auth completes (or the
 * attempts run out and the job dead-letters with a notification). Before: no handler at all (stress finding W-1).
 */
/**
 * Starts a connector's sign-in for Health's re-auth button (the worker passes src/reauth/run.ts). Returns what it did,
 * or null when the connector has nothing to start.
 */
export type ReauthStarter = (connector: string, ctx: JobContext) => Promise<{ status: string; message: string } | null>;

/** Start outcomes that mean the sign-in could not even begin: retrying the probe would not help. */
const NOT_STARTED = new Set(['unavailable', 'failed']);

export function reauthHandler(deps: ScanHandlerDeps, start?: ReauthStarter): JobHandler {
  return async (ctx) => {
    const p = ctx.job.payload as { connectorId?: string };
    if (typeof p?.connectorId !== 'string') throw new JobError(`job ${ctx.job.id} has no connectorId`, 'validation', { code: 'bad_payload' });
    const name = await connectorName(ctx, p.connectorId);
    const spec = name ? deps.scanner.spec(name) : undefined;
    if (!name || !spec) return { status: 'skipped', detail: `no scanner is running for connector ${name ?? p.connectorId}` };
    // The click starts the sign-in once (the first attempt); the retries only re-probe while the user finishes it.
    let started: { status: string; message: string } | null = null;
    if (start && ctx.job.attempts <= 1) {
      started = await start(name, ctx).catch((e: unknown) => ({ status: 'failed', message: redact(String((e as Error)?.message ?? e)).text.slice(0, 300) }));
      ctx.log('reauth started', { connector: name, status: started?.status ?? 'none' });
    }
    const resumed = deps.scanner.resumeConnector(name);
    const scope = deps.scanner.scopesOf(name)[0] ?? (spec.type === 'traversal' ? (name === 'org62' ? 'opps' : 'inbox') : 'all');
    const out = await deps.scanner.runScope({ connector: name, scope }, 'manual', undefined, ctx.signal);
    if (out.some((o) => o.errorClass === 'auth')) {
      // the probe has put the connector back to "needs re-auth"; say why when the sign-in never began
      if (started && NOT_STARTED.has(started.status)) throw new JobError(`${name}: ${started.message}`, 'validation', { code: 'reauth_not_started' });
      throw new JobError(`${name} still needs re-auth`, 'transient', { code: 'reauth_pending' });
    }
    return { status: out.every((o) => o.status === 'succeeded' || o.status === 'skipped') ? 'succeeded' : 'failed', connector: name, resumed, probe: scope, started: started?.status ?? null };
  };
}

export function scanHandler(deps: ScanHandlerDeps): JobHandler {
  return async (ctx) => {
    if (isUiScanRequest(ctx.job.payload)) return runUiScan(deps, ctx, ctx.job.payload);
    const job = ctx.job.payload as unknown as RuntimeJob;
    if (!job || (job.kind !== 'scan' && job.kind !== 'reconcile')) throw new JobError(`job ${ctx.job.id} has no RuntimeJob payload`, 'validation', { code: 'bad_payload' });
    const outcome = await deps.scanner.executeJob(job, ctx.signal, { dbJobId: ctx.job.id });
    if (job.kind === 'scan') {
      // The job's first run adopted its Health "Rescan" placeholder (store startRun). Close any placeholder still
      // queued, so the UI never shows a run queued forever: no run started (no scanner for the connector, paused by
      // budget or auth; a retry gets its own run), or two Rescans merged into this one queued job.
      const why = outcome.runId ? `merged into scan run ${outcome.runId}` : redact(outcome.detail ?? outcome.status).text.slice(0, 300);
      // HYG-1: a job refused before any run (an unknown scope) fails its placeholder: it read nothing, so it is never
      // "succeeded" and never a quiet "cancelled"
      const refused = !outcome.runId && outcome.status === 'failed';
      await ctx.db.execute(sql`
        update scan_runs set status = ${refused ? 'failed' : 'cancelled'}, finished_at = ${ctx.clock().toISOString()}::timestamptz, error_message = ${why},
               error_code = ${refused ? (outcome.errorClass ?? 'config') : null}
         where owner_user_id = ${ctx.userId} and job_id = ${Number(ctx.job.id)} and status = 'queued'`);
    }
    if (outcome.followUps.length) await deps.queue.enqueue(outcome.followUps);
    if (outcome.retryAt && job.kind === 'scan') {
      await deps.queue.enqueue([retryJobOf(job, outcome)]);
    }
    if (deps.afterRun) {
      await deps.afterRun(job, outcome, ctx).catch((e) => ctx.log('afterRun failed', { code: (e as Error).name }));
    }
    return {
      status: outcome.status,
      runId: outcome.runId,
      connector: job.kind === 'scan' ? job.connector : undefined,
      scope: job.kind === 'scan' ? job.scope : undefined,
      mode: job.kind === 'scan' ? job.mode : 'reconcile',
      errorClass: outcome.errorClass,
      retryAt: outcome.retryAt,
      followUps: outcome.followUps.length,
      touched: outcome.touchedWorkItemIds?.length ?? 0,
      costUsd: outcome.costUsd ?? 0,
      detail: outcome.detail ? redact(outcome.detail).text.slice(0, 200) : undefined,
    };
  };
}
