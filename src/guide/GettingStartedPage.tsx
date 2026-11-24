'use client';
/**
 * Getting started (01-ui-audit R9, UI-34): five outcomes, the same ones and the same count as the sidebar card
 * (src/guide/checklist.ts `OUTCOMES`, `outcomesOf`; GET /guide `done` / `total` count them). The kit's PageHeader (the
 * topbar holds the title, from the route table) and one slot per outcome, in order:
 *
 *   1 Connect your sources · 2 Pick your role · 3 Approve a draft · 4 Log a week · 5 Claim a DC
 *
 * Each slot shows the outcome's state (ticked from real state, never by hand except a judgement only you can make)
 * and the button of its next step; the steps (page tours, the Assistant, feedback) stay its detail in the card's
 * popover and behind each page's `?`. An outcome this role doesn't have says so and is not counted. Until the first
 * scan is done, Connect your sources also says what it costs (the spend governor's estimate for the lookback chosen in
 * setup, UX.md "Raise a hand"). Product name in new text: Command Center.
 */
import type { ReactNode } from 'react';
import { DEFAULT_LOOKBACK_DAYS, durationText, type ChecklistItem } from '@/contract';
import { queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { useLiveFollow } from '@/client/live';
import { PageHeader } from '@/components/kit/PageHeader';
import { useOnboardingState } from '@/components/onboarding/OnboardingGate';
import { startedSentence } from '@/components/onboarding/started-sentence';
import { navigate } from '@/components/shell/router';
import { FIRST_SCAN_SOURCE_DAY_USD } from '@/llm/spend/defaults';
import { estimateFirstScan, firstScanLine } from '@/llm/spend/first-scan';
import { Button, cn, EmptyState, Icon, PanelError, Skeleton } from '@/ui';
import { GUIDE_TOPICS } from './GettingStarted';
import { outcomesFor, outcomesOf, type OutcomeDef, type OutcomeView } from './checklist';

export function GettingStartedPage() {
  const q = useApi('getGuide', undefined, { staleTime: 30_000, refetchOnWindowFocus: true });
  useLiveFollow(queryKey('getGuide'), GUIDE_TOPICS);
  const persona = usePersona();
  const views = new Map(outcomesOf(q.data?.items ?? [], persona).outcomes.map((o) => [o.id, o] as const));
  // one filled button on the page: the first outcome still to do
  const next = [...views.values()].find((o) => o.state === 'todo')?.id ?? null;
  const onboarding = useOnboardingState().data;
  const days = onboarding?.firstScan?.lookbackDays ?? onboarding?.draft?.history?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const scanLeft = q.data?.items.some((i) => i.id === 'firstScan' && i.state !== 'done') ?? false;
  return (
    <div className="cc-scroll h-full min-h-0 overflow-y-auto" data-testid="getting-started-page">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 pt-6 pb-10">
        <PageHeader
          route="gettingStarted"
          titleIn="topbar"
          inset={false}
          sentence={
            q.data ? (
              <>
                <b className="font-bold text-fg-heading" data-testid="gs-page-count">
                  {q.data.done} of {q.data.total} done.
                </b>{' '}
                {startedSentence(q.data.total)}
              </>
            ) : (
              'Five things and Command Center runs your day.'
            )
          }
        />
        {q.isError && !q.data ? (
          <PanelError title="Getting started failed to load" error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <ol className="grid gap-4 @container" aria-label="Getting started outcomes">
            {outcomesFor(persona).map((o, i) => (
              <OutcomeSlot key={o.id} n={i + 1} outcome={o} view={views.get(o.id) ?? null}>
                {q.isLoading ? <Skeleton variant="line" count={2} /> : <CurrentStep view={views.get(o.id) ?? null} next={next === o.id} />}
                {o.id === 'sources' && scanLeft ? <p className="mt-2 text-caption text-muted tabular-nums" data-testid="gs-first-scan-estimate">{firstScanEstimateLine(days)}. Past that it asks before it goes on.</p> : null}
              </OutcomeSlot>
            ))}
          </ol>
        )}
        {q.data && !q.data.items.length ? <EmptyState icon="success" title="Nothing to set up" body="Your role has no steps left here." /> : null}
        <p className="text-caption text-muted">Each page has a short tour behind its ? in the top bar, whenever you want it.</p>
      </div>
    </div>
  );
}

/** "First scan: usually about $3.10, up to $5.40, about 4 h" for this many days of history. */
export function firstScanEstimateLine(days: number = DEFAULT_LOOKBACK_DAYS): string {
  return firstScanLine(estimateFirstScan(Object.keys(FIRST_SCAN_SOURCE_DAY_USD), { days }), durationText);
}

/** One outcome's frame. */
function OutcomeSlot({ n, outcome, view, children }: { n: number; outcome: OutcomeDef; view: OutcomeView<ChecklistItem> | null; children: ReactNode }) {
  return (
    <li data-outcome={outcome.id} data-state={view?.state ?? 'none'} className={cn('grid grid-cols-[2rem_minmax(0,1fr)] gap-x-4 rounded-lg border border-line bg-surface p-5', !view && 'opacity-70')}>
      <span aria-hidden className="grid size-8 place-items-center rounded-full bg-surface-muted text-body font-bold text-fg-heading tabular-nums">
        {n}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-body-lg font-bold text-fg-heading">{outcome.title}</h2>
        <p className="max-w-[72ch] text-body text-muted">{outcome.why}</p>
        <div className="mt-2 min-w-0" data-slot="outcome-body">
          {children}
        </div>
      </div>
    </li>
  );
}

const STATE: Record<ChecklistItem['state'], { label: string; icon: string; cls: string }> = {
  done: { label: 'Done', icon: 'success', cls: 'text-success-700' },
  waiting: { label: 'Working on it', icon: 'clock', cls: 'text-muted' },
  todo: { label: 'To do', icon: 'task', cls: 'text-fg' },
};

/** The outcome's state and its next step's button (the step's own words: what is missing, where to do it). */
function CurrentStep({ view, next }: { view: OutcomeView<ChecklistItem> | null; next: boolean }) {
  if (!view) return <p className="text-body text-muted">Not part of your role.</p>;
  const st = STATE[view.state];
  // done: the required step's line says what happened; else the step to do next
  const step = view.state === 'done' ? (view.items.find((i) => view.required.includes(i.id)) ?? null) : (view.next ?? null);
  return (
    <div className="flex flex-wrap items-center gap-3" data-state={view.state}>
      <span className={cn('inline-flex items-center gap-1.5 text-body font-bold', st.cls)}>
        <Icon name={st.icon} size="xs" />
        {st.label}
      </span>
      {step ? <span className="min-w-0 flex-1 text-body text-muted">{step.detail}</span> : null}
      {view.state !== 'done' && step?.href ? (
        // a button that navigates (one tab stop), not a button inside a link
        <Button size="sm" variant={next ? 'primary' : 'secondary'} onClick={() => navigate(step.href!)} data-outcome-cta>
          {step.cta}
        </Button>
      ) : null}
    </div>
  );
}
