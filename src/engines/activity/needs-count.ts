/**
 * The one "needs you" count on Activity (2026-11-20 review, 01 UI-3). Before this, the header said "6 rows need you"
 * (the rows alone) while the Needs-you tab said 7 (the rows plus the use-case questions): two sums of the same thing.
 * Every surface that says how many things wait on the user in Activity reads this: the header sentence and the tab.
 * (The sidebar badge is a different signal on purpose: approvals waiting, see components/time/badges.ts.)
 *
 * Pure. The rows are what `needsYou` (components/time/path-derive.ts) derives; the use cases are the Org62 use cases
 * that carry a question (`UseCaseSyncItem.question`); the candidates are the use cases to add the app noticed
 * (src/engines/use-cases, GET /use-cases/candidates `counts.toAdd`).
 */
export interface NeedsYouCount {
  /** Activity rows that cannot log without the user. */
  rows: number;
  /** Org62 use cases that wait on an answer. */
  useCases: number;
  /** Use cases to add (candidates waiting for Accept, Edit or Reject). */
  candidates: number;
  /** What the tab shows and the header says: rows plus use cases plus use cases to add. */
  total: number;
}

const count = (n: number | undefined) => Math.max(0, Math.trunc(n ?? 0) || 0);

export function needsYouCount(input: { rows: number; useCases: number; candidates?: number }): NeedsYouCount {
  const rows = count(input.rows);
  const useCases = count(input.useCases);
  const candidates = count(input.candidates);
  return { rows, useCases, candidates, total: rows + useCases + candidates };
}

/**
 * One plain sentence for 0, 1 or many of each part, the use cases said once (24-visual-qa: "1 use case and 3 use cases
 * to add need you" named them twice): "6 rows need you" · "1 row and 1 use case need you" · "3 use cases to add need
 * you" · "6 rows and 4 use cases (3 to add) need you" · null when nothing waits.
 */
export function needsYouPhrase(c: NeedsYouCount): string | null {
  if (!c.total) return null;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const asked = c.useCases;
  const toAdd = c.candidates ?? 0;
  const useCases = asked && toAdd ? `${n(asked + toAdd, 'use case', 'use cases')} (${toAdd} to add)` : asked ? n(asked, 'use case', 'use cases') : toAdd ? n(toAdd, 'use case to add', 'use cases to add') : null;
  const rows = c.rows ? n(c.rows, 'row', 'rows') : null;
  const list = [rows, useCases].filter(Boolean).join(' and ');
  return `${list} ${c.total === 1 ? 'needs' : 'need'} you`;
}

// ── The same pattern for Triage and the Outbox (01 UI-3, R12) ────────────────────────────────────────────────────────
// One count per page, read by every surface that says it: the page's sentence, its position line and the sidebar.
// The sidebar badge comes from the server's navCounts (getToday); tests/ui/counts-parity.test.ts pins that the
// server's numbers equal these over the same payload, so the badge and the page cannot drift apart.

export interface TriageCount {
  /** Guesses waiting for you to confirm (the badge, the sentence). */
  guesses: number;
  /** Closed for you in the last 14 days: a record, never counted with the guesses. */
  closed: number;
  /** Rows on the page (guesses and closed), for "4 of N" while a row is selected. */
  rows: number;
}

export function triageCount(input: { guesses: number; closed: number }): TriageCount {
  const guesses = Math.max(0, Math.trunc(input.guesses) || 0);
  const closed = Math.max(0, Math.trunc(input.closed) || 0);
  return { guesses, closed, rows: guesses + closed };
}

/** "9 guesses to confirm" · "1 guess to confirm" · null when nothing waits. */
export function triagePhrase(c: TriageCount): string | null {
  return c.guesses ? `${c.guesses} ${c.guesses === 1 ? 'guess' : 'guesses'} to confirm` : null;
}

export interface OutboxCount {
  /** Drafts waiting for your approval. */
  pending: number;
  /** Sends that failed and wait for a retry. */
  failed: number;
  /** What waits on you: the badge (red when it is not zero) and the sentence. */
  total: number;
}

export function outboxCount(input: { pending: number; failed: number }): OutboxCount {
  const pending = Math.max(0, Math.trunc(input.pending) || 0);
  const failed = Math.max(0, Math.trunc(input.failed) || 0);
  return { pending, failed, total: pending + failed };
}

/** "2 drafts wait for your approval, and 1 failed" · "1 failed to send" · null when nothing waits. */
export function outboxPhrase(c: OutboxCount): string | null {
  if (!c.total) return null;
  const drafts = c.pending ? `${c.pending} ${c.pending === 1 ? 'draft waits' : 'drafts wait'} for your approval` : null;
  const failed = c.failed ? `${c.failed} failed${drafts ? '' : ' to send'}` : null;
  return drafts && failed ? `${drafts}, and ${failed}` : (drafts ?? failed);
}

// 01 R5 / D-86: the one Needs-you count is the queue's total (p3-needs-queue).
export { needsCount } from '../needs/count';
