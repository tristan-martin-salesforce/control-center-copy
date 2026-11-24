/**
 * D-103 (b), chunk DC2: my covered AEs' open Data & AI Specialist Forecasts, read by one fixed SELECT inside
 * `org62.discover` (same soqlQuery read path, same daily cap), and the context on every DC suggestion (the other Data &
 * AI DCs and the specialists on the opp, J-1). Eligibility first (J-6). Pure: no Org62, no db.
 */
import { describe, expect, it } from 'vitest';

import { DcSuggestion } from '@/contract';
import { DATA_AI_FORECAST_TYPES, dcContextOf, parseSpecialistForecasts, sfrByOpp, sfrDiscoverSoql, sfrEligibility, type DiscoveredOpp } from '@/engines/attribution/discover';
import { assertReadOnlySoql } from '@/engines/deals/soql';
import { DISCOVER_DAILY_LOOKUPS } from '@/jobs/handlers/org62-discover';
import { MOCK_SPECIALIST_FORECASTS, mockSfrFields } from '@/server/datasource/mock/attribution';
import { OPP_SFR_EXT, sfrCandidateFields } from '@/server/datasource/db/attribution-sfr';
import { extKey } from '@/server/datasource/db/ext';
import { sellsDcProduct } from '@/engines/attribution/dc';
import { dcContextChips, dcContextDetails } from '@/components/time/DcSuggestions';

const ae = (i: number) => `005SMPL${String(i).padStart(8, '0')}AAA`;
const answer = (records: unknown[]) => JSON.stringify({ totalSize: records.length, done: true, records });
const sfrRow = (id: string, opp: string, owner: string, o: Record<string, unknown> = {}) => ({
  attributes: { type: 'SpecialistForecast__c' },
  Id: id,
  Opportunity__c: opp,
  ForecastType__c: 'Data Cloud',
  OwnerId: owner,
  Owner: { Name: `AE ${owner.slice(-5, -3)}` },
  Opportunity__r: { Name: 'Placeholder Co - Data 360', AccountId: '001SMPL00000001AAA', Account: { Name: 'Placeholder Co' }, StageName: 'Discovery', CloseDate: '2027-01-30', Amount: 300000, IsClosed: false, OwnerId: owner, Owner: { Name: 'AE' }, ...o },
});

describe('sfrDiscoverSoql: one fixed SELECT, ids bound, no free text', () => {
  it('6 covered AEs: one statement on SpecialistForecast__c, Data & AI types, open opps only', () => {
    const qs = sfrDiscoverSoql(Array.from({ length: 6 }, (_, i) => ae(i + 1)));
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(assertReadOnlySoql(q)).toBe(q);
    expect(q).toMatch(/^SELECT Id, Opportunity__c, ForecastType__c, OwnerId, Owner\.Name, .* FROM SpecialistForecast__c WHERE OwnerId IN \('005SMPL00000001AAA', .*'005SMPL00000006AAA'\) AND ForecastType__c IN \('Data Cloud', 'BtL Data Cloud', 'Agentforce', 'BtL Agentforce'\) AND Opportunity__r\.IsClosed = false ORDER BY Id LIMIT 200$/);
    expect(DATA_AI_FORECAST_TYPES).toHaveLength(4);
  });

  it('anything that is not an Org62 id is dropped, never quoted into the statement', () => {
    const qs = sfrDiscoverSoql([ae(1), "x') OR Name LIKE '%", 'Robert', '']);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toContain(`OwnerId IN ('${ae(1)}')`);
    expect(qs[0]).not.toMatch(/LIKE|Robert|OR Name/);
    expect(sfrDiscoverSoql(['nope'])).toEqual([]);
    expect(sfrDiscoverSoql([])).toEqual([]);
  });

  it('the 15- and 18-character forms of one AE are one id; ≤ 200 ids per statement', () => {
    expect(sfrDiscoverSoql([ae(1), ae(1).slice(0, 15)])[0]!.match(/'005/g)).toHaveLength(1);
    expect(sfrDiscoverSoql(Array.from({ length: 401 }, (_, i) => ae(i + 1)))).toHaveLength(3);
  });

  it('cost: a user with 6 covered AEs pays one read a day for it, well under the daily discovery cap', () => {
    expect(sfrDiscoverSoql(Array.from({ length: 6 }, (_, i) => ae(i + 1))).length).toBe(1);
    expect(DISCOVER_DAILY_LOOKUPS).toBe(20);
  });
});

describe('parseSpecialistForecasts / sfrByOpp: the records fill specialistForecastOwnerIds', () => {
  it('records → one entry per opp with every owner once; the opp is merged for the upsert', () => {
    const into = new Map<string, DiscoveredOpp>();
    const rows = parseSpecialistForecasts(answer([sfrRow('a0XSMPL00000001AAA', '006SMPL00000001AAA', ae(1)), sfrRow('a0XSMPL00000002AAA', '006SMPL00000001AAA', ae(2), {}), sfrRow('a0XSMPL00000003AAA', '006SMPL00000001AAA', ae(1)), { Id: 'bad', Opportunity__c: 'nope', OwnerId: ae(1) }]), into);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ recordId: 'a0XSMPL00000001AAA', oppOrg62Id: '006SMPL00000001AAA', accountOrg62Id: '001SMPL00000001AAA', ownerOrg62Id: ae(1), productLine: 'Data Cloud', stage: 'Discovery', amount: 300000 });
    expect(into.size).toBe(1);
    expect([...into.values()][0]).toMatchObject({ name: 'Placeholder Co - Data 360', amount: 300000, isClosed: false, team: [] });
    const by = sfrByOpp(rows, '2026-11-23T12:00:00.000Z');
    const e = [...by.values()][0]!;
    expect(e.ownerIds).toEqual([ae(1), ae(2)]);
    expect(e.productLines).toEqual(['Data Cloud']);
    expect(e.recordIds).toHaveLength(3);
  });

  it('an unreadable answer throws (the job reports it, nothing is written)', () => {
    expect(() => parseSpecialistForecasts('not json')).toThrow();
  });
});

