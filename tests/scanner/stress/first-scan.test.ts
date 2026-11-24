/**
 * B-080 (placeholders only): first-run lookback setting + one-time backfill budget + oldest-first backfill (FS-ORDER).
 * In-memory store and the scripted runner (no model); the production ScannerRuntime plans and executes.
 */
import { describe, expect, it } from 'vitest';

import { CalendarFetcher } from '../../../src/connectors/google/calendar';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { deterministicSpec, org62Spec, slackSpec } from '../../../src/scanner/runtime/connectors';
import { DEFAULT_FIRST_SCAN_DAYS, FirstScan, MemoryFirstScanLedger, firstScanFromEnv } from '../../../src/scanner/runtime/first-scan';
import type { RuntimeJob, ScanJob } from '../../../src/scanner/runtime/jobs';
import { planResume } from '../../../src/scanner/runtime/resume-planner';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { Reconciler } from '../../../src/scanner/reconcile/reconciler';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { windowAligned } from '../../../src/worker/scanning';
import { ScriptedSkillRunner, type Script } from '../runtime/helpers/scripted-runner';
import { PROFILE } from '../runtime/helpers/world';
import { FakeGoogle, fx, signal } from '../../connectors/readers/helpers';
import { DriveFetcher, MemoryDigestStore } from '../../../src/scanner/drive-digest';

const H = 3_600_000;
const NOW = '2026-11-06T15:00:00.000Z';

/** Covers its window and finishes; costs $0.01 per run. */
const coverAll: Script = async (api) => {
  const w = api.input.window!;
  const scope = api.input.context.scope.scope;
  const refs = scope === 'inbox' ? ['search:dm', 'search:mentions', 'search:mine'] : [`search:${scope}`];
  await api.call('cc_report_coverage', { windows: refs.map((ref) => ({ ref, from: w.from, to: w.to })) });
  await api.call('cc_finish', { cursor: { value: `${Math.floor(Date.parse(w.to) / 1000)}.000000`, at: w.to }, complete: true });
  api.spend(0.01);
};

function world(opts: { lookbackDays: number; budgetUsd: number; hardCapUsd?: number; ledger?: MemoryFirstScanLedger; store?: InMemoryScannerStore; clock?: FakeClock }) {
  const clock = opts.clock ?? new FakeClock(NOW);
  const store = opts.store ?? new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: opts.hardCapUsd ?? 5, softCapUsd: 2 });
  const runner = new ScriptedSkillRunner(coverAll);
  const ledger = opts.ledger ?? new MemoryFirstScanLedger();
  const firstScan = new FirstScan({ lookbackDays: opts.lookbackDays, budgetUsd: opts.budgetUsd, connectors: ['slack'] }, ledger);
  const runtime = new ScannerRuntime({ store, runner, specs: [slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined })], clock, reevaluate: async () => {}, firstScan });
  return { clock, store, runner, ledger, firstScan, runtime };
}

async function drain(runtime: ScannerRuntime, jobs: RuntimeJob[], limit = 10_000) {
  const q = runtime.queue as unknown as { enqueue(j: RuntimeJob[]): Promise<void>; dequeue(at: Date): RuntimeJob | undefined };
  await q.enqueue(jobs);
  const order: ScanJob[] = [];
  const far = new Date(8.64e15);
  for (let job = q.dequeue(far), n = 0; job && n < limit; job = q.dequeue(far), n++) {
    if (job.kind !== 'scan') continue;
    const out = await runtime.executeJob(job);
    order.push(job);
    await q.enqueue(out.followUps);
  }
  return order;
}

