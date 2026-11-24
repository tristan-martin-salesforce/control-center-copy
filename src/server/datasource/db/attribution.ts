/**
 * The attribution engine on Postgres (src/engines/attribution; holistic review 2026-11-20 lane 06): learned rules
 * (mapping_rules, read first and written by every correction), the engine's read-side extras for Time rows, the
 * `opp_engagement` rollup, DC suggestions (dc_suggestions) and their decisions, the opp rundown, the covered-AE lookup
 * and the discovered-opp upsert. The mock's twin is src/server/datasource/mock/attribution.ts.
 *
 * Writes: a correction's rules and outcome ride the correction's own change set (Undo reverts the learning with the
 * edit); a DC decision is one change set with the DC request Accept drafts (it rides the next logging canvas, applied
 * by the user: tenet: Nothing leaves without approval). The rollup and the outcome log are unaudited bookkeeping.
 * Logs carry ids and counts only.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { attributionSettingsOf, EMPTY_DC_CONTEXT, type ActivityEntry, type CoveredAeLookupResult, type DcSuggestion, type DcSuggestionsPayload, type DecideDcSuggestionRequest, type MappingRuleView, type OppRundown, type Settings } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db, DbOrTx, Tx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { localDay, weekStart } from '@/engines/activity/time';
import { DB_KIND, INTERNAL_TARGET, RULE_KIND_OF_DB, planLearning, ruleActive, type Chosen, type RuleChange } from '@/engines/attribution/rules';
import { decideDc, planDcSuggestions, type DcCandidateOpp, type DcSuggestionRow } from '@/engines/attribution/dc';
import { engagementSummaries, rollupEngagement, totalsByOpp, type EngagementRow } from '@/engines/attribution/engagement';
import { coverageRefsOf } from '@/engines/attribution/coverage';
import { oppRundown } from '@/engines/attribution/rundown';
import { rowAttribution, worldOfContract, type RowExtras } from '@/engines/attribution/row';
import { dcComment, dcPayload, ruleView as ruleViewOf } from '@/engines/attribution/view';
import type { DiscoveredOpp } from '@/engines/attribution/discover';
import type { LearnedMappings } from '@/engines/attribution/activity';
import type { LearnedRule } from '@/engines/attribution/types';
import { touchesOf } from '@/engines/attribution/touches';
import { lastCallsByAccount } from '@/engines/attribution/resurface';
import { sfrQuarterBounds, sfrQuarterOfDay } from '@/engines/forecast/time';
import { DEFAULT_MIN_AMOUNT } from '@/engines/deals/classify';
import { featureActive, personaOf } from '@/personas';
import { invalid, notFound } from '@/server/errors';
import { storedSuggestionsOf, SUGGESTIONS_KV, type SuggestContext } from '@/lib/time-suggest';
import { loggingProfile } from '@/engines/activity/persona';
import { org62RecordUrl } from '@/projections/links';
import { extKey } from './ext';
import { loadDcContexts, sfrCandidateFields } from './attribution-sfr';

export { OPP_SFR_EXT, markSpecialistForecasts, oppSfrOf, sfrCandidateFields, loadDcContexts } from './attribution-sfr';
import { loadModel, type ReadModel } from './model';
import { everything } from './reads/scope';
import type { WriteCtx } from './store/common';
import { mergeExt, upsertOpportunityFromOrg62 } from './store/projections';
import { liveDcRequest } from '@/server/deals/dc-requests';
import { loadDcRequests } from './store/dc-requests';

export const OPP_ENGAGEMENT_JOB = 'attribution.opp_engagement';
export const DC_SUGGEST_JOB = 'attribution.dc_suggest';
export const ORG62_DISCOVER_JOB = 'org62.discover';
export const ATTRIBUTION_QUEUE = 'maintenance';
/** kv: when the DC batch last ran, and the discovery's last run (cadence). */
export const DC_SUGGEST_KV = 'cc.attribution.dc_suggest';
export const DISCOVER_KV = 'cc.attribution.discover';
/** kv: the covered-AE lookups' Org62 hits per name, kept 7 days. */
export const AE_LOOKUP_KV = 'cc.attribution.ae_lookup';
export const AE_LOOKUP_TTL_MS = 7 * 86_400_000;

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

// ---------------------------------------------------------------------------
// Learned rules
// ---------------------------------------------------------------------------

interface RuleRow extends Record<string, unknown> {
  id: string;
  kind: string;
  pattern: string;
  account_id: string | null;
  opportunity_id: string | null;
  target_value: string | null;
  hit_count: number;
  miss_count: number;
  last_hit_at: Date | string | null;
  enabled: boolean;
  source: string;
}

const KINDS = Object.keys(RULE_KIND_OF_DB);

/** The learned rules the engine reads (plain keys; regex seeds and the ignore kinds are not attribution rules). */
export async function loadRules(db: DbOrTx, userId: string, opts: { all?: boolean } = {}): Promise<LearnedRule[]> {
  const r = await db.execute<RuleRow>(sql`
    select id, kind::text as kind, pattern, account_id, opportunity_id, target_value, hit_count, miss_count, last_hit_at, enabled, source::text as source
      from mapping_rules
     where owner_user_id = ${userId} and not is_regex and kind::text in (${sql.join(KINDS.map((k) => sql`${k}`), sql`, `)})
       ${opts.all ? sql`` : sql`and enabled`}
     order by priority, updated_at desc`);
  return r.rows.map((x) => ({
    id: x.id,
    kind: RULE_KIND_OF_DB[x.kind]!,
    pattern: x.pattern,
    accountId: x.account_id,
    oppId: x.opportunity_id,
    internal: x.target_value === INTERNAL_TARGET,
    hits: Math.max(n(x.hit_count), x.source === 'seed' ? 1 : 0),
    misses: n(x.miss_count),
    lastUsedAt: iso(x.last_hit_at),
    enabled: x.enabled,
    source: x.source === 'user_correction' ? 'user_correction' : 'seed',
  }));
}

