'use client';
/**
 * The frame the context pages share (Deals, Briefs, Time; lane P-CONTEXT-A), design v2 (docs/archive/2026-build/DESIGN-V2.md):
 *
 *   ContextPage      the page: a head plus panes that fill #cc-main. The page itself never scrolls; long lists
 *                    scroll inside their pane. Layouts condense with `@container main` queries, so a docked
 *                    right panel (#cc-main[data-panel="open"]) gives one consistent "with panel" layout.
 *   ContextHead      one 18 px sentence (what the page says right now), nouns as line tabs, quiet actions. The
 *                    shell's topbar holds the page's h1; the head hands it a better title when it has one.
 *   Pane             an L1 surface with a hairline; its body scrolls on its own (`scrollbar-gutter: stable`).
 *   SectionHead      a verb-named section ("Log & fix 4") with an optional batch action on the right.
 *   ContextRow       two lines: title + one muted why line; the row's verb is quiet text and becomes the one
 *                    filled button only when the row is selected (or it is the #1 item and nothing is selected).
 *   useContextKeys   j/k move the selection, Enter opens Details in the docked panel, Esc closes it.
 *
 * Detail never opens in a page-owned sheet: rows call useRightPanel().openDetails({kind, id, label}).
 * `window.__ccOpenDetails` sees every request first (the smoke tests' spy, the same seam Home and Today use).
 */
