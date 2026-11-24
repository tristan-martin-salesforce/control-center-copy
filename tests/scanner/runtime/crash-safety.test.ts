/**
 * ask #14 (docs/EDGE-CASES.md "Worker"; report 28-crash-resume.md): the runtime side of "nothing lost, duplicated or
 * silently stuck". In-memory store, a deterministic mail source, scripted runners; no network, no model.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../../../src/scanner/runtime/clock';
import { deterministicSpec } from '../../../src/scanner/runtime/connectors';
import { FileFirstScanLedger } from '../../../src/scanner/runtime/first-scan';
import { toInterpret } from '../../../src/scanner/runtime/reread';
import { ScannerRuntime, type RuntimeLogEvent } from '../../../src/scanner/runtime/scanner-runtime';
import { DISK_FULL_MESSAGE, isDiskFull, onStateWriteError } from '../../../src/scanner/runtime/state-write';
import { scanJob } from '../../../src/scanner/runtime/jobs';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import type { DeterministicFetcher, NormalizedSourceItem, SkillRunner, TimeWindow } from '../../../src/scanner/types';
import { PROFILE } from './helpers/world';

const NOW = '2026-11-18T18:00:00.000Z';
const H = 3_600_000;
const SCOPE = { connector: 'gmail' as const, scope: 'inbox' };

const mail = (i: number, at: string): NormalizedSourceItem => ({
  connector: 'gmail',
  kind: 'email',
  externalId: `m-${i}`,
  dedupeKey: `gmail:m-${i}`,
  contentHash: `h-${i}`,
  occurredAt: at,
  title: `Placeholder ${i}`,
  author: { name: 'Example Person', email: 'person@example.com' },
});

function inbox(items: NormalizedSourceItem[], fail?: () => Error | null): DeterministicFetcher & { calls: TimeWindow[] } {
  const calls: TimeWindow[] = [];
  return {
    connector: 'gmail',
    calls,
    scopes: async () => ['inbox'],
    health: async () => ({ state: 'ok', checkedAt: NOW }),
    async fetch(_s, _c, w) {
      calls.push(w);
      const e = fail?.();
      if (e) throw e;
      return { items: items.filter((x) => x.occurredAt >= w.from && x.occurredAt < w.to), coverage: [{ kind: 'mailbox_range', ref: 'gmail:inbox', from: w.from, to: w.to }], nextCursor: { value: w.to, at: w.to }, complete: true };
    },
  };
}

function world(o: { fetcher: DeterministicFetcher; runner?: SkillRunner; reevaluate?: (ids: string[]) => Promise<void> }) {
  const clock = new FakeClock(NOW);
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
  const log: RuntimeLogEvent[] = [];
  const runner: SkillRunner = o.runner ?? { run: async () => ({ ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }) };
  const runtime = new ScannerRuntime({ store, runner, specs: [deterministicSpec(o.fetcher)], clock, reevaluate: o.reevaluate ?? (async () => undefined), log: (e) => log.push(e) });
  const job = (from: number, to: number) => scanJob({ connector: 'gmail', scope: 'inbox', window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, mode: 'incremental', trigger: 'schedule', runAt: NOW });
  return { clock, store, runtime, log, job };
}

afterEach(() => onStateWriteError(null));

describe('a run never stays running while the worker lives (ask #14)', () => {
  it('an error that escapes the run after it started (booking its spend) closes the run as failed', async () => {
    const now = Date.parse(NOW);
    const w = world({ fetcher: inbox([mail(1, new Date(now - 30 * 60_000).toISOString())]), runner: { run: async () => ({ ok: true, costUsd: 0.02, inputTokens: 10, outputTokens: 1, turns: 1 }) } });
    const book = w.store.recordSpend.bind(w.store);
    w.store.recordSpend = async (s) => {
      if (s.costUsd > 0) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
      return book(s);
    };
    await expect(w.runtime.executeJob(w.job(now - H, now))).rejects.toThrow(/terminated/);
    const runs = w.store.listRuns(SCOPE);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
  });

  it('a re-evaluation enqueue that fails after the commit leaves the run succeeded; its ids go with the next success', async () => {
    const now = Date.parse(NOW);
    const runner: SkillRunner = {
      run: async (input, store) => {
        for (const r of await store.recordSourceItems(input.runId, input.prefetched!)) {
          await store.proposeItem(input.runId, { kind: 'ask', title: `Send the placeholder deck ${r.dedupeKey}`, confidence: 'likely', evidence: [{ sourceItemId: r.sourceItemId, role: 'origin', reason: 'test' }] });
        }
        if (input.preReportedCoverage?.length) await store.reportCoverage(input.runId, input.preReportedCoverage);
        return { ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
      },
    };
    const calls: string[][] = [];
    let down = true;
    const reevaluate = async (ids: string[]) => {
      if (down) throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
      calls.push(ids);
    };
    const w = world({ fetcher: inbox([mail(1, new Date(now - 30 * 60_000).toISOString()), mail(2, new Date(now + 30 * 60_000).toISOString())]), runner, reevaluate });
    const out = await w.runtime.executeJob(w.job(now - H, now));
    expect(out.status).toBe('succeeded');
    expect(w.store.listRuns(SCOPE)[0]!.status).toBe('succeeded');
    expect(w.runtime.status().find((s) => s.scope === 'inbox')?.failures ?? 0).toBe(0);
    expect(w.log.some((e) => e.code === 'reevaluate_failed')).toBe(true);
    // the database is back: the next run of the scope re-evaluates both its own item and the first run's
    down = false;
    w.clock.set(now + H);
    const next = await w.runtime.executeJob(w.job(now, now + H));
    expect(next.status).toBe('succeeded');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.length).toBe(2);
    expect(calls[0]).toEqual(expect.arrayContaining([...out.touchedWorkItemIds!, ...next.touchedWorkItemIds!]));
  });
});

describe('the model call fails mid-job (ask #14)', () => {
  it('the run fails transient with what it cost booked, and the window is tried again', async () => {
    const now = Date.parse(NOW);
    const runner: SkillRunner = { run: async () => ({ ok: false, costUsd: 0.03, inputTokens: 300, outputTokens: 20, turns: 2, error: { message: 'classifier: overloaded', errorClass: 'transient' } }) };
    const w = world({ fetcher: inbox([mail(1, new Date(now - 30 * 60_000).toISOString())]), runner });
    const out = await w.runtime.executeJob(w.job(now - H, now));
    expect(out.status).toBe('failed');
    expect(out.errorClass).toBe('transient');
    const run = w.store.listRuns(SCOPE)[0]!;
    expect(run.status).toBe('failed');
    expect(w.store.spendToday()).toBeCloseTo(0.03, 6);
    // tried again: a retry job, or the scope due again soon from its unmoved cursor
    expect(await w.store.getCursor(SCOPE)).toBeNull();
    const due = Date.parse(w.runtime.status().find((s) => s.scope === 'inbox')!.nextDueAt);
    expect(!!out.retryAt || due <= now + 30 * 60_000).toBe(true);
  });
});

describe('a full disk (ask #14, W5)', () => {
  it('fails the run transient in plain words, says so once to the listener, and never stops the scope', async () => {
    const now = Date.parse(NOW);
    const heard: Array<{ what: string; code: string }> = [];
    onStateWriteError((e) => heard.push(e));
    const w = world({ fetcher: inbox([], () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })) });
    for (let i = 0; i < 6; i++) {
      const out = await w.runtime.executeJob(w.job(now - H, now));
      expect(out.status).toBe('failed');
      expect(out.errorClass).toBe('transient');
    }
    expect(w.store.listRuns(SCOPE).every((r) => r.status === 'failed' && r.error === DISK_FULL_MESSAGE)).toBe(true);
    expect(heard.length).toBeGreaterThanOrEqual(1);
    expect(heard[0]!.code).toBe('ENOSPC');
    expect(w.runtime.status().find((s) => s.scope === 'inbox')?.paused).not.toBe('stopped');
    expect(w.log.some((e) => e.code === 'disk_full')).toBe(true);
  });

  it('isDiskFull knows the file system and the database codes', () => {
    expect(isDiskFull({ code: 'ENOSPC' })).toBe(true);
    expect(isDiskFull({ code: '53100' })).toBe(true);
    expect(isDiskFull({ cause: { code: 'ENOSPC' } })).toBe(true);
    expect(isDiskFull({ code: 'ECONNREFUSED' })).toBe(false);
    expect(isDiskFull(null)).toBe(false);
  });

  it('the first-scan state file failing to save does not throw (state stays in memory) and is reported', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cc-fs-'));
    const blocker = path.join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const heard: string[] = [];
    onStateWriteError((e) => heard.push(e.code));
    const ledger = new FileFirstScanLedger(path.join(blocker, 'first-scan.json'));
    expect(() => ledger.save({ status: 'active' } as never)).not.toThrow();
    expect(heard).toHaveLength(1); // EEXIST or ENOTDIR: the folder is a file here; ENOSPC on a full disk
  });
});

describe('a message an interrupted run stored but nobody judged is read again (W2)', () => {
  it('toInterpret keeps new, changed and unjudged rows; judged unchanged rows are skipped', async () => {
    const rows = [
      { sourceItemId: 'a', isNew: true, changed: false },
      { sourceItemId: 'b', isNew: false, changed: true },
      { sourceItemId: 'c', isNew: false, changed: false },
      { sourceItemId: 'd', isNew: false, changed: false },
    ];
    const store = { triageVerdicts: async (ids: string[]) => new Map(ids.filter((i) => i === 'd').map((i) => [i, { v: 'noise' as const }])) };
    expect((await toInterpret(store, rows)).map((r) => r.sourceItemId)).toEqual(['a', 'b', 'c']);
    // a store that can't say keeps the old rule
    expect((await toInterpret({}, rows)).map((r) => r.sourceItemId)).toEqual(['a', 'b']);
    expect((await toInterpret({ triageVerdicts: async () => Promise.reject(new Error('down')) }, rows)).map((r) => r.sourceItemId)).toEqual(['a', 'b']);
  });

  it('at the hard cap, a re-read of a window an interrupted run stored defers its messages to reconcile again', async () => {
    const now = Date.parse(NOW);
    const items = [mail(1, new Date(now - 40 * 60_000).toISOString()), mail(2, new Date(now - 20 * 60_000).toISOString())];
    const w = world({ fetcher: inbox(items) });
    // the interrupted run: its messages stored, nothing judged, the run never finished
    const { runId } = await w.store.startRun({ scope: SCOPE, trigger: 'schedule', window: { from: new Date(now - H).toISOString(), to: new Date(now).toISOString() } });
    await w.store.recordSourceItems(runId, items);
    await w.store.failRun(runId, { error: 'cancelled: worker stopped before the run finished', errorClass: 'transient' });
    // the re-run is over the day's cap: linking is deferred, and both messages are flagged (not only new ones)
    await w.store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 1_000, inputTokens: 1, outputTokens: 1, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'x' });
    const out = await w.runtime.executeJob(w.job(now - H, now));
    expect(out.status).toBe('succeeded');
    const flagged = await w.store.unlinkedSourceItems({});
    expect(flagged.map((u) => u.sourceItemId).sort()).toHaveLength(2);
  });
});

describe('a clock jump (the Mac slept 3 h)', () => {
  it('plans one bounded catch-up per scope, not 3 h of missed polls', async () => {
    const start = Date.parse(NOW);
    const w = world({ fetcher: inbox([]) });
    await w.runtime.drain();
    const cursor0 = (await w.store.getCursor(SCOPE))!.at;
    w.clock.set(start + 3 * H);
    const jobs = (await w.runtime.planJobs()).filter((j) => j.kind === 'scan' && j.connector === 'gmail' && j.scope === 'inbox');
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.length).toBeLessThanOrEqual(4);
    // the windows tile [cursor, now] without overlap
    const ws = jobs.flatMap((j) => (j.kind === 'scan' ? [j.window] : [])).sort((a, b) => a.from.localeCompare(b.from));
    expect(ws[0]!.from <= cursor0).toBe(true);
    expect(ws.at(-1)!.to).toBe(new Date(start + 3 * H).toISOString());
    for (let i = 1; i < ws.length; i++) expect(ws[i]!.from >= ws[i - 1]!.to).toBe(true);
    // planning again at once adds nothing (the jobs are pending, not re-fired)
    expect((await w.runtime.planJobs()).filter((j) => j.kind === 'scan' && j.connector === 'gmail' && j.scope === 'inbox')).toEqual([]);
  });
});
