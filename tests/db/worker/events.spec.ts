import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LiveEvent } from '@/contract';
import { LiveEvent as LiveEventSchema } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import { installChangeSetPublisher, liveEventsResponse, PgEventBus, TABLE_TOPICS } from '@/server/events';

/** A work item's topics: the one table → topic map's (2026-11-13 audit C1), the same the web's bus publishes. */
const ITEM_TOPICS = [...TABLE_TOPICS.work_items!.topics].sort();

import { createUser, openTestDb, TEST_URL, waitFor } from './helpers';

const h = openTestDb(3);
const db = h.db;
let userId: string;
// "web" listens and serves SSE; "worker" publishes. Two buses = two processes as far as NOTIFY is concerned.
const web = new PgEventBus({ url: TEST_URL, log: () => {} });
const worker = new PgEventBus({ url: TEST_URL, log: () => {} });

beforeAll(async () => {
  userId = await createUser(db, 'events');
  await Promise.all([web.start(), worker.start()]);
});
afterAll(async () => {
  await Promise.all([web.stop(), worker.stop()]);
  await h.close();
});

function collect(bus: PgEventBus) {
  const got: LiveEvent[] = [];
  const off = bus.subscribe((e) => got.push(e));
  return { got, off };
}

async function newItem(title: string) {
  const { result } = await withChangeSet({ db, userId, actor: actors.user(), reason: 'capture' }, (tx) =>
    tx.execute<{ id: string }>(sql`insert into work_items (owner_user_id, kind, origin, status, title) values (${userId}, 'task', 'manual', 'open', ${title}) returning id`),
  );
  return result.rows[0]!.id;
}

describe('PgEventBus (LISTEN/NOTIFY)', () => {
  it('delivers a published event to another process, small and contract-valid, without echoing to the publisher', async () => {
    const w = collect(web);
    const k = collect(worker);
    const ids = Array.from({ length: 80 }, (_, i) => `id-${i}`);
    const ev = worker.publish({ topic: 'health', ids, reason: 'connector.updated' });
    expect(ev.ids).toHaveLength(50);
    const got = await waitFor(() => w.got.find((e) => e.reason === 'connector.updated'));
    expect(LiveEventSchema.safeParse(got).success).toBe(true);
    expect(got).toMatchObject({ topic: 'health', reason: 'connector.updated' });
    expect(got.ids).toHaveLength(50);
    await new Promise((r) => setTimeout(r, 150));
    expect(k.got.filter((e) => e.reason === 'connector.updated')).toHaveLength(1); // local delivery only
    w.off();
    k.off();
  });

  it('publishes on every change-set commit (commit hook) with one event per topic, deduped against cc_change', async () => {
    const uninstall = installChangeSetPublisher({ bus: worker, db });
    const w = collect(web);
    try {
      const id = await newItem('Hook-published item');
      await waitFor(() => w.got.some((e) => e.topic === 'audit'));
      await new Promise((r) => setTimeout(r, 400)); // past the cc_change debounce: no duplicates may follow
      const forItem = w.got.filter((e) => e.ids.includes(id));
      expect(forItem.map((e) => e.topic).sort()).toEqual(ITEM_TOPICS);
      expect(new Set(forItem.map((e) => e.reason))).toEqual(new Set(['item.created']));
      expect(forItem.every((e) => e.entityType === 'work_item')).toBe(true);
    } finally {
      uninstall();
      w.off();
    }
  });

  it('falls back to the audit trigger notifications when the writer did not publish', async () => {
    const w = collect(web);
    try {
      const id = await newItem('Fallback item');
      const got = await waitFor(() => w.got.filter((e) => e.ids.includes(id)).length >= 4 && w.got.filter((e) => e.ids.includes(id)));
      expect(got.map((e) => e.topic).sort()).toEqual(ITEM_TOPICS);
    } finally {
      w.off();
    }
  });
});

describe('SSE adapter', () => {
  async function readFrames(res: Response, n: number, timeoutMs = 4000) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const frames: Array<{ event: string; id?: string; data: unknown }> = [];
    const t0 = Date.now();
    while (frames.length < n && Date.now() - t0 < timeoutMs) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), timeoutMs)),
      ]);
      if (done && !value) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (raw.startsWith(':')) continue;
        const f: { event: string; id?: string; data: unknown } = { event: 'message', data: null };
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) f.event = line.slice(7);
          else if (line.startsWith('id: ')) f.id = line.slice(4);
          else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6));
        }
        frames.push(f);
      }
    }
    reader.releaseLock();
    return frames;
  }

  it('streams NOTIFY-delivered events as SSE frames (hello first, id = seq)', async () => {
    const ac = new AbortController();
    const res = liveEventsResponse(new Request('http://localhost/api/v1/events', { signal: ac.signal }), { bus: web });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const framesP = readFrames(res, 2);
    await new Promise((r) => setTimeout(r, 50));
    worker.publish({ topic: 'scans', ids: ['run-1'], reason: 'scan.finished' });
    const frames = await framesP;
    ac.abort();
    expect(frames[0]!.event).toBe('hello');
    expect(frames[0]!.data).toMatchObject({ dataSource: 'db' });
    expect(frames[1]).toMatchObject({ event: 'live', data: { topic: 'scans', ids: ['run-1'], reason: 'scan.finished' } });
    expect(Number(frames[1]!.id)).toBe((frames[1]!.data as LiveEvent).seq);
  });

  it('replays buffered events after Last-Event-ID on reconnect', async () => {
    const before = web.recent.at(-1)?.seq ?? 0;
    worker.publish({ topic: 'jobs', ids: ['j-1'], reason: 'job.updated' });
    await waitFor(() => web.recent.some((e) => e.reason === 'job.updated' && e.seq > before));
    const ac = new AbortController();
    const res = liveEventsResponse(new Request('http://localhost/api/v1/events', { signal: ac.signal, headers: { 'last-event-id': String(before) } }), { bus: web });
    const frames = await readFrames(res, 2);
    ac.abort();
    expect(frames[1]).toMatchObject({ event: 'live', data: { topic: 'jobs', reason: 'job.updated' } });
  });
});
