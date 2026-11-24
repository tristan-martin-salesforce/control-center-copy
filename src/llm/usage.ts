/**
 * Token usage of one Agent SDK run, split the way the ledger books it (D0, audit 2026-11-13): uncached input, output,
 * cache reads and cache writes, per model. Before, every caller summed cache reads and writes into `inputTokens`, so
 * the ledger could not show a cache hit rate or what caching saved.
 *
 * The authority is the result message's `modelUsage` (one entry per model the run used, with its own cost). Without
 * it (an older CLI, a run that died before its result), the per-message usage blocks are summed.
 */
import { estimateCallCostUsd } from './models';

export interface ModelUsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface UsageTotals {
  /** Uncached input only. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Per model, largest cost first. */
  byModel: ModelUsageRow[];
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);

export const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: [] };

function totals(byModel: ModelUsageRow[]): UsageTotals {
  return {
    inputTokens: byModel.reduce((a, u) => a + u.inputTokens, 0),
    outputTokens: byModel.reduce((a, u) => a + u.outputTokens, 0),
    cacheReadTokens: byModel.reduce((a, u) => a + u.cacheReadTokens, 0),
    cacheWriteTokens: byModel.reduce((a, u) => a + u.cacheWriteTokens, 0),
    byModel: [...byModel].sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model)),
  };
}

/** From the SDK result's `modelUsage` (keyed by model id). */
export function usageFromModelUsage(mu: Record<string, unknown> | null | undefined): UsageTotals | null {
  const entries = Object.entries(mu ?? {});
  if (!entries.length) return null;
  return totals(
    entries.map(([model, raw]) => {
      const u = (raw ?? {}) as Record<string, unknown>;
      return { model, inputTokens: n(u.inputTokens), outputTokens: n(u.outputTokens), cacheReadTokens: n(u.cacheReadInputTokens), cacheWriteTokens: n(u.cacheCreationInputTokens), costUsd: n(u.costUSD) };
    }),
  );
}

/** From one Messages API usage block (`input_tokens`, `cache_read_input_tokens`, …) on `model`. */
export function usageFromBlock(model: string, u: Record<string, number | null | undefined> | null | undefined): UsageTotals {
  const b = u ?? {};
  return totals([
    {
      model,
      inputTokens: n(b.input_tokens),
      outputTokens: n(b.output_tokens),
      cacheReadTokens: n(b.cache_read_input_tokens),
      cacheWriteTokens: n(b.cache_creation_input_tokens),
      costUsd: estimateCallCostUsd(model, b),
    },
  ]);
}

/** Sum usages (several messages, several passes). */
export function addUsage(...us: Array<UsageTotals | null | undefined>): UsageTotals {
  const m = new Map<string, ModelUsageRow>();
  for (const u of us) {
    for (const r of u?.byModel ?? []) {
      const c = m.get(r.model) ?? { model: r.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
      c.inputTokens += r.inputTokens;
      c.outputTokens += r.outputTokens;
      c.cacheReadTokens += r.cacheReadTokens;
      c.cacheWriteTokens += r.cacheWriteTokens;
      c.costUsd += r.costUsd;
      m.set(r.model, c);
    }
  }
  return totals([...m.values()]);
}

/** Prompt tokens of a usage (uncached + cache read + cache write): what the long-prompt price threshold counts. */
export const promptTokens = (u: Pick<UsageTotals, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** Characters per token for text we have not sent yet (tool results): low, so the prompt guard trips early, not late. */
export const GUARD_CHARS_PER_TOKEN = 2.5;
export const estimateTokens = (chars: number) => Math.ceil(Math.max(0, chars) / GUARD_CHARS_PER_TOKEN);

/**
 * Per-request measurement of one Agent SDK run (0027, review 04 §4.5): each request's prompt size (uncached + cache
 * read + cache write), from the assistant messages' usage blocks (one request can arrive as several messages with the
 * same id), plus the tool output that will go into the next request. It answers the measurement columns
 * (first / max prompt, long-tier requests, turns) and the prompt guard's question: how big will the next request be?
 */
export class RequestMeter {
  private readonly reqs = new Map<string, { model: string; prompt: number; output: number }>();
  private last: string | null = null;
  /** Estimated tokens of tool results returned since the last request (they go into the next one). */
  private pending = 0;

  constructor(private readonly thresholdOf: (model: string) => number | null) {}

  /** One assistant message's usage. A new message id is a new request; the pending tool output went into it. */
  observe(id: string, model: string, u: Record<string, number | null | undefined>): void {
    const prompt = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
    const prev = this.reqs.get(id);
    if (!prev) this.pending = 0;
    this.reqs.set(id, { model, prompt: Math.max(prev?.prompt ?? 0, prompt), output: Math.max(prev?.output ?? 0, n(u.output_tokens)) });
    this.last = id;
  }

  /** A tool result of `tokens` (estimated) will be in the next request. */
  addPending(tokens: number): void {
    this.pending += Math.max(0, tokens);
  }

  /** The next request's prompt, estimated: the last prompt, the last reply, and the tool results since. 0 before any request. */
  projectedNext(): number {
    const r = this.last ? this.reqs.get(this.last) : undefined;
    return r ? r.prompt + r.output + this.pending : 0;
  }

  /** The long-prompt threshold of the model the run is on (the last request's), or null. */
  threshold(fallbackModel: string): number | null {
    const r = this.last ? this.reqs.get(this.last) : undefined;
    return this.thresholdOf(r?.model ?? fallbackModel);
  }

  get turns(): number {
    return this.reqs.size;
  }

  /** The measurement columns this meter answers; empty before any request. */
  measure(): { firstPromptTokens?: number; maxPromptTokens?: number; longTierRequests?: number; turns?: number } {
    const xs = [...this.reqs.values()];
    if (!xs.length) return {};
    return {
      firstPromptTokens: xs[0]!.prompt,
      maxPromptTokens: Math.max(...xs.map((x) => x.prompt)),
      longTierRequests: xs.filter((x) => {
        const t = this.thresholdOf(x.model);
        return t != null && x.prompt > t;
      }).length,
      turns: xs.length,
    };
  }
}

/**
 * D1 gap (review 04 COST-12 / §4.6 #12): a one-shot call's result usage, split the way the ledger books it. For
 * callers that used to fold cache reads and writes into `inputTokens` (the NBA / voice `agentSdkComplete`).
 */
export function splitResultUsage(u: Record<string, number | null | undefined> | null | undefined): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  const b = u ?? {};
  return { inputTokens: n(b.input_tokens), outputTokens: n(b.output_tokens), cacheReadTokens: n(b.cache_read_input_tokens), cacheWriteTokens: n(b.cache_creation_input_tokens) };
}
