'use client';
/**
 * The raise-hand card (spend governor, H-5; 05 §6.3, §8): the answer passed its estimate and waits at its next step.
 * A neutral question, never a red error: "This answer has used $0.27 of its $0.25 estimate; allow $0.13 more?"
 * Allow $Z more lets the waiting turn continue (nothing already done runs again); Stop wraps it up from what it has.
 * The answer goes through the contract (POST /chat/spend-answer). The richer plan card is Assistant v2's.
 */
import { useState } from 'react';
import { api } from '@/client/api';
import type { ChatSpendAskView } from '@/client/chat';
import { Button } from '@/ui';

export function SpendAskCard({ ask, onFallback }: { ask: ChatSpendAskView; onFallback?: (usd: number) => void }) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const answer = async (kind: 'approve' | 'deny') => {
    setBusy(kind);
    setFailed(false);
    try {
      const r = await api('chatSpendAnswer', { body: kind === 'approve' ? { holdId: ask.holdId, answer: 'approve', usd: ask.moreUsd } : { holdId: ask.holdId, answer: 'deny' } });
      // The turn stopped listening (closed tab, time out): Allow more continues the stopped answer instead.
      if (!r.resumed && kind === 'approve') onFallback?.(ask.moreUsd);
      setDone(kind === 'approve' ? `Allowed $${ask.moreUsd.toFixed(2)} more` : 'Stopping here: it answers from what it has');
    } catch {
      setFailed(true);
      setBusy(null);
      return;
    }
    setBusy(null);
  };
  return (
    <div role="group" aria-label="Spend question" className="mt-2 flex max-w-[68ch] flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface-muted px-4 py-3" data-spend-ask={ask.holdId}>
      <p className="min-w-0 flex-1 text-body text-fg">
        {ask.question}
        {failed ? <span className="block text-caption text-muted">Could not send the answer. Try again.</span> : null}
      </p>
      {done ? (
        <span className="text-caption text-muted" data-spend-answered>
          {done}
        </span>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" loading={busy === 'approve'} disabled={!!busy} onClick={() => void answer('approve')} data-spend-allow={ask.moreUsd}>
            Allow ${ask.moreUsd.toFixed(2)} more
          </Button>
          <Button variant="quiet" size="sm" loading={busy === 'deny'} disabled={!!busy} onClick={() => void answer('deny')} data-spend-stop>
            Stop
          </Button>
        </div>
      )}
    </div>
  );
}
