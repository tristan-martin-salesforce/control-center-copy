/**
 * EventBus over Postgres LISTEN/NOTIFY (R-UI-20 live updates; ports.ts `EventBus`).
 *
 * Channels:
 * - `cc_live`  : small LiveEvent payloads `{o, t, i, r, a, e?, cs?}` published by any process (worker or web). Large
 *                things are referenced by id; ids are capped at 50 so a payload stays far below NOTIFY's 8000 bytes.
 * - `cc_change`: the audit trigger's per-row notification `{cs, entity_type, entity_id, table, op}`, delivered at
 *                COMMIT. It is the fallback for writers that did not publish: rows are buffered per change set for
 *                `changeDebounceMs` and turned into topic events unless a `cc_live` message for the same change set
 *                arrived (dedupe by change set id).
 *
 * Every process keeps its own monotonic `seq` (the SSE `id:`) and a short replay buffer for reconnects. A message a
 * process published itself is delivered locally at publish time and ignored when it comes back over LISTEN.
 */
import { randomUUID } from 'node:crypto';

import { Client, type Pool } from 'pg';

import type { LiveEvent, LiveTopic } from '@/contract';
import { resolveDatabaseUrl } from '@/db/client';
import type { Clock, EventBus, LiveEventInput } from '@/server/ports';

import { eventsForChanges, MAX_IDS, type ChangeRow, type TopicEvent } from './topics';

export const LIVE_CHANNEL = 'cc_live';
export const CHANGE_CHANNEL = 'cc_change';

interface WireEvent {
  /** origin process id */
  o: string;
  t: LiveTopic;
  i: string[];
  r: string;
  a: string;
  e?: LiveEvent['entityType'];
  cs?: string;
}

export interface PgEventBusOptions {
  /** Connection string for the dedicated LISTEN client (default DATABASE_URL). */
  url?: string;
  /** Pool used for NOTIFY. Default: a 1-connection pool of its own is not created; NOTIFY uses the LISTEN client. */
  pool?: Pool;
  clock?: Clock;
  replaySize?: number;
  changeDebounceMs?: number;
  /** Also turn `cc_change` rows into events (default true). */
  listenChanges?: boolean;
  log?: (msg: string) => void;
}

type Listener = (e: LiveEvent) => void;

export class PgEventBus implements EventBus {
  readonly originId = randomUUID();
  private seq = 0;
  private readonly listeners = new Set<Listener>();
  readonly recent: LiveEvent[] = [];
  private client: Client | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private everConnected = false;
  private reconnectMs = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** change set ids already published over cc_live (or expected to be). */
  private readonly published = new Map<string, number>();
  private readonly pending = new Map<string, { rows: ChangeRow[]; timer: NodeJS.Timeout }>();
  private readonly o: Required<Pick<PgEventBusOptions, 'replaySize' | 'changeDebounceMs' | 'listenChanges'>> & PgEventBusOptions;

  constructor(opts: PgEventBusOptions = {}) {
    this.o = { replaySize: 200, changeDebounceMs: 150, listenChanges: true, ...opts };
  }

  private now(): Date {
    return this.o.clock?.now() ?? new Date();
  }
  private log(msg: string) {
    (this.o.log ?? ((m: string) => console.log(`[events] ${m}`)))(msg);
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** Connects the LISTEN client. Idempotent; reconnects on its own after errors. */
  start(): Promise<void> {
    this.stopped = false;
    if (this.client) return Promise.resolve();
    return (this.starting ??= this.connect().finally(() => {
      this.starting = null;
    }));
  }

  private async connect(): Promise<void> {
    const c = new Client({ connectionString: resolveDatabaseUrl(this.o.url), application_name: 'command-center-events', options: '-c TimeZone=UTC' });
    c.on('notification', (m) => this.onNotification(m.channel, m.payload));
    const drop = () => {
      if (this.client !== c) return;
      this.client = null;
      void c.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    c.on('error', (err) => {
      this.log(`listen client error: ${(err as { code?: string }).code ?? err.name}`);
      drop();
    });
    c.on('end', drop);
    await c.connect();
    await c.query(`LISTEN ${LIVE_CHANNEL}`);
    if (this.o.listenChanges) await c.query(`LISTEN ${CHANGE_CHANNEL}`);
    if (this.stopped) {
      await c.end().catch(() => undefined);
      return;
    }
    const wasReconnect = this.everConnected;
    this.everConnected = true;
    this.client = c;
    this.reconnectMs = 1000;
    // Anything published while we were away is lost: tell open views to refetch.
    if (wasReconnect) for (const t of ['today', 'items', 'health'] as const) this.deliver({ topic: t, ids: [], reason: 'live.reconnected' });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch(() => this.scheduleReconnect());
    }, wait);
    this.reconnectTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }

  // ------------------------------------------------------------------ EventBus

  publish(input: LiveEventInput): LiveEvent {
    return this.publishWire(input);
  }

  /** Publish a change set's events; the change set id dedupes the cc_change fallback in every process. */
  publishChangeSet(changeSetId: string, events: TopicEvent[]): LiveEvent[] {
    this.expectChangeSet(changeSetId);
    return events.map((e) => this.publishWire(e, changeSetId));
  }