describe('first-scan setting (B-080)', () => {
  it('reads the lookback and budget from env or worker flags; off when unset', () => {
    expect(firstScanFromEnv({}, [])).toBeUndefined();
    expect(firstScanFromEnv({ CC_FIRST_SCAN_LOOKBACK_DAYS: '90' }, [])).toMatchObject({ lookbackDays: 90, budgetUsd: 25, connectors: ['slack', 'gmail', 'drive', 'gemini_notes', 'org62', 'calendar'] });
    expect(firstScanFromEnv({}, ['node', 'worker', '--lookback-days=30', '--backfill-budget', '40'])).toMatchObject({ lookbackDays: 30, budgetUsd: 40 });
    // The worker's default (30 d) applies only when nothing is set; 0 turns the first scan off.
    expect(firstScanFromEnv({}, [], DEFAULT_FIRST_SCAN_DAYS)).toMatchObject({ lookbackDays: 30, budgetUsd: 25 });
    expect(firstScanFromEnv({ CC_FIRST_SCAN_LOOKBACK_DAYS: '0' }, [], DEFAULT_FIRST_SCAN_DAYS)).toBeUndefined();
    expect(firstScanFromEnv({ CC_FIRST_SCAN_LOOKBACK_DAYS: '7' }, [], DEFAULT_FIRST_SCAN_DAYS)).toMatchObject({ lookbackDays: 7 });
  });

  it('FS-ORDER: first-scan planning has no head hour and chunks each gap forward from its start, oldest → newest', () => {
    const now = new Date(NOW);
    const gaps = [{ from: new Date(Date.parse(NOW) - 30 * H).toISOString(), to: NOW }];
    const plan = planResume({ now, gaps, chunkMs: 6 * H, head: false, maxBackfillMs: 40 * H });
    expect(plan.every((p) => p.mode === 'backfill')).toBe(true); // before: the head hour first, then newest → oldest
    const bf = plan.map((p) => p.window);
    expect(bf.map((w) => w.from)).toEqual([...bf.map((w) => w.from)].sort()); // oldest → newest
    expect(plan.map((p) => p.order)).toEqual(plan.map((_, i) => i));
    expect(bf[0]!.from).toBe(gaps[0]!.from);
    expect(bf.at(-1)!.to).toBe(NOW);
    for (let i = 1; i < bf.length; i++) expect(bf[i]!.from).toBe(bf[i - 1]!.to);
    // A later re-plan after the 3 oldest chunks ran (the gap starts where the last one ended) keeps the same chunks.
    const later = new Date(Date.parse(NOW) + 2 * H);
    const again = planResume({ now: later, gaps: [{ from: bf[2]!.to, to: NOW }, { from: NOW, to: later.toISOString() }], chunkMs: 6 * H, head: false, maxBackfillMs: 40 * H });
    expect(again.map((p) => p.window).slice(0, bf.length - 3)).toEqual(bf.slice(3));
    // The live loop still plans the head hour first (unchanged).
    expect(planResume({ now, gaps, chunkMs: 6 * H, maxBackfillMs: 40 * H })[0]).toMatchObject({ mode: 'head' });
  });
});

