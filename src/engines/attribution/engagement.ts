/**
 * `opp_engagement` rollup (R4): per opp × ISO week, what I did on it: meetings (and how many had a customer),
 * Slack lines, mail threads, docs touched, sessions, notes, hours logged, the last touch and counts per source.
 *
 * Attribute time to one opp, deserve DCs on several (lane 06 D-T4, tenet: Hours are human hours):
 *   - a touch counts at 1.0 for the opp it is logged to (its WhatId);
 *   - with no opp, at its score for each alternate the engine ranked ≥ 0.5 (top 3): a burst spanning two accounts
 *     credits both accounts' opps at their scores, never one of them in full;
 *   - an account-only touch spreads over the account's open opps (1/n each);
 *   - an internal-only meeting (no customer, no account, no opp) credits nothing;
 *   - hours count ONLY on the opp the row is logged to: engagement never adds or splits hours.
 * Pure: the nightly job (src/jobs/handlers/opp-engagement.ts) and the fast path on new signals feed it the same rows.
 */
import { weekStart } from '@/engines/activity/time';

export type TouchKind = 'meeting' | 'slack' | 'mail' | 'doc' | 'session' | 'note' | 'logged';

/** One piece of my work: a meeting, a Slack burst, a mail thread, a doc edit, a session, a note, a logged row. */
export interface EngagementTouch {
  kind: TouchKind;
  /** When (ISO). */
  at: string;
  /** Local day (YYYY-MM-DD) of `at`: the ISO week it counts in. */
  day: string;
  /** The opp it is logged or mapped to (credit 1.0). */
  oppId?: string | null;
  /** The account it is mapped to when no opp is (spread over its open opps). */
  accountId?: string | null;
  /** With no opp: the engine's ranked alternates (only ≥ 0.5 count). */
  candidates?: ReadonlyArray<{ oppId: string; score: number }>;
  /** A customer was in it (external attendees, a shared channel). */
  external?: boolean;
  /** Slack lines in a burst, messages in a thread; default 1. */
  count?: number;
  /** Hours logged (approved or later rows only; `logged` touches): counted on `oppId` alone. */
  hours?: number;
  /** A link for the evidence line (label + url): the last few per opp and week are kept. */
  ref?: { label: string; url?: string | null } | null;
}

export interface EngagementRow {
  oppId: string;
  /** Monday of the ISO week (local). */
  weekStart: string;
  meetings: number;
  externalMeetings: number;
  slackLines: number;
  mailThreads: number;
  docsTouched: number;
  sessions: number;
  notes: number;
  hoursLogged: number;
  /** The credit-weighted touches (1.0 on the logged opp, the score on alternates). */
  credit: number;
  lastTouchAt: string | null;
  sourceCounts: Record<string, number>;
  /** The last few evidence links (newest first). */
  refs: Array<{ label: string; url: string | null; at: string }>;
}

