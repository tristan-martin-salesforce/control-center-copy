/**
 * The resolution check (holistic review 2026-11-20, lane 03 §4.1, decision H-7): ONE closer for "is this item done?",
 * replacing the completion pass (src/scanner/completion) and Settle's decision (src/engines/settle).
 *
 *   trigger   a new line in the item's conversation, a Drive revision or share of its file, a Gemini note naming it, a
 *             Claude session touching it, the asker gone quiet past the item's window, the nightly sweep (R3)
 *   pack      one builder (pack.ts) over the Settle pack: the ask, everything after it (mine and acks tagged), the file's
 *             revisions, notes and sessions, "elsewhere" lines naming the deliverable; capped by tokens (R4)
 *   ladder    rules D1–D6 first (src/scanner/resolution/rules.ts), then the cheap model on the pack (no tools), then a
 *             narrow escalation only when the cheap verdict is unsure and the item is worth it, data-gated (ladder.ts)
 *   outcome   mapped onto the closure machine (applySignal) or Settle's policy, honouring mayAutoClose; no new status
 *             vocabulary (outcome.ts): closed | likely | asked | left | reopened
 *   record    one closure_checks row per check, shadow or live (R9)
 *
 * Pure types; nothing here reads a store or calls a model.
 */
import type { CompletionModel } from '@/scanner/completion/types';
import type { RuleHints, RuleId, RulesResult } from '@/scanner/resolution/rules';
import type { RawSource, SettleRaw } from '@/engines/settle/context';
import type { SettleContext, SettleLine } from '@/engines/settle/types';
import type { PolicyItem } from '@/engines/settle/policy';
import type { ClosureItem } from '@/engines/types';

export const RESOLUTION_ENGINE_VERSION = 'resolution@1.0.0';
export const RESOLUTION_SKILL = 'resolve-item';
export const RESOLUTION_SKILL_PATH = 'skills/resolve-item.md';

export const RESOLUTION_TRIGGERS = ['conversation_line', 'drive_revision', 'drive_share', 'notes', 'session', 'quiet', 'sweep', 'evidence', 'manual'] as const;
export type ResolutionTrigger = (typeof RESOLUTION_TRIGGERS)[number];

export const RESOLUTION_OUTCOMES = ['closed', 'likely', 'asked', 'left', 'reopened'] as const;
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

/** The model's verdicts (the lane report's decision schema, plus Settle's gone-quiet and done-by-other). */
export const RESOLUTION_VERDICTS = ['done', 'partial', 'not_done', 'not_mine', 'not_needed', 'duplicate', 'waiting_on_them', 'gone_quiet', 'done_by_other'] as const;
export type ResolutionVerdict = (typeof RESOLUTION_VERDICTS)[number];

export const RESOLUTION_BASES = ['delivered', 'answered', 'confirmed', 'done_by_other', 'resolved', 'moment_passed', 'record_fixed', 'none'] as const;
export type ResolutionBasis = (typeof RESOLUTION_BASES)[number];

/** Verdicts that would change the item's state (close it or ask about it): the only ones worth an escalation. */
export const STATE_CHANGING: ReadonlySet<ResolutionVerdict> = new Set(['done', 'not_mine', 'not_needed', 'duplicate', 'done_by_other', 'gone_quiet']);

/** A line in the pack: Settle's line plus the tags the resolution check adds. */
export interface PackLine extends Omit<SettleLine, 'kind'> {
  kind: SettleLine['kind'] | 'file' | 'notes' | 'session';
  /** `ack`: the asker acknowledging my line; `chase`: the asker writing again with a problem or a nudge. */
  tag?: 'ack' | 'chase';
  /** Attachments REC-1 recorded (names only), for D1's delivery match. */
  files?: Array<{ name?: string; mimetype?: string }>;
  hasFile?: boolean;
  byAsker?: boolean;
  /** The line is the item's own evidence (the scanner linked it): never trimmed. */
  linked?: boolean;
}

/** A Drive revision of the item's file (from source_items, kind file_revision). */
export interface RawFileRevision {
  sourceItemId: string;
  fileId: string;
  title: string | null;
  at: string;
  byMe: boolean;
  editor?: string | null;
  /** The digest's "changes" line (redacted at ingest). */
  changes: string | null;
  /** A share (permission change) rather than an edit. */
  share?: boolean;
  url?: string | null;
}

/** A Claude session linked to the item (or naming it). */
export interface RawSession {
  sourceItemId?: string;
  sessionId: string;
  status: string;
  title: string | null;
  at: string;
  /** Last ≤ 300 characters of its last message. */
  lastMessage: string | null;
}

export interface ResolutionRaw extends SettleRaw {
  evidence: Array<RawSource & { files?: Array<{ name?: string; mimetype?: string }>; hasFile?: boolean }>;
  conversation: Array<RawSource & { files?: Array<{ name?: string; mimetype?: string }>; hasFile?: boolean }>;
  files?: RawFileRevision[];
  notes?: RawSource[];
  sessions?: RawSession[];
  /** D3: a read-back of the record the item is about. */
  record?: { fixed: boolean; cite?: string } | null;
  /** D6: the last check and the newest input for the item. */
  lastCheck?: LastCheck | null;
  latestInputAt?: string | null;
}

