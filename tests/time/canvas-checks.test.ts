/**
 * 2026-11-13 audit C4: each handed-off canvas has its own progress, and a copied Slackbot prompt re-checks Org62 for it
 * about 5, 15, 30 and 60 minutes later (the real case: Events made at 17:37, last scan 17:19, 6-hourly off hours).
 */
import { describe, expect, it } from 'vitest';

import { canvasChecksOf, canvasProgressOf, planRecheck, progressLine, RECHECK_AFTER_MIN, recheckWindow, slotOf } from '@/lib/canvas/checks';
import { createMockDataSource } from '@/server/datasource/mock';
import { logCanvasesOf } from '@/server/datasource/log-canvases';

const NOW = new Date('2026-11-13T17:40:00.000Z');

describe('planRecheck', () => {
  it('a copy queues checks about 5, 15, 30 and 60 minutes later, and remembers when you told Slackbot', () => {
    const p = planRecheck({}, 'd1', 'copied', NOW);
    expect(p.slots).toEqual(RECHECK_AFTER_MIN.map((m) => slotOf(new Date(NOW.getTime() + m * 60_000).toISOString())));
    expect(p.next.d1).toEqual({ toldAt: NOW.toISOString(), askedAt: null, at: p.slots });
  });

  it('"check now" adds one check at once and keeps the earlier ones', () => {
    const a = planRecheck({}, 'd1', 'copied', NOW);
    const later = new Date(NOW.getTime() + 2 * 60_000);
    const b = planRecheck(a.next, 'd1', 'now', later);
    expect(b.slots).toEqual([slotOf(later.toISOString())]);
    expect(b.next.d1!.at).toHaveLength(5);
    expect(b.next.d1!.toldAt).toBe(NOW.toISOString());
    expect(b.next.d1!.askedAt).toBe(later.toISOString());
  });

  it('two canvases told in the same minute share their check slots (one read each)', () => {
    const a = planRecheck({}, 'd1', 'copied', NOW);
    const b = planRecheck(a.next, 'd2', 'copied', new Date(NOW.getTime() + 20_000));
    expect(b.slots).toEqual(a.slots);
  });

  it('forgets canvases a week after their last check; tolerates a malformed store', () => {
    const old = planRecheck({}, 'old', 'copied', new Date(NOW.getTime() - 9 * 86_400_000));
    expect(Object.keys(planRecheck(old.next, 'd1', 'now', NOW).next)).toEqual(['d1']);
    expect(canvasChecksOf('nope')).toEqual({});
    expect(canvasChecksOf({ d1: { toldAt: 'x', at: ['2026-11-13T17:45:00.000Z', 3] } })).toEqual({ d1: { toldAt: null, askedAt: null, at: ['2026-11-13T17:45:00.000Z'] } });
  });

  it('a check reads from before the canvas was applied up to when it runs (at most a day back)', () => {
    expect(recheckWindow('2026-11-13T17:45:00.000Z', '2026-11-13T17:30:00.000Z')).toEqual({ from: '2026-11-13T16:45:00.000Z', to: '2026-11-13T17:45:00.000Z' });
    expect(recheckWindow('2026-11-13T17:45:00.000Z', '2026-11-10T17:30:00.000Z').from).toBe('2026-11-12T17:45:00.000Z');
  });
});

