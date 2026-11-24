/**
 * The Claude Agent SDK provider: the one `ModelProvider` today (decision H-4). `run()` is the SDK's `query()` as the
 * app always called it; `complete()` is one tool-less turn in the scanner's clean env (no built-ins, no settings files,
 * no filesystem, every permission denied), the same shape as the completion pass (src/scanner/completion/llm.ts).
 *
 * This file and src/llm/claude-env.ts are the only places the SDK is imported (eslint `@typescript-eslint/no-restricted-imports`).
 */
import fs from 'node:fs';

import { createSdkMcpServer, query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, tool, type HookCallback, type McpServerConfig, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { claudeGatewayConfig, scannerEnv, type GatewayConfig } from '@/llm/claude-env';
import { defaultClaudeExecutable, defaultScannerCwd } from '@/llm/env';
import { ANTHROPIC_TIER_MODELS, MODEL_PRICES, resolveModel } from '@/llm/models';
import { safeLogText } from '@/llm/redact';

import type { AgentRun, CompleteInput, CompleteResult, ModelProvider, ProviderMessage, ProviderToolCall } from './types';

export type AgentQuery = typeof query;
/** The Agent SDK's own run spec (a prompt string or message stream, and its `Options`). */
export type AgentSdkRunSpec = Parameters<AgentQuery>[0];
export type AgentSdkProvider = ModelProvider<AgentSdkRunSpec, SDKMessage>;

export interface AgentSdkProviderOptions {
  /** Test seam: the SDK's `query`. A fake also skips the gateway config and the scanner cwd on disk. */
  queryFn?: AgentQuery;
  gateway?: GatewayConfig;
}

interface ResultLike {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  errors?: string[];
}

/** The in-process server a `complete()` with tools declares; its tools are never run (the hook denies and records). */
export const COMPLETE_TOOL_SERVER = 'complete';

/** One prompt string from the messages (the Agent SDK takes a single prompt; earlier turns are rendered as a transcript). */
export function renderMessages(messages: ProviderMessage[]): string {
  if (messages.length === 1 && messages[0]!.role === 'user') return messages[0]!.content;
  return messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
}

/** `system` split at the cache boundary into the SDK's static / dynamic form. */
export function systemPromptOf(system: string, cacheBoundary: number | undefined): string | string[] {
  if (cacheBoundary == null || cacheBoundary <= 0 || cacheBoundary >= system.length) return system;
  return [system.slice(0, cacheBoundary), SYSTEM_PROMPT_DYNAMIC_BOUNDARY, system.slice(cacheBoundary)];
}

export function createAgentSdkProvider(o: AgentSdkProviderOptions = {}): AgentSdkProvider {
  const q = o.queryFn ?? query;
  const tiers = ANTHROPIC_TIER_MODELS;
  return {
    id: 'anthropic-agent-sdk',
    tiers,
    prices: MODEL_PRICES,
    run(spec: AgentSdkRunSpec): AgentRun<SDKMessage> {
      return q(spec);
    },
    async complete(input: CompleteInput): Promise<CompleteResult> {
      const model = resolveModel(input.model, tiers);
      const gw = o.gateway ?? (o.queryFn ? { env: {} } : claudeGatewayConfig());
      const cwd = defaultScannerCwd();
      if (!o.queryFn) fs.mkdirSync(cwd, { recursive: true });
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      input.signal?.addEventListener('abort', onAbort, { once: true });
      const watchdog = setTimeout(() => ac.abort(), input.timeoutMs ?? 90_000);
      const calls: ProviderToolCall[] = [];
      const tools = input.tools ?? [];
      const full = (name: string) => `mcp__${COMPLETE_TOOL_SERVER}__${name}`;
      const byFull = new Map(tools.map((t) => [full(t.name), t.name]));
      // the model only proposes a call: record it and stop before anything runs
      const capture: HookCallback = async (h) => {
        if (h.hook_event_name !== 'PreToolUse') return {};
        const name = byFull.get(h.tool_name);
        if (name) calls.push({ name, input: (h.tool_input ?? {}) as Record<string, unknown> });
        return { continue: false, stopReason: 'tool call recorded', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'complete() records tool calls, it never runs them' } };
      };
      const server: Record<string, McpServerConfig> = tools.length
        ? { [COMPLETE_TOOL_SERVER]: createSdkMcpServer({ name: COMPLETE_TOOL_SERVER, version: '1.0.0', tools: tools.map((t) => tool(t.name, t.description, t.shape, async () => ({ content: [{ type: 'text' as const, text: 'not run' }] }))) }) }
        : {};
      const options: Options = {
        model,
        systemPrompt: systemPromptOf(input.system, input.cacheBoundary),
        tools: [],
        mcpServers: server,
        strictMcpConfig: true,
        settingSources: [],
        skills: [],
        maxTurns: 1,
        persistSession: false,
        permissionMode: 'dontAsk',
        ...(tools.length ? { allowedTools: [...byFull.keys()], hooks: { PreToolUse: [{ hooks: [capture] }] } } : {}),
        canUseTool: async (name, args) => {
          const t = byFull.get(name);
          if (t && !calls.some((c) => c.name === t)) calls.push({ name: t, input: args });
          return { behavior: 'deny', message: 'complete() records tool calls, it never runs them', interrupt: true };
        },
        ...(input.budgetUsd ? { maxBudgetUsd: input.budgetUsd } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        env: scannerEnv(gw.env, process.env, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.max(1, Math.round(input.maxTokens))) }),
        ...(gw.apiKeyHelper ? { settings: { apiKeyHelper: gw.apiKeyHelper } } : {}),
        cwd,
        pathToClaudeCodeExecutable: defaultClaudeExecutable(),
        abortController: ac,
      };
      let last: ResultLike | undefined;
      let failure: string | undefined;
      const run = q({ prompt: renderMessages(input.messages), options });
      try {
        for await (const msg of run as AsyncIterable<ResultLike>) if (msg.type === 'result') last = msg;
      } catch (err) {
        failure = safeLogText(err instanceof Error ? err.message : String(err), 200);
      } finally {
        clearTimeout(watchdog);
        input.signal?.removeEventListener('abort', onAbort);
        try {
          (run as { close?: () => void }).close?.();
        } catch {
          /* closed */
        }
      }
      const u = last?.usage ?? {};
      const usage = {
        provider: 'anthropic-agent-sdk',
        model,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        costUsd: last?.total_cost_usd ?? 0,
        costEstimated: false,
      };
      const ok = !failure && ((last?.subtype === 'success' && !last.is_error) || calls.length > 0);
      const why = failure ?? (last?.errors?.join('; ') || (last?.is_error ? last.result : undefined) || last?.subtype || 'no result');
      return {
        ok,
        text: ok && last?.subtype === 'success' ? (last.result ?? '') : '',
        ...(calls.length ? { toolCalls: calls } : {}),
        usage,
        ...(ok ? {} : { error: safeLogText(String(why), 200) }),
      };
    },
  };
}

export const agentSdkProvider: AgentSdkProvider = createAgentSdkProvider();
