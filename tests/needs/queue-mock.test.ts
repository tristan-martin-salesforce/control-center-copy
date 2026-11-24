/**
 * The queue on the mock DataSource: the contract, decide (dispatch through the existing route, audited, Undo brings
 * the row back: NQ-01), a navigation verb refused, a failing read (NQ-02), and the one count: the sidebar's number is
 * the queue's total (NQ-05).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeedsPayload, routes, type RouteDef } from '@/contract';
import { needsCount } from '@/engines/needs/count';
import { needsCount as reexported } from '@/engines/activity/needs-count';
import { navCount } from '@/components/shell/Sidebar';
import { NAV_GROUPS } from '@/components/shell/nav';
import { ACTIVITY_KINDS, reviewableNeeds, rowsOfKinds, withoutNeed } from '@/components/needs/model';
import { needsAdapter } from '@/components/needs/NeedsReview';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';

let ds: MockDataSource | null = null;
afterEach(() => {
  ds?.dispose?.();
  ds = null;
});
const make = () => (ds = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } }));
const list = async (d: MockDataSource) => NeedsPayload.parse(await d.listNeeds({} as never));

describe('the routes', () => {
  it('GET /needs reads; POST /needs/:id/decide is deny for the Assistant and never sends', () => {
    expect(routes.listNeeds).toMatchObject({ method: 'GET', path: '/needs', assistant: 'read' });
    expect(routes.decideNeedRow).toMatchObject({ method: 'POST', path: '/needs/:id/decide', assistant: 'deny' });
    expect((routes.decideNeedRow as RouteDef).undoable).toBeUndefined();
  });
});

describe('GET /needs on the mock', () => {
  it('validates, one row per fact, total = rows = Σ byKind', async () => {
    const q = await list(make());
    expect(q.total).toBe(q.rows.length);
    expect(Object.values(q.byKind).reduce((a, b) => a + b, 0)).toBe(q.total);
    expect(new Set(q.rows.map((r) => r.id)).size).toBe(q.rows.length);
    expect(q.byKind.time_ready_to_log).toBeLessThanOrEqual(1);
    expect(q.partial).toEqual([]);
    for (const r of q.rows) expect(r.verbs.filter((v) => v.primary), r.id).toHaveLength(1);
  });

  it('the sidebar count is the queue’s total (and Activity’s slice is part of it)', async () => {
    const q = await list(make());
    const home = NAV_GROUPS[0]!.items.find((i) => i.href === '/')!;
    expect(home.count).toBe('needs');
    expect(navCount(undefined, home.count, needsCount(q))).toBe(q.total);
    expect(reexported(q)).toBe(q.total);
    expect(rowsOfKinds(q.rows, ACTIVITY_KINDS)!.length).toBeLessThanOrEqual(q.total);
  });

  it('a read that fails costs its rows only, and logs (NQ-02)', async () => {
    const d = make();
    const before = await list(d);
    vi.spyOn(d, 'getTriage').mockRejectedValue(new Error('down'));
    const q = await list(d);
    expect(q.partial).toEqual(expect.arrayContaining(['triage_guess', 'mapping_question', 'resolution_confirm']));
    expect(q.rows.some((r) => r.kind === 'triage_guess')).toBe(false);
    expect(q.byKind.outbox_draft).toBe(before.byKind.outbox_draft);
  });
});

describe('POST /needs/:id/decide on the mock', () => {
  it('runs the row’s route (audited), the row leaves, Undo brings it back (NQ-01)', async () => {
    const d = make();
    const q = await list(d);
    const r = q.rows.find((x) => x.kind === 'triage_guess' && x.verbs.find((v) => v.primary)?.id === 'accept')!;
    expect(r).toBeTruthy();
    const accept = vi.spyOn(d, 'acceptTriage');
    const res = await d.decideNeedRow({ params: { id: r.id }, body: { verb: 'accept' } } as never);
    expect(accept).toHaveBeenCalledWith({ params: { id: r.id.split(':')[1] }, body: {} });
    expect(res.auditId).toBeTruthy();
    expect(res.entity).toMatchObject({ verb: 'accept', route: 'acceptTriage', undoable: true });
    const after = await list(d);
    expect(after.rows.some((x) => x.id === r.id)).toBe(false);
    expect(after.total).toBe(q.total - 1);
    await d.undoAudit({ params: { id: res.auditId! }, body: {} } as never);
    expect((await list(d)).rows.some((x) => x.id === r.id)).toBe(true);
  });

  it('Later on a kind without its own snooze is the existing needs decision; Undo clears it', async () => {
    const d = make();
    const r = (await list(d)).rows.find((x) => x.kind === 'time_ready_to_log')!;
    const res = await d.decideNeedRow({ params: { id: r.id }, body: { verb: 'snooze' } } as never);
    expect(res.entity.route).toBe('decideNeed');
    expect((await list(d)).byKind.time_ready_to_log).toBe(0);
    await d.undoAudit({ params: { id: res.auditId! }, body: {} } as never);
    expect((await list(d)).byKind.time_ready_to_log).toBe(1);
  });

  it('refuses a navigation verb and a row that is gone', async () => {
    const d = make();
    const r = (await list(d)).rows.find((x) => x.kind === 'outbox_draft')!;
    await expect(d.decideNeedRow({ params: { id: r.id }, body: { verb: 'review' } } as never)).rejects.toMatchObject({ code: 'validation' });
    await expect(d.decideNeedRow({ params: { id: 'triage_guess:nope' }, body: { verb: 'accept' } } as never)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the client model', () => {
  it('a decided row leaves the cached queue at once (optimistic), counts with it', async () => {
    const q = await list(make());
    const r = q.rows[0]!;
    const next = withoutNeed(q, r.id);
    expect(next.total).toBe(q.total - 1);
    expect(next.byKind[r.kind]).toBe((q.byKind[r.kind] ?? 0) - 1);
    expect(withoutNeed(next, r.id)).toBe(next);
  });

  it('drain mode walks rows decided here; its Undo reverts exactly the batch', async () => {
    const q = await list(make());
    const rows = reviewableNeeds(q.rows);
    expect(rows.every((r) => r.verbs.find((v) => v.primary)?.call)).toBe(true);
    const audits = new Map<string, string>();
    const decide = vi.fn(async () => ({ auditId: 'au1' }));
    const undo = vi.fn(async () => ({}));
    const a = needsAdapter({ decide, undoAudit: undo, refetch: () => undefined }, audits);
    await a.approve(rows[0]!);
    expect(decide).toHaveBeenCalledWith(rows[0], rows[0]!.verbs.find((v) => v.primary));
    await a.undo({ verb: 'approve', items: [rows[0]!] });
    expect(undo).toHaveBeenCalledWith('au1');
    expect(audits.size).toBe(0);
  });
});
