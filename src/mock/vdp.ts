/**
 * Placeholder VDPs for the mock DataSource (CC_DATA=mock never calls VDP). Built from the seed's own placeholder
 * accounts and opportunities, so linking and the gap check run on the same rules as the db path. D-63: an account
 * counts when it has an open opp where my DC split is 100% ("engaged"), and the three tree shapes are all there:
 *  - the first engaged account: a VDP that exists and misses things (an opp to add, the AE and TA, a use case's
 *    inputs and its Generate, the entitlement leveraged: D-69, vdp-app #11 shipped it);
 *  - the second: VDP knows the company, no VDP yet (create_vdp and what comes under it);
 *  - every other engaged account: VDP lacks the company (create_company, the VDP under it, and its items);
 *  - an account where my DC is only 50%: a VDP I am on, listed as past (no 100%-DC open opp).
 * Ids are fixed fake uuids; urls point at a `.test` host. The Specialist Forecast AEs are placeholders too.
 */
import type { Account, Opportunity, VdpCandidateSource } from '@/contract';
import type { SpecialistAe } from '@/engines/vdp/gaps';
import type { VdpCompanyLookup, VdpCompanyMatch, VdpServerInfo, VdpServerTool, VdpSnapshot, VdpUseCase } from '@/lib/vdp/types';
import type { AccountHierarchy } from '@/lib/accounts/hierarchy';
import { identityQueries, type IdentityJudgment, type IdentityOverride, type JudgmentRequest } from '@/engines/vdp/identity';
import { gapEntities } from '@/server/vdp/coverage';
import { assetKeyOf, VDP_ASSET_TYPES } from '@/engines/vdp/assets';
import type { CandidateRecord } from '@/server/vdp/detail';
import type { Org62UseCase, UseCaseLink } from '@/engines/activity/use-cases';
import { seedScale } from './scale';

export const MOCK_VDP_BASE = 'https://vdp.example.test';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org62 = (url: string | null, prefix: '001' | '006') => new RegExp(`\\b(${prefix}[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)\\b`).exec(url ?? '')?.[1] ?? null;
const slugOf = (name: string, n: number) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company'}-${n}`;

function placeholderUseCase(n: number, o: Partial<VdpUseCase>): VdpUseCase {
  return {
    id: uid(1000 + n),
    track: 'd360',
    displayOrder: n,
    title: null,
    priority: null,
    division: null,
    persona: null,
    detailsInput: null,
    executionPhase: null,
    executionStartDate: null,
    executionTargetDate: null,
    executionDurationValue: null,
    executionDurationUnit: null,
    hasAi: false,
    generatedFields: null,
    painThemeId: null,
    sourceLibraryId: null,
    createdAt: null,
    updatedAt: null,
    detailLoaded: true,
    ...o,
  };
}

/**
 * C9 smoke at scale (src/mock/scale.ts): at CC_SEED_SCALE ≥ 4 the first VDP carries 4 × n more use cases with gaps
 * (no priority, division, persona or details), so the VDP page shows 60+ items to fix. Below 4: none (unchanged).
 */
export function scaledUseCases(n: number): VdpUseCase[] {
  if (n < 4) return [];
  const tracks = ['d360', 'agentforce'] as const;
  return Array.from({ length: 4 * n }, (_, i) => placeholderUseCase(10 + i, { track: tracks[i % 2]!, title: `Placeholder use case ${i + 1}`, ...(i % 3 === 0 ? { priority: '2 - Medium' } : {}) }));
}

/** D-63: an open opp where my DC split is 100%. */
const engagedOpp = (o: Opportunity) => o.isOpen && o.myDc?.split === 100;

/** The engaged accounts in the seed's order, each with its engaged opps (closest close first). */
function engagedAccounts(accounts: Account[], opps: Opportunity[]): Array<{ a: Account; os: Opportunity[] }> {
  return accounts
    .map((a) => ({ a, os: opps.filter((o) => o.accountId === a.id && engagedOpp(o)).sort((x, y) => (x.closeDate ?? '9999').localeCompare(y.closeDate ?? '9999')) }))
    .filter((x) => x.os.length);
}

const fiscalOf = (iso: string | null) => {
  const m = /^(\d{4})-(\d{2})/.exec(iso ?? '');
  if (!m) return { fiscalYear: 27, fiscalQuarter: 4 };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { fiscalYear: (mo === 1 ? y : y + 1) % 100, fiscalQuarter: mo === 1 ? 4 : Math.floor((mo - 2) / 3) + 1 };
};

