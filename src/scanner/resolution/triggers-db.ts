/**
 * The resolution check's triggers on Postgres (R3): the scan-run hook, the nightly sweep and quiet selection, and the
 * recall sweep's thread rows. Reads only, plus `jobs` rows; never a source system. The rules themselves are pure
 * (triggers.ts) and shared with the in-memory pipeline.
 *
 *   enqueueResolutionTriggers(tx, user, runId)  after a scan run commits (DbScannerStore.finishRun): the run's new
 *                                                source items → triggersFor → one `resolution.check` per item
 *   selectSweepItems(db, user, now)              nightly: live items with no check in SWEEP_DAYS, and quiet ones
 *   myThreadRows(db, user, now)                  the recall sweep's channel threads (recall.ts threadsToFollow)
 */
import { sql } from 'drizzle-orm';

import { ResolutionEngineMode } from '@/contract';
import type { Db, DbOrTx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import type { ResolutionTrigger } from '@/engines/resolution/types';

import { RECALL_LOOKBACK_DAYS, RECALL_POLL_MS, type ThreadRow } from './recall';
import { SWEEP_DAYS, expectedWindowDays, isQuiet, triggerDedupeKey, triggersFor, type TriggerItem, type TriggerSource } from './triggers';

export const RESOLUTION_JOB_KIND = 'resolution.check';
/** The Settle queue (concurrency 1): the resolution check replaces Settle's decision, so it shares its lane. */
export const RESOLUTION_QUEUE = 'settle';
const DAY = 86_400_000;
type R = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
const lcArr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string' && !!x).map((x) => x.toLowerCase()) : []);

/** The conversation a source row lives in (as the in-memory store keys it): a DM by channel, else its thread ref. */
const CONV = (a: string) => sql.raw(`(case when ${a}.source = 'slack' and ${a}.meta->>'channelType' in ('im', 'mpim') then 'dm:' || (${a}.meta->>'channelId') else ${a}.external_parent_id end)`);
const AUTHOR_KEYS = (a: string) => sql.raw(`array_remove(array[lower(${a}.meta->'author'->>'externalId'), lower(${a}.meta->'author'->>'email'), lower(${a}.meta->'author'->>'name'), lower(${a}.actor_external_id)], null)`);

export async function resolutionEngineMode(db: DbOrTx, userId: string): Promise<ResolutionEngineMode> {
  const r = await db.execute<{ m: string | null }>(sql`select value->>'resolutionEngine' as m from user_settings where owner_user_id = ${userId} and key = 'settings.closing'`);
  const p = ResolutionEngineMode.safeParse(r.rows[0]?.m ?? 'shadow');
  return p.success ? p.data : 'shadow';
}

/** One `resolution.check` for an item: per item per 10 minutes (per day for a closed item). Returns whether queued. */
export async function enqueueResolutionCheck(db: DbOrTx, userId: string, itemId: string, trigger: ResolutionTrigger, now: Date, o: { closed?: boolean; delaySeconds?: number } = {}): Promise<boolean> {
  const r = await enqueueJob(db, {
    ownerUserId: userId,
    kind: RESOLUTION_JOB_KIND,
    queue: RESOLUTION_QUEUE,
    dedupeKey: `resolution.check:${itemId}`,
    idempotencyKey: `${userId}:${triggerDedupeKey(itemId, now, o.closed)}`,
    payload: { itemId, trigger },
    delaySeconds: o.delaySeconds ?? 30,
    maxAttempts: 2,
    timeoutSeconds: 600,
  });
  return r.inserted;
}

/** The sweep / recall jobs (one queued per user per slot). */
export async function enqueueResolutionSweep(db: DbOrTx, userId: string, trigger: 'sweep' | 'recall', now: Date): Promise<boolean> {
  const slot = trigger === 'recall' ? Math.floor(now.getTime() / RECALL_POLL_MS) : Math.floor(now.getTime() / DAY);
  const r = await enqueueJob(db, { ownerUserId: userId, kind: RESOLUTION_JOB_KIND, queue: RESOLUTION_QUEUE, dedupeKey: `resolution.${trigger}:${userId}`, idempotencyKey: `resolution.${trigger}:${userId}:${slot}`, payload: { trigger }, delaySeconds: 15, maxAttempts: 2, timeoutSeconds: 1800 });
  return r.inserted;
}

/** Live items and engine-closed items in the reopen window, as the trigger rules see them. */
export async function loadTriggerItems(db: DbOrTx, userId: string, now: Date, windowDays = 14): Promise<TriggerItem[]> {
  const from = new Date(now.getTime() - windowDays * DAY).toISOString();
  const rs = (
    await db.execute<R>(sql`
      select wi.id::text as id, wi.status::text as status, wi.title, wi.done_at, wi.done_by::text as done_by,
             (select min(o.occurred_at) from work_item_evidence e join source_items o on o.id = e.source_item_id where e.work_item_id = wi.id and e.role = 'origin') as ask_at,
             (select array_agg(distinct ${CONV('s')}) from work_item_evidence e join source_items s on s.id = e.source_item_id where e.work_item_id = wi.id and e.role <> 'context') as convs,
             (select array_agg(distinct r.value) from work_item_evidence e join source_item_refs r on r.source_item_id = e.source_item_id and r.kind = 'drive_file' where e.work_item_id = wi.id) as files,
             (select ${AUTHOR_KEYS('o')} from work_item_evidence e join source_items o on o.id = e.source_item_id where e.work_item_id = wi.id and e.role = 'origin' and not o.from_me order by o.occurred_at limit 1) as asker,
             (select array_agg(distinct coalesce(s.meta->>'sessionId', s.external_id)) from work_item_evidence e join source_items s on s.id = e.source_item_id where e.work_item_id = wi.id and s.source = 'claude') as sessions
        from work_items wi
       where wi.owner_user_id = ${userId} and wi.merged_into_id is null
         and (wi.status::text in ('open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done')
              or (wi.status = 'done' and wi.done_by = 'engine' and wi.done_at >= ${from}::timestamptz))
       order by wi.updated_at desc limit 800`)
  ).rows;
  return rs.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    title: String(r.title),
    doneAt: iso(r.done_at),
    doneBy: (r.done_by as string) ?? null,
    askAt: iso(r.ask_at) ?? new Date(0).toISOString(),
    conversationKeys: ((r.convs as Array<string | null>) ?? []).filter((x): x is string => !!x),
    fileRefs: ((r.files as string[]) ?? []).filter(Boolean),
    askerKeys: lcArr(r.asker),
    sessionIds: ((r.sessions as string[]) ?? []).filter(Boolean),
  }));
}

