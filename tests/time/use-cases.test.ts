/**
 * D-67: use cases in both VDP and Org62 Use_Case__c, the round trip (src/engines/activity/use-cases.ts), the VDP items
 * it makes (src/engines/vdp/steps.ts), the duplicate check before any new use case (src/server/deals/use-cases.ts),
 * and the canvas rows. One describe per row of docs/EDGE-CASES.md (UC-01 … UC-08) and per audit scenario.
 * Placeholders only: no customer names or ids.
 */
import { describe, expect, it } from 'vitest';

import type { Draft, VdpCoveragePayload } from '@/contract';
import { parseWorkOrder } from '@/engines/activity/canvas-parse';
import { renderWorkOrder } from '@/engines/activity/slackbot';
import {
  NO_UC_HOLDS,
  phaseOfStage,
  planUseCases,
  reconcileUseCaseLinks,
  trackOfProduct,
  ucAgentTypes,
  ucEntitlement,
  ucExisting,
  ucProduct,
  ucRowsIn,
  ucSameTitle,
  ucStage,
  UC_TEXT_MAX,
  withUseCaseRows,
  type Org62UseCase,
  type UcOpp,
  type UcVdp,
  type UseCaseHolds,
  type UseCaseLink,
  type UseCasePlanInput,
} from '@/engines/activity/use-cases';
import { vdpSteps } from '@/engines/vdp/steps';
import { canvasActionFor, ucRowCount } from '@/lib/canvas/payload';
import { canvasPromptFor } from '@/lib/canvas/prompt';
import type { VdpSnapshot, VdpUseCase } from '@/lib/vdp/types';
import { withDcAdds } from '@/server/deals/dc-requests';
import { ucDecisionsOf, ucDuplicateGuard, ucHolds } from '@/server/deals/use-cases';
import { batchCanvases } from '@/server/time/batch-canvases';
import { vdpActionForItem } from '@/server/vdp/coverage';

const ME = '005XX0000000MEAAAA';
const OTHER = '005XX0000000OTHAAA';
const OPP = '006XX0000000OP1AAA';
const OPP2 = '006XX0000000OP2AAA';
const ACC = '001XX0000000AC1AAA';
const ACC2 = '001XX0000000AC2AAA';
const NOW = '2026-11-12T16:00:00.000Z';
const REC = 'a1XXX0000000UC1AAA';
const REC2 = 'a1XXX0000000UC2AAA';

const uc = (n: number, o: Partial<VdpUseCase> = {}): VdpUseCase => ({
  id: `00000000-0000-4000-8000-00000000100${n}`,
  track: 'd360',
  displayOrder: n,
  title: `Use case ${n}`,
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
});

const vdp = (useCases: VdpUseCase[], o: Partial<VdpSnapshot> = {}): UcVdp => ({
  accountId: 'acc_1',
  snapshot: {
    id: 'vdp-1',
    slug: 'customer-1',
    url: 'https://vdp.example.test/vdp/customer-1',
    company: { id: 'c1', name: 'CUSTOMER_1', slug: 'customer-1', industry: null, segment: null },
    fiscalYear: 27,
    fiscalQuarter: 4,
    salesforceAccountId: ACC,
    salesforceOpportunityId: OPP,
    salesforceOpportunityIds: [OPP],
    isSeed: false,
    archivedAt: null,
    createdAt: null,
    updatedAt: null,
    lastActivityAt: null,
    aes: [],
    tas: [],
    createdBy: null,
    collaborators: [],
    useCases,
    stakeholders: [],
    assets: [],
    dcNoteCached: false,
    executiveSummary: null,
    ...o,
  },
});

const opp = (o: Partial<UcOpp> = {}): UcOpp => ({ id: 'opp_1', org62Id: OPP, name: 'CUSTOMER_1 – Data 360', accountId: 'acc_1', accountOrg62Id: ACC, isOpen: true, dcSplit: 100, closeDate: '2027-01-15', ...o });
const rec = (o: Partial<Org62UseCase> = {}): Org62UseCase => ({ id: REC, opportunityId: OPP, accountId: ACC, name: 'Use case 1', ownerId: ME, createdById: ME, stage: 'U01 - Not Started', goLive: null, product: 'Data Cloud', createdAt: '2026-11-13T10:00:00.000Z', goneAt: null, ...o });
const link = (o: Partial<UseCaseLink> = {}): UseCaseLink => ({ vdpUseCaseId: uc(1).id, org62UseCaseId: REC, origin: 'app', syncedStage: 'U03 - Scoping', syncedGoLive: null, syncedName: 'Use case 1', ...o });
const input = (o: Partial<UseCasePlanInput> = {}): UseCasePlanInput => ({ vdps: [vdp([uc(1)])], opps: [opp()], org62: { readAt: NOW, records: [] }, links: [], holds: NO_UC_HOLDS, me: ME, ...o });
const base = { ownerName: 'Sam Placeholder', ownerOrg62Id: ME, recordTypeId: '012XX0000000MOCKAA', generatedAt: NOW, sourceLabel: 'test' };
const itemOf = (p: ReturnType<typeof planUseCases>, key: string) => p.items.find((x) => x.key === key)!;
const K1 = `uc:${uc(1).id}`;

