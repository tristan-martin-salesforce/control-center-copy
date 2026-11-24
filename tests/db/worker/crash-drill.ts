/**
 * The crash-resume drill's shared harness (tests/db/worker/crash-resume.test.ts and the child it kills,
 * crash-child.ts). One Gmail-like source over Postgres, read in pages, interpreted by a fake classifier that books its
 * calls the way the fetch-then-interpret runner does (one `pass` trace row per call, the run's spend at its end) and
 * proposes one item per new message. Placeholder data only; no network, no model.
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CanUseTool, HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { Db } from '@/db/client';
import { createDefaultRegistry } from '@/jobs';
import { FtiSkillRunner, type ClassifierModel } from '@/scanner/interpret';
import { FakeClock } from '@/scanner/runtime/clock';
import { scanJob } from '@/scanner/runtime/jobs';
import type { ScanSkillRunResult } from '@/scanner/runtime/contract-ext';
import { DbScannerStore } from '@/scanner/store-db';
import { flushTrace, trace } from '@/scanner/trace';
import type { CoverageObject, Cursor, DeterministicFetcher, FetchResult, NormalizedSourceItem, ScannerStore, SkillRunner, TimeWindow } from '@/scanner/types';
import { AgentSdkSkillRunner, type QueryFn, type ScanSkillRunInput } from '@/llm/skill-runner';
import { estimateCallCostUsd } from '@/llm/models';
import { NullNotifier } from '@/worker/notify';
import { WorkerRuntime } from '@/worker/runtime';
import { buildScanning } from '@/worker/scanning';

export const H = 3_600_000;
/** The drill's "now" and the window the killed scan reads: three pages of two messages. */
export const NOW = Date.parse('2026-11-18T18:00:00.000Z');
export const T0 = NOW - 3 * H;
export const PAGE_SIZE = 2;
export const CALL_USD = 0.01;
export const MODEL = 'claude-haiku-5-5';

export const iso = (ms: number) => new Date(ms).toISOString();
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** Six placeholder messages in [T0, NOW): 25 min apart from T0 + 10 min. */
export function drillItems(): NormalizedSourceItem[] {
  return Array.from({ length: 6 }, (_, i) => {
    const at = iso(T0 + 10 * 60_000 + i * 25 * 60_000);
    return {
      connector: 'gmail' as const,
      kind: 'email' as const,
      externalId: `drill-msg-${i + 1}`,
      dedupeKey: `gmail:drill-msg-${i + 1}`,
      contentHash: hash(`drill-msg-${i + 1}`),
      occurredAt: at,
      title: `Placeholder request ${i + 1}`,
      excerpt: `Could you send the example deck ${i + 1}?`,
      author: { name: 'Example Person', email: 'person@example.com', isMe: false, isExternal: true },
      threadRef: `gmail-thread:drill-${i + 1}`,
    };
  });
}

/** Where the drill kills the worker (see crash-resume.test.ts). */
export type DrillPoint = 'run_started' | 'items_staged' | 'llm_spent' | 'finish_tx' | 'after_commit' | 'job_complete' | 'sdk_turn';

/** A fault hook: `kill(point, page)` ends the process when this is the configured point and page. */
export type Fault = (point: DrillPoint, page: number) => void;
export const noFault: Fault = () => undefined;

/** SIGKILL this process at `point` on `page` (the child). Nothing is flushed: that is the drill. */
export function killAt(point: DrillPoint | undefined, page: number): Fault {
  return (p, n) => {
    if (point && p === point && n === page) process.kill(process.pid, 'SIGKILL');
  };
}

