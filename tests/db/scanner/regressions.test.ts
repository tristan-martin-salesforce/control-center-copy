/**
 * Regression tests for the stress-campaign fixes (docs/archive/2026-build/STRESS.md). Placeholder fixtures only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertReadTool, type GoogleTools } from '../../../src/connectors/google/client';
import { CalendarFetcher } from '../../../src/connectors/google/calendar';
import { GmailFetcher } from '../../../src/connectors/google/gmail';
import { DeferredSkillRunner, pgReevaluateEnqueuer } from '../../../src/jobs/scan';
import { AgentSdkSkillRunner, prefixTripwireLimit } from '../../../src/llm/skill-runner';
import { renderContextPack, renderPrefetched } from '../../../src/llm/skill-loader';
import { DEFAULT_CADENCE, intervalMs } from '../../../src/scanner/runtime/cadence';
import { deterministicSpec, slackSpec } from '../../../src/scanner/runtime/connectors';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { scanJob, type RuntimeJob } from '../../../src/scanner/runtime/jobs';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { Reconciler } from '../../../src/scanner/reconcile/reconciler';
import { DbScannerStore } from '../../../src/scanner/store-db';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import type { ConnectorHealthProbe, DeterministicFetcher, NormalizedSourceItem, SkillRunner } from '../../../src/scanner/types';
import { loadProfileIntoDb, PLACEHOLDER_PROFILE } from '../../../scripts/stress/lib/profile';
import { fakeQuery, type Step } from '../../scanner/runtime/helpers/fake-query';
import { makeWorld, PROFILE } from '../../scanner/runtime/helpers/world';

import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

const ME = { email: 'me@example.com', name: 'ME' };
const signal = new AbortController().signal;

/** A placeholder Gmail backend: `n` messages, one per minute from `t0`, in the tool's text formats. */
function fakeGmail(n: number, t0: number, opts: { subject?: (i: number) => string; from?: string } = {}): GoogleTools {
  const msgs = Array.from({ length: n }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}`, t: t0 + i * 60_000 }));
  return {
    async call(tool: string, args: Record<string, unknown>) {
      assertReadTool(tool);
      if (tool === 'search_gmail_messages') {
        const q = String(args.query);
        const a = Number(q.match(/after:(\d+)/)?.[1]) * 1000;
        const b = Number(q.match(/before:(\d+)/)?.[1]) * 1000;
        const hits = msgs.filter((m) => m.t >= a && m.t < b).sort((x, y) => y.t - x.t); // newest first, like Gmail
        return hits.length ? `Found ${hits.length} messages:\n\n${hits.map((m) => `Message ID: ${m.id}\nWeb Link: https://mail.example.com/${m.id}\nThread ID: t${m.id}\n`).join('\n')}` : 'No messages found';
      }
      if (tool === 'get_gmail_messages_content_batch') {
        const ids = args.message_ids as string[];
        return `Retrieved ${ids.length} messages:\n\n${ids
          .map((id) => {
            const m = msgs.find((x) => x.id === id)!;
            const i = msgs.indexOf(m);
            return `Message ID: ${id}\nSubject: ${opts.subject?.(i) ?? `PLACEHOLDER question ${i}`}\nFrom: ${opts.from ?? 'Person A <person_a@example.com>'}\nTo: ME <me@example.com>\nDate: ${new Date(m.t).toUTCString()}\n\n--- BODY ---\ncan you send the ACME deck? ${'x'.repeat(50)}\n`;
          })
          .join('\n---\n\n')}`;
      }
      if (tool === 'get_gmail_threads_content_batch') return '';
      if (tool === 'get_events') return 'No events found';
      throw new Error(`no route ${tool}`);
    },
    async health(): Promise<ConnectorHealthProbe> {
      return { state: 'ok', checkedAt: new Date().toISOString() };
    },
  };
}

describe('G-1: an incomplete Gmail run resumes inside its own window', () => {
  it('a past window with more unseen messages than the limit does not jump to the scope’s latest epoch', async () => {
    const t0 = Date.parse('2026-10-20T15:00:00.000Z');
    const now = new Date('2026-10-26T12:00:00.000Z');
    const f = new GmailFetcher({ google: fakeGmail(30, t0), me: ME, clock: () => now });
    // The live cursor (e.g. a cold-start head run) has seen far later mail.
    const live = { value: JSON.stringify({ lastEpoch: Math.floor(Date.parse('2026-10-26T11:59:00.000Z') / 1000), seen: {} }), at: '2026-10-26T12:00:00.000Z' };
    const window = { from: '2026-10-20T14:00:00.000Z', to: '2026-10-20T20:00:00.000Z' };
    const r = await f.fetch('inbox', live, window, { signal, limit: 25 });
    expect(r.complete).toBe(false);
    expect(r.items).toHaveLength(25);
    // Resumes after the 25th oldest message (index 24), not at the window end or the live epoch.
    expect(r.nextCursor.at).toBe(new Date(t0 + 24 * 60_000).toISOString());
  });
});

describe('G-3: prefetched items no longer trip the prefix tripwire', () => {
  const items: NormalizedSourceItem[] = Array.from({ length: 25 }, (_, i) => ({
    connector: 'gmail',
    kind: 'email',
    externalId: `m${i}`,
    dedupeKey: `gmail:m${i}`,
    contentHash: `h${i}`,
    occurredAt: '2026-10-20T15:00:00.000Z',
    title: `PLACEHOLDER subject ${i}`,
    excerpt: 'y'.repeat(1200),
    payload: { bodyNew: 'b'.repeat(2400), bodyFull: 'f'.repeat(4000), snippet: 's'.repeat(200), urls: Array.from({ length: 15 }, (_, k) => `https://example.com/${k}`), bulk: i % 5 === 0 },
  }));

  it('renders one compact body per email', () => {
    const block = renderPrefetched(items);
    expect(block.length).toBeLessThan(25 * 2800);
    expect(block).not.toContain('y'.repeat(100)); // excerpt not repeated next to bodyNew
  });

  it('the tripwire budget includes the prefetched payload; a bloated fixed prefix still trips', async () => {
    const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
    const ctx = await store.getContext({ connector: 'gmail', scope: 'inbox' });
    const { runId } = await store.startRun({ scope: { connector: 'gmail', scope: 'inbox' }, trigger: 'catch_up', window: { from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T00:00:00.000Z' } });
    const base = { skillPath: 'skills/scan-gmail.md', model: 'claude-haiku-5-5', mcpServers: {}, allowedTools: [], runId, context: ctx, maxTurns: 10, costCapUsd: 0.05, signal, window: { from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T00:00:00.000Z' }, mode: 'backfill' };
    const blockTokens = Math.ceil(renderPrefetched(items).length / 2);
    const first = (t: number): Step => ({ usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: t } });
    const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [first(20_000 + blockTokens)] }, { toolResults: [] }) }).run({ ...base, prefetched: items }, store);
    expect(r.error?.message ?? '').not.toMatch(/prefix tripwire/);
    const { runId: r2 } = await store.startRun({ scope: { connector: 'gmail', scope: 'inbox' }, trigger: 'catch_up', window: base.window });
    const bad = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [first(50_000)] }, { toolResults: [] }) }).run({ ...base, runId: r2 }, store);
    expect(bad.error?.message).toMatch(/prefix tripwire/);
  });

  it('TRIP-1: a ~34 K fixed prefix (Calendar with a real-sized context pack) plus a small payload does not trip', async () => {
    const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
    const ctx = await store.getContext({ connector: 'calendar', scope: 'primary' });
    const w = { from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T00:00:00.000Z' };
    const { runId } = await store.startRun({ scope: { connector: 'calendar', scope: 'primary' }, trigger: 'catch_up', window: w });
    const few = items.slice(0, 2);
    const payloadTokens = Math.ceil(renderPrefetched(few).length / 2.07); // as measured on event JSON
    const first: Step = { usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 34_300 + payloadTokens } };
    const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [first] }, { toolResults: [] }) }).run(
      { skillPath: 'skills/scan-calendar.md', model: 'claude-haiku-5-5', mcpServers: {}, allowedTools: [], runId, context: ctx, maxTurns: 10, costCapUsd: 0.05, signal, window: w, mode: 'backfill', prefetched: few },
      store,
    );
    expect(r.error?.message ?? '').not.toMatch(/prefix tripwire/);
  });

  it('CTX-1: a real-sized list (pack past the typical size) does not trip; the pack drops fetcher cursors and caps initiatives', async () => {
    const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
    const base = await store.getContext({ connector: 'claude_sessions', scope: 'all' });
    const w = { from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T00:00:00.000Z' };
    // 60 open items and 30 initiatives with placeholder text, and an 8 K fetcher cursor (Claude sessions on a real machine).
    const ctx = {
      ...base,
      cursor: { value: JSON.stringify({ files: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`/placeholder/projects/p${i}/session-${i}.jsonl`, { o: 123456 + i, i: 98765 + i }])) }), at: w.from },
      openItems: Array.from({ length: 60 }, (_, i) => ({
        workItemId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        kind: 'task' as const,
        state: 'open' as const,
        title: `PLACEHOLDER item ${i} `.padEnd(90, 'x'),
        purpose: 'p'.repeat(140),
        people: ['Person A', 'Person B', 'U0PLACEHOLD'],
        accounts: ['ACME'],
        keywords: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
        threadRefs: ['C0PLACEHOLD:1793800000.000100'],
        fileRefs: [],
        lastEvidenceAt: w.to,
      })),
      initiatives: Array.from({ length: 30 }, (_, i) => ({ initiativeId: `ini${i}`, title: `PLACEHOLDER initiative ${i}`, purpose: 'q'.repeat(140), people: [], accounts: [], keywords: [] })),
    } as unknown as typeof base;
    const pack = renderContextPack(ctx);
    expect(pack).not.toContain('/placeholder/projects/'); // the fetcher state is not shown to the agent
    expect(JSON.parse(pack)).toMatchObject({ initiativesTruncated: 5 });
    expect(pack.length).toBeGreaterThan(35_000); // so the run below (34.3 K + excess) is over the old flat 40 K limit
    const { runId } = await store.startRun({ scope: { connector: 'claude_sessions', scope: 'all' }, trigger: 'schedule', window: w });
    const input = { skillPath: 'skills/scan-claude-sessions.md', model: 'claude-haiku-5-5', mcpServers: {}, allowedTools: [], runId, context: ctx, maxTurns: 10, costCapUsd: 0.05, signal, window: w, mode: 'incremental' as const };
    // 34 K for skill + tools + a typical pack, plus this pack's excess at about 2.1 characters per token.
    const real: Step = { usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 34_300 + Math.ceil((pack.length - 20_000) / 2.1) } };
    const ok = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [real] }, { toolResults: [] }) }).run(input, store);
    expect(ok.error?.message ?? '').not.toMatch(/prefix tripwire/);
    // A real blow-up (tens of thousands of extra tokens of tool schemas) still trips.
    const { runId: r2 } = await store.startRun({ scope: { connector: 'claude_sessions', scope: 'all' }, trigger: 'schedule', window: w });
    const bloated: Step = { usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 34_300 + Math.ceil((pack.length - 20_000) / 2.1) + 30_000 } };
    const bad = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [bloated] }, { toolResults: [] }) }).run({ ...input, runId: r2 }, store);
    expect(bad.error?.message).toMatch(/prefix tripwire/);
  });

  /**
   * TRIP-2: every shipped scan skill, with a real user's list (60 open items, 25 initiatives, 40 accounts, a long fetcher
   * cursor) and a full payload, stays under its own tripwire, and a failed restricted config (every MCP tool loaded)
   * still trips. The first prompt is modelled from what the runner really sends, with the live measurements at their
   * dense end: about 19 K hidden tokens (SDK prompt + tool schemas), prose at 3 and JSON data at 2 characters per token.
   */
  describe('TRIP-2: shipped skills fit their own tripwire', () => {
    const HIDDEN_TOKENS = 19_000;
    const w = { from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T00:00:00.000Z' };
    const cases: Array<{ connector: 'slack' | 'org62' | 'gmail' | 'calendar' | 'claude_sessions' | 'drive' | 'gemini_notes' | 'trainings'; scope: string; skill: string; payload: number }> = [
      { connector: 'slack', scope: 'inbox', skill: 'skills/scan-slack.md', payload: 0 },
      { connector: 'slack', scope: 'channel:C0PLACEHOLD', skill: 'skills/scan-slack.md', payload: 0 },
      { connector: 'org62', scope: 'events', skill: 'skills/scan-org62.md', payload: 0 },
      { connector: 'gmail', scope: 'inbox', skill: 'skills/scan-gmail.md', payload: 25 },
      { connector: 'calendar', scope: 'primary', skill: 'skills/scan-calendar.md', payload: 25 },
      { connector: 'claude_sessions', scope: 'all', skill: 'skills/scan-claude-sessions.md', payload: 25 },
      { connector: 'drive', scope: 'tracked', skill: 'skills/scan-drive.md', payload: 15 },
      { connector: 'gemini_notes', scope: 'poll', skill: 'skills/scan-gemini-notes.md', payload: 25 },
      { connector: 'trainings', scope: 'gmail', skill: 'skills/scan-trainings.md', payload: 25 },
    ];
    const bigContext = (base: Awaited<ReturnType<InMemoryScannerStore['getContext']>>) =>
      ({
        ...base,
        cursor: { value: JSON.stringify({ files: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`/placeholder/p${i}.jsonl`, { o: 123456 + i }])) }), at: w.from },
        openItems: Array.from({ length: 60 }, (_, i) => ({ workItemId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'task', state: 'open', title: `PLACEHOLDER item ${i} `.padEnd(90, 'x'), purpose: 'p'.repeat(140), people: ['Person A', 'Person B', 'U0PLACEHOLD'], accounts: ['ACME'], keywords: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'], threadRefs: ['C0PLACEHOLD:1793800000.000100'], fileRefs: ['1PlaceholderFileId000000000'], lastEvidenceAt: w.to })),
        initiatives: Array.from({ length: 25 }, (_, i) => ({ initiativeId: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`, title: `PLACEHOLDER initiative ${i}`, purpose: 'q'.repeat(140), people: ['Person A'], accounts: ['ACME'], keywords: ['alpha', 'beta'] })),
        aliases: { accounts: Array.from({ length: 40 }, (_, i) => ({ accountId: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`, names: [`PLACEHOLDER Account ${i}, Inc.`, `org62:001PLACEHOLDER${String(i).padStart(4, '0')}`] })), channels: [] },
      }) as unknown as typeof base;

    for (const c of cases) {
      it(`${c.skill} (${c.connector}:${c.scope})`, async () => {
        const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
        const ctx = bigContext(await store.getContext({ connector: c.connector, scope: c.scope }));
        const prefetched = items.slice(0, c.payload).map((it) => ({ ...it, connector: c.connector }));
        const input = { skillPath: c.skill, model: 'claude-haiku-5-5', mcpServers: {}, allowedTools: [], context: ctx, maxTurns: 10, costCapUsd: 0.05, signal, window: w, mode: 'backfill' as const, ...(prefetched.length ? { prefetched } : {}) };
        const run = async (tokens: number) => {
          const { runId } = await store.startRun({ scope: { connector: c.connector, scope: c.scope }, trigger: 'catch_up', window: w });
          const seen: { options?: { systemPrompt?: unknown }; prompt?: unknown; toolResults: string[] } = { toolResults: [] };
          const r = await new AgentSdkSkillRunner({ queryFn: fakeQuery({ steps: [{ usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: tokens } }] }, seen as never) }).run({ ...input, runId }, store);
          const sp = (Array.isArray(seen.options?.systemPrompt) ? seen.options!.systemPrompt : [String(seen.options?.systemPrompt ?? '')]) as string[];
          const proseChars = sp[0]!.length;
          const sent = { proseChars, dataChars: sp.reduce((a, x) => a + x.length, 0) - proseChars + String(seen.prompt ?? '').length };
          return { r, sent };
        };
        const { sent } = await run(1_000);
        const real = HIDDEN_TOKENS + Math.ceil(sent.proseChars / 3 + sent.dataChars / 2);
        expect(real, 'modelled first prompt').toBeLessThan(prefixTripwireLimit(sent) - 5_000);
        const ok = await run(real);
        expect(ok.r.error?.message ?? '').not.toMatch(/prefix tripwire/);
        // The restricted single-server config failed: every MCP server's tools load (tens of thousands of tokens).
        const blown = await run(real + 45_000);
        expect(blown.r.error?.message).toMatch(/prefix tripwire/);
      });
    }
  });

  it('CAL-1: a deterministic cost-cap / tripwire failure retries the same window with half the items (no time-split cascade)', async () => {
    const limits: number[] = [];
    const fetcher: DeterministicFetcher = {
      connector: 'calendar',
      scopes: async () => ['primary'],
      health: async () => ({ state: 'ok', checkedAt: new Date().toISOString() }),
      fetch: async (_s, _c, w, o) => {
        limits.push(o.limit ?? -1);
        return { items: [items[1]!], coverage: [{ kind: 'calendar_range', ref: 'primary', from: w.from, to: w.to }], nextCursor: { value: '1', at: w.to }, complete: true };
      },
    };
    const runner: SkillRunner = { run: async () => ({ ok: false, costUsd: 0.1, inputTokens: 1200, outputTokens: 80, turns: 1, error: { message: 'cost cap exceeded (SDK maxBudgetUsd)', errorClass: 'config' } }) };
    const clock = new FakeClock('2026-10-21T00:00:00.000Z');
    const rt = new ScannerRuntime({ store: new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) }), runner, specs: [deterministicSpec(fetcher)], clock, reevaluate: async () => undefined });
    let job: RuntimeJob | undefined = scanJob({ connector: 'calendar', scope: 'primary', window: { from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T00:00:00.000Z' }, mode: 'backfill', trigger: 'catch_up', runAt: clock.now().toISOString() });
    let runs = 0;
    while (job && runs < 20) {
      const out = await rt.executeJob(job);
      runs += 1;
      expect(out.followUps.length).toBeLessThanOrEqual(1);
      job = out.followUps[0];
      if (job?.kind === 'scan') expect(job.window).toEqual({ from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T00:00:00.000Z' });
    }
    expect(limits).toEqual([25, 12, 6, 3, 1]);
    expect(runs).toBe(5);
  });
});

describe('F-1: a deterministic run that ended without cc_finish retries with fewer items', () => {
  it('halves the items instead of retrying the same oversized batch', async () => {
    const fetcher: DeterministicFetcher = {
      connector: 'gmail',
      scopes: async () => ['inbox'],
      health: async () => ({ state: 'ok', checkedAt: new Date().toISOString() }),
      fetch: async (_s, _c, w) => ({ items: [{ connector: 'gmail', kind: 'email', externalId: 'e1', dedupeKey: 'gmail:e1', contentHash: 'h', occurredAt: w.from }], coverage: [{ kind: 'mailbox_range', ref: 'gmail:inbox', from: w.from, to: w.to }], nextCursor: { value: '1', at: w.to }, complete: true }),
    };
    const runner: SkillRunner = { run: async () => ({ ok: false, costUsd: 0.003, inputTokens: 1200, outputTokens: 80, turns: 6, error: { message: 'run ended without cc_finish', errorClass: 'unknown' } }) };
    const clock = new FakeClock('2026-10-21T00:00:00.000Z');
    const rt = new ScannerRuntime({ store: new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) }), runner, specs: [deterministicSpec(fetcher)], clock, reevaluate: async () => undefined });
    const out = await rt.executeJob(scanJob({ connector: 'gmail', scope: 'inbox', window: { from: '2026-10-20T12:00:00.000Z', to: '2026-10-21T00:00:00.000Z' }, mode: 'backfill', trigger: 'catch_up', runAt: clock.now().toISOString() }));
    expect(out.followUps).toHaveLength(1);
    expect(out.followUps[0]!.kind === 'scan' && out.followUps[0].vars?.maxItems).toBe('12');
  });
});

