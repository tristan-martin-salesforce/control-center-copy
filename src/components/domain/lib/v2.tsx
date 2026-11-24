'use client';
/**
 * Design v2 building blocks shared by every domain component (docs/archive/2026-build/DESIGN-V2.md):
 *  - Indicator: color is an indicator, never identity. now/selected = accent · overdue, blocked, expired =
 *    danger · at risk = warning · ready = success · AI = violet. One signal per row (edge + its badge).
 *  - StatusBadge: icon + word, only for things that need action.
 *  - AccountTag: accounts, initiatives and sources are neutral.
 *  - EffortNote: hands-on time first ("You ~20m"), agent time as a quiet violet note ("✦ agent ~20m in background").
 *  - hm(): "1h 30m" durations for v2 copy (the dense `dur()` stays "1h30m").
 *
 * Tokens: names from src/styles/brand.css only (the v2 set from brief 14 §6.2).
 */
import type { Tone, WorkItem } from '@/contract';
import type { ReactNode } from 'react';
import { cn, Icon, TONE_BADGE, TONE_DASHED } from '@/ui';
import { minutesBetween } from './time';

// ── durations ────────────────────────────────────────────────────────────────────────────────

/** 0 → "0m" · 20 → "20m" · 90 → "1h 30m" · 120 → "2h" · 2 days+ → "2d". */
export function hm(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  if (m >= 48 * 60) return `${Math.round(m / 1440)}d`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** "DO NOW" → "Do now" (v2 is sentence case; contract labels may still arrive in caps). */
export function sentence(label: string): string {
  if (label !== label.toUpperCase() || !/[A-Z]/.test(label)) return label;
  const lower = label.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ── indicator ────────────────────────────────────────────────────────────────────────────────

export type Indicator = 'now' | 'danger' | 'warning' | 'success' | 'ai' | 'none';

/** 3 px edge / dot fill. Neutral rows get the strong hairline so the edge column stays aligned. */
export const EDGE_BG: Record<Indicator, string> = {
  now: 'bg-accent',
  danger: 'bg-danger-500',
  warning: 'bg-warning-500',
  success: 'bg-success-500',
  ai: 'bg-ai-500',
  none: 'bg-line-strong',
};

/** Top edge for lead cards (follows the card's corner radius, like an inset rule). */
export const EDGE_TOP: Record<Indicator, string> = {
  now: 'shadow-[inset_0_3px_0_var(--color-accent)]',
  danger: 'shadow-[inset_0_3px_0_var(--color-danger-500)]',
  warning: 'shadow-[inset_0_3px_0_var(--color-warning-500)]',
  success: 'shadow-[inset_0_3px_0_var(--color-success-500)]',
  ai: 'shadow-[inset_0_3px_0_var(--color-ai-500)]',
  none: '',
};

export const INDICATOR_TEXT: Record<Indicator, string> = {
  now: 'text-link',
  danger: 'text-danger-700',
  warning: 'text-warning-700',
  success: 'text-success-700',
  ai: 'text-ai-700',
  none: 'text-muted',
};

/** Contract tones → v2 indicator roles. */
export const TONE_INDICATOR: Record<Tone, Indicator> = { ok: 'success', warn: 'warning', risk: 'danger', brand: 'now', neutral: 'none', ai: 'ai' };

/** Minutes before a start-by at which it counts as tight (amber). */
export const TIGHT_MIN = 60;

export interface IndicatorOpts {
  selected?: boolean;
  /** The page knows the item is blocked on someone else (e.g. an answer it needs). */
  blocked?: boolean;
  /** An AI draft is ready (untouched by the user). */
  drafted?: boolean;
}

type IndicatorItem = Pick<WorkItem, 'state' | 'startBy' | 'due' | 'isBackground' | 'reopened' | 'loopedBackIn' | 'training'>;

/**
 * The one state color an item carries. Danger beats selection (a late or blocked row stays red when
 * selected); selection beats everything else.
 */
export function itemIndicator(item: IndicatorItem, now: string, opts: IndicatorOpts = {}): Indicator {
  if (item.state === 'done' || item.state === 'dismissed') return opts.selected ? 'now' : 'none';
  // LD-1: a likely-done item waits for Confirm, so the clock no longer colors it.
  if (item.state === 'likely_done') return opts.selected ? 'now' : 'success';
  const at = item.startBy ?? item.due;
  const late = !!at && minutesBetween(now, at) < 0 && !item.isBackground;
  if (opts.blocked || late || item.training?.overdue) return 'danger';
  if (opts.selected) return 'now';
  if (item.state === 'suggested' || opts.drafted) return 'ai';
  if (item.reopened || item.loopedBackIn || item.state === 'reopened' || item.state === 'waiting_on_me') return 'warning';
  if (item.startBy && !item.isBackground && minutesBetween(now, item.startBy) <= TIGHT_MIN) return 'warning';
  return 'none';
}

// ── marks ────────────────────────────────────────────────────────────────────────────────────

export type BadgeTone = 'danger' | 'warning' | 'success' | 'ai' | 'now' | 'neutral';

/** Badge roles → the contract tones `@/ui` styles (TONE_BADGE / TONE_DASHED own the classes). */
const BADGE_TONE: Record<BadgeTone, Tone> = { danger: 'risk', warning: 'warn', success: 'ok', ai: 'ai', now: 'brand', neutral: 'neutral' };

/** Contract tone → badge role. */
export const TONE_TO_BADGE: Record<Tone, BadgeTone> = { ok: 'success', warn: 'warning', risk: 'danger', brand: 'now', neutral: 'neutral', ai: 'ai' };
export const INDICATOR_BADGE: Record<Indicator, BadgeTone> = { now: 'now', danger: 'danger', warning: 'warning', success: 'success', ai: 'ai', none: 'neutral' };

export interface StatusBadgeProps {
  tone: BadgeTone;
  /** SLDS utility icon name; `sparkle` renders the single ✦ used for AI. */
  icon?: string | 'sparkle';
  children: ReactNode;
  dashed?: boolean;
  title?: string;
  className?: string;
}

/**
 * Status = icon + word (color never alone). 24 px, 14 px bold. The `@/ui` StatePill look (same TONE_BADGE
 * classes), plus free-form children, the single ✦ for AI, and truncation inside narrow rows.
 */
export function StatusBadge({ tone, icon, children, dashed, title, className }: StatusBadgeProps) {
  const t = BADGE_TONE[tone];
  return (
    <span
      title={title}
      data-tone={t}
      className={cn(
        'inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2 text-caption font-bold leading-none',
        dashed ? TONE_DASHED[t] : TONE_BADGE[t],
        className,
      )}
    >
      {icon === 'sparkle' ? <span aria-hidden>✦</span> : icon ? <Icon name={icon} size="xs" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** "✦ Drafted for you": the AI marker, violet text, no box. */
export function AiMark({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-caption font-bold text-ai-700', className)}>
      <span aria-hidden>✦</span>
      {children}
    </span>
  );
}

export interface AccountTagProps {
  label: string;
  onOpen?: () => void;
  /** Plain: no box, muted text (dense meta lines). */
  plain?: boolean;
  title?: string;
  className?: string;
}

/** Neutral tag for accounts, initiatives and categories: identity is never a color. */
export function AccountTag({ label, onOpen, plain, title, className }: AccountTagProps) {
  const cls = cn(
    // a short tag ("ACME", "Outbox") never shrinks: in a squeezed card (Home with the panel open) it collapsed to an
    // empty box (01-ui-audit UI-12); a long one still truncates
    'inline-flex min-w-0 max-w-[16rem] items-center whitespace-nowrap text-caption',
    label.length <= 14 ? 'shrink-0' : 'shrink',
    plain ? 'text-muted' : 'h-6 rounded-sm border border-line-strong bg-surface-sunken px-2 font-bold text-fg',
    onOpen && 'hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:shadow-focus',
    className,
  );
  const body = <span className="truncate">{label}</span>;
  if (!onOpen)
    return (
      <span className={cls} title={title ?? label}>
        {body}
      </span>
    );
  return (
    <button
      type="button"
      className={cls}
      title={title ?? label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {body}
    </button>
  );
}

export interface EffortNoteProps {
  youMin: number;
  agentMin?: number | null;
  /** Spell out "in background" (wide layouts). */
  long?: boolean;
  /** Lower-case "you" when the note follows other text. */
  inline?: boolean;
  className?: string;
}

/** "You ~20m + ✦ agent ~20m in background": only your minutes count against the day. */
export function EffortNote({ youMin, agentMin, long = true, inline, className }: EffortNoteProps) {
  const agent = agentMin && agentMin > 0 ? agentMin : 0;
  return (
    <span className={cn('inline-flex min-w-0 items-baseline gap-1 whitespace-nowrap text-caption text-muted tabular-nums', className)} title={`Your hands-on time ~${hm(youMin)}${agent ? `; agent ~${hm(agent)} in the background (doesn't count against your day)` : ''}`}>
      {youMin > 0 || !agent ? (
        <span>
          {inline ? 'you' : 'You'} ~{hm(youMin)}
        </span>
      ) : null}
      {agent ? (
        <span className="min-w-0 truncate font-bold text-ai-700">
          {youMin > 0 ? <span className="font-normal text-muted">+ </span> : null}✦ agent ~{hm(agent)}
          {long ? <span className="font-bold"> in background</span> : null}
        </span>
      ) : null}
    </span>
  );
}

/** Surface for the #1 / raised card (brief 14 §6.2 `surface-raised`, L2). */
export const RAISED_BG = 'bg-surface-raised';
