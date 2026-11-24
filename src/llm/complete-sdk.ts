/**
 * The real `Complete` (the engine port in src/engines/nba/prompt/complete.ts): Agent SDK, no tools, no filesystem
 * settings, one turn. Engines never import this; an entry point (scripts/voice/cli.ts, tests/skills/run-evals.ts)
 * builds it and passes it in (CONTRIBUTING "a pure layer takes a port its caller builds").
 */
import type { Complete } from '@/engines/nba/prompt/complete';

import { childEnv, claudeGatewayConfig, type GatewayConfig } from './claude-env';
import type { QueryFn } from './skill-runner.shared';
import { splitResultUsage } from './usage';

interface ResultLike {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  errors?: string[];
}

export interface AgentSdkCompleteOptions {
  /** Test seam: a fake query. Without it the provider's `agentQuery` runs. */
  queryFn?: QueryFn;
  /** Defaults to the user's Claude settings (empty when a fake `queryFn` is given). */
  gateway?: GatewayConfig;
}

export function createAgentSdkComplete(o: AgentSdkCompleteOptions = {}): Complete {
  return async (req) => {
    const query = o.queryFn ?? ((await import('./provider')).agentQuery as unknown as QueryFn);
    const gw = o.gateway ?? (o.queryFn ? { env: {} } : claudeGatewayConfig());
    const abort = new AbortController();
    if (req.signal) req.signal.addEventListener('abort', () => abort.abort(), { once: true });
    let last: ResultLike | undefined;
    const q = query({
      prompt: req.user,
      options: {
        model: req.model,
        systemPrompt: req.system,
        tools: [],
        settingSources: [],
        maxTurns: 1,
        persistSession: false,
        permissionMode: 'dontAsk',
        abortController: abort,
        ...(req.maxBudgetUsd ? { maxBudgetUsd: req.maxBudgetUsd } : {}),
        ...(req.effort ? { effort: req.effort } : {}),
        ...(gw.apiKeyHelper ? { settings: { apiKeyHelper: gw.apiKeyHelper } } : {}),
        env: childEnv(gw.env),
      },
    });
    for await (const msg of q as AsyncIterable<ResultLike>) {
      if (msg.type === 'result') last = msg;
    }
    // D1: cache reads and writes are booked apart from uncached input (they used to be folded into inputTokens).
    const u = splitResultUsage(last?.usage);
    const ok = last?.subtype === 'success' && !last.is_error;
    return {
      text: ok ? (last?.result ?? '') : '',
      costUsd: last?.total_cost_usd ?? 0,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      model: req.model,
      ok,
      ...(ok ? {} : { error: last?.errors?.join('; ') ?? last?.result ?? last?.subtype ?? 'no result' }),
    };
  };
}

/** The production `Complete`: the provider's query with the user's Claude gateway settings. */
export const agentSdkComplete: Complete = createAgentSdkComplete();
