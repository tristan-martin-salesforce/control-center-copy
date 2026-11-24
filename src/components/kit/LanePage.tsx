'use client';
/**
 * LanePage: the two-column page frame for dense pages (docs/reviews/2026-11-23-activity-ux/01-activity-at-scale.md
 * AX-8, §3.1, §3.2, §3.4 "Layout switch"). Activity's To log first, then VDP, Inbox and Work.
 *
 *   Two columns (panel closed, main ≥ 1,100 px)          One column (panel open, or main narrower)
 *   ┌ 1 Fix · 36 [Accept 21] ┬ 2 Ready · 11 [Log 11] ┐   [Fix 36] [Ready 11] [Sending 2]   ← lane pills
 *   │ rows…                  │ rows…                  │   ▾ Fix · 36 [Accept 21]   rows…
 *   │                        ├ 3 Sending · ▲ 2 failed │   ▸ Ready · 11 [Log 11]    (collapsed: header line only)
 *   │                        │ rows…                  │   ▸ Sending · ▲ 2 failed
 *
 * The switch is `#cc-main[data-panel="closed"]` (the shell's one right panel, shared by Details and the Assistant:
 * shell/AppFrame.tsx) AND the `main` container at least LANE_TWO_COLUMN_MIN wide. The columns are pure CSS (a
 * container query plus the attribute, TWO_COL below), so there is no flash on load; `useLaneColumns` mirrors the same
 * rule in JS for what CSS cannot do (the pills exist only in one column; `data-columns` on the frame).
 *
 * Lanes: `span` puts a lane in the left or right column (default: the first lane left, the rest right, stacked).
 * `collapsed` lanes (no work) show their header line only in one column; a pill or the header's chevron opens them.
 * In two columns every lane is open. Headers are sticky (#cc-main scrolls) and hold no focus trap.
 * Tailwind and tokens only (docs/UX.md "Component kit"); no per-page CSS.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/ui';

/** The main area's width (px) from which the frame shows two columns, when the right panel is closed. */
export const LANE_TWO_COLUMN_MIN = 1100;

/** The two-column variant: `#cc-main[data-panel=closed]` and the `main` container ≥ 1,100 px (keep in step above). */
const TWO_COL = {
  frame:
    '[#cc-main[data-panel=closed]_&]:@min-[1100px]/main:grid [#cc-main[data-panel=closed]_&]:@min-[1100px]/main:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] [#cc-main[data-panel=closed]_&]:@min-[1100px]/main:items-start [#cc-main[data-panel=closed]_&]:@min-[1100px]/main:gap-6',
  col: '[#cc-main[data-panel=closed]_&]:@min-[1100px]/main:flex',
  hidden: '[#cc-main[data-panel=closed]_&]:@min-[1100px]/main:hidden',
};

export interface LaneHeader {
  /** The lane's name ("Fix or approve"); its heading and its pill. */
  title: string;
  /** One number for the lane (the pill repeats it). */
  count?: number | string;
  /** The lane's one primary button. */
  action?: ReactNode;
  /** A failure mark's plain words ("2 not found"); shows as a red ▲ and stays visible when collapsed. */
  failure?: string;
}

export interface Lane {
  id: string;
  header: LaneHeader;
  body: ReactNode;
  /** No work: in one column the lane shows its header line only until opened. */
  collapsed?: boolean;
  /** The column in two-column mode (default: the first lane left, the rest right). */
  span?: 'left' | 'right';
}

export interface LanePageProps {
  lanes: Lane[];
  /** The pills' name for screen readers (default "Lanes"). */
  label?: string;
  className?: string;
}

/** 1 or 2: the same rule as the CSS switch, read from the frame's #cc-main (1 outside the app frame). */
export function laneColumns(main: HTMLElement | null): 1 | 2 {
  if (!main) return 1;
  return main.getAttribute('data-panel') === 'closed' && main.clientWidth >= LANE_TWO_COLUMN_MIN ? 2 : 1;
}

