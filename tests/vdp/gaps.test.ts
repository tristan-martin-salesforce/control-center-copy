/**
 * The VDP gap check (pure): every rule, linking by Org62 id / account / name over every opp a VDP links, the scope,
 * the feature detection, and the account-level gaps. Placeholders only.
 *
 * D-63 (2026-11-12): scope = open opps where my DC split is 100% (50% and team-only create nothing); a seed VDP is
 * writable when I am on it, hidden when I am not; every fix is an app fix (disabled, with the reason, when VDP's MCP
 * doesn't list the tool or argument); the DC note, duplicate use cases and asset links are no longer checked; the AE
 * comes from the opp's Specialist Forecast; the execution phase and target date are inputs; a company VDP lacks is
 * created, then its VDP, then what the VDP needs.
 */
import { describe, expect, it } from 'vitest';

import { companyKey, computeVdpGaps, isEngaged, linkVdp, listedVdp, missingCodes, salesSegmentFor, sameUseCaseTitle, sfFiscalPeriod, specialistAesFor, vdpScope } from '../../src/engines/vdp/gaps';
import { NO_SERVER_INFO, vdpCapabilities } from '../../src/lib/vdp/capabilities';
import type { VdpServerInfo } from '../../src/lib/vdp/types';
import { SHIPPED_VDP_TOOLS } from '../../src/mock/vdp';
import { accounts, NOW, opp, opps, uc, vdp } from './gap-fixtures';

const me = { name: 'Me Placeholder', email: 'me@example.com' };
const base = { accounts, opps, me, vdpBaseUrl: 'https://vdp.example.test', now: NOW };
const codes = (r: ReturnType<typeof computeVdpGaps>) => r.vdps.flatMap((v) => v.gaps.map((g) => g.id));
const server = (o: Partial<VdpServerInfo> = {}): VdpServerInfo => ({ tools: SHIPPED_VDP_TOOLS, deliverableTypes: null, companies: [], readAt: NOW, ...o });
const fixOf = (r: ReturnType<typeof computeVdpGaps>, id: string) => [...r.vdps.flatMap((v) => v.gaps), ...r.unlinked].find((g) => g.id === id)?.fix;

describe('linking', () => {
  it('by Org62 id (15/18 forms agree), then by the opp account, then by company name', () => {
    expect(linkVdp(vdp(), accounts, opps)).toEqual({ accountId: 'A1', opportunityId: 'O1', opportunityName: 'Opp O1', opportunityIds: ['O1'] });
    expect(linkVdp(vdp({ salesforceAccountId: null }), accounts, opps).accountId).toBe('A1'); // via O1's account
    expect(linkVdp(vdp({ salesforceAccountId: null, salesforceOpportunityId: null, company: { id: null, name: 'Globex Placeholder LLC', slug: null, industry: null, segment: null } }), accounts, opps)).toEqual({ accountId: 'A2', opportunityId: null, opportunityName: null, opportunityIds: [] });
    expect(companyKey('The Acme Placeholder, Inc.')).toBe(companyKey('acme placeholder'));
  });

  it('every opp on a multi-opp VDP is linked, not only the first (salesforceOpportunityIds)', () => {
    const more = [...opps, opp({ id: 'O4', org62OpportunityId: '006DDDDDDDDDDDD' })];
    const v = vdp({ salesforceOpportunityId: '006AAAAAAAAAAAA', salesforceOpportunityIds: ['006AAAAAAAAAAAA', '006DDDDDDDDDDDDQQQ'] });
    expect(linkVdp(v, accounts, more)).toMatchObject({ opportunityId: 'O1', opportunityIds: ['O1', 'O4'] });
    const r = computeVdpGaps({ ...base, opps: more, vdps: [v] });
    expect(r.unlinked.map((g) => g.code)).toEqual(['company_not_in_vdp', 'opp_without_vdp', 'no_ae', 'no_ta', 'no_use_case', 'no_ai_fields']); // Globex, created with what it needs
    expect(r.vdps[0]).toMatchObject({ opportunityIds: ['O1', 'O4'], opportunityNames: ['Opp O1', 'Opp O4'] });
  });

  it('Salesforce fiscal periods: FY runs Feb–Jan', () => {
    expect(sfFiscalPeriod('2026-02-01')).toEqual({ fiscalYear: 27, fiscalQuarter: 1 });
    expect(sfFiscalPeriod('2026-10-31')).toEqual({ fiscalYear: 27, fiscalQuarter: 3 });
    expect(sfFiscalPeriod('2026-12-15')).toEqual({ fiscalYear: 27, fiscalQuarter: 4 });
    expect(sfFiscalPeriod('2027-01-31')).toEqual({ fiscalYear: 27, fiscalQuarter: 4 });
  });
});