describe('UC-01 matching: the VDP use-case id when known, else the opp + a normalized (fuzzy) title', () => {
  it('a linked use case renamed in VDP is still its record: no second create, the title drift is shown', () => {
    const p = planUseCases(input({ vdps: [vdp([uc(1, { title: 'Renamed' })])], org62: { readAt: NOW, records: [rec()] }, links: [link()] }));
    expect(p.creates).toHaveLength(0);
    expect(itemOf(p, K1)).toMatchObject({ state: 'drift', drift: [{ field: 'Use_Case_Name__c', vdp: 'Renamed', org62: 'Use case 1', fix: 'org62_by_hand' }] });
  });

  it('unlinked: my record with the same opp and title (case, spacing, nearly the same words) is the use case', () => {
    for (const name of ['  use CASE   1 ', 'Use-case 1']) expect(itemOf(planUseCases(input({ org62: { readAt: NOW, records: [rec({ name })] } })), K1)).toMatchObject({ state: 'in_org62', org62UseCaseId: REC });
    const fuzzy = planUseCases(input({ vdps: [vdp([uc(1, { title: 'Unified customer profile for service' })])], org62: { readAt: NOW, records: [rec({ name: 'Unified Customer Profile – Service' })] } }));
    expect(itemOf(fuzzy, K1).state).toBe('in_org62');
    // a different use case on the same opp is not it
    expect(itemOf(planUseCases(input({ org62: { readAt: NOW, records: [rec({ name: 'Something else entirely' })] } })), K1).state).toBe('create');
  });

  it('titles that differ only by a number are different use cases (the shared matcher drops one-character words)', () => {
    expect(ucSameTitle('Service agent – Phase 1', 'Service agent – Phase 2')).toBe(false);
    expect(ucSameTitle('Service agent – Phase 2', 'service agent phase 2')).toBe(true);
    expect(itemOf(planUseCases(input({ vdps: [vdp([uc(1, { title: 'Agent Phase 2' })])], org62: { readAt: NOW, records: [rec({ name: 'Agent Phase 1' })] } })), K1).state).toBe('create');
  });

  it('a 15-character opp id matches the 18-character one, and any opp of the VDP counts', () => {
    expect(itemOf(planUseCases(input({ org62: { readAt: NOW, records: [rec({ opportunityId: OPP.slice(0, 15) })] } })), K1).state).toBe('in_org62');
    const two = planUseCases(input({ vdps: [vdp([uc(1)], { salesforceOpportunityIds: [OPP, OPP2] })], opps: [opp(), opp({ id: 'opp_2', org62Id: OPP2, dcSplit: null })], org62: { readAt: NOW, records: [rec({ opportunityId: OPP2 })] } }));
    expect(itemOf(two, K1).state).toBe('in_org62');
  });

  it('reconcile links by title (adopted, synced where the two agree) and by the canvas row (app)', () => {
    const adopted = reconcileUseCaseLinks(input({ vdps: [vdp([uc(1, { executionPhase: 'Discovery' })])], org62: { readAt: NOW, records: [rec({ stage: 'U05 - Implementation' })] } })).add[0]!;
    expect(adopted).toMatchObject({ origin: 'adopted', syncedStage: null, syncedName: 'Use case 1' });
    const sent: UseCaseHolds = { held: new Map(), sent: new Map([[`uc:${uc(1).id}`, { draftId: 'd', at: '2026-11-12T09:00:00.000Z' }]]), sentCreates: new Map([[uc(1).id, { vdpUseCaseId: uc(1).id, opportunityId: OPP, name: 'Use case 1', stage: 'U03 - Scoping', goLive: '', draftId: 'd', at: '2026-11-12T09:00:00.000Z' }]]) };
    expect(reconcileUseCaseLinks(input({ holds: sent, org62: { readAt: NOW, records: [rec({ stage: 'U03 - Scoping', createdAt: '2026-11-12T10:00:00.000Z' })] } })).add).toEqual([{ vdpUseCaseId: uc(1).id, org62UseCaseId: REC, origin: 'app', syncedStage: 'U03 - Scoping', syncedGoLive: null, syncedName: 'Use case 1' }]);
    // another owner's record never links
    expect(reconcileUseCaseLinks(input({ org62: { readAt: NOW, records: [rec({ ownerId: OTHER })] } })).add).toHaveLength(0);
  });
});

describe('a partial or older mirror row never stops a batch', () => {
  it('a snapshot with only use cases and opp ids is read (slug from the row), never thrown on', () => {
    const partial = { accountId: null, snapshot: { useCases: [{ id: 'u1', title: 'Unified customer profile' }], salesforceOpportunityIds: [OPP] } } as unknown as UcVdp;
    const p = planUseCases(input({ vdps: [partial] }));
    expect(p.creates.map((c) => [c.vdpUseCaseId, c.opportunityId, c.product])).toEqual([['u1', OPP, 'Data Cloud']]);
    expect(() => reconcileUseCaseLinks(input({ vdps: [partial] }))).not.toThrow();
    expect(() => ucDuplicateGuard({ vdps: [partial], records: [], opps: [opp()], drafts: [] })('x', { vdpSlug: null })).not.toThrow();
  });
});