/** Alternates under this score never earn engagement. */
export const MIN_ALTERNATE_SCORE = 0.5;
const REFS_KEPT = 5;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Roll touches up into rows (one per opp × week). `openByAccount`: each account's open opp ids (account-only touches). */
export function rollupEngagement(touches: readonly EngagementTouch[], openByAccount: ReadonlyMap<string, readonly string[]>): EngagementRow[] {
  const rows = new Map<string, EngagementRow>();
  const rowOf = (oppId: string, week: string): EngagementRow => {
    const k = `${oppId}|${week}`;
    let r = rows.get(k);
    if (!r) {
      r = { oppId, weekStart: week, meetings: 0, externalMeetings: 0, slackLines: 0, mailThreads: 0, docsTouched: 0, sessions: 0, notes: 0, hoursLogged: 0, credit: 0, lastTouchAt: null, sourceCounts: {}, refs: [] };
      rows.set(k, r);
    }
    return r;
  };
  for (const t of touches) {
    const shares = creditOf(t, openByAccount);
    if (!shares.length) continue;
    const week = weekStart(t.day);
    const n = Math.max(1, t.count ?? 1);
    for (const { oppId, w } of shares) {
      const r = rowOf(oppId, week);
      r.credit = r2(r.credit + w);
      if (t.kind === 'meeting') {
        r.meetings = r2(r.meetings + w);
        if (t.external) r.externalMeetings = r2(r.externalMeetings + w);
      } else if (t.kind === 'slack') r.slackLines = r2(r.slackLines + n * w);
      else if (t.kind === 'mail') r.mailThreads = r2(r.mailThreads + w);
      else if (t.kind === 'doc') r.docsTouched = r2(r.docsTouched + w);
      else if (t.kind === 'session') r.sessions = r2(r.sessions + w);
      else if (t.kind === 'note') r.notes = r2(r.notes + w);
      // hours: only on the opp the row is logged to (w = 1 there), never on an alternate
      if (t.hours && t.oppId === oppId) r.hoursLogged = r2(r.hoursLogged + t.hours);
      r.sourceCounts[t.kind] = (r.sourceCounts[t.kind] ?? 0) + 1;
      if (!r.lastTouchAt || r.lastTouchAt < t.at) r.lastTouchAt = t.at;
      if (t.ref) {
        r.refs = [...r.refs, { label: t.ref.label.slice(0, 160), url: t.ref.url ?? null, at: t.at }].sort((a, b) => b.at.localeCompare(a.at)).slice(0, REFS_KEPT);
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.oppId.localeCompare(b.oppId));
}

/** Who a touch credits, and how much. */
export function creditOf(t: EngagementTouch, openByAccount: ReadonlyMap<string, readonly string[]>): Array<{ oppId: string; w: number }> {
  if (t.oppId) return [{ oppId: t.oppId, w: 1 }];
  const alts = (t.candidates ?? []).filter((c) => c.score >= MIN_ALTERNATE_SCORE).slice(0, 3);
  if (alts.length) return alts.map((c) => ({ oppId: c.oppId, w: r2(c.score) }));
  if (t.accountId) {
    const open = openByAccount.get(t.accountId) ?? [];
    return open.map((oppId) => ({ oppId, w: r2(1 / open.length) }));
  }
  return [];
}

export interface OppTotals {
  hoursLogged: number;
  meetings: number;
  externalMeetings: number;
  slackLines: number;
  mailThreads: number;
  docsTouched: number;
  sessions: number;
  notes: number;
  credit: number;
  lastTouchAt: string | null;
  refs: EngagementRow['refs'];
}

/** Totals per opp over the weeks from `fromWeek` (inclusive) on. */
export function totalsByOpp(rows: readonly EngagementRow[], fromWeek: string): Map<string, OppTotals> {
  const out = new Map<string, OppTotals>();
  for (const r of rows) {
    if (r.weekStart < fromWeek) continue;
    const t = out.get(r.oppId) ?? { hoursLogged: 0, meetings: 0, externalMeetings: 0, slackLines: 0, mailThreads: 0, docsTouched: 0, sessions: 0, notes: 0, credit: 0, lastTouchAt: null, refs: [] };
    t.hoursLogged = r2(t.hoursLogged + r.hoursLogged);
    t.meetings = r2(t.meetings + r.meetings);
    t.externalMeetings = r2(t.externalMeetings + r.externalMeetings);
    t.slackLines = r2(t.slackLines + r.slackLines);
    t.mailThreads = r2(t.mailThreads + r.mailThreads);
    t.docsTouched = r2(t.docsTouched + r.docsTouched);
    t.sessions = r2(t.sessions + r.sessions);
    t.notes = r2(t.notes + r.notes);
    t.credit = r2(t.credit + r.credit);
    if (r.lastTouchAt && (!t.lastTouchAt || t.lastTouchAt < r.lastTouchAt)) t.lastTouchAt = r.lastTouchAt;
    t.refs = [...t.refs, ...r.refs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, REFS_KEPT);
    out.set(r.oppId, t);
  }
  return out;
}

/** The engine's recency input (last 4 weeks): touches and hours per opp. */
export function engagementSummaries(rows: readonly EngagementRow[], today: string): Record<string, { lastTouchAt: string | null; touches4w: number; hours4w: number }> {
  const from = weekStart(new Date(Date.parse(`${today}T12:00:00Z`) - 27 * 86_400_000).toISOString().slice(0, 10));
  const out: Record<string, { lastTouchAt: string | null; touches4w: number; hours4w: number }> = {};
  for (const [oppId, t] of totalsByOpp(rows, from)) {
    out[oppId] = { lastTouchAt: t.lastTouchAt, touches4w: Math.round(t.meetings + t.mailThreads + t.docsTouched + t.sessions + t.notes + (t.slackLines > 0 ? 1 : 0)), hours4w: t.hoursLogged };
  }
  return out;
}
