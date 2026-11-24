/**
 * The read-in research agent: one Agent SDK `query()` (Sonnet, SCANNER.md §7 "smarter work uses a higher tier"),
 * following the scanner's restricted-MCP technique (brief 09 §5.10) without reusing the scanner code:
 *
 *  - Loads ONLY Slack (search + read thread), Org62 (SOQL read) and the in-process `cc_readin` server
 *    (`strictMcpConfig`, `tools: []`: no built-ins, so no web search, no shell, no files).
 *  - Exact allowlist. A call to anything else aborts the whole run with `disallowed_tool`: a PreToolUse hook, the
 *    `canUseTool` fallback, a scan of assistant `tool_use` blocks, and the result's `permission_denials`.
 *  - `permissionMode: 'dontAsk'`, so nothing outside the allowlist can be approved by a classifier.
 *  - Budget: `maxTurns`, SDK `maxBudgetUsd`, and a running estimate from per-message usage that aborts the moment the
 *    per-read-in cap is crossed. With a spend gate (the job's governor hold, caps audit 26 F-4) the estimate is reported
 *    after every request instead; past the hold the run raises a hand and ends `paused_for_spend` (the job queues its
 *    continuation), and the SDK budget and turns are the runaway guard only. A watchdog, and the job's AbortSignal
 *    (cancel = superseded by new evidence).
 *  - Clean env (scannerEnv: never the parent Claude's session variables) + the user's gateway config.
 *  - Logs carry ids, tool names and codes only.
 */
import fs from 'node:fs';

import {
  agentQuery as sdkQuery,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from '@/llm/provider';

import { claudeGatewayConfig, scannerEnv, type GatewayConfig } from '@/llm/claude-env';
import { PAUSED_FOR_SPEND, RUNAWAY_TURNS, type SpendGate } from '@/llm/spend';
import { defaultClaudeExecutable, defaultScannerCwd } from '@/llm/env';
import { classifyError, classifyMcpStatus, errorText, type ErrorClass } from '@/llm/errors';
import { assertReadOnly, disallowedFor } from '@/llm/mcp-config';
import { estimateCallCostUsd } from '@/llm/models';
import { safeLogText } from '@/llm/redact';
import { isRealTool } from '@/llm/skill-runner';
import { addUsage, usageFromBlock, usageFromModelUsage, type UsageTotals } from '@/llm/usage';

import { buildReadInServer, READIN_ALLOWED_TOOLS, READIN_SERVER, rememberUrls, type ReadInToolState, type ToolHandlerMap } from './tools';
import type { ReadInOutput } from './types';

export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY };

export interface ResearchRunInput {
  runId: string;
  model: string;
  effort?: EffortLevel;
  /** [static skill + draft style, BOUNDARY, context pack]; the static prefix is cacheable. */
  systemPrompt: string[];
  prompt: string;
  /** External read-only MCP servers (Slack, Org62), redeclared from ~/.claude.json (non-secret fields only). */
  mcpServers: Record<string, McpServerConfig>;
  /** Full names of the external tools allowed (e.g. mcp__slack__slack_read_thread). */
  externalTools: string[];
  handlers: ToolHandlerMap;
  state: ReadInToolState;
  maxTurns: number;
  costCapUsd: number;
  /** F-4: the job's spend hold. Present: `costCapUsd` and `maxTurns` are only floors of the runaway guard. */
  spend?: SpendGate | null;
  /** With a spend hold: the user budget the run never passes (the day lines that are left); the SDK budget stops there. */
  userLineUsd?: number;
  signal: AbortSignal;
  /** Called on every allowed tool call (progress for the UI). */
  onTool?: (fullName: string) => void;
  /**
   * Another in-process read-only server instead of `cc_readin` (chat research, src/llm/research/): its full tool names
   * join the allowlist, and `done()` replaces "readin_finish was called" as the success check.
   */
  local?: { name: string; server: McpSdkServerConfigWithInstance; tools: string[]; done: () => boolean; call?: (bare: string, args: unknown) => Promise<{ text: string; isError?: boolean }> };
}

