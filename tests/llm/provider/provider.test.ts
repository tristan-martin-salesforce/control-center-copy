/**
 * ModelProvider seam (08 R6, decision H-4): the Agent SDK adapter with a fake `query` (no model, no CLI), tier
 * resolution, the OpenAI stub, and `agentQuery` following the active provider.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ANTHROPIC_TIER_MODELS, ESCALATION_MODEL, estimateCallCostUsd, MODEL_PRICES, resolveModel, SCANNER_MODEL } from '@/llm/models';
import { agentQuery, agentSdkProvider, COMPLETE_TOOL_SERVER, createAgentSdkProvider, createOpenAiProvider, modelProvider, NotImplemented, providerIdOf, renderMessages, setModelProvider, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, systemPromptOf, type AgentQuery, type HookCallback, type ModelProvider, type Options, type SDKMessage } from '@/llm/provider';

afterEach(() => setModelProvider(null));

/** A fake SDK `query` that records the options and answers with one result message. */
function fakeQuery(result: Record<string, unknown>, onRun?: (o: Options) => Promise<void>) {
  const seen: { prompt?: unknown; options?: Options } = {};
  const q = ((p: { prompt: unknown; options?: Options }) => {
    seen.prompt = p.prompt;
    seen.options = p.options;
    return (async function* () {
      if (onRun) await onRun(p.options!);
      yield { type: 'result', ...result } as unknown as SDKMessage;
    })();
  }) as unknown as AgentQuery;
  return { q, seen };
}

