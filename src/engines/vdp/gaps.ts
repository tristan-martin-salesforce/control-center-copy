/**
 * VDP gap check (pure). Input: the mirrored VDPs (src/connectors/vdp/types.ts), my accounts and opportunities with
 * their Org62 ids and my DC split, who I am, today, the Specialist Forecast AEs, and what VDP's server can take
 * (D-59, D-63). Output: per VDP, what is missing and the one VDP call that fixes each gap.
 *
 * Scope (D-63). An open opportunity where my DC split is 100% belongs in my VDPs ("engaged"): it needs a VDP, or to be
 * on its company's VDP. Closed opps, 50% DCs and team-only opps create nothing. A VDP I am on is checked only while
 * its account has an engaged opp (and it is this period or later, or links an open opp); otherwise it is `past`:
 * listed quietly on My VDPs, never checked. A seed VDP is writable when I am its AE, TA or a collaborator (vdp-app
 * lib/auth/policy.ts); a seed VDP I am not on is not listed at all. Archived VDPs are skipped.
 *
 *   per VDP      opportunities: opp_not_on_vdp (an engaged opp to add) · no_opp_link · wrong_opp_link (closed lost or
 *                another account's: remove it, a suggestion)
 *                people: no_ae (from the opp's Specialist Forecast, else an input) · no_ta (me)
 *                use cases: no_use_case · use_case_field (a required input is empty, the execution phase and target
 *                date included) · no_ai_fields (Generate, after the inputs)
 *                assets: no_assets (none in VDP: the in-app "Find assets")
 *                header: no_account_id · no_fiscal_period · wrong_fiscal_period · wrong_account_id (suggestions) ·
 *                no_entitlement (only when the read carries the field)
 *   per account  company_not_in_vdp (create the company, or the VDP when VDP knows the company) · opp_without_vdp (only
 *                past VDPs on the account: a new VDP), plus what the new VDP needs (no_ae, no_ta, no_use_case, with
 *                no `vdpSlug`)
 *
 * Every fix is an `app` fix (one VDP call). When VDP's MCP does not list the tool or argument it needs, the fix says
 * so (`unsupported`): the item shows disabled until the server lists it (*tenet: Nothing leaves without approval*;
 * D-63: no handoffs, no copy text). Auto-generated fields (the Deal Contribution note) are not checked, nor are
 * duplicate use cases or asset links (nothing to push for them).
 *
 * An app fix whose values are all known facts (an Org62 id or close quarter, VDP's own company match, me as TA, the
 * Specialist Forecast's AE) is `known` (D-60): VDP autopilot may apply it. A looks-wrong fix changes a value a person
 * entered, so it is always a suggestion.
 *
 * Matching VDP ↔ Org62 is by id (15-character prefix, so 15- and 18-character forms agree) over EVERY opp id on the
 * VDP (a VDP links up to 20), then by the linked opps' account, then by company name.
 */
import type { VdpCompanyIdentity, VdpCoverageRow, VdpGap } from '@/contract';
import { inChain, type AccountHierarchy } from '@/lib/accounts/hierarchy';
import { NO_SERVER_INFO, optionalArgs, unsupportedReason, type VdpCapabilities } from '@/lib/vdp/capabilities';
import { VDP_ENTITLEMENT_VALUES, VDP_FIELD_LABEL, VDP_FIELD_OPTIONS, VDP_MAX_OPPORTUNITIES, VDP_MAX_OWNERS } from '@/lib/vdp/payload';
import { oppIdsOf, type VdpServerInfo, type VdpSnapshot, type VdpUseCase } from '@/lib/vdp/types';

import { resolveCompanyIdentity, type IdentityJudgment, type IdentityOverride, type IdentityResult } from './identity';

export interface GapAccount {
  id: string;
  name: string;
  org62AccountId: string | null;
  /** The account's industry (Org62), for a new company's `industry_category_id` (D-60, only on an exact match). */
  industry?: string | null;
}

export interface GapOpp {
  id: string;
  accountId: string | null;
  name: string;
  org62OpportunityId: string | null;
  isOpen: boolean;
  /** Closed won (true), closed lost (false), or unknown / open (null): a linked closed-lost opp looks wrong (D-60). */
  isWon?: boolean | null;
  /** D-63: my DC split on it (Org62 Split_Percentage__c); null when I hold no DC or the split was not read. */
  dcSplit: number | null;
  closeDate: string | null;
  owner: { name: string | null; email: string | null } | null;
}

/** One specialist AE of an opp: the owner of its Org62 Specialist Forecast of a VDP type (D-63). */
export interface SpecialistAe {
  email: string;
  name: string | null;
  /** ForecastType__c: Data Cloud, BtL Data Cloud, Agentforce, BtL Agentforce. */
  type: string;
}

export interface GapInput {
  vdps: VdpSnapshot[];
  accounts: GapAccount[];
  opps: GapOpp[];
  me: { name: string; email: string | null };
  /** Every email of mine in VDP (aliases too), for "am I on this seed VDP". Default: `me.email`. */
  myEmails?: readonly string[];
  /** Origin of the VDP app ("https://vdp-app-fir-….herokuapp-internal.com"), for links when a VDP has no url. */
  vdpBaseUrl: string | null;
  /** Required human inputs of a use case (wire names). Default: the five VDP inputs plus the execution timeline. */
  requiredFields?: readonly string[];
  /** Today (ISO): the current fiscal period, for the scope. Default: the clock. */
  now?: string;
  /** What VDP's server takes over MCP (src/lib/vdp/capabilities.ts). Default: what upstream main ships. */
  capabilities?: VdpCapabilities;
  /** The server's lookups and company matches (the mirror's last read). */
  server?: VdpServerInfo | null;
  /** D-63: the Specialist Forecast AEs per local opp id (src/server/vdp/specialist-aes.ts). */
  aesByOpp?: ReadonlyMap<string, readonly SpecialistAe[]>;
  /** D-69: the Org62 account hierarchy (kv `cc.org62.account_hierarchy`); null = not read yet. */
  hierarchy?: AccountHierarchy | null;
  /** D-69: the judgment skill's cached decisions per ambiguity unit (kv `cc.vdp.identity.judgments`). */
  judgments?: Readonly<Record<string, IdentityJudgment>>;
  /** D-69: your mappings (Change…; kv `cc.vdp.identity`). */
  overrides?: readonly IdentityOverride[];
  /** D-69 (VD-14): VDPs archived in VDP, or that I am no longer on (the mirror's last read of them). */
  tombstones?: readonly VdpSnapshot[];
  /** D-69 (VD-13): Org62 opp ids gone from Org62 (DC-22 tombstones them: deleted there, archived here). */
  deletedOrg62OppIds?: readonly string[];
}