describe('SLK-1: the Slack inbox backfills in 2 h chunks (busy 6 h windows were not triaged)', () => {
  it('a cold start plans the inbox lookback in windows of at most 2 h; channels keep 6 h', async () => {
    const clock = new FakeClock('2026-10-22T16:00:00.000Z');
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
    const runner: SkillRunner = { run: async () => ({ ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }) };
    const rt = new ScannerRuntime({ store, runner, specs: [slackSpec()], clock, reevaluate: async () => undefined });
    const jobs = (await rt.planJobs(clock.now())).filter((j): j is ReturnType<typeof scanJob> => j.kind === 'scan');
    const span = (j: ReturnType<typeof scanJob>) => Date.parse(j.window.to) - Date.parse(j.window.from);
    const inbox = jobs.filter((j) => j.scope === 'inbox' && j.mode === 'backfill');
    expect(inbox.length).toBeGreaterThan(0);
    expect(Math.max(...inbox.map(span))).toBeLessThanOrEqual(2 * 3600_000);
    expect(slackSpec().chunkMsFor?.('channel:C0PLACE01')).toBe(6 * 3600_000);
  });
});

describe('THR-1: a run that made no progress gets one delayed retry, then the chain ends', () => {
  it('stops the chain instead of re-reading the same window forever', async () => {
    const runner: SkillRunner = {
      run: async (input, store) => {
        const w = input.window!;
        await store.reportCoverage(input.runId, [{ kind: 'query_window', ref: 'thread', from: w.from, to: w.from }]);
        return { ok: true, costUsd: 0.003, inputTokens: 1200, outputTokens: 80, turns: 3, proposedCursor: { value: 'x', at: w.from }, complete: false };
      },
    };
    const clock = new FakeClock('2026-10-22T06:30:00.000Z');
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
    // Hermetic: the real spec reads the slack MCP server from ~/.claude config and throws ("not declared") on a machine
    // without it, so the run failed before the runner and no retry was planned (THR-1 failed on HEAD off the owner's Mac).
    const spec = slackSpec({ mcpServers: () => ({}) });
    const rt = new ScannerRuntime({ store, runner, specs: [spec], clock, reevaluate: async () => undefined });
    const w = { from: '2026-10-21T17:59:40.000Z', to: '2026-10-22T06:22:00.000Z' };
    const first = await rt.executeJob(scanJob({ connector: 'slack', scope: 'thread:D0PLACE01:1.1', window: w, mode: 'targeted', trigger: 'reconcile', runAt: clock.now().toISOString() }));
    expect(first.followUps).toHaveLength(1); // a stalled run gets one delayed retry of the rest
    expect(first.followUps[0]).toMatchObject({ mode: 'retry', window: { from: w.from, to: w.to } });
    expect(Date.parse(first.followUps[0]!.runAt) - clock.now().getTime()).toBe(30 * 60_000);
    const again = await rt.executeJob(first.followUps[0]! as ReturnType<typeof scanJob>);
    expect(again.status).toBe('succeeded');
    expect(again.followUps).toHaveLength(0); // the retry stalled too: the chain ends (reconcile finds the hole)
  });
});

