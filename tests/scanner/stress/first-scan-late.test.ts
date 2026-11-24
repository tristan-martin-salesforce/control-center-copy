/**
 * FS-LATE (placeholders only): a channel watch added after the first scan finished backfills the first scan's lookback
 * from the day it is added, under the remaining one-time budget. Before, it planned Slack's own 24 h.
 */
import { describe, expect, it } from 'vitest';

import { FakeClock } from '../../../src/scanner/runtime/clock';
import { slackSpec } from '../../../src/scanner/runtime/connectors';
import { FirstScan, MemoryFirstScanLedger, type FirstScanState } from '../../../src/scanner/runtime/first-scan';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { setTraceSink } from '../../../src/scanner/trace';
import { ScriptedSkillRunner } from '../runtime/helpers/scripted-runner';
import { PROFILE } from '../runtime/helpers/world';

const DAY = 86_400_000;
const STARTED = '2026-11-06T15:00:00.000Z';
const LATER = '2026-11-14T15:00:00.000Z';
const CH = 'slack:channel:C0PLACEHOLD';

const doneState = (o: Partial<FirstScanState> = {}): FirstScanState => ({
  lookbackDays: 30,
  budgetUsd: 100,
  startedAt: STARTED,
  floorAt: new Date(Date.parse(STARTED) - 30 * DAY).toISOString(),
  spentUsd: 40,
  byDay: {},
  scopes: { 'slack:inbox': 'done', 'gmail:inbox': 'done' },
  status: 'done',
  doneAt: '2026-11-06T21:00:00.000Z',
  ...o,
});
const firstScan = (s: FirstScanState) => {
  const ledger = new MemoryFirstScanLedger();
  ledger.state = s;
  return { fs: new FirstScan({ lookbackDays: 30, budgetUsd: 100, connectors: ['slack', 'gmail'] }, ledger), ledger };
};

describe('FS-LATE: a channel watch added after the first scan finished', () => {
  it('joins it: 30 days back from the day it is added, the first scan active again until it is done', () => {
    const { fs, ledger } = firstScan(doneState());
    const now = new Date(LATER);
    const c = fs.claim('slack', CH, false, now)!;
    expect(c.floorAt).toBe(new Date(now.getTime() - 30 * DAY).toISOString());
    expect(c.startedAt).toBe(LATER);
    expect(ledger.state).toMatchObject({ status: 'active', scopes: { [CH]: 'pending' }, late: { [CH]: LATER } });
    expect(ledger.state!.doneAt).toBeUndefined();
    // a later claim while it runs keeps the same window
    expect(fs.claim('slack', CH, true, new Date(Date.parse(LATER) + 3_600_000))).toEqual(c);
    fs.scopeDone(CH, new Date(Date.parse(LATER) + 2 * 3_600_000));
    expect(ledger.state!.status).toBe('done');
  });

  it('never for a thread or other targeted scope, a channel with history, or a spent budget', () => {
    expect(firstScan(doneState()).fs.claim('slack', 'slack:thread:C0PLACEHOLD:1793800000.000100', false, new Date(LATER))).toBeUndefined();
    expect(firstScan(doneState()).fs.claim('slack', CH, true, new Date(LATER))).toBeUndefined();
    expect(firstScan(doneState({ spentUsd: 100 })).fs.claim('slack', CH, false, new Date(LATER))).toBeUndefined();
    const { fs, ledger } = firstScan(doneState());
    expect(fs.claim('slack', 'slack:inbox', false, new Date(LATER))).toBeUndefined();
    expect(ledger.state!.status).toBe('done');
  });

  it('the runtime plans the channel oldest first back 30 days, on the first-scan budget', async () => {
    const clock = new FakeClock(LATER);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
    const { fs } = firstScan(doneState());
    const spec = slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined, scopes: () => ['channel:C0PLACEHOLD'] });
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(async () => {}), specs: [spec], clock, reevaluate: async () => {}, firstScan: fs });
    const jobs = (await runtime.planJobs(new Date(LATER))).filter((j) => j.kind === 'scan' && j.scope === 'channel:C0PLACEHOLD');
    expect(jobs.length).toBeGreaterThan(1);
    const froms = jobs.map((j) => (j.kind === 'scan' ? Date.parse(j.window.from) : NaN));
    expect(Math.min(...froms)).toBe(Date.parse(LATER) - 30 * DAY);
    expect(froms).toEqual([...froms].sort((x, y) => x - y)); // FS-ORDER
    expect(jobs.filter((j) => j.kind === 'scan' && j.mode === 'backfill').every((j) => j.kind === 'scan' && j.budget === 'first_scan')).toBe(true);
  });

  it("the channel's runs carry a first_scan_reopened trace event (scope, floor, when it joined)", async () => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const prev = setTraceSink({ write: (e: { kind: string; payload: Record<string, unknown> }) => void events.push(e), flush: async () => {} } as never);
    try {
      const clock = new FakeClock(LATER);
      const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
      const { fs } = firstScan(doneState());
      const finish = async (api: any) => {
        const w = api.input.window!;
        await api.call('cc_report_coverage', { windows: [{ ref: 'conversations.history', from: w.from, to: w.to }] });
        await api.call('cc_finish', { cursor: { value: `${Math.floor(Date.parse(w.to) / 1000)}.000000`, at: w.to }, complete: true });
      };
      const spec = slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined, scopes: () => ['channel:C0PLACEHOLD'] });
      const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(finish), specs: [spec], clock, reevaluate: async () => {}, firstScan: fs });
      const jobs = (await runtime.planJobs(new Date(LATER))).filter((j) => j.kind === 'scan' && j.mode === 'backfill');
      await runtime.executeJob(jobs[0]!);
      const ev = events.find((e) => e.kind === 'first_scan_reopened');
      expect(ev?.payload).toMatchObject({ scope: CH, joinedAt: LATER, floorAt: new Date(Date.parse(LATER) - 30 * DAY).toISOString(), lookbackDays: 30 });
    } finally {
      setTraceSink(prev);
    }
  });
});