describe('sfrEligibility: eligibility first (J-6), with the reason', () => {
  const rule = { minAmount: 100_000, dcProducts: ['Data Cloud', 'Agentforce'] };
  it('below the threshold, outside the DC products or closed: skipped with why', () => {
    expect(sfrEligibility({ amount: 50_000, isClosed: false, name: 'X' }, ['Data Cloud'], rule)).toBe('below_threshold');
    expect(sfrEligibility({ amount: null, isClosed: false, name: 'X' }, ['Data Cloud'], rule)).toBe('below_threshold');
    expect(sfrEligibility({ amount: 500_000, isClosed: false, name: 'X - Service' }, ['Tableau'], rule)).toBe('not_dc_product');
    expect(sfrEligibility({ amount: 500_000, isClosed: true, name: 'X' }, ['Data Cloud'], rule)).toBe('closed');
  });
  it('above the threshold on a DC product (its forecast line or its name), or every product counts: eligible', () => {
    expect(sfrEligibility({ amount: 500_000, isClosed: false, name: 'X' }, ['BtL Data Cloud'], rule)).toBeNull();
    expect(sfrEligibility({ amount: 500_000, isClosed: false, name: 'X - Agentforce' }, [], rule)).toBeNull();
    expect(sfrEligibility({ amount: 500_000, isClosed: false, name: 'X' }, [], { minAmount: 0, dcProducts: [] })).toBeNull();
  });
});

describe('dcContextOf: who else is on the opp (per opp, J-1)', () => {
  it('other DCs (never mine), the team’s specialists and the forecast owners, me flagged, deduped', () => {
    const c = dcContextOf({
      dcs: [
        { ownerName: 'Jane Placeholder', role: 'AI + Data Architect', split: 100, isMine: false },
        { ownerName: 'Me Placeholder', role: 'AI + Data Architect', split: 50, isMine: true },
        { ownerName: 'Kim Placeholder', role: 'Agentforce Specialist', split: null, isMine: false },
      ],
      team: [
        { name: 'Me Placeholder', role: 'Data Cloud Specialist', isMe: true },
        { name: 'Raj AE', role: 'Account Executive', isMe: false },
      ],
      sfr: { ownerNames: ['Elena AE', 'elena ae'] },
      coveredOnTeam: null,
    });
    expect(c.dcs).toEqual([
      { ownerName: 'Jane Placeholder', role: 'AI + Data Architect', product: 'Data Cloud', split: 100 },
      { ownerName: 'Kim Placeholder', role: 'Agentforce Specialist', product: 'Agentforce', split: null },
    ]);
    expect(c.specialists).toEqual([
      { name: 'Me Placeholder', isMe: true },
      { name: 'Elena AE', isMe: false },
    ]);
    expect(c).toMatchObject({ via: 'sfr', viaAe: 'Elena AE' });
  });
  it('no forecast: via the opp team when a covered AE is on it; else nothing', () => {
    expect(dcContextOf({ dcs: [], team: [], sfr: null, coveredOnTeam: 'Raj AE' })).toEqual({ dcs: [], specialists: [], via: 'team', viaAe: 'Raj AE' });
    expect(dcContextOf({ dcs: [], team: [], sfr: null, coveredOnTeam: null })).toEqual({ dcs: [], specialists: [], via: null, viaAe: null });
  });
  it('the contract: context defaults to empty on an older stored suggestion', () => {
    const parsed = DcSuggestion.shape.context.parse(undefined);
    expect(parsed).toEqual({ dcs: [], specialists: [], via: null, viaAe: null });
  });
});

