/**
 * A ladder decision → what happens to the item, with no new status vocabulary (decision H-7):
 *
 *   done (rule or model), citing a line            → `completion` evidence (Sure or Likely), judged by the closure
 *                                                    machine (applySignal): it closes (closed), asks (likely), or does
 *                                                    nothing; R1's mayAutoClose downgrades a Sure to Likely there
 *   partial                                         → `progress` evidence (in progress), outcome left
 *   a chase after an engine close (item is done)    → `contradiction` with `follow_up:`: the machine reopens (reopened)
 *   done by another, not mine, not needed, duplicate,
 *   waiting on them, gone quiet, not done           → Settle's policy (decideSettle): close / ask / reopen / wait / leave
 *
 * Brakes (wave-0 review W0-4, the reopen → re-close flip-flop): after a follow-up reopen, only evidence newer than the
 * reopen can close it again; after two reopens the item is ask-only (Likely done · Confirm, Still needed?) and the
 * check says why (`blocked_by: reopened_twice`, shown in "Why still open"). Pure.
 */
import type { ClosingSettings } from '@/contract';
import { applySignal } from '@/engines/closure/machine';
import { signalFromEvidence, type EvidenceLink } from '@/engines/closure/signals';
import { REOPEN_ASK_ONLY_AFTER } from '@/engines/closure/correction';
import { decideSettle } from '@/engines/settle/policy';
import type { SettleResult, SettleVerdict } from '@/engines/settle/types';
import type { Confidence, SignalSource } from '@/engines/types';

import type { LadderDecision, PackLine, ResolutionItem, ResolutionOutcome, ResolutionPack } from './types';

/** Reason prefix on every evidence row the check writes (kept readable, like `done_check:` and `settle:`). */
export const RESOLUTION_PREFIX = 'resolution:';
export { REOPEN_ASK_ONLY_AFTER };

export interface OutcomePlan {
  outcome: ResolutionOutcome;
  blockedBy: string | null;
  /** Live: the evidence row to link (the machine then decides, through `reevaluate`). */
  evidence?: { sourceItemId: string; role: 'completion' | 'progress' | 'contradiction'; confidence: Confidence; reason: string };
  /** Live: the Settle-policy action to apply (settleApply). */
  settle?: { action: 'close' | 'ask_looks_done' | 'ask_still_needed' | 'reopen' | 'wait'; reasonClass: string | null; resolution?: string; verdict: SettleVerdict; confidence: number };
  /** One line in plain words (scan:explain, the panel). */
  why: string;
}

const SETTLE_OF: Record<string, SettleVerdict> = {
  done_by_other: 'resolved_by_other',
  not_mine: 'not_yours',
  not_needed: 'moment_passed',
  duplicate: 'duplicate',
  waiting_on_them: 'waiting_on_them',
  gone_quiet: 'gone_quiet',
  not_done: 'still_yours',
  done: 'done_by_you',
};

