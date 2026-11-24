/**
 * R1: one correction rule for both closers (the closure machine and Settle). *Tenet: Suggest, then learn*: "it never
 * overrides a correction: an item you reopened or kept is never closed again for you".
 *
 *   mayAutoClose(item) = not reopened by the user after a close (a Reopen, an Undo of an engine close or ask,
 *                        Not done on Looks done)
 *                      ∧ not kept (Keep on Still needed?)
 *                      ∧ not on the user's ask-first lists (people, channels, external commitments)
 *
 * Accepting a suggestion from Triage, snoozing it, setting its account or due date, or adding notes are not
 * corrections: they never block a close (before, Settle treated any touch as one, SCN-3).
 *
 * Pure. The facts come from SQL (correction-db.ts) or a store; the settings are the user's Closing settings.
 */
import type { ClosingSettings } from '@/contract';

export interface CorrectionFacts {
  /** The user reopened it after a close: Reopen, an Undo of an engine close/ask, Not done on Looks done. */
  userReopened: boolean;
  /** The user kept it when asked "Still needed?". */
  userKept: boolean;
  /** A commitment to someone outside the company. */
  externalCommitment: boolean;
  /** People (names) and channels (`#name` or name) it involves. */
  people: string[];
  channels: string[];
}

export type AutoCloseBlock = 'user_reopened' | 'user_kept' | 'ask_first_external' | 'ask_first_person' | 'ask_first_channel';

type AskFirst = Pick<ClosingSettings, 'askFirstExternalCommitments' | 'askFirstPeople' | 'askFirstChannels'>;

const lc = (x: string) => x.trim().toLowerCase().replace(/^#/, '');

/** The first rule that keeps the engine from closing this item for the user, or null when it may. */
export function autoCloseBlock(f: CorrectionFacts, s: AskFirst): AutoCloseBlock | null {
  if (f.userReopened) return 'user_reopened';
  if (f.userKept) return 'user_kept';
  if (s.askFirstExternalCommitments && f.externalCommitment) return 'ask_first_external';
  if (s.askFirstPeople.some((p) => f.people.some((q) => lc(q) === lc(p)))) return 'ask_first_person';
  if (s.askFirstChannels.some((c) => f.channels.some((q) => lc(q) === lc(c)))) return 'ask_first_channel';
  return null;
}

export function mayAutoClose(f: CorrectionFacts, s: AskFirst): boolean {
  return autoCloseBlock(f, s) === null;
}

/** A correction (as opposed to an ask-first list): the item is never closed or asked about again by Settle. */
export const isCorrection = (b: AutoCloseBlock | string | null | undefined): boolean => b === 'user_reopened' || b === 'user_kept';

/** Plain words for a block, as the decision's note ("not closed for you: you reopened it"). */
export const AUTO_CLOSE_BLOCK_TEXT: Record<AutoCloseBlock, string> = {
  user_reopened: 'you reopened it',
  user_kept: 'you kept it',
  ask_first_external: 'commitment to someone outside the company',
  ask_first_person: 'a person on your ask-first list',
  ask_first_channel: 'a channel on your ask-first list',
};

export function blockText(b: string | null | undefined): string {
  return (b && AUTO_CLOSE_BLOCK_TEXT[b as AutoCloseBlock]) || 'set to ask first';
}

/** After this many reopens of a close for you, the engine only asks (wave-0 review W0-4: no reopen → re-close loop). */
export const REOPEN_ASK_ONLY_AFTER = 2;

export type ReopenBrake = 'reopened_twice' | 'evidence_before_reopen';

/**
 * W0-4: the brake on a flip-flop. A completion signal no newer than the item's last reopen is what the reopen already
 * overruled (`evidence_before_reopen`); after two reopens the item is ask-only (`reopened_twice`). Either way a Sure
 * completion only asks (Likely done · Confirm), and the reason is said. Pure.
 */
export function reopenBrake(item: { reopenedCount?: number | null; lastReopenedAt?: string | null }, signalAt: string | null | undefined): ReopenBrake | null {
  if ((item.reopenedCount ?? 0) >= REOPEN_ASK_ONLY_AFTER) return 'reopened_twice';
  const r = Date.parse(item.lastReopenedAt ?? '');
  const a = Date.parse(signalAt ?? '');
  if (Number.isFinite(r) && Number.isFinite(a) && a <= r) return 'evidence_before_reopen';
  return null;
}

export const REOPEN_BRAKE_TEXT: Record<ReopenBrake, string> = {
  reopened_twice: 'it was reopened twice, so it only asks now',
  evidence_before_reopen: 'that evidence is older than its reopen',
};

