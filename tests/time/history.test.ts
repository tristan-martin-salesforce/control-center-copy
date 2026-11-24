/**
 * History's rows (src/components/time/history-derive.ts): the Org62 record, and whether Undo can still take a row back.
 * A row in a batch that waits for Apply has not left; once applied or in Org62, Undo explains and offers the correction
 * (*tenet: Nothing leaves without approval*; external wins, then flag).
 */
import { describe, expect, it } from 'vitest';
import type { ActivityEntry, EventUpdateRow, LogCanvas } from '@/contract';
import { batchFinished, cardWaiting, correctionOf, finishedBatchesOf, historyStateOf, inBatchOf, inFlightCount, inFlightLine, landedLine, org62RecordOf, pageHistoryItems, undoWindowOf, unsettledIds } from '@/components/time/history-derive';
import { logItems } from '@/components/time/log-derive';

describe('History', () => {
  it('the Org62 record comes from the row’s Org62 source', () => {
    expect(org62RecordOf({ sources: [{ kind: 'calendar', label: 'Calendar' }, { kind: 'org62', label: 'Org62 · Solutions Event', externalId: '00U000000000001', url: 'https://org62.example/00U000000000001' }] })).toEqual({ id: '00U000000000001', url: 'https://org62.example/00U000000000001' });
    expect(org62RecordOf({ sources: [{ kind: 'org62', label: 'Org62 · ACME' }] })).toBeNull();
  });

  it('Undo is open while the batch waits for Apply, closed once applied or in Org62', () => {
    expect(undoWindowOf({ status: 'approved', canvasDraftId: 'd1', fromOrg62: false })).toMatchObject({ state: 'open', draftId: 'd1', label: 'Take it out of the batch' });
    const applied = undoWindowOf({ status: 'synced_to_canvas', canvasDraftId: undefined, fromOrg62: false });
    expect(applied).toMatchObject({ state: 'closed' });
    expect(applied.state === 'closed' && applied.why).toContain('can’t take it back');
    const logged = undoWindowOf({ status: 'verified', canvasDraftId: undefined, fromOrg62: false });
    expect(logged.state === 'closed' && logged.fix).toContain('Change or delete it in Org62');
    expect(undoWindowOf({ status: 'verified', canvasDraftId: undefined, fromOrg62: true })).toEqual({ state: 'none' });
    expect(undoWindowOf({ status: 'dismissed', canvasDraftId: undefined, fromOrg62: false })).toEqual({ state: 'none' });
  });

  const canvas = (o: Partial<LogCanvas>): LogCanvas => ({ draftId: 'd', title: 't', state: 'verified', url: null, createdAt: '2026-11-20T10:00:00Z', appliedAt: '2026-11-20T10:00:00Z', rows: 2, hours: 3, dcs: 0, updates: 0, useCases: 0, rowIds: ['r1', 'r2'], org62: { logged: 2, waiting: 0, missing: 0 }, quarters: [], maybeCreated: false, progress: null, ...o });

  it('Batches: only finished batches (checked in Org62, or every missing row settled), newest first, with their counts', () => {
    const done = canvas({ draftId: 'old', appliedAt: '2026-11-19T10:00:00Z', rows: 14, hours: 14.5, org62: { logged: 14, waiting: 0, missing: 0 }, rowIds: ['a'] });
    const newer = canvas({ draftId: 'new', appliedAt: '2026-11-21T10:00:00Z' });
    const pending = canvas({ draftId: 'p', state: 'pending', appliedAt: null, org62: null });
    const sending = canvas({ draftId: 's', org62: { logged: 1, waiting: 1, missing: 0 } });
    const failed = canvas({ draftId: 'f', state: 'unverified' });
    const settledMissing = canvas({ draftId: 'm', org62: { logged: 1, waiting: 0, missing: 1 }, rowIds: ['x1', 'x2'] });
    const out = finishedBatchesOf([done, pending, sending, failed, newer, settledMissing], { unsettled: new Set(['r9']), tz: 'UTC' });
    expect(out.map((b) => b.canvas.draftId)).toEqual(['new', 'm', 'old']);
    expect(out.at(-1)!.line).toBe('Batch 19 Nov · 14 rows · 14.5 h · Checked 14 of 14');
    // a missing row still not settled keeps its batch in Sending
    expect(batchFinished(settledMissing, new Set(['x2']))).toBe(false);
    expect(finishedBatchesOf([])).toEqual([]);
    // C10: once the last missing row is settled, the same batch is History's (and inBatchOf stops naming it)
    expect(batchFinished(settledMissing, new Set())).toBe(true);
    expect(inBatchOf([settledMissing], { unsettled: new Set() }).size).toBe(0);
    expect(inBatchOf([settledMissing], { unsettled: new Set(['x2']) }).get('x2')).toMatchObject({ draftId: 'm' });
  });

  it('a row on a batch still in Sending says so once ("in batch 21 Nov"); Undo only while the batch waits for Apply', () => {
    const m = inBatchOf([canvas({ draftId: 's', appliedAt: '2026-11-21T10:00:00Z', org62: { logged: 0, waiting: 2, missing: 0 } }), canvas({ draftId: 'p', state: 'pending', appliedAt: null, createdAt: '2026-11-22T09:00:00Z', org62: null, rowIds: ['r3'] })], { tz: 'UTC' });
    expect(historyStateOf({ id: 'r1', status: 'synced_to_canvas' }, m)).toEqual({ kind: 'in_batch', text: 'in batch 21 Nov', draftId: 's', pending: false });
    expect(historyStateOf({ id: 'r3', status: 'approved' }, m)).toMatchObject({ kind: 'in_batch', pending: true, text: 'in batch 22 Nov · waiting for your Apply' });
    expect(historyStateOf({ id: 'r9', status: 'proposed' }, m)).toEqual({ kind: 'waiting', text: 'Waiting on you in To log' });
    expect(historyStateOf({ id: 'r1', status: 'verified' }, m)).toEqual({ kind: 'done' });
    expect(historyStateOf({ id: 'r2', status: 'dismissed' }, m)).toEqual({ kind: 'excluded' });
    expect(unsettledIds([{ id: 'a', status: 'synced_to_canvas' }, { id: 'b', status: 'verified' }, { id: 'c', status: 'verify_failed' }])).toEqual(new Set(['a', 'c']));
  });

  it('F4: a finished batch says where its hours landed; the card counts batches in flight and drops their steps', () => {
    const spans = canvas({ draftId: 'x', quarters: [{ label: 'Q3 FY27', rows: 1, hours: 2.5 }, { label: 'Q4 FY27', rows: 1, hours: 6 }] });
    const one = canvas({ draftId: 'y', appliedAt: '2026-11-18T10:00:00Z', quarters: [{ label: 'Q4 FY27', rows: 2, hours: 3 }] });
    const out = finishedBatchesOf([spans, one], { tz: 'UTC' });
    expect(out.map((b) => b.landed)).toEqual(['Landed in Q3 FY27 2.5 h · Q4 FY27 6 h', 'Landed in Q4 FY27']);
    expect(landedLine({ quarters: [] })).toBeNull();
    const flying = canvas({ draftId: 'f', state: 'pending', appliedAt: null, org62: null });
    expect(inFlightCount([spans, one, flying])).toBe(1);
    expect(inFlightLine(1)).toBe('1 batch in flight');
    expect(inFlightLine(0)).toBeNull();
    const w = cardWaiting({ rows: 9, hours: 20, parts: [{ id: 'needs', label: 'need you', rows: 3, hours: 4 }, { id: 'ready', label: 'ready to log', rows: 2, hours: 2 }, { id: 'apply', label: 'to apply', rows: 2, hours: 6 }, { id: 'tell', label: 'to send to Org62 via Slackbot', rows: 2, hours: 8 }] });
    expect(w).toEqual({ rows: 5, hours: 6, parts: [expect.objectContaining({ id: 'needs' }), expect.objectContaining({ id: 'ready' })] });
  });

  it('scale: 8 rows a day then Show more, at most four weeks open', () => {
    const entries = Array.from({ length: 6 }, (_, w) => Array.from({ length: 10 }, (_, i) => ({ id: `w${w}r${i}`, date: new Date(Date.UTC(2026, 10, 20 - w * 7)).toISOString().slice(0, 10), status: 'verified', durationH: 1 }))).flat() as unknown as ActivityEntry[];
    const flat = logItems({ entries, weeks: [] });
    const paged = pageHistoryItems(flat);
    const weeks = paged.filter((it) => it.kind === 'week');
    expect(weeks.length).toBe(6);
    expect(weeks.filter((w) => w.kind === 'week' && w.open).length).toBe(4);
    expect(paged.filter((it) => it.kind === 'more').map((it) => it.kind === 'more' && it.hidden)).toEqual([2, 2, 2, 2]);
    expect(paged.filter((it) => it.kind === 'row').length).toBe(32);
    const day = paged.find((it) => it.kind === 'day')!;
    const opened = pageHistoryItems(flat, { days: new Set([day.kind === 'day' ? day.day : '']) });
    expect(opened.filter((it) => it.kind === 'row').length).toBe(34);
    expect(pageHistoryItems(flat, { weeks: new Set() }).filter((it) => it.kind === 'row').length).toBe(0);
  });

  it('a correction: Dismiss, or Undo to bring a dismissed one back', () => {
    const u = { writeId: 'w1', label: 'ACME weekly', summary: 'update · Duration 1 h → 2 h', reason: 'the meeting ran long', state: 'proposed' } as EventUpdateRow;
    expect(correctionOf(u)).toEqual({ id: 'w1', title: 'ACME weekly', what: 'Duration 1 h → 2 h · the meeting ran long', state: 'waiting', verb: { label: 'Dismiss', action: 'dismiss' } });
    expect(correctionOf({ ...u, state: 'dismissed' }).verb).toEqual({ label: 'Undo', action: 'restore' });
  });
});
