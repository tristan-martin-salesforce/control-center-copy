/**
 * Fetch-then-interpret (FTI, review 04 §4.1, decision H-3): the shapes the interpret step passes around.
 *
 *   fetched + recorded items ─▶ prefilter (rules, no model) ─▶ candidates (deterministic joins) ─▶ batches by tokens
 *     ─▶ classify (tool-less Haiku, one cached prefix, strict JSON) ─▶ second pass below the confidence floor
 *     ─▶ apply (the cc tool handlers: the same gates, redaction and writes as the agentic path)
 */
import type { CompletionModelRequest, CompletionModelResult } from '../completion/types';
import type { ConnectorId, NormalizedSourceItem, ResolutionFields } from '../types';

/** A candidate home for an item, aliased `w1`…`w5` per item so the prompt (and the cassette hash) never carries ids. */
export interface ItemCandidate extends ResolutionFields {
  alias: string;
  workItemId: string;
  title: string;
  why: string;
  score: number;
  state?: string;
}

/** A conversation line shown around an item (read only; never given a verdict). */
export interface ContextLine {
  at: string;
  author: string;
  text: string;
  /** Who the line is addressed to (the triage addressing, rendered). */
  to?: string;
  earlier?: boolean;
}

/** One unit the classifier gives a verdict to: a source item, or one of a meeting-notes doc's steps. */
export interface InterpretItem {
  /** What the prompt and the verdict cite: the item's externalId (`#n` for a notes step). */
  ref: string;
  sourceItemId: string;
  item: NormalizedSourceItem;
  connector: ConnectorId;
  /** A Gemini next step assigned to me (one item each). */
  step?: { index: number; title: string; description?: string };
  /** Rendered addressing (`→ me`, `→ PERSON_C (not me)`, `from me`…). */
  to?: string;
  context: ContextLine[];
  candidates: ItemCandidate[];
  /** Conversation key, so a batch keeps a conversation together. */
  group: string;
  /** Recorded as new or changed in this run (unchanged items with a stored verdict never reach the model). */
  fresh: boolean;
}

/** Why rules settled an item without the model (`items_decided_by_rules`, llm_decisions reasons). */
export type RuleReason =
  | 'trivial'
  | 'bot'
  | 'join'
  | 'not_addressed'
  | 'own_no_cue'
  | 'seen_decided'
  | 'bulk_mail'
  | 'calendar_notice'
  | 'no_my_steps'
  | 'step_done'
  | 'no_deliverable'
  | 'org62_rule'
  | 'thread_join';

export interface RuleDecision {
  sourceItemId: string;
  reason: RuleReason;
}

/** The classifier's model seam: a tool-less one-turn call (a `CompletionModel` fits it, so the cassette does too). */
export interface ClassifierRequest extends CompletionModelRequest {
  /** Character offset in `system` where the cacheable prefix ends (the skill text). */
  cacheBoundary?: number;
  maxTokens?: number;
}
export type ClassifierModel = (req: ClassifierRequest) => Promise<CompletionModelResult>;

/** One classifier call, as the run traces and books it (a `pass` row each: src/scanner/trace/queries.ts passSkill). */
export interface ClassifierCall {
  pass: 'classify' | 'reclassify';
  model: string;
  ok: boolean;
  error?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** ledgerHash(model, skill version, system, user): the cassette key and the D0 content hash. */
  contentHash: string;
  /** ledgerHash(model, the static prefix): identical across every classifier call (one cache entry). */
  prefixHash: string;
  /** Estimated prompt tokens of this request (system + user), for the measurement when a replay reports none. */
  promptTokensEst: number;
  itemsIn: number;
  /** Valid verdicts the call returned. */
  verdicts: number;
  /** Of those, verdicts that propose or link (`items_out`). */
  acts: number;
  invalid: number;
  malformed: boolean;
  ms: number;
}
