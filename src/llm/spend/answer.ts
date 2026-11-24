/**
 * Answering a spend ask (Health's needs-you row, the Assistant card): the governor records the answer, then a run
 * waiting in this process takes it and continues (the Assistant's turn), or the paused job is re-queued now with the
 * approved amount (a scan in the worker) or cancelled on Stop. Both DataSources call this.
 */
import type { SpendGovernor } from './governor';
import type { Hold, SpendAnswer } from './types';
import { deliverAnswer } from './waiters';

export type AnswerRequest = { answer: 'approve' | 'today' | 'deny'; usd?: number };

export function spendAnswerOf(r: AnswerRequest): SpendAnswer {
  if (r.answer === 'approve') return { kind: 'approve', usd: Math.max(0.01, r.usd ?? 0.01) };
  return { kind: r.answer };
}

export async function answerHold(gov: SpendGovernor, holdId: string, req: AnswerRequest, o: { requeue?: (h: Hold) => Promise<void>; cancel?: (h: Hold) => Promise<void> } = {}): Promise<{ hold: Hold; resumed: boolean } | null> {
  const a = spendAnswerOf(req);
  const hold = await gov.answer(holdId, a);
  if (!hold) return null;
  const resumed = deliverAnswer(holdId, a);
  if (!resumed) {
    if (a.kind === 'deny') await o.cancel?.(hold);
    else await o.requeue?.(hold);
  }
  return { hold, resumed };
}
