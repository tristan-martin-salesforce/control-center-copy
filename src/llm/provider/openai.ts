/**
 * OpenAI provider: a stub (decision H-4: the seam now, the adapter when a named teammate needs it).
 *
 * The shape an adapter fills in (08-connectors-providers §4, "Libraries for the reasoning side"; the Vercel AI SDK
 * `ai` + `@ai-sdk/openai` is the recommended base):
 *
 *   tiers     { fast: 'gpt-…-mini', balanced: 'gpt-…', strong: 'gpt-…' }: whatever ids the team licenses
 *   prices    USD per million tokens per model id (input, output, cacheRead; OpenAI caches prefixes automatically, so
 *             `cacheWrite5m` is the input price and `CompleteInput.cacheBoundary` is ignored)
 *   complete  `generateText({ model, system, messages, tools, maxOutputTokens })` → `{ ok, text, toolCalls, usage }`,
 *             with `usage.cachedInputTokens` mapped to `cacheReadTokens` and the cost computed from `prices`
 *             (`costEstimated: true`, the API returns no price)
 *   run       NotImplemented. Agentic runs are Claude Agent SDK options (MCP servers under Claude Code's OAuth, hooks,
 *             `canUseTool`); an OpenAI run can only host the app's own tools (the cc handlers and their zod shapes,
 *             src/llm/cc-tools) and must never read Slack or Org62 itself: those reads stay `claude_relay`
 *             (src/connectors/runtime, decision H-3), and no token from Claude Code's store is ever handed to it.
 *
 * Selecting it (`CC_MODEL_PROVIDER=openai`) today fails loudly instead of silently falling back to Claude.
 */
import type { AgentRun, AgentRunSpec, CompleteInput, CompleteResult, ModelProvider } from './types';
import { NotImplemented } from './types';

export function createOpenAiProvider(): ModelProvider {
  return {
    id: 'openai',
    tiers: { fast: 'unset', balanced: 'unset', strong: 'unset' },
    prices: {},
    complete(_input: CompleteInput): Promise<CompleteResult> {
      return Promise.reject(new NotImplemented('the OpenAI provider (complete)'));
    },
    run(_spec: AgentRunSpec): AgentRun {
      throw new NotImplemented('the OpenAI provider (run)');
    },
  };
}
