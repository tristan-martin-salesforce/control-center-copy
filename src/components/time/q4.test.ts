import { describe, expect, it } from 'vitest';
import type { ActivityEntry, TimeWeek } from '@/contract';
import { handedOffRows, q4Steps, q4Tone, quarterBounds, quarterPace, quarterRowsOf } from './derive';

const entry = (o: Partial<ActivityEntry>): ActivityEntry =>
  ({ id: 'a', version: 1, date: '2026-11-02', start: '2026-11-02T17:00:00.000Z', end: '2026-11-02T18:00:00.000Z', durationH: 1, taskType: 'Demo', oppId: 'o1', oppName: 'Opp', accountName: 'Acct', meetingType: 'CF', description: 'd', status: 'approved', confidence: 'likely', sources: [], userLockedFields: [], issues: [], updatedAt: '2026-11-02T18:00:00.000Z', ...o }) as ActivityEntry;

const NOW = '2026-11-05T18:00:00.000Z';
const week = (entries: ActivityEntry[], canvas: Partial<TimeWeek['canvas']> = {}): Pick<TimeWeek, 'entries' | 'canvas' | 'quarter'> => ({
  entries,
  canvas: { lastSyncedAt: '2026-11-04T23:00:00.000Z', rowsChangedSince: 0, confirmRequired: false, label: 'Slackbot work-order batch', ...canvas },
  quarter: { label: 'Q4 FY27', loggedH: 18.5, targetH: 60, due: '2026-11-06T19:00:00.000Z' },
});

