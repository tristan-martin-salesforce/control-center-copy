// Projection run: version, options, counts and week types, source loading and the matcher (no db writers). Split from run.ts (max-lines); run.ts re-exports the public names.
import { sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import {
  type HeldChange, type RederiveRow, type RowChange, type UpdateCandidate, DELETED_IN_ORG62, type ActivityConfig,
  type OnsiteOverrides,
} from '@/engines/activity';
import type { loadBlockWindow, ActivityProjection, ActivityRow, Mapping } from '@/server/datasource/db/store/projections';
import type { loadVocab } from '@/server/datasource/db/store/time';
import { ENGINE_STATUSES, OWNED_ACTIVITY_PREFIXES, type WeekInput, type WeekPlan } from './activity';
import { Matcher, withOrg62Parents, type MatchAccount, type MatchOpp } from './matching';
import type { ProjectionStore } from './run.store';
import type { BookRead, DomainRules, Me, SourceRow } from './types';
import { DEFAULT_IGNORE_DOMAINS, domainOf } from './util';
import { ACCOUNT_HIERARCHY_KV, hierarchyOf } from '@/lib/accounts/hierarchy';

/**
 * 2: onsite lane (calendar location column, all-day events at local midnight): one full re-projection.
 * 3: D-18 amended (every accepted meeting logs; onsite days log in full): one full re-projection, so rows excluded only
 *    for an overlap come back as proposals (the user's own dismissals are theirs and stay).
 * 4: my DCs mirrored into deal_contributions (split, role): one full re-projection, so the DCs already in stored Org62
 *    snapshots land without waiting for each one to change in Org62 (an incremental read only sees changed DCs).
 * 5: Deals pipeline (forecast category, won, next step seen on opps): one full re-projection, so opps already in
 *    stored snapshots get them without waiting to change in Org62.
 * 6: (a) `oppFor` ignores generic words ("call", "team", "renewal", "FY27") and weak hits on opps I'm not on, and a
 *    meeting on an opp I'm not on waits for my Approve: one full re-projection, so unlocked, not-yet-logged rows
 *    re-resolve (rows I approved, synced, logged or verified keep their opp: they are mine, or Org62's); (b) my DCs
 *    re-link to their opp row by Org62 id, so `myDc` (split, role) is filled on every opp I hold a DC on.
 * 7: D-64 (SE persona): work for no customer is internal-only activity (repo and Drive work no account or opp matched,
 *    meetings with no customer, account or opp that name internal work): what_kind none, no WhatId, CF / CR off, an
 *    internal task type (Asset Creation, Personal Development, Sales Enablement, Travel), `proposed`; a meeting I
 *    declined has no row, also one I organize; "Dismiss all from …" rules. One full re-projection, so the rows waiting
 *    under "No opportunity" re-classify; rows I approved, edited, dismissed, logged or verified are mine and stay.
 * 8: D-66: every row carries its Org62 Description note (`logNote` in its side-car: the template over its evidence,
 *    the cheap model's over the meeting notes where `activity.notes` made one). One full re-projection, so the rows
 *    of the last weeks get one; a row waiting to be logged whose note you have not edited takes the newer note too.
 * 9: D-68: sibling-aware account matching (a child account matched by its full name; a shared " - " head maps to no
 *    child unless an attendee domain or an opp word points at exactly one) and Slack as missed-opp evidence. One full
 *    re-projection, so calendar and activity rows re-map; rows I approved, edited, dismissed, logged or verified stay.
 * 10: D-65: the Time ↔ Org62 round trip. A row pairs with its Event by the link, then its CC# key, then the slot rule;
 *     a real Org62 record is never hidden (duplicates and overlapping manual Events log, flagged); a legacy record type
 *     stops counting. One full re-projection, so the live hidden duplicates and excluded overlaps come back as logged
 *     rows; your approvals, edits, dismissals and dismiss rules stay yours.
 */
export const PROJECTIONS_VERSION = 10;
export const STATE_KEY = 'cc.projections';
export const SLACK_MS = 10 * 60_000;
export const WEEK_REFRESH_MS = 15 * 60_000;
export const REMATCH_BACK_DAYS = 45;
export const REMATCH_AHEAD_DAYS = 30;
export const SOURCES = ['calendar', 'org62', 'claude', 'drive', 'gemini_notes', 'slack'];
/** Company domains per team pack when the pack does not list its own (`team_packs.raw.internalDomains`). */
const PACK_INTERNAL_DOMAINS: Record<string, string[]> = {
  'salesforce-se': ['salesforce.com', 'slack.com', 'slack-corp.com', 'tableau.com', 'mulesoft.com', 'salesforce.org', 'heroku.com', 'quip.com', 'exacttarget.com', 'demandware.com', 'clicksoftware.com'],
};
export interface State {
  version: number;
  watermark: string | null;
  weekRefreshedAt: string | null;
  /** Weeks whose pass failed: retried on the next ticks, without holding the watermark back. */
  pendingWeeks?: string[];
}
export interface ProjectionCounts {
  calendar_events: number;
  cancelled_events: number;
  accounts: number;
  opportunities: number;
  org62_events: number;
  claude_sessions: number;
  assets: number;
  meeting_notes: number;
  activity_entries: number;
  time_blocks: number;
  missed_findings: number;
  /** My DCs mirrored into deal_contributions, and the DC requests they confirmed. */
  deal_contributions: number;
  /** Work items given the account their title names (ACC-1). */
  work_item_accounts: number;
}
export interface ProjectionResult {
  skipped: boolean;
  changedItems: number;
  weeks: string[];
  written: ProjectionCounts;
  /** Org62 Events the skill recorded without a start time (counted, not projected). */
  org62EventsWithoutStart: number;
  /** The latest complete book read (counts only), when Stage A re-read Org62. */
  book?: (BookRead & { openTeamOpps: number; left: number }) | null;
  /** Missed-opp findings the deals engine produced this pass (written or unchanged). */
  missedFindings?: number;
  errors: string[];
}
export interface ProjectionOptions {
  /** The store (`projectionStore(db)`, src/server/datasource/db/store/projections.run.ts). */
  store: ProjectionStore;
  userId: string;
  now?: Date;
  /** Recompute everything (ignores the watermark). */
  full?: boolean;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
}
export const zero = (): ProjectionCounts => ({ calendar_events: 0, cancelled_events: 0, accounts: 0, opportunities: 0, org62_events: 0, claude_sessions: 0, assets: 0, meeting_notes: 0, activity_entries: 0, time_blocks: 0, missed_findings: 0, deal_contributions: 0, work_item_accounts: 0 });
export class NothingToWrite extends Error {}
/** A loggable error code: the Postgres / DbError code or the error class, never a message (it may quote data). */
export const errCode = (e: unknown): string => {
  const x = e as { code?: unknown; constraint?: unknown; name?: string; cause?: { code?: unknown; constraint?: unknown } };
  const code = typeof x.code === 'string' ? x.code : typeof x.cause?.code === 'string' ? x.cause.code : (x.name ?? 'Error');
  const constraint = typeof x.constraint === 'string' ? x.constraint : typeof x.cause?.constraint === 'string' ? x.cause.constraint : null;
  return [code, constraint].filter(Boolean).join(':');
};
// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type Raw = {
  id: string;
  source: string;
  kind: string;
  external_id: string;
  external_parent_id: string | null;
  external_container_id: string | null;
  dedupe_key: string;
  occurred_at: Date | string;
  title: string | null;
  url: string | null;
  body: string | null;
  meta: Record<string, unknown> | null;
  from_me: boolean;
  deleted_upstream_at: Date | string | null;
  changed_at: Date | string;
};
export const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const toRow = (r: Raw): SourceRow => ({
  id: r.id,
  source: r.source,
  kind: r.kind,
  externalId: r.external_id,
  externalParentId: r.external_parent_id,
  externalContainerId: r.external_container_id,
  dedupeKey: r.dedupe_key,
  occurredAt: iso(r.occurred_at),
  title: r.title,
  url: r.url,
  body: r.body,
  meta: r.meta ?? {},
  fromMe: r.from_me,
  deletedUpstreamAt: r.deleted_upstream_at ? iso(r.deleted_upstream_at) : null,
  changedAt: iso(r.changed_at),
});
export const CHANGED_AT = sql`greatest(si.created_at, coalesce(si.content_changed_at, si.created_at), si.updated_at, coalesce(si.deleted_upstream_at, si.created_at))`;
/** Bodies are read only where a mapper needs them (Org62 excerpt fields, the Claude recap), and never logged. */
const BODY = sql`case when si.source in ('org62', 'claude') then left(si.body, 2000) end`;
export async function loadSources(db: Db | Tx, userId: string, where: ReturnType<typeof sql>): Promise<SourceRow[]> {
  const r = await db.execute<Raw>(sql`
    select si.id, si.source, si.kind, si.external_id, si.external_parent_id, si.external_container_id, si.dedupe_key, si.occurred_at,
           si.title, si.url, ${BODY} as body, si.meta, si.from_me, si.deleted_upstream_at, ${CHANGED_AT} as changed_at
      from source_items si
     where si.owner_user_id = ${userId} and ${where}
     order by changed_at, si.id`);
  return r.rows.map(toRow);
}
export function domainRules(me: Me, packSlug: string | null, raw: Record<string, unknown>): DomainRules {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : null);
  const mine = domainOf(me.email);
  const internal = list(raw.internalDomains) ?? (packSlug ? (PACK_INTERNAL_DOMAINS[packSlug] ?? []) : []);
  return {
    internal: [...new Set([...(mine ? [mine] : []), ...internal])],
    partner: list(raw.partnerDomains) ?? [],
    ignore: [...new Set([...DEFAULT_IGNORE_DOMAINS, ...(list(raw.ignoreDomains) ?? [])])],
  };
}
export async function loadMatcher(tx: Tx | Db, userId: string, rules: DomainRules): Promise<Matcher> {
  const a = await tx.execute<{ id: string; name: string; org62: string | null; aliases: { kind: string; value: string }[] | null }>(sql`
    select a.id, a.name, a.org62_account_id as org62,
           coalesce(json_agg(json_build_object('kind', al.kind, 'value', al.value)) filter (where al.id is not null), '[]') as aliases
      from accounts a left join account_aliases al on al.account_id = a.id
     where a.owner_user_id = ${userId} and a.archived_at is null
     group by a.id, a.name, a.org62_account_id`);
  const o = await tx.execute<{ id: string; account_id: string | null; org62: string; name: string; is_closed: boolean; on_my_team: boolean; dc: boolean }>(sql`
    select o.id, o.account_id, o.org62_opportunity_id as org62, o.name, o.is_closed, o.on_my_team,
           (coalesce((select (s.value->>'dcAssigned')::boolean from user_settings s where s.owner_user_id = ${userId} and s.key = 'cc.ext/opportunities/' || o.id), false)
             or exists (select 1 from deal_contributions dc where dc.owner_user_id = ${userId} and dc.opportunity_id = o.id and dc.is_mine and dc.deleted_upstream_at is null)) as dc
      from opportunities o
     where o.owner_user_id = ${userId} and o.archived_at is null`);
  // D-69 (DC-23): the Org62 parents, from the account hierarchy once it is read (siblings by parent, not by name)
  const hv = await tx.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${ACCOUNT_HIERARCHY_KV}`);
  const accounts: MatchAccount[] = withOrg62Parents(
    a.rows.map((r) => ({ id: r.id, name: r.name, org62AccountId: r.org62, aliases: r.aliases ?? [] })),
    hv.rows[0]?.value ? hierarchyOf(hv.rows[0].value) : null,
  );
  const opps: MatchOpp[] = o.rows.map((r) => ({ id: r.id, accountId: r.account_id, org62OpportunityId: r.org62, name: r.name, isClosed: r.is_closed, onMyTeam: r.on_my_team, myDc: r.dc }));
  const m = new Matcher(accounts, opps, rules);
  // domains of meetings whose title already names an account (the last 60 days of projected events)
  const ev = await tx.execute<{ title: string | null; external_domains: string[] | null }>(sql`
    select title, external_domains from calendar_events
     where owner_user_id = ${userId} and starts_at > now() - interval '60 days' and cardinality(coalesce(external_domains, '{}')) > 0`);
  m.learnDomains(ev.rows.map((r) => ({ title: r.title ?? '', domains: r.external_domains ?? [] })));
  return m;
}
/** Per user: the database time the last work-item account pass started (ACC-1). */
export const lastWorkItemPass = new Map<string, Date>();
export const mappingOf = (m: { accountId: string; oppId: string | null; confidence: number } | null): Mapping =>
  m ? { accountId: m.accountId, opportunityId: m.oppId, mappingMethod: 'rule', mappingConfidence: m.confidence } : { accountId: null, opportunityId: null, mappingMethod: null, mappingConfidence: null };
// ---------------------------------------------------------------------------
// Stage B: one week
// ---------------------------------------------------------------------------

export interface WeekCtx {
  me: Me;
  rules: DomainRules;
  cfg: ActivityConfig;
  vocab: Awaited<ReturnType<typeof loadVocab>>;
}
/** The verify issue of an app row whose Org62 Event was deleted there (org62.readback; Time shows it on the row). */
export const DELETED_IN_ORG62_ISSUE = DELETED_IN_ORG62;
/** A text[] / uuid[] literal of these values (never empty: callers check). */
export const textArr = (vals: readonly string[]) => sql`array[${sql.join(vals.map((v) => sql`${v}::text`), sql`, `)}]`;
export const uuidArr = (vals: readonly string[]) => sql`array[${sql.join(vals.map((v) => sql`${v}::uuid`), sql`, `)}]`;
export const ownedRow = (r: ActivityRow) => OWNED_ACTIVITY_PREFIXES.some((p) => r.dedupeKey.startsWith(p)) && ENGINE_STATUSES.has(r.status) && !(r.userLockedFields ?? []).length;
/** Options of a week's load: the re-derive's read-only stand-ins (rederive.ts). */
export interface LoadWeekOptions {
  /**
   * A session's human turns when its source item has none yet (a transcript the scanner has not re-read since the
   * prompts were stored, 2026-11-14): the dry run reads them from the local transcript, read-only.
   */
  turnsOf?: (sessionExternalId: string) => { at: string; runEndsAt: string }[] | null;
}
/** One week, loaded and planned (no writes): what `projectWeek` applies and the re-derive compares. */
export interface LoadedWeek {
  weekStart: string;
  from: Date;
  end: Date;
  input: WeekInput;
  plan: WeekPlan;
  want: ActivityProjection[];
  moves: (WeekPlan['moves'][number] & { adopt?: WeekPlan['moves'][number]['adopt'] & { opportunityId?: string | null; accountId?: string | null; whatName?: string | null } })[];
  /** The week's rows, and my rows of its meetings that sit in another week (TL-32). */
  mine: ActivityRow[];
  sameMeeting: ActivityRow[];
  held: Set<string>;
  blocksExisting: Awaited<ReturnType<typeof loadBlockWindow>>;
  overrides: OnsiteOverrides;
  matcher: Matcher;
  /** Org62 Events by their row id: the Salesforce id of the Event a row is tied to. */
  org62Ids: Map<string, string>;
}
/** One day of a re-derive: hours before (as Time holds them) and after (the re-derive applied, update candidates landed). */
export interface RederiveDay {
  day: string;
  before: number;
  /** After `--apply`: the user's rows as they are, every other row as the engine wants it. */
  after: number;
  /** `after` plus the update candidates' and held changes' differences (the model's view, once they land). */
  afterModel: number;
  /** Of `afterModel`: meetings (calendar rows), solo work (evidence rows), travel, onsite, Org62's own rows. */
  split: { meetings: number; solo: number; travel: number; onsite: number; org62: number; internal: number };
}
export interface RederiveReport {
  from: string;
  to: string;
  days: RederiveDay[];
  totals: { before: number; after: number; afterModel: number };
  added: (RederiveRow & { week: string })[];
  changed: (RowChange & { week: string })[];
  removed: (RederiveRow & { week: string })[];
  candidates: UpdateCandidate[];
  held: HeldChange[];
  errors: string[];
}
export const r2 = (n: number) => Math.round(n * 100) / 100;
