/**
 * `kv.backfill` (queue `maintenance`): D-98 / 0036, the data half of the kv side-car → columns migration
 * (docs/DATA-MIGRATIONS.md). The migration only adds columns and tables; this job copies what the old build kept in
 * `user_settings` into them, per user, in chunks:
 *
 *   ext:<table>.<field>   a promoted ext field (store/sidecar.ts PROMOTED) → its column, where the column is still empty
 *   need_decisions        `cc.need/<rule>/<subject>` → need_decisions rows
 *   canvas_row_overrides  the `canvas.row_overrides` map → one row per row key
 *   vdp_children          a VDP mirrored before 0036 → its use case, asset and member rows (from `detail`)
 *   message_landings      a Slack / Gmail item delivered before 0036 → its landing (origin `backfill`)
 *
 * Idempotent (every step copies only where the target is still empty and never overwrites), chunked (500 rows per
 * change set, so no long lock), resumable (the cursor and counts live in `data_backfills`; a stopped run continues at
 * the family and row it reached). It never deletes the kv: the old build reads it after a rollback, and the readers
 * fall back to it until this reports done. Counts only in jobs.result and logs.
 *
 * Runs once after migrate: the worker queues it at start (it returns at once when done), `npm run db:backfill`
 * runs it by hand (`-- --dry` prints the plan), and `npm run db:backfill -- --queue` is the update path's hook.
 */
import { sql, type SQL } from 'drizzle-orm';

import { NeedDecision } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db, DbOrTx, Tx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { rowOverridesOf, ROW_OVERRIDES_KV } from '@/lib/canvas/overrides';
import type { VdpSnapshot } from '@/lib/vdp/types';
import { NEED_KV_PREFIX } from '@/server/datasource/db/needs-decisions';
import { MESSAGE_RECORD_KIND } from '@/server/datasource/db/store/landings';
import { PROMOTED, type PromotedField } from '@/server/datasource/db/store/sidecar';
import { writeVdpChildren } from '@/server/datasource/db/vdp-mirror';

import type { JobHandlerDef } from '../types';

export const KV_BACKFILL_KIND = 'kv.backfill';
export const KV_BACKFILL_QUEUE = 'maintenance';
export const KV_BACKFILL_NAME = '0036_sidecar_columns';
export const KV_BACKFILL_CHUNK = 500;

export interface BackfillFamily {
  id: string;
  /** Rows still to copy (the dry run's plan, and Doctor's DATA.KV.FALLBACK). */
  pending(db: DbOrTx, userId: string): Promise<number>;
  /** Copy up to `limit` rows after the cursor; `last` is the new cursor, null when the family is done. */
  step(tx: Tx, userId: string, after: string | null, limit: number): Promise<{ copied: number; last: string | null }>;
}

// ---------------------------------------------------------------------------
// Promoted ext fields → columns
// ---------------------------------------------------------------------------

const v = (f: PromotedField): SQL => sql`s.value -> ${f.field}`;
const vt = (f: PromotedField): SQL => sql`s.value ->> ${f.field}`;
const col = (f: PromotedField): SQL => sql`t.${sql.identifier(f.column)}`;

/** The kv holds a value the column can take, and the column is still empty. */
function pendingWhere(f: PromotedField): SQL {
  switch (f.type) {
    case 'bool':
      return sql`${vt(f)} = 'true' and not ${col(f)}`;
    case 'text':
      return sql`jsonb_typeof(${v(f)}) in ('string', 'number', 'boolean') and ${col(f)} is null`;
    case 'text[]':
      return sql`jsonb_typeof(${v(f)}) = 'array' and jsonb_array_length(${v(f)}) > 0 and ${col(f)} is null`;
    case 'uuid':
      return sql`${vt(f)} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and ${col(f)} is null`;
    case 'tstz':
      return sql`${vt(f)} ~ '^\\d{4}-\\d{2}-\\d{2}' and ${col(f)} is null`;
    case 'jsonb':
      return sql`jsonb_typeof(${v(f)}) is not null and jsonb_typeof(${v(f)}) <> 'null' and ${col(f)} is null`;
  }
}

