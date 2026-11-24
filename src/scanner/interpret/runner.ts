/**
 * FtiSkillRunner: the scanner's `SkillRunner` in fetch-then-interpret mode (`CC_SCAN_MODE=fti`, review 04 §4.1,
 * decision H-3). The runtime's control flow is unchanged (planning, cursors, coverage commit, retries, budgets, first
 * scan); only what one run does is:
 *
 *   traversal sources (Slack, Org62)   fetch by code: the scope's fixed queries through the `claude_relay` runtime,
 *                                      paged by code, recorded by REC-1 / REC-2 → report coverage → interpret → finish
 *   deterministic sources               the fetcher already ran: record the prefetched items → interpret
 *   interpret                           src/scanner/interpret/interpret.ts (rules, candidates, batched tool-less Haiku)
 *
 * Anything else runs the agentic runner as before (the fallback): relink and skill-upgrade passes, the Org62 `book` and
 * `missed_opps` reads, Calendar, Claude sessions, trainings, watch briefs, VDP, and a user with no Slack / Org62 id.
 *
 * Spend (H-5, caps audit 26 F-4): every paid call reports the run's spend to its hold (`input.spend`, the runtime's
 * gate). Past the hold the run stops before its next classifier batch, raises a hand and ends `paused for spend`
 * (the runtime keeps the window queued with the hold; what earlier batches applied stays, with their verdicts).
 *
 * Booking (D0, 0027): every relay read and every classifier call is one `pass` trace row (`fetch:relay:<c>:<tool>`,
 * `classify:classify-items`, `reclassify:classify-items`) with its model, tokens, cost, content hash and measurement,
 * traced and flushed as the call returns (ask #14: a run killed mid-way still leaves its paid calls for the next
 * start's recovery to book); the runtime's `recordSpend` books one `llm_calls` row per pass row, on the run's budget.
 */
import type { ConnectorRuntime } from '@/connectors/runtime/types';
import { ledgerHash, type CallMeasurement } from '@/db/ledger';
import { createCcHandlers, createRunState, type CcRunState } from '@/llm/cc-tools';
import type { ScanSkillRunInput } from '@/llm/skill-runner';

import { relayedFetch, relayedFetchSupported, ScopeFetchError, type FetchCall } from '../fetch';
import { flushTrace, trace } from '../trace';
import type { ConnectorId, ScannerStore, SkillRunner, SkillRunResult } from '../types';
import { ClassifierCallError, ClassifyPaused } from './classify';
import { CLASSIFY_SKILL_KEY, interpretRun, type InterpretResult } from './interpret';
import { CLASSIFIER_MODEL, providerClassifierModel } from './model';
import type { ClassifierCall, ClassifierModel } from './types';
import { FTI_INTERPRETED } from './units';

export interface FtiRunnerOptions {
  /** The agentic runner for everything FTI does not cover. */
  fallback: SkillRunner;
  /** The `claude_relay` runtime of a relayed source (Slack, Org62); null: that source falls back. */
  runtimeFor: (connector: ConnectorId) => ConnectorRuntime | null;
  model?: ClassifierModel;
  modelId?: string;
  repoRoot?: string;
  /** Connectors whose items FTI interprets (default: Slack, Gmail, Gemini notes, Drive, Org62). */
  interpreted?: ReadonlySet<string>;
  log?: (e: { runId: string; event: 'fti' | 'fallback' | 'error'; code?: string; detail?: string }) => void;
}

/** Why a run stays on the agentic runner (null: FTI runs it). */
export function fallbackReason(input: ScanSkillRunInput, o: Pick<FtiRunnerOptions, 'runtimeFor' | 'interpreted'>): string | null {
  const c = input.context.scope.connector;
  const mode = input.mode ?? 'incremental';
  if (input.pass) return 'pass';
  if (mode.startsWith('relink')) return 'relink';
  if (/skill upgrade dry run/i.test(input.instruction ?? '')) return 'skill_upgrade';
  if (!(o.interpreted ?? FTI_INTERPRETED).has(c)) return 'not_interpreted';
  if (input.prefetched) return null;
  if (!relayedFetchSupported(c, input.context.scope.scope, mode, input.context.me)) return 'scope_not_fetched';
  if (!o.runtimeFor(c)) return 'no_runtime';
  return null;
}