describe('CUR-1 / LOOP-1: long fetcher cursors and windows that always fail', () => {
  const longCursorFetcher = (cursorChars: number): DeterministicFetcher => ({
    connector: 'claude_sessions',
    scopes: async () => ['all'],
    health: async () => ({ state: 'ok', checkedAt: new Date().toISOString() }),
    fetch: async (_s, _c, w) => ({
      items: [{ connector: 'claude_sessions', kind: 'claude_session', externalId: 's1', dedupeKey: 'claude:s1', contentHash: 'h', occurredAt: w.from }],
      coverage: [{ kind: 'session', ref: 'claude:registry', from: w.from, to: w.to }],
      nextCursor: { value: JSON.stringify({ files: { 'placeholder/session.jsonl': 'x'.repeat(cursorChars) } }), at: w.to },
      complete: true,
    }),
  });

  it('CUR-1: the agent gets a short header cursor when the fetcher cursor is long; the worker commits the real one', async () => {
    let seen: Record<string, unknown> | undefined;
    const runner: SkillRunner = {
      run: async (input, store) => {
        seen = (input as { vars?: Record<string, unknown> }).vars;
        const w = input.window!;
        await store.reportCoverage(input.runId, [{ kind: 'session', ref: 'claude:registry', from: w.from, to: w.to }]);
        return { ok: true, costUsd: 0.001, inputTokens: 1200, outputTokens: 80, turns: 2, proposedCursor: { value: String(seen?.['header.cursor.value']), at: w.to }, complete: true };
      },
    };
    const clock = new FakeClock('2026-11-04T00:00:00.000Z');
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
    const rt = new ScannerRuntime({ store, runner, specs: [deterministicSpec(longCursorFetcher(400))], clock, reevaluate: async () => undefined });
    const out = await rt.executeJob(scanJob({ connector: 'claude_sessions', scope: 'all', window: { from: '2026-11-03T12:00:00.000Z', to: '2026-11-04T00:00:00.000Z' }, mode: 'backfill', trigger: 'catch_up', runAt: clock.now().toISOString() }));
    expect(out.status).toBe('succeeded');
    expect(String(seen?.['header.cursor.value']).length).toBeLessThanOrEqual(200); // fits cc_finish's cursor.value
    const committed = await store.getCursor({ connector: 'claude_sessions', scope: 'all' });
    expect(committed?.value.length).toBeGreaterThan(400); // the fetcher's own cursor, not the stand-in
  });

  it('LOOP-1: a scope that keeps giving up on a window backs off (30 min doubling, capped at 6 h)', async () => {
    const { stuckDelayMs } = await import('../../../src/scanner/runtime/scanner-runtime');
    const MIN = 60_000;
    expect(stuckDelayMs(1)).toBe(30 * MIN);
    expect(stuckDelayMs(4)).toBe(30 * MIN);
    expect(stuckDelayMs(5)).toBe(60 * MIN);
    expect(stuckDelayMs(9)).toBe(120 * MIN);
    expect(stuckDelayMs(40)).toBe(360 * MIN);
  });
});

