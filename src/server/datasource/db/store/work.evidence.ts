// Evidence rows: load, insert, update, source refs. Split from work.ts (max-lines); work.ts re-exports the public names.
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Evidence, SourceRef } from '@/contract';
import { sourceItems, workItemEvidence, workItems } from '@/db/schema';
import { sourceItemUrl } from '@/projections/links';
import { applyOverride, confToNum, numToConf, sourceFromDb, sourceItemKind, sourceToDb, type Override } from '../enums';
import { hashKey, uuidFor } from '../ids';
import { ext, iso, isoReq, toDate, writeExt, type ReadCtx, type WriteCtx } from './common';

// ---------------------------------------------------------------------------
// Evidence (work_item_evidence + one source_items row per evidence)
// ---------------------------------------------------------------------------

interface EvidenceExt {
  isNew: Override<'true' | 'false', 'true' | 'false'>;
}
interface EvidenceMeta {
  label?: string;
  author?: string | { name?: string | null; email?: string | null } | null;
  sourceAt?: string | null;
  externalId?: string | null;
  channelName?: unknown;
  subject?: unknown;
}
const SOURCE_LABEL: Partial<Record<SourceRef['kind'], string>> = { slack: 'Slack message', gmail: 'Email', calendar: 'Calendar event', drive: 'Drive file', gemini: 'Meeting notes', org62: 'Org62 record', claude: 'Claude session', vdp: 'VDP' };
/** The scanner's author is {name, email, externalId, isMe}; the contract shows a name. */
function authorName(a: EvidenceMeta['author']): string | null {
  if (typeof a === 'string') return a || null;
  if (a && typeof a === 'object') return a.name || a.email || null;
  return null;
}
function scannerLabel(m: EvidenceMeta): string | null {
  if (typeof m.channelName === 'string' && m.channelName) return `#${m.channelName.replace(/^#/, '')}`;
  if (typeof m.subject === 'string' && m.subject) return m.subject;
  return null;
}
/**
 * The source item columns a source chip reads (post-2.0 read profile: the evidence reads selected every column, the
 * search vector and the scan bookkeeping included, about half of a page's bytes on Home and Triage).
 */
export const sourceChipCols = { id: sourceItems.id, source: sourceItems.source, externalId: sourceItems.externalId, url: sourceItems.url, meta: sourceItems.meta, title: sourceItems.title, occurredAt: sourceItems.occurredAt };
export type SourceChipRow = Pick<typeof sourceItems.$inferSelect, 'source' | 'externalId' | 'url' | 'meta' | 'title' | 'occurredAt'>;