export interface ResearchRunResult {
  ok: boolean;
  output: ReadInOutput | null;
  costUsd: number;
  /** Uncached input (D0); cache reads and writes are their own fields. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  turns: number;
  toolCalls: string[];
  error?: { code: string; message: string; errorClass: ErrorClass; disallowedTool?: string };
}

/** Same signature as the SDK `query`, plus the in-process handlers so scripted fakes can execute tool calls. */
export type ReadInQueryFn = (params: { prompt: string; options: Options; handlers: ToolHandlerMap; state: ReadInToolState }) => AsyncIterable<SDKMessage> & { close?: () => void };

export interface ResearchAgent {
  run(input: ResearchRunInput): Promise<ResearchRunResult>;
}

export interface SdkResearchAgentOptions {
  queryFn?: ReadInQueryFn;
  gateway?: GatewayConfig;
  cwd?: string;
  pathToClaudeCodeExecutable?: string;
  /** Watchdog per read-in. Default 240 s. */
  timeoutMs?: number;
  /** Abort if the first call's prompt exceeds this (tool-schema overhead tripwire). Default 40 000. */
  prefixTripwireTokens?: number;
  logger?: (e: { runId: string; event: string; tool?: string; code?: string; costUsd?: number; detail?: string }) => void;
}

const realQuery: ReadInQueryFn = ({ prompt, options }) => sdkQuery({ prompt, options }) as ReturnType<ReadInQueryFn>;

export class SdkResearchAgent implements ResearchAgent {
  constructor(private readonly o: SdkResearchAgentOptions = {}) {}