describe('first scan in the runtime (B-080)', () => {
  it('a cold start plans the whole lookback oldest first under the first-scan budget, past the 14-day cap', async () => {
    const { runtime } = world({ lookbackDays: 20, budgetUsd: 100 });
    const jobs = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan');
    const inbox = jobs.filter((j) => j.scope === 'inbox');
    expect(inbox.every((j) => j.mode === 'backfill' && j.budget === 'first_scan')).toBe(true); // FS-ORDER: no head hour
    expect(inbox[0]!.window.from).toBe(new Date(Date.parse(NOW) - 20 * 24 * H).toISOString()); // 20 d > the 14 d cap
    expect(inbox.at(-1)!.window.to).toBe(NOW);
    // The queue runs them in plan order: runAt ascends with the window, oldest first.
    expect(inbox.map((j) => j.window.from)).toEqual([...inbox.map((j) => j.window.from)].sort());
    expect(inbox.map((j) => j.runAt)).toEqual([...inbox.map((j) => j.runAt)].sort());
    expect(inbox.every((j) => Date.parse(j.window.to) - Date.parse(j.window.from) <= 2 * H)).toBe(true);
  });

  it('FS-ORDER: an ask is recorded before the reply that answers it, and live polls during the backfill cover only what came after the plan', async () => {
    const { runtime, clock, store } = world({ lookbackDays: 1, budgetUsd: 100, hardCapUsd: 50 });
    const plan = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan' && j.scope === 'inbox');
    const ran: string[] = [];
    for (const j of plan.slice(0, 3)) {
      await runtime.executeJob(j);
      ran.push(j.window.from);
    }
    expect(ran).toEqual([...ran].sort()); // oldest windows first
    // The cursor trails the backfill (before: the head hour put it at now on the first run).
    expect((await store.getCursor({ connector: 'slack', scope: 'inbox' }))!.at).toBe(plan[2]!.window.to);
    // The plan's jobs leave the pending lease (15 min) and the live loop polls: only [plan end, now], never the backfill.
    clock.advance(20 * 60_000);
    const live = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan' && j.scope === 'inbox');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ mode: 'incremental', window: { from: NOW, to: clock.now().toISOString() } });
    expect(live[0]!.budget).toBeUndefined();
    // The rest of the backfill runs, then the cursor fast-forwards over the live poll's coverage.
    await runtime.executeJob(live[0]!);
    for (const j of plan.slice(3)) await runtime.executeJob(j);
    expect((await store.getCursor({ connector: 'slack', scope: 'inbox' }))!.at).toBe(clock.now().toISOString());
    expect(await store.coverageGaps({ connector: 'slack', scope: 'inbox' }, { from: plan[0]!.window.from, to: clock.now().toISOString() })).toEqual([]);
  });

  it('first-scan jobs bypass the daily hard cap until the one-time budget is spent; regular spend is unaffected', async () => {
    const { runtime, store, firstScan } = world({ lookbackDays: 2, budgetUsd: 0.1, hardCapUsd: 0.05 });
    // Regular spend already at the daily hard cap: regular traversal would pause.
    await store.recordSpend({ connector: 'chat', model: 'claude-sonnet-5-5', costUsd: 0.05, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    const jobs = await runtime.planJobs();
    const order = await drain(runtime, jobs.filter((j) => j.kind === 'scan'));
    const st = firstScan.state()!;
    expect(st.status).toBe('exhausted'); // 10 runs × $0.01 spent it
    expect(st.spentUsd).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(st.spentUsd).toBeLessThanOrEqual(0.1 + 0.01 + 1e-9); // the check runs before a run: at most one run over
    expect(order.filter((j) => j.budget === 'first_scan').length).toBeGreaterThanOrEqual(10);
    // After the budget is spent, the remaining first-scan chunks fall under the daily cap: paused.
    const blocked = await runtime.executeJob({ kind: 'scan', id: 'x', connector: 'slack', scope: 'inbox', window: { from: '2026-11-04T15:00:00.000Z', to: '2026-11-04T17:00:00.000Z' }, mode: 'backfill', trigger: 'catch_up', priority: 40, runAt: NOW, dedupeKey: 'x', budget: 'first_scan' });
    expect(blocked).toMatchObject({ status: 'paused', detail: 'budget_hard_cap' });
  });

  it('FS-RELINK: the plan after the first scan turns done relinks its unlinked items once (not at 02:00); a restart after done does not', async () => {
    const { runtime, firstScan, clock, ledger, store } = world({ lookbackDays: 2, budgetUsd: 100, hardCapUsd: 50 });
    await drain(runtime, await runtime.planJobs());
    expect(firstScan.state()!.status).toBe('done');
    clock.advance(60_000);
    const relinks = (await runtime.planJobs()).filter((j) => j.kind === 'reconcile');
    expect(relinks).toEqual([expect.objectContaining({ passes: ['unlinked'], id: 'reconcile:first_scan_done:unlinked' })]);
    clock.advance(60_000);
    expect((await runtime.planJobs()).filter((j) => j.kind === 'reconcile')).toEqual([]);
    // A worker started after the first scan finished: no catch-up relink of its own.
    const again = world({ lookbackDays: 2, budgetUsd: 100, hardCapUsd: 50, ledger, store, clock });
    await again.runtime.planJobs();
    clock.advance(60_000);
    expect((await again.runtime.planJobs()).filter((j) => j.kind === 'reconcile' && j.id.includes('first_scan_done'))).toEqual([]);
  });

  it('the budget ends for good when every planned scope has no first-scan work left; later plans are regular', async () => {
    const { runtime, firstScan, store, clock } = world({ lookbackDays: 2, budgetUsd: 100, hardCapUsd: 50 });
    await drain(runtime, await runtime.planJobs());
    const st = firstScan.state()!;
    expect(st.status).toBe('done');
    expect(Object.values(st.scopes).every((v) => v === 'done')).toBe(true);
    expect(await store.coverageGaps({ connector: 'slack', scope: 'inbox' }, { from: st.floorAt, to: NOW })).toEqual([]);
    clock.advance(30 * 60_000);
    const next = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan');
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((j) => !j.budget && j.mode === 'incremental')).toBe(true);
  });

  it('the worker default (30 d) plans 30 days of windows, past the 14-day planner cap', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const cfg = firstScanFromEnv({}, [], DEFAULT_FIRST_SCAN_DAYS)!;
    const firstScan = new FirstScan(cfg, new MemoryFirstScanLedger());
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(coverAll), specs: [slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined }), org62Spec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {}, firstScan });
    const jobs = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan');
    const floor = new Date(Date.parse(NOW) - 30 * 24 * H).toISOString();
    for (const c of ['slack', 'org62']) {
      const mine = jobs.filter((j) => j.connector === c);
      expect(mine.map((j) => j.window.from).sort()[0], c).toBe(floor);
      expect(mine.every((j) => j.budget === 'first_scan' || j.mode === 'incremental'), c).toBe(true);
    }
    // Contiguous: the inbox windows tile [floor, now) with no gap (2 h chunks, no head hour).
    const inbox = jobs.filter((j) => j.connector === 'slack' && j.scope === 'inbox').map((j) => j.window).sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < inbox.length; i++) expect(inbox[i]!.from).toBe(inbox[i - 1]!.to);
    expect(inbox.at(-1)!.to).toBe(NOW);
    expect(inbox.length).toBe(360); // 30 days of two-hour chunks
  });

  it('FS-ORDER: only a scope that reads the current state (Org62 book, missed opps) keeps its head run, which is the read', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const firstScan = new FirstScan({ lookbackDays: 30, budgetUsd: 100, connectors: ['org62'] }, new MemoryFirstScanLedger());
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(coverAll), specs: [org62Spec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {}, firstScan });
    const jobs = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan');
    for (const scope of ['book', 'missed_opps']) expect(jobs.filter((j) => j.scope === scope).map((j) => j.mode), scope).toEqual(['head', 'backfill']);
    for (const scope of ['opps', 'events', 'dcs']) {
      const mine = jobs.filter((j) => j.scope === scope);
      expect(mine.every((j) => j.mode === 'backfill'), scope).toBe(true);
      expect(mine.map((j) => j.window.from), scope).toEqual([...mine.map((j) => j.window.from)].sort());
    }
  });

  it('a short first scan never shortens a connector own lookback (Org62 keeps 30 d at a 7-day setting)', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const firstScan = new FirstScan({ lookbackDays: 7, budgetUsd: 100, connectors: ['slack', 'org62'] }, new MemoryFirstScanLedger());
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(coverAll), specs: [slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined }), org62Spec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {}, firstScan });
    const jobs = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan');
    const oldest = (c: string) => jobs.filter((j) => j.connector === c).map((j) => j.window.from).sort()[0];
    expect(oldest('slack')).toBe(new Date(Date.parse(NOW) - 7 * 24 * H).toISOString());
    expect(oldest('org62')).toBe(new Date(Date.parse(NOW) - 30 * 24 * H).toISOString());
  });

  it('a restart mid-way re-plans only the uncovered chunks, still under the first-scan budget', async () => {
    const a = world({ lookbackDays: 2, budgetUsd: 100, hardCapUsd: 50 });
    const plan = (await a.runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan' && j.scope === 'inbox');
    // Run the 5 oldest chunks, then "restart".
    for (const j of plan.slice(0, 5)) await a.runtime.executeJob(j);
    a.clock.advance(60_000);
    const b = world({ lookbackDays: 2, budgetUsd: 100, hardCapUsd: 50, ledger: a.ledger, store: a.store, clock: a.clock });
    const again = (await b.runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan' && j.scope === 'inbox');
    const oldBf = plan.slice(5).map((j) => j.id);
    const newBf = again.filter((j) => Date.parse(j.window.to) <= Date.parse(NOW)).map((j) => j.id);
    expect(newBf).toEqual(oldBf); // same chunks, same ids: queued copies dedupe
    expect(again.at(-1)!.window).toEqual({ from: NOW, to: a.clock.now().toISOString() }); // the minute since, last
    expect(again.every((j) => j.budget === 'first_scan' || j.mode === 'incremental')).toBe(true);
  });
});