export function mockVdpSnapshots(accounts: Account[], opps: Opportunity[], me: { name: string; email: string }, now: string): VdpSnapshot[] {
  const out: VdpSnapshot[] = [];
  const meP = { email: me.email.toLowerCase(), name: me.name, placeholder: false };
  const first = engagedAccounts(accounts, opps)[0];
  if (first) {
    const { a, os } = first;
    const opp = os[0]!;
    const slug = slugOf(a.name, 1);
    const fp = fiscalOf(opp.closeDate);
    const id = org62(opp.org62Url, '006');
    out.push({
      id: uid(1),
      slug,
      url: `${MOCK_VDP_BASE}/vdp/${slug}`,
      company: { id: uid(100), name: a.name, slug: slugOf(a.name, 0), industry: a.industry, segment: null },
      ...fp,
      salesforceAccountId: org62(a.org62Url, '001'),
      // the first engaged opp is linked; the others are items to add
      salesforceOpportunityId: id,
      salesforceOpportunityIds: id ? [id] : [],
      isSeed: false,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      aes: [],
      tas: [],
      createdBy: meP,
      collaborators: [],
      useCases: [
        placeholderUseCase(1, { title: 'Unified customer profile', priority: '3 - High', division: 'Sales', persona: 'Data team', detailsInput: 'Placeholder details.', executionPhase: 'Build', executionTargetDate: '2027-01-15', hasAi: true, generatedFields: { executive_summary: 'Placeholder summary.' } }),
        placeholderUseCase(2, { track: 'agentforce', title: 'Service agent deflection', priority: '2 - Medium', division: 'Service', detailsInput: 'Placeholder details.' }),
        ...scaledUseCases(seedScale()),
      ],
      stakeholders: [{ id: uid(3000), name: 'Stakeholder Placeholder', title: 'VP of Service', role: 'Champion', notes: null }],
      assets: [],
      dcNoteCached: false,
      executiveSummary: null,
      // the read carries the field and it is empty: an input (update_vdp_header takes it since vdp-app #11)
      entitlementLeveraged: null,
    });
  }
  // a VDP I am on whose account has no open 100%-DC opp of mine (only a 50% one): past, not checked
  const half = accounts.find((a) => !engagedAccounts([a], opps).length && opps.some((o) => o.accountId === a.id && o.isOpen && o.myDc && o.myDc.split !== 100));
  if (half) {
    const slug = slugOf(half.name, 2);
    out.push({
      id: uid(2),
      slug,
      url: `${MOCK_VDP_BASE}/vdp/${slug}`,
      company: { id: uid(101), name: half.name, slug: slugOf(half.name, 0), industry: half.industry, segment: null },
      fiscalYear: 27,
      fiscalQuarter: 3,
      salesforceAccountId: org62(half.org62Url, '001'),
      salesforceOpportunityId: null,
      salesforceOpportunityIds: [],
      isSeed: false,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      aes: [{ email: 'ae@example.com', name: 'AE Placeholder', placeholder: true }],
      tas: [meP],
      createdBy: meP,
      collaborators: [],
      useCases: [placeholderUseCase(3, { title: 'Placeholder past use case', priority: '1 - Low', division: 'IT', persona: 'Architect', detailsInput: 'Placeholder details.', hasAi: true, generatedFields: { executive_summary: 'Placeholder.' } })],
      stakeholders: [],
      assets: [],
      dcNoteCached: true,
      executiveSummary: null,
    });
  }
  return out;
}

/**
 * The placeholder Specialist Forecast AEs per local opp id (D-63): the first engaged account's opps have a Data Cloud
 * and an Agentforce owner, the second's a BtL Data Cloud one; the rest have none (their AE is an input).
 */
export function mockSpecialistAes(accounts: Account[], opps: Opportunity[]): Map<string, SpecialistAe[]> {
  const out = new Map<string, SpecialistAe[]>();
  const eng = engagedAccounts(accounts, opps);
  const [a, b] = eng;
  if (a?.os[0]) out.set(a.os[0].id, [{ email: 'dc.ae@example.com', name: 'Data Cloud AE Placeholder', type: 'Data Cloud' }]);
  if (a?.os[1]) out.set(a.os[1].id, [{ email: 'af.ae@example.com', name: 'Agentforce AE Placeholder', type: 'Agentforce' }, { email: 'dc.ae@example.com', name: 'Data Cloud AE Placeholder', type: 'BtL Data Cloud' }]);
  if (b?.os[0]) out.set(b.os[0].id, [{ email: 'btl.ae@example.com', name: 'BtL Data Cloud AE Placeholder', type: 'BtL Data Cloud' }]);
  return out;
}