function valueExpr(f: PromotedField): SQL {
  switch (f.type) {
    case 'bool':
      return sql`true`;
    case 'text':
      return vt(f);
    case 'text[]':
      return sql`array(select jsonb_array_elements_text(${v(f)}))`;
    case 'uuid':
      return sql`(${vt(f)})::uuid`;
    case 'tstz':
      return sql`(${vt(f)})::timestamptz`;
    case 'jsonb':
      return v(f);
  }
}

function extFamily(table: string, f: PromotedField): BackfillFamily {
  const t = sql.identifier(table);
  const join = sql`join user_settings s on s.owner_user_id = t.owner_user_id and s.key = ${`cc.ext/${table}/`} || t.id::text`;
  return {
    id: `ext:${table}.${f.field}`,
    async pending(db, userId) {
      const r = await db.execute<{ n: string }>(sql`select count(*)::text as n from ${t} t ${join} where t.owner_user_id = ${userId}::uuid and ${pendingWhere(f)}`);
      return Number(r.rows[0]?.n ?? 0);
    },
    async step(tx, userId, after, limit) {
      const ids = await tx.execute<{ id: string }>(sql`
        select t.id::text as id from ${t} t ${join}
         where t.owner_user_id = ${userId}::uuid and ${pendingWhere(f)} ${after ? sql`and t.id::text > ${after}` : sql``}
         order by t.id::text limit ${limit}`);
      if (!ids.rows.length) return { copied: 0, last: null };
      const list = sql.join(
        ids.rows.map((x) => sql`${x.id}`),
        sql`, `,
      );
      const r = await tx.execute(sql`
        update ${t} as t set ${sql.identifier(f.column)} = ${valueExpr(f)}
          from user_settings s
         where s.owner_user_id = t.owner_user_id and s.key = ${`cc.ext/${table}/`} || t.id::text
           and t.owner_user_id = ${userId}::uuid and t.id::text in (${list}) and ${pendingWhere(f)}`);
      return { copied: r.rowCount ?? 0, last: ids.rows.length < limit ? null : ids.rows.at(-1)!.id };
    },
  };
}

// ---------------------------------------------------------------------------
// Tables: need decisions, canvas row overrides
// ---------------------------------------------------------------------------

const needFamily: BackfillFamily = {
  id: 'need_decisions',
  async pending(db, userId) {
    const r = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from user_settings s
       where s.owner_user_id = ${userId}::uuid and s.key like 'cc.need/%'
         and not exists (select 1 from need_decisions d where d.owner_user_id = s.owner_user_id and s.key = ${NEED_KV_PREFIX} || d.rule || '/' || d.subject_id)`);
    return Number(r.rows[0]?.n ?? 0);
  },
  async step(tx, userId, after, limit) {
    const rows = await tx.execute<{ key: string; value: unknown }>(sql`
      select key, value from user_settings where owner_user_id = ${userId}::uuid and key like 'cc.need/%' ${after ? sql`and key > ${after}` : sql``}
       order by key limit ${limit}`);
    let copied = 0;
    for (const r of rows.rows) {
      const d = NeedDecision.safeParse(r.value);
      if (!d.success) continue;
      const x = d.data;
      const res = await tx.execute(sql`
        insert into need_decisions (owner_user_id, rule, subject_id, kind, until, reason, label, baseline, decided_at)
        values (${userId}::uuid, ${x.rule}, ${x.subjectId}, ${x.kind}, ${x.until}::timestamptz, ${x.reason}, ${x.label}, ${JSON.stringify(x.baseline ?? {})}::jsonb, ${x.decidedAt}::timestamptz)
        on conflict (owner_user_id, rule, subject_id) do nothing`);
      copied += res.rowCount ?? 0;
    }
    return { copied, last: rows.rows.length < limit ? null : rows.rows.at(-1)!.key };
  },
};

async function oldOverrides(db: DbOrTx, userId: string) {
  const r = await db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId}::uuid and key = ${ROW_OVERRIDES_KV}`);
  return rowOverridesOf(r.rows[0]?.value);
}