describe('D-63 scope: open opps where my DC split is 100%', () => {
  it('engaged = open and 100%; a 50% DC, no DC and a closed opp are not', () => {
    expect(isEngaged({ isOpen: true, dcSplit: 100 })).toBe(true);
    expect(isEngaged({ isOpen: true, dcSplit: 50 })).toBe(false);
    expect(isEngaged({ isOpen: true, dcSplit: null })).toBe(false);
    expect(isEngaged({ isOpen: false, dcSplit: 100 })).toBe(false);
  });

  it('a 50% DC or a team-only opp creates nothing: no company, no VDP, no add', () => {
    const half = opps.map((o) => (o.id === 'O2' ? { ...o, dcSplit: 50 } : o));
    const r = computeVdpGaps({ ...base, opps: [...half, opp({ id: 'O5', dcSplit: null, org62OpportunityId: '006EEEEEEEEEEEE' })], vdps: [vdp()] });
    expect(r.unlinked).toEqual([]);
    expect(codes(r)).toEqual([]);
  });

  it('a VDP I am on is checked only while its account has an open 100%-DC opp of mine; VD-11: a current one before the DC waits for it, never Past', () => {
    const half = opps.map((o) => (o.id === 'O1' ? { ...o, dcSplit: 50 } : o));
    const r = computeVdpGaps({ ...base, opps: half, vdps: [vdp({ aes: [], tas: [], useCases: [] })] });
    expect(r.vdps[0]).toMatchObject({ scope: 'waiting_dc', gaps: [] });
    expect(vdpScope({ fiscalYear: 27, fiscalQuarter: 4 }, [{ isOpen: true }], NOW, false)).toBe('waiting_dc');
    // no open opp at all on the account, or an old period on closed opps: past
    expect(vdpScope({ fiscalYear: 27, fiscalQuarter: 4 }, [], NOW, false, false)).toBe('past');
    expect(vdpScope({ fiscalYear: 26, fiscalQuarter: 2 }, [{ isOpen: false }], NOW, false, true)).toBe('past');
  });

  it('with an engaged account: this period or later, or an open linked opp; an old period on closed opps is past', () => {
    const open = [{ isOpen: true }];
    const closed = [{ isOpen: false }];
    expect(vdpScope({ fiscalYear: 27, fiscalQuarter: 4 }, closed, NOW)).toBe('current');
    expect(vdpScope({ fiscalYear: 28, fiscalQuarter: 1 }, closed, NOW)).toBe('current');
    expect(vdpScope({ fiscalYear: 27, fiscalQuarter: 2 }, closed, NOW)).toBe('past');
    expect(vdpScope({ fiscalYear: 27, fiscalQuarter: 2 }, open, NOW)).toBe('current');
    expect(vdpScope({ fiscalYear: null, fiscalQuarter: null }, [], NOW)).toBe('current');
    expect(vdpScope({ fiscalYear: null, fiscalQuarter: null }, closed, NOW)).toBe('past');
  });

  it('seed VDPs: writable when I am their AE, TA or a collaborator; one I am not on is not listed at all', () => {
    const seedMine = vdp({ isSeed: true, useCases: [uc('u1', { persona: null })] });
    const r = computeVdpGaps({ ...base, vdps: [seedMine] });
    expect(fixOf(r, 'acme:use_case_field:u1:persona')).toMatchObject({ kind: 'app', op: 'update_use_case', unsupported: null });
    const seedOther = vdp({ isSeed: true, aes: [{ email: 'other@example.com', name: 'Other', placeholder: false }], tas: [], createdBy: { email: 'me@example.com', name: 'Me', placeholder: false } });
    expect(computeVdpGaps({ ...base, vdps: [seedOther] }).vdps).toEqual([]);
    expect(listedVdp(seedOther, ['me@example.com'])).toBe(false);
    expect(listedVdp({ ...seedOther, collaborators: [{ email: 'ME@example.com', name: null, placeholder: false }] }, ['me@example.com'])).toBe(true);
    // my aliases count
    expect(computeVdpGaps({ ...base, myEmails: ['other@example.com'], vdps: [seedOther] }).vdps).toHaveLength(1);
  });

  it('archived VDPs are skipped', () => {
    expect(computeVdpGaps({ ...base, vdps: [vdp({ archivedAt: '2026-10-01T00:00:00.000Z', aes: [] })] }).vdps).toEqual([]);
  });
});

