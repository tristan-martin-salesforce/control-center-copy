/**
 * Activity ▸ Org62 ▸ Weeks: the week picker (./weeks-derive.ts) and the landing marks (./landing-derive.ts). Pure.
 */
import { describe, expect, it } from 'vitest';

import type { UseCaseLanding } from '@/contract';
import { batchSelectionOf } from '@/server/time/batch-canvases';

import { landingPill, runWritesLine, ucGroups, whereLine, writeState } from './landing-derive';
import { pickerRange, previousQuarter, weekGroups } from './weeks-derive';

describe('the week picker', () => {
  it('the quarter before, across a fiscal year', () => {
    expect(previousQuarter('Q4 FY27')).toBe('Q3 FY27');
    expect(previousQuarter('Q1 FY28')).toBe('Q4 FY27');
    expect(previousQuarter('bogus')).toBeNull();
    // Q3 FY27 is Aug–Oct 2026
    expect(pickerRange('Q4 FY27', '2026-11-15')).toEqual({ from: '2026-08-01', to: '2026-11-15' });
  });

  it('every week of this quarter and the one before, grouped, with found and in-Org62 hours; this week marked', () => {
    const g = weekGroups({ weeks: [{ weekStart: '2026-11-09', weekEnd: '2026-11-15', rows: 4, hours: 6, loggedH: 3.5 }, { weekStart: '2026-10-26', weekEnd: '2026-11-01', rows: 2, hours: 4, loggedH: 4 }] }, 'Q4 FY27', '2026-11-09');
    expect(g.map((x) => x.quarter)).toEqual(['Q3 FY27', 'Q4 FY27']);
    expect(g[0]!.weeks[0]!.monday).toBe('2026-07-27');
    const last = g[1]!.weeks.at(-1)!;
    expect(last).toEqual({ monday: '2026-11-09', label: 'Nov 9', hours: 6, loggedH: 3.5, pct: 58, current: true });
    expect(g[1]!.weeks[0]!.monday).toBe('2026-10-26');
    expect(g[1]!.weeks[0]).toMatchObject({ hours: 4, loggedH: 4, pct: 100, current: false });
    // a week with nothing found reads as nothing
    expect(g[0]!.weeks[1]).toMatchObject({ hours: 0, loggedH: 0, pct: 0 });
  });
});

const uc = (o: Partial<UseCaseLanding>): UseCaseLanding =>
  ({ id: 'u1', key: 'uc:1', title: 'Use case', track: 'd360', companyName: 'CUSTOMER_1', vdpSlug: null, vdpUrl: null, vdpUseCaseId: '1', org62UseCaseId: null, accountId: null, accountName: null, oppId: null, oppName: null, org62OpportunityId: null, org62: null, vdp: null, where: 'neither', state: 'create', why: '', ready: false, sends: null, question: null, differences: [], assets: [], writes: [], canvasDraftId: null, ...o }) as UseCaseLanding;

describe('landing marks: color is the state', () => {
  it('"Org62 ✓ · VDP —", differs amber, missing red, staged dashed', () => {
    expect(whereLine(uc({ org62: { state: 'verified' } as never, vdp: null }))).toBe('Org62 ✓ · VDP —');
    expect(landingPill('org62', { state: 'differs' })).toMatchObject({ label: 'Org62 differs', tone: 'warn' });
    expect(landingPill('vdp', { state: 'missing' })).toMatchObject({ label: 'VDP missing', tone: 'risk' });
    expect(landingPill('org62', { state: 'staged' })).toMatchObject({ tone: 'neutral', dashed: true });
    expect(writeState({ state: 'verified', destination: 'vdp' })).toEqual({ label: 'in VDP', tone: 'ok' });
    expect(writeState({ state: 'proposed', destination: 'org62' }).tone).toBe('ai');
    expect(runWritesLine({ create: 3, update: 1, delete: 0, removed: 1 })).toBe('3 creates · 1 update · 1 taken off');
  });

  it('use cases grouped by company, filtered', () => {
    const items = [uc({ key: 'a', companyName: 'B co', where: 'both' }), uc({ key: 'b', companyName: 'A co', where: 'vdp', ready: true }), uc({ key: 'c', companyName: 'A co', where: 'org62', differences: [{} as never] })];
    expect(ucGroups(items, 'all').map((g) => [g.company, g.items.map((x) => x.key)])).toEqual([
      ['A co', ['b', 'c']],
      ['B co', ['a']],
    ]);
    expect(ucGroups(items, 'ready').flatMap((g) => g.items.map((x) => x.key))).toEqual(['b']);
    expect(ucGroups(items, 'differs').flatMap((g) => g.items.map((x) => x.key))).toEqual(['c']);
    expect(ucGroups(items, 'both').flatMap((g) => g.items.map((x) => x.key))).toEqual(['a']);
  });
});

describe('Log it names everything it takes', () => {
  it('the batch takes exactly what is ticked, or everything when nothing is', () => {
    expect(batchSelectionOf({})).toEqual({ rows: null, useCases: null, updates: null });
    const s = batchSelectionOf({ useCases: ['uc:1'] });
    expect([...s.rows!]).toEqual([]);
    expect([...s.useCases!]).toEqual(['uc:1']);
    expect([...s.updates!]).toEqual([]);
  });
});
