/**
 * Time ▸ Log derivations (log-derive.ts) and the read-back fixes in derive.ts: a row read from Org62 is confirmed
 * by definition (never "Unconfirmed in Org62", never handed off), the quarter log's range, the URL filters, the
 * route query they make, and the flat list the virtualized Log renders. Placeholder data only.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityEntry, ActivityLog } from '@/contract';
import { NOT_IN_ORG62_FLAG } from '@/engines/activity/org62-check';
import { handedOffRows, loggingGap, q4Range, readbackState } from './derive';
import { activeLogFilterCount, DEFAULT_LOG_FILTERS, historyHref, isCompactRow, logItems, logQueryOf, parseLogFilters, quarterRangeOf, serializeLogFilters, toggleStatus, weekEndOf, weekRangeLabel } from './log-derive';

const entry = (o: Partial<ActivityEntry>): ActivityEntry =>
  ({ id: 'a', version: 1, date: '2026-10-05', start: '2026-10-05T17:00:00.000Z', end: '2026-10-05T18:00:00.000Z', durationH: 1, taskType: 'Demo', oppId: 'o1', oppName: 'OPP_1', accountName: 'ACCOUNT_1', meetingType: 'CF', description: 'd', status: 'logged', confidence: 'likely', sources: [], userLockedFields: [], issues: [], updatedAt: '2026-10-05T18:00:00.000Z', fromOrg62: false, excludedReason: null, loggedAt: null, verifiedAt: null, ...o }) as ActivityEntry;

const NOW = '2026-11-10T18:00:00.000Z';

describe('read-back state', () => {
  it('a logged row read from Org62 is confirmed; one written from here waits for the read-back', () => {
    expect(readbackState(entry({ fromOrg62: true }), NOW)).toBeNull();
    expect(readbackState(entry({ fromOrg62: false }), NOW)).toBe('unconfirmed');
    // D-65: a row whose fields differ is in Org62 ("differs"); one deleted there, or not in Org62 after its canvas ran,
    // is the one that is missing
    expect(readbackState(entry({ status: 'verify_failed', fromOrg62: false }), NOW)).toBe('differs');
    expect(readbackState(entry({ status: 'verify_failed', fromOrg62: false, issues: ['Org62 check: Deleted in Org62'] }), NOW)).toBe('deleted');
    expect(readbackState(entry({ status: 'synced_to_canvas', fromOrg62: false, issues: [NOT_IN_ORG62_FLAG] }), NOW)).toBe('missing');
  });

  it('an approved row waiting in an Outbox canvas item is not handed off yet: nothing to confirm', () => {
    expect(readbackState(entry({ status: 'approved' }), NOW)).toBe('unconfirmed');
    expect(readbackState(entry({ status: 'approved', canvasDraftId: 'd1' }), NOW)).toBeNull();
  });

  it('Org62-native rows are never handed off and never open the logging gap', () => {
    const rows = [entry({ id: 'n1', fromOrg62: true }), entry({ id: 'n2', fromOrg62: true, durationH: 2 }), entry({ id: 'mine', fromOrg62: false })];
    expect(handedOffRows(rows, NOW).map((e) => e.id)).toEqual(['mine']);
    const gap = loggingGap({ entries: rows, org62: { lastReadbackAt: null, verified: 0, pending: 1 }, canvas: { lastSyncedAt: null, rowsChangedSince: 0, confirmRequired: false, label: 'Work-order canvas' } }, NOW);
    expect(gap.unconfirmedRows).toBe(1);
    expect(gap.unconfirmedH).toBe(1);
  });
});

describe('the quarter log range', () => {
  const week = (weekStart: string, weekEnd: string, label: string) => ({ weekStart, weekEnd, quarter: { label, loggedH: 0, targetH: 60, due: null } });
  it('early in a quarter it reaches back 3 weeks into the last one', () => {
    expect(q4Range(week('2026-11-09', '2026-11-15', 'Q4 FY27'))).toEqual({ from: '2026-10-19', to: '2026-11-15' });
  });
  it('later on it covers the whole quarter so far', () => {
    expect(q4Range(week('2026-12-14', '2026-12-20', 'Q4 FY27'))).toEqual({ from: '2026-11-01', to: '2026-12-20' });
  });
  it('a label it cannot read falls back to the lookback', () => {
    expect(q4Range(week('2026-12-14', '2026-12-20', 'This quarter'))).toEqual({ from: '2026-11-23', to: '2026-12-20' });
  });
});

describe('Log filters', () => {
  it('parses the URL, dropping unknown values, and writes it back with view=history first', () => {
    const f = parseLogFilters(new URLSearchParams('view=history&quarter=Q3+FY27&status=logged,bogus,verified,logged&q=demo&account=ACCOUNT_1&opp=o1'));
    expect(f).toEqual({ quarter: 'Q3 FY27', status: ['logged', 'verified'], q: 'demo', account: 'ACCOUNT_1', opp: 'o1', type: null, week: null });
    expect(serializeLogFilters(f)).toBe('view=history&quarter=Q3+FY27&status=logged%2Cverified&q=demo&account=ACCOUNT_1&opp=o1');
    expect(parseLogFilters(new URLSearchParams('quarter=Q9 FY27&week=monday'))).toEqual(DEFAULT_LOG_FILTERS);
    expect(serializeLogFilters(DEFAULT_LOG_FILTERS)).toBe('view=history');
    // the Ledger's drill-down: every quarter, a task type, a week
    const d = parseLogFilters(new URLSearchParams('view=history&quarter=all&type=Demo&week=2026-11-02&opp=internal'));
    expect(d).toMatchObject({ quarter: 'all', type: 'Demo', week: '2026-11-02', opp: 'internal' });
    expect(serializeLogFilters(d)).toBe('view=history&quarter=all&opp=internal&type=Demo&week=2026-11-02');
  });

  it('a quarter becomes its calendar range (FY starts 1 Feb); the rest maps one to one', () => {
    expect(logQueryOf({ ...DEFAULT_LOG_FILTERS, quarter: 'Q3 FY27' })).toEqual({ from: '2026-08-01', to: '2026-10-31' });
    expect(logQueryOf({ quarter: null, status: ['excluded', 'logged'], q: '  demo ', account: 'ACCOUNT_1', opp: 'o1', type: 'Demo', week: null })).toEqual({ status: 'excluded,logged', q: 'demo', account: 'ACCOUNT_1', opp: 'o1', type: 'Demo' });
    expect(logQueryOf(DEFAULT_LOG_FILTERS)).toEqual({});
  });

  it('runs to the end of this week; next weeks show with the Upcoming chip or a quarter not started yet', () => {
    expect(weekEndOf('2026-11-10')).toBe('2026-11-15');
    expect(logQueryOf(DEFAULT_LOG_FILTERS, '2026-11-15')).toEqual({ to: '2026-11-15' });
    expect(logQueryOf({ ...DEFAULT_LOG_FILTERS, quarter: 'Q4 FY27' }, '2026-11-15')).toEqual({ from: '2026-11-01', to: '2026-11-15' });
    expect(logQueryOf({ ...DEFAULT_LOG_FILTERS, quarter: 'Q3 FY27' }, '2026-11-15')).toEqual({ from: '2026-08-01', to: '2026-10-31' });
    expect(logQueryOf({ ...DEFAULT_LOG_FILTERS, status: ['upcoming'] }, '2026-11-15')).toEqual({ status: 'upcoming' });
    expect(logQueryOf({ ...DEFAULT_LOG_FILTERS, quarter: 'Q1 FY28' }, '2026-11-15')).toEqual({ from: '2027-02-01', to: '2027-04-30' });
  });

  it('toggles chips and counts active filters (the quarter is a view, not a filter)', () => {
    expect(toggleStatus(['logged'], 'verified')).toEqual(['logged', 'verified']);
    expect(toggleStatus(['logged', 'verified'], 'logged')).toEqual(['verified']);
    expect(activeLogFilterCount({ quarter: 'Q3 FY27', status: ['logged', 'verified'], q: ' ', account: 'A', opp: null, type: null, week: null })).toBe(3);
    expect(activeLogFilterCount({ ...DEFAULT_LOG_FILTERS, type: 'Demo', week: '2026-11-02' })).toBe(2);
  });

  it('no quarter is the current one (its days from the ledger); all is every quarter; a week narrows to it, inside the quarter', () => {
    const current = { start: '2026-11-01', end: '2027-01-31' };
    expect(quarterRangeOf(DEFAULT_LOG_FILTERS, current)).toEqual(current);
    expect(quarterRangeOf({ quarter: 'Q3 FY27' }, current)).toEqual({ start: '2026-08-01', end: '2026-10-31' });
    expect(quarterRangeOf({ quarter: 'all' }, current)).toBeNull();
    expect(logQueryOf(DEFAULT_LOG_FILTERS, '2026-11-15', current)).toEqual({ from: '2026-11-01', to: '2026-11-15' });
    expect(logQueryOf({ ...DEFAULT_LOG_FILTERS, quarter: 'all' }, '2026-11-15', current)).toEqual({ to: '2026-11-15' });
    // the quarter's first week starts on the 1st (a Sunday): clipped to the quarter
    expect(logQueryOf({ ...DEFAULT_LOG_FILTERS, week: '2026-10-26' }, '2026-11-15', current)).toEqual({ from: '2026-11-01', to: '2026-11-01' });
    expect(logQueryOf({ ...DEFAULT_LOG_FILTERS, week: '2026-11-02', opp: 'none', account: 'none' }, '2026-11-15', current)).toEqual({ from: '2026-11-02', to: '2026-11-08', account: 'none', opp: 'none' });
    // the last week of a past quarter ends with the quarter
    expect(logQueryOf({ ...DEFAULT_LOG_FILTERS, quarter: 'Q3 FY27', week: '2026-10-26' }, '2026-11-15')).toEqual({ from: '2026-10-26', to: '2026-10-31' });
  });
});

describe('the Log list', () => {
  const rows = [
    entry({ id: 'n1', date: '2026-11-03', start: '2026-11-03T15:00:00.000Z', status: 'proposed' }),
    entry({ id: 'n2', date: '2026-11-03', start: '2026-11-03T18:00:00.000Z', status: 'dismissed', excludedReason: 'overlap' }),
    entry({ id: 'o1', date: '2026-10-30', status: 'logged', fromOrg62: true }),
    entry({ id: 'a1', date: '2026-08-04', status: 'verified' }),
  ];
  const log: Pick<ActivityLog, 'entries' | 'weeks'> = {
    entries: rows,
    weeks: [
      { weekStart: '2026-11-02', weekEnd: '2026-11-08', rows: 2, hours: 1, loggedH: 0 },
      { weekStart: '2026-10-26', weekEnd: '2026-11-01', rows: 1, hours: 1, loggedH: 1 },
      { weekStart: '2026-08-03', weekEnd: '2026-08-09', rows: 1, hours: 1, loggedH: 1 },
    ],
  };

  it('is weeks (with their totals) → days → rows, newest first, ending with "That\'s everything"', () => {
    const items = logItems(log);
    expect(items.map((i) => (i.kind === 'row' ? `r:${i.entry.id}` : i.key))).toEqual(['w:2026-11-02', 'd:2026-11-03', 'r:n1', 'r:n2', 'w:2026-10-26', 'd:2026-10-30', 'r:o1', 'w:2026-08-03', 'd:2026-08-04', 'r:a1', 'end']);
    const w = items[0]!;
    expect(w.kind === 'week' && w.total).toEqual({ rows: 2, hours: 1, loggedH: 0 });
    const d = items[1]!;
    expect(d.kind === 'day' && d.hours).toBe(1); // the excluded hour is not yours
    expect(items.at(-1)).toEqual({ kind: 'end', key: 'end', rows: 4 });
  });

  it('logged, verified and excluded rows are compact and read-only; the rest stay editable', () => {
    const compact = logItems(log).flatMap((i) => (i.kind === 'row' ? [[i.entry.id, i.compact] as const] : []));
    expect(compact).toEqual([
      ['n1', false],
      ['n2', true],
      ['o1', true],
      ['a1', true],
    ]);
    expect(isCompactRow({ status: 'needs_input' })).toBe(false);
    expect(isCompactRow({ status: 'upcoming' })).toBe(false);
  });

  it('links days to History and labels weeks', () => {
    expect(historyHref('2026-08-04')).toBe('/history?day=2026-08-04');
    expect(weekRangeLabel('2026-10-26', '2026-11-01')).toBe('Oct 26 – Nov 1');
    expect(weekRangeLabel('2026-08-03', '2026-08-09')).toBe('Aug 3 – 9');
  });
});