describe('CAL-1: Calendar honors the per-run item limit', () => {
  it('emits the events nearest to now first and the rest on later polls', async () => {
    const now = new Date('2026-10-22T16:00:00.000Z');
    const evs = Array.from({ length: 40 }, (_, i) => {
      const s = new Date(Date.parse('2026-10-21T00:00:00.000Z') + i * 3 * 3600_000);
      const e = new Date(s.getTime() + 30 * 60_000);
      return `- "PLACEHOLDER meeting ${i}" (Starts: ${s.toISOString()}, Ends: ${e.toISOString()})\n  ID: ev${i} | Link: https://cal.example.com/ev${i}\n  Attendee Details:\n    me@example.com: accepted\n`;
    });
    const google: GoogleTools = { call: async () => evs.join(''), health: async () => ({ state: 'ok', checkedAt: now.toISOString() }) };
    const f = new CalendarFetcher({ google, me: ME, clock: () => now });
    const w = { from: '2026-10-22T15:00:00.000Z', to: now.toISOString() };
    const r1 = await f.fetch('primary', null, w, { signal, limit: 25 });
    expect(r1.items).toHaveLength(25);
    expect(r1.complete).toBe(false);
    const r2 = await f.fetch('primary', r1.nextCursor, w, { signal, limit: 25 });
    const ids = new Set([...r1.items, ...r2.items].map((i) => i.externalId));
    expect(ids.size).toBe([...r1.items, ...r2.items].length); // no event emitted twice
    expect(r2.items.length).toBeGreaterThan(0);
    const r3 = await f.fetch('primary', r2.nextCursor, w, { signal, limit: 25 });
    expect(r3.items).toHaveLength(0);
    expect(r3.complete).toBe(true);
  });
});

