/**
 * The VDP mirror store: `vdp_records` (one row per VDP of mine), written by `scan.vdp` (src/connectors/vdp/fetcher.ts)
 * and read by `getVdpCoverage`. Read-only state of an external system, so no change set: the table is not audited,
 * and a read replaces the row (it is never an edit of mine).
 *
 *  - Linked to my accounts and opportunities by Org62 id (15-character prefix), then by the linked opp's account, then
 *    by company name (src/engines/vdp/gaps.ts `linkVdp`).
 *  - `detail` holds the whole normalized VDP; the summary columns (counts, AE/TA, missing gap codes) are derived.
 *  - D-98 (0036): the parts the app reads and edits are child rows too (vdp_use_cases, vdp_assets, vdp_members, the
 *    phase history), stamped `mirrored_at`, and each read is one `mirror_reads` row (../vdp-mirror.ts). Readers get
 *    use cases, assets and people from the child rows; a row mirrored before 0036 falls back to `detail` until the
 *    next read or the kv.backfill job writes its children. `detail` stays for one release.
 *  - A complete read marks rows it no longer lists `gone_at` (kept, never deleted); a VDP that returns clears it.
 *  - Each read also settles the VDP asset candidates (store/vdp-candidates.ts): one VDP now shows is closed (`in_vdp`),
 *    and a VDP that appears takes the candidates its account collected before it existed.
 *  - What the server can do (D-59: its tool names, the Deliverable lookup, company matches) goes to `vdp_server`, one
 *    row per user, replaced by each read that carries it.
 * Logs and errors carry counts and codes only.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import type { Db, DbOrTx } from '@/db/client';
import { accounts, opportunities, userSettings, vdpRecords, vdpServer } from '@/db/schema';
import { computeVdpGaps, linkVdp, missingCodes, type GapAccount, type GapOpp } from '@/engines/vdp/gaps';
import { identityQueries, judgmentsOf, overridesOf, VDP_IDENTITY_JUDGE_KV, VDP_IDENTITY_KV } from '@/engines/vdp/identity';
import { ACCOUNT_HIERARCHY_KV, hierarchyOf, type AccountHierarchy } from '@/lib/accounts/hierarchy';
import { vdpCapabilities } from '@/lib/vdp/capabilities';
import type { VdpMirrorBatch, VdpMirrorSink, VdpServerInfo, VdpSnapshot } from '@/lib/vdp/types';

import { loadVdpChildren, readHash, recordMirrorRead, withChildren, writeVdpChildren } from '../vdp-mirror';
import { readMemo } from '../reads/session';
import { reconcileCandidates } from './vdp-candidates';

export interface VdpRecordRow {
  vdpSlug: string;
  vdpId: string | null;
  accountId: string | null;
  opportunityId: string | null;
  lastActivityAt: string | null;
  lastSeenAt: string;
  goneAt: string | null;
  archived: boolean;
  url: string | null;
  snapshot: VdpSnapshot | null;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** An Org62 Account/Opportunity id, or null (seeded rows carry a `cc:` placeholder key, which is no id). */
const org62Id = (id: string | null) => (id && /^(001|006)[A-Za-z0-9]{12}/.test(id) ? id : null);

/** D-69 (VD-13): the Org62 ids of my opps DC-22 tombstoned (archived: Org62 no longer has them). */
export async function deletedOrg62OppIds(db: DbOrTx, userId: string): Promise<string[]> {
  const r = await db.execute<{ id: string }>(sql`select org62_opportunity_id as id from opportunities where owner_user_id = ${userId} and archived_at is not null and org62_opportunity_id is not null`);
  return r.rows.map((x) => x.id).filter((x) => /^006[A-Za-z0-9]{12}/.test(x));
}

/** My accounts and opportunities as the gap engine reads them (from the tables: the sink and getVdpCoverage). */
export function loadGapEntities(db: Db, userId: string): Promise<{ accounts: GapAccount[]; opps: GapOpp[] }> {
  return readMemo(db, `gapEntities:${userId}`, () => readGapEntities(db, userId)); // one read per Home/Today request
}

