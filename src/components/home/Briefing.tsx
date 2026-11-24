'use client';
/**
 * Home as the briefing (phase 3; docs/UX.md "Home"): the strips around Do now that answer "what do I do now" without
 * a second list. Tailwind and the tokens only (H-10b).
 *
 *   MoveItLine     overbooked → "Overbooked by 45 min. Move “X” to Monday to fit. [Move it]" (the snooze verb, Undo)
 *   RespondStrip   Respond · 4   [Reply to Dana · Send] [Reply to Marcus · Retry] [Draft: Answer Lee]   Review 3 →
 *   ComingBuilds   ✦ ACME demo-org build · 2 of 6 · ETA 10:40            [Open in Claude]   (nothing when none;
 *                  Review prompt first when the build carries a prepared prompt, SEC-10)
 *   AdminRow       Admin: 4 items · ~25m · next due Fri 16:00  ▸  (expands to its items)
 *
 * Every chip and row only opens: a draft opens its Outbox row (the Outbox's own preview, confirm and undo window), an
 * item opens Details, a build opens its Claude session on an explicit click. *Nothing leaves without approval*.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { HomeAdmin, HomeBuild, HomeMoveIt, HomeRespond, HomeRespondChip } from '@/contract';
import { navigate } from '@/components/shell/router';
import { useRightPanel } from '@/components/shell/panel';
import { Button, cn } from '@/ui';
import { needsReview, OPEN_IN_CLAUDE_LABEL, REVIEW_PROMPT_LABEL } from '@/components/agents/LaunchReview';
import { type HomeActions } from './useHomeActions';

// ---- overbooked: what to move -----------------------------------------------------------------------------------

export function MoveItLine({ m, actions }: { m: HomeMoveIt; actions: Pick<HomeActions, 'snooze'> }) {
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-body text-fg" data-testid="home-move-it" data-movable={m.item ? '1' : '0'}>
      <b className="font-bold text-danger-700">{m.label}.</b>
      <span className="min-w-0">{m.sentence}</span>
      {m.item && m.title ? (
        <Button variant="secondary" size="sm" data-testid="home-move-it-btn" title={`Moves it to ${m.to?.short ?? 'the next working day'}; Undo on the toast`} onClick={() => actions.snooze(m.item!, m.title!)}>
          Move it
        </Button>
      ) : null}
    </p>
  );
}

// ---- Respond ----------------------------------------------------------------------------------------------------

/** The chip's words: "Reply to Dana · Send", "Post in #team · Send", "Reply to Marcus · Retry", "Draft: Answer Lee". */
export function chipText(c: Pick<HomeRespondChip, 'kind' | 'who' | 'verb'>): { lead: string; verb: string } {
  if (c.kind === 'reply') return { lead: c.who, verb: c.verb };
  return { lead: c.who.startsWith('#') ? `Post in ${c.who}` : `Reply to ${c.who}`, verb: c.verb };
}

const CHIP_TONE: Record<HomeRespondChip['state'], string> = {
  ready: 'border-ai-200 bg-ai-50 text-fg',
  failed: 'border-danger-200 bg-danger-50 text-fg',
  drafting: 'border-line bg-surface-muted text-muted',
  can_draft: 'border-line bg-surface text-fg',
};
const VERB_TONE: Record<HomeRespondChip['state'], string> = { ready: 'text-ai-700', failed: 'text-danger-700', drafting: 'text-muted', can_draft: 'text-link' };

/**
 * What the Respond line hides, said as "+N more" (01-ui-audit UI-3: a count above fewer chips read as a mismatch).
 * `fitting` is how many chips fit on the one line; past them the first click shows every chip the briefing sent,
 * and past those (the briefing sends at most five) the link goes to Work ▸ Asked of me, where every reply is.
 */
export function respondMore(count: number, chips: number, fitting: number, expanded: boolean): { n: number; to: 'expand' | 'work' } | null {
  if (!expanded && fitting < chips) return { n: count - fitting, to: 'expand' };
  if (count > chips) return { n: count - chips, to: 'work' };
  return null;
}