describe('gap rules', () => {
  it('a complete VDP has no gaps', () => {
    const r = computeVdpGaps({ ...base, vdps: [vdp()] });
    expect(codes(r)).toEqual([]);
    expect(r.vdps[0]).toMatchObject({ accountId: 'A1', opportunityId: 'O1', useCaseCount: 1, useCaseWithAiCount: 1, assetCount: 1, hasAe: true, hasTa: true, scope: 'current' });
  });

  it('missing use-case inputs (the execution phase and target date included) are update_use_case fixes, one per field, no guesses', () => {
    const r = computeVdpGaps({ ...base, vdps: [vdp({ useCases: [uc('u1', { persona: null, priority: '  ', title: null, executionPhase: null, executionTargetDate: null })] })] });
    const g = r.vdps[0]!.gaps;
    expect(g.map((x) => x.id)).toEqual(['acme:use_case_field:u1:title', 'acme:use_case_field:u1:priority', 'acme:use_case_field:u1:persona', 'acme:use_case_field:u1:execution_phase', 'acme:use_case_field:u1:execution_target_date']);
    expect(g[1]!.fix).toEqual({ kind: 'app', op: 'update_use_case', field: 'priority', current: null, suggested: null, options: ['3 - High', '2 - Medium', '1 - Low'], values: {}, known: false, unsupported: null });
    expect(g[3]!.fix).toMatchObject({ field: 'execution_phase', suggested: null, options: ['Not Started', 'Discovery', 'Build', 'Live', 'On Hold'] });
    expect(g[0]).toMatchObject({ severity: 'high', useCaseId: 'u1', useCaseTitle: 'Untitled D360 use case' });
  });

  it('details are not flagged from an index-only row (get_use_case not read yet)', () => {
    const r = computeVdpGaps({ ...base, vdps: [vdp({ useCases: [uc('u1', { detailsInput: null, detailLoaded: false })] })] });
    expect(codes(r)).toEqual([]);
  });

  it('no use case: create_use_case, and its Generate (the new use case’s id is passed down)', () => {
    const r = computeVdpGaps({ ...base, vdps: [vdp({ useCases: [] })] });
    expect(r.vdps[0]!.gaps).toEqual([
      expect.objectContaining({ id: 'acme:no_use_case', code: 'no_use_case', severity: 'high', title: 'Add a use case', fix: expect.objectContaining({ kind: 'app', op: 'create_use_case' }) }),
      expect.objectContaining({ id: 'acme:no_ai_fields:new', code: 'no_ai_fields', useCaseId: null, fix: expect.objectContaining({ op: 'generate_use_case', known: true }) }),
    ]);
  });

  it('D-63: AI fields, AE, TA are app fixes (upstream ships the tools); no assets is the in-app Find assets', () => {
    const aes = new Map([['O1', [{ email: 'af.ae@example.com', name: 'AF AE', type: 'Agentforce' }, { email: 'dc.ae@example.com', name: 'DC AE', type: 'Data Cloud' }]]]);
    const r = computeVdpGaps({ ...base, aesByOpp: aes, vdps: [vdp({ aes: [], tas: [], assets: [], useCases: [uc('u1', { hasAi: false })] })] });
    const by = Object.fromEntries(r.vdps[0]!.gaps.map((g) => [g.code, g]));
    // the Specialist Forecast's AEs, Data Cloud first, then Agentforce: known (autopilot may set them)
    expect(by.no_ae!.fix).toMatchObject({ kind: 'app', op: 'set_vdp_owners', field: 'account_executives', suggested: ['dc.ae@example.com', 'af.ae@example.com'], known: true, unsupported: null });
    expect(by.no_ae!.title).toBe('AE: DC AE, AF AE');
    expect(by.no_ta!.fix).toMatchObject({ kind: 'app', op: 'set_vdp_owners', field: 'technical_architects', suggested: ['me@example.com'], known: true });
    expect(by.no_ai_fields!.fix).toMatchObject({ kind: 'app', op: 'generate_use_case', known: true, unsupported: null });
    expect(by.no_assets!.fix).toEqual({ kind: 'in_app', action: 'find_assets', label: 'Find assets' });
    expect(r.counts.handoffs).toBe(0);
  });

  it('D-63: no Specialist Forecast names an AE: an input (no guess, never the core opp owner)', () => {
    const r = computeVdpGaps({ ...base, vdps: [vdp({ aes: [] })] });
    expect(fixOf(r, 'acme:no_ae')).toMatchObject({ suggested: null, known: false });
    expect(r.vdps[0]!.gaps[0]!.title).toBe('AE: no Specialist Forecast on the opportunity');
  });

  it('specialistAesFor: Data Cloud owners first, then Agentforce, deduplicated by email; other types are not VDP AEs', () => {
    const m = new Map([
      ['O1', [{ email: 'AF@example.com', name: 'AF', type: 'BtL Agentforce' }, { email: 'svc@example.com', name: 'Svc', type: 'Service Cloud' }]],
      ['O2', [{ email: 'dc@example.com', name: 'DC', type: 'BtL Data Cloud' }, { email: 'af@example.com', name: 'AF', type: 'Agentforce' }]],
    ]);
    expect(specialistAesFor(['O1', 'O2'], m).map((a) => a.email)).toEqual(['dc@example.com', 'af@example.com']);
    expect(specialistAesFor(['O3'], m)).toEqual([]);
  });

  it('D-63: dropped checks: no DC note, no duplicate use cases, no bad or repeated asset links', () => {
    const r = computeVdpGaps({
      ...base,
      vdps: [vdp({ dcNoteCached: false, useCases: [uc('u1', { title: 'Order status agent' }), uc('u2', { title: 'Order status agent' })], assets: [{ id: 'a1', title: 'x', url: 'file:///nope', type: null, description: null }, { id: 'a2', title: 'y', url: 'https://docs.example.com/d/1', type: null, description: null }, { id: 'a3', title: 'z', url: 'https://docs.example.com/d/1', type: null, description: null }] })],
    });
    expect(codes(r)).toEqual([]);
  });

  it('no opp link and nothing engaged to add: an input; engaged opps of the account are each an "Add"', () => {
    // a second VDP of the account when its engaged opp is on the first: nothing to add, so the link is an input
    const lone = computeVdpGaps({ ...base, vdps: [vdp(), vdp({ id: 'v2', slug: 'acme-2', salesforceOpportunityId: null, salesforceOpportunityIds: [] })] });
    expect(lone.vdps.find((v) => v.vdpSlug === 'acme-2')!.gaps.map((g) => g.code)).toEqual(['no_opp_link']);
    const r = computeVdpGaps({ ...base, opps: [...opps, opp({ id: 'O4', org62OpportunityId: '006DDDDDDDDDDDD' })], vdps: [vdp({ salesforceOpportunityId: null })] });
    expect(r.vdps[0]!.gaps.map((g) => g.id)).toEqual(['opp:O1:opp_not_on_vdp', 'opp:O4:opp_not_on_vdp']);
    expect(r.vdps[0]!.gaps[0]!.fix).toMatchObject({ op: 'update_vdp_header', field: 'add_opportunity_ids', suggested: ['006AAAAAAAAAAAA'], known: true });
  });

  it('no fiscal period: app fixes, suggested from the linked opp close date', () => {
    const r = computeVdpGaps({ ...base, vdps: [vdp({ fiscalYear: null, fiscalQuarter: null })] });
    expect(r.vdps[0]!.gaps.map((g) => [g.id, g.fix.kind === 'app' ? g.fix.suggested : null])).toEqual([
      ['acme:no_fiscal_period:fiscal_year', 27],
      ['acme:no_fiscal_period:fiscal_quarter', 4],
    ]);
  });

  it('no Org62 account id is an app fix suggested from the linked account', () => {
    const r = computeVdpGaps({ ...base, vdps: [vdp({ salesforceAccountId: null })] });
    expect(r.vdps[0]!.gaps).toEqual([expect.objectContaining({ id: 'acme:no_account_id', code: 'no_account_id', fix: expect.objectContaining({ kind: 'app', op: 'update_vdp_header', field: 'salesforce_account_id', suggested: '001AAAAAAAAAAAAQQQ' }) })]);
  });

  it('D-63: a closed-lost linked opp: remove_opportunity_ids, a suggestion (the id VDP holds)', () => {
    const lost = [...opps.map((o) => (o.id === 'O1' ? { ...o, isOpen: false, isWon: false } : o)), opp({ id: 'O5', org62OpportunityId: '006EEEEEEEEEEEE' })];
    const r = computeVdpGaps({ ...base, opps: lost, vdps: [vdp({ salesforceOpportunityIds: ['006AAAAAAAAAAAAXYZ', '006EEEEEEEEEEEE'] })] });
    const g = r.vdps[0]!.gaps.find((x) => x.code === 'wrong_opp_link')!;
    expect(g).toMatchObject({ check: 'wrong', title: 'Remove Opp O1', why: 'Opp O1 is closed lost in Org62', fix: { kind: 'app', op: 'update_vdp_header', field: 'remove_opportunity_ids', suggested: ['006AAAAAAAAAAAAXYZ'], unsupported: null } });
    // a server that lists the header without the argument: disabled, with why
    const old = server({ tools: SHIPPED_VDP_TOOLS.map((t) => (t.name === 'update_vdp_header' ? { ...t, args: t.args.filter((a) => a !== 'remove_opportunity_ids') } : t)) });
    const off = computeVdpGaps({ ...base, opps: lost, vdps: [vdp({ salesforceOpportunityIds: ['006AAAAAAAAAAAAXYZ', '006EEEEEEEEEEEE'] })], server: old, capabilities: vdpCapabilities(old) });
    expect(off.vdps[0]!.gaps.find((x) => x.code === 'wrong_opp_link')!.fix).toMatchObject({ unsupported: "VDP's MCP can't take this yet: update_vdp_header.remove_opportunity_ids" });
  });

  it('D-63: the entitlement leveraged is an item only when the read carries the field and it is empty; D-69: shipped (vdp-app #11), disabled again when a stored list lacks it', () => {
    expect(codes(computeVdpGaps({ ...base, vdps: [vdp()] }))).toEqual([]); // the field is absent (an older server)
    expect(codes(computeVdpGaps({ ...base, vdps: [vdp({ entitlementLeveraged: 'Flex' })] }))).toEqual([]);
    const r = computeVdpGaps({ ...base, vdps: [vdp({ entitlementLeveraged: null })] });
    // the tool list unknown: vdp-app #11 shipped it, so it is pushable (an input you choose)
    expect(fixOf(r, 'acme:no_entitlement')).toMatchObject({ op: 'update_vdp_header', field: 'entitlement_leveraged', suggested: null, options: ['Data Services', 'Flex', 'Conversations'], unsupported: null });
    const listed = server({ tools: SHIPPED_VDP_TOOLS });
    const on = computeVdpGaps({ ...base, vdps: [vdp({ entitlementLeveraged: null })], server: listed, capabilities: vdpCapabilities(listed) });
    expect(fixOf(on, 'acme:no_entitlement')).toMatchObject({ unsupported: null });
    // a stored list without the argument governs: disabled again, the argument named
    const older = server({ tools: SHIPPED_VDP_TOOLS.map((t) => (t.name === 'update_vdp_header' ? { ...t, args: t.args.filter((a) => a !== 'entitlement_leveraged') } : t)) });
    const off = computeVdpGaps({ ...base, vdps: [vdp({ entitlementLeveraged: null })], server: older, capabilities: vdpCapabilities(older) });
    expect(fixOf(off, 'acme:no_entitlement')).toMatchObject({ unsupported: "VDP's MCP can't take this yet: update_vdp_header.entitlement_leveraged" });
    expect(vdpCapabilities(older)).toMatchObject({ entitlementHeader: false, entitlementCreate: true, salesSegment: true });
    expect(NO_SERVER_INFO).toMatchObject({ entitlementHeader: true, entitlementCreate: true, salesSegment: true });
  });

  it('salesSegmentFor: only an exact name (or slug) match, and only one', () => {
    const list = [
      { id: 's1', slug: 'enterprise', label: 'Enterprise' },
      { id: 's2', slug: 'cmrcl', label: 'Commercial' },
    ];
    expect(salesSegmentFor('enterprise', list)).toBe('s1');
    expect(salesSegmentFor('Enterprise Plus', list)).toBeNull();
    expect(salesSegmentFor(null, list)).toBeNull();
  });
});

