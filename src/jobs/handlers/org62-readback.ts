/**
 * `org62.readback` (queue `maintenance`): HYG-1, the Org62 read-back reconcile. Daily at 06:40 local
 * (src/worker/schedules.ts) and on demand from Health ▸ Org62 ▸ "Re-check Org62 records" (POST /connectors/:id/scan
 * `{scope: "readback"}`, which queues this job and a placeholder scan run it adopts).
 *
 * Why: the windowed Org62 scans read by SystemModstamp, so an Event or DC edited in Org62 is read by the next poll
 * whose window holds the edit. A poll that never ran for that window (a bogus scope, a dead job, a laptop asleep past
 * the backfill limit) left the edit unread for good, and an Event deleted in Org62 was never read at all (a SOQL
 * window never returns a deleted row), so its app row stayed "verified". This pass re-reads, BY ID, every Event the
 * app has logged or verified this fiscal quarter and last, plus all my DCs (when DCs are active for the persona):
 *
 *   one `soqlQuery` per batch of 40 Ids through runOneReadLookup (the scanners' Org62 read allowlist, not widened;
 *   the same path as `forecast.sync`), the rows recorded as source items by the REC-2 recorder's mapping
 *   (org62RowToRaw: `Event:<Id>@<SystemModstamp>`, `Deal_Contribution__c:<Id>@<SystemModstamp>`) in one run on
 *   `org62:readback`. The projections then treat them like any scan: a changed SystemModstamp is a new snapshot,
 *   so `org62_events` / `deal_contributions` update and a verified row adopts the edit (ReadbackMove.adopt).
 *
 *   An Id asked for and not returned by a complete answer was deleted in Org62: its source items and its
 *   `org62_events` row get `deleted_upstream_at` (DCs: the projection then marks `deal_contributions`), and the weeks
 *   of those Events are recomputed, where a verified or logged app row moves to verify_failed "Deleted in Org62"
 *   (src/projections/run.ts projectWeek). Never silently "verified".
 *
 * D-67 (when the persona's `vdp` feature is active): the Use_Case__c records on my open opps (and on the opps of records
 * the app linked), one `soqlQuery` per 20 opps, stored in `org62_use_cases` (store/use-cases.ts saveOrg62UseCaseRead),
 * which then ties them to VDP use cases. Not recorded as source items: nothing else projects them. A record a complete
 * batch no longer returns is marked gone (deleted or moved off my opps), never deleted from the app.
 *
 * Live reads run only in the launchd worker (CC_LIVE / NODE_ENV=production) unless a test injects the lookup.
 * jobs.result holds counts and codes only, never subjects or names.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import type { Db, DbOrTx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { localDay } from '@/engines/activity/time';
import { normalizeItem } from '@/llm/cc-tools';
import { org62RowToRaw, soqlRecords } from '@/llm/org62-rec';
import { featureActive } from '@/personas';
import { DELETED_IN_ORG62_ISSUE, fiscalQuarterStart, recomputeWeeks } from '@/projections/run';
import { ORG62_READBACK_SCOPE } from '@/scanner/scope-catalog';
import { DbScannerStore } from '@/scanner/store-db';
import type { NormalizedSourceItem, ScannerStore } from '@/scanner/types';
import { liveOrg62 } from '@/server/chat/record-type';
import { loadKv } from '@/server/datasource/db/ext';
import { markOppsDeleted, oppReadbackSoql, readbackOppIds } from '@/server/datasource/db/store/deals-sync';
import { loadPersona } from '@/server/datasource/db/store/persona';
import { loadSettingsSections } from '@/server/datasource/db/store/settings';
import { saveOrg62UseCaseRead, ucReadOppIds, type Org62UseCaseRow } from '@/server/datasource/db/store/use-cases';
import { runOneReadLookup, type OneLookupResult } from '@/server/onboarding/identity';

import { JobError, type JobContext, type JobHandlerDef } from '../types';
import { relayGuard, type RelayGuard } from './relay-guard';
import { insertLlmCall, ledgerHash } from '@/db/ledger';
import { syncLandingsForUser } from '@/server/landings/db-sync';
import { projectionStore } from '@/server/datasource/db/store/projections.run';

export const ORG62_READBACK_JOB = 'org62.readback';
export const ORG62_READBACK_QUEUE = 'maintenance';
export const ORG62_READBACK_SKILL = 'skills/read-lookup.md';
/** Ids per `IN (…)`: 40 Event rows are about 33K characters, well under the tool's output cap (ORG-1). */
export const READBACK_BATCH = 40;
/** D-65: Events carry Description now (its CC# key): 25 per batch stay well under the cap. */
export const EVENT_READBACK_BATCH = 25;
const batchOf = (object: 'Event' | 'Deal_Contribution__c' | 'Opportunity') => (object === 'Event' ? EVENT_READBACK_BATCH : READBACK_BATCH);
/** The verify issue an app row carries when its Org62 Event was deleted there (set by projectWeek). */
export const DELETED_IN_ORG62 = DELETED_IN_ORG62_ISSUE;

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const id15 = (s: string) => s.slice(0, 15);
/** A text[] literal of these values (empty: an empty array). */
const textArr = (vals: readonly string[]) => (vals.length ? sql`array[${sql.join(vals.map((v) => sql`${v}::text`), sql`, `)}]` : sql`array[]::text[]`);