/** Placeholder calendar: one 30-minute customer meeting a day at 16:00Z over the last `days` days. */
function dailyMeetings(now: string, days: number) {
  const evs = Array.from({ length: days }, (_, i) => {
    const s = new Date(Date.parse(now.slice(0, 10) + 'T16:00:00.000Z') - i * 24 * H);
    return { id: `evt_d${i}`, start: s.toISOString(), end: new Date(s.getTime() + 30 * 60_000).toISOString() };
  });
  return (args: Record<string, unknown>) => {
    const from = Date.parse(String(args.time_min));
    const to = Date.parse(String(args.time_max));
    const hit = evs.filter((e) => Date.parse(e.end) > from && Date.parse(e.start) < to).sort((a, b) => a.start.localeCompare(b.start));
    if (!hit.length) return 'No events found.';
    return [
      `Successfully retrieved ${hit.length} events from calendar 'primary' for me@example.com:`,
      ...hit.flatMap((e) => [
        `- "ACME_CORP sync" (Starts: ${e.start}, Ends: ${e.end})`,
        '  Description: No Description',
        '  Location: No Location',
        '  Creator: <ae.one@example.com>',
        '  Organizer: <ae.one@example.com>',
        '  Meeting Link: https://meet.google.com/abc-defg-hij',
        '  Attendees: me@example.com, ae.one@example.com, cust.one@customer.example',
        '  Attendee Details: me@example.com: accepted',
        '    ae.one@example.com: accepted (organizer)',
        '    cust.one@customer.example: accepted',
        '  Attachments: None',
        `  ID: ${e.id} | Link: https://www.google.com/calendar/event?eid=${e.id}`,
      ]),
    ].join('\n');
  };
}

/** Echo the header cursor (a deterministic run's agent): coverage was pre-reported by the worker. */
const echoHeader: Script = async (api) => {
  const v = api.input.vars ?? {};
  await api.call('cc_finish', { cursor: { value: String(v['header.cursor.value']), at: String(v['header.cursor.at']) }, complete: v['header.complete'] === 'true' });
  api.spend(0.01);
};