/** A source item as a source chip, linked to the original (derived from its ids when it has no stored link). */
export function sourceRefOf(si: SourceChipRow): SourceRef {
  const meta = (si.meta ?? {}) as EvidenceMeta;
  const kind = sourceFromDb(si.source);
  const externalId = 'externalId' in meta ? meta.externalId : si.externalId;
  const sourceAt = 'sourceAt' in meta ? meta.sourceAt : iso(si.occurredAt);
  const url = sourceItemUrl({ source: si.source, externalId: si.externalId, url: si.url, meta: si.meta as Record<string, unknown> });
  return {
    kind,
    label: meta.label ?? si.title ?? scannerLabel(meta) ?? SOURCE_LABEL[kind] ?? 'Source',
    ...(url ? { url } : {}),
    ...(externalId ? { externalId } : {}),
    ...(sourceAt ? { at: sourceAt } : {}),
  };
}
/** `itemIds`: only those items' evidence (a page scope, reads/scope.ts); omitted = every item's. */
export async function loadEvidence(rc: ReadCtx, itemIds?: readonly string[]): Promise<Evidence[]> {
  if (itemIds && !itemIds.length) return [];
  const rows = await rc.db
    .select({ e: workItemEvidence, si: { ...sourceChipCols, body: sourceItems.body }, seen: workItems.seenByUserAt })
    .from(workItemEvidence)
    .innerJoin(workItems, eq(workItems.id, workItemEvidence.workItemId))
    .leftJoin(sourceItems, eq(sourceItems.id, workItemEvidence.sourceItemId))
    .where(itemIds ? and(eq(workItems.ownerUserId, rc.userId), inArray(workItemEvidence.workItemId, [...itemIds])) : eq(workItems.ownerUserId, rc.userId))
    .orderBy(asc(workItemEvidence.createdAt), asc(workItemEvidence.id));
  return rows.map(({ e, si, seen }) => {
    const meta = (si?.meta ?? {}) as EvidenceMeta;
    const derivedNew = !!seen && e.createdAt.getTime() > seen.getTime();
    const x = ext<EvidenceExt>(rc, 'work_item_evidence', e.id);
    const isNew = applyOverride(derivedNew ? 'true' : 'false', derivedNew ? 'true' : 'false', x.isNew) === 'true';
    const kind = si ? sourceFromDb(si.source) : 'manual';
    // app-written source items carry label / sourceAt / externalId in meta; the scanner's carry its own meta
    // (channelName, subject, author object) and the columns
    const externalId = 'externalId' in meta ? meta.externalId : (si?.externalId ?? null);
    const sourceAt = 'sourceAt' in meta ? meta.sourceAt : si ? iso(si.occurredAt) : null;
    // Rows stored before their source had a link (Org62, Claude sessions) get it derived from their ids.
    const srcUrl = si ? sourceItemUrl({ source: si.source, externalId: si.externalId, url: si.url, meta: si.meta as Record<string, unknown> }) : null;
    const source: SourceRef = {
      kind,
      label: meta.label ?? si?.title ?? scannerLabel(meta) ?? SOURCE_LABEL[kind] ?? 'Source',
      ...(srcUrl ? { url: srcUrl } : {}),
      ...(externalId ? { externalId } : {}),
      ...(sourceAt ? { at: sourceAt } : {}),
    };
    return {
      id: e.id,
      workItemId: e.workItemId,
      role: e.role,
      source,
      at: isoReq(e.createdAt),
      summary: e.rationale ?? '',
      snippet: si?.body ?? null,
      author: authorName(meta.author),
      isNew,
      confidence: e.confidence === 0.5 ? null : numToConf(e.confidence),
    };
  });
}
/** isNew is derived (created after the item was last seen); store an override when it disagrees. */
export function evidenceNewOverride(ev: Evidence, itemSeenAt: string | null): Override<'true' | 'false', 'true' | 'false'> | null {
  const derived = !!itemSeenAt && Date.parse(ev.at) > Date.parse(itemSeenAt);
  return derived === ev.isNew ? null : { value: ev.isNew ? 'true' : 'false', when: derived ? 'true' : 'false' };
}
export async function insertEvidence(w: WriteCtx, ev: Evidence, itemSeenAt: string | null, createdBy: 'user' | 'engine' | 'chat' | 'connector' | 'system' = 'engine'): Promise<string> {
  const id = uuidFor(ev.id);
  const srcId = uuidFor(`source:${ev.id}`);
  await w.tx.insert(sourceItems).values({
    id: srcId,
    ownerUserId: w.userId,
    source: sourceToDb(ev.source.kind),
    kind: sourceItemKind(ev.source.kind),
    externalId: ev.source.externalId ?? `evidence:${ev.id}`,
    dedupeKey: `cc.evidence:${ev.id}`,
    contentHash: hashKey(ev.summary, ev.snippet),
    occurredAt: toDate(ev.source.at ?? ev.at)!,
    title: ev.source.label,
    url: ev.source.url ?? null,
    body: ev.snippet,
    meta: { label: ev.source.label, author: ev.author, sourceAt: ev.source.at ?? null, externalId: ev.source.externalId ?? null },
  });
  await w.tx.insert(workItemEvidence).values({
    id,
    workItemId: uuidFor(ev.workItemId),
    sourceItemId: srcId,
    role: ev.role,
    confidence: ev.confidence ? confToNum(ev.confidence) : 0.5,
    extractorId: w.extractorId,
    rationale: ev.summary,
    createdBy,
    createdAt: toDate(ev.at)!,
    updatedAt: toDate(ev.at)!,
  });
  const o = evidenceNewOverride(ev, itemSeenAt);
  await writeExt(w, 'work_item_evidence', id, o ? { isNew: o } : null);
  return id;
}
export async function updateEvidence(w: WriteCtx, cur: Evidence, next: Evidence, itemSeenAt: string | null) {
  const id = uuidFor(cur.id);
  if (cur.workItemId !== next.workItemId) {
    await w.tx.update(workItemEvidence).set({ workItemId: uuidFor(next.workItemId) }).where(eq(workItemEvidence.id, id));
  }
  const o = evidenceNewOverride(next, itemSeenAt);
  await writeExt(w, 'work_item_evidence', id, o ? { isNew: o } : null);
}
