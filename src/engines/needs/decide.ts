/**
 * POST /needs/:id/decide, planned (pure): which existing route a row's verb runs, with the payload the page already
 * sends. The server dispatches the plan to that DataSource method, so a decision through the queue is exactly the
 * page's own (the same audit entry, the same Undo). Navigation verbs (Review, Open, How to fix) have no call: the
 * page navigates, and deciding one is refused.
 */
import type { DecideNeedRowRequest, NeedDispatchRoute, NeedRow, NeedVerb } from '@/contract';

export interface NeedPlan {
  verb: NeedVerb;
  route: NeedDispatchRoute;
  input: { params: Record<string, string>; body: Record<string, unknown> };
}

export type NeedPlanResult = { ok: true; plan: NeedPlan } | { ok: false; code: 'validation' | 'not_found'; message: string };

export function planNeedDecision(row: NeedRow, req: DecideNeedRowRequest): NeedPlanResult {
  const v = row.verbs.find((x) => x.id === req.verb);
  if (!v) return { ok: false, code: 'validation', message: `"${row.title}" has no ${req.verb} (it offers ${row.verbs.map((x) => x.id).join(', ')})` };
  if (!v.call) return { ok: false, code: 'validation', message: `${v.label} opens ${v.href ?? 'its page'}; it is not decided here` };
  const body: Record<string, unknown> = { ...v.call.body };
  if (req.verb === 'answer') {
    const pick = req.choiceId ?? (typeof body.choiceId === 'string' ? body.choiceId : undefined);
    if (!pick || !(v.choices ?? []).some((c) => c.id === pick)) return { ok: false, code: 'validation', message: 'Pick one of the offered answers' };
    body.choiceId = pick;
  }
  if (req.reason && (v.call.route === 'dismissTriage' || v.call.route === 'rejectDraft')) body.reason = req.reason;
  if (req.until && v.id === 'snooze' && (v.call.route === 'decideNeed' || v.call.route === 'itemAction')) body.until = req.until;
  return { ok: true, plan: { verb: v, route: v.call.route, input: { params: { ...v.call.params }, body } } };
}