export function RespondStrip({ r }: { r: HomeRespond }) {
  const panel = useRightPanel();
  const listRef = useRef<HTMLUListElement>(null);
  const [fitting, setFitting] = useState(r.chips.length);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    const measure = () => {
      const items = [...ul.children] as HTMLElement[];
      const top = items[0]?.offsetTop ?? 0;
      setFitting(items.filter((li) => li.offsetTop === top).length);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(ul);
    return () => ro.disconnect();
  }, [r.chips.length]);
  if (!r.count) return null;
  const allFailed = r.failed > 0 && r.ready === 0 && r.chips.every((c) => c.kind !== 'draft' || c.state === 'failed');
  const open = (c: HomeRespondChip) => (c.kind === 'draft' ? navigate(c.href) : panel.openDetails({ kind: c.entity.kind, id: c.entity.id, label: c.entity.label ?? c.who }));
  const more = respondMore(r.count, r.chips.length, fitting, expanded);
  return (
    <section className="flex min-w-0 items-start gap-2" aria-labelledby="hm-respond" data-home-panel="respond" data-testid="home-respond">
      <h2 id="hm-respond" className="mr-1 shrink-0 py-0.5 text-body leading-7 font-bold text-fg-heading">
        Respond <span className="font-normal text-muted tabular-nums">{r.count}</span>
      </h2>
      {allFailed ? <span className="py-0.5 text-caption leading-7 text-danger-700">{r.failed === 1 ? 'The draft' : `All ${r.failed} drafts`} failed to send · Retry each in the Outbox.</span> : null}
      <ul ref={listRef} className={cn('flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-0.5', expanded ? null : 'h-8 overflow-hidden')} aria-label="Replies the app drafted or can draft">
        {r.chips.map((c) => {
          const t = chipText(c);
          return (
            <li key={c.id} className="shrink-0">
              <button
                type="button"
                className={cn('inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-caption hover:border-line-strong focus-visible:outline-2 focus-visible:outline-focus', CHIP_TONE[c.state])}
                data-chip-state={c.state}
                data-chip-kind={c.kind}
                title={c.text}
                onClick={() => open(c)}
              >
                {c.kind === 'draft' && c.state !== 'failed' ? (
                  <span aria-hidden className="text-ai-700">
                    ✦
                  </span>
                ) : null}
                <span className="min-w-0 truncate">{t.lead}</span>
                <span aria-hidden className="text-faint">
                  ·
                </span>
                <span className={cn('shrink-0 font-bold', VERB_TONE[c.state])}>{t.verb}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {more ? (
        <button
          type="button"
          className="shrink-0 py-0.5 text-caption leading-7 font-bold whitespace-nowrap text-link hover:underline"
          onClick={() => (more.to === 'expand' ? setExpanded(true) : navigate('/work?tab=asked_of_me'))}
          data-testid="home-respond-more"
          title={more.to === 'expand' ? 'Show every reply on this line' : 'Every reply waiting on you, on Work ▸ Asked of me'}
        >
          +{more.n} more{more.to === 'work' ? ' on Work' : ''}
        </button>
      ) : null}
      {r.review ? (
        <button type="button" className="ml-auto shrink-0 py-0.5 text-caption leading-7 font-bold whitespace-nowrap text-link hover:underline" onClick={() => navigate(r.review!.href)} data-testid="home-respond-review">
          {r.review.label} in the Outbox →
        </button>
      ) : null}
    </section>
  );
}

// ---- Coming builds ----------------------------------------------------------------------------------------------

export function ComingBuilds({ builds, actions }: { builds: HomeBuild[]; actions: Pick<HomeActions, 'run' | 'launching' | 'reviewLaunch'> }) {
  if (!builds.length) return null;
  // SEC-10: a build with a prepared prompt (or none yet: it is prepared on the click) shows Review prompt first
  const openIn = (b: HomeBuild) => {
    if (b.deepLink) return actions.reviewLaunch(b.deepLink, b.title);
    if (b.workItemId) actions.run({ label: 'Open in Claude', action: 'open_in_claude', href: null, targetId: b.workItemId }, { title: b.title });
  };
  const verb = (b: HomeBuild) => (!b.deepLink || needsReview(b.deepLink) ? REVIEW_PROMPT_LABEL : OPEN_IN_CLAUDE_LABEL);
  return (
    <section className="flex min-w-0 flex-col gap-1" aria-labelledby="hm-builds" data-home-panel="builds" data-testid="home-builds">
      <h2 id="hm-builds" className="text-body font-bold text-fg-heading">
        Coming builds <span className="font-normal text-muted tabular-nums">{builds.length}</span>
      </h2>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {builds.map((b) => (
          <li key={b.id} className="flex min-w-0 items-center gap-3 px-3 py-1.5" data-build-state={b.state}>
            <span aria-hidden className="text-ai-700">
              ✦
            </span>
            <span className="min-w-0 flex-1 truncate text-body text-fg" title={b.title}>
              {b.title}
            </span>
            {b.progressLabel ? <span className="hidden truncate text-caption text-muted sm:inline">{b.progressLabel}</span> : null}
            <span className={cn('shrink-0 text-caption tabular-nums', b.state === 'waiting_on_you' ? 'font-bold text-warning-700' : 'text-muted')}>{b.etaLabel}</span>
            {b.deepLink || b.workItemId ? (
              <Button variant="ghost" size="sm" disabled={!b.deepLink && actions.launching} onClick={() => openIn(b)} data-build-open={verb(b) === REVIEW_PROMPT_LABEL ? 'review' : 'open'}>
                {verb(b)}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Admin: one quiet row -----------------------------------------------------------------------------------------

export function AdminRow({ a }: { a: HomeAdmin }) {
  const [open, setOpen] = useState(false);
  const panel = useRightPanel();
  return (
    <section className="min-w-0" aria-label="Admin" data-home-panel="admin" data-testid="home-admin" data-admin-mode={a.mode}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-body text-muted hover:bg-surface-muted"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden className="text-faint">
          {open ? '▾' : '▸'}
        </span>
        <span className="min-w-0 truncate">{a.label}</span>
        {a.promoted ? <span className="shrink-0 text-caption text-warning-700">part of today</span> : null}
      </button>
      {open ? (
        <ul className="ml-5 flex flex-col gap-0.5 pb-1">
          {a.rows.map((r) => (
            <li key={r.id} className="flex min-w-0 items-baseline gap-2 text-caption">
              <button type="button" className="min-w-0 truncate text-left text-fg hover:underline" onClick={() => panel.openDetails({ kind: 'work_item', id: r.id, label: r.title })}>
                {r.title}
              </button>
              <span className="shrink-0 text-muted">{[r.kind, r.dueLabel].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---- the empty day ----------------------------------------------------------------------------------------------

/** HM-01: nothing to do: say what the app is watching, so an empty Home never reads as broken. */
export function watchingLine(watching: readonly string[]): string {
  if (!watching.length) return 'Nothing needs you right now. No source is connected yet: Health ▸ Setup connects them.';
  const list = watching.length === 1 ? watching[0]! : `${watching.slice(0, -1).join(', ')} and ${watching[watching.length - 1]}`;
  return `Nothing needs you right now. Watching ${list}; anything new lands here.`;
}
