/**
 * Missed-opportunity engine types (R-UI-14). Names mirror docs/reference/DATA-MODEL.md:
 * missed_opp_findings (tier, verdict, evidence_strength, has_d360_line, d360_line_amount,
 * flex_line_amount, my_org62_hours, my_dc_exists, other_architect_dc_count, stranded_dc_id).
 */

export type MissedOppTier =
  | 'won_no_dc'
  | 'strong_evidence_no_dc'
  | 'core_account_no_dc'
  | 'core_account_flex_only'
  | 'renewal'
  | 'light_touch'
  | 'light_touch_flex_only'
  | 'stranded_dc'
  | 'already_covered';

export type MissedOppVerdict = 'claim' | 'check' | 'skip';
export type EvidenceStrength = 'strong' | 'some' | 'none';

/** Org62 Opportunity (read-only mirror). */
export interface OppRecord {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  amount: number | null;
  stageName: string;
  isClosed: boolean;
  isWon: boolean;
  /** YYYY-MM-DD */
  closeDate: string;
  /** New Business, Renewal, Upsell, ... */
  type?: string | null;
  /** Deadline_to_Update__c: DCs lock after this day (YYYY-MM-DD). */
  deadlineToUpdate?: string | null;
}

export interface LineItemRecord {
  oppId: string;
  productName: string;
  totalPrice: number;
}

export interface DcRecord {
  id: string;
  oppId: string;
  userId: string;
  userName?: string | null;
  /** Opportunity_Role__c, e.g. "AI + Data Architect". */
  role: string;
  splitPercent: number;
}

export type AccountVia = 'opp_team' | 'dc' | 'org62_event' | 'calendar' | 'sibling';

export interface AccountScope {
  accountId: string;
  /** core = opp team / my DCs / my logged Org62 time. light = calendar or sibling org only. */
  kind: 'core' | 'light';
  via: AccountVia[];
}

export type EvidenceKind = 'org62_event' | 'calendar' | 'drive' | 'gemini_notes' | 'slack' | 'claude_session';

/** One piece of the user's own activity, already reduced to a title/subject (never message bodies). */
export interface EvidenceSignal {
  id: string;
  kind: EvidenceKind;
  /** Title / subject / one-line snippet. Matched against opp name tokens. */
  text: string;
  at?: string;
  /** Explicit opp link (e.g. Event.WhatId). Wins over text matching. */
  oppId?: string;
  accountId?: string;
  /** Org62 event hours, or Claude hands-on hours. */
  hours?: number;
  /** Drive: the user owns/authored it. Calendar: the user accepted and attended. */
  owned?: boolean;
  /** Slack: the prior judgment of the thread. */
  verdict?: 'strong' | 'some';
  /** Claude session: how many accounts it touched. */
  accountCount?: number;
  /** Calendar noise inputs. */
  recurring?: boolean;
  internalOnly?: boolean;
}

export interface EvidenceReason {
  evidenceId: string;
  kind: EvidenceKind;
  weight: 'strong' | 'some';
  text: string;
}

export interface IgnoredEvidence {
  evidenceId: string;
  why: string;
}

export interface NarrowResult {
  strength: EvidenceStrength;
  verdict: MissedOppVerdict;
  reasons: EvidenceReason[];
  ignored: IgnoredEvidence[];
  evidenceIds: string[];
  myOrg62Hours: number;
  summary: string;
}

export interface Classification {
  signal: 'd360_line' | 'name_token' | 'flex_only' | 'none';
  hasD360Line: boolean;
  d360LineAmount: number;
  flexLineAmount: number;
  d360Products: string[];
  /** Lines dropped from the D360 count ($0 Provisioning / Foundations entitlements). */
  excludedEntitlements: string[];
  nameTokens: string[];
}

export interface LockInfo {
  deadline: string | null;
  locked: boolean;
  /** Past the lock: the DC needs a manager exception. */
  managerExceptionNeeded: boolean;
  noteDraft: string | null;
}

export interface ClaimTask {
  title: string;
  opportunityId: string;
  role: string;
  splitPercent: number;
  /** Slackbot "DC Comment Upload" prompt draft. Draft only: nothing is sent. */
  slackbotPromptDraft: string;
}

export type SuggestedAction =
  | { kind: 'claim'; label: string; task: ClaimTask }
  | { kind: 'request_exception'; label: string; noteDraft: string }
  | { kind: 'move_dc'; label: string; candidateOppIds: string[]; noteDraft: string }
  | { kind: 'dismiss'; label: string; requiresReason: true; reasons: string[] };

export interface MissedOppFinding {
  opportunityId: string;
  accountId: string;
  tier: MissedOppTier;
  verdict: MissedOppVerdict;
  evidenceStrength: EvidenceStrength;
  signal: Classification['signal'];
  hasD360Line: boolean;
  d360LineAmount: number;
  flexLineAmount: number;
  myOrg62Hours: number;
  myDcExists: boolean;
  otherArchitectDcCount: number;
  /** DC id of my DC when it sits on a dead/duplicate opp. */
  strandedDcId: string | null;
  evidenceSummary: string;
  reasons: EvidenceReason[];
  evidenceIds: string[];
  /** "Split, not a second 100%" note when another AI + Data Architect already holds the role. */
  splitNote: string | null;
  suggestedSplit: number;
  lock: LockInfo;
  actions: SuggestedAction[];
}

export const ARCHITECT_ROLE = 'AI + Data Architect';
export const DISMISS_REASONS = ['not my work', 'AE or another SE covers it', 'duplicate opp', 'renewals team owns it', 'deal lost', 'split declined', 'other'] as const;