const EVENT_FIELDS = 'Id, Subject, StartDateTime, EndDateTime, DurationInMinutes, Duration__c, SE_Task_Type__c, Meeting_Type__c, RecordType.Name, WhatId, What.Name, What.Type, AccountId, IsChild, Description, CreatedDate, SystemModstamp';
const DC_FIELDS = 'Id, Opportunity__c, Opportunity__r.Name, Opportunity__r.AccountId, Opportunity__r.StageName, Opportunity__r.CloseDate, Opportunity__r.IsClosed, Opportunity__r.IsWon, SE_Name__c, Opportunity_Role__c, Split_Percentage__c, SystemModstamp';

/** D-67: opps per Use_Case__c read, and the row cap of one (teammates average ~5 use cases per opp). */
export const USE_CASE_BATCH = 20;
export const USE_CASE_LIMIT = 200;
const USE_CASE_FIELDS = 'Id, Name, OwnerId, CreatedById, CreatedDate, Opportunity__c, Account__c, Use_Case_Name__c, Product__c, Stage__c, Go_Live_Date__c, SystemModstamp';

/** The fixed SOQL of one Use_Case__c batch: every use case on these opps (validated Salesforce ids, quoted). */
export function ucReadbackSoql(oppIds: readonly string[]): string {
  const safe = oppIds.filter((i) => SF_ID.test(i) && i.startsWith('006'));
  if (!safe.length) throw new RangeError('ucReadbackSoql: no valid opportunity ids');
  return `SELECT ${USE_CASE_FIELDS} FROM Use_Case__c WHERE Opportunity__c IN (${safe.map((i) => `'${i}'`).join(', ')}) ORDER BY Id LIMIT ${USE_CASE_LIMIT}`;
}

/** The fixed SOQL of one batch: the Ids are validated Salesforce ids (never free text), quoted. */
export function readbackSoql(object: 'Event' | 'Deal_Contribution__c', ids: readonly string[]): string {
  const safe = ids.filter((i) => SF_ID.test(i));
  if (!safe.length) throw new RangeError('readbackSoql: no valid ids');
  const list = safe.map((i) => `'${i}'`).join(', ');
  return object === 'Event'
    ? `SELECT ${EVENT_FIELDS} FROM Event WHERE Id IN (${list}) ORDER BY Id LIMIT ${EVENT_READBACK_BATCH + 10}`
    : `SELECT ${DC_FIELDS} FROM Deal_Contribution__c WHERE Id IN (${list}) ORDER BY Id LIMIT ${READBACK_BATCH + 10}`;
}

/** Queue one read-back (one queued per user: a second "Re-check" while one waits is the same job). */
export async function enqueueOrg62Readback(db: DbOrTx, userId: string, o: { trigger: 'manual' | 'chat' | 'schedule' | 'start' }): Promise<{ id: number; inserted: boolean }> {
  return enqueueJob(db, { ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: ORG62_READBACK_QUEUE, payload: { trigger: o.trigger }, dedupeKey: `org62.readback:${userId}`, maxAttempts: 3, timeoutSeconds: 900 });
}

