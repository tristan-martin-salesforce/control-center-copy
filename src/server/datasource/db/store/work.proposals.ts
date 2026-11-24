// Initiatives and change proposals: load and insert. Split from work.ts (max-lines); work.ts re-exports the public names.
import { asc, desc, eq, inArray } from 'drizzle-orm';

import type { FieldChange, Initiative, Proposal, SourceRef, WorkItemRecord } from '@/contract';
import { changeProposals, initiativeLinks, initiatives, sourceItems, workItemEvidence } from '@/db/schema';
import { sourceItemUrl } from '@/projections/links';
import {
  kindFromDb, sourceFromDb, sourceItemKind, sourceToDb, stateFromDb, stateToDb, type DbWorkKind, type DbWorkStatus,
} from '../enums';
import { hashKey, uuidFor, uuidOrNull } from '../ids';
import { plainText as docPlainText, textDiff } from '../../mock/render';
import { ext, iso, isoReq, personRef, toDate, writeExt, type ReadCtx, type WriteCtx } from './common';
import { COLUMN_FIELD, WORK_FIELD_COLUMN } from './work.columns';
import { FIELD_LABEL } from './work.load';

// ---------------------------------------------------------------------------
// Initiatives
// ---------------------------------------------------------------------------

const INI_LOCK: Record<string, string> = { title: 'title', purpose: 'purpose', summary: 'background_summary', status: 'status' };
const INI_LOCK_REV = Object.fromEntries(Object.entries(INI_LOCK).map(([f, c]) => [c, f]));
export async function loadInitiatives(rc: ReadCtx): Promise<Initiative[]> {
  const rows = await rc.db.select().from(initiatives).where(eq(initiatives.ownerUserId, rc.userId)).orderBy(asc(initiatives.createdAt), asc(initiatives.id));
  if (!rows.length) return [];
  const links = await rc.db
    .select()
    .from(initiativeLinks)
    .where(inArray(initiativeLinks.initiativeId, rows.map((r) => r.id)))
    .orderBy(asc(initiativeLinks.createdAt), asc(initiativeLinks.id));
  return rows.map((r) => {
    const x = ext<{ timeline: Initiative['timeline'] }>(rc, 'initiatives', r.id);
    const ls = links.filter((l) => l.initiativeId === r.id);
    return {
      id: r.id,
      version: r.version,
      title: r.title,
      purpose: r.purpose,
      summary: r.backgroundSummary ?? '',
      status: r.status,
      accountId: r.accountId,
      oppId: r.opportunityId,
      targetEventId: r.targetEventId,
      people: ls.filter((l) => l.personId).map((l) => personRef(rc, l.personId)!),
      assetIds: ls.filter((l) => l.assetId).map((l) => l.assetId!),
      timeline: x.timeline ?? [],
      userLockedFields: r.userLockedFields.map((c) => INI_LOCK_REV[c]).filter((f): f is Initiative['userLockedFields'][number] => !!f),
      createdAt: isoReq(r.createdAt),
      updatedAt: isoReq(r.updatedAt),
    };
  });
}
export async function insertInitiative(w: WriteCtx, ini: Initiative, hasAsset: (id: string) => boolean): Promise<string> {
  const id = uuidFor(ini.id);
  await w.tx.insert(initiatives).values({
    id,
    ownerUserId: w.userId,
    title: ini.title,
    purpose: ini.purpose,
    backgroundSummary: ini.summary,
    status: ini.status,
    accountId: uuidOrNull(ini.accountId),
    opportunityId: uuidOrNull(ini.oppId),
    targetEventId: uuidOrNull(ini.targetEventId),
    createdBy: 'engine',
    userLockedFields: ini.userLockedFields.map((f) => INI_LOCK[f]!).sort(),
    version: ini.version,
    createdAt: toDate(ini.createdAt)!,
    updatedAt: toDate(ini.updatedAt)!,
  });
  let i = 0;
  const at = () => new Date(Date.parse(ini.createdAt) + i++);
  const values: (typeof initiativeLinks.$inferInsert)[] = [
    ...ini.people.map((p) => ({ initiativeId: id, personId: uuidFor(p.id), role: 'stakeholder' as const, method: 'user' as const, confidence: 1, createdAt: at() })),
    ...ini.assetIds.filter(hasAsset).map((a) => ({ initiativeId: id, assetId: uuidFor(a), role: 'asset' as const, method: 'user' as const, confidence: 1, createdAt: at() })),
  ];
  if (values.length) await w.tx.insert(initiativeLinks).values(values).onConflictDoNothing();
  await writeExt(w, 'initiatives', id, { timeline: ini.timeline });
  return id;
}
// ---------------------------------------------------------------------------
// Proposals (change_proposals; one row per field, grouped by group_id into one contract Proposal)
// ---------------------------------------------------------------------------