  /** Mark a change set as "published here" before the events are computed (drops buffered cc_change rows). */
  expectChangeSet(changeSetId: string): void {
    this.markPublished(changeSetId);
    const p = this.pending.get(changeSetId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(changeSetId);
    }
  }

  private publishWire(input: LiveEventInput, cs?: string): LiveEvent {
    const ev = this.deliver({ ...input, ids: input.ids.filter(Boolean).slice(0, MAX_IDS) });
    const wire: WireEvent = { o: this.originId, t: ev.topic, i: ev.ids, r: ev.reason, a: ev.at, ...(ev.entityType ? { e: ev.entityType } : {}), ...(cs ? { cs } : {}) };
    let payload = JSON.stringify(wire);
    if (payload.length > 7900) payload = JSON.stringify({ ...wire, i: wire.i.slice(0, 5) });
    void this.notify(payload);
    return ev;
  }

  private notifyChain: Promise<void> = Promise.resolve();

  /** NOTIFYs are serialized: one pg Client must not run concurrent queries. */
  private notify(payload: string): Promise<void> {
    const run = async () => {
      try {
        if (this.o.pool) await this.o.pool.query('select pg_notify($1, $2)', [LIVE_CHANNEL, payload]);
        else {
          if (!this.client) await this.start();
          await this.client?.query('select pg_notify($1, $2)', [LIVE_CHANNEL, payload]);
        }
      } catch (e) {
        this.log(`notify failed: ${(e as { code?: string }).code ?? (e as Error).name}`);
      }
    };
    this.notifyChain = this.notifyChain.then(run, run);
    return this.notifyChain;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private deliver(input: LiveEventInput): LiveEvent {
    const event: LiveEvent = { ...input, seq: ++this.seq, at: input.at ?? this.now().toISOString() };
    this.recent.push(event);
    if (this.recent.length > this.o.replaySize) this.recent.shift();
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* one bad listener must not starve the others */
      }
    }
    return event;
  }

  // ------------------------------------------------------------------ LISTEN

  private markPublished(cs: string) {
    const t = Date.now();
    this.published.set(cs, t);
    if (this.published.size > 2000) {
      for (const [k, at] of this.published) if (t - at > 60_000 || this.published.size > 1500) this.published.delete(k);
    }
  }

  private onNotification(channel: string, payload: string | undefined) {
    if (!payload) return;
    let msg: unknown;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (channel === LIVE_CHANNEL) {
      const w = msg as WireEvent;
      if (!w || typeof w.t !== 'string' || !Array.isArray(w.i)) return;
      if (w.cs) this.expectChangeSet(w.cs);
      if (w.o === this.originId) return; // delivered locally at publish time
      this.deliver({ topic: w.t, ids: w.i.filter((x) => typeof x === 'string' && x.length > 0).slice(0, MAX_IDS), reason: String(w.r ?? 'changed'), at: w.a, ...(w.e ? { entityType: w.e } : {}) });
      return;
    }
    if (channel === CHANGE_CHANNEL) {
      const c = msg as { cs?: string; entity_type?: string; entity_id?: string; table?: string; op?: ChangeRow['op'] };
      if (!c?.cs || !c.entity_type) return;
      if (this.published.has(c.cs)) return;
      const cur = this.pending.get(c.cs);
      const row: ChangeRow = { entityType: c.entity_type, entityId: c.entity_id ?? '', op: c.op ?? 'update', ...(c.table ? { table: c.table } : {}) };
      if (cur) {
        if (cur.rows.length < 500) cur.rows.push(row);
        return;
      }
      const timer = setTimeout(() => this.flushChange(c.cs!), this.o.changeDebounceMs);
      timer.unref?.();
      this.pending.set(c.cs, { rows: [row], timer });
    }
  }

  private flushChange(cs: string) {
    const p = this.pending.get(cs);
    this.pending.delete(cs);
    if (!p || this.published.has(cs)) return;
    this.markPublished(cs);
    // Every process receives cc_change itself, so these are delivered locally only (no re-NOTIFY).
    for (const e of eventsForChanges(p.rows)) this.deliver(e);
  }

  // ------------------------------------------------------------------ streaming

  /**
   * Async iterator over events until the signal aborts. `afterSeq` replays buffered events newer than it (SSE
   * Last-Event-ID), so a quick reconnect loses nothing this process saw.
   */
  iterate(signal: AbortSignal, opts: { afterSeq?: number } = {}): AsyncIterable<LiveEvent> {
    const queue: LiveEvent[] = opts.afterSeq !== undefined ? this.recent.filter((e) => e.seq > opts.afterSeq!) : [];
    let wake: (() => void) | null = null;
    const unsubscribe = this.subscribe((e) => {
      queue.push(e);
      if (queue.length > 1000) queue.splice(0, queue.length - 1000);
      wake?.();
    });
    const done = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    void this.start().catch(() => this.scheduleReconnect());
    return {
      [Symbol.asyncIterator]: async function* () {
        try {
          while (!signal.aborted) {
            if (!queue.length) {
              await Promise.race([new Promise<void>((r) => (wake = r)), done]);
              wake = null;
              continue;
            }
            yield queue.shift()!;
          }
        } finally {
          unsubscribe();
        }
      },
    };
  }
}