describe('B-1 / B-2: catch-up follows its plan; paused windows are retried', () => {
  const finishWindow = async (api: { input: { window?: { from: string; to: string } }; call: (n: string, a: unknown) => Promise<unknown> }) => {
    const w = api.input.window!;
    await api.call('cc_report_coverage', { windows: [{ kind: 'query_window', ref: 'search:dm', from: w.from, to: w.to }] });
    await api.call('cc_finish', { cursor: { value: 'x', at: w.to }, complete: true });
  };

  it('a cold start is still catching up after its head hour, until the lookback backfill is done', async () => {
    const { runtime } = makeWorld({ now: '2026-11-04T17:00:00.000Z', script: finishWindow as never });
    const plan = (await runtime.planJobs()).filter((j) => j.kind === 'scan');
    expect(plan[0]!.kind === 'scan' && plan[0].mode).toBe('head');
    await runtime.executeJob(plan[0]!);
    expect(runtime.isCatchingUp('slack')).toBe(true); // before the fix: released here (the head set the cursor to now)
    expect((await runtime.catchUpProgress()).slack).toBeLessThan(100);
    for (const j of plan.slice(1)) await runtime.executeJob(j);
    expect(runtime.isCatchingUp('slack')).toBe(false);
  });

  it('a backfill window paused at the budget cap is retried at the next budget day, a paused poll is not', async () => {
    const { runtime, store } = makeWorld({ now: '2026-11-04T17:00:00.000Z', script: finishWindow as never, hardCapUsd: 0.01 });
    await store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 0.02, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    await runtime.planJobs();
    const backfill = scanJob({ connector: 'slack', scope: 'inbox', window: { from: '2026-11-03T17:00:00.000Z', to: '2026-11-03T23:00:00.000Z' }, mode: 'backfill', trigger: 'catch_up', runAt: '2026-11-04T17:00:00.000Z' });
    const out = await runtime.executeJob(backfill);
    expect(out.status).toBe('paused');
    expect(out.retryAt).toBe('2026-11-05T07:01:00.000Z'); // 00:01 America/Denver
    const poll = await runtime.executeJob(scanJob({ connector: 'slack', scope: 'inbox', window: { from: '2026-11-04T16:58:00.000Z', to: '2026-11-04T17:00:00.000Z' }, mode: 'incremental', trigger: 'schedule', runAt: '2026-11-04T17:00:00.000Z' }));
    expect(poll.retryAt).toBeUndefined();
  });
});

