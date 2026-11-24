/**
 * LIVE smoke test (skipped unless CC_LIVE=1): runs scan-slack over today's inbox (DMs, @mentions, my
 * messages) with Haiku through the real Agent SDK, the real restricted Slack MCP server (OAuth reused
 * from the user's Claude config), the real cc tools, and the in-memory store. Read-only.
 *
 *   CC_LIVE=1 CC_LIVE_SLACK_ID=<your U… id> npx vitest run tests/scanner/runtime/live-smoke.test.ts
 *
 * Prints numbers only (cost, turns, counts); message content never leaves process memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSdkSkillRunner, type RunnerLogEvent } from '../../../src/llm/skill-runner';
import { slackSpec } from '../../../src/scanner/runtime/connectors';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';

const live = process.env.CC_LIVE === '1';

describe.skipIf(!live)('LIVE: scan-slack today with Haiku', () => {
  it('runs the real path to a committed cursor', async () => {
    const slackId = process.env.CC_LIVE_SLACK_ID;
    expect(slackId, 'set CC_LIVE_SLACK_ID').toBeTruthy();
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const window = { from: midnight.toISOString(), to: now.toISOString() };
    const store = new InMemoryScannerStore({ profile: { me: { userId: 'user_live', name: process.env.CC_LIVE_ME_NAME ?? 'ME', slackId }, watchList: [], aliases: { accounts: [], channels: [] } } });
    const events: RunnerLogEvent[] = [];
    const runner = new AgentSdkSkillRunner({ logger: (e) => events.push(e), timeoutMs: 280_000 });
    const runtime = new ScannerRuntime({ store, runner, specs: [slackSpec({ chunkMs: 24 * 3600_000, costCapUsd: () => 0.15, maxTurns: () => 40 })], reevaluate: async () => {} });
    const outcomes = await runtime.runScope({ connector: 'slack', scope: 'inbox' }, 'manual', window);
    const runs = store.listRuns({ connector: 'slack', scope: 'inbox' });
    const report = {
      window,
      outcomes: outcomes.map((o) => ({ status: o.status, errorClass: o.errorClass, costUsd: o.costUsd, detail: o.status === 'succeeded' ? undefined : o.detail })),
      runs: runs.map((r) => ({ status: r.status, stats: r.stats, error: r.error?.slice(0, 160) })),
      counts: store.counts(),
      evidenceRoles: store.allEvidence().reduce<Record<string, number>>((a, e) => ((a[e.role] = (a[e.role] ?? 0) + 1), a), {}),
      workItems: store.listWorkItems().reduce<Record<string, number>>((a, w) => ((a[`${w.kind}:${w.landedAs}`] = (a[`${w.kind}:${w.landedAs}`] ?? 0) + 1), a), {}),
      ledger: store.ledger({ connector: 'slack', scope: 'inbox' }).map((l) => ({ kind: l.object.kind, ref: l.object.ref, outcome: l.outcome })),
      cursorAt: (await store.getCursor({ connector: 'slack', scope: 'inbox' }))?.at,
      toolCalls: events.filter((e) => e.event === 'tool').reduce<Record<string, number>>((a, e) => ((a[e.tool!] = (a[e.tool!] ?? 0) + 1), a), {}),
      errors: events.filter((e) => e.event === 'error' || e.event === 'denied').map((e) => ({ code: e.code, tool: e.tool })),
    };
    // Numbers and ids only. Written outside the repo for the builder's notes.
    const out = process.env.CC_LIVE_REPORT;
    if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ outcomes: report.outcomes, runs: report.runs.map((r) => ({ status: r.status, turns: r.stats?.turns, costUsd: r.stats?.costUsd })), counts: report.counts, cursorAt: report.cursorAt, errors: report.errors }));
    expect(outcomes.every((o) => o.status === 'succeeded')).toBe(true);
    expect(report.cursorAt).toBe(window.to);
  }, 300_000);
});
