/**
 * Live Org62 discovery (R3/R7): fixed SELECTs that find the deals the local mirror doesn't have yet, so a new deal is
 * an attribution candidate the same day (lane 06 TA-4: "a brand-new deal is invisible to the suggester").
 *
 *   team      OpportunityTeamMember of me and the AEs I cover (toggled on), open opps only;
 *   accounts  open Opportunities on the accounts I engaged lately (opp_engagement, mapped rows), or owned by an AE I
 *             cover (the AE is usually the owner).
 *   users     the covered-AE lookup (Settings ▸ Time ▸ AEs I cover): active Users by name.
 *
 * Every query is a SELECT (assertReadOnlySoql), runs through the existing one-call read path (runOneReadLookup:
 * `soqlQuery` on the scan allowlist, never widened, tenet: Read-only ingest). The opp queries take ≤ 200 ids per IN
 * list; the team query packs ids up to Salesforce's length limits (teamChunks) and pages by Id (readTeam).
 * Pure: builders and parsers; the job (src/jobs/handlers/org62-discover.ts) runs them.
 */
import { org62Key, sameOrg62Id } from '@/connectors/org62/ids';
import { assertReadOnlySoql, chunk } from '@/engines/deals/soql';

const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const q = (ids: readonly string[]) => [...new Set(ids.filter((x) => ID.test(x)))].map((x) => `'${x}'`).join(', ');
export const DISCOVER_BATCH = 200;
export const DISCOVER_LIMIT = 200;

const OPP_FIELDS = 'Id, Name, AccountId, Account.Name, StageName, CloseDate, Amount, IsClosed, IsWon, OwnerId, Owner.Name, Owner.Email';

/**
 * Salesforce bounds an `IN` list by the statement's length, not by a count:
 *   - a SOQL statement is at most 100,000 characters (SOQL and SOSL Reference, "SOQL and SOSL Limits"); and
 *   - a REST request URI is at most 16,384 bytes (REST API Developer Guide, "Status Codes and Error Responses", 414),
 *     which binds first if the connector sends the query as `GET /query?q=<url-encoded statement>`.
 * The team query keeps both with margin: ≤ TEAM_SOQL_MAX_CHARS characters and ≤ TEAM_SOQL_MAX_URI_BYTES url-encoded
 * bytes (1,384 left for the host and `/services/data/vNN.N/query?q=`). About 550 ids fit in one statement, so a small
 * team is still one statement; a longer list is several, read in sequence and merged (readTeam).
 */
export const SOQL_MAX_CHARS = 100_000;
export const REST_URI_MAX_BYTES = 16_384;
export const TEAM_SOQL_MAX_CHARS = 90_000;
export const TEAM_SOQL_MAX_URI_BYTES = 15_000;

const TEAM_SELECT =
  'SELECT Id, OpportunityId, UserId, TeamMemberRole, Opportunity.Name, Opportunity.AccountId, Opportunity.Account.Name, Opportunity.StageName, Opportunity.CloseDate, Opportunity.Amount, Opportunity.IsClosed, Opportunity.IsWon, Opportunity.OwnerId, Opportunity.Owner.Name FROM OpportunityTeamMember WHERE UserId IN (';
const teamTail = (after: string | undefined, limit: number) => `) AND Opportunity.IsClosed = false${after ? ` AND Id > '${after}'` : ''} ORDER BY Id LIMIT ${limit}`;

export interface TeamSoqlBudget {
  maxChars?: number;
  maxUriBytes?: number;
  /** Rows per page (DISCOVER_LIMIT; under Salesforce's 2,000 rows per call, so one page is one call). */
  limit?: number;
}

/** Valid ids, one per user (the 15- and 18-character forms of an id are one), first seen first. */
function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((x) => ID.test(x) && !seen.has(org62Key(x)) && !!seen.add(org62Key(x)));
}