describe('models by tier', () => {
  it('a tier resolves to the provider model id; an id passes through; the scanner and escalation models are tiers', () => {
    expect(resolveModel('fast')).toBe('claude-haiku-5-5');
    expect(resolveModel('balanced')).toBe('claude-sonnet-5-5');
    expect(resolveModel('strong')).toBe('claude-opus-5-5');
    expect(resolveModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(resolveModel('fast', { fast: 'gpt-x-mini', balanced: 'gpt-x', strong: 'gpt-x-pro' })).toBe('gpt-x-mini');
    expect(SCANNER_MODEL).toBe(ANTHROPIC_TIER_MODELS.fast);
    expect(ESCALATION_MODEL).toBe(ANTHROPIC_TIER_MODELS.balanced);
    for (const m of Object.values(ANTHROPIC_TIER_MODELS)) expect(MODEL_PRICES[m]).toBeDefined();
  });

  it('prices come through the provider (a provider table overrides the rate card)', () => {
    expect(agentSdkProvider.prices).toBe(MODEL_PRICES);
    const u = { input_tokens: 10_000 };
    expect(estimateCallCostUsd('claude-haiku-5-5', u)).toBeCloseTo(0.001, 6);
    expect(estimateCallCostUsd('other-model', u, { 'other-model': { input: 7, output: 0, cacheWrite5m: 0, cacheRead: 0 } })).toBeCloseTo(0.07, 6);
  });
});

describe('Agent SDK provider: complete()', () => {
  it('one tool-less turn in the clean env: no settings files, no built-ins, no MCP; the cache boundary splits the system prompt', async () => {
    const { q, seen } = fakeQuery({ subtype: 'success', result: 'label: done', total_cost_usd: 0.0003, usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 900 } });
    const p = createAgentSdkProvider({ queryFn: q });
    const r = await p.complete({ model: 'fast', system: 'STATIC PREFIX\nDYNAMIC PART', cacheBoundary: 'STATIC PREFIX\n'.length, messages: [{ role: 'user', content: 'classify this' }], maxTokens: 256 });
    expect(r).toMatchObject({ ok: true, text: 'label: done', usage: { provider: 'anthropic-agent-sdk', model: 'claude-haiku-5-5', inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, costUsd: 0.0003, costEstimated: false } });
    const o = seen.options!;
    expect(seen.prompt).toBe('classify this');
    expect(o).toMatchObject({ model: 'claude-haiku-5-5', tools: [], settingSources: [], skills: [], maxTurns: 1, persistSession: false, strictMcpConfig: true, mcpServers: {} });
    expect(o.systemPrompt).toEqual(['STATIC PREFIX\n', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'DYNAMIC PART']);
    expect(o.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('256');
    expect(await o.canUseTool!('Read', {}, { signal: new AbortController().signal } as never)).toMatchObject({ behavior: 'deny' });
  });

  it('tools: the model proposes a call, the hook records it and denies it (nothing runs)', async () => {
    const { q, seen } = fakeQuery({ subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.0001, usage: {} }, async (o) => {
      const hook = o.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
      const out = (await hook({ hook_event_name: 'PreToolUse', tool_name: `mcp__${COMPLETE_TOOL_SERVER}__verdict`, tool_input: { id: 'w1', done: true }, session_id: 's', transcript_path: '', cwd: '' } as never, 'tu', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
    const p = createAgentSdkProvider({ queryFn: q });
    const r = await p.complete({ model: 'claude-sonnet-5-5', system: 's', messages: [{ role: 'user', content: 'decide' }], maxTokens: 100, tools: [{ name: 'verdict', description: 'one verdict', shape: { id: z.string(), done: z.boolean() } }] });
    expect(r.ok).toBe(true);
    expect(r.toolCalls).toEqual([{ name: 'verdict', input: { id: 'w1', done: true } }]);
    expect(seen.options!.allowedTools).toEqual([`mcp__${COMPLETE_TOOL_SERVER}__verdict`]);
    expect(Object.keys(seen.options!.mcpServers ?? {})).toEqual([COMPLETE_TOOL_SERVER]);
  });

  it('a failed run is not ok, with a short reason and the usage it reported', async () => {
    const { q } = fakeQuery({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.05, errors: ['budget'] });
    const r = await createAgentSdkProvider({ queryFn: q }).complete({ model: 'fast', system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, budgetUsd: 0.05 });
    expect(r).toMatchObject({ ok: false, text: '', error: 'budget', usage: { costUsd: 0.05 } });
  });

  it('several messages render as one transcript prompt; a boundary outside the prompt leaves it whole', () => {
    expect(renderMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }])).toBe('User: a\n\nAssistant: b\n\nUser: c');
    expect(systemPromptOf('abc', undefined)).toBe('abc');
    expect(systemPromptOf('abc', 3)).toBe('abc');
  });
});

describe('active provider and agentQuery', () => {
  it('default is the Agent SDK; CC_MODEL_PROVIDER=openai selects the stub, which refuses loudly', async () => {
    expect(providerIdOf({})).toBe('anthropic-agent-sdk');
    expect(providerIdOf({ CC_MODEL_PROVIDER: 'openai' })).toBe('openai');
    expect(modelProvider({}).id).toBe('anthropic-agent-sdk');
    const oa = modelProvider({ CC_MODEL_PROVIDER: 'openai' });
    expect(oa.id).toBe('openai');
    await expect(oa.complete({ model: 'fast', system: '', messages: [], maxTokens: 1 })).rejects.toBeInstanceOf(NotImplemented);
    expect(() => createOpenAiProvider().run({ prompt: 'x' })).toThrow(NotImplemented);
  });

  it('agentQuery runs on the active provider (every runner that imports it follows a provider switch)', () => {
    const runs: unknown[] = [];
    const p: ModelProvider = {
      id: 'test',
      tiers: ANTHROPIC_TIER_MODELS,
      prices: {},
      complete: async () => ({ ok: true, text: '', usage: { provider: 'test', model: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costEstimated: false } }),
      run: (spec) => {
        runs.push(spec);
        return (async function* () {})();
      },
    };
    setModelProvider(p);
    agentQuery({ prompt: 'hello', options: { model: 'claude-haiku-5-5' } });
    expect(runs).toEqual([{ prompt: 'hello', options: { model: 'claude-haiku-5-5' } }]);
  });
});
