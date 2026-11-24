/**
 * dc-roundtrip (D-68): the Deals and DC rows of docs/EDGE-CASES.md (DC-01 … DC-33), each a scenario named after its
 * row, on the shared pure rules and the mock DataSource. The Postgres side of the same rows is
 * tests/db/deals/dc-roundtrip-db.test.ts. Placeholders only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { myDcWords, routes, type DcRequest, type MissedOpp, type RouteDef, type RouteKey, type RouteOutput } from '@/contract';
import { renderWorkOrder } from '@/engines/activity/slackbot';
import { dcGapOf, dealsNeeds } from '@/engines/deals/needs';
import { resurfaced } from '@/lib/need-decisions';
import { Matcher, siblingFamilies, type MatchAccount, type MatchOpp } from '@/projections/matching';
import { missedOpps, type MissedEvidence } from '@/projections/missed';
import { channelAccount } from '@/projections/missed-slack';
import { projectOrg62 } from '@/projections/org62';
import type { MockDataSource } from '@/server/datasource/mock';
import { DC_NOT_CREATED_GRACE_MS, dcCanvasPreflight, dcCanvasRows, dcRowStillNeeded, dcRowWanted, pendingDcAdds, planDcRequest, reconcileDcRequests, sumMyDcs, withDcAdds, type DcAdd } from '@/server/deals/dc-requests';
import { dealsNeedsFor, vdpOppIdsOf } from '@/server/deals/needs';
import { accountMerges, vdpItemsOutOfScope } from '@/server/deals/scope';
import { personaOf } from '@/personas';

import { mockWith } from '../chat/helpers';
import { org62Item } from '../projections/fixtures';

const DC_ID = 'a0XXX0000000DC1AAA';
const OPP_ID = '006XX0000000001AAA';
const ME_ORG62 = '005XX0000000001AAA';
const OTHER_SE = '005XX0000000099AAA';

const req = (o: Partial<DcRequest> = {}): DcRequest => ({
  id: 'r1',
  kind: 'add',
  oppId: 'o1',
  oppName: 'CUSTOMER_1 – Data 360 Expansion',
  accountId: 'a1',
  accountName: 'CUSTOMER_1',
  org62OpportunityId: OPP_ID,
  role: 'AI + Data Architect',
  splitPercent: 100,
  fromSplit: null,
  comment: 'Built the demo',
  status: 'approved',
  stage: 'waiting',
  canvasDraftId: null,
  canvasUrl: null,
  dc: null,
  outcome: null,
  note: null,
  lockedReason: null,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  ...o,
});
const myDc = (split: number | null, o: { id?: string; count?: number } = {}) => ({ split, role: 'AI + Data Architect', org62DcId: o.id ?? DC_ID, lastSeenAt: '2026-11-11T06:00:00.000Z', ...(o.count ? { dcCount: o.count } : {}) });
const base = { ownerName: 'Sam Placeholder', ownerOrg62Id: ME_ORG62, recordTypeId: '012XX0000000MOCKAA', generatedAt: '2026-11-11T12:00:00Z', sourceLabel: 'test' };

let ds: MockDataSource;
beforeEach(() => {
  ds = mockWith();
});
afterEach(() => ds.dispose());

async function call<K extends RouteKey>(key: K, input: unknown): Promise<RouteOutput<K>> {
  const def = routes[key] as RouteDef;
  const parsed: Record<string, unknown> = {};
  const i = (input ?? {}) as Record<string, unknown>;
  if (def.params) parsed.params = def.params.parse(i.params ?? {});
  if (def.query) parsed.query = def.query.parse(i.query ?? {});
  if (def.body) parsed.body = def.body.parse(i.body);
  const out = await (ds[key as keyof MockDataSource] as (x: unknown) => Promise<unknown>).call(ds, parsed);
  const r = def.response.safeParse(out);
  if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return out as RouteOutput<K>;
}

/** The mock's DCs now, as a complete read would list them (each opp's summed myDc as one DC). */
const seedDcs = () => ds.store.all('opps').filter((o) => o.myDc).map((o) => ({ oppId: o.id, split: o.myDc!.split, role: o.myDc!.role, org62DcId: o.myDc!.org62DcId! }));
const gapOppIds = async () => (await call('getDeals', {})).needs.filter((n) => n.section === 'fix').flatMap((n) => n.opps.map((g) => g.oppId));
const reqOf = async (id: string) => (await call('listDcRequests', {})).requests.find((r) => r.id === id)!;

// The seed: opp_umbrella_af is open, on my team, with no DC (a DC gap); opp_umbrella_c360 holds my 50% DC.
const GAP_OPP = 'opp_umbrella_af';
const HALF_OPP = 'opp_umbrella_c360';

