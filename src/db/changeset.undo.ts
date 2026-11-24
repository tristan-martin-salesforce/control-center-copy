// Undo of a committed change set (revert its audit rows). Split from changeset.ts (max-lines); changeset.ts re-exports the public names.
import { eq, sql, type SQL } from 'drizzle-orm';

import { getDb, type Db, type DbOrTx, type Tx } from './client';
import {
  AlreadyUndoneError, ConstraintViolationError, mapPgError, NotFoundError, NotUndoableError, UndoConflictError,
  ValidationError,
} from './errors';
import { changeSets } from './schema';
import { normalize, type Actor, type ActorKind, type ChangeSetResult, withChangeSet } from './changeset.core';

// ---------------------------------------------------------------------------
// Undo / redo (DATA-MODEL §1.3)
// ---------------------------------------------------------------------------

/** Monotonic bookkeeping: never restored, never compared ("changed since" ignores it). */
const NEVER_RESTORE = new Set(['updated_at', 'version', 'reeval_generation']);
interface TableMeta {
  columns: Set<string>;
  insertable: Set<string>;
  pk: string[];
}
const metaCache = new Map<string, TableMeta>();
async function tableMeta(tx: DbOrTx, table: string): Promise<TableMeta> {
  const hit = metaCache.get(table);
  if (hit) return hit;
  const res = await tx.execute<{ name: string; generated: boolean; pk: boolean }>(sql`
    select a.attname as name, a.attgenerated <> '' as generated,
           coalesce(a.attnum = any(i.indkey), false) as pk
      from pg_attribute a
      left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
     where a.attrelid = to_regclass(${`public.${table}`}) and a.attnum > 0 and not a.attisdropped
     order by a.attnum`);
  if (!res.rows.length) throw new ValidationError(`undo: unknown table ${table}`);
  const meta: TableMeta = {
    columns: new Set(res.rows.map((r) => r.name)),
    insertable: new Set(res.rows.filter((r) => !r.generated).map((r) => r.name)),
    pk: res.rows.filter((r) => r.pk).map((r) => r.name),
  };
  metaCache.set(table, meta);
  return meta;
}
interface AuditRow extends Record<string, unknown> {
  id: string;
  table_name: string;
  row_id: string;
  op: 'insert' | 'update' | 'delete';
  changed_fields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
const ident = (c: string) => sql.identifier(c);
/**
 * `left` still matches image `right` on `cols`. Columns in `nullable` also match when `left` is NULL:
 * they pointed at a row this same undo already deleted, and the FK's ON DELETE SET NULL cleared them.
 */
const sameCols = (cols: string[], left: string, right: string, nullable: Set<string> = new Set()): SQL =>
  cols.length
    ? sql.join(
        cols.map((c) => {
          const eq = sql`${sql.raw(left)}.${ident(c)} is not distinct from ${sql.raw(right)}.${ident(c)}`;
          return nullable.has(c) ? sql`(${sql.raw(left)}.${ident(c)} is null or ${eq})` : eq;
        }),
        sql` and `,
      )
    : sql`true`;
const pkMatch = (pk: string[], left: string, right: string): SQL =>
  sql.join(
    pk.map((c) => sql`${sql.raw(left)}.${ident(c)} = ${sql.raw(right)}.${ident(c)}`),
    sql` and `,
  );
const diffKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => normalize(a[k]) !== normalize(b[k]));
export interface UndoOptions {
  actor?: Actor | ActorKind;
  reason?: string;
  db?: Db;
}
/**
 * Reverts change set `changeSetId` as a new change set of kind 'undo' (or 'redo' when the target
 * is itself an undo), walking its audit rows newest first:
 *   insert -> delete the row; update -> restore `before` for the changed fields; delete -> re-insert.
 * Each step first checks the row still matches the change set's `after` image; if not, nothing is
 * undone and UndoConflictError ("changed since: review") is thrown.
 */
