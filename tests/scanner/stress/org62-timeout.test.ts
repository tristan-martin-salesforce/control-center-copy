/** ORG-2 (placeholders only): a paged Org62 run gets a longer watchdog than the runner's 3-minute default. */
import { describe, expect, it, vi } from 'vitest';

import { AgentSdkSkillRunner } from '../../../src/llm/skill-runner';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { org62Spec } from '../../../src/scanner/runtime/connectors';
import type { ScanJob } from '../../../src/scanner/runtime/jobs';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import type { SkillRunInput, SkillRunner } from '../../../src/scanner/types';
import { PROFILE } from '../runtime/helpers/world';

const NOW = '2026-11-06T15:00:00.000Z';

describe('Org62 run watchdog (ORG-2)', () => {
  it('paged scopes get 8 minutes; the sweep keeps the default', () => {
    const s = org62Spec({ mcpServers: () => ({}) });
    for (const scope of ['events', 'opps', 'dcs', 'book']) expect(s.timeoutMs!(scope, 'backfill')).toBe(8 * 60_000);
    expect(s.timeoutMs!('missed_opps', 'backfill')).toBe(180_000);
  });

  it('the runtime hands the scope watchdog to the runner', async () => {
    const seen: SkillRunInput[] = [];
    const runner: SkillRunner = { run: async (input) => (seen.push(input), { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, error: { message: 'x', errorClass: 'unknown' } }) as never };
    const clock = new FakeClock(NOW);
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), hardCapUsd: 50, softCapUsd: 2 });
    const runtime = new ScannerRuntime({ store, runner, specs: [org62Spec({ mcpServers: () => ({}) })], clock, reevaluate: async () => {} });
    const job: ScanJob = { kind: 'scan', id: 'e1', connector: 'org62', scope: 'events', window: { from: '2026-10-23T15:00:00.000Z', to: '2026-10-30T15:00:00.000Z' }, mode: 'backfill', trigger: 'catch_up', priority: 40, runAt: NOW, dedupeKey: 'e1' };
    await runtime.executeJob(job);
    expect(seen[0]!.timeoutMs).toBe(8 * 60_000);
  });

  it('the runner watchdog uses the run input, else its own default', async () => {
    const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
    const ctx = await store.getContext({ connector: 'org62', scope: 'events' });
    const w = { from: '2026-10-23T15:00:00.000Z', to: '2026-10-30T15:00:00.000Z' };
    const { runId } = await store.startRun({ scope: { connector: 'org62', scope: 'events' }, trigger: 'catch_up', window: w });
    // A run that never ends: one assistant turn, then the stream hangs until it is aborted.
    const hang = (({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        yield { type: 'system', subtype: 'init', mcp_servers: [], tools: [] } as never;
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      })()) as never;
    const runner = new AgentSdkSkillRunner({ queryFn: hang, timeoutMs: 60_000 });
    // the watchdog on a fake clock: 50 ms of it ends the run (the 60 s default would leave it pending), whatever the load
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const run = runner.run({ skillPath: 'skills/scan-org62.md', model: 'claude-haiku-5-5', mcpServers: {}, allowedTools: [], runId, context: ctx, maxTurns: 5, costCapUsd: 0.05, timeoutMs: 50, signal: new AbortController().signal, window: w, mode: 'backfill' }, store).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const r = await run;
      expect(r.error?.message).toMatch(/watchdog: run exceeded 50 ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});