const overridesFamily: BackfillFamily = {
  id: 'canvas_row_overrides',
  async pending(db, userId) {
    const old = await oldOverrides(db, userId);
    const keys = Object.keys(old);
    if (!keys.length) return 0;
    const have = await db.execute<{ row_key: string }>(sql`select row_key from canvas_row_overrides where owner_user_id = ${userId}::uuid`);
    const got = new Set(have.rows.map((x) => x.row_key));
    return keys.filter((k) => !got.has(k)).length;
  },
  async step(tx, userId) {
    const old = await oldOverrides(tx, userId);
    let copied = 0;
    for (const [key, o] of Object.entries(old)) {
      const res = await tx.execute(sql`
        insert into canvas_row_overrides (owner_user_id, row_key, fields, edited_at) values (${userId}::uuid, ${key}, ${JSON.stringify(o.fields)}::jsonb, ${o.at})
        on conflict (owner_user_id, row_key) do nothing`);
      copied += res.rowCount ?? 0;
    }
    return { copied, last: null };
  },
};

// ---------------------------------------------------------------------------
// VDP children, message landings
// ---------------------------------------------------------------------------

const vdpFamily: BackfillFamily = {
  id: 'vdp_children',
  async pending(db, userId) {
    const r = await db.execute<{ n: string }>(sql`select count(*)::text as n from vdp_records where owner_user_id = ${userId}::uuid and mirrored_at is null and detail is not null`);
    return Number(r.rows[0]?.n ?? 0);
  },
  async step(tx, userId, after, limit) {
    const rows = await tx.execute<{ id: string; detail: VdpSnapshot; last_seen_at: Date | string }>(sql`
      select id::text as id, detail, last_seen_at from vdp_records
       where owner_user_id = ${userId}::uuid and mirrored_at is null and detail is not null ${after ? sql`and id::text > ${after}` : sql``}
       order by id::text limit ${limit}`);
    let copied = 0;
    for (const r of rows.rows) {
      const s = r.detail;
      if (!s || !Array.isArray(s.useCases) || !Array.isArray(s.assets) || !Array.isArray(s.aes) || !Array.isArray(s.tas) || !Array.isArray(s.collaborators)) continue;
      await writeVdpChildren(tx, userId, r.id, s, new Date(r.last_seen_at));
      copied += 1;
    }
    return { copied, last: rows.rows.length < limit ? null : rows.rows.at(-1)!.id };
  },
};

/** A real Slack / Gmail delivery (the Outbox stamps sent_external_id only when something left), with no landing yet. */
const messagePending = (userId: string) => sql`
  d.owner_user_id = ${userId}::uuid and d.channel in ('slack', 'email') and d.sent_external_id is not null
  and not exists (select 1 from record_landings l where l.owner_user_id = d.owner_user_id and l.record_kind = ${MESSAGE_RECORD_KIND} and l.record_id = d.id::text)`;

const messageFamily: BackfillFamily = {
  id: 'message_landings',
  async pending(db, userId) {
    const r = await db.execute<{ n: string }>(sql`select count(*)::text as n from drafts d where ${messagePending(userId)}`);
    return Number(r.rows[0]?.n ?? 0);
  },
  async step(tx, userId, after, limit) {
    const rows = await tx.execute<{ id: string; channel: string; sent_external_id: string; sent_at: Date | null; staged_at: Date | null; verified_at: Date | null; result_url: string | null; target_external_id: string | null; target_thread_external_id: string | null }>(sql`
      select d.id::text as id, d.channel::text as channel, d.sent_external_id, d.sent_at, d.staged_at, d.verified_at, d.result_url, d.target_external_id, d.target_thread_external_id
        from drafts d where ${messagePending(userId)} ${after ? sql`and d.id::text > ${after}` : sql``}
       order by d.id::text limit ${limit}`);
    let copied = 0;
    for (const d of rows.rows) {
      const dest = d.channel === 'slack' ? 'slack' : 'gmail';
      const mode = d.sent_at ? 'send' : 'draft';
      const at = d.sent_at ?? d.staged_at ?? d.verified_at ?? new Date();
      const state = d.verified_at ? 'verified' : mode === 'draft' ? 'staged' : 'sent';
      const values = dest === 'slack' ? { channel: d.target_external_id, thread_ts: d.target_thread_external_id, mode, link: d.result_url } : { thread_id: d.target_thread_external_id, mode, link: d.result_url };
      const l = await tx.execute<{ id: string }>(sql`
        insert into record_landings (owner_user_id, record_kind, record_id, destination, external_id, state, verified_at)
        values (${userId}::uuid, ${MESSAGE_RECORD_KIND}, ${d.id}, ${dest}, ${d.sent_external_id}, ${state}, ${d.verified_at})
        on conflict (owner_user_id, record_kind, record_id, destination) do nothing returning id::text as id`);
      const id = l.rows[0]?.id;
      if (!id) continue;
      await tx.execute(sql`
        insert into landing_writes (owner_user_id, landing_id, draft_id, row_key, op, after, state, origin, reason, sent_at, verified_at)
        values (${userId}::uuid, ${id}::uuid, ${d.id}::uuid, 'backfill', 'create', ${JSON.stringify(values)}::jsonb, ${d.verified_at ? 'verified' : 'sent'}, 'backfill', 'backfill', ${at}, ${d.verified_at})
        on conflict do nothing`);
      copied += 1;
    }
    return { copied, last: rows.rows.length < limit ? null : rows.rows.at(-1)!.id };
  },
};

