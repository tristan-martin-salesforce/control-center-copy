/**
 * Time ▸ Needs you / Log it / a row's details, the pure parts: why a row is read only (./rows-derive.ts rowLock), the
 * patch that accepts a suggestion, each logging canvas as a run with its own status,
 * the Log button naming its rows, and the opportunity picker's groups (./opp-picker-derive.ts).
 */
import { describe, expect, it } from 'vitest';

import type { ActivityEntry, ActivitySuggestion, LogCanvas, OppOption } from '@/contract';
import { LOG_AGAIN_FLAG } from '@/engines/activity/org62-check';
import { INTERNAL_LABEL, pickerList } from './opp-picker-derive';
import { acceptPatch, canvasRun, completeForApprove, confidenceOf, rowLock, suggestionLabel, sureWord } from './rows-derive';

const row = (o: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'r1',
  version: 1,
  date: '2026-11-10',
  start: '2026-11-10T16:00:00.000Z',
  end: '2026-11-10T17:00:00.000Z',
  durationH: 1,
  taskType: 'Solution Design',
  oppId: null,
  oppName: null,
  accountName: null,
  meetingType: 'CR',
  description: 'Row',
  status: 'needs_input',
  confidence: 'likely',
  sources: [],
  userLockedFields: [],
  issues: [],
  updatedAt: '2026-11-10T17:00:00.000Z',
  fromOrg62: false,
  excludedReason: null,
  loggedAt: null,
  verifiedAt: null,
  internal: false,
  dismissSource: null,
  logNote: null,
  logNoteBasis: null,
  why: null,
  suggestion: null,
  ...o,
});

const part = (total: number, inOrg62: number, missing = 0) => ({ total, inOrg62, missing });
const canvas = (o: Partial<LogCanvas> = {}): LogCanvas => ({
  draftId: 'd1',
  title: 'Activity log · Nov 3–Nov 12 · 2 rows',
  state: 'pending',
  url: null,
  createdAt: '2026-11-12T10:00:00.000Z',
  appliedAt: null,
  rows: 2,
  hours: 3,
  dcs: 0,
  updates: 0,
  useCases: 0,
  rowIds: ['r1', 'r2'],
  org62: null,
  quarters: [],
  maybeCreated: false,
  progress: null,
  ...o,
});

const sugg = (o: Partial<ActivitySuggestion> = {}): ActivitySuggestion => ({ kind: 'opp', oppId: 'o1', oppName: 'Initech · D360 Pilot', accountName: 'Initech', taskType: null, confidence: 0.8, reason: 'x', basis: 'rules', at: null, ...o });

describe('read only, and why', () => {
  it('says what holds the row and where it can change', () => {
    expect(rowLock(row())).toBeNull();
    expect(rowLock(row({ status: 'approved', canvasDraftId: 'd1' }), [canvas()])).toMatchObject({ kind: 'on_canvas', canvas: { draftId: 'd1' } });
    expect(rowLock(row({ status: 'approved', canvasDraftId: 'd1' }), [canvas()])!.why).toBe('On “Activity log · Nov 3–Nov 12 · 2 rows”, waiting for your Apply: edit or remove it in that batch’s review');
    expect(rowLock(row({ status: 'synced_to_canvas' }), [canvas({ state: 'applied', appliedAt: '2026-11-12T11:00:00.000Z' })])).toMatchObject({ kind: 'handed_off' });
    expect(rowLock(row({ status: 'verified', verifiedAt: '2026-11-12T18:00:00.000Z' }), [], 'UTC')!.why).toBe('In Org62 (checked Thu, Nov 12): change it in Org62, the app follows');
    expect(rowLock(row({ status: 'logged', fromOrg62: true }))!.kind).toBe('from_org62');
    expect(rowLock(row({ status: 'dismissed', excludedReason: 'dismissed' }))!.why).toMatch(/Restore it from History/);
    // D-65: a row you put back with Log again is yours again, though its old canvas lists it
    expect(rowLock(row({ status: 'approved', issues: [LOG_AGAIN_FLAG] }), [canvas({ state: 'applied' })])).toBeNull();
  });
});

