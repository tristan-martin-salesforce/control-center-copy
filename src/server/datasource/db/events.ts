/**
 * Live invalidation for the db DataSource: an EventBus (src/server/ports.ts) fed by Postgres.
 *
 * The cc_audit trigger NOTIFYs `cc_change` {cs, entity_type, entity_id, table, op} for every audited
 * write, delivered at COMMIT — so any writer (this process, the worker, a scanner) invalidates open views.
 * Notifications are batched per change set for 40 ms and fanned out as one LiveEvent per topic.
 * Writes to unaudited tables (jobs, scan runs, briefs read markers, priority scores) are published by the
 * DataSource after commit through `publish()`.
 *
 * Swappable: BE-1a's worker will export the shared SSE adapter (src/server/events/**); until then this
 * module owns its own LISTEN client. The table → topic map is the shared one (src/server/events/topics.ts
 * TABLE_TOPICS, 2026-11-13 audit C1): never a second copy here.
 *
 * It also LISTENs `cc_live` (2026-11-14 live pass): what the worker publishes itself (its catch-up progress, change
 * sets with no audited rows, the read-in's notices). A `cc_live` event for a change set whose `cc_change` rows this
 * process already turned into events is dropped (the same change, twice). Unaudited tables the UI follows (jobs,
 * scan runs, tool runs, app events, worker instances) notify `cc_change` from their own trigger (0026_live_notify)
 * under a `tx:<txid>` change set; those batches skip the `audit` topic (they are not on the ⌘Z stack).
 */
import { Client } from 'pg';

import { LiveTopic as LiveTopicEnum, type LiveEvent, type LiveTopic } from '@/contract';
import { topicsFor } from '@/server/events/topics';
import type { Clock, EventBus, LiveEventInput } from '@/server/ports';

interface Notice {
  cs: string;
  entity_type: string;
  entity_id: string;
  table: string;
  op: string;
}

/** A `cc_live` message (src/server/events/pg-bus.ts WireEvent). */
interface WireEvent {
  o?: string;
  t?: string;
  i?: unknown;
  r?: unknown;
  a?: unknown;
  e?: unknown;
  cs?: string;
}

/** Health's rule (getHealth `worker.alive`): a beat within this long. */
const WORKER_ALIVE_MS = 120_000;
const WORKER_CHECK_MS = 30_000;

const isTopic = (t: unknown): t is LiveTopic => typeof t === 'string' && (LiveTopicEnum.options as readonly string[]).includes(t);

export class PgEventBus implements EventBus {
  private seq = 0;
  private listeners = new Set<(e: LiveEvent) => void>();
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, Notice[]>();
  /** Change sets whose cc_change rows reached this process (a cc_live event for one of them is a duplicate). */
  private seenCs = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly recent: LiveEvent[] = [];

  constructor(
    private readonly url: string,
    private readonly clock: Clock,
  ) {}

