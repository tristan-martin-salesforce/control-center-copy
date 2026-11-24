'use client';
/**
 * The loud part of Health (DESIGN-V2 principle 10): it exists only when something is broken. One block per
 * broken source with what's affected, the exact re-auth command with Copy, and the re-auth action (filled on
 * the first block only: one filled action per region), plus the dead worker and the spend cap.
 * Degraded or offline sources get a quieter amber line. When nothing is broken this renders nothing.
 */
import type { Connector, HealthPayload } from '@/contract';
import { clock, dayLabel, sameDay } from '@/components/domain/lib/time';
import { CommandBlock } from '@/components/panels/bits';
import { connectorPrimary } from '@/components/panels/derive';
import { DEFAULT_HANDS_ON } from '@/engines/priority/estimate';
import { Button } from '@/ui';
import { AppLink } from '@/components/shell/AppLink';
import { connectorProblem, problemOf } from '@/client/health-setup';
import { BROKEN_STATES, needsYou } from './derive';
import { RaiseCapButton } from './RaiseCap';
import { SpendAskRows } from './SpendAsks';
import type { useConnectorActions } from './actions';

type Actions = ReturnType<typeof useConnectorActions>;

/** The command in the worker's fix ("npm run update (or npm run db:migrate)" → "npm run update"); null when it is prose. */
export function waitingCommand(fix: string | null): string | null {
  return /^npm run [\w:-]+/.exec(fix ?? '')?.[0] ?? null;
}

