/**
 * The FTI path end to end through the real ScannerRuntime (the worker's tick, in memory, no network, no model): a
 * first scan of the Slack inbox over the placeholder corpus, fetched by code through a fake relay runtime and
 * interpreted by a scripted classifier. Items are produced, coverage commits the cursor, every relay read and
 * classifier call is a `pass` row with its tokens (the D0 ledger guard runs after each test), the first scan reports
 * progress per source on the run's outcome event, and what FTI does not cover goes to the agentic fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { slackSpec } from '@/scanner/runtime/connectors';
import { FirstScan, MemoryFirstScanLedger } from '@/scanner/runtime/first-scan';
import { ftiTraversalOverrides } from '@/scanner/runtime/fti-specs';
import { SIGNAL_CADENCE } from '@/scanner/runtime/cadence';
import { ScannerRuntime } from '@/scanner/runtime/scanner-runtime';
import type { RuntimeJob } from '@/scanner/runtime/jobs';
import { fallbackReason, FtiSkillRunner } from '@/scanner/interpret';
import { MemoryTraceSink, setTraceSink } from '@/scanner/trace';
import type { SkillRunner } from '@/scanner/types';
import type { ScanSkillRunInput } from '@/llm/skill-runner';

import { corpusRelay, corpusStore, loadCorpus, scriptedClassifier } from './helpers';

const corpus = loadCorpus();
const NOW = '2026-11-06T18:00:00.000Z';

const fallbackCalls: string[] = [];
const fallback: SkillRunner = {
  async run(input) {
    fallbackCalls.push(`${input.context.scope.connector}:${input.context.scope.scope}:${(input as ScanSkillRunInput).mode}`);
    return { ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, proposedCursor: { value: 'x', at: input.window?.to ?? NOW }, complete: true, counts: { recorded: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, coverage: 0 } };
  },
};

let sink: MemoryTraceSink;
beforeEach(() => {
  sink = new MemoryTraceSink();
  setTraceSink(sink);
  fallbackCalls.length = 0;
});
afterEach(() => {
  setTraceSink(null);
});

function runtime(o: { firstScan?: boolean } = {}) {
  const store = corpusStore(corpus, NOW);
  const relay = corpusRelay(corpus);
  const runner = new FtiSkillRunner({ fallback, runtimeFor: (c) => (c === 'slack' ? relay : null), model: scriptedClassifier });
  const ledger = new MemoryFirstScanLedger();
  const rt = new ScannerRuntime({
    store,
    runner,
    specs: [slackSpec({ ...ftiTraversalOverrides('slack'), scopes: () => ['inbox'] })],
    reevaluate: async () => undefined,
    clock: { now: () => new Date(NOW), sleep: async () => undefined } as never,
    cadence: SIGNAL_CADENCE,
    firstScan: o.firstScan ? new FirstScan({ lookbackDays: 8, budgetUsd: 5, connectors: ['slack'] }, ledger) : null,
  });
  return { store, relay, rt, ledger };
}

async function drain(rt: ScannerRuntime, jobs: RuntimeJob[]) {
  const done: string[] = [];
  const queue = [...jobs];
  while (queue.length) {
    const j = queue.shift()!;
    const out = await rt.executeJob(j);
    done.push(out.status);
    queue.push(...out.followUps);
  }
  return done;
}

describe('a first scan through FTI (the worker tick, in memory)', () => {
  it('fetches by code, interprets in batches, proposes items and commits the cursor', async () => {
    const { store, relay, rt, ledger } = runtime({ firstScan: true });
    const jobs = await rt.planJobs(new Date(NOW));
    expect(jobs.length).toBeGreaterThan(1); // day-sized first-scan chunks, oldest first
    const statuses = await drain(rt, jobs);
    expect(statuses.every((s) => s === 'succeeded')).toBe(true);
    expect(fallbackCalls).toEqual([]);
    // every read was a fixed relay search; nothing went through an agent
    expect(new Set(relay.calls.map((c) => c.tool))).toEqual(new Set(['slack_search_public_and_private', 'slack_read_thread']));
    const titles = store.listWorkItems().map((w) => w.title);
    expect(titles.some((t) => /GLOBEX sizing sheet/.test(t))).toBe(true);
    expect(titles.some((t) => /ACME demo deck/.test(t))).toBe(true);
    expect(titles.some((t) => /pricing slide/.test(t))).toBe(true);
    expect(titles.some((t) => /desktop app/i.test(t))).toBe(true);
    expect(titles.some((t) => /thanks/i.test(t))).toBe(false); // a rule settled it
    expect(await store.getCursor({ connector: 'slack', scope: 'inbox' })).not.toBeNull();
    // progress per source, in the ledger and on the runs' outcome events
    const fs = ledger.state!.sources!.slack!;
    expect(fs.read).toBeGreaterThan(5);
    expect(fs.found).toBeGreaterThanOrEqual(4);
    const lines = sink.events.filter((e) => e.kind === 'outcome' && (e.payload as { firstScan?: { line?: string } }).firstScan).map((e) => (e.payload as { firstScan: { line: string } }).firstScan.line);
    expect(lines.at(-1)).toMatch(/^Slack: \d+ messages read, \d+ asks? found, \$\d+\.\d\d so far$/);
  });

  it('books one pass row per relay read and per classifier call, with tokens and the measurement', async () => {
    const { rt } = runtime({ firstScan: true });
    await drain(rt, await rt.planJobs(new Date(NOW)));
    const passes = sink.events.filter((e) => e.kind === 'pass').map((e) => e.payload as { pass: string; costUsd: number; inputTokens: number; contentHash: string; m: { itemsIn?: number; firstPromptTokens?: number; itemsDecidedByRules?: number } });
    expect(passes.some((p) => p.pass === 'fetch:relay:slack:slack_search_public_and_private')).toBe(true);
    const classify = passes.filter((p) => p.pass === 'classify:classify-items');
    expect(classify.length).toBeGreaterThan(0);
    for (const p of passes) {
      expect(p.costUsd).toBeGreaterThan(0);
      expect(p.inputTokens).toBeGreaterThan(0);
      expect(p.contentHash).toMatch(/^[0-9a-f]{32}$/);
    }
    for (const p of classify) expect(p.m.itemsIn).toBeGreaterThan(0);
    expect(classify.some((p) => typeof p.m.itemsDecidedByRules === 'number')).toBe(true);
  });
});

describe('what FTI hands to the agentic runner', () => {
  const input = (o: Partial<ScanSkillRunInput> & { connector?: string; scope?: string; me?: Record<string, string> }): ScanSkillRunInput => ({ skillPath: 'skills/scan-slack.md', model: 'm', mcpServers: {}, allowedTools: [], runId: 'r', maxTurns: 1, costCapUsd: 0.1, signal: new AbortController().signal, ...o, context: { scope: { connector: (o.connector ?? 'slack') as never, scope: o.scope ?? 'inbox' }, cursor: null, gaps: [], me: { userId: 'u', name: 'ME', slackId: 'U0ME00001', org62UserId: '005XX0000000001AAA', ...(o.me ?? {}) }, watchList: [], aliases: { accounts: [], channels: [] }, openItems: [], initiatives: [], skillVersion: 'x' } }) as ScanSkillRunInput;
  const o = { runtimeFor: (c: string) => (c === 'slack' || c === 'org62' ? ({} as never) : null) };
  it('relink, skill-upgrade dry runs, passes, Org62 book, sources it does not interpret, a missing id or runtime', () => {
    expect(fallbackReason(input({}), o)).toBeNull();
    expect(fallbackReason(input({ mode: 'relink' }), o)).toBe('relink');
    expect(fallbackReason(input({ instruction: 'Skill upgrade dry run (a → b): re-read the window' }), o)).toBe('skill_upgrade');
    expect(fallbackReason(input({ pass: 'triage' }), o)).toBe('pass');
    expect(fallbackReason(input({ connector: 'org62', scope: 'book' }), o)).toBe('scope_not_fetched');
    expect(fallbackReason(input({ connector: 'org62', scope: 'events' }), o)).toBeNull();
    expect(fallbackReason(input({ connector: 'calendar', scope: 'primary', prefetched: [] }), o)).toBe('not_interpreted');
    expect(fallbackReason(input({ connector: 'gmail', scope: 'inbox', prefetched: [] }), o)).toBeNull();
    expect(fallbackReason(input({ me: { slackId: '' } }), o)).toBe('scope_not_fetched');
    expect(fallbackReason(input({}), { runtimeFor: () => null })).toBe('no_runtime');
  });
});