/** A store whose recordSourceItems also notes which ids were new or changed in this run. */
function tracking(store: ScannerStore, fresh: Set<string>): ScannerStore {
  return new Proxy(store, {
    get(t, p, r) {
      if (p === 'recordSourceItems') {
        return async (runId: string, items: Parameters<ScannerStore['recordSourceItems']>[1]) => {
          const res = await t.recordSourceItems(runId, items);
          for (const x of res) if (x.isNew || x.changed) fresh.add(x.sourceItemId);
          return res;
        };
      }
      const v = Reflect.get(t, p, r) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

type Usage = NonNullable<SkillRunResult['usage']>[number];

/** One relay read's `pass` row (what recordSpend, or the next start's recovery, books as one llm_calls row). */
function tracePassOfFetch(runId: string, mode: string, connector: ConnectorId, c: FetchCall, hold: string | null): void {
  const model = c.usage.model ?? CLASSIFIER_MODEL;
  const m: CallMeasurement = { turns: c.usage.turns || (c.usd > 0 ? 1 : 0), firstPromptTokens: c.usage.prefixTokens || c.usage.inputTokens + c.usage.cacheReadTokens + c.usage.cacheWriteTokens || null, toolCount: 1, itemsIn: c.rows, itemsOut: 0 };
  trace(runId, 'pass', { pass: `fetch:relay:${connector === 'watch' ? 'slack' : connector}:${c.tool}`, mode, model, hold, ok: c.ok, errorClass: c.ok ? null : (c.code ?? 'unknown'), costUsd: c.usd, inputTokens: c.usage.inputTokens, outputTokens: c.usage.outputTokens, cacheReadTokens: c.usage.cacheReadTokens, cacheWriteTokens: c.usage.cacheWriteTokens, contentHash: c.contentHash, turns: m.turns, ms: c.ms, m });
}

/** One classifier call's `pass` row; the run's first carries how many items rules decided. */
function tracePassOfClassify(runId: string, mode: string, c: ClassifierCall, hold: string | null, decidedByRules?: number): void {
  const first = c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens || c.promptTokensEst;
  const m: CallMeasurement = { turns: 1, firstPromptTokens: first, maxPromptTokens: first, longTierRequests: first > 100_000 ? 1 : 0, toolCount: 0, toolSchemaTokens: 0, prefixHash: c.prefixHash, itemsIn: c.itemsIn, itemsOut: c.acts, ...(decidedByRules != null ? { itemsDecidedByRules: decidedByRules } : {}) };
  trace(runId, 'pass', { pass: `${c.pass}:${CLASSIFY_SKILL_KEY}`, mode, model: c.model, hold, ok: c.ok, errorClass: c.ok ? null : 'transient', costUsd: c.costUsd, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens, cacheWriteTokens: c.cacheWriteTokens, contentHash: c.contentHash, turns: 1, ms: c.ms, counts: { items: c.itemsIn, verdicts: c.verdicts, invalid: c.invalid, malformed: c.malformed }, m });
}

function addTo(rows: Map<string, Usage>, model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, usd: number) {
  const r = rows.get(model) ?? { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  r.inputTokens += u.inputTokens;
  r.outputTokens += u.outputTokens;
  r.cacheReadTokens += u.cacheReadTokens;
  r.cacheWriteTokens += u.cacheWriteTokens;
  r.costUsd += usd;
  rows.set(model, r);
}

export class FtiSkillRunner implements SkillRunner {
  constructor(private readonly o: FtiRunnerOptions) {}

  async run(input: ScanSkillRunInput, store: ScannerStore): Promise<SkillRunResult> {
    const why = fallbackReason(input, this.o);
    if (why) {
      this.o.log?.({ runId: input.runId, event: 'fallback', code: why });
      return this.o.fallback.run(input, store);
    }
    return this.runFti(input, store);
  }

  private async runFti(input: ScanSkillRunInput, baseStore: ScannerStore): Promise<SkillRunResult> {
    const ctx = input.context;
    const connector = ctx.scope.connector;
    const scope = ctx.scope.scope;
    const mode = input.mode ?? 'incremental';
    const window = input.window ?? { from: ctx.cursor?.at ?? new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString() };
    const fresh = new Set<string>();
    const store = tracking(baseStore, fresh);
    const state = createRunState({ runId: input.runId, connector, window, context: ctx, ...(input.prefetched ? { prefetched: input.prefetched } : {}) });
    if (connector === 'org62' && scope === 'opps') {
      // ORG-7: Q2 covers only the accounts it was given
      const accounts = String(input.vars?.['org62.accountIds'] ?? '').split(',').filter((x) => x.trim()).length;
      state.coverageMeta = (c) => (c.ref === 'soql:Opportunity:accounts' ? { accounts } : undefined);
    }
    const handlers = createCcHandlers(store, state);
    const fetchCalls: FetchCall[] = [];
    const classifyCalls: ClassifierCall[] = [];
    let classify: InterpretResult | undefined;
    // ask #14 (crash drill d): each paid call's `pass` row is traced and flushed as the call returns, so a run killed
    // mid-way leaves a row per call for the next start's recovery to book (src/worker/recovery.ts)
    const mode0 = input.mode ?? 'incremental';
    // the governor's hold the calls count against: recovery settles a dead run's hold from these rows
    const holdId = input.spend?.hold.id ?? null;
    // H-5: the run's spend so far, reported to its hold after every paid call; 'ask' pauses before the next batch
    let spent = 0;
    let overHold = false;
    const tick = (usd: number) => {
      spent += Math.max(0, usd || 0);
      if (input.spend?.observe(spent) === 'ask') overHold = true;
    };
    const onFetch = async (c: FetchCall) => {
      fetchCalls.push(c);
      tick(c.usd);
      tracePassOfFetch(input.runId, mode0, connector, c, holdId);
      await flushTrace();
    };
    const onClassify = async (c: ClassifierCall, decidedByRules: number) => {
      classifyCalls.push(c);
      tick(c.costUsd);
      tracePassOfClassify(input.runId, mode0, c, holdId, classifyCalls.length === 1 ? decidedByRules : undefined);
      await flushTrace();
    };
    let cursor = { value: String(input.vars?.['header.cursor.value'] ?? ''), at: String(input.vars?.['header.cursor.at'] ?? window.to) };
    let complete = String(input.vars?.['header.complete'] ?? 'true') !== 'false';
    let error: SkillRunResult['error'];
    const t0 = Date.now();
    try {
      if (input.prefetched) {
        if (input.prefetched.length) {
          const res = await store.recordSourceItems(input.runId, input.prefetched);
          const byKey = new Map(input.prefetched.map((it) => [it.dedupeKey, it]));
          for (const r of res) {
            state.recorded.set(r.dedupeKey, r.sourceItemId);
            const it = byKey.get(r.dedupeKey);
            if (it) state.items.set(r.dedupeKey, it);
            state.counts.recorded += 1;
            if (r.isNew) state.counts.new += 1;
            if (r.changed) state.counts.changed += 1;
          }
        }
        if (input.preReportedCoverage?.length) {
          await store.reportCoverage(input.runId, input.preReportedCoverage);
          state.coverage.push(...input.preReportedCoverage);
          state.counts.coverage += input.preReportedCoverage.length;
        }
        if (!cursor.value) cursor = { value: window.to, at: window.to };
      } else {
        const readScope = relayedFetch(connector)!;
        const runtime = this.o.runtimeFor(connector)!;
        let f;
        try {
          // what the fetch read before it failed is still booked: every call reached onFetch as it returned
          f = await readScope({ scope, window, mode, ctx, vars: input.vars ?? {}, runtime, store, state, signal: input.signal, onCall: onFetch });
        } catch (err) {
          if (err instanceof ScopeFetchError) for (const c of err.calls) if (!fetchCalls.includes(c)) await onFetch(c);
          throw err;
        }
        for (const c of f.calls) if (!fetchCalls.includes(c)) await onFetch(c);
        trace(input.runId, 'prefetch', () => ({ fti: true, calls: f.calls.length, read: f.read, recorded: state.counts.recorded, new: state.counts.new, coverage: f.coverage.length, complete: f.complete, cursorAt: f.cursor.at, ms: Date.now() - t0 }));
        await handlers.cc_report_coverage({ objects: f.coverage.map((c) => ({ kind: c.kind, ref: c.ref, ...(c.from ? { from: c.from } : {}), ...(c.to ? { to: c.to } : {}), ...(c.meta ? { meta: c.meta } : {}) })) });
        cursor = f.cursor;
        complete = f.complete;
      }
      classify = await interpretRun({
        store,
        state,
        ctx,
        window,
        fresh,
        model: this.o.model ?? providerClassifierModel(),
        modelId: this.o.modelId ?? CLASSIFIER_MODEL,
        mode,
        signal: input.signal,
        ...(this.o.repoRoot ? { repoRoot: this.o.repoRoot } : {}),
        trigger: mode,
        onCall: onClassify,
        ...(input.spend ? { pauseBefore: () => overHold } : {}),
      });
      if (!input.prefetched) {
        await handlers.cc_finish({ cursor, complete });
        cursor = state.finished!.cursor;
        complete = state.finished!.complete;
      }
    } catch (err) {
      if (err instanceof ClassifyPaused && input.spend) {
        await input.spend.ask({ pctDone: err.batches ? Math.round((err.batchesDone / err.batches) * 100) : null }).catch(() => undefined);
        // the runtime's paused-for-spend path keys on this message (src/scanner/runtime/scanner-runtime.jobs.ts)
        error = { message: `paused for spend: $${spent.toFixed(4)} of a $${input.spend.hold.heldUsd.toFixed(4)} hold`, errorClass: 'config' };
        this.o.log?.({ runId: input.runId, event: 'error', code: 'paused_for_spend' });
        return this.result(input, state, fetchCalls, classifyCalls, classify, { cursor, complete, error, connector });
      }
      const errorClass = err instanceof ScopeFetchError || err instanceof ClassifierCallError ? err.errorClass : 'config';
      error = { message: (err instanceof Error ? err.message : String(err)).slice(0, 300), errorClass };
      this.o.log?.({ runId: input.runId, event: 'error', code: err instanceof ScopeFetchError ? err.code : errorClass });
    }
    return this.result(input, state, fetchCalls, classifyCalls, classify, { cursor, complete, error, connector });
  }

  /** Assemble the run result from the calls (their `pass` rows were traced as each returned). */
  private result(input: ScanSkillRunInput, state: CcRunState, fetchCalls: FetchCall[], calls: ClassifierCall[], cl: InterpretResult | undefined, o: { cursor: { value: string; at: string }; complete: boolean; error?: SkillRunResult['error']; connector: ConnectorId }): SkillRunResult {
    const usage = new Map<string, Usage>();
    let cost = 0;
    const hashes: string[] = [];
    const mode = input.mode ?? 'incremental';
    for (const c of fetchCalls) {
      cost += c.usd;
      hashes.push(c.contentHash);
      addTo(usage, c.usage.model ?? CLASSIFIER_MODEL, c.usage, c.usd);
    }
    // a classifier call that failed mid-run is in `calls` too (interpret's result never came back): its cost counts
    for (const c of calls) {
      cost += c.costUsd;
      hashes.push(c.contentHash);
      addTo(usage, c.model, c, c.costUsd);
    }
    const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => [...usage.values()].reduce((a, u) => a + u[k], 0);
    // the run's own row (what no pass row covers) carries the first request's size whenever it books requests
    const firstFetch = fetchCalls[0];
    const firstPrompt = firstFetch ? firstFetch.usage.prefixTokens || firstFetch.usage.inputTokens + firstFetch.usage.cacheReadTokens + firstFetch.usage.cacheWriteTokens : calls[0] ? calls[0].inputTokens + calls[0].cacheReadTokens + calls[0].cacheWriteTokens || calls[0].promptTokensEst : 0;
    const requests = fetchCalls.length + calls.length;
    const measure: CallMeasurement = { itemsIn: state.counts.recorded, itemsDecidedByRules: cl?.decided.length ?? 0, itemsOut: state.counts.proposed + state.counts.linked, ...(requests && firstPrompt > 0 ? { turns: requests, firstPromptTokens: firstPrompt } : {}) };
    const ok = !o.error;
    trace(input.runId, 'outcome', () => ({ fti: true, ok, units: cl?.units ?? 0, decided: cl?.decided.length ?? 0, unsure: cl?.unsure ?? 0, verdicts: cl?.verdicts ?? {}, failedWrites: cl?.failedWrites ?? 0, fetchCalls: fetchCalls.length, classifyCalls: calls.length, costUsd: Math.round(cost * 1e6) / 1e6 }));
    return {
      ok,
      costUsd: cost,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheReadTokens: sum('cacheReadTokens'),
      cacheWriteTokens: sum('cacheWriteTokens'),
      ...(usage.size ? { usage: [...usage.values()] } : {}),
      contentHash: ledgerHash('fti/v1', o.connector, input.context.scope.scope, mode, input.window?.from, input.window?.to, ...hashes),
      turns: fetchCalls.length + calls.length,
      ...(ok ? { proposedCursor: o.cursor, complete: o.complete } : {}),
      summary: `fti: ${state.counts.recorded} recorded, ${cl?.units ?? 0} interpreted, ${state.counts.proposed} proposed, ${state.counts.linked} linked`,
      ...(o.error ? { error: o.error } : {}),
      counts: { ...state.counts },
      measure,
    };
  }
}
