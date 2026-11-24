/**
 * ModelProvider: the reasoning seam (08-connectors-providers §4, R6; decision H-4 "seam now, OpenAI adapter on
 * demand"). A provider knows models, prices and how to run a prompt; it knows nothing about sources. How a source's
 * read tool is called is the other seam, `ConnectorRuntime` (src/connectors/runtime): Slack and Org62 reads stay MCP
 * through Claude Code whatever provider reasons (H-3).
 *
 * Two entry points:
 *  - `complete()`: one prompt in, text (and optional tool calls) out; no tool loop, no filesystem, no settings. What a
 *    batched, tool-less classification or a draft needs, and what any provider can implement with a plain API call.
 *  - `run()`: an agentic run (tool loop, MCP servers, hooks, permission gate). Its spec is the provider's own harness
 *    options (`AgentRunSpec<O>`); today that is the Claude Agent SDK's `query()` and its `Options`, and every caller in
 *    the app reaches it through `agentQuery` (src/llm/provider/index.ts). A second provider maps the subset it can
 *    host or refuses with `NotImplemented`.
 *
 * Only `src/llm/provider/**` and `src/llm/claude-env.ts` may import `@anthropic-ai/claude-agent-sdk` (eslint rule,
 * tests/llm/provider/sdk-imports.test.ts).
 */
import type { ZodRawShape } from 'zod';

import type { ModelPrice, ModelTier } from '@/llm/models';

export type { ModelPrice, ModelTier } from '@/llm/models';

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool a `complete()` call offers; the provider returns the calls the model asked for, it never runs them. */
export interface ProviderToolDef {
  name: string;
  description: string;
  /** zod raw shape of the input (the same shapes the in-process cc tools use). */
  shape: ZodRawShape;
}

export interface CompleteInput {
  /** A tier (`fast` …) or a provider model id. */
  model: string | ModelTier;
  system: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  maxTokens: number;
  /**
   * Character offset into `system` where the static, cacheable prefix ends (everything after it varies per call).
   * The Agent SDK adapter puts `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` there; a provider with automatic prefix caching ignores it.
   */
  cacheBoundary?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Hard stop for this call (USD). */
  budgetUsd?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProviderToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** A provider-neutral usage record; the existing `llm_calls` token and cost columns take it as is (no migration). */
export interface ProviderUsage {
  provider: string;
  model: string;
  /** Uncached input only; cache reads and writes are their own fields (D0). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** True when the provider gave no price and the cost came from the rate card. */
  costEstimated: boolean;
}

export interface CompleteResult {
  ok: boolean;
  text: string;
  toolCalls?: ProviderToolCall[];
  usage: ProviderUsage;
  /** Short, redacted reason when not ok; never a prompt or a body. */
  error?: string;
}

/** An agentic run: the prompt and the provider's own harness options. */
export interface AgentRunSpec<O = unknown> {
  prompt: string;
  options?: O;
}

/** What `run()` returns: the provider's message stream, closable. */
export type AgentRun<M = unknown> = AsyncIterable<M> & { close?: () => void };

export interface ModelProvider<S = AgentRunSpec, M = unknown> {
  /** Stable id: `anthropic-agent-sdk`, `openai` … */
  readonly id: string;
  /** Tier → this provider's model id. */
  readonly tiers: Readonly<Record<ModelTier, string>>;
  /** Model id → list price (the cost estimate before a result carries the real one). */
  readonly prices: Readonly<Record<string, ModelPrice>>;
  complete(input: CompleteInput): Promise<CompleteResult>;
  run(spec: S): AgentRun<M>;
}

export class NotImplemented extends Error {
  override name = 'NotImplemented';
  constructor(what: string) {
    super(`${what} is not implemented (adapter on demand, decision H-4)`);
  }
}