export interface VdpLink {
  accountId: string | null;
  /** The first local opp the VDP links (its primary, when that one is in my book). */
  opportunityId: string | null;
  opportunityName: string | null;
  /** Every local opp the VDP links, in VDP's order. */
  opportunityIds: string[];
}

/** A coverage row before its open items and status (src/engines/vdp/status.ts adds those). */
export type GapVdpRow = Omit<VdpCoverageRow, 'steps' | 'status' | 'summary' | 'assetItems'>;

export interface GapResult {
  vdps: GapVdpRow[];
  /** Account gaps no VDP owns yet: the company or VDP to create, and what that VDP needs. */
  unlinked: VdpGap[];
  counts: { vdps: number; gaps: number; appFixable: number; handoffs: number };
  /** D-69: the company identity of every engaged account, and its groups. */
  identity: IdentityResult;
}

/** What Generate reads: the five human inputs VDP's use-case editor captures (and its Use_Case__c export reads). */
export const GENERATE_INPUTS = ['title', 'priority', 'division', 'persona', 'details_input'] as const;
/**
 * The inputs a use case needs (D-63): the five, plus its execution timeline, which VDP exports to Salesforce as
 * Stage__c and Go_Live_Date__c. No guessed values: each is typed.
 */
export const DEFAULT_REQUIRED_FIELDS = [...GENERATE_INPUTS, 'execution_phase', 'execution_target_date'] as const;

const id15 = (s: string | null | undefined) => (s && s.length >= 15 ? s.slice(0, 15) : null);

/** D-63: an open opportunity where my DC split is 100%: it belongs in my VDPs. */
export const isEngaged = (o: Pick<GapOpp, 'isOpen' | 'dcSplit'>): boolean => o.isOpen && o.dcSplit === 100;

/** "Acme, Inc." → "acme" — for the name fallback only. */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|group|holdings|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Salesforce fiscal period of a date: FY runs Feb–Jan (FY27 = Feb 2026 → Jan 2027), Q1 = Feb–Apr. */
export function sfFiscalPeriod(isoDate: string): { fiscalYear: number; fiscalQuarter: number } | null {
  const m = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const fy = mo === 1 ? y : y + 1;
  const q = mo === 1 ? 4 : Math.floor((mo - 2) / 3) + 1;
  return { fiscalYear: fy % 100, fiscalQuarter: q };
}

/** A fiscal period as one comparable number (FY27 Q4 → 274). */
export const periodRank = (p: { fiscalYear: number | null; fiscalQuarter: number | null }) => (p.fiscalYear ?? 0) * 10 + (p.fiscalQuarter ?? 0);

/** The quarter after this one (FY27 Q4 → FY28 Q1). */
export const nextPeriod = (p: { fiscalYear: number; fiscalQuarter: number }) => (p.fiscalQuarter === 4 ? { fiscalYear: (p.fiscalYear + 1) % 100, fiscalQuarter: 1 } : { fiscalYear: p.fiscalYear, fiscalQuarter: p.fiscalQuarter + 1 });

/** The local account and opps a VDP belongs to (every opp id it links, not only the first). */
export function linkVdp(v: Pick<VdpSnapshot, 'salesforceAccountId' | 'salesforceOpportunityId' | 'salesforceOpportunityIds' | 'company'>, accounts: GapAccount[], opps: GapOpp[]): VdpLink {
  const keys = oppIdsOf(v).map(id15).filter((k): k is string => !!k);
  const linked = keys.map((k) => opps.find((o) => id15(o.org62OpportunityId) === k)).filter((o): o is GapOpp => !!o);
  const first = linked[0];
  const accKey = id15(v.salesforceAccountId);
  const viaOpp = linked.map((o) => o.accountId).find((a): a is string => !!a);
  const acc =
    (accKey ? accounts.find((a) => id15(a.org62AccountId) === accKey) : undefined) ??
    (viaOpp ? accounts.find((a) => a.id === viaOpp) : undefined) ??
    accounts.find((a) => companyKey(a.name) !== '' && companyKey(a.name) === companyKey(v.company.name));
  return { accountId: acc?.id ?? viaOpp ?? null, opportunityId: first?.id ?? null, opportunityName: first?.name ?? null, opportunityIds: [...new Set(linked.map((o) => o.id))] };
}

/**
 * `current` when the VDP's account has an engaged opp (D-63) and the VDP is for this fiscal period or a later one, or
 * any opp it links is open; `past` otherwise (an older period on closed opps, or an account with no open 100%-DC opp
 * of mine). A VDP with no period is checked (it needs one) unless every opp it links is closed.
 *
 * D-69 (VD-11): a VDP that would be current, on an account with an open opp but none where my DC is 100% yet, is
 * `waiting_dc` ("Waiting for your DC"), never Past: the VDP came before the DC.
 */
export function vdpScope(v: Pick<VdpSnapshot, 'fiscalYear' | 'fiscalQuarter'>, linked: readonly Pick<GapOpp, 'isOpen'>[], now: string, accountEngaged = true, accountHasOpenOpp = false): 'current' | 'waiting_dc' | 'past' {
  if (!accountEngaged) {
    if (!accountHasOpenOpp && !linked.some((o) => o.isOpen)) return 'past';
    return vdpScope(v, linked, now, true) === 'current' ? 'waiting_dc' : 'past';
  }
  if (linked.some((o) => o.isOpen)) return 'current';
  const cur = sfFiscalPeriod(now);
  if (!cur) return 'current';
  if (v.fiscalYear !== null && v.fiscalYear !== undefined) {
    if (v.fiscalQuarter === null || v.fiscalQuarter === undefined) return v.fiscalYear >= cur.fiscalYear ? 'current' : 'past';
    return periodRank(v) >= periodRank(cur) ? 'current' : 'past';
  }
  return linked.length ? 'past' : 'current';
}