/** A scan run's new or changed source items, as the trigger rules see them. */
export async function loadRunSources(db: DbOrTx, userId: string, runId: string): Promise<TriggerSource[]> {
  const rs = (
    await db.execute<R>(sql`
      select s.id::text as id, s.source::text as connector, s.kind::text as kind, s.occurred_at, s.from_me, coalesce(s.addressed_to_me, false) as to_me,
             ${AUTHOR_KEYS('s')} as authors, ${CONV('s')} as conv,
             (select array_agg(lower(coalesce(p->>'externalId', p->>'email', p->>'name'))) from jsonb_array_elements(case when jsonb_typeof(s.meta->'participants') = 'array' then s.meta->'participants' when jsonb_typeof(s.meta->'to') = 'array' then s.meta->'to' else '[]'::jsonb end) p where coalesce((p->>'isMe')::boolean, false) = false) as recipients,
             (select array_agg(r.value) from source_item_refs r where r.source_item_id = s.id and r.kind = 'drive_file') as files,
             left(concat_ws(' ', s.title, s.body, s.meta->>'summary'), 2000) as text, s.meta->>'sessionId' as session_id
        from source_items s
       where s.owner_user_id = ${userId} and (s.first_scan_run_id = ${runId}::uuid or s.last_scan_run_id = ${runId}::uuid)
       limit 2000`)
  ).rows;
  return rs.map((r) => ({
    id: String(r.id),
    connector: String(r.connector) === 'claude' ? 'claude_sessions' : String(r.connector),
    kind: String(r.kind),
    occurredAt: iso(r.occurred_at)!,
    fromMe: !!r.from_me,
    authorKeys: lcArr(r.authors),
    addressedToMe: !!r.to_me,
    recipientKeys: lcArr(r.recipients),
    conversationKey: (r.conv as string) ?? null,
    fileRefs: ((r.files as string[]) ?? []).filter(Boolean),
    text: String(r.text ?? ''),
    sessionId: (r.session_id as string) ?? null,
  }));
}

/**
 * The scan-run hook: after a run commits, queue a check for every item its new lines trigger (and, for a Slack run,
 * the recall sweep's next slot). Off when the engine is `legacy`. Never throws into the scan: the caller wraps it.
 */
export async function enqueueResolutionTriggers(db: DbOrTx, userId: string, runId: string, now: Date, o: { connector?: string } = {}): Promise<{ queued: number; hits: number }> {
  if ((await resolutionEngineMode(db, userId)) === 'legacy') return { queued: 0, hits: 0 };
  const sources = await loadRunSources(db, userId, runId);
  if (o.connector === 'slack') await enqueueResolutionSweep(db, userId, 'recall', now);
  if (!sources.length) return { queued: 0, hits: 0 };
  const closing = (await db.execute<{ r: boolean | null }>(sql`select (value->>'reopenOnFollowUp')::boolean as r from user_settings where owner_user_id = ${userId} and key = 'settings.closing'`)).rows[0];
  const items = await loadTriggerItems(db, userId, now);
  const hits = triggersFor(items, sources, now, { reopenOnFollowUp: closing?.r ?? true });
  // New non-engine evidence on a live item from this run's lines (the scanner agent linked it).
  const evid = (
    await db.execute<{ id: string }>(sql`
      select distinct e.work_item_id::text as id from work_item_evidence e join work_items wi on wi.id = e.work_item_id
       where wi.owner_user_id = ${userId} and e.created_by <> 'engine' and e.role not in ('origin', 'context')
         and wi.status::text in ('open', 'in_progress', 'waiting_on_me', 'waiting_on_others')
         and e.source_item_id::text = any(${sql`array[${sql.join(sources.map((s) => sql`${s.id}`), sql`, `)}]::text[]`})`)
  ).rows.map((r) => r.id);
  const all = new Map(hits.map((h) => [h.itemId, h.trigger] as const));
  for (const id of evid) if (!all.has(id)) all.set(id, 'evidence');
  const closedIds = new Set(items.filter((i) => i.status === 'done').map((i) => i.id));
  let queued = 0;
  for (const [id, trigger] of all) if (await enqueueResolutionCheck(db, userId, id, trigger, now, { closed: closedIds.has(id) })) queued += 1;
  return { queued, hits: all.size };
}

