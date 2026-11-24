/**
 * HEALTH-1 and SHUT-1 (placeholders only): a connector recovers by itself after a restart, and a worker-initiated
 * abort is a cancellation, never a connector failure. In-memory store and the scripted runner (no model).
 */
import { describe, expect, it } from 'vitest';

import { JobAbort } from '../../../src/jobs/types';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { slackSpec } from '../../../src/scanner/runtime/connectors';
import type { ScanJob } from '../../../src/scanner/runtime/jobs';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import type { SkillRunner } from '../../../src/scanner/types';
import { ScriptedSkillRunner, type Script } from '../runtime/helpers/scripted-runner';
import { PROFILE } from '../runtime/helpers/world';

const NOW = '2026-11-06T15:00:00.000Z';
const cover: Script = async (api) => {
  const w = api.input.window!;
  const scope = api.input.context.scope.scope;
  const refs = scope === 'inbox' ? ['search:dm', 'search:mentions', 'search:mine'] : [`search:${scope}`];
  await api.call('cc_report_coverage', { windows: refs.map((ref) => ({ ref, from: w.from, to: w.to })) });
  await api.call('cc_finish', { cursor: { value: `${Math.floor(Date.parse(w.to) / 1000)}.000000`, at: w.to }, complete: true });
};
const job = (scope: string, from: string, to: string, id = `${scope}:${from}`): ScanJob => ({ kind: 'scan', id, connector: 'slack', scope, window: { from, to }, mode: 'backfill', trigger: 'catch_up', priority: 40, runAt: NOW, dedupeKey: id });
const spec = () => slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined });

describe('connector health recovery (HEALTH-1)', () => {
  it('a restarted worker writes ok on its first success: a Degraded connector does not stay Degraded', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    // The previous worker process left the connector Degraded.
    await store.recordHealth('slack', { state: 'degraded', errorClass: 'config', detail: 'Channel scans: prompt over the size limit', checkedAt: NOW });
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(cover), specs: [spec()], clock, reevaluate: async () => {} });
    const out = await runtime.executeJob(job('inbox', '2026-11-06T13:00:00.000Z', '2026-11-06T15:00:00.000Z'));
    expect(out.status).toBe('succeeded');
    expect(store.latestHealth('slack')).toMatchObject({ state: 'ok' });
  });

  it('stays Degraded while another scope keeps failing, and recovers once it succeeds', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    let channelBroken = true;
    const script: Script = async (api) => {
      if (channelBroken && api.input.context.scope.scope.startsWith('channel:')) return; // no cc_finish: a failed run
      await cover(api);
    };
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(script), specs: [spec()], clock, reevaluate: async () => {} });
    expect((await runtime.executeJob(job('channel:C0PLACEHOLD', '2026-11-05T15:00:00.000Z', '2026-11-06T15:00:00.000Z'))).status).toBe('failed');
    expect(store.latestHealth('slack')).toMatchObject({ state: 'degraded', detail: 'Channel scans: a run stopped before finishing' });
    await runtime.executeJob(job('inbox', '2026-11-06T13:00:00.000Z', '2026-11-06T15:00:00.000Z'));
    expect(store.latestHealth('slack')?.state).toBe('degraded'); // the channel scope is still failing
    channelBroken = false;
    await runtime.executeJob(job('channel:C0PLACEHOLD', '2026-11-05T15:00:00.000Z', '2026-11-06T15:00:00.000Z', 'again'));
    expect(store.latestHealth('slack')).toMatchObject({ state: 'ok' });
  });
});

describe('worker-initiated aborts (SHUT-1)', () => {
  /** A run that blocks until it is aborted, then reports what the real runner reports. */
  const waitsForAbort: SkillRunner = {
    run: (input) =>
      new Promise((resolve) => {
        const done = () => resolve({ ok: false, costUsd: 0.002, inputTokens: 1200, outputTokens: 80, turns: 1, error: { message: 'aborted by caller', errorClass: 'transient' } } as never);
        if (input.signal.aborted) done();
        else input.signal.addEventListener('abort', done, { once: true });
      }),
  } as SkillRunner;

  it.each(['shutdown', 'cancel', 'lease_lost'] as const)('a %s abort cancels the run without touching connector health', async (reason) => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const runtime = new ScannerRuntime({ store, runner: waitsForAbort, specs: [spec()], clock, reevaluate: async () => {} });
    const ac = new AbortController();
    const p = runtime.executeJob(job('inbox', '2026-11-06T13:00:00.000Z', '2026-11-06T15:00:00.000Z'), ac.signal);
    setTimeout(() => ac.abort(new JobAbort(reason, 'test')), 5);
    const out = await p;
    expect(out).toMatchObject({ status: 'skipped', followUps: [] });
    expect(out.detail).toMatch(/^cancelled: worker/);
    expect(store.latestHealth('slack')).toBeUndefined(); // before: degraded, "transient / timeout"
    expect(runtime.status().find((s) => s.scope === 'inbox')?.failures ?? 0).toBe(0);
  });

  it('a job timeout is still a failure', async () => {
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const runtime = new ScannerRuntime({ store, runner: waitsForAbort, specs: [spec()], clock, reevaluate: async () => {} });
    const ac = new AbortController();
    const p = runtime.executeJob(job('inbox', '2026-11-06T13:00:00.000Z', '2026-11-06T15:00:00.000Z'), ac.signal);
    setTimeout(() => ac.abort(new JobAbort('timeout', '600s')), 5);
    expect((await p).status).toBe('failed');
    expect(store.latestHealth('slack')?.state).toBe('degraded');
  });
});
