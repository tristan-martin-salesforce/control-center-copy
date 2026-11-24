/**
 * VDP asset candidates over Postgres (`vdp_asset_candidates`, migration 0011) and the "Find assets" runs (`jobs` rows
 * of kind `vdp.assets.find`). Local state only: nothing here calls VDP.
 *
 *  - upsertCandidates: one row per (target, asset key). A new sighting adds its source and may raise the confidence
 *    (an unsure one becomes suggested on stronger evidence); it never resets a row the user moved (added, dismissed)
 *    or one VDP already shows (in_vdp).
 *  - reconcileCandidates: after a mirror read, an open candidate the VDP now shows (same link or title) is closed
 *    (`in_vdp`), and a candidate waiting for a VDP that now exists is adopted by it.
 *  - setCandidateStatus: confirm, mark added, dismiss, put back; refused for `in_vdp`.
 * Logs carry counts only; titles and links stay in the table.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { budgetsForDay, type Settings, type VdpBackfillRun, type VdpCandidateSource, type VdpCandidateStatus } from '@/contract';
import type { Db, DbOrTx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { vdpAssetCandidates } from '@/db/schema';
import { inVdp, mergeDraft, screenCandidates, screenDrafts, type CandidateDraft } from '@/engines/vdp/assets';
import { linkVdp, type GapAccount, type GapOpp } from '@/engines/vdp/gaps';
import type { VdpSnapshot } from '@/lib/vdp/types';
import { chatLimitsFromEnv } from '@/server/chat/outputs';
import { notFound } from '@/server/errors';
import { checkTransition, type CandidateRecord } from '@/server/vdp/detail';

export { checkTransition };

export const VDP_ASSETS_JOB = 'vdp.assets.find';
export const VDP_ASSETS_QUEUE = 'vdp';
export const vdpAssetsDedupeKey = (key: string) => `${VDP_ASSETS_JOB}:${key}`;

type Row = typeof vdpAssetCandidates.$inferSelect;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function recordOf(r: Row): CandidateRecord {
  return {
    id: r.id,
    targetKey: r.targetKey,
    vdpSlug: r.vdpSlug,
    accountId: r.accountId,
    companyName: r.companyName,
    title: r.title,
    url: r.url,
    assetKey: r.assetKey,
    kind: r.kind as CandidateRecord['kind'],
    why: r.why,
    confidence: Number(r.confidence),
    origin: r.origin as CandidateRecord['origin'],
    status: r.status as VdpCandidateStatus,
    sources: (r.sources ?? []) as unknown as VdpCandidateSource[],
    firstSeenAt: iso(r.firstSeenAt)!,
    statusAt: iso(r.statusAt),
  };
}

export async function loadCandidates(db: DbOrTx, userId: string): Promise<CandidateRecord[]> {
  const rows = await db.select().from(vdpAssetCandidates).where(eq(vdpAssetCandidates.ownerUserId, userId)).orderBy(vdpAssetCandidates.firstSeenAt, vdpAssetCandidates.id);
  // screened at read time: open candidates that aren't worth a VDP (meeting notes, internal prep, untitled links,
  // copies) never show, so a better rule needs no data patch (2026-11-14)
  return screenCandidates(rows.map(recordOf));
}

const keyOf = (d: { targetKey: string; assetKey: string }) => `${d.targetKey}|${d.assetKey}`;

/** Record sightings (matcher, backfill or chat). Returns how many rows were added and how many gained a source. */
export async function upsertCandidates(db: DbOrTx, userId: string, drafts: readonly CandidateDraft[], o: { origin: CandidateRecord['origin']; now: Date }): Promise<{ added: number; updated: number; ids: string[] }> {
  const all = new Map<string, CandidateDraft>();
  for (const d of drafts) all.set(keyOf(d), all.has(keyOf(d)) ? mergeDraft(all.get(keyOf(d))!, d) : d);
  // the screen every producer applies (matcher, research, chat), once more where they are stored: nothing unworthy lands
  const merged = new Map(screenDrafts([...all.values()]).map((d) => [keyOf(d), d]));
  if (!merged.size) return { added: 0, updated: 0, ids: [] };
  const targets = [...new Set([...merged.values()].map((d) => d.targetKey))];
  const existing = await db.select().from(vdpAssetCandidates).where(and(eq(vdpAssetCandidates.ownerUserId, userId), inArray(vdpAssetCandidates.targetKey, targets)));
  const byKey = new Map(existing.map((r) => [keyOf(r), r]));
  let added = 0;
  let updated = 0;
  const ids: string[] = [];
  for (const d of merged.values()) {
    const cur = byKey.get(keyOf(d));
    if (!cur) {
      const [row] = await db
        .insert(vdpAssetCandidates)
        .values({
          ownerUserId: userId,
          targetKey: d.targetKey,
          vdpSlug: d.vdpSlug,
          accountId: d.accountId,
          companyName: d.companyName,
          title: d.title,
          url: d.url,
          assetKey: d.assetKey,
          kind: d.kind,
          why: d.why,
          confidence: d.confidence,
          origin: o.origin,
          status: d.status,
          sources: d.sources as unknown as Array<Record<string, unknown>>,
          sourceItemIds: d.sourceItemIds,
          firstSeenAt: o.now,
          lastSeenAt: o.now,
        })
        .onConflictDoNothing()
        .returning({ id: vdpAssetCandidates.id });
      if (row) {
        added += 1;
        ids.push(row.id);
      }
      continue;
    }
    ids.push(cur.id);
    const prev = recordOf(cur);
    // every sighting stays (tenet *Provenance on everything*; caps audit 2026-11-21: was 8 sources and 20 items)
    const sources = [...prev.sources, ...d.sources.filter((s) => !prev.sources.some((x) => x.url === s.url && x.label === s.label))];
    const stronger = d.confidence > prev.confidence;
    const open = prev.status === 'unsure' || prev.status === 'suggested';
    const patch: Partial<typeof vdpAssetCandidates.$inferInsert> = {};
    if (sources.length !== prev.sources.length) patch.sources = sources as unknown as Array<Record<string, unknown>>;
    if (stronger && open) {
      patch.confidence = d.confidence;
      patch.why = d.why;
      if (prev.status === 'unsure' && d.status === 'suggested') patch.status = 'suggested';
    }
    if (!cur.vdpSlug && d.vdpSlug) patch.vdpSlug = d.vdpSlug;
    const ids2 = [...new Set([...(cur.sourceItemIds ?? []), ...d.sourceItemIds])];
    if (ids2.length !== (cur.sourceItemIds ?? []).length) patch.sourceItemIds = ids2;
    if (!Object.keys(patch).length) continue;
    await db.update(vdpAssetCandidates).set({ ...patch, lastSeenAt: o.now, updatedAt: o.now }).where(eq(vdpAssetCandidates.id, cur.id));
    updated += 1;
  }
  return { added, updated, ids };
}