/** Write a correction's rule changes (inside its change set: mapping_rules is audited, so Undo reverts them). */
export async function writeRuleChanges(w: WriteCtx, changes: readonly RuleChange[]): Promise<string[]> {
  const ids: string[] = [];
  for (const c of changes) {
    const a = c.after;
    const target = a.internal ? INTERNAL_TARGET : null;
    if (!c.before) {
      // a user correction ranks ahead of seeds (priority 50 < 100)
      const r = await w.tx.execute<{ id: string }>(sql`
        insert into mapping_rules (id, owner_user_id, kind, pattern, is_regex, account_id, opportunity_id, target_value, priority, source, created_from_change_set_id, hit_count, miss_count, last_hit_at, enabled)
        values (${a.id}, ${w.userId}, ${DB_KIND[a.kind]}::mapping_rule_kind, ${a.pattern}, false, ${a.accountId}, ${a.oppId}, ${target}, 50, 'user_correction'::rule_source, ${w.cs.id}, ${a.hits}, ${a.misses}, ${a.lastUsedAt}::timestamptz, true)
        on conflict (owner_user_id, kind, pattern) do update set
          account_id = excluded.account_id, opportunity_id = excluded.opportunity_id, target_value = excluded.target_value,
          hit_count = mapping_rules.hit_count + 1, last_hit_at = excluded.last_hit_at, enabled = true, updated_at = now()
        returning id`);
      ids.push(r.rows[0]?.id ?? a.id);
      continue;
    }
    await w.tx.execute(sql`
      update mapping_rules set account_id = ${a.accountId}, opportunity_id = ${a.oppId}, target_value = ${target},
             hit_count = ${a.hits}, miss_count = ${a.misses}, last_hit_at = ${c.effect === 'decayed' ? iso(c.before.lastUsedAt) : a.lastUsedAt}::timestamptz,
             last_miss_at = ${c.effect === 'decayed' ? a.lastUsedAt : null}::timestamptz,
             source = ${c.effect === 'replaced' ? 'user_correction' : c.before.source === 'seed' ? 'seed' : 'user_correction'}::rule_source, updated_at = now()
       where id = ${a.id} and owner_user_id = ${w.userId}`);
    ids.push(a.id);
  }
  return ids;
}

export async function recordOutcome(tx: DbOrTx, userId: string, o: { subjectKind: string; subjectId: string; outcome: 'accept' | 'edit' | 'reject'; basis?: string | null; topReason?: string | null; shownConfidence?: number | null; shownTarget?: string | null; chosenTarget?: string | null; ruleIds?: string[] }): Promise<void> {
  await tx.execute(sql`
    insert into attribution_outcomes (owner_user_id, subject_kind, subject_id, outcome, basis, top_reason, shown_confidence, shown_target, chosen_target, rule_ids)
    values (${userId}, ${o.subjectKind}, ${o.subjectId}, ${o.outcome}, ${o.basis ?? null}, ${o.topReason ?? null}, ${o.shownConfidence ?? null}, ${o.shownTarget ?? null}, ${o.chosenTarget ?? null}, ${JSON.stringify(o.ruleIds ?? [])}::jsonb)`);
}

// ---------------------------------------------------------------------------
// The engine's extras (read side) and the activity engine's learned mappings
// ---------------------------------------------------------------------------

/** The Time rows' suggestion context from the read model (GET /time's, the jobs'), with the engine's extras. */
export function contextOf(m: ReadModel, now: Date, extras?: RowExtras): SuggestContext {
  return {
    opps: m.all('opps'),
    accounts: m.all('accounts'),
    events: m.all('events'),
    people: m.all('people'),
    assets: m.all('assets'),
    runs: m.all('agentRuns'),
    workItems: m.all('workItems'),
    activity: m.all('activity'),
    today: localDay(now.getTime(), m.settings().profile.timezone || 'UTC'),
    stored: storedSuggestionsOf(m.ctx.kv.get(SUGGESTIONS_KV)),
    internalActivity: loggingProfile(personaOf(m.settings())).internalActivity,
    ...(extras ? { attribution: extras } : {}),
  };
}

/** What the engine reads besides the read model (learned rules, channels, series, engagement, covered AEs). */
export async function loadRowExtras(db: DbOrTx, userId: string, s: Settings, kv: Map<string, unknown>, today: string): Promise<RowExtras> {
  const [rules, ch, series, eng, domains, me] = [
    await loadRules(db, userId),
    await db.execute<{ external_id: string; name: string | null; account_id: string | null; opportunity_id: string | null }>(sql`
      select c.external_id, lower(c.name) as name, m.account_id, m.opportunity_id
        from channels c left join channel_account_maps m on m.channel_id = c.id and m.user_verdict is distinct from 'rejected'
       where c.owner_user_id = ${userId} and c.name is not null`),
    await db.execute<{ id: string; rid: string }>(sql`
      select id, recurring_event_id as rid from calendar_events
       where owner_user_id = ${userId} and recurring_event_id is not null and starts_at > now() - interval '180 days'`),
    await loadEngagement(db, userId, weekStart(new Date(Date.parse(`${today}T12:00:00Z`) - 35 * 86_400_000).toISOString().slice(0, 10))),
    await db.execute<{ account_id: string; value: string }>(sql`
      select l.account_id, l.normalized_value as value from account_aliases l join accounts a on a.id = l.account_id
       where a.owner_user_id = ${userId} and l.kind::text = 'domain'`),
    await db.execute<{ email: string | null }>(sql`select email from users where id = ${userId}`),
  ];
  const channels: NonNullable<RowExtras['channels']> = {};
  for (const r of ch.rows) if (r.name) channels[r.name] = { id: r.external_id, accountId: r.account_id, oppId: r.opportunity_id };
  const seriesOf: Record<string, string> = {};
  for (const r of series.rows) seriesOf[r.id] = r.rid;
  const accountDomains: Record<string, string[]> = {};
  for (const r of domains.rows) (accountDomains[r.account_id] ??= []).push(r.value);
  const oppVia: Record<string, 'book' | 'discovered' | 'covered_ae'> = {};
  for (const [k, v] of kv) {
    if (!k.startsWith(extKey('opportunities', ''))) continue;
    const via = (v as { via?: unknown } | null)?.via;
    if (via === 'discovered' || via === 'covered_ae') oppVia[k.slice(extKey('opportunities', '').length)] = via;
  }
  const myDomain = me.rows[0]?.email?.split('@')[1]?.toLowerCase();
  return {
    rules,
    channels,
    seriesOf,
    engagement: engagementSummaries(eng, today),
    coveredAes: coverageRefsOf(attributionSettingsOf(s.time).coveredAes),
    oppTeams: await loadOppTeams(db, userId),
    internalDomains: myDomain ? [myDomain] : [],
    accountDomains,
    oppVia,
  };
}

