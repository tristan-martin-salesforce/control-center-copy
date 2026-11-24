/**
 * One dismissal memory (D-103 (d), AT-13): when a set-aside row comes back. Pure; the three dismissal paths use it,
 * the same on both DataSources: a DC suggestion's Reject (dc.ts), a DC gap's Not needed (src/lib/need-decisions.ts)
 * and a missed-opp finding's Dismiss (`returnedFindings`, below).
 *
 * A dismissal stores a baseline: the hours on the opp, whether I'm on its team, the last call on its account then
 * (`lastCallAt`) and when I set it aside (`at`). The row stays hidden until one of these holds:
 *   team    I join its opp team;
 *   hours   I log 2 h more on it (in that fiscal quarter; DC-30: in a later quarter, 2 h of that quarter's);
 *   call    a call on its account after the dismissal: a customer meeting from my calendar, or an Event read from
 *           Org62 on it (`lastCallsByAccount`). Slack and mail never count.
 * It comes back once: dismissing it again stores a new baseline, past that call. A baseline from before D-103 has
 * no `lastCallAt` (read as null) and no `at`: then only a call after its decision time counts, and with no time at
 * all, calls never bring it back (hours and team still do).
 */
import type { ActivityEntry, MissedOpp, NeedDecision } from '@/contract';

/** A dismissed row comes back once I log this many more hours on its opp. */
export const RESURFACE_HOURS = 2;

export interface DismissalBaseline {
  hours?: number | null;
  onTeam?: boolean | null;
  /** The fiscal quarter `hours` are of (DC-30). */
  quarter?: string | null;
  /** The last call on the account when it was set aside (ISO; null: none). */
  lastCallAt?: string | null;
  /** When it was set aside (ISO). */
  at?: string | null;
}

export interface DismissalFacts {
  hours: number;
  onTeam: boolean;
  quarter?: string | null;
  /** The last call on the account now (ISO; null: none). */
  lastCallAt: string | null;
  /** The account's name, for the sentence. */
  accountName?: string | null;
  /** The user's time zone, for the call's date. */
  timezone?: string;
}

export type ResurfaceWhy = 'hours' | 'team' | 'call';

export interface Resurfaced {
  why: ResurfaceWhy;
  /** In plain words: "You met Acme on Nov 24, after you set this aside". */
  text: string;
}

const time = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

/** Whether a dismissed row comes back now, and why (null: it stays set aside). `decidedAt`: an old baseline's time. */
export function resurfaced(then: DismissalBaseline | null | undefined, now: DismissalFacts, decidedAt?: string | null): Resurfaced | null {
  const b = then ?? {};
  if (now.onTeam && b.onTeam !== true) return { why: 'team', text: 'You joined its opp team after you set this aside' };
  const sameQuarter = !b.quarter || !now.quarter || b.quarter === now.quarter;
  if (now.hours - (sameQuarter ? Number(b.hours ?? 0) : 0) >= RESURFACE_HOURS) return { why: 'hours', text: `You logged ${RESURFACE_HOURS} h more on it after you set this aside` };
  const marks = [time(b.lastCallAt), time(b.at ?? decidedAt)].filter((t) => Number.isFinite(t));
  const call = time(now.lastCallAt);
  if (marks.length && Number.isFinite(call) && call > Math.max(...marks)) {
    const day = new Date(call).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(now.timezone ? { timeZone: now.timezone } : {}) });
    return { why: 'call', text: `You met ${now.accountName || 'the customer'} on ${day}, after you set this aside` };
  }
  return null;
}

/** The baseline a dismissal stores now. */
export function dismissalBaseline(facts: DismissalFacts, at: string): DismissalBaseline {
  return { hours: Math.round(facts.hours * 100) / 100, onTeam: facts.onTeam, ...(facts.quarter ? { quarter: facts.quarter } : {}), lastCallAt: facts.lastCallAt, at };
}

