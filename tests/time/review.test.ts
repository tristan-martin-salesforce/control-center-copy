/**
 * The Review page's model (src/components/time/review-derive.ts): what is ticked when it opens, the one button and
 * why it is off, the re-check before staging, the one stage request and the result screen (nothing sent); lane 2
 * (ready-derive.ts): its groups, its counts and "Log N · h"; and lane 1, Fix or approve (fix-derive.ts): its groups,
 * their order and the one count.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityEntry, ActivitySuggestion, DcSuggestion, EventUpdateRow, StageLogBatchResult, UseCaseLanding } from '@/contract';
import { DEFAULT_WEIGHTS } from '@/engines/attribution/weights';
import { defaultOpen, extraGroups, groupTick, laneButton, laneCount, READY_OPEN_MAX, READY_STEP, readyGroups, tickable, tickedLine } from '@/components/time/ready-derive';
import { NOT_IN_ORG62_FLAG } from '@/engines/activity/org62-check';
import { bandLabel, FIX_STEP, fixAcceptPatch, fixLane, groupVerbLabel, initialOpen, quarterEndOf, rangeIds, tickedLine as fixTickedLine, toggleGroup, type FixGroupBy } from '@/components/time/fix-derive';
import { needsYou } from '@/components/time/path-derive';
import { changeNotice, dcExtras, initialChecked, logButton, recheck, resultLines, reviewEntries, reviewExtras, fixMoreLine, reviewKey, reviewPickRows, settleLineFor, snapshotOf, stageRequest } from '@/components/time/review-derive';

const row = (o: Partial<ActivityEntry> = {}): ActivityEntry =>
  ({
    id: 'r1',
    version: 1,
    date: '2026-11-16',
    start: '2026-11-16T16:00:00.000Z',
    end: '2026-11-16T17:00:00.000Z',
    durationH: 1,
    taskType: 'Customer Discovery',
    oppId: 'o1',
    oppName: 'ACME · Platform',
    accountName: 'ACME',
    meetingType: 'CF',
    description: 'ACME weekly',
    status: 'proposed',
    confidence: 'sure',
    sources: [],
    userLockedFields: [],
    issues: [],
    updatedAt: '2026-11-16T17:00:00.000Z',
    fromOrg62: false,
    excludedReason: null,
    loggedAt: null,
    verifiedAt: null,
    internal: false,
    dismissSource: null,
    logNote: null,
    logNoteBasis: null,
    why: 'the meeting names ACME',
    suggestion: null,
    ...o,
  }) as ActivityEntry;

const sugg = (o: Partial<ActivitySuggestion> = {}): ActivitySuggestion => ({ kind: 'opp', oppId: 'o2', oppName: 'Initech · Pilot', accountName: 'Initech', taskType: null, confidence: 0.9, reason: '#initech-pilot reads as Initech', basis: 'rules', at: null, ...o });
const needOpp = (o: Partial<ActivityEntry> = {}) => row({ id: 'n1', oppId: null, oppName: null, accountName: null, status: 'needs_input', issues: ['needs opp'], start: '2026-11-17T16:00:00.000Z', date: '2026-11-17', ...o });
const settle = DEFAULT_WEIGHTS.settle;

describe('the Review page', () => {
  it('the settle line is the attribution weights’ (a valid override wins)', () => {
    expect(settleLineFor(null)).toBe(0.75);
    expect(settleLineFor(null, 0.9)).toBe(0.9);
    expect(settleLineFor(null, 7)).toBe(0.75);
  });

  it('pre-ticks what the app is sure of; leaves a guess and an unsettled opp for me', () => {
    const rows = reviewEntries({
      ready: [row(), row({ id: 'r2', confidence: 'guess', start: '2026-11-16T18:00:00.000Z' }), row({ id: 'r3', status: 'approved', confidence: 'guess', start: '2026-11-16T19:00:00.000Z' })],
      needOpp: [needOpp({ suggestion: sugg() }), needOpp({ id: 'n2', suggestion: sugg({ confidence: 0.6 }), start: '2026-11-17T18:00:00.000Z' }), needOpp({ id: 'n3', suggestion: sugg(), suggestions: [sugg(), sugg({ oppId: 'o3', oppName: 'Globex', confidence: 0.85 })], start: '2026-11-17T19:00:00.000Z' })],
      settle,
    });
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get('r1')).toMatchObject({ kind: 'ready', preChecked: true, target: 'ACME · Platform' });
    expect(by.get('r2')).toMatchObject({ kind: 'ready', preChecked: false });
    expect(by.get('r3')).toMatchObject({ kind: 'ready', preChecked: true, why: 'You approved it.' });
    expect(by.get('n1')).toMatchObject({ kind: 'suggested', preChecked: true, target: 'Initech · Pilot' });
    expect(by.get('n2')).toMatchObject({ kind: 'unsure', preChecked: false, target: null });
    // a close second is not settled
    expect(by.get('n3')).toMatchObject({ kind: 'unsure', preChecked: false });
    expect([...initialChecked(rows)].sort()).toEqual(['n1', 'r1', 'r3']);
    expect(readyGroups(rows, 'day').map((d) => [d.key, d.rows.length, d.hours])).toEqual([
      ['2026-11-16', 3, 3],
      ['2026-11-17', 3, 3],
    ]);
  });

  it('a DC to claim on the same deal and the covered AE ride on the row', () => {
    const dc = { id: 's1', oppId: 'o1', state: 'new', coveredAe: 'Dana', splitPercent: 100, reasons: [{ code: 'x', text: 'two customer meetings' }] } as unknown as DcSuggestion;
    const [r] = reviewEntries({ ready: [row()], dcs: [dc], settle });
    expect(r).toMatchObject({ dc: { id: 's1' }, coveredAe: 'Dana' });
  });

  it('R3-6: a DC row says its coverage once, in the reason’s own words (an OOO cover is never "AE you cover")', () => {
    const base = { id: 's1', oppId: 'o1', oppName: 'Renewal FY27', accountName: 'Globex', state: 'new', splitPercent: 50, preTicked: true } as const;
    const ooo = { ...base, coveredAe: 'Elena Cruz', reasons: [{ code: 'covered_ae', text: 'covering for Elena Cruz (OOO) · 50%' }] } as unknown as DcSuggestion;
    const [x] = dcExtras([ooo]);
    expect(x!.why).toBe('50% DC · covering for Elena Cruz (OOO) · 50%');
    expect(x!.why).not.toMatch(/AE you cover/);
    // no coverage reason (an older suggestion): the person is still named, once
    const old = { ...base, coveredAe: 'Dana', reasons: [{ code: 'meetings', text: 'two customer meetings' }] } as unknown as DcSuggestion;
    expect(dcExtras([old])[0]!.why).toBe('50% DC · Covering Dana · two customer meetings');
  });

  it('zero ticked: the button is off and says why; otherwise it names what it logs', () => {
    const rows = reviewEntries({ ready: [row(), row({ id: 'r2', durationH: 1.5, start: '2026-11-16T18:00:00.000Z' })], settle });
    expect(logButton(rows, new Set())).toMatchObject({ disabled: true, why: 'Tick at least one row to log. Nothing is logged until you do.' });
    expect(logButton([], new Set())).toMatchObject({ disabled: true, why: 'Nothing is ready to log right now.' });
    expect(logButton(rows, new Set(['r1', 'r2']))).toMatchObject({ disabled: false, label: 'Log these 2 · 2.5 h', why: null });
    expect(logButton(rows, new Set(['r2']))).toMatchObject({ label: 'Log this one · 1.5 h' });
    // an unsure row can't be ticked until its opp is picked
    const unsure = reviewEntries({ ready: [], needOpp: [needOpp()], settle });
    expect(logButton(unsure, new Set(['n1'])).disabled).toBe(true);
    expect(tickedLine(rows, new Set(['r1']))).toBe('1 of 2 rows · 1 h ticked');
  });

  it('F5 (R2-6): Review is lane 2 at full width: the same header count, only the unsure rows a pick ticks, a link for the rest', () => {
    const ready = [row(), row({ id: 'r2', confidence: 'guess', start: '2026-11-16T18:00:00.000Z' })];
    const needs = [
      needOpp({ id: 'settled', suggestion: sugg() }),
      needOpp({ id: 'close', suggestion: sugg(), suggestions: [sugg(), sugg({ oppId: 'o3', oppName: 'Globex', confidence: 0.85 })] }),
      needOpp({ id: 'low', suggestion: sugg({ confidence: 0.5 }) }),
      needOpp({ id: 'none' }),
    ];
    const { pick, more } = reviewPickRows(needs, settle);
    // a settled suggestion is lane 1's Accept; no suggestion at all is lane 1's pick
    expect(pick.map((e) => e.id)).toEqual(['close', 'low']);
    expect(more).toBe(2);
    expect(fixMoreLine(more)).toBe('2 more rows need an opp first');
    expect(fixMoreLine(1)).toBe('1 more row needs an opp first');
    expect(fixMoreLine(0)).toBeNull();
    const lane = reviewEntries({ ready, settle });
    const review = reviewEntries({ ready, needOpp: pick, settle });
    expect(review.filter((r) => r.kind === 'unsure').map((r) => r.id).sort()).toEqual(['close', 'low']);
    expect(review.some((r) => r.id === 'none' || r.id === 'settled')).toBe(false);
    // one header on both faces
    const extras = reviewExtras([{ key: 'uc:1', title: 'Agent', ready: true } as unknown as UseCaseLanding]);
    expect(laneCount(review, extras)).toBe(laneCount(lane, extras));
    expect(laneCount(review, extras)).toBe('2 rows · 2 h · 1 use case');
  });

  it('use cases and changes to Events in Org62 are ticked like rows and go in the same request', () => {
    const uc = { key: 'uc:1', title: 'Agent for claims', companyName: 'ACME', oppName: 'ACME · Platform', sends: 'new in Org62', ready: true } as unknown as UseCaseLanding;
    const up = { writeId: 'w1', label: 'ACME weekly', summary: 'update · Duration 1 h → 2 h', reason: 'the meeting ran long', state: 'proposed' } as unknown as EventUpdateRow;
    const extras = reviewExtras([uc, { ...uc, key: 'uc:2', ready: false }], [up, { ...up, writeId: 'w2', state: 'dismissed' }]);
    expect(extras.map((x) => x.id)).toEqual(['uc|uc:1', 'up|w1']);
    expect(extras[1]!.why).toBe('Change: Duration 1 h → 2 h · the meeting ran long');
    const rows = reviewEntries({ ready: [row()], settle });
    expect(stageRequest(rows, new Set(['r1', 'uc|uc:1']), extras)).toEqual({ ids: ['r1'], useCases: ['uc:1'], updates: [] });
    // only a use case ticked: no ids (an absent list would mean every ready row; the explicit lists say none)
    expect(stageRequest(rows, new Set(['uc|uc:1']), extras)).toEqual({ useCases: ['uc:1'], updates: [] });
    expect(logButton(rows, new Set(['uc|uc:1']), extras)).toMatchObject({ disabled: false, label: 'Log this one' });
  });

  it('re-check: an opp changed elsewhere, a row gone or already handed off is named, never logged silently', () => {
    const rows = reviewEntries({ ready: [row(), row({ id: 'r2', start: '2026-11-16T18:00:00.000Z' }), row({ id: 'r3', start: '2026-11-16T19:00:00.000Z' })], settle });
    const snap = snapshotOf(rows);
    const fresh = [row({ oppId: 'o9', oppName: 'Globex · Renewal', accountName: 'Globex', version: 2 }), row({ id: 'r2', status: 'synced_to_canvas' })];
    const changes = recheck(snap, fresh, ['r1', 'r2', 'r3']);
    expect(changes.map((c) => [c.id, c.what])).toEqual([
      ['r1', 'now goes to Globex · Renewal'],
      ['r2', 'went to Org62 another way since you opened this page'],
      ['r3', 'is gone: it was removed since you opened this page'],
    ]);
    expect(changeNotice(changes.slice(0, 1))).toBe('1 row changed since you opened this page: ACME weekly now goes to Globex · Renewal. It is unticked; check, then press Log again.');
    // a pick made on this page is mine, not a change
    expect(recheck(snap, fresh, ['r1'], new Set(['r1']))).toEqual([]);
    expect(recheck(snap, [row(), row({ id: 'r2', start: '2026-11-16T18:00:00.000Z' })], ['r1', 'r2'])).toEqual([]);
    expect(changeNotice([])).toBeNull();
  });

  it('the result screen says what was staged and that nothing was sent', () => {
    const r = { draftIds: ['d1'], canvases: [{ draftId: 'd1', title: 'Q4 batch', rows: 2, hours: 2.5, updates: 0 }], events: 2, hours: 2.5, approved: 1, skipped: [], waiting: { rows: 0, hours: 0, draftIds: [] }, useCases: { rows: 0, later: 0 }, eventUpdates: 0 } as StageLogBatchResult;
    expect(resultLines(r, true)).toEqual({ title: 'Staged one batch: 2 rows · 2.5 h', body: ['1 suggested row approved with it.', 'Nothing was sent. Dry run is on: Apply only shows what would go to Org62.'] });
    expect(resultLines(r, false).body.at(-1)).toBe('Nothing was sent. It waits for your Apply; then Send to Org62 via Slackbot, and the app checks Org62.');
    const none = { ...r, draftIds: [], canvases: [], waiting: { rows: 2, hours: 2, draftIds: ['d0'] } } as StageLogBatchResult;
    expect(resultLines(none, true)).toEqual({ title: 'Already waiting for your Apply', body: ['2 rows are in a batch you have not applied yet.', 'Nothing was sent.'] });
  });

  it('keys: space ticks, j / k move, Enter opens, a logs', () => {
    expect([' ', 'j', 'ArrowDown', 'k', 'ArrowUp', 'Enter', 'a', 'x'].map(reviewKey)).toEqual(['toggle', 'next', 'next', 'prev', 'prev', 'open', 'log', null]);
  });
});

// C5: lane 2, Ready to log (src/components/time/ready-derive.ts): grouped by day or account, the counts and the button
describe('the Ready to log lane', () => {
  const day = (d: string, n: number, o: Partial<ActivityEntry> = {}) => row({ id: `${d}-${n}`, date: d, start: `${d}T${String(8 + n).padStart(2, '0')}:00:00.000Z`, durationH: 0.5, ...o });

  it('by day, oldest first; by account, the most hours first with Internal and no account last', () => {
    const rows = reviewEntries({ ready: [day('2026-11-17', 1), day('2026-11-16', 2, { accountName: 'Globex', durationH: 3 }), day('2026-11-16', 1, { internal: true, oppId: null, accountName: null }), day('2026-11-18', 1, { accountName: 'Globex' })], settle });
    expect(readyGroups(rows, 'day').map((g) => [g.key, g.rows.length, g.hours])).toEqual([
      ['2026-11-16', 2, 3.5],
      ['2026-11-17', 1, 0.5],
      ['2026-11-18', 1, 0.5],
    ]);
    expect(readyGroups(rows, 'account').map((g) => [g.label, g.rows.length])).toEqual([
      ['Globex', 2],
      ['ACME', 1],
      ['Internal (no opportunity)', 1],
    ]);
  });

  it('at most four groups open; 8 rows a group', () => {
    const rows = reviewEntries({ ready: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'].map((d) => day(d, 1)), settle });
    expect([...defaultOpen(readyGroups(rows, 'day'))]).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
    expect([READY_STEP, READY_OPEN_MAX]).toEqual([8, 4]);
  });

  it('F3: the header counts what the button can log, extras named; the button says what it stages; group labels carry no count', () => {
    const rows = reviewEntries({ ready: [day('2026-11-16', 1), day('2026-11-16', 2, { confidence: 'guess' })], settle });
    const extras = reviewExtras([{ key: 'uc1', title: 'Agentforce pilot', ready: true } as UseCaseLanding], [{ writeId: 'w1', label: 'ACME sync', summary: 'update · Duration 1 h → 2 h', reason: null, state: 'approved' } as unknown as EventUpdateRow]);
    const checked = new Set([...initialChecked(rows), ...extras.map((x) => x.id)]);
    expect(laneCount(rows)).toBe('2 rows · 1 h');
    expect(laneCount(rows, extras)).toBe('2 rows · 1 h · 1 use case · 1 Event change');
    expect(laneCount([], extras.slice(0, 1))).toBe('1 use case');
    expect(laneCount([])).toBe('Nothing ready');
    // the guess is not ticked: one row and two extras, each named
    expect(laneButton(rows, checked, extras).label).toBe('Log 1 row · 1 use case · 1 Event change');
    // R3-5: beside the button, per kind of what the header counts
    expect(tickedLine(rows, checked, extras)).toBe('1 of 2 rows · 0.5 h · 1 use case · 1 Event change ticked');
    expect(tickedLine(rows, new Set(initialChecked(rows)), extras)).toBe('1 of 2 rows · 0.5 h · 0 of 1 use case · 0 of 1 Event change ticked');
    // no extras ticked: rows and hours
    expect(laneButton(rows, new Set(initialChecked(rows)), extras).label).toBe('Log 1 row · 0.5 h');
    expect(laneButton(rows, new Set(['uc|uc1']), extras).label).toBe('Log 1 use case');
    expect(laneButton(rows, new Set(), extras)).toMatchObject({ label: 'Log', disabled: true });
    // the header draws the count beside the label ("Use cases 29"), so the label has none
    expect(extraGroups(extras).map((g) => g.label)).toEqual(['Use cases', 'Events in Org62']);
    // at scale: 2 rows and 29 use cases
    const ucs = reviewExtras(Array.from({ length: 29 }, (_, i) => ({ key: `u${i}`, title: `UC ${i}`, ready: true }) as UseCaseLanding));
    const two = reviewEntries({ ready: [day('2026-11-16', 1), day('2026-11-17', 1)], settle });
    expect(laneCount(two, ucs)).toBe('2 rows · 1 h · 29 use cases');
    expect(laneButton(two, new Set(initialChecked(two)), ucs).label).toBe('Log 2 rows · 1 h');
    expect(laneButton(two, new Set([...initialChecked(two), ...ucs.map((x) => x.id)]), ucs).label).toBe('Log 2 rows · 29 use cases');
    // R3-5: 8 of 29 seen and ticked: header, ticked line and button agree
    const eight = new Set([...initialChecked(two), ...ucs.slice(0, 8).map((x) => x.id)]);
    expect(laneButton(two, eight, ucs).label).toBe('Log 2 rows · 8 use cases');
    expect(tickedLine(two, eight, ucs)).toBe('2 rows · 1 h · 8 of 29 use cases ticked');
    const ids = tickable(rows);
    expect(groupTick(ids, new Set([ids[0]!]))).toEqual({ checked: false, mixed: true });
    expect(groupTick(ids, new Set(ids))).toEqual({ checked: true, mixed: false });
  });
});

// ── Lane 1, Fix or approve (src/components/time/fix-derive.ts; C4) ──────────────────────────────────────────────
describe('lane 1: Fix or approve', () => {
  const lane = (rows: ActivityEntry[], internal: ActivityEntry[] = [], by?: FixGroupBy) => fixLane({ needs: needsYou(rows, { taskTypeRequired: true }), internal: { rows: internal }, by });
  const initech = (id: string, o: Partial<ActivityEntry> = {}) => needOpp({ id, suggestion: sugg(), ...o });
  const globex = (id: string, c: number, o: Partial<ActivityEntry> = {}) => needOpp({ id, suggestion: sugg({ oppId: 'o3', oppName: 'Data 360 Expansion', accountName: 'Globex', confidence: c }), ...o });
  const internalRow = (id: string) => row({ id, oppId: null, oppName: null, accountName: null, internal: true, status: 'proposed', taskType: 'Asset Creation' });

  it('by suggestion: one group per suggested opp, then Internal, then no suggestion, type, hours; rows oldest first', () => {
    const m = lane(
      [
        initech('a', { start: '2026-11-18T16:00:00.000Z', date: '2026-11-18' }),
        initech('b'),
        globex('c', 0.95),
        needOpp({ id: 'd', suggestion: sugg({ kind: 'internal', oppId: null, oppName: null, accountName: null, taskType: 'Travel' }) }),
        needOpp({ id: 'e' }),
        row({ id: 'f', taskType: null, status: 'needs_input' }),
        row({ id: 'g', durationH: 0, status: 'needs_input' }),
      ],
      [internalRow('i1')],
    );
    expect(m.groups.map((g) => [g.id, g.label, g.ids])).toEqual([
      ['sugg:o3', 'Suggested: Globex · Data 360 Expansion', ['c']],
      ['sugg:o2', 'Suggested: Initech · Pilot', ['b', 'a']],
      ['internal', 'Suggested: Internal', ['i1', 'd']],
      ['r|pick', 'No suggestion: pick an opp', ['e']],
      ['r|type', 'Missing a task type', ['f']],
      ['r|hours', 'Hours to check', ['g']],
    ]);
    // C11: the sure suggestions and Internal are the Accept band, the rest Review
    expect(m.groups.map((g) => g.band)).toEqual(['accept', 'accept', 'accept', 'review', 'review', 'review']);
    // R3-4: the bands count the counted rows (Accept + Review = the lane's count); the suggested Internal row apart
    expect(m.bands).toEqual({ accept: 4, review: 3, internal: 1 });
    expect(m.bands.accept + m.bands.review).toBe(m.count);
    expect(bandLabel('accept', m.bands.accept, m.bands.internal)).toBe('Accept 4 · Internal 1');
    // the row under a group named for its opp does not repeat it
    expect(m.groups[1]!.target).toBe('Initech · Pilot');
    // Accept N: the suggestions, and the internal ones as internal
    expect(m.groups.map((g) => g.accept.length)).toEqual([1, 2, 2, 0, 0, 0]);
    expect(groupVerbLabel(m.groups[1]!)).toBe('Accept 2');
    expect(fixAcceptPatch(internalRow('i1'))).toEqual({ status: 'approved' });
    // the count is lanesOf's fix rows: the internal row the app suggests never counts
    expect(m.count).toBe(7);
    expect(m.suggested.map((e) => e.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('C11 bands: Accept holds the sure suggestions (and Internal), Review the guesses and the rows with none; Accept N never takes a guess', () => {
    const m = lane([initech('sure'), globex('guess', 0.47), needOpp({ id: 'none' }), initech('close', { suggestions: [sugg(), sugg({ oppId: 'o9', confidence: 0.88 })] })], [internalRow('i1')]);
    const band = (id: string) => m.groups.find((g) => g.ids.includes(id))!.band;
    expect(['sure', 'i1'].map(band)).toEqual(['accept', 'accept']);
    // a guess under the line, no suggestion, and a sure one with a close second are Review
    expect(['guess', 'none', 'close'].map(band)).toEqual(['review', 'review', 'review']);
    expect(m.bands).toEqual({ accept: 1, review: 3, internal: 1 });
    expect(m.bands.accept + m.bands.review).toBe(m.count);
    expect(bandLabel('accept', m.bands.accept, m.bands.internal)).toBe('Accept 1 · Internal 1');
    expect(bandLabel('accept', m.bands.accept)).toBe('Accept 1');
    expect(bandLabel('review', m.bands.review)).toBe('Review 3');
    // the lane's "Accept N suggestions" is the Accept band only; a Review group has no group Accept (row by row)
    expect(m.suggested.map((e) => e.id)).toEqual(['sure']);
    const review = m.groups.find((g) => g.ids.includes('guess'))!;
    expect(review.accept.map((e) => e.id)).toEqual(['guess']);
    expect(groupVerbLabel(review)).toBeNull();
    expect(groupVerbLabel(m.groups.find((g) => g.ids.includes('sure'))!)).toBe('Accept 1');
    // the Accept band first
    expect(m.groups.map((g) => g.band)).toEqual(['accept', 'accept', ...m.groups.slice(2).map(() => 'review')]);
  });

  it('the internal rows alone are a group outside the count; rows not found in Org62 are never here', () => {
    const m = lane([row({ id: 'gone', status: 'synced_to_canvas', issues: [NOT_IN_ORG62_FLAG] }), initech('a')], [internalRow('i1'), internalRow('i2')]);
    expect(m.groups.map((g) => [g.id, g.counted])).toEqual([
      ['sugg:o2', true],
      ['internal', false],
    ]);
    expect(m.count).toBe(1);
    expect(m.groups.flatMap((g) => g.ids)).not.toContain('gone');
  });

  it('order: the quarter due soonest first, then the most likely suggestion, then the most hours', () => {
    const m = lane([initech('late', { suggestion: sugg({ confidence: 0.99 }) }), globex('early', 0.5, { date: '2026-10-20', start: '2026-10-20T16:00:00.000Z' }), globex('x', 0.6, { suggestion: sugg({ oppId: 'o4', oppName: 'Hooli · Big', accountName: 'Hooli', confidence: 0.6 }), durationH: 5 }), needOpp({ id: 'y', suggestion: sugg({ oppId: 'o5', oppName: 'Umbrella · Small', accountName: 'Umbrella', confidence: 0.6 }), durationH: 1 })]);
    // F1: the October row is last quarter's: its own group, named by its quarter, due first
    // C11: the sure one is the Accept band; the guesses (under the settle line) are Review, in the same order
    expect(m.groups.map((g) => g.id)).toEqual(['sugg:o2', 'r|sugg:o3@Q3 FY27', 'r|sugg:o4', 'r|sugg:o5']);
    expect(m.groups[1]!.label).toMatch(/^Q3 FY27 · Suggested: /);
    expect(quarterEndOf('2026-10-20')).toBe('2026-10-31');
    expect(quarterEndOf('2026-11-17')).toBe('2027-01-31');
    expect(quarterEndOf('2027-01-05')).toBe('2027-01-31');
    expect(quarterEndOf('2026-02-01')).toBe('2026-04-30');
  });

  it('by day, account or opportunity; Internal stays its own group', () => {
    const rows = [initech('a'), globex('b', 0.8, { date: '2026-11-16', start: '2026-11-16T16:00:00.000Z' }), needOpp({ id: 'c' })];
    expect(lane(rows, [internalRow('i1')], 'day').groups.map((g) => g.id)).toEqual(['day:2026-11-16', 'day:2026-11-17', 'internal', 'r|day:2026-11-17']);
    expect(lane(rows, [], 'account').groups.map((g) => g.label).sort()).toEqual(['Globex', 'Initech', 'No account yet']);
    expect(lane(rows, [], 'opp').groups.map((g) => g.label).sort()).toEqual(['No opportunity yet', 'Suggested: Globex · Data 360 Expansion', 'Suggested: Initech · Pilot']);
  });

  it('four groups open at most; shift-click ranges; the ticked line', () => {
    const groups = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    expect(initialOpen(groups)).toEqual(['a', 'b', 'c', 'd']);
    expect(toggleGroup(['a', 'b', 'c', 'd'], 'e')).toEqual(['b', 'c', 'd', 'e']);
    expect(toggleGroup(['a', 'b'], 'a')).toEqual(['b']);
    expect(FIX_STEP).toBe(8);
    expect(rangeIds(['r1', 'r2', 'r3', 'r4'], 'r3', 'r1')).toEqual(['r1', 'r2', 'r3']);
    expect(rangeIds(['r1', 'r2'], null, 'r2')).toEqual(['r2']);
    expect(fixTickedLine([{ durationH: 1.5 }, { durationH: 3 }])).toBe('2 ticked · 4.5 h');
  });
});