/** A paged mail source: at most PAGE_SIZE messages per call, `complete: false` while more remain in the window. */
export class PagedMailFetcher implements DeterministicFetcher {
  readonly connector = 'gmail' as const;
  calls = 0;
  constructor(
    private readonly items: NormalizedSourceItem[],
    private readonly fault: Fault = noFault,
  ) {}
  async scopes() {
    return ['inbox'];
  }
  async health() {
    return { state: 'ok' as const, checkedAt: new Date(NOW).toISOString() };
  }
  /** The page a window starts on (1-based), from the messages before it. */
  pageOf(window: TimeWindow): number {
    const from = Date.parse(window.from);
    return Math.floor(this.items.filter((x) => Date.parse(x.occurredAt) < from && Date.parse(x.occurredAt) >= T0).length / PAGE_SIZE) + 1;
  }
  async fetch(scope: string, _c: Cursor | null, window: TimeWindow): Promise<FetchResult> {
    this.calls += 1;
    this.fault('run_started', this.pageOf(window));
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    const inWin = this.items.filter((x) => Date.parse(x.occurredAt) >= from && Date.parse(x.occurredAt) < to).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const page = inWin.slice(0, PAGE_SIZE);
    const complete = inWin.length <= PAGE_SIZE;
    const at = complete ? window.to : iso(Date.parse(page.at(-1)!.occurredAt) + 1);
    const coverage: CoverageObject[] = [{ kind: 'mailbox_range', ref: `gmail:${scope}`, from: window.from, to: at }];
    return { items: page, coverage, nextCursor: { value: JSON.stringify({ at }), at }, complete };
  }
}

/**
 * The fake classifier: records the page, books one `pass` trace row per new message (flushed at once, as the FTI
 * runner should; its real rows reach the database within the trace sink's 500 ms), proposes one ask per message and
 * links the first page's first message to the standing item (one link, so a lost re-evaluation shows). The run's spend is the sum of its calls (booked by the
 * runtime at the end, split over the pass rows).
 */
export class DrillClassifier implements SkillRunner {
  constructor(
    private readonly o: { standingItemId: string; pageOf: (w: TimeWindow) => number; fault?: Fault; failAfterCalls?: number },
  ) {}
  async run(input: ScanSkillRunInput, store: ScannerStore): Promise<ScanSkillRunResult> {
    const zero = { ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 } as ScanSkillRunResult;
    if (!input.prefetched) return zero;
    const page = this.o.pageOf(input.window!);
    const fault = this.o.fault ?? noFault;
    const rec = await store.recordSourceItems(input.runId, input.prefetched);
    fault('items_staged', page);
    if (input.preReportedCoverage?.length) await store.reportCoverage(input.runId, input.preReportedCoverage);
    let cost = 0;
    let calls = 0;
    let proposed = 0;
    let linked = 0;
    // like the FTI runner: an unchanged message an earlier run already judged is not sent again (`seen_decided`)
    const prior = (await store.triageVerdicts?.(rec.map((r) => r.sourceItemId))) ?? new Map();
    const judged: Array<{ sourceItemId: string; v: 'act' }> = [];
    for (const [i, r] of rec.entries()) {
      if (!r.isNew && !r.changed && prior.has(r.sourceItemId)) continue;
      if (this.o.failAfterCalls != null && calls >= this.o.failAfterCalls) {
        return { ok: false, costUsd: cost, inputTokens: calls * 100, outputTokens: calls * 10, cacheReadTokens: 0, cacheWriteTokens: 0, turns: calls, error: { message: 'classifier: the model call failed (overloaded)', errorClass: 'transient' } };
      }
      // one classifier call: its pass row is in the database before the next step
      trace(input.runId, 'pass', { pass: 'classify:classify-items', mode: input.mode ?? 'incremental', model: MODEL, ok: true, costUsd: CALL_USD, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contentHash: hash(`call:${r.sourceItemId}`), turns: 1 });
      await flushTrace();
      cost = Math.round((cost + CALL_USD) * 1e6) / 1e6;
      calls += 1;
      fault('llm_spent', page);
      const it = input.prefetched.find((x) => x.dedupeKey === r.dedupeKey)!;
      await store.proposeItem(input.runId, { kind: 'ask', title: `Send ${it.title}`, confidence: 'likely', evidence: [{ sourceItemId: r.sourceItemId, role: 'origin', reason: 'drill: an ask' }] });
      proposed += 1;
      judged.push({ sourceItemId: r.sourceItemId, v: 'act' });
      if (page === 1 && i === 0) {
        await store.linkEvidence(input.runId, { workItemId: this.o.standingItemId, sourceItemId: r.sourceItemId, role: 'context', confidence: 'likely', reason: 'drill: same customer' });
        linked += 1;
      }
    }
    // verdicts last, as FTI saves them: a run killed before this point leaves its messages unjudged (read again)
    if (judged.length) await store.recordTriageVerdicts?.(judged);
    return {
      ok: true,
      costUsd: cost,
      inputTokens: calls * 100,
      outputTokens: calls * 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: calls,
      counts: { recorded: rec.length, new: rec.filter((r) => r.isNew).length, changed: rec.filter((r) => r.changed).length, linked, proposed, unlinked: 0, coverage: input.preReportedCoverage?.length ?? 0 },
      ...(calls ? { usage: [{ model: MODEL, inputTokens: calls * 100, outputTokens: calls * 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost }] } : {}),
    };
  }
}

