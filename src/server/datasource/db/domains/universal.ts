/**
 * The db DataSource, universal domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, toAppError, I, Res } from '../shared';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import type { Draft, LiveEvent } from '@/contract';
import { actors, undoChangeSet, withChangeSet } from '@/db/changeset';
import type { Db, Tx } from '@/db/client';
import { ConstraintViolationError, UndoConflictError } from '@/db/errors';
import { changeSets, contentRevisions, drafts as draftsTable, workItems } from '@/db/schema';
import { AppError, invalid, notFound } from '@/server/errors';
import { plainText, renderAll } from '../../mock/render';
import { auditEntry, receiptFromChangeSet, sinceEntries } from '../audit';
import { canon } from '../ext';
import { uuidFor } from '../ids';
import { everything } from '../reads/scope';
import * as readin from '../readin';
import { daysBetween, readOnsiteOverrides } from '../store/onsite';
import { recomputeWeeks } from '@/projections/run';
import { buildSince } from '../views';
import { peopleView, searchView } from '@/server/views/universal';
import { projectionStore } from '../store/projections.run';

/**
 * BE-0's undo bumps `version` on every row it restores (OCC bookkeeping everywhere else), but
 * priority_policies.version is the policy's own number (v3, v4…), unique per user. Around an undo or redo
 * of a change set that updated policy rows: first move those rows' numbers out of the way (negative), so
 * the bump cannot collide with a version row the undo re-inserts, then give each its number back. A
 * row's number is the one it was created with (its first audited insert image). Both writes run in
 * non-undoable change sets inside the undo's transaction.
 */
async function shiftPolicyVersionNumbers(tx: Tx, userId: string, targetId: string): Promise<Map<string, number>> {
  const res = await tx.execute<{ row_id: string; v: number | null }>(sql`
    select a.row_id, (select (i.after ->> 'version')::int from audit_events i
                       where i.table_name = 'priority_policies' and i.row_id = a.row_id and i.op = 'insert'
                       order by i.id limit 1) as v
      from audit_events a
     where a.change_set_id = ${targetId} and a.table_name = 'priority_policies' and a.op = 'update'`);
  const out = new Map<string, number>();
  for (const r of res.rows) if (r.v !== null) out.set(r.row_id, r.v);
  if (!out.size) return out;
  await withChangeSet({ db: tx as unknown as Db, userId, actor: actors.system('undo.policy_version'), reason: 'Policy version numbers (before undo)', undoable: false }, async (t2) => {
    for (const [id, v] of out) await t2.execute(sql`update priority_policies set version = ${-100000 - v} where id = ${id}::uuid`);
  });
  return out;
}

async function restorePolicyVersionNumbers(tx: Tx, userId: string, rows: Map<string, number>): Promise<void> {
  if (!rows.size) return;
  await withChangeSet({ db: tx as unknown as Db, userId, actor: actors.system('undo.policy_version'), reason: 'Policy version numbers (after undo)', undoable: false }, async (t2) => {
    for (const [id, v] of rows) await t2.execute(sql`update priority_policies set version = ${v} where id = ${id}::uuid`);
  });
}

export class DbUniversal {
  constructor(private readonly ctx: DbCtx) {}

