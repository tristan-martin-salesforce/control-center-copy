'use client';
/**
 * Health ▸ Setup (11 R6/R7, 01 R7): one surface for "is my Command Center healthy, and what do I do".
 *
 *   Setup   1 needs you · 1 can't tell yet · checked 2 min ago                         [Check again]
 *   ▌ Slack            [Signed out]  Slack needs you to sign in                 [Re-auth Slack] [Check again]
 *   ▌                  Command Center can't read Slack until … · Next step: … · code AUTH.SLACK.SIGNED_OUT
 *   ▌ Claude sign-in   [Can't tell yet]  Every model step needs Claude …              [Test Claude (about $0.001)]
 *   ▌ Database         [Ready]  Where your data lives on this Mac.
 *
 * Rows come from `HealthPayload.setup` (the worker's last doctor run) or, after Check again, the fresh GET
 * /doctor?fresh=1. Each row: why we need it, a state chip, the catalog's problem and ONE next step, and a button per
 * `action.kind` (run: the command in a copy box, then Check again · reauth: the existing re-auth flow · open: an app
 * route · link: the docs · report: Feedback with the code). The Claude check costs a model call, so its price is on the
 * button. offline and unknown never read as broken. Each row is the anchor `#setup-<id>` that toasts and Health's
 * "needs you" link to.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { Connector, DoctorPayload, HealthPayload, SetupDependency } from '@/contract';
import { ApiError, api } from '@/client/api';
import { usePersona } from '@/client/persona';
import { depIdFromHash, connectorForDependency, dependencyIdForSource, problemOf, problemToast, setupRowView, setupSummary, sortSetup, checkedAgo, type SetupButton, type SetupRowView, type SetupTone } from '@/client/health-setup';
import { toast } from '@/client/toast';
import { ActionRow, type ActionRowVerb } from '@/components/kit';
import { CommandBlock } from '@/components/panels/bits';
import { navigate } from '@/components/shell/router';
import { setupDepsFor } from '@/personas';
import { openReadme } from '@/guide/Readme';
import { Button, StatePill, useNow, type Tone } from '@/ui';
import type { useConnectorActions } from './actions';
import { useReportProblem } from './report';

type Actions = ReturnType<typeof useConnectorActions>;

const PILL_TONE: Record<SetupTone, Tone> = { ok: 'ok', danger: 'risk', warning: 'warn', neutral: 'neutral' };
const EDGE: Record<SetupTone, 'danger' | 'warning' | 'none'> = { ok: 'none', danger: 'danger', warning: 'warning', neutral: 'none' };

/** The muted "code" chip: the one place a raw catalog code shows (for a report). */
export function CodeChip({ code }: { code: string }) {
  return (
    <span data-code-chip title="The error code, for a report" className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 font-mono text-micro text-muted">
      <span className="font-sans">code</span> {code}
    </span>
  );
}

export interface SetupListProps {
  deps: readonly SetupDependency[];
  nowMs: number;
  /** Mock mode: fixture states, nothing on this Mac was checked. */
  simulated?: boolean;
  /** The whole list is being re-checked (Check again in the header). */
  checking?: boolean;
  /** The row whose own button is running (its Check again, its re-auth, the Claude test). */
  busyId?: string | null;
  onCheckAll: () => void;
  onButton: (b: SetupButton, row: SetupRowView) => void;
}

function verbOf(b: SetupButton | undefined, row: SetupRowView, p: SetupListProps): ActionRowVerb | null {
  if (!b) return null;
  return {
    label: b.label,
    onClick: () => p.onButton(b, row),
    loading: p.busyId === row.id || (p.checking && (b.kind === 'check' || b.kind === 'smoke')) || false,
    icon: b.kind === 'reauth' ? 'refresh' : b.kind === 'link' ? 'new_window' : b.kind === 'report' ? 'bug' : b.kind === 'check' ? 'sync' : undefined,
    testId: `setup-${b.kind}-${row.id}`,
  };
}

