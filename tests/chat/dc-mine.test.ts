/**
 * D-58 fix: the app knows my DCs and their split; requests respect them; one Claim verb; DC-only canvases only on
 * purpose; the next scan confirms a request. Mock DataSource and the shared rules (src/server/deals/dc-requests.ts);
 * the Postgres side of the same cases is tests/db/datasource/dc-mine.test.ts and tests/db/projections/db.test.ts.
 * Placeholders only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, type RouteDef, type RouteKey, type RouteOutput } from '@/contract';
import { renderWorkOrder } from '@/engines/activity/slackbot';
import { mockOrg62IdFor } from '@/mock/org62-opps';
import { personaOf } from '@/personas';
import { previewRouteCall } from '@/server/chat/app-routes';
import { matchInApp } from '@/server/chat/org62';
import type { MockDataSource } from '@/server/datasource/mock';
import { dcConfirmations, dcHolds, dcRowsIn, planDcRequest, withDcAdds, type DcAdd } from '@/server/deals/dc-requests';
import { batchCanvases } from '@/server/time/batch-canvases';
import { mockWith } from './helpers';

const SE = personaOf({});
const OPP = 'opp_umbrella_af'; // open, on my team, no DC in the seed
const DC_ID = 'a0XXX0000000DC1AAA';

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

const base = { ownerName: 'Sam Placeholder', ownerOrg62Id: '005XX0000000MOCKAA', recordTypeId: '012XX0000000MOCKAA', generatedAt: '2026-11-11T12:00:00Z', sourceLabel: 'test' };

describe('the shared rule: a request is checked against my DC', () => {
  const opp = (split: number | null, o: { dcAssigned?: boolean; id?: string | null } = {}) => ({ name: 'CUSTOMER_1 – Data 360 Expansion', dcAssigned: o.dcAssigned ?? true, myDc: { split, role: 'AI + Data Architect', org62DcId: o.id === undefined ? DC_ID : o.id } });

  it('the same split is refused, another split is a change, no DC is an add', () => {
    expect(() => planDcRequest(opp(100), 100)).toThrow(/You already hold a 100% DC on CUSTOMER_1 – Data 360 Expansion \(AI \+ Data Architect\)/);
    expect(planDcRequest(opp(100), 50)).toEqual({ kind: 'change', fromSplit: 100, org62DcId: DC_ID });
    expect(planDcRequest({ name: 'x', dcAssigned: false, myDc: null }, 100)).toEqual({ kind: 'add', fromSplit: null, org62DcId: null });
    // Org62 says I hold one but the app hasn't read it yet: never a silent add
    expect(() => planDcRequest({ name: 'x', dcAssigned: true, myDc: null }, 100)).toThrow(/hasn't read its split yet/);
    expect(() => planDcRequest(opp(50, { id: null }), 100)).toThrow(/Org62 id/);
  });

  it('a change is an UPDATE row on that DC; an ADD row never changes an existing split', () => {
    const ev = { ccId: 'a1', subject: 'Demo', startUtc: '2026-11-10T16:00:00.000Z', endUtc: '2026-11-10T17:00:00.000Z', taskType: 'Demo', durationH: 1, whatId: '006XX0000000001AAA', meetingType: '', description: 'CC#a1' };
    const add: DcAdd = { requestId: 'r1', org62OpportunityId: '006XX0000000002AAA', oppName: 'CUSTOMER_2', role: 'AI + Data Architect', split: 100, comment: 'Built the demo' };
    const change: DcAdd = { requestId: 'r2', kind: 'change', org62OpportunityId: '006XX0000000003AAA', oppName: 'CUSTOMER_1', role: 'AI + Data Architect', split: 50, fromSplit: 100, fromRole: 'AI + Data Architect', org62DcId: DC_ID, comment: 'Shared with the AE' };
    const md = withDcAdds(renderWorkOrder({ ...base, events: [ev], updates: [] }), [add, change], base.ownerOrg62Id);
    const lines = md.split('\n');
    // WO-1: the change in DEAL CONTRIBUTIONS TO UPDATE (no Object column), the add in its own create table
    expect(lines).toContain(`|1|${DC_ID}|Split_Percentage__c|50|100|Change your DC 100% → 50% on CUSTOMER_1 · Shared with the AE|`);
    expect(md).toMatch(/## DEAL CONTRIBUTIONS TO UPDATE \(1 row · 1 DC change\)/);
    expect(md).toMatch(/## EVENTS TO CREATE \(1 row · 1\.00 h of activities\)/);
    expect(md).toMatch(/## DEAL CONTRIBUTIONS TO CREATE \(1 row\)/);
    const rule = lines.find((l) => l.startsWith('**DEAL CONTRIBUTIONS TO CREATE:**'))!;
    expect(rule).toContain("don't create a second one and don't change it");
    expect(rule).not.toMatch(/update its Comments__c and Split_Percentage__c/);
    expect(lines.find((l) => l.startsWith('**DEAL CONTRIBUTIONS TO UPDATE:**'))).toContain('changes one field on an existing Deal Contribution');
    expect(dcRowsIn(md).sort()).toEqual(['006XX0000000002|ai + data architect', `dc:${DC_ID.slice(0, 15)}`].sort());
  });

  it('never makes a DC-only canvas unless asked (Log DCs now)', () => {
    const add: DcAdd = { requestId: 'r1', org62OpportunityId: '006XX0000000002AAA', oppName: 'CUSTOMER_2', role: 'AI + Data Architect', split: 100, comment: 'Built the demo' };
    const rows = { events: [], updates: [], dcs: [add], ucCreates: [], ucUpdates: [] };
    expect(batchCanvases(base, rows, { span: null }).canvases).toEqual([]);
    const own = batchCanvases(base, rows, { span: null, dcOnly: true }).canvases;
    expect(own).toHaveLength(1);
    expect(own[0]!.title).toBe('Deal Contributions · 1 DC');
  });

  it('a scan confirms a request whose DC now answers it (DC-03: an add at any split Org62 shows; a change at the requested one)', () => {
    const reqs = [
      { id: 'q1', oppId: 'o1', status: 'approved' as const, splitPercent: 100 },
      { id: 'q2', oppId: 'o2', status: 'approved' as const, splitPercent: 50, kind: 'change' as const },
      { id: 'q3', oppId: 'o3', status: 'dismissed' as const, splitPercent: 100 },
      { id: 'q4', oppId: 'o4', status: 'approved' as const, splitPercent: 100 },
    ];
    const dcs = new Map([
      ['o1', { split: 100 }],
      ['o2', { split: 100 }], // a change to 50% that hasn't landed
      ['o3', { split: 100 }],
      ['o4', { split: 50 }], // an add made by hand at another split: Org62 wins
    ]);
    expect(dcConfirmations(reqs, dcs).map((x) => x.request.id)).toEqual(['q1', 'q4']);
  });

  it('the Org62 lookup keeps the team and my DC apart', () => {
    const rows = matchInApp([{ org62Id: '006XX0000000009AAA', name: 'CUSTOMER_1', account: null, accountOrg62Id: null, owner: null }], [{ id: 'o1', accountId: 'a1', org62Url: 'https://org62.example.com/006XX0000000009AAA/view', isMine: false, myDc: { split: 100, role: 'AI + Data Architect' }, dcAssigned: true }], []);
    expect(rows[0]!.inApp).toMatchObject({ oppId: 'o1', onMyTeam: false, myDc: { split: 100, role: 'AI + Data Architect' }, dcWords: 'Your DC: 100% · AI + Data Architect' });
  });
});

describe('the incident (mock): I hold a 100% DC on the opp', () => {
  beforeEach(() => {
    ds.recordMyDcs([{ oppId: OPP, split: 100, role: 'AI + Data Architect', org62DcId: DC_ID }]);
  });

  it('every read says my DC; it is not "on the team"', async () => {
    const acct = await call('getAccount', { params: { accountId: (await call('getDeals', {})).accounts.find((a) => a.myDcs.some((d) => d.oppId === OPP))!.id } });
    expect(acct.opps.find((o) => o.id === OPP)).toMatchObject({ dcAssigned: true, myDc: { split: 100, role: 'AI + Data Architect', org62DcId: DC_ID } });
    const list = await call('listDcRequests', {});
    // the seed holds other DCs of mine too (D-63: its opps carry my split)
    expect(list.myDcs.filter((d) => d.oppId === OPP)).toEqual([expect.objectContaining({ oppId: OPP, split: 100, role: 'AI + Data Architect', org62DcId: DC_ID, isOpen: true })]);
  });

  it('a request for 100% is refused and creates nothing; 50% becomes a change row', async () => {
    await expect(ds.createDcRequest({ body: { opp: OPP, split: 100, comment: 'Built the POC' } } as never)).rejects.toThrow(/You already hold a 100% DC/);
    expect((await call('listDcRequests', {})).requests).toEqual([]);
    const c = await call('createDcRequest', { body: { opp: OPP, split: 50, comment: 'Shared with the partner SE' } });
    expect(c.entity).toMatchObject({ kind: 'change', fromSplit: 100, splitPercent: 50, stage: 'waiting', dc: { split: 100, org62DcId: DC_ID }, lockedReason: null });
    // an edit back to my DC's split is refused on the card too, before Apply
    const card = await previewRouteCall(ds as never, { op: 'route_call', route: 'patchDcRequest', params: { id: c.entity.id }, body: { split: 100 } }, SE);
    expect(card.error).toMatch(/you already hold a 100% DC/);
    await expect(ds.patchDcRequest({ params: { id: c.entity.id }, body: { split: 100 } } as never)).rejects.toThrow(/You already hold a 100% DC/);
    // the canvas row says exactly that, in the UPDATE table on my DC's Record Id
    const r = await call('stageLogBatch', { body: { includeProposed: true } });
    const outbox = await call('getOutbox', {});
    const md = outbox.admin.items.map((i) => i.draft).filter((d) => r.entity.draftIds.includes(d.id)).map((d) => (d.destination.kind === 'action' ? String(d.destination.input.markdown) : '')).join('\n');
    expect(md).toContain(`|${DC_ID}|Split_Percentage__c|50|100|Change your DC 100% → 50% on`);
    expect(md).toContain('## DEAL CONTRIBUTIONS TO UPDATE');
    expect(md).not.toContain('## DEAL CONTRIBUTIONS TO CREATE');
    expect(md).not.toMatch(new RegExp(`\\|${mockOrg62IdFor(OPP)}\\|AI \\+ Data Architect\\|50\\|`));
    expect((await call('listDcRequests', {})).requests[0]).toMatchObject({ stage: 'in_canvas' });
  });

  it('the chat card refuses the same split and words a change', async () => {
    const same = await previewRouteCall(ds as never, { op: 'route_call', route: 'createDcRequest', body: { opp: OPP, split: 100, comment: 'Built the POC' } }, SE);
    expect(same.error).toMatch(/you already hold a 100% DC on Umbrella/);
    const change = await previewRouteCall(ds as never, { op: 'route_call', route: 'createDcRequest', body: { opp: OPP, split: 50, comment: 'Built the POC' } }, SE);
    expect(change.error).toBeNull();
    expect(change.lines[0]).toMatchObject({ label: expect.stringMatching(/^Change your DC · /), before: '100% · AI + Data Architect', after: '50% · “Built the POC”' });
  });
});

describe('edit and withdraw (mock)', () => {
  it('edits a waiting request (re-checked against my DC) and withdraws it; Undo restores it', async () => {
    const c = await call('createDcRequest', { body: { opp: OPP, split: 50, comment: 'Built the demo' } });
    const e = await call('patchDcRequest', { params: { id: c.entity.id }, body: { split: 100, comment: 'Built the demo and the sizing' } });
    expect(e.entity).toMatchObject({ kind: 'add', splitPercent: 100, comment: 'Built the demo and the sizing' });
    expect(e.auditId).toBeTruthy();
    const w = await call('withdrawDcRequest', { params: { id: c.entity.id }, body: {} });
    expect(w.entity).toMatchObject({ stage: 'dismissed', status: 'dismissed', lockedReason: 'It was withdrawn' });
    await call('undoAudit', { params: { id: w.auditId! }, body: {} });
    expect((await call('listDcRequests', {})).requests[0]).toMatchObject({ stage: 'waiting', splitPercent: 100 });
    // a withdrawn one leaves room for a new request on the same opp
    await call('withdrawDcRequest', { params: { id: c.entity.id }, body: {} });
    expect((await call('createDcRequest', { body: { opp: OPP, split: 60, comment: 'Built the demo' } })).entity.splitPercent).toBe(60);
  });

  it('a request on a canvas cannot change, and says why', async () => {
    const c = await call('createDcRequest', { body: { opp: OPP, split: 50, comment: 'Built the demo' } });
    await call('stageLogBatch', { body: { includeProposed: true } });
    const cur = (await call('listDcRequests', {})).requests.find((r) => r.id === c.entity.id)!;
    expect(cur.stage).toBe('in_canvas');
    expect(cur.lockedReason).toMatch(/waiting for your Apply on Activity/);
    await expect(ds.patchDcRequest({ params: { id: c.entity.id }, body: { split: 60 } } as never)).rejects.toThrow(/Can't edit the DC request/);
    await expect(ds.withdrawDcRequest({ params: { id: c.entity.id }, body: {} } as never)).rejects.toThrow(/Can't withdraw/);
  });
});

describe('one Claim verb (mock)', () => {
  it('Missed ▸ Claim creates a DC request with the form values (split, role); Triage Claim does too', async () => {
    const r = await call('claimMissed', { params: { id: 'mo_globex_renew' }, body: { split: 60, role: 'AI + Data Architect', comment: 'Ran the renewal workshop' } });
    expect(r.entity).toMatchObject({ status: 'claimed', claimedWorkItemId: null });
    const req = (await call('listDcRequests', {})).requests.find((x) => x.id === r.entity.dcRequestId)!;
    expect(req).toMatchObject({ oppId: 'opp_globex_renew', kind: 'add', splitPercent: 60, role: 'AI + Data Architect', comment: 'Ran the renewal workshop', stage: 'waiting' });
    const t = await call('acceptTriage', { params: { id: 'mo_hooli_data' }, body: {} });
    expect(t.auditId).toBeTruthy();
    const hooli = (await call('listDcRequests', {})).requests.find((x) => x.oppId === 'opp_hooli_data')!;
    expect(hooli).toMatchObject({ kind: 'add', splitPercent: 100, comment: expect.stringMatching(/^Claimed from Missed opportunities/) });
  });

  it('a Claim on an opp I already hold that split on is refused, nothing changes', async () => {
    ds.recordMyDcs([{ oppId: 'opp_globex_renew', split: 100, role: 'AI + Data Architect', org62DcId: DC_ID }]);
    await expect(ds.claimMissed({ params: { id: 'mo_globex_renew' }, body: {} } as never)).rejects.toThrow(/You already hold a 100% DC/);
    expect((await call('getMissed', {})).missed.find((m) => m.id === 'mo_globex_renew')!.status).toBe('new');
  });
});

describe('lone DCs and confirmation (mock)', () => {
  it('no rows ready: a DC request waits (no canvas); Log DCs now makes one on purpose', async () => {
    // log everything that is ready first, so the batch has no rows
    await call('stageLogBatch', { body: { includeProposed: true } });
    await call('createDcRequest', { body: { opp: OPP, split: 50, comment: 'Built the demo' } });
    const quiet = await call('stageLogBatch', { body: { includeProposed: true } });
    expect(quiet.entity.draftIds).toEqual([]);
    expect((await call('listDcRequests', {})).requests[0]!.stage).toBe('waiting');
    const now = await call('stageLogBatch', { body: { dcOnly: true } });
    expect(now.entity.canvases).toEqual([expect.objectContaining({ title: 'Deal Contributions · 1 DC', rows: 0 })]);
    expect((await call('listDcRequests', {})).requests[0]!.stage).toBe('in_canvas');
  });

  it('the next scan that reads the DC confirms the request and links it (DC-03: whatever split Org62 shows)', async () => {
    const c = await call('createDcRequest', { body: { opp: OPP, split: 100, comment: 'Built the demo' } });
    // a read with no DC of mine on the opp confirms nothing
    expect(ds.recordMyDcs([])).toBe(0);
    expect((await call('listDcRequests', {})).requests[0]!.stage).toBe('waiting');
    expect(ds.recordMyDcs([{ oppId: OPP, split: 100, role: 'AI + Data Architect', org62DcId: DC_ID }])).toBe(1);
    const done = (await call('listDcRequests', {})).requests.find((r) => r.id === c.entity.id)!;
    expect(done).toMatchObject({ status: 'verified', stage: 'confirmed', dc: { split: 100, org62DcId: DC_ID }, lockedReason: expect.stringMatching(/Org62 already has this DC/) });
    // a confirmed request leaves room for a change later
    expect((await call('createDcRequest', { body: { opp: OPP, split: 50, comment: 'Shared it' } })).entity).toMatchObject({ kind: 'change', fromSplit: 100 });
  });

  it('the canvas link shows once the canvas item was applied', () => {
    const md = withDcAdds(renderWorkOrder({ ...base, events: [], updates: [] }), [{ requestId: 'r1', org62OpportunityId: '006XX0000000002AAA', oppName: 'CUSTOMER_2', role: 'AI + Data Architect', split: 100, comment: 'x' }], base.ownerOrg62Id);
    const draft = { id: 'd1', status: 'sent' as const, resultUrl: 'https://slack.example/canvas/F0PLACE', destination: { kind: 'action' as const, action: 'slack_canvas.create', target: { label: 'x', url: null }, input: { title: 'x', markdown: md, eventIds: [], hours: 0, updates: 0, part: 1, parts: 1 }, changes: [], text: null } };
    const h = dcHolds([draft as never]);
    expect(h.sent.get('006XX0000000002|ai + data architect')).toBe('d1');
    expect(h.urls.get('d1')).toBe('https://slack.example/canvas/F0PLACE');
  });
});