const sourceOf = (l: PackLine): SignalSource | undefined => (l.kind === 'file' ? 'drive' : l.kind === 'session' ? 'claude' : l.kind === 'notes' ? 'gemini' : /email/.test(l.where ?? '') ? 'gmail' : /DM|thread|#|channel/.test(l.where ?? '') ? 'slack' : undefined);

function viaMachine(item: ResolutionItem, l: PackLine, role: 'completion' | 'progress' | 'contradiction', confidence: Confidence, reason: string, at: string): ResolutionOutcome {
  const link: EvidenceLink = { id: `rc-${l.id}`, role, confidence, reason, at: l.at ?? at, linkedAt: at, ...(sourceOf(l) ? { source: sourceOf(l)! } : {}), actor: { name: l.by, ...(l.fromMe ? { isMe: true } : {}) }, ...(l.kind === 'file' ? { fileRef: l.sourceItemId ?? null } : {}) };
  const d = applySignal(item.closure, signalFromEvidence(link));
  const to = d.transition?.to;
  if (to === 'done') return 'closed';
  if (to === 'likely_done' || (role === 'completion' && item.status === 'likely_done')) return 'likely';
  if (item.status === 'done' && to) return 'reopened';
  return 'left';
}

/** The chase line that would reopen an engine close: the asker writing again after the close. */
function chaseAfterClose(item: ResolutionItem, p: ResolutionPack): PackLine | undefined {
  const closed = Date.parse(item.closure.doneAt ?? '');
  return [...p.after].reverse().find((l) => l.tag === 'chase' && l.byAsker && (!Number.isFinite(closed) || Date.parse(l.at ?? '') > closed));
}

export function planOutcome(item: ResolutionItem, d: LadderDecision, p: ResolutionPack, settings: ClosingSettings, now: Date): OutcomePlan {
  const at = now.toISOString();
  if (d.decidedBy === 'skip') return { outcome: 'left', blockedBy: null, why: 'nothing new since the last check' };
  if (d.decidedBy === 'failed') return { outcome: 'left', blockedBy: 'check_failed', why: `the check failed (${d.error ?? 'no verdict'}); it tries again on the next trigger` };

  // ---- a closed item: the only question is whether a follow-up brings it back (R2, through the machine)
  if (item.status === 'done') {
    const chase = chaseAfterClose(item, p);
    if (chase && chase.sourceItemId && item.closure.doneBy === 'engine' && settings.reopenOnFollowUp && d.verdict !== 'done') {
      const reason = `follow_up: ${chase.by} wrote again: ${RESOLUTION_PREFIX} ${d.needs ?? 'not finished'}`;
      const outcome = viaMachine(item, chase, 'contradiction', 'sure', reason, at);
      return { outcome, blockedBy: null, evidence: { sourceItemId: chase.sourceItemId, role: 'contradiction', confidence: 'sure', reason }, why: `${chase.by} wrote again after it was closed for you` };
    }
    return { outcome: 'left', blockedBy: null, why: 'already done; nothing reopens it' };
  }

  const askOnly = item.reopenedCount >= REOPEN_ASK_ONLY_AFTER;
  const sinceReopen = Date.parse(item.lastReopenAt ?? '');
  const why = (s: string) => `${d.decidedBy === 'rule' ? `rule ${d.ruleHit}` : d.decidedBy === 'escalation' ? 'the stronger model' : 'the cheap model'}: ${s}`;

  // ---- done, citing a line: through the closure machine
  if (d.verdict === 'done' && d.cite?.sourceItemId && d.certainty) {
    const c = d.cite;
    if (Number.isFinite(sinceReopen) && item.reopenedCount > 0 && Date.parse(c.at ?? '') <= sinceReopen) {
      return { outcome: 'left', blockedBy: 'evidence_before_reopen', why: why('the line it cites is older than your reopen; it needs something new') };
    }
    const confidence: Confidence = d.certainty === 'sure' && !askOnly ? 'sure' : 'likely';
    const reason = `${RESOLUTION_PREFIX} ${d.decidedBy === 'rule' ? `${d.ruleHit} ${d.rules.decision?.why ?? ''}` : (d.needs ?? `${d.basis ?? 'done'} (${c.id})`)}`.trim();
    const outcome = viaMachine(item, c, 'completion', confidence, reason, at);
    const blockedBy = askOnly && d.certainty === 'sure' ? 'reopened_twice' : outcome !== 'closed' && d.certainty === 'sure' ? (item.closure.mayAutoClose === false ? (item.closure.autoCloseBlock ?? 'user_corrected') : c.kind === 'file' ? 'file_edit_alone' : null) : null;
    return { outcome, blockedBy, evidence: { sourceItemId: c.sourceItemId!, role: 'completion', confidence, reason }, why: why(outcome === 'closed' ? `closed for you, citing ${c.id}` : `looks done (${c.id}); one confirm`) };
  }
  if (d.verdict === 'partial' && d.cite?.sourceItemId) {
    const reason = `${RESOLUTION_PREFIX} partial: ${d.needs ?? 'some of it'}`;
    viaMachine(item, d.cite, 'progress', 'likely', reason, at);
    return { outcome: 'left', blockedBy: null, evidence: { sourceItemId: d.cite.sourceItemId, role: 'progress', confidence: 'likely', reason }, why: why(`some of it is done${d.needs ? `; still needs ${d.needs}` : ''}`) };
  }

  // ---- everything else: Settle's policy (R1's correction rule inside)
  const verdict = SETTLE_OF[d.verdict ?? 'not_done'] ?? 'still_yours';
  const r: SettleResult = {
    workItemId: item.id,
    verdict,
    confidence: d.confidence ?? 0,
    reason: d.needs ?? '',
    valid: d.verdict === 'done' ? false : true,
    ...(d.verdict === 'done' ? { invalidWhy: 'done without a line to cite' } : {}),
    ...(p.hints.askCutOff ? { askCutOff: true } : {}),
    ...(p.ruleHints.lastWriter === 'asker' && !p.ruleHints.askerAckAfterMine ? { openLoop: true } : {}),
    model: d.model ?? 'rules',
    costUsd: d.costUsd,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    skill: 'resolve-item',
  };
  const s = decideSettle(r, item.policy, settings);
  let action = s.action;
  let blockedBy: string | null = action === 'leave' ? s.why : null;
  if (action === 'close' && askOnly) {
    action = s.reason === 'done_by_you' || s.reason === 'resolved_by_other' || s.reason === 'duplicate' || s.reason === 'superseded' ? 'ask_looks_done' : 'ask_still_needed';
    blockedBy = 'reopened_twice';
  }
  if (action === 'leave') return { outcome: 'left', blockedBy: verdict === 'still_yours' ? null : blockedBy, why: why(verdict === 'still_yours' ? `still yours${d.needs ? `: ${d.needs}` : ''}` : s.why) };
  const outcome: ResolutionOutcome = action === 'close' ? 'closed' : action === 'reopen' ? 'reopened' : action === 'wait' ? 'left' : 'asked';
  return {
    outcome,
    blockedBy: outcome === 'asked' ? (blockedBy ?? (s.why.includes('below') ? 'below_threshold' : s.why.includes('meeting') ? 'upcoming_meeting' : s.why.includes('wrote last') ? 'open_loop' : null)) : blockedBy,
    settle: { action, reasonClass: s.reason, ...(s.resolution ? { resolution: s.resolution } : {}), verdict, confidence: r.confidence },
    why: why(action === 'wait' ? 'waiting on their answer (Chase)' : outcome === 'closed' ? `closed for you (${s.reason})` : outcome === 'asked' ? `asks you (${s.why})` : s.why),
  };
}