async function readGapEntities(db: Db, userId: string): Promise<{ accounts: GapAccount[]; opps: GapOpp[] }> {
  // DC-24: an archived account (merged away in Org62: its opps moved to the survivor) is no VDP's account any more; a
  // VDP whose header still carries its id links through its opps to the account that took them over
  const accs = await db
    .select({ id: accounts.id, name: accounts.name, org62AccountId: accounts.org62AccountId })
    .from(accounts)
    .where(and(eq(accounts.ownerUserId, userId), sql`${accounts.archivedAt} is null`));
  const ops = await db
    .select({
      id: opportunities.id,
      accountId: opportunities.accountId,
      name: opportunities.name,
      org62OpportunityId: opportunities.org62OpportunityId,
      isClosed: opportunities.isClosed,
      isWon: opportunities.isWon,
      // D-63: my DC split (deal_contributions, as the Org62 scans read it): 100% makes the opp mine for VDP. Matched
      // by the opp row, else by the Org62 opp id (a DC read on another row of the same Org62 opp). DC-14: two DCs of
      // mine on one opp are summed (a Flex 50/50, both mine, is 100%).
      dcSplit: sql<number | null>`(select sum(dc.split_percent)::float8 from deal_contributions dc left join opportunities o2 on o2.id = dc.opportunity_id
          where dc.owner_user_id = ${userId} and dc.is_mine and dc.deleted_upstream_at is null
            and (dc.opportunity_id = "opportunities"."id" or ("opportunities"."org62_opportunity_id" is not null and o2.org62_opportunity_id15 = "opportunities"."org62_opportunity_id15")))`,
      closeDate: opportunities.closeDate,
    })
    .from(opportunities)
    .where(eq(opportunities.ownerUserId, userId));
  return {
    accounts: accs.map((a) => ({ ...a, org62AccountId: org62Id(a.org62AccountId) })),
    opps: ops.map((o) => ({ id: o.id, accountId: o.accountId, name: o.name, org62OpportunityId: org62Id(o.org62OpportunityId), isOpen: !o.isClosed, isWon: o.isClosed ? !!o.isWon : null, dcSplit: o.dcSplit === null || o.dcSplit === undefined ? null : Number(o.dcSplit), closeDate: o.closeDate, owner: null })),
  };
}

export function loadVdpRecords(db: DbOrTx, userId: string): Promise<VdpRecordRow[]> {
  return readMemo(db, `vdpRecords:${userId}`, () => readVdpRecords(db, userId)); // one read per Home/Today request
}

async function readVdpRecords(db: DbOrTx, userId: string): Promise<VdpRecordRow[]> {
  const rows = await db.select().from(vdpRecords).where(eq(vdpRecords.ownerUserId, userId));
  // D-98: the child tables for rows the 0036 mirror wrote; the blob for the rest (the dual-read window)
  const children = await loadVdpChildren(
    db,
    userId,
    rows.filter((r) => r.mirroredAt && r.detail).map((r) => r.id),
  );
  return rows.map((r) => ({
    vdpSlug: r.vdpSlug,
    vdpId: r.vdpId,
    accountId: r.accountId,
    opportunityId: r.opportunityId,
    lastActivityAt: iso(r.lastActivityAt),
    lastSeenAt: iso(r.lastSeenAt)!,
    goneAt: iso(r.goneAt),
    archived: r.archived,
    url: r.url,
    snapshot: r.detail ? (children.has(r.id) ? withChildren(r.detail as unknown as VdpSnapshot, children.get(r.id)!) : (r.detail as unknown as VdpSnapshot)) : null,
  }));
}

/** The server info the last read stored (D-59 feature detection), or null before the first such read. */
export async function loadVdpServer(db: DbOrTx, userId: string): Promise<VdpServerInfo | null> {
  const [row] = await db.select({ info: vdpServer.info }).from(vdpServer).where(eq(vdpServer.ownerUserId, userId));
  return (row?.info as unknown as VdpServerInfo | undefined) ?? null;
}

/** One kv value of the user's (user_settings), or null. */
export async function loadKv(db: DbOrTx, userId: string, key: string): Promise<unknown> {
  const [row] = await db.select({ value: userSettings.value }).from(userSettings).where(and(eq(userSettings.ownerUserId, userId), eq(userSettings.key, key)));
  return row?.value ?? null;
}

/** D-69: the Org62 account hierarchy (kv `cc.org62.account_hierarchy`), or null before the first read. */
export async function loadAccountHierarchy(db: DbOrTx, userId: string): Promise<AccountHierarchy | null> {
  const raw = await loadKv(db, userId, ACCOUNT_HIERARCHY_KV);
  return raw ? hierarchyOf(raw) : null;
}

/**
 * D-69: the names a read looks up in VDP's company list: every name up the Org62 chain (cleaned: no " - org/product"
 * segments, no legal suffix) of my engaged accounts (an open opp where my DC is 100%, D-63) that no VDP of mine links,
 * except the ones you mapped to a VDP company yourself.
 */
export async function companyQueries(db: Db, userId: string): Promise<string[]> {
  const ents = await loadGapEntities(db, userId);
  const live = (await loadVdpRecords(db, userId)).filter((r) => r.snapshot && !r.goneAt && !r.snapshot.archivedAt).map((r) => r.snapshot!);
  return identityQueries({ accounts: ents.accounts, opps: ents.opps, vdps: live, hierarchy: await loadAccountHierarchy(db, userId), overrides: overridesOf(await loadKv(db, userId, VDP_IDENTITY_KV)), judgments: judgmentsOf(await loadKv(db, userId, VDP_IDENTITY_JUDGE_KV)) });
}

