/**
 * Outbox row semantics (pure): what a draft's status means on screen, so nothing that is pending ever
 * looks sent (UI-SPEC §12) and a dry run never looks like a delivery.
 */
import type { DispatchAttempt, Draft, OutboxGroup } from '@/contract';
import type { Tone } from '@/ui/tones';
import { fmtClockIn, fmtDayIn } from './format';

export interface OutboxStatusView {
  tone: Tone;
  label: string;
  /** Pending and scheduled use the dashed treatment: they have not left. */
  dashed: boolean;
  /** One quiet line under the preview (verification detail, failure reason). */
  detail: string | null;
  /** The message actually left the machine (sent, staged as a destination draft, or verified). */
  left: boolean;
}

/** The latest attempt that only rendered the payload (global dry run). */
export function lastDryRun(d: Pick<Draft, 'attempts'>): DispatchAttempt | null {
  for (let i = d.attempts.length - 1; i >= 0; i--) {
    const a = d.attempts[i]!;
    if (a.dryRun || a.outcome === 'rendered') return a;
  }
  return null;
}

/** Why a failed row failed: the newest failed attempt, else the verification note. */
export function failureOf(d: Pick<Draft, 'attempts' | 'verification'>): string | null {
  for (let i = d.attempts.length - 1; i >= 0; i--) {
    const a = d.attempts[i]!;
    if (a.outcome === 'failed') return a.detail ?? 'The send failed.';
  }
  if (d.verification && (d.verification.state === 'failed' || d.verification.state === 'unverified')) return d.verification.detail;
  return null;
}

/**
 * A failure in words a seller reads (01-ui-audit UI-7, R7: never the raw error): "Gmail API 503: backendError" says
 * Gmail had a problem on its side and Retry sends it again. A line that is already a sentence stays as it is; the
 * raw text stays in the row's details panel (its attempts list) for a report.
 */
export function plainFailure(raw: string | null, destination?: Pick<Draft['destination'], 'kind'>): string | null {
  if (!raw) return null;
  const app = destination?.kind === 'slack' ? 'Slack' : destination?.kind === 'email' ? 'Gmail' : 'The other app';
  if (/\b(401|403)\b|unauthori[sz]ed|invalid_auth|token (?:expired|revoked)|signed out|re-?auth/i.test(raw)) return `${app} needs you to sign in again; then Retry.`;
  if (/\b429\b|rate.?limit|too many requests/i.test(raw)) return `${app} is busy right now (too many requests). Retry in a minute.`;
  if (/\b5\d\d\b|backendError|timed? ?out|ETIMEDOUT|ECONNRESET|unavailable|fetch failed|socket hang up/i.test(raw)) return `${app} had a temporary problem on its side. Retry sends it again.`;
  // a bare code, an API name or a stack-ish token is not a sentence a seller can act on
  if (!/\s/.test(raw.trim()) || /\b[a-z]+[A-Z]\w*\b|\b\w+_\w+\b|\bAPI\b|Error\b/.test(raw)) return `${app} didn't take it. Retry, or open the row for what it said.`;
  return raw;
}

/**
 * A message pushed as a draft in its own app waits there for you to send it: say so ("Saved as Slack draft") and
 * where to find it ("in Slack ▸ Drafts"). Null for structured actions (applied, not pushed).
 */
export function stagedLabel(destination: Pick<Draft['destination'], 'kind'> | undefined): string | null {
  if (destination?.kind === 'slack') return 'Saved as Slack draft';
  if (destination?.kind === 'email') return 'Saved as Gmail draft';
  return null;
}
export function stagedWhere(destination: Pick<Draft['destination'], 'kind'> | undefined): string | null {
  if (destination?.kind === 'slack') return 'in Slack ▸ Drafts';
  if (destination?.kind === 'email') return 'in Gmail ▸ Drafts';
  return null;
}

/** "Open sent ↗": where a sent message (or a pushed draft) lives, when the send recorded it. Never for an action. */
export function sentResultUrl(d: Pick<Draft, 'resultUrl'> & { destination?: Pick<Draft['destination'], 'kind'> }, group: OutboxGroup): string | null {
  return group === 'sent' && d.destination?.kind !== 'action' && d.resultUrl ? d.resultUrl : null;
}

