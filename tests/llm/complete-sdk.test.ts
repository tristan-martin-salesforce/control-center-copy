/**
 * The real `Complete` (src/llm/complete-sdk.ts) with a fake query: no model, no network. It is a tool-less one-turn
 * call, books cache tokens apart from uncached input (D1), and never inherits the parent's auth channel.
 */
import { describe, expect, it } from 'vitest';

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { agentSdkComplete, createAgentSdkComplete } from '../../src/llm/complete-sdk';
import type { QueryFn } from '../../src/llm/skill-runner.shared';

function fakeQuery(messages: unknown[]): { fn: QueryFn; seen: Array<{ prompt: string; options: Options }> } {
  const seen: Array<{ prompt: string; options: Options }> = [];
  const fn = ((params: { prompt: string; options: Options }) => {
    seen.push(params);
    return (async function* () {
      for (const m of messages) yield m as SDKMessage;
    })();
  }) as unknown as QueryFn;
  return { fn, seen };
}

const REQ = { system: 'You are a placeholder.', user: 'Say hi.', model: 'claude-haiku-5-5' };

describe('createAgentSdkComplete', () => {
  it('runs one tool-less turn and splits cache tokens from input', async () => {
    const { fn, seen } = fakeQuery([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', result: 'hi', total_cost_usd: 0.0012, usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 } },
    ]);
    const r = await createAgentSdkComplete({ queryFn: fn, gateway: { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' }, apiKeyHelper: 'example-helper' } })({ ...REQ, maxBudgetUsd: 0.3, effort: 'low' });
    expect(r).toEqual({ text: 'hi', costUsd: 0.0012, inputTokens: 10, outputTokens: 3, cacheReadTokens: 400, cacheWriteTokens: 50, model: REQ.model, ok: true });
    const o = seen[0]!.options;
    expect(seen[0]!.prompt).toBe('Say hi.');
    expect(o).toMatchObject({ model: REQ.model, systemPrompt: REQ.system, tools: [], settingSources: [], maxTurns: 1, persistSession: false, maxBudgetUsd: 0.3, effort: 'low', settings: { apiKeyHelper: 'example-helper' } });
    expect(o.env?.ANTHROPIC_BASE_URL).toBe('https://gateway.example.invalid');
  });

  it('returns ok:false with the error and no text when the run fails', async () => {
    const { fn, seen } = fakeQuery([{ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.3, errors: ['budget'] }]);
    const r = await createAgentSdkComplete({ queryFn: fn })(REQ);
    expect(r).toMatchObject({ ok: false, text: '', costUsd: 0.3, error: 'budget', inputTokens: 0 });
    expect(seen[0]!.options).not.toHaveProperty('maxBudgetUsd');
    expect(seen[0]!.options).not.toHaveProperty('settings');
  });

  it('says "no result" when the stream ends without one, and aborts the run when the caller does', async () => {
    const { fn, seen } = fakeQuery([]);
    const ctl = new AbortController();
    const r = await createAgentSdkComplete({ queryFn: fn })({ ...REQ, signal: ctl.signal });
    expect(r).toMatchObject({ ok: false, error: 'no result' });
    ctl.abort();
    expect(seen[0]!.options.abortController?.signal.aborted).toBe(true);
  });

  it('exports the production instance', () => {
    expect(typeof agentSdkComplete).toBe('function');
  });
});
