/**
 * ONE MCP call with OUR arguments, through a minimal Agent SDK run (the model only relays it): only the given server
 * loads (`strictMcpConfig`, `tools: []`), exactly one tool is allowed, a PreToolUse hook swaps in our arguments and stops
 * anything else, and the output is read from the tool result, never from the model's words. The caller decides which
 * tool may run (src/server/onboarding/identity.ts: the scanners' read allowlist; src/outbox/relay.ts: the Outbox's).
 */
import fs from 'node:fs';

import type { CanUseTool, HookCallback, McpServerConfig, Options, SDKMessage } from '@/llm/provider';
import { agentQuery as sdkQuery } from '@/llm/provider';

import { claudeGatewayConfig, scannerEnv, scannerSettingSources, type GatewayConfig } from '@/llm/claude-env';
import { ledgerHash, type CallMeasurement } from '@/db/ledger';
import { defaultClaudeExecutable, defaultScannerCwd } from '@/llm/env';
import { classifyError, errorText } from '@/llm/errors';
import { estimateCallCostUsd, longPromptThresholdOf, SCANNER_MODEL } from '@/llm/models';
import { addUsage, RequestMeter, usageFromBlock, usageFromModelUsage, type UsageTotals } from '@/llm/usage';
import type { LoadedSkill } from '@/llm/skill-loader';
import type { QueryFn } from '@/llm/skill-runner';
import { isRealTool } from '@/llm/skill-runner';

export interface OneCallResult {
  /** The tool's own output (null when the call did not happen or failed). */
  text: string | null;
  code: string;
  message: string;
  costUsd: number;
  /** Uncached input (D0); cache reads and writes are their own fields. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model: string;
  started: boolean;
  /**
   * The one tool call was let through to the server (its PreToolUse allowed it). false with no text: the run ended
   * before it called the tool (a timeout while the model was still writing the call), so nothing reached the server.
   * Absent (a fake, an older caller): unknown, treated as "it may have been called".
   */
  called?: boolean;
  /** 0027: requests and their prompt sizes, tools loaded, and the prefix hash (callers book it as `measure`). */
  measure?: CallMeasurement;
}

/** A string argument longer than this reaches the model as a stand-in; the hook swaps the real value in. */
export const STAND_IN_OVER = 200;
export const STAND_IN = '(the app fills this in)';

/**
 * What the model is asked to pass: the same arguments with every long string replaced by a short stand-in. The model
 * only relays the call (the PreToolUse hook and canUseTool swap in `args` as they are), so it never has to re-type a
 * long value: a 74,000-character logging canvas had the model writing ~20,000 tokens of tool input, past the 90 s
 * timeout, on every Apply (2026-11-16). Short values stay as they are, so the call still reads naturally.
 */
export function relayStandIn(args: Record<string, unknown>): Record<string, unknown> {
  const one = (v: unknown): unknown => (typeof v === 'string' ? (v.length > STAND_IN_OVER ? STAND_IN : v) : Array.isArray(v) ? v.map(one) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, one(x)])) : v);
  return one(args) as Record<string, unknown>;
}

export interface OneCallInput {
  servers: Record<string, unknown>;
  /** `mcp__<server>__<tool>`: the only tool the run may call. */
  fullTool: string;
  args: Record<string, unknown>;
  allowedTools: string[];
  disallowedTools: string[];
  /** The relay skill (model, max_turns, budget_usd_per_run, body). */
  skill: LoadedSkill;
  queryFn?: QueryFn;
  gateway?: GatewayConfig;
  timeoutMs?: number;
}

/** The text of an MCP tool result, whatever wrapper it arrives in (string, content blocks, `{content}`). */
export function toolText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (Array.isArray(resp)) return resp.map(toolText).join('\n');
  if (resp && typeof resp === 'object') {
    const o = resp as { text?: unknown; content?: unknown };
    if (typeof o.text === 'string') return o.text;
    if (o.content !== undefined) return toolText(o.content);
    return JSON.stringify(resp);
  }
  return '';
}