/** Am I on this VDP: its AE, TA or a collaborator (or its creator), by any of my emails. */
export function onVdp(v: Pick<VdpSnapshot, 'aes' | 'tas' | 'collaborators' | 'createdBy'>, emails: readonly string[]): boolean {
  const mine = new Set(emails.map((e) => e.toLowerCase()));
  return [...v.aes, ...v.tas, ...v.collaborators, ...(v.createdBy ? [v.createdBy] : [])].some((p) => !!p.email && mine.has(p.email.toLowerCase()));
}

/** D-63: a seed VDP is writable by its assigned AE, TA and collaborators; one I am not on is not listed. */
export function listedVdp(v: Pick<VdpSnapshot, 'isSeed' | 'archivedAt' | 'aes' | 'tas' | 'collaborators' | 'createdBy'>, emails: readonly string[]): boolean {
  if (v.archivedAt) return false;
  if (!v.isSeed || !emails.length) return true;
  return onVdp({ ...v, createdBy: null }, emails);
}

/**
 * D-63: the specialist AEs for these opps (the owners of their Specialist Forecasts): Data Cloud owners first, then
 * Agentforce, deduplicated by email, at most VDP's 20.
 */
export function specialistAesFor(oppIds: readonly string[], aesByOpp: ReadonlyMap<string, readonly SpecialistAe[]> | undefined): SpecialistAe[] {
  if (!aesByOpp) return [];
  const all = oppIds.flatMap((id) => [...(aesByOpp.get(id) ?? [])]);
  const rank = (t: string) => (/data cloud/i.test(t) ? 0 : /agentforce/i.test(t) ? 1 : 2);
  const sorted = all.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a.type) - rank(y.a.type) || x.i - y.i);
  const seen = new Set<string>();
  const out: SpecialistAe[] = [];
  for (const { a } of sorted) {
    const k = a.email.trim().toLowerCase();
    if (!k || seen.has(k) || rank(a.type) > 1) continue;
    seen.add(k);
    out.push({ ...a, email: k });
  }
  return out.slice(0, VDP_MAX_OWNERS);
}

const valueOf = (u: VdpUseCase, field: string): string | number | null => {
  const m: Record<string, string | number | null> = {
    title: u.title,
    priority: u.priority,
    division: u.division,
    persona: u.persona,
    details_input: u.detailsInput,
    execution_phase: u.executionPhase,
    execution_start_date: u.executionStartDate,
    execution_target_date: u.executionTargetDate,
    execution_duration_value: u.executionDurationValue,
    execution_duration_unit: u.executionDurationUnit,
  };
  return m[field] ?? null;
};

const label = (v: Pick<VdpSnapshot, 'company' | 'fiscalYear' | 'fiscalQuarter'>) => `${v.company.name}${v.fiscalYear !== null ? ` FY${String(v.fiscalYear).padStart(2, '0')}${v.fiscalQuarter ? ` Q${v.fiscalQuarter}` : ''}` : ''}`;
const ucName = (u: VdpUseCase) => u.title?.trim() || `Untitled ${u.track === 'agentforce' ? 'Agentforce' : 'D360'} use case`;
type AppFix = Extract<VdpGap['fix'], { kind: 'app' }>;
const app = (fix: Omit<AppFix, 'kind' | 'options' | 'values' | 'current' | 'known' | 'unsupported'> & Partial<Pick<AppFix, 'options' | 'values' | 'current' | 'known' | 'unsupported'>>): AppFix => ({
  kind: 'app',
  current: null,
  options: [],
  values: {},
  known: false,
  unsupported: null,
  ...fix,
});
/** D-69 (VD-32): a tool that now requires an argument the app never sends turns its items off, whatever else holds. */
const blockedBy = (caps: VdpCapabilities, fix: AppFix): AppFix => (caps.blocked?.[fix.op] && !fix.unsupported ? { ...fix, unsupported: caps.blocked[fix.op]! } : fix);

/**
 * Caps audit 2026-11-21: create_vdp carries at most VDP_MAX_OPPORTUNITIES ids (VDP's own limit). An opp past them is
 * not silently left off: its gap says why instead of pointing at a create that would not include it.
 */
const pastVdpLimit = (fix: AppFix, o: { org62OpportunityId?: string | null }): AppFix => {
  const ids = (fix.values as { salesforce_opportunity_ids?: string[] }).salesforce_opportunity_ids ?? [];
  return o.org62OpportunityId && ids.length >= VDP_MAX_OPPORTUNITIES && !ids.includes(o.org62OpportunityId) && !fix.unsupported
    ? { ...fix, unsupported: `A VDP links at most ${VDP_MAX_OPPORTUNITIES} opportunities (VDP's limit); this one is past them: add it to another VDP` }
    : fix;
};

/** D-69: why a company node's items can't be pushed yet (its identity is not settled), else null. */
export function identityBlock(id: Pick<VdpCompanyIdentity, 'state' | 'reason'> | null | undefined): string | null {
  if (!id) return null;
  switch (id.state) {
    case 'needs_you':
      return 'Needs you: confirm the VDP company first (Change…)';
    case 'not_looked_up':
      return 'Not looked up yet: the next VDP read looks the company up in VDP';
    case 'hidden_vdps':
    case 'tombstoned':
      return id.reason;
    default:
      return null;
  }
}
/** Off until VDP's MCP lists what it needs (D-63): the reason, else null. */
const unless = (ok: boolean, what: string) => (ok ? null : unsupportedReason(what));

/** "acme retail-banking" → "acme retail banking": names compared for industries and segments. */
const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The industry or subcategory id whose name is exactly the account's industry, when exactly one is (D-60). */
export function industryIdFor(industry: string | null | undefined, list: ReadonlyArray<{ id: string; name: string; slug: string | null }> | null | undefined): string | null {
  const k = norm(industry);
  if (!k || !list?.length) return null;
  const hits = list.filter((i) => norm(i.name) === k || (i.slug ? norm(i.slug) === k : false));
  return new Set(hits.map((h) => h.id)).size === 1 ? hits[0]!.id : null;
}

