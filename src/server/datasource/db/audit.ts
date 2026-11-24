/**
 * change_sets + audit_events → contract AuditEntry.
 *
 * - id / at / summary / undoable / undoneAt / undoOf come straight from change_sets.
 * - action: the change set's actor_ref (the DataSource passes the UI/engine action name, e.g. "item.done";
 *   DB-NOTES: ref = "UI action name"), else the kind ("undo", "redo", "system").
 * - entity: change_sets.entity_type / entity_id (contract EntityType), labelled from the read model.
 * - related: the other root entities its audit rows touched.
 * - changes: audit row images mapped back to contract fields (work items through the column map; ext
 *   side-car rows as contract-field diffs); bookkeeping columns are skipped, like the mock's VOLATILE set.
 * Seeded history rows (no audit images) carry their display changes in `cc.ext/change_sets/<id>`.
 */
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';

import { EntityType as EntityTypeEnum, type Actor, type AuditEntry, type EntityRef, type EntityType, type FieldChange, type Receipt, type ReceiptChange } from '@/contract';
import type { Db, DbOrTx } from '@/db/client';
import { auditEvents, changeSets } from '@/db/schema';

import { hrefFor } from '../mock/views';
import { EXT_PREFIX } from './ext';
import type { ReadModel } from './model';
import { stateFromDb, type DbWorkStatus } from './enums';

const ROOT_TYPE: Record<string, EntityType> = {
  work_items: 'work_item',
  drafts: 'draft',
  initiatives: 'initiative',
  activity_entries: 'activity_entry',
  calendar_events: 'calendar_event',
  claude_sessions: 'agent_run',
  connectors: 'connector',
  watch_subscriptions: 'watch',
  briefs: 'brief',
  missed_opp_findings: 'missed_opp',
  accounts: 'account',
  opportunities: 'opportunity',
  people: 'person',
  assets: 'asset',
  change_proposals: 'proposal',
  priority_policies: 'policy',
  tool_adapters: 'tool_adapter',
};

const WORK_COLUMN_FIELD: Record<string, string> = {
  status: 'state',
  status_reason: 'closedReason',
  title: 'title',
  purpose: 'purpose',
  description: 'notes',
  kind: 'kind',
  initiative_id: 'initiativeId',
  account_id: 'accountId',
  opportunity_id: 'oppId',
  counterparty_person_id: 'counterparty',
  due_at: 'due',
  deadline_event_id: 'servesEventId',
  effort_minutes: 'effort',
  lead_time_minutes: 'effort',
  importance: 'priority',
  confidence: 'confidence',
  snoozed_until: 'snoozedUntil',
  snoozed_from_status: 'snoozedFrom',
  waiting_reason: 'waiting',
  waiting_since: 'waiting',
  done_at: 'doneAt',
  done_by: 'doneBy',
  resolution: 'resolution',
  resolution_person_id: 'resolutionDetail',
  resolution_work_item_id: 'resolutionDetail',
  resolution_note: 'resolutionDetail',
  resolution_inferred: 'resolutionDetail',
  resolution_evidence_id: 'resolutionDetail',
  owner_person_id: 'owner',
  involvement: 'involvement',
  seen_by_user_at: 'seenAt',
  unseen_evidence_count: 'newEvidenceCount',
  priority_rank: 'rank',
  priority_score: 'score',
  current_nba_id: 'nbaId',
  user_locked_fields: 'userLockedFields',
};
/** Bookkeeping / cache columns that never show as a change (the mock's VOLATILE set, in db terms). */
const SKIP = new Set(['updated_at', 'version', 'status_changed_at', 'last_new_info_at', 'priority_lane', 'priority_score_id', 'priority_computed_at', 'reeval_generation', 'likely_done_at', 'last_reopened_at', 'reopened_count', 'doc_version', 'content_hash', 'plain_text', 'search_tsv']);

type AuditRow = typeof auditEvents.$inferSelect;
type CsRow = typeof changeSets.$inferSelect;

function contractValue(table: string, column: string, v: unknown): unknown {
  if (table === 'work_items' && (column === 'status' || column === 'snoozed_from_status') && typeof v === 'string') return stateFromDb(v as DbWorkStatus, false);
  return v ?? null;
}