// ---------------------------------------------------------------------------
// Asset candidates (Time ▸ VDP details ▸ Assets to add), placeholders only
// ---------------------------------------------------------------------------


const slack = (channel: string, n: number, at: string): VdpCandidateSource => ({ source: 'slack', label: `#${channel}`, url: `https://example.slack.com/archives/C0PLACEHOLDER/p${1700000000000000 + n}`, at });

function cand(n: number, o: Omit<CandidateRecord, 'id' | 'assetKey' | 'statusAt'> & { statusAt?: string | null }): CandidateRecord {
  return { id: uid(5000 + n), assetKey: assetKeyOf(o.url), statusAt: o.statusAt ?? null, ...o };
}

const channelOf = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account'}-ext`;

/**
 * What the matcher would have found on the placeholder VDPs: on the first VDP a deck (suggested) and a recording
 * (unsure: only the message mentions the account); on the first engaged account without a VDP, a doc that waits for it.
 */
export function mockVdpCandidates(snaps: VdpSnapshot[], targets: Array<{ accountId: string | null; vdpSlug: string | null; companyName: string }>, now: string): CandidateRecord[] {
  const out: CandidateRecord[] = [];
  const first = snaps[0];
  const t1 = first ? targets.find((t) => t.vdpSlug === first.slug) : undefined;
  if (first && t1) {
    const ch = channelOf(t1.companyName);
    out.push(
      cand(1, { targetKey: t1.accountId ?? `vdp:${first.slug}`, vdpSlug: first.slug, accountId: t1.accountId, companyName: t1.companyName, title: `${t1.companyName} · Discovery readout (placeholder)`, url: 'https://docs.google.com/presentation/d/PLACEHOLDER0DECK000000000001/edit', kind: 'deck', why: `Shared in #${ch}: its title names ${t1.companyName}`, confidence: 0.85, origin: 'matcher', status: 'suggested', sources: [slack(ch, 1, now)], firstSeenAt: now }),
      cand(2, { targetKey: t1.accountId ?? `vdp:${first.slug}`, vdpSlug: first.slug, accountId: t1.accountId, companyName: t1.companyName, title: `${t1.companyName} demo recording (placeholder)`, url: 'https://zoom.us/rec/share/PLACEHOLDER-REC-0001', kind: 'recording', why: `Shared in a DM: the message mentions ${t1.companyName}`, confidence: 0.55, origin: 'matcher', status: 'unsure', sources: [{ source: 'slack', label: 'DM · AE Placeholder', url: 'https://example.slack.com/archives/D0PLACEHOLDER/p1700000000000002', at: now }], firstSeenAt: now }),
    );
  }
  const orphan = targets.find((t) => !t.vdpSlug && t.accountId);
  if (orphan) {
    out.push(cand(3, { targetKey: orphan.accountId!, vdpSlug: null, accountId: orphan.accountId, companyName: orphan.companyName, title: `${orphan.companyName} · Architecture overview (placeholder)`, url: 'https://docs.google.com/document/d/PLACEHOLDER0DOC0000000000003/edit', kind: 'doc', why: `A Drive file: its title names ${orphan.companyName}`, confidence: 0.8, origin: 'matcher', status: 'suggested', sources: [{ source: 'drive', label: 'Drive', url: 'https://docs.google.com/document/d/PLACEHOLDER0DOC0000000000003/edit', at: now }], firstSeenAt: now }));
  }
  return out;
}

