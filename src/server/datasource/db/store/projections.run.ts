/**
 * The projections tick's store (src/projections/run.store.ts `ProjectionStore`) on Postgres: the reads and writes
 * src/projections/run*.ts used to make through the schema and the change-set machinery itself. The projection files
 * stay pure; they receive this object from their caller (`projectionStore(db)`). Behaviour is the tick's, unchanged:
 * change sets commit only when something was written, the watermark has its own change set, writers are idempotent.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { actors, withChangeSet, type ChangeSetContext } from '@/db/changeset';
import type { Db, Tx } from '@/db/client';
import { activityEntries, calendarEvents, claudeSessions, missedOppFindings, missedOppSweeps, people, personIdentities, teamPacks, userSettings, users } from '@/db/schema';
import { DEFAULT_ONSITE_CONFIG, airportBuffers, type OnsiteConfig, type OnsiteOverrides } from '@/engines/activity/onsite';
import { addDays as addLocalDays } from '@/engines/activity/time';
import type { OverlapMode } from '@/engines/activity/types';
import { loggingProfile, personaTargetH } from '@/engines/activity/persona';
import type { MissedResult } from '@/projections/missed';
import { NothingToWrite, PROJECTIONS_VERSION, STATE_KEY, textArr, type State } from '@/projections/run.model';
import { money } from '@/projections/run.helpers';
import { weekOf } from '@/projections/activity';
import type { ProjectionMe, ProjectionStore } from '@/projections/run.store';
import type { Me, Org62Book } from '@/projections/types';
import { id15 } from '@/projections/util';

import { loadLearnedMappings } from '../attribution';
import { canon, loadKv } from '../ext';
import { uuidFor } from '../ids';
import { ensureExtractor } from '../seed';
import { writeKv, type WriteCtx } from './common';
import { syncMyDcs } from './dc-requests';
import { ONSITE_OVERRIDES_KEY, onsiteWeekKey, overridesForWeek, overridesHash, readOnsiteOverrides, type OnsiteWeekRecord } from './onsite';
import { loadPersona } from './persona';
import {
  applyActivityWindow, applyBlockWindow, driftedLoggedRowStarts, hiddenOrg62RowStarts, loadActivityWindow, loadBlockWindow,
  markCalendarEventGone, mergeExt, setEventTakeaways, upsertAccountFromOrg62, upsertCalendarEventFromSource, upsertDriveAsset,
  upsertMeetingNote, upsertMyTeamMembership, upsertOpportunityFromOrg62, upsertOrg62Event, upsertSessionFromSource,
} from './projections';
import { loadVocab } from './time';
import { heldActivityRows, readTimeDismissRules } from './time-rules';

const actor = () => actors.engine(`projections@${PROJECTIONS_VERSION}`);

async function maybeChangeSet<T>(db: Db, userId: string, reason: string, fn: (tx: Tx, cs: ChangeSetContext) => Promise<{ result: T; wrote: boolean }>): Promise<T | null> {
  let out: T | null = null;
  try {
    await withChangeSet({ db, userId, actor: actor(), reason, undoable: false }, async (tx, cs) => {
      const r = await fn(tx, cs);
      out = r.result;
      if (!r.wrote) throw new NothingToWrite();
    });
  } catch (e) {
    if (!(e instanceof NothingToWrite)) throw e;
  }
  return out;
}

async function loadMe(db: Db, userId: string): Promise<ProjectionMe> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw new Error('projections: user not found');
  const persona = await loadPersona(db, userId);
  const kv = await db
    .select({ key: userSettings.key, value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.ownerUserId, userId), inArray(userSettings.key, ['settings.profile', 'cc.meta'])));
  const profile = (kv.find((k) => k.key === 'settings.profile')?.value ?? {}) as { name?: string; timezone?: string; workingHours?: { start: string; end: string } };
  const meta = (kv.find((k) => k.key === 'cc.meta')?.value ?? {}) as { quarter?: { targetH?: number } };
  const [mePerson] = u.personId
    ? await db.select({ id: people.id, name: people.displayName }).from(people).where(eq(people.id, u.personId))
    : await db.select({ id: people.id, name: people.displayName }).from(people).where(and(eq(people.ownerUserId, userId), eq(people.isMe, true))).limit(1);
  const ids = mePerson ? await db.select({ system: personIdentities.system, externalId: personIdentities.externalId }).from(personIdentities).where(eq(personIdentities.personId, mePerson.id)) : [];
  const [pack] = u.teamPackId ? await db.select({ slug: teamPacks.slug, raw: teamPacks.raw }).from(teamPacks).where(eq(teamPacks.id, u.teamPackId)) : [];
  return {
    me: {
      userId,
      personId: mePerson?.id ?? userId,
      name: profile.name ?? u.displayName ?? u.email,
      email: u.email.toLowerCase(),
      org62UserId: ids.find((i) => i.system === 'org62_user')?.externalId ?? null,
      slackUserId: ids.find((i) => i.system === 'slack')?.externalId ?? null,
      timezone: profile.timezone || u.timezone || 'UTC',
    },
    workday: profile.workingHours ?? { start: '09:00', end: '18:00' },
    packSlug: pack?.slug ?? null,
    packRaw: (pack?.raw ?? {}) as Record<string, unknown>,
    // D-55: a persona with no hours target (the AE) has none; otherwise the stored quarter's (bootstrap: 250 h)
    quarterTargetH: personaTargetH(persona, meta.quarter?.targetH ?? 250),
    logging: loggingProfile(persona),
  };
}

async function readState(db: Db, userId: string): Promise<State | null> {
  const [r] = await db.select({ value: userSettings.value }).from(userSettings).where(and(eq(userSettings.ownerUserId, userId), eq(userSettings.key, STATE_KEY)));
  const v = r?.value as State | undefined;
  return v && v.version === PROJECTIONS_VERSION ? v : null;
}

async function writeState(db: Db, userId: string, s: State): Promise<void> {
  await withChangeSet({ db, userId, actor: actor(), reason: 'Projections: watermark', undoable: false }, async (tx) => {
    await tx
      .insert(userSettings)
      .values({ ownerUserId: userId, key: STATE_KEY, value: s })
      .onConflictDoUpdate({ target: [userSettings.ownerUserId, userSettings.key], set: { value: sql`excluded.value`, updatedAt: sql`now()` }, setWhere: sql`${userSettings.value} is distinct from excluded.value` });
  });
}

async function writeCtx(tx: Tx, cs: WriteCtx['cs'], me: Me, now: Date, extractorId: string): Promise<WriteCtx> {
  return { tx, cs, userId: me.userId, me: { id: me.personId, name: me.name }, now, extractorId, timezone: me.timezone, kv: await loadKv(tx, me.userId) };
}

/**
 * Settings ▸ Time: the saved section over the defaults. Onsite days, and how overlapping meetings log (D-18 amended):
 * a row saved before the setting existed reads the persona's preset (`log_all_accepted` for every persona).
 */