  async run(input: ResearchRunInput): Promise<ResearchRunResult> {
    const log = (e: { event: string; tool?: string; code?: string; costUsd?: number; detail?: string }) => this.o.logger?.({ runId: input.runId, ...e });
    const result: ResearchRunResult = { ok: false, output: null, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: [] };
    const localName = input.local?.name ?? READIN_SERVER;
    const allowed = [...new Set([...input.externalTools, ...(input.local?.tools ?? READIN_ALLOWED_TOOLS)])];
    try {
      assertReadOnly(allowed);
    } catch (err) {
      result.error = { code: 'disallowed_tool', message: safeLogText(errorText(err), 200), errorClass: 'config' };
      return result;
    }
    const allowSet = new Set(allowed);
    const ac = new AbortController();
    let error: ResearchRunResult['error'];
    const fail = (e: NonNullable<ResearchRunResult['error']>) => {
      if (!error) error = e;
      if (!ac.signal.aborted) ac.abort();
    };
    const guard = (tool: string, where: string): 'allow' | 'abort' | 'unknown' => {
      if (allowSet.has(tool)) return 'allow';
      if (isRealTool(tool)) {
        log({ event: 'denied', tool, code: where });
        fail({ code: 'disallowed_tool', message: `disallowed tool call: ${tool}`, errorClass: 'config', disallowedTool: tool });
        return 'abort';
      }
      log({ event: 'denied', tool, code: `unknown_tool_name:${where}` });
      return 'unknown';
    };
    const onExternalAbort = () => fail({ code: 'cancelled', message: 'aborted by caller', errorClass: 'transient' });
    if (input.signal.aborted) onExternalAbort();
    input.signal.addEventListener('abort', onExternalAbort, { once: true });
    const timeoutMs = this.o.timeoutMs ?? 240_000;
    const watchdog = setTimeout(() => fail({ code: 'timeout', message: `watchdog: read-in exceeded ${timeoutMs} ms`, errorClass: 'transient' }), timeoutMs);

    const preToolUse: HookCallback = async (h) => {
      if (h.hook_event_name !== 'PreToolUse') return {};
      const g = guard(h.tool_name, 'pre_tool_use');
      if (g === 'allow') {
        result.toolCalls.push(h.tool_name);
        log({ event: 'tool', tool: h.tool_name });
        input.onTool?.(h.tool_name);
        // No decision: a hook `allow` would skip the canUseTool gate (SDK-1 pattern, READIN-1). The gate approves.
        return {};
      }
      const deny = { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'not on the read-in allowlist' };
      return g === 'abort' ? { continue: false, stopReason: 'disallowed tool', hookSpecificOutput: deny } : { hookSpecificOutput: deny };
    };
    /** The allowlist gate: every tool call is decided here (READIN-1, as SDK-1 did for the scanner). */
    const canUseTool: CanUseTool = async (toolName, toolInput) => {
      const g = guard(toolName, 'can_use_tool');
      return g === 'allow' ? { behavior: 'allow', updatedInput: (toolInput ?? {}) as Record<string, unknown> } : { behavior: 'deny', message: 'not on the read-in allowlist', interrupt: g === 'abort' };
    };

    const gateway = this.o.gateway ?? (this.o.queryFn ? { env: {} } : claudeGatewayConfig());
    const cwd = this.o.cwd ?? defaultScannerCwd();
    if (!this.o.queryFn) fs.mkdirSync(cwd, { recursive: true });
    let stderrTail = '';
    const options: Options = {
      model: input.model,
      effort: input.effort ?? 'medium',
      tools: [],
      mcpServers: { ...input.mcpServers, [localName]: input.local?.server ?? buildReadInServer(input.handlers, input.state) },
      strictMcpConfig: true,
      // No bare `allowedTools` and no `dontAsk`: they approve (or decide) before the canUseTool gate, which the SDK then
      // never calls (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED in the worker log on the first live day). Everything outside the
      // allowlist stays in `disallowedTools`, so it is never in the model's context (READIN-1).
      disallowedTools: disallowedFor(allowed),
      permissionMode: 'default',
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      settingSources: ['user'],
      skills: [],
      persistSession: false,
      maxTurns: input.spend ? Math.max(input.maxTurns, RUNAWAY_TURNS) : input.maxTurns,
      maxBudgetUsd: input.spend ? Math.min(input.userLineUsd ?? Number.POSITIVE_INFINITY, Math.max(input.costCapUsd, input.spend.ceilingUsd())) : input.costCapUsd,
      systemPrompt: input.systemPrompt,
      env: scannerEnv(gateway.env),
      ...(gateway.apiKeyHelper ? { settings: { apiKeyHelper: gateway.apiKeyHelper } } : {}),
      cwd,
      pathToClaudeCodeExecutable: this.o.pathToClaudeCodeExecutable ?? defaultClaudeExecutable(),
      abortController: ac,
      stderr: (d: string) => {
        stderrTail = (stderrTail + d).slice(-4000);
      },
    };

    const usage = new Map<string, number>();
    const blocks = new Map<string, UsageTotals>(); // D0: the tokens behind each estimate (a run that dies before its result)
    let firstChecked = false;
    let sawResult = false;
    log({ event: 'start', detail: `model=${input.model} tools=${allowed.length}` });
    const q = (this.o.queryFn ?? realQuery)({ prompt: input.prompt, options, handlers: input.handlers, state: input.state });
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          for (const s of msg.mcp_servers ?? []) {
            if (s.name === localName) continue;
            const c = classifyMcpStatus(s.status);
            if (c) fail({ code: c.code, message: `mcp server ${s.name} status ${s.status}`, errorClass: c.errorClass });
          }
        } else if (msg.type === 'assistant') {
          const m = msg.message as unknown as { id?: string; model?: string; content?: Array<{ type: string; name?: string }>; usage?: Record<string, number | null> };
          for (const b of m.content ?? []) if (b.type === 'tool_use' && b.name) guard(b.name, 'assistant_tool_use');
          const errCode = (msg as { error?: string }).error;
          if (errCode) {
            const cls: ErrorClass = errCode === 'authentication_failed' ? 'auth' : errCode === 'rate_limit' ? 'rate_limited' : errCode === 'overloaded' || errCode === 'server_error' ? 'transient' : 'unknown';
            fail({ code: errCode, message: `assistant error ${errCode}`, errorClass: cls });
          }
          if (m.usage) {
            const prompt = (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
            const key = m.id ?? `anon-${usage.size}`;
            usage.set(key, estimateCallCostUsd(m.model ?? input.model, m.usage));
            blocks.set(key, usageFromBlock(m.model ?? input.model, m.usage));
            if (!firstChecked) {
              firstChecked = true;
              if (prompt > (this.o.prefixTripwireTokens ?? 40_000)) fail({ code: 'prefix_tripwire', message: `first prompt ${prompt} tokens`, errorClass: 'config' });
            }
            const est = [...usage.values()].reduce((a, c) => a + c, 0);
            if (input.spend) {
              // a user budget (the day line left) stays a line
              if (input.userLineUsd != null && est > input.userLineUsd) fail({ code: 'cost_cap', message: `the day's budget is reached: est $${est.toFixed(4)} > $${input.userLineUsd.toFixed(4)}`, errorClass: 'config' });
              // H-5: past the hold, raise a hand and stop here (what was read stays booked; the continuation reruns it)
              else if (!error && input.spend.observe(est) === 'ask') {
                await input.spend.ask({ pctDone: null }).catch(() => undefined);
                log({ event: 'paused', code: PAUSED_FOR_SPEND, costUsd: est });
                fail({ code: PAUSED_FOR_SPEND, message: `paused for spend: $${est.toFixed(4)} of a $${input.spend.hold.heldUsd.toFixed(4)} hold`, errorClass: 'config' });
              }
            } else if (est > input.costCapUsd) fail({ code: 'cost_cap', message: `cost cap exceeded: est $${est.toFixed(4)} > $${input.costCapUsd}`, errorClass: 'config' });
          }
        } else if (msg.type === 'user') {
          // Tool results from the external servers (Slack, Org62): remember their links so the output may cite them.
          const content = (msg.message as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const b of content as Array<{ type?: string; content?: unknown }>) {
              if (b.type !== 'tool_result') continue;
              const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map((x) => x.text ?? '').join('\n') : '';
              if (text) rememberUrls(text, input.state);
            }
          }
        } else if (msg.type === 'result') {
          sawResult = true;
          result.costUsd = msg.total_cost_usd ?? 0;
          result.turns = msg.num_turns ?? 0;
          // D0: cache reads and writes are booked apart from uncached input.
          const u = usageFromModelUsage(msg.modelUsage as Record<string, unknown> | undefined);
          result.inputTokens = u?.inputTokens ?? 0;
          result.outputTokens = u?.outputTokens ?? 0;
          result.cacheReadTokens = u?.cacheReadTokens ?? 0;
          result.cacheWriteTokens = u?.cacheWriteTokens ?? 0;
          for (const d of msg.permission_denials ?? []) guard(d.tool_name, 'permission_denial');
          if (msg.subtype === 'success') {
            if (msg.is_error) {
              const c = classifyError(msg.result);
              fail({ code: c.code, message: safeLogText(msg.result, 300), errorClass: c.errorClass });
            }
          } else if (msg.subtype === 'error_max_budget_usd') {
            fail({ code: 'cost_cap', message: 'cost cap exceeded (SDK maxBudgetUsd)', errorClass: 'config' });
          } else if (msg.subtype === 'error_max_turns') {
            if (!(input.local ? input.local.done() : input.state.output)) fail({ code: 'max_turns', message: `max_turns (${input.maxTurns}) reached before the finish call`, errorClass: 'unknown' });
          } else {
            const text = (msg.errors ?? []).join(' | ') || stderrTail;
            const c = classifyError(text);
            fail({ code: c.code, message: safeLogText(text || msg.subtype, 300), errorClass: c.errorClass });
          }
          log({ event: 'result', code: msg.subtype, costUsd: result.costUsd });
        }
      }
    } catch (err) {
      if (!error) {
        const c = classifyError(`${errorText(err)} ${stderrTail}`);
        fail({ code: c.code, message: safeLogText(errorText(err), 300), errorClass: c.errorClass });
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
    if (!sawResult && !result.costUsd) result.costUsd = [...usage.values()].reduce((a, c) => a + c, 0);
    if (!sawResult && blocks.size) {
      // D0: no result message (aborted, superseded, a disallowed tool): its tokens are the per-message usage blocks.
      const u = addUsage(...blocks.values());
      Object.assign(result, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens });
    }
    result.output = input.state.output;
    if (error) {
      log({ event: 'error', code: error.code, tool: error.disallowedTool });
      result.error = error;
      return result;
    }
    if (!(input.local ? input.local.done() : input.state.output)) {
      result.error = { code: 'invalid_output', message: 'run ended without a valid finish call', errorClass: 'unknown' };
      return result;
    }
    result.ok = true;
    return result;
  }
}
