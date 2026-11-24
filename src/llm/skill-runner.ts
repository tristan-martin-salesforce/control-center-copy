/**
 * AgentSdkSkillRunner: one Agent SDK `query()` per scan step (SCANNER.md §2, §3, §7; brief 09 §3–§5).
 *
 * Guarantees:
 *  - Loads ONLY the given MCP server(s) plus the in-process `cc` server (`strictMcpConfig`, `tools: []`).
 *  - Exact allowlist, enforced by the `canUseTool` gate: no bare `allowedTools` (they auto-approve a tool before the
 *    callback runs; the SDK warned CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) and no hook `allow`, so every call reaches the
 *    gate. Any call to anything else aborts the whole run with `error.disallowedTool`, via the PreToolUse hook
 *    (deny only, fires first), the gate, a scan of assistant `tool_use` blocks, and the result's `permission_denials`.
 *    Everything outside the allowlist is also in `disallowedTools`, so it is never in the model's context.
 *  - `permissionMode: 'default'` with the gate as the only approver: the user's default `auto` classifier never runs.
 *  - Budget: `maxTurns`, `maxBudgetUsd` (SDK) plus a running estimate from per-message usage. With a spend gate (the
 *    governor's hold, src/llm/spend; H-5) the estimate is reported after every request; past the hold the run stops at
 *    the next turn boundary (before the next tool runs), raises a hand (SPEND.ASK) and ends `paused_for_spend`, which
 *    the runtime re-queues instead of failing; `maxBudgetUsd` is then the runaway guard only. Without a gate the cap
 *    aborts as soon as it is crossed (as before). A prefix tripwire (first-call prompt > 40 K tokens plus the prefetched payload), a watchdog.
 *  - AbortSignal propagation; clean env (never inherits CLAUDE_CODE_* from a parent Claude).
 *  - Skill text + context pack go in the system prompt (cacheable), the Run block in the user prompt.
 *  - Cost and tokens come from the result message (`total_cost_usd`, `modelUsage`). Ask #14: each request's usage
 *    block is also traced as a `turn` row as it arrives (skill-runner.turns.ts), so a worker killed mid-query leaves
 *    what the query had spent for the next start's recovery to book; the query's end `pass` row books it otherwise.
 *  - Measurement (0027, review 04 §4.5): per-request prompt sizes (first, max, long-tier requests), turns, tools loaded
 *    and their schema tokens (`getContextUsage({detail:'summary'})`), a hash of everything before the cache boundary,
 *    items in / out; it rides on the `pass` trace row and the result (`measure`) into `llm_calls`.
 *  - COST-2: once REC-1/REC-2 have recorded a read tool's raw result, the PostToolUse hook hands the model a compact
 *    digest (`updatedToolOutput`, src/llm/tool-digest.ts), and a per-request prompt guard stops the run before a
 *    request would pass the model's long-prompt tier (Haiku 5.5: 100K, 5×): the run ends `prompt cap` and the runtime
 *    splits the window like a cost cap, instead of paying the tier.
 *  - COST-8: no Claude settings files (`settingSources: []`); the gateway env and apiKeyHelper are passed explicitly.
 *  - Errors are classified auth | transient | rate_limited | config | unknown (brief 09 signatures).
 *  - Logs carry ids, tool names and codes only; no bodies, no secrets.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  agentQuery as sdkQuery, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type CanUseTool, type HookCallback, type McpServerConfig,
  type Options,
} from '@/llm/provider';
import type { ScannerStore, SkillRunner, TimeWindow } from '../scanner/types';
import type { ScanSkillRunResult, ScannerStoreWithBriefs } from '../scanner/runtime/contract-ext';
import {
  buildCcServer, CC_SERVER_NAME, CC_TOOL_NAMES, CC_TRIAGE_TOOL_NAMES, ccToolFullName, createCcHandlers,
  createRunState, parseHighlightsBlock, type CcRunState, type CcToolName,
} from './cc-tools';
import { bareToolName, SlackAutoRecorder } from './slack-rec';
import { Org62AutoRecorder } from './org62-rec';
import { Org62PageObserver } from './org62-pages';
import { ownCoverageHole } from './cc-tools/handlers';
import { claudeGatewayConfig, scannerEnv, scannerSettingSources } from './claude-env';
import { defaultClaudeExecutable, defaultScannerCwd } from './env';
import { classifyError, classifyMcpStatus, errorText, type ErrorClass } from './errors';
import { assertReadOnly, disallowedFor } from './mcp-config';
import { estimateCallCostUsd, longPromptThresholdOf } from './models';
import { addUsage, estimateTokens, RequestMeter, usageFromBlock, usageFromModelUsage, type UsageTotals } from './usage';
import { ledgerHash, type CallMeasurement } from '../db/ledger';
import { digestToolOutput, toolOutputText } from './tool-digest';
import { safeLogText } from './redact';
import {
  commonSkillPathFor, loadSkill, renderPrefetched, renderRunBlock, scannerSystemPrompt, soqlDateTime,
} from './skill-loader';
import { trace } from '../scanner/trace';
import { PAUSED_FOR_SPEND } from './spend/scan-gate';
import {
  type ScanSkillRunInput, type ScanSkillRunResultWithPasses, type RunnerLogEvent, ORG62_WINDOWED, type ErrorState,
  isRealTool, PROMPT_GUARD_MARGIN_TOKENS, type QueryFn, TOOL_ROWS, prefixTripwireLimit, traceArgs, traceResult,
  traceError, setUsage,
} from './skill-runner.shared';
import { AgentSdkSkillRunnerTriage } from './skill-runner.triage';
import { TurnTracer } from './skill-runner.turns';
export {
  TOOL_OVERHEAD_TOKENS, PROMPT_GUARD_MARGIN_TOKENS, prefixTripwireLimit, isRealTool,
} from './skill-runner.shared';
export type {
  ScanSkillRunInput, SkillPassStat, ScanSkillRunResultWithPasses, ContextUsageLike, QueryFn, RunnerLogEvent,
  AgentSdkSkillRunnerOptions,
} from './skill-runner.shared';

export { PAUSED_FOR_SPEND } from './spend/scan-gate';

export class AgentSdkSkillRunner extends AgentSdkSkillRunnerTriage implements SkillRunner {

  async run(input: ScanSkillRunInput, store: ScannerStore): Promise<ScanSkillRunResultWithPasses> {
    const { result: raw, state, rec } = await this.runOnce(input, store);
    // CONN-9: Slack answered in a format the parser no longer reads and nothing was recorded: fail the run as parse
    // drift (DATA.PARSE_DRIFT pauses the scope with "the format changed; report it") instead of a silent empty success
    const drift = rec instanceof SlackAutoRecorder ? rec.drift : null;
    const result: ScanSkillRunResult = raw.ok && drift && rec!.stats.recorded === 0 ? { ...raw, ok: false, error: { message: `ParseDrift: ${drift}`, errorClass: 'config' } } : raw;
    const out: ScanSkillRunResultWithPasses = result;
    out.passes = [{ pass: 'traversal', model: input.model, runs: 1, costUsd: result.costUsd, ...(rec ? { autoRecorded: rec.stats.recorded, recErrors: rec.stats.errors } : {}) }];
    if (!result.ok || !input.triage || input.pass || input.signal.aborted) return out;
    try {
      await this.runTriage(input, store, state, out);
    } catch (err) {
      // A triage failure never fails the traversal run: its writes so far stay, the rest is the traversal's outcome.
      this.o.logger?.({ runId: input.runId, event: 'error', code: 'triage_failed', detail: safeLogText(errorText(err), 200) });
    }
    return out;
  }

  /** One Agent SDK query, traced as a `pass` (model, outcome, cost, tokens, counts). */
  protected async runOnce(input: ScanSkillRunInput, store: ScannerStore, parent?: CcRunState, extra?: (state: CcRunState) => Partial<CallMeasurement>): Promise<{ result: ScanSkillRunResult; state: CcRunState; rec?: SlackAutoRecorder | Org62AutoRecorder }> {
    const t0 = Date.now();
    const turns = new TurnTracer({ runId: input.runId, pass: input.pass ?? 'traversal', mode: input.mode ?? 'incremental', holdId: input.spend?.hold.id ?? null });
    const out = await this.runOnceInner(input, store, parent, turns);
    const r = out.result;
    // 0027: items out = what this pass proposed or linked; the caller adds what only it knows (items in, D4).
    const items: Partial<CallMeasurement> = { itemsOut: (r.counts?.proposed ?? 0) + (r.counts?.linked ?? 0), ...(input.pass ? {} : { itemsIn: input.prefetched?.length || out.state.counts.recorded }) };
    r.measure = { ...(r.measure ?? {}), ...items, ...(extra?.(out.state) ?? {}) };
    trace(input.runId, 'pass', () => ({ pass: input.pass ?? 'traversal', mode: input.mode ?? 'incremental', model: input.model, q: turns.q, hold: input.spend?.hold.id ?? null, ok: r.ok, errorClass: r.error?.errorClass ?? null, error: r.error ? r.error.message : null, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens ?? 0, cacheWriteTokens: r.cacheWriteTokens ?? 0, contentHash: r.contentHash ?? null, ...(r.usage && r.usage.length > 1 ? { usage: r.usage } : {}), turns: r.turns, ms: Date.now() - t0, counts: r.counts ?? null, ...(out.rec ? { rec: { ...out.rec.stats } } : {}), finished: !!out.state.finished, complete: r.complete ?? null, m: r.measure ?? null }));
    return out;
  }

  /** One Agent SDK query. `parent`: a post-traversal pass shares the traversal's recorded items and outcomes. */
  protected async runOnceInner(input: ScanSkillRunInput, store: ScannerStore, parent?: CcRunState, turns?: TurnTracer): Promise<{ result: ScanSkillRunResult; state: CcRunState; rec?: SlackAutoRecorder | Org62AutoRecorder }> {
    const log = (e: Omit<RunnerLogEvent, 'runId'>) => this.o.logger?.({ runId: input.runId, ...e });
    const window: TimeWindow = input.window ?? { from: input.context.cursor?.at ?? new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString() };
    const state = createRunState({ runId: input.runId, connector: input.context.scope.connector, window, context: input.context, prefetched: input.prefetched });
    if (parent) {
      state.recorded = parent.recorded;
      state.items = parent.items;
      state.auto = parent.auto;
      state.outcomes = parent.outcomes;
      state.resolution = parent.resolution;
    }
    if (input.pass) state.pass = input.pass;
    // ORG-7: Q2 (opps on my accounts) covers only the accounts it was given: its coverage says how many.
    if (input.context.scope.connector === 'org62' && input.context.scope.scope === 'opps') {
      const accounts = String(input.vars?.['org62.accountIds'] ?? '').split(',').filter((x: string) => x.trim()).length;
      state.coverageMeta = (o) => (o.ref === 'soql:Opportunity:accounts' ? { accounts } : undefined);
    }
    const rec =
      input.autoRecord === 'slack' && !input.pass
        ? new SlackAutoRecorder(store, state, input.context)
        : input.autoRecord === 'org62' && !input.pass && ORG62_WINDOWED.has(input.context.scope.scope)
          ? new Org62AutoRecorder(store, state)
          : undefined;
    // ORG-3: what each SOQL query returned, to judge a finish the agent called incomplete by the paging rule.
    const org62Pages = input.context.scope.connector === 'org62' && !input.pass ? new Org62PageObserver() : undefined;
    const ccNames: readonly CcToolName[] = input.pass ? CC_TRIAGE_TOOL_NAMES : CC_TOOL_NAMES;
    const base: ScanSkillRunResult = { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };

    // ---- skill + prompt
    let systemPrompt: string[];
    let prompt: string;
    let sent = { proseChars: 0, dataChars: 0 };
    let skillVersion: string | null = null;
    let prefixHash: string | null = null;
    try {
      const skill = loadSkill(input.skillPath, this.o.repoRoot);
      const common = loadSkill(commonSkillPathFor(input.skillPath), this.o.repoRoot);
      skillVersion = skill.versionTag ?? null;
      assertReadOnly(input.allowedTools);
      if (input.prefetched?.length) {
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
      systemPrompt = scannerSystemPrompt(common.body, skill.body, input.context, SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
      const prefetchedBlock = renderPrefetched(input.prefetched, state.recorded);
      prompt = [
        renderRunBlock({ runId: input.runId, mode: input.mode ?? 'incremental', window, ctx: input.context, vars: rec ? { ...input.vars, 'slack.rec': 'auto' } : input.vars, coverage: input.preReportedCoverage }),
        prefetchedBlock,
        input.instruction ? `## Step\n${input.instruction}` : '',
        input.pass
          ? `Follow the skill for mode "${input.pass}". Propose or link what needs it, then give every VERDICT message one verdict with cc_triage_verdicts, then stop (no cc_finish).`
          : `Follow the skill for mode "${input.mode ?? 'incremental'}". Record, link, report coverage, then call cc_finish exactly once.`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const proseChars = systemPrompt[0]!.length;
      sent = { proseChars, dataChars: systemPrompt.reduce((a, x) => a + x.length, 0) - proseChars + prompt.length };
      // D0: identical calls (same model, skill version, prompt and input) share this hash, so repeats are visible.
      base.contentHash = ledgerHash(input.model, skillVersion, ...systemPrompt, prompt);
      if (turns) turns.contentHash = base.contentHash;
      // 0027: cache identity. Tools render first, then the system prompt up to the dynamic boundary.
      const cut = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
      prefixHash = ledgerHash(input.model, ...(input.allowedTools ?? []), ...ccNames, ...(cut >= 0 ? systemPrompt.slice(0, cut) : systemPrompt));
    } catch (err) {
      const c = classifyError(err);
      log({ event: 'error', code: c.code, detail: safeLogText(errorText(err), 200) });
      return { result: { ...base, error: { message: safeLogText(errorText(err), 300), errorClass: c.errorClass === 'unknown' ? 'config' : c.errorClass } }, state, rec };
    }

    // ---- guards
    const ccServer = buildCcServer(createCcHandlers(store, state), state, ccNames);
    const allowed = [...new Set([...input.allowedTools, ...ccNames.map(ccToolFullName)])];
    const allowSet = new Set(allowed);
    const ac = new AbortController();
    let error: ErrorState | undefined;
    const fail = (e: ErrorState) => {
      if (!error) error = e;
      if (!ac.signal.aborted) ac.abort();
    };
    const denyTool = (tool: string, where: string) => {
      log({ event: 'denied', tool, code: where });
      fail({ message: `disallowed tool call: ${tool}`, errorClass: 'config', disallowedTool: tool, code: 'disallowed_tool' });
    };
    /**
     * A real tool that is not on the allowlist aborts the run. A name that matches no tool at all (a
     * model naming slip such as a bare `cc_…` name) cannot execute: the CLI rejects it and the model
     * retries, so it is logged, not fatal.
     */
    const guard = (tool: string, where: string): 'allow' | 'abort' | 'unknown' => {
      if (allowSet.has(tool)) return 'allow';
      if (isRealTool(tool)) {
        denyTool(tool, where);
        return 'abort';
      }
      log({ event: 'denied', tool, code: `unknown_tool_name:${where}` });
      return 'unknown';
    };
    const onExternalAbort = () => fail({ message: 'aborted by caller', errorClass: 'transient', code: 'aborted' });
    if (input.signal.aborted) onExternalAbort();
    input.signal.addEventListener('abort', onExternalAbort, { once: true });
    const timeoutMs = input.timeoutMs ?? this.o.timeoutMs;
    const watchdog = setTimeout(() => fail({ message: `watchdog: run exceeded ${timeoutMs} ms`, errorClass: 'transient', code: 'timeout' }), timeoutMs);

    // 0027 + COST-2: every request's prompt size, and the tool output that will go into the next one.
    const meter = new RequestMeter(longPromptThresholdOf);
    const digests = new Map<string, { rawChars: number; chars: number }>();
    const slackMe = input.context.me?.slackId;

    const preToolUse: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {};
      const g = guard(hookInput.tool_name, 'pre_tool_use');
      if (g === 'allow') {
        // No decision: an `allow` here would skip the canUseTool gate (SDK-1). The gate approves.
        log({ event: 'tool', tool: hookInput.tool_name });
        return {};
      }
      const deny = { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'not on the scanner allowlist' };
      return g === 'abort' ? { continue: false, stopReason: 'disallowed tool', hookSpecificOutput: deny } : { hookSpecificOutput: deny };
    };
    // REC-1: record what the read tools returned before the model sees it (the CLI awaits the hook). Then COST-2: the
    // model gets a digest of what was recorded, and the run stops before its next request would pass the long tier.
    const postToolUse: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== 'PostToolUse') return {};
      if (rec) await rec.onToolResult(hookInput.tool_name, hookInput.tool_input, hookInput.tool_response, hookInput.tool_use_id);
      if (org62Pages) org62Pages.onToolResult(hookInput.tool_name, hookInput.tool_input, hookInput.tool_response);
      const digest = this.o.toolDigest ? digestToolOutput(hookInput.tool_name, hookInput.tool_input, hookInput.tool_response, { slackRecorded: rec instanceof SlackAutoRecorder, me: slackMe }) : null;
      if (digest && hookInput.tool_use_id) digests.set(hookInput.tool_use_id, { rawChars: digest.rawChars, chars: digest.chars });
      meter.addPending(estimateTokens(digest ? digest.chars : toolOutputText(hookInput.tool_response).length));
      const replace = digest ? { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, updatedToolOutput: digest.output } } : {};
      const limit = this.o.promptGuard ? meter.threshold(input.model) : null;
      const next = meter.projectedNext();
      if (limit != null && next + PROMPT_GUARD_MARGIN_TOKENS > limit) {
        trace(input.runId, 'prompt_guard', { pass: input.pass ?? 'traversal', projected: next, limit, finished: !!state.finished });
        // A finished run only has its closing reply left: stop it, nothing to split.
        if (!state.finished) fail({ message: `prompt cap: the next request would be about ${next} tokens, past the ${limit}-token long-prompt tier`, errorClass: 'config', code: 'prompt_cap' });
        return { continue: false, stopReason: 'prompt cap', ...replace };
      }
      return replace;
    };
    /** The allowlist gate: every tool call is decided here (SDK-1). */
    const canUseTool: CanUseTool = async (toolName, toolInput) => {
      const g = guard(toolName, 'can_use_tool');
      if (g !== 'allow') return { behavior: 'deny', message: 'not on the scanner allowlist', interrupt: g === 'abort' };
      // H-5: past its hold the run stops here, at a turn boundary, before this tool runs: raise a hand, end paused.
      if (spendAsk && input.spend && !error) {
        await input.spend.ask({ pctDone: pctDone() }).catch(() => undefined);
        trace(input.runId, 'spend_ask', { pass: input.pass ?? 'traversal', spentUsd: input.spend.hold.spentUsd, heldUsd: input.spend.hold.heldUsd });
        fail({ message: `paused for spend: $${input.spend.hold.spentUsd.toFixed(4)} of a $${input.spend.hold.heldUsd.toFixed(4)} hold`, errorClass: 'config', code: PAUSED_FOR_SPEND });
        return { behavior: 'deny', message: 'paused for spend', interrupt: true };
      }
      // REC-1 needs message ts: the concise thread/channel formats carry none, so reads are made detailed.
      const bare = bareToolName(toolName);
      const ti = (toolInput ?? {}) as Record<string, unknown>;
      if (rec && (bare === 'slack_read_thread' || bare === 'slack_read_channel') && ti.response_format !== 'detailed') return { behavior: 'allow', updatedInput: { ...ti, response_format: 'detailed' } };
      return { behavior: 'allow', updatedInput: ti };
    };

    const cwd = this.o.cwd ?? defaultScannerCwd();
    const gateway = this.o.gateway ?? (this.o.queryFn ? { env: {} } : claudeGatewayConfig());
    if (!this.o.queryFn) fs.mkdirSync(cwd, { recursive: true });
    let stderrTail = '';
    const options: Options = {
      model: input.model,
      effort: input.effort ?? this.o.effort ?? 'low',
      tools: [],
      mcpServers: { ...(input.mcpServers as Record<string, McpServerConfig>), [CC_SERVER_NAME]: ccServer },
      strictMcpConfig: true,
      // No `allowedTools`: bare entries would auto-approve before the gate (SDK-1).
      disallowedTools: disallowedFor(allowed),
      permissionMode: 'default',
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }], PostToolUse: [{ hooks: [postToolUse] }] },
      // COST-8: no settings files; the gateway env and apiKeyHelper below are what the run needs from them.
      settingSources: this.o.settingSources ?? scannerSettingSources(),
      // Hide the CLI's skill listing: scanners never use the Skill tool, and the listing costs prompt tokens.
      skills: [],
      persistSession: false,
      maxTurns: input.maxTurns,
      // With a spend gate the SDK budget is the runaway guard only, never the soft line (04 §4.3).
      maxBudgetUsd: input.spend ? Math.max(input.costCapUsd, input.spend.ceilingUsd()) : input.costCapUsd,
      systemPrompt,
      env: this.o.env ?? scannerEnv(gateway.env),
      ...(gateway.apiKeyHelper ? { settings: { apiKeyHelper: gateway.apiKeyHelper } } : {}),
      cwd,
      pathToClaudeCodeExecutable: this.o.pathToClaudeCodeExecutable ?? defaultClaudeExecutable(),
      abortController: ac,
      stderr: (d: string) => {
        stderrTail = (stderrTail + d).slice(-4000);
      },
    };

    // ---- run
    const usageByMsg = new Map<string, { model: string; cost: number; prompt: number; usage: UsageTotals }>();
    /** H-5: the hold was passed; the next tool call is the turn boundary where the run stops and asks. */
    let spendAsk = false;
    /** How far a windowed run got: its own coverage's furthest end across the window (null without a window). */
    const pctDone = (): number | null => {
      const from = Date.parse(window.from);
      const to = Date.parse(window.to);
      if (!(to > from)) return null;
      const ends = state.coverage.map((c) => Date.parse(c.to ?? '')).filter((t) => Number.isFinite(t));
      return ends.length ? Math.round((Math.min(to, Math.max(...ends)) - from) / (to - from) * 100) : 0;
    };
    let firstPromptChecked = false;
    const result: ScanSkillRunResult = { ...base };
    let sawResult = false;
    let lastText = ''; // the agent's last prose reply: says why a run ended without cc_finish (redacted, truncated)
    const toolUses = new Map<string, { name: string; input: unknown }>(); // REC-1 fallback when hooks do not fire
    const traced = new Map<string, { name: string; input: unknown; t0: number }>(); // the trace: every tool call, from the stream
    let toolCount: number | null = null;
    const seen: { toolSchemaTokens?: number } = {};
    let contextAsked = false;
    log({ event: 'start', detail: `${path.basename(input.skillPath)} model=${input.model} tools=${allowed.length}` });
    const q = (this.o.queryFn ?? (sdkQuery as unknown as QueryFn))({ prompt, options });
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          for (const s of msg.mcp_servers ?? []) {
            if (s.name === CC_SERVER_NAME) continue;
            const c = classifyMcpStatus(s.status);
            if (c) {
              log({ event: 'init', code: c.code, detail: s.name });
              fail({ message: `mcp server ${s.name} status ${s.status}`, errorClass: c.errorClass, code: c.code });
            }
          }
          toolCount = (msg.tools ?? []).length;
          const unexpected = (msg.tools ?? []).filter((t) => t.startsWith('mcp__') && !allowSet.has(t));
          if (unexpected.length) log({ event: 'init', code: 'unexpected_tools_loaded', detail: unexpected.slice(0, 10).join(',') });
        } else if (msg.type === 'assistant') {
          const m = msg.message as unknown as { id?: string; model?: string; content?: Array<{ type: string; name?: string; text?: string }>; usage?: Record<string, number | null> };
          for (const block of m.content ?? []) {
            if (block.type === 'tool_use' && block.name) guard(block.name, 'assistant_tool_use');
            if (rec && block.type === 'tool_use' && block.name) toolUses.set((block as { id?: string }).id ?? '', { name: block.name, input: (block as { input?: unknown }).input });
            if (block.type === 'tool_use' && block.name) traced.set((block as { id?: string }).id ?? '', { name: block.name, input: (block as { input?: unknown }).input, t0: Date.now() });
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) lastText = block.text;
          }
          const errCode = (msg as { error?: string }).error;
          if (errCode) {
            const cls: ErrorClass = errCode === 'authentication_failed' || errCode === 'oauth_org_not_allowed' ? 'auth' : errCode === 'rate_limit' ? 'rate_limited' : errCode === 'overloaded' || errCode === 'server_error' ? 'transient' : errCode === 'model_not_found' || errCode === 'invalid_request' ? 'config' : 'unknown';
            fail({ message: `assistant error ${errCode}`, errorClass: cls, code: errCode });
          }
          if (m.usage) {
            const model = m.model ?? input.model;
            const promptTokens = (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
            const msgKey = m.id ?? `anon-${usageByMsg.size}`;
            usageByMsg.set(msgKey, { model, cost: estimateCallCostUsd(model, m.usage), prompt: promptTokens, usage: usageFromBlock(model, m.usage) });
            meter.observe(msgKey, model, m.usage);
            // ask #14: this request's cost is in the database before the next tool runs (a kill now still books it)
            await turns?.observe(msgKey, model, m.usage);
            if (!contextAsked && q.getContextUsage) {
              // 0027 / COST-8: what the context holds (tool schemas vs system prompt vs messages), once per run, never
              // awaited in the stream: the answer lands while the run goes on.
              contextAsked = true;
              void q
                .getContextUsage({ detail: 'summary' })
                .then((c) => {
                  const rows = (c?.categories ?? []).filter((x) => x.kind !== 'deferred');
                  seen.toolSchemaTokens = rows.filter((x) => x.id && TOOL_ROWS.has(x.id)).reduce((a, x) => a + (x.tokens ?? 0), 0);
                  trace(input.runId, 'context', { pass: input.pass ?? 'traversal', total: c?.totalTokens ?? null, rows: rows.map((x) => ({ id: x.id ?? null, tokens: x.tokens ?? 0 })) });
                })
                .catch(() => undefined);
            }
            if (!firstPromptChecked) {
              firstPromptChecked = true;
              // The tripwire guards what we do not send ourselves (SDK prompt + tool schemas): everything we send,
              // the prefetched payload included (G-3), is counted at 2 characters per token (TRIP-2).
              const limit = prefixTripwireLimit(sent, this.o.prefixTripwireTokens);
              trace(input.runId, 'prompt', { pass: input.pass ?? 'traversal', model, tokens: promptTokens, limit, headroom: limit - promptTokens, proseChars: sent.proseChars, dataChars: sent.dataChars });
              if (promptTokens > limit) {
                trace(input.runId, 'tripwire', { pass: input.pass ?? 'traversal', tokens: promptTokens, limit });
                fail({ message: `prefix tripwire: first call prompt ${promptTokens} tokens > ${limit}`, errorClass: 'config', code: 'prefix_tripwire' });
              }
            }
            const est = [...usageByMsg.values()].reduce((a, u) => a + u.cost, 0);
            if (input.spend) {
              // tick: the hold sees the run's spend after every request; 'ask' stops it at the next tool call
              if (!spendAsk && input.spend.observe(est) === 'ask') {
                spendAsk = true;
                log({ event: 'cost', code: 'spend_over_hold', costUsd: est });
              }
            } else if (est > input.costCapUsd) {
              log({ event: 'cost', code: 'cost_cap', costUsd: est });
              trace(input.runId, 'cost_cap', { pass: input.pass ?? 'traversal', estUsd: est, capUsd: input.costCapUsd, source: 'estimate' });
              fail({ message: `cost cap exceeded: est $${est.toFixed(4)} > $${input.costCapUsd}`, errorClass: 'config', code: 'cost_cap' });
            }
          }
        } else if (msg.type === 'user') {
          const content = (msg.message as { content?: unknown }).content;
          for (const b of Array.isArray(content) ? (content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) : []) {
            const tc = b.type === 'tool_result' && b.tool_use_id ? traced.get(b.tool_use_id) : undefined;
            if (tc) {
              traced.delete(b.tool_use_id!);
              const dg = digests.get(b.tool_use_id!);
              trace(input.runId, 'tool_call', () => ({ pass: input.pass ?? 'traversal', tool: bareToolName(tc.name), server: tc.name.startsWith('mcp__') ? (tc.name.split('__')[1] ?? null) : null, args: traceArgs(tc.name, tc.input), ms: Date.now() - tc.t0, ...traceResult(b.content), ...(dg ? { rawSize: dg.rawChars, digest: true } : {}), error: b.is_error ? traceError(b.content) : null }));
            }
            if (!rec) continue;
            const tu = b.type === 'tool_result' && !b.is_error && b.tool_use_id ? toolUses.get(b.tool_use_id) : undefined;
            if (tu) await rec.onToolResult(tu.name, tu.input, b.content, b.tool_use_id);
          }
        } else if (msg.type === 'result') {
          sawResult = true;
          result.costUsd = msg.total_cost_usd ?? 0;
          result.turns = msg.num_turns ?? 0;
          // D0: uncached input, output, cache reads and writes, per model (cache is no longer folded into input).
          const usage = usageFromModelUsage(msg.modelUsage as Record<string, unknown> | undefined) ?? usageFromBlock(input.model, msg.usage as unknown as Record<string, number | undefined>);
          setUsage(result, usage);
          for (const d of msg.permission_denials ?? []) guard(d.tool_name, 'permission_denial');
          if (msg.subtype === 'success') {
            if (msg.is_error) {
              const c = classifyError(msg.result);
              fail({ message: safeLogText(msg.result, 300), errorClass: c.errorClass, code: c.code });
            }
          } else if (msg.subtype === 'error_max_budget_usd') {
            trace(input.runId, 'cost_cap', { pass: input.pass ?? 'traversal', estUsd: msg.total_cost_usd ?? null, capUsd: input.costCapUsd, source: 'sdk' });
            fail({ message: 'cost cap exceeded (SDK maxBudgetUsd)', errorClass: 'config', code: 'cost_cap' });
          } else if (msg.subtype === 'error_max_turns') {
            if (!state.finished) fail({ message: `max_turns (${input.maxTurns}) reached before cc_finish`, errorClass: 'unknown', code: 'max_turns' });
          } else {
            const text = (msg.errors ?? []).join(' | ') || stderrTail;
            const c = classifyError(text);
            fail({ message: safeLogText(text || msg.subtype, 300), errorClass: c.errorClass, code: c.code });
          }
          log({ event: 'result', code: msg.subtype, costUsd: result.costUsd });
        }
      }
    } catch (err) {
      if (!error) {
        const text = `${errorText(err)} ${stderrTail}`;
        const c = classifyError(text);
        fail({ message: safeLogText(errorText(err), 300), errorClass: c.errorClass, code: c.code });
      }
    } finally {
      clearTimeout(watchdog);
      input.signal.removeEventListener('abort', onExternalAbort);
      try {
        q.close?.();
      } catch {
        /* already closed */
      }
    }

    if (!sawResult && !result.costUsd) {
      result.costUsd = [...usageByMsg.values()].reduce((a, u) => a + u.cost, 0);
    }
    input.spend?.endQuery(result.costUsd);
    // 0027: what this query measured. Turns are the requests seen with usage (so a booked turn always has its size).
    result.measure = { ...meter.measure(), ...(toolCount != null ? { toolCount } : {}), ...(seen.toolSchemaTokens != null ? { toolSchemaTokens: seen.toolSchemaTokens } : {}), ...(prefixHash ? { prefixHash } : {}) };
    // A run that died before its result message: its tokens come from the per-message usage blocks.
    if (!sawResult && usageByMsg.size) setUsage(result, addUsage(...[...usageByMsg.values()].map((u) => u.usage)));
    result.counts = { ...state.counts };
    if (state.finished) {
      result.proposedCursor = state.finished.cursor;
      result.summary = state.finished.summary;
      result.complete = state.finished.complete;
      // ORG-3: the agent called a windowed Org62 run incomplete, yet no query reached its LIMIT and its own coverage
      // reaches the window end: by the skill's paging rule the window was read whole. Without this, the store clamps
      // the run's coverage to its (wrong) cursor and the weeks become holes.
      if (org62Pages && !error && !state.finished.complete && ORG62_WINDOWED.has(input.context.scope.scope) && org62Pages.readWhole()) {
        // The agent believed it paged out, so it reported its query windows only up to its cursor. Every query ran
        // under its LIMIT, so each one read the whole window: restate their coverage over it.
        if (ownCoverageHole(state.coverage, window.from, window.to)) {
          const refs = [...new Set(state.coverage.filter((c) => c.kind === 'query_window').map((c) => c.ref))];
          const whole = refs.map((ref) => ({ kind: 'query_window' as const, ref, from: window.from, to: window.to, meta: { restated: 'org62 paging rule (ORG-3)' } }));
          if (whole.length) {
            await store.reportCoverage(input.runId, whole);
            state.coverage.push(...whole);
          }
        }
        if (!ownCoverageHole(state.coverage, window.from, window.to)) {
          result.complete = true;
          result.proposedCursor = { value: soqlDateTime(window.to), at: new Date(window.to).toISOString() };
          log({ event: 'tool', code: 'org62_complete_by_paging_rule' });
        }
      }
      // ORG-5 (REC-2): the runner recorded every row it saw and knows where each query got to. A finish that left a
      // full page behind (incomplete with its cursor at the window start, or "complete" without paging on) resumes
      // from the earliest last row among the queries whose page was full, with coverage up to it: the window always
      // moves on, and no row past the cursor is claimed.
      const resume = rec instanceof Org62AutoRecorder && !error ? rec.resumePoint() : null;
      if (resume && Date.parse(resume.stamp) >= Date.parse(window.from) && Date.parse(resume.stamp) < Date.parse(window.to)) {
        const at = new Date(resume.stamp).toISOString();
        const agentAt = result.complete ? Date.parse(window.to) : Date.parse(result.proposedCursor?.at ?? window.from);
        if (result.complete || !(agentAt > Date.parse(at))) {
          const refs = [...new Set([...state.coverage.filter((c) => c.kind === 'query_window').map((c) => c.ref), ...(rec as Org62AutoRecorder).queriedRefs()])];
          const upTo = refs.map((ref) => ({ kind: 'query_window' as const, ref, from: window.from, to: at, meta: { restated: 'org62 rows read (ORG-5)', ...(state.coverageMeta?.({ kind: 'query_window', ref, from: window.from, to: at }) ?? {}) } }));
          await store.reportCoverage(input.runId, upTo);
          state.coverage.push(...upTo);
          result.complete = false;
          result.proposedCursor = { value: `${resume.stamp}|${resume.id}`, at };
          log({ event: 'tool', code: 'org62_resume_from_rows_read' });
        }
      }
      // ORG-6: a windowed scope that ran no SOQL query read nothing, whatever it reports. Stage 1 attempt 7: in mode
      // backfill the agent applied the unwindowed skip (§3) to `opps`, reported `soql:org62:opps:skipped` over the
      // window and finished complete over a 1,148-row week. The run stays incomplete at the window start (no coverage,
      // so the store keeps the hole and the runtime retries).
      if (org62Pages && !error && ORG62_WINDOWED.has(input.context.scope.scope) && org62Pages.queries === 0) {
        result.complete = false;
        result.proposedCursor = { value: soqlDateTime(window.from), at: new Date(window.from).toISOString() };
        log({ event: 'tool', code: 'org62_windowed_without_query' });
      }
    }
    if (error) {
      log({ event: 'error', code: error.code, tool: error.disallowedTool, detail: error.message });
      result.ok = false;
      result.error = { message: error.message, errorClass: error.errorClass, ...(error.disallowedTool ? { disallowedTool: error.disallowedTool } : {}) };
      return { result, state, rec };
    }
    if (input.pass) {
      result.ok = true;
      return { result, state, rec };
    }
    if (!state.finished) {
      result.ok = false;
      const why = lastText ? ` (last reply: ${safeLogText(lastText, 160)})` : '';
      result.error = { message: `run ended without cc_finish${why}`, errorClass: 'unknown' };
      return { result, state, rec };
    }
    // Brief fallback (scan-watch): a HIGHLIGHTS v1 block in the summary when the tool was not used.
    const briefStore = store as ScannerStoreWithBriefs;
    if (!state.brief && briefStore.recordBriefHighlights && state.briefDefaults.subscription) {
      const parsed = parseHighlightsBlock(state.finished.summary, state.recorded);
      if (parsed) {
        try {
          const r = await briefStore.recordBriefHighlights(input.runId, { subscription: state.briefDefaults.subscription, period: state.briefDefaults.period, summary: parsed.summary, highlights: parsed.highlights });
          state.brief = { briefId: r.briefId, highlights: parsed.highlights.length };
        } catch (err) {
          log({ event: 'error', code: 'brief_fallback_failed', detail: safeLogText(errorText(err), 160) });
        }
      }
    }
    result.ok = true;
    return { result, state, rec };
  }
}

/** Exposed for tests and the scripted runner. */
export type { CcRunState };