async function loadTimeConfig(db: Db, userId: string, presetOverlaps: OverlapMode): Promise<{ onsite: OnsiteConfig; overlaps: OverlapMode }> {
  const [r] = await db.select({ value: userSettings.value }).from(userSettings).where(and(eq(userSettings.ownerUserId, userId), eq(userSettings.key, 'settings.time')));
  const v = (r?.value ?? {}) as Partial<{ detectOnsite: boolean; onsiteHours: { start: string; end: string }; airportBufferMin: number; airportBufferBeforeMin: number; airportBufferAfterMin: number; dinnersCustomerFacing: boolean; overlaps: string }>;
  // 2026-11-14: 120 min before a flight, 60 after; the legacy symmetric field is still read (airportBuffers)
  const buf = airportBuffers(v);
  return {
    onsite: {
      enabled: v.detectOnsite ?? DEFAULT_ONSITE_CONFIG.enabled,
      hours: v.onsiteHours ?? DEFAULT_ONSITE_CONFIG.hours,
      airportBufferBeforeMin: buf.beforeMin,
      airportBufferAfterMin: buf.afterMin,
      dinnersCustomerFacing: v.dinnersCustomerFacing ?? DEFAULT_ONSITE_CONFIG.dinnersCustomerFacing,
    },
    overlaps: v.overlaps === 'count_once' || v.overlaps === 'log_all_accepted' ? v.overlaps : presetOverlaps,
  };
}

/** Weeks an onsite correction touches whose stored record was computed without it (or before an Undo). */
async function onsiteWeeksDue(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ key: userSettings.key, value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.ownerUserId, userId), sql`(${userSettings.key} = ${ONSITE_OVERRIDES_KEY} or ${userSettings.key} like 'cc.onsite.week/%')`));
  const overrides = (rows.find((r) => r.key === ONSITE_OVERRIDES_KEY)?.value ?? null) as OnsiteOverrides | null;
  const records = new Map(rows.filter((r) => r.key !== ONSITE_OVERRIDES_KEY).map((r) => [r.key, r.value as OnsiteWeekRecord]));
  const weeks = new Set<string>();
  const touch = (day: string) => weeks.add(weekOf(`${day}T12:00:00Z`, 'UTC').start);
  for (const d of overrides?.days ?? []) touch(d.day);
  for (const t of overrides?.trips ?? []) for (let d = t.from; d <= t.to && d <= addLocalDays(t.from, 60); d = addLocalDays(d, 1)) touch(d);
  // a week whose record saw corrections that are gone now (an Undo)
  for (const [, r] of records) if (r?.overridesHash && r.overridesHash !== overridesHash(overridesForWeek(overrides, r.weekStart))) weeks.add(r.weekStart);
  return [...weeks].filter((ws) => records.get(onsiteWeekKey(ws))?.overridesHash !== overridesHash(overridesForWeek(overrides, ws))).sort();
}