/** What a simulated "Find assets" run finds for one target (deterministic per run number). */
export function mockBackfillFinds(t: { key: string; accountId: string | null; vdpSlug: string | null; companyName: string }, run: number, now: string): CandidateRecord[] {
  const ch = channelOf(t.companyName);
  const base = 6000 + run * 10;
  const pad = (n: number) => String(base + n).padStart(6, '0');
  const common = { targetKey: t.key, vdpSlug: t.vdpSlug, accountId: t.accountId, companyName: t.companyName, origin: 'backfill' as const, firstSeenAt: now };
  return [
    cand(base + 1, { ...common, title: `${t.companyName} · Solution overview (placeholder)`, url: `https://docs.google.com/presentation/d/PLACEHOLDER0BACKFILL${pad(1)}/edit`, kind: 'deck', why: `Presented in the ${t.companyName} workshop (Calendar attachment)`, confidence: 0.9, status: 'suggested', sources: [{ source: 'calendar', label: `Calendar · ${t.companyName} workshop`, url: 'https://calendar.google.com/calendar/event?eid=PLACEHOLDER', at: now }] }),
    cand(base + 2, { ...common, title: `${t.companyName} · Consumption estimate (placeholder)`, url: `https://docs.google.com/spreadsheets/d/PLACEHOLDER0BACKFILL${pad(2)}/edit`, kind: 'sheet', why: `Sent to the AE in #${ch} with the pricing thread`, confidence: 0.8, status: 'suggested', sources: [slack(ch, base + 2, now)] }),
    cand(base + 3, { ...common, title: 'Demo walkthrough · loom.com', url: `https://www.loom.com/share/PLACEHOLDER${pad(3)}`, kind: 'recording', why: `Linked in a Gmail thread that mentions ${t.companyName}`, confidence: 0.6, status: 'unsure', sources: [{ source: 'gmail', label: 'Gmail · Re: demo follow-up', url: 'https://mail.google.com/mail/u/0/#inbox/PLACEHOLDER', at: now }] }),
  ];
}

// ---------------------------------------------------------------------------
// The server's tools and company matches (D-59 feature detection), placeholders only
// ---------------------------------------------------------------------------

/**
 * The VDP tools upstream main ships (D-63), with their argument names as `tools/list` reports them (lib/mcp/server.ts):
 * the D-59 writes included, and (D-69) vdp-app #11's entitlement_leveraged, sales_segment_id and list_sales_segments.
 */
export const SHIPPED_VDP_TOOLS: VdpServerTool[] = [
  { name: 'add_vdp_asset', args: ['asset_type', 'deliverable_type', 'description', 'title', 'url', 'vdp_id'] },
  { name: 'create_company', args: ['aliases', 'industry_category_id', 'name', 'sales_segment_id', 'website'], required: ['name'] },
  { name: 'create_use_case', args: ['details_input', 'division', 'persona', 'priority', 'title', 'track', 'vdp_id'] },
  { name: 'create_vdp', args: ['company_id', 'entitlement_leveraged', 'fiscal_quarter', 'fiscal_year', 'salesforce_account_id', 'salesforce_opportunity_id', 'salesforce_opportunity_ids'], required: ['company_id'] },
  { name: 'generate_use_case', args: ['regenerate', 'use_case_id', 'vdp_id'] },
  { name: 'get_use_case', args: ['id'] },
  { name: 'get_vdp', args: ['slug'] },
  { name: 'get_vdp_assets', args: ['vdp_id'] },
  { name: 'list_asset_types', args: [] },
  { name: 'list_companies', args: ['archived', 'limit', 'offset', 'q', 'query', 'search'] },
  { name: 'list_industries', args: [] },
  { name: 'list_sales_segments', args: [] },
  { name: 'get_company', args: ['slug'] },
  { name: 'search_vdps', args: ['company_id', 'include_archived', 'limit', 'offset', 'q'] },
  { name: 'set_vdp_owners', args: ['account_executives', 'technical_architects', 'vdp_id'] },
  { name: 'update_use_case', args: ['details_input', 'division', 'execution_duration_days', 'execution_duration_unit', 'execution_duration_value', 'execution_phase', 'execution_start_date', 'execution_target_date', 'id', 'persona', 'priority', 'title'] },
  { name: 'update_vdp_header', args: ['add_opportunity_ids', 'entitlement_leveraged', 'fiscal_quarter', 'fiscal_year', 'opportunity_order', 'remove_opportunity_ids', 'salesforce_account_id', 'salesforce_opportunity_id', 'vdp_id'], required: ['vdp_id'] },
];

// ---------------------------------------------------------------------------
// D-69: company identity, placeholders only (the Org62 hierarchy, VDP's companies, a judgment, your mapping)
// ---------------------------------------------------------------------------

