/**
 * ScriptedSkillRunner: a fake SkillRunner that replays scripted cc-tool calls through the REAL cc
 * handlers (zod validation, redaction, idempotent keys, R-UI-22 guard, cc_finish checks) against the
 * given store. Only the model is replaced by a script.
 */
import type { ScannerStore, SkillRunner } from '../../../../src/scanner/types';
import type { ScanSkillRunInput } from '../../../../src/llm/skill-runner';
import type { ScanSkillRunResult } from '../../../../src/scanner/runtime/contract-ext';
import { callCcTool, createCcHandlers, createRunState, type CcRunState } from '../../../../src/llm/cc-tools';
import { classifyError } from '../../../../src/llm/errors';

export interface ScriptApi {
  input: ScanSkillRunInput;
  state: CcRunState;
  /** Call a cc tool; throws on a tool error unless `allowError`. Returns parsed JSON. */
  call<T = any>(name: string, args: unknown, opts?: { allowError?: boolean }): Promise<T>;
  recordedId(dedupeKey: string): string | undefined;
  /** Simulate the source/tool spend of this run. */
  spend(usd: number, turns?: number): void;
  /** Simulate the agent calling a non-cc tool. */
  toolCall(name: string): void;
}

export type Script = (api: ScriptApi) => Promise<void>;

export interface ScriptedCall {
  model: string;
  mode?: string;
  scope: string;
  runId: string;
  skillPath: string;
  allowedTools: string[];
  window?: { from: string; to: string };
  instruction?: string;
}

export class ScriptedSkillRunner implements SkillRunner {
  readonly calls: ScriptedCall[] = [];
  constructor(private readonly script: Script) {}

  async run(input: ScanSkillRunInput, store: ScannerStore): Promise<ScanSkillRunResult> {
    this.calls.push({ model: input.model, mode: input.mode, scope: `${input.context.scope.connector}:${input.context.scope.scope}`, runId: input.runId, skillPath: input.skillPath, allowedTools: input.allowedTools, window: input.window, instruction: input.instruction });
    const window = input.window ?? { from: input.context.cursor?.at ?? new Date().toISOString(), to: new Date().toISOString() };
    const state = createRunState({ runId: input.runId, connector: input.context.scope.connector, window, context: input.context });
    const handlers = createCcHandlers(store, state);
    let cost = 0;
    let turns = 1;
    let disallowed: string | undefined;
    const allowed = new Set(input.allowedTools);
    if (input.prefetched?.length) {
      for (const r of await store.recordSourceItems(input.runId, input.prefetched)) {
        state.recorded.set(r.dedupeKey, r.sourceItemId);
        state.counts.recorded += 1;
        if (r.isNew) state.counts.new += 1;
        if (r.changed) state.counts.changed += 1;
      }
    }
    if (input.preReportedCoverage?.length) {
      await store.reportCoverage(input.runId, input.preReportedCoverage);
      state.coverage.push(...input.preReportedCoverage);
    }
    const api: ScriptApi = {
      input,
      state,
      async call(name, args, opts) {
        if (input.signal.aborted) throw new Error('aborted');
        turns += 1;
        const r = await callCcTool(handlers, state, name, args);
        if (r.isError && !opts?.allowError) throw new Error(`cc tool ${name} failed: ${r.text}`);
        return JSON.parse(r.text);
      },
      recordedId: (k) => state.recorded.get(k),
      spend(usd, t) {
        cost += usd;
        if (t) turns += t;
      },
      toolCall(name) {
        if (!allowed.has(name)) disallowed = name;
      },
    };
    const base = { costUsd: cost, inputTokens: 1000, outputTokens: 100, turns };
    try {
      await this.script(api);
    } catch (err) {
      return { ok: false, ...base, costUsd: cost, turns, counts: { ...state.counts }, error: { message: input.signal.aborted ? 'aborted by caller' : String(err instanceof Error ? err.message : err), errorClass: input.signal.aborted ? 'transient' : classifyError(err).errorClass } };
    }
    if (disallowed) return { ok: false, ...base, costUsd: cost, turns, counts: { ...state.counts }, error: { message: `disallowed tool call: ${disallowed}`, errorClass: 'config', disallowedTool: disallowed } };
    if (input.signal.aborted) return { ok: false, ...base, costUsd: cost, turns, counts: { ...state.counts }, error: { message: 'aborted by caller', errorClass: 'transient' } };
    if (!state.finished) return { ok: false, ...base, costUsd: cost, turns, counts: { ...state.counts }, error: { message: 'run ended without cc_finish', errorClass: 'unknown' } };
    return { ok: true, ...base, costUsd: cost, turns, counts: { ...state.counts }, proposedCursor: state.finished.cursor, complete: state.finished.complete, summary: state.finished.summary };
  }
}