/** Every family, in run order (the cursor names one of these). */
export const BACKFILL_FAMILIES: readonly BackfillFamily[] = [...Object.entries(PROMOTED).flatMap(([table, fields]) => fields.map((f) => extFamily(table, f))), needFamily, overridesFamily, vdpFamily, messageFamily];

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface BackfillReport {
  name: string;
  dry: boolean;
  state: 'pending' | 'running' | 'done' | 'failed' | 'stopped';
  /** Rows still to copy per family before this run (the plan). */
  pending: Record<string, number>;
  /** Rows copied per family by this run. */
  copied: Record<string, number>;
  chunks: number;
}

export interface BackfillOptions {
  dry?: boolean;
  chunk?: number;
  /** Stop after this many chunks (tests: resumability); the next run continues at the cursor. */
  maxChunks?: number;
  now?: () => Date;
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
}

export async function backfillPlan(db: DbOrTx, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // one after another: a caller may pass a transaction
  for (const f of BACKFILL_FAMILIES) out[f.id] = await f.pending(db, userId);
  return out;
}

interface Progress {
  state: string;
  cursor: { family?: string; after?: string };
  counts: Record<string, number>;
}

async function progressOf(db: DbOrTx, userId: string): Promise<Progress | null> {
  const r = await db.execute<{ state: string; cursor: Progress['cursor']; counts: Progress['counts'] }>(sql`select state, cursor, counts from data_backfills where owner_user_id = ${userId}::uuid and name = ${KV_BACKFILL_NAME}`);
  return r.rows[0] ?? null;
}

async function saveProgress(db: DbOrTx, userId: string, p: Progress & { finished?: boolean; error?: string | null; run?: boolean }): Promise<void> {
  await db.execute(sql`
    insert into data_backfills (owner_user_id, name, state, cursor, counts, runs, started_at, finished_at, last_error)
    values (${userId}::uuid, ${KV_BACKFILL_NAME}, ${p.state}, ${JSON.stringify(p.cursor)}::jsonb, ${JSON.stringify(p.counts)}::jsonb, ${p.run ? 1 : 0}, now(), ${p.finished ? sql`now()` : sql`null`}, ${p.error ?? null})
    on conflict (owner_user_id, name) do update
       set state = excluded.state, cursor = excluded.cursor, counts = excluded.counts, last_error = excluded.last_error,
           runs = data_backfills.runs + ${p.run ? 1 : 0},
           started_at = coalesce(data_backfills.started_at, excluded.started_at),
           finished_at = ${p.finished ? sql`now()` : sql`null`}, updated_at = now()`);
}

/**
 * One run for one user. Dry: the plan only (nothing written). Else every family from the stored cursor, one change set
 * per chunk (actor system `kv.backfill`, not undoable: a copy, not an edit of yours), the cursor saved with each chunk.
 */