/** Upsert one read of my VDPs. Returns rows written and rows newly marked gone. */
export async function saveVdpMirror(db: Db, userId: string, batch: VdpMirrorBatch): Promise<{ written: number; removed: number }> {
  const ents = await loadGapEntities(db, userId);
  const server = batch.server ?? (await loadVdpServer(db, userId));
  const gaps = computeVdpGaps({ vdps: batch.snapshots, accounts: ents.accounts, opps: ents.opps, me: { name: '', email: null }, vdpBaseUrl: null, now: batch.readAt, server, capabilities: vdpCapabilities(server) });
  const codes = new Map(gaps.vdps.map((r) => [r.vdpSlug, missingCodes(r)]));
  const readAt = new Date(batch.readAt);
  return db.transaction(async (tx) => {
    let written = 0;
    for (const s of batch.snapshots) {
      const link = linkVdp(s, ents.accounts, ents.opps);
      const cols = {
        vdpId: s.id,
        companyName: s.company.name,
        salesforceAccountId: s.salesforceAccountId,
        // the primary; every id is in `detail` (salesforceOpportunityIds) and links through linkVdp
        salesforceOpportunityId: s.salesforceOpportunityId,
        archived: !!s.archivedAt,
        lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt) : null,
        goneAt: null,
        detail: s as unknown as Record<string, unknown>,
        url: s.url,
        opportunityId: link.opportunityId,
        accountId: link.accountId,
        fiscalYear: s.fiscalYear,
        fiscalQuarter: s.fiscalQuarter,
        hasAe: s.aes.length > 0,
        hasTa: s.tas.length > 0,
        useCaseCount: s.useCases.length,
        useCaseWithAiCount: s.useCases.filter((u) => u.hasAi).length,
        assetCount: s.assets.length,
        dcNoteCached: s.dcNoteCached,
        missingItems: codes.get(s.slug) ?? [],
        // provenance: the record_snapshot item of this VDP, once the scanner has recorded it (a run records after the fetch)
        sourceItemId: sql`(select id from source_items where owner_user_id = ${userId} and dedupe_key = ${`vdp:${s.id}`} order by last_seen_at desc limit 1)`,
        lastSeenAt: readAt,
        updatedAt: readAt,
      };
      const [row] = await tx
        .insert(vdpRecords)
        .values({ ownerUserId: userId, vdpSlug: s.slug, ...cols })
        .onConflictDoUpdate({ target: [vdpRecords.ownerUserId, vdpRecords.vdpSlug], set: cols })
        .returning({ id: vdpRecords.id });
      // D-98: the child rows (use cases, assets, people, phase history) of what this read saw
      await writeVdpChildren(tx, userId, row!.id, s, readAt);
      written += 1;
    }
    // D-98 (mirror convention): one row per read
    await recordMirrorRead(tx, userId, { source: 'vdp', scope: 'my_vdps', readAt, rows: batch.snapshots.length, complete: batch.complete, hash: readHash(batch.snapshots.map((s) => `${s.id}|${s.lastActivityAt ?? ''}|${s.useCases.length}|${s.assets.length}`)) });
    let removed = 0;
    if (batch.complete) {
      const seen = batch.snapshots.map((s) => s.id);
      const r = await tx
        .update(vdpRecords)
        .set({ goneAt: readAt, updatedAt: readAt })
        .where(
          and(
            eq(vdpRecords.ownerUserId, userId),
            isNotNull(vdpRecords.vdpId),
            sql`${vdpRecords.goneAt} is null`,
            seen.length ? sql`${vdpRecords.vdpId} not in (${sql.join(seen.map((id) => sql`${id}`), sql`, `)})` : sql`true`,
          ),
        );
      removed = r.rowCount ?? 0;
    }
    if (batch.server) {
      const info = batch.server as unknown as Record<string, unknown>;
      await tx
        .insert(vdpServer)
        .values({ ownerUserId: userId, info, readAt })
        .onConflictDoUpdate({ target: [vdpServer.ownerUserId], set: { info, readAt, updatedAt: readAt } });
    }
    // Asset candidates: close the ones VDP now shows, and give a new VDP the ones that waited for it (all live rows,
    // not only this batch: an incomplete read still knows every VDP it read before).
    const live = (await loadVdpRecords(tx, userId)).filter((x) => x.snapshot && !x.goneAt).map((x) => x.snapshot!);
    await reconcileCandidates(tx, userId, live, ents, readAt);
    return { written, removed };
  });
}

/**
 * D-69 (VD-06): VDP answered "not found" for this company id (merged or archived there): drop every stored lookup that
 * names it, so the next read looks those names up again instead of reusing a dead match for 12 hours.
 */
export async function dropCompanyLookups(db: DbOrTx, userId: string, companyId: string): Promise<number> {
  const info = await loadVdpServer(db, userId);
  if (!info) return 0;
  const companies = info.companies.filter((c) => !c.matches.some((m) => m.id === companyId));
  if (companies.length === info.companies.length) return 0;
  await db.update(vdpServer).set({ info: { ...info, companies } as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(vdpServer.ownerUserId, userId));
  return info.companies.length - companies.length;
}

/** The fetcher's sink over Postgres. */
export function dbVdpSink(db: Db, userId: string): VdpMirrorSink {
  return {
    async known() {
      const rows = await loadVdpRecords(db, userId);
      return new Map(rows.filter((r) => r.vdpId).map((r) => [r.vdpId!, { lastActivityAt: r.lastActivityAt, snapshot: r.snapshot }]));
    },
    save: (batch) => saveVdpMirror(db, userId, batch),
    server: () => loadVdpServer(db, userId),
    companyQueries: () => companyQueries(db, userId),
  };
}
