'use client';
/**
 * Tabs and SegmentedToggle, v2 (mockup panel tabs `.dock-tab` and settings `.seg`).
 * - Tabs `variant="pill"` (default): bold muted labels; the selected tab is a `selected` surface with a heading-colour
 *   label. No 3 px Lightning underline. `variant="line"` keeps a subtle 2 px accent line for dense in-panel tab rows.
 * - SegmentedToggle: an input-well group; the checked segment is the selected tint with a 1 px accent ring.
 * Tabs render the tablist only; pair panels with `tabPanelProps(baseId, value)`.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';

export interface TabItem<V extends string = string> {
  value: V;
  label: string;
  count?: number;
  icon?: string;
  disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
  tabs: TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  /** md = page/panel tabs (16 px, 36 px targets); sm = in-panel tabs (14 px, 32 px targets). */
  size?: 'sm' | 'md';
  /** pill (default): selected surface · line: subtle 2 px accent line under the selected label. */
  variant?: 'pill' | 'line';
  label?: string;
  /** Prefix for tab/panel ids (use the same with tabPanelProps). */
  idBase?: string;
  className?: string;
  trailing?: ReactNode;
}

function rove<V extends string>(e: KeyboardEvent, tabs: TabItem<V>[], value: V, onChange: (v: V) => void, refs: (HTMLButtonElement | null)[]) {
  const enabled = tabs.filter((t) => !t.disabled);
  const i = enabled.findIndex((t) => t.value === value);
  let next = -1;
  if (e.key === 'ArrowRight') next = (i + 1) % enabled.length;
  else if (e.key === 'ArrowLeft') next = (i - 1 + enabled.length) % enabled.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = enabled.length - 1;
  if (next < 0) return;
  e.preventDefault();
  const v = enabled[next]!.value;
  onChange(v);
  refs[tabs.findIndex((t) => t.value === v)]?.focus();
}

export function Tabs<V extends string>({ tabs, value, onChange, size = 'md', variant = 'pill', label, idBase, className, trailing }: TabsProps<V>) {
  const auto = useId();
  const base = idBase ?? auto;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const pill = variant === 'pill';
  // aria-controls only names a panel that is on the page (tabPanelProps): a tab row that switches the route has none,
  // and an id that points nowhere is invalid ARIA (axe aria-valid-attr-value).
  const [panelShown, setPanelShown] = useState(false);
  useEffect(() => setPanelShown(!!document.getElementById(`${base}-panel-${value}`)), [base, value]);
  return (
    <div
      data-variant={variant}
      className={cn(
        'flex items-center border-b border-line',
        pill ? (size === 'md' ? 'h-14 gap-1 compact:h-12' : 'h-12 gap-1 compact:h-10') : size === 'md' ? 'h-12 compact:h-10' : 'h-10 compact:h-9',
        className,
      )}
    >
      <div
        role="tablist"
        aria-label={label}
        className={cn('flex min-w-0 gap-1 overflow-x-auto', pill ? 'items-center py-1' : 'items-stretch self-stretch')}
        onKeyDown={(e) => rove(e, tabs, value, onChange, refs.current)}
      >
        {tabs.map((t, i) => {
          const selected = t.value === value;
          return (
            <button
              key={t.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.value}`}
              aria-selected={selected}
              aria-controls={panelShown ? `${base}-panel-${t.value}` : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={t.disabled}
              onClick={() => onChange(t.value)}
              className={cn(
                'group relative inline-flex shrink-0 items-center gap-2 font-bold whitespace-nowrap transition-colors duration-(--dur-quick) focus-visible:outline-none',
                size === 'md' ? 'text-body' : 'text-caption',
                pill
                  ? cn('rounded-md px-3 focus-visible:shadow-focus', size === 'md' ? 'h-9 compact:h-8' : 'h-8 compact:h-7')
                  : 'px-2 focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)]',
                selected
                  ? pill
                    ? 'bg-selected text-fg-heading'
                    : 'text-fg-heading'
                  : pill
                    ? 'text-muted enabled:hover:bg-fg/8 enabled:hover:text-fg'
                    : 'text-muted enabled:hover:text-fg',
                t.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {t.icon ? <Icon name={t.icon} size="sm" /> : null}
              {t.label}
              {typeof t.count === 'number' ? (
                <span className={cn('font-normal tabular-nums', t.count > 0 ? 'text-muted' : 'text-faint')}>{t.count > 99 ? '99+' : t.count}</span>
              ) : null}
              {pill ? null : (
                <span aria-hidden className={cn('absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors', selected ? 'bg-accent' : 'bg-transparent group-hover:bg-line-strong')} />
              )}
            </button>
          );
        })}
      </div>
      {trailing ? <div className="ml-auto flex items-center gap-2 pl-3">{trailing}</div> : null}
    </div>
  );
}

export function tabPanelProps(idBase: string, value: string) {
  return { role: 'tabpanel' as const, id: `${idBase}-panel-${value}`, 'aria-labelledby': `${idBase}-tab-${value}`, tabIndex: 0 };
}

// ── SegmentedToggle ─────────────────────────────────────────────────────────────────────────

export interface SegmentOption<V extends string = string> {
  value: V;
  label: string;
  icon?: string;
  disabled?: boolean;
}

export interface SegmentedToggleProps<V extends string = string> {
  options: SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: 'xs' | 'sm' | 'md';
  label: string;
  className?: string;
  /** Stretch segments to fill the width. */
  block?: boolean;
}

/** Outer heights 28 · 32 · 40 px (the md one matches a 40 px input). */
const SEG_SIZE = {
  xs: 'h-7 text-caption',
  sm: 'h-8 text-caption',
  md: 'h-10 text-body',
} as const;

export function SegmentedToggle<V extends string>({ options, value, onChange, size = 'sm', label, className, block }: SegmentedToggleProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % enabled.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + enabled.length) % enabled.length;
    if (next < 0) return;
    e.preventDefault();
    const v = enabled[next]!.value;
    onChange(v);
    refs.current[options.findIndex((o) => o.value === v)]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('inline-flex items-stretch gap-0.5 rounded-md border border-line-input bg-surface-input p-0.5', block && 'flex w-full', SEG_SIZE[size], className)}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:shadow-focus',
              size === 'md' ? 'px-3.5' : 'px-2.5',
              block && 'flex-1',
              checked ? 'bg-selected font-bold text-fg-heading shadow-[inset_0_0_0_1px_var(--color-accent)]' : 'text-muted enabled:hover:bg-fg/8 enabled:hover:text-fg',
              o.disabled && 'cursor-not-allowed text-disabled line-through',
            )}
          >
            {o.icon ? <Icon name={o.icon} size="sm" /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