export interface ReadbackDeps {
  lookup?: typeof runOneReadLookup;
  live?: boolean;
  store?: (ctx: JobContext) => ScannerStore;
  /** D6: the budget guard (tests pass one that never refuses, or one that does). */
  guard?: (ctx: JobContext) => RelayGuard;
}

let deps: ReadbackDeps = {};
export function configureOrg62Readback(d: ReadbackDeps): void {
  deps = { ...deps, ...d };
}
export function resetOrg62ReadbackConfig(): void {
  deps = {};
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The Event ids the app logged or verified this fiscal quarter and last (still live in the app). */
export async function readbackEventIds(db: DbOrTx, userId: string, from: string): Promise<string[]> {
  const r = await db.execute<{ id: string }>(sql`
    select distinct e.org62_event_id as id
      from activity_entries a join org62_events e on e.id = a.org62_event_row_id
     where a.owner_user_id = ${userId} and e.owner_user_id = ${userId} and e.deleted_upstream_at is null
       and a.status in ('logged', 'verified', 'verify_failed') and e.starts_at >= ${from}::timestamptz
     order by 1`);
  return r.rows.map((x) => x.id).filter((i) => SF_ID.test(i));
}

export async function readbackDcIds(db: DbOrTx, userId: string): Promise<string[]> {
  const r = await db.execute<{ id: string }>(sql`
    select org62_dc_id as id from deal_contributions where owner_user_id = ${userId} and is_mine and deleted_upstream_at is null order by 1`);
  return r.rows.map((x) => x.id).filter((i) => SF_ID.test(i));
}

/** Mark Org62 records deleted upstream: their snapshots (so no projection brings them back) and their Event rows. */
export async function markOrg62Deleted(db: Db, userId: string, gone: { events: string[]; dcs: string[] }, now: Date): Promise<{ sourceItems: number; events: number; eventDays: string[] }> {
  const ev15 = gone.events.map(id15);
  const dc15 = gone.dcs.map(id15);
  if (!ev15.length && !dc15.length) return { sourceItems: 0, events: 0, eventDays: [] };
  const { result } = await withChangeSet({ db, userId, actor: actors.system(ORG62_READBACK_JOB), reason: `Org62 read-back: ${ev15.length} Event${ev15.length === 1 ? '' : 's'} and ${dc15.length} DC${dc15.length === 1 ? '' : 's'} deleted in Org62`, undoable: false }, async (tx) => {
    const objId = sql`left(split_part(split_part(si.external_id, ':', 2), '@', 1), 15)`;
    const si = await tx.execute(sql`
      update source_items si set deleted_upstream_at = ${now.toISOString()}::timestamptz, updated_at = now()
       where si.owner_user_id = ${userId} and si.source = 'org62' and si.deleted_upstream_at is null
         and ((si.external_id like 'Event:%' and ${objId} = any(${textArr(ev15)}))
           or ((si.external_id like 'Deal\\_Contribution\\_\\_c:%' or si.external_id like 'BookDc:%') and ${objId} = any(${textArr(dc15)})))`);
    const ev = await tx.execute<{ starts_at: Date | string }>(sql`
      update org62_events set deleted_upstream_at = ${now.toISOString()}::timestamptz
       where owner_user_id = ${userId} and deleted_upstream_at is null and left(org62_event_id, 15) = any(${textArr(ev15)})
      returning starts_at`);
    return { sourceItems: si.rowCount ?? 0, events: ev.rowCount ?? 0, starts: ev.rows.map((x) => new Date(x.starts_at).toISOString()) };
  });
  const tz = (await loadSettingsSections({ db, userId })).profile?.timezone ?? 'America/Denver';
  return { sourceItems: result.sourceItems, events: result.events, eventDays: [...new Set(result.starts.map((s) => localDay(Date.parse(s), tz)))].sort() };
}

async function recordSpend(ctx: JobContext, day: string, r: OneLookupResult, what: string, ms: number, q: string) {
  if (!r.model || !r.started) return;
  const finished = new Date();
  await insertLlmCall(ctx.db, {
    ownerUserId: ctx.userId,
    purpose: 'other',
    model: r.model,
    skillKey: 'org62-readback',
    promptVersion: what,
    requestHash: `org62-readback:${ctx.job.id}:${randomUUID()}`,
    jobId: ctx.job.id,
    status: r.text !== null ? 'ok' : r.code === 'timeout' ? 'timeout' : 'error',
    errorCode: r.text === null ? r.code : null,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    cacheWriteTokens: r.cacheWriteTokens ?? 0,
    costUsd: r.costUsd,
    latencyMs: ms,
    budgetDay: day,
    startedAt: new Date(finished.getTime() - ms),
    finishedAt: finished,
    rollup: false,
    trigger: typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : 'schedule',
    modelReason: 'default',
    contentHash: ledgerHash(r.model, 'soqlQuery', q),
    outcome: r.text !== null ? 'ok' : r.code,
  });
}

export interface ReadbackResult {
  skipped?: string;
  events: number;
  eventsRead: number;
  eventsDeleted: number;
  dcs: number;
  dcsRead: number;
  dcsDeleted: number;
  /** DC-22: open opps of a DC question re-read by Id, and the ones Org62 no longer has (tombstoned). */
  opps?: number;
  oppsDeleted?: number;
  recorded: number;
  new: number;
  changed: number;
  lookups: number;
  failedBatches: number;
  weeks: number;
  /** D-67: opps whose use cases were read, records read, marked gone, newly linked to a VDP use case. */
  useCaseOpps: number;
  useCasesRead: number;
  useCasesGone: number;
  useCasesLinked: number;
  costUsd: number;
  /** TL-42: every batch failed (nothing read, nothing inferred): the scan run failed with this class. */
  failed?: 'auth' | 'transient';
  /** Batches this leg did not read (an earlier leg read them, or the job paused at its spend estimate): nothing inferred. */
  skippedBatches?: number;
  /** The job passed its hold and asked (relay-guard.ts): its continuation reads from where this leg stopped. */
  paused?: 'spend';
  holdId?: string;
  queued?: boolean;
}

export async function runOrg62Readback(ctx: JobContext, d: ReadbackDeps = deps): Promise<ReadbackResult> {
  const zero: ReadbackResult = { events: 0, eventsRead: 0, eventsDeleted: 0, dcs: 0, dcsRead: 0, dcsDeleted: 0, recorded: 0, new: 0, changed: 0, lookups: 0, failedBatches: 0, weeks: 0, useCaseOpps: 0, useCasesRead: 0, useCasesGone: 0, useCasesLinked: 0, costUsd: 0 };
  const persona = await loadPersona(ctx.db, ctx.userId);
  if (!persona.connectors.includes('org62')) return { ...zero, skipped: 'inactive' };
  const live = d.live ?? (!!d.lookup || liveOrg62());
  if (!live) return { ...zero, skipped: 'not_live' };
  const now = ctx.clock();
  const tz = (await loadSettingsSections({ db: ctx.db, userId: ctx.userId })).profile?.timezone ?? 'America/Denver';
  const q = fiscalQuarterStart(now, tz);
  const [y, m] = q.split('-').map(Number) as [number, number];
  const lastQ = new Date(Date.UTC(y, m - 1 - 3, 1)).toISOString(); // a day early in the west: a wider net, never narrower
  const events = await readbackEventIds(ctx.db, ctx.userId, lastQ);
  const dcs = featureActive(persona, 'dealContributions') ? await readbackDcIds(ctx.db, ctx.userId) : [];
  const ucOpps = featureActive(persona, 'vdp') ? await ucReadOppIds(ctx.db, ctx.userId) : [];
  // DC-22: the opps a DC question hangs on, so one deleted in Org62 is tombstoned, never a gap
  const opps = featureActive(persona, 'dealContributions') ? await readbackOppIds(ctx.db, ctx.userId) : [];
  const res: ReadbackResult = { ...zero, events: events.length, dcs: dcs.length, useCaseOpps: ucOpps.length, opps: opps.length, oppsDeleted: 0 };
  if (!events.length && !dcs.length && !ucOpps.length && !opps.length) return res;

  // one hold per job (the start gate's): every lookup books into it; past it the job asks once, keeps what it read, and
  // its continuation reads on from the batch this leg stopped at (`vars.relayDone`), on the same hold
  const guard = d.guard?.(ctx) ?? relayGuard(ctx, 'org62-readback');
  const early = await guard.start?.();
  if (early) return { ...res, ...early } as ReadbackResult;
  try {
    return await readBack(ctx, d, { res, guard, now, tz, events, dcs, opps, ucOpps });
  } finally {
    await guard.finish?.().catch(() => undefined);
  }
}

async function readBack(
  ctx: JobContext,
  d: ReadbackDeps,
  { res, guard, now, tz, events, dcs, opps, ucOpps }: { res: ReadbackResult; guard: RelayGuard; now: Date; tz: string; events: string[]; dcs: string[]; opps: string[]; ucOpps: string[] },
): Promise<ReadbackResult> {
  const store = d.store?.(ctx) ?? new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
  const at = now.toISOString();
  const { runId } = await store.startRun({ scope: { connector: 'org62', scope: ORG62_READBACK_SCOPE }, trigger: 'reconcile', window: { from: at, to: at }, model: 'haiku', jobId: ctx.job.id });
  const lookup = d.lookup ?? runOneReadLookup;
  // the batches in order; a continuation skips the ones its earlier legs read
  const plan = [['Event', events], ['Deal_Contribution__c', dcs], ['Opportunity', opps]] as const;
  const total = plan.reduce((n, [object, ids]) => n + Math.ceil(ids.length / batchOf(object)), 0) + Math.ceil(ucOpps.length / USE_CASE_BATCH);
  const skipTo = guard.resumeAt ?? 0;
  let pos = 0;
  let paused = false;
  const skip = (): boolean => {
    const at = pos++;
    if (!paused && at >= skipTo) return false;
    res.skippedBatches = (res.skippedBatches ?? 0) + 1;
    return true;
  };
  const day = localDay(now.getTime(), tz);
  const gone = { events: [] as string[], dcs: [] as string[], opps: [] as string[] };
  const failCodes: string[] = [];
  const ucRows: Org62UseCaseRow[] = [];
  const ucComplete: string[] = [];
  let ucAllComplete = true;
  try {
    for (const [object, ids] of plan) {
      for (const batch of chunks(ids, batchOf(object))) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
        if (skip()) continue;
        const t0 = Date.now();
        const q = object === 'Opportunity' ? oppReadbackSoql(batch, READBACK_BATCH + 10) : readbackSoql(object, batch);
        // D6: the lookup holds its cost cap against the daily hard cap; a refused batch infers nothing (like a failed one).
        const r = await guard.run(async () => {
          const r = await lookup({ connector: 'org62', tool: 'soqlQuery', args: { q } }, { skillPath: ORG62_READBACK_SKILL, timeoutMs: 90_000 });
          await recordSpend(ctx, day, r, object, Date.now() - t0, q).catch(() => undefined);
          return r;
        }, { pctDone: (100 * (pos - 1)) / total });
        if (!r && guard.stop === 'spend') {
          paused = true;
          res.skippedBatches = (res.skippedBatches ?? 0) + 1;
          continue;
        }
        if (!r) {
          res.failedBatches += 1;
          failCodes.push('hard_cap');
          continue;
        }
        res.lookups += 1;
        res.costUsd += r.costUsd;
        void ctx.heartbeat().catch(() => undefined);
        if (r.code === 'disallowed_tool') throw new JobError('the read-back tried a tool outside the read-only allowlist', 'bug', { code: r.code });
        const rows = r.text === null ? null : soqlRecords(r.text);
        // an answer that is not a complete result (an error, cut short, more pages) reads what it holds and infers nothing
        const complete = rows !== null && (JSON.parse(r.text!) as { done?: unknown }).done !== false && rows.length < batchOf(object) + 10;
        if (!rows) {
          res.failedBatches += 1;
          failCodes.push(r.code);
          continue;
        }
        const items: NormalizedSourceItem[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
          const raw = org62RowToRaw(row);
          const id = typeof row.Id === 'string' ? row.Id : null;
          if (id) seen.add(id15(id));
          if (!raw) continue;
          items.push(normalizeItem('org62', raw));
        }
        if (object === 'Event') res.eventsRead += seen.size;
        else if (object === 'Deal_Contribution__c') res.dcsRead += seen.size;
        for (let i = 0; i < items.length; i += 50) {
          const out = await store.recordSourceItems(runId, items.slice(i, i + 50));
          for (const o of out) {
            res.recorded += 1;
            if (o.isNew) res.new += 1;
            if (o.changed) res.changed += 1;
          }
        }
        if (!complete) {
          res.failedBatches += 1;
          continue;
        }
        for (const id of batch) if (!seen.has(id15(id))) (object === 'Event' ? gone.events : object === 'Deal_Contribution__c' ? gone.dcs : gone.opps).push(id);
      }
    }
    // D-67: the use cases on my opps (by opp, not by Id: a new record has no Id the app knows yet)
    for (const batch of chunks(ucOpps, USE_CASE_BATCH)) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
      if (skip()) {
        ucAllComplete = false;
        continue;
      }
      const t0 = Date.now();
      const q = ucReadbackSoql(batch);
      const r = await guard.run(async () => {
        const r = await lookup({ connector: 'org62', tool: 'soqlQuery', args: { q } }, { skillPath: ORG62_READBACK_SKILL, timeoutMs: 90_000 });
        await recordSpend(ctx, day, r, 'Use_Case__c', Date.now() - t0, q).catch(() => undefined);
        return r;
      }, { pctDone: (100 * (pos - 1)) / total });
      if (!r && guard.stop === 'spend') {
        paused = true;
        res.skippedBatches = (res.skippedBatches ?? 0) + 1;
        ucAllComplete = false;
        continue;
      }
      if (!r) {
        res.failedBatches += 1;
        failCodes.push('hard_cap');
        ucAllComplete = false;
        continue;
      }
      res.lookups += 1;
      res.costUsd += r.costUsd;
      void ctx.heartbeat().catch(() => undefined);
      if (r.code === 'disallowed_tool') throw new JobError('the read-back tried a tool outside the read-only allowlist', 'bug', { code: r.code });
      const rows = r.text === null ? null : soqlRecords(r.text);
      if (!rows) {
        res.failedBatches += 1;
        failCodes.push(r.code);
        ucAllComplete = false;
        continue;
      }
      for (const row of rows) if (typeof row.Id === 'string') ucRows.push(row as unknown as Org62UseCaseRow);
      const complete = (JSON.parse(r.text!) as { done?: unknown }).done !== false && rows.length < USE_CASE_LIMIT;
      if (complete) ucComplete.push(...batch);
      else {
        res.failedBatches += 1;
        ucAllComplete = false;
      }
    }
  } catch (err) {
    await store.failRun(runId, { error: String((err as Error)?.message ?? err).slice(0, 200), errorClass: 'transient', stats: { fetched: res.recorded + ucRows.length, new: res.new, costUsd: res.costUsd } }).catch(() => undefined);
    throw err;
  }
  // TL-42: every batch failed (a lapsed token, Org62 down): the run fails, so Health shows the connector degraded, and
  // nothing is inferred (no Event is marked deleted, no row moves). Before, the run was "succeeded" with nothing read.
  if (res.lookups > 0 && res.failedBatches === res.lookups && res.recorded === 0 && ucRows.length === 0) {
    const auth = failCodes.some((c) => /auth|401|403|expired|session|login|unauthor/i.test(c));
    const cls = auth ? 'auth' : 'transient';
    await store.failRun(runId, { error: `every Org62 read-back batch failed (${res.failedBatches}: ${[...new Set(failCodes)].join(', ').slice(0, 80)}): nothing read, nothing inferred`, errorClass: cls, stats: { fetched: 0, new: 0, costUsd: res.costUsd } });
    return { ...res, failed: cls, costUsd: Math.round(res.costUsd * 10_000) / 10_000, ...((await guard.finish?.()) ?? {}) };
  }
  await store.finishRun(runId, { cursor: { value: ORG62_READBACK_SCOPE, at }, stats: { fetched: res.recorded + ucRows.length, new: res.new, changed: res.changed, linked: 0, proposed: 0, unlinked: 0, costUsd: res.costUsd, inputTokens: 0, outputTokens: 0, turns: res.lookups } });
  if (ucOpps.length && (ucRows.length || ucComplete.length)) {
    const u = await saveOrg62UseCaseRead(ctx.db, ctx.userId, { rows: ucRows, completeOpps: ucComplete, opps: ucOpps.length, complete: ucAllComplete, at: now });
    res.useCasesRead = u.written;
    res.useCasesGone = u.gone;
    res.useCasesLinked = u.linked;
  }
  const marked = await markOrg62Deleted(ctx.db, ctx.userId, gone, now);
  res.eventsDeleted = gone.events.length;
  res.dcsDeleted = gone.dcs.length;
  if (gone.opps.length) res.oppsDeleted = await tombstoneOpps(ctx, gone.opps, now);
  if (marked.eventDays.length) {
    const w = await recomputeWeeks({ store: projectionStore(ctx.db), userId: ctx.userId, days: marked.eventDays, now });
    res.weeks = w.weeks.length;
  }
  res.costUsd = Math.round(res.costUsd * 10_000) / 10_000;
  return { ...res, ...((await guard.finish?.()) ?? {}) };
}