describe('feature detection (D-63): shipped tools on while the list is unknown; the stored list governs once read', () => {
  it('capabilities', () => {
    expect(vdpCapabilities(null)).toEqual(NO_SERVER_INFO);
    // D-69: vdp-app #11 shipped the entitlement and the sales segment: on while the list is unknown, like #10's tools
    expect(NO_SERVER_INFO).toMatchObject({ createCompany: true, addAsset: true, setOwners: true, generateUseCase: true, removeOpportunities: true, entitlementHeader: true, entitlementCreate: true, salesSegment: true });
    expect(vdpCapabilities(server())).toMatchObject({ known: true, createVdp: true, addOpportunities: true, removeOpportunities: true, createCompany: true, addAsset: true, setOwners: true, generateUseCase: true, entitlementHeader: true, salesSegment: true });
    const without = (name: string) => server({ tools: SHIPPED_VDP_TOOLS.filter((t) => t.name !== name) });
    expect(vdpCapabilities(without('set_vdp_owners')).setOwners).toBe(false);
    expect(vdpCapabilities(without('create_vdp')).createVdp).toBe(false);
    // a renamed or missing argument keeps it off
    expect(vdpCapabilities(server({ tools: [...SHIPPED_VDP_TOOLS.filter((t) => t.name !== 'set_vdp_owners'), { name: 'set_vdp_owners', args: ['vdp_id', 'ae_emails', 'ta_emails'] }] })).setOwners).toBe(false);
    expect(vdpCapabilities(server({ tools: [...SHIPPED_VDP_TOOLS.filter((t) => t.name !== 'add_vdp_asset'), { name: 'add_vdp_asset', args: ['vdp_id', 'url'] }] })).addAsset).toBe(false);
    // the new D-63 tools only by name AND argument
    const seg = server({ tools: [...SHIPPED_VDP_TOOLS.map((t) => (t.name === 'create_company' ? { ...t, args: [...t.args, 'sales_segment_id'] } : t)), { name: 'list_sales_segments', args: [] }] });
    expect(vdpCapabilities(seg).salesSegment).toBe(true);
    const noArg = SHIPPED_VDP_TOOLS.map((t) => (t.name === 'create_company' ? { ...t, args: t.args.filter((a) => a !== 'sales_segment_id') } : t));
    expect(vdpCapabilities(server({ tools: noArg })).salesSegment).toBe(false);
  });

  it('a listed server without a tool: the same item, disabled with the tool named', () => {
    const v = vdp({ aes: [], tas: [], useCases: [uc('u1', { hasAi: false })] });
    const s = server({ tools: SHIPPED_VDP_TOOLS.filter((t) => t.name !== 'set_vdp_owners' && t.name !== 'generate_use_case') });
    const r = computeVdpGaps({ ...base, vdps: [v], server: s, capabilities: vdpCapabilities(s) });
    const by = Object.fromEntries(r.vdps[0]!.gaps.map((g) => [g.code, g.fix]));
    expect(by.no_ta).toMatchObject({ kind: 'app', op: 'set_vdp_owners', unsupported: "VDP's MCP can't take this yet: set_vdp_owners" });
    expect(by.no_ai_fields).toMatchObject({ kind: 'app', op: 'generate_use_case', unsupported: "VDP's MCP can't take this yet: generate_use_case" });
    expect(r.vdps[0]!.gaps.filter((g) => g.fix.kind === 'app' && !g.fix.unsupported)).toEqual([]);
  });
});