describe('Calendar in the first scan (FS-CAL-1)', () => {
  it('plans the lookback in day chunks; history before the live 2 days is recorded without the agent and fully covered', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const firstScan = new FirstScan({ lookbackDays: 10, budgetUsd: 100, connectors: ['calendar'] }, new MemoryFirstScanLedger());
    const google = new FakeGoogle({ get_events: dailyMeetings(NOW, 12) });
    const fetcher = new CalendarFetcher({ google, me: { email: 'me@example.com', name: 'Pat Example' }, clock: () => clock.now() });
    const runner = new ScriptedSkillRunner(echoHeader);
    const runtime = new ScannerRuntime({ store, runner, specs: [deterministicSpec(windowAligned(fetcher))], clock, reevaluate: async () => {}, firstScan });

    const jobs = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan');
    const floor = new Date(Date.parse(NOW) - 10 * 24 * H).toISOString();
    expect(jobs.every((j) => j.connector === 'calendar' && j.mode === 'backfill' && j.budget === 'first_scan')).toBe(true);
    const bf = jobs.filter((j) => j.mode === 'backfill');
    expect(bf[0]!.window.from).toBe(floor);
    expect(bf.every((j) => Date.parse(j.window.to) - Date.parse(j.window.from) <= 24 * H)).toBe(true);
    expect(bf.length).toBe(10);

    await drain(runtime, jobs);
    // The agent ran only for windows that reach into the live range (snapshot runs); history chunks never call it.
    const liveFrom = Date.parse(NOW) - 2 * 24 * H;
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls.every((c) => Date.parse(c.window!.to) > liveFrom)).toBe(true);
    // Every meeting since the floor is a source item; the history ones carry the hint and were never flagged unlinked.
    for (let i = 0; i < 10; i++) {
      const si = store.getSourceItemByDedupe(`cal:evt_d${i}`);
      expect(si, `evt_d${i}`).toBeDefined();
      if (i >= 3) {
        expect((si!.payload as { hints: string[] }).hints, `evt_d${i}`).toContain('history');
        expect(store.unlinkedRow(si!.id), `evt_d${i}`).toBeUndefined();
      }
    }
    expect(await store.coverageGaps({ connector: 'calendar', scope: 'primary' }, { from: floor, to: NOW })).toEqual([]);
    expect(firstScan.state()!.scopes['calendar:primary']).toBe('done');
  });
});

describe('first-scan holes and tripwires (FS-2, TRIP-3)', () => {
  /** Like drain(), plus the production queue's retry handling (src/worker/runtime.ts: retryAt → attempt + 1). */
  async function drainWithRetries(runtime: ScannerRuntime, jobs: RuntimeJob[]) {
    const q = runtime.queue as unknown as { enqueue(j: RuntimeJob[]): Promise<void>; dequeue(at: Date): RuntimeJob | undefined };
    await q.enqueue(jobs);
    const far = new Date(8.64e15);
    for (let job = q.dequeue(far), n = 0; job && n < 10_000; job = q.dequeue(far), n++) {
      if (job.kind !== 'scan') continue;
      const out = await runtime.executeJob(job);
      await q.enqueue(out.followUps);
      if (out.retryAt) await q.enqueue([{ ...job, runAt: out.retryAt, attempt: (job.attempt ?? 0) + 1, dedupeKey: `${job.dedupeKey}#retry${(job.attempt ?? 0) + 1}` }]);
    }
  }

  it('FS-2: a window that fails for good leaves the scope pending, and its hole is re-planned after a backoff', async () => {
    let broken = true;
    let badFrom = '';
    // The agent never finishes the bad window while `broken` (a stuck run), and covers every other window.
    const script: Script = async (api) => {
      if (broken && api.input.window!.from === badFrom) return;
      await coverAll(api);
    };
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const firstScan = new FirstScan({ lookbackDays: 1, budgetUsd: 100, connectors: ['slack'] }, new MemoryFirstScanLedger());
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(script), specs: [slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined })], clock, reevaluate: async () => {}, firstScan });
    const jobs = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan');
    const bad = jobs.filter((j) => j.mode === 'backfill')[3]!.window;
    badFrom = bad.from;
    await drainWithRetries(runtime, jobs);

    const st = firstScan.state()!;
    expect(st.scopes['slack:inbox']).toBe('pending'); // before: done, with the hole left for good
    expect(st.replans?.['slack:inbox']).toBe(1);
    const floor = st.floorAt;
    expect(await store.coverageGaps({ connector: 'slack', scope: 'inbox' }, { from: floor, to: NOW })).toEqual([bad]);

    // After the backoff the hole is planned again under the first-scan budget, and the scope then ends.
    broken = false;
    clock.advance(31 * 60_000);
    const again = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan');
    expect(again.some((j) => j.budget === 'first_scan' && j.window.from === bad.from && j.window.to === bad.to)).toBe(true);
    await drainWithRetries(runtime, again);
    expect(firstScan.state()!.scopes['slack:inbox']).toBe('done');
    expect(await store.coverageGaps({ connector: 'slack', scope: 'inbox' }, { from: floor, to: NOW })).toEqual([]);
  });

  it('FS-3: time past the cursor (not yet polled) is not a hole: a slow-polling scope ends without a re-plan', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const firstScan = new FirstScan({ lookbackDays: 1, budgetUsd: 100, connectors: ['slack'] }, new MemoryFirstScanLedger());
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(coverAll), specs: [slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined })], clock, reevaluate: async () => {}, firstScan });
    const jobs = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan' && j.scope === 'inbox');
    for (const j of jobs.slice(0, -1)) await runtime.executeJob(j);
    clock.advance(30 * 60_000); // no poll ran meanwhile: [cursor, now] is simply not polled yet
    await runtime.executeJob(jobs.at(-1)!);
    expect(firstScan.state()!.scopes['slack:inbox']).toBe('done');
    expect(firstScan.state()!.replans?.['slack:inbox']).toBeUndefined();
  });

  it('TRIP-3: a traversal prefix tripwire retries the same window later instead of splitting it', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const tripped = { run: async () => ({ ok: false, costUsd: 0.005, inputTokens: 1200, outputTokens: 80, turns: 1, error: { message: 'prefix tripwire: first call prompt 70000 tokens > 58000', errorClass: 'config' as const } }) };
    const runtime = new ScannerRuntime({ store, runner: tripped as never, specs: [slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined })], clock, reevaluate: async () => {} });
    const job: ScanJob = { kind: 'scan', id: 'c1', connector: 'slack', scope: 'channel:C0PLACEHOLD', window: { from: '2026-11-04T15:00:00.000Z', to: '2026-11-05T15:00:00.000Z' }, mode: 'backfill', trigger: 'catch_up', priority: 40, runAt: NOW, dedupeKey: 'c1' };
    const out = await runtime.executeJob(job);
    expect(out.status).toBe('failed');
    expect(out.followUps).toEqual([]); // before: two half windows, then quarters… down to 10 minutes
    expect(out.retryAt).toBeDefined();
  });
});