/** DC-22: the opps Org62 no longer has, tombstoned in one system change set (dc-roundtrip's `markOppsDeleted`). */
async function tombstoneOpps(ctx: JobContext, ids: readonly string[], now: Date): Promise<number> {
  const { result } = await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.system(ORG62_READBACK_JOB), reason: `Org62 read-back: ${ids.length} opportunit${ids.length === 1 ? 'y' : 'ies'} deleted in Org62`, undoable: false }, async (tx, cs) => {
    const me = await tx.execute<{ person_id: string | null; name: string | null; tz: string | null }>(sql`select person_id, display_name as name, timezone as tz from users where id = ${ctx.userId}`);
    const m = me.rows[0];
    const w = { tx, cs, userId: ctx.userId, me: { id: m?.person_id ?? ctx.userId, name: m?.name ?? 'me' }, now, extractorId: '', timezone: m?.tz ?? 'America/Denver', kv: await loadKv(tx, ctx.userId) };
    await markOppsDeleted(w, ids);
    return ids.length;
  });
  return result;
}

export function org62ReadbackJobDef(d?: ReadbackDeps): JobHandlerDef {
  return {
    kind: ORG62_READBACK_JOB,
    queue: ORG62_READBACK_QUEUE,
    wired: true,
    spends: true,
    description: 'Org62 read-back: re-read my logged Events and my DCs by Id (edits, deletions), and the use cases on my opps (D-67), daily and from Health',
    handler: async (ctx) => {
      const r = await runOrg62Readback(ctx, d ?? deps);
      // a Health placeholder this job did not adopt (two clicks merged into one queued job) never stays queued
      await ctx.db.execute(sql`
        update scan_runs set status = 'cancelled', finished_at = now(),
               error_message = ${r.skipped ? `Org62 read-back skipped: ${r.skipped}` : 'merged into the read-back run'}
         where owner_user_id = ${ctx.userId} and job_id = ${Number(ctx.job.id)} and status = 'queued'`);
      // D-70: what the read-back found reaches the landings now (verified · missing · differs), not at the next page load
      if (!r.skipped && !r.failed) await syncLandingsForUser(ctx.db as Db, ctx.userId, ctx.clock());
      // TL-42: the scan run failed (Health shows it); the job fails too, with the class that says why
      if (r.failed) throw new JobError(`every Org62 read-back batch failed (${r.failedBatches}): nothing read, nothing inferred`, r.failed, { code: 'readback_failed' });
      return { ...r };
    },
  };
}
