/**
 * CONTRACT-1 task 1: chat ops. Every chat-made change is audited as actor `chat` (never `user`), never adds
 * userLockedFields, and is undoable. A field the user locked comes back as a proposal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CalendarEvent, PolicyPreview, Receipt, Settings, WorkItem } from '@/contract';
import type { MockDataSource } from '@/server/datasource/mock';
import { ask, newDs, of, opsOf } from './helpers';

let ds: MockDataSource;
beforeEach(() => {
  ds = newDs();
});
afterEach(() => ds.dispose());

const item = async (id: string) => (await ds.getItem({ params: { id } })).item;
const auditOf = (id: string) => ds.audit.get(id)!;

describe('chat changes startBy (streamed through POST /chat)', () => {
  it('is audited as chat, does not lock the field, and undoes', async () => {
    const evs = await ask(ds, 'move Globex prep after lunch');
    expect(evs[0].type).toBe('start');
    expect(evs.at(-1)?.type).toBe('done');
    const receipt = of(evs, 'receipt')[0].receipt;
    expect(receipt.actor).toBe('chat');
    const line = receipt.changes.find((c) => c.field === 'startBy')!;
    expect(line).toBeDefined();
    expect(line.label).toBe('Start by');

    const entry = auditOf(line.auditId);
    expect(entry.actor).toBe('chat');
    expect(entry.action).toBe('chat.edit');
    expect(entry.undoable).toBe(true);

    const after = await item(line.entity.id);
    expect(after.startBy).toBe(line.after);
    expect(after.userLockedFields).not.toContain('startBy');
    const history = await ds.getItemHistory({ params: { id: after.id } });
    expect(history.entries.find((e) => e.id === line.auditId)?.actor).toBe('chat');
    expect(history.entries.some((e) => e.actor === 'user')).toBe(false);

    const undo = await ds.undoAudit({ params: { id: line.auditId }, body: {} });
    expect(undo.entity.undoOf).toBe(line.auditId);
    const reverted = await item(line.entity.id);
    expect(reverted.startBy).toBe(line.before);
    expect(reverted.userLockedFields).not.toContain('startBy');
  });

  it('a later engine write to the chat-edited field still lands (chat did not lock it)', async () => {
    const evs = await ask(ds, 'move Globex prep after lunch');
    const line = of(evs, 'receipt')[0].receipt.changes.find((c) => c.field === 'startBy')!;
    const r = await ds.devEngineChange({ body: { entityType: 'work_item', id: line.entity.id, patch: { startBy: '2030-01-01T09:00:00.000Z' }, reason: 'engine' } });
    expect(r.applied).toContain('startBy');
    expect(r.proposalIds).toEqual([]);
  });
});

describe('ChatOps', () => {
  it('patchItem: user-locked fields become proposals; unlocked ones land without locking', async () => {
    const ops = opsOf(ds);
    const target = ops.topItems(5)[1];
    const locked = await ds.patchItem({ params: { id: target.id }, body: { ifVersion: target.version, patch: { startBy: '2030-01-02T10:00:00.000Z' } } });
    expect(locked.entity.userLockedFields).toContain('startBy');

    const r = ops.patchItem(target.id, { startBy: '2030-01-02T15:00:00.000Z', effort: { youMin: 20, agentMin: 0 } }, 'Asked in chat');
    expect(r.receipt?.changes.map((c) => c.field)).toEqual(['effort']);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ actor: 'chat', status: 'pending', changes: [{ field: 'startBy', before: '2030-01-02T10:00:00.000Z', after: '2030-01-02T15:00:00.000Z' }] });
    const now = await item(target.id);
    expect(now.startBy).toBe('2030-01-02T10:00:00.000Z'); // the user's value stays
    expect(now.effort.youMin).toBe(20);
    expect(now.userLockedFields).not.toContain('effort');
    expect(auditOf(r.receipt!.changes[0].auditId).actor).toBe('chat');

    // Apply → it lands (user-applied), Keep mine is the other path.
    await ds.applyProposal({ params: { id: r.proposals[0].id }, body: {} });
    expect((await item(target.id)).startBy).toBe('2030-01-02T15:00:00.000Z');
  });

  it('patchItem rejects an invalid patch and changes nothing', async () => {
    const ops = opsOf(ds);
    const target = ops.topItems(1)[0];
    expect(() => ops.patchItem(target.id, { startBy: 'not a date' } as never, 'x')).toThrow(/Invalid patch/);
    expect((await item(target.id)).version).toBe(target.version);
  });

  it('resolveItem closes as chat (doneBy chat) and undoes', async () => {
    const ops = opsOf(ds);
    const target = ops.topItems(3)[2];
    const r = ops.resolveItem(target.id, 'handed_off', { personName: 'Kim Lee' }, 'asked in chat');
    expect(r.proposals).toEqual([]);
    expect(r.item).toMatchObject({ state: 'done', doneBy: 'chat', resolution: 'handed_off', involvement: 'watcher' });
    expect(r.item.userLockedFields).toEqual(target.userLockedFields);
    const line = r.receipt!.changes.find((c) => c.field === 'state')!;
    expect(auditOf(line.auditId)).toMatchObject({ actor: 'chat', action: 'chat.resolve' });
    await ds.undoAudit({ params: { id: line.auditId }, body: {} });
    expect((await item(target.id)).state).toBe(target.state);
    expect(() => ops.resolveItem(target.id, 'handed_off')).toThrow(/handed_off needs/);
  });

  it('capture: actor chat, nothing locked, undo removes it', async () => {
    const ops = opsOf(ds);
    const { item: w, receipt } = ops.capture('Send Dana the SSO doc ~10m');
    expect(w.userLockedFields).toEqual([]);
    expect(w.effort.youMin).toBe(10);
    expect(Receipt.parse(receipt).actor).toBe('chat');
    expect(auditOf(receipt.changes[0].auditId)).toMatchObject({ actor: 'chat', action: 'chat.capture' });
    await ds.undoAudit({ params: { id: receipt.changes[0].auditId }, body: {} });
    await expect(ds.getItem({ params: { id: w.id } })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('scan: starts a run attributed to chat; a connector needing re-auth reports ok=false', async () => {
    const ops = opsOf(ds);
    const ok = ops.scan('slack', 'chat:2d');
    expect(ok.ok).toBe(true);
    expect(ok.run?.scope).toBe('chat:2d');
    expect(ds.audit.entries.find((e) => e.action === 'chat.scan')?.actor).toBe('chat');
    const broken = ops.scan('vdp', 'chat:1d');
    expect(broken.ok).toBe(false);
    expect(ops.scan('nope', 'x')).toMatchObject({ ok: false, run: null });
  });

  it('policyPreview changes nothing; policyApply is a chat-attributed, undoable new version', async () => {
    const ops = opsOf(ds);
    const before = (await ds.getSettings({} as never)).policy;
    const preview = PolicyPreview.parse(ops.policyPreview({ customer_facing: 2 }));
    expect(preview.basedOnVersion).toBe(before.version);
    expect((await ds.getSettings({} as never)).policy.version).toBe(before.version);

    const { receipt } = ops.policyApply({ customer_facing: 2 }, 'Customer work matters more (chat)');
    const after = (await ds.getSettings({} as never)).policy;
    expect(after.version).toBe(before.version + 1);
    expect(after.weights.customer_facing).toBe(Math.min(10, before.weights.customer_facing + 2));
    expect(receipt.actor).toBe('chat');
    const entry = auditOf(receipt.changes[0].auditId);
    expect(entry.actor).toBe('chat');
    expect((await ds.getPolicyVersions({} as never)).versions[0].by).toBe('chat');
    await ds.undoAudit({ params: { id: entry.id }, body: {} });
    expect((await ds.getSettings({} as never)).policy.weights.customer_facing).toBe(before.weights.customer_facing);
  });

  it('reads: settings, calendarToday, listItems are contract shapes from the same store', async () => {
    const ops = opsOf(ds);
    expect(Settings.safeParse(ops.settings()).success).toBe(true);
    const events = ops.calendarToday();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(CalendarEvent.safeParse(e).success).toBe(true);
    expect(events.map((e) => e.start)).toEqual([...events.map((e) => e.start)].sort());
    const promises = ops.listItems({ tab: 'promises' });
    expect(promises.some((p) => p.id === 'w_promise_beacon')).toBe(true);
    for (const p of promises) expect(WorkItem.safeParse(p).success).toBe(true);
  });

  it('no chat-made audit entry is ever attributed to the user', async () => {
    for (const t of ['move Globex prep after lunch and find the deck I made for them', '/rescan slack 2d', '/capture Call Priya back', 'do the Initech prep first', 'good morning']) await ask(ds, t);
    const chatActions = ds.audit.entries.filter((e) => e.action.startsWith('chat.'));
    expect(chatActions.length).toBeGreaterThan(4);
    expect(chatActions.every((e) => e.actor === 'chat')).toBe(true);
    // and none of them added a lock
    const locks = new Map(ds.store.all('workItems').map((w) => [w.id, w.userLockedFields]));
    const seeded = new Map(newDsLocks());
    for (const [id, l] of locks) if (seeded.has(id)) expect(l, id).toEqual(seeded.get(id));
  });
});

function newDsLocks(): Array<[string, string[]]> {
  const fresh = newDs();
  const out = fresh.store.all('workItems').map((w): [string, string[]] => [w.id, w.userLockedFields]);
  fresh.dispose();
  return out;
}
