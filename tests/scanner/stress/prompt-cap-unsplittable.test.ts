/**
 * W0-7 (wave-0 review): a prompt cap on a window that cannot be split (an inbox poll under 10 minutes) is never
 * retried identically forever. Second identical failure: the same window once, in half-size pages. Third: the scope
 * pauses with a plain Health line and a DATA.PROMPT_CAP event; a manual Rescan still runs. Fake runner, placeholders.
 */
import { describe, expect, it } from 'vitest';

import { FakeClock } from '../../../src/scanner/runtime/clock';
import { slackSpec } from '../../../src/scanner/runtime/connectors';
import { scanJob, type ScanJob } from '../../../src/scanner/runtime/jobs';
import { ScannerRuntime, type RuntimeLogEvent } from '../../../src/scanner/runtime/scanner-runtime';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import type { ConnectorHealthProbe, SkillRunInput, SkillRunner } from '../../../src/scanner/types';
import { PROFILE } from '../runtime/helpers/world';

const NOW = '2026-11-06T15:00:00.000Z';
const W = { from: '2026-11-06T14:55:00.000Z', to: '2026-11-06T15:00:00.000Z' }; // 5 minutes: no split left

function world() {
  const seen: SkillRunInput[] = [];
  const runner: SkillRunner = {
    run: async (input) => {
      seen.push(input);
      return { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, error: { message: 'prompt cap: the next request would be about 120000 tokens, past the 100000-token long-prompt tier', errorClass: 'config' } } as never;
    },
  };
  const clock = new FakeClock(NOW);
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
  const health: Array<{ connector: string; probe: ConnectorHealthProbe }> = [];
  const recordHealth = store.recordHealth.bind(store);
  store.recordHealth = async (connector, probe) => (health.push({ connector, probe }), recordHealth(connector, probe));
  const events: RuntimeLogEvent[] = [];
  const runtime = new ScannerRuntime({ store, runner, specs: [slackSpec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {}, log: (e) => events.push(e) });
  return { runtime, seen, health, events, clock };
}

const poll = (mode: ScanJob['mode'] = 'incremental', trigger: ScanJob['trigger'] = 'schedule'): ScanJob =>
  scanJob({ connector: 'slack', scope: 'inbox', window: W, mode, trigger, runAt: NOW });

describe('prompt cap with no split left (W0-7)', () => {
  it('1st: plain failure; 2nd: one run in half-size pages; 3rd: paused with Health + DATA.PROMPT_CAP; then no runs until a Rescan', async () => {
    const { runtime, seen, health, events } = world();

    const first = await runtime.executeJob(poll());
    expect(first.status).toBe('failed');
    expect(first.followUps).toHaveLength(0);
    expect(first.detail).toContain('too large to read in one request');
    expect(first.detail).not.toContain('was split');

    const second = await runtime.executeJob(poll());
    expect(second.detail).toContain('half-size pages');
    expect(second.followUps).toHaveLength(1);
    const degraded = second.followUps[0] as ScanJob;
    expect(degraded).toMatchObject({ kind: 'scan', mode: 'retry', window: W });
    expect(degraded.instruction).toMatch(/limit: 10/);
    expect(degraded.vars?.['scan.pageScale']).toBe('0.5');

    const third = await runtime.executeJob(degraded);
    expect(seen.at(-1)!.instruction).toMatch(/half the usual page sizes/); // the runner got the smaller pages
    expect(third.status).toBe('failed');
    expect(third.followUps).toHaveLength(0);
    expect(third.detail).toMatch(/too large to read, even in smaller pages; paused .*Report this/);
    expect(events.find((e) => e.event === 'paused' && e.code === 'DATA.PROMPT_CAP')).toMatchObject({ connector: 'slack', scope: 'inbox' });
    expect(health.at(-1)).toMatchObject({ connector: 'slack', probe: { state: 'degraded' } });
    expect(health.at(-1)!.probe.detail).toContain('Slack inbox: one message set is too large to read');

    // paused: a scheduled poll does not run the model again
    const runs = seen.length;
    const fourth = await runtime.executeJob(poll());
    expect(fourth.status).toBe('paused');
    expect(seen.length).toBe(runs);
    const planned = await runtime.planJobs(new Date(Date.parse(NOW) + 60 * 60_000));
    expect(planned.filter((j) => j.kind === 'scan' && j.connector === 'slack' && j.scope === 'inbox')).toHaveLength(0);

    // a manual Rescan still runs (and would lift the pause on success)
    await runtime.executeJob(poll('manual', 'manual'));
    expect(seen.length).toBe(runs + 1);
  });

  it('a different window start counts afresh (not the same failure)', async () => {
    const { runtime } = world();
    await runtime.executeJob(poll());
    const other = scanJob({ connector: 'slack', scope: 'inbox', window: { from: '2026-11-06T14:56:00.000Z', to: W.to }, mode: 'incremental', trigger: 'schedule', runAt: NOW });
    const r = await runtime.executeJob(other);
    expect(r.followUps).toHaveLength(0);
    expect(r.detail).not.toContain('half-size pages');
  });
});