/** Proposal metadata the rows can't carry (source chip, actor, the contract field names). */
interface ProposalExt {
  actor: Proposal['actor'];
  source: SourceRef | null;
  label: string;
  /** Display labels of the changed fields (seeded proposals carry them; engine proposals don't). */
  labels: Record<string, string>;
}
const PROPOSAL_ENTITY: Record<string, Proposal['entity']['type']> = { work_items: 'work_item', drafts: 'draft', initiatives: 'initiative', activity_entries: 'activity_entry', priority_policies: 'policy' };
export const PROPOSAL_TABLE: Record<string, string> = Object.fromEntries(Object.entries(PROPOSAL_ENTITY).map(([t, e]) => [e, t]));
/** db column value → contract value for a proposal line. */
function contractValue(table: string, column: string, v: unknown): { field: string; value: unknown } {
  if (table === 'work_items') {
    const field = COLUMN_FIELD[column] ?? column;
    if (column === 'status' && typeof v === 'string') return { field, value: stateFromDb(v as DbWorkStatus, false) };
    if (column === 'kind' && typeof v === 'string') return { field, value: kindFromDb(v as DbWorkKind) };
    if ((column === 'due_at' || column === 'deadline_event_id') && v) return { field, value: column === 'due_at' ? iso(v as string) : v };
    return { field, value: v ?? null };
  }
  if (table === 'drafts' && column === 'doc_json') return { field: 'doc', value: v };
  return { field: column, value: v ?? null };
}
export async function loadProposals(rc: ReadCtx, labelOf: (type: Proposal['entity']['type'], id: string) => string): Promise<Proposal[]> {
  const rows = await rc.db
    .select({ p: changeProposals, si: sourceItems })
    .from(changeProposals)
    .leftJoin(sourceItems, eq(sourceItems.id, changeProposals.sourceItemId))
    .where(eq(changeProposals.ownerUserId, rc.userId))
    .orderBy(asc(changeProposals.createdAt), asc(changeProposals.field));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!groups.has(r.p.groupId)) groups.set(r.p.groupId, []);
    groups.get(r.p.groupId)!.push(r);
  }
  const out: Proposal[] = [];
  for (const [groupId, rs] of groups) {
    const first = rs[0]!.p;
    const x = ext<ProposalExt>(rc, 'change_proposals', groupId);
    const type = PROPOSAL_ENTITY[first.entityType] ?? 'work_item';
    const changes: FieldChange[] = [];
    for (const { p } of rs) {
      const before = contractValue(p.entityType, p.field, p.currentValue);
      const after = contractValue(p.entityType, p.field, p.proposedValue);
      if (p.field === 'lead_time_minutes') continue; // folded into effort below
      if (p.field === 'effort_minutes') continue;
      const label = x.labels?.[before.field] ?? (before.field === 'doc' ? FIELD_LABEL.doc : undefined);
      changes.push({ field: before.field, ...(label ? { label } : {}), before: before.value, after: after.value });
    }
    if (!changes.length) continue;
    const statuses = rs.map((r) => r.p.status);
    const status: Proposal['status'] = statuses.includes('pending')
      ? 'pending'
      : statuses.includes('accepted')
        ? 'applied'
        : statuses.includes('rejected')
          ? 'rejected'
          : 'superseded';
    const si = rs.find((r) => r.si)?.si;
    const meta = (si?.meta ?? {}) as { label?: string };
    const siUrl = si ? sourceItemUrl({ source: si.source, externalId: si.externalId, url: si.url, meta: si.meta as Record<string, unknown> }) : null;
    const source: SourceRef | null = x.source ?? (si ? { kind: sourceFromDb(si.source), label: meta.label ?? si.title ?? 'Source', ...(siUrl ? { url: siUrl } : {}) } : null);
    out.push({
      id: groupId,
      entity: { type, id: first.entityId, label: x.label ?? labelOf(type, first.entityId) },
      changes,
      reason: first.reason,
      source,
      createdAt: isoReq(first.createdAt),
      status,
      actor: x.actor ?? 'engine',
      baseVersion: first.baseVersion || null,
      textDiff: docDiff(rs.map((r) => r.p)),
      resolvedAt: iso(rs.map((r) => r.p.decidedAt).filter(Boolean).sort().pop() ?? null),
    });
  }
  return out;
}
function docDiff(rows: (typeof changeProposals.$inferSelect)[]): Proposal['textDiff'] {
  const doc = rows.find((r) => r.entityType === 'drafts' && r.field === 'doc_json');
  if (!doc) return null;
  const text = (v: unknown) => (v && typeof v === 'object' ? docPlainText(v as never) : '');
  return textDiff(text(doc.currentValue), text(doc.proposedValue));
}
/** Seed / import a contract proposal verbatim (one row per change, shared group id = proposal id). */
export async function insertProposal(w: WriteCtx, p: Proposal): Promise<string> {
  const groupId = uuidFor(p.id);
  const table = PROPOSAL_TABLE[p.entity.type];
  if (!table) throw new Error(`proposal ${p.id}: unsupported entity ${p.entity.type}`);
  let sourceItemId: string | null = null;
  if (p.source) {
    sourceItemId = uuidFor(`source:${p.id}`);
    await w.tx
      .insert(sourceItems)
      .values({
        id: sourceItemId,
        ownerUserId: w.userId,
        source: sourceToDb(p.source.kind),
        kind: sourceItemKind(p.source.kind),
        externalId: p.source.externalId ?? `proposal:${p.id}`,
        dedupeKey: `cc.proposal:${p.id}`,
        contentHash: hashKey(p.reason),
        occurredAt: toDate(p.source.at ?? p.createdAt)!,
        title: p.source.label,
        url: p.source.url ?? null,
        meta: { label: p.source.label },
      })
      .onConflictDoNothing();
  }
  const status = p.status === 'applied' ? 'accepted' : p.status;
  for (const c of p.changes) {
    const column = table === 'work_items' ? (WORK_FIELD_COLUMN[c.field] ?? c.field) : table === 'drafts' && c.field === 'doc' ? 'doc_json' : c.field;
    const toDb = (v: unknown) => (table === 'work_items' && column === 'status' && typeof v === 'string' ? stateToDb(v as WorkItemRecord['state']) : v);
    await w.tx.insert(changeProposals).values({
      id: p.changes.length === 1 ? groupId : uuidFor(`${p.id}:${c.field}`),
      ownerUserId: w.userId,
      entityType: table,
      entityId: uuidFor(p.entity.id),
      field: column,
      groupId,
      currentValue: (toDb(c.before) ?? null) as never,
      proposedValue: (toDb(c.after) ?? null) as never,
      reason: p.reason,
      sourceItemId,
      baseVersion: p.baseVersion ?? 0,
      status,
      decidedAt: toDate(p.resolvedAt),
      createdAt: toDate(p.createdAt)!,
    });
  }
  const labels = Object.fromEntries(p.changes.filter((c) => c.label).map((c) => [c.field, c.label!]));
  await writeExt(w, 'change_proposals', groupId, { actor: p.actor === 'engine' ? undefined : p.actor, source: null, label: p.entity.label, labels: Object.keys(labels).length ? labels : undefined });
  return groupId;
}
/** Ids of evidence rows for an item (for undo-safe resolution evidence references). */
export async function evidenceIdsFor(w: WriteCtx, itemId: string): Promise<string[]> {
  const rows = await w.tx.select({ id: workItemEvidence.id }).from(workItemEvidence).where(eq(workItemEvidence.workItemId, uuidFor(itemId))).orderBy(desc(workItemEvidence.createdAt));
  return rows.map((r) => r.id);
}
