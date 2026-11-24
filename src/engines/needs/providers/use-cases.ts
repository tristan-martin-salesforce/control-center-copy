/**
 * use_case_candidate: one row per use case the app noticed and waits on you (GET /use-cases/candidates: suggested or
 * edited; src/engines/use-cases), with the verbs Activity's list runs: Add (POST /use-cases/candidates/:id accept:
 * drafts the VDP create_use_case Outbox item and puts an Org62 row on the next logging canvas; nothing leaves until
 * you approve and Apply them), Edit (on Activity, where the opp picker and the fields are) and Not a use case. One the
 * engine is unsure of the opp for asks for the pick first, so its primary verb is Edit.
 */
import type { NeedRow, UseCaseCandidate } from '@/contract';
import { callVerb, isSnoozed, needRow, sinceOf, verb } from '../row';
import type { NeedProvider, NeedsContext } from '../types';
import { KIND_URGENCY } from '../urgency';

const HREF = '/activity?view=usecases';
const WAITING = new Set<UseCaseCandidate['status']>(['suggested', 'edited']);

function rowOf(c: UseCaseCandidate, ctx: NeedsContext): NeedRow {
  const p = { id: c.id };
  const pick = c.needsPick || !c.oppId;
  const ev = c.evidence.find((e) => !!e.url);
  return needRow({
    kind: 'use_case_candidate',
    sourceId: c.id,
    title: `Add use case: ${c.title}`,
    why: [c.oppName ? `on ${c.oppName}` : null, pick ? 'pick the opportunity first' : null, c.problem || null].filter(Boolean).join(' · '),
    account: c.accountName ? { id: c.accountId, label: c.accountName, href: c.accountId ? `/deals/${c.accountId}` : null } : null,
    opp: c.oppName ? { id: c.oppId, label: c.oppName, href: null } : null,
    verbs: [
      ...(pick ? [] : [callVerb({ id: 'accept', label: 'Add', kbd: 'a', primary: true, route: 'decideUseCaseCandidate', params: p, body: { decision: 'accept' }, undoable: true, feature: 'vdp' })]),
      verb({ id: 'edit', label: pick ? 'Pick the opp' : 'Edit', kbd: 'e', primary: pick, href: HREF, feature: 'vdp' }),
      callVerb({ id: 'reject', label: 'Not a use case', kbd: 'x', route: 'decideUseCaseCandidate', params: p, body: { decision: 'reject', reason: 'not_use_case' }, undoable: true, feature: 'vdp' }),
    ],
    groupKey: 'deal',
    urgency: KIND_URGENCY.use_case_candidate,
    since: sinceOf(c.evidence.map((e) => e.at), ctx.nowMs),
    source: ev?.url ? { label: ev.label, url: ev.url } : null,
    estimateMin: 2,
    confidence: c.confidence >= 0.8 ? 'sure' : c.confidence >= 0.5 ? 'likely' : 'guess',
  });
}

export const useCaseCandidateProvider: NeedProvider = {
  kind: 'use_case_candidate',
  feature: 'vdp',
  run(ctx) {
    const u = ctx.useCases;
    if (!u?.enabled) return [];
    return u.candidates.filter((c) => WAITING.has(c.status) && !isSnoozed(ctx, 'use_case_candidate', c.id)).map((c) => rowOf(c, ctx));
  },
};