/**
 * The companies the placeholder VDP holds (list_companies answers by substring, like upstream): Globex (the second
 * engaged account's company, and its " - Marketing Cloud" child's), Tyrell Holdings (Nexus Care's Org62 parent: a
 * subsidiary brand the judgment keeps separate), two companies that are one name by VDP's rule (Cyberdyne: "Needs
 * you"), and Soylent Corporation (picked for Soylent Foods with Change…). Initech has none (created).
 */
export const MOCK_VDP_COMPANIES: Array<{ id: string; name: string; slug: string; aliases: string[]; vdpCount: number }> = [
  { id: uid(200), name: 'Globex', slug: 'globex-0', aliases: [], vdpCount: 0 },
  { id: uid(201), name: 'Tyrell Holdings', slug: 'tyrell-holdings-0', aliases: ['Tyrell'], vdpCount: 0 },
  { id: uid(202), name: 'Cyberdyne Systems', slug: 'cyberdyne-systems-0', aliases: [], vdpCount: 0 },
  { id: uid(203), name: 'Cyberdyne Systems, Inc.', slug: 'cyberdyne-systems-inc-0', aliases: ['CSI'], vdpCount: 0 },
  { id: uid(204), name: 'Soylent Corporation', slug: 'soylent-corporation-0', aliases: [], vdpCount: 0 },
];

/** Org62 parents outside my book (placeholder ids on the fake 001XX… pattern). */
const OUTSIDE_PARENTS: Record<string, { id: string; name: string }> = {
  'Nexus Care': { id: '001XX0000SEED90AAA', name: 'Tyrell Holdings' },
  'Cyberdyne Systems - Robotics': { id: '001XX0000SEED91AAA', name: 'Cyberdyne Systems' },
};

/**
 * The placeholder Org62 hierarchy: every seed account with an Org62 id, its parent where it has one: "Globex -
 * Marketing Cloud" under Globex (in my book), Nexus Care under Tyrell Holdings and "Cyberdyne Systems - Robotics" under
 * Cyberdyne Systems (outside my book). The others are their own top.
 */
export function mockAccountHierarchy(accounts: Account[], now: string): AccountHierarchy {
  const nodes: AccountHierarchy['nodes'] = {};
  const idOf = (a: Account) => org62(a.org62Url, '001')?.slice(0, 15) ?? null;
  const globex = accounts.find((a) => a.name === 'Globex');
  for (const a of accounts) {
    const id = idOf(a);
    if (!id) continue;
    const out = OUTSIDE_PARENTS[a.name];
    const parentId = out ? out.id.slice(0, 15) : a.name.startsWith('Globex - ') && globex ? idOf(globex) : null;
    nodes[id] = { id, name: a.name, parentId };
    if (out) nodes[out.id.slice(0, 15)] = { id: out.id.slice(0, 15), name: out.name, parentId: null };
  }
  return { readAt: now, nodes, read: Object.keys(nodes) };
}

/** VDP's answer to `list_companies q` (a substring of the name or an alias, active companies), as a stored lookup. */
function lookupOf(q: string, now: string): VdpCompanyLookup {
  const k = q.toLowerCase();
  return { query: q, at: now, matches: MOCK_VDP_COMPANIES.filter((c) => c.name.toLowerCase().includes(k) || c.aliases.some((x) => x.toLowerCase().includes(k))).map((c) => ({ id: c.id, name: c.name, slug: c.slug, aliases: c.aliases, vdpCount: c.vdpCount, vdpSlugs: [] })) };
}

/** The placeholder Deliverable types (`list_asset_types` deliverable_types): generic labels, no customer data. */
export const MOCK_DELIVERABLE_TYPES: readonly string[] = ['Use Case', 'Solution/Technical', 'Consumption', 'QBR', 'Executive Briefing', 'Discovery'];

/**
 * What the placeholder VDP server reports: the shipped tools, its asset lookups (`list_asset_types`: VDP's asset types
 * and a few Deliverable types), two sales segments, and a lookup for every name up the Org62 chains of the engaged
 * accounts no VDP links (D-69), answered from MOCK_VDP_COMPANIES.
 */