/**
 * One `missed_opp_findings` row per opp (the engine's tier, verdict and evidence), refreshed each pass unless the
 * user locked it. Status is the user's: never changed, except a new or claimed finding whose opp now carries my DC
 * becomes `resolved`. A pass that changes nothing writes nothing (no sweep row either).
 */
async function writeMissedFindings(w: WriteCtx, res: MissedResult, book: Org62Book): Promise<number> {
  const { tx, userId } = w;
  const oppRows = new Map(
    (await tx.execute<{ id: string; org62: string }>(sql`select id, org62_opportunity_id as org62 from opportunities where owner_user_id = ${userId} and archived_at is null`)).rows.map((r) => [id15(r.org62), r.id]),
  );
  const existing = await tx.select().from(missedOppFindings).where(eq(missedOppFindings.ownerUserId, userId));
  const curByOpp = new Map(existing.map((f) => [f.opportunityId, f]));
  const org62ByRow = new Map([...oppRows].map(([k, v]) => [v, k]));
  const stamp = book.bookRead?.at ?? book.opps.map((o) => o.sweep?.at).filter((x): x is string => !!x).sort().at(-1) ?? 'none';
  const sweepId = uuidFor(`proj:missed_sweep:${userId}:${stamp}`);
  let sweepReady = false;
  const ensureSweep = async () => {
    if (sweepReady) return;
    await tx
      .insert(missedOppSweeps)
      .values({ id: sweepId, ownerUserId: userId, status: 'succeeded', criteria: { source: 'projections', engine: 'deals', stamp }, accountsConsidered: res.considered.accounts, oppsConsidered: res.considered.opps, startedAt: w.now, finishedAt: w.now })
      .onConflictDoNothing();
    sweepReady = true;
  };
  let created = 0;
  let changed = 0;
  for (const f of res.findings) {
    const oppRow = oppRows.get(f.opportunityId);
    if (!oppRow) continue; // an opp outside the projected book has no row to anchor a finding
    const cols = {
      tier: f.tier,
      verdict: f.verdict,
      evidenceStrength: f.evidenceStrength,
      hasD360Line: f.hasD360Line,
      d360LineAmount: money(f.d360LineAmount),
      flexLineAmount: money(f.flexLineAmount),
      myOrg62Hours: money(f.myOrg62Hours),
      myDcExists: f.myDcExists,
      otherArchitectDcCount: f.otherArchitectDcCount,
      evidenceSummary: (res.lines.get(f.opportunityId) ?? [f.evidenceSummary]).join('\n'),
    };
    const cur = curByOpp.get(oppRow);
    let id: string;
    if (!cur) {
      await ensureSweep();
      id = uuidFor(`proj:missed:${userId}:${f.opportunityId}`);
      await tx.insert(missedOppFindings).values({ id, ownerUserId: userId, opportunityId: oppRow, firstSweepId: sweepId, lastSweepId: sweepId, status: 'new', ...cols });
      created++;
    } else {
      id = cur.id;
      if (cur.userLocked) continue;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cols)) if (String((cur as Record<string, unknown>)[k] ?? '') !== String(v ?? '')) patch[k] = v;
      if (Object.keys(patch).length) {
        await ensureSweep();
        await tx.update(missedOppFindings).set({ ...patch, lastSweepId: sweepId, updatedAt: w.now }).where(eq(missedOppFindings.id, id));
        changed++;
      }
    }
    if (await mergeExt(w, 'missed_opp_findings', id, { otherDcs: res.otherDcs.get(f.opportunityId) ?? null })) changed += cur ? 1 : 0;
  }
  // my DC is on the opp now: the question is settled
  for (const cur of existing) {
    const org62 = org62ByRow.get(cur.opportunityId);
    if (!org62 || !res.covered.has(org62) || cur.userLocked || !['new', 'reviewing', 'actioned'].includes(cur.status)) continue;
    await tx.update(missedOppFindings).set({ status: 'resolved', updatedAt: w.now }).where(eq(missedOppFindings.id, cur.id));
    changed++;
  }
  if (sweepReady) await tx.update(missedOppSweeps).set({ findingsNew: created, findingsChanged: changed }).where(eq(missedOppSweeps.id, sweepId));
  return created + changed;
}