/** D-63: the sales segment whose label (or slug) is exactly the account's Org62 segment, when exactly one is. */
export function salesSegmentFor(segment: string | null | undefined, list: ReadonlyArray<{ id: string; slug: string | null; label: string }> | null | undefined): string | null {
  const k = norm(segment);
  if (!k || !list?.length) return null;
  const hits = list.filter((s) => norm(s.label) === k || (s.slug ? norm(s.slug) === k : false));
  return new Set(hits.map((h) => h.id)).size === 1 ? hits[0]!.id : null;
}

/** Every token of a normalized title, one-character ones and numbers included ("phase 1" → phase, 1). */
const tokens = (s: string) => new Set(norm(s).split(' ').filter(Boolean));
/** The tokens that tell two otherwise equal titles apart: numbers and single letters or roman numerals ("1", "b", "ii"). */
const markers = (t: ReadonlySet<string>) => [...t].filter((w) => /\d/.test(w) || (w.length === 1 && w !== 'a') || /^[ivx]+$/.test(w)).sort().join(' ');

/**
 * Two use-case titles that name the same thing: equal once normalized, or nearly the same words (Jaccard ≥ 0.8 over
 * every token). VD-34: numbers and other distinguishing tokens must match, so "Use case 1" ≠ "Use case 2" and
 * "Agent – Phase 1" ≠ "Agent – Phase 2"; a one-character word counts as a word.
 */
export function sameUseCaseTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const wa = tokens(x);
  const wb = tokens(y);
  if (markers(wa) !== markers(wb)) return false;
  if (wa.size < 2 || wb.size < 2) return false;
  const inter = [...wa].filter((w) => wb.has(w)).length;
  return inter / new Set([...wa, ...wb]).size >= 0.8;
}

const fpLabel = (p: { fiscalYear: number; fiscalQuarter: number }) => `FY${String(p.fiscalYear).padStart(2, '0')} Q${p.fiscalQuarter}`;

/** The fiscal period a new VDP for these opps counts in: the first close date's, never before the current one. */
export function periodFor(opps: readonly Pick<GapOpp, 'closeDate'>[], now: string): { fiscalYear: number; fiscalQuarter: number } | null {
  const cur = sfFiscalPeriod(now);
  const fp = opps.map((o) => (o.closeDate ? sfFiscalPeriod(o.closeDate) : null)).find((x) => !!x) ?? null;
  if (!fp) return cur;
  return cur && periodRank(fp) < periodRank(cur) ? cur : fp;
}