export async function undoChangeSet(changeSetId: string, opts: UndoOptions = {}): Promise<ChangeSetResult<{ rows: number }>> {
  const db = opts.db ?? getDb();
  const [target] = await db.select().from(changeSets).where(eq(changeSets.id, changeSetId));
  if (!target) throw new NotFoundError('change_sets', changeSetId);
  if (target.undoneAt) throw new AlreadyUndoneError(changeSetId);
  if (!target.undoable) throw new NotUndoableError(changeSetId);

  return withChangeSet(
    {
      userId: target.ownerUserId,
      actor: opts.actor ?? 'user',
      kind: target.kind === 'undo' ? 'redo' : 'undo',
      reason: opts.reason ?? `Undo: ${target.summary}`,
      entity: target.entityType && target.entityId ? { type: target.entityType, id: target.entityId } : undefined,
      undoOf: changeSetId,
      db,
    },
    async (tx, cs) => {
      // Re-check under lock: a concurrent undo of the same change set loses here.
      const locked = await tx.execute<{ undone_at: string | null; closed_at: string | null }>(
        sql`select undone_at, closed_at from change_sets where id = ${changeSetId} for update`,
      );
      if (locked.rows[0]?.undone_at) throw new AlreadyUndoneError(changeSetId);
      if (!locked.rows[0]?.closed_at) {
        await tx.execute(sql`update change_sets set closed_at = now() where id = ${changeSetId}`);
      }

      const audit = await tx.execute<AuditRow>(sql`
        select id, table_name, row_id, op, changed_fields, before, after
          from audit_events where change_set_id = ${changeSetId} order by id desc`);
      const deleted = new Set<string>();
      for (const a of audit.rows) await revertAuditRow(tx, changeSetId, a, deleted);

      await markUndoChain(tx, changeSetId, cs.id);
      return { rows: audit.rows.length };
    },
  );
}
async function revertAuditRow(tx: Tx, changeSetId: string, a: AuditRow, deleted: Set<string>): Promise<void> {
  const meta = await tableMeta(tx, a.table_name);
  const clearedBy = (img: Record<string, unknown>, cols: string[]) =>
    new Set(cols.filter((c) => typeof img[c] === 'string' && deleted.has(img[c] as string)));
  const t = ident(a.table_name);
  const conflict = (reason: UndoConflictError['reason']) => new UndoConflictError(changeSetId, a.table_name, a.row_id, reason);
  const exists = async (img: Record<string, unknown>) =>
    (
      await tx.execute(sql`select 1 from ${t} cur, jsonb_populate_record(null::${t}, ${normalize(img)}::jsonb) img
                            where ${pkMatch(meta.pk, 'cur', 'img')}`)
    ).rows.length > 0;

  if (!a.before && a.after) {
    // undo an insert: delete it, if it is still exactly what this change set left behind
    const cmp = Object.keys(a.after).filter((k) => meta.columns.has(k) && !NEVER_RESTORE.has(k) && !meta.pk.includes(k));
    let res;
    try {
      res = await tx.execute(sql`
        delete from ${t} as cur using jsonb_populate_record(null::${t}, ${normalize(a.after)}::jsonb) as img
         where ${pkMatch(meta.pk, 'cur', 'img')} and ${sameCols(cmp, 'cur', 'img', clearedBy(a.after, cmp))}
        returning 1`);
    } catch (e) {
      const mapped = mapPgError(e);
      // e.g. a later row references it through an ON DELETE RESTRICT FK
      if (mapped instanceof ConstraintViolationError) throw conflict('not_restorable');
      throw mapped;
    }
    if (!res.rows.length) throw conflict((await exists(a.after)) ? 'changed_since' : 'row_missing');
    deleted.add(a.row_id);
  } else if (a.before && !a.after) {
    // undo a delete: re-insert the before image
    if (await exists(a.before)) throw conflict('row_exists');
    const cols = Object.keys(a.before).filter((k) => meta.insertable.has(k));
    const list = sql.join(cols.map(ident), sql`, `);
    try {
      await tx.execute(sql`insert into ${t} (${list})
                           select ${list} from jsonb_populate_record(null::${t}, ${normalize(a.before)}::jsonb)`);
    } catch (e) {
      const mapped = mapPgError(e);
      if (mapped instanceof ConstraintViolationError) throw conflict('not_restorable');
      throw mapped;
    }
  } else if (a.before && a.after) {
    // undo an update: restore `before` for the fields this change set changed
    const changed = a.changed_fields.length ? a.changed_fields : diffKeys(a.before, a.after);
    const fields = changed.filter((k) => meta.columns.has(k) && meta.insertable.has(k) && !NEVER_RESTORE.has(k));
    if (!fields.length) return;
    const sets = fields.map((f) => sql`${ident(f)} = b.${ident(f)}`);
    if (meta.columns.has('version')) sets.push(sql`version = cur.version + 1`);
    if (meta.columns.has('updated_at')) sets.push(sql`updated_at = now()`);
    const res = await tx.execute(sql`
      update ${t} as cur set ${sql.join(sets, sql`, `)}
        from jsonb_populate_record(null::${t}, ${normalize(a.before)}::jsonb) as b,
             jsonb_populate_record(null::${t}, ${normalize(a.after)}::jsonb) as a
       where ${pkMatch(meta.pk, 'cur', 'a')} and ${sameCols(fields, 'cur', 'a', clearedBy(a.after, fields))}
      returning 1`);
    if (!res.rows.length) throw conflict((await exists(a.after)) ? 'changed_since' : 'row_missing');
  }
  // before and after both null: created and deleted inside one change set, nothing to revert.
}
/**
 * undone_at means "this change set's effects are currently reverted". Undoing X reverts X; if X was
 * an undo/redo of Y, Y is in effect again, Y's own target reverted again, and so on down the chain.
 * Work-item transitions and reopen decisions carried by those change sets follow the same state.
 */
async function markUndoChain(tx: Tx, targetId: string, undoChangeSetId: string): Promise<void> {
  let id: string | null = targetId;
  let reverted = true;
  for (let guard = 0; id && guard < 100; guard++) {
    const by = reverted ? sql`${undoChangeSetId}::uuid` : sql`null::uuid`;
    const at = reverted ? sql`now()` : sql`null::timestamptz`;
    const res: { rows: { undo_of_change_set_id: string | null }[] } = await tx.execute<{
      undo_of_change_set_id: string | null;
    }>(sql`update change_sets set undone_at = ${at}, undone_by_change_set_id = ${by}
                   where id = ${id} returning undo_of_change_set_id`);
    await tx.execute(sql`update work_item_transitions set undone_at = ${at}, undone_by_change_set_id = ${by}
                          where change_set_id = ${id}`);
    await tx.execute(sql`update reopen_decisions set undone_at = ${at}, undone_by_change_set_id = ${by}
                          where change_set_id = ${id}`);
    id = res.rows[0]?.undo_of_change_set_id ?? null;
    reverted = !reverted;
  }
}
