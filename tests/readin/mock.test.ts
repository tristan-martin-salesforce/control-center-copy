/**
 * Mock DataSource read-ins (example seed, placeholders): demo read-ins are deterministic and only on when asked
 * for; "Read me in" plays queued → researching → ready, dedupes, and links an Outbox draft that is never sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReadInPayload, routes } from '../../src/contract';
import { createMockDataSource, type MockDataSource } from '../../src/server/datasource/mock';
import { demoItems } from '../../src/server/datasource/mock/readin';

const fast = { enrichMs: 1e8, stepMs: 20, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };
let ds: MockDataSource | null = null;
afterEach(() => {
  ds?.dispose();
  ds = null;
  vi.useRealTimers();
});
/** The read-in's steps are timers (stepMs 20 → a 20 ms step, ready after 7): step a fake clock, never the wall clock. */
const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('mock read-ins', () => {
  it('demo read-ins: one per Slack destination shape, sourced from the seed, deterministic', async () => {
    ds = createMockDataSource({ autoplay: false, delays: fast, readinDemo: true });
    const items = demoItems(ds.store);
    expect(items.length).toBeGreaterThanOrEqual(2);
    const p = await ds.getReadIn({ params: { type: 'work_item', id: items[0]!.id } });
    routes.getReadIn.response.parse(p);
    expect(p.readIn?.state).toMatch(/ready|stale/);
    expect(p.readIn!.tldr.length).toBeGreaterThan(5);
    expect(p.readIn!.costUsd).toBeGreaterThan(0);
    expect(p.readIn!.suggestedReply?.draftId).toBeTruthy();
    const again = createMockDataSource({ autoplay: false, delays: fast, readinDemo: true });
    const q = await again.getReadIn({ params: { type: 'work_item', id: items[0]!.id } });
    again.dispose();
    expect(q.readIn?.tldr).toBe(p.readIn?.tldr);
    // readInState rides on the list and detail payloads
    const list = await ds.listItems({ query: { tab: 'all_open' } } as never);
    expect(list.items.find((w) => w.id === items[0]!.id)?.readInState).toBe(p.readIn!.state);
    const detail = await ds.getItem({ params: { id: items[0]!.id } });
    expect(detail.item.readInState).toBe(p.readIn!.state);
  });

  it('without the demo flag there are no read-ins (tests, db:seed and parity stay clean)', async () => {
    ds = createMockDataSource({ autoplay: false, delays: fast });
    const id = ds.store.all('workItems')[0]!.id;
    expect((await ds.getReadIn({ params: { type: 'work_item', id } })).readIn).toBeNull();
    expect(ds.store.all('workItems').some((w) => w.readInState)).toBe(false);
  });

  it('Read me in: queued → researching → ready, deduped while running, the reply stays a draft', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ds = createMockDataSource({ autoplay: false, delays: fast });
    const id = demoItems(ds.store)[0]!.id;
    const seen: string[] = [];
    const unsub = ds.bus.subscribe((e) => e.topic === 'readin' && seen.push(e.reason));
    const first = await ds.requestReadIn({ params: { type: 'work_item', id }, body: { force: false } });
    routes.requestReadIn.response.parse(first);
    expect(first.entity.state).toBe('queued');
    expect(first.auditId).toBeNull();
    await elapse(25);
    const dup = await ds.requestReadIn({ params: { type: 'work_item', id }, body: { force: true } });
    expect(dup.entity.state).toBe('researching'); // the first of six 20 ms steps ran, the job is still going
    await elapse(114);
    expect((await ds.getReadIn({ params: { type: 'work_item', id } })).readIn?.state).not.toBe('ready'); // at 139 ms: ready comes at 140 ms (seven steps), not before
    await elapse(1);
    const done = await ds.getReadIn({ params: { type: 'work_item', id } });
    ReadInPayload.parse(done);
    expect(done.readIn?.state).toBe('ready');
    expect(seen[0]).toBe('readin.queued');
    expect(seen).toContain('readin.progress');
    expect(seen.at(-1)).toBe('readin.ready');
    expect(seen.filter((r) => r === 'readin.queued')).toHaveLength(1); // the duplicate request was absorbed
    const draft = ds.store.get('drafts', done.readIn!.suggestedReply!.draftId)!;
    expect(draft.status).not.toBe('sent');
    expect(draft.attempts).toHaveLength(0);
    // A ready read-in is not re-run unless forced
    expect((await ds.requestReadIn({ params: { type: 'work_item', id }, body: { force: false } })).entity.state).toBe('ready');
    unsub();
  });

  it('unknown entities are 404s', async () => {
    ds = createMockDataSource({ autoplay: false, delays: fast });
    await expect(ds.getReadIn({ params: { type: 'work_item', id: 'w_nope' } })).rejects.toMatchObject({ code: 'not_found' });
  });
});
