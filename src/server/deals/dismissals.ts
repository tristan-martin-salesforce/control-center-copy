/**
 * Missed-opp dismissals with memory (D-103 (d), B-118), shared by both DataSources so the mock and Postgres show
 * the same findings. A Dismiss keeps the finding `dismissed` and stores a `missed_opp` need decision whose baseline
 * the one dismissal rule (src/engines/attribution/resurface.ts) is compared against: the finding comes back once on
 * 2 h more logged on its opp, on joining its team, or on a call on its account after the Dismiss.
 */
import type { ActivityEntry, MissedOpp, NeedBaseline, NeedDecision } from '@/contract';
import { dismissalBaseline, findingFacts, lastCallsByAccount, MISSED_RULE, returnedFindings, type FindingWorld } from '@/engines/attribution/resurface';
import { sfrQuarterOfDay } from '@/engines/forecast/time';
import { dayOf } from '@/lib/deals-format';

export interface MissedSource {
  now: Date;
  timezone: string;
  opps: FindingWorld['opps'];
  accounts: FindingWorld['accounts'];
  activity: readonly ActivityEntry[];
  decisions: readonly NeedDecision[];
}

/** The world a finding's dismissal is compared against now. */
export function missedWorld(s: MissedSource): FindingWorld {
  const nowIso = s.now.toISOString();
  return { opps: s.opps, accounts: s.accounts, calls: lastCallsByAccount(s.activity, s.accounts, s.opps, nowIso), quarter: sfrQuarterOfDay(dayOf(s.now, s.timezone || undefined)), timezone: s.timezone || undefined };
}

/** The findings as shown: a dismissed one whose dismissal is outweighed is back (`new`, its reason first). */
export function missedShown(missed: readonly MissedOpp[], s: MissedSource): MissedOpp[] {
  return returnedFindings(missed, s.decisions, missedWorld(s));
}

/** The decision a missed-opp Dismiss stores beside the finding (its facts now: hours, team, the last call). */
export function missedDismissal(m: MissedOpp, reason: string, s: MissedSource): NeedDecision {
  const at = s.now.toISOString();
  return { rule: MISSED_RULE, subjectId: m.id, kind: 'not_needed', until: null, reason, label: m.oppName, baseline: dismissalBaseline(findingFacts(m, missedWorld(s)), at) as NeedBaseline, decidedAt: at };
}
