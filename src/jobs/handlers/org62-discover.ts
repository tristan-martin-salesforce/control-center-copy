/**
 * `org62.discover` (queue `maintenance`, holistic review 2026-11-20 H-9, lane 06 R3/R7): live Org62 discovery, so a
 * deal the local mirror doesn't have yet is an attribution candidate the same day.
 *
 *   discover (default)  fixed SELECTs (src/engines/attribution/discover.ts): open opps whose team has me or an AE I
 *                       cover (toggled on, Settings ▸ Time ▸ AEs I cover), and open opps on the accounts I engaged in
 *                       the last 8 weeks (opp_engagement, mapped rows) or owned by a covered AE. Each hit is upserted
 *                       into the mirror (opportunities, accounts, the covered AEs' team rows) with provenance in the
 *                       opp's ext (`via: discovered | covered_ae`, `discoveredAt`); a discovered account stays out of
 *                       my book (is_my_book false) until I work on it.
 *   lookup_ae           Settings ▸ Time ▸ AEs I cover: ONE User read by name; the hits go to kv AE_LOOKUP_KV (7 days).
 *
 * Every query is a SELECT through the existing one-call read path (runOneReadLookup: `soqlQuery` on the scan allowlist,
 * never widened; tenet: Read-only ingest). Each call holds its cost cap against the daily hard cap while it runs and
 * books its spend (relayGuard + recordSpend, as vdp.specialist_aes does) into the job's one hold (the start gate's);
 * past it the job asks once, keeps what it read, and its continuation runs the discovery again on the same hold (the
 * daily lookup count above bounds it).
 * At most DISCOVER_DAILY_LOOKUPS lookups a day (lane 06 D-T5), counted in kv DISCOVER_KV.
 * Cadence: Settings ▸ Time ▸ discovery (daily by default, weekly, or off); the 06:45 schedule skips a weekly run that
 * is not due. Does nothing live outside the launchd worker (CC_LIVE / NODE_ENV=production) unless a test injects the
 * lookup. jobs.result holds counts and codes only.
 */
import { sql } from 'drizzle-orm';

import { attributionSettingsOf } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { ledgerHash } from '@/db/ledger';
import { localDay } from '@/engines/activity/time';
import { DiscoverParseError, oppsSoql, parseDiscovered, parseSpecialistForecasts, parseUsers, readTeam, sfrByOpp, sfrDiscoverSoql, sfrEligibility, userLookupSoql, viaOf, type DiscoveredOpp, type DiscoveredSfr, type SfrSkipReason } from '@/engines/attribution/discover';
import { coverageActive } from '@/engines/attribution/coverage';
import { org62Key } from '@/connectors/org62/ids';
import { DEFAULT_MIN_AMOUNT } from '@/engines/deals/classify';
import { personaOf } from '@/personas';
import { liveOrg62 } from '@/server/chat/record-type';
import { AE_LOOKUP_KV, DISCOVER_KV, ORG62_DISCOVER_JOB, ATTRIBUTION_QUEUE, markSpecialistForecasts, upsertDiscovered } from '@/server/datasource/db/attribution';
import { putKv } from '@/server/datasource/db/ext';
import { loadSettingsSections } from '@/server/datasource/db/store/settings';
import { runOneReadLookup } from '@/server/onboarding/identity';
import { loadModel } from '@/server/datasource/db/model';
import { everything } from '@/server/datasource/db/reads/scope';

import { JobError, type JobContext, type JobHandlerDef } from '../types';
import { FORECAST_LOOKUP_SKILL, recordSpend } from './forecast-sync';
import { relayGuard, type RelayGuard } from './relay-guard';

/** Lane 06 D-T5: at most this many discovery lookups a day. */
export const DISCOVER_DAILY_LOOKUPS = 20;
/** Accounts engaged in the last this many days are searched for new opps. */
export const DISCOVER_ENGAGED_DAYS = 56;

export interface DiscoverDeps {
  lookup?: typeof runOneReadLookup;
  live?: boolean;
  guard?: (ctx: JobContext) => RelayGuard;
}

let deps: DiscoverDeps = {};
export function configureDiscoverJob(d: DiscoverDeps): void {
  deps = { ...deps, ...d };
}
export function resetDiscoverJobConfig(): void {
  deps = {};
}

interface DiscoverState {
  /** Lookups per local day. */
  days: Record<string, number>;
  lastRunAt: string | null;
}