describe('CAD-1: slow cadences are capped and stay incremental', () => {
  it('off-hours and quiet backoff never push a poller past 4 h, or a daily source past a day', () => {
    const night = new Date('2026-11-01T09:00:00.000Z'); // Sunday 02:00 Denver
    expect(intervalMs(DEFAULT_CADENCE, 'trainings', 'gmail', night, 3)).toBe(24 * 3600_000); // was 6 × 8 days
    expect(intervalMs(DEFAULT_CADENCE, 'org62', 'dcs', night, 3)).toBe(4 * 3600_000); // was 48 h
    expect(intervalMs(DEFAULT_CADENCE, 'org62', 'missed_opps', night, 0)).toBe(24 * 3600_000); // was 6 days
    expect(intervalMs(DEFAULT_CADENCE, 'slack', 'inbox', night, 3)).toBe(96 * 60_000); // unchanged
  });

  it('a regular off-hours poll after a > 1 h interval is incremental, not a catch-up', async () => {
    const finishWindow = async (api: { input: { window?: { from: string; to: string } }; call: (n: string, a: unknown) => Promise<unknown> }) => {
      const w = api.input.window!;
      await api.call('cc_report_coverage', { windows: [{ kind: 'query_window', ref: 'search:dm', from: w.from, to: w.to }] });
      await api.call('cc_finish', { cursor: { value: 'x', at: w.to }, complete: true });
    };
    const { runtime, clock } = makeWorld({ now: '2026-10-31T06:00:00.000Z', script: finishWindow as never }); // Sat 00:00 Denver
    for (const j of await runtime.planJobs()) await runtime.executeJob(j);
    let catchUps = 0;
    let polls = 0;
    for (let i = 0; i < 40; i++) {
      clock.advance(10 * 60_000);
      const jobs = (await runtime.planJobs()).filter((j) => j.kind === 'scan');
      polls += jobs.length;
      catchUps += jobs.filter((j) => j.kind === 'scan' && (j.mode === 'head' || j.mode === 'backfill')).length;
      for (const j of jobs) await runtime.executeJob(j);
    }
    expect(polls).toBeGreaterThan(0);
    expect(catchUps).toBe(0);
    expect(runtime.isCatchingUp()).toBe(false);
  });
});

