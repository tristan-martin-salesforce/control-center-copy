/**
 * D-70 landings (docs/design/landings.md), the pure part both DataSources run (src/lib/landings): the sync over drafts,
 * rows and the use-case plan; the writes a canvas carries (create, update X → Y), their states through Apply, the
 * read-back, Remove, reject and an undone batch; the backfill; one id per use case across both systems; the re-derive's
 * Event update candidates; and the views. Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import type { ActivityEntry, DcRequest, Draft } from '@/contract';
import { renderWorkOrder, type WorkOrderEvent } from '@/engines/activity/slackbot';
import { NO_UC_HOLDS, planUseCases, type Org62UseCase, type UcOpp, type UcVdp, type UseCaseLink, type UseCasePlanInput } from '@/engines/activity/use-cases';
import { canvasActionFor, canvasInputOf } from '@/lib/canvas/payload';
import { upsertTable } from '@/lib/canvas/tables';
import { applyChanges, EMPTY_STORE, type LandingStore } from '@/lib/landings/model';
import { syncLandings, type LandingWorld } from '@/lib/landings/sync';
import { eventUpdatesForBatch, eventUpdatesView, patchEventUpdate, proposeEventUpdates } from '@/lib/landings/updates';
import { canvasWritesView, recordLandingsView, ucLandingsView } from '@/lib/landings/views';
import type { VdpSnapshot, VdpUseCase } from '@/lib/vdp/types';
import { labelsFor } from '@/server/landings/ops';
import { renderBatch } from '@/server/time/batch-canvases';
import { actionDraftFor } from '@/server/vdp/coverage';

const NOW = '2026-11-14T16:00:00.000Z';
const ME = '005XX0000000MEAAAA';
const OPP = '006XX0000000OP1AAA';
const ACC = '001XX0000000AC1AAA';
const REC = 'a1XXX0000000UC1AAA';
const EVT = '00UXX0000000EV1AAA';

let n = 0;
const newId = () => `id${++n}`;

const entry = (id: string, o: Partial<ActivityEntry> = {}): ActivityEntry =>
  ({ id, version: 1, date: '2026-11-10', start: '2026-11-10T16:00:00.000Z', end: '2026-11-10T18:00:00.000Z', durationH: 2, taskType: 'Discovery', oppId: 'opp_1', oppName: 'CUSTOMER_1 – Opp', accountName: 'CUSTOMER_1', meetingType: 'CF', description: `Row ${id}`, status: 'approved', confidence: 'likely', sources: [], userLockedFields: [], issues: [], updatedAt: NOW, fromOrg62: false, excludedReason: null, loggedAt: null, verifiedAt: null, internal: false, dismissSource: null, logNote: null, logNoteBasis: null, why: null, suggestion: null, ...o }) as ActivityEntry;

const ev = (id: string, h = 2): WorkOrderEvent => ({ ccId: id, subject: `Row ${id}`, startUtc: '2026-11-10T16:00:00.000Z', endUtc: '2026-11-10T18:00:00.000Z', taskType: 'Discovery', durationH: h, whatId: OPP, meetingType: '', description: `Note · CC#${id}` });
const BASE = { ownerName: 'Sam Placeholder', ownerOrg62Id: ME, recordTypeId: '012XX0000000MOCKAA', generatedAt: NOW, sourceLabel: 'test' };

function canvas(id: string, status: Draft['status'], items: Parameters<typeof renderBatch>[1], at = NOW): Draft {
  const md = renderBatch(BASE, items);
  const events = items.flatMap((i) => ('e' in i ? [i.e] : []));
  const ups = items.flatMap((i) => ('u' in i ? [i.u] : []));
  const dest = canvasActionFor({ title: `Activity log · ${id}`, markdown: md, eventIds: events.map((e) => e.ccId), hours: events.reduce((s, e) => s + e.durationH, 0), updates: ups.length, updateIds: ups.map((u) => u.recordId), part: 1, parts: 1 });
  const d = actionDraftFor(dest, { id, now: at, rendered: () => ({}) as never });
  return { ...d, status, ...(status === 'sent' ? { attempts: [{ id: 'att1', at, mode: 'send', dryRun: false, outcome: 'sent' }] } : {}) } as Draft;
}

const world = (o: Partial<LandingWorld> = {}): LandingWorld => ({ now: NOW, drafts: [], activity: [], dcRequests: [], useCases: null, candidates: [], ...o });

function run(store: LandingStore, w: LandingWorld) {
  const r = syncLandings(store, w, { newId });
  return { store: applyChanges(store, r.changes), changes: r.changes, byKey: r.useCaseByKey };
}

const writesOf = (s: LandingStore, draftId: string) => s.writes.filter((w) => w.draftId === draftId);

describe('a logging canvas stages one write per row, and its state follows Apply, the read-back, Remove and reject', () => {
  it('staged → sent → verified, with the create carrying the row exactly as written', () => {
    const d = canvas('d1', 'ready', [{ e: ev('a1') }, { e: ev('a2', 1.5) }]);
    let s = run(EMPTY_STORE, world({ drafts: [d], activity: [entry('a1'), entry('a2')] })).store;
    expect(writesOf(s, 'd1').map((w) => [w.rowKey, w.op, w.state, w.origin, w.reason])).toEqual([
      ['event:a1', 'create', 'staged', 'canvas', 'A new Event from your row'],
      ['event:a2', 'create', 'staged', 'canvas', 'A new Event from your row'],
    ]);
    expect(writesOf(s, 'd1')[1]!.after).toMatchObject({ Subject: 'Row a2', Duration__c: '1.5', WhatId: OPP, SE_Task_Type__c: 'Discovery' });
    expect(s.landings.map((l) => [l.recordId, l.state])).toEqual([
      ['a1', 'staged'],
      ['a2', 'staged'],
    ]);
    // Apply: sent (its time is the live attempt's)
    s = run(s, world({ drafts: [{ ...d, status: 'sent', attempts: [{ id: 'x', at: '2026-11-14T17:00:00.000Z', mode: 'send', dryRun: false, outcome: 'sent' }] } as Draft], activity: [entry('a1', { status: 'synced_to_canvas' }), entry('a2', { status: 'synced_to_canvas' })] })).store;
    expect(writesOf(s, 'd1').map((w) => [w.state, w.sentAt])).toEqual([
      ['sent', '2026-11-14T17:00:00.000Z'],
      ['sent', '2026-11-14T17:00:00.000Z'],
    ]);
    // the read-back verifies one, finds the other deleted in Org62
    s = run(s, world({ drafts: [{ ...d, status: 'sent' } as Draft], activity: [entry('a1', { status: 'verified', verifiedAt: '2026-11-14T18:00:00.000Z' }), entry('a2', { status: 'verify_failed', issues: ['Deleted in Org62'] })] })).store;
    expect(s.landings.map((l) => [l.recordId, l.state, l.verifiedAt])).toEqual([
      ['a1', 'verified', '2026-11-14T18:00:00.000Z'],
      ['a2', 'missing', null],
    ]);
    expect(writesOf(s, 'd1').map((w) => w.state)).toEqual(['verified', 'sent']);
  });

  it('Remove before Apply keeps the write, as removed; Undo puts it back; reject rejects the rest; an undone batch is removed', () => {
    const d = canvas('d1', 'ready', [{ e: ev('a1') }, { e: ev('a2') }]);
    let s = run(EMPTY_STORE, world({ drafts: [d], activity: [entry('a1'), entry('a2')] })).store;
    const without = canvas('d1', 'ready', [{ e: ev('a2') }]);
    s = run(s, world({ drafts: [without] })).store;
    expect(writesOf(s, 'd1').map((w) => [w.rowKey, w.state])).toEqual([
      ['event:a1', 'removed'],
      ['event:a2', 'staged'],
    ]);
    expect(s.landings.find((l) => l.recordId === 'a1')!.state).toBe('not_sent');
    s = run(s, world({ drafts: [d] })).store;
    expect(writesOf(s, 'd1').map((w) => w.state)).toEqual(['staged', 'staged']);
    s = run(s, world({ drafts: [{ ...d, status: 'rejected' } as Draft] })).store;
    expect(writesOf(s, 'd1').map((w) => w.state)).toEqual(['rejected', 'rejected']);
    const d2 = canvas('d2', 'ready', [{ e: ev('a3') }]);
    s = run(s, world({ drafts: [d2] })).store;
    s = run(s, world({ drafts: [] })).store;
    expect(writesOf(s, 'd2').map((w) => w.state)).toEqual(['removed']);
  });

  it('a Duration fix is "update · Duration 2 h → 3 h"; the run lists its writes in the canvas order', () => {
    const fix = { recordId: EVT, field: 'Duration__c', newValue: '3', currentValue: '2', why: 're-derived: hands-on 2 h → 3 h' };
    const d = canvas('d1', 'sent', [{ e: ev('a1') }, { u: fix }]);
    const s = run(EMPTY_STORE, world({ drafts: [d], activity: [entry('a1', { status: 'synced_to_canvas' })], eventIds: new Map([['a9', EVT]]) })).store;
    const view = canvasWritesView(s, 'd1', d, labelsFor(world({ activity: [entry('a1'), entry('a9', { description: 'Earlier meeting' })] }), s), () => 'Activity log · d1');
    expect(view.writes.map((w) => [w.label, w.summary, w.state])).toEqual([
      ['Row a1', 'create · Duration 2 h · Task type Discovery', 'sent'],
      ['Earlier meeting', 'update · Duration 2 h → 3 h', 'sent'],
    ]);
    expect(view.counts).toEqual({ create: 1, update: 1, delete: 0, removed: 0 });
  });
});

describe('backfill: what predates landings', () => {
  it('a canvas first seen after Apply is history (reason and origin backfill); verified rows with no canvas get a landing only', () => {
    const d = canvas('old', 'sent', [{ e: ev('a1') }], '2026-10-01T16:00:00.000Z');
    const s = run(EMPTY_STORE, world({ drafts: [d], activity: [entry('a1', { status: 'verified' }), entry('a7', { status: 'verified', fromOrg62: true }), entry('a8', { status: 'approved' })] })).store;
    expect(writesOf(s, 'old').map((w) => [w.origin, w.reason, w.state, w.createdAt])).toEqual([['backfill', 'backfill', 'verified', '2026-10-01T16:00:00.000Z']]);
    expect(s.landings.map((l) => [l.recordId, l.state]).sort()).toEqual([
      ['a1', 'verified'],
      ['a7', 'verified'],
    ]);
    // idempotent: a second pass changes nothing
    const again = syncLandings(s, world({ drafts: [d], activity: [entry('a1', { status: 'verified' }), entry('a7', { status: 'verified', fromOrg62: true }), entry('a8')] }), { newId });
    expect(again.changes).toEqual({ landings: { insert: [], update: [], remove: [] }, writes: { insert: [], update: [] }, useCases: { insert: [], update: [], remove: [] } });
  });

  it('DC requests: on a canvas a staged write; confirmed in Org62 a verified landing', () => {
    const dc: DcRequest = { id: 'dcr1', kind: 'add', oppId: 'opp_1', oppName: 'CUSTOMER_1 – Opp', accountId: null, accountName: null, org62OpportunityId: OPP, role: 'Solution Engineer', splitPercent: 100, fromSplit: null, comment: 'Ran discovery', status: 'approved', stage: 'in_canvas', outcome: null, note: null, canvasDraftId: 'd1', canvasUrl: null, dc: null, lockedReason: null, createdAt: NOW, updatedAt: NOW };
    const md = upsertTable(renderWorkOrder({ ...BASE, events: [ev('a1')], updates: [] }), 'dcs_create', 'DC rule', [['', 'Deal_Contribution__c', 'CUSTOMER_1 – Opp', '', '', 'Solution Engineer', '100', OPP, '', 'Ran discovery']]);
    const d = { ...canvas('d1', 'ready', [{ e: ev('a1') }]), destination: { ...canvas('d1', 'ready', [{ e: ev('a1') }]).destination, input: { ...(canvas('d1', 'ready', [{ e: ev('a1') }]).destination as { input: Record<string, unknown> }).input, markdown: md } } } as Draft;
    expect(canvasInputOf(d.destination as never).markdown).toContain('## DEAL CONTRIBUTIONS TO CREATE (1 row)');
    let s = run(EMPTY_STORE, world({ drafts: [d], dcRequests: [dc] })).store;
    expect(s.writes.find((w) => w.rowKey.startsWith('dc:'))).toMatchObject({ op: 'create', state: 'staged', after: { Split_Percentage__c: '100', Opportunity_Role__c: 'Solution Engineer' } });
    expect(s.landings.find((l) => l.recordKind === 'deal_contribution')!.recordId).toBe('dcr1');
    s = run(s, world({ drafts: [{ ...d, status: 'sent' } as Draft], dcRequests: [{ ...dc, stage: 'confirmed', dc: { split: 100, role: 'Solution Engineer', org62DcId: 'a0XXX0000000DC1AAA', lastSeenAt: NOW } }] })).store;
    expect(s.landings.find((l) => l.recordKind === 'deal_contribution')).toMatchObject({ state: 'verified', externalId: 'a0XXX0000000DC1AAA' });
  });
});

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

const uc = (k: number, o: Partial<VdpUseCase> = {}): VdpUseCase => ({ id: `00000000-0000-4000-8000-00000000100${k}`, track: 'd360', displayOrder: k, title: `Use case ${k}`, priority: null, division: null, persona: null, detailsInput: null, executionPhase: null, executionStartDate: null, executionTargetDate: null, executionDurationValue: null, executionDurationUnit: null, hasAi: false, generatedFields: null, painThemeId: null, sourceLibraryId: null, createdAt: null, updatedAt: null, detailLoaded: true, ...o });
const vdp = (useCases: VdpUseCase[], o: Partial<VdpSnapshot> = {}): UcVdp => ({
  accountId: 'acc_1',
  snapshot: { id: 'vdp-1', slug: 'customer-1', url: 'https://vdp.example.test/vdp/customer-1', company: { id: 'c1', name: 'CUSTOMER_1', slug: 'customer-1', industry: null, segment: null }, fiscalYear: 27, fiscalQuarter: 4, salesforceAccountId: ACC, salesforceOpportunityId: OPP, salesforceOpportunityIds: [OPP], isSeed: false, archivedAt: null, createdAt: null, updatedAt: null, lastActivityAt: null, aes: [], tas: [], createdBy: null, collaborators: [], useCases, stakeholders: [], assets: [{ id: 'as1', title: 'Demo deck', url: 'https://docs.example.test/deck', type: 'deck', description: null }], dcNoteCached: false, executiveSummary: null, ...o },
});
const opp = (o: Partial<UcOpp> = {}): UcOpp => ({ id: 'opp_1', org62Id: OPP, name: 'CUSTOMER_1 – Opp', accountId: 'acc_1', accountOrg62Id: ACC, isOpen: true, dcSplit: 100, closeDate: '2027-01-15', ...o });
const rec = (o: Partial<Org62UseCase> = {}): Org62UseCase => ({ id: REC, opportunityId: OPP, accountId: ACC, name: 'Use case 1', ownerId: ME, createdById: ME, stage: 'U01 - Not Started', goLive: null, product: 'Data Cloud', createdAt: NOW, goneAt: null, ...o });
const link = (o: Partial<UseCaseLink> = {}): UseCaseLink => ({ vdpUseCaseId: uc(1).id, org62UseCaseId: REC, origin: 'app', syncedStage: 'U01 - Not Started', syncedGoLive: null, syncedName: 'Use case 1', ...o });
const ucInput = (o: Partial<UseCasePlanInput> = {}): UseCasePlanInput => ({ vdps: [vdp([uc(1)])], opps: [opp()], org62: { readAt: NOW, records: [] }, links: [], holds: NO_UC_HOLDS, me: ME, ...o });
const ucWorld = (i: UseCasePlanInput, o: Partial<LandingWorld> = {}) => world({ useCases: { plan: planUseCases(i), input: i }, ...o });

function ucView(s: LandingStore, w: LandingWorld, byKey: ReadonlyMap<string, string>) {
  return ucLandingsView({ store: s, world: w, useCaseByKey: byKey, accountName: () => 'CUSTOMER_1', labelOf: labelsFor(w, s), draftTitle: () => 'canvas', readAt: NOW });
}

describe('use cases: neither, one or both, one id across both systems', () => {
  it('VDP only (on the next canvas) → both after the read; its two landings say so', () => {
    const w0 = ucWorld(ucInput());
    const r0 = run(EMPTY_STORE, w0);
    const v0 = ucView(r0.store, w0, r0.byKey).items[0]!;
    expect([v0.where, v0.org62?.state, v0.vdp?.state, v0.ready, v0.sends]).toEqual(['vdp', 'not_sent', 'verified', true, 'New in Org62 on CUSTOMER_1 – Opp']);
    expect(v0.assets).toEqual([{ id: 'vdpasset:as1', title: 'Demo deck', url: 'https://docs.example.test/deck', kind: 'deck', state: 'verified', words: 'In VDP' }]);
    const id = v0.id;
    const w1 = ucWorld(ucInput({ org62: { readAt: NOW, records: [rec()] }, links: [link()] }));
    const r1 = run(r0.store, w1);
    const v1 = ucView(r1.store, w1, r1.byKey).items[0]!;
    expect([v1.id, v1.where, v1.org62?.state, v1.org62?.externalId]).toEqual([id, 'both', 'verified', REC]);
  });

  it('an Org62-only use case added to VDP stays one use case (its landings and their history keep the same id)', () => {
    const w0 = ucWorld(ucInput({ vdps: [vdp([])], org62: { readAt: NOW, records: [rec({ name: 'From Org62' })] } }));
    const r0 = run(EMPTY_STORE, w0);
    const v0 = ucView(r0.store, w0, r0.byKey).items[0]!;
    expect([v0.key, v0.where]).toEqual([`rec:${REC.slice(0, 15)}`, 'org62']);
    // VDP now has it (pushed from the Org62 → VDP item) and the read linked them
    const w1 = ucWorld(ucInput({ vdps: [vdp([uc(1, { title: 'From Org62' })])], org62: { readAt: NOW, records: [rec({ name: 'From Org62' })] }, links: [link({ syncedName: 'From Org62', origin: 'adopted' })] }));
    const r1 = run(r0.store, w1);
    const v1 = ucView(r1.store, w1, r1.byKey).items[0]!;
    expect([v1.key, v1.id, v1.where]).toEqual([`uc:${uc(1).id}`, v0.id, 'both']);
    expect(r1.store.useCases).toHaveLength(1);
  });

  it('differences field by field, with the side that changed since they agreed and your pick', () => {
    const i = ucInput({ vdps: [vdp([uc(1, { executionPhase: 'Build', title: 'Use case 1' })])], org62: { readAt: NOW, records: [rec({ stage: 'U03 - Scoping', ownerId: ME })] }, links: [link({ origin: 'adopted' })] });
    const w = ucWorld(i);
    const r = run(EMPTY_STORE, w);
    const v = ucView(r.store, w, r.byKey).items[0]!;
    expect(v.differences).toEqual([
      { field: 'stage', label: 'Stage', org62: 'U03 - Scoping', vdp: 'Build', changed: 'both', pick: null, next: 'Pick the right value', take: { org62: null, vdp: null } },
    ]);
    expect([v.org62?.state, v.vdp?.state, v.question?.code]).toEqual(['differs', 'differs', 'pick_value']);
    // you pick VDP's: Org62's Stage__c goes on the next canvas as an UPDATE row (a record you own)
    const picked = planUseCases({ ...i, overrides: { [`pick:${uc(1).id}|Stage__c`]: { fields: { take: 'vdp', vdp: 'Build', org62: 'Discovery' }, at: NOW } } });
    expect(picked.updates).toEqual([expect.objectContaining({ field: 'Stage__c', newValue: 'U05 - Implementation', currentValue: 'U03 - Scoping', why: "your pick: VDP's Stage Build" })]);
    // you pick Org62's: a VDP change to push (the VDP tree's use_case_drift item)
    const org = planUseCases({ ...i, overrides: { [`pick:${uc(1).id}|Stage__c`]: { fields: { take: 'org62', vdp: 'Build', org62: 'Discovery' }, at: NOW } } });
    expect(org.updates).toEqual([]);
    expect(org.vdpGaps.get('customer-1')?.map((g) => [g.code, g.fix.kind === 'app' ? g.fix.suggested : null])).toEqual([['use_case_drift', 'Discovery']]);
  });

  it('a use case that asks you something: the opp it goes on (several of yours on the account), then it is ready', () => {
    const two = [opp({ id: 'opp_1', org62Id: OPP }), opp({ id: 'opp_2', org62Id: '006XX0000000OP2AAA', name: 'CUSTOMER_1 – Second' })];
    const i = ucInput({ vdps: [vdp([uc(1)], { salesforceOpportunityIds: [], salesforceOpportunityId: null })], opps: two });
    const w = ucWorld(i);
    const r = run(EMPTY_STORE, w);
    const v = ucView(r.store, w, r.byKey).items[0]!;
    expect([v.state, v.question?.code, v.question?.opps.map((o) => o.name), v.ready]).toEqual(['skipped', 'pick_opp', ['CUSTOMER_1 – Opp', 'CUSTOMER_1 – Second'], false]);
    const answered = planUseCases({ ...i, overrides: { [`uc:${uc(1).id}`]: { fields: { opportunityId: '006XX0000000OP2AAA' }, at: NOW } } });
    expect(answered.creates.map((c) => c.opportunityId)).toEqual(['006XX0000000OP2AAA']);
  });

  it('left out of Org62 by you: no create, state left (Undo brings it back)', () => {
    const p = planUseCases(ucInput({ decisions: { leave: new Set([`uc:${uc(1).id}`]), readd: new Set() } }));
    expect([p.creates.length, p.items[0]!.state]).toEqual([0, 'left']);
  });

  it('a use case on a canvas is a staged Org62 write; its record read back verifies it', () => {
    const p = planUseCases(ucInput());
    const d = canvas('d1', 'ready', [{ c: p.creates[0]! }]);
    const w = ucWorld(ucInput(), { drafts: [d] });
    const s = run(EMPTY_STORE, w).store;
    expect(s.writes.map((x) => [x.rowKey, x.op, x.state, x.after.Use_Case_Name__c])).toEqual([[`uc:${uc(1).id}`, 'create', 'staged', 'Use case 1']]);
    const w2 = ucWorld(ucInput({ org62: { readAt: NOW, records: [rec()] }, links: [link()] }), { drafts: [{ ...d, status: 'sent' } as Draft] });
    const s2 = run(s, w2).store;
    expect(s2.writes[0]!.state).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// Event updates: the re-derive's candidates
// ---------------------------------------------------------------------------

describe('Event updates: proposed, approved, on the next canvas, history either way', () => {
  const cand = { activityEntryId: 'a1', org62EventId: EVT, field: 'duration', from: '2', to: '3', reason: 're-derived: hands-on 2 h → 3 h' };
  const act = (id: string) => (id === 'a1' ? entry('a1', { status: 'verified' }) : undefined);

  it('one proposed write per update, never twice; an unknown field or row is skipped with why', () => {
    const p = proposeEventUpdates(EMPTY_STORE, [cand, cand, { ...cand, field: 'Colour' }, { ...cand, activityEntryId: 'gone' }], { now: NOW, newId, activity: act });
    const s = applyChanges(EMPTY_STORE, p.changes);
    expect(p.proposed).toHaveLength(1);
    expect(p.skipped.map((x) => x.why)).toEqual(['The same update is already proposed or on its way', 'No canvas UPDATE row writes Colour', 'The row is not in Activity']);
    expect(eventUpdatesView(s, () => ({ description: 'Discovery call', date: '2026-11-10' }))).toEqual([expect.objectContaining({ summary: 'update · Duration 2 h → 3 h', state: 'proposed', fieldLabel: 'Duration', label: 'Discovery call' })]);
    expect(applyChanges(s, proposeEventUpdates(s, [cand], { now: NOW, newId, activity: act }).changes).writes).toHaveLength(1);
  });

  it('approved → on the canvas (the same write moves onto it) → taken off: back to approved as a new write, the removed one kept', () => {
    let s = applyChanges(EMPTY_STORE, proposeEventUpdates(EMPTY_STORE, [cand], { now: NOW, newId, activity: act }).changes);
    const id = s.writes[0]!.id;
    expect(eventUpdatesForBatch(s, { approveComplete: false })).toEqual([]);
    const ok = patchEventUpdate(s, id, 'approve', NOW);
    if ('error' in ok) throw new Error(ok.why);
    s = applyChanges(s, ok.changes);
    const ups = eventUpdatesForBatch(s, { approveComplete: false });
    expect(ups).toEqual([{ writeId: id, recordId: EVT, field: 'Duration__c', newValue: '3', currentValue: '2', why: cand.reason }]);
    const d = canvas('d1', 'ready', [{ u: ups[0]! }]);
    s = run(s, world({ drafts: [d], activity: [entry('a1', { status: 'verified' })] })).store;
    expect(s.writes.map((w) => [w.id, w.draftId, w.state])).toEqual([[id, 'd1', 'staged']]);
    expect(recordLandingsView(s, 'activity_event', 'a1', () => 'Discovery call', () => 'Activity log · d1').landings[0]!.writes.map((w) => w.summary)).toEqual(['update · Duration 2 h → 3 h']);
    s = run(s, world({ drafts: [canvas('d1', 'ready', [{ e: ev('a5') }])], activity: [entry('a1', { status: 'verified' })] })).store;
    const mine = s.writes.filter((w) => w.origin === 'proposed');
    expect(mine.map((w) => [w.draftId, w.state])).toEqual([
      ['d1', 'removed'],
      [null, 'approved'],
    ]);
    expect(patchEventUpdate(s, id, 'dismiss', NOW)).toMatchObject({ error: 'locked' });
  });
});