describe('DC lifecycle', () => {
  it('DC-01 DC created manually for a flagged opp: the gap closes on the next read (mock)', async () => {
    expect(await gapOppIds()).toContain(GAP_OPP);
    ds.recordMyDcs([{ oppId: GAP_OPP, split: 100, role: 'AI + Data Architect', org62DcId: DC_ID }]);
    expect(await gapOppIds()).not.toContain(GAP_OPP);
  });

  it('DC-03 waiting add, DC created manually at another split: the request confirms (Org62 wins), no ADD on the canvas', async () => {
    // pure: an add confirms whatever split Org62 shows, and the batch never takes it
    const r = req({ dc: myDc(50) });
    expect(reconcileDcRequests({ requests: [r] }).confirm.map((x) => x.id)).toEqual(['r1']);
    expect(dcRowWanted(r)).toBe(false);
    expect(pendingDcAdds([r])).toEqual([]);
    // mock: asked for 100%, made by hand at 50% in Org62
    const c = await call('createDcRequest', { body: { opp: GAP_OPP, split: 100, comment: 'Built the demo' } });
    expect(ds.recordMyDcs([{ oppId: GAP_OPP, split: 50, role: 'AI + Data Architect', org62DcId: DC_ID }])).toBe(1);
    expect(await reqOf(c.entity.id)).toMatchObject({ status: 'verified', stage: 'confirmed', dc: { split: 50 } });
    const batch = await call('stageLogBatch', { body: { dcOnly: true } });
    expect(batch.entity.canvases).toEqual([]);
  });

  it('DC-04 waiting change 50→100, Org62 hand-edited to 75: withdrawn, never overwrites', async () => {
    const change = req({ kind: 'change', fromSplit: 50, splitPercent: 100, dc: myDc(75) });
    expect(reconcileDcRequests({ requests: [change] }).close).toEqual([{ request: change, outcome: 'changed_in_org62' }]);
    expect(pendingDcAdds([change])).toEqual([]);
    // the DC gone altogether: withdrawn too (nothing to change)
    expect(reconcileDcRequests({ requests: [req({ kind: 'change', fromSplit: 50, dc: null })] }).close[0]!.outcome).toBe('dc_removed');
    // a change still at its fromSplit goes on the canvas with the split it was asked from as "current"
    const still = req({ kind: 'change', fromSplit: 50, splitPercent: 100, dc: myDc(50) });
    expect(pendingDcAdds([still])).toMatchObject([{ kind: 'change', fromSplit: 50, split: 100, org62DcId: DC_ID }]);
    // mock: my 50% DC, a change to 100%, then someone sets 75% in Org62
    const c = await call('createDcRequest', { body: { opp: HALF_OPP, split: 100, comment: 'Took over the build' } });
    expect(c.entity).toMatchObject({ kind: 'change', fromSplit: 50 });
    const dc = ds.store.get('opps', HALF_OPP)!.myDc!;
    ds.recordMyDcs([{ oppId: HALF_OPP, split: 75, role: dc.role, org62DcId: dc.org62DcId! }]);
    const after = await reqOf(c.entity.id);
    expect(after).toMatchObject({ status: 'dismissed', stage: 'dismissed', outcome: 'changed_in_org62', note: expect.stringMatching(/Org62 now shows your DC at 75%.*never overwrites/) });
    expect((await call('stageLogBatch', { body: { dcOnly: true } })).entity.canvases).toEqual([]);
  });

  it('DC-05 request on a pending canvas, DC lands before Apply: the preflight drops the row', () => {
    const ev = { ccId: 'a1', subject: 'Demo', startUtc: '2026-11-10T16:00:00.000Z', endUtc: '2026-11-10T17:00:00.000Z', taskType: 'Demo', durationH: 1, whatId: OPP_ID, meetingType: '', description: 'CC#a1' };
    const add: DcAdd = { requestId: 'r1', org62OpportunityId: '006XX0000000002AAA', oppName: 'CUSTOMER_2', role: 'AI + Data Architect', split: 100, comment: 'Built the demo' };
    const change: DcAdd = { requestId: 'r2', kind: 'change', org62OpportunityId: '006XX0000000003AAA', oppName: 'CUSTOMER_3', role: 'AI + Data Architect', split: 100, fromSplit: 50, fromRole: 'AI + Data Architect', org62DcId: DC_ID, comment: 'Took it over' };
    const md = withDcAdds(renderWorkOrder({ ...base, events: [ev], updates: [] }), [add, change], ME_ORG62);
    const rows = dcCanvasRows(md);
    expect(rows.map((r) => [r.kind, r.org62OpportunityId ?? r.org62DcId, r.split, r.current])).toEqual([
      ['add', '006XX0000000002AAA', 100, null],
      ['change', DC_ID, 100, '50'],
    ]);
    // nothing changed in Org62: both rows still needed
    expect(dcCanvasPreflight(md, { myDcs: [{ org62DcId: DC_ID, org62OpportunityId: '006XX0000000003AAA', split: 50 }] })).toEqual([]);
    // the DC landed before Apply (any split): the ADD row is dropped
    const landed = dcRowStillNeeded(rows[0]!, { myDcs: [{ org62DcId: 'a0XXX0000000DC9AAA', org62OpportunityId: '006XX0000000002', split: 75 }] });
    expect(landed).toEqual({ keep: false, reason: expect.stringMatching(/Org62 already has your DC on CUSTOMER_2 \(75%\)/), conflict: false });
    // the change: already the new value → dropped; changed to something else → a conflict, never overwritten; gone → dropped
    expect(dcRowStillNeeded(rows[1]!, { myDcs: [{ org62DcId: DC_ID, org62OpportunityId: null, split: 100 }] })).toMatchObject({ keep: false, conflict: false });
    expect(dcRowStillNeeded(rows[1]!, { myDcs: [{ org62DcId: DC_ID, org62OpportunityId: null, split: 75 }] })).toMatchObject({ keep: false, conflict: true, reason: expect.stringMatching(/75%, not the 50%/) });
    expect(dcRowStillNeeded(rows[1]!, { myDcs: [] })).toMatchObject({ keep: false, reason: expect.stringMatching(/removed in Org62/) });
    // the request behind an ADD row was withdrawn: dropped
    expect(dcRowStillNeeded(rows[0]!, { myDcs: [], requests: [{ kind: 'add', role: 'AI + Data Architect', org62OpportunityId: '006XX0000000002AAA', dc: null, stage: 'dismissed' }] })).toMatchObject({ keep: false });
  });

  it('DC-06 canvas applied partially: after the next complete read with no DC, not_created and unlocked; the gap comes back; Chase works', async () => {
    const c = await call('createDcRequest', { body: { opp: GAP_OPP, split: 100, comment: 'Built the demo' } });
    expect(await gapOppIds()).not.toContain(GAP_OPP);
    await call('stageLogBatch', { body: { dcOnly: true } });
    // the user Applied the canvas 13 h ago (it reached Slack); Slackbot ran the Events but not the DC
    const canvas = ds.store.all('drafts').find((d) => d.destination.kind === 'action' && d.destination.action === 'slack_canvas.create')!;
    ds.store._set('drafts', { ...canvas, status: 'sent', updatedAt: new Date(ds.now().getTime() - DC_NOT_CREATED_GRACE_MS - 3_600_000).toISOString() });
    expect(await reqOf(c.entity.id)).toMatchObject({ stage: 'handed_off' });
    // Chase reads the requests (the account status "requested" was never written on Postgres)
    const chase = (await call('getDeals', {})).needs.filter((n) => n.section === 'chase');
    expect(chase.map((n) => [n.accountId, n.title])).toEqual([['acc_umbrella', 'Umbrella Health: DC requested on Umbrella · Agentforce Care']]);
    // a read that isn't complete decides nothing
    ds.recordMyDcs(seedDcs());
    expect(await reqOf(c.entity.id)).toMatchObject({ stage: 'handed_off' });
    // the next complete read: no DC on the opp
    ds.recordMyDcs(seedDcs(), { complete: true });
    const nc = await reqOf(c.entity.id);
    expect(nc).toMatchObject({ status: 'dismissed', stage: 'not_created', outcome: 'not_created', note: expect.stringMatching(/^Not created/) });
    expect(await gapOppIds()).toContain(GAP_OPP);
    expect((await call('getDeals', {})).needs.filter((n) => n.section === 'chase')).toEqual([]);
    // unlocked: Ask again is a new request, waiting for the next canvas (not "handed off" on the canvas that failed)
    const again = await call('createDcRequest', { body: { opp: GAP_OPP, split: 100, comment: 'Built the demo' } });
    expect(again.entity).toMatchObject({ kind: 'add', stage: 'waiting' });
    expect((await call('stageLogBatch', { body: { dcOnly: true } })).entity.canvases).toHaveLength(1);
  });
});