/**
 * The activity engine's learned mappings (projections/run.ts passes them in ActivityMappings): the rules, the opps they
 * name (WhatId, name, team), and the user-confirmed channel map (Slack channel id → account), which the projection
 * never passed before (lane 06 TA-3).
 */
export async function loadLearnedMappings(db: DbOrTx, userId: string): Promise<{ learned: LearnedMappings; channels: Record<string, string> }> {
  const rules = await loadRules(db, userId);
  const oppIds = [...new Set(rules.filter(ruleActive).map((r) => r.oppId).filter((x): x is string => !!x))];
  const opps: LearnedMappings['opps'] = {};
  if (oppIds.length) {
    const r = await db.execute<{ id: string; account_id: string | null; org62_opportunity_id: string; name: string; on_my_team: boolean; is_closed: boolean }>(sql`
      select id, account_id, org62_opportunity_id, name, on_my_team, is_closed from opportunities
       where owner_user_id = ${userId} and id in (${sql.join(oppIds.map((x) => sql`${x}::uuid`), sql`, `)})`);
    for (const o of r.rows) opps[o.id] = { accountKey: o.account_id, whatId: o.org62_opportunity_id, whatName: o.name, team: o.on_my_team, isOpen: !o.is_closed };
  }
  const ch = await db.execute<{ external_id: string; account_id: string }>(sql`
    select c.external_id, m.account_id from channel_account_maps m join channels c on c.id = m.channel_id
     where c.owner_user_id = ${userId} and m.user_verdict is distinct from 'rejected'`);
  const channels: Record<string, string> = {};
  for (const r of ch.rows) channels[r.external_id] = r.account_id;
  return { learned: { rules: rules.filter((r) => !r.oppId || !!opps[r.oppId]), opps }, channels };
}

// ---------------------------------------------------------------------------
// opp_engagement
// ---------------------------------------------------------------------------

interface EngRow extends Record<string, unknown> {
  opportunity_id: string;
  week_start: string | Date;
  meetings: string;
  external_meetings: string;
  slack_lines: string;
  mail_threads: string;
  docs_touched: string;
  sessions: string;
  notes: string;
  hours_logged: string;
  credit: string;
  last_touch_at: Date | string | null;
  source_counts: Record<string, number>;
  refs: Array<{ label: string; url: string | null; at: string }>;
}

export async function loadEngagement(db: DbOrTx, userId: string, fromWeek: string): Promise<EngagementRow[]> {
  const r = await db.execute<EngRow>(sql`select * from opp_engagement where owner_user_id = ${userId} and week_start >= ${fromWeek}::date order by week_start, opportunity_id`);
  return r.rows.map((x) => ({
    oppId: x.opportunity_id,
    weekStart: typeof x.week_start === 'string' ? x.week_start.slice(0, 10) : x.week_start.toISOString().slice(0, 10),
    meetings: n(x.meetings),
    externalMeetings: n(x.external_meetings),
    slackLines: n(x.slack_lines),
    mailThreads: n(x.mail_threads),
    docsTouched: n(x.docs_touched),
    sessions: n(x.sessions),
    notes: n(x.notes),
    hoursLogged: n(x.hours_logged),
    credit: n(x.credit),
    lastTouchAt: iso(x.last_touch_at),
    sourceCounts: x.source_counts ?? {},
    refs: x.refs ?? [],
  }));
}

