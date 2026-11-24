/**
 * Load a Seed into Postgres through change sets (actor `system:seed`).
 *
 * The seed is translated to database ids first (translate.ts), then written domain by domain with the
 * same mappers the DataSource uses (store/*.ts), so what the DataSource reads back is what a seed says.
 * Circular references (work item ↔ NBA ↔ draft, item ↔ resolution evidence, item ↔ session / tool run)
 * are inserted with the forward reference empty and patched at the end of the same change set.
 *
 * Engine-closed items in the seed become real engine change sets ("Closed for you" → Undo works):
 * the item is inserted as it was before the close, then an `engine_pass` change set closes it and logs
 * the done transition, exactly as the closure engine will.
 *
 * Idempotent: re-running with the same seed is a no-op ("up to date"); a different seed needs
 * `reset: true`, which truncates the app tables of this database (lane databases only).
 */
import { createHash } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import type { AgentRun, Seed, WorkItemRecord } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { ConstraintViolationError, DbError, mapPgError } from '@/db/errors';
import { changeSets, claudeSessions, extractors, org62PicklistValues, priorityRuns, seTaskTypes, teamPacks, toolRuns, users, workItems } from '@/db/schema';

import { loadKv } from './ext';
import { uuidFor } from './ids';
import type { WriteCtx } from './store/common';
import { insertSession, insertToolAdapter, insertToolRun, writeAppRun } from './store/agents';
import { insertBrief, insertWatch } from './store/briefs';
import { insertAccount, insertAsset, insertCalendarEvent, insertOpportunity, insertPerson, personDirectory } from './store/entities';
import { insertConnector, insertEvent, insertJob, insertScanRun, writeSpend } from './store/health';
import { ensureSweep, insertChatThread, insertFinding, insertHistoryEntry, writeMapping, writeSlots } from './store/misc';
import { insertDraft, insertNba, linkNbaDraft } from './store/nba';
import { activePolicyRowId, insertPolicyVersion, writeMeta, writeSection, type MetaState } from './store/settings';
import { insertActivity, insertTimeBlock, loadVocab } from './store/time';
import { insertEvidence, insertInitiative, insertProposal, insertScore, insertWorkItem, logTransition, updateWorkItem } from './store/work';
import { buildIdMap, translateHrefs, translateIds } from './translate';

export const SEED_EXTRACTOR = { key: 'cc.datasource', version: '1' } as const;

export interface LoadSeedOptions {
  db: Db;
  /** When the mock computed ranks at load (seed-from-mock), its ranking time. Defaults to meta.asOf. */
  rankedAt?: string;
  reset?: boolean;
  log?: (line: string) => void;
}

export interface LoadSeedResult {
  userId: string;
  status: 'loaded' | 'up_to_date';
  seedHash: string;
  changeSetId: string | null;
  skipped: string[];
}

/**
 * A loggable reason for a rejected row: the typed error code and constraint name only. Never the driver
 * message — drizzle's includes the bound parameters, i.e. row contents (DB-NOTES: log DbError.code).
 */
export function describeDbError(e: unknown): string {
  const m = mapPgError(e);
  if (m instanceof ConstraintViolationError) return `${m.code}${m.constraint ? ` (${m.constraint})` : ''}`;
  if (m instanceof DbError) return m.code;
  return 'rejected';
}

export function seedHash(seed: Seed): string {
  return createHash('sha256').update(JSON.stringify(seed)).digest('hex').slice(0, 32);
}

/** Tables owned by the app (everything but drizzle's bookkeeping); used by `reset`. */
async function truncateAll(db: Db) {
  const res = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = res.rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}

export async function ensureExtractor(db: Db): Promise<string> {
  await db.insert(extractors).values({ key: SEED_EXTRACTOR.key, version: SEED_EXTRACTOR.version, kind: 'user', description: 'Command Center app writes (DataSource, seeds)' }).onConflictDoNothing();
  const [row] = await db.select({ id: extractors.id }).from(extractors).where(sql`${extractors.key} = ${SEED_EXTRACTOR.key} and ${extractors.version} = ${SEED_EXTRACTOR.version}`);
  return row!.id;
}