describe('quarter log steps', () => {
  it('has exactly one current step, in order approve → submit → confirm → fix', () => {
    const rows = [entry({ id: 'p', status: 'proposed' }), entry({ id: 's', status: 'synced_to_canvas' }), entry({ id: 'n', status: 'needs_input', issues: ['Needs an opp'] })];
    const steps = q4Steps({ rows, week: week(rows, { rowsChangedSince: 2 }), nowIso: NOW });
    expect(steps.map((s) => s.id)).toEqual(['approve', 'submit', 'confirm', 'fix']);
    expect(steps.filter((s) => s.state === 'current').map((s) => s.id)).toEqual(['approve']);
    // "Log these" (D-47): the complete proposed row is ready for Slackbot (it is approved with the batch)
    expect(steps.find((s) => s.id === 'submit')!.verb).toBe('Log the 1 row ready to Slackbot');
    expect(steps.find((s) => s.id === 'confirm')!.verb).toBe('Confirm 1 row');
  });

  it('makes Confirm current once the batch is up to date, and waits after the prompt is copied', () => {
    const rows = Array.from({ length: 3 }, (_, i) => entry({ id: `s${i}`, status: 'synced_to_canvas', durationH: 1.5 }));
    const steps = q4Steps({ rows, week: week(rows), nowIso: NOW });
    expect(steps.find((s) => s.id === 'submit')!.state).toBe('done');
    const confirm = steps.find((s) => s.id === 'confirm')!;
    expect(confirm.state).toBe('current');
    expect(confirm.hours).toBe(4.5);
    const after = q4Steps({ rows, week: week(rows), nowIso: NOW, confirmCopiedFor: 3 });
    expect(after.find((s) => s.id === 'confirm')!.state).toBe('waiting');
    expect(after.some((s) => s.state === 'current')).toBe(false);
  });

  it('"Log to Slackbot" takes rows that have ended: approved, or proposed with a task type and an opportunity', () => {
    const rows = [
      entry({ id: 'ok', status: 'approved' }),
      entry({ id: 'p', status: 'proposed' }),
      entry({ id: 'p-no-opp', status: 'proposed', oppId: null }),
      entry({ id: 'p-no-type', status: 'proposed', taskType: null }),
      entry({ id: 'future', status: 'approved', start: '2026-11-06T17:00:00.000Z', end: '2026-11-06T18:00:00.000Z' }),
    ];
    const log = q4Steps({ rows, week: week(rows), nowIso: NOW }).find((s) => s.id === 'submit')!;
    expect(log.ids).toEqual(['ok', 'p']);
    expect(log.hours).toBe(2);
    expect(q4Steps({ rows: [entry({ id: 'n', status: 'needs_input' })], week: week([]), nowIso: NOW }).find((s) => s.id === 'submit')).toMatchObject({ state: 'done', title: 'Nothing ready to log' });
  });

  it('rows already staged in a batch item are not offered again: they wait in a step that opens it for Apply', () => {
    const rows = [entry({ id: 'held1', canvasDraftId: 'd1' }), entry({ id: 'held2', canvasDraftId: 'd1', durationH: 0.5 }), entry({ id: 'new', status: 'approved' })];
    const steps = q4Steps({ rows, week: week(rows), nowIso: NOW });
    expect(steps.map((s) => s.id)).toEqual(['submit', 'outbox']);
    expect(steps.find((s) => s.id === 'submit')).toMatchObject({ state: 'current', ids: ['new'], verb: 'Log the 1 row ready to Slackbot' });
    expect(steps.find((s) => s.id === 'outbox')).toMatchObject({ state: 'later', title: '2 rows waiting for your Apply', verb: 'Review & apply', draftIds: ['d1'], hours: 1.5 });
    // all staged: nothing new to log, and opening the Outbox item is the one thing to do
    const only = q4Steps({ rows: rows.slice(0, 2), week: week([]), nowIso: NOW });
    expect(only.find((s) => s.id === 'submit')).toMatchObject({ state: 'done', title: 'Nothing new to log' });
    expect(only.find((s) => s.id === 'outbox')!.state).toBe('current');
    // two items
    const two = q4Steps({ rows: [entry({ id: 'a1', canvasDraftId: 'd1' }), entry({ id: 'b1', canvasDraftId: 'd2' })], week: week([]), nowIso: NOW });
    expect(two.find((s) => s.id === 'outbox')).toMatchObject({ verb: 'Review & apply 2', draftIds: ['d1', 'd2'] });
  });

  it('counts handed-off rows from earlier weeks, never agent time', () => {
    const rows = [entry({ id: 'old', status: 'synced_to_canvas', date: '2026-10-27' }), entry({ id: 'v', status: 'verified' }), entry({ id: 'up', status: 'upcoming' })];
    expect(handedOffRows(rows, NOW).map((e) => e.id)).toEqual(['old']);
  });

  it('colors the deadline only when it is close or past', () => {
    const q = week([]).quarter;
    expect(q4Tone(q, NOW)).toBe('warning');
    expect(q4Tone(q, '2026-10-01T00:00:00.000Z')).toBe('none');
    expect(q4Tone(q, '2026-11-07T00:00:00.000Z')).toBe('danger');
    expect(q4Tone({ ...q, loggedH: 60 }, '2026-11-07T00:00:00.000Z')).toBe('none');
  });
});

