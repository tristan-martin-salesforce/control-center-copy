/**
 * Model ids (by tier) and list prices used for the running cost estimate (SCANNER.md §7, brief 09 §4.1). The prices
 * here are the Anthropic provider's (`agentSdkProvider.prices`); another provider brings its own table.
 * The authoritative cost is the SDK result's `total_cost_usd` / `modelUsage`; this table only lets the
 * runner abort mid-run when the per-run cap is crossed, before the result message arrives.
 */

/**
 * Model choice by capability (08 R6, H-4): code asks for a tier and the active provider maps it to its own model id.
 * `fast` is the background scanners' model, `balanced` the escalation / drafting model, `strong` the user-asked one.
 */
export type ModelTier = 'fast' | 'balanced' | 'strong';
export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'balanced', 'strong'];

/** The Anthropic tier map (the Agent SDK provider's `tiers`; src/llm/provider/agent-sdk.ts). */
export const ANTHROPIC_TIER_MODELS: Readonly<Record<ModelTier, string>> = Object.freeze({
  fast: 'claude-haiku-5-5',
  balanced: 'claude-sonnet-5-5',
  strong: 'claude-opus-5-5',
});

/**
 * Assistant v2 (H-6): the Assistant's model names by tier, and back (src/llm/chat/router.ts routes a turn to a tier;
 * the message header shows the label). `haiku | sonnet | opus` are `ChatModel` values.
 */
export const CHAT_TIER_MODEL: Readonly<Record<ModelTier, 'haiku' | 'sonnet' | 'opus'>> = Object.freeze({ fast: 'haiku', balanced: 'sonnet', strong: 'opus' });
export const CHAT_MODEL_TIER: Readonly<Record<'haiku' | 'sonnet' | 'opus', ModelTier>> = Object.freeze({ haiku: 'fast', sonnet: 'balanced', opus: 'strong' });
export const TIER_LABEL: Readonly<Record<ModelTier, string>> = Object.freeze({ fast: 'Haiku', balanced: 'Sonnet', strong: 'Opus' });

export const isModelTier = (m: string): m is ModelTier => (MODEL_TIERS as readonly string[]).includes(m);

/** A tier → the provider's model id (default: the Anthropic map); a model id passes through unchanged. */
export function resolveModel(model: string | ModelTier, tiers: Readonly<Record<ModelTier, string>> = ANTHROPIC_TIER_MODELS): string {
  return isModelTier(model) ? tiers[model] : model;
}

export const SCANNER_MODEL = ANTHROPIC_TIER_MODELS.fast;
export const ESCALATION_MODEL = ANTHROPIC_TIER_MODELS.balanced;

export interface ModelPrice {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheRead: number;
  /** Haiku 5.5 switches to a higher tier above 100K prompt tokens. */
  longPromptThreshold?: number;
  longInput?: number;
  longOutput?: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheRead: 0.01, longPromptThreshold: 100_000, longInput: 0.5, longOutput: 2.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 },
};

export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Estimate the cost of one API call from its usage block (a provider passes its own `prices`). Unknown models are priced as Sonnet (conservative). */
export function estimateCallCostUsd(model: string, u: TokenUsage, prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES): number {
  const p = prices[model] ?? MODEL_PRICES[model] ?? MODEL_PRICES['claude-sonnet-5-5']!;
  const inp = u.input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  const cr = u.cache_read_input_tokens ?? 0;
  const prompt = inp + cw + cr;
  const long = p.longPromptThreshold != null && prompt > p.longPromptThreshold;
  const inRate = long ? (p.longInput ?? p.input) : p.input;
  const outRate = long ? (p.longOutput ?? p.output) : p.output;
  const scale = long ? inRate / p.input : 1;
  return (inp * inRate + out * outRate + cw * p.cacheWrite5m * scale + cr * p.cacheRead * scale) / 1_000_000;
}

/**
 * COST-2: the per-request prompt size above which `model` is priced higher (Haiku 5.5: 100K, 5×), or null when its
 * price has no such tier. The runner's prompt guard and the ledger's `long_tier_requests` read it, so a provider with
 * other thresholds only changes this table.
 */
export function longPromptThresholdOf(model: string): number | null {
  return MODEL_PRICES[model]?.longPromptThreshold ?? null;
}