  /**
   * Universal undo = undoChangeSet (BE-0), inside one outer transaction together with the draft-body
   * restore: doc_json is kept out of the audit images, so a change set that saved a draft revision gets
   * the previous revision back (content_revisions, W5). Undoing an undo is redo.
   */
  async undoAudit({ params }: I<'undoAudit'>): Promise<Res<'undoAudit'>> {
    const userId = await this.ctx.userId();
    const m0 = await this.ctx.model(WHOLE);
    const target = await auditEntry(this.ctx.db, userId, params.id, m0, m0.ctx.kv);
    if (!target) throw notFound('Audit entry', params.id);
    if (!target.undoable) throw invalid('This change cannot be undone');
    if (target.undoneAt) throw invalid('Already undone');
    const now = this.ctx.now();
    let undoId = '';
    try {
      await this.ctx.db.transaction(async (outer) => {
        const policyRows = await shiftPolicyVersionNumbers(outer, userId, params.id);
        const res = await undoChangeSet(params.id, { db: outer as unknown as Db, actor: actors.user('undo'), reason: `Undo: ${target.summary}` });
        undoId = res.changeSetId;
        await outer.update(changeSets).set({ createdAt: now }).where(eq(changeSets.id, undoId));
        await this.restoreRevisions(outer, userId, params.id, undoId, now);
        await restorePolicyVersionNumbers(outer, userId, policyRows);
      });
    } catch (e) {
      // Redo of an undone policy apply: the rankings computed under that policy version went with it
      // (derived, unaudited output, migration 0006), so the score pointers it would restore are gone.
      if (e instanceof ConstraintViolationError && e.constraint === 'work_items_priority_score_id_priority_scores_id_fk') {
        throw new AppError('conflict', 'This re-rank can’t be redone: its scores were discarded with the undone policy version. Re-apply the policy from Settings ▸ Policy instead.', { current: target, reason: 'not_restorable' });
      }
      throw toAppError(e, target);
    }
    const m = await this.ctx.model(WHOLE);
    // an onsite correction (or its redo) moved the overrides: the weeks it touches recompute now (onsite lane)
    const before = readOnsiteOverrides(m0.ctx.kv);
    const after = readOnsiteOverrides(m.ctx.kv);
    if (canon(before) !== canon(after)) {
      const touched = [...before.days, ...after.days].map((d) => d.day).concat([...before.trips, ...after.trips].flatMap((t) => daysBetween(t.from, t.to)));
      await recomputeWeeks({ store: projectionStore(this.ctx.db), userId, days: [...new Set(touched)], now });
    }
    const entry = (await auditEntry(this.ctx.db, userId, undoId, m, m.ctx.kv))!;
    return { entity: entry, auditId: entry.id, receipt: await receiptFromChangeSet(this.ctx.db, undoId, m, 'user', `Undid: ${target.summary}`, now.toISOString()) };
  }

  private async restoreRevisions(tx: Tx, userId: string, targetId: string, undoId: string, now: Date) {
    const revs = await tx.select().from(contentRevisions).where(and(eq(contentRevisions.changeSetId, targetId), eq(contentRevisions.entityType, 'drafts'), eq(contentRevisions.field, 'doc_json')));
    if (!revs.length) return;
    await withChangeSet({ db: tx as unknown as Db, userId, actor: actors.user('undo.revision'), reason: 'Restore draft body', undoable: false }, async (t2) => {
      for (const rev of revs) {
        const [cur] = await t2.select({ doc: draftsTable.docJson }).from(draftsTable).where(eq(draftsTable.id, rev.entityId));
        if (!cur) continue;
        if (JSON.stringify(cur.doc) !== JSON.stringify(rev.docJson)) throw new UndoConflictError(targetId, 'drafts', rev.entityId, 'changed_since');
        const [prev] = await t2
          .select()
          .from(contentRevisions)
          .where(and(eq(contentRevisions.entityType, 'drafts'), eq(contentRevisions.entityId, rev.entityId), eq(contentRevisions.field, 'doc_json'), sql`${contentRevisions.revision} < ${rev.revision}`))
          .orderBy(sql`${contentRevisions.revision} desc`)
          .limit(1);
        if (!prev?.docJson) continue;
        const doc = prev.docJson as unknown as Draft['doc'];
        await t2.update(draftsTable).set({ docJson: prev.docJson, plainText: plainText(doc), updatedAt: now }).where(eq(draftsTable.id, rev.entityId));
        const [max] = await t2.execute<{ n: number }>(sql`select coalesce(max(revision), 0)::int as n from content_revisions where entity_type = 'drafts' and entity_id = ${rev.entityId} and field = 'doc_json'`).then((x) => x.rows);
        await t2.insert(contentRevisions).values({ ownerUserId: userId, entityType: 'drafts', entityId: rev.entityId, field: 'doc_json', revision: (max?.n ?? 0) + 1, docJson: prev.docJson, contentHash: JSON.stringify(prev.docJson).length.toString(36), actorKind: 'user', editorSessionId: `undo:${undoId}`, changeSetId: undoId, closedAt: now });
      }
    });
    // re-render at the restored body (renditions are derived, unaudited)
    const { draftRenditions } = await import('@/db/schema');
    for (const rev of revs) {
      const [d] = await tx.select().from(draftsTable).where(eq(draftsTable.id, rev.entityId));
      if (!d?.docJson) continue;
      const doc = d.docJson as unknown as Draft['doc'];
      const dest = (await this.ctx.model(everything('send: the draft in its transaction'), tx as unknown as Db)).get('drafts', d.id)?.destination;
      if (!dest) continue;
      const rendered = renderAll(dest, doc);
      for (const rr of Object.values(rendered)) {
        if (!rr) continue;
        await tx.insert(draftRenditions).values({ draftId: d.id, docVersion: d.docVersion, format: rr.format, body: rr.body, rendererVersion: 'cc-render@1', contentHash: rr.body.length.toString(36), lossy: rr.lossy.length > 0, warnings: rr.lossy }).onConflictDoUpdate({ target: [draftRenditions.draftId, draftRenditions.docVersion, draftRenditions.format], set: { body: rr.body, warnings: rr.lossy } });
      }
    }
  }