const LIVE = new Set<ActivityEntry['status']>(['needs_input', 'proposed', 'approved', 'synced_to_canvas', 'logged', 'verified', 'verify_failed']);
type CallRow = Pick<ActivityEntry, 'status' | 'internal' | 'sources' | 'fromOrg62' | 'meetingType' | 'oppId' | 'accountName' | 'start' | 'end'>;

/** Whether a time row is a call: a customer meeting from my calendar, or an Event read from Org62. Never Slack or mail. */
export function isCall(e: Pick<CallRow, 'status' | 'internal' | 'sources' | 'fromOrg62' | 'meetingType'>): boolean {
  if (!LIVE.has(e.status) || e.internal) return false;
  if (e.fromOrg62) return true;
  return e.sources.some((s) => s.kind === 'calendar') && e.meetingType !== 'CR';
}

/** The last call on each account (ISO start), ended by `nowIso`: the row's opp's account, else its account name. */
export function lastCallsByAccount(entries: readonly CallRow[], accounts: ReadonlyArray<{ id: string; name: string }>, opps: ReadonlyArray<{ id: string; accountId?: string | null }>, nowIso: string): Map<string, string> {
  const byName = new Map(accounts.map((a) => [a.name.trim().toLowerCase(), a.id] as const));
  const oppAccount = new Map(opps.map((o) => [o.id, o.accountId || null] as const));
  const now = Date.parse(nowIso);
  const out = new Map<string, string>();
  for (const e of entries) {
    if (!isCall(e) || Date.parse(e.end) > now) continue;
    const acct = (e.oppId ? oppAccount.get(e.oppId) : null) ?? (e.accountName ? byName.get(e.accountName.trim().toLowerCase()) : undefined);
    if (!acct) continue;
    const prev = out.get(acct);
    if (!prev || Date.parse(e.start) > Date.parse(prev)) out.set(acct, e.start);
  }
  return out;
}

/** The need-decision rule a missed-opp Dismiss is remembered under (subject: the finding id). */
export const MISSED_RULE = 'missed_opp';

/** What a missed-opp finding's dismissal is compared against: its opp's facts and its account's last call. */
export interface FindingWorld {
  opps: ReadonlyArray<{ id: string; accountId?: string | null; isMine: boolean; hoursQtd?: number }>;
  accounts: ReadonlyArray<{ id: string; name: string }>;
  calls: ReadonlyMap<string, string>;
  quarter?: string | null;
  timezone?: string;
}

/** The facts for one finding now (its opp, else its account by name). */
export function findingFacts(m: Pick<MissedOpp, 'oppId' | 'accountName'>, w: FindingWorld): DismissalFacts {
  const o = m.oppId ? w.opps.find((x) => x.id === m.oppId) : undefined;
  const acct = o?.accountId || w.accounts.find((a) => a.name.trim().toLowerCase() === m.accountName.trim().toLowerCase())?.id || null;
  return { hours: o?.hoursQtd ?? 0, onTeam: !!o?.isMine, quarter: w.quarter ?? null, lastCallAt: acct ? (w.calls.get(acct) ?? null) : null, accountName: m.accountName, timezone: w.timezone };
}

/**
 * Missed-opp findings as shown: a dismissed one whose dismissal (a `missed_opp` decision) is outweighed comes back
 * once, status `new`, its reason first in its evidence. A finding dismissed before D-103 has no decision: it stays.
 */
export function returnedFindings(missed: readonly MissedOpp[], decisions: readonly NeedDecision[], w: FindingWorld): MissedOpp[] {
  const by = new Map(decisions.filter((d) => d.rule === MISSED_RULE).map((d) => [d.subjectId, d] as const));
  return missed.map((m) => {
    const d = m.status === 'dismissed' ? by.get(m.id) : undefined;
    const back = d ? resurfaced(d.baseline as DismissalBaseline, findingFacts(m, w), d.decidedAt) : null;
    return back ? { ...m, status: 'new' as const, dismissReason: null, evidence: [back.text, ...m.evidence] } : m;
  });
}