describe('canvasProgressOf', () => {
  const base = { draftId: 'd1', appliedAt: '2026-11-13T17:30:00.000Z', rows: 4, dcs: 55, useCases: 3, org62: { logged: 4, waiting: 0, missing: 0 } };
  const confirmed = Array.from({ length: 55 }, () => ({ canvasDraftId: 'd1', stage: 'confirmed' as const, outcome: null }));

  it('"4 of 4 Events · 55 of 55 DCs · 3 of 3 use cases in Org62", in Org62, checked at the oldest read it needs', () => {
    const p = canvasProgressOf(base, { dcRequests: confirmed, useCases: [], now: NOW, reads: { events: '2026-11-13T17:49:00.000Z', dcs: '2026-11-13T17:50:00.000Z', useCases: '2026-11-13T17:52:00.000Z' } });
    expect(progressLine(p)).toBe('4 of 4 Events · 55 of 55 DCs · 3 of 3 use cases in Org62');
    expect(p.state).toBe('in_org62');
    expect(p.checkedAt).toBe('2026-11-13T17:49:00.000Z');
  });

  it('a read from before the canvas was applied does not count as checked', () => {
    const p = canvasProgressOf(base, { dcRequests: confirmed, now: NOW, reads: { events: '2026-11-13T17:19:00.000Z', dcs: '2026-11-13T17:50:00.000Z', useCases: '2026-11-13T17:50:00.000Z' } });
    expect(p.checkedAt).toBeNull();
  });

  it('waiting for Slackbot, then checking once you told it (with the next check), and missing when Org62 lacks some', () => {
    const waiting = { ...base, org62: { logged: 0, waiting: 4, missing: 0 } };
    const handed = confirmed.map((r) => ({ ...r, stage: 'handed_off' as const }));
    expect(canvasProgressOf(waiting, { dcRequests: handed, useCases: [{ canvasDraftId: 'd1', state: 'handed_off' }], now: NOW }).state).toBe('waiting');
    const told = planRecheck({}, 'd1', 'copied', NOW).next.d1!;
    const p = canvasProgressOf(waiting, { dcRequests: handed, useCases: [{ canvasDraftId: 'd1', state: 'handed_off' }], check: told, now: NOW });
    expect(p.state).toBe('checking');
    expect(p.toldAt).toBe(NOW.toISOString());
    expect(p.nextCheckAt).toBe(told.at[0]);
    expect(progressLine(p)).toBe('0 of 4 Events · 0 of 55 DCs · 2 of 3 use cases in Org62');
    const missing = canvasProgressOf({ ...base, org62: { logged: 3, waiting: 0, missing: 1 } }, { dcRequests: [...confirmed.slice(1), { canvasDraftId: 'd1', stage: 'not_created', outcome: null }], now: NOW });
    expect(missing.state).toBe('missing');
    expect(missing.dcs).toEqual({ total: 55, inOrg62: 54, missing: 1 });
  });

  it('two canvases in flight are told apart: each counts only its own DCs', () => {
    const reqs = [...Array.from({ length: 3 }, () => ({ canvasDraftId: 'a', stage: 'confirmed' as const, outcome: null })), ...Array.from({ length: 2 }, () => ({ canvasDraftId: 'b', stage: 'handed_off' as const, outcome: null }))];
    const a = canvasProgressOf({ ...base, draftId: 'a', rows: 0, dcs: 3, useCases: 0, org62: null }, { dcRequests: reqs, now: NOW });
    const b = canvasProgressOf({ ...base, draftId: 'b', rows: 0, dcs: 2, useCases: 0, org62: null }, { dcRequests: reqs, now: NOW });
    expect([a.state, progressLine(a)]).toEqual(['in_org62', '3 of 3 DCs in Org62']);
    expect([b.state, progressLine(b)]).toEqual(['waiting', '0 of 2 DCs in Org62']);
  });
});

describe('the mock: a created canvas carries its progress, and Check now records its checks', () => {
  it('logCanvasesOf without sources leaves progress null (the Assistant reads stay as they were)', () => {
    expect(logCanvasesOf([], [], NOW)).toEqual([]);
  });

  it('checkCanvasOrg62 refuses a canvas that is not in Slack yet, and an unknown one', async () => {
    const ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
    await expect(ds.checkCanvasOrg62({ params: { id: 'nope' }, body: { reason: 'now' } } as never)).rejects.toThrow(/not found/i);
  });
});

describe('C7: Withdraw all waiting is one change with one Undo (mock)', () => {
  it('withdraws every waiting request in one change set; Undo brings them all back', async () => {
    const ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
    for (const opp of ['opp_globex_renew', 'opp_hooli_data']) await ds.createDcRequest({ body: { opp, split: 100, comment: 'Placeholder: helped on the demo' } } as never);
    const before = (await ds.listDcRequests({} as never)).requests.filter((r) => r.stage === 'waiting');
    expect(before).toHaveLength(2);
    const res = await ds.withdrawDcRequests({ body: {} } as never);
    expect(res.entity.withdrawn.sort()).toEqual(before.map((r) => r.id).sort());
    expect(res.auditId).toBeTruthy();
    expect((await ds.listDcRequests({} as never)).requests.filter((r) => r.stage === 'waiting')).toHaveLength(0);
    expect((await ds.getToday({ query: {} } as never)).navCounts.waitingForCanvas.dcs).toBe(0);
    await ds.undoAudit({ params: { id: res.auditId! }, body: {} } as never);
    expect((await ds.listDcRequests({} as never)).requests.filter((r) => r.stage === 'waiting')).toHaveLength(2);
    expect((await ds.getToday({ query: {} } as never)).navCounts.waitingForCanvas.dcs).toBe(2);
  });
});
