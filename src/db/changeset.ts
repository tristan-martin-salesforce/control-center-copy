/**
 * The write helper every mutation goes through (DATA-MODEL §1.3, §1.4, §3.3).
 *
 *   const { result, changeSetId } = await withChangeSet(
 *     { userId, actor: actors.user(), reason: 'Rename task' },
 *     async (tx, cs) => cs.updateVersioned(workItems, id, ifVersion, { title }),
 *   );
 *
 * - withChangeSet() opens a transaction, a `change_sets` row and the transaction-local GUCs the
 *   cc_audit trigger requires (cc.change_set_id, cc.actor_kind, cc.actor_ref, plus cc.user_id).
 *   A write to a curated table outside it is refused by the database (ChangeSetRequiredError).
 * - The change set id is the Undo target: undoChangeSet(id) reverts it from the audit images.
 * - Versioned rows use optimistic concurrency (ConflictError on a stale version, W4).
 * - User edits lock the fields they touch; engine writes to locked fields become
 *   change_proposals ("New info -> update?") instead of overwriting (R-UI-20).
 * - Re-eval writes can fence on work_items.reeval_generation (StaleGenerationError, W3).
 */
import { and, eq, getTableColumns, getTableName, isTable, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import type { DbOrTx } from './client';
import { ConflictError, InvalidStateError, mapPgError, NotFoundError, ValidationError } from './errors';
import * as schema from './schema';
import { changeProposals } from './schema';
import { normalize, PROTECTED } from './changeset.core';
export {
  actors, onChangeSetCommitted, withChangeSet, closeIdleBursts, updateVersioned, engineUpdate, userUpdate,
} from './changeset.core';
export type {
  ActorKind, ChangeSetKind, Actor, ChangeSetOptions, ProposalRef, WriteResult, Provenance, WriteOptions, IdTable,
  VersionedTable, Patch, ChangeSetContext, ChangeSetResult, CommittedChangeSet,
} from './changeset.core';
export { undoChangeSet } from './changeset.undo';
export type { UndoOptions } from './changeset.undo';

const tablesByName = new Map<string, PgTable>();
for (const v of Object.values(schema) as unknown[]) {
  if (isTable(v)) tablesByName.set(getTableName(v), v as PgTable);
}

/**
 * 2026-11-13 audit B4: whether a pending proposal still applies to what it was proposed against: the row is still at
 * its `base_version`, or (the row moved on for another field) the proposal's field still holds the value it was
 * proposed over, compared after the same jsonb → column conversion the apply uses. False means the field changed
 * since, so applying would overwrite newer data. A missing proposal or row is left to the apply to report.
 */
export async function proposalStillCurrent(tx: DbOrTx, proposalId: string): Promise<boolean> {
  try {
    const [p] = await tx.select().from(changeProposals).where(eq(changeProposals.id, proposalId));
    if (!p) return true;
    const table = tablesByName.get(p.entityType);
    if (!table) return true;
    const cols = Object.values(getTableColumns(table)).map((c) => c.name);
    if (!cols.includes(p.field)) return true;
    const t = sql.identifier(p.entityType);
    const f = sql.identifier(p.field);
    const version = cols.includes('version') ? sql`version` : sql`null::int`;
    const res = await tx.execute<{ version: number | null; same: boolean }>(sql`
      select ${version} as version,
             (${f} is not distinct from (jsonb_populate_record(null::${t}, jsonb_build_object(${p.field}::text, ${normalize(p.currentValue ?? null)}::jsonb))).${f}) as same
        from ${t} where id = ${p.entityId}`);
    const row = res.rows[0];
    if (!row) return true;
    return (row.version !== null && Number(row.version) === p.baseVersion) || row.same === true;
  } catch (e) {
    throw mapPgError(e);
  }
}

/** "New info -> update?" accepted: apply the proposed value (the field stays locked). */
export async function applyProposal(
  tx: DbOrTx,
  proposalId: string,
  opts: { ifVersion?: number } = {},
): Promise<{ entityType: string; entityId: string; field: string; version: number | null }> {
  try {
    const [p] = await tx.select().from(changeProposals).where(eq(changeProposals.id, proposalId)).for('update');
    if (!p) throw new NotFoundError('change_proposals', proposalId);
    if (p.status !== 'pending') throw new InvalidStateError(`proposal ${proposalId} is ${p.status}, not pending`);
    const table = tablesByName.get(p.entityType);
    if (!table) throw new ValidationError(`proposal ${proposalId}: unknown table ${p.entityType}`);
    const cols = Object.values(getTableColumns(table)).map((c) => c.name);
    if (!cols.includes(p.field) || PROTECTED.has(p.field)) {
      throw new ValidationError(`proposal ${proposalId}: field ${p.field} cannot be applied`);
    }
    const t = sql.identifier(p.entityType);
    const f = sql.identifier(p.field);
    const extra: SQL[] = [];
    if (cols.includes('version')) extra.push(sql`, version = version + 1`);
    if (cols.includes('updated_at')) extra.push(sql`, updated_at = now()`);
    const versionGuard = opts.ifVersion !== undefined ? sql` and version = ${opts.ifVersion}` : sql``;
    const res = await tx.execute<{ version: number | null }>(sql`
      update ${t} set ${f} = (jsonb_populate_record(null::${t}, jsonb_build_object(${p.field}::text, ${normalize(p.proposedValue)}::jsonb))).${f}
             ${sql.join(extra, sql``)}
       where id = ${p.entityId}${versionGuard}
      returning ${cols.includes('version') ? sql`version` : sql`null::int as version`}`);
    if (!res.rows.length) {
      if (opts.ifVersion === undefined) throw new NotFoundError(p.entityType, p.entityId);
      const cur = await tx.execute<{ version: number }>(sql`select version from ${t} where id = ${p.entityId}`);
      if (!cur.rows.length) throw new NotFoundError(p.entityType, p.entityId);
      throw new ConflictError(p.entityType, p.entityId, opts.ifVersion, cur.rows[0]!.version);
    }
    await tx
      .update(changeProposals)
      .set({
        status: 'accepted',
        decidedAt: new Date(),
        decidedBy: sql`nullif(current_setting('cc.actor_kind', true), '')::actor_kind`,
        appliedChangeSetId: sql`nullif(current_setting('cc.change_set_id', true), '')::uuid`,
      })
      .where(eq(changeProposals.id, proposalId));
    return { entityType: p.entityType, entityId: p.entityId, field: p.field, version: res.rows[0]!.version };
  } catch (e) {
    throw mapPgError(e);
  }
}

/** "Not now": a learning signal; the field keeps the user's value. */
export async function rejectProposal(tx: DbOrTx, proposalId: string): Promise<void> {
  try {
    const res = await tx
      .update(changeProposals)
      .set({
        status: 'rejected',
        decidedAt: new Date(),
        decidedBy: sql`nullif(current_setting('cc.actor_kind', true), '')::actor_kind`,
      })
      .where(and(eq(changeProposals.id, proposalId), eq(changeProposals.status, 'pending')))
      .returning({ id: changeProposals.id });
    if (!res.length) throw new InvalidStateError(`proposal ${proposalId} is not pending`);
  } catch (e) {
    throw mapPgError(e);
  }
}