export interface LastCheck {
  at: string;
  verdict: string | null;
  outcome: ResolutionOutcome;
  citeAlias?: string | null;
}

/** The pack the ladder judges: the Settle context plus files, notes, sessions, the rules' hints and history. */
export interface ResolutionPack extends Omit<SettleContext, 'after' | 'elsewhere'> {
  after: PackLine[];
  elsewhere: PackLine[];
  files: PackLine[];
  notes: PackLine[];
  sessions: PackLine[];
  ruleHints: RuleHints;
  history: LastCheck | null;
  /** Lines and blocks dropped to fit the token cap (never the ask, mine after it, or the asker's after it). */
  trimmed: number;
  tokens: number;
  digest: string;
  /** The conversation the ask lives in (`slack:C…:ts`, `gmail:thread`): items sharing one batch into one call. */
  conversationKey: string;
}

/** What the item is worth an escalation for. */
export interface ItemWorth {
  /** The linked opportunity's amount (USD), when there is one. */
  dealUsd?: number | null;
  /** The asker's people.tier (leader, customer_exec, customer, …). */
  personTier?: string | null;
}

/** The item as the check needs it: the closure machine's view, Settle's policy facts (R1's correction rule in both). */
export interface ResolutionItem {
  id: string;
  kind: string;
  status: string;
  title: string;
  closure: ClosureItem;
  policy: PolicyItem;
  worth?: ItemWorth;
  /** W0-4: how often it was reopened after a close for me, and when last. */
  reopenedCount: number;
  lastReopenAt?: string | null;
}

export type EscalationReason = 'uncertain' | 'invalid_cite' | 'hint_conflict';

/** One rung's answer for one item. */
export interface ModelVerdict {
  verdict: ResolutionVerdict;
  basis: ResolutionBasis;
  confidence: number;
  cite: PackLine | null;
  needs: string | null;
  valid: boolean;
  invalidWhy?: string;
}

export interface LadderDecision {
  itemId: string;
  decidedBy: 'rule' | 'model' | 'escalation' | 'skip' | 'failed';
  rules: RulesResult;
  ruleHit: RuleId | null;
  verdict: ResolutionVerdict | null;
  basis: ResolutionBasis | null;
  confidence: number | null;
  /** Sure / likely for a rule; from the model's confidence otherwise. */
  certainty: 'sure' | 'likely' | null;
  cite: PackLine | null;
  needs: string | null;
  escalated: boolean;
  escalationReason: string | null;
  escalationChanged: boolean | null;
  model: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  calls: number;
  error?: string;
}

/** Recent escalations per reason (from llm_calls), for the data gate. */
export interface EscalationStat {
  reason: EscalationReason;
  escalations: number;
  changed: number;
}

/**
 * The resolution skill as the composition root loads it (`loadResolutionSkill`, src/scanner/resolution/skill.ts): the
 * prompt, its frontmatter (models, thresholds, budgets) and the model ids to use when the frontmatter names none. The
 * engine never reads the file itself (CONTRIBUTING "Where code goes": no node-only modules, no `llm` in a pure layer).
 */
export interface ResolutionSkill {
  body: string;
  frontmatter: Record<string, unknown>;
  defaultModels: { cheap: string; strong: string };
}

export interface LadderOptions {
  model: CompletionModel;
  skill: ResolutionSkill;
  now: Date;
  me: string;
  cheapModel?: string;
  strongModel?: string;
  /** Stats over the last 14 days; a reason under 20 % changed (with enough samples) stops escalating. */
  escalationStats?: EscalationStat[];
  /** Turn the stronger model off (Settings ▸ Closing ▸ stronger model). */
  strongerModel?: boolean;
  /** Max items per cheap call (items sharing a conversation batch together). */
  batchSize?: number;
  maxCallUsd?: number;
  signal?: AbortSignal;
  /** Booked on each call (the job's ledger), with what the call was. */
  onCall?: (c: CallRecord) => void | Promise<void | number | null>;
}

export interface CallRecord {
  model: string;
  tier: 'cheap' | 'strong';
  itemIds: string[];
  system: string;
  user: string;
  ok: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  errorClass?: string;
  escalationReason?: EscalationReason;
  /** On an escalation: whether the stronger verdict differs from the cheap one. */
  changed?: boolean;
}

/** One closure_checks row (what the DB and the memory store record). */
export interface CheckRecord {
  workItemId: string;
  at: string;
  trigger: ResolutionTrigger;
  mode: 'shadow' | 'live';
  statusBefore: string;
  packDigest: string;
  packTokens: number;
  packLines: number;
  rulesFired: string[];
  ruleHit: string | null;
  decidedBy: LadderDecision['decidedBy'];
  verdict: string | null;
  basis: string | null;
  confidence: number | null;
  citeAlias: string | null;
  citeSourceItemId: string | null;
  escalated: boolean;
  escalationReason: string | null;
  escalationChanged: boolean | null;
  outcome: ResolutionOutcome;
  blockedBy: string | null;
  model: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  llmCallId?: number | null;
  durationMs: number;
  engineVersion: string;
}
