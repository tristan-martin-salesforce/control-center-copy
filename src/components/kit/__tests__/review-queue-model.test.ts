/**
 * The drain mode's model: stable order, arrivals at the end, Undo scoped to the open batch, a gone row that never
 * traps the cursor, failures back on screen.
 */
import { describe, expect, it } from 'vitest';
import { actOn, actOnMany, closeBatch, failOn, initQueue, moveCursor, pendingOf, progressOf, summaryOf, syncQueue, undoBatch } from '../review-queue-model';

describe('review queue model', () => {
  it('acting advances; progress counts what is done', () => {
    let m = initQueue(['a', 'b', 'c']);
    expect(progressOf(m)).toEqual({ position: 1, total: 3, done: 0 });
    m = actOn(m, 'a', 'approve');
    expect(m.cursor).toBe('b');
    expect(progressOf(m)).toEqual({ position: 2, total: 3, done: 1 });
  });

  it('same verb joins the batch; another verb starts a new one; Undo reverts only that batch, back in place', () => {
    let m = initQueue(['a', 'b', 'c', 'd']);
    m = actOn(m, 'a', 'approve');
    m = actOn(m, 'b', 'approve');
    expect(m.batch).toMatchObject({ verb: 'approve', ids: ['a', 'b'] });
    m = actOn(m, 'c', 'snooze');
    expect(m.batch).toMatchObject({ verb: 'snooze', ids: ['c'] });
    m = undoBatch(m);
    expect(m.batch).toBeNull();
    expect(m.cursor).toBe('c');
    expect(pendingOf(m)).toEqual(['c', 'd']);
    expect(summaryOf(m)).toEqual({ approve: 2, snooze: 0, dismiss: 0 });
    expect(m.order).toEqual(['a', 'b', 'c', 'd']);
    // the earlier batch is closed: a second undo does nothing
    expect(undoBatch(m)).toBe(m);
  });

  it('a closed toast ends the batch: the next act starts a new one', () => {
    let m = actOn(initQueue(['a', 'b']), 'a', 'approve');
    m = closeBatch(m);
    m = actOn(m, 'b', 'approve');
    expect(m.batch?.ids).toEqual(['b']);
  });

  it('a bulk approve is its own batch', () => {
    let m = actOn(initQueue(['a', 'b', 'c', 'd']), 'a', 'approve');
    m = actOnMany(m, ['c', 'd'], 'approve');
    expect(m.batch?.ids).toEqual(['c', 'd']);
    expect(m.cursor).toBe('b');
    m = undoBatch(m);
    expect(pendingOf(m)).toEqual(['b', 'c', 'd']);
  });

  it('fresh data never reorders; arrivals go to the end, marked new; acted rows keep their place', () => {
    let m = actOn(initQueue(['a', 'b', 'c']), 'a', 'approve');
    m = syncQueue(m, ['n1', 'c', 'b']); // the server re-sorted, a left (approved), n1 arrived on top
    expect(m.order).toEqual(['a', 'b', 'c', 'n1']);
    expect(m.fresh).toEqual(['n1']);
    expect(m.cursor).toBe('b');
  });

  it('the row on screen that left elsewhere stays, gone, until you move on; others drop at once', () => {
    let m = initQueue(['a', 'b', 'c']);
    m = syncQueue(m, ['c']);
    expect(m.order).toEqual(['a', 'c']);
    expect(m.gone).toEqual(['a']);
    expect(actOn(m, 'a', 'approve')).toBe(m); // nothing to approve
    m = moveCursor(m, 1);
    expect(m.cursor).toBe('c');
    expect(m.order).toEqual(['c']);
  });

  it('a gone last row leads to the end screen', () => {
    let m = initQueue(['a']);
    m = syncQueue(m, []);
    m = moveCursor(m, 1);
    expect(m.cursor).toBeNull();
  });

  it('j/k stop at the ends', () => {
    let m = initQueue(['a', 'b']);
    m = moveCursor(m, -1);
    expect(m.cursor).toBe('a');
    m = moveCursor(moveCursor(m, 1), 1);
    expect(m.cursor).toBe('b');
  });

  it('a failure puts the row back on screen with its error', () => {
    let m = actOn(initQueue(['a', 'b']), 'a', 'approve');
    m = failOn(m, 'a', 'Slack said no');
    expect(m.cursor).toBe('a');
    expect(m.failed).toEqual({ a: 'Slack said no' });
    expect(m.batch).toBeNull();
    m = actOn(m, 'a', 'approve');
    expect(m.failed).toEqual({});
  });
});