describe('R-1 / R-2 / R-3 / BUD-1: reconcile', () => {
  it('R-1: calendar reconcile listing is identity-only (an in-progress multi-day event is not "uncovered")', async () => {
    const google: GoogleTools = {
      call: async (tool) => {
        if (tool === 'get_events') return '- "PLACEHOLDER offsite" (Starts: 2026-10-26, Ends: 2026-10-30)\n  ID: ev1 | Link: https://cal.example.com/ev1\n';
        throw new Error(tool);
      },
      health: async () => ({ state: 'ok', checkedAt: new Date().toISOString() }),
    };
    const f = new CalendarFetcher({ google, me: ME, clock: () => new Date('2026-10-28T12:00:00.000Z') });
    const listed = await f.listForReconcile('primary', { from: '2026-10-21T12:00:00.000Z', to: '2026-10-28T12:00:00.000Z' }, { signal });
    expect(listed).toEqual([{ kind: 'calendar_range', ref: 'event:ev1', from: '2026-10-26T00:00:00.000Z' }]);
  });

  it('R-2/R-3: only objects inside [first scan, cursor] are gaps, and they get ONE targeted job', async () => {
    const clock = new FakeClock('2026-10-28T12:00:00.000Z');
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
    const key = { connector: 'gmail' as const, scope: 'inbox' };
    const { runId } = await store.startRun({ scope: key, trigger: 'catch_up', window: { from: '2026-10-26T00:00:00.000Z', to: '2026-10-28T00:00:00.000Z' } });
    await store.reportCoverage(runId, [{ kind: 'mailbox_range', ref: 'gmail:inbox', from: '2026-10-26T00:00:00.000Z', to: '2026-10-28T00:00:00.000Z' }]);
    await store.finishRun(runId, { cursor: { value: '1', at: '2026-10-28T00:00:00.000Z' }, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
    const fetcher: DeterministicFetcher = {
      connector: 'gmail',
      scopes: async () => ['inbox'],
      health: async () => ({ state: 'ok', checkedAt: clock.now().toISOString() }),
      fetch: async () => {
        throw new Error('not used');
      },
      listForReconcile: async (_s, w) =>
        [
          { kind: 'email' as const, ref: 'before-first-scan', from: '2026-10-22T10:00:00.000Z' },
          { kind: 'email' as const, ref: 'missed-1', from: '2026-10-27T09:00:00.000Z' },
          { kind: 'email' as const, ref: 'missed-2', from: '2026-10-27T15:00:00.000Z' },
          { kind: 'email' as const, ref: 'after-cursor', from: '2026-10-28T06:00:00.000Z' },
        ].filter((o) => Date.parse(o.from) >= Date.parse(w.from) - 60_000 && Date.parse(o.from) <= Date.parse(w.to)),
    };
    const rec = new Reconciler({ store, runner: new DeferredSkillRunner(), clock, specs: [deterministicSpec(fetcher)] });
    const report = await rec.run({ kind: 'reconcile', id: 'r', passes: ['coverage_gaps'], trigger: 'reconcile', priority: 20, runAt: clock.now().toISOString(), dedupeKey: 'r' }, signal);
    expect(report.findings.map((f) => f.detail).sort()).toEqual(['uncovered email missed-1', 'uncovered email missed-2']);
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0]!.kind === 'scan' && report.jobs[0].window).toEqual({ from: '2026-10-27T08:59:00.000Z', to: '2026-10-27T15:01:00.000Z' });
  });

  it('BUD-1: the unlinked pass never calls the LLM at the hard cap', async () => {
    const clock = new FakeClock('2026-10-28T12:00:00.000Z');
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
    const key = { connector: 'gmail' as const, scope: 'inbox' };
    const { runId } = await store.startRun({ scope: key, trigger: 'schedule', window: { from: '2026-10-28T11:00:00.000Z', to: '2026-10-28T12:00:00.000Z' } });
    const [r] = await store.recordSourceItems(runId, [{ connector: 'gmail', kind: 'email', externalId: 'x1', dedupeKey: 'gmail:x1', contentHash: 'h', occurredAt: '2026-10-28T11:30:00.000Z' }]);
    await store.flagUnlinked(runId, { sourceItemId: r!.sourceItemId, reason: 'PLACEHOLDER relevant FYI about ACME' });
    let calls = 0;
    const runner: SkillRunner = { run: async () => ((calls += 1), { ok: true, costUsd: 0.01, inputTokens: 1200, outputTokens: 80, turns: 1 }) };
    const fetcher = { connector: 'gmail', scopes: async () => ['inbox'], health: async () => ({ state: 'ok', checkedAt: '' }), fetch: async () => ({ items: [], coverage: [], nextCursor: { value: '', at: '' }, complete: true }) } as unknown as DeterministicFetcher;
    const rec = new Reconciler({ store, runner, clock, specs: [deterministicSpec(fetcher)], llmAllowed: async () => false });
    const report = await rec.run({ kind: 'reconcile', id: 'r', passes: ['unlinked'], trigger: 'reconcile', priority: 20, runAt: clock.now().toISOString(), dedupeKey: 'r' }, signal);
    expect(calls).toBe(0);
    expect(report.findings.some((f) => /hard cap/.test(f.detail))).toBe(true);
  });
});