/** Rebuild opp_engagement from this quarter's start minus 4 weeks (the nightly job and the fast path). */
export async function rebuildEngagement(db: Db, userId: string, now: Date): Promise<{ rows: number; touches: number; from: string }> {
  const m = await loadModel(db, userId, now, { scope: everything('attribution job'), ops: false });
  const tz = m.settings().profile.timezone || 'UTC';
  const today = localDay(now.getTime(), tz);
  const q = sfrQuarterBounds(sfrQuarterOfDay(today));
  const from = weekStart(new Date(Date.parse(`${(q?.start ?? today)}T12:00:00Z`) - 28 * 86_400_000).toISOString().slice(0, 10));
  // the engine's alternates read the learned rules, the channel map and covered AEs (not last week's engagement: it is being rebuilt)
  const ctx = contextOf(m, now, { ...(await loadRowExtras(db, userId, m.settings(), m.ctx.kv, today)), engagement: {} });
  const touches = touchesOf(m.all('activity'), ctx, from);
  const open = new Map<string, string[]>();
  for (const o of ctx.opps) if (o.isOpen && o.accountId) open.set(o.accountId, [...(open.get(o.accountId) ?? []), o.id]);
  const rows = rollupEngagement(touches, open);
  const known = new Set(ctx.opps.map((o) => o.id));
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from opp_engagement where owner_user_id = ${userId} and week_start >= ${from}::date`);
    for (const r of rows) {
      if (!known.has(r.oppId)) continue;
      await tx.execute(sql`
        insert into opp_engagement (owner_user_id, opportunity_id, week_start, meetings, external_meetings, slack_lines, mail_threads, docs_touched, sessions, notes, hours_logged, credit, last_touch_at, source_counts, refs, computed_at)
        values (${userId}, ${r.oppId}::uuid, ${r.weekStart}::date, ${r.meetings}, ${r.externalMeetings}, ${r.slackLines}, ${r.mailThreads}, ${r.docsTouched}, ${r.sessions}, ${r.notes}, ${r.hoursLogged}, ${r.credit}, ${r.lastTouchAt}::timestamptz, ${JSON.stringify(r.sourceCounts)}::jsonb, ${JSON.stringify(r.refs)}::jsonb, ${now.toISOString()}::timestamptz)`);
    }
  });
  return { rows: rows.filter((r) => known.has(r.oppId)).length, touches: touches.length, from };
}

// ---------------------------------------------------------------------------
// DC suggestions
// ---------------------------------------------------------------------------

interface SugRow extends Record<string, unknown> {
  id: string;
  opportunity_id: string;
  quarter: string;
  group_key: string;
  state: string;
  share_percent: number;
  split_percent: number | null;
  pre_ticked: boolean;
  reasons: DcSuggestionRow['reasons'];
  evidence: DcSuggestionRow['evidence'];
  covered_ae: string | null;
  baseline: DcSuggestionRow['baseline'];
  dc_request_id: string | null;
  decided_at: Date | string | null;
}

const rowOf = (x: SugRow): DcSuggestionRow & { decidedAt: string | null } => ({
  id: x.id,
  oppId: x.opportunity_id,
  quarter: x.quarter,
  groupKey: x.group_key,
  state: x.state as DcSuggestionRow['state'],
  sharePercent: n(x.share_percent),
  splitPercent: x.split_percent === null ? null : n(x.split_percent),
  preTicked: x.pre_ticked,
  reasons: x.reasons ?? [],
  evidence: x.evidence ?? [],
  coveredAe: x.covered_ae,
  baseline: x.baseline ?? null,
  dcRequestId: x.dc_request_id,
  decidedAt: iso(x.decided_at),
});

export async function loadDcSuggestionRows(db: DbOrTx, userId: string, quarter?: string): Promise<Array<DcSuggestionRow & { decidedAt: string | null }>> {
  const r = await db.execute<SugRow>(sql`select * from dc_suggestions where owner_user_id = ${userId} ${quarter ? sql`and quarter = ${quarter}` : sql``} order by created_at, id`);
  return r.rows.map(rowOf);
}

/** The DC rule's inputs from the read model (opps with requests, other architects' DCs, the sweep's claims). */
export async function dcCandidates(db: DbOrTx, m: ReadModel, extras: RowExtras): Promise<DcCandidateOpp[]> {
  const userId = m.ctx.userId;
  const requests = await loadDcRequests(db, userId);
  const requested = new Set(requests.filter((r) => liveDcRequest(r)).map((r) => r.oppId));
  const claims = new Set(m.all('missedOpps').filter((x) => x.verdict === 'claim' && x.status === 'new' && x.oppId).map((x) => x.oppId!));
  const other = new Set(m.all('missedOpps').filter((x) => x.otherDcs.length && x.oppId).map((x) => x.oppId!));
  const world = worldOfContract({ opps: m.all('opps'), accounts: m.all('accounts'), people: m.all('people'), activity: [], today: '9999-12-31', attribution: extras });
  const acct = new Map(m.all('accounts').map((a) => [a.id, a.name] as const));
  return world.opps.map((o) => ({ ...o, accountName: o.accountId ? (acct.get(o.accountId) ?? null) : null, requested: requested.has(o.id), sweepClaim: claims.has(o.id), otherArchitectDc: other.has(o.id), ...sfrCandidateFields(m.ctx.kv, o.id, o.products) }));
}

/** The daily batch: rebuild nothing, read the rollup, plan, write (one change set, not undoable: it is the app's own). */
export async function runDcBatch(db: Db, userId: string, now: Date): Promise<{ suggestions: number; changed: number; skipped?: string }> {
  const m = await loadModel(db, userId, now, { scope: everything('attribution job'), ops: false });
  const s = m.settings();
  if (!featureActive(personaOf(s), 'dealContributions')) return { suggestions: 0, changed: 0, skipped: 'dc_inactive' };
  const tz = s.profile.timezone || 'UTC';
  const today = localDay(now.getTime(), tz);
  const quarter = sfrQuarterOfDay(today);
  const qStart = sfrQuarterBounds(quarter)?.start ?? today;
  const extras = await loadRowExtras(db, userId, s, m.ctx.kv, today);
  const [opps, eng, existing] = [await dcCandidates(db, m, extras), await loadEngagement(db, userId, weekStart(qStart)), await loadDcSuggestionRows(db, userId, quarter)];
  const a = attributionSettingsOf(s.time);
  const minAmount = Number(personaOf(s).thresholds.missedOppMinAmountUsd ?? DEFAULT_MIN_AMOUNT);
  const plan = planDcSuggestions({ opps, totals: totalsByOpp(eng, weekStart(qStart)), coveredAes: extras.coveredAes ?? [], asOf: today, dcProducts: a.dcProducts, minAmount: Number.isFinite(minAmount) ? minAmount : DEFAULT_MIN_AMOUNT, dcSplit: a.dcSplit, quarter, existing, newId: () => randomUUID(), ...dbCallsOf(m, now.toISOString()) });
  const before = new Map(existing.map((x) => [x.id, x] as const));
  const changed = plan.upserts.filter((u) => JSON.stringify({ ...before.get(u.id), decidedAt: undefined }) !== JSON.stringify({ ...u, decidedAt: undefined }));
  if (changed.length) {
    await withChangeSet({ db, userId, actor: actors.system(DC_SUGGEST_JOB), reason: `DC suggestions: ${changed.length} updated`, entity: { type: 'dc_suggestions', id: userId }, undoable: false }, async (tx) => {
      for (const u of changed) await upsertSuggestion(tx, userId, u);
    });
  }
  return { suggestions: plan.upserts.filter((u) => u.state === 'new').length, changed: changed.length };
}

async function upsertSuggestion(tx: Tx, userId: string, u: DcSuggestionRow, decidedAt?: string | null): Promise<void> {
  await tx.execute(sql`
    insert into dc_suggestions (id, owner_user_id, opportunity_id, quarter, group_key, state, share_percent, split_percent, pre_ticked, reasons, evidence, covered_ae, baseline, dc_request_id, decided_at)
    values (${u.id}::uuid, ${userId}, ${u.oppId}::uuid, ${u.quarter}, ${u.groupKey}, ${u.state}, ${u.sharePercent}, ${u.splitPercent}, ${u.preTicked}, ${JSON.stringify(u.reasons)}::jsonb, ${JSON.stringify(u.evidence)}::jsonb, ${u.coveredAe}, ${u.baseline ? JSON.stringify(u.baseline) : null}::jsonb, ${u.dcRequestId}::uuid, ${decidedAt ?? null}::timestamptz)
    on conflict (owner_user_id, opportunity_id, quarter) do update set
      group_key = excluded.group_key, state = excluded.state, share_percent = excluded.share_percent, split_percent = excluded.split_percent,
      pre_ticked = excluded.pre_ticked, reasons = excluded.reasons, evidence = excluded.evidence, covered_ae = excluded.covered_ae,
      baseline = excluded.baseline, dc_request_id = excluded.dc_request_id, decided_at = coalesce(excluded.decided_at, dc_suggestions.decided_at), updated_at = now()`);
}

/** Rows → the contract (with the opp's name, account, amount, stage and close, and each group's size). */
export function suggestionsView(rows: ReadonlyArray<DcSuggestionRow & { decidedAt: string | null }>, m: Pick<ReadModel, 'get'>): DcSuggestion[] {
  const size = new Map<string, number>();
  for (const r of rows) if (r.state === 'new') size.set(r.groupKey, (size.get(r.groupKey) ?? 0) + 1);
  return rows.flatMap((r): DcSuggestion[] => {
    const o = m.get('opps', r.oppId);
    if (!o) return [];
    return [
      {
        id: r.id,
        oppId: r.oppId,
        oppName: o.name,
        accountId: o.accountId || null,
        accountName: m.get('accounts', o.accountId)?.name ?? null,
        amount: o.amount,
        stage: o.stage,
        closeDate: o.closeDate,
        quarter: r.quarter,
        groupKey: r.groupKey,
        groupSize: Math.max(1, size.get(r.groupKey) ?? 1),
        sharePercent: r.sharePercent,
        splitPercent: r.splitPercent,
        preTicked: r.preTicked,
        state: r.state,
        reasons: r.reasons,
        evidence: r.evidence,
        coveredAe: r.coveredAe,
        dcRequestId: r.dcRequestId,
        decidedAt: r.decidedAt,
        context: EMPTY_DC_CONTEXT,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// The DataSource side
// ---------------------------------------------------------------------------

export interface DbAttributionHost {
  db: Db;
  now(): Date;
  userId(): Promise<string>;
  model(): Promise<ReadModel>;
  /** The Time rows' suggestion context (the read model's records), without the extras. */
  suggestContext(m: ReadModel): SuggestContext;
  mutate<T>(meta: { action: string; summary: string; entity: { type: string; id: string } }, fn: (w: WriteCtx, model: ReadModel) => Promise<T>): Promise<{ result: T; auditId: string; undoable: boolean }>;
  /** Draft a DC request in this change set (the existing DC adapter path: it rides the next logging canvas). */
  claimDc(w: WriteCtx, model: ReadModel, opp: { id: string; name: string }, body: { split: number; comment: string; role?: string }): Promise<{ id: string }>;
  /** Org62 reads run here (the launchd worker's machine: CC_LIVE); a lookup is then queued for the worker. */
  org62Live: boolean;
  publish(tables: string[], ids: string[], reason: string): void;
}

const EXTRAS_TTL_MS = 15_000;

export class DbAttribution {
  private extras: { userId: string; at: number; value: RowExtras } | null = null;

  constructor(private readonly host: DbAttributionHost) {}

  /** The extras, loaded at most every 15 s (and after every learning write). */
  async ensureExtras(m?: ReadModel): Promise<RowExtras> {
    const model = m ?? (await this.host.model());
    const userId = model.ctx.userId;
    if (this.extras && this.extras.userId === userId && Date.now() - this.extras.at < EXTRAS_TTL_MS) return this.extras.value;
    const today = localDay(this.host.now().getTime(), model.settings().profile.timezone || 'UTC');
    const value = await loadRowExtras(this.host.db, userId, model.settings(), model.ctx.kv, today);
    this.extras = { userId, at: Date.now(), value };
    return value;
  }

  /** The cached extras for a synchronous reader (undefined until the first ensureExtras). */
  cached(userId: string): RowExtras | undefined {
    return this.extras?.userId === userId ? this.extras.value : undefined;
  }

  invalidate(): void {
    this.extras = null;
  }

  private ctx(m: ReadModel, extras: RowExtras): SuggestContext {
    return { ...this.host.suggestContext(m), attribution: extras };
  }

  /**
   * A correction on a Time row (its opp set, or made internal): learn from it in the same change set (the rules it
   * agrees with get stronger, the ones it contradicts decay, a new key gets a rule) and log the outcome.
   */
  async learnFromRow(w: WriteCtx, model: ReadModel, cur: ActivityEntry, next: ActivityEntry, how: 'patch' | 'org62_pick' = 'patch'): Promise<void> {
    const chosen: Chosen | null = next.internal && !cur.internal ? { oppId: null, accountId: null, internal: true } : next.oppId && next.oppId !== cur.oppId ? { oppId: next.oppId, accountId: model.get('opps', next.oppId)?.accountId ?? null } : null;
    if (!chosen) return;
    const ctx = this.ctx(model, await loadRowExtras(w.tx, w.userId, model.settings(), model.ctx.kv, localDay(w.now.getTime(), w.timezone || 'UTC')));
    const ra = rowAttribution(cur, ctx, { internalOk: ctx.internalActivity });
    const shown = ra.suggestion;
    const accepted = !!shown && ((shown.kind === 'internal' && !!chosen.internal) || (!!shown.oppId && shown.oppId === chosen.oppId));
    const outcome = accepted ? 'accept' : 'edit';
    const existing = await loadRules(w.tx, w.userId, { all: true });
    const changes = planLearning({ signal: ra.signal, chosen, outcome, shown: shown ? { oppId: shown.oppId, accountId: null, internal: shown.kind === 'internal' } : null, world: worldOfContract(ctx) }, existing, w.now.toISOString(), () => randomUUID());
    const ruleIds = await writeRuleChanges(w, changes);
    await recordOutcome(w.tx, w.userId, { subjectKind: how === 'org62_pick' ? 'activity_entry_org62' : 'activity_entry', subjectId: cur.id, outcome, basis: shown?.basis ?? null, topReason: ra.attribution.top?.why[0]?.code ?? null, shownConfidence: shown?.confidence ?? null, shownTarget: shown ? (shown.oppId ?? 'internal') : null, chosenTarget: chosen.internal ? 'internal' : chosen.oppId, ruleIds });
    this.invalidate();
    // the fast path: this row's engagement (and the DC batch after it) in a minute, once per burst of edits
    await enqueueJob(w.tx, { ownerUserId: w.userId, kind: OPP_ENGAGEMENT_JOB, queue: ATTRIBUTION_QUEUE, payload: { trigger: 'change' }, dedupeKey: `${OPP_ENGAGEMENT_JOB}:${w.userId}:change`, runAt: new Date(w.now.getTime() + 60_000), maxAttempts: 2, timeoutSeconds: 600 }).catch(() => undefined);
  }

  async rules(): Promise<{ rules: MappingRuleView[] }> {
    const m = await this.host.model();
    const all = await loadRules(this.host.db, m.ctx.userId, { all: true });
    return { rules: all.map((r) => ruleView(r, m)) };
  }

  async patchRule(id: string, enabled: boolean): Promise<{ entity: MappingRuleView; auditId: string | null }> {
    const r = await this.host.mutate({ action: enabled ? 'attribution.rule.enable' : 'attribution.rule.disable', summary: `${enabled ? 'Turned on' : 'Turned off'} a learned rule`, entity: { type: 'mapping_rules', id } }, async (w, model) => {
      const u = await w.tx.execute<{ id: string }>(sql`update mapping_rules set enabled = ${enabled}, updated_at = now() where id = ${id}::uuid and owner_user_id = ${w.userId} returning id`);
      if (!u.rows.length) throw notFound('Learned rule', id);
      const rule = (await loadRules(w.tx, w.userId, { all: true })).find((x) => x.id === id);
      if (!rule) throw notFound('Learned rule', id);
      return ruleView(rule, model);
    });
    this.invalidate();
    this.host.publish(['mapping_rules'], [id], 'attribution.rule');
    return { entity: r.result, auditId: r.undoable ? r.auditId : null };
  }

  async deleteRule(id: string): Promise<{ entity: { rules: MappingRuleView[] }; auditId: string | null }> {
    const r = await this.host.mutate({ action: 'attribution.rule.delete', summary: 'Removed a learned rule', entity: { type: 'mapping_rules', id } }, async (w) => {
      const d = await w.tx.execute<{ id: string }>(sql`delete from mapping_rules where id = ${id}::uuid and owner_user_id = ${w.userId} returning id`);
      if (!d.rows.length) throw notFound('Learned rule', id);
    });
    this.invalidate();
    this.host.publish(['mapping_rules'], [id], 'attribution.rule.delete');
    return { entity: await this.rules(), auditId: r.undoable ? r.auditId : null };
  }

  async dcSuggestions(): Promise<DcSuggestionsPayload> {
    const m = await this.host.model();
    const s = m.settings();
    const today = localDay(this.host.now().getTime(), s.profile.timezone || 'UTC');
    const quarter = sfrQuarterOfDay(today);
    const enabled = featureActive(personaOf(s), 'dealContributions');
    const rows = enabled ? await loadDcSuggestionRows(this.host.db, m.ctx.userId, quarter) : [];
    const ran = m.ctx.kv.get(DC_SUGGEST_KV) as { at?: string } | undefined;
    const ctxs = await loadDcContexts(this.host.db, m, [...new Set(rows.map((r) => r.oppId))], attributionSettingsOf(s.time).coveredAes);
    return dcPayload(suggestionsView(rows, m).map((x) => ({ ...x, context: ctxs.get(x.oppId) ?? x.context })), quarter, { generatedAt: ran?.at ?? null, dcProducts: attributionSettingsOf(s.time).dcProducts, enabled });
  }

  async decide(id: string, body: DecideDcSuggestionRequest): Promise<{ entity: { suggestion: DcSuggestion; dcRequestId: string | null }; auditId: string | null }> {
    const r = await this.host.mutate({ action: `dc.suggestion.${body.decision}`, summary: `DC suggestion: ${body.decision}`, entity: { type: 'dc_suggestions', id } }, async (w, model) => {
      if (!featureActive(personaOf(model.settings()), 'dealContributions')) throw invalid('Deal contributions are off for this persona');
      const cur = (await loadDcSuggestionRows(w.tx, w.userId)).find((x) => x.id === id);
      if (!cur) throw notFound('DC suggestion', id);
      if (cur.state !== 'new') throw invalid(`This suggestion is ${cur.state} already`);
      const opp = model.get('opps', cur.oppId);
      if (!opp) throw notFound('Opportunity', cur.oppId);
      const view = suggestionsView([cur], model)[0]!;
      let dcRequestId: string | null = null;
      const split = body.split ?? cur.splitPercent ?? undefined;
      if (body.decision !== 'reject') {
        if (split === undefined) throw invalid('Another architect has a DC on this opportunity: agree the split, then Edit with your split');
        dcRequestId = (await this.host.claimDc(w, model, { id: opp.id, name: opp.name }, { split, comment: body.comment ?? dcComment(view), ...(body.role ? { role: body.role } : {}) })).id;
      }
      const eng = totalsByOpp(await loadEngagement(w.tx, w.userId, weekStart(sfrQuarterBounds(cur.quarter)?.start ?? '1970-01-05')), '0000-00-00').get(cur.oppId);
      const next = decideDc(cur, body.decision, { hours: eng?.hoursLogged ?? 0, onTeam: opp.isMine, lastCallAt: (opp.accountId && dbCallsOf(model, w.now.toISOString()).calls.get(opp.accountId)) || null, at: w.now.toISOString() }, dcRequestId, split);
      await upsertSuggestion(w.tx, w.userId, next, w.now.toISOString());
      await recordOutcome(w.tx, w.userId, { subjectKind: 'dc_suggestion', subjectId: id, outcome: body.decision, basis: 'engine', topReason: cur.reasons[0]?.code ?? null, shownConfidence: cur.sharePercent / 100, shownTarget: cur.oppId, chosenTarget: body.decision === 'reject' ? null : cur.oppId });
      return { suggestion: { ...view, state: next.state, splitPercent: next.splitPercent, dcRequestId, decidedAt: w.now.toISOString() }, dcRequestId };
    });
    this.host.publish(['dc_suggestions', ...(r.result.dcRequestId ? ['deal_contribution_requests'] : [])], [id], `dc.suggestion.${body.decision}`);
    return { entity: r.result, auditId: r.undoable ? r.auditId : null };
  }

  async refresh(): Promise<{ queued: boolean; suggestions: number; note: string | null }> {
    const userId = await this.host.userId();
    const queued = await withChangeSet({ db: this.host.db, userId, actor: actors.user('attribution.refresh'), reason: 'Refresh DC suggestions', undoable: false }, async (tx) =>
      enqueueJob(tx, { ownerUserId: userId, kind: OPP_ENGAGEMENT_JOB, queue: ATTRIBUTION_QUEUE, payload: { trigger: 'change' }, dedupeKey: `${OPP_ENGAGEMENT_JOB}:${userId}:change`, maxAttempts: 2, timeoutSeconds: 600 }),
    );
    const n0 = (await loadDcSuggestionRows(this.host.db, userId)).filter((x) => x.state === 'new').length;
    this.host.publish(['jobs'], [String(queued.result.id)], 'attribution.refresh');
    return { queued: true, suggestions: n0, note: 'The worker re-reads your engagement and refreshes the suggestions in a moment' };
  }

  async rundown(q: { entryId?: string; accountId?: string }): Promise<OppRundown> {
    const m = await this.host.model();
    const extras = await this.ensureExtras(m);
    const ctx = this.ctx(m, extras);
    const today = localDay(this.host.now().getTime(), m.settings().profile.timezone || 'UTC');
    const totals = totalsByOpp(await loadEngagement(this.host.db, m.ctx.userId, weekStart(new Date(Date.parse(`${today}T12:00:00Z`) - 27 * 86_400_000).toISOString().slice(0, 10))), '0000-00-00');
    let a = null;
    if (q.entryId) {
      const e = m.get('activity', q.entryId);
      if (!e) throw notFound('Activity entry', q.entryId);
      a = rowAttribution(e, ctx).attribution;
    }
    const world = worldOfContract(ctx);
    const opps = oppRundown(a, { opps: world.opps, totals4w: totals, coveredAes: extras.coveredAes ?? [], asOf: today, ...(q.accountId ? { accountIds: [q.accountId] } : {}) });
    return { entryId: q.entryId ?? null, needsAsk: a ? a.needsAsk : true, opps: opps.map((o) => ({ ...o, accountName: o.accountId ? (m.get('accounts', o.accountId)?.name ?? null) : null })) };
  }

  /**
   * Settings ▸ Time ▸ AEs I cover: the app's own people first (an AE title, or an Account Executive on an opp team);
   * then, where Org62 is live, ONE read-only User read the worker runs (`org62.discover` mode lookup_ae: the one-call
   * read path, its spend booked and held like the other relay reads). Its hits are kept 7 days per name (kv
   * AE_LOOKUP_KV) and listed on the next ask.
   */
  async lookupAe(q: string): Promise<CoveredAeLookupResult> {
    const userId = await this.host.userId();
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const local = await this.host.db.execute<{ name: string; email: string | null; title: string | null; org62: string | null }>(sql`
      select distinct p.display_name as name, p.primary_email as email, p.title,
             coalesce((select pi.external_id from person_identities pi where pi.person_id = p.id and pi.system::text in ('org62_user', 'org62') order by pi.is_primary desc limit 1),
                      (select t.org62_user_id from opportunity_team_members t where t.person_id = p.id limit 1)) as org62
        from people p
       where p.owner_user_id = ${userId} and not p.is_me and p.merged_into_person_id is null and p.display_name ilike ${like}
         and (p.title ilike '%account exec%' or p.title ~* '(^|[^a-z])ae([^a-z]|$)'
              or exists (select 1 from opportunity_team_members t where t.person_id = p.id and t.team_role ilike '%account exec%'))
       order by p.display_name limit 10`);
    const hits: CoveredAeLookupResult['hits'] = local.rows.map((r) => ({ name: r.name, org62UserId: r.org62 && /^005/.test(r.org62) ? r.org62 : null, email: r.email, title: r.title, source: 'app' as const }));
    const key = q.trim().toLowerCase();
    const kv = await this.host.db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${AE_LOOKUP_KV}`);
    const cached = (kv.rows[0]?.value as Record<string, { at: string; hits: CoveredAeLookupResult['hits'] }> | undefined)?.[key];
    const fresh = !!cached && this.host.now().getTime() - Date.parse(cached.at) < AE_LOOKUP_TTL_MS;
    for (const h of fresh ? cached!.hits : []) if (!hits.some((x) => x.org62UserId && h.org62UserId && x.org62UserId.slice(0, 15) === h.org62UserId.slice(0, 15))) hits.push({ ...h, source: 'org62' });
    if (fresh) return { q, hits: hits.slice(0, 15), live: true, note: null };
    if (!this.host.org62Live) return { q, hits, live: false, note: hits.length ? null : 'No AE by that name in the app yet. Org62 is looked up where it is live (the launchd worker), or type their name and save' };
    await withChangeSet({ db: this.host.db, userId, actor: actors.user('attribution.ae_lookup'), reason: 'Look up an AE in Org62', undoable: false }, async (tx) =>
      enqueueJob(tx, { ownerUserId: userId, kind: ORG62_DISCOVER_JOB, queue: ATTRIBUTION_QUEUE, payload: { mode: 'lookup_ae', q: q.trim().slice(0, 80) }, dedupeKey: `${ORG62_DISCOVER_JOB}:${userId}:ae:${key}`, maxAttempts: 1, timeoutSeconds: 180 }),
    );
    return { q, hits, live: false, note: 'Asked Org62 (one read-only User read): its matches show here in a moment' };
  }
}