function changesOf(rows: AuditRow[]): FieldChange[] {
  const out: FieldChange[] = [];
  const seen = new Set<string>();
  for (const a of rows) {
    if (!a.before || !a.after) continue;
    if (a.tableName === 'user_settings') {
      // ext side-car: diff the contract-field objects
      const key = (a.after as { key?: string }).key ?? '';
      if (!key.startsWith(EXT_PREFIX)) continue;
      const b = ((a.before as { value?: Record<string, unknown> }).value ?? {}) as Record<string, unknown>;
      const f = ((a.after as { value?: Record<string, unknown> }).value ?? {}) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(b), ...Object.keys(f)])) {
        if (JSON.stringify(b[k]) === JSON.stringify(f[k]) || k.endsWith('Override') || k === 'rankReasons') continue;
        const id = `${key}:${k}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ field: k, before: b[k] ?? null, after: f[k] ?? null });
      }
      continue;
    }
    const fields = a.changedFields.length ? a.changedFields : Object.keys(a.after);
    for (const col of fields) {
      if (SKIP.has(col)) continue;
      const field = a.tableName === 'work_items' ? (WORK_COLUMN_FIELD[col] ?? col) : col;
      const id = `${a.tableName}:${a.rowId}:${field}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ field, before: contractValue(a.tableName, col, (a.before as Record<string, unknown>)[col]), after: contractValue(a.tableName, col, (a.after as Record<string, unknown>)[col]) });
    }
  }
  return out;
}

/**
 * change_sets.entity_type → contract EntityType. The DataSource writes contract types ("work_item"); the scanner
 * writes table names ("work_items"), which are mapped like audit rows are. Anything else falls back (null).
 */
const ENTITY_TYPES = new Set<string>(EntityTypeEnum.options);
export function entityTypeOf(t: string | null): EntityType | null {
  if (!t) return null;
  if (ENTITY_TYPES.has(t)) return t as EntityType;
  return ROOT_TYPE[t] ?? null;
}

const labelOr = (label: string, id: string, rows: AuditRow[]) => (label === id ? (imageLabel(rows, id) ?? label) : label);

const ACTOR: Record<string, Actor> = { user: 'user', engine: 'engine', chat: 'chat', connector: 'connector', system: 'system', autonomy_policy: 'engine' };

export function labelFor(model: ReadModel | null, type: EntityType, id: string): string {
  if (!model) return id;
  switch (type) {
    case 'work_item':
      return model.get('workItems', id)?.title ?? id;
    case 'initiative':
      return model.get('initiatives', id)?.title ?? id;
    case 'draft':
      return 'Draft';
    case 'nba':
      return model.get('nbas', id)?.title ?? id;
    case 'agent_run':
      return model.get('agentRuns', id)?.title ?? id;
    case 'connector':
      return model.get('connectors', id)?.label ?? id;
    case 'missed_opp':
      return model.get('missedOpps', id)?.oppName ?? id;
    case 'watch':
      return model.get('watches', id)?.label ?? id;
    case 'activity_entry':
      return model.get('activity', id)?.description ?? id;
    case 'account':
      return model.get('accounts', id)?.name ?? id;
    default:
      return id;
  }
}

/** A label from the audit images when the entity no longer exists (e.g. the undo of a capture). */
function imageLabel(rows: AuditRow[], id: string): string | null {
  for (const r of rows) {
    if (r.rowId !== id) continue;
    const img = (r.after ?? r.before) as Record<string, unknown> | null;
    const v = img?.title ?? img?.name ?? img?.display_name ?? img?.label;
    if (typeof v === 'string') return v;
  }
  return null;
}

const actionOf = (cs: CsRow) => (cs.actorRef && cs.actorRef.includes('.') ? cs.actorRef : cs.kind === 'undo' || cs.kind === 'redo' ? 'undo' : (cs.actorRef ?? cs.kind));