export async function runKvBackfill(db: Db, userId: string, o: BackfillOptions = {}): Promise<BackfillReport> {
  const limit = Math.max(1, o.chunk ?? KV_BACKFILL_CHUNK);
  const pending = await backfillPlan(db, userId);
  const report: BackfillReport = { name: KV_BACKFILL_NAME, dry: !!o.dry, state: 'pending', pending, copied: {}, chunks: 0 };
  const todo = Object.values(pending).reduce((a, n) => a + n, 0);
  const prev = await progressOf(db, userId);
  if (o.dry) {
    report.state = (prev?.state as BackfillReport['state']) ?? 'pending';
    return report;
  }
  if (!todo) {
    await saveProgress(db, userId, { state: 'done', cursor: {}, counts: prev?.counts ?? {}, finished: true, run: prev?.state !== 'done' });
    report.state = 'done';
    return report;
  }
  const counts: Record<string, number> = { ...(prev?.counts ?? {}) };
  // a finished run that finds rows again (a rollback wrote kv, then the update came back) starts over from the top
  let cursor: Progress['cursor'] = prev && prev.state !== 'done' ? { ...prev.cursor } : {};
  await saveProgress(db, userId, { state: 'running', cursor, counts, run: true });
  const start = cursor.family ? Math.max(0, BACKFILL_FAMILIES.findIndex((f) => f.id === cursor.family)) : 0;
  try {
    for (let i = start; i < BACKFILL_FAMILIES.length; i++) {
      const fam = BACKFILL_FAMILIES[i]!;
      let after: string | null = cursor.family === fam.id ? (cursor.after ?? null) : null;
      for (;;) {
        if (o.signal?.aborted || (o.maxChunks !== undefined && report.chunks >= o.maxChunks)) {
          report.state = 'stopped';
          return report;
        }
        const res = await withChangeSet({ db, userId, actor: actors.system('kv.backfill'), reason: `Data migration 0036: copy ${fam.id}`, undoable: false }, async (tx) => {
          const r = await fam.step(tx, userId, after, limit);
          if (r.copied) counts[fam.id] = (counts[fam.id] ?? 0) + r.copied;
          const next: Progress['cursor'] = r.last ? { family: fam.id, after: r.last } : { family: BACKFILL_FAMILIES[i + 1]?.id };
          await saveProgress(tx, userId, { state: 'running', cursor: next, counts });
          return r;
        });
        report.chunks += 1;
        if (res.result.copied) report.copied[fam.id] = (report.copied[fam.id] ?? 0) + res.result.copied;
        cursor = res.result.last ? { family: fam.id, after: res.result.last } : { family: BACKFILL_FAMILIES[i + 1]?.id };
        await o.heartbeat?.();
        if (!res.result.last) break;
        after = res.result.last;
      }
    }
  } catch (err) {
    const code = (err as { code?: string }).code ?? (err as Error).name ?? 'error';
    await saveProgress(db, userId, { state: 'failed', cursor, counts, error: String(code).slice(0, 80) });
    o.log?.('kv.backfill: failed', { code });
    throw err;
  }
  await saveProgress(db, userId, { state: 'done', cursor: {}, counts, finished: true });
  report.state = 'done';
  o.log?.('kv.backfill: done', { chunks: report.chunks, ...report.copied });
  return report;
}

/** The lines `npm run db:backfill` prints (family names and counts only). */
export function formatBackfillReport(r: BackfillReport): string[] {
  const lines = [`  ${r.name}: ${r.dry ? 'plan (dry run, nothing written)' : r.state}${r.dry ? '' : `, ${r.chunks} chunk(s)`}`];
  for (const [id, n] of Object.entries(r.pending)) {
    const c = r.copied[id];
    if (n || c) lines.push(`    ${id}: ${n} to copy${r.dry ? '' : `, ${c ?? 0} copied`}`);
  }
  if (lines.length === 1) lines.push('    nothing to copy');
  return lines;
}

/** Queue one run for a user (the worker start and the update path; one queued at a time per user). */
export async function enqueueKvBackfill(db: DbOrTx, userId: string, trigger: 'start' | 'update' | 'manual'): Promise<{ id: number; inserted: boolean }> {
  return enqueueJob(db, { ownerUserId: userId, kind: KV_BACKFILL_KIND, queue: KV_BACKFILL_QUEUE, payload: { trigger }, dedupeKey: `kv.backfill:${userId}`, delaySeconds: trigger === 'start' ? 30 : 0, maxAttempts: 3, timeoutSeconds: 1800 });
}

export function kvBackfillJobDef(): JobHandlerDef {
  return {
    kind: KV_BACKFILL_KIND,
    queue: KV_BACKFILL_QUEUE,
    wired: true,
    description: 'data migration 0036: copy the kv side-car into its columns and tables (idempotent, chunked, resumable)',
    handler: async (ctx) => {
      const r = await runKvBackfill(ctx.db, ctx.userId, { now: ctx.clock, signal: ctx.signal, heartbeat: ctx.heartbeat, log: ctx.log });
      return { name: r.name, state: r.state, chunks: r.chunks, pending: r.pending, copied: r.copied };
    },
  };
}