  publish(input: LiveEventInput): LiveEvent {
    const event: LiveEvent = { ...input, seq: ++this.seq, at: input.at ?? this.clock.now().toISOString() };
    this.recent.push(event);
    if (this.recent.length > 200) this.recent.shift();
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        console.error('[db-bus] listener failed', (err as Error).message);
      }
    }
    return event;
  }

  /** Publish the topics a set of tables invalidates (unaudited writes). */
  publishTables(tables: string[], ids: string[], reason: string) {
    const topics = new Set<LiveTopic>();
    for (const t of tables) for (const topic of topicsFor(t)) topics.add(topic);
    for (const topic of topics) this.publish({ topic, ids, reason });
  }

  subscribe(listener: (e: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    void this.ensureListening();
    this.watchWorker();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) void this.stop();
    };
  }

  // ── the worker's heartbeat ───────────────────────────────────────────────────────────────
  // A worker that stopped beating can't announce it. While a view is open, one cheap read every 30 s on the LISTEN
  // connection notices the flip (alive ⇄ gone, Health's 120 s rule) and publishes `health`: the views are pushed the
  // change instead of polling Health.
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private workerAlive: boolean | undefined;

  private watchWorker() {
    if (this.workerTimer) return;
    this.workerTimer = setInterval(() => void this.checkWorker(), WORKER_CHECK_MS);
    (this.workerTimer as { unref?: () => void }).unref?.();
  }

  private async checkWorker(): Promise<void> {
    const c = this.client;
    if (!c || !this.listeners.size) return;
    try {
      const r = await c.query<{ at: Date | null }>('select max(last_beat_at) as at from worker_instances where stopped_at is null');
      const at = r.rows[0]?.at;
      this.noteWorker(!!at && this.clock.now().getTime() - new Date(at).getTime() < WORKER_ALIVE_MS);
    } catch {
      /* the LISTEN client is reconnecting */
    }
  }

  /** Publish `health` when the worker's liveness flips (not on the first reading). Exported for tests. */
  noteWorker(alive: boolean): void {
    const was = this.workerAlive;
    this.workerAlive = alive;
    if (was !== undefined && was !== alive) this.publish({ topic: 'health', ids: [], reason: alive ? 'worker.up' : 'worker.down' });
  }

  private everListened = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  /** The LISTEN client dropped (Postgres restarted, the Mac slept): reconnect while anyone is listening. */
  private dropped(c: Client) {
    if (this.client !== c && this.client !== null) return;
    this.client = null;
    void c.end().catch(() => {});
    if (!this.listeners.size || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.listeners.size) void this.ensureListening();
    }, 2000);
    (this.retry as { unref?: () => void }).unref?.();
  }

  private async ensureListening(): Promise<void> {
    if (this.client || this.connecting) return this.connecting ?? undefined;
    this.connecting = (async () => {
      const c = new Client({ connectionString: this.url, application_name: 'command-center-sse', options: '-c TimeZone=UTC' });
      c.on('error', (err) => {
        console.error(`[db-bus] listen client error: ${err.message}`);
        this.dropped(c);
      });
      c.on('end', () => this.dropped(c));
      c.on('notification', (n) => {
        if (!n.payload) return;
        try {
          if (n.channel === 'cc_change') this.enqueue(JSON.parse(n.payload) as Notice);
          else if (n.channel === 'cc_live') this.onLive(JSON.parse(n.payload) as WireEvent);
        } catch {
          /* malformed payload: ignore */
        }
      });
      await c.connect();
      await c.query('LISTEN cc_change');
      await c.query('LISTEN cc_live');
      this.client = c;
      // Back after a drop: whatever changed meanwhile was never announced, so every open view refetches once.
      if (this.everListened) for (const topic of LiveTopicEnum.options) this.publish({ topic, ids: [], reason: 'live.reconnected' });
      this.everListened = true;
    })()
      .catch((err: Error) => {
        console.error(`[db-bus] cannot LISTEN: ${err.message}`);
        if (this.listeners.size && !this.retry) {
          this.retry = setTimeout(() => {
            this.retry = null;
            if (this.listeners.size) void this.ensureListening();
          }, 5000);
          (this.retry as { unref?: () => void }).unref?.();
        }
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  /** Another process's event (the worker's publisher, the read-in). Exported for tests through `receive`. */
  private onLive(w: WireEvent) {
    if (!w || !isTopic(w.t) || !Array.isArray(w.i)) return;
    if (w.cs && (this.seenCs.has(w.cs) || this.pending.has(w.cs))) return; // its cc_change rows already published it
    const ids = (w.i as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 50);
    this.publish({ topic: w.t, ids, reason: typeof w.r === 'string' ? w.r : 'changed', ...(typeof w.a === 'string' ? { at: w.a } : {}), ...(typeof w.e === 'string' ? { entityType: w.e as LiveEvent['entityType'] } : {}) });
  }

  /** Tests: feed a notification as if it came over LISTEN. */
  receive(channel: 'cc_change' | 'cc_live', payload: string): void {
    if (channel === 'cc_change') this.enqueue(JSON.parse(payload) as Notice);
    else this.onLive(JSON.parse(payload) as WireEvent);
  }

  private enqueue(n: Notice) {
    this.seenCs.set(n.cs, Date.now());
    if (this.seenCs.size > 2000) {
      const cut = Date.now() - 60_000;
      for (const [k, at] of this.seenCs) if (at < cut) this.seenCs.delete(k);
    }
    if (!this.pending.has(n.cs)) this.pending.set(n.cs, []);
    this.pending.get(n.cs)!.push(n);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 40);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private flush() {
    this.timer = null;
    const batches = [...this.pending.values()];
    this.pending.clear();
    for (const batch of batches) {
      const byTopic = new Map<LiveTopic, Set<string>>();
      for (const n of batch) {
        for (const topic of topicsFor(n.table, n.entity_type)) {
          if (!byTopic.has(topic)) byTopic.set(topic, new Set());
          if (n.entity_id) byTopic.get(topic)!.add(n.entity_id); // a statement-level notice carries no id
        }
      }
      // a `tx:` batch is an unaudited table's trigger (0026_live_notify): not on the ⌘Z stack
      if (!batch[0]!.cs.startsWith('tx:')) byTopic.set('audit', new Set(batch.map((n) => n.entity_id)));
      const reason = `db.${batch[0]!.table}.${batch[0]!.op}`;
      for (const [topic, ids] of byTopic) this.publish({ topic, ids: [...ids], reason });
    }
  }

  async stop(): Promise<void> {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.workerTimer = null;
    this.workerAlive = undefined;
    const c = this.client;
    this.client = null;
    if (c) await c.end().catch(() => {});
  }

  /** Async iterator over future events until the signal aborts. */
  iterate(signal: AbortSignal): AsyncIterable<LiveEvent> {
    const queue: LiveEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = this.subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    const done = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return {
      [Symbol.asyncIterator]: async function* () {
        try {
          while (!signal.aborted) {
            if (queue.length === 0) {
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