describe('MIN-25: deterministic backfills get room for long items', () => {
  it('a backfill-type run of a deterministic source may spend $0.10; the regular poll keeps $0.05', async () => {
    const { deterministicSpec } = await import('../../../src/scanner/runtime/connectors');
    for (const connector of ['gemini_notes', 'gmail', 'calendar']) {
      const spec = deterministicSpec({ connector } as never);
      expect(['backfill', 'head', 'continuation', 'retry'].map((m) => spec.costCapUsd('x', m as never))).toEqual([0.1, 0.1, 0.1, 0.1]);
      expect(spec.costCapUsd('x', 'incremental')).toBe(0.05);
    }
  });
});

describe('MIN-26: a planned split or fewer-items retry does not degrade the connector', () => {
  const W = { from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T00:00:00.000Z' };
  const setup = async (fail: (n: number) => { message: string; errorClass: 'config' | 'transient' } | null) => {
    const { deterministicSpec } = await import('../../../src/scanner/runtime/connectors');
    const { scanJob } = await import('../../../src/scanner/runtime/jobs');
    const clock = new FakeClock('2026-10-21T00:00:00.000Z');
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
    const fetcher = {
      connector: 'gemini_notes' as const,
      scopes: async () => ['poll'],
      health: async () => ({ state: 'ok' as const, checkedAt: clock.now().toISOString() }),
      fetch: async (_s: unknown, _c: unknown, w: { from: string; to: string }) => ({
        items: [{ connector: 'gemini_notes' as const, kind: 'meeting_notes', externalId: 'n1', dedupeKey: 'gemini_notes:n1', contentHash: 'h', occurredAt: w.from }],
        coverage: [{ kind: 'calendar_range' as const, ref: 'notes-poll', from: w.from, to: w.to }],
        nextCursor: { value: '1', at: w.to },
        complete: true,
      }),
    };
    const ok = new ScriptedSkillRunner(async (api) => {
      await api.call('cc_finish', { cursor: { value: '1', at: api.input.window!.to }, complete: true });
    });
    let n = 0;
    const runner = {
      run: async (input: never, s: never) => {
        const f = fail(n++);
        return f ? { ok: false, costUsd: 0.06, inputTokens: 1200, outputTokens: 80, turns: 1, error: f } : ok.run(input, s);
      },
    };
    const rt = new ScannerRuntime({ store, runner: runner as never, specs: [deterministicSpec(fetcher as never)], clock, reevaluate: async () => {} });
    const job = scanJob({ connector: 'gemini_notes', scope: 'poll', window: W, mode: 'backfill', trigger: 'catch_up', runAt: clock.now().toISOString() });
    return { rt, store, job };
  };

  it('a cost-cap failure retried with fewer items: never degraded; the retry that succeeds writes ok', async () => {
    const { rt, store, job } = await setup((n) => (n === 0 ? { message: 'cost cap exceeded (SDK maxBudgetUsd)', errorClass: 'config' } : null));
    const first = await rt.executeJob(job);
    expect(first.status).toBe('failed');
    expect(first.followUps).toHaveLength(1);
    expect(store.healthHistory('gemini_notes').filter((p) => p.state !== 'ok')).toEqual([]);
    const second = await rt.executeJob(first.followUps[0]!);
    expect(second.status).toBe('succeeded');
    expect(store.healthHistory('gemini_notes').map((p) => p.state)).toEqual(['ok']);
  });

  it('a real failure still degrades it', async () => {
    const { rt, store, job } = await setup(() => ({ message: 'upstream 503: backend unavailable', errorClass: 'transient' }));
    await rt.executeJob(job);
    expect(store.latestHealth('gemini_notes')?.state).toBe('degraded');
  });
});
