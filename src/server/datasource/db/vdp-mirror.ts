/**
 * D-98 (0036): the VDP mirror's child tables (src/db/schema/vdp-mirror.ts) and the inbound mirror convention.
 *
 *   childRowsOf(snapshot)       the parts of a VDP the app reads and edits, as rows: use cases, assets, members.
 *   withChildren(base, rows)    the snapshot back from those rows (the exact arrays a read stored, in order), over the
 *                               rest of the stored payload (company, stakeholders, header): what every reader gets.
 *   writeVdpChildren()          one read's rows for one VDP: replaced in place, `mirrored_at` stamped, a phase change
 *                               appended to `vdp_use_case_phases` (stage history).
 *   recordMirrorRead()          one `mirror_reads` row per read: source, scope, rows, complete, a hash of what it saw.
 *
 * Pure mapping plus SQL; no external call. The blob (`vdp_records.detail`) is still written for one release: readers
 * outside the store (projections, activity notes) read it until 2.1.
 */
import { createHash } from 'node:crypto';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { mirrorReads, vdpAssets, vdpMembers, vdpUseCasePhases, vdpUseCases } from '@/db/schema';
import type { VdpAsset, VdpPerson, VdpSnapshot, VdpUseCase } from '@/lib/vdp/types';

export type MemberRole = 'ae' | 'ta' | 'collaborator' | 'creator';

export interface VdpChildRows {
  useCases: (Omit<typeof vdpUseCases.$inferInsert, 'ownerUserId' | 'vdpRecordId' | 'mirroredAt'>)[];
  assets: (Omit<typeof vdpAssets.$inferInsert, 'ownerUserId' | 'vdpRecordId' | 'mirroredAt'>)[];
  members: (Omit<typeof vdpMembers.$inferInsert, 'ownerUserId' | 'vdpRecordId' | 'mirroredAt'>)[];
}

const person = (role: MemberRole, p: VdpPerson, ordinal: number) => ({ role, ordinal, email: p.email, name: p.name, placeholder: !!p.placeholder });