export function mockVdpServer(accounts: Account[], opps: Opportunity[], snaps: VdpSnapshot[], now: string): VdpServerInfo {
  const ents = gapEntities(accounts, opps);
  const queries = identityQueries({ accounts: ents.accounts, opps: ents.opps, vdps: snaps, hierarchy: mockAccountHierarchy(accounts, now), overrides: [] });
  return {
    tools: SHIPPED_VDP_TOOLS,
    deliverableTypes: [...MOCK_DELIVERABLE_TYPES],
    assetTypes: [...VDP_ASSET_TYPES],
    companies: queries.map((q) => lookupOf(q, now)),
    salesSegments: [
      { id: uid(300), slug: 'enterprise', label: 'Enterprise' },
      { id: uid(301), slug: 'commercial', label: 'Commercial' },
    ],
    readAt: now,
  };
}

/** VDP's company search for Change… (the placeholder companies plus the ones the mirror names), by name or alias. */
export function mockCompanySearch(q: string): VdpCompanyMatch[] {
  return lookupOf(q.trim(), new Date(0).toISOString()).matches;
}

/**
 * The placeholder override: Soylent Foods mapped by you (Change…) to VDP's "Soylent Corporation". Its own name finds
 * nothing in VDP, so without it the app would create "Soylent Foods".
 */
export function mockIdentityOverrides(accounts: Account[], now: string): IdentityOverride[] {
  const soylent = accounts.find((a) => a.name === 'Soylent Foods');
  const c = MOCK_VDP_COMPANIES.find((x) => x.name === 'Soylent Corporation')!;
  return soylent ? [{ key: `account:${soylent.id}`, accountIds: [soylent.id], pick: { kind: 'match', id: c.id, name: c.name }, at: now }] : [];
}

/**
 * The placeholder judgment (the vdp-company-identity skill's cached decision): Nexus Care is a brand of its own under
 * Tyrell Holdings, so it stays a company of its own. Built for the unit's current hash, so it applies as cached.
 */
export function mockIdentityJudgments(units: ReadonlyMap<string, JudgmentRequest>, now: string): Record<string, IdentityJudgment> {
  const out: Record<string, IdentityJudgment> = {};
  for (const u of units.values()) {
    const nexus = u.accounts.find((a) => a.name === 'Nexus Care');
    if (!nexus) continue;
    out[u.key] = { hash: u.hash, at: now, model: 'claude-haiku-5-5', accounts: [{ accountId: nexus.id, pick: { kind: 'create', name: 'Nexus Care', aliases: [] }, level: 0, confidence: 0.86, reason: 'Its own brand under Tyrell Holdings: a company of its own' }] };
  }
  return out;
}

/**
 * D-70: a placeholder Org62 read-back for the app's mock (CC_MOCK_UC_DEMO, on outside tests like the read-in demo), so
 * Activity ▸ Org62 ▸ Use cases shows every case: the first VDP's first titled use case is in both systems, linked, with
 * a Stage both sides changed since they agreed (you pick); a use case Org62 has on the same opp that VDP does not; the
 * rest are VDP only. Placeholder ids; the mock never calls Org62.
 */
export function mockOrg62UseCaseDemo(snaps: readonly VdpSnapshot[], me: string, now: string): { records: Org62UseCase[]; links: UseCaseLink[] } {
  const v = snaps.find((s) => !s.isSeed && !s.archivedAt && s.useCases.some((u) => u.title?.trim()));
  const uc = v?.useCases.find((u) => u.title?.trim());
  const opp = v?.salesforceOpportunityIds?.[0] ?? v?.salesforceOpportunityId ?? null;
  if (!v || !uc || !opp) return { records: [], links: [] };
  const at = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  const both: Org62UseCase = { id: 'a1XXX0000000DM1AAA', opportunityId: opp, accountId: v.salesforceAccountId, name: uc.title!.trim(), ownerId: me, createdById: me, stage: 'U03 - Scoping', goLive: uc.executionTargetDate?.slice(0, 10) ?? null, product: uc.track === 'agentforce' ? 'Agentforce' : 'Data Cloud', createdAt: at, goneAt: null };
  const only: Org62UseCase = { id: 'a1XXX0000000DM2AAA', opportunityId: opp, accountId: v.salesforceAccountId, name: 'Placeholder Org62 use case', ownerId: me, createdById: me, stage: 'U02 - Ideation', goLive: null, product: 'Data Cloud', createdAt: at, goneAt: null };
  return { records: [both, only], links: [{ vdpUseCaseId: uc.id, org62UseCaseId: both.id, origin: 'adopted', syncedStage: 'U01 - Not Started', syncedGoLive: both.goLive, syncedName: both.name }] };
}