describe('UC-02 a VDP use case not yet in Org62 → a canvas row; audit 9: the track mapping', () => {
  it('a titled use case on the VDP’s 100%-DC opp is one create, owned by me, with VDP’s mapping and where it came from', () => {
    const p = planUseCases(input({ vdps: [vdp([uc(1, { executionPhase: 'Build', executionTargetDate: '2027-03-01', detailsInput: 'Details.', generatedFields: { business_challenge: 'The problem.', kpis_impacted: 'The KPIs.', detailed_user_story: 'The story.' } })], { entitlementLeveraged: 'Data Services' })] }));
    expect(p.creates).toHaveLength(1);
    expect(p.creates[0]).toMatchObject({ name: 'Use case 1', opportunityId: OPP, accountId: ACC, product: 'Data Cloud', agentTypes: ['D360 Custom'], entitlement: 'Data Services', stage: 'U05 - Implementation', goLive: '2027-03-01', businessProblem: 'The problem.', kpis: 'The KPIs.' });
    expect(p.creates[0]!.notes).toBe(`Details.\n\nThe story.\n\nSource: VDP https://vdp.example.test/vdp/customer-1 · CC-UC#${uc(1).id}`);
    expect(itemOf(p, K1)).toMatchObject({ state: 'create', oppName: 'CUSTOMER_1 – Data 360' });
  });

  it('D360 → Data Cloud, Agentforce → Agentforce (and back for Org62 → VDP); the picklists use VDP’s fallbacks', () => {
    expect([ucProduct('d360'), ucProduct('agentforce'), ucProduct(null)]).toEqual(['Data Cloud', 'Agentforce', 'Data Cloud']);
    expect([trackOfProduct('Data Cloud'), trackOfProduct('Agentforce'), trackOfProduct(null)]).toEqual(['d360', 'agentforce', 'd360']);
    expect(ucAgentTypes(uc(1, { track: 'agentforce' }))).toEqual(['Agentforce Custom']);
    expect(ucAgentTypes(uc(1, { generatedFields: { consumption_use_cases: ['D360 for Service', 'Agentforce for Sales', 'D360 for Sales'] } }))).toEqual(['D360 for Sales', 'D360 for Service']);
    expect([ucEntitlement(null, 'd360'), ucEntitlement('Data Services', 'agentforce'), ucEntitlement('Conversations', 'agentforce')]).toEqual(['Flex', 'Flex', 'Conversations']);
    expect([ucStage('Discovery'), ucStage('Live'), ucStage('On Hold'), ucStage(null)]).toEqual(['U03 - Scoping', 'U06 - In Production', '', '']);
    expect([phaseOfStage('U02 - Ideation'), phaseOfStage('U04 - Validation'), phaseOfStage('U07 - Lost'), phaseOfStage(null)]).toEqual(['Discovery', 'Discovery', 'On Hold', '']);
  });

  it('text is cut only at the Org62 field’s length (32,768); nothing is created before the first Org62 read', () => {
    expect(UC_TEXT_MAX).toBe(32_768);
    const whole = planUseCases(input({ vdps: [vdp([uc(1, { generatedFields: { business_challenge: 'x'.repeat(5000) } })])] })).creates[0]!;
    expect(whole.businessProblem).toBe('x'.repeat(5000));
    const c = planUseCases(input({ vdps: [vdp([uc(1, { generatedFields: { business_challenge: 'x'.repeat(40_000) }, detailsInput: 'd'.repeat(40_000) })])] })).creates[0]!;
    expect(c.businessProblem.length).toBe(UC_TEXT_MAX);
    expect(c.businessProblem).toMatch(/… \(more in VDP\)$/);
    expect(c.notes.length).toBeLessThanOrEqual(UC_TEXT_MAX);
    expect(c.notes).toMatch(/\n\nSource: VDP .* · CC-UC#/);
    expect(itemOf(planUseCases(input({ org62: { readAt: null, records: [] } })), K1)).toMatchObject({ state: 'skipped', why: expect.stringMatching(/first Org62 read/) });
  });
});

describe('UC-03 a Use_Case__c with no VDP use case → a create_use_case item under the VDP', () => {
  const other = rec({ id: REC2, name: 'Agent for claims', product: 'Agentforce', ownerId: OTHER, createdById: OTHER });
  const p = planUseCases(input({ org62: { readAt: NOW, records: [other] } }));

  it('is an org62_only item and one VDP gap for that opp’s VDP (track and title from Org62)', () => {
    expect(itemOf(p, `rec:${REC2.slice(0, 15)}`)).toMatchObject({ state: 'org62_only', vdpSlug: 'customer-1', title: 'Agent for claims', track: 'agentforce', options: ['leave'] });
    const g = p.vdpGaps.get('customer-1')!;
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ code: 'org62_use_case', fix: { op: 'create_use_case', suggested: 'Agent for claims', values: { track: 'agentforce', org62_use_case_id: REC2 } } });
  });

  it('becomes a create_use_case child under Use cases in the VDP tree, never autopilot, typed inputs required', () => {
    const steps = vdpSteps({ key: 'customer-1', companyName: 'CUSTOMER_1', vdpLabel: 'CUSTOMER_1 FY27 Q4', gaps: p.vdpGaps.get('customer-1')!, candidates: [], useCases: [{ id: uc(1).id, title: 'Use case 1' }] });
    const s = steps.find((x) => x.apply?.key === `customer-1:org62_use_case:${REC2.slice(0, 15)}`)!;
    expect(s).toMatchObject({ kind: 'create_use_case', section: 'use_cases', apply: { op: 'create_use_case', label: 'Add it to VDP' } });
    expect(s.apply!.fields.map((f) => [f.field, f.suggested, f.required])).toEqual([
      ['track', 'agentforce', true],
      ['title', 'Agent for claims', true],
      ['priority', null, true],
      ['division', null, true],
      ['persona', null, true],
      ['details_input', null, true],
    ]);
  });

  it('a record on an opp no VDP of mine lists waits for the VDP (no gap); Leave it closes it', () => {
    const none = planUseCases(input({ vdps: [], org62: { readAt: NOW, records: [other] } }));
    expect(itemOf(none, `rec:${REC2.slice(0, 15)}`)).toMatchObject({ state: 'org62_only', vdpSlug: null });
    expect(none.vdpGaps.size).toBe(0);
    const left = planUseCases(input({ org62: { readAt: NOW, records: [other] }, decisions: { leave: new Set([`rec:${REC2.slice(0, 15)}`]), readd: new Set() } }));
    expect(itemOf(left, `rec:${REC2.slice(0, 15)}`).state).toBe('left');
    expect(left.vdpGaps.size).toBe(0);
  });

  it('done once VDP has it: the next read matches it and the item and gap go (requirement 3)', () => {
    const after = planUseCases(input({ vdps: [vdp([uc(1), uc(2, { title: 'Agent for claims', track: 'agentforce' })])], org62: { readAt: NOW, records: [other] } }));
    expect(itemOf(after, `uc:${uc(2).id}`)).toMatchObject({ state: 'others', org62UseCaseId: REC2 });
    expect(after.items.some((x) => x.state === 'org62_only')).toBe(false);
    expect(after.vdpGaps.size).toBe(0);
  });
});