describe('account-level gaps: the company, then the VDP, then what it needs', () => {
  const globexMatch = server({ companies: [{ query: 'Globex Placeholder', at: NOW, matches: [{ id: '00000000-0000-4000-8000-0000000000c2', name: 'Globex Placeholder', slug: 'globex' }] }] });

  it('VDP knows the company: ONE create_vdp with company, account, opps and period, and the new VDP’s people and use case', () => {
    const r = computeVdpGaps({ ...base, opps: [...opps, opp({ id: 'O6', accountId: 'A2', org62OpportunityId: '006FFFFFFFFFFFF', closeDate: '2027-03-01' })], vdps: [vdp()], server: globexMatch, capabilities: vdpCapabilities(globexMatch) });
    expect(r.unlinked.map((g) => g.id)).toEqual(['account:A2:company_not_in_vdp', 'account:A2:no_ae', 'account:A2:no_ta', 'account:A2:no_use_case', 'account:A2:no_ai_fields:new']);
    expect(r.unlinked[0]!.fix).toEqual({
      kind: 'app',
      op: 'create_vdp',
      field: 'company_id',
      current: null,
      suggested: '00000000-0000-4000-8000-0000000000c2',
      options: [],
      values: { fiscal_year: 27, fiscal_quarter: 4, salesforce_account_id: '001BBBBBBBBBBBB', salesforce_opportunity_ids: ['006BBBBBBBBBBBB', '006FFFFFFFFFFFF'] },
      known: true,
      unsupported: null,
    });
    expect(r.unlinked.every((g) => g.vdpSlug === null && g.accountId === 'A2')).toBe(true);
  });

  it('VDP lacks the company: create_company (known only when list_companies found nothing up a read Org62 chain), then the VDP under it', () => {
    const miss = server({ companies: [{ query: 'Globex Placeholder', at: NOW, matches: [] }] });
    const hierarchy = { readAt: NOW, nodes: { '001BBBBBBBBBBBB': { id: '001BBBBBBBBBBBB', name: 'Globex Placeholder', parentId: null } }, read: ['001BBBBBBBBBBBB'] };
    const r = computeVdpGaps({ ...base, vdps: [vdp()], server: miss, capabilities: vdpCapabilities(miss), hierarchy });
    expect(r.unlinked.map((g) => g.id)).toEqual(['account:A2:company_not_in_vdp', 'opp:O2:opp_without_vdp', 'account:A2:no_ae', 'account:A2:no_ta', 'account:A2:no_use_case', 'account:A2:no_ai_fields:new']);
    // create_company takes no Org62 id: only the name (no industry: the server lists no taxonomy)
    expect(r.unlinked[0]!.fix).toEqual({ kind: 'app', op: 'create_company', field: 'name', current: null, suggested: 'Globex Placeholder', options: [], values: {}, known: true, unsupported: null });
    // the VDP's company id is the new company's: no id here, still known (passed in by the push)
    expect(r.unlinked[1]!.fix).toMatchObject({ op: 'create_vdp', suggested: null, known: true, unsupported: null, values: { salesforce_opportunity_ids: ['006BBBBBBBBBBBB'] } });
    // VD-02: no lookup yet: shown, disabled until the next read looks it up (never pushed blind)
    const none = computeVdpGaps({ ...base, vdps: [vdp()] });
    expect(none.unlinked[0]!.fix).toMatchObject({ op: 'create_company', known: false, unsupported: 'Not looked up yet: the next VDP read looks the company up in VDP' });
    // the Org62 parent not read yet: a suggestion you push, never autopilot's
    const unread = computeVdpGaps({ ...base, vdps: [vdp()], server: miss, capabilities: vdpCapabilities(miss) });
    expect(unread.unlinked[0]!.fix).toMatchObject({ op: 'create_company', known: false, unsupported: null });
  });

  it('an engaged opp the account’s current VDP does not link: "Add <opp>" under that VDP (the one for its quarter, else the newest)', () => {
    const r = computeVdpGaps({ ...base, opps: [...opps, opp({ id: 'O5', org62OpportunityId: '006EEEEEEEEEEEE' })], vdps: [vdp()] });
    expect(r.vdps[0]!.gaps.map((g) => g.id)).toEqual(['opp:O5:opp_not_on_vdp']);
    expect(r.vdps[0]!.gaps[0]).toMatchObject({ vdpSlug: 'acme', title: 'Add Opp O5', fix: { kind: 'app', op: 'update_vdp_header', field: 'add_opportunity_ids', suggested: ['006EEEEEEEEEEEE'] } });
    expect(r.unlinked.map((g) => g.accountId)).not.toContain('A1');
    // its Org62 id is not known yet: shown, disabled with why
    const noId = computeVdpGaps({ ...base, opps: [...opps, opp({ id: 'O5' })], vdps: [vdp()] });
    expect(noId.vdps[0]!.gaps[0]!.fix).toMatchObject({ unsupported: 'Its Org62 id is not known yet: the next Org62 read brings it' });
  });

  it('only past VDPs on the account: a new VDP for the loose opps (the company is known from the old one)', () => {
    const closedOpps = [...opps.map((o) => (o.id === 'O1' ? { ...o, isOpen: false } : o)), opp({ id: 'O5', org62OpportunityId: '006EEEEEEEEEEEE' })];
    const r = computeVdpGaps({ ...base, opps: closedOpps, vdps: [vdp({ fiscalYear: 26, fiscalQuarter: 2 })] });
    expect(r.unlinked[0]).toMatchObject({ id: 'opp:O5:opp_without_vdp', fix: { kind: 'app', op: 'create_vdp', suggested: '00000000-0000-4000-8000-0000000000c1', values: { salesforce_opportunity_ids: ['006EEEEEEEEEEEE'] } } });
  });

  it('caps audit: an opp past VDP\'s 20-opportunity limit is told so, not pointed at a create that leaves it off', () => {
    const many = Array.from({ length: 22 }, (_, i) => opp({ id: `M${i}`, org62OpportunityId: `006M${String(i).padStart(11, '0')}`, closeDate: `2026-12-${String(i + 1).padStart(2, '0')}` }));
    const closedOpps = [...opps.map((o) => (o.id === 'O1' ? { ...o, isOpen: false } : o)), ...many];
    const r = computeVdpGaps({ ...base, opps: closedOpps, vdps: [vdp({ fiscalYear: 26, fiscalQuarter: 2 })] });
    const rows = r.unlinked.filter((g) => g.code === 'opp_without_vdp' && g.opportunityId?.startsWith('M'));
    expect(rows).toHaveLength(22);
    const ids = (rows[0]!.fix as unknown as { values: { salesforce_opportunity_ids: string[] } }).values.salesforce_opportunity_ids;
    expect(ids).toHaveLength(20);
    const past = rows.filter((g) => (g.fix as { unsupported: string | null }).unsupported);
    expect(past).toHaveLength(2);
    expect((past[0]!.fix as { unsupported: string }).unsupported).toMatch(/at most 20 opportunities/);
  });

  it('VD-34 use-case titles differing only by a number are different', () => {
    expect(sameUseCaseTitle('Use case 1', 'Use case 2')).toBe(false);
    expect(sameUseCaseTitle('Agent – Phase 1', 'Agent – Phase 2')).toBe(false);
    expect(sameUseCaseTitle('Agent Phase I', 'Agent Phase II')).toBe(false);
    expect(sameUseCaseTitle('Tier B routing', 'Tier C routing')).toBe(false);
    expect(sameUseCaseTitle('FY27 rollout wave 3', 'FY27 rollout wave 3')).toBe(true);
    expect(sameUseCaseTitle('Agent – Phase 1', 'agent phase 1')).toBe(true);
    // the same words, one more filler word: still the same use case (the article "a" tells nothing apart)
    expect(sameUseCaseTitle('A unified customer profile for service', 'Unified customer profile for service')).toBe(true);
  });

  it('missingCodes: one per code, sorted (vdp_records.missing_items)', () => {
    const r = computeVdpGaps({ ...base, vdps: [vdp({ aes: [], useCases: [uc('u1', { persona: null, division: null })] })] });
    expect(missingCodes(r.vdps[0]!)).toEqual(['no_ae', 'use_case_field']);
  });
});