/** One rule as Settings lists it (its target's name from the read model). */
export function ruleView(r: LearnedRule, m: Pick<ReadModel, 'get'>): MappingRuleView {
  return ruleViewOf(r, { opp: (id) => m.get('opps', id), account: (id) => m.get('accounts', id) });
}

// ---------------------------------------------------------------------------
// Discovery: upsert what Org62 discovery found (provenance in the opp's ext: via, discoveredAt)
// ---------------------------------------------------------------------------

export async function upsertDiscovered(w: WriteCtx, found: readonly DiscoveredOpp[], via: (o: DiscoveredOpp) => 'discovered' | 'covered_ae', me: string | null): Promise<{ added: number; updated: number; ids: string[] }> {
  let added = 0;
  let updated = 0;
  const ids: string[] = [];
  for (const o of found) {
    const have = await w.tx.execute<{ id: string }>(sql`select id from opportunities where owner_user_id = ${w.userId} and left(org62_opportunity_id, 15) = ${o.org62Id.slice(0, 15)}`);
    let accountId: string | null = null;
    if (o.accountOrg62Id) {
      const a = await w.tx.execute<{ id: string }>(sql`select id from accounts where owner_user_id = ${w.userId} and left(org62_account_id, 15) = ${o.accountOrg62Id.slice(0, 15)}`);
      accountId = a.rows[0]?.id ?? null;
      if (!accountId) {
        // a discovered account is not in my book until I work on it (is_my_book false)
        accountId = randomUUID();
        await w.tx.execute(sql`insert into accounts (id, owner_user_id, org62_account_id, name, is_my_book) values (${accountId}, ${w.userId}, ${o.accountOrg62Id}, ${o.accountName ?? o.accountOrg62Id}, false)`);
        await mergeExt(w, 'accounts', accountId, { org62Url: org62RecordUrl('Account', o.accountOrg62Id), via: 'discovered', discoveredAt: w.now.toISOString() });
      }
    }
    const k15 = (x: string | null | undefined) => (x ?? '').slice(0, 15);
    const mine = !!me && o.team.some((t) => k15(t.userId) === k15(me));
    const up = await upsertOpportunityFromOrg62(
      w,
      { org62OpportunityId: o.org62Id, accountId, name: o.name, stage: o.stage, amount: o.amount, closeDate: o.closeDate, forecastCategory: null, type: null, isClosed: o.isClosed, isWon: o.isWon, onMyTeam: mine, myTeamRole: mine ? (o.team.find((t) => k15(t.userId) === k15(me))?.role ?? null) : null, org62ModifiedAt: null, ext: { dcAssigned: false, nextStep: null, org62Url: org62RecordUrl('Opportunity', o.org62Id)!, hoursQtd: 0 } },
      have.rows[0]?.id ?? randomUUID(),
    );
    ids.push(up.id);
    if (!have.rows.length) {
      added++;
      await mergeExt(w, 'opportunities', up.id, { via: via(o), discoveredAt: w.now.toISOString(), ownerName: o.ownerName, ownerOrg62Id: o.ownerOrg62Id });
    } else if (up.written) updated++;
    // the covered AEs' team rows (non-me rows the table already models) and the owner
    for (const t of o.team) {
      if (me && k15(t.userId) === k15(me)) continue;
      await w.tx.execute(sql`
        insert into opportunity_team_members (opportunity_id, org62_user_id, team_role, is_me) values (${up.id}::uuid, ${t.userId}, ${t.role ?? 'Account Executive'}, false)
        on conflict (opportunity_id, org62_user_id, team_role) do update set last_seen_at = now(), removed_at = null`);
    }
    if (o.ownerOrg62Id && !o.team.some((t) => k15(t.userId) === k15(o.ownerOrg62Id))) {
      await w.tx.execute(sql`
        insert into opportunity_team_members (opportunity_id, org62_user_id, team_role, is_me) values (${up.id}::uuid, ${o.ownerOrg62Id}, 'Opportunity Owner', ${!!me && k15(o.ownerOrg62Id) === k15(me)})
        on conflict (opportunity_id, org62_user_id, team_role) do update set last_seen_at = now(), removed_at = null`);
    }
  }
  return { added, updated, ids };
}

