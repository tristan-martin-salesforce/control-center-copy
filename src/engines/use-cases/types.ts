/**
 * Use-case candidates (holistic review 2026-11-20 lane 06 R6, TA-14; H-9): use cases the app notices in what I read
 * (Gemini notes, meetings, Slack bursts and mail threads with a customer), stages for me, and adds to VDP and Org62 in
 * one click, instead of me typing them twice. The engine is pure: the db and the mock hand it sources, the
 * attribution engine's World and what already exists; it hands back candidates (or evidence for one that exists).
 *
 * Tenets: *Nothing leaves without approval* (Accept drafts two Outbox items, both applied by the user), *Suggest, then
 * learn* (every pick and every wrong-opp reject is a correction the attribution engine learns from), *Provenance on
 * everything* (each candidate carries its evidence: the source items and the sentence), *Config over code* (the
 * product vocabulary is Settings ▸ Time `dcProducts` plus VDP's own).
 */
import type { UcTrack } from '@/engines/activity/use-cases';
import type { Reason, Signal } from '@/engines/attribution/types';
import type { RundownOpp } from '@/engines/attribution/rundown';

/** Where a candidate came from. */
export type UcSourceKind = 'gemini_note' | 'meeting' | 'slack_burst' | 'mail_thread' | 'manual';
export const UC_SOURCE_KINDS: readonly UcSourceKind[] = ['gemini_note', 'meeting', 'slack_burst', 'mail_thread', 'manual'];

/** suggested → (edited) → accepted / staged_org62 / staged_vdp → landed; or rejected. */
export type UcCandidateStatus = 'suggested' | 'accepted' | 'edited' | 'rejected' | 'staged_org62' | 'staged_vdp' | 'landed';
export const UC_CANDIDATE_STATUSES: readonly UcCandidateStatus[] = ['suggested', 'accepted', 'edited', 'rejected', 'staged_org62', 'staged_vdp', 'landed'];
/** The ones still waiting on me (Activity ▸ Needs you ▸ Use cases to add). */
export const UC_WAITING: ReadonlySet<UcCandidateStatus> = new Set(['suggested', 'edited']);
/** Accepted and on their way (an Outbox item or a canvas row, not yet read back). */
export const UC_STAGED: ReadonlySet<UcCandidateStatus> = new Set(['accepted', 'staged_org62', 'staged_vdp']);

export type UcRejectReason = 'not_use_case' | 'wrong_opp' | 'duplicate' | 'already_in_org62';
export const UC_REJECT_REASONS: readonly UcRejectReason[] = ['not_use_case', 'wrong_opp', 'duplicate', 'already_in_org62'];

/** One thing I read, as the extractor reads it (the db and the mock build these from their stores). */
export interface UcSource {
  kind: UcSourceKind;
  /** Stable key: the notes' or meeting's source item id, the Slack thread or the mail thread. */
  key: string;
  /** The source items it is made of (evidence links). */
  sourceItemIds: string[];
  /** The note's meeting, the event title, the channel, the subject. */
  title: string;
  /** The words to read (the notes' summary and decisions, the event description, the burst's lines, the mails). */
  text: string;
  at: string;
  url: string | null;
  /** External participants (attendees, recipients, channel members not of my domain). Empty: internal only. */
  externalEmails: string[];
  externalDomains: string[];
  /** A customer counterpart without an external email (a mapped customer channel, a shared channel). */
  customer?: boolean;
  channel?: { id: string; name?: string | null } | null;
  seriesId?: string | null;
  /** The opp or account the source is already linked to (the meeting's opp, the channel's account). */
  explicit?: { oppIds?: string[]; accountIds?: string[]; via?: string } | null;
}

/** One use-case shaped statement found in a source. */
export interface UcMention {
  sourceKey: string;
  /** The sentence it came from (clipped; never logged). */
  statement: string;
  /** "Order status" (what the problem is called, short). */
  title: string;
  /** The problem in a sentence ("Brendan wants a working demo of order status"). */
  problem: string;
  /** Salesforce products named (canonical names). */
  products: string[];
  track: UcTrack | null;
  /** The outcome or KPI named nearby ("containment 58%"), else ''. */
  outcome: string;
  /** VDP execution phase it sounds like (Discovery · Build · Live), else null. */
  stageHint: string | null;
  /** The cue that made it ("wants a demo of", "agreed to prove"). */
  cue: string;
  /** sure: the cue and a product or capability; unsure: a model confirms it first (or it is dropped). */
  certainty: 'sure' | 'unsure';
}

/** Evidence on a candidate: a source item and the sentence. */
export interface UcEvidence {
  sourceKey: string;
  sourceItemId: string | null;
  kind: UcSourceKind;
  label: string;
  url: string | null;
  at: string;
  quote: string | null;
}

/** What a candidate matched instead of being new (dedupe): an app use case, an Org62 record, a VDP use case. */
export type UcMatchKind = 'use_case' | 'org62' | 'vdp' | 'candidate';

/** A candidate as stored (use_case_candidates; the mock's collection). */
export interface UcCandidateRow {
  id: string;
  source: UcSourceKind;
  sourceKey: string;
  title: string;
  problem: string;
  products: string[];
  outcome: string;
  track: UcTrack | null;
  stageHint: string | null;
  status: UcCandidateStatus;
  rejectReason: UcRejectReason | null;
  accountId: string | null;
  oppId: string | null;
  confidence: number;
  why: Reason[];
  /** The engine was unsure of the opp: the picker shows the alternates. */
  needsPick: boolean;
  alternates: RundownOpp[];
  basis: 'rules' | 'ai';
  dedupeKey: string;
  problemKey: string;
  evidence: UcEvidence[];
  /** The signal the opp was attributed from (what a correction teaches the engine). */
  signal: Signal | null;
  matchedKind: UcMatchKind | null;
  useCaseId: string | null;
  org62UseCaseId: string | null;
  vdpUseCaseId: string | null;
  vdpSlug: string | null;
  vdpDraftId: string | null;
  createdAt: string;
  decidedAt: string | null;
  updatedAt: string;
}

/** Something that already exists, for dedupe. */
export interface UcExisting {
  kind: Exclude<UcMatchKind, 'candidate'>;
  /** use_cases.id, the Use_Case__c id, the VDP use case id. */
  id: string;
  title: string;
  oppId: string | null;
  accountId: string | null;
  org62UseCaseId?: string | null;
  vdpUseCaseId?: string | null;
  vdpSlug?: string | null;
  useCaseId?: string | null;
}
