/**
 * The canvas pre-fill through the attribution engine (src/engines/attribution). Two places fill a logging canvas's
 * opportunity before you see it:
 *
 *   Time rows       the row's suggestion (src/engines/attribution/row.ts via src/lib/time-suggest.ts): what the Needs you
 *                   row offers and what an accepted row carries onto the canvas as its WhatId;
 *   use-case rows   D-67 / D-70: a VDP use case whose opp is not settled (its VDP lists none, its account has several
 *                   open opps with my 100% DC) asks which opp it goes on. The engine ranks those opps here: the use case's
 *                   own words against the opps' names, the VDP's account, and (when the caller has it) my engagement;
 *                   the first is the pre-fill, one click away. Never applied for you (D-70: never a guess), and no new
 *                   VDP or Org62 write: the choice rides the next canvas as before.
 *   suggested       a use case the app noticed (a use-case candidate you accepted) carries a `suggested` marker on its
 *                   canvas question, with the opp you accepted it on as the pick_opp pre-fill (markSuggested).
 * Pure.
 */
import type { UseCaseQuestion } from '@/contract/landings';
import type { UcOpp } from '@/engines/activity/use-cases';
import { attribute, type EngagementSummary, type World } from '@/engines/attribution';
import { sameUseCase } from '@/engines/use-cases/similar';

export interface UseCasePrefill {
  /** The opps, the engine's best first (ties keep the VDP's own order). */
  ordered: UcOpp[];
  /** The best, when the engine prefers one (its confidence and why); null when it can't tell them apart. */
  suggested: { org62Id: string; confidence: number; why: string } | null;
}

export function rankUseCaseOpps(uc: { title: string; companyName?: string | null; accountId: string | null }, opps: readonly UcOpp[], extras: { engagement?: Record<string, EngagementSummary>; today?: string } = {}): UseCasePrefill {
  if (opps.length < 2) return { ordered: [...opps], suggested: opps[0] ? { org62Id: opps[0].org62Id, confidence: 1, why: 'its only opportunity' } : null };
  const accounts = [...new Set(opps.map((o) => o.accountId).filter((x): x is string => !!x))].map((id) => ({ id, name: id === uc.accountId ? (uc.companyName ?? id) : id }));
  const world: World = {
    accounts,
    opps: opps.map((o) => ({ id: o.id, accountId: o.accountId, name: o.name, isOpen: o.isOpen, isMine: true, myDc: o.dcSplit === 100, closeDate: o.closeDate })),
    engagement: extras.engagement ?? {},
    today: extras.today ?? '9999-12-31',
    // the use case's words name opps, never accounts (its account is the VDP's)
    matchText: () => [],
  };
  const r = attribute({ kind: 'manual', text: uc.title, related: uc.accountId ? { accountIds: [uc.accountId], via: 'the VDP' } : null }, world, { oppsOnly: true, limit: opps.length });
  const score = new Map(r.candidates.map((c) => [c.oppId, c] as const));
  const ordered = opps.map((o, i) => ({ o, i, c: score.get(o.id)?.confidence ?? 0 })).sort((a, b) => b.c - a.c || a.i - b.i).map((x) => x.o);
  const top = score.get(ordered[0]!.id);
  const second = score.get(ordered[1]!.id)?.confidence ?? 0;
  const lead = top?.why.find((w) => w.code === 'keyword' || w.code === 'engagement');
  return { ordered, suggested: top && lead && top.confidence - second >= 0.05 ? { org62Id: ordered[0]!.org62Id, confidence: top.confidence, why: lead.text } : null };
}

/** An accepted use-case candidate as the canvas question reads it (src/engines/use-cases). */
export interface SuggestedCandidate {
  id: string;
  title: string;
  accountId: string | null;
  /** The opp it was accepted on (Org62 id), when known. */
  oppOrg62Id: string | null;
  /** Where it was noticed ("Saltmere weekly sync"). */
  from: string | null;
}

/**
 * The `suggested` marker on a use case's canvas question: the app noticed this use case (a candidate you accepted with
 * the same title on the same account), and for pick_opp the opp you accepted it on when it is one of the question's
 * opps. A pre-fill, never applied for you (D-70); a question with no matching candidate is returned as it is.
 */
export function markSuggested<Q extends UseCaseQuestion | null>(q: Q, uc: { title: string; accountId: string | null }, candidates: readonly SuggestedCandidate[]): Q {
  if (!q) return q;
  const c = candidates.find((x) => (!x.accountId || !uc.accountId || x.accountId === uc.accountId) && sameUseCase(x.title, uc.title).same);
  if (!c) return q;
  const org62Id = q.code === 'pick_opp' && c.oppOrg62Id ? (q.opps.find((o) => o.org62Id.slice(0, 15) === c.oppOrg62Id!.slice(0, 15))?.org62Id ?? null) : null;
  return { ...q, suggested: { candidateId: c.id, org62Id, why: `Suggested by the app${c.from ? ` from ${c.from}` : ''}${org62Id ? ': the opp you accepted it on' : ''}` } };
}
