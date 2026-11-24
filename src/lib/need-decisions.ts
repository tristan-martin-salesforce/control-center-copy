/**
 * Needs-you decisions (src/contract/needs.ts): whether a stored Snooze or Not needed still hides a row. Pure, shared
 * by the Deals needs (src/engines/deals/needs.ts), Home ▸ Log & fix (src/engines/home/build.ts) and both
 * DataSources, so the mock and Postgres hide exactly the same rows.
 *
 *   snooze       hides until `until`, then the row is back by itself.
 *   not_needed   hides until something material changes, as the rule says (`resurfaced`):
 *                dc_gap        the one dismissal rule (src/engines/attribution/resurface.ts, D-103 (d)): I join the opp's
 *                              team, I log ≥ 2 h more on it (DC-30: per fiscal quarter), or once, a call on its
 *                              account after I said Not needed (`lastCallAt`);
 *                deals_ahead   the account's next close date is another date;
 *                home:<rule>   a subject the row didn't have then (a new missed opp, a new deal role to set);
 *                anything else stays set aside until Undo or "Bring back" (clearNeedDecision).
 */
import type { NeedBaseline, NeedDecision } from '@/contract';
import { RESURFACE_HOURS, resurfaced as dismissalResurfaced } from '@/engines/attribution/resurface';

/** A Not needed DC gap comes back once I log this many more hours on the opp. */
export const DC_GAP_RESURFACE_HOURS = RESURFACE_HOURS;

/** The key a decision is stored and looked up by. */
export const needKey = (rule: string, subjectId: string) => `${rule}|${subjectId}`;

/** Subject lists in a baseline ("ids": "a,b,c"). */
export const subjectList = (ids: readonly string[]) => [...new Set(ids)].sort().join(',');
const listOf = (v: NeedBaseline[string] | undefined) => (typeof v === 'string' && v ? v.split(',') : []);

/** Whether a Not needed row has changed enough to come back (see the module comment). */
export function resurfaced(rule: string, then: NeedBaseline, now: NeedBaseline, decidedAt?: string | null): boolean {
  if (rule === 'dc_gap') return !!dcGapResurfaced(then, now, decidedAt);
  if (rule === 'deals_ahead') return (now.nextCloseDate ?? null) !== (then.nextCloseDate ?? null);
  if (rule.startsWith('home:')) {
    const before = new Set(listOf(then.subjects));
    return listOf(now.subjects).some((s) => !before.has(s));
  }
  return false;
}

/** Whether this decision still hides its row at `nowIso`, given the row's facts now. */
export function stillHides(d: Pick<NeedDecision, 'rule' | 'kind' | 'until' | 'baseline'> & Partial<Pick<NeedDecision, 'decidedAt'>>, nowIso: string, current: NeedBaseline = {}): boolean {
  if (d.kind === 'snooze') return !!d.until && Date.parse(d.until) > Date.parse(nowIso);
  return !resurfaced(d.rule, d.baseline ?? {}, current, d.decidedAt);
}

/** Decisions by key, for lookups while a rule builds its rows. */
export function decisionIndex(decisions: readonly NeedDecision[] | undefined): ReadonlyMap<string, NeedDecision> {
  return new Map((decisions ?? []).map((d) => [needKey(d.rule, d.subjectId), d] as const));
}

/** Whether (rule, subject) is set aside right now. */
export function isSetAside(index: ReadonlyMap<string, NeedDecision>, rule: string, subjectId: string, nowIso: string, current: NeedBaseline = {}): boolean {
  const d = index.get(needKey(rule, subjectId));
  return !!d && stillHides(d, nowIso, current);
}

/** The order the decisions list is returned in, the same on both DataSources: newest first, then by key. */
export const needDecisionOrder = (a: NeedDecision, b: NeedDecision) => b.decidedAt.localeCompare(a.decidedAt) || needKey(a.rule, a.subjectId).localeCompare(needKey(b.rule, b.subjectId));

const str = (v: NeedBaseline[string] | undefined) => (typeof v === 'string' && v ? v : null);

/** A DC gap's Not needed against the opp now (the shared rule; why it came back, or null). */
export function dcGapResurfaced(then: NeedBaseline, now: NeedBaseline, decidedAt?: string | null) {
  return dismissalResurfaced(
    { hours: Number(then.hoursQtd ?? 0), onTeam: then.onTeam === true, quarter: str(then.quarter), lastCallAt: str(then.lastCallAt), at: str(then.at) },
    { hours: Number(now.hoursQtd ?? 0), onTeam: now.onTeam === true, quarter: str(now.quarter), lastCallAt: str(now.lastCallAt), accountName: str(now.accountName), timezone: str(now.timezone) ?? undefined },
    decidedAt,
  );
}