describe('the mock: one Specialist Forecast of a covered AE on an opp I never touched', () => {
  it('fills specialistForecastOwnerIds and seenVia on that opp only (placeholders)', () => {
    const r = MOCK_SPECIALIST_FORECASTS[0]!;
    expect(mockSfrFields(r.oppId)).toEqual({ specialistForecastOwnerIds: [r.ownerOrg62Id], seenVia: 'sfr', products: [r.productLine] });
    expect(mockSfrFields(r.oppId, ['Data 360', r.productLine.toUpperCase()]).products).toEqual(['Data 360', r.productLine.toUpperCase()]);
    expect(mockSfrFields('opp_acme_p2')).toEqual({});
  });
});

describe('R3-3: the forecast’s product lines reach the DC product gate', () => {
  const kv = new Map<string, unknown>([[extKey('opportunities', 'opp-plain'), { [OPP_SFR_EXT]: { ownerIds: ['005SMPL00000001AAA'], ownerNames: ['Sam AE'], productLines: ['Data Cloud'], recordIds: ['a0XSMPL00000001AAA'], seenAt: '2026-11-23T00:00:00.000Z' } }]]);
  it('a forecast-named opp with no products and a plain name is a candidate when its forecast type is a DC product', () => {
    const f = sfrCandidateFields(kv, 'opp-plain');
    expect(f).toMatchObject({ specialistForecastOwnerIds: ['005SMPL00000001AAA'], seenVia: 'sfr', products: ['Data Cloud'] });
    const opp = { name: 'Placeholder Co - Renewal FY27', products: [] as string[] };
    expect(sellsDcProduct(opp, ['Data Cloud'])).toBe(false);
    expect(sellsDcProduct({ ...opp, ...f }, ['Data Cloud'])).toBe(true);
    // merged into the opp's own products, deduped
    expect(sfrCandidateFields(kv, 'opp-plain', ['Agentforce', 'data cloud']).products).toEqual(['Agentforce', 'data cloud']);
    expect(sfrCandidateFields(kv, 'opp-none', ['Agentforce'])).toEqual({});
  });
});

describe('the row’s chips and details: plain words', () => {
  const ctx = { dcs: [{ ownerName: 'Jane', role: 'AI + Data Architect', split: 100 }, { ownerName: 'Kim', role: null, split: null }], specialists: [{ name: 'Me', isMe: true }, { name: 'Elena', isMe: false }], via: 'sfr' as const, viaAe: 'Elena' };
  it('"2 Data & AI DCs: Jane, Kim" and "via Elena’s forecast"; the details list them', () => {
    expect(dcContextChips(ctx).map((c) => c.text)).toEqual(['2 Data & AI DCs: Jane, Kim', 'via Elena’s forecast']);
    expect(dcContextChips({ ...ctx, dcs: [], via: 'team', viaAe: 'Raj' }).map((c) => c.text)).toEqual(['via opp team']);
    expect(dcContextChips(undefined)).toEqual([]);
    expect(dcContextDetails(ctx)).toEqual(['Elena’s Specialist Forecast names this opportunity', 'Data & AI DC: Jane (AI + Data Architect, 100%)', 'Data & AI DC: Kim', 'Specialists on it: Me (you), Elena']);
  });
  it('never the acronym or a field name in the copy', () => {
    const all = [...dcContextChips(ctx), ...dcContextDetails(ctx).map((text) => ({ text }))].map((c) => c.text).join(' ');
    expect(all).not.toMatch(/\bSFR\b|__c|SpecialistForecast/);
  });
});
