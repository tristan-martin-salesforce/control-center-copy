/**
 * Home as the briefing, its actions over the mock DataSource: every card, row and chip verb maps to an existing route
 * (no new mutation semantics; nothing sends from Home), and "Move it" (Overbooked → what to move) is the existing
 * snooze, audited, and its Undo brings the item back to today's load.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HomeAction, HomePayload, ItemActionVerb, routes } from '@/contract';
import { buildHome } from '@/engines/home/build';
import { matchRoute } from '@/components/shell/routes';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { homeInputFromStore } from '@/server/datasource/mock/home';

let ds: MockDataSource | null = null;
afterEach(() => {
  ds?.dispose?.();
  ds = null;
});
const make = () => (ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed', delays: { enrichMs: 1e8, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } }));

/** A client page for an in-app href (query and hash dropped). */
const isPage = (href: string) => matchRoute(href.split(/[?#]/)[0]!).key !== 'notFound';

describe('card verbs map to existing routes', () => {
  it('every Do-now card, row, chip and admin item lands on an app page or an existing route; none sends', async () => {
    const d = make();
    const h = HomePayload.parse(await d.getHome({ query: { wide: false } } as never));
    const verbs = [...h.doNow.cards.map((c) => c.verb), ...h.sections.flatMap((s) => s.rows.map((r) => r.verb))];
    for (const v of verbs) {
      expect(HomeAction.options).toContain(v.action);
      // the verbs that leave Home navigate to a page; Open in Claude and Re-auth name what they act on
      if (v.action === 'open_in_claude' || v.action === 'reauth') expect(v.targetId, v.label).toBeTruthy();
      else if (v.href) expect(isPage(v.href), `${v.label} → ${v.href}`).toBe(true);
      // approving a draft is Review in the Outbox (its own preview, confirm and undo window), never a send from Home
      if (v.action === 'review') expect(v.href ?? '').toMatch(/^\/outbox/);
    }
    for (const c of h.respond.chips) expect(isPage(c.href), c.href).toBe(true);
    for (const c of h.respond.chips.filter((x) => x.kind === 'draft')) expect(c.href).toMatch(/^\/outbox\?draft=/);
    if (h.respond.review) expect(h.respond.review.href).toBe('/outbox');
    if (h.admin) for (const r of h.admin.rows) expect(isPage(r.href), r.href).toBe(true);
    for (const b of h.builds) expect(b.deepLink === null || b.deepLink.startsWith('claude://')).toBe(true);
  });

  it('the item verbs Home runs are the existing item actions (done, snooze, reopen, not-now, confirm-done, not-done)', () => {
    for (const v of ['done', 'snooze', 'reopen', 'not-now', 'confirm-done', 'not-done']) expect(ItemActionVerb.options).toContain(v);
    expect(routes.itemAction).toMatchObject({ method: 'POST', path: '/items/:id/actions/:verb', undoable: true });
    expect(routes.undoAudit).toMatchObject({ method: 'POST', path: '/audit/:id/undo' });
  });
});

describe('Overbooked → "Move it" (the snooze verb) and Undo', () => {
  it('moves the first makeRoom item to the next working day; Undo puts it back where it was', async () => {
    const d = make();
    const overbook = () => {
      const input = homeInputFromStore(d, false);
      return buildHome({ ...input, capacity: { ...input.capacity, day: 'today', fits: false, youMinToday: input.capacity.freeMin + 240, openMin: -240 } });
    };
    const before = overbook();
    const m = before.moveIt!;
    expect(m).not.toBeNull();
    expect(m.item).not.toBeNull();
    const id = m.item!.id;
    const prior = d.store.get('workItems', id)!;

    // what the "Move it" button sends: useHomeActions.snooze → POST /items/:id/actions/snooze until the day named
    const res = await d.itemAction({ params: { id, verb: 'snooze' }, body: { ifVersion: m.item!.version, until: m.to!.startsAt } } as never);
    expect(res.auditId).toBeTruthy();
    const moved = d.store.get('workItems', id)!;
    expect(moved.snoozedUntil ?? null).toBe(m.to!.startsAt);
    const after = overbook();
    expect(after.doNow.cards.some((c) => c.id === id)).toBe(false);
    expect(after.makeRoom?.rows.some((r) => r.itemId === id) ?? false).toBe(false);

    // Undo (the toast): the audit's change set reverts, and the item is today's work again
    await d.undoAudit({ params: { id: res.auditId! }, body: {} } as never);
    const back = d.store.get('workItems', id)!;
    expect(back.state).toBe(prior.state);
    expect(back.snoozedUntil ?? null).toBe(prior.snoozedUntil ?? null);
    expect(overbook().moveIt?.item?.id).toBe(id);
  });
});