describe('stale re-reads during a first scan (RCN-1)', () => {
  it('the stale-but-active pass skips a connector whose first scan is still active', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const base = await store.getContext({ connector: 'slack', scope: 'inbox' });
    // One open item whose Slack thread may have moved (last evidence a day ago).
    const ctx = { ...base, openItems: [{ workItemId: 'wi_1', kind: 'ask', state: 'open', title: 'PLACEHOLDER ask', people: [], accounts: [], keywords: [], threadRefs: ['slack:C0PLACEHOLD:1793800000.000100'], fileRefs: [], lastEvidenceAt: new Date(Date.parse(NOW) - 24 * H).toISOString() }] };
    const fakeStore = { getContext: async () => ctx } as unknown as InMemoryScannerStore;
    const specs = [slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined })];
    const job = { kind: 'reconcile' as const, id: 'r', passes: ['stale_active' as const], trigger: 'reconcile' as const, priority: 45, runAt: NOW, dedupeKey: 'r' };
    let active = true;
    const rec = new Reconciler({ store: fakeStore, runner: new ScriptedSkillRunner(coverAll), clock, specs, firstScanActive: () => active });
    expect((await rec.run(job, new AbortController().signal)).jobs).toEqual([]);
    active = false;
    const after = await rec.run(job, new AbortController().signal);
    expect(after.jobs.map((j) => (j.kind === 'scan' ? j.scope : j.kind))).toEqual(['thread:C0PLACEHOLD:1793800000.000100']);
  });
});

