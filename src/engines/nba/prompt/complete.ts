/**
 * The single LLM seam the judgment layer needs: system + user in, text + cost out.
 * Engines take a `Complete` so tests stay offline. The real one, `agentSdkComplete`, lives in
 * `src/llm/complete-sdk.ts`; an entry point builds it and passes it in (engines never import src/llm).
 */

export interface CompleteRequest {
  system: string;
  user: string;
  model: string;
  maxOutputTokens?: number;
  /** Hard stop for this call (Agent SDK maxBudgetUsd). */
  maxBudgetUsd?: number;
  effort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  costUsd: number;
  /** Uncached input only (D1): cache reads and writes are their own fields. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model: string;
  ok: boolean;
  error?: string;
}

export type Complete = (req: CompleteRequest) => Promise<CompleteResult>;