async function readKv<T>(db: Db, userId: string, key: string): Promise<T | null> {
  const r = await db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${key}`);
  return (r.rows[0]?.value as T | undefined) ?? null;
}

async function myOrg62Id(db: Db, userId: string): Promise<string | null> {
  const r = await db.execute<{ id: string | null }>(sql`
    select (select pi.external_id from person_identities pi where pi.person_id = u.person_id and pi.system::text = 'org62_user' order by pi.is_primary desc limit 1) as id
      from users u where u.id = ${userId}`);
  return r.rows[0]?.id ?? null;
}

export async function runOrg62Discover(ctx: JobContext, d: DiscoverDeps = deps): Promise<Record<string, unknown>> {
  const live = d.live ?? (!!d.lookup || liveOrg62());
  if (!live) return { skipped: 'not_live', note: 'Org62 reads run in the launchd worker only (CC_LIVE)' };
  const now = ctx.clock();
  const sections = await loadSettingsSections({ db: ctx.db, userId: ctx.userId });
  const tz = sections.profile?.timezone ?? 'America/Denver';
  const day = localDay(now.getTime(), tz);
  const settings = attributionSettingsOf(sections.time ?? null);
  const mode = ctx.job.payload?.mode === 'lookup_ae' ? 'lookup_ae' : 'discover';
  const state = (await readKv<DiscoverState>(ctx.db, ctx.userId, DISCOVER_KV)) ?? { days: {}, lastRunAt: null };
  if (mode === 'discover') {
    if (settings.discovery === 'off') return { skipped: 'off' };
    if (settings.discovery === 'weekly' && ctx.job.payload?.trigger !== 'manual' && state.lastRunAt && now.getTime() - Date.parse(state.lastRunAt) < 6.5 * 86_400_000) return { skipped: 'not_due' };
  }
  const used = state.days[day] ?? 0;
  if (used >= DISCOVER_DAILY_LOOKUPS) return { skipped: 'daily_cap', lookups: used };
  const lookup = d.lookup ?? runOneReadLookup;
  const guard = d.guard?.(ctx) ?? relayGuard(ctx, 'org62-discover');
  const early = await guard.start?.();
  if (early) return early;
  try {
    const minAmount = Number(personaOf(sections).thresholds.missedOppMinAmountUsd ?? DEFAULT_MIN_AMOUNT);
    return await discover(ctx, { mode, state, settings, tz, day, now, used, lookup, guard, minAmount: Number.isFinite(minAmount) ? minAmount : DEFAULT_MIN_AMOUNT });
  } finally {
    await guard.finish?.().catch(() => undefined);
  }
}

async function discover(
  ctx: JobContext,
  { mode, state, settings, tz, day, now, used, lookup, guard, minAmount }: { minAmount: number; mode: 'discover' | 'lookup_ae'; state: DiscoverState; settings: ReturnType<typeof attributionSettingsOf>; tz: string; day: string; now: Date; used: number; lookup: typeof runOneReadLookup; guard: RelayGuard },
): Promise<Record<string, unknown>> {
  let lookups = 0;
  let costUsd = 0;
  // one read-only call: hold → call → book → release
  const read = async (q: string): Promise<string | null | 'cap'> => {
    if (used + lookups >= DISCOVER_DAILY_LOOKUPS) return 'cap';
    const started = Date.now();
    const r = await guard.run(async () => {
      const r = await lookup({ connector: 'org62', tool: 'soqlQuery', args: { q } }, { skillPath: FORECAST_LOOKUP_SKILL, timeoutMs: 90_000 });
      await recordSpend(ctx, day, { purpose: 'other', skillKey: 'org62-discover', promptVersion: 'records', model: r.model, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, contentHash: ledgerHash(r.model, 'soqlQuery', q), ok: r.text !== null, ...(r.text === null ? { errorCode: r.code } : {}), latencyMs: Date.now() - started }).catch(() => undefined);
      return r;
    });
    if (!r) return 'cap';
    lookups += 1;
    costUsd += r.costUsd;
    void ctx.heartbeat().catch(() => undefined);
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
    if (r.code === 'disallowed_tool') throw new JobError('the discovery read tried a tool outside the read-only allowlist', 'bug', { code: r.code });
    return r.text;
  };
  const saveState = async (extra: Record<string, unknown> = {}) =>
    withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.system(ORG62_DISCOVER_JOB), reason: `Org62 discovery: ${lookups} lookups`, entity: { type: 'settings', id: DISCOVER_KV }, undoable: false }, async (tx) => {
      const days = Object.fromEntries(Object.entries({ ...state.days, [day]: used + lookups }).filter(([k]) => k >= localDay(now.getTime() - 14 * 86_400_000, tz)));
      await putKv(tx, ctx.userId, DISCOVER_KV, { days, lastRunAt: mode === 'discover' ? now.toISOString() : state.lastRunAt, ...extra });
    });

  if (mode === 'lookup_ae') {
    const q = String(ctx.job.payload?.q ?? '').trim();
    let soql: string;
    try {
      soql = userLookupSoql(q);
    } catch {
      return { skipped: 'bad_query' };
    }
    const text = await read(soql);
    if (text === 'cap') return { skipped: 'cap', lookups, ...((await guard.finish?.()) ?? {}) };
    if (text === null) throw new JobError('the Org62 User read did not finish', 'transient', { code: 'lookup_failed' });
    let hits;
    try {
      hits = parseUsers(text).map((u) => ({ name: u.name, org62UserId: u.org62UserId, email: u.email, title: u.title, source: 'org62' as const }));
    } catch (e) {
      throw new JobError('Org62 answered in a way the app could not read', 'transient', { code: e instanceof DiscoverParseError ? 'unreadable' : 'parse' });
    }
    const cache = (await readKv<Record<string, unknown>>(ctx.db, ctx.userId, AE_LOOKUP_KV)) ?? {};
    await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.system(ORG62_DISCOVER_JOB), reason: 'AE lookup in Org62', entity: { type: 'settings', id: AE_LOOKUP_KV }, undoable: false }, async (tx) => {
      await putKv(tx, ctx.userId, AE_LOOKUP_KV, { ...cache, [q.toLowerCase()]: { at: now.toISOString(), hits } });
    });
    await saveState();
    return { mode, hits: hits.length, lookups, costUsd: Math.round(costUsd * 10_000) / 10_000, ...((await guard.finish?.()) ?? {}) };
  }

  // discover: me + the covered AEs I toggled on; the accounts I engaged lately
  const me = await myOrg62Id(ctx.db, ctx.userId);
  const covered = settings.coveredAes.filter((a) => a.enabled !== false && a.org62UserId).map((a) => a.org62UserId!);
  const coveredSet = new Set(covered.map((x) => x.slice(0, 15)));
  const engaged = await ctx.db.execute<{ org62_account_id: string }>(sql`
    select distinct a.org62_account_id from opp_engagement e join opportunities o on o.id = e.opportunity_id join accounts a on a.id = o.account_id
     where e.owner_user_id = ${ctx.userId} and e.week_start >= ${localDay(now.getTime() - DISCOVER_ENGAGED_DAYS * 86_400_000, tz)}::date and a.org62_account_id is not null
     limit 400`);
  const teamIds = [...(me ? [me] : []), ...covered];
  const queries = oppsSoql({ accountIds: engaged.rows.map((r) => r.org62_account_id), ownerIds: covered });
  if (!teamIds.length && !queries.length) return { skipped: 'nothing_to_read', note: 'No Org62 id of mine, no covered AE and no engaged account yet' };
  const found = new Map<string, DiscoveredOpp>();
  let partial: string | null = null;
  // the team read: chunked under Salesforce's statement limits, paged by Id, merged into `found` (readTeam)
  let team = { statements: 0, reads: 0 };
  if (teamIds.length) {
    let t: Awaited<ReturnType<typeof readTeam>>;
    try {
      t = await readTeam(teamIds, read, found);
    } catch (e) {
      throw new JobError('Org62 answered in a way the app could not read', 'transient', { code: e instanceof DiscoverParseError ? 'unreadable' : 'parse' });
    }
    if (t.partial === 'lookup_failed' && !lookups) throw new JobError('the Org62 discovery read did not finish', 'transient', { code: 'lookup_failed' });
    team = { statements: t.statements, reads: t.reads };
    partial = t.partial === 'cap' && guard.stop === 'spend' ? 'spend' : t.partial;
  }
  for (const q of partial ? [] : queries) {
    const text = await read(q);
    if (text === 'cap') {
      partial = guard.stop === 'spend' ? 'spend' : 'cap';
      break;
    }
    if (text === null) {
      if (!lookups) throw new JobError('the Org62 discovery read did not finish', 'transient', { code: 'lookup_failed' });
      partial = 'lookup_failed';
      break;
    }
    try {
      parseDiscovered(text, found);
    } catch (e) {
      throw new JobError('Org62 answered in a way the app could not read', 'transient', { code: e instanceof DiscoverParseError ? 'unreadable' : 'parse' });
    }
  }
  // D-103 (b): one fixed SELECT for my covered AEs' open Data & AI Specialist Forecasts (same read path, same cap);
  // R3-14: only the AEs whose coverage window holds today (an OOO cover that ended costs no read)
  const sfrRows: DiscoveredSfr[] = [];
  const sfrOnly = new Map<string, DiscoveredOpp>();
  const sfrAes = settings.coveredAes.filter((a) => a.enabled !== false && a.org62UserId && coverageActive(a, day)).map((a) => a.org62UserId!);
  for (const q of partial || !sfrAes.length ? [] : sfrDiscoverSoql(sfrAes)) {
    const text = await read(q);
    if (text === 'cap' || text === null) {
      partial = text === 'cap' ? (guard.stop === 'spend' ? 'spend' : 'cap') : 'lookup_failed';
      break;
    }
    try {
      sfrRows.push(...parseSpecialistForecasts(text, sfrOnly));
    } catch (e) {
      throw new JobError('Org62 answered in a way the app could not read', 'transient', { code: e instanceof DiscoverParseError ? 'unreadable' : 'parse' });
    }
  }
  // J-6, eligibility first: an opp only a Specialist Forecast names, below the DC threshold or outside the DC
  // products, is not a candidate; the job's result and its kv trace say why (ids and reason codes only)
  const sfr = sfrByOpp(sfrRows, now.toISOString());
  const sfrSkips: Array<{ opp: string; reason: SfrSkipReason }> = [];
  for (const [k, o] of sfrOnly) {
    const why = sfrEligibility(o, sfr.get(k)?.productLines ?? [], { minAmount, dcProducts: settings.dcProducts });
    if (why) {
      sfrSkips.push({ opp: o.org62Id, reason: why });
      sfr.delete(k);
    } else if (!found.has(k)) found.set(k, o);
  }
  const opps = [...found.values()].filter((o) => !o.isClosed);
  let added = 0;
  let updated = 0;
  if (opps.length) {
    const m = await loadModel(ctx.db, ctx.userId, now, { scope: everything('org62 discover job'), ops: false });
    const r = await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.scanner(ORG62_DISCOVER_JOB), reason: `Org62 discovery: ${opps.length} open opportunities read`, entity: { type: 'opportunities', id: ctx.userId }, undoable: false }, async (tx, cs) =>
      upsertDiscovered({ tx, cs, userId: ctx.userId, me: m.ctx.me, now, extractorId: '', timezone: tz, kv: m.ctx.kv }, opps, (o) => viaOf(o, me, coveredSet), me),
    );
    added = r.result.added;
    updated = r.result.updated;
    const marks = opps.flatMap((o, i) => (sfr.has(org62Key(o.org62Id)) && r.result.ids[i] ? [{ oppId: r.result.ids[i]!, sfr: sfr.get(org62Key(o.org62Id))! }] : []));
    if (marks.length) await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.scanner(ORG62_DISCOVER_JOB), reason: `Org62 discovery: ${marks.length} opportunities a covered AE's Specialist Forecast names`, entity: { type: 'opportunities', id: ctx.userId }, undoable: false }, async (tx, cs) => markSpecialistForecasts({ tx, cs, userId: ctx.userId, me: m.ctx.me, now, extractorId: '', timezone: tz, kv: m.ctx.kv }, marks));
  }
  await saveState({ sfrSkips: sfrSkips.slice(0, 200) });
  // past the hold the job asked: its continuation runs the discovery again (trigger manual: not "not due"), same hold
  const paused = (await guard.finish?.({ payload: { trigger: 'manual' } })) ?? {};
  const skipped = sfrSkips.reduce<Record<string, number>>((a, x) => ({ ...a, [x.reason]: (a[x.reason] ?? 0) + 1 }), {});
  return { mode, read: opps.length, added, updated, lookups, sfr: sfrRows.length, sfrOpps: sfr.size, ...(sfrSkips.length ? { sfrSkipped: skipped } : {}), teamStatements: team.statements, teamReads: team.reads, ...(partial ? { partial } : {}), costUsd: Math.round(costUsd * 10_000) / 10_000, ...paused };
}

export function org62DiscoverJobDef(): JobHandlerDef {
  return { kind: ORG62_DISCOVER_JOB, queue: ATTRIBUTION_QUEUE, wired: true, spends: true, description: 'Org62 discovery (attribution engine): open opps of my teams, my covered AEs and the accounts I engaged (fixed SOQL, read-only) → the mirror, with provenance; and the covered-AE User lookup', handler: (ctx) => runOrg62Discover(ctx) };
}
