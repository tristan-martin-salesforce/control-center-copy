'use client';
/**
 * Getting started: a small card at the bottom of the sidebar nav with "N of M" over the five outcomes (01 R9: connect
 * sources · pick your role · approve a draft · log a week · claim a DC; an AE has four), and the outcomes in a popover
 * (GET /guide, src/guide/checklist.ts `outcomesOf`), each with its steps as the detail: the setup steps, the page
 * tours, the Assistant and feedback. Outcomes still to do come first; done ones fold into "Done · N" at the bottom.
 *
 * Every item's button starts guidance on its page, visited before or not: "Take the tour" plays that page's tour from
 * step 1, "Show me" (and "Open Connectors", "Open Role & rules"…) goes there and spotlights the element to use
 * (request.ts → CoachMarks). Items tick from real state; a tour ticks once it is done. The list refetches when a tour
 * records what you saw, when the popover opens and when the window regains focus.
 *
 * Dismissible (settings.guide.checklistDismissed); Settings ▸ About and ⌘K bring it back. Collapsed sidebar: an icon
 * with the steps left.
 */
import { useQueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import type { ChecklistItem, GuidePayload } from '@/contract';
import { queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { useLiveFollow } from '@/client/live';
import { AppLink } from '@/components/shell/AppLink';
import { useOpenFeedback } from '@/components/shell/FeedbackButton';
import { isPlainLinkClick } from '@/components/shell/router';
import type { RouteKey } from '@/components/shell/routes';
import { useShellOptional } from '@/components/shell/ShellContext';
import { IconButton } from '@/ui/Button';
import { cn } from '@/ui/cn';
import { Icon } from '@/ui/Icon';
import { Popover } from '@/ui/Popover';
import { Tooltip } from '@/ui/Tooltip';
import { DC_STEP, itemDoneKey, nextStep, outcomesOf, type GuideItemId, type OutcomeView } from './checklist';
import { requestGuide, type GuideRequest } from './request';
import { useGuideSettings } from './useGuide';

export { nextStep };

/** What an item's button asks CoachMarks for: the page's whole tour, or the item's tip. */
export function guideRequestFor(it: Pick<ChecklistItem, 'id' | 'kind' | 'page'>): GuideRequest {
  return { page: (it.page as RouteKey | null) ?? null, item: it.kind === 'explore' ? null : (it.id as GuideItemId) };
}

function StateMark({ state }: { state: ChecklistItem['state'] }) {
  if (state === 'done') return <Icon name="success" size="sm" className="mt-0.5 shrink-0 text-success-700" />;
  if (state === 'waiting') return <span aria-hidden className="mt-1 size-3.5 shrink-0 rounded-full border-2 border-accent border-t-transparent motion-safe:animate-spin" />;
  return <span aria-hidden className="mt-1 size-3.5 shrink-0 rounded-full border-2 border-line-strong" />;
}

function Bar({ done, total }: { done: number; total: number }) {
  const all = total > 0 && done >= total;
  return (
    <span className="block h-1 w-full overflow-hidden rounded-full bg-surface-muted" aria-hidden>
      <span className={cn('block h-full rounded-full transition-[width] duration-(--dur-prompt)', all ? 'bg-success-700' : 'bg-accent')} style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
    </span>
  );
}

const LINK = 'text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus';

/** The item's button: it goes to the item's place (when it has one) and plays its guidance there. */
function GuideButton({ it, close, label }: { it: ChecklistItem; close: () => void; label: string }) {
  const shell = useShellOptional();
  const start = () => requestGuide(guideRequestFor(it));
  if (it.href) {
    return (
      <AppLink
        href={it.href}
        className={cn(LINK, 'font-bold')}
        data-testid={`gs-go-${it.id}`}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          // ⌘-click opens the place in a new tab, without a tip here
          if (!isPlainLinkClick(e, e.currentTarget)) return;
          close();
          start();
        }}
      >
        {label}
      </AppLink>
    );
  }
  return (
    <button
      type="button"
      className={cn(LINK, 'font-bold')}
      data-testid={`gs-go-${it.id}`}
      onClick={() => {
        close();
        if (it.action === 'assistant') shell?.focusChat();
        start();
      }}
    >
      {label}
    </button>
  );
}

/** The in-place confirm on a step only you can judge: your role ("Looks right"), a DC claimed outside the app. */
const CONFIRM_LABEL: Partial<Record<string, string>> = { [DC_STEP]: 'I’ve claimed one' };