  async search({ query }: I<'search'>): Promise<Res<'search'>> {
    const q = query.q.trim().toLowerCase();
    if (!q) return { q: query.q, hits: [], total: 0 };
    const m = await this.ctx.model(WHOLE);
    const tokens = q.split(/\s+/).filter(Boolean);
    const like = tokens.map((t) => or(ilike(workItems.title, `%${t}%`), ilike(workItems.purpose, `%${t}%`)));
    const fts = await this.ctx.db
      .select({ id: workItems.id, ftsHit: sql<boolean>`${workItems.searchTsv} @@ plainto_tsquery('english', ${q})` })
      .from(workItems)
      .where(and(eq(workItems.ownerUserId, m.ctx.userId), or(sql`${workItems.searchTsv} @@ plainto_tsquery('english', ${q})`, ...like, sql`true`)));
    // the full-text matches the token score misses (stemmed words) still count (src/server/views/universal.ts)
    return searchView(m, query, new Set(fts.filter((r) => r.ftsHit).map((r) => r.id)));
  }

  async getSince({ query }: I<'getSince'>): Promise<Res<'getSince'>> {
    const m = await this.ctx.model(WHOLE);
    const since = query.ts ?? m.meta().lastActiveAt;
    return buildSince(m, await sinceEntries(this.ctx.db, m.ctx.userId, new Date(since), m, m.ctx.kv), since, this.ctx.now());
  }

  async getPeople({ query }: I<'getPeople'>): Promise<Res<'getPeople'>> {
    // like listItems: the account filter is a uuid, or a seed id
    return peopleView(await this.ctx.model(WHOLE), query, query.account ? uuidFor(query.account) : null);
  }

  // ---- Read-ins (BE-READIN; db/readin.ts: the worker researches, this only reads and enqueues) ----
  async getReadIn({ params }: I<'getReadIn'>): Promise<Res<'getReadIn'>> {
    const userId = await this.ctx.userId();
    if (!(await readin.entityExists(this.ctx.db, userId, params))) throw notFound(params.type === 'work_item' ? 'Work item' : 'Event', params.id);
    return readin.getReadInDb(this.ctx.db, userId, params);
  }
  async requestReadIn({ params, body }: I<'requestReadIn'>): Promise<Res<'requestReadIn'>> {
    const userId = await this.ctx.userId();
    if (!(await readin.entityExists(this.ctx.db, userId, params))) throw notFound(params.type === 'work_item' ? 'Work item' : 'Event', params.id);
    const r = await readin.enqueueReadIn(this.ctx.db, userId, params, { trigger: 'on_demand', priority: 90, force: body.force });
    if (r.action !== 'fresh' && r.action !== 'running') await readin.notifyReadIn(this.ctx.db, params, 'readin.queued');
    const p = await readin.getReadInDb(this.ctx.db, userId, params);
    return { entity: p.readIn ?? readin.queuedPlaceholder(params, this.ctx.now()), auditId: null };
  }

  events({ signal }: { signal: AbortSignal }): AsyncIterable<LiveEvent> {
    return this.ctx.bus.iterate(signal);
  }
}