export async function setCandidateStatus(db: DbOrTx, userId: string, id: string, status: 'suggested' | 'added' | 'dismissed', now: Date): Promise<{ before: CandidateRecord; after: CandidateRecord }> {
  const [cur] = await db.select().from(vdpAssetCandidates).where(and(eq(vdpAssetCandidates.ownerUserId, userId), eq(vdpAssetCandidates.id, id)));
  if (!cur) throw notFound('Asset candidate', id);
  const before = recordOf(cur);
  checkTransition(before.status, status);
  if (before.status === status) return { before, after: before };
  const [row] = await db.update(vdpAssetCandidates).set({ status, statusAt: now, updatedAt: now }).where(eq(vdpAssetCandidates.id, id)).returning();
  return { before, after: recordOf(row!) };
}

/** The newest live VDP per account (fiscal period, then last activity), as the mirror links them. */
export function newestByAccount(snaps: readonly VdpSnapshot[], accountOf: (s: VdpSnapshot) => string | null): Map<string, VdpSnapshot> {
  const out = new Map<string, VdpSnapshot>();
  const rank = (s: VdpSnapshot) => (s.fiscalYear ?? 0) * 10 + (s.fiscalQuarter ?? 0);
  for (const s of snaps) {
    if (s.archivedAt) continue;
    const a = accountOf(s);
    if (!a) continue;
    const cur = out.get(a);
    if (!cur || rank(s) > rank(cur) || (rank(s) === rank(cur) && (s.lastActivityAt ?? '') > (cur.lastActivityAt ?? ''))) out.set(a, s);
  }
  return out;
}

/**
 * After a mirror read: close open candidates the VDP now shows (`in_vdp`), and give a VDP that now exists the
 * candidates that waited for it. Idempotent.
 */