describe('deeper per-scope lookback (FS-DEEP)', () => {
  it('reads the scope days from env or the worker flag; days not past the lookback are dropped', () => {
    expect(firstScanFromEnv({ CC_FIRST_SCAN_LOOKBACK_DAYS: '30', CC_FIRST_SCAN_SCOPE_DAYS: 'slack:inbox=90, gmail:inbox=90,bad,org62:opps=10' }, [])).toMatchObject({ lookbackDays: 30, scopeDays: { 'slack:inbox': 90, 'gmail:inbox': 90 } });
    expect(firstScanFromEnv({ CC_FIRST_SCAN_LOOKBACK_DAYS: '30' }, ['node', 'worker', '--scope-days=slack:inbox=60'])).toMatchObject({ scopeDays: { 'slack:inbox': 60 } });
    expect(firstScanFromEnv({ CC_FIRST_SCAN_LOOKBACK_DAYS: '30' }, [])?.scopeDays).toBeUndefined();
  });

  it('the inbox plans back to its own floor (2 h chunks inside the lookback, 6 h past it); other scopes keep the lookback', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: { ...structuredClone(PROFILE), watchList: [{ kind: 'slack_channel', ref: 'C0PLACEHOLD', label: '#placeholder-watch' }] } as never, hardCapUsd: 50, softCapUsd: 2 });
    const ledger = new MemoryFirstScanLedger();
    const firstScan = new FirstScan({ lookbackDays: 3, budgetUsd: 100, connectors: ['slack'], scopeDays: { 'slack:inbox': 6 } }, ledger);
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(coverAll), specs: [slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined })], clock, reevaluate: async () => {}, firstScan });
    const jobs = (await runtime.planJobs()).filter((j): j is ScanJob => j.kind === 'scan');
    const day = 24 * H;
    const base = Date.parse(NOW) - 3 * day;
    const inbox = jobs.filter((j) => j.scope === 'inbox').map((j) => j.window).sort((a, b) => a.from.localeCompare(b.from));
    expect(inbox[0]!.from).toBe(new Date(Date.parse(NOW) - 6 * day).toISOString());
    for (let i = 1; i < inbox.length; i++) expect(inbox[i]!.from).toBe(inbox[i - 1]!.to); // contiguous, no gap at the base floor
    const len = (w: { from: string; to: string }) => Date.parse(w.to) - Date.parse(w.from);
    expect(inbox.filter((w) => Date.parse(w.to) <= base).every((w) => len(w) <= 6 * H)).toBe(true);
    expect(inbox.filter((w) => Date.parse(w.to) <= base).some((w) => len(w) === 6 * H)).toBe(true);
    expect(inbox.filter((w) => Date.parse(w.from) >= base).every((w) => len(w) <= 2 * H)).toBe(true);
    const channel = jobs.filter((j) => j.scope === 'channel:C0PLACEHOLD').map((j) => j.window.from).sort();
    expect(channel[0]).toBe(new Date(base).toISOString()); // not deeper than the lookback
    expect(firstScan.floorFor('slack:inbox')).toBe(inbox[0]!.from);
    expect(ledger.state!.floors).toEqual({ 'slack:inbox': inbox[0]!.from }); // survives a restart

    // Drained, the deep scope has no holes back to its own floor and the first scan ends.
    await drain(runtime, jobs);
    expect(await store.coverageGaps({ connector: 'slack', scope: 'inbox' }, { from: inbox[0]!.from, to: NOW })).toEqual([]);
    expect(firstScan.state()!.status).toBe('done');
  });
});

