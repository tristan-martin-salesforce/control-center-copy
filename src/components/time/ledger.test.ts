/**
 * Time ▸ Ledger's pure parts (ledger-derive.ts): the quarter picker (oldest → newest, the current one the default),
 * the tracking meter by the one count map against the target, each breakdown line's drill-down (the rows list's
 * filters, a second click clears), the rows' title, and the chart's scale. Placeholder data only.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityLogQuarter, TimeLedger } from '@/contract';
import { chartScale, isLaterWeek, isLineActive, lineBar, lineFilters, periodWords, quarterChoices, quarterParam, quarterTitle, shareText, shortOppName, shownQuarter, sliceTitle, toggleLine, tracking } from './ledger-derive';

const q = (label: string, start: string, end: string, o: Partial<ActivityLogQuarter> = {}): ActivityLogQuarter => ({ label, start, end, loggedH: 0, verifiedH: 0, targetH: 250, due: null, current: false, rows: 0, ...o });
const Q4 = q('Q4 FY27', '2026-11-01', '2027-01-31', { loggedH: 60, verifiedH: 50, current: true, due: '2027-01-31T19:00:00.000Z' });
const Q3 = q('Q3 FY27', '2026-08-01', '2026-10-31', { loggedH: 212.5, verifiedH: 200 });
const totals = (o: Partial<TimeLedger['totals']> = {}): TimeLedger['totals'] => ({ rows: 40, hours: 80, loggedH: 50.5, verifiedH: 50, approvedH: 12, approvedRows: 6, proposedH: 8, proposedRows: 5, needsInputH: 6.5, needsInputRows: 3, missingH: 3, missingRows: 1, earlierH: 9.5, excludedRows: 2, excludedH: 1, ...o });
const ledger = (o: Partial<TimeLedger> = {}): TimeLedger => ({
  quarter: 'Q4 FY27',
  from: '2026-11-01',
  to: '2027-01-31',
  quarters: [Q4, Q3],
  totals: totals(),
  accounts: [{ name: 'ACCOUNT_1', rows: 10, hours: 20, loggedH: 12, share: 0.25, opps: [{ oppId: 'o1', name: 'ACCOUNT_1 · Phase 2', rows: 8, hours: 16, loggedH: 12, share: 0.2 }, { oppId: null, name: 'No opportunity', rows: 2, hours: 4, loggedH: 0, share: 0.05 }] }],
  internal: { rows: 3, hours: 3, loggedH: 0, share: 0.04 },
  unassigned: { rows: 1, hours: 4, loggedH: 0, share: 0.05 },
  types: [],
  periods: { kind: 'week', items: [] },
  ...o,
});

describe('the quarter picker', () => {
  it('lists the quarters oldest → newest, the current one as the default (no URL value), then every quarter', () => {
    const c = quarterChoices([Q4, Q3]);
    expect(c.map((x) => [x.label, x.value, x.current])).toEqual([
      ['Q3 FY27', 'Q3 FY27', false],
      ['Q4 FY27', null, true],
      ['All quarters', 'all', false],
    ]);
    expect(c[0]).toMatchObject({ sub: '212.5 of 250 h', pct: 85 });
    expect(c[2]!.sub).toBe('272.5 h');
    expect(quarterParam('Q4 FY27', [Q4, Q3])).toBeNull();
    expect(quarterParam('Q3 FY27', [Q4, Q3])).toBe('Q3 FY27');
  });

  it('names the quarter shown (all has none)', () => {
    expect(shownQuarter(ledger())).toBe(Q4);
    expect(shownQuarter(ledger({ quarter: 'all' }))).toBeNull();
    expect(quarterTitle(ledger())).toBe('Q4 FY27 · Nov 1 – Jan 31 · this quarter');
    expect(quarterTitle(ledger({ quarter: 'Q3 FY27', from: '2026-08-01', to: '2026-10-31' }))).toBe('Q3 FY27 · Aug 1 – Oct 31');
    expect(quarterTitle(ledger({ quarter: 'all', from: null, to: null }))).toBe('Every quarter · 2 quarters');
  });
});

describe('tracking', () => {
  it('in Org62 is the quarter’s own number (earlier hours included); the states add up; the meter scales to the target', () => {
    const t = tracking(ledger(), Q4);
    expect(t).toMatchObject({ loggedH: 60, targetH: 250, leftH: 190, scaleH: 250 });
    expect(t.segments.map((s) => [s.id, s.hours, s.rows])).toEqual([
      ['org62', 60, null],
      ['way', 12, 6],
      ['suggested', 8, 5],
      ['needs', 9.5, 4],
    ]);
    expect(t.projectedH).toBe(89.5);
    expect(t.segments[0]!.pct).toBeCloseTo(24, 5);
    expect(t.segments.at(-1)!.hint).toContain('1 not in Org62 after all');
  });

  it('past the target the meter scales to everything yours; without a target there is no hours-to-go; empty states are left out', () => {
    const over = tracking(ledger({ totals: totals({ approvedH: 300 }) }), Q4);
    expect(over.scaleH).toBe(over.projectedH);
    expect(tracking(ledger(), { ...Q4, targetH: 0 })).toMatchObject({ targetH: 0, leftH: 0 });
    const none = tracking(ledger({ totals: totals({ approvedH: 0, proposedH: 0, needsInputH: 0, missingH: 0 }) }), Q4);
    expect(none.segments.map((s) => s.id)).toEqual(['org62']);
  });

  it('a persona that logs no task type (the AE, D-55) is never asked for "a type"', () => {
    expect(tracking(ledger(), Q4).segments.at(-1)!.hint).toContain('Missing an opp, a type or hours');
    const ae = tracking(ledger(), Q4, { taskType: false }).segments.at(-1)!.hint;
    expect(ae).toContain('Missing an opp or hours');
    expect(ae).not.toContain('type');
  });
});

describe('lines and the drill-down', () => {
  it('each line is the rows list’s filters; the slice replaces the last one', () => {
    expect(lineFilters({ kind: 'account', account: 'ACCOUNT_1' })).toEqual({ account: 'ACCOUNT_1', opp: null, type: null, week: null });
    expect(lineFilters({ kind: 'opp', account: 'ACCOUNT_1', oppId: 'o1' })).toEqual({ account: 'ACCOUNT_1', opp: 'o1', type: null, week: null });
    expect(lineFilters({ kind: 'opp', account: 'ACCOUNT_1', oppId: null })).toMatchObject({ account: 'ACCOUNT_1', opp: 'none' });
    expect(lineFilters({ kind: 'account', account: null })).toMatchObject({ account: 'none', opp: null });
    expect(lineFilters({ kind: 'internal' })).toMatchObject({ account: null, opp: 'internal' });
    expect(lineFilters({ kind: 'unassigned' })).toMatchObject({ account: 'none', opp: 'none' });
    expect(lineFilters({ kind: 'type', type: null })).toMatchObject({ type: 'none' });
    expect(lineFilters({ kind: 'week', week: '2026-11-02' })).toMatchObject({ week: '2026-11-02', account: null });
  });

  it('a click shows a line’s rows; a second click on it shows every row again', () => {
    const none = { account: null, opp: null, type: null, week: null };
    const acct = toggleLine({ kind: 'account', account: 'ACCOUNT_1' }, none);
    expect(isLineActive({ kind: 'account', account: 'account_1' }, acct)).toBe(true);
    expect(isLineActive({ kind: 'opp', account: 'ACCOUNT_1', oppId: 'o1' }, acct)).toBe(false);
    expect(toggleLine({ kind: 'account', account: 'ACCOUNT_1' }, acct)).toEqual(none);
    expect(toggleLine({ kind: 'type', type: 'Demo' }, acct)).toEqual({ ...none, type: 'Demo' });
  });

  it('titles the rows in words, never "none"', () => {
    const l = ledger();
    expect(sliceTitle({ account: 'ACCOUNT_1', opp: 'o1', type: null, week: null }, l)).toBe('ACCOUNT_1 · ACCOUNT_1 · Phase 2');
    expect(sliceTitle({ account: 'ACCOUNT_1', opp: 'none', type: null, week: null }, l)).toBe('ACCOUNT_1 · No opportunity');
    expect(sliceTitle({ account: null, opp: 'internal', type: null, week: null }, l)).toBe('Internal (no opportunity)');
    expect(sliceTitle({ account: 'none', opp: 'none', type: null, week: null }, l)).toBe('No account or opportunity yet');
    expect(sliceTitle({ account: null, opp: null, type: 'none', week: null }, l)).toBe('No type');
    // the quarter's first week, clipped to the quarter
    expect(sliceTitle({ account: null, opp: null, type: null, week: '2026-10-26' }, l)).toBe('Week of Nov 1');
    expect(sliceTitle({ account: null, opp: null, type: null, week: '2026-11-02' }, l)).toBe('Week of Nov 2 – 8');
    expect(sliceTitle({ account: null, opp: null, type: null, week: null }, l)).toBeNull();
  });

  it('shortens an opportunity named after its account; shares and bars read plainly', () => {
    expect(shortOppName('ACCOUNT_1 · Phase 2', 'ACCOUNT_1')).toBe('Phase 2');
    expect(shortOppName('Globex - Data Cloud', 'Globex')).toBe('Data Cloud');
    expect(shortOppName('ACME · Headless Phase 2', 'ACME Corp')).toBe('Headless Phase 2');
    expect(shortOppName('Renewal', 'ACCOUNT_1')).toBe('Renewal');
    expect(shareText(0.3456)).toBe('35%');
    expect(shareText(0.004)).toBe('<1%');
    expect(shareText(0)).toBe('0%');
    expect(lineBar({ hours: 10, loggedH: 4 }, 20)).toEqual({ org62: 20, rest: 30 });
    expect(lineBar({ hours: 0, loggedH: 0 }, 20)).toEqual({ org62: 0, rest: 0 });
  });
});

describe('the chart', () => {
  it('scales to a clean top tick at or above the highest column', () => {
    expect(chartScale(12)).toEqual({ top: 20, ticks: [0, 10, 20] });
    expect(chartScale(41)).toEqual({ top: 50, ticks: [0, 25, 50] });
    expect(chartScale(3.5)).toEqual({ top: 5, ticks: [0, 2.5, 5] });
    expect(chartScale(0)).toEqual({ top: 10, ticks: [0, 5, 10] });
  });

  it('a week after this one is later (drawn empty); a column says its numbers', () => {
    expect(isLaterWeek({ start: '2026-11-16' }, '2026-11-15')).toBe(true);
    expect(isLaterWeek({ start: '2026-11-09' }, '2026-11-15')).toBe(false);
    expect(periodWords({ label: 'Nov 2', start: '2026-11-02', end: '2026-11-08', hours: 12, loggedH: 9.5, rows: 8 }, 'week')).toBe('Week of Nov 2 – 8: 12 h, 9.5 h in Org62, 8 rows');
    expect(periodWords({ label: 'Q3 FY27', start: '2026-08-01', end: '2026-10-31', hours: 0, loggedH: 0, rows: 0 }, 'quarter')).toBe('Q3 FY27: nothing logged');
  });
});