describe('the confidence chip', () => {
  it('Sure / Likely / Guess on the same cut-offs as the suggestion line', () => {
    expect([0.95, 0.85, 0.7, 0.65, 0.5].map(confidenceOf)).toEqual(['sure', 'sure', 'likely', 'likely', 'guess']);
    for (const c of [0.9, 0.7, 0.3]) expect(sureWord(c).replace('a ', '')).toBe(confidenceOf(c));
  });
});

describe('accepting a suggestion', () => {
  it('an opp: the row takes it, and a held row it completes is approved with it', () => {
    expect(acceptPatch(row({ suggestion: sugg() }))).toEqual({ oppId: 'o1', status: 'approved' });
    expect(acceptPatch(row({ status: 'proposed', suggestion: sugg() }))).toEqual({ oppId: 'o1' });
    // still missing a type: it stays held
    expect(acceptPatch(row({ taskType: null, suggestion: sugg() }))).toEqual({ oppId: 'o1' });
    expect(acceptPatch(row())).toBeNull();
  });
  it('internal: the internal type it names, approved', () => {
    expect(acceptPatch(row({ suggestion: sugg({ kind: 'internal', oppId: null, oppName: null, accountName: null, taskType: 'Asset Creation' }) }))).toEqual({ internal: true, taskType: 'Asset Creation', status: 'approved' });
    expect(suggestionLabel(sugg({ kind: 'internal' }))).toBe('Internal (no opportunity)');
    expect(suggestionLabel(sugg())).toBe('Initech · D360 Pilot');
    expect(suggestionLabel(sugg({ oppName: 'D360 Pilot' }))).toBe('D360 Pilot (Initech)');
  });
  it('Approve in bulk only touches complete rows', () => {
    expect(completeForApprove(row({ oppId: 'o1' }))).toBe(true);
    expect(completeForApprove(row())).toBe(false);
    expect(completeForApprove(row({ internal: true, taskType: 'Asset Creation' }))).toBe(true);
    expect(completeForApprove(row({ oppId: 'o1', taskType: null }))).toBe(false);
    expect(completeForApprove(row({ oppId: 'o1', taskType: null }), false)).toBe(true);
  });
});

describe('batches as runs', () => {
  it('pending: waiting for your Apply, its rows still editable in the review', () => {
    const r = canvasRun(canvas());
    expect(r).toMatchObject({ status: 'Waiting for your Apply', tone: 'act', next: 'apply' });
    expect(r.steps.map((s) => `${s.id}:${s.state}`)).toEqual(['staged:done', 'applied:current', 'told:todo', 'org62:todo']);
    expect(r.rowsNote).toMatch(/edit or remove its rows/);
    expect(r.counts).toBe('2 rows · 3 h');
  });
  it('a retry that may have made the batch: check Slack first, its rows locked', () => {
    const r = canvasRun(canvas({ state: 'retry', maybeCreated: true }));
    expect(r).toMatchObject({ next: 'check_slack', tone: 'warning' });
    expect(r.rowsNote).toMatch(/check Slack/);
  });
  it('created: send it to Org62 via Slackbot; told: checking; all in Org62: finished; some missing: needs you', () => {
    const applied = { state: 'applied' as const, appliedAt: '2026-11-12T11:00:00.000Z', url: 'https://example.slack.com/canvas/1' };
    const waiting = canvasRun(canvas({ ...applied, progress: { events: part(2, 0), dcs: part(0, 0), useCases: part(0, 0), state: 'waiting', toldAt: null, checkedAt: null, nextCheckAt: null } }), 'UTC');
    expect(waiting).toMatchObject({ status: 'Created: send it to Org62 via Slackbot', next: 'tell', tone: 'act' });
    expect(waiting.rowsNote).toBe('Applied Thu, Nov 12: its rows can’t change here now');
    const told = canvasRun(canvas({ ...applied, progress: { events: part(2, 1), dcs: part(0, 0), useCases: part(0, 0), state: 'checking', toldAt: '2026-11-12T12:00:00.000Z', checkedAt: null, nextCheckAt: null } }));
    expect(told).toMatchObject({ next: 'check', tone: 'waiting' });
    expect(told.steps.find((s) => s.id === 'told')!.state).toBe('done');
    const done = canvas({ ...applied, draftId: 'd2', progress: { events: part(2, 2), dcs: part(3, 3), useCases: part(0, 0), state: 'in_org62', toldAt: '2026-11-12T12:00:00.000Z', checkedAt: '2026-11-12T13:00:00.000Z', nextCheckAt: null } });
    expect(canvasRun(done)).toMatchObject({ status: 'In Org62', next: 'none' });
    const missing = canvasRun(canvas({ ...applied, progress: { events: part(2, 1, 1), dcs: part(0, 0), useCases: part(0, 0), state: 'missing', toldAt: null, checkedAt: '2026-11-12T13:00:00.000Z', nextCheckAt: null } }));
    expect(missing).toMatchObject({ status: 'Missing in Org62: 1 Event', tone: 'danger', next: 'relog' });
  });
});