describe('DC changes in Org62', () => {
  it('DC-10 split changed 100↔50: staged VDP items for an account that leaves the 100% scope are withdrawn', () => {
    const items = [
      { id: 'd_in', accountId: 'acc_in', editedByUser: false },
      { id: 'd_out', accountId: 'acc_out', editedByUser: false },
      { id: 'd_mine', accountId: 'acc_out', editedByUser: true },
      { id: 'd_unknown', accountId: null, editedByUser: false },
    ];
    expect(vdpItemsOutOfScope(items, new Set(['acc_in']))).toEqual(['d_out']);
  });

  it('DC-11 DC removed (non-team opp): dcAssigned clears; the gap and the claim come back', async () => {
    ds.recordMyDcs([...seedDcs(), { oppId: 'opp_globex_renew', split: 100, role: 'AI + Data Architect', org62DcId: DC_ID }]);
    expect(ds.store.get('opps', 'opp_globex_renew')).toMatchObject({ dcAssigned: true, myDc: { split: 100 } });
    // the complete read no longer lists it: removed in Org62
    ds.recordMyDcs(seedDcs().filter((d) => d.oppId !== 'opp_globex_renew'), { complete: true });
    expect(ds.store.get('opps', 'opp_globex_renew')).toMatchObject({ dcAssigned: false, myDc: null });
    expect(await gapOppIds()).toContain('opp_globex_renew');
    expect(planDcRequest({ name: 'x', dcAssigned: false, myDc: null }, 100).kind).toBe('add');
    expect((await call('createDcRequest', { body: { opp: 'opp_globex_renew', split: 100, comment: 'Ran the renewal workshop' } })).entity.kind).toBe('add');
  });

  it('DC-12 confirmed request, DC later removed: the opp can be a gap again (the live request only)', async () => {
    const opp = { id: 'o1', accountId: 'a1', name: 'OPP_1', amount: 1000, isOpen: true, isMine: true, dcAssigned: false, myDc: null, hoursQtd: 3 };
    const acc = { id: 'a1', name: 'ACCT_1', industry: null, dcStatus: 'none' as const, vdpStatus: 'none' as const, hoursQtd: 3, team: [], org62Url: null, notes: '', myDcs: [], openOpps: 1, openTasks: 0, pipelineAmount: 1000, nextCloseDate: null };
    const needs = (requests: Array<{ oppId: string; status: DcRequest['status'] }>) => dealsNeedsFor({ now: new Date('2026-11-12T12:00:00Z'), timezone: 'America/Denver', persona: personaOf({}), accounts: [acc], opps: [opp], missed: [], requests, decisions: [] }).filter((n) => n.section === 'fix').length;
    expect(needs([{ oppId: 'o1', status: 'verified' }])).toBe(1);
    expect(needs([{ oppId: 'o1', status: 'approved' }])).toBe(0);
    expect(needs([{ oppId: 'o1', status: 'dismissed' }])).toBe(1);
    // mock: confirmed, then the DC is removed in Org62
    const c = await call('createDcRequest', { body: { opp: GAP_OPP, split: 100, comment: 'Built the demo' } });
    ds.recordMyDcs([...seedDcs(), { oppId: GAP_OPP, split: 100, role: 'AI + Data Architect', org62DcId: DC_ID }]);
    expect((await reqOf(c.entity.id)).stage).toBe('confirmed');
    ds.recordMyDcs(seedDcs().filter((d) => d.oppId !== GAP_OPP), { complete: true });
    expect(await gapOppIds()).toContain(GAP_OPP);
  });

  it('DC-13 DC reassigned to another SE: not mine any more (SE_Name__c recorded and read)', () => {
    const OPP = '006XX0000000009AAA';
    const dcRow = (stamp: string, meta: Record<string, unknown>) => org62Item(`Deal_Contribution__c:a0XXX0000000009AAA@${stamp}`, { title: 'DC on OPP_9', meta: { Opportunity__c: OPP, Opportunity_Role__c: 'AI + Data Architect', Split_Percentage__c: 100, ...meta }, oppHints: [OPP], changedAt: stamp.replace('+0000', 'Z') });
    const mine = dcRow('2026-10-01T10:00:00.000+0000', {}); // the windowed dcs query (filtered on me)
    const reassigned = dcRow('2026-11-11T10:00:00.000+0000', { SE_Name__c: OTHER_SE }); // the read-back, by Id
    expect(projectOrg62([mine, reassigned], { me: ME_ORG62 }).dcs).toEqual([]);
    expect(projectOrg62([mine, reassigned], { me: ME_ORG62 }).opps.find((o) => o.org62OpportunityId === OPP)?.myDc ?? false).toBe(false);
    expect(projectOrg62([mine, dcRow('2026-11-11T10:00:00.000+0000', { SE_Name__c: ME_ORG62 })], { me: ME_ORG62 }).dcs).toHaveLength(1);
    // handed back to me: the newer windowed read (no SE field: it came from a query on me) wins
    expect(projectOrg62([mine, reassigned, dcRow('2026-11-12T10:00:00.000+0000', {})], { me: ME_ORG62 }).dcs).toHaveLength(1);
  });

  it('DC-14 two DCs of mine on one opp (Flex 50/50): splits summed per opp', async () => {
    expect(sumMyDcs([myDc(50), myDc(50, { id: 'a0XXX0000000DC2AAA' })])).toEqual({ split: 100, role: 'AI + Data Architect', org62DcId: DC_ID, lastSeenAt: '2026-11-11T06:00:00.000Z', dcCount: 2 });
    expect(sumMyDcs([myDc(null), myDc(50)])!.split).toBe(50);
    expect(myDcWords(sumMyDcs([myDc(50), myDc(50, { id: 'a0XXX0000000DC2AAA' })]))).toBe('Your DC: 100% (2 DCs) · AI + Data Architect');
    // the projection: the opp's split is the sum
    const OPP = '006XX0000000005AAA';
    const dcRow = (id: string) => org62Item(`Deal_Contribution__c:${id}@2026-11-01T10:00:00.000+0000`, { title: 'DC on OPP_5', meta: { Opportunity__c: OPP, Opportunity_Role__c: 'AI + Data Architect', Split_Percentage__c: 50 }, oppHints: [OPP], accountHints: ['001XX0000000005AAA', 'ACCT_5'] });
    const b = projectOrg62([dcRow('a0XXX0000000D51AAA'), dcRow('a0XXX0000000D52AAA')], { me: ME_ORG62 });
    expect(b.dcs).toHaveLength(2);
    expect(b.opps.find((o) => o.org62OpportunityId === OPP)).toMatchObject({ myDc: true, myDcSplit: 100 });
    // a change would move only one of them: refused with why
    expect(() => planDcRequest({ name: 'OPP_5', dcAssigned: true, myDc: myDc(100, { count: 2 }) }, 50)).toThrow(/You hold 2 DCs on OPP_5 \(100% together\)/);
    // mock: the read carries two of mine on one opp
    ds.recordMyDcs([{ oppId: GAP_OPP, split: 50, role: 'AI + Data Architect', org62DcId: 'a0XXX0000000D61AAA' }, { oppId: GAP_OPP, split: 50, role: 'AI + Data Architect', org62DcId: 'a0XXX0000000D62AAA' }]);
    expect(ds.store.get('opps', GAP_OPP)!.myDc).toMatchObject({ split: 100, dcCount: 2 });
  });
});