describe('Drive in the first scan (FS-DRIVE-1)', () => {
  /** Placeholder files I last edited one per day over the lookback (and one by someone else), served by a query-aware feed. */
  function driveFeed(now: string, days: number) {
    const files = Array.from({ length: days }, (_, i) => ({
      id: `1DriveFile${String(i).padStart(2, '0')}AAAAAAAAAAAAAAAAAA`,
      modified: new Date(Date.parse(now) - i * 24 * H - 3 * H).toISOString(),
      me: i !== 4,
    }));
    const queries: string[] = [];
    const search = (a: Record<string, unknown>) => {
      const q = String(a.query);
      queries.push(q);
      const after = /modifiedTime > '([^']+)'/.exec(q)?.[1];
      const before = /modifiedTime <= '([^']+)'/.exec(q)?.[1];
      const hit = files.filter((f) => (!after || f.modified > after) && (!before || f.modified <= before));
      return [
        `Found ${hit.length} files for me@example.com matching '${q}':`,
        ...hit.map(
          (f) =>
            `- Name: "ACME_CORP deck ${f.id.slice(10, 12)}" (ID: ${f.id}, Type: application/vnd.google-apps.presentation, Size: 2048, Created: 2026-01-01T10:00:00.000Z, Modified: ${f.modified}, Last Edited By: ${f.me ? 'Pat Example <me@example.com>' : 'Other Person <other@example.com>'}) Link: https://docs.google.com/presentation/d/${f.id}/edit?usp=drivesdk`,
        ),
      ].join('\n');
    };
    return { files, queries, search };
  }

  it('an oldest-first backfill behind a snapshot feed: every window succeeds, is covered, and reads its own day', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const firstScan = new FirstScan({ lookbackDays: 10, budgetUsd: 100, connectors: ['drive'] }, new MemoryFirstScanLedger());
    const feed = driveFeed(NOW, 10);
    const google = new FakeGoogle({ search_drive_files: feed.search, get_presentation: () => fx('drive', 'presentation_v1.txt') });
    const fetcher = new DriveFetcher({ google, me: { email: 'me@example.com', name: 'Pat Example' }, store: new MemoryDigestStore(), clock: () => clock.now() });
    const runner = new ScriptedSkillRunner(echoHeader);
    const runtime = new ScannerRuntime({ store, runner, specs: [deterministicSpec(windowAligned(fetcher))], clock, reevaluate: async () => {}, firstScan });

    // The worker's loop: plan, run the next due job, let a few minutes pass, plan again (live polls interleave).
    const q = runtime.queue as unknown as { enqueue(j: RuntimeJob[]): Promise<void>; dequeue(at: Date): RuntimeJob | undefined };
    const floor = new Date(Date.parse(NOW) - 10 * 24 * H).toISOString();
    const outcomes: Array<{ mode: string; from: string; status: string; detail?: string }> = [];
    await q.enqueue(await runtime.planJobs());
    for (let n = 0; n < 200; n++) {
      const job = q.dequeue(clock.now());
      if (!job) {
        if (firstScan.state()!.scopes['drive:tracked'] === 'done') break;
        clock.advance(5 * 60_000);
        await q.enqueue(await runtime.planJobs());
        continue;
      }
      if (job.kind !== 'scan') continue;
      const out = await runtime.executeJob(job);
      outcomes.push({ mode: job.mode, from: job.window.from, status: out.status, ...(out.status === 'succeeded' ? {} : { detail: out.detail }) });
      await q.enqueue(out.followUps);
      clock.advance(3 * 60_000);
      await q.enqueue(await runtime.planJobs());
    }

    const backfill = outcomes.filter((o) => o.mode === 'backfill');
    expect(backfill.length).toBe(10);
    expect(backfill[0]!.from).toBe(floor);
    expect(outcomes.filter((o) => o.status !== 'succeeded')).toEqual([]);
    expect(firstScan.state()!.scopes['drive:tracked']).toBe('done');
    expect(await store.coverageGaps({ connector: 'drive', scope: 'tracked' }, { from: floor, to: NOW })).toEqual([]);
    // After the first feed, a backfill window lists only its own day (bounded both ends); live polls keep the short feed.
    // (the last window or two end within a day of the frontier and read the feed from their own start instead).
    const bounded = feed.queries.filter((x) => /modifiedTime <= /.test(x));
    expect(bounded.length).toBeGreaterThanOrEqual(7);
    expect(bounded.every((x) => backfill.some((b) => x.includes(`modifiedTime > '${b.from}'`)))).toBe(true);
    // Every editor file I last edited in the lookback is recorded once as history; the other person's is not.
    for (const f of feed.files) {
      const si = store.getSourceItemByDedupe(`drive:${f.id}@${f.modified}`);
      if (f.me) expect(si, f.id).toBeDefined();
      else expect(si, f.id).toBeUndefined();
    }
  });

  it('the fetcher: a window a day behind the frontier lists itself and keeps the cursor; a late poll reads from its own start', async () => {
    const clock = new FakeClock(NOW);
    const feed = driveFeed(NOW, 10);
    const google = new FakeGoogle({ search_drive_files: feed.search, get_presentation: () => fx('drive', 'presentation_v1.txt') });
    const f = new DriveFetcher({ google, me: { email: 'me@example.com', name: 'Pat Example' }, store: new MemoryDigestStore(), clock: () => clock.now() });
    const at = (h: number) => new Date(Date.parse(NOW) + h * H).toISOString();
    const r1 = await f.fetch('tracked', null, { from: at(-240), to: at(-216) }, { signal }); // the first feed
    expect(r1.recordOnly).toBe(true);
    clock.advance(10 * 60_000);

    const w = { from: at(-168), to: at(-144) };
    const r = await f.fetch('tracked', r1.nextCursor, w, { signal });
    expect(feed.queries.at(-1)).toContain(`modifiedTime > '${w.from}' and modifiedTime <= '${w.to}'`);
    expect(r).toMatchObject({ recordOnly: true, complete: true, nextCursor: { value: r1.nextCursor.value, at: w.to } });
    expect(r.coverage).toEqual([expect.objectContaining({ kind: 'query_window', ref: 'drive:feed', from: w.from, to: w.to })]);
    const mine = feed.files.filter((x) => x.me && x.modified > w.from && x.modified <= w.to);
    expect(mine.length).toBe(1);
    expect(r.items.map((i) => i.dedupeKey)).toEqual(mine.map((x) => `drive:${x.id}@${x.modified}`));

    // A poll that starts behind the frontier (the cursor it was handed is newer than its window start) reads the feed
    // from its own start, so its coverage reaches back to window.from; before, it began at frontier - 2 min.
    clock.advance(10 * 60_000);
    const live = { from: at(-1), to: clock.now().toISOString() };
    const p = await f.fetch('tracked', r1.nextCursor, live, { signal });
    expect(feed.queries.at(-1)).toContain(`modifiedTime > '${live.from}' and trashed`);
    expect(p.recordOnly).toBeUndefined();
    expect(p.coverage[0]).toMatchObject({ kind: 'query_window', ref: 'drive:feed', from: live.from });
  });
});