describe('the opportunity picker’s groups', () => {
  const o = (id: string, name: string, accountName: string, why: OppOption['why'] = [], extra: Partial<OppOption> = {}): OppOption => ({ id, name, accountId: `a_${accountName}`, accountName, stage: 'Discovery', closeDate: '2026-12-01', isOpen: true, isMine: true, why, lastUsed: null, org62Id: null, ...extra });
  const opps = [o('o1', 'Initech · D360 Pilot', 'Initech', ['related']), o('o2', 'ACME · Phase 2', 'ACME Corp', ['recent'], { lastUsed: '2026-11-10' }), o('o3', 'Globex · Renewal', 'Globex')];

  it('nothing typed: the suggestion, Internal near the top, the likely account, used lately, the rest', () => {
    const list = pickerList({ opps, q: '', entry: { oppId: null, internal: false, accountName: null, suggestion: sugg({ oppId: 'o1' }) }, internal: true });
    expect(list.map((x) => `${x.group}:${x.key}`)).toEqual(['Suggested:opp:o1', 'Internal work:internal', 'Used lately:opp:o2', 'Other opportunities:opp:o3']);
    const internalFirst = pickerList({ opps, q: '', entry: { oppId: null, internal: false, accountName: 'Globex', suggestion: sugg({ kind: 'internal', oppId: null }) }, internal: true });
    expect(internalFirst[0]).toMatchObject({ kind: 'internal', group: 'Suggested', label: INTERNAL_LABEL });
    expect(internalFirst[1]).toMatchObject({ key: 'opp:o3', group: 'Globex opportunities' });
    // a role without internal work never sees it
    expect(pickerList({ opps, q: '', entry: { oppId: null, internal: false, accountName: null, suggestion: null }, internal: false }).some((x) => x.kind === 'internal')).toBe(false);
  });

  it('typed: the Org62 search first when nothing here matches, last otherwise; Internal when the words say so', () => {
    const none = pickerList({ opps, q: 'umbrella', entry: { oppId: null, internal: false, accountName: null, suggestion: null }, internal: true });
    expect(none.map((x) => x.kind)).toEqual(['search']);
    const some = pickerList({ opps, q: 'globex', entry: { oppId: null, internal: false, accountName: null, suggestion: null }, internal: true });
    expect(some.map((x) => x.kind)).toEqual(['opp', 'search']);
    expect(pickerList({ opps, q: 'intern', entry: { oppId: null, internal: false, accountName: null, suggestion: null }, internal: true })[0]!.kind).toBe('internal');
    // once the search answered, its hits are the caller's: no second search item
    expect(pickerList({ opps, q: 'umbrella', entry: { oppId: null, internal: false, accountName: null, suggestion: null }, internal: true, searched: true })).toEqual([]);
  });
});