describe('Opps and accounts', () => {
  const OPP = '006XX0000000006AAA';
  const ACC: [string, string] = ['001XX0000000006AAA', 'ACCT_6'];
  const oppRow = (stamp: string, closed: boolean, acct: [string, string] = ACC) =>
    org62Item(`Opportunity:${OPP}@${stamp}`, { title: 'OPP_6', meta: { Id: OPP, StageName: closed ? 'Closed Lost' : 'Discovery', IsClosed: closed, Amount: 50000 }, body: 'team_role=Solution Engineer', accountHints: acct, oppHints: [OPP] });

  it('DC-20 opp closed but seen only by the DC read-back; reopened but seen only by the book read: the newer source wins', () => {
    // closed: the DC read-back (by Id, Nov 10) carries Opportunity__r.IsClosed; the opp's own rows are older
    const dcClosed = org62Item('Deal_Contribution__c:a0XXX0000000006AAA@2026-09-01T10:00:00.000+0000', { title: 'DC on OPP_6', meta: { Opportunity__c: OPP, Split_Percentage__c: 100, IsClosed: true }, oppHints: [OPP], accountHints: [ACC[0]], changedAt: '2026-11-10T08:00:00.000Z' });
    expect(projectOrg62([oppRow('2026-10-01T10:00:00.000+0000', false), dcClosed], { me: ME_ORG62 }).opps.find((o) => o.org62OpportunityId === OPP)!.isClosed).toBe(true);
    // reopened: the daily book read lists it (open) after the closed snapshot
    const STAMP = '2026-11-06T13:00:00.000Z';
    const book = { ...org62Item(`Book:${OPP}`, { title: 'OPP_6', body: `book_at=${STAMP}; stage=Discovery; team_role=Solution Engineer`, accountHints: ACC, oppHints: [OPP] }), occurredAt: '2026-10-20T10:00:00.000Z' };
    const run = { ...org62Item(`BookRun:run-${STAMP}`, { title: 'Book read', body: `book_at=${STAMP}; rows=1; complete=true` }), occurredAt: STAMP };
    expect(projectOrg62([oppRow('2026-10-01T10:00:00.000+0000', true), book, run], { me: ME_ORG62 }).opps.find((o) => o.org62OpportunityId === OPP)!.isClosed).toBe(false);
    // and a newer closed snapshot after that read still wins
    expect(projectOrg62([oppRow('2026-11-08T10:00:00.000+0000', true), book, run], { me: ME_ORG62 }).opps.find((o) => o.org62OpportunityId === OPP)!.isClosed).toBe(true);
  });

  it('DC-21 opp moved to another account: the move is read (the old account loses its state on Postgres)', () => {
    const b = projectOrg62([oppRow('2026-10-01T10:00:00.000+0000', false), oppRow('2026-11-05T10:00:00.000+0000', false, ['001XX0000000007AAA', 'ACCT_7'])], { me: ME_ORG62 });
    expect(b.accountMoves).toEqual([{ org62OpportunityId: OPP, from: '001XX0000000006', to: '001XX0000000007AAA' }]);
    expect(b.accounts.map((a) => a.name)).toEqual(['ACCT_7']);
  });

  it('DC-23 child accounts with " - org/product" suffixes under one parent: evidence matches the right child', () => {
    const accounts: MatchAccount[] = [
      { id: 'a_com', name: 'Umbrella Health - Commercial', org62AccountId: '001XX00000000C1AAA', aliases: [] },
      { id: 'a_med', name: 'Umbrella Health - Medicaid', org62AccountId: '001XX00000000C2AAA', aliases: [{ kind: 'domain', value: 'medicaid.umbrella.example' }] },
      { id: 'a_hooli', name: 'Hooli', org62AccountId: '001XX00000000C3AAA', aliases: [] },
    ];
    const opps: MatchOpp[] = [
      { id: 'o_com1', accountId: 'a_com', org62OpportunityId: '006XX00000000C1AAA', name: 'Umbrella Health - Commercial - Patient 360', isClosed: false, onMyTeam: true, myDc: true },
      { id: 'o_com2', accountId: 'a_com', org62OpportunityId: '006XX00000000C2AAA', name: 'Umbrella Health - Commercial - Service Agent', isClosed: false, onMyTeam: true, myDc: false },
      { id: 'o_med', accountId: 'a_med', org62OpportunityId: '006XX00000000C3AAA', name: 'Umbrella Health - Medicaid - Member Engagement', isClosed: false, onMyTeam: true, myDc: false },
    ];
    expect([...siblingFamilies(accounts)]).toEqual([
      ['a_com', 'n:umbrella health'],
      ['a_med', 'n:umbrella health'],
    ]);
    const m = new Matcher(accounts, opps, { internal: ['corp.example'], partner: [], ignore: [] });
    // the full child name: that child
    expect(m.resolve('Umbrella Health - Medicaid weekly')?.accountId).toBe('a_med');
    expect(m.resolve('Umbrella Health Commercial QBR')?.accountId).toBe('a_com');
    // the shared head only: never "the child with more of my opps" (that put evidence on the wrong child)
    expect(m.resolve('Umbrella Health architecture review')).toBeNull();
    // the head plus an attendee domain (or an opp word) of one child: that child
    expect(m.resolve('Umbrella Health architecture review', ['medicaid.umbrella.example'])?.accountId).toBe('a_med');
    expect(m.resolve('Umbrella Health member engagement demo')?.accountId).toBe('a_med');
    // the activity engine never matches a child on the shared head alone
    const maps = m.mappings({ internalDomains: [], partnerDomains: [], ignoreDomains: [] });
    expect(new RegExp(maps.accounts.find((a) => a.key === 'a_med')!.match).test('umbrella health architecture review')).toBe(false);
    expect(new RegExp(maps.accounts.find((a) => a.key === 'a_med')!.match).test('umbrella health medicaid weekly')).toBe(true);
    // a parent account named by the head itself takes the head
    const withParent = new Matcher([...accounts, { id: 'a_parent', name: 'Umbrella Health', org62AccountId: '001XX00000000C9AAA', aliases: [] }], opps, { internal: [], partner: [], ignore: [] });
    expect(withParent.resolve('Umbrella Health exec sync')?.accountId).toBe('a_parent');
    // the seam: the Org62 hierarchy (ParentId) makes siblings of names that share nothing
    expect(siblingFamilies([{ id: 'x', name: 'Globex Retail', parentOrg62AccountId: '001XX0000000P01AAA' }, { id: 'y', name: 'Globex Bank', parentOrg62AccountId: '001XX0000000P01AAA' }]).get('x')).toBe('p:001XX0000000P01');
  });

  it('DC-24 account merged in Org62: every opp it had moved to one survivor', () => {
    const moves = [
      { org62OpportunityId: '006XX0000000M01AAA', from: '001XX0000000M01', to: '001XX0000000M02AAA' },
      { org62OpportunityId: '006XX0000000M02AAA', from: '001XX0000000M01', to: '001XX0000000M02AAA' },
      // one opp of ACCT_X moved, another stayed: a move, never a merge
      { org62OpportunityId: '006XX0000000M03AAA', from: '001XX0000000M0X', to: '001XX0000000M02AAA' },
    ];
    const opps = [{ org62AccountId: '001XX0000000M02AAA' }, { org62AccountId: '001XX0000000M02AAA' }, { org62AccountId: '001XX0000000M02AAA' }, { org62AccountId: '001XX0000000M0XAAA' }] as never;
    expect(accountMerges({ opps, accountMoves: moves })).toEqual([{ from: '001XX0000000M01', to: '001XX0000000M02AAA', opps: 2 }]);
    // two survivors: no merge either
    expect(accountMerges({ opps: [] as never, accountMoves: [moves[0]!, { ...moves[1]!, to: '001XX0000000M03AAA' }] })).toEqual([]);
  });
});