/** D-103 (a): each opp's team members besides me (live rows), so a covered AE matches as a team member. */
async function loadOppTeams(db: DbOrTx, userId: string): Promise<NonNullable<RowExtras['oppTeams']>> {
  const r = await db.execute<{ opportunity_id: string; org62_user_id: string; person_id: string | null; name: string | null; email: string | null }>(sql`
    select t.opportunity_id, t.org62_user_id, t.person_id, p.display_name as name, p.primary_email as email
      from opportunity_team_members t join opportunities o on o.id = t.opportunity_id
      left join people p on p.id = t.person_id
     where o.owner_user_id = ${userId} and not t.is_me and t.removed_at is null`);
  const out: NonNullable<RowExtras['oppTeams']> = {};
  for (const x of r.rows) (out[x.opportunity_id] ??= []).push({ name: x.name, personId: x.person_id, org62UserId: x.org62_user_id, email: x.email });
  return out;
}

/** D-103 (d): the last call on each account and the time zone, for the one dismissal rule (resurface.ts). */
export function dbCallsOf(m: Pick<ReadModel, 'all' | 'settings' | 'meta'>, nowIso: string): { calls: Map<string, string>; timezone: string } {
  return { calls: lastCallsByAccount(m.all('activity'), m.all('accounts'), m.all('opps'), nowIso), timezone: m.settings().profile.timezone || m.meta().timezone };
}