export function computeVdpGaps(input: GapInput): GapResult {
  const required = input.requiredFields ?? DEFAULT_REQUIRED_FIELDS;
  const now = input.now ?? new Date().toISOString();
  const caps = input.capabilities ?? NO_SERVER_INFO;
  const emails = input.myEmails?.length ? input.myEmails : input.me.email ? [input.me.email] : [];
  const live = input.vdps.filter((v) => listedVdp(v, emails));
  // D-69: which VDP company each engaged account belongs to, and which accounts go together (one node, one VDP)
  const tombstones = [...(input.tombstones ?? []), ...input.vdps.filter((v) => !!v.archivedAt)];
  const identity = resolveCompanyIdentity({ accounts: input.accounts, opps: input.opps, vdps: live, tombstones, hierarchy: input.hierarchy ?? null, lookups: input.server?.companies ?? [], ...(input.judgments ? { judgments: input.judgments } : {}), ...(input.overrides ? { overrides: input.overrides } : {}) });
  const links = new Map(
    live.map((v) => {
      const l = linkVdp(v, input.accounts, input.opps);
      const g = identity.groupOfVdp.get(v.id);
      return [v.id, g ? { ...l, accountId: g.primaryAccountId } : l] as const;
    }),
  );
  const linkedOppIds = new Set([...links.values()].flatMap((l) => l.opportunityIds));
  const oppById = new Map(input.opps.map((o) => [o.id, o]));
  const accById = new Map(input.accounts.map((a) => [a.id, a]));
  /** The accounts a link's account stands for: its group's (D-69), else itself. */
  const membersOf = (accountId: string | null): string[] => (accountId ? (identity.groupOfAccount.get(accountId)?.accountIds ?? [accountId]) : []);
  const engagedAccounts = new Set(input.opps.filter((o) => isEngaged(o) && o.accountId).map((o) => o.accountId!));
  const openAccounts = new Set(input.opps.filter((o) => o.isOpen && o.accountId).map((o) => o.accountId!));
  const scopes = new Map(
    live.map((v) => {
      const l = links.get(v.id)!;
      const members = membersOf(l.accountId);
      return [v.id, vdpScope(v, l.opportunityIds.map((id) => oppById.get(id)!), now, members.some((a) => engagedAccounts.has(a)), members.some((a) => openAccounts.has(a)))] as const;
    }),
  );
  const vdpUrlOf = (v: VdpSnapshot) => v.url ?? (input.vdpBaseUrl ? `${input.vdpBaseUrl.replace(/\/+$/, '')}/vdp/${v.slug}` : null);
  const me = input.me.email ? input.me.email.toLowerCase() : null;
  const ownersOff = unless(caps.setOwners, 'set_vdp_owners');

  // ---- account level first: which VDP each loose engaged opp goes on, and the VDPs / companies to create
  const unlinked: VdpGap[] = [];
  const addToVdp = new Map<string, VdpGap[]>();
  const byAccount = new Map<string, VdpSnapshot[]>();
  for (const v of live) {
    const a = links.get(v.id)!.accountId;
    if (a) byAccount.set(a, [...(byAccount.get(a) ?? []), v]);
  }
  /** What a VDP to create needs (D-63): the people (TA me, AE from the Specialist Forecast) and a use case. */
  const newVdpNeeds = (a: GapAccount, os: readonly GapOpp[], base: Omit<VdpGap, 'id' | 'code' | 'severity' | 'title' | 'fix'>) => {
    const aes = specialistAesFor(os.map((o) => o.id), input.aesByOpp);
    unlinked.push({
      ...base,
      id: `account:${a.id}:no_ae`,
      code: 'no_ae',
      severity: 'high',
      title: aes.length ? `AE: ${aes.map((x) => x.name ?? x.email).join(', ')}` : 'AE: no Specialist Forecast on the opportunity',
      fix: blockedBy(caps, app({ op: 'set_vdp_owners', field: 'account_executives', suggested: aes.length ? aes.map((x) => x.email) : null, known: aes.length > 0, unsupported: ownersOff })),
    });
    unlinked.push({ ...base, id: `account:${a.id}:no_ta`, code: 'no_ta', severity: 'medium', title: `TA: ${input.me.name || me || 'you'}`, fix: blockedBy(caps, app({ op: 'set_vdp_owners', field: 'technical_architects', suggested: me ? [me] : null, known: !!me, unsupported: ownersOff })) });
    unlinked.push({ ...base, id: `account:${a.id}:no_use_case`, code: 'no_use_case', severity: 'high', title: 'Add a use case', fix: blockedBy(caps, app({ op: 'create_use_case', field: 'title', suggested: null })) });
    unlinked.push(newUseCaseGenerate(`account:${a.id}`, base));
  };
  /** The Generate of the use case a create_use_case item makes (D-63: its new id is passed down). */
  const newUseCaseGenerate = (key: string, base: Omit<VdpGap, 'id' | 'code' | 'severity' | 'title' | 'fix'>): VdpGap => ({ ...base, useCaseId: null, id: `${key}:no_ai_fields:new`, code: 'no_ai_fields', severity: 'low', title: 'Generate the AI fields', fix: blockedBy(caps, app({ op: 'generate_use_case', field: 'ai_fields', suggested: 'generate', known: true, unsupported: unless(caps.generateUseCase, 'generate_use_case') })) });
  /**
   * The create_vdp call for these opps: the company VDP knows (`companyId`), or the one the create_company item above
   * it makes (`underNewCompany`: its id is passed in by the push). D-69: the account id is the primary opp's own account
   * (VD-12), known only when the company identity is deterministic, and blocked while it is not settled.
   */
  const createVdp = (companyId: string | null, os: readonly GapOpp[], o: { underNewCompany?: boolean; known?: boolean; blocked?: string | null } = {}): AppFix => {
    const fp = periodFor(os, now);
    const ids = os.map((x) => x.org62OpportunityId).filter((x): x is string => !!x).slice(0, VDP_MAX_OPPORTUNITIES);
    const primaryAcc = os[0]?.accountId ? accById.get(os[0].accountId) : undefined;
    return blockedBy(
      caps,
      app({
        op: 'create_vdp',
        field: 'company_id',
        suggested: companyId,
        values: { ...(fp ? { fiscal_year: fp.fiscalYear, fiscal_quarter: fp.fiscalQuarter } : {}), ...(primaryAcc?.org62AccountId ? { salesforce_account_id: primaryAcc.org62AccountId } : {}), ...(ids.length ? { salesforce_opportunity_ids: ids } : {}) },
        // VDP's own company match (or the company it is about to create) and my Org62 opps and account: known (D-60)
        known: (!!companyId || !!o.underNewCompany) && o.known !== false,
        unsupported: unless(caps.createVdp, 'create_vdp') ?? o.blocked ?? (companyId || o.underNewCompany ? null : 'The VDP company id is not known yet: the next VDP read looks it up'),
      }),
    );
  };
  for (const g of identity.groups) {
    const a = accById.get(g.primaryAccountId)!;
    const mine = input.opps.filter((o) => !!o.accountId && g.accountIds.includes(o.accountId) && isEngaged(o)).sort((x, y) => (x.closeDate ?? '9999').localeCompare(y.closeDate ?? '9999'));
    if (!mine.length) continue;
    const vdps = byAccount.get(a.id) ?? [];
    const base = { vdpSlug: null, vdpUrl: null, useCaseId: null, useCaseTitle: null, accountId: a.id, check: 'missing' as const, why: null };
    const loose = mine.filter((o) => !linkedOppIds.has(o.id));
    if (!vdps.length) {
      // VD-04: every engaged opp is on a VDP of mine already (a sibling's, say): nothing to create
      if (!loose.length) continue;
      const first = loose[0]!;
      const os = loose;
      const id = g.identity;
      const blocked = identityBlock(id);
      if (id.pick.kind === 'match') {
        unlinked.push({ ...base, id: `account:${a.id}:company_not_in_vdp`, code: 'company_not_in_vdp', severity: 'high', title: `${a.name} has no VDP`, opportunityId: first.id, fix: createVdp(id.pick.id, os, { known: id.deterministic, blocked }) });
      } else {
        // D-60: a new company carries its industry only when VDP's taxonomy names the account's industry exactly once;
        // D-69: it is a known fix (autopilot may create it) only when the company identity is deterministic: every
        // name up the Org62 chain was looked up and VDP returned nothing at all, and the chain carries one name
        const opt = optionalArgs(input.server ?? null, 'create_company');
        const industryId = opt.includes('industry_category_id') ? industryIdFor(a.industry, input.server?.industries) : null;
        const aliases = opt.includes('aliases') ? id.pick.aliases : [];
        unlinked.push({
          ...base,
          id: `account:${a.id}:company_not_in_vdp`,
          code: 'company_not_in_vdp',
          severity: 'high',
          title: `${id.pick.name} is not in VDP`,
          opportunityId: first.id,
          fix: blockedBy(caps, app({ op: 'create_company', field: 'name', suggested: id.pick.name, values: { ...(aliases.length ? { aliases } : {}), ...(industryId ? { industry_category_id: industryId } : {}) }, known: id.deterministic, unsupported: unless(caps.createCompany, 'create_company') ?? blocked })),
        });
        // the VDP under the new company: its id comes from the create_company item (D-63)
        const fix = createVdp(null, os, { underNewCompany: true, known: id.deterministic, blocked });
        for (const o of os) unlinked.push({ ...base, id: `opp:${o.id}:opp_without_vdp`, code: 'opp_without_vdp', severity: 'medium', title: `${o.name} is not on a VDP`, opportunityId: o.id, fix: pastVdpLimit(fix, o) });
      }
      newVdpNeeds(a, os, { ...base, opportunityId: first.id });
      continue;
    }
    if (!loose.length) continue;
    const current = vdps.filter((v) => scopes.get(v.id) === 'current');
    if (current.length) {
      // The account has a current VDP: add each loose opp to it (the one for its quarter, else the newest).
      for (const o of loose) {
        const fp = o.closeDate ? sfFiscalPeriod(o.closeDate) : null;
        const target =
          (fp ? current.find((v) => v.fiscalYear === fp.fiscalYear && v.fiscalQuarter === fp.fiscalQuarter) : undefined) ??
          [...current].sort((x, y) => periodRank(y) - periodRank(x) || (y.lastActivityAt ?? '').localeCompare(x.lastActivityAt ?? ''))[0]!;
        const full = oppIdsOf(target).length >= VDP_MAX_OPPORTUNITIES;
        const g: VdpGap = {
          ...base,
          vdpSlug: target.slug,
          vdpUrl: vdpUrlOf(target),
          id: `opp:${o.id}:opp_not_on_vdp`,
          code: 'opp_not_on_vdp',
          severity: 'medium',
          title: `Add ${o.name}`,
          opportunityId: o.id,
          fix: app({
            op: 'update_vdp_header',
            field: 'add_opportunity_ids',
            suggested: o.org62OpportunityId ? [o.org62OpportunityId] : null,
            known: !!o.org62OpportunityId,
            unsupported: unless(caps.addOpportunities, 'update_vdp_header.add_opportunity_ids') ?? (full ? `The VDP already links ${VDP_MAX_OPPORTUNITIES} opportunities (VDP's limit)` : o.org62OpportunityId ? null : 'Its Org62 id is not known yet: the next Org62 read brings it'),
          }),
        };
        addToVdp.set(target.slug, [...(addToVdp.get(target.slug) ?? []), g]);
      }
      continue;
    }
    // Only past VDPs: a new VDP for the loose opps (VDP knows the company: its old VDPs name it).
    const company = [...vdps].sort((x, y) => periodRank(y) - periodRank(x))[0]!.company;
    const fix = createVdp(company.id, loose);
    for (const o of loose) unlinked.push({ ...base, id: `opp:${o.id}:opp_without_vdp`, code: 'opp_without_vdp', severity: 'medium', title: `${o.name} is not on a VDP`, opportunityId: o.id, fix: pastVdpLimit(fix, o) });
    newVdpNeeds(a, loose, { ...base, opportunityId: loose[0]!.id });
  }

  // ---- per VDP
  const rows: GapVdpRow[] = [];
  for (const v of live) {
    const link = links.get(v.id)!;
    const linked = link.opportunityIds.map((id) => oppById.get(id)!).filter(Boolean);
    const opp = linked[0];
    const scope = scopes.get(v.id)!;
    const vdpUrl = vdpUrlOf(v);
    const gaps: VdpGap[] = [];
    const base = { vdpSlug: v.slug, vdpUrl, accountId: link.accountId, opportunityId: link.opportunityId, useCaseId: null, useCaseTitle: null, check: 'missing' as const, why: null };

    if (scope === 'current') {
      // Known facts (D-60): the account the VDP's own Org62 account id names, and the account its linked opps are on
      const viaAccountId = !!id15(v.salesforceAccountId) && input.accounts.some((a) => id15(a.org62AccountId) === id15(v.salesforceAccountId) && a.id === link.accountId);
      const viaOpp = linked.map((o) => o.accountId).find((a): a is string => !!a) ?? null;

      // ---- opportunities: the engaged ones to add (the account loop), a link when it has none, the ones that look wrong
      gaps.push(...(addToVdp.get(v.slug) ?? []));
      if (!oppIdsOf(v).length && !addToVdp.get(v.slug)?.length) {
        gaps.push({ ...base, id: `${v.slug}:no_opp_link`, code: 'no_opp_link', severity: 'low', title: 'Link the VDP to an Org62 opportunity', fix: app({ op: 'update_vdp_header', field: 'add_opportunity_ids', suggested: null, unsupported: unless(caps.addOpportunities, 'update_vdp_header.add_opportunity_ids') }) });
      }
      const wrong = (g: Omit<VdpGap, keyof typeof base | 'check' | 'severity' | 'useCaseId' | 'useCaseTitle'> & Partial<VdpGap>): VdpGap => ({ ...base, severity: 'medium', ...g, check: 'wrong' });
      // D-69: the VDP's accounts are its company group's (a parent's header id counts: VD-10)
      const members = membersOf(link.accountId);
      const headerInGroup = !!id15(v.salesforceAccountId) && members.some((m) => inChain(input.hierarchy ?? null, accById.get(m)?.org62AccountId, v.salesforceAccountId));
      const seen = new Set<string>();
      for (const o of linked) {
        const lost = !o.isOpen && o.isWon === false;
        // VD-13: an opp moved to an account outside the VDP's group, while the header or its other opps anchor it there
        const anchored = viaAccountId || headerInGroup || linked.some((x) => x !== o && !!x.accountId && members.includes(x.accountId));
        const other = !!o.accountId && !!link.accountId && anchored && !members.includes(o.accountId);
        // VD-12: an engaged opp another current VDP of mine links too (create_vdp warns about it; the later one looks wrong)
        const twin = isEngaged(o) ? live.find((x) => x.id !== v.id && scopes.get(x.id) === 'current' && links.get(x.id)!.opportunityIds.includes(o.id) && ((x.createdAt ?? '') < (v.createdAt ?? '') || ((x.createdAt ?? '') === (v.createdAt ?? '') && x.slug < v.slug))) : undefined;
        if ((!lost && !other && !twin) || seen.has(o.id)) continue;
        seen.add(o.id);
        const onVdpId = oppIdsOf(v).find((x) => id15(x) === id15(o.org62OpportunityId)) ?? o.org62OpportunityId;
        const why = lost ? `${o.name} is closed lost in Org62` : other ? `${o.name} is on ${accById.get(o.accountId!)?.name ?? 'another account'}, not ${accById.get(link.accountId!)?.name ?? 'this VDP’s account'}` : `${o.name} is also on ${twin!.slug}: one opportunity, one VDP`;
        // D-63: taken off the header with remove_opportunity_ids, a suggestion you approve (never deleted)
        gaps.push(wrong({ id: `${v.slug}:wrong_opp_link:${o.id}`, code: 'wrong_opp_link', title: `Remove ${o.name}`, why, opportunityId: o.id, fix: blockedBy(caps, app({ op: 'update_vdp_header', field: 'remove_opportunity_ids', suggested: onVdpId ? [onVdpId] : null, known: true, unsupported: unless(caps.removeOpportunities, 'update_vdp_header.remove_opportunity_ids') })) }));
      }

      // VD-13: an opp id on the header that Org62 no longer has (DC-22 tombstoned it): take it off, a suggestion
      const dead = new Set((input.deletedOrg62OppIds ?? []).map(id15).filter((x): x is string => !!x));
      for (const x of oppIdsOf(v)) {
        const k = id15(x);
        if (!k || !dead.has(k) || seen.has(k)) continue;
        seen.add(k);
        gaps.push(wrong({ id: `${v.slug}:wrong_opp_link:gone:${k}`, code: 'wrong_opp_link', title: 'Remove a deleted opportunity', why: `${x} is no longer in Org62 (deleted there)`, opportunityId: null, fix: blockedBy(caps, app({ op: 'update_vdp_header', field: 'remove_opportunity_ids', suggested: [x], known: true, unsupported: unless(caps.removeOpportunities, 'update_vdp_header.remove_opportunity_ids') })) }));
      }

      // ---- people: fill only an empty role (set_vdp_owners sends the role's full list; never changes who is there)
      if (!v.aes.length) {
        // the AEs of the engaged opps it links and of the ones it is about to get, then of its other linked opps
        const adding = (addToVdp.get(v.slug) ?? []).map((g) => oppById.get(g.opportunityId ?? '')).filter((o): o is GapOpp => !!o);
        const pool = [...linked.filter(isEngaged), ...adding, ...linked.filter((o) => !isEngaged(o))].map((o) => o.id);
        const aes = specialistAesFor(pool, input.aesByOpp);
        gaps.push({
          ...base,
          id: `${v.slug}:no_ae`,
          code: 'no_ae',
          severity: 'high',
          title: aes.length ? `AE: ${aes.map((x) => x.name ?? x.email).join(', ')}` : 'AE: no Specialist Forecast on the opportunity',
          fix: app({ op: 'set_vdp_owners', field: 'account_executives', suggested: aes.length ? aes.map((x) => x.email) : null, known: aes.length > 0, unsupported: ownersOff }),
        });
      }
      if (v.aes.length) {
        // VD-30: the Specialist Forecast now names an AE the VDP does not list: add them (the live list plus the new
        // one, never a replace), a looks-wrong suggestion you approve
        const listed = new Set(v.aes.map((p) => p.email?.toLowerCase()).filter((e): e is string => !!e));
        const fresh = specialistAesFor(linked.filter(isEngaged).map((o) => o.id), input.aesByOpp).filter((x) => !listed.has(x.email));
        if (fresh.length && listed.size) {
          const current = [...listed];
          const next = [...current, ...fresh.map((x) => x.email)].slice(0, VDP_MAX_OWNERS);
          gaps.push(wrong({ id: `${v.slug}:ae_not_on_vdp`, code: 'ae_not_on_vdp', title: `Add the AE: ${fresh.map((x) => x.name ?? x.email).join(', ')}`, why: `The Specialist Forecast names ${fresh.map((x) => x.name ?? x.email).join(', ')}; the VDP lists ${v.aes.map((p) => p.name ?? p.email).join(', ')}`, severity: 'medium', fix: blockedBy(caps, app({ op: 'set_vdp_owners', field: 'account_executives', current, suggested: next, known: false, unsupported: ownersOff })) }));
        }
      }
      if (!v.tas.length) gaps.push({ ...base, id: `${v.slug}:no_ta`, code: 'no_ta', severity: 'medium', title: `TA: ${input.me.name || me || 'you'}`, fix: app({ op: 'set_vdp_owners', field: 'technical_architects', suggested: me ? [me] : null, known: !!me, unsupported: ownersOff }) });

      // ---- use cases
      if (!v.useCases.length) {
        gaps.push({ ...base, id: `${v.slug}:no_use_case`, code: 'no_use_case', severity: 'high', title: 'Add a use case', fix: app({ op: 'create_use_case', field: 'title', suggested: null }) });
        gaps.push(newUseCaseGenerate(v.slug, base));
      }
      for (const u of v.useCases) {
        const ub = { ...base, useCaseId: u.id, useCaseTitle: ucName(u) };
        // An index-only row (detail not read yet) has no details_input: skip that field rather than flag it falsely.
        for (const f of required) {
          if (f === 'details_input' && !u.detailLoaded) continue;
          const cur = valueOf(u, f);
          if (cur !== null && String(cur).trim() !== '') continue;
          gaps.push({
            ...ub,
            id: `${v.slug}:use_case_field:${u.id}:${f}`,
            code: 'use_case_field',
            severity: f === 'title' || f === 'details_input' ? 'high' : 'medium',
            title: `${ucName(u)}: ${VDP_FIELD_LABEL[f] ?? f} is empty`,
            fix: app({ op: 'update_use_case', field: f, suggested: null, options: [...(VDP_FIELD_OPTIONS[f] ?? [])] }),
          });
        }
        if (!u.hasAi) gaps.push({ ...ub, id: `${v.slug}:no_ai_fields:${u.id}`, code: 'no_ai_fields', severity: 'low', title: `${ucName(u)}: Generate the AI fields`, fix: app({ op: 'generate_use_case', field: 'ai_fields', suggested: 'generate', known: true, unsupported: unless(caps.generateUseCase, 'generate_use_case') }) });
      }

      // ---- assets: none in VDP → the in-app "Find assets" (candidates, when there are any, are their own items)
      if (!v.assets.length) gaps.push({ ...base, id: `${v.slug}:no_assets`, code: 'no_assets', severity: 'medium', title: 'No assets on the VDP', fix: { kind: 'in_app', action: 'find_assets', label: 'Find assets' } });

      // ---- header
      if (!v.salesforceAccountId) {
        const acc = link.accountId ? accById.get(link.accountId) : undefined;
        // known when the account came from the opps the VDP links (Org62), not from the company name alone
        gaps.push({ ...base, id: `${v.slug}:no_account_id`, code: 'no_account_id', severity: 'medium', title: 'Set the Org62 account id', fix: app({ op: 'update_vdp_header', field: 'salesforce_account_id', suggested: acc?.org62AccountId ?? null, known: !!acc?.org62AccountId && viaOpp === acc.id }) });
      }
      if (v.fiscalYear === null || v.fiscalQuarter === null) {
        // known from the linked opp's Org62 close date; the current quarter is only a default
        const fromOpp = opp?.closeDate ? sfFiscalPeriod(opp.closeDate) : null;
        const fp = fromOpp ?? sfFiscalPeriod(now);
        if (v.fiscalYear === null) gaps.push({ ...base, id: `${v.slug}:no_fiscal_period:fiscal_year`, code: 'no_fiscal_period', severity: 'medium', title: 'Fiscal year is not set', fix: app({ op: 'update_vdp_header', field: 'fiscal_year', suggested: fp?.fiscalYear ?? null, known: !!fromOpp }) });
        if (v.fiscalQuarter === null) gaps.push({ ...base, id: `${v.slug}:no_fiscal_period:fiscal_quarter`, code: 'no_fiscal_period', severity: 'medium', title: 'Fiscal quarter is not set', fix: app({ op: 'update_vdp_header', field: 'fiscal_quarter', suggested: fp?.fiscalQuarter ?? null, options: ['1', '2', '3', '4'], known: !!fromOpp }) });
      }
      // looks wrong (D-60): the period vs the linked open opps' close quarter; the account id vs the linked opps' account
      const openLinked = linked.filter((o) => o.isOpen && o.closeDate);
      if (v.fiscalYear !== null && v.fiscalQuarter !== null && openLinked.length) {
        const periods = [...new Map(openLinked.map((o) => sfFiscalPeriod(o.closeDate!)).filter((x): x is NonNullable<typeof x> => !!x).map((p) => [fpLabel(p), p])).values()];
        const cur = { fiscalYear: v.fiscalYear, fiscalQuarter: v.fiscalQuarter };
        if (periods.length && !periods.some((p) => periodRank(p) === periodRank(cur))) {
          const why = `${openLinked.length === 1 ? `${openLinked[0]!.name} closes` : 'The linked opportunities close'} ${periods.map(fpLabel).join(' / ')}; the VDP says ${fpLabel(cur)}`;
          const one = periods.length === 1 ? periods[0]! : null;
          const title = `Fiscal period looks wrong: ${fpLabel(cur)}`;
          if (!one || one.fiscalYear !== cur.fiscalYear) gaps.push(wrong({ id: `${v.slug}:wrong_fiscal_period:fiscal_year`, code: 'wrong_fiscal_period', title, why, fix: app({ op: 'update_vdp_header', field: 'fiscal_year', current: cur.fiscalYear, suggested: one?.fiscalYear ?? null, options: one ? [] : [...new Set(periods.map((p) => String(p.fiscalYear)))], known: !!one }) }));
          if (!one || one.fiscalQuarter !== cur.fiscalQuarter) gaps.push(wrong({ id: `${v.slug}:wrong_fiscal_period:fiscal_quarter`, code: 'wrong_fiscal_period', title, why, fix: app({ op: 'update_vdp_header', field: 'fiscal_quarter', current: cur.fiscalQuarter, suggested: one?.fiscalQuarter ?? null, options: ['1', '2', '3', '4'], known: !!one }) }));
        }
      }
      if (v.salesforceAccountId) {
        const accIds = [...new Set(linked.map((o) => (o.accountId ? accById.get(o.accountId)?.org62AccountId : null)).filter((x): x is string => !!x))];
        if (accIds.length && !accIds.some((x) => id15(x) === id15(v.salesforceAccountId))) {
          const names = [...new Set(linked.map((o) => (o.accountId ? accById.get(o.accountId)?.name : null)).filter((x): x is string => !!x))];
          const why = `The linked opportunities are on ${names.join(', ') || 'another account'} (${accIds.join(', ')}); the VDP header says ${v.salesforceAccountId}`;
          gaps.push(wrong({ id: `${v.slug}:wrong_account_id`, code: 'wrong_account_id', title: 'The Org62 account id looks wrong', why, fix: app({ op: 'update_vdp_header', field: 'salesforce_account_id', current: v.salesforceAccountId, suggested: accIds.length === 1 ? accIds[0]! : null, options: accIds.length > 1 ? accIds : [], known: accIds.length === 1 }) }));
        }
      }
      // D-63: the entitlement leveraged, only when the read carries the field and it is empty (an input, no default)
      if (v.entitlementLeveraged === null) {
        gaps.push({ ...base, id: `${v.slug}:no_entitlement`, code: 'no_entitlement', severity: 'medium', title: 'Entitlement leveraged is not set', fix: app({ op: 'update_vdp_header', field: 'entitlement_leveraged', suggested: null, options: [...VDP_ENTITLEMENT_VALUES], unsupported: unless(caps.entitlementHeader, 'update_vdp_header.entitlement_leveraged') }) });
      }
    }

    rows.push({
      vdpSlug: v.slug,
      vdpId: v.id,
      url: vdpUrl,
      companyName: v.company.name,
      fiscalYear: v.fiscalYear,
      fiscalQuarter: v.fiscalQuarter,
      accountId: link.accountId,
      opportunityId: link.opportunityId,
      opportunityName: link.opportunityName,
      opportunityIds: link.opportunityIds,
      opportunityNames: linked.map((o) => o.name),
      accountIds: membersOf(link.accountId),
      useCaseCount: v.useCases.length,
      useCaseWithAiCount: v.useCases.filter((u) => u.hasAi).length,
      assetCount: v.assets.length,
      hasAe: v.aes.length > 0,
      hasTa: v.tas.length > 0,
      lastActivityAt: v.lastActivityAt,
      scope,
      gaps,
    });
  }

  const all = [...rows.flatMap((r) => r.gaps), ...unlinked];
  return {
    vdps: rows.sort((a, b) => b.gaps.length - a.gaps.length || a.companyName.localeCompare(b.companyName)),
    unlinked,
    counts: { vdps: rows.length, gaps: all.length, appFixable: all.filter((g) => g.fix.kind === 'app' && !g.fix.unsupported).length, handoffs: 0 },
    identity,
  };
}

/** Gap codes for `vdp_records.missing_items` (one per code, sorted). */
export const missingCodes = (row: Pick<VdpCoverageRow, 'gaps'>): string[] => [...new Set(row.gaps.filter((g) => g.check !== 'wrong').map((g) => g.code))].sort();

export { label as vdpLabel };
