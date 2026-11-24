'use client';
/**
 * "Raise today's cap" (POST /budgets/raise-today): a higher hard cap for today with a reason, from wherever the cap
 * shows (the capped card on Health, Health ▸ Spend, the sidebar spend panel, Settings ▸ Budgets). Raise only, and every
 * raise is kept (`budgets.raises`), so a costly day keeps its story. `RaiseHistory` lists them.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { BudgetRaise, HealthPayload } from '@/contract';
import { ApiError, api } from '@/client/api';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { Button } from '@/ui/Button';
import { cn } from '@/ui/cn';
import { Dialog } from '@/ui/Dialog';
import { fmtUsd } from '@/ui/format';

type Spend = HealthPayload['spend'];

/** The next sensible cap: +$10, or +50% when the cap is already large. */
export function suggestedCap(hardUsd: number): number {
  return Math.ceil(Math.max(hardUsd + 10, hardUsd * 1.5) / 5) * 5;
}

/** What a raise does to the soft budget when only the hard cap is given (mirrors raiseBudgetToday). */
export function softAfter(spend: Spend['today'], toHard: number): number {
  return Math.min(toHard, spend.softBudgetUsd + Math.max(0, toHard - spend.hardCapUsd));
}

export function useRaiseCap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { hardUsd: number; reason: string }) => api('raiseBudgetToday', { body }),
    onSuccess: (res, body) => {
      for (const t of ['health', 'settings', 'today', 'home']) void qc.invalidateQueries({ queryKey: [t] });
      toast({ key: 'raise-cap', tone: 'success', title: `Today's cap is now ${fmtUsd(body.hardUsd)}`, body: 'Scanners pick up again on their next run. Back to the standard limits tomorrow.', undo: res.auditId ? { auditId: res.auditId } : undefined });
    },
  });
}

export function RaiseCapButton({ spend, variant = 'secondary', size = 'sm', className, label = "Raise today's cap…" }: { spend: Spend | undefined; variant?: 'primary' | 'secondary' | 'quiet'; size?: 'xs' | 'sm'; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!spend) return null;
  return (
    <>
      <Button variant={variant} size={size} icon="money" onClick={() => setOpen(true)} className={className} data-testid="raise-cap">
        {label}
      </Button>
      {open ? <RaiseCapDialog spend={spend} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function RaiseCapDialog({ spend, onClose }: { spend: Spend; onClose: () => void }) {
  const raise = useRaiseCap();
  const [hard, setHard] = useState(() => suggestedCap(spend.today.hardCapUsd));
  const [reason, setReason] = useState('');
  const tooLow = !(hard > spend.today.hardCapUsd);
  const noReason = reason.trim().length < 3;
  const err = raise.error instanceof ApiError ? raise.error.message : raise.error ? 'Could not raise the cap. Try again.' : null;
  const submit = async () => {
    if (tooLow || noReason) return;
    await raise.mutateAsync({ hardUsd: hard, reason: reason.trim() });
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Raise today's cap"
      description={`${fmtUsd(spend.today.usd)} spent today of a ${fmtUsd(spend.today.hardCapUsd)} cap. The raise is for today only and is kept in the spend history with your reason.`}
      confirmLabel={`Raise to ${fmtUsd(hard)}`}
      busy={raise.isPending}
      onConfirm={submit}
      confirmKbd="mod+enter"
    >
      <div className="space-y-3 text-body">
        <label className="flex items-center gap-3">
          <span className="w-28 shrink-0 text-muted">New hard cap</span>
          <span className="text-muted">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={Math.floor(spend.today.hardCapUsd) + 1}
            step={1}
            value={hard}
            onChange={(e) => setHard(Number(e.target.value))}
            aria-invalid={tooLow}
            className="h-9 w-24 rounded-md border border-line-input bg-surface-input px-2 tabular-nums text-fg focus-visible:shadow-focus focus-visible:outline-none"
            data-testid="raise-cap-hard"
          />
          <span className="text-caption text-muted">soft budget {fmtUsd(spend.today.softBudgetUsd)} → {fmtUsd(softAfter(spend.today, hard))}</span>
        </label>
        {tooLow ? <p className="text-caption text-danger-700">Raise it above {fmtUsd(spend.today.hardCapUsd)}.</p> : null}
        <label className="block">
          <span className="mb-1 block text-muted">Why (kept with the day’s spend)</span>
          <textarea
            rows={2}
            maxLength={200}
            value={reason}
            placeholder="e.g. first AE forecast run · catching up after a week off"
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border border-line-input bg-surface-input px-2.5 py-2 text-fg placeholder:text-faint focus-visible:shadow-focus focus-visible:outline-none"
            data-testid="raise-cap-reason"
            autoFocus
          />
        </label>
        {noReason && reason.length > 0 ? <p className="text-caption text-muted">A few words, so the day makes sense later.</p> : null}
        {err ? <p className="text-caption text-danger-700">{err}</p> : null}
      </div>
    </Dialog>
  );
}

/** Raises, newest first, with the day's spend when it's within the last 7 days; `limit` first, then Show all N (caps audit F-13). */
export function RaiseHistory({ last7d, limit = 8, className }: { last7d?: Spend['last7d']; limit?: number; className?: string }) {
  const settings = useApi('getSettings');
  const [all, setAll] = useState(false);
  const every: BudgetRaise[] = [...(settings.data?.budgets.raises ?? [])].reverse();
  const raises = all ? every : every.slice(0, limit);
  if (!raises.length) return null;
  const spentOn = new Map((last7d ?? []).map((d) => [d.day, d.usd]));
  return (
    <section className={cn('space-y-1.5', className)} aria-label="Cap raises" data-testid="raise-history">
      <h3 className="text-caption font-bold tracking-wide text-muted uppercase">Cap raises</h3>
      <ul className="space-y-1">
        {raises.map((r) => (
          <li key={r.at} className="grid grid-cols-[6.5rem_auto_1fr] items-baseline gap-x-3 text-body">
            <span className="text-caption text-muted tabular-nums">{new Date(`${r.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <span className="font-bold tabular-nums text-fg">
              {fmtUsd(r.fromHardUsd)} → {fmtUsd(r.toHardUsd)}
            </span>
            <span className="min-w-0 text-muted">
              {r.reason}
              {spentOn.has(r.day) ? <span className="text-faint"> · spent {fmtUsd(spentOn.get(r.day) ?? 0)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {every.length > limit ? (
        <button type="button" className="rounded-sm text-caption font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus" onClick={() => setAll((v) => !v)} data-testid="raise-history-all">
          {all ? 'Show fewer' : `Show all ${every.length}`}
        </button>
      ) : null}
    </section>
  );
}
