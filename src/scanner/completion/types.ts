/**
 * Completion pass (CMP-1, docs/reference/SCANNER.md §4.9): types shared by the candidate collector, the model check and
 * the `completion.check` job.
 *
 * The pass reads open work items that are mine and the source items that arrived since each item's last check,
 * asks a cheap model "is it done?" for the items that have plausible candidates, and emits `completion` (done) or
 * `progress` (partial) evidence through the scanner's writer (`ScannerStore.linkEvidence`, `cc_link_evidence`
 * semantics) with the reason prefix `done_check:`. It never sets item state: the closure machine and the
 * `reevaluate` job decide what closes (ENGINES.md §3).
 */
import type { ConnectorId, EvidenceRole, Confidence, Involvement, PersonRef, ScannerStore } from '../types';

/** Reason prefix on every evidence row this pass writes. */
export const DONE_CHECK_PREFIX = 'done_check:';

/** Live statuses the pass checks. Suggested (Triage), snoozed, done, dismissed and merged items are skipped. */
export const LIVE_STATUSES = ['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done'] as const;

/** One evidence row of a work item, with the source item fields the candidate rules need. */
export interface CompletionEvidence {
  sourceItemId: string;
  role: EvidenceRole;
  connector: ConnectorId;
  /** Source item kind (message, email, calendar_event, file_revision, meeting_notes…). */
  kind: string;
  externalId: string;
  threadRef?: string;
  occurredAt: string;
  fromMe: boolean;
  author?: PersonRef;
  participants?: PersonRef[];
  fileRefs: string[];
  accountHints: string[];
  /** Redacted text (title + body), clipped by the store. */
  text?: string;
  /** The evidence row's reason (`done_check: …` marks this pass's own rows). */
  reason?: string;
}

/** An open work item that is mine, as the completion pass needs it. */
export interface CompletionItem {
  workItemId: string;
  kind: string;
  title: string;
  purpose?: string;
  status: string;
  due?: string;
  createdAt: string;
  involvement?: Involvement;
  accountId?: string;
  accountNames: string[];
  /** Who asked me / whom I promised, when the item records it (counterparty person). */
  counterparty?: PersonRef;
  /** Drive files and links the item references (deliverables, links, evidence refs). */
  fileRefs: string[];
  evidence: CompletionEvidence[];
  /**
   * R1, the correction rule both closers share (src/engines/closure/correction.ts): false when the user reopened it, kept
   * it, marked it Not done, or it is on an ask-first list. The pass then writes at most Likely ("Confirm"). Undefined = may.
   */
  mayAutoClose?: boolean;
}

/** A source item that may say an item is done. */
export interface CompletionSource {
  sourceItemId: string;
  connector: ConnectorId;
  kind: string;
  externalId: string;
  threadRef?: string;
  occurredAt: string;
  /** When it arrived: first seen, or its last content change (an edit that added the link). */
  seenAt: string;
  fromMe: boolean;
  author?: PersonRef;
  participants?: PersonRef[];
  title?: string;
  /** Redacted body, clipped by the store. */
  text?: string;
  fileRefs: string[];
  accountHints: string[];
  url?: string;
}

/** Read helpers both scanner stores implement (src/scanner/store-db.ts, store-memory.ts). */
export interface CompletionReadStore {
  /**
   * Open items that are mine (LIVE_STATUSES, involvement owner/contributor, created at or before `asOf`).
   * `statuses` overrides the status filter (evaluation replays read items whatever their current status).
   */
  /** Every live item of mine, newest first; `limit` omitted = all (caps audit 2026-11-21: the pass took the newest 400). */
  completionItems(opts?: { asOf?: string; limit?: number; statuses?: readonly string[] }): Promise<CompletionItem[]>;
  /** Source items that arrived in (seenAfter, seenUntil], newest first. */
  completionSources(opts: { seenAfter: string; seenUntil: string; limit?: number }): Promise<CompletionSource[]>;
  /** Today's LLM spend vs the caps (llm_calls / llm_budgets, the global hard cap). */
  budgetStatus(): Promise<{ todayUsd: number; softCapUsd: number; hardCapUsd: number; state: 'ok' | 'soft_alert' | 'capped' }>;
}

export type CompletionStore = ScannerStore & CompletionReadStore;