/**
 * The real fetch-then-interpret runner (src/scanner/interpret/runner.ts) over the same pages, with a fake classifier:
 * each page is two paid calls (the first leaves the page's second message below the confidence floor, so a second
 * look follows), one ask per message. The fault `llm_spent` fires as the second look starts: the first call has
 * returned, been paid and (with the eager `pass` rows) traced; nothing of the page is applied yet.
 */
export function drillFtiRunner(fault: Fault = noFault): SkillRunner {
  const items = drillItems();
  const pageOfRef = (ref: string) => Math.floor(items.findIndex((x) => x.externalId === ref) / PAGE_SIZE) + 1;
  const model: ClassifierModel = async (req) => {
    const refs = [...req.user.matchAll(/^### \[([^\]]+)\]/gm)].map((m) => m[1]!);
    const second = /second look/.test(req.user);
    if (second && refs.length) fault('llm_spent', pageOfRef(refs[0]!));
    const verdicts = refs.map((ref, i) => {
      const it = items.find((x) => x.externalId === ref);
      return { ref, v: 'ask', kind: 'ask', title: `Send ${it?.title ?? ref}`, who: 'Example Person', cite: 'send the example deck', conf: !second && i === 1 ? 0.4 : 0.9, why: 'an ask of me' };
    });
    return { ok: true, text: JSON.stringify({ verdicts }), costUsd: CALL_USD, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
  };
  const fallback: SkillRunner = { run: async () => ({ ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, error: { message: 'drill: no agent' } }) };
  return new FtiSkillRunner({ fallback, runtimeFor: () => null, model, modelId: MODEL });
}

/** One agent turn's usage (what the fake SDK reports per assistant message): $0.0003 on Haiku. */
export const TURN_USAGE = { input_tokens: 2000, output_tokens: 200 };
export const TURN_USD = estimateCallCostUsd(MODEL, TURN_USAGE);
/** The agentic drill's page: propose each message (the first page also links its first to the standing item), finish. */
export const turnsOfPage = (page: number) => (page === 1 ? 4 : 3);
/** The agentic drill kills on page 2 here: after its second turn's usage reached the runner, before that turn's tool. */
export const SDK_KILL_TURN = 2;

/**
 * The real Agent SDK runner (src/llm/skill-runner.ts) over the same pages, with a fake SDK in place of the CLI (as in
 * tests/llm/spend/pause.test.ts): one assistant message per turn with its usage block, the PreToolUse hook and the
 * canUseTool gate before each tool, the cc tools over the in-process MCP server, a result message at the end. The
 * fault `sdk_turn` fires on resuming after the runner took turn SDK_KILL_TURN's message (its usage seen, the tool not
 * run): the session loop is mid-query, its end `pass` row not traced.
 */
export function drillAgentRunner(standingItemId: string, fault: Fault = noFault): SkillRunner {
  const items = drillItems();
  const pageOfRef = (ref: string) => Math.floor(items.findIndex((x) => x.externalId === ref) / PAGE_SIZE) + 1;
  const queryFn: QueryFn = ({ prompt, options }) => {
    const gen = async function* (): AsyncGenerator<SDKMessage> {
      const signal = options.abortController!.signal;
      const cc = (options.mcpServers as Record<string, { instance: { connect: (t: unknown) => Promise<void> } }>).cc!.instance;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await cc.connect(st);
      const client = new Client({ name: 'drill-cli', version: '1' });
      await client.connect(ct);
      const block = prompt.split('## Prefetched items')[1]?.split('\n')[1] ?? '[]';
      const rows = JSON.parse(block) as Array<{ sourceItemId: string; externalId: string; title: string }>;
      // the header cursor's end and completeness (the worker commits its own cursor; the echo only has to be valid)
      const finish = /"at":"([^"]+)"\}, complete=(true|false)/.exec(prompt);
      const page = rows.length ? pageOfRef(rows[0]!.externalId) : 0;
      const steps: Array<{ tool: string; input: Record<string, unknown> }> = [];
      for (const [i, r] of rows.entries()) {
        steps.push({ tool: 'mcp__cc__cc_propose_item', input: { kind: 'ask', title: `Send ${r.title}`, confidence: 'likely', evidence: [{ sourceItemId: r.sourceItemId, role: 'origin', reason: 'drill: an ask' }] } });
        if (page === 1 && i === 0) steps.push({ tool: 'mcp__cc__cc_link_evidence', input: { workItemId: standingItemId, sourceItemId: r.sourceItemId, role: 'context', confidence: 'likely', reason: 'drill: same customer' } });
      }
      steps.push({ tool: 'mcp__cc__cc_finish', input: { cursor: { value: 'drill-header', at: finish?.[1] ?? iso(NOW) }, complete: finish?.[2] !== 'false' } });
      yield { type: 'system', subtype: 'init', mcp_servers: [], tools: steps.map((x) => x.tool) } as unknown as SDKMessage;
      let n = 0;
      try {
        for (const st of steps) {
          if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          n += 1;
          yield { type: 'assistant', message: { id: `msg_${n}`, model: options.model, content: [{ type: 'tool_use', id: `tu_${n}`, name: st.tool, input: st.input }], usage: TURN_USAGE } } as unknown as SDKMessage;
          if (n === SDK_KILL_TURN) fault('sdk_turn', page);
          const pre = options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
          await pre({ hook_event_name: 'PreToolUse', tool_name: st.tool, tool_input: st.input, tool_use_id: `tu_${n}`, session_id: 's', transcript_path: '', cwd: '' } as never, `tu_${n}`, { signal });
          const gate = (await (options.canUseTool as CanUseTool)(st.tool, st.input, { signal, toolUseID: `tu_${n}` } as never)) as { behavior: string; interrupt?: boolean };
          if (gate.behavior === 'deny') {
            if (gate.interrupt) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            continue;
          }
          const out = await client.callTool({ name: st.tool.slice('mcp__cc__'.length), arguments: st.input });
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_${n}`, content: out.content, is_error: !!out.isError }] } } as unknown as SDKMessage;
        }
        // the CLI prices the same usage blocks: its total is the turns' sum
        yield { type: 'result', subtype: 'success', is_error: false, num_turns: n, result: 'DONE', total_cost_usd: Math.round(n * TURN_USD * 1e6) / 1e6, usage: { input_tokens: n * TURN_USAGE.input_tokens, output_tokens: n * TURN_USAGE.output_tokens }, modelUsage: {}, permission_denials: [] } as unknown as SDKMessage;
      } finally {
        await client.close();
      }
    };
    return gen();
  };
  return new AgentSdkSkillRunner({ queryFn, timeoutMs: 30_000, gateway: { env: {} }, settingSources: [], toolDigest: false, promptGuard: false });
}

/** A worker id the way the real worker makes one (`host:pid:uuid`), so recovery can tell a dead one by its pid. */
export const workerIdOf = (pid = process.pid) => `${hostname()}:${pid}:${randomUUID()}`;

/** The worker the drill runs: the real scanning wiring and job runtime over Postgres, the fake source and classifier. */
export function drillWorker(o: { db: Db; userId: string; standingItemId: string; fault?: Fault; workerId?: string; failAfterCalls?: number; runner?: 'drill' | 'fti' | 'agentic' }) {
  const clock = new FakeClock(NOW);
  const fault = o.fault ?? noFault;
  const store = new DbScannerStore({ db: o.db, userId: o.userId, clock: () => clock.now() });
  // the fault hooks that sit between store calls: inside the finish transaction, and right after it committed
  const inner = store as unknown as { advanceCursor: (...a: unknown[]) => Promise<void>; finishRun: DbScannerStore['finishRun'] };
  const fetcher = new PagedMailFetcher(drillItems(), fault);
  let finishing = 0;
  const advance = inner.advanceCursor.bind(store);
  inner.advanceCursor = async (...a: unknown[]) => {
    fault('finish_tx', finishing);
    return advance(...a);
  };
  const finish = inner.finishRun.bind(store);
  inner.finishRun = async (runId, input) => {
    const r = await store.getCursor({ connector: 'gmail', scope: 'inbox' });
    finishing = fetcher.pageOf({ from: r?.at ?? iso(T0), to: iso(NOW) });
    const out = await finish(runId, input);
    fault('after_commit', finishing);
    return out;
  };
  const runner = o.runner === 'fti' ? drillFtiRunner(fault) : o.runner === 'agentic' ? drillAgentRunner(o.standingItemId, fault) : new DrillClassifier({ standingItemId: o.standingItemId, pageOf: (w) => fetcher.pageOf(w), fault, ...(o.failAfterCalls != null ? { failAfterCalls: o.failAfterCalls } : {}) });
  const scanning = buildScanning({ db: o.db, userId: o.userId, store, clock, fetchers: [fetcher], llm: true, runner, scanMode: 'agentic', notifier: new NullNotifier(), cadenceFile: null, completionCheck: false });
  const afterRun = scanning.handlerDeps.afterRun;
  scanning.handlerDeps.afterRun = async (job, outcome, ctx) => {
    await afterRun?.(job, outcome, ctx);
    if (job.kind === 'scan') fault('job_complete', fetcher.pageOf(job.window));
  };
  const registry = createDefaultRegistry({ scan: scanning.handlerDeps });
  const worker = new WorkerRuntime({
    db: o.db,
    userId: o.userId,
    workerId: o.workerId ?? workerIdOf(),
    registry,
    services: {},
    pools: [{ name: 'scan.gmail', queues: ['scan.gmail'], concurrency: 1 }],
    listenUrl: null,
    log: () => {},
  });
  /** The killed scan: one job for the whole window (its pages follow as continuations). */
  const enqueueWindow = () => scanning.queue.enqueue([scanJob({ connector: 'gmail', scope: 'inbox', window: { from: iso(T0), to: iso(NOW) }, mode: 'incremental', trigger: 'schedule', runAt: iso(NOW - 60_000) })]);
  const plan = async () => scanning.queue.enqueue(await scanning.scanner.planJobs(clock.now()));
  const drain = async (max = 60) => {
    for (let i = 0; i < max; i++) {
      const n = await worker.pollOnce();
      await worker.idle(60_000);
      if (!n) break;
    }
  };
  return { clock, store, scanning, worker, fetcher, enqueueWindow, plan, drain };
}

/** The drill's database facts, for its assertions. */
export async function drillFacts(db: Db, userId: string) {
  const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await db.execute<T>(s)).rows;
  const [items] = await q<{ n: number; distinct_keys: number }>(sql`select count(*)::int as n, count(distinct dedupe_key)::int as distinct_keys from source_items where owner_user_id = ${userId} and external_id like 'drill-msg-%'`);
  const asks = await q<{ title: string; n: number }>(sql`select title, count(*)::int as n from work_items where owner_user_id = ${userId} and title like 'Send Placeholder request %' group by title order by title`);
  const runs = await q<{ id: string; status: string; error_code: string | null; error_message: string | null; cost_usd: string; window_start: string; window_end: string }>(sql`
    select r.id, r.status, r.error_code, r.error_message, r.cost_usd::text, r.window_start::text, r.window_end::text from scan_runs r join connectors c on c.id = r.connector_id
     where r.owner_user_id = ${userId} and c.name = 'gmail' order by r.started_at, r.created_at`);
  const [cursor] = await q<{ at: string | null }>(sql`
    select sc.high_watermark_at as at from scan_cursors sc join connectors c on c.id = sc.connector_id
     where sc.owner_user_id = ${userId} and c.name = 'gmail' and sc.scope = 'gmail:inbox'`);
  const calls = await q<{ request_hash: string; cost_usd: string; scan_run_id: string | null }>(sql`select request_hash, cost_usd::text, scan_run_id from llm_calls where owner_user_id = ${userId} and skill_key = 'classify-items' order by id`);
  // the agentic drill's calls book on the Gmail skill (one row per query, or per turn of a query a kill cut short)
  const agentCalls = await q<{ request_hash: string; cost_usd: string; scan_run_id: string | null; outcome: string | null }>(sql`select request_hash, cost_usd::text, scan_run_id, outcome from llm_calls where owner_user_id = ${userId} and skill_key = 'scan-gmail' order by id`);
  const turnRows = await q<{ run_id: string; seq: number; q: string; cost: string }>(sql`select e.run_id, e.seq, e.payload->>'q' as q, e.payload->>'costUsd' as cost from scan_run_events e join scan_runs r on r.id = e.run_id where r.owner_user_id = ${userId} and e.kind = 'turn' order by e.run_id, e.seq`);
  const passRows = await q<{ run_id: string; seq: number }>(sql`select e.run_id, e.seq from scan_run_events e join scan_runs r on r.id = e.run_id where r.owner_user_id = ${userId} and e.kind = 'pass'`);
  const jobs = await q<{ id: string; status: string; kind: string; mode: string | null; last_error_code: string | null }>(sql`select id::text, status, kind, payload->>'mode' as mode, last_error_code from jobs where owner_user_id = ${userId} and kind = 'scan.gmail' order by id`);
  const holds = await q<{ id: string; state: string; spent_usd: string; held_usd: string }>(sql`select id::text, state, spent_usd::text, held_usd::text from spend_holds where user_id = ${userId} and scope = 'scan_run'`);
  const events = await q<{ code: string; message: string; resolved: boolean; detail: Record<string, unknown> }>(sql`select code, message, resolved_at is not null as resolved, detail from app_events where owner_user_id = ${userId} and component = 'worker' order by id`);
  const reevals = await q<{ work_item_id: string }>(sql`select payload->>'work_item_id' as work_item_id from jobs where owner_user_id = ${userId} and kind = 'reevaluate'`);
  const standingEvidence = await q<{ n: number }>(sql`select count(*)::int as n from work_item_evidence e join work_items w on w.id = e.work_item_id where w.owner_user_id = ${userId} and w.title = 'Standing item' and e.role = 'context'`);
  return { items: items!, asks, runs, cursorAt: cursor?.at ? new Date(cursor.at).toISOString() : null, calls, agentCalls, turnRows, passRows, jobs, holds, events, reevals, standingContext: standingEvidence[0]!.n };
}