/** Ids packed so every team statement, with the longest paging clause, stays inside both limits. */
export function teamChunks(userIds: readonly string[], b: TeamSoqlBudget = {}): string[][] {
  const maxChars = b.maxChars ?? TEAM_SOQL_MAX_CHARS;
  const maxBytes = b.maxUriBytes ?? TEAM_SOQL_MAX_URI_BYTES;
  const fixed = TEAM_SELECT + teamTail('x'.repeat(18), b.limit ?? DISCOVER_LIMIT);
  const enc = (t: string) => encodeURIComponent(t).length;
  const out: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  let bytes = 0;
  for (const id of uniqueIds(userIds)) {
    const piece = `, '${id}'`;
    if (cur.length && (chars + piece.length > maxChars || bytes + enc(piece) > maxBytes)) {
      out.push(cur);
      cur = [];
    }
    if (!cur.length) {
      chars = fixed.length - 2;
      bytes = enc(fixed) - enc(', ');
    }
    cur.push(id);
    chars += piece.length;
    bytes += enc(piece);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** One page of the team read for one chunk: open opps whose team has one of these users, after `after` by Id. */
export function teamPageSoql(chunkIds: readonly string[], after?: string, limit = DISCOVER_LIMIT): string {
  const list = q(chunkIds);
  if (!list) throw new Error('teamSoql: no user ids');
  if (after !== undefined && !ID.test(after)) throw new Error('teamSoql: bad paging id');
  return assertReadOnlySoql(`${TEAM_SELECT}${list}${teamTail(after, limit)}`);
}

/** The first page of every chunk: one statement for a small team, more once the ids pass the length limits. */
export function teamSoqls(userIds: readonly string[], b: TeamSoqlBudget = {}): string[] {
  const chunks = teamChunks(userIds, b);
  if (!chunks.length) throw new Error('teamSoql: no user ids');
  return chunks.map((c) => teamPageSoql(c, undefined, b.limit));
}

/** Open opps whose team has one of these users (me, my covered AEs): the single statement, when the ids fit in one. */
export function teamSoql(userIds: readonly string[]): string {
  const qs = teamSoqls(userIds);
  if (qs.length > 1) throw new Error(`teamSoql: ${uniqueIds(userIds).length} ids need ${qs.length} statements; use readTeam`);
  return qs[0]!;
}

/** One read through the existing one-call path: the answer, null when it did not finish, 'cap' when the budget refused it. */
export type DiscoverRead = (soql: string) => Promise<string | null | 'cap'>;

export interface TeamReadResult {
  statements: number;
  reads: number;
  partial: 'cap' | 'lookup_failed' | null;
}

/**
 * The team read for any number of ids: each chunk in sequence through `read`, every page merged into `into` (deduped
 * by opportunity id, team rows by user id: parseDiscovered). A chunk pages by Id while a page comes back full or
 * Salesforce says it is not done (`done: false`: a `nextRecordsUrl` the one-call path does not follow). It stops at the
 * first read the budget refuses or that does not finish, and says which; what it read stays merged.
 */
export async function readTeam(userIds: readonly string[], read: DiscoverRead, into: Map<string, DiscoveredOpp> = new Map(), b: TeamSoqlBudget = {}): Promise<TeamReadResult> {
  const limit = b.limit ?? DISCOVER_LIMIT;
  const chunks = teamChunks(userIds, b);
  let reads = 0;
  for (const ids of chunks) {
    let after: string | undefined;
    for (;;) {
      const text = await read(teamPageSoql(ids, after, limit));
      if (text === 'cap' || text === null) return { statements: chunks.length, reads, partial: text === 'cap' ? 'cap' : 'lookup_failed' };
      reads += 1;
      const { rows, done } = page(text);
      parseDiscovered(text, into);
      const last = str(rows.at(-1)?.Id);
      if ((rows.length < limit && done) || !last || !ID.test(last) || last === after) break;
      after = last;
    }
  }
  return { statements: chunks.length, reads, partial: null };
}

/** Open opps on these accounts, or owned by these users (one query per ≤ 200 ids of each). */
export function oppsSoql(a: { accountIds: readonly string[]; ownerIds: readonly string[] }): string[] {
  const out: string[] = [];
  for (const ids of chunk([...new Set(a.accountIds.filter((x) => ID.test(x)))], DISCOVER_BATCH)) out.push(assertReadOnlySoql(`SELECT ${OPP_FIELDS} FROM Opportunity WHERE IsClosed = false AND AccountId IN (${q(ids)}) ORDER BY CloseDate DESC NULLS LAST LIMIT ${DISCOVER_LIMIT}`));
  for (const ids of chunk([...new Set(a.ownerIds.filter((x) => ID.test(x)))], DISCOVER_BATCH)) out.push(assertReadOnlySoql(`SELECT ${OPP_FIELDS} FROM Opportunity WHERE IsClosed = false AND OwnerId IN (${q(ids)}) ORDER BY CloseDate DESC NULLS LAST LIMIT ${DISCOVER_LIMIT}`));
  return out;
}

/** Settings ▸ Time ▸ AEs I cover: active users by name (one word or more; quotes and wildcards escaped). */
export function userLookupSoql(name: string): string {
  const t = name.trim().replace(/\s+/g, ' ');
  if (t.length < 2) throw new Error('give at least 2 letters of a name');
  const esc = t.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[%_]/g, (c) => `\\${c}`);
  return assertReadOnlySoql(`SELECT Id, Name, Email, Title FROM User WHERE IsActive = true AND Name LIKE '%${esc}%' ORDER BY Name LIMIT 10`);
}

export interface DiscoveredOpp {
  org62Id: string;
  name: string;
  accountOrg62Id: string | null;
  accountName: string | null;
  stage: string | null;
  closeDate: string | null;
  amount: number | null;
  isClosed: boolean;
  isWon: boolean;
  ownerOrg62Id: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  /** Team rows the read saw (me or a covered AE), by user id. */
  team: Array<{ userId: string; role: string | null }>;
}

export interface Org62UserHit {
  org62UserId: string;
  name: string;
  email: string | null;
  title: string | null;
}

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sub = (r: Rec, k: string): Rec => (r[k] && typeof r[k] === 'object' ? (r[k] as Rec) : {});

export class DiscoverParseError extends Error {}

function page(raw: string): { rows: Rec[]; done: boolean } {
  try {
    const t = raw.trim();
    const body = JSON.parse(t.slice(t.indexOf('{'))) as { records?: Rec[]; done?: unknown };
    return { rows: Array.isArray(body.records) ? body.records : [], done: body.done !== false };
  } catch {
    throw new DiscoverParseError('Org62 answered in a way the app could not read');
  }
}
const records = (raw: string): Rec[] => page(raw).rows;

/** A soqlQuery answer (Opportunity or OpportunityTeamMember rows) → opps, merged by id. */
export function parseDiscovered(raw: string, into: Map<string, DiscoveredOpp> = new Map()): Map<string, DiscoveredOpp> {
  for (const r of records(raw)) {
    const team = typeof r.OpportunityId === 'string';
    const o = team ? sub(r, 'Opportunity') : r;
    const id = str(team ? r.OpportunityId : r.Id);
    if (!id || !ID.test(id)) continue;
    const have = into.get(org62Key(id));
    const owner = sub(o, 'Owner');
    const next: DiscoveredOpp = {
      org62Id: have?.org62Id ?? id,
      name: str(o.Name) ?? have?.name ?? id,
      accountOrg62Id: str(o.AccountId) ?? have?.accountOrg62Id ?? null,
      accountName: str(sub(o, 'Account').Name) ?? have?.accountName ?? null,
      stage: str(o.StageName) ?? have?.stage ?? null,
      closeDate: str(o.CloseDate) ?? have?.closeDate ?? null,
      amount: num(o.Amount) ?? have?.amount ?? null,
      isClosed: o.IsClosed === true,
      isWon: o.IsWon === true,
      ownerOrg62Id: str(o.OwnerId) ?? have?.ownerOrg62Id ?? null,
      ownerName: str(owner.Name) ?? have?.ownerName ?? null,
      ownerEmail: str(owner.Email) ?? have?.ownerEmail ?? null,
      team: [...(have?.team ?? [])],
    };
    const uid = str(r.UserId);
    if (team && uid && !next.team.some((x) => sameOrg62Id(x.userId, uid))) next.team.push({ userId: uid, role: str(r.TeamMemberRole) });
    into.set(org62Key(id), next);
  }
  return into;
}

export function parseUsers(raw: string): Org62UserHit[] {
  return records(raw)
    .filter((r) => typeof r.Id === 'string' && ID.test(r.Id as string) && (r.Id as string).startsWith('005'))
    .map((r) => ({ org62UserId: r.Id as string, name: str(r.Name) ?? (r.Id as string), email: str(r.Email), title: str(r.Title) }));
}

/** How the app knows a discovered opp: me on its team or an account I engaged (`discovered`), or a covered AE's (`covered_ae`). */
export function viaOf(o: DiscoveredOpp, me: string | null, covered: ReadonlySet<string>): 'discovered' | 'covered_ae' {
  if (me && o.team.some((t) => sameOrg62Id(t.userId, me))) return 'discovered';
  if ((o.ownerOrg62Id && covered.has(org62Key(o.ownerOrg62Id))) || o.team.some((t) => covered.has(org62Key(t.userId)))) return 'covered_ae';
  return 'discovered';
}

// ---------------------------------------------------------------------------
// D-103 (b): my covered AEs' open Data & AI Specialist Forecasts (one fixed SELECT inside org62.discover)
// ---------------------------------------------------------------------------

/**
 * ForecastType__c values that are Data & AI (the product lines a DC counts on). The same four the VDP specialist read
 * uses (src/server/vdp/specialist-aes.ts VDP_AE_FORECAST_TYPES, field shape checked read-only 2026-11-12).
 */
export const DATA_AI_FORECAST_TYPES = ['Data Cloud', 'BtL Data Cloud', 'Agentforce', 'BtL Agentforce'] as const;

const SFR_DISCOVER_FIELDS =
  'Id, Opportunity__c, ForecastType__c, OwnerId, Owner.Name, Opportunity__r.Name, Opportunity__r.AccountId, Opportunity__r.Account.Name, Opportunity__r.StageName, Opportunity__r.CloseDate, Opportunity__r.Amount, Opportunity__r.IsClosed, Opportunity__r.OwnerId, Opportunity__r.Owner.Name';

/**
 * The open Data & AI Specialist Forecasts owned by these users (my covered AEs): one statement per ≤ 200 ids (a user
 * with 6 covered AEs: one read). Fixed shape: only the ids are bound (validated, quoted), no free text.
 */
export function sfrDiscoverSoql(ownerIds: readonly string[]): string[] {
  const types = DATA_AI_FORECAST_TYPES.map((t) => `'${t}'`).join(', ');
  return chunk(uniqueIds(ownerIds), DISCOVER_BATCH).map((ids) =>
    assertReadOnlySoql(`SELECT ${SFR_DISCOVER_FIELDS} FROM SpecialistForecast__c WHERE OwnerId IN (${q(ids)}) AND ForecastType__c IN (${types}) AND Opportunity__r.IsClosed = false ORDER BY Id LIMIT ${DISCOVER_LIMIT}`),
  );
}

/** One Specialist Forecast as the discovery read returns it. */
export interface DiscoveredSfr {
  recordId: string;
  oppOrg62Id: string;
  accountOrg62Id: string | null;
  ownerOrg62Id: string;
  ownerName: string | null;
  productLine: string | null;
  stage: string | null;
  amount: number | null;
}

/** A soqlQuery answer of SpecialistForecast__c rows → records; their opps merged into `into` (DiscoveredOpp shape). */
export function parseSpecialistForecasts(raw: string, into: Map<string, DiscoveredOpp> = new Map()): DiscoveredSfr[] {
  const out: DiscoveredSfr[] = [];
  for (const r of records(raw)) {
    const id = str(r.Id);
    const opp = str(r.Opportunity__c);
    const owner = str(r.OwnerId);
    if (!id || !opp || !owner || !ID.test(opp) || !ID.test(owner)) continue;
    const o = sub(r, 'Opportunity__r');
    out.push({ recordId: id, oppOrg62Id: opp, accountOrg62Id: str(o.AccountId), ownerOrg62Id: owner, ownerName: str(sub(r, 'Owner').Name), productLine: str(r.ForecastType__c), stage: str(o.StageName), amount: num(o.Amount) });
    const have = into.get(org62Key(opp));
    into.set(org62Key(opp), {
      org62Id: have?.org62Id ?? opp,
      name: have?.name ?? str(o.Name) ?? opp,
      accountOrg62Id: have?.accountOrg62Id ?? str(o.AccountId),
      accountName: have?.accountName ?? str(sub(o, 'Account').Name),
      stage: have?.stage ?? str(o.StageName),
      closeDate: have?.closeDate ?? str(o.CloseDate),
      amount: have?.amount ?? num(o.Amount),
      isClosed: have?.isClosed ?? o.IsClosed === true,
      isWon: have?.isWon ?? false,
      ownerOrg62Id: have?.ownerOrg62Id ?? str(o.OwnerId),
      ownerName: have?.ownerName ?? str(sub(o, 'Owner').Name),
      ownerEmail: have?.ownerEmail ?? null,
      team: [...(have?.team ?? [])],
    });
  }
  return out;
}

export type SfrSkipReason = 'closed' | 'below_threshold' | 'not_dc_product';

/**
 * J-6, eligibility first: an opp a Specialist Forecast names is a DC candidate only when it is open, above the DC
 * threshold and sells a DC product (its forecasts' product lines or its name; empty `dcProducts` = every product).
 */
export function sfrEligibility(o: { amount: number | null; isClosed: boolean; name: string }, productLines: readonly (string | null)[], rule: { minAmount: number; dcProducts: readonly string[] }): SfrSkipReason | null {
  if (o.isClosed) return 'closed';
  if (o.amount === null || !(o.amount > rule.minAmount)) return 'below_threshold';
  if (rule.dcProducts.length) {
    const hay = [o.name, ...productLines.filter((x): x is string => !!x)].join(' ').toLowerCase();
    if (!rule.dcProducts.some((p) => !!p.trim() && hay.includes(p.trim().toLowerCase()))) return 'not_dc_product';
  }
  return null;
}

/** What the app stores on an opp a covered AE's Specialist Forecast names (the opp's ext, key `specialistForecasts`). */
export interface OppSfrExt {
  ownerIds: string[];
  ownerNames: string[];
  productLines: string[];
  recordIds: string[];
  seenAt: string;
}

/** Per opp (org62Key of its id): the Specialist Forecasts' owners, product lines and record ids (deduped by owner). */
export function sfrByOpp(rows: readonly DiscoveredSfr[], seenAt: string): Map<string, OppSfrExt> {
  const out = new Map<string, OppSfrExt>();
  for (const r of rows) {
    const k = org62Key(r.oppOrg62Id);
    const cur = out.get(k) ?? { ownerIds: [], ownerNames: [], productLines: [], recordIds: [], seenAt };
    if (!cur.ownerIds.some((x) => sameOrg62Id(x, r.ownerOrg62Id))) {
      cur.ownerIds.push(r.ownerOrg62Id);
      cur.ownerNames.push(r.ownerName ?? r.ownerOrg62Id);
    }
    if (r.productLine && !cur.productLines.includes(r.productLine)) cur.productLines.push(r.productLine);
    cur.recordIds.push(r.recordId);
    out.set(k, cur);
  }
  return out;
}

export interface DcContext {
  dcs: Array<{ ownerName: string; role: string | null; product: string | null; split: number | null }>;
  specialists: Array<{ name: string; isMe: boolean }>;
  via: 'sfr' | 'team' | null;
  viaAe: string | null;
}

/**
 * D-103 (b), J-1: a suggestion's context, per opp. `dcs`: the other DCs on the opp (never mine); `specialists`: the
 * specialists on its team plus its Specialist Forecasts' owners, deduped by name, me flagged; `via` 'sfr' (with the AE)
 * when a covered AE's Specialist Forecast names it, else 'team' when a covered AE is on its team.
 */
export function dcContextOf(i: {
  dcs: ReadonlyArray<{ ownerName: string | null; role: string | null; split: number | null; isMine: boolean }>;
  team: ReadonlyArray<{ name: string | null; role: string | null; isMe: boolean }>;
  sfr: Pick<OppSfrExt, 'ownerNames'> | null;
  coveredOnTeam: string | null;
}): DcContext {
  const dcs = i.dcs.filter((d) => !d.isMine && d.ownerName).map((d) => ({ ownerName: d.ownerName!, role: d.role, product: dataAiProductOf(d.role), split: d.split }));
  const specialists: Array<{ name: string; isMe: boolean }> = [];
  const add = (name: string | null, isMe: boolean) => {
    if (!name) return;
    const have = specialists.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (have) have.isMe ||= isMe;
    else specialists.push({ name, isMe });
  };
  for (const t of i.team) if (t.role && /specialist/i.test(t.role)) add(t.name, t.isMe);
  for (const n of i.sfr?.ownerNames ?? []) add(n, false);
  const sfrAe = i.sfr?.ownerNames[0] ?? null;
  return { dcs, specialists, via: sfrAe ? 'sfr' : i.coveredOnTeam ? 'team' : null, viaAe: sfrAe ?? i.coveredOnTeam };
}

function dataAiProductOf(role: string | null): string | null {
  if (!role) return null;
  if (/agentforce/i.test(role)) return 'Agentforce';
  if (/data (cloud|360)|ai \+ data|data \+ ai/i.test(role)) return 'Data Cloud';
  return null;
}