/** How a candidate relates to the item. Strong relations can back an auto-close; the rest at most a "Confirm". */
export type Relation =
  | 'same_thread'
  /** A thread the item has only `context` evidence in (the scanner links context liberally): never strong. */
  | 'context_thread'
  | 'same_dm'
  | 'same_email_thread'
  | 'to_asker'
  | 'from_asker'
  | 'same_channel'
  | 'same_file'
  | 'same_event'
  | 'same_account'
  /** R7: the asker's short acknowledgement ("got it, thanks") after my line in the item's conversation. */
  | 'ack'
  /** R7: a Drive revision of the item's file (its own relation; an edit alone never closes). */
  | 'file_revision'
  /** R7: meeting notes of the item's meeting, or notes with the asker that name the item. */
  | 'meeting_notes'
  /** R7: a Claude session about the item (its status line and last message). */
  | 'session';

/**
 * Ties strong enough to back an auto-close: the conversation the item lives in. A message to the asker elsewhere is
 * not (the same person often has several open asks), so it can at most produce "Likely done · Confirm".
 */
export const STRONG_RELATIONS: ReadonlySet<Relation> = new Set(['same_thread', 'same_dm', 'same_email_thread']);

export interface Candidate {
  source: CompletionSource;
  relations: Relation[];
  strong: boolean;
}

/** Per-user progress of the pass, kept in the latest succeeded `completion.check` job's result. */
export interface CompletionWatermark {
  /** Every source item that arrived at or before this time was checked (except the `pending` items). */
  through: string;
  /** Items not checked yet (budget, a failed call, the per-pass cap): their own "since". */
  pending: Record<string, string>;
  /** Skill version tag that produced it (`check-completion@1.0.0`). */
  skill?: string;
}

export type Verdict = 'done' | 'partial' | 'not_done';

/**
 * What the cited message is (skill ≥ 1.1.0). Small models compress their confidence, so the gate keys on this
 * category plus the relation, not on a high number alone:
 *   delivered      my message itself carries the thing asked for (the file, link, answer, decision, the access)
 *   confirmed      the asker (or another) confirms it is done or received
 *   done_by_other  someone else did it and says so
 *   resolved       the asker (or the group) settled it without me: cancelled, decided, no longer needed (RES-1)
 *   pointer        points to where the answer is, or a bare link with no word on what it is
 *   partial        some of it
 *   none           nothing that finishes it
 */
export const BASES = ['delivered', 'confirmed', 'done_by_other', 'resolved', 'pointer', 'partial', 'none'] as const;
export type Basis = (typeof BASES)[number];

/** One parsed model verdict, mapped back to real ids. */
export interface ItemVerdict {
  workItemId: string;
  verdict: Verdict;
  sourceItemId?: string;
  confidence: number;
  reason: string;
  basis?: Basis;
}

/** An evidence row the pass emits (or would emit, in a dry run). */
export interface CompletionSignal {
  workItemId: string;
  sourceItemId: string;
  role: Extract<EvidenceRole, 'completion' | 'progress'>;
  confidence: Confidence;
  reason: string;
  connector: ConnectorId;
  /** Why this confidence (gate): `strong_mine`, `likely`, `partial`, `shared_citation`. */
  gate: string;
  /** The model's own confidence (0–1) and basis, for calibration. */
  modelConfidence: number;
  basis?: Basis;
  /** The candidate's relations to the item. */
  relations: string[];
  /** The evidence row written for it (absent in a dry run or when the link failed). */
  evidenceId?: string;
}

export interface CompletionModelRequest {
  system: string;
  user: string;
  model: string;
  effort?: 'low' | 'medium' | 'high';
  /** Hard stop for this call (Agent SDK maxBudgetUsd). */
  maxBudgetUsd: number;
  signal?: AbortSignal;
  /** An id the caller's guard books the call against (settle: the work item). Never sent to the model. */
  tag?: string;
}

export interface CompletionModelResult {
  ok: boolean;
  text: string;
  costUsd: number;
  /** Uncached input (D0); cache reads and writes are their own fields. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  error?: { message: string; errorClass?: 'auth' | 'transient' | 'rate_limited' | 'config' | 'unknown' };
}

/** The single LLM seam: one tool-less, one-turn call. Tests pass a fake. */
export type CompletionModel = (req: CompletionModelRequest) => Promise<CompletionModelResult>;