function ItemRow({ it, close, confirm, report }: { it: ChecklistItem; close: () => void; confirm: () => void; report: () => void }) {
  const done = it.state === 'done';
  return (
    <li className="flex gap-2.5" data-testid={`gs-item-${it.id}`} data-state={it.state} data-kind={it.kind}>
      <StateMark state={it.state} />
      <div className="min-w-0 flex-1">
        <div className={cn('font-bold', done ? 'text-muted' : 'text-fg')}>{it.title}</div>
        <p className="text-caption text-muted">{it.detail}</p>
        {!done || it.kind === 'explore' ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
            <GuideButton it={it} close={close} label={it.cta} />
            {!done && it.action === 'confirm' ? (
              <button type="button" className={LINK} onClick={confirm} data-testid={`gs-confirm-${it.id}`}>
                {CONFIRM_LABEL[it.id] ?? 'Looks right'}
              </button>
            ) : null}
            {!done && it.action === 'feedback' ? (
              <button
                type="button"
                className={LINK}
                data-testid="gs-feedback"
                onClick={() => {
                  close();
                  report();
                }}
              >
                Report one
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** One outcome: its state, its title and how many of its steps are done, then the steps (its detail). */
function OutcomeBlock({ o, row }: { o: OutcomeView<ChecklistItem>; row: (it: ChecklistItem) => ReactNode }) {
  const done = o.state === 'done';
  const stepsDone = o.items.filter((i) => i.state === 'done').length;
  return (
    <li className="flex flex-col gap-2" data-testid={`gs-outcome-${o.id}`} data-state={o.state}>
      <div className="flex items-baseline gap-2.5">
        <StateMark state={o.state} />
        <h3 className={cn('min-w-0 flex-1 font-bold', done ? 'text-muted' : 'text-fg-heading')}>{o.title}</h3>
        <span className="shrink-0 text-caption text-muted tabular-nums">
          {stepsDone} of {o.items.length} steps
        </span>
      </div>
      <ol className="ml-6 flex flex-col gap-3 border-l border-line pl-3" data-testid={`gs-steps-${o.id}`} aria-label={`${o.title}: steps`}>
        {o.items.map(row)}
      </ol>
    </li>
  );
}

function ChecklistList({ g, close }: { g: GuidePayload; close: () => void }) {
  const { markSeen, dismissChecklist } = useGuideSettings();
  const openFeedback = useOpenFeedback();
  const [showDone, setShowDone] = useState(false);
  const { outcomes, extra } = outcomesOf(g.items, usePersona());
  const open = outcomes.filter((o) => o.state !== 'done');
  const done = outcomes.filter((o) => o.state === 'done');
  const all = g.total > 0 && g.done >= g.total;
  const row = (it: ChecklistItem) => <ItemRow key={it.id} it={it} close={close} confirm={() => markSeen([itemDoneKey(it.id as GuideItemId)])} report={openFeedback} />;
  const block = (o: OutcomeView<ChecklistItem>) => <OutcomeBlock key={o.id} o={o} row={row} />;
  return (
    <div className="flex max-h-[min(78vh,40rem)] flex-col text-body" data-testid="getting-started-list">
      <div className="shrink-0 px-4 pt-4">
        <div className="flex items-baseline gap-2">
          <h2 className="min-w-0 flex-1 text-body font-bold text-fg-heading">{all ? 'You’re set up' : 'Getting started'}</h2>
          <span className="text-caption text-muted tabular-nums">
            {g.done} of {g.total} done
          </span>
        </div>
        <div className="mt-2">
          <Bar done={g.done} total={g.total} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-1">
        {open.length ? (
          <ol className="mt-3 flex flex-col gap-4" data-testid="gs-open">
            {open.map(block)}
          </ol>
        ) : (
          <p className="mt-3 text-fg">Every outcome is done. Each page’s ? still explains it and replays its tour.</p>
        )}
        {extra.length ? (
          <div className="mt-4 border-t border-line pt-2">
            <h3 className="text-caption font-bold text-muted">More tours</h3>
            <ol className="mt-2 flex flex-col gap-3" data-testid="gs-extra">
              {extra.map(row)}
            </ol>
          </div>
        ) : null}
        {done.length ? (
          <div className="mt-3 border-t border-line pt-2">
            <button type="button" className="inline-flex items-center gap-1 rounded-sm text-caption font-bold text-muted hover:text-fg focus-visible:outline-none focus-visible:shadow-focus" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)} data-testid="gs-done-toggle">
              <Icon name={showDone ? 'chevrondown' : 'chevronright'} size="xs" />
              Done · {done.length}
            </button>
            {showDone ? (
              <ol className="mt-2 flex flex-col gap-4" data-testid="gs-done">
                {done.map(block)}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-3 text-caption">
        <span className="min-w-0 flex-1 text-muted">{all ? 'You can bring it back from ⌘K or Settings ▸ About.' : 'Outcomes tick themselves as you use the app; tours are optional.'}</span>
        <button
          type="button"
          className={cn(LINK, all && 'font-bold')}
          data-testid="gs-dismiss"
          onClick={() => {
            close();
            dismissChecklist(true);
          }}
        >
          Hide the checklist
        </button>
      </div>
    </div>
  );
}

/**
 * Two compact rows (it shares the sidebar with the nav); the next step is in its tooltip and the popover. Its content
 * names it, no aria-label (axe label-content-name-mismatch): the title is read as shown, the short "1/5" or "Done" is
 * hidden from screen readers and a visually hidden ": 1 of 5 done. Next: …" stands in for it.
 */
/** What a screen reader hears after the card's title, in place of the short count. */
export const cardSpoken = (g: Pick<GuidePayload, 'done' | 'total'>, next?: string): string =>
  g.total > 0 && g.done >= g.total ? `: all ${g.total} done` : `: ${g.done} of ${g.total} done${next ? `. Next: ${next}` : ''}`;

const CardTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { g: GuidePayload }>(function CardTrigger({ g, className, ...rest }, ref) {
  const next = nextStep(g);
  const all = g.total > 0 && g.done >= g.total;
  return (
    <Tooltip side="right" content={next ? `Next: ${next.title}` : 'All done: open it to hide the checklist'}>
      <button
        ref={ref}
        type="button"
        data-testid="getting-started"
        data-done={all ? 'true' : undefined}
        className={cn('flex w-full flex-col gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-caption transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:shadow-focus aria-expanded:border-line-strong', className)}
        {...rest}
      >
        <span className="flex w-full items-baseline gap-2">
          {all ? <Icon name="success" size="xs" className="shrink-0 self-center text-success-700" /> : null}
          <span className="min-w-0 flex-1 truncate font-bold text-fg">{all ? 'You’re set up' : 'Getting started'}</span>
          <span aria-hidden className={cn('shrink-0 tabular-nums', all ? 'font-bold text-success-700' : 'text-muted')}>
            {all ? 'Done' : `${g.done}/${g.total}`}
          </span>
          <span className="sr-only">{cardSpoken(g, next?.title)}</span>
        </span>
        <Bar done={g.done} total={g.total} />
      </button>
    </Tooltip>
  );
});

const RailTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { g: GuidePayload }>(function RailTrigger({ g, ...rest }, ref) {
  const left = g.total - g.done;
  return (
    <Tooltip side="right" content={`Getting started · ${g.done} of ${g.total} done`}>
      <IconButton ref={ref} icon={left > 0 ? 'task' : 'success'} label={left > 0 ? `Getting started: ${left} of ${g.total} left` : 'Getting started: all done'} badge={left > 0 ? left : undefined} data-testid="getting-started" {...rest} />
    </Tooltip>
  );
});

/** A short fingerprint of what was seen: it changes whenever a tour records a step. */
const seenPrint = (seen: Readonly<Record<string, string>> | undefined) => (seen ? Object.keys(seen).sort().join('|') : '');

/**
 * What ticks an outcome, as live topics: connectors (health), the first scan (scans, jobs), drafts, the Assistant
 * (chat), the role (settings, onboarding), a logged batch (time) and a claimed DC (deals). Without deals and time the
 * card sat on 1/5 after a DC claim until the window lost focus (24-visual-qa).
 */
export const GUIDE_TOPICS = ['health', 'draft', 'chat', 'scans', 'jobs', 'deals', 'time', 'settings', 'onboarding'] as const;

export function GettingStarted({ collapsed }: { collapsed?: boolean }) {
  // Push, not a poll: the guide's steps tick from connectors (health), drafts, the Assistant (chat) and the first scan.
  const q = useApi('getGuide', undefined, { staleTime: 30_000, refetchOnWindowFocus: true });
  useLiveFollow(queryKey('getGuide'), GUIDE_TOPICS);
  const qc = useQueryClient();
  const { guide } = useGuideSettings();
  const [open, setOpen] = useState(false);
  // a tour (or "Looks right") recorded something: the explore items tick without a reload
  const print = seenPrint(guide?.seen);
  const lastPrint = useRef(print);
  useEffect(() => {
    if (lastPrint.current === print) return;
    lastPrint.current = print;
    void qc.invalidateQueries({ queryKey: queryKey('getGuide') });
  }, [print, qc]);
  const refetch = q.refetch;
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);
  const g = q.data;
  if (!g || g.dismissed) return null;
  return (
    <div className={cn('shrink-0', collapsed ? 'flex justify-center pb-2' : 'pt-1 pb-2')}>
      <Popover open={open} onOpenChange={setOpen} placement="right-end" width={380} label="Getting started" trigger={collapsed ? <RailTrigger g={g} /> : <CardTrigger g={g} />}>
        {({ close }) => <ChecklistList g={g} close={close} />}
      </Popover>
    </div>
  );
}