/** The child rows of one VDP read. */
export function childRowsOf(s: VdpSnapshot): VdpChildRows {
  return {
    useCases: s.useCases.map((u, i) => ({
      vdpUseCaseId: u.id,
      ordinal: i,
      track: u.track,
      displayOrder: u.displayOrder,
      title: u.title,
      priority: u.priority,
      division: u.division,
      persona: u.persona,
      detailsInput: u.detailsInput,
      executionPhase: u.executionPhase,
      executionStartDate: u.executionStartDate,
      executionTargetDate: u.executionTargetDate,
      executionDurationValue: u.executionDurationValue,
      executionDurationUnit: u.executionDurationUnit,
      hasAi: u.hasAi,
      generatedFields: u.generatedFields,
      painThemeId: u.painThemeId,
      sourceLibraryId: u.sourceLibraryId,
      vdpCreatedAt: u.createdAt,
      vdpUpdatedAt: u.updatedAt,
      detailLoaded: u.detailLoaded,
    })),
    assets: s.assets.map((a, i) => ({ vdpAssetId: a.id, ordinal: i, title: a.title, url: a.url, type: a.type, description: a.description, deliverableType: a.deliverableType ?? null, deliverableRead: 'deliverableType' in a })),
    members: [...s.aes.map((p, i) => person('ae', p, i)), ...s.tas.map((p, i) => person('ta', p, i)), ...s.collaborators.map((p, i) => person('collaborator', p, i)), ...(s.createdBy ? [person('creator', s.createdBy, 0)] : [])],
  };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function useCaseOf(r: VdpChildRows['useCases'][number]): VdpUseCase {
  return {
    id: r.vdpUseCaseId,
    track: r.track,
    displayOrder: r.displayOrder ?? 0,
    title: r.title ?? null,
    priority: r.priority ?? null,
    division: r.division ?? null,
    persona: r.persona ?? null,
    detailsInput: r.detailsInput ?? null,
    executionPhase: r.executionPhase ?? null,
    executionStartDate: r.executionStartDate ?? null,
    executionTargetDate: r.executionTargetDate ?? null,
    executionDurationValue: num(r.executionDurationValue),
    executionDurationUnit: r.executionDurationUnit ?? null,
    hasAi: !!r.hasAi,
    generatedFields: (r.generatedFields as Record<string, unknown> | null | undefined) ?? null,
    painThemeId: r.painThemeId ?? null,
    sourceLibraryId: r.sourceLibraryId ?? null,
    createdAt: r.vdpCreatedAt ?? null,
    updatedAt: r.vdpUpdatedAt ?? null,
    detailLoaded: !!r.detailLoaded,
  };
}

function assetOf(r: VdpChildRows['assets'][number]): VdpAsset {
  const a: VdpAsset = { id: r.vdpAssetId, title: r.title ?? null, url: r.url, type: r.type ?? null, description: r.description ?? null };
  if (r.deliverableRead) a.deliverableType = r.deliverableType ?? null;
  return a;
}

const personOf = (r: VdpChildRows['members'][number]): VdpPerson => ({ email: r.email ?? null, name: r.name ?? null, placeholder: !!r.placeholder });

/** The snapshot with its use cases, assets and people taken from the child rows (the rest from the stored payload). */
export function withChildren(base: VdpSnapshot, rows: VdpChildRows): VdpSnapshot {
  const by = (role: MemberRole) => rows.members.filter((m) => m.role === role).sort((a, b) => a.ordinal - b.ordinal);
  const creator = by('creator')[0];
  return {
    ...base,
    aes: by('ae').map(personOf),
    tas: by('ta').map(personOf),
    collaborators: by('collaborator').map(personOf),
    createdBy: creator ? personOf(creator) : null,
    useCases: [...rows.useCases].sort((a, b) => a.ordinal - b.ordinal).map(useCaseOf),
    assets: [...rows.assets].sort((a, b) => a.ordinal - b.ordinal).map(assetOf),
  };
}

/** Replace one VDP's child rows with what this read saw; a use case whose phase moved gets a stage-history row. */
export async function writeVdpChildren(db: DbOrTx, userId: string, vdpRecordId: string, s: VdpSnapshot, readAt: Date): Promise<void> {
  const rows = childRowsOf(s);
  const before = await db.select({ id: vdpUseCases.vdpUseCaseId, phase: vdpUseCases.executionPhase }).from(vdpUseCases).where(eq(vdpUseCases.vdpRecordId, vdpRecordId));
  const had = new Map(before.map((b) => [b.id, b.phase] as const));
  const moved = rows.useCases.filter((u) => !had.has(u.vdpUseCaseId) || (had.get(u.vdpUseCaseId) ?? null) !== (u.executionPhase ?? null));
  if (moved.length) await db.insert(vdpUseCasePhases).values(moved.map((u) => ({ ownerUserId: userId, vdpRecordId, vdpUseCaseId: u.vdpUseCaseId, phase: u.executionPhase ?? null, observedAt: readAt })));
  await db.delete(vdpUseCases).where(eq(vdpUseCases.vdpRecordId, vdpRecordId));
  await db.delete(vdpAssets).where(eq(vdpAssets.vdpRecordId, vdpRecordId));
  await db.delete(vdpMembers).where(eq(vdpMembers.vdpRecordId, vdpRecordId));
  const stamp = { ownerUserId: userId, vdpRecordId, mirroredAt: readAt };
  if (rows.useCases.length) await db.insert(vdpUseCases).values(rows.useCases.map((u) => ({ ...u, ...stamp })));
  if (rows.assets.length) await db.insert(vdpAssets).values(rows.assets.map((a) => ({ ...a, ...stamp })));
  if (rows.members.length) await db.insert(vdpMembers).values(rows.members.map((m) => ({ ...m, ...stamp })));
  await db.execute(sql`update vdp_records set mirrored_at = ${readAt.toISOString()}::timestamptz where id = ${vdpRecordId}::uuid`);
}

/** The child rows of these VDP records (by vdp_records.id), one query per table. */
export async function loadVdpChildren(db: DbOrTx, userId: string, recordIds: readonly string[]): Promise<Map<string, VdpChildRows>> {
  const out = new Map<string, VdpChildRows>(recordIds.map((id) => [id, { useCases: [], assets: [], members: [] }] as const));
  if (!recordIds.length) return out;
  const ids = [...recordIds];
  // one after another: inside a transaction one client runs one query at a time
  const ucs = await db.select().from(vdpUseCases).where(and(eq(vdpUseCases.ownerUserId, userId), inArray(vdpUseCases.vdpRecordId, ids))).orderBy(asc(vdpUseCases.ordinal));
  const as = await db.select().from(vdpAssets).where(and(eq(vdpAssets.ownerUserId, userId), inArray(vdpAssets.vdpRecordId, ids))).orderBy(asc(vdpAssets.ordinal));
  const ms = await db.select().from(vdpMembers).where(and(eq(vdpMembers.ownerUserId, userId), inArray(vdpMembers.vdpRecordId, ids))).orderBy(asc(vdpMembers.ordinal));
  for (const u of ucs) out.get(u.vdpRecordId)?.useCases.push(u);
  for (const a of as) out.get(a.vdpRecordId)?.assets.push(a);
  for (const m of ms) out.get(m.vdpRecordId)?.members.push(m);
  return out;
}

/** A read's hash: sha256 over what it saw, in order (ids and activity stamps), first 16 hex. */
export function readHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/** One row per read of an external system (the inbound mirror convention). */
export async function recordMirrorRead(db: DbOrTx, userId: string, r: { source: string; scope: string; readAt: Date; rows: number; complete: boolean; hash: string }): Promise<void> {
  await db.insert(mirrorReads).values({ ownerUserId: userId, source: r.source, scope: r.scope, readAt: r.readAt, rows: r.rows, complete: r.complete, hash: r.hash });
}

/** The newest read of one (source, scope), or null before the first. */
export async function lastMirrorRead(db: DbOrTx, userId: string, source: string, scope: string): Promise<{ readAt: string; rows: number; complete: boolean; hash: string } | null> {
  const r = await db.execute<{ read_at: Date | string; rows: number; complete: boolean; hash: string }>(sql`
    select read_at, rows, complete, hash from mirror_reads where owner_user_id = ${userId}::uuid and source = ${source} and scope = ${scope} order by read_at desc, id desc limit 1`);
  const x = r.rows[0];
  return x ? { readAt: new Date(x.read_at).toISOString(), rows: Number(x.rows), complete: x.complete, hash: x.hash } : null;
}