import { createContext, forwardRef, useCallback, useContext, useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { useKeyBinding, useKeyScope } from '@/client/keyboard';
import { usePageTitle, useRightPanel, type PanelEntity } from '@/components/shell';
import { titleOf } from '@/lib/node-text';
import { cn, RowVerb, type ListRowAction } from '@/ui';
import './context.css';

// ── Details ────────────────────────────────────────────────────────────────────────────────

/** Test seam (Playwright): `window.__ccOpenDetails` sees every openDetails call before the panel does. */
export function notifyDetailsSpy(e: PanelEntity) {
  if (typeof window === 'undefined') return;
  const spy = (window as { __ccOpenDetails?: (e: PanelEntity) => void }).__ccOpenDetails;
  if (spy) spy(e);
}

/** openDetails with the spy, plus "is this entity the one open in Details?" for the quiet-verb rule. */
export function useDetails() {
  const panel = useRightPanel();
  const open = useCallback(
    (e: PanelEntity) => {
      notifyDetailsSpy(e);
      panel.openDetails(e);
    },
    [panel],
  );
  const openId = panel.open && panel.tab === 'details' ? (panel.entity?.id ?? null) : null;
  return { open, openId, panel };
}

// ── Width ──────────────────────────────────────────────────────────────────────────────────

/** The width of #cc-main (the `main` container), for layouts that change what they render, not only how. */
export function useMainWidth(fallback = 1600): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = document.getElementById('cc-main');
    if (!el) return;
    const update = () => setW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

// ── Layout ─────────────────────────────────────────────────────────────────────────────────

export function ContextPage({ children, className, label, ...rest }: { children: ReactNode; className?: string; label: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-context-page=""
      aria-label={label}
      className={cn('flex h-full min-h-0 flex-col gap-5 px-8 pt-6 pb-4 text-body text-fg tabular-nums @max-[1100px]/main:gap-4 @max-[1100px]/main:px-5 @max-[1100px]/main:pt-4', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface ContextHeadProps {
  /** The topbar title (string titles replace the route's default, e.g. an account's name). */
  title: ReactNode;
  /** One sentence: what this page says right now. */
  sentence?: ReactNode;
  /** A small line above the title (breadcrumb). Sentence case, never an eyebrow. */
  crumb?: ReactNode;
  /** Noun tabs (<Tabs variant="line">). */
  tabs?: ReactNode;
  /** Quiet actions on the right; at most one filled button on the whole page. */
  actions?: ReactNode;
  className?: string;
}

export function ContextHead({ title, sentence, crumb, tabs, actions, className }: ContextHeadProps) {
  // The shell's topbar is the page's h1; a page that knows a better name (an account) puts it there.
  usePageTitle(typeof title === 'string' ? title : null);
  return (
    <header className={cn('flex shrink-0 flex-col gap-3', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1">
          {crumb ? <div className="mb-1 text-caption text-muted">{crumb}</div> : null}
          {sentence ? <p className="max-w-[110ch] text-body-lg text-muted">{sentence}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {tabs}
    </header>
  );
}

export interface PaneProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  /** Header row (a SectionHead) that stays put while the body scrolls. */
  head?: ReactNode;
  /** Body scrolls inside the pane (default true). */
  scroll?: boolean;
  bodyClassName?: string;
  bodyRef?: RefObject<HTMLDivElement | null>;
  as?: 'section' | 'aside' | 'div';
}

export function Pane({ children, head, scroll = true, className, bodyClassName, bodyRef, as: Tag = 'section', ...rest }: PaneProps) {
  return (
    <Tag className={cn('flex min-h-0 min-w-0 flex-col rounded-lg border border-line bg-surface', className)} {...rest}>
      {head ? <div className="shrink-0">{head}</div> : null}
      <div ref={bodyRef} className={cn('min-h-0 flex-1', scroll && 'cc-scroll overflow-y-auto [scrollbar-gutter:stable]', bodyClassName)}>
        {children}
      </div>
    </Tag>
  );
}

export interface SectionHeadProps {
  /** A verb ("Log & fix", "Think ahead", "Claim") or, for a reference list, a noun ("Accounts"). */
  title: string;
  count?: number;
  /** Faint text after the count ("next 45 days"). */
  sub?: ReactNode;
  /** Batch action on the right (quiet). */
  action?: ReactNode;
  id?: string;
  className?: string;
  level?: 2 | 3;
}

export function SectionHead({ title, count, sub, action, id, className, level = 2 }: SectionHeadProps) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className={cn('flex min-h-12 min-w-0 items-center gap-2 px-5 pt-3 pb-1', className)}>
      <H id={id} className={cn('shrink-0 font-bold whitespace-nowrap text-fg-heading', level === 2 ? 'text-lead' : 'text-body-lg')}>
        {title}
      </H>
      {count !== undefined ? <span className="shrink-0 text-body text-muted tabular-nums">{count}</span> : null}
      {sub ? <span className="min-w-0 truncate text-caption text-muted">{sub}</span> : null}
      {action ? <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1">{action}</span> : null}
    </div>
  );
}

/** A muted one-liner for a section that has nothing in it (sections usually just disappear). */
export function QuietLine({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('px-5 py-3 text-body text-muted', className)}>{children}</p>;
}

// ── Row ────────────────────────────────────────────────────────────────────────────────────

export type Edge = 'now' | 'danger' | 'warning' | 'success' | 'ai' | 'none';

const EDGE: Record<Edge, string> = {
  now: 'bg-accent',
  danger: 'bg-danger-500',
  warning: 'bg-warning-500',
  success: 'bg-success-500',
  ai: 'bg-ai-500',
  none: 'bg-transparent',
};

export interface ContextRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  rowId: string;
  title: ReactNode;
  /** The one muted why line. */
  why?: ReactNode;
  /** A second muted line that never truncates (a DC request's lock reason): what the row can't do, and why. */
  note?: ReactNode;
  /** Right of the title: quiet facts (amount, close date). */
  meta?: ReactNode;
  /** A status badge (icon + word), only when the row needs you. */
  badge?: ReactNode;
  /** Extra lines under the why line (notes, a draft). */
  below?: ReactNode;
  /** Leading control (a checkbox). */
  lead?: ReactNode;
  /** The row's verb. */
  verb?: ListRowAction;
  /** Snooze / dismiss / not now: shown on hover, focus or selection. */
  secondary?: ReactNode;
  /** One color signal per row: the 3 px edge. */
  edge?: Edge;
  selected?: boolean;
  /** The #1 item: its verb is filled while nothing else is selected. */
  emphasized?: boolean;
  /** Open in the docked panel: the panel footer owns the filled button, so the verb stays quiet. */
  inPanel?: boolean;
  dimmed?: boolean;
  /** Larger title (focal sections). */
  size?: 'md' | 'lg';
}

/**
 * Live updates (docs/UX.md "Live updates"): a page wraps its rows in <LiveRows value={live.liveOf}> and every
 * ContextRow inside marks itself (arrived, leaving, gone) by its rowId. One mechanism for Deals, Briefs, History…
 */
const LiveRowsCtx = createContext<((rowId: string) => 'new' | 'leaving' | 'gone' | undefined) | null>(null);
export function LiveRows({ value, children }: { value: (rowId: string) => 'new' | 'leaving' | 'gone' | undefined; children: ReactNode }) {
  return <LiveRowsCtx.Provider value={value}>{children}</LiveRowsCtx.Provider>;
}

export const ContextRow = forwardRef<HTMLDivElement, ContextRowProps>(function ContextRow(
  { rowId, title, why, note, meta, badge, below, lead, verb, secondary, edge = 'none', selected, emphasized, inPanel, dimmed, size = 'md', className, ...rest },
  ref,
) {
  const filled = Boolean((selected || emphasized) && !inPanel);
  const liveOf = useContext(LiveRowsCtx);
  return (
    <div
      ref={ref}
      role="listitem"
      data-crow=""
      data-row-id={rowId}
      data-live={liveOf?.(rowId)}
      data-selected={selected ? '' : undefined}
      data-in-panel={inPanel ? '' : undefined}
      tabIndex={selected || emphasized ? 0 : -1}
      className={cn(
        'group/crow relative mx-2 flex min-w-0 cursor-pointer gap-3 rounded-md py-3 pr-3 pl-4 outline-none',
        'focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)]',
        selected ? 'bg-selected' : 'hover:bg-surface-muted',
        dimmed && 'opacity-70',
        className,
      )}
      {...rest}
    >
      <span aria-hidden className={cn('absolute inset-y-3 left-1 w-[3px] rounded-full', EDGE[selected && edge === 'none' ? 'now' : edge])} />
      {lead ? <div className="shrink-0 pt-0.5">{lead}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-3">
          {/* 2026-11-13 audit C5: a truncated title or why line shows in full on hover */}
          <div className={cn('min-w-0 flex-1 truncate font-bold text-fg-heading', size === 'lg' ? 'text-lead' : 'text-body-lg')} title={titleOf(title)}>
            {title}
          </div>
          {meta ? <div className="flex shrink-0 items-baseline gap-3 text-caption whitespace-nowrap text-muted tabular-nums">{meta}</div> : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          {badge ? <span className="shrink-0">{badge}</span> : null}
          {why ? (
            <div className="min-w-0 flex-1 truncate text-body text-muted" title={titleOf(why)}>
              {why}
            </div>
          ) : (
            <div className="flex-1" />
          )}
          {secondary || verb ? (
            <div className="relative flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
              {secondary ? (
                <div
                  data-row-secondary=""
                  className={cn('items-center gap-0.5', selected ? 'flex' : 'hidden group-hover/crow:flex group-focus-within/crow:flex')}
                >
                  {secondary}
                </div>
              ) : null}
              {verb ? <RowVerb action={verb} filled={filled} /> : null}
            </div>
          ) : null}
        </div>
        {note ? (
          <div className="mt-0.5 min-w-0 text-caption break-words text-muted" data-row-note="">
            {note}
          </div>
        ) : null}
        {below}
      </div>
    </div>
  );
});

// ── Keys ───────────────────────────────────────────────────────────────────────────────────

const cssEscape = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/"/g, '\\"'));

/** Focus is on a control inside a row (its own Enter/Space must win), not on the row itself. */
export function onOwnControl(): boolean {
  const el = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  if (!el || el === document.body) return false;
  if (el.hasAttribute('data-row-id')) return false;
  return el.matches('button,a,input,textarea,select,summary,[role="radio"],[role="checkbox"],[role="tab"]');
}

export interface ContextKeysOptions {
  scope: string;
  rootRef: RefObject<HTMLElement | null>;
  ids: string[];
  selected: string | null;
  setSelected: (id: string | null) => void;
  /** Enter: open Details for the selection. */
  onOpen?: (id: string) => void;
  /** ⌘↵: the selection's verb. */
  onPrimary?: (id: string) => void;
  /** ⇧Enter: the selection's full page. */
  onOpenPage?: (id: string) => void;
  /** Single-key verbs on the selection (a, n, x, p, t, o, space…). */
  actions?: Record<string, (id: string) => void>;
  /** While Details is open, j/k retarget it to the new selection (default true). */
  followPanel?: boolean;
  enabled?: boolean;
  /** Live while nothing has focus (the page's main list). Default true; a second list on the page passes false. */
  primary?: boolean;
  /** Esc with focus inside: return false to fall through to closing the panel / clearing the selection. */
  onEscape?: () => boolean | void;
}

/**
 * j/k (and ↓/↑) move the selection, Enter opens Details, ⌘↵ runs the verb. Esc: the shell closes an open panel
 * (and restores focus to the row); with no panel open, Esc clears the selection. Live while focus is inside `rootRef`, or nowhere (body).
 */
export function useContextKeys(o: ContextKeysOptions) {
  const { scope, rootRef, enabled = true, followPanel = true, primary = true } = o;
  const { panel } = useDetails();
  const [focus, setFocus] = useState<'body' | 'inside' | 'panel' | 'outside'>('body');
  const latest = useRef(o);
  latest.current = o;

  useEffect(() => {
    const up = () => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) setFocus('body');
      else setFocus(rootRef.current?.contains(el) ? 'inside' : el.closest('#cc-sheet-host,#cc-detail-dock,[data-cc-panel],aside[aria-label="Details and assistant"]') ? 'panel' : 'outside');
    };
    const later = () => setTimeout(up, 0);
    up();
    document.addEventListener('focusin', up);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', up);
      document.removeEventListener('focusout', later);
    };
  }, [rootRef]);

  const live = enabled && (focus === 'inside' || (primary && (focus === 'body' || focus === 'panel')));
  useKeyScope(scope, { active: live });
  const kopts = { scope, enabled: live };

  const focusRow = useCallback(
    (id: string) => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-row-id="${cssEscape(id)}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest' });
    },
    [rootRef],
  );

  const move = useCallback(
    (delta: number) => {
      const list = latest.current.ids;
      if (!list.length) return false;
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
      const cur = focused && list.includes(focused) ? focused : latest.current.selected;
      const i = cur ? list.indexOf(cur) : -1;
      const next = list[i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + delta))]!;
      latest.current.setSelected(next);
      requestAnimationFrame(() => focusRow(next));
      if (followPanel && panel.open && panel.tab === 'details' && latest.current.onOpen) latest.current.onOpen(next);
    },
    [focusRow, followPanel, panel.open, panel.tab],
  );

  const target = () => {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
    const id = focused && latest.current.ids.includes(focused) ? focused : latest.current.selected;
    return id && latest.current.ids.includes(id) ? id : null;
  };

  useKeyBinding(['j', 'down'], () => move(1), kopts);
  useKeyBinding(['k', 'up'], () => move(-1), kopts);
  useKeyBinding(
    'enter',
    () => {
      if (onOwnControl()) return false;
      const id = target();
      if (!id || !latest.current.onOpen) return false;
      latest.current.setSelected(id);
      latest.current.onOpen(id);
    },
    kopts,
  );
  useKeyBinding(
    'shift+enter',
    () => {
      if (onOwnControl()) return false;
      const id = target();
      if (!id || !latest.current.onOpenPage) return false;
      latest.current.onOpenPage(id);
    },
    kopts,
  );
  useKeyBinding(
    'mod+enter',
    () => {
      const id = target();
      if (!id || !latest.current.onPrimary) return false;
      latest.current.onPrimary(id);
    },
    kopts,
  );
  const verbKeys = Object.keys(o.actions ?? {});
  useKeyBinding(
    verbKeys.length ? verbKeys : ['__none__'],
    (e) => {
      if (onOwnControl()) return false;
      const id = target();
      const fn = latest.current.actions?.[e.key === ' ' ? 'space' : e.key.toLowerCase()];
      if (!id || !fn) return false;
      fn(id);
    },
    { ...kopts, enabled: live && verbKeys.length > 0 },
  );
  useKeyBinding(
    'escape',
    () => {
      // An open panel is the shell's to close (it puts focus back on the row that opened it).
      if (panel.open) return false;
      if (latest.current.onEscape && focus === 'inside' && latest.current.onEscape() !== false) return;
      if (latest.current.selected) {
        latest.current.setSelected(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      }
      return false;
    },
    kopts,
  );

  return { move, focusRow, live };
}