export function outboxStatus(d: Draft, group: OutboxGroup, tz?: string): OutboxStatusView {
  switch (group) {
    case 'pending_approval':
      return { tone: 'brand', label: 'Pending approval', dashed: true, detail: null, left: false };
    case 'scheduled':
      return { tone: 'brand', label: d.scheduledFor ? `Scheduled · ${fmtDayIn(d.scheduledFor, tz)} ${fmtClockIn(d.scheduledFor, tz)}` : 'Scheduled', dashed: true, detail: null, left: false };
    case 'failed':
      return { tone: 'risk', label: 'Failed', dashed: false, detail: plainFailure(failureOf(d), d.destination), left: false };
    case 'sent': {
      // a structured action (a canvas, a VDP change, the feedback post) is applied, not sent
      const action = d.destination?.kind === 'action';
      switch (d.status) {
        case 'sending':
          return { tone: 'warn', label: action ? 'Applying…' : 'Sending…', dashed: false, detail: null, left: false };
        case 'staged': {
          if (action) return { tone: 'neutral', label: 'Applied', dashed: false, detail: d.verification?.detail ?? null, left: true };
          // where the pushed draft waits for you to send it, then what the read-back found
          const where = stagedWhere(d.destination);
          const detail = [where ? `Find it ${where}` : null, d.verification?.detail ?? null].filter(Boolean).join(' · ') || null;
          return { tone: 'neutral', label: stagedLabel(d.destination) ?? 'Draft saved', dashed: false, detail, left: true };
        }
        case 'verified':
          return { tone: 'ok', label: action ? 'Applied · verified' : 'Verified', dashed: false, detail: d.verification?.detail ?? null, left: true };
        case 'verify_failed':
          return { tone: 'warn', label: action ? 'Applied · not verified' : 'Unverified', dashed: false, detail: d.verification?.detail ?? 'Read-back did not find it.', left: true };
        default: {
          const word = action ? 'Applied' : 'Sent';
          return { tone: 'neutral', label: d.verification?.state === 'pending' ? `${word} · verifying…` : word, dashed: false, detail: d.verification?.detail ?? null, left: true };
        }
      }
    }
  }
}

/** Sent group sub-count: "2 verified · 1 unverified". */
export function sentBreakdown(drafts: Array<Pick<Draft, 'status'>>): string {
  const v = drafts.filter((d) => d.status === 'verified').length;
  const u = drafts.filter((d) => d.status === 'verify_failed').length;
  const rest = drafts.length - v - u;
  return [v ? `${v} verified` : '', u ? `${u} unverified` : '', rest ? `${rest} other` : ''].filter(Boolean).join(' · ');
}

/** Approve is only offered where a send has not happened: pending, scheduled and failed rows. */
export function canApprove(group: OutboxGroup): boolean {
  return group === 'pending_approval' || group === 'scheduled' || group === 'failed';
}

/** Button copy. In dry run the label says so, so nobody expects a delivery. */
export function approveLabel(d: Pick<Draft, 'mode'> & { destination?: Draft['destination'] }, group: OutboxGroup, dryRun: boolean): string {
  // A structured action changes something in its app: Apply, not send. Draft mode leaves a draft in Slack or Gmail for
  // you to send there, and says where in plain words (01-ui-audit UI-16: "push draft" was jargon).
  const where = d.destination?.kind === 'slack' ? 'Slack' : d.destination?.kind === 'email' ? 'Gmail' : null;
  const base = group === 'failed' ? 'Retry' : d.destination?.kind === 'action' ? 'Approve & apply' : d.mode === 'send' ? 'Approve & send' : where ? `Approve: draft in ${where}` : 'Approve as a draft';
  return dryRun ? `${base} (dry run)` : base;
}

/** v2 Outbox sections, in focus order. "Sending" is a draft status inside the contract's groups, shown on its own. */
export type OutboxSection = 'approve' | 'retry' | 'sending' | 'later' | 'sent';
export const OUTBOX_SECTIONS: Array<{ key: OutboxSection; title: string; noun: string }> = [
  { key: 'approve', title: 'Approve', noun: 'drafts' },
  { key: 'retry', title: 'Retry', noun: 'failed' },
  { key: 'sending', title: 'Sending now', noun: 'sending' },
  { key: 'later', title: 'Going out later', noun: 'scheduled' },
  { key: 'sent', title: 'Sent', noun: 'sent' },
];

export function outboxSection(it: { group: OutboxGroup; draft: Pick<Draft, 'status'> }): OutboxSection {
  if (it.draft.status === 'sending') return 'sending';
  if (it.group === 'pending_approval') return 'approve';
  if (it.group === 'failed') return 'retry';
  if (it.group === 'scheduled') return 'later';
  return 'sent';
}