describe('UC-04 drift: both values shown, never auto-overwritten', () => {
  const at = (o: Partial<VdpUseCase>, r: Partial<Org62UseCase>, l: Partial<UseCaseLink> = {}) => planUseCases(input({ vdps: [vdp([uc(1, o)])], org62: { readAt: NOW, records: [rec(r)] }, links: [link(l)] }));

  it('only VDP changed, on a record the app created and I own: Org62 follows on the canvas (Stage / Go-Live)', () => {
    const p = at({ executionPhase: 'Build', executionTargetDate: '2027-02-01' }, { stage: 'U03 - Scoping' });
    expect(p.updates.map((u) => [u.field, u.currentValue, u.newValue])).toEqual([
      ['Stage__c', 'U03 - Scoping', 'U05 - Implementation'],
      ['Go_Live_Date__c', '(blank)', '2027-02-01'],
    ]);
    expect(itemOf(p, K1).state).toBe('update');
    expect(p.vdpGaps.size).toBe(0);
  });

  it('only Org62 changed: no canvas row; VDP follows through an update_use_case item with both values', () => {
    const p = at({ executionPhase: 'Discovery' }, { stage: 'U05 - Implementation' });
    expect(p.updates).toHaveLength(0);
    expect(itemOf(p, K1)).toMatchObject({ state: 'drift', drift: [{ field: 'Stage__c', vdp: 'Discovery', org62: 'Build', fix: 'vdp' }] });
    const g = p.vdpGaps.get('customer-1')![0]!;
    expect(g).toMatchObject({ code: 'use_case_drift', check: 'wrong', useCaseId: uc(1).id, fix: { op: 'update_use_case', field: 'execution_phase', current: 'Discovery', suggested: 'Build' } });
    const s = vdpSteps({ key: 'customer-1', companyName: 'CUSTOMER_1', vdpLabel: 'x', gaps: [g], candidates: [], useCases: [{ id: uc(1).id, title: 'Use case 1' }] })[0]!;
    expect(s).toMatchObject({ kind: 'use_case_fields', check: 'wrong', section: 'use_cases', apply: { key: `customer-1:use_case_drift:${uc(1).id}`, op: 'update_use_case', label: 'Take Org62’s value' } });
  });

  it('a stage inside one VDP phase (U04 vs Discovery) is not drift; Org62 changing within it never overwrites', () => {
    expect(itemOf(at({ executionPhase: 'Discovery' }, { stage: 'U04 - Validation' }), K1).state).toBe('in_org62');
  });

  it('both changed since they last agreed: the user chooses (no canvas row, a VDP item, and "or change Org62")', () => {
    const p = at({ executionPhase: 'Live' }, { stage: 'U05 - Implementation' });
    expect(p.updates).toHaveLength(0);
    expect(itemOf(p, K1).drift).toEqual([{ field: 'Stage__c', vdp: 'Live', org62: 'Build', fix: 'choose' }]);
    expect(p.vdpGaps.get('customer-1')![0]!.why).toMatch(/Both changed .* or change Org62 to VDP's \(Live\) by hand/);
  });

  it('VDP is empty and Org62 has a value: VDP is filled from Org62, never Org62 cleared', () => {
    const p = at({ executionTargetDate: null }, { goLive: '2027-04-01' }, { syncedGoLive: '2027-04-01' });
    expect(p.updates).toHaveLength(0);
    expect(itemOf(p, K1).drift).toContainEqual({ field: 'Go_Live_Date__c', vdp: '', org62: '2027-04-01', fix: 'vdp' });
  });

  it('a title or a record the app didn’t create: "change it in Org62" when VDP changed, never a canvas row', () => {
    const p = at({ executionPhase: 'Build' }, { stage: 'U03 - Scoping' }, { origin: 'adopted' });
    expect(p.updates).toHaveLength(0);
    expect(itemOf(p, K1).drift).toEqual([{ field: 'Stage__c', vdp: 'Build', org62: 'Discovery', fix: 'org62_by_hand' }]);
    expect(itemOf(at({ executionPhase: 'Build' }, { stage: 'U03 - Scoping', ownerId: OTHER }), K1).drift[0]!.fix).toBe('org62_by_hand');
  });

  it('done once they agree: an update that landed (or a manual edit) moves the synced value; nothing is sent again', () => {
    const i = input({ vdps: [vdp([uc(1, { executionPhase: 'Build' })])], org62: { readAt: NOW, records: [rec({ stage: 'U05 - Implementation' })] }, links: [link()] });
    expect(reconcileUseCaseLinks(i).synced).toEqual([{ vdpUseCaseId: uc(1).id, syncedStage: 'U05 - Implementation' }]);
    expect(itemOf(planUseCases(i), K1).state).toBe('in_org62');
  });
});

describe('UC-05 deleted or inactive in one system', () => {
  it('deleted in Org62: gone, never created again silently; Add it again → a create; Leave it → left', () => {
    const gone = input({ org62: { readAt: NOW, records: [rec({ goneAt: NOW })] }, links: [link()] });
    const p = planUseCases(gone);
    expect(p.creates).toHaveLength(0);
    expect(itemOf(p, K1)).toMatchObject({ state: 'gone', options: ['readd', 'leave'] });
    const readd = planUseCases({ ...gone, decisions: { leave: new Set(), readd: new Set([K1]) } });
    expect(readd.creates).toHaveLength(1);
    expect(readd.creates[0]!.again).toBe(true);
    expect(itemOf(readd, K1)).toMatchObject({ state: 'create', decided: 'readd' });
    expect(itemOf(planUseCases({ ...gone, decisions: { leave: new Set([K1]), readd: new Set() } }), K1).state).toBe('left');
  });

  it('deleted in VDP (linked use case gone from the mirror): Org62-only again, offered back to VDP', () => {
    const p = planUseCases(input({ vdps: [vdp([uc(2)])], org62: { readAt: NOW, records: [rec()] }, links: [link()] }));
    expect(itemOf(p, `rec:${REC.slice(0, 15)}`)).toMatchObject({ state: 'org62_only', why: expect.stringMatching(/Deleted in VDP, still in Org62/) });
    expect(p.vdpGaps.get('customer-1')![0]!.why).toMatch(/VDP no longer does/);
  });

  it('an archived VDP, or one no longer mine: its records stay quiet (never re-proposed anywhere)', () => {
    const archived = planUseCases(input({ vdps: [vdp([uc(1)], { archivedAt: NOW })], org62: { readAt: NOW, records: [rec()] }, links: [link()] }));
    expect(itemOf(archived, K1)).toMatchObject({ state: 'in_org62', why: expect.stringMatching(/archived/) });
    expect(archived.vdpGaps.size).toBe(0);
    const gone = planUseCases(input({ vdps: [], goneVdps: [vdp([uc(1)])], org62: { readAt: NOW, records: [rec()] }, links: [link()] }));
    expect(itemOf(gone, K1).state).toBe('in_org62');
    expect(gone.items.some((x) => x.state === 'org62_only')).toBe(false);
  });

  it('Lost in Org62 (U07) on a live VDP use case: VDP is asked to follow (On Hold), never Org62 reopened', () => {
    const p = planUseCases(input({ vdps: [vdp([uc(1, { executionPhase: 'Build' })])], org62: { readAt: NOW, records: [rec({ stage: 'U07 - Lost' })] }, links: [link({ syncedStage: 'U05 - Implementation' })] }));
    expect(p.updates).toHaveLength(0);
    expect(itemOf(p, K1).drift).toEqual([{ field: 'Stage__c', vdp: 'Build', org62: 'On Hold', fix: 'vdp' }]);
  });
});

describe('UC-06 the VDP’s primary opp changes, the use case moves, or the opp moves to another account', () => {
  it('a record on an opp the VDP no longer lists: Opportunity__c drift (change it in Org62), no second create', () => {
    const p = planUseCases(input({ vdps: [vdp([uc(1)], { salesforceOpportunityIds: [OPP2], salesforceOpportunityId: OPP2 })], opps: [opp(), opp({ id: 'opp_2', org62Id: OPP2, name: 'CUSTOMER_1 – Renewal' })], org62: { readAt: NOW, records: [rec()] }, links: [link({ syncedStage: 'U01 - Not Started' })] }));
    expect(p.creates).toHaveLength(0);
    expect(itemOf(p, K1).drift).toContainEqual({ field: 'Opportunity__c', vdp: OPP2, org62: OPP, fix: 'org62_by_hand' });
  });

  it('the opp moved to another account: Account__c drift; a new create takes the opp’s account (keyed by opp)', () => {
    const moved = opp({ accountOrg62Id: ACC2 });
    expect(itemOf(planUseCases(input({ opps: [moved], org62: { readAt: NOW, records: [rec()] }, links: [link({ syncedStage: 'U01 - Not Started' })] })), K1).drift).toContainEqual({ field: 'Account__c', vdp: ACC2, org62: ACC, fix: 'org62_by_hand' });
    expect(planUseCases(input({ opps: [moved] })).creates[0]!.accountId).toBe(ACC2);
  });
});

describe('UC-07 duplicate Use_Case__c after a double export', () => {
  it('two records of mine with the same opp and title: the oldest is the use case, the other is flagged (never deleted)', () => {
    const older = rec({ createdAt: '2026-11-01T10:00:00.000Z' });
    const newer = rec({ id: REC2, createdAt: '2026-11-02T10:00:00.000Z' });
    const p = planUseCases(input({ org62: { readAt: NOW, records: [newer, older] } }));
    expect(p.creates).toHaveLength(0);
    expect(itemOf(p, K1)).toMatchObject({ state: 'in_org62', org62UseCaseId: REC });
    expect(itemOf(p, `rec:${REC2.slice(0, 15)}`)).toMatchObject({ state: 'duplicate', why: expect.stringMatching(/delete the extra one in Org62 \(the app never deletes\)/) });
    expect(p.vdpGaps.size).toBe(0);
    expect(reconcileUseCaseLinks(input({ org62: { readAt: NOW, records: [newer, older] } })).add[0]!.org62UseCaseId).toBe(REC);
  });

  it('also next to a linked record', () => {
    const p = planUseCases(input({ org62: { readAt: NOW, records: [rec(), rec({ id: REC2, createdAt: '2026-11-14T10:00:00.000Z' })] }, links: [link({ syncedStage: 'U01 - Not Started' })] }));
    expect(itemOf(p, `rec:${REC2.slice(0, 15)}`).state).toBe('duplicate');
  });
});

describe('audit 8 / D-63: only opps with my 100% DC get new use cases (and a VDP made before the DC waits)', () => {
  it('50% DC, team-only and closed opps create nothing, each with why', () => {
    expect(itemOf(planUseCases(input({ opps: [opp({ dcSplit: 50 })] })), K1)).toMatchObject({ state: 'skipped', why: expect.stringMatching(/Waiting for your 100% DC on CUSTOMER_1 – Data 360: Claim DC/) });
    expect(itemOf(planUseCases(input({ opps: [opp({ dcSplit: null })] })), K1).state).toBe('skipped');
    expect(itemOf(planUseCases(input({ opps: [opp({ isOpen: false })] })), K1)).toMatchObject({ state: 'skipped', why: expect.stringMatching(/closed/) });
  });

  it('the VDP existed before the DC: once the DC reads 100% the use case goes', () => {
    expect(planUseCases(input({ opps: [opp({ dcSplit: null })] })).creates).toHaveLength(0);
    expect(planUseCases(input({ opps: [opp({ dcSplit: 100 })] })).creates).toHaveLength(1);
  });

  it('the first in-scope opp on the VDP, primary first; a VDP with no opp uses the account’s only one, never a guess', () => {
    const p = planUseCases(input({ vdps: [vdp([uc(1)], { salesforceOpportunityIds: [OPP, OPP2] })], opps: [opp({ dcSplit: 50 }), opp({ id: 'opp_2', org62Id: OPP2, name: 'CUSTOMER_1 – Agentforce' })] }));
    expect(p.creates[0]).toMatchObject({ opportunityId: OPP2 });
    const none = vdp([uc(1)], { salesforceOpportunityIds: [], salesforceOpportunityId: null });
    expect(planUseCases(input({ vdps: [none] })).creates).toHaveLength(1);
    expect(itemOf(planUseCases(input({ vdps: [none], opps: [opp(), opp({ id: 'opp_2', org62Id: OPP2 })] })), K1).why).toMatch(/lists no open opportunity with your 100% DC/);
  });
});

describe('ordering: holds, a sent canvas, a re-push after a partial failure (requirement 4)', () => {
  const sentFor = (ids: number[], at: string): UseCaseHolds => ({
    held: new Map(),
    sent: new Map(ids.map((n) => [`uc:${uc(n).id}`, { draftId: 'd2', at }])),
    sentCreates: new Map(ids.map((n) => [uc(n).id, { vdpUseCaseId: uc(n).id, opportunityId: OPP, name: `Use case ${n}`, stage: '', goLive: '', draftId: 'd2', at }])),
  });

  it('a pending canvas holds its rows; a sent one hands them off', () => {
    const held: UseCaseHolds = { held: new Map([[`uc:${uc(1).id}`, 'd1']]), sent: new Map(), sentCreates: new Map() };
    expect(itemOf(planUseCases(input({ holds: held })), K1)).toMatchObject({ state: 'in_canvas', canvasDraftId: 'd1' });
    expect(itemOf(planUseCases(input({ holds: sentFor([1], '2026-11-11T16:00:00.000Z') })), K1)).toMatchObject({ state: 'handed_off', canvasDraftId: 'd2' });
  });

  it('partial: Slackbot made one of two; the next read links it, the other waits, and only it is offered again two days on', () => {
    const vdps = [vdp([uc(1), uc(2)])];
    const landed = [rec({ createdAt: '2026-11-11T17:00:00.000Z' })];
    const soon = planUseCases(input({ vdps, holds: sentFor([1, 2], '2026-11-11T16:00:00.000Z'), org62: { readAt: NOW, records: landed } }));
    expect([itemOf(soon, K1).state, itemOf(soon, `uc:${uc(2).id}`).state]).toEqual(['in_org62', 'handed_off']);
    const later = planUseCases(input({ vdps, holds: sentFor([1, 2], '2026-11-10T10:00:00.000Z'), org62: { readAt: NOW, records: landed } }));
    expect(later.creates.map((c) => c.vdpUseCaseId)).toEqual([uc(2).id]);
    expect(later.creates[0]!.again).toBe(true);
  });

  it('ucHolds reads the rows back from canvas drafts by status, and the sent time is the Apply', () => {
    const p = planUseCases(input());
    const md = withUseCaseRows(renderWorkOrder({ ...base, events: [], updates: [] }), p.creates, [], ME);
    const draft = (id: string, status: Draft['status']) => ({ id, status, updatedAt: '2026-11-20T00:00:00.000Z', sentAt: NOW, destination: canvasActionFor({ title: 't', markdown: md, eventIds: [], hours: 0, updates: 0, part: 1, parts: 1 }) }) as Pick<Draft, 'id' | 'status' | 'destination' | 'updatedAt'> & { sentAt: string };
    expect(ucHolds([draft('d1', 'ready')]).held.get(`uc:${uc(1).id}`)).toBe('d1');
    expect(ucHolds([draft('d1', 'rejected')]).held.size).toBe(0);
    expect(ucHolds([draft('d1', 'sent')]).sent.get(`uc:${uc(1).id}`)).toEqual({ draftId: 'd1', at: NOW });
  });
});

describe('UC-08 / audit 11: before any new use case, both systems and what is on its way are checked', () => {
  const past = vdp([uc(5, { title: 'Churn prediction model' })], { slug: 'customer-1-fy26', id: 'vdp-0' });
  const ctx = { vdps: [vdp([uc(1)]), past], records: [rec({ id: REC2, name: 'Agent for claims' })], opps: [opp()], drafts: [] as Array<Pick<Draft, 'id' | 'status' | 'destination'>> };

  it('ucExisting finds it in a past VDP, in Org62, or staged; a new title is new', () => {
    expect(ucExisting('churn prediction model', { vdps: [past.snapshot], records: [], pending: [] })).toMatchObject({ where: 'vdp' });
    expect(ucExisting('Agent for claims', { vdps: [], records: ctx.records, pending: [] })).toMatchObject({ where: 'org62' });
    expect(ucExisting('Agent for claims', { vdps: [], records: ctx.records, pending: [] }, { org62UseCaseId: REC2 })).toBeNull();
    expect(ucExisting('Lead scoring', { vdps: [], records: [], pending: [{ title: 'Lead Scoring', where: 'staged' }] })).toMatchObject({ where: 'pending' });
    expect(ucExisting('A brand new idea', { vdps: [past.snapshot], records: ctx.records, pending: [] })).toBeNull();
  });

  it('the guard scopes to the company (every VDP of the account, its opps’ records, its drafts and canvas rows)', () => {
    const g = ucDuplicateGuard(ctx);
    expect(g('Churn prediction model', { vdpSlug: 'customer-1' })).toMatch(/^Already a use case: “Churn prediction model” on VDP customer-1-fy26/);
    expect(g('Agent for claims', { vdpSlug: 'customer-1' })).toMatch(/in Org62/);
    expect(g('Agent for claims', { vdpSlug: 'customer-1', excludeRecord: REC2 })).toBeNull();
    const canvas = canvasActionFor({ title: 't', markdown: withUseCaseRows(renderWorkOrder({ ...base, events: [], updates: [] }), planUseCases(input({ vdps: [vdp([uc(3, { title: 'Lead scoring' })])] })).creates, [], ME), eventIds: [], hours: 0, updates: 0, part: 1, parts: 1 });
    const staged = { id: 'd9', status: 'ready', destination: { kind: 'action', action: 'vdp.create_use_case', target: { label: 'x', url: null }, input: { vdpSlug: 'customer-1', changes: [{ field: 'title', value: 'Forecast assistant' }] }, changes: [], text: null } } as unknown as Pick<Draft, 'id' | 'status' | 'destination'>;
    const g2 = ucDuplicateGuard({ ...ctx, drafts: [{ id: 'c1', status: 'ready', destination: canvas }, staged] });
    expect(g2('Lead scoring', { vdpSlug: 'customer-1' })).toMatch(/on a logging canvas/);
    expect(g2('Forecast assistant', { accountId: 'acc_1' })).toMatch(/staged for VDP/);
    expect(g2('Forecast assistant', { accountId: 'acc_other' })).toBeNull();
  });

  it('a VDP create_use_case item is refused (409) for a duplicate title, never staged; a new one stages', () => {
    const gaps = planUseCases(input({ org62: { readAt: NOW, records: [rec({ id: REC2, name: 'Agent for claims', product: 'Agentforce' })] } })).vdpGaps.get('customer-1')!;
    const steps = vdpSteps({ key: 'customer-1', companyName: 'CUSTOMER_1', vdpLabel: 'CUSTOMER_1 FY27 Q4', gaps, candidates: [], useCases: [] });
    const cov = { vdps: [{ vdpSlug: 'customer-1', companyName: 'CUSTOMER_1', steps, assetItems: [] }], notInVdp: [] } as unknown as VdpCoveragePayload;
    const key = steps[0]!.apply!.key;
    const values = { priority: '3 - High', division: 'Service', persona: 'Ops lead', details_input: 'Placeholder details.' };
    // the record it comes from is not its own duplicate: it stages, with Org62's title and track
    const ok = vdpActionForItem(cov, [vdp([]).snapshot], { itemKey: key, values }, [], { duplicateOf: ucDuplicateGuard(ctx) });
    expect(ok).toMatchObject({ kind: 'action', action: 'vdp.create_use_case', input: { track: 'agentforce', changes: expect.arrayContaining([{ field: 'title', before: null, value: 'Agent for claims' }]) } });
    // a title another VDP of the company has: refused
    expect(() => vdpActionForItem(cov, [vdp([]).snapshot], { itemKey: key, values: { ...values, title: 'Churn prediction model' } }, [], { duplicateOf: ucDuplicateGuard(ctx) })).toThrow(/Already a use case/);
  });

  it('the decisions are D-61 needs decisions (rules use_case / use_case_readd)', () => {
    const d = (rule: string, subjectId: string) => ({ rule, subjectId, kind: 'not_needed' as const, until: null, reason: 'x', label: null, baseline: {}, decidedAt: NOW });
    const out = ucDecisionsOf([d('use_case', K1), d('use_case_readd', 'uc:b'), d('dc_gap', 'opp_1')]);
    expect([...out.leave]).toEqual([K1]);
    expect([...out.readd]).toEqual(['uc:b']);
  });
});

describe('audit 10: Org62 is only read; writes are canvas rows the user Applies', () => {
  const p = planUseCases(input({ vdps: [vdp([uc(1), uc(2, { track: 'agentforce' })])] }));
  const upd = { vdpUseCaseId: uc(3).id, recordId: 'a1XXX0000000UC9AAA', field: 'Stage__c' as const, newValue: 'U05 - Implementation', currentValue: 'U03 - Scoping', name: 'Use case 3', why: 'VDP execution phase is Build' };
  const md = withUseCaseRows(renderWorkOrder({ ...base, events: [], updates: [] }), p.creates, [upd], ME);

  it('the rule creates as me, skips any opp + title that exists, never edits or deletes another record; fixes are Stage / Go-Live only', () => {
    expect(md).toMatch(/^\*\*USE CASES TO CREATE:\*\* create one Use_Case__c per row with OwnerId `005XX0000000MEAAAA`/m);
    expect(md).toMatch(/Skip a row ONLY if a Use_Case__c with the same Opportunity__c and Use_Case_Name__c already exists, whoever owns it/);
    expect(md).toMatch(/Never edit or delete an existing use case from this table/);
    expect(md).toMatch(/\*\*USE CASES TO UPDATE:\*\* each row changes one field on an existing Use_Case__c: on the record whose Id is in Record Id, and only if `005XX0000000MEAAAA` owns it/);
    expect(md).not.toMatch(/\bDelete\b/);
    expect(md.indexOf('## USE CASES TO CREATE (2 rows)')).toBeGreaterThan(0);
    expect(md.indexOf('## USE CASES TO CREATE (2 rows)')).toBeLessThan(md.indexOf('## USE CASES TO UPDATE (1 row · 1 use-case fix)'));
    expect(md).toContain(`|1|Use case 1|${OPP}|${ACC}|Data Cloud|D360 Custom|Flex||`);
    expect(md).toContain('|1|a1XXX0000000UC9AAA|Stage__c|U05 - Implementation|U03 - Scoping|Use case 3: VDP execution phase is Build|');
  });

  it('the rows read back; the work-order parser never takes them for Events; the preview and prompt count them', () => {
    expect(ucRowsIn(md).creates.map((c) => c.vdpUseCaseId)).toEqual([uc(1).id, uc(2).id]);
    expect(ucRowsIn(md).updates).toEqual([{ recordId: 'a1XXX0000000UC9AAA', field: 'Stage__c', newValue: 'U05 - Implementation' }]);
    expect(parseWorkOrder(md).adds).toHaveLength(0);
    expect(ucRowCount(md)).toBe(3);
    const dest = canvasActionFor({ title: 'Activity log', markdown: md, eventIds: [], hours: 0, updates: 0, part: 1, parts: 1 });
    expect(dest.changes).toContainEqual({ label: 'VDP use cases (Use_Case__c)', before: null, after: '3 to create or update' });
    expect(canvasPromptFor(dest, { url: null, recordTypeName: 'Solutions Event' })).toMatch(/3 VDP use cases \(Use_Case__c\) to create or update/);
  });

  it('on a work order with DC rows, each table has its own paragraph once, in the fixed order', () => {
    const withDc = withDcAdds(renderWorkOrder({ ...base, events: [], updates: [] }), [{ requestId: 'r1', org62OpportunityId: OPP, oppName: 'x', role: 'AI + Data Architect', split: 100, comment: 'c' }], ME);
    const both = withUseCaseRows(withDc, p.creates, [], ME);
    expect(both.match(/^\d+\. /gm)).toEqual(['1. ', '2. ']);
    expect(both.match(/^\*\*[A-Z ]+:\*\*/gm)).toEqual(['**DEAL CONTRIBUTIONS TO CREATE:**', '**USE CASES TO CREATE:**']);
    expect(both.indexOf('## DEAL CONTRIBUTIONS TO CREATE')).toBeLessThan(both.indexOf('## USE CASES TO CREATE'));
  });
});

describe('packing (2026-11-13 B1, D-70): every use case goes on the batch’s one canvas', () => {
  const big = { business_challenge: 'b'.repeat(1100), kpis_impacted: 'k'.repeat(1100) };
  const mk = (n: number) => planUseCases(input({ vdps: [vdp(Array.from({ length: n }, (_, k) => uc(k + 1, { id: `uc-${k + 1}`, title: `Use case number ${k + 1}`, generatedFields: big, detailsInput: 'd'.repeat(1100) })))] }));
  const ev = (k: number) => ({ ccId: `e${k}`, subject: `Meeting ${k}`, startUtc: '2026-11-10T16:00:00.000Z', endUtc: '2026-11-10T17:00:00.000Z', taskType: 'Demo', durationH: 1, whatId: OPP, meetingType: '', description: `Note · CC#e${k}` });
  const rows = (n: number, events = [ev(1), ev(2)]) => {
    const p = mk(n);
    return { events, updates: [], dcs: [], ucCreates: p.creates, ucUpdates: p.updates };
  };

  it('D-70: use cases are rows, so they log on their own; 20 use cases ride on ONE canvas with the rows', () => {
    const alone = batchCanvases(base, rows(2, []), { span: null });
    expect(alone.canvases.map((c) => c.title)).toEqual(['Activity log · 2 use cases']);
    expect(alone.useCases).toEqual({ rows: 2, later: 0 });
    const r = batchCanvases(base, rows(20), { span: 'Nov 10' });
    expect(r.canvases).toHaveLength(1);
    expect(r.useCases).toEqual({ rows: 20, later: 0 });
    const c = r.canvases[0]!;
    expect(c.title).toBe('Activity log · Nov 10 · 2 rows · 20 use cases');
    expect(c.eventIds).toEqual(['e1', 'e2']);
    expect(ucRowsIn(c.markdown).creates.map((x) => x.vdpUseCaseId)).toEqual(Array.from({ length: 20 }, (_, k) => `uc-${k + 1}`));
    expect(c.markdown.length).toBeGreaterThan(12_000); // the old cap would have split this into 7 canvases
  });

  it('all pending use cases go: no per-batch count', () => {
    expect(batchCanvases(base, rows(31), { span: 'Nov 10' }).useCases).toEqual({ rows: 31, later: 0 });
  });

  it('past the byte limit the WHOLE work order splits into parts, each with the rules; never a use-case-only canvas title', () => {
    const r = batchCanvases(base, rows(8), { span: 'Nov 10', limit: 12_000 });
    expect(r.canvases.length).toBeGreaterThan(1);
    r.canvases.forEach((c, k) => {
      expect(new TextEncoder().encode(c.markdown).length).toBeLessThanOrEqual(12_000);
      expect(c.markdown).toMatch(/Slackbot: this canvas is a complete work order/);
      // D-70: a part of use cases alone names no rows ("… · 3 use cases (part 2 of 3)")
      expect(c.title).toMatch(new RegExp(`^Activity log · Nov 10 · (\\d+ rows? · )?\\d+ use cases? \\(part ${k + 1} of ${r.canvases.length}\\)$`));
      expect(c.title).not.toMatch(/^VDP use cases/);
    });
    expect(r.canvases.flatMap((c) => ucRowsIn(c.markdown).creates.map((x) => x.vdpUseCaseId))).toEqual(Array.from({ length: 8 }, (_, k) => `uc-${k + 1}`));
    expect(r.canvases.flatMap((c) => c.eventIds)).toEqual(['e1', 'e2']);
  });

  it('use cases never ride on a DC-only canvas', () => {
    const p = mk(3);
    const r = batchCanvases(base, { events: [], updates: [], dcs: [{ requestId: 'r1', org62OpportunityId: OPP, oppName: 'x', role: 'AI + Data Architect', split: 100, comment: 'c' }], ucCreates: p.creates, ucUpdates: [] }, { span: null, dcOnly: true });
    expect(r.canvases).toHaveLength(1);
    expect(ucRowsIn(r.canvases[0]!.markdown).creates).toEqual([]);
    expect(r.useCases.rows).toBe(0);
  });
});
