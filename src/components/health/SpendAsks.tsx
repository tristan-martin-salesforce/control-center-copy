'use client';
/**
 * Health ▸ needs you, one row kind (spend governor, H-5): a run passed its estimate and waits for you. The plain
 * question, then Allow $Z more (it is re-queued, or continues if it waits in this process) · Allow for today (no more
 * asks on it today; today's cap moves up by its hold if needed) · Stop (settled as denied; what it did stays).
 * Answers go through the contract: POST /spend/holds/:id/answer.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SpendAsk } from '@/contract';
import { ApiError, api } from '@/client/api';
import { toast } from '@/client/toast';
import { Button } from '@/ui';

type Answer = { ask: SpendAsk; answer: 'approve' | 'today' | 'deny' };

export function SpendAskRows({ asks }: { asks: SpendAsk[] }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({ ask, answer }: Answer) => api('answerSpendHold', { params: { id: ask.holdId }, body: answer === 'approve' ? { answer, usd: ask.moreUsd } : { answer } }),
    onSuccess: (_r, { ask, answer }) =>
      toast({ key: `spend-${ask.holdId}`, tone: 'info', title: answer === 'approve' ? `Allowed $${ask.moreUsd.toFixed(2)} more` : answer === 'today' ? 'Allowed for today' : 'Stopped', body: answer === 'deny' ? 'What it already did stays.' : 'It picks up where it paused.' }),
    onError: (e: ApiError, { ask }) => toast({ key: `spend-${ask.holdId}`, tone: 'error', title: 'Couldn’t send the answer', body: e.message, durationMs: null }),
    onSettled: () => {
      for (const t of ['health', 'jobs', 'event_log']) void qc.invalidateQueries({ queryKey: [t] });
    },
  });
  const busy = (a: SpendAsk, k: Answer['answer']) => m.isPending && m.variables?.ask.holdId === a.holdId && m.variables.answer === k;
  if (!asks.length) return null;
  return (
    <>
      {asks.map((a) => (
        <li key={a.holdId} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-body" data-health-spend-ask={a.holdId}>
          <span className="font-bold text-warning-700">
            <span aria-hidden>▲ </span>
            {a.question}
          </span>
          <span className="flex flex-wrap items-center gap-1">
            <Button variant="secondary" size="xs" loading={busy(a, 'approve')} disabled={m.isPending} onClick={() => m.mutate({ ask: a, answer: 'approve' })} data-spend-allow={a.moreUsd}>
              Allow ${a.moreUsd.toFixed(2)} more
            </Button>
            <Button variant="quiet" size="xs" loading={busy(a, 'today')} disabled={m.isPending} onClick={() => m.mutate({ ask: a, answer: 'today' })} data-spend-today>
              Allow for today
            </Button>
            <Button variant="quiet" size="xs" loading={busy(a, 'deny')} disabled={m.isPending} onClick={() => m.mutate({ ask: a, answer: 'deny' })} data-spend-stop>
              Stop
            </Button>
          </span>
        </li>
      ))}
    </>
  );
}