/** Follows #cc-main's data-panel and width. Starts at 1 (the server render); the layout effect corrects it before paint. */
export function useLaneColumns(ref: RefObject<HTMLElement | null>): 1 | 2 {
  const [cols, setCols] = useState<1 | 2>(1);
  useLayoutEffect(() => {
    const main = ref.current?.closest<HTMLElement>('#cc-main') ?? null;
    const update = () => setCols(laneColumns(main));
    update();
    if (!main) return;
    const mo = new MutationObserver(update);
    mo.observe(main, { attributes: true, attributeFilter: ['data-panel'] });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(main);
    window.addEventListener('resize', update);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [ref]);
  return cols;
}

/**
 * Chrome drops the rows of an open lane when the panel toggle flips the layout: the `#cc-main[data-panel]` attribute
 * changes the frame (grid ↔ flex) and the columns (flex ↔ contents), and the rows inside each lane body, a size
 * container (`@container/lane`), are left with no boxes (R3-1: one column, every lane 0 px). A width change that flips
 * the same rule is fine. So after each switch, each body is taken out of layout and put back, which rebuilds its rows.
 */
function useRelayoutOnSwitch(ref: RefObject<HTMLElement | null>, cols: 1 | 2) {
  const last = useRef(cols);
  useLayoutEffect(() => {
    if (last.current === cols) return;
    last.current = cols;
    for (const body of ref.current?.querySelectorAll<HTMLElement>('[data-lane-body]') ?? []) {
      const prior = body.style.display;
      body.style.display = 'none';
      void body.offsetHeight; // the broken layout happens here
      body.style.display = prior;
    }
  }, [ref, cols]);
}

const laneDom = (id: string) => ({ anchor: `lane-${id}`, title: `lane-${id}-title`, body: `lane-${id}-body` });

export function LanePage({ lanes, label = 'Lanes', className }: LanePageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cols = useLaneColumns(ref);
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const [jump, setJump] = useState<{ id: string; n: number } | null>(null);
  const isOpen = (l: Lane) => openState[l.id] ?? !l.collapsed;
  const toggle = useCallback((id: string, open: boolean) => setOpenState((s) => ({ ...s, [id]: open })), []);
  useRelayoutOnSwitch(ref, cols);

  // A pill opens its lane, then (after that render) scrolls to it and moves focus to its heading.
  useEffect(() => {
    if (!jump) return;
    const d = laneDom(jump.id);
    document.getElementById(d.anchor)?.scrollIntoView?.({ block: 'start' });
    document.getElementById(d.title)?.focus({ preventScroll: true });
  }, [jump]);

  const side = (l: Lane, i: number) => l.span ?? (i === 0 ? 'left' : 'right');
  const render = (l: Lane, i: number) => <LaneSection key={l.id} lane={l} order={i} open={isOpen(l)} cols={cols} onToggle={toggle} />;
  const column = (which: 'left' | 'right') => (
    <div data-lane-column={which} className={cn('contents', TWO_COL.col, 'min-w-0 flex-col gap-4')}>
      {lanes.map((l, i) => (side(l, i) === which ? render(l, i) : null))}
    </div>
  );

  return (
    <div
      ref={ref}
      data-lane-page
      data-columns={cols}
      className={cn('flex min-w-0 flex-col gap-4', TWO_COL.frame, className)}
    >
      {cols === 1 ? (
        <nav aria-label={label} data-lane-pills className={cn('order-[-1] flex flex-wrap gap-2', TWO_COL.hidden)}>
          {lanes.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-controls={laneDom(l.id).anchor}
              onClick={() => {
                toggle(l.id, true);
                setJump((j) => ({ id: l.id, n: (j?.n ?? 0) + 1 }));
              }}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-body text-fg hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus"
            >
              <span>{l.header.title}</span>
              {l.header.count !== undefined ? <span className="font-bold tabular-nums text-fg-heading">{l.header.count}</span> : null}
              {l.header.failure ? (
                <>
                  <span aria-hidden className="text-danger-700">
                    ▲
                  </span>
                  <span className="sr-only">, {l.header.failure}</span>
                </>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}
      {column('left')}
      {column('right')}
    </div>
  );
}

function LaneSection({ lane, order, open, cols, onToggle }: { lane: Lane; order: number; open: boolean; cols: 1 | 2; onToggle: (id: string, open: boolean) => void }) {
  const d = laneDom(lane.id);
  const { title, count, action, failure } = lane.header;
  const shut = !open; // hidden in one column; TWO_COL.col shows it again in two
  return (
    <section
      id={d.anchor}
      aria-labelledby={d.title}
      data-lane={lane.id}
      data-collapsed={cols === 1 && shut ? 'true' : undefined}
      style={{ order }}
      className="min-w-0 scroll-mt-2 rounded-lg border border-line bg-surface"
    >
      <div className="sticky top-0 z-[1] flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-t-lg border-b border-line bg-surface px-4 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={d.body}
          aria-label={`${open ? 'Hide' : 'Show'} ${title}`}
          onClick={() => onToggle(lane.id, !open)}
          className={cn('-ml-1 grid size-6 place-items-center rounded text-muted hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus', TWO_COL.hidden)}
        >
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </button>
        <h2 id={d.title} tabIndex={-1} className="text-body-lg font-bold text-fg-heading focus:outline-none">
          {title}
        </h2>
        {count !== undefined ? <span className="text-body font-bold tabular-nums text-muted">{count}</span> : null}
        {failure ? (
          <span className="inline-flex items-center gap-1 text-body text-danger-700" data-lane-failure>
            <span aria-hidden>▲</span>
            {failure}
          </span>
        ) : null}
        {action ? <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div id={d.body} data-lane-body className={cn(shut ? cn('hidden', TWO_COL.col) : 'flex', '@container/lane min-w-0 flex-col')}>
        {lane.body}
      </div>
    </section>
  );
}
