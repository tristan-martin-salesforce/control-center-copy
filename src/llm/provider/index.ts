/**
 * The model provider every LLM call in the app goes through (08 R6, decision H-4).
 *
 *  - `modelProvider()`: the active provider (`CC_MODEL_PROVIDER`, default `anthropic-agent-sdk`; `openai` is a stub
 *    that refuses, src/llm/provider/openai.ts). `complete()` for tool-less prompts, `run()` for agentic runs.
 *  - `agentQuery`: the drop-in for the Agent SDK's `query()` that the existing runners (skill-runner, one-call, chat,
 *    read-in, research, feedback, forecast …) call. It runs on the active provider, so selecting another provider
 *    takes every agentic run with it, or fails loudly.
 *  - The Agent SDK types and in-process tool-server helpers the runners are written against, re-exported so no file
 *    outside this folder imports `@anthropic-ai/claude-agent-sdk` (eslint, tests/llm/provider/sdk-imports.test.ts).
 */
import { agentSdkProvider, type AgentQuery, type AgentSdkProvider } from './agent-sdk';
import { createOpenAiProvider } from './openai';
import type { ModelProvider } from './types';

export * from './types';
export { agentSdkProvider, COMPLETE_TOOL_SERVER, createAgentSdkProvider, renderMessages, systemPromptOf, type AgentQuery, type AgentSdkProvider, type AgentSdkProviderOptions, type AgentSdkRunSpec } from './agent-sdk';
export { createOpenAiProvider } from './openai';

export { BUILTIN_TOOL_NAMES, createSdkMcpServer, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, tool } from '@anthropic-ai/claude-agent-sdk';
export type { CanUseTool, EffortLevel, HookCallback, McpSdkServerConfigWithInstance, McpServerConfig, Options, SDKMessage, SettingSource } from '@anthropic-ai/claude-agent-sdk';

export type ProviderId = 'anthropic-agent-sdk' | 'openai';

let override: ModelProvider | null = null;
let openai: ModelProvider | null = null;

/** The provider id the environment selects (unknown values: the default). */
export function providerIdOf(env: Record<string, string | undefined> = process.env): ProviderId {
  return env.CC_MODEL_PROVIDER === 'openai' ? 'openai' : 'anthropic-agent-sdk';
}

/** The active provider. */
export function modelProvider(env: Record<string, string | undefined> = process.env): ModelProvider {
  if (override) return override;
  if (providerIdOf(env) === 'openai') return (openai ??= createOpenAiProvider());
  return agentSdkProvider as ModelProvider;
}

/** Tests: swap the active provider (null restores the environment's choice). */
export function setModelProvider(p: ModelProvider | null): void {
  override = p;
}

/** The SDK's `query()`, on the active provider. */
export const agentQuery: AgentQuery = ((params: Parameters<AgentQuery>[0]) => (modelProvider() as unknown as AgentSdkProvider).run(params)) as unknown as AgentQuery;
