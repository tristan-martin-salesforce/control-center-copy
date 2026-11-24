/**
 * Deals needs and needs-you decisions, shared by both DataSources (the mock and Postgres answer the same):
 *  - `dealsNeedsFor`: getDeals' and getAccount's `needs` (src/engines/deals/needs.ts) for the persona's Deals features;
 *  - `planNeedDecisions`: what a decideNeed stores (one decision per subject; a DC gap's baseline read from the opp,
 *    so a Not needed comes back only on a material change: I join the team, or log 2 h more on it);
 *  - `needDecisionLabel`: the change set's words.
 */
import { SNOOZE_MS, type AccountRow, type DcRequest, type DealsNeed, type DecideNeedRequest, type MissedOpp, type NeedDecision, type Opportunity } from '@/contract';
import { dayOf } from '@/lib/deals-format';
import { dcGapBaselines, dealsFeaturesOf, dealsNeeds, type GapOpp } from '@/engines/deals/needs';
import type { ResolvedPersona } from '@/personas/types';
import { liveDcRequest } from '@/server/deals/dc-requests';
import { AppError } from '@/server/errors';

export interface DealsNeedsSource {
  now: Date;
  timezone: string;
  persona: ResolvedPersona;
  accounts: readonly AccountRow[];
  opps: readonly GapOpp[];
  missed: readonly MissedOpp[];
  /**
   * Every DC request (DC-12: only a live one, in flight, means the opp is handled; DC-06: one handed off to Slackbot
   * and not in Org62 yet is Chase). A bare {oppId, status} is in flight unless withdrawn or confirmed.
   */
  requests: ReadonlyArray<Pick<DcRequest, 'oppId' | 'status'> & Partial<Pick<DcRequest, 'stage' | 'oppName' | 'updatedAt'>>>;
  decisions: readonly NeedDecision[];
  /** D-103 (d): the last call on each account (`lastCallsByAccount`). */
  calls?: ReadonlyMap<string, string>;
  /** DC-32: open opps a live VDP I'm on links (the VDP mirror; `vdpOppIdsOf`). */
  vdpOppIds?: ReadonlySet<string>;
}

/** `dcAssigned` = I hold a DC the scans read (`myDc`) or Org62 says I hold one: never `myDc` without the flag. */
export const withMyDcFlag = <T extends Pick<Opportunity, 'dcAssigned' | 'myDc'>>(o: T): T => (o.myDc && !o.dcAssigned ? { ...o, dcAssigned: true } : o);

export function dealsNeedsFor(s: DealsNeedsSource): DealsNeed[] {
  return dealsNeeds({
    accounts: s.accounts,
    opps: s.opps,
    missed: s.missed,
    requestedOppIds: new Set(s.requests.filter((r) => liveDcRequest({ status: r.status as DcRequest['status'] })).map((r) => r.oppId)),
    vdpOppIds: s.vdpOppIds,
    chase: s.requests.filter((r) => r.stage === 'handed_off' && liveDcRequest({ status: r.status as DcRequest['status'] })).map((r) => ({ oppId: r.oppId, oppName: r.oppName ?? r.oppId, since: r.updatedAt ?? s.now.toISOString() })),
    decisions: s.decisions,
    calls: s.calls,
    timezone: s.timezone || undefined,
    today: dayOf(s.now, s.timezone || undefined),
    now: s.now.toISOString(),
    features: dealsFeaturesOf(s.persona),
  });
}

/** The decisions a decideNeed stores, one per subject. A DC gap's subjects must be opps the app has. */
export function planNeedDecisions(b: DecideNeedRequest, now: Date, opps: readonly GapOpp[], timezone?: string, calls?: ReadonlyMap<string, string>): NeedDecision[] {
  if (b.kind === 'snooze' && b.until && Date.parse(b.until) <= now.getTime()) throw new AppError('validation', 'A snooze ends in the future');
  // DC-30: the baseline names the fiscal quarter its hours are of
  const baselines = b.rule === 'dc_gap' ? dcGapBaselines(opps, b.subjectIds, dayOf(now, timezone || undefined), calls, calls ? now.toISOString() : undefined) : null;
  if (baselines) for (const id of b.subjectIds) if (!opps.some((o) => o.id === id)) throw new AppError('not_found', `No opportunity "${id}" in the app: a DC gap is set aside per opp (getDeals needs[].opps[].oppId)`);
  const at = now.toISOString();
  return [...new Set(b.subjectIds)].map((subjectId) => ({
    rule: b.rule,
    subjectId,
    kind: b.kind,
    until: b.kind === 'snooze' ? (b.until ?? new Date(now.getTime() + SNOOZE_MS).toISOString()) : null,
    reason: b.kind === 'not_needed' ? (b.reason ?? null) : null,
    label: (b.rule === 'dc_gap' ? (opps.find((o) => o.id === subjectId)?.name ?? b.label) : b.label) ?? null,
    baseline: baselines?.get(subjectId) ?? b.baseline ?? {},
    decidedAt: at,
  }));
}

/** "Not needed (Not my deal): CUSTOMER_1 – Renewal" / "Snoozed to 18 Nov: …" (the change set's summary). */
export function needDecisionLabel(ds: readonly NeedDecision[]): string {
  const d = ds[0];
  if (!d) return 'Needs: nothing set aside';
  const what = ds.map((x) => x.label ?? x.subjectId).join(', ');
  return (d.kind === 'snooze' ? `Snoozed to ${d.until?.slice(0, 10)}: ${what}` : `Not needed (${d.reason}): ${what}`).slice(0, 200);
}

/**
 * DC-32: the open opps a live VDP I'm on links (by any of my emails; an archived or gone VDP never counts), from the
 * VDP mirror's snapshots and the links it made (`linkVdp`). Both DataSources call it with their own mirror.
 */
export function vdpOppIdsOf(vdps: ReadonlyArray<{ linkedOppIds: readonly string[]; onIt: boolean; live: boolean }>, openOppIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const v of vdps) if (v.onIt && v.live) for (const id of v.linkedOppIds) if (openOppIds.has(id)) out.add(id);
  return out;
}