/** The pre-close image of an engine-closed item (what the engine change set then closes). */
function beforeEngineClose(w: WorkItemRecord): WorkItemRecord {
  return {
    ...w,
    state: 'open',
    doneAt: null,
    doneBy: null,
    closedReason: null,
    resolution: null,
    resolutionDetail: null,
    involvement: w.resolution === 'handed_off' ? 'owner' : w.involvement,
  };
}

export async function loadSeedIntoDb(rawSeed: Seed, opts: LoadSeedOptions): Promise<LoadSeedResult> {
  const { db } = opts;
  const log = opts.log ?? (() => {});
  const hash = seedHash(rawSeed);
  const userId = uuidFor(rawSeed.meta.user.id);

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (existing) {
    const kv = await loadKv(db, userId);
    const meta = kv.get('cc.meta') as (MetaState & { seedHash?: string }) | undefined;
    if (meta?.seedHash === hash && !opts.reset) return { userId, status: 'up_to_date', seedHash: hash, changeSetId: null, skipped: [] };
    // a user without meta is a load that failed half-way (identity rows are written before the change set)
    if (meta && !opts.reset) throw new Error('this database holds a different seed for this user; re-run with --reset (lane databases only)');
  }
  if (opts.reset) await truncateAll(db);

  const map = buildIdMap(rawSeed);
  const seed = translateHrefs(translateIds(rawSeed, map), map);
  const meId = uuidFor(rawSeed.meta.user.id);
  const tz = seed.settings.profile.timezone || seed.meta.timezone;

  // users / team pack / extractor are not audited (identity + vocabularies), written directly
  const packId = uuidFor(`team_pack:${userId}`);
  await db.insert(teamPacks).values({ id: packId, slug: `cc-seed-${userId.slice(0, 8)}`, version: '1', name: 'Seed team pack', sourcePath: '(seed)', contentHash: hash }).onConflictDoNothing();
  const taskTypes = [...new Set(seed.activity.map((a) => a.taskType).filter((t): t is string => !!t))];
  if (taskTypes.length) {
    await db
      .insert(seTaskTypes)
      .values(taskTypes.map((name, i) => ({ teamPackId: packId, name, countsCustomerRelated: true, countsCustomerFacing: /demo|discovery|briefing|deep dive|workshop/i.test(name), bucket: 'pre_sale' as const, ordinal: i })))
      .onConflictDoNothing();
  }
  await db
    .insert(org62PicklistValues)
    .values([
      { teamPackId: packId, field: 'Meeting_Type__c', value: 'CF', ordinal: 0 },
      { teamPackId: packId, field: 'Meeting_Type__c', value: 'CR', ordinal: 1 },
    ])
    .onConflictDoNothing();
  await db
    .insert(users)
    .values({ id: userId, email: seed.meta.user.email, displayName: seed.meta.user.name, timezone: tz, teamPackId: packId })
    .onConflictDoNothing();
  const extractorId = await ensureExtractor(db);

  const engineClosed = seed.workItems.filter((w) => w.state === 'done' && w.doneBy === 'engine');
  const seedEvidence = new Set(seed.evidence.map((e) => e.id));
  const skipped: string[] = [];

  const { changeSetId } = await withChangeSet({ db, userId, actor: actors.system('seed'), kind: 'system', reason: `Seed: ${seed.meta.label}`, undoable: false }, async (tx, cs) => {
    const kv = new Map<string, unknown>();
    const w: WriteCtx = { tx, cs, userId, me: { id: meId, name: seed.meta.user.name }, now: new Date(seed.meta.asOf), extractorId, timezone: tz, kv };

    // ---- accounts first (people reference them), then people (me first)
    for (const [i, a] of seed.accounts.entries()) await insertAccount(w, a, { ordinal: i });
    await insertPerson(w, { id: meId, name: seed.meta.user.name, email: seed.meta.user.email, accountId: null }, { isMe: true });
    await tx.update(users).set({ personId: meId }).where(eq(users.id, userId));
    const known = new Set<string>([meId]);
    for (const p of seed.people) {
      if (p.id === meId) continue;
      await insertPerson(w, p);
      known.add(p.id);
    }
    const manager = seed.people.find((p) => p.isManager);
    if (manager) await tx.update(users).set({ managerPersonId: manager.id }).where(eq(users.id, userId));

    // ---- opportunities (+ finding-only rows), assets, calendar
    for (const [i, o] of seed.opps.entries()) await insertOpportunity(w, o, { ordinal: i });
    const oppIds = new Set(seed.opps.map((o) => o.id));
    const accountByName = new Map(seed.accounts.map((a) => [a.name, a.id]));
    const findingOpp = new Map<string, string>();
    let oppOrdinal = seed.opps.length; // finding-only and anchor rows sort after the book
    for (const m of seed.missedOpps) {
      if (m.oppId && oppIds.has(m.oppId)) continue;
      const oid = m.oppId ?? uuidFor(`finding-opp:${m.id}`);
      findingOpp.set(m.id, oid);
      await insertOpportunity(w, { id: oid, accountId: accountByName.get(m.accountName) ?? '', name: m.oppName, stage: m.stage, amount: m.amount, closeDate: m.closeDate, isOpen: true, isMine: false, dcAssigned: false, vdpLinked: false, hoursQtd: 0, nextStep: null, products: [], owner: null, org62Url: null, findingOnly: true }, { ordinal: oppOrdinal++ });
    }

    // activity rows may point at opportunities outside the book: anchor rows keep the FK (hidden like findings)
    for (const a of seed.activity) {
      if (!a.oppId || oppIds.has(a.oppId) || findingOpp.has(a.oppId)) continue;
      oppIds.add(a.oppId);
      await insertOpportunity(w, { id: a.oppId, accountId: accountByName.get(a.accountName ?? '') ?? '', name: a.oppName ?? 'Opportunity', stage: '', amount: null, closeDate: null, isOpen: true, isMine: false, dcAssigned: false, vdpLinked: false, hoursQtd: 0, nextStep: null, products: [], owner: null, org62Url: null, findingOnly: true }, { ordinal: oppOrdinal++ });
    }

    // embedded refs to people outside the directory
    const refs = [
      ...seed.workItems.flatMap((x) => [x.owner, x.counterparty, x.waiting?.who, ...x.people]),
      ...seed.initiatives.flatMap((i) => i.people),
      ...seed.calendar.events.flatMap((e) => e.attendees),
      ...seed.accounts.flatMap((a) => a.team),
      ...seed.opps.map((o) => o.owner),
    ];
    for (const r of refs) {
      if (!r || known.has(r.id) || r.id === meId) continue;
      await insertPerson(w, { ...r, synthetic: true });
      known.add(r.id);
    }
    const dir = await personDirectory(w);
    for (const [i, a] of seed.assets.entries()) await insertAsset(w, a, (name) => dir.byName.get(name) ?? null, { ordinal: i });
    const assetIds = new Set(seed.assets.map((a) => a.id));
    for (const e of seed.calendar.events) await insertCalendarEvent(w, e, (pid) => dir.email.get(pid) ?? null);
    for (const i of seed.initiatives) await insertInitiative(w, i, (id) => assetIds.has(id));

    // ---- connectors, tools, sessions, runs (work-item refs patched below)
    for (const [i, c] of seed.connectors.entries()) await insertConnector(w, c, new Date(Date.parse(seed.meta.asOf) + i));
    const adapterRow = new Map<string, string>();
    for (const [i, t] of seed.toolAdapters.entries()) adapterRow.set(t.manifest.id, await insertToolAdapter(w, t, new Date(Date.parse(seed.meta.asOf) + i).toISOString()));
    const sessionIds = new Set<string>();
    const runById = new Map<string, AgentRun>(seed.agentRuns.map((r) => [r.id, r]));
    for (const r of seed.agentRuns) {
      if (r.kind === 'claude_session') {
        await insertSession(w, { ...r, workItemId: null });
        sessionIds.add(r.id);
      } else if (r.kind === 'app_run') {
        await writeAppRun(w, r);
      }
    }
    const toolRunIds = new Set<string>();
    for (const tr of seed.toolRuns) {
      const adapterId = adapterRow.get(tr.adapterId);
      if (!adapterId) {
        skipped.push(`tool run ${tr.id}: unknown adapter ${tr.adapterId}`);
        continue;
      }
      const mirror = tr.agentRunId ? (runById.get(tr.agentRunId) ?? null) : null;
      const adapter = seed.toolAdapters.find((a) => a.manifest.id === tr.adapterId)!;
      await insertToolRun(w, { ...tr, workItemId: null, nbaId: null }, adapterId, adapter.manifest.capabilities[0] ?? 'run', mirror);
      toolRunIds.add(tr.id);
    }
    const toolRunForMirror = new Map(seed.toolRuns.filter((t) => t.agentRunId).map((t) => [t.agentRunId!, t.id]));
    const linkTargets = {
      runLinks: (runIds: string[]): { claudeSessionId?: string; toolRunId?: string }[] =>
        runIds.flatMap((rid): { claudeSessionId?: string; toolRunId?: string }[] => {
          if (sessionIds.has(rid)) return [{ claudeSessionId: rid }];
          const tr = toolRunForMirror.get(rid);
          if (tr && toolRunIds.has(tr)) return [{ toolRunId: tr }];
          return [];
        }),
      hasAsset: (id: string) => assetIds.has(id),
    };

    // ---- work items (engine-closed ones as they were before the close), evidence
    const closedIds = new Set(engineClosed.map((x) => x.id));
    for (const [ordinal, item] of seed.workItems.entries()) {
      const rec = closedIds.has(item.id) ? beforeEngineClose(item) : item;
      await insertWorkItem(w, { ...rec, nbaId: null, resolutionDetail: rec.resolutionDetail ? { ...rec.resolutionDetail, evidenceIds: undefined } : null }, linkTargets, { ordinal });
    }
    const seenAt = new Map(seed.workItems.map((x) => [x.id, x.seenAt]));
    for (const ev of seed.evidence) await insertEvidence(w, ev, seenAt.get(ev.workItemId) ?? null);
    const evidenceIds = new Set(seed.evidence.map((e) => e.id));
    // resolution evidence + extra ids that point at real evidence rows
    for (const item of seed.workItems) {
      const first = item.resolutionDetail?.evidenceIds?.[0];
      if (!closedIds.has(item.id) && first && evidenceIds.has(first)) await tx.update(workItems).set({ resolutionEvidenceId: first, updatedAt: new Date(item.updatedAt) }).where(eq(workItems.id, item.id));
    }

    // ---- NBAs ↔ drafts
    const draftKind = new Map(seed.drafts.map((d) => [d.id, d.destination.kind]));
    for (const n of seed.nbas) await insertNba(w, n, (rid) => sessionIds.has(rid), n.draftId ? draftKind.get(n.draftId) === 'email' : false);
    for (const d of seed.drafts) await insertDraft(w, d);
    for (const n of seed.nbas) if (n.draftId) await linkNbaDraft(w, n.id, n.draftId);
    for (const item of seed.workItems) if (item.nbaId) await tx.update(workItems).set({ currentNbaId: item.nbaId, updatedAt: new Date(item.updatedAt) }).where(eq(workItems.id, item.id));
    for (const r of seed.agentRuns) if (r.kind === 'claude_session' && r.workItemId) await tx.update(claudeSessions).set({ launchWorkItemId: r.workItemId }).where(eq(claudeSessions.id, r.id));
    for (const tr of seed.toolRuns) if (toolRunIds.has(tr.id) && (tr.workItemId || tr.nbaId)) await tx.update(toolRuns).set({ workItemId: tr.workItemId, nbaId: tr.nbaId }).where(eq(toolRuns.id, tr.id));
    for (const p of seed.proposals) await insertProposal(w, p);

    // ---- time, briefs, health, chat, deals, triage
    const vocab = await loadVocab(tx, userId);
    const accountOfOpp = new Map(seed.opps.map((o) => [o.id, seed.accounts.find((a) => a.id === o.accountId)?.name ?? null]));
    for (const a of seed.activity) {
      try {
        await tx.transaction(async (sp) => insertActivity({ ...w, tx: sp }, vocab, a, a.oppId ? (accountOfOpp.get(a.oppId) ?? null) : null));
      } catch (e) {
        skipped.push(`activity ${a.id}: ${describeDbError(e)}`);
      }
    }
    for (const b of seed.timeBlocks) {
      try {
        await tx.transaction(async (sp) => insertTimeBlock({ ...w, tx: sp }, b));
      } catch (e) {
        skipped.push(`time block ${b.id}: ${describeDbError(e)}`);
      }
    }
    const exists = async (kind: 'opportunity' | 'account' | 'person', id: string) => {
      const t = kind === 'opportunity' ? 'opportunities' : kind === 'account' ? 'accounts' : 'people';
      const r = await tx.execute(sql`select 1 from ${sql.identifier(t)} where id = ${id}`);
      return r.rows.length > 0;
    };
    for (const s of seed.watches) await insertWatch(w, s, exists);
    const watchLabel = new Map(seed.watches.map((s) => [s.id, s.label]));
    for (const b of seed.briefs) {
      let subId = b.subscriptionId;
      if (!subId || !watchLabel.has(subId)) {
        // opportunity / account briefs without a user watch hang off an auto-managed subscription
        subId = uuidFor(`auto-watch:${b.id}`);
        const kind = b.kind === 'opp' ? 'opp' : b.kind === 'account' ? 'account' : b.kind === 'person' ? 'person' : b.kind === 'search' ? 'search' : 'channel';
        const target = kind === 'opp' ? (b.oppId ?? b.title) : kind === 'account' ? (b.accountId ?? b.title) : b.title;
        await insertWatch(w, { id: subId, version: 1, targetKind: kind, target, label: b.title, cadence: 'daily_0730', style: 'brief', enabled: true, createdAt: b.generatedAt, updatedAt: b.generatedAt }, exists, { autoManaged: true });
      }
      await insertBrief(w, b, subId, watchLabel.get(subId) ?? b.title);
    }
    for (const [i, s] of seed.scanRuns.entries()) await insertScanRun(w, s, { ordinal: i });
    for (const [i, j] of seed.jobs.entries()) await insertJob(w, j, i);
    const connByKind = new Map<string, string>(seed.connectors.map((c) => [c.source, c.id]));
    for (const c of seed.connectors) connByKind.set(c.id, c.id);
    for (const e of seed.eventLog) await insertEvent(w, e, connByKind);
    for (const t of seed.chatThreads) await insertChatThread(w, t);
    const sweep = seed.missedOpps.length ? await ensureSweep(w, seed.meta.asOf) : null;
    for (const [i, m] of seed.missedOpps.entries()) await insertFinding(w, m, findingOpp.get(m.id) ?? m.oppId!, sweep!, accountOfOpp.get(m.oppId ?? '') ?? null, { ordinal: i });
    for (const q of seed.mappings) await writeMapping(w, q);
    await writeSlots(w, seed.calendar.slots);

    // ---- settings, policy versions, meta, spend (time too: DC1's covered AEs live there, and both sides read the same coverage)
    for (const s of ['profile', 'agentBehavior', 'sending', 'budgets', 'display', 'chat', 'time'] as const) if (seed.settings[s]) await writeSection(w, s, seed.settings[s]);
    const versions = [...seed.policyVersions].sort((a, b) => a.version - b.version);
    const current = seed.settings.policy;
    if (!versions.some((v) => v.version === current.version)) versions.push({ version: current.version, at: current.updatedAt, by: 'system', note: current.note ?? 'Seeded policy', policy: current });
    versions.forEach((v) => (v.policy = { ...v.policy, id: current.id }));
    for (const [i, v] of versions.entries()) {
      const isCurrent = v.version === current.version;
      await insertPolicyVersion(w, isCurrent ? current : v.policy, { at: v.at, by: v.by, note: v.note, activate: isCurrent, rowId: i === 0 ? current.id : undefined });
    }
    const rankedAt = opts.rankedAt ?? seed.meta.asOf;
    await writeMeta(w, { ...seed.meta, rankedAt, policyRankVersion: current.version, seedHash: hash } as MetaState);
    await writeSpend(w, seed.spend);

    // ---- priority: one run, a score row per item (why / startBy / components) and the lane cache
    const policyRow = (await activePolicyRowId(w))!;
    const [run] = await tx
      .insert(priorityRuns)
      .values({ ownerUserId: userId, trigger: 'startup', engineVersion: 'cc-seed@1', policyId: policyRow, startedAt: new Date(rankedAt), finishedAt: new Date(rankedAt), itemsConsidered: seed.workItems.length, itemsChanged: seed.workItems.length })
      .returning({ id: priorityRuns.id });
    for (const item of seed.workItems) {
      const scoreId = await insertScore(w, item, { runId: run!.id, policyId: policyRow }, new Date(rankedAt));
      await tx.update(workItems).set({ priorityScoreId: scoreId, priorityComputedAt: new Date(rankedAt), updatedAt: new Date(item.updatedAt) }).where(eq(workItems.id, item.id));
    }

    // ---- seeded history (display only)
    for (const e of seed.audit) await insertHistoryEntry(w, e);
  });
  log(`[seed] ${seed.meta.label}: base loaded`);

  // ---- engine closes as real, undoable engine change sets
  for (const item of engineClosed) {
    const before = beforeEngineClose(item);
    const at = item.doneAt ?? item.updatedAt;
    await withChangeSet(
      { db, userId, actor: actors.engine('item.close'), reason: `Closed for you: ${item.title}`, entity: { type: 'work_item', id: item.id } },
      async (tx, cs) => {
        const kv = await loadKv(tx as unknown as Db, userId);
        const w: WriteCtx = { tx, cs, userId, me: { id: meId, name: seed.meta.user.name }, now: new Date(at), extractorId, timezone: tz, kv };
        const ev = item.resolutionDetail?.evidenceIds?.find((id) => seedEvidence.has(id));
        const after: WorkItemRecord = item.resolutionDetail ? { ...item, resolutionDetail: { ...item.resolutionDetail, evidenceIds: ev ? [ev, ...(item.resolutionDetail.evidenceIds ?? []).filter((x) => x !== ev)] : undefined } } : item;
        await updateWorkItem(w, before, after, { runLinks: () => [], hasAsset: () => true }, { bump: false });
        await tx.update(workItems).set({ updatedAt: new Date(item.updatedAt), statusChangedAt: new Date(at) }).where(eq(workItems.id, item.id));
        await logTransition(w, item.id, 'open', 'done', item.closedReason, ev ?? null);
        await tx.update(changeSets).set({ createdAt: new Date(at) }).where(eq(changeSets.id, cs.id));
      },
    );
  }
  log(`[seed] ${engineClosed.length} engine closes recorded; ${skipped.length} rows skipped`);
  return { userId, status: 'loaded', seedHash: hash, changeSetId, skipped };
}
