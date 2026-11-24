'use client';
/**
 * The plan card (Assistant v2, lane 05 §6.2, §8): the model's own plan, priced by the spend governor from history,
 * shown before a research-class run. "Plan · 3 steps · ~$0.12 (up to $0.30)" with Run / Edit / Skip while the turn
 * waits on it (POST /chat/plan-answer); once answered (or for a plan that only says what it will do) it is one quiet
 * line with its steps folded. A neutral card, never an error. Tailwind (H-10b), kit Button.
 */
import { useState } from 'react';
import { api } from '@/client/api';
import type { ChatPlan } from '@/contract';
import { Button } from '@/ui';

const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

const STATUS: Record<ChatPlan['status'], string> = {
  waiting: 'Waiting for you',
  run: 'Running it',
  skipped: 'Not run',
  edited: 'Re-planning from your note',
  info: 'Plan',
};

export function planLine(plan: ChatPlan): string {
  const n = plan.steps.length;
  return `${n} step${n === 1 ? '' : 's'} · ~${usd(plan.estimate.p50)} (up to ${usd(plan.estimate.p90)})`;
}

export function PlanCard({ plan, live }: { plan: ChatPlan; /** The turn is still running (the answer can reach it). */ live: boolean }) {
  const [busy, setBusy] = useState<'run' | 'skip' | 'edit' | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(plan.status === 'waiting');
  const waiting = plan.status === 'waiting' && live && !sent;

  const answer = async (a: 'run' | 'skip' | 'edit') => {
    setBusy(a);
    setFailed(null);
    try {
      const r = await api('chatPlanAnswer', { body: { planId: plan.id, answer: a, ...(a === 'edit' && note.trim() ? { note: note.trim() } : {}) } });
      if (!r.delivered) setFailed('This answer has moved on; ask again to plan it anew.');
      else setSent(a === 'run' ? 'Running it' : a === 'skip' ? 'Skipped: it answers from what it has' : 'Re-planning from your note');
    } catch {
      setFailed('Could not send the answer. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div role="group" aria-label="Plan" className="mt-2 max-w-[68ch] rounded-lg border border-line bg-surface-muted px-4 py-3" data-plan={plan.id} data-plan-status={sent ? 'answered' : plan.status}>
      <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-plan-toggle>
        <span className="text-caption font-medium text-fg">{sent ?? STATUS[plan.status]}</span>
        <span className="text-caption tabular-nums text-muted" data-plan-estimate>
          · {planLine(plan)}
          {plan.estimate.basis === 'default' ? ' · estimate' : ''}
        </span>
      </button>
      {open ? (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-body text-fg" data-plan-steps>
          {plan.steps.map((s, i) => (
            <li key={i}>
              {s.what}
              <span className="text-caption text-muted">
                {' '}
                · {s.run ?? s.tool}
                {s.estUsd ? ` · ${usd(s.estUsd)}` : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {plan.why && open ? <p className="mt-2 text-caption text-muted">{plan.why}</p> : null}
      {plan.note ? <p className="mt-2 text-caption text-muted">Your note: {plan.note}</p> : null}
      {waiting ? (
        editing ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-body text-fg"
              aria-label="What to change in the plan"
              placeholder="Only Slack and Drive, since March"
              value={note}
              autoFocus
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && note.trim()) void answer('edit');
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(false);
                }
              }}
              data-plan-note
            />
            <Button variant="primary" size="sm" loading={busy === 'edit'} disabled={!note.trim() || !!busy} onClick={() => void answer('edit')} data-plan-send-edit>
              Re-plan
            </Button>
            <Button variant="quiet" size="sm" disabled={!!busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" size="sm" loading={busy === 'run'} disabled={!!busy} onClick={() => void answer('run')} data-plan-run>
              Run · ~{usd(plan.estimate.p50)}
            </Button>
            <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => setEditing(true)} data-plan-edit>
              Edit
            </Button>
            <Button variant="quiet" size="sm" loading={busy === 'skip'} disabled={!!busy} onClick={() => void answer('skip')} data-plan-skip>
              Skip
            </Button>
          </div>
        )
      ) : null}
      {failed ? <p className="mt-2 text-caption text-muted">{failed}</p> : null}
    </div>
  );
}
