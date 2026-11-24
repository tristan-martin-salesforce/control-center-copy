/**
 * Time ▸ Log hours, the one path (./path-derive.ts, docs/archive/2026-build/time-redesign.md): Needs you groups (one group per row,
 * in fixing order, bulk only where one pick fits many), the fix that approves a held row it completes, the stepper's
 * counts and its one current stop, the quarter header (waiting on you this quarter, on its way, where a canvas's
 * hours landed) and the selected week's Suggested line. Placeholder data only.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityEntry, LogCanvas, SourceRef, TimeWeek } from '@/contract';
import { NOT_IN_ORG62_FLAG } from '@/engines/activity/org62-check';
import { quartersOf } from '@/server/datasource/log-canvases';
import { batchDone, fixRowsOf, lanesOf } from './lanes-derive';
import { fixPatch, logPath, missingOf, needsYou, quarterTruth, spillLine, weekSuggested, type PathInput } from './path-derive';

const NOW = '2026-11-11T22:00:00.000Z';
const src = (kind: SourceRef['kind']): SourceRef[] => [{ kind, label: kind }];

let n = 0;
const entry = (o: Partial<ActivityEntry>): ActivityEntry =>
  ({
    id: `a${++n}`,
    version: 1,
    date: '2026-11-10',
    start: '2026-11-10T17:00:00.000Z',
    end: '2026-11-10T18:00:00.000Z',
    durationH: 1,
    taskType: 'Demo',
    oppId: 'o1',
    oppName: 'Opp',
    accountName: 'CUSTOMER_1',
    meetingType: 'CF',
    description: 'd',
    status: 'approved',
    confidence: 'likely',
    sources: src('calendar'),
    userLockedFields: [],
    issues: [],
    updatedAt: '2026-11-10T18:00:00.000Z',
    fromOrg62: false,
    excludedReason: null,
    loggedAt: null,
    verifiedAt: null,
    ...o,
  }) as ActivityEntry;

const canvas = (o: Partial<LogCanvas>): LogCanvas => ({ draftId: 'd1', title: 'Activity log · 2 rows', state: 'applied', url: 'https://example.slack.com/docs/T0/F0PLACE', createdAt: '2026-11-11T15:00:00.000Z', appliedAt: '2026-11-11T15:05:00.000Z', rows: 0, hours: 0, dcs: 0, updates: 0, useCases: 0, rowIds: [], org62: null, quarters: [], maybeCreated: false, progress: null, ...o });

const week = (logCanvases: LogCanvas[] = [], quarter: Partial<TimeWeek['quarter']> = {}): PathInput['week'] => ({
  entries: [],
  canvas: { lastSyncedAt: null, rowsChangedSince: 0, confirmRequired: false, label: 'Work-order batch' },
  quarter: { label: 'Q4 FY27', loggedH: 12.5, targetH: 250, due: '2027-01-31T02:00:00.000Z', ...quarter },
  logCanvases,
});

describe('Needs you: grouped by what is missing', () => {
  const rows = [
    entry({ id: 'n-both', status: 'needs_input', oppId: null, oppName: null, taskType: null, issues: ['Needs an opp (WhatId) and a task type'] }),
    ...['s1', 's2', 's3'].map((id) => entry({ id, status: 'proposed', oppId: null, oppName: null, accountName: null, sources: src('slack'), description: `Slack ${id}` })),
    entry({ id: 'no-type', status: 'approved', taskType: null }),
    entry({ id: 'zero', status: 'approved', durationH: 0 }),
    entry({ id: 'hold', status: 'needs_input', issues: ['placeholder: is this a meeting?'] }),
    entry({ id: 'held', status: 'approved', oppId: null, canvasDraftId: 'd9' }),
    entry({ id: 'on-canvas', status: 'approved', oppId: null }),
    entry({ id: 'done', status: 'verified', oppId: null }),
    entry({ id: 'later', status: 'upcoming', oppId: null }),
    entry({ id: 'out', status: 'dismissed', oppId: null }),
    entry({ id: 'ok', status: 'approved' }),
  ];
  const canvases = [canvas({ rowIds: ['on-canvas'] })];

  it('puts each open row in the group of its first missing thing, in fixing order, oldest first', () => {
    const r = needsYou(rows, { canvases });
    expect(r.groups.map((g) => g.kind)).toEqual(['opp', 'type', 'hours', 'check']);
    expect(r.groups.find((g) => g.kind === 'opp')!.ids.sort()).toEqual(['n-both', 's1', 's2', 's3']);
    expect(r.groups.find((g) => g.kind === 'type')!.ids).toEqual(['no-type']);
    expect(r.groups.find((g) => g.kind === 'hours')!.ids).toEqual(['zero']);
    expect(r.groups.find((g) => g.kind === 'check')!.ids).toEqual(['hold']);
    // one group per row; rows in a canvas item, on an applied canvas, done, later or excluded never need you
    expect(new Set(r.ids).size).toBe(r.ids.length);
    for (const id of ['held', 'on-canvas', 'done', 'later', 'out', 'ok']) expect(r.ids).not.toContain(id);
    expect(r.hours).toBe(6);
  });

  it('names each group plainly', () => {
    const type = needsYou([entry({ id: 't1', taskType: null }), entry({ id: 't2', taskType: null })]).groups[0]!;
    expect(type).toMatchObject({ kind: 'type', title: 'No task type', ids: ['t1', 't2'] });
  });

  it('an AE (Sales Events, no task type) never has a task-type group', () => {
    const r = needsYou(rows, { canvases, taskTypeRequired: false, recordTypeName: 'Sales Event' });
    expect(r.groups.map((g) => g.kind)).toEqual(['opp', 'hours', 'check']);
    expect(r.ids).not.toContain('no-type');
    expect(missingOf(entry({ taskType: null }), false)).toBeNull();
    expect(r.groups.map((g) => `${g.title} ${g.why}`).join(' ')).not.toMatch(/task type/i);
  });

  it('a fix that completes a row the scan held also approves it; anything still open keeps it held', () => {
    const onlyOpp = entry({ status: 'needs_input', oppId: null, issues: ['NEEDS WhatId: which opportunity?'] });
    expect(fixPatch(onlyOpp, { oppId: 'o2' })).toEqual({ oppId: 'o2', status: 'approved' });
    const both = entry({ status: 'needs_input', oppId: null, taskType: null, issues: ['Needs an opp (WhatId) and a task type'] });
    expect(fixPatch(both, { oppId: 'o2' })).toEqual({ oppId: 'o2' });
    expect(fixPatch({ ...both, oppId: 'o2' }, { taskType: 'Demo' })).toEqual({ taskType: 'Demo', status: 'approved' });
    // the AE's row needs no type
    expect(fixPatch(both, { oppId: 'o2' }, false)).toEqual({ oppId: 'o2', status: 'approved' });
    // a question the fields don't answer stays for your Approve
    const hold = entry({ status: 'needs_input', oppId: null, issues: ['OOO: you were out'] });
    expect(fixPatch(hold, { oppId: 'o2' })).toEqual({ oppId: 'o2' });
    // proposed rows log with the batch: the fix is just the field
    expect(fixPatch(entry({ status: 'proposed', oppId: null }), { oppId: 'o2' })).toEqual({ oppId: 'o2' });
  });

  it('reads overlap notes and estimate notes as information, never as a question', () => {
    expect(missingOf(entry({ status: 'proposed', issues: ["overlaps 'Sync' 12:30–13:00 (both log)", 'GUESS: hours estimated from evidence'] }))).toBeNull();
    expect(missingOf(entry({ status: 'needs_input', issues: ['Duration unclear: check the hours'] }))).toBe('hours');
  });
});

describe('Log it: the stepper', () => {
  it('counts every stop and gives exactly one the filled button: log, then apply, then tell', () => {
    const rows = [
      entry({ id: 'r1', status: 'approved', durationH: 1.5 }),
      entry({ id: 'r2', status: 'proposed', durationH: 2 }),
      entry({ id: 'no-opp', status: 'approved', oppId: null }),
      entry({ id: 'h1', status: 'approved', canvasDraftId: 'p1' }),
      entry({ id: 't1', status: 'synced_to_canvas', durationH: 3 }),
      entry({ id: 'v1', status: 'verified', durationH: 4 }),
      entry({ id: 'v-q3', status: 'verified', date: '2026-10-20', durationH: 5 }),
    ];
    const canvases = [canvas({ draftId: 'p1', state: 'pending', url: null, appliedAt: null, rowIds: ['h1'], rows: 1, hours: 1 }), canvas({ draftId: 'c1', rowIds: ['t1'], rows: 1, hours: 3 })];
    const p = logPath({ rows, week: week(canvases), nowIso: NOW });
    const by = Object.fromEntries(p.stages.map((s) => [s.id, s]));
    expect(p.stages.map((s) => s.title)).toEqual(['Ready to log', 'Apply', 'Send to Org62 via Slackbot', 'Verified']);
    // an approved row without its opp is not ready: it needs you
    expect(p.readyIds).toEqual(['r1', 'r2']);
    expect(p.needs.ids).toEqual(['no-opp']);
    expect(by.ready).toMatchObject({ rows: 2, hours: 3.5, count: '2 rows · 3.5 h', state: 'current' });
    expect(by.ready.step?.verb).toBe('Log the 2 rows ready to Slackbot');
    expect(by.ready.secondary.map((s) => s.verb)).toEqual(['Approve 1 now']);
    expect(by.apply).toMatchObject({ rows: 1, count: '1 batch · 1 row', state: 'later' });
    expect(by.tell).toMatchObject({ rows: 1, count: '1 row on 1 batch', state: 'later' });
    // verified: in Org62 this quarter only (the Q3 row counts toward Q3)
    expect(by.verified).toMatchObject({ rows: 1, hours: 4, state: 'done', step: null });
    expect(p.stages.filter((s) => s.state === 'current')).toHaveLength(1);
  });

  it('moves the button on as stops empty, and waits once the Slackbot prompt is copied', () => {
    const t = [entry({ id: 't1', status: 'synced_to_canvas' })];
    const canvases = [canvas({ draftId: 'c1', rowIds: ['t1'], rows: 1, hours: 1 })];
    expect(logPath({ rows: t, week: week(canvases), nowIso: NOW }).current?.id).toBe('tell');
    const copied = logPath({ rows: t, week: week(canvases), nowIso: NOW, confirmCopiedFor: 1 });
    expect(copied.current).toBeNull();
    expect(copied.stages.find((s) => s.id === 'tell')!.state).toBe('waiting');
    const empty = logPath({ rows: [], week: week(), nowIso: NOW });
    expect(empty.current).toBeNull();
    expect(empty.stages.find((s) => s.id === 'ready')).toMatchObject({ count: 'Nothing ready', state: 'done' });
  });

  it('counts the DC requests waiting for a batch on Ready, with a link to them (55 claims never hide)', () => {
    const rows = [entry({ id: 'r1' }), entry({ id: 'r2' })];
    const withRows = logPath({ rows, week: week(), nowIso: NOW, dcPending: 55 });
    expect(withRows.stages.find((s) => s.id === 'ready')).toMatchObject({ count: '2 rows · 2 h · 55 DCs', why: 'Log to Slackbot puts them and your 55 DC requests in a new batch', dcs: 55, state: 'current' });
    // with use cases too, each is named
    expect(logPath({ rows, week: week(), nowIso: NOW, dcPending: 1, ucPending: 2 }).stages.find((s) => s.id === 'ready')!.why).toBe('Log to Slackbot puts them, your 1 DC request and your 2 VDP use cases in a new batch');
    // no rows ready: the DCs wait (counted, never "Nothing ready", never a muted done: 2026-11-13 audit C2). Log DCs now
    // is the stop's button, and the page's filled default only while nothing else waits on a click
    const only = logPath({ rows: [], week: week(), nowIso: NOW, dcPending: 3 });
    const ready = only.stages.find((s) => s.id === 'ready')!;
    expect(ready).toMatchObject({ count: '3 DCs waiting', why: 'They ride in your next batch with rows; Log DCs now puts them on one of their own', dcs: 3, state: 'current' });
    expect(ready.step?.verb).toBe('Log DCs now');
    expect(ready.secondary).toEqual([]);
    expect(only.current?.id).toBe('ready');
    expect(logPath({ rows: [], week: week(), nowIso: NOW }).stages.find((s) => s.id === 'ready')).toMatchObject({ count: 'Nothing ready', dcs: 0 });
  });

  it('follows the logging setting: with approveComplete off only approved rows are ready', () => {
    const rows = [entry({ id: 'p', status: 'proposed' }), entry({ id: 'a', status: 'approved' })];
    expect(logPath({ rows, week: week(), nowIso: NOW, approveComplete: false }).readyIds).toEqual(['a']);
    expect(logPath({ rows, week: week(), nowIso: NOW }).readyIds.sort()).toEqual(['a', 'p']);
  });

  it('reads correctly for an AE: Sales Events need no task type to be ready, and no stop asks for one', () => {
    const rows = [entry({ id: 'ae1', status: 'proposed', taskType: null })];
    const p = logPath({ rows, week: week([], { targetH: 0 }), nowIso: NOW, taskTypeRequired: false, recordTypeName: 'Sales Event' });
    expect(p.readyIds).toEqual(['ae1']);
    expect(p.needs.groups).toEqual([]);
    expect(JSON.stringify(p.stages)).not.toMatch(/task type/i);
    const se = logPath({ rows, week: week(), nowIso: NOW });
    expect(se.readyIds).toEqual([]);
    expect(se.needs.groups.map((g) => g.kind)).toEqual(['type']);
  });
});

describe('the quarter header tells the truth', () => {
  it('says what waits on you this quarter by stage, what is on its way, and leaves other quarters out', () => {
    const rows = [
      entry({ id: 'need', status: 'needs_input', oppId: null, durationH: 2 }),
      entry({ id: 'need-q3', status: 'needs_input', oppId: null, date: '2026-10-28', durationH: 7 }),
      entry({ id: 'ready', status: 'approved', durationH: 4 }),
      entry({ id: 'apply', status: 'approved', canvasDraftId: 'p1', durationH: 1.5 }),
      entry({ id: 'tell', status: 'synced_to_canvas', durationH: 7 }),
    ];
    const canvases = [canvas({ draftId: 'p1', state: 'pending', url: null, appliedAt: null, rowIds: ['apply'] }), canvas({ draftId: 'c1', rowIds: ['tell'] })];
    const input = { rows, week: week(canvases), nowIso: NOW, tz: 'America/Denver' };
    const t = quarterTruth(input, logPath(input), 9);
    expect(t.waiting).toEqual({
      rows: 4,
      hours: 14.5,
      parts: [
        { id: 'needs', label: 'need you', rows: 1, hours: 2 },
        { id: 'ready', label: 'ready to log', rows: 1, hours: 4 },
        { id: 'apply', label: 'to apply', rows: 1, hours: 1.5 },
        { id: 'tell', label: 'to send to Org62 via Slackbot', rows: 1, hours: 7 },
      ],
    });
    expect(t).toMatchObject({ loggedH: 12.5, targetH: 250, leftH: 237.5, verifiedH: 9 });
    expect(t.pace?.state).toBe('behind');
    // once the prompt is copied, Tell Slackbot is on its way, not on you
    const copied = { ...input, confirmCopiedFor: 1 };
    const c = quarterTruth(copied, logPath(copied));
    expect(c.waiting.rows).toBe(3);
    expect(c.onItsWay).toEqual({ rows: 1, hours: 7 });
  });

  it('says where a batch that spans quarters put its hours: 31.8 h landed in Q3 FY27', () => {
    const spanning = canvas({ draftId: 'c9', title: 'Activity log · 40 rows', rows: 40, hours: 44.25, quarters: [{ label: 'Q4 FY27', rows: 11, hours: 12.45 }, { label: 'Q3 FY27', rows: 29, hours: 31.8 }] });
    const waiting = canvas({ draftId: 'p9', state: 'pending', url: null, appliedAt: null, quarters: [{ label: 'Q3 FY27', rows: 2, hours: 3 }] });
    const inQ = canvas({ draftId: 'c8', quarters: [{ label: 'Q4 FY27', rows: 3, hours: 3 }] });
    const input = { rows: [], week: week([spanning, waiting, inQ]), nowIso: NOW };
    const t = quarterTruth(input, logPath(input));
    expect(t.spill.map((s) => s.draftId)).toEqual(['c9', 'p9']);
    expect(t.spill[0]).toMatchObject({ applied: true, hours: 44.25, hereH: 12.45, elsewhere: [{ label: 'Q3 FY27', rows: 29, hours: 31.8 }] });
    expect(spillLine(t.spill[0]!)).toBe('31.8 h landed in Q3 FY27');
    expect(spillLine(t.spill[1]!)).toBe('3 h will land in Q3 FY27');
  });

  it('a role without a target shows hours alone: nothing to go, no pace', () => {
    const input = { rows: [], week: week([], { targetH: 0 }), nowIso: NOW };
    expect(quarterTruth(input, logPath(input))).toMatchObject({ targetH: 0, leftH: 0, pct: 0, pace: null });
  });

  it('the batch split (LogCanvas.quarters) counts its rows by the fiscal quarter of their day, newest first', () => {
    const rows = new Map(
      [
        { id: 'oct1', status: 'synced_to_canvas' as const, date: '2026-10-29', durationH: 20 },
        { id: 'oct2', status: 'synced_to_canvas' as const, date: '2026-10-30', durationH: 11.8 },
        { id: 'nov', status: 'synced_to_canvas' as const, date: '2026-11-02', durationH: 12.45 },
        { id: 'nodate', status: 'approved' as const },
      ].map((r) => [r.id, r] as const),
    );
    expect(quartersOf(['oct1', 'nov', 'oct2', 'nodate', 'gone'], rows)).toEqual([
      { label: 'Q4 FY27', rows: 1, hours: 12.45 },
      { label: 'Q3 FY27', rows: 2, hours: 31.8 },
    ]);
  });
});

describe('Suggested: the selected week', () => {
  it('says how much was suggested and where it is now, with the CF/CR split and what was not logged', () => {
    const entries = [
      entry({ id: 'w-need', status: 'needs_input', oppId: null, durationH: 2, meetingType: 'CF' }),
      entry({ id: 'w-ready', status: 'approved', durationH: 3, meetingType: 'CR' }),
      entry({ id: 'w-way', status: 'synced_to_canvas', durationH: 1 }),
      entry({ id: 'w-org62', status: 'verified', durationH: 1.5 }),
      entry({ id: 'w-up', status: 'upcoming', durationH: 1 }),
      entry({ id: 'w-out', status: 'dismissed', durationH: 0.5 }),
    ];
    const p = logPath({ rows: entries, week: week(), nowIso: NOW });
    const s = weekSuggested(entries, p);
    expect(s).toMatchObject({ rows: 4, hours: 7.5, upcoming: 1, excluded: 1, cf: 4.5, cr: 3 });
    expect(s.parts.map((x) => [x.id, x.rows])).toEqual([
      ['needs', 1],
      ['ready', 1],
      ['way', 1],
      ['org62', 1],
    ]);
  });
});

describe('C1 one count: lanesOf (AX-2)', () => {
  const rows = [
    entry({ id: 'f1', status: 'needs_input', oppId: null, oppName: null, issues: ['Needs an opp (WhatId)'] }),
    entry({ id: 'f2', status: 'approved', taskType: null, durationH: 2 }),
    entry({ id: 'i1', status: 'needs_input', internal: true, oppId: null, oppName: null }),
    entry({ id: 'i2', status: 'proposed', internal: true, oppId: null, oppName: null }),
    entry({ id: 'r1', status: 'approved' }),
    entry({ id: 'r2', status: 'approved', durationH: 1.5 }),
    entry({ id: 's1', status: 'synced_to_canvas', canvasDraftId: 'b1' }),
    entry({ id: 's2', status: 'synced_to_canvas', canvasDraftId: 'b1' }),
    entry({ id: 'ok2', status: 'logged', canvasDraftId: 'b2' }),
    entry({ id: 'nf', status: 'synced_to_canvas', canvasDraftId: 'b2', issues: [NOT_IN_ORG62_FLAG] }),
  ];
  const canvases = [
    canvas({ draftId: 'b1', rowIds: ['s1', 's2'], rows: 2, hours: 2, org62: { logged: 0, waiting: 2, missing: 0 } }),
    canvas({ draftId: 'b2', rowIds: ['ok2', 'nf'], rows: 2, hours: 2, org62: { logged: 1, waiting: 0, missing: 1 } }),
    canvas({ draftId: 'b3', rowIds: [], rows: 3, hours: 3, org62: { logged: 3, waiting: 0, missing: 0 } }),
  ];
  const input = { rows, week: week(canvases), nowIso: NOW };
  const path = logPath(input);
  const lanes = lanesOf({ path, rows, canvases });

  it('counts each lane once: fix without Internal or not-found rows, ready, open batches with their failures', () => {
    expect(lanes.fix).toMatchObject({ rows: 2, hours: 3 });
    expect([...lanes.fix.ids].sort()).toEqual(['f1', 'f2']);
    expect(lanes.ready).toEqual({ rows: 2, hours: 2.5 });
    expect(lanes.sending).toEqual({ batches: 2, rows: 4, hours: 4, failed: 1, notFound: 1, failedBatches: 0 });
    expect(lanes.internal).toEqual({ rows: 1 });
    expect(lanes.badge).toBe(3);
  });

  it('every surface reads it: the quarter card, Select all and the path agree with the lanes', () => {
    const t = quarterTruth(input, path);
    expect(t.waiting.parts.find((p) => p.id === 'needs')!.rows).toBe(lanes.fix.rows + lanes.sending.notFound);
    expect(t.waiting.parts.find((p) => p.id === 'ready')!.rows).toBe(lanes.ready.rows);
    expect(fixRowsOf(path.needs)).toHaveLength(lanes.fix.rows);
    expect(path.readyIds).toHaveLength(lanes.ready.rows);
  });

  it('a batch that failed as a whole is a failure; a checked one leaves the lane', () => {
    const l = lanesOf({ path, rows, canvases: [...canvases, canvas({ draftId: 'b4', state: 'retry', url: null, rows: 1, hours: 1 })] });
    expect(l.sending).toMatchObject({ batches: 3, failed: 2, failedBatches: 1 });
    expect(l.badge).toBe(4);
    expect(batchDone(canvases[2]!)).toBe(true);
    expect(batchDone(canvas({ progress: { state: 'in_org62' } as LogCanvas['progress'], org62: { logged: 0, waiting: 2, missing: 0 } }))).toBe(true);
  });
});