export async function reconcileCandidates(db: DbOrTx, userId: string, snaps: readonly VdpSnapshot[], ents: { accounts: GapAccount[]; opps: GapOpp[] }, now: Date): Promise<{ closed: number; adopted: number }> {
  const rows = await db.select().from(vdpAssetCandidates).where(and(eq(vdpAssetCandidates.ownerUserId, userId), inArray(vdpAssetCandidates.status, ['unsure', 'suggested', 'added'])));
  if (!rows.length) return { closed: 0, adopted: 0 };
  const accountOf = new Map(snaps.map((s) => [s.slug, linkVdp(s, ents.accounts, ents.opps).accountId]));
  const bySlug = new Map(snaps.filter((s) => !s.archivedAt).map((s) => [s.slug, s]));
  const newest = newestByAccount(snaps, (s) => accountOf.get(s.slug) ?? null);
  let closed = 0;
  let adopted = 0;
  for (const r of rows) {
    const snap = (r.vdpSlug ? bySlug.get(r.vdpSlug) : undefined) ?? (r.accountId ? newest.get(r.accountId) : undefined);
    if (!snap) continue;
    const patch: Partial<typeof vdpAssetCandidates.$inferInsert> = {};
    if (!r.vdpSlug) {
      patch.vdpSlug = snap.slug;
      adopted += 1;
    }
    if (inVdp({ url: r.url, title: r.title }, snap.assets.map((a) => ({ url: a.url, title: a.title })))) {
      patch.status = 'in_vdp';
      patch.statusAt = now;
      closed += 1;
    }
    if (Object.keys(patch).length) await db.update(vdpAssetCandidates).set({ ...patch, updatedAt: now }).where(eq(vdpAssetCandidates.id, r.id));
  }
  return { closed, adopted };
}

// ---------------------------------------------------------------------------
// "Find assets" runs (jobs) and the assistant's day line (research spend counts there)
// ---------------------------------------------------------------------------

/** The newest run per details key (queued / running / done / failed / skipped). */
export async function backfillRuns(db: Db, userId: string): Promise<Map<string, VdpBackfillRun>> {
  const r = await db.execute<{ key: string; status: string; created_at: Date; finished_at: Date | null; result: Record<string, unknown> | null; last_error: string | null }>(sql`
    select distinct on (payload->>'key') payload->>'key' as key, status::text as status, created_at, finished_at, result, last_error
      from jobs
     where owner_user_id = ${userId} and kind = ${VDP_ASSETS_JOB}
     order by payload->>'key', id desc`);
  const out = new Map<string, VdpBackfillRun>();
  for (const x of r.rows) {
    const res = x.result ?? {};
    const skipped = typeof res.skipped === 'string' ? res.skipped : null;
    const status: VdpBackfillRun['status'] =
      x.status === 'queued' || x.status === 'scheduled' ? 'queued' : x.status === 'running' || x.status === 'claimed' ? 'running' : x.status === 'succeeded' ? (skipped ? 'skipped' : 'done') : x.status === 'cancelled' ? 'skipped' : 'failed';
    out.set(x.key, {
      status,
      startedAt: iso(x.created_at)!,
      finishedAt: iso(x.finished_at),
      found: typeof res.added === 'number' ? res.added : 0,
      costUsd: typeof res.costUsd === 'number' ? res.costUsd : null,
      note: skipped ? (typeof res.note === 'string' ? res.note : skipped) : status === 'failed' ? (x.last_error ?? 'the run failed').slice(0, 160) : typeof res.note === 'string' ? res.note : null,
    });
  }
  return out;
}

export async function enqueueBackfill(db: DbOrTx, userId: string, t: { key: string; capUsd: number; batch?: string | null }): Promise<boolean> {
  const r = await enqueueJob(db, {
    ownerUserId: userId,
    kind: VDP_ASSETS_JOB,
    queue: VDP_ASSETS_QUEUE,
    dedupeKey: vdpAssetsDedupeKey(t.key),
    payload: { key: t.key, cap_usd: t.capUsd, ...(t.batch ? { batch: t.batch } : {}) },
    maxAttempts: 1,
    timeoutSeconds: 420,
  });
  return r.inserted;
}

/**
 * What is left today on the assistant's day line (research runs are recorded there, like chat_research): Settings ▸
 * Budgets ▸ Assistant limits (or its env override), raised by "Today only", minus today's assistant spend.
 */
export async function assistantDayLeft(db: Db, userId: string, settings: Pick<Settings, 'chat' | 'budgets'>, day: string): Promise<{ perRunUsd: number; dayLeftUsd: number; lineUsd: number; hardLeftUsd: number }> {
  const lim = chatLimitsFromEnv(process.env, 'sonnet', settings.chat);
  const eff = budgetsForDay(settings.budgets, day);
  const line = eff.chatUsd != null && process.env.CC_CHAT_DAILY_USD === undefined ? eff.chatUsd : lim.chatDailyUsd;
  const r = await db.execute<{ spent: string | null; daily: string | null }>(sql`
    select coalesce(sum(cost_usd) filter (where purpose = 'chat'), 0) as spent, coalesce(sum(cost_usd) filter (where budget = 'daily'), 0) as daily
      from llm_calls where owner_user_id = ${userId} and budget_day = ${day}::date`);
  return { perRunUsd: lim.researchUsd, dayLeftUsd: Math.max(0, line - Number(r.rows[0]?.spent ?? 0)), lineUsd: line, hardLeftUsd: Math.max(0, eff.hardUsd - Number(r.rows[0]?.daily ?? 0)) };
}