/** Nightly: live items not checked in SWEEP_DAYS (`sweep`), and the ones gone quiet past their window (`quiet`). */
export async function selectSweepItems(db: Db, userId: string, now: Date, limit = 400): Promise<Array<{ id: string; trigger: ResolutionTrigger }>> {
  const rs = (
    await db.execute<R>(sql`
      select wi.id::text as id, wi.kind::text as kind, wi.due_at,
             (select min(o.occurred_at) from work_item_evidence e join source_items o on o.id = e.source_item_id where e.work_item_id = wi.id and e.role = 'origin') as ask_at,
             (select max(n.occurred_at) from work_item_evidence e join source_items o on o.id = e.source_item_id
                join source_items n on n.owner_user_id = wi.owner_user_id and ${CONV('n')} = ${CONV('o')}
               where e.work_item_id = wi.id and e.role = 'origin') as last_line_at,
             (select max(c.at) from closure_checks c where c.work_item_id = wi.id) as last_check_at
        from work_items wi
       where wi.owner_user_id = ${userId} and wi.merged_into_id is null
         and wi.status::text in ('open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done')
       order by wi.updated_at desc limit 2000`)
  ).rows;
  const out: Array<{ id: string; trigger: ResolutionTrigger }> = [];
  for (const r of rs) {
    const lastCheck = iso(r.last_check_at);
    const quiet = isQuiet({ kind: String(r.kind), askAt: iso(r.ask_at) ?? iso(now)!, dueAt: iso(r.due_at), lastLineAt: iso(r.last_line_at) }, now);
    // a quiet item is judged once per window, not every night
    const quietDue = quiet && (!lastCheck || now.getTime() - Date.parse(lastCheck) >= expectedWindowDays(String(r.kind)) * DAY);
    if (quietDue) out.push({ id: String(r.id), trigger: 'quiet' });
    else if (!lastCheck || now.getTime() - Date.parse(lastCheck) >= SWEEP_DAYS * DAY) out.push({ id: String(r.id), trigger: 'sweep' });
    if (out.length >= limit) break;
  }
  return out;
}

/** The recall sweep's rows: channel threads where I posted (or was mentioned) in the lookback. */
export async function myThreadRows(db: DbOrTx, userId: string, now: Date): Promise<ThreadRow[]> {
  const since = new Date(now.getTime() - RECALL_LOOKBACK_DAYS * DAY).toISOString();
  const rs = (
    await db.execute<R>(sql`
      with mine as (
        select s.meta->>'channelId' as channel_id, s.meta->>'channelType' as channel_type, coalesce(s.meta->>'threadTs', s.meta->>'ts') as thread_ts, max(s.occurred_at) as last_mine
          from source_items s
         where s.owner_user_id = ${userId} and s.source = 'slack' and s.occurred_at >= ${since}::timestamptz
           and coalesce(s.meta->>'channelType', 'channel') not in ('im', 'mpim')
           and (s.from_me or coalesce((s.meta->>'mentionsMe')::boolean, false))
           and s.meta->>'channelId' is not null and coalesce(s.meta->>'threadTs', s.meta->>'ts') is not null
         group by 1, 2, 3)
      select m.channel_id, m.channel_type, m.thread_ts, m.last_mine,
             (select max(n.occurred_at) from source_items n where n.owner_user_id = ${userId} and n.source = 'slack' and n.meta->>'channelId' = m.channel_id
                 and coalesce(n.meta->>'threadTs', n.meta->>'ts') = m.thread_ts) as last_at,
             (select n.meta->>'ts' from source_items n where n.owner_user_id = ${userId} and n.source = 'slack' and n.meta->>'channelId' = m.channel_id
                 and coalesce(n.meta->>'threadTs', n.meta->>'ts') = m.thread_ts order by n.occurred_at desc limit 1) as last_ts
        from mine m`)
  ).rows;
  return rs.map((r) => ({ channelId: String(r.channel_id), channelType: (r.channel_type as string) ?? 'channel', threadTs: String(r.thread_ts), lastMineAt: iso(r.last_mine)!, lastRecordedAt: iso(r.last_at) ?? iso(r.last_mine)!, lastRecordedTs: String(r.last_ts ?? r.thread_ts) }));
}