function toEntry(cs: CsRow, rows: AuditRow[], model: ReadModel | null, kv: Map<string, unknown>): AuditEntry {
  const x = (kv.get(`${EXT_PREFIX}change_sets/${cs.id}`) as { changes?: FieldChange[]; entity?: EntityRef; related?: EntityRef[]; actor?: Actor } | undefined) ?? {};
  const mainType = entityTypeOf(cs.entityType) ?? (rows[0] ? (ROOT_TYPE[rows[0].entityType] ?? 'settings') : 'settings');
  const mainId = cs.entityId ?? rows[0]?.entityId ?? cs.id;
  const related: EntityRef[] = [];
  const seen = new Set<string>([`${mainType}:${mainId}`]);
  for (const r of rows) {
    const t = ROOT_TYPE[r.entityType];
    if (!t) continue;
    const k = `${t}:${r.entityId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    related.push({ type: t, id: r.entityId, label: labelOr(labelFor(model, t, r.entityId), r.entityId, rows), href: hrefFor({ type: t, id: r.entityId }) });
  }
  return {
    id: cs.id,
    at: cs.createdAt.toISOString(),
    actor: x.actor ?? ACTOR[cs.actorKind] ?? 'system',
    action: actionOf(cs),
    summary: cs.summary,
    entity: x.entity ?? { type: mainType, id: mainId, label: labelOr(labelFor(model, mainType, mainId), mainId, rows), href: hrefFor({ type: mainType, id: mainId }) },
    related: x.related ?? related.slice(0, 12),
    changes: x.changes ?? changesOf(rows),
    undoable: cs.undoable,
    undoneAt: cs.undoneAt ? cs.undoneAt.toISOString() : null,
    undoOf: cs.undoOfChangeSetId,
  };
}

async function entriesFor(db: DbOrTx, sets: CsRow[], model: ReadModel | null, kv: Map<string, unknown>): Promise<AuditEntry[]> {
  if (!sets.length) return [];
  const rows = await db.select().from(auditEvents).where(inArray(auditEvents.changeSetId, sets.map((s) => s.id))).orderBy(asc(auditEvents.id));
  return sets.map((cs) => toEntry(cs, rows.filter((r) => r.changeSetId === cs.id), model, kv));
}


export async function auditEntry(db: DbOrTx, userId: string, id: string, model: ReadModel | null, kv: Map<string, unknown>): Promise<AuditEntry | null> {
  const [cs] = await db.select().from(changeSets).where(and(eq(changeSets.ownerUserId, userId), eq(changeSets.id, id)));
  if (!cs) return null;
  return (await entriesFor(db, [cs], model, kv))[0]!;
}

/** Q13-style history of one work item: change sets whose audit rows touch it, plus seeded entries naming it. */
export async function itemHistory(db: Db, userId: string, itemId: string, model: ReadModel, kv: Map<string, unknown>): Promise<AuditEntry[]> {
  const viaAudit = await db.execute<{ id: string }>(sql`
    select distinct cs.id
      from audit_events ae
      join change_sets cs on cs.id = ae.change_set_id
     where ae.entity_type = 'work_items' and ae.entity_id = ${itemId} and cs.owner_user_id = ${userId}
       and cs.actor_ref is distinct from 'seed'`);
  const ids = new Set(viaAudit.rows.map((r) => r.id));
  const named = await db.select({ id: changeSets.id }).from(changeSets).where(and(eq(changeSets.ownerUserId, userId), eq(changeSets.entityId, itemId)));
  for (const n of named) ids.add(n.id);
  if (!ids.size) return [];
  const sets = await db.select().from(changeSets).where(inArray(changeSets.id, [...ids]));
  const entries = await entriesFor(db, sets.filter((s) => s.actorRef !== 'seed'), model, kv);
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/** Entries after `since` (since-you-left digest). */
/** What the since digest reads of an audit entry (`buildSince`). */
export type SinceSource = Pick<AuditEntry, 'id' | 'at' | 'actor' | 'action' | 'summary' | 'entity' | 'undoable' | 'undoneAt'>;

/** The audit row columns the since digest needs; `imgLabel` is imageLabel's title of the row image, read in SQL. */
interface SinceRow {
  changeSetId: string;
  rowId: string;
  entityType: string;
  entityId: string;
  changedFields: string[];
  imgLabel: string | null;
}

/**
 * Change sets after `since` that are news (not the user's, not undone, not seed/bootstrap; scanner sets by isNews), as
 * the since digest reads them: entity, action, summary, actor. PERF-1: the old path built full audit entries (every
 * audit image, field diffs, related labels) for every change set after `since`, then dropped most of them: on this
 * database's 30-day first scan that was 16k change sets and 12k audit images per /home and /today request.
 *  - isNews's scanner rule runs as a SQL prefilter (scanner bookkeeping sets with no news rows never leave Postgres);
 *  - audit rows come back without their images: only the columns below and the image's title (imageLabel);
 *  - one array parameter for the set ids, not one bind parameter per set.
 */
export async function sinceEntries(db: Db, userId: string, since: Date, model: ReadModel, kv: Map<string, unknown>): Promise<SinceSource[]> {
  const extIds = [...kv.keys()].filter((k) => k.startsWith(CS_EXT)).map((k) => k.slice(CS_EXT.length));
  const sets = await db
    .select()
    .from(changeSets)
    .where(
      and(
        eq(changeSets.ownerUserId, userId),
        gt(changeSets.createdAt, since),
        ne(changeSets.actorKind, 'user'),
        isNull(changeSets.undoneAt),
        sql`${changeSets.actorRef} is distinct from 'seed'`,
        sql`${changeSets.actorRef} is distinct from 'bootstrap'`,
        sql`(${changeSets.actorKind} <> 'connector' or ${changeSets.entityType} is not null or ${changeSets.id}::text = any(${pgArray(extIds)}::text[])
              or exists (select 1 from audit_events a where a.change_set_id = ${changeSets.id}
                and (a.entity_type = any(${pgArray(NEWS_ANY)}::text[]) or (a.entity_type = any(${pgArray(NEWS_STATUS)}::text[]) and 'status' = any(a.changed_fields)))))`,
      ),
    )
    .orderBy(asc(changeSets.createdAt));
  if (!sets.length) return [];
  const img = sql.raw(`coalesce(after, before)`);
  const title = (k: string) => sql`nullif(${img} -> ${k}, 'null'::jsonb)`;
  const v = sql`coalesce(${title('title')}, ${title('name')}, ${title('display_name')}, ${title('label')})`;
  const res = await db.execute<{ change_set_id: string; row_id: string; entity_type: string; entity_id: string; changed_fields: string[] | null; img_label: string | null }>(sql`
    select change_set_id, row_id, entity_type, entity_id, changed_fields, case when jsonb_typeof(${v}) = 'string' then ${v} #>> '{}' end as img_label
      from audit_events where change_set_id = any(${pgArray(sets.map((x) => x.id))}::uuid[]) order by id`);
  const byCs = new Map<string, SinceRow[]>();
  for (const r of res.rows) {
    const row: SinceRow = { changeSetId: r.change_set_id, rowId: r.row_id, entityType: r.entity_type, entityId: r.entity_id, changedFields: r.changed_fields ?? [], imgLabel: r.img_label };
    const l = byCs.get(row.changeSetId);
    if (l) l.push(row);
    else byCs.set(row.changeSetId, [row]);
  }
  return sets.filter((cs) => isNews(cs, byCs.get(cs.id) ?? [], kv)).map((cs) => toSinceEntry(cs, byCs.get(cs.id) ?? [], model, kv));
}

/** toEntry's id, at, actor, action, summary, entity and undo fields, from slim rows. */
function toSinceEntry(cs: CsRow, rows: SinceRow[], model: ReadModel, kv: Map<string, unknown>): SinceSource {
  const x = (kv.get(`${CS_EXT}${cs.id}`) as { entity?: EntityRef; actor?: Actor } | undefined) ?? {};
  const mainType = entityTypeOf(cs.entityType) ?? (rows[0] ? (ROOT_TYPE[rows[0].entityType] ?? 'settings') : 'settings');
  const mainId = cs.entityId ?? rows[0]?.entityId ?? cs.id;
  const label = labelFor(model, mainType, mainId);
  return {
    id: cs.id,
    at: cs.createdAt.toISOString(),
    actor: x.actor ?? ACTOR[cs.actorKind] ?? 'system',
    action: actionOf(cs),
    summary: cs.summary,
    entity: x.entity ?? { type: mainType, id: mainId, label: label === mainId ? (rows.find((r) => r.rowId === mainId && r.imgLabel !== null)?.imgLabel ?? label) : label, href: hrefFor({ type: mainType, id: mainId }) },
    undoable: cs.undoable,
    undoneAt: cs.undoneAt ? cs.undoneAt.toISOString() : null,
  };
}

const CS_EXT = `${EXT_PREFIX}change_sets/`;
/** Root tables whose audit rows make a scanner change set news: any change, or (connectors) a status change. */
const NEWS_ANY = Object.entries(ROOT_TYPE).filter(([, t]) => t !== 'connector').map(([table]) => table);
const NEWS_STATUS = Object.entries(ROOT_TYPE).filter(([, t]) => t === 'connector').map(([table]) => table);
/** A Postgres array literal of strings (one bind parameter). */
const pgArray = (xs: readonly string[]) => `{${xs.map((x) => `"${x.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

/**
 * Scanner change sets are news when they name an entity, carry display history (seeded entries), touched an
 * entity the user sees, or changed a connector's status. Their bookkeeping (registering a connector, spend,
 * cursors, a run's last-success stamp) is not: on a live database it is hundreds of change sets a day, and
 * Since you left counted each as "changed".
 */
function isNews(cs: CsRow, rows: ReadonlyArray<Pick<AuditRow, 'entityType' | 'changedFields'>>, kv: Map<string, unknown>): boolean {
  if (cs.actorKind !== 'connector' || cs.entityType || kv.has(`${EXT_PREFIX}change_sets/${cs.id}`)) return true;
  return rows.some((r) => {
    const t = ROOT_TYPE[r.entityType];
    if (!t) return false;
    return t !== 'connector' || r.changedFields.includes('status');
  });
}

/** Latest not-undone engine close of each item (for "Closed for you" undo), via Q6's transition log. */
export async function closeEntries(db: Db, userId: string, from: Date): Promise<Map<string, string>> {
  // Q6's rows (DATA-MODEL §6: its WHERE and ORDER BY), the two columns read here: its evidence joins are on primary
  // keys (one row each) and only fed columns nobody reads (post-2.0 Home SQL)
  const res = await db.execute<{ work_item_id: string; undo_change_set_id: string | null }>(sql`
    select t.work_item_id, t.change_set_id as undo_change_set_id
      from work_item_transitions t
      join work_items wi on wi.id = t.work_item_id
     where wi.owner_user_id = ${userId}
       and t.to_status = 'done' and t.actor_kind = 'engine'
       and t.occurred_at >= ${from.toISOString()} and t.undone_at is null
     order by t.occurred_at desc`);
  const out = new Map<string, string>();
  for (const r of res.rows) if (r.undo_change_set_id && !out.has(r.work_item_id)) out.set(r.work_item_id, r.undo_change_set_id);
  return out;
}

export async function latestChangeSets(db: Db, userId: string, limit = 50) {
  return db.select().from(changeSets).where(eq(changeSets.ownerUserId, userId)).orderBy(desc(changeSets.createdAt)).limit(limit);
}

/** Receipt lines (before → after per field) from a change set's audit rows. */
export async function receiptFromChangeSet(
  db: DbOrTx,
  changeSetId: string,
  model: ReadModel | null,
  actor: Actor,
  summary: string,
  at: string,
  filter?: (table: string, field: string) => boolean,
): Promise<Receipt> {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.changeSetId, changeSetId)).orderBy(asc(auditEvents.id));
  const changes: ReceiptChange[] = [];
  const skip = new Set(['rankReasons', 'score', 'priority', 'doc', 'savedAt', 'rendered']);
  for (const r of rows) {
    if (r.tableName === 'user_settings') continue;
    const t = ROOT_TYPE[r.tableName] ?? ROOT_TYPE[r.entityType];
    if (!t) continue;
    for (const c of changesOf([r])) {
      if (skip.has(c.field)) continue;
      if (filter && !filter(r.tableName, c.field)) continue;
      const id = r.tableName === 'work_items' || r.tableName === r.entityType ? r.rowId : r.entityId;
      changes.push({ auditId: changeSetId, entity: { type: t, id, label: labelFor(model, t, id), href: hrefFor({ type: t, id }) }, field: c.field, before: c.before, after: c.after });
    }
  }
  return { id: `rcpt_${changeSetId.slice(0, 8)}`, at, actor, summary, changes, staged: false };
}
