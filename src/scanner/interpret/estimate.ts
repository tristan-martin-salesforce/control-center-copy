/**
 * Cost from token counts (no gateway here: the A/B table, the first-scan estimate and the docs price tokens with the
 * provider's list prices, src/llm/models.ts, Haiku 5.5: $0.10 in / $0.50 out / $0.01 cache read / $0.125 cache write
 * per MTok, 5× above 100K prompt tokens). Every assumption is a named constant, so a measured value replaces it.
 *
 *   relay read      one model request: the CLI's own prompt + the one tool's schema + the read-lookup skill (the
 *                   prefix, cached while the same tool is called within 5 minutes) + the run line; the tool output is
 *                   never read by the model (PostToolUse stops the run, src/llm/one-call.ts)
 *   classifier call one tool-less request: the skill + persona + glossary (cached prefix) + the batch (uncached) + the
 *                   verdict JSON
 *   agentic run     the traversal: a ~24K-token hidden prefix (CLI + cc tool + MCP schemas, skill-runner.ts
 *                   TOOL_OVERHEAD_TOKENS) + _scanner-common + the scan skill + the context pack, re-read on every turn,
 *                   plus each turn's tool output, written to the cache once per cold start
 */
import { estimateCallCostUsd, SCANNER_MODEL } from '@/llm/models';

/**
 * Prompt tokens of one relay request, until the owner's ledger measures it (`llm_calls.first_prompt_tokens` of the
 * `relay:*` rows). Derivation: the relay replaces Claude Code's system prompt with the read-lookup skill (~0.3K tokens),
 * loads no built-in tools and exactly one MCP tool schema (disallowed tools leave the context); the traversal's measured
 * 13-19K hidden tokens carried 14 schemas (10 cc + 4 Slack), so one schema is ~1-4K. That is 2-5K; 8K is a
 * conservative middle. Review 04 gave 5-15K unmeasured; RELAY_PREFIX_TOKENS_HIGH is that bound (the docs show both).
 */
export const RELAY_PREFIX_TOKENS = 8_000;
export const RELAY_PREFIX_TOKENS_HIGH = 15_000;
/** The relay's run line (the tool and our arguments) and its reply ("DONE" and the tool call). */
export const RELAY_RUN_TOKENS = 300;
export const RELAY_OUT_TOKENS = 80;
/** The agentic traversal's hidden prefix (skill-runner.ts TOOL_OVERHEAD_TOKENS). */
export const AGENTIC_HIDDEN_TOKENS = 24_000;
/** Characters per token: prose (skills) and data (JSON, tool output). */
export const PROSE_CHARS_PER_TOKEN = 3.5;
export const DATA_CHARS_PER_TOKEN = 2.5;
/** What a model writes per turn in a traversal (tool calls and their JSON). */
export const AGENTIC_OUT_PER_TURN = 200;
/** What one verdict costs to write (src/scanner/interpret/batch.ts OUTPUT_TOKENS_PER_VERDICT keeps the reply budget). */
export const VERDICT_OUT_TOKENS = 70;

const usd = (o: { uncached: number; read: number; write: number; out: number }, model = SCANNER_MODEL) =>
  estimateCallCostUsd(model, { input_tokens: o.uncached, output_tokens: o.out, cache_read_input_tokens: o.read, cache_creation_input_tokens: o.write });

/** One relay read: warm (the same tool's prefix read from the cache) or cold (written to it). */
export function relayUsd(cold: boolean, prefixTokens = RELAY_PREFIX_TOKENS): number {
  return usd({ uncached: RELAY_RUN_TOKENS, read: cold ? 0 : prefixTokens, write: cold ? prefixTokens : 0, out: RELAY_OUT_TOKENS });
}

/** One classifier call. */
export function classifierUsd(o: { systemTokens: number; userTokens: number; verdicts: number; cold: boolean }): number {
  return usd({ uncached: o.userTokens, read: o.cold ? 0 : o.systemTokens, write: o.cold ? o.systemTokens : 0, out: 60 + o.verdicts * VERDICT_OUT_TOKENS });
}

/**
 * One agentic traversal run of `turns` model requests: the prefix is written once when cold, read on every later turn;
 * tool output enters on the turn after it came back and is re-read on every turn after that (written once, then read).
 */
export function agenticRunUsd(o: { prefixTokens: number; turns: number; toolOutputTokens: number[]; cold: boolean; outPerTurn?: number }): number {
  let total = 0;
  let carried = 0;
  for (let t = 0; t < o.turns; t++) {
    const fresh = t > 0 ? (o.toolOutputTokens[t - 1] ?? 0) : 0;
    const prefixCold = t === 0 && o.cold;
    total += usd({ uncached: 200, read: (prefixCold ? 0 : o.prefixTokens) + carried, write: (prefixCold ? o.prefixTokens : 0) + fresh, out: o.outPerTurn ?? AGENTIC_OUT_PER_TURN });
    carried += fresh;
  }
  return total;
}

export const proseTokens = (chars: number) => Math.ceil(chars / PROSE_CHARS_PER_TOKEN);
export const dataTokens = (chars: number) => Math.ceil(chars / DATA_CHARS_PER_TOKEN);
