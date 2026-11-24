/**
 * Scans end to end through the worker: ScannerRuntime.planJobs → Postgres jobs → WorkerRuntime claim →
 * scanHandler → ScannerRuntime.executeJob → DbScannerStore. Fetchers are BE-2b's with fixture-backed fakes.
 */
import { cp, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeSessionsFetcher, MemorySessionStateStore } from '@/connectors/claude/sessions';
import { CalendarFetcher } from '@/connectors/google/calendar';
import { GeminiNotesFetcher } from '@/connectors/google/gemini-notes';
import { GmailFetcher } from '@/connectors/google/gmail';
import { TrainingsFetcher } from '@/connectors/google/trainings';
import { createDefaultRegistry } from '@/jobs';
import { FakeClock } from '@/scanner/runtime/clock';
import { DriveFetcher, MemoryDigestStore } from '@/scanner/drive-digest';
import { DbScannerStore } from '@/scanner/store-db';
import type { ConnectorId, CoverageObject, Cursor, DeterministicFetcher, FetchResult, SkillRunner, TimeWindow } from '@/scanner/types';
import { NullNotifier } from '@/worker/notify';
import { WorkerRuntime } from '@/worker/runtime';
import { alignToWindow, buildScanning } from '@/worker/scanning';

import { FakeGoogle, fx, ME } from '../../connectors/readers/helpers';
import { createUser, openTestDb, setUserSetting, uid } from './helpers';

const h = openTestDb(8);
const db = h.db;
afterAll(() => h.close());
beforeEach(async () => {
  await db.execute(sql`update jobs set status = 'cancelled', finished_at = now(), lease_expires_at = null where status in ('queued', 'running')`);
});

const H = 3600_000;

function harness(opts: { clock: FakeClock; fetchers: DeterministicFetcher[]; userId: string; llm?: boolean; runner?: SkillRunner; queues?: string[] }) {
  const store = new DbScannerStore({ db, userId: opts.userId, clock: () => opts.clock.now() });
  const notifier = new NullNotifier();
  const scanning = buildScanning({ db, userId: opts.userId, store, clock: opts.clock, fetchers: opts.fetchers, llm: opts.llm ?? false, runner: opts.runner, notifier });
  const registry = createDefaultRegistry({ scan: scanning.handlerDeps });
  const queues = opts.queues ?? opts.fetchers.map((f) => `scan.${f.connector}`);
  const worker = new WorkerRuntime({
    db,
    userId: opts.userId,
    workerId: `test:${uid()}`,
    registry,
    services: {},
    pools: queues.map((q) => ({ name: q, queues: [q], concurrency: 1 })),
    listenUrl: null,
    log: () => {},
  });
  /** Plan once, then claim and run until the queue is empty. */
  const plan = async () => scanning.queue.enqueue(await scanning.scanner.planJobs(opts.clock.now()));
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      const n = await worker.pollOnce();
      await worker.idle();
      if (!n) break;
    }
  };
  return { store, scanning, worker, plan, drain, notifier };
}

const count = async (userId: string, connector: string) =>
  Number(
    (
      await db.execute<{ n: string }>(sql`
        select count(*) as n from source_items si join connectors c on c.id = si.connector_id
         where si.owner_user_id = ${userId} and c.name = ${connector}`)
    ).rows[0]!.n,
  );

const runs = async (userId: string, connector: string) =>
  (
    await db.execute<{ status: string; scope: string; window_start: string; window_end: string; items_new: number }>(sql`
      select r.status, r.scope, r.window_start, r.window_end, r.items_new from scan_runs r join connectors c on c.id = r.connector_id
       where r.owner_user_id = ${userId} and c.name = ${connector} order by r.started_at, r.created_at`)
  ).rows;

/** A windowed fetcher (Gmail-like): covers exactly its window and puts the cursor at window.to. */
class WindowFetcher implements DeterministicFetcher {
  readonly connector: ConnectorId = 'gmail';
  calls: TimeWindow[] = [];
  async scopes() {
    return ['inbox'];
  }
  async health() {
    return { state: 'ok' as const, checkedAt: new Date().toISOString() };
  }
  async fetch(scope: string, _c: Cursor | null, window: TimeWindow): Promise<FetchResult> {
    this.calls.push(window);
    const coverage: CoverageObject[] = [{ kind: 'mailbox_range', ref: `gmail:${scope}`, from: window.from, to: window.to }];
    return { items: [], coverage, nextCursor: { value: JSON.stringify({ at: window.to }), at: window.to }, complete: true };
  }
}