export async function runOneToolCall(c: OneCallInput): Promise<OneCallResult> {
  const skill = c.skill;
  const model = typeof skill.frontmatter.model === 'string' ? skill.frontmatter.model : SCANNER_MODEL;
  const maxTurns = typeof skill.frontmatter.max_turns === 'number' ? skill.frontmatter.max_turns : 2;
  const cap = typeof skill.frontmatter.budget_usd_per_run === 'number' ? skill.frontmatter.budget_usd_per_run : 0.03;
  const base: OneCallResult = { text: null, code: '', message: '', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model, started: false, called: false };
  const full = c.fullTool;
  const ac = new AbortController();
  let failure: { code: string; message: string } | null = null;
  const fail = (code: string, message: string) => {
    failure ??= { code, message };
    if (!ac.signal.aborted) ac.abort();
  };
  let captured: string | null = null;
  let called = false;
  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (input.tool_name === full && captured === null) {
      called = true;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: c.args } };
    }
    const deny = { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'only the one lookup is allowed' };
    if (isRealTool(input.tool_name) && input.tool_name !== full) {
      fail('disallowed_tool', 'The lookup tried another tool and was stopped.');
      return { continue: false, stopReason: 'disallowed tool', hookSpecificOutput: deny };
    }
    return { continue: false, stopReason: 'one call only', hookSpecificOutput: deny };
  };
  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== full) return {};
    captured ??= toolText(input.tool_response);
    return { continue: false, stopReason: 'lookup captured' };
  };
  const canUseTool: CanUseTool = async (name) => {
    if (name !== full) return { behavior: 'deny', message: 'only the one lookup is allowed', interrupt: true };
    called = true;
    return { behavior: 'allow', updatedInput: c.args };
  };
  const gateway = c.gateway ?? (c.queryFn ? { env: {} } : claudeGatewayConfig());
  const cwd = defaultScannerCwd();
  if (!c.queryFn) fs.mkdirSync(cwd, { recursive: true });
  const options: Options = {
    model,
    effort: 'low',
    tools: [],
    mcpServers: c.servers as Record<string, McpServerConfig>,
    strictMcpConfig: true,
    allowedTools: c.allowedTools,
    disallowedTools: c.disallowedTools,
    permissionMode: 'dontAsk',
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUse] }], PostToolUse: [{ hooks: [postToolUse] }] },
    // COST-8: no settings files; the gateway env and apiKeyHelper are passed below.
    settingSources: scannerSettingSources(),
    skills: [],
    persistSession: false,
    maxTurns,
    maxBudgetUsd: cap,
    systemPrompt: skill.body,
    env: scannerEnv(gateway.env),
    ...(gateway.apiKeyHelper ? { settings: { apiKeyHelper: gateway.apiKeyHelper } } : {}),
    cwd,
    pathToClaudeCodeExecutable: defaultClaudeExecutable(),
    abortController: ac,
  };
  const standIn = relayStandIn(c.args);
  const filled = JSON.stringify(standIn) !== JSON.stringify(c.args) ? ` Pass "${STAND_IN}" exactly as written: the app fills in those values.` : '';
  const prompt = `## Run\nCall \`${full}\` exactly once with these arguments:\n\`\`\`json\n${JSON.stringify(standIn)}\n\`\`\`\n${filled ? `${filled.trim()}\n` : ''}Then reply DONE.`;
  const watchdog = setTimeout(() => fail('timeout', 'The lookup took too long.'), c.timeoutMs ?? 90_000);
  const usage = new Map<string, number>();
  const meter = new RequestMeter(longPromptThresholdOf);
  let toolCount: number | undefined;
  const blocks = new Map<string, UsageTotals>(); // D0: the tokens behind each estimate (a lookup that dies before its result)
  let result = { ...base, started: true };
  let resultCost: number | null = null;
  const q = (c.queryFn ?? (sdkQuery as unknown as QueryFn))({ prompt, options });
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        toolCount = (msg.tools ?? []).length;
      } else if (msg.type === 'assistant') {
        const m = msg.message as unknown as { id?: string; model?: string; content?: Array<{ type: string; name?: string }>; usage?: Record<string, number | null> };
        for (const b of m.content ?? []) if (b.type === 'tool_use' && b.name && b.name !== full && isRealTool(b.name)) fail('disallowed_tool', 'The lookup tried another tool and was stopped.');
        if (m.usage) {
          const key = m.id ?? `m${usage.size}`;
          usage.set(key, estimateCallCostUsd(m.model ?? model, m.usage));
          blocks.set(key, usageFromBlock(m.model ?? model, m.usage));
          meter.observe(key, m.model ?? model, m.usage);
          if ([...usage.values()].reduce((a, c) => a + c, 0) > cap) fail('cost_cap', 'The lookup hit its cost cap.');
        }
      } else if (msg.type === 'user' && captured === null) {
        const content = (msg.message as { content?: unknown }).content;
        if (Array.isArray(content)) for (const b of content as Array<{ type?: string; content?: unknown }>) if (b.type === 'tool_result') captured ??= toolText(b.content);
      } else if (msg.type === 'result') {
        resultCost = msg.total_cost_usd ?? null;
        // D0: cache reads and writes are booked apart from uncached input.
        const u = usageFromModelUsage(msg.modelUsage as Record<string, unknown> | undefined);
        result = { ...result, inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, cacheReadTokens: u?.cacheReadTokens ?? 0, cacheWriteTokens: u?.cacheWriteTokens ?? 0 };
        for (const d of msg.permission_denials ?? []) if (d.tool_name !== full && isRealTool(d.tool_name)) fail('disallowed_tool', 'The lookup tried another tool and was stopped.');
      }
    }
  } catch (e) {
    if (!failure && captured === null) {
      const c = classifyError(`${errorText(e)}`);
      failure = { code: c.code, message: c.errorClass === 'auth' ? 'Sign in again, then Detect again.' : 'The lookup did not finish.' };
    }
  } finally {
    clearTimeout(watchdog);
    try {
      (q as { close?: () => void }).close?.();
    } catch {
      /* closed */
    }
  }
  const costUsd = resultCost ?? [...usage.values()].reduce((a, c) => a + c, 0);
  if (resultCost === null && blocks.size) {
    const u = addUsage(...blocks.values());
    result = { ...result, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens };
  }
  // 0027: the relay's prefix is its skill plus the one tool; its requests are what the meter saw.
  result = { ...result, measure: { ...meter.measure(), ...(toolCount != null ? { toolCount } : {}), prefixHash: ledgerHash(model, full, skill.body) } };
  const f = failure as { code: string; message: string } | null;
  if (f?.code === 'disallowed_tool') return { ...result, called, costUsd, text: null, code: f.code, message: f.message };
  if (captured !== null) return { ...result, called: true, costUsd, text: captured, code: 'ok', message: '' };
  return { ...result, called, costUsd, text: null, code: f?.code ?? 'no_result', message: f?.message ?? 'The lookup did not return anything.' };
}