/** Presentational: the rows in the order that needs the user first. */
export function SetupList(p: SetupListProps) {
  const rows = useMemo(() => sortSetup(p.deps).map((d) => setupRowView(d, p.nowMs)), [p.deps, p.nowMs]);
  const summary = setupSummary(p.deps);
  const [target, setTarget] = useState<string | null>(null);

  // #setup-<id>: scroll the row into view and mark it (toasts, Health's needs-you links, Getting started)
  useEffect(() => {
    const go = () => {
      const id = depIdFromHash(window.location.hash);
      setTarget(id);
      if (id) requestAnimationFrame(() => document.getElementById(`setup-${id}`)?.scrollIntoView?.({ block: 'center' }));
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, [rows.length]);

  const firstNeeds = rows.find((r) => r.needsYou)?.id ?? null;
  return (
    <section aria-label="Setup" className="flex flex-col gap-2" data-setup data-setup-needs={summary.needs}>
      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1">
        <p className="min-w-0 text-body font-bold text-fg-heading" data-setup-summary>
          {summary.needs ? summary.line : summary.unsure ? `Everything that could be checked is ready · ${summary.unsure} can't tell yet` : 'Everything is ready'}
        </p>
        <span className="text-caption text-muted tabular-nums" data-setup-checked>
          {checkedAgo(summary.lastChecked, p.nowMs)}
        </span>
        <Button variant="secondary" size="sm" icon="sync" loading={p.checking} onClick={p.onCheckAll} className="ml-auto" data-testid="setup-check-all">
          Check again
        </Button>
      </header>
      {p.simulated ? <p className="px-1 text-caption text-muted">Mock mode: these are fixture states; nothing on this Mac was checked.</p> : null}
      {rows.length === 0 ? (
        <p className="px-1 text-body text-muted">Not checked yet. Check again runs the setup checks on this Mac.</p>
      ) : (
        <div role="grid" aria-label="Dependencies" className="flex flex-col">
          {rows.map((r) => {
            const unsure = !r.needsYou && r.state !== 'ok';
            return (
              <div key={r.id} id={r.anchor} data-setup-row={r.id} data-state={r.state} data-target={target === r.id || undefined} className="scroll-mt-6 rounded-md data-[target]:shadow-[inset_0_0_0_2px_var(--color-focus)]">
                <ActionRow
                  id={r.id}
                  title={r.label}
                  edge={EDGE[r.chip.tone]}
                  badge={<StatePill tone={PILL_TONE[r.chip.tone]} label={r.chip.label} icon={r.chip.tone === 'neutral' ? false : undefined} />}
                  why={r.needsYou && r.problem ? <span className="font-bold text-fg">{r.problem.title}</span> : r.why}
                  meta={<span className="tabular-nums">{r.checked}</span>}
                  verb={verbOf(r.buttons[0], r, p)}
                  altVerb={verbOf(r.buttons[1], r, p)}
                  emphasis={r.id === firstNeeds}
                  extra={
                    r.needsYou || unsure ? (
                      <div className="flex max-w-[72ch] flex-col gap-1.5 pb-1 text-body" data-setup-detail>
                        {r.problem ? (
                          <p className="text-fg" data-setup-problem>
                            {unsure && r.problem.title !== r.chip.label ? <b>{r.problem.title}. </b> : null}
                            {r.problem.text}
                          </p>
                        ) : null}
                        {r.nextStep ? (
                          <p className="text-fg" data-setup-next>
                            <b>Next step:</b> {r.nextStep}
                          </p>
                        ) : null}
                        {r.command ? <CommandBlock className="max-w-[60rem]" command={r.command} note="Run it in Terminal, then click Check again." /> : null}
                        <p className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-muted">
                          {r.needsYou ? <span className="min-w-0">Why: {r.why}</span> : null}
                          {r.code ? <CodeChip code={r.code} /> : null}
                        </p>
                      </div>
                    ) : null
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The newer of the payload's rows and a Check again run made on this page. */
export function pickDeps(fromHealth: readonly SetupDependency[] | undefined, fresh: Pick<DoctorPayload, 'generatedAt' | 'dependencies'> | null): readonly SetupDependency[] {
  const h = fromHealth ?? [];
  if (!fresh) return h;
  const newestH = h.map((d) => d.lastChecked).filter((x): x is string => !!x).sort().at(-1) ?? '';
  return fresh.generatedAt >= newestH ? fresh.dependencies : h;
}

/** Health ▸ Setup: the rows and their buttons, wired to the doctor route, the Claude check and the re-auth flow. */
export function SetupTab({ h, connectors, actions }: { h: HealthPayload | undefined; connectors: Connector[]; actions: Actions }) {
  const qc = useQueryClient();
  const nowMs = useNow().getTime();
  const report = useReportProblem();
  const persona = usePersona();
  const [fresh, setFresh] = useState<DoctorPayload | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const check = useMutation({
    mutationFn: (_rowId: string | null) => api('getDoctor', { query: { fresh: '1' } }),
    onMutate: (rowId) => setBusyId(rowId),
    onSuccess: (d) => {
      setFresh(d);
      void qc.invalidateQueries({ queryKey: ['health'] });
    },
    onError: (e: ApiError) => toast(problemToast(e, { key: 'setup-check', title: 'Couldn’t run the setup checks' })),
    onSettled: () => setBusyId(null),
  });

  const smoke = useMutation({
    mutationFn: () => api('smokeClaude', { body: {} }),
    onMutate: () => setBusyId('claude-signin'),
    onSuccess: (r) => {
      if (r.status === 'ok') toast({ key: 'setup-smoke', tone: 'success', title: 'Claude answered', body: r.costUsd !== null ? `The check cost $${r.costUsd.toFixed(4)}.` : 'Claude is signed in.' });
      else if (r.status === 'simulated') toast({ key: 'setup-smoke', tone: 'info', title: 'Nothing was run (mock mode)', body: 'On a real install this asks Claude for one word.' });
      else {
        const p = problemOf(r.code ?? 'AUTH.LLM.SIGNED_OUT', { depId: 'claude-signin' });
        toast({ key: 'setup-smoke', tone: r.status === 'refused' ? 'info' : 'error', title: p.title, body: p.nextStep, durationMs: 20_000 });
      }
      check.mutate(null);
    },
    onError: (e: ApiError) => toast(problemToast(e, { key: 'setup-smoke', title: 'Couldn’t test Claude' })),
    onSettled: () => setBusyId(null),
  });

  // D-55: Check again reads every dependency; a row for a source the persona doesn't have stays away (VDP for an AE)
  const deps = setupDepsFor(pickDeps(h?.setup?.dependencies, fresh), persona);

  const onButton = (b: SetupButton, row: SetupRowView) => {
    switch (b.kind) {
      case 'check':
        return check.mutate(row.id);
      case 'smoke':
        return smoke.mutate();
      case 'run':
        return check.mutate(row.id);
      case 'reauth': {
        const c = connectorForDependency(row.id, connectors);
        if (c) return actions.reauth.mutate(c);
        const p = problemOf(row.code ?? 'BUG.UNKNOWN');
        return toast({ key: `setup-reauth-${row.id}`, tone: 'info', title: p.title, body: p.nextStep });
      }
      case 'open':
        return navigate(b.ref);
      case 'link':
        if (b.ref.startsWith('#')) return openReadme();
        window.open(b.ref, '_blank', 'noopener,noreferrer');
        return;
      case 'report':
        return report({ depId: row.id, label: row.label, code: row.code, title: row.problem?.title ?? null });
    }
  };

  const reauthing = connectors.find((c) => actions.reauthing(c.id));
  const reauthDep = reauthing ? dependencyIdForSource(reauthing.source) : null;
  return (
    <SetupList
      deps={deps}
      nowMs={nowMs}
      simulated={fresh?.simulated}
      checking={check.isPending && busyId === null}
      busyId={busyId ?? reauthDep}
      onCheckAll={() => check.mutate(null)}
      onButton={onButton}
    />
  );
}