/** The projections' store on this database handle (pass it to runProjections, recomputeWeeks, rederiveWeeks, …). */
export function projectionStore(db: Db): ProjectionStore {
  return {
    db,
    loadMe: (userId) => loadMe(db, userId),
    readState: (userId) => readState(db, userId),
    writeState: (userId, s) => writeState(db, userId, s),
    ensureExtractor: () => ensureExtractor(db),
    changeSet: (userId, reason, fn) => maybeChangeSet(db, userId, reason, fn),
    writeCtx,
    readOnly: (me, now, fn) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set transaction read only`);
        // a read-only context: the loaders read through it, nothing writes (the transaction is READ ONLY besides)
        const w: WriteCtx = { tx, cs: null as unknown as WriteCtx['cs'], userId: me.userId, me: { id: me.personId, name: me.name }, now, extractorId: '', timezone: me.timezone, kv: await loadKv(tx, me.userId) };
        return fn(tx, w);
      }),
    loadVocab,
    loadTimeConfig: (userId, preset) => loadTimeConfig(db, userId, preset),
    onsiteWeeksDue: (userId) => onsiteWeeksDue(db, userId),
    uuidFor,
    upsertAccountFromOrg62,
    upsertOpportunityFromOrg62,
    upsertMyTeamMembership,
    syncMyDcs,
    upsertOrg62Event,
    driftedLoggedRowStarts,
    hiddenOrg62RowStarts,
    writeMissedFindings,
    markCalendarEventGone,
    upsertCalendarEventFromSource,
    upsertSessionFromSource,
    eventMapping: async (tx, id) => {
      const [r] = await tx.select({ accountId: calendarEvents.accountId, opportunityId: calendarEvents.opportunityId }).from(calendarEvents).where(eq(calendarEvents.id, id));
      return r ?? null;
    },
    upsertDriveAsset,
    eventRowId: async (tx, userId, externalEventId) => {
      const [r] = await tx.select({ id: calendarEvents.id }).from(calendarEvents).where(and(eq(calendarEvents.ownerUserId, userId), eq(calendarEvents.externalEventId, externalEventId))).limit(1);
      return r?.id ?? null;
    },
    upsertMeetingNote,
    setEventTakeaways,
    loadLearnedMappings,
    readOnsiteOverrides,
    weekSessions: (tx, userId, from, end) =>
      tx
        .select({ id: claudeSessions.id, title: claudeSessions.title, cwd: claudeSessions.cwd, startedAt: claudeSessions.startedAt, lastActivityAt: claudeSessions.lastActivityAt, accountId: claudeSessions.accountId, sourceItemId: claudeSessions.sourceItemId, sessionExternalId: claudeSessions.sessionExternalId, desktopSessionId: claudeSessions.desktopSessionId })
        .from(claudeSessions)
        .where(and(eq(claudeSessions.ownerUserId, userId), sql`${claudeSessions.lastActivityAt} >= ${from.toISOString()}::timestamptz`, sql`coalesce(${claudeSessions.startedAt}, ${claudeSessions.lastActivityAt}) < ${end.toISOString()}::timestamptz`)),
    loadActivityWindow,
    sameMeetingRows: (tx, userId, idents) =>
      tx
        .select()
        .from(activityEntries)
        .where(and(eq(activityEntries.ownerUserId, userId), sql`split_part(${activityEntries.dedupeKey}, '|', 1) = 'cal' and ('cal|' || split_part(${activityEntries.dedupeKey}, '|', 2) || '|' || split_part(${activityEntries.dedupeKey}, '|', 3) || '|') = any(${textArr(idents)})`)),
    loadBlockWindow,
    heldActivityRows,
    readTimeDismissRules,
    applyActivityWindow,
    applyBlockWindow,
    writeOnsiteWeek: async (w, weekStart, overrides, days) => {
      const record: OnsiteWeekRecord = { version: 1, weekStart, overridesHash: overridesHash(overridesForWeek(overrides, weekStart)), days };
      const key = onsiteWeekKey(weekStart);
      const prev = w.kv.get(key);
      const nextVal = record.days.length || prev ? record : null;
      const wrote = canon(prev ?? null) !== canon(nextVal) ? 1 : 0;
      if (wrote) await writeKv(w, key, nextVal);
      return wrote;
    },
  };
}
