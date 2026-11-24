/**
 * spend_ask: the spend governor's raised hands (H-5; `HealthPayload.spendAsks`): background work that passed its
 * estimate and waits for your answer, the same question Health ▸ needs you asks, with the same three answers
 * (POST /spend/holds/:id/answer): Allow $X more · Allow for today · Stop. Answering is yours alone (the route is deny
 * for the Assistant), and it is not undoable: a run that took the answer has continued.
 */
import type { NeedRow, SpendAsk } from '@/contract';
import { callVerb, needRow, sinceOf } from '../row';
import type { NeedProvider, NeedsContext } from '../types';
import { KIND_URGENCY } from '../urgency';

const usd = (n: number) => `$${n.toFixed(2)}`;

const WHAT: Record<SpendAsk['scope'], string> = {
  chat_message: 'An Assistant answer',
  scan_run: 'A scan',
  settle_pass: 'The done check',
  relay: 'A source read',
  research: 'A research run',
  feedback: 'The feedback report',
  job: 'A background job',
};

function rowOf(a: SpendAsk, ctx: NeedsContext): NeedRow {
  const p = { id: a.holdId };
  const more = Math.max(0.01, Math.round(a.moreUsd * 100) / 100);
  return needRow({
    kind: 'spend_ask',
    sourceId: a.holdId,
    title: `${WHAT[a.scope]} is over its estimate`,
    why: a.question || `Used ${usd(a.spentUsd)} of ${usd(a.heldUsd)}; allow ${usd(more)} more?`,
    verbs: [
      callVerb({ id: 'allow', label: `Allow ${usd(more)} more`, kbd: 'a', primary: true, route: 'answerSpendHold', params: p, body: { answer: 'approve', usd: more } }),
      callVerb({ id: 'allow_today', label: 'Allow for today', route: 'answerSpendHold', params: p, body: { answer: 'today' } }),
      callVerb({ id: 'stop', label: 'Stop', kbd: 'x', route: 'answerSpendHold', params: p, body: { answer: 'deny' } }),
    ],
    groupKey: 'admin',
    urgency: KIND_URGENCY.spend_ask,
    since: sinceOf([a.askedAt], ctx.nowMs),
    estimateMin: 1,
  });
}

export const spendAskProvider: NeedProvider = {
  kind: 'spend_ask',
  run: (ctx) => (ctx.health?.spendAsks ?? []).map((a) => rowOf(a, ctx)),
};