export function NeedsYou({ h, now, tz, actions, onOpen, panelId }: { h: HealthPayload; now: string; tz?: string; actions: Actions; onOpen: (c: Connector) => void; panelId?: string | null }) {
  const list = needsYou(h.connectors);
  const broken = list.filter((c) => BROKEN_STATES.has(c.state));
  const amber = list.filter((c) => !BROKEN_STATES.has(c.state));
  const workerDown = !h.worker.alive;
  // lane E (E1): alive, but waiting for the database schema to match its build (no job runs meanwhile)
  const waiting = !workerDown && h.worker.blocked ? h.worker.blocked : null;
  const capped = h.spend.state === 'capped';
  const soft = h.spend.state === 'soft_alert';
  // D-60: VDP autopilot is on but paused (re-auth VDP, dry run, today's cap): told here until it clears
  const ap = h.vdpAutopilot?.paused ? h.vdpAutopilot : null;
  // H-5: runs that passed their estimate and wait for an answer
  const asks = h.spendAsks ?? [];
  if (!broken.length && !amber.length && !workerDown && !waiting && !capped && !soft && !ap && !asks.length) return null;
  const since = (iso: string) => (sameDay(iso, now, tz) ? clock(iso, tz) : dayLabel(iso, tz));
  let filledUsed = false;
  const takeFilled = () => {
    if (filledUsed) return false;
    filledUsed = true;
    return true;
  };

  return (
    <section aria-label="Needs you" className="flex flex-col gap-3" data-health-loud>
      {broken.map((c) => {
        const p = connectorPrimary(c);
        const r = c.reauth;
        // one diagnosis, in the catalog's words; the Setup row owns the detail (01 UI-7: no second wording here)
        const prob = connectorProblem(c, h.setup?.dependencies);
        // Open in the docked panel: its footer holds the filled button, so this one goes quiet.
        const filled = p.kind === 'reauth' && panelId !== c.id && takeFilled();
        return (
          <article key={c.id} className="rounded-lg border border-danger-200 bg-danger-50 px-5 py-4 shadow-[inset_3px_0_0_var(--color-danger-500)]" data-broken={c.id} aria-label={`${c.label} ${c.state === 'auth_needed' ? 'needs re-auth' : 'is broken'}`}>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-lead font-bold text-danger-700">
                <span aria-hidden>✕ </span>
                {c.label} {c.state === 'auth_needed' ? 'needs re-auth' : 'is broken'}
              </h2>
              <span className="text-caption text-muted tabular-nums">since {since(c.since)}</span>
            </div>
            {prob ? (
              <p className="mt-1 max-w-[68ch] text-body text-fg" data-problem-code={prob.code}>
                <b>{prob.title}.</b> {prob.nextStep}
              </p>
            ) : null}
            {c.impact ? <p className="mt-1 max-w-[68ch] text-caption text-muted">{c.impact}</p> : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {p.kind === 'reauth' ? (
                <Button variant={filled ? 'primary' : 'secondary'} size="sm" icon={r?.kind === 'terminal_command' ? 'new_window' : 'refresh'} loading={actions.reauthing(c.id)} onClick={() => actions.reauth.mutate(c)} data-reauth={c.id}>
                  {p.label}
                </Button>
              ) : null}
              <Button variant="quiet" size="sm" icon="sync" loading={actions.scanning(c.id)} onClick={() => actions.scan.mutate(c)}>
                Rescan
              </Button>
              <Button variant="quiet" size="sm" onClick={() => onOpen(c)}>
                Details
              </Button>
              {prob?.href ? (
                <AppLink href={prob.href} className="text-caption font-bold text-link hover:underline" data-setup-link={prob.depId}>
                  How to fix
                </AppLink>
              ) : null}
              <span className="text-caption text-muted">You ~{DEFAULT_HANDS_ON.reauth}m. Scanning resumes and catches up on its own.</span>
            </div>
          </article>
        );
      })}
      {waiting ? (
        <article className="rounded-lg border border-danger-200 bg-danger-50 px-5 py-4 shadow-[inset_3px_0_0_var(--color-danger-500)]" data-health-system="schema">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lead font-bold text-danger-700">
              <span aria-hidden>✕ </span>
              The background worker is waiting for the database
            </h2>
            <span className="text-caption text-muted tabular-nums">since {since(waiting.since)}</span>
          </div>
          <p className="mt-1 max-w-[68ch] text-body text-fg">{waiting.message} Scans and jobs wait until then.</p>
          {waitingCommand(waiting.fix) ? (
            <CommandBlock className="mt-3 max-w-[60rem]" command={waitingCommand(waiting.fix)!} note={waitingCommand(waiting.fix) === 'npm run update' ? 'Run it from the Command Center folder: it backs up the database, migrates and restarts both services.' : 'Run it from the Command Center folder.'} />
          ) : waiting.fix ? (
            <p className="mt-2 max-w-[68ch] text-body text-fg">{waiting.fix}</p>
          ) : null}
        </article>
      ) : null}
      {workerDown ? <WorkerDown /> : null}
      {capped ? (
        <article className="rounded-lg border border-danger-200 bg-danger-50 px-5 py-4 shadow-[inset_3px_0_0_var(--color-danger-500)]" data-health-system>
          <h2 className="text-lead font-bold text-danger-700">
            <span aria-hidden>✕ </span>
            The hard spend cap is reached
          </h2>
          <p className="mt-1 max-w-[68ch] text-body text-fg">{`Scans run on rules only (no AI) until tomorrow ($${h.spend.today.usd.toFixed(2)} of $${h.spend.today.hardCapUsd}).`}</p>
          <RaiseCapButton spend={h.spend} variant="primary" className="mt-3" />
        </article>
      ) : null}
      {amber.length || soft || ap || asks.length ? (
        <ul className="flex flex-col gap-1" data-health-amber>
          <SpendAskRows asks={asks} />
          {ap ? (
            <li className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-body" data-testid="health-vdp-autopilot">
              <span className="font-bold text-warning-700">
                <span aria-hidden>▲ </span>
                {ap.paused === 'reauth' ? 'VDP autopilot is paused: re-auth VDP' : ap.paused === 'dry_run' ? 'VDP autopilot is paused: dry run is on' : "VDP autopilot is paused: today's cap is reached"}
              </span>
              <span className="min-w-0 text-caption text-muted">{ap.line} · what it would apply waits</span>
              <AppLink href="/activity?view=vdp" className="text-caption font-bold text-link hover:underline">
                VDP changes
              </AppLink>
            </li>
          ) : null}
          {amber.map((c) => (
            <li key={c.id} className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-body">
              <span className="font-bold text-warning-700">
                <span aria-hidden>▲ </span>
                {c.label} {c.state === 'offline' ? 'is offline' : 'is degraded'}
              </span>
              <span className="min-w-0 text-caption text-muted">{c.impact ?? connectorProblem(c, h.setup?.dependencies)?.title ?? `since ${since(c.since)}`}</span>
              <Button variant="quiet" size="xs" onClick={() => onOpen(c)}>
                Details
              </Button>
            </li>
          ))}
          {soft ? (
            <li className="flex flex-wrap items-baseline gap-x-3 text-body">
              <span className="font-bold text-warning-700">
                <span aria-hidden>▲ </span>
                {Math.round(h.spend.today.pct)}% of today’s soft budget used
              </span>
              <span className="text-caption text-muted">
                ${h.spend.today.usd.toFixed(2)} of ${h.spend.today.softBudgetUsd}
              </span>
              <RaiseCapButton spend={h.spend} variant="quiet" size="xs" />
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

/** The worker stopped (DEP.WORKER.DOWN): the catalog's words and its restart command, the same as its Setup row. */
function WorkerDown() {
  const p = problemOf('DEP.WORKER.DOWN');
  const command = p.action?.kind === 'run' ? p.action.ref : null;
  return (
    <article className="rounded-lg border border-danger-200 bg-danger-50 px-5 py-4 shadow-[inset_3px_0_0_var(--color-danger-500)]" data-health-system="worker" data-problem-code={p.code}>
      <h2 className="text-lead font-bold text-danger-700">
        <span aria-hidden>✕ </span>
        {p.title}
      </h2>
      <p className="mt-1 max-w-[68ch] text-body text-fg">{p.text}</p>
      {command ? <CommandBlock className="mt-3 max-w-[60rem]" command={command} note="Run it in Terminal; scans and jobs resume when it checks in." /> : null}
      {p.href ? (
        <AppLink href={p.href} className="mt-2 inline-block text-caption font-bold text-link hover:underline" data-setup-link={p.depId}>
          How to fix
        </AppLink>
      ) : null}
    </article>
  );
}