describe('quarter pace (fiscal year starts 1 Feb)', () => {
  it('maps fiscal quarter labels to calendar bounds', () => {
    expect(quarterBounds('Q4 FY27')).toEqual({ start: '2026-11-01', end: '2027-01-31' });
    expect(quarterBounds('Q1 FY27')).toEqual({ start: '2026-02-01', end: '2026-04-30' });
    expect(quarterBounds('Q3 FY27')).toEqual({ start: '2026-08-01', end: '2026-10-31' });
    expect(quarterBounds('Q2 FY28')).toEqual({ start: '2027-05-01', end: '2027-07-31' });
    expect(quarterBounds('Week 45')).toBeNull();
  });

  it('compares logged hours with an even pace over the workdays so far', () => {
    // Q4 FY27 has 65 workdays (21 in Nov, 23 in Dec, 21 in Jan); by Thu 5 Nov 4 have passed → 250 × 4 / 65 ≈ 15.4 h
    const tz = 'America/Denver';
    const p = quarterPace({ label: 'Q4 FY27', loggedH: 15, targetH: 250 }, NOW, tz)!;
    expect(p.expectedH).toBe(15.4);
    expect(p.state).toBe('on_pace');
    expect(p.workdaysLeft).toBe(61);
    expect(quarterPace({ label: 'Q4 FY27', loggedH: 5, targetH: 250 }, NOW, tz)!.state).toBe('behind');
    expect(quarterPace({ label: 'Q4 FY27', loggedH: 30, targetH: 250 }, NOW, tz)!.state).toBe('ahead');
  });

  it('has no pace outside the quarter or without a target', () => {
    expect(quarterPace({ label: 'Q3 FY27', loggedH: 0, targetH: 250 }, NOW)).toBeNull();
    expect(quarterPace({ label: 'Q4 FY27', loggedH: 0, targetH: 0 }, NOW)).toBeNull();
  });

  it('D-58: counts pending DC requests: they ride in the next batch with rows, or Log DCs now (never the default)', () => {
    // nothing ready to log: the DCs wait, with an explicit Log DCs now that is not the filled button
    const none = q4Steps({ rows: [], week: week([]), nowIso: NOW, dcPending: 2 });
    expect(none.find((s) => s.id === 'submit')).toMatchObject({ state: 'done', title: 'Nothing ready to log' });
    expect(none.find((s) => s.id === 'dcs')).toMatchObject({ title: '2 DC requests ride in your next batch', verb: 'Log DCs now', state: 'later' });
    expect(none.some((s) => s.state === 'current')).toBe(false);
    // rows ready: the DCs ride along on that canvas (no separate step)
    const rows = [entry({ id: 'r1' })];
    const withRows = q4Steps({ rows, week: week(rows), nowIso: NOW, dcPending: 1 });
    expect(withRows.find((s) => s.id === 'submit')).toMatchObject({ state: 'current', title: '1 row ready for Slackbot · 1 DC request ride along' });
    expect(withRows.some((s) => s.id === 'dcs')).toBe(false);
    // and with nothing pending, no DC words at all
    expect(q4Steps({ rows: [], week: week([]), nowIso: NOW }).some((s) => s.id === 'dcs')).toBe(false);
  });

  it('D-67: VDP use cases ride along in the next batch with rows (no step of their own)', () => {
    const rows = [entry({ id: 'r1' })];
    expect(q4Steps({ rows, week: week(rows), nowIso: NOW, dcPending: 1, ucPending: 2 }).find((s) => s.id === 'submit')).toMatchObject({ title: '1 row ready for Slackbot · 1 DC request · 2 VDP use cases ride along' });
    expect(q4Steps({ rows, week: week(rows), nowIso: NOW, ucPending: 1 }).find((s) => s.id === 'submit')).toMatchObject({ title: '1 row ready for Slackbot · 1 VDP use case ride along' });
    // nothing ready: they wait quietly (no dead-end step)
    expect(q4Steps({ rows: [], week: week([]), nowIso: NOW, ucPending: 3 }).map((s) => s.id)).not.toContain('dcs');
  });
});

describe('quarterRowsOf: Log it waits for the quarter before it counts (2026-11-16)', () => {
  const e = (id: string, status = 'approved') => ({ id, status }) as unknown as ActivityEntry;
  const week = { entries: [e('w1')] };
  const log = { entries: [e('q1'), e('q2'), e('w1', 'proposed')], quarters: [{ current: true, verifiedH: 26.5 }] } as unknown as Parameters<typeof quarterRowsOf>[0]['log'];

  it('not loaded on this week alone: the path and the button wait (no "Log this row" while 71 are ready)', () => {
    expect(quarterRowsOf({ log: undefined, week })).toMatchObject({ loaded: false, verifiedH: null });
    expect(quarterRowsOf({ log, week: undefined }).loaded).toBe(false);
  });

  it('loaded with the log: its rows with this week’s on top, and the quarter’s verified hours', () => {
    const r = quarterRowsOf({ log, week });
    expect(r.loaded).toBe(true);
    expect(r.rows.map((x) => x.id).sort()).toEqual(['q1', 'q2', 'w1']);
    expect(r.rows.find((x) => x.id === 'w1')!.status).toBe('approved'); // this week's payload wins
    expect(r.verifiedH).toBe(26.5);
  });

  it('a log that failed never leaves the page loading: this week’s rows are all there is', () => {
    expect(quarterRowsOf({ log: undefined, logFailed: true, week })).toMatchObject({ loaded: true, rows: [expect.objectContaining({ id: 'w1' })] });
  });
});
