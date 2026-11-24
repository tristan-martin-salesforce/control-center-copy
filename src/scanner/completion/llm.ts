/**
 * The completion check's model call: ONE Agent SDK turn with no tools at all (no built-ins, no MCP server, no
 * settings sources, every permission denied), the scanner's clean env, pinned CLI and fixed cwd. The model can
 * only answer with text; the pass parses it and writes evidence itself.
 */
import fs from 'node:fs';

import type { Options, SDKMessage } from '@/llm/provider';

import { claudeGatewayConfig, scannerEnv } from '@/llm/claude-env';
import { defaultClaudeExecutable, defaultScannerCwd } from '@/llm/env';
import { classifyError } from '@/llm/errors';
import { safeLogText } from '@/llm/redact';

import type { CompletionModel, CompletionModelRequest, CompletionModelResult } from './types';

export interface AgentSdkModelOptions {
  /** Watchdog per call (ms). Default 90 s. */
  timeoutMs?: number;
  /** Test seam: the SDK's `query`. */
  queryFn?: (p: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & { close?: () => void };
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

export function agentSdkCompletionModel(o: AgentSdkModelOptions = {}): CompletionModel {
  return async (req: CompletionModelRequest): Promise<CompletionModelResult> => {
    const query = o.queryFn ?? (await import('@/llm/provider')).agentQuery;
    const gw = o.queryFn ? { env: {} } : claudeGatewayConfig();
    const cwd = defaultScannerCwd();
    if (!o.queryFn) fs.mkdirSync(cwd, { recursive: true });
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const watchdog = setTimeout(() => ac.abort(), o.timeoutMs ?? 90_000);
    let last: ResultLike | undefined;
    const options: Options = {
      model: req.model,
      systemPrompt: req.system,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      maxTurns: 1,
      persistSession: false,
      permissionMode: 'dontAsk',
      canUseTool: async () => ({ behavior: 'deny', message: 'the completion check has no tools', interrupt: true }),
      maxBudgetUsd: req.maxBudgetUsd,
      ...(req.effort ? { effort: req.effort } : {}),
      env: scannerEnv(gw.env),
      ...(gw.apiKeyHelper ? { settings: { apiKeyHelper: gw.apiKeyHelper } } : {}),
      cwd,
      pathToClaudeCodeExecutable: defaultClaudeExecutable(),
      abortController: ac,
    };
    const q = query({ prompt: req.user, options });
    try {
      for await (const msg of q as AsyncIterable<ResultLike>) if (msg.type === 'result') last = msg;
    } catch (err) {
      const c = classifyError(err);
      const lu = last?.usage ?? {};
      return { ok: false, text: '', costUsd: last?.total_cost_usd ?? 0, inputTokens: lu.input_tokens ?? 0, outputTokens: lu.output_tokens ?? 0, cacheReadTokens: lu.cache_read_input_tokens ?? 0, cacheWriteTokens: lu.cache_creation_input_tokens ?? 0, error: { message: safeLogText(err instanceof Error ? err.message : String(err), 200), errorClass: ac.signal.aborted ? 'transient' : c.errorClass } };
    } finally {
      clearTimeout(watchdog);
      req.signal?.removeEventListener('abort', onAbort);
      try {
        (q as { close?: () => void }).close?.();
      } catch {
        /* closed */
      }
    }
    const u = last?.usage ?? {};
    // D0: cache reads and writes are booked apart from uncached input.
    const inputTokens = u.input_tokens ?? 0;
    const ok = last?.subtype === 'success' && !last.is_error;
    const why = last?.errors?.join('; ') || (last?.is_error ? last.result : undefined) || last?.subtype || 'no result';
    return {
      ok,
      text: ok ? (last?.result ?? '') : '',
      costUsd: last?.total_cost_usd ?? 0,
      inputTokens,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      ...(ok ? {} : { error: { message: safeLogText(why, 200), errorClass: last?.subtype === 'error_max_budget_usd' ? 'config' : classifyError(why).errorClass } }),
    };
  };
}
