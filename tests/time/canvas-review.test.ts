/**
 * 2026-11-13 audit B2: the canvas review's pure parts (src/server/time/canvas-review.ts) over a work order with every
 * row kind: the review rows read from the markdown (a DC change's split and role rows are one), Remove and a row
 * written again (renumbered, every table header and the title rebuilt from what is left), and the checks on an edit's
 * values (Org62's picklists, Duration in 0.25 steps). Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import { eventRow } from '@/engines/activity/slackbot';
import { ucCreateLine, withUcOverride, type UseCaseCreate } from '@/engines/activity/use-cases';
import { canvasActionFor, canvasInputOf } from '@/lib/canvas/payload';
import { canvasRowsOf, retitleCanvas } from '@/lib/canvas/preflight';
import type { DcAdd } from '@/server/deals/dc-requests';
import { batchCanvases, batchTitle } from '@/server/time/batch-canvases';
import { checkedUpdateValue, checkedUseCaseFields, reviewRowsOf, ucCreateOfRow, updateLineWith, withoutRows, withRowReplaced } from '@/server/time/canvas-review';

const ME = '005XX0000000MEAAAA';
const base = { ownerName: 'Sam Placeholder', ownerOrg62Id: ME, recordTypeId: '012XX0000000MOCKAA', generatedAt: '2026-11-13T12:00:00.000Z', sourceLabel: 'test' };
const ev = (k: number) => eventRow({ id: `act-${k}`, subject: `CUSTOMER_${k} / Discovery`, start: `2026-11-1${k}T16:00:00.000Z`, end: `2026-11-1${k}T17:00:00.000Z`, durationH: 1, taskType: 'Customer Discovery', whatOrg62Id: '006XX0000000OP1AAA', origin: 'calendar', note: `Discovery with CUSTOMER_${k}` });
const add: DcAdd = { requestId: 'r1', org62OpportunityId: '006XX0000000OP2AAA', oppName: 'CUSTOMER_2 · Pilot', role: 'AI + Data Architect', split: 100, comment: 'Built the pilot' };
const change: DcAdd = { requestId: 'r2', kind: 'change', org62OpportunityId: '006XX0000000OP3AAA', oppName: 'CUSTOMER_3 · Expansion', role: 'Solution Engineer', split: 50, comment: 'Shared with the partner', fromSplit: 100, fromRole: 'AI + Data Architect', org62DcId: 'a0XXX0000000DC1AAA' };
const uc = (k: number): UseCaseCreate => ({ vdpUseCaseId: `00000000-0000-4000-8000-00000000000${k}`, vdpSlug: 'customer-1', vdpUrl: 'https://vdp.example.test/vdp/customer-1', companyName: 'CUSTOMER_1', displayOrder: k, name: `Use case ${k}`, opportunityId: '006XX0000000OP1AAA', accountId: '001XX0000000AC1AAA', oppName: 'CUSTOMER_1 · Phase 2', oppCloseDate: null, product: 'Data Cloud', agentTypes: ['D360 Custom'], entitlement: 'Flex', stage: 'U03 - Scoping', goLive: '', businessProblem: 'Line one\nLine two', kpis: 'KPI', notes: `Details\n\nSource: VDP https://vdp.example.test/vdp/customer-1 · CC-UC#00000000-0000-4000-8000-00000000000${k}`, again: false });

function canvas() {
  const c = batchCanvases(
    base,
    {
      events: [ev(1), ev(2)],
      updates: [{ recordId: '00UXX0000000EV1AAA', field: 'Duration__c', newValue: '1.5', currentValue: '(blank)', why: 'Time never filled' }],
      dcs: [add, change],
      ucCreates: [uc(1), uc(2)],
      ucUpdates: [{ vdpUseCaseId: 'x', recordId: 'a1XXX0000000UC1AAA', field: 'Stage__c', newValue: 'U04 - Validation', currentValue: 'U03 - Scoping', name: 'Use case 9', why: 'VDP execution phase is Validation' }],
    },
    { span: 'Nov 11–Nov 12' },
  ).canvases[0]!;
  return canvasInputOf(canvasActionFor({ ...c }));
}

describe('the review rows of a work order', () => {
  it('one row per thing to decide on, by kind, in the work order’s order', () => {
    const i = canvas();
    expect(i.title).toBe(batchTitle({ span: 'Nov 11–Nov 12', rows: 2, dcs: 2, useCases: 3 }));
    expect(i.title).toBe('Activity log · Nov 11–Nov 12 · 2 rows · 2 DCs · 3 use cases');
    const rows = reviewRowsOf(i.markdown);
    expect(rows.map((r) => r.key)).toEqual([
      'event:act-1',
      'event:act-2',
      'dc:006XX0000000OP2:ai + data architect',
      `uc:${uc(1).vdpUseCaseId}`,
      `uc:${uc(2).vdpUseCaseId}`,
      'update:Event:00UXX0000000EV1:Duration__c',
      'dcchange:a0XXX0000000DC1',
      'update:Use_Case__c:a1XXX0000000UC1:Stage__c',
    ]);
    // a change of split AND role is two UPDATE lines, one row to decide on
    expect(rows.find((r) => r.kind === 'dcchange')!.rows.map((r) => r.cells[3])).toEqual(['Split_Percentage__c', 'Opportunity_Role__c']);
  });

  it('Remove rebuilds every header and the title from what is left (rows, hours, DCs, changes, fixes)', () => {
    const i = canvas();
    const { input, removed } = withoutRows(i, ['event:act-2', 'dcchange:a0XXX0000000DC1', `uc:${uc(2).vdpUseCaseId}`, 'update:Use_Case__c:a1XXX0000000UC1:Stage__c']);
    expect(removed).toHaveLength(4);
    const md = input.markdown;
    // WO-1: each table recounted on its own; a table with nothing left leaves the canvas
    expect(md).toContain('## EVENTS TO CREATE (1 row · 1.00 h of activities)');
    expect(md).toContain('## DEAL CONTRIBUTIONS TO CREATE (1 row)');
    expect(md).toContain('## USE CASES TO CREATE (1 row)');
    expect(md).toContain('## EVENTS TO UPDATE (1 row)');
    expect(md).not.toContain('## DEAL CONTRIBUTIONS TO UPDATE');
    expect(md).not.toContain('## USE CASES TO UPDATE');
    expect(md).not.toContain('CC#act-2');
    expect(md).not.toContain('|a0XXX0000000DC1AAA|');
    expect(input).toMatchObject({ eventIds: ['act-1'], hours: 1, updates: 1, updateIds: ['00UXX0000000EV1AAA'] });
    expect(input.title).toBe('Activity log · Nov 11–Nov 12 · 1 row · 1 DC · 1 use case');
    // every table numbered from 1 again
    expect(canvasRowsOf(md).map((r) => `${r.section}:${r.cells[0]}`)).toEqual(['add:1', 'add:1', 'use_cases:1', 'update:1']);
    expect(() => withoutRows(i, reviewRowsOf(i.markdown).map((r) => r.key))).toThrow(/Reject the canvas instead/);
    expect(() => withoutRows(i, ['event:act-9'])).toThrow(/no longer on this canvas/);
  });

  it('a row written again keeps its place; a DC change that drops its role row recounts', () => {
    const i = canvas();
    const r = reviewRowsOf(i.markdown).find((x) => x.key === 'update:Event:00UXX0000000EV1:Duration__c')!;
    expect(checkedUpdateValue(r.rows[0]!, '2.25')).toBe('2.25');
    const next = withRowReplaced(i, r.key, [updateLineWith(r.rows[0]!, '2.25')]);
    expect(next.markdown).toContain('|1|00UXX0000000EV1AAA|Duration__c|2.25|(blank)|Time never filled|');
    const one = withRowReplaced(i, 'dcchange:a0XXX0000000DC1', ['|9|a0XXX0000000DC1AAA|Split_Percentage__c|25|100|Change|']);
    expect(one.markdown).toMatch(/## DEAL CONTRIBUTIONS TO UPDATE \(1 row · 1 DC change\)/);
    expect(one.markdown).not.toContain('|Opportunity_Role__c|Solution Engineer|');
  });

  it('a use case reads back from its row, and an edit keeps the source line and CC-UC# key last', () => {
    const i = canvas();
    const r = reviewRowsOf(i.markdown).find((x) => x.kind === 'use_case')!;
    const c = ucCreateOfRow(r.rows[0]!);
    expect(c).toMatchObject({ name: 'Use case 1', businessProblem: 'Line one\nLine two', agentTypes: ['D360 Custom'], source: expect.stringMatching(/^Source: VDP .* · CC-UC#/) });
    const edited = withUcOverride(c, { fields: checkedUseCaseFields({ name: 'Use case 1 (pilot)', stage: 'U04 - Validation', notes: 'Pilot first' }) });
    expect(edited.notes).toBe(`Pilot first\n\n${c.source}`);
    const md = withRowReplaced(i, r.key, [ucCreateLine(1, edited)]).markdown;
    expect(md).toContain('|Use case 1 (pilot)|');
    expect(md).toContain(`Pilot first ⏎  ⏎ ${c.source}|`); // each line break is one ` ⏎ `
    expect(() => checkedUseCaseFields({ stage: 'Discovery' })).toThrow(/one of Org62's values/);
    expect(() => checkedUseCaseFields({ agentTypes: ['Made up type'] })).toThrow(/Org62's values only/);
  });

  it('checks an UPDATE row’s new value against the field', () => {
    const rows = reviewRowsOf(canvas().markdown);
    const dur = rows.find((x) => x.key.startsWith('update:Event'))!.rows[0]!;
    const stage = rows.find((x) => x.key.startsWith('update:Use_Case__c'))!.rows[0]!;
    expect(() => checkedUpdateValue(dur, '1.3')).toThrow(/0\.25 steps/);
    expect(() => checkedUpdateValue(stage, 'Live')).toThrow(/Org62's stages/);
    expect(checkedUpdateValue(stage, 'U06 - In Production')).toBe('U06 - In Production');
  });

  it('retitles a forecast-style title by its row count only', () => {
    expect(retitleCanvas('Specialist forecast · 4 rows', { rows: 3, dcs: 0, useCases: 0 })).toBe('Specialist forecast · 3 rows');
    expect(retitleCanvas('Activity log · Nov 3 · 2 rows (part 1 of 2)', { rows: 1, dcs: 1, useCases: 0 })).toBe('Activity log · Nov 3 · 1 row · 1 DC (part 1 of 2)');
  });
});