describe('Set-asides, counts, evidence', () => {
  it('DC-30 set-aside across a quarter rollover: the baseline is per quarter', () => {
    // Not needed in Q3 at 5 h; in Q4 the hours start again at 0
    expect(resurfaced('dc_gap', { onTeam: true, hoursQtd: 5, quarter: 'FY27 Q3' }, { onTeam: true, hoursQtd: 3, quarter: 'FY27 Q4' })).toBe(true);
    expect(resurfaced('dc_gap', { onTeam: true, hoursQtd: 5, quarter: 'FY27 Q3' }, { onTeam: true, hoursQtd: 1.5, quarter: 'FY27 Q4' })).toBe(false);
    expect(resurfaced('dc_gap', { onTeam: true, hoursQtd: 5, quarter: 'FY27 Q4' }, { onTeam: true, hoursQtd: 6.5, quarter: 'FY27 Q4' })).toBe(false);
    // a decision from before quarters were stored compares as before
    expect(resurfaced('dc_gap', { onTeam: true, hoursQtd: 5 }, { onTeam: true, hoursQtd: 3, quarter: 'FY27 Q4' })).toBe(false);
    // the engine stores the quarter and honours it
    const opp = { id: 'o1', accountId: 'a1', name: 'OPP_1', amount: 1000, isOpen: true, isMine: false, dcAssigned: false, myDc: null, hoursQtd: 3 };
    const acc = { id: 'a1', name: 'ACCT_1', industry: null, dcStatus: 'none' as const, vdpStatus: 'none' as const, hoursQtd: 3, team: [], org62Url: null, notes: '', myDcs: [], openOpps: 1, openTasks: 0, pipelineAmount: 1000, nextCloseDate: null };
    const decision = { rule: 'dc_gap', subjectId: 'o1', kind: 'not_needed' as const, until: null, reason: 'Other', label: 'OPP_1', baseline: { onTeam: false, hoursQtd: 5, quarter: 'FY27 Q3' }, decidedAt: '2026-10-20T00:00:00.000Z' };
    const fix = (today: string) => dealsNeeds({ accounts: [acc], opps: [opp], missed: [], requestedOppIds: new Set(), decisions: [decision], today, now: `${today}T12:00:00.000Z` }).filter((n) => n.section === 'fix').length;
    expect(fix('2026-11-12')).toBe(1);
  });

  it('DC-31 Home vs Deals DC counts: one source (dealsNeeds); Claim DC marks the finding claimed', async () => {
    const deals = await call('getDeals', {});
    const gapIds = deals.needs.filter((n) => n.section === 'fix').flatMap((n) => n.opps.map((g) => g.oppId));
    const home = await call('getHome', { query: {} });
    const row = home.sections.flatMap((s) => s.rows).find((r) => r.id === 'gap:missed_dc')!;
    expect(row.title).toBe(gapIds.length === 1 ? expect.stringMatching(/^Claim DC on /) : `Claim DC on ${gapIds.length} opps`);
    // Claim DC on Deals (createDcRequest) on an opp with an open finding claims the finding too
    expect((await call('getMissed', {})).missed.find((m) => m.id === 'mo_globex_renew')!.status).toBe('new');
    const c = await call('createDcRequest', { body: { opp: 'opp_globex_renew', split: 100, comment: 'Ran the renewal workshop' } });
    expect((await call('getMissed', {})).missed.find((m) => m.id === 'mo_globex_renew')).toMatchObject({ status: 'claimed', dcRequestId: c.entity.id });
    // and Home follows Deals: one opp fewer
    const after = (await call('getDeals', {})).needs.filter((n) => n.section === 'fix').flatMap((n) => n.opps.map((g) => g.oppId));
    expect(after).not.toContain('opp_globex_renew');
    const row2 = (await call('getHome', { query: {} })).sections.flatMap((s) => s.rows).find((r) => r.id === 'gap:missed_dc');
    if (after.length) expect(row2!.title).toBe(after.length === 1 ? expect.stringMatching(/^Claim DC on /) : `Claim DC on ${after.length} opps`);
    else expect(row2).toBeUndefined();
  });

  it('DC-32 a VDP I am on links an open opp with no DC of mine: strong evidence, gap reason vdp', () => {
    const opp = { id: 'o1', accountId: 'a1', name: 'OPP_1', amount: 250000, isOpen: true, isMine: false, dcAssigned: false, myDc: null, hoursQtd: 0 };
    expect(dcGapOf(opp, undefined, false)).toBeNull();
    expect(dcGapOf(opp, undefined, false, true)).toMatchObject({ reasons: ['vdp'] });
    // amount 0: only an opp I'm on the team of (strong evidence only)
    expect(dcGapOf({ ...opp, amount: 0 }, undefined, false, true)).toBeNull();
    // the mirror: a VDP I'm on, live, linking it; never one I'm not on or one archived
    expect([...vdpOppIdsOf([{ linkedOppIds: ['o1', 'o_closed'], onIt: true, live: true }, { linkedOppIds: ['o2'], onIt: false, live: true }, { linkedOppIds: ['o3'], onIt: true, live: false }], new Set(['o1', 'o2', 'o3']))]).toEqual(['o1']);
    const acc = { id: 'a1', name: 'ACCT_1', industry: null, dcStatus: 'none' as const, vdpStatus: 'linked' as const, hoursQtd: 0, team: [], org62Url: null, notes: '', myDcs: [], openOpps: 0, openTasks: 0, pipelineAmount: 0, nextCloseDate: null };
    const needs = dealsNeedsFor({ now: new Date('2026-11-12T12:00:00Z'), timezone: 'America/Denver', persona: personaOf({}), accounts: [acc], opps: [opp], missed: [], requests: [], decisions: [], vdpOppIds: new Set(['o1']) });
    expect(needs.find((n) => n.section === 'fix')).toMatchObject({ why: "1 opp on a VDP you're on and no DC: OPP_1", opps: [{ oppId: 'o1', reasons: ['vdp'] }] });
  });

  it('DC-33 meetings or Slack only on a non-team opp: Slack counts as evidence, within the strong-evidence rule', () => {
    const STAMP = '2026-11-06T13:00:00.000Z';
    const OPP = '006XX0000000008AAA';
    const OPP_2 = '006XX0000000018AAA';
    const ACC: [string, string] = ['001XX0000000002AAA', 'Globex Inc.'];
    const book = (id: string, name: string) => ({ ...org62Item(`Book:${id}`, { title: name, body: `book_at=${STAMP}; stage=Proposal; amount=180000; close=2026-12-31; team_role=Solution Engineer`, accountHints: ACC, oppHints: [id] }), occurredAt: '2026-10-01T10:00:00.000Z' });
    const sweep = org62Item(`MissedOpp:${OPP}`, { title: 'Globex - Wealth Data Cloud', meta: { Id: OPP, AccountId: ACC[0], AccountName: ACC[1], StageName: 'Proposal', Amount: 180000, CloseDate: '2026-12-31', IsClosed: false, signal: 'd360', d360Amount: 120000, products: ['Data 360 Profiles'] }, body: 'tier=claim; signal=d360; other_architect_dc=none', accountHints: ACC, oppHints: [OPP] });
    const run = { ...org62Item(`BookRun:run-${STAMP}`, { title: 'Book read', body: `book_at=${STAMP}; rows=1; complete=true` }), occurredAt: STAMP };
    const b = projectOrg62([sweep, book(OPP_2, 'Globex - Card Agentforce'), run], { me: ME_ORG62 });
    const ev = (slack: MissedEvidence['slack'], calendar: MissedEvidence['calendar'] = []): MissedEvidence => ({ calendar, drive: [], sessions: [], slack });
    const finding = (e: MissedEvidence) => missedOpps({ book: b, me: { org62UserId: ME_ORG62, name: 'Ada Example' }, evidence: e, today: '2026-11-12', quarter: { start: '2026-11-01', end: '2027-01-31' } }).findings.find((f) => f.opportunityId === OPP.slice(0, 15));
    const channel = (messages: number, accountOrg62Id: string | null = ACC[0]) => [{ id: 'C0PLACE01', channelName: 'globex-wealth-pov', at: '2026-11-10T16:00:00.000Z', messages, accountOrg62Id }];
    // a channel I really work in, named after the opp: Check on its own
    expect(finding(ev(channel(5)))).toMatchObject({ verdict: 'check', reasons: [expect.objectContaining({ kind: 'slack', text: expect.stringMatching(/Slack channel you work in \(matches 'wealth'\)/) })] });
    // with a meeting on it too (an independent kind): Claim
    const meeting = [{ id: 'e1', title: 'Globex wealth workshop', at: '2026-11-09T16:00:00.000Z', oppOrg62Id: null, accountOrg62Id: ACC[0], owned: true, recurring: false, internalOnly: false }];
    expect(finding(ev(channel(5), meeting))?.verdict).toBe('claim');
    // a one-off message is never evidence; nor a channel of another account
    expect(finding(ev(channel(2)))?.reasons.some((r) => r.kind === 'slack') ?? false).toBe(false);
    expect(finding(ev(channel(5, '001XX0000000009AAA')))?.reasons.some((r) => r.kind === 'slack') ?? false).toBe(false);
    // the channel's account: the one account it names
    const pats = [{ id: 'g', pats: [['globex']] }, { id: 'h', pats: [['hooli']] }];
    expect(channelAccount('ext-globex-wealth', pats)).toBe('g');
    expect(channelAccount('globex-hooli-partners', pats)).toBeNull();
    expect(channelAccount('team-standup', pats)).toBeNull();
  });
});

/** A finding of the mock seed (placeholders), for the type checker. */
export type _Finding = MissedOpp;