describe('D-1: relink with the LLM off is a no-op, not a failed run', () => {
  it('returns ok without touching the store', async () => {
    const r = await new DeferredSkillRunner().run({ mode: 'relink' } as never, {} as never);
    expect(r.ok).toBe(true);
  });
});

describe.skipIf(!pgAvailable())('RE-1: re-evaluation jobs carry the catch-up flag', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await provisionTestDb('reeval');
  });
  afterAll(async () => t?.drop());

  it('payload has catching_up and trigger', async () => {
    const userId = await loadProfileIntoDb(t.handle.db, PLACEHOLDER_PROFILE);
    const store = new DbScannerStore({ db: t.handle.db, userId });
    const key = { connector: 'slack' as const, scope: 'inbox' };
    const w = { from: '2026-10-28T11:00:00.000Z', to: '2026-10-28T12:00:00.000Z' };
    const { runId } = await store.startRun({ scope: key, trigger: 'catch_up', window: w });
    const [r] = await store.recordSourceItems(runId, [{ connector: 'slack', kind: 'message', externalId: 'C0ACME001:1.1', dedupeKey: 'slack:C0ACME001:1.1', contentHash: 'h', occurredAt: w.from, excerpt: 'can you send the deck?' }]);
    const { workItemId } = await store.proposeItem(runId, { kind: 'ask', title: 'Send PLACEHOLDER deck to PERSON_A', evidence: [{ sourceItemId: r!.sourceItemId, role: 'origin', reason: 'direct ask' }], confidence: 'sure' });
    await pgReevaluateEnqueuer(t.handle.db, userId)([workItemId], { runId, connector: 'slack', catchingUp: true, trigger: 'catch_up' });
    const j = await t.handle.db.execute<{ p: Record<string, unknown> }>(sql`select payload as p from jobs where kind = 'reevaluate' and payload->>'run_id' = ${runId}`);
    expect(j.rows[0]!.p).toMatchObject({ work_item_id: workItemId, catching_up: true, trigger: 'catch_up' });
  });
});