describe('catch-up after a weekend away', () => {
  it('runs the newest hour first, then backfills oldest → newest; the cursor fast-forwards and the ledger has no holes', async () => {
    const userId = await createUser(db, 'catchup');
    const fri = Date.parse('2026-10-30T23:00:00Z');
    const mon = Date.parse('2026-11-02T15:00:00Z');
    const clock = new FakeClock(fri);
    const f = new WindowFetcher();
    // Friday evening: the worker was running and up to date.
    const fridayStore = new DbScannerStore({ db, userId, clock: () => clock.now() });
    const { runId } = await fridayStore.startRun({ scope: { connector: 'gmail', scope: 'inbox' }, trigger: 'schedule', window: { from: new Date(fri - H).toISOString(), to: new Date(fri).toISOString() } });
    await fridayStore.reportCoverage(runId, [{ kind: 'mailbox_range', ref: 'gmail:inbox', from: new Date(fri - H).toISOString(), to: new Date(fri).toISOString() }]);
    await fridayStore.finishRun(runId, { cursor: { value: '{}', at: new Date(fri).toISOString() }, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
    // Monday morning: the worker starts with a fresh runtime (first planJobs = resume plan).
    clock.set(mon);
    const hs = harness({ clock, fetchers: [f], userId });
    await hs.plan();
    const queued = await db.execute<{ mode: string; priority: number; from: string }>(sql`
      select payload->>'mode' as mode, priority, payload#>>'{window,from}' as "from" from jobs
       where owner_user_id = ${userId} and status = 'queued' and kind = 'scan.gmail' order by priority desc, run_at, id`);
    expect(queued.rows[0]!.mode).toBe('head');
    expect(queued.rows.slice(1).every((r) => r.mode === 'backfill')).toBe(true);
    expect(queued.rows.slice(1).map((r) => r.from)).toEqual(queued.rows.slice(1).map((r) => r.from).sort());
    await hs.drain();
    expect(f.calls[0]).toEqual({ from: new Date(mon - H).toISOString(), to: new Date(mon).toISOString() });
    const backfills = f.calls.slice(1);
    expect(backfills[0]!.from).toBe(new Date(fri).toISOString());
    expect(backfills.map((w) => w.from)).toEqual(backfills.map((w) => w.from).sort());
    expect(backfills.at(-1)!.to).toBe(new Date(mon - H).toISOString());
    expect((await hs.store.getCursor({ connector: 'gmail', scope: 'inbox' }))?.at).toBe(new Date(mon).toISOString());
    expect(await hs.store.coverageGaps({ connector: 'gmail', scope: 'inbox' }, { from: new Date(fri - H).toISOString(), to: new Date(mon).toISOString() })).toEqual([]);
    expect((await runs(userId, 'gmail')).every((r) => r.status === 'succeeded')).toBe(true);
  });
});

describe('window alignment (fetcher → store contract)', () => {
  it('turns ranges outside the window into points, clamps overlapping ones at the window end and a future cursor', () => {
    const w = { from: '2026-11-02T14:00:00.000Z', to: '2026-11-02T15:00:00.000Z' };
    const r = alignToWindow(
      {
        items: [],
        complete: true,
        nextCursor: { value: 'v', at: '2026-11-05T10:00:00.000Z' },
        coverage: [
          { kind: 'session', ref: 'reg', from: '2026-11-02T13:00:00.000Z', to: w.to },
          { kind: 'session', ref: 'old', from: '2026-10-20T00:00:00.000Z', to: '2026-10-21T00:00:00.000Z' },
          { kind: 'email', ref: 'm1', from: '2026-11-02T14:30:00.000Z', to: '2026-11-02T14:30:00.000Z' },
          { kind: 'calendar_range', ref: 'event:future', from: '2026-11-04T10:00:00.000Z', to: '2026-11-04T11:00:00.000Z' },
        ],
      },
      w,
    );
    expect(r.coverage).toEqual([
      { kind: 'session', ref: 'reg', from: '2026-11-02T13:00:00.000Z', to: w.to },
      { kind: 'session', ref: 'old', from: '2026-10-21T00:00:00.000Z', to: '2026-10-21T00:00:00.000Z' },
      { kind: 'email', ref: 'm1', from: '2026-11-02T14:30:00.000Z', to: '2026-11-02T14:30:00.000Z' },
      { kind: 'calendar_range', ref: 'event:future', from: '2026-11-04T10:00:00.000Z', to: '2026-11-04T10:00:00.000Z' },
    ]);
    expect(r.nextCursor).toEqual({ value: 'v', at: w.to });
  });
});

describe('budget awareness', () => {
  it('at the hard cap, traversal scans pause while deterministic scans keep running', async () => {
    const userId = await createUser(db, 'budget');
    await setUserSetting(db, userId, 'budgets', { softUsd: 0.5, hardUsd: 1 });
    const clock = new FakeClock(Date.now());
    const runner: SkillRunner = { run: async () => ({ ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }) };
    const f = new WindowFetcher();
    const hs = harness({ clock, fetchers: [f], userId, llm: true, runner });
    await hs.store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 2, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    const planned = await hs.scanning.scanner.planJobs(clock.now());
    expect(planned.some((j) => j.kind === 'scan' && j.connector === 'gmail')).toBe(true);
    expect(planned.some((j) => j.kind === 'scan' && (j.connector === 'slack' || j.connector === 'org62'))).toBe(false);
    expect(hs.scanning.scanner.status().filter((s) => s.connector === 'slack').every((s) => s.paused === 'budget')).toBe(true);
    const health = await db.execute<{ status: string }>(sql`select status from connectors where owner_user_id = ${userId} and name = 'slack'`);
    expect(health.rows[0]!.status).toBe('degraded');
  });
});

describe('deterministic scan handlers against recorded fixtures', () => {
  const NOW = new Date('2026-03-10T18:00:00.000Z');

  it('gmail: items, coverage and cursor are written; a second pass adds nothing', async () => {
    const userId = await createUser(db, 'gmail');
    const g = new FakeGoogle({
      search_gmail_messages: (a) => {
        const q = String(a.query);
        if (q.includes('has:attachment')) return fx('gmail', 'search_attachments.txt');
        return q.startsWith('in:sent') ? fx('gmail', 'search_sent.txt') : fx('gmail', 'search_inbox.txt');
      },
      get_gmail_messages_content_batch: (a) => ((a.message_ids as string[]).includes('18f0000000000004') ? fx('gmail', 'batch_sent.txt') : fx('gmail', 'batch_inbox.txt')),
      get_gmail_threads_content_batch: () => fx('gmail', 'threads_inbox.txt'),
    });
    const clock = new FakeClock(NOW);
    const hs = harness({ clock, fetchers: [new GmailFetcher({ google: g, me: ME, clock: () => clock.now() })], userId });
    await hs.plan();
    await hs.drain();
    const n1 = await count(userId, 'gmail');
    expect(n1).toBeGreaterThanOrEqual(4);
    for (const scope of ['inbox', 'sent']) {
      expect((await hs.store.getCursor({ connector: 'gmail', scope }))?.at).toBe(NOW.toISOString());
      expect(await hs.store.coverageGaps({ connector: 'gmail', scope }, { from: new Date(NOW.getTime() - 24 * H).toISOString(), to: NOW.toISOString() })).toEqual([]);
    }
    const body = await db.execute<{ body: string | null; meta: Record<string, unknown> }>(sql`
      select body, meta from source_items where owner_user_id = ${userId} and dedupe_key = 'gmail:18f0000000000001'`);
    expect(body.rows[0]!.body).toContain('Can you send the updated deck');
    expect(JSON.stringify(body.rows[0]!.meta)).not.toContain('Can you send the updated deck');
    // linking deferred (no LLM): new items are flagged for reconcile
    const deferred = await hs.store.unlinkedSourceItems({ connector: 'gmail', limit: 100 });
    expect(deferred.length).toBe(n1);
    expect(deferred.every((d) => d.reason.startsWith('deferred:') && d.attempts === 0)).toBe(true);
    // second pass from the cursor: nothing new
    clock.advance(5 * 60_000);
    const again = harness({ clock, fetchers: [new GmailFetcher({ google: g, me: ME, clock: () => clock.now() })], userId });
    await again.plan();
    await again.drain();
    expect(await count(userId, 'gmail')).toBe(n1);
    const r = await runs(userId, 'gmail');
    expect(r.every((x) => x.status === 'succeeded')).toBe(true);
    expect(r.slice(-2).every((x) => x.items_new === 0)).toBe(true);
  });

  it('calendar, trainings and gemini notes', async () => {
    const userId = await createUser(db, 'cal');
    const events = fx('calendar', 'events.txt');
    const g = new FakeGoogle({
      get_events: () => events,
      search_gmail_messages: () => fx('trainings', 'search_trainings.txt'),
      get_gmail_messages_content_batch: () => fx('trainings', 'batch_trainings.txt'),
      get_doc_as_markdown: () => fx('gemini', 'notes.md'),
      search_drive_files: () => fx('gemini', 'drive_search_notes.txt'),
    });
    const at = new Date('2026-03-10T15:50:00.000Z'); // 20 min after the declined meeting ended (Gemini poll window)
    const clock = new FakeClock(at);
    const fetchers = [
      new CalendarFetcher({ google: g, me: ME, clock: () => clock.now() }),
      new TrainingsFetcher({ google: g, me: ME, clock: () => clock.now() }),
      new GeminiNotesFetcher({ google: g, me: ME, clock: () => clock.now() }),
    ];
    const hs = harness({ clock, fetchers, userId });
    await hs.plan();
    await hs.drain();
    expect(await count(userId, 'calendar')).toBeGreaterThan(3);
    expect(await count(userId, 'trainings')).toBeGreaterThan(0);
    expect(await count(userId, 'gemini_notes')).toBe(1);
    const kinds = await db.execute<{ kind: string; n: string }>(sql`select kind, count(*) as n from source_items where owner_user_id = ${userId} group by kind order by kind`);
    expect(kinds.rows.map((r) => r.kind)).toEqual(expect.arrayContaining(['calendar_event', 'email_message', 'gemini_note']));
    for (const [connector, scope] of [['calendar', 'primary'], ['trainings', 'gmail'], ['trainings', 'calendar'], ['gemini_notes', 'poll']] as const) {
      expect((await hs.store.getCursor({ connector, scope }))?.at, `${connector}:${scope}`).toBe(at.toISOString());
    }
    for (const c of ['calendar', 'trainings', 'gemini_notes']) expect((await runs(userId, c)).every((r) => r.status === 'succeeded'), c).toBe(true);
    // the next poll is planned from the cursor (coverage does not claim the future)
    clock.advance(6 * 60_000);
    const next = harness({ clock, fetchers, userId });
    const planned = await next.scanning.scanner.planJobs(clock.now());
    expect(planned.filter((j) => j.kind === 'scan').map((j) => `${(j as { connector: string }).connector}:${(j as { scope: string }).scope}`)).toEqual(
      expect.arrayContaining(['calendar:primary', 'trainings:calendar', 'gemini_notes:poll']),
    );
  });

  it('drive: baseline first, an edit on the next sample becomes a file_revision item', async () => {
    const userId = await createUser(db, 'drive');
    let version = 'v1';
    let modified = '2026-03-10T17:20:00.000Z';
    const g = new FakeGoogle({
      search_drive_files: () => fx('drive', 'feed_deck_modified.txt').replace('2026-03-10T17:20:00.000Z', modified),
      get_presentation: () => fx('drive', `presentation_${version}.txt`),
      get_doc_as_markdown: () => fx('drive', 'doc_v1.md'),
      get_spreadsheet_info: () => fx('drive', 'sheet_info.txt'),
      read_sheet_values: (a) => (String(a.range_name).includes('Inputs') ? fx('drive', 'sheet_inputs_v1.txt') : fx('drive', 'sheet_outputs_v1.txt')),
    });
    const clock = new FakeClock('2026-03-10T17:30:00.000Z');
    const digests = new MemoryDigestStore();
    const mk = () => new DriveFetcher({ google: g, me: ME, store: digests, clock: () => clock.now() });
    const hs = harness({ clock, fetchers: [mk()], userId });
    await hs.plan();
    await hs.drain();
    // Baseline only, plus DRV-1's record-only history of my last edit (no diff, no agent run).
    expect(await count(userId, 'drive')).toBe(1);
    expect((await db.execute<{ h: boolean }>(sql`select (meta->>'history')::boolean as h from source_items where owner_user_id = ${userId} and source = 'drive'`)).rows.map((r) => r.h)).toEqual([true]);
    expect((await hs.store.getCursor({ connector: 'drive', scope: 'tracked' }))?.at).toBe(clock.now().toISOString());
    clock.advance(20 * 60_000);
    version = 'v2';
    modified = '2026-03-10T17:45:00.000Z';
    const again = harness({ clock, fetchers: [mk()], userId });
    await again.plan();
    await again.drain();
    const items = await db.execute<{ kind: string; title: string }>(sql`select kind, title from source_items where owner_user_id = ${userId}`);
    expect(items.rows.length).toBeGreaterThanOrEqual(2); // the history item and the edit's diff
    expect(items.rows.every((r) => r.kind === 'drive_file_revision')).toBe(true);
    expect((await runs(userId, 'drive')).every((r) => r.status === 'succeeded')).toBe(true);
  });

  describe('claude sessions via the file watch', () => {
    let dir: string;
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('a file change enqueues an incremental scan; waiting sessions notify once', async () => {
      const userId = await createUser(db, 'claude');
      dir = await mkdtemp(join(tmpdir(), 'cc-be1a-claude-'));
      await cp(join(__dirname, '..', '..', 'fixtures', 'scanner', 'claude'), dir, { recursive: true });
      const old = new Date(NOW.getTime() - 3600_000);
      for (const s of ['s-busy', 's-waiting-dialog', 's-ask', 's-plan', 's-done', 's-question', 's-courtesy', 's-idle-live', 's-apierr', 's-interrupted', 's-cctag', 's-compact', 's-sidechain', 's-sdk', 's-scheduled', 's-custom-title']) {
        await utimes(join(dir, 'projects', '-work-acme', `${s}.jsonl`), old, old);
      }
      const clock = new FakeClock(NOW);
      const procs = async () => new Map<number, string>([1001, 1002, 1003, 1006, 1009].map((p) => [p, `Tue Mar 10 08:00:0${p % 10} 2026`] as [number, string]));
      const f = new ClaudeSessionsFetcher({ sessionsDir: join(dir, 'sessions'), projectsDir: join(dir, 'projects'), desktopDir: null, stateStore: new MemorySessionStateStore(), clock: () => clock.now(), listProcesses: procs, recentDays: 3650 });
      const hs = harness({ clock, fetchers: [f], userId });
      await hs.plan();
      await hs.drain();
      const n1 = await count(userId, 'claude_sessions');
      expect(n1).toBeGreaterThan(5);
      // per-transcript coverage reaches back before the window; aligned, the cursor still initializes
      expect((await hs.store.getCursor({ connector: 'claude_sessions', scope: 'all' }))?.at).toBe(NOW.toISOString());
      expect((await runs(userId, 'claude_sessions')).every((r) => r.status === 'succeeded')).toBe(true);
      expect(hs.notifier.sent.filter((s) => s.kind === 'waiting_on_you').length).toBeGreaterThan(0);
      const waitingFirst = hs.notifier.sent.length;
      // a file change (the watcher's debounced callback) → an incremental scan, coalesced on the poll key; a second change
      // inside the window (COST-2) schedules no second run: it joins the queued one
      clock.advance(60_000);
      expect(await hs.scanning.enqueueFileWatch()).toBe(true);
      expect(await hs.scanning.enqueueFileWatch()).toBe(false);
      const q = await db.execute<{ n: string }>(sql`select count(*) as n from jobs where owner_user_id = ${userId} and status = 'queued' and dedupe_key = 'scan:claude_sessions:all'`);
      expect(q.rows[0]!.n).toBe('1');
      await hs.drain();
      expect(await count(userId, 'claude_sessions')).toBe(n1);
      expect(hs.notifier.sent.length).toBe(waitingFirst); // unchanged sessions do not re-notify
      const trig = await db.execute<{ trigger: string }>(sql`
        select r.trigger from scan_runs r join connectors c on c.id = r.connector_id where c.name = 'claude_sessions' and r.owner_user_id = ${userId}
         order by r.started_at desc limit 1`);
      expect(trig.rows[0]!.trigger).toBe('hook');
    });
  });
});
