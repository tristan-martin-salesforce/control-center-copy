'use client';
/**
 * v2 buttons (DESIGN-V2 "quiet actions, loud selection"; mockup cc.css `.btn`): rounded-md, bold, never pill.
 * Variants:
 * - primary: the ONE filled accent per view region (bg-accent + on-accent bold label);
 * - secondary: hairline outline, neutral label;
 * - quiet: text-only in the link colour (a row's verb until the row is selected); `ghost` is a v1 alias;
 * - danger: destructive confirm (danger-600 + on-solid);
 * - ai: agentic gradient border + one sparkle (AI Run/Apply only).
 * Sizes: xs 28 · sm 32 · md 36 px (compact density: 24 · 28 · 32).
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';
import { Icon, type IconSet } from './Icon';
import { useIsMac } from '@/client/keyboard/KeyboardProvider';
import { ariaKeyShortcuts, KbdHint } from './Kbd';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'ghost' | 'danger' | 'ai';
export type ButtonSize = 'xs' | 'sm' | 'md';

const BASE =
  'relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md border font-bold ' +
  'transition-[background-color,box-shadow,color,border-color] duration-(--dur-quick) ' +
  'focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress aria-busy:opacity-100';

// Border colour lives on the variant (never in BASE): two border-colour utilities on one element resolve by CSS order.
const QUIET = 'border-transparent text-link enabled:hover:bg-fg/8 enabled:active:bg-fg/12';

const VARIANT: Record<ButtonVariant, string> = {
  // `bg-brand-600` is a v1 compat marker only (a test selects `button.bg-brand-600` as "the primary"; prefer
  // `[data-variant="primary"]`). The fill comes from enabled:/disabled: accent classes, which win on specificity.
  primary: 'border-transparent bg-brand-600 enabled:bg-accent disabled:bg-accent text-on-accent enabled:hover:bg-accent-hover',
  secondary: 'border-line-strong bg-surface text-fg enabled:hover:border-line-input enabled:hover:bg-surface-muted enabled:active:bg-surface-sunken',
  quiet: QUIET,
  ghost: QUIET,
  danger: 'border-transparent bg-danger-600 text-on-solid enabled:hover:bg-danger-700',
  ai: 'border-agentic text-fg enabled:hover:shadow-[0_0_8px_2px_color-mix(in_oklab,var(--color-ai-500),transparent_80%)]',
};

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-7 text-caption compact:h-6',
  sm: 'h-8 text-caption compact:h-7',
  md: 'h-9 text-body compact:h-8',
};

/** Quiet buttons sit tighter (they read as text, mockup `.btn.quiet`). */
const PAD: Record<'filled' | 'quiet', Record<ButtonSize, string>> = {
  filled: { xs: 'px-2.5', sm: 'px-3', md: 'px-3.5' },
  quiet: { xs: 'px-2', sm: 'px-2', md: 'px-2.5' },
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Key spec shown as a hint inside the button ("mod+enter" → ⌘↵). Display only. */
  kbd?: string;
  loading?: boolean;
  /** Leading utility icon name (or { set, name }). The ai variant always leads with one sparkle. */
  icon?: string | { set: IconSet; name: string };
  iconRight?: string;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', kbd, loading = false, icon, iconRight, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const lead = variant === 'ai' ? { set: 'utility' as const, name: 'sparkles' } : typeof icon === 'string' ? { set: 'utility' as const, name: icon } : icon;
  const iconSize = size === 'md' ? 'md' : 'sm';
  const filled = variant === 'primary' || variant === 'danger';
  const quiet = variant === 'quiet' || variant === 'ghost';
  const isMac = useIsMac();
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      // the key caps are seen, the shortcut is announced from here (the name stays the visible label, WCAG 2.5.3)
      aria-keyshortcuts={kbd ? ariaKeyShortcuts(kbd, isMac) : undefined}
      data-variant={variant === 'ghost' ? 'quiet' : variant}
      className={cn(BASE, VARIANT[variant], SIZE[size], PAD[quiet ? 'quiet' : 'filled'][size], className)}
      {...rest}
    >
      {loading ? (
        <Spinner size={iconSize} />
      ) : lead ? (
        <Icon set={lead.set} name={lead.name} size={iconSize} className={variant === 'ai' ? 'text-ai-700' : undefined} />
      ) : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={iconSize} /> : null}
      {kbd ? <KbdHint combo={kbd} decorative tone={filled ? 'inverse' : 'quiet'} className="-mr-1 ml-0.5 font-normal" /> : null}
    </button>
  );
});

export type IconButtonVariant = 'ghost' | 'quiet' | 'outline' | 'solid' | 'header';

const ICON_QUIET = 'text-muted enabled:hover:bg-fg/8 enabled:hover:text-fg enabled:active:bg-fg/12';

const ICON_VARIANT: Record<IconButtonVariant, string> = {
  ghost: ICON_QUIET,
  quiet: ICON_QUIET,
  header: `${ICON_QUIET} aria-expanded:bg-selected aria-expanded:text-fg-heading`,
  outline: 'border border-line-strong bg-surface text-muted enabled:hover:border-line-input enabled:hover:bg-surface-muted enabled:hover:text-fg',
  solid: 'bg-accent text-on-accent enabled:hover:bg-accent-hover',
};

const ICON_SIZE: Record<ButtonSize, { box: string; icon: 'xs' | 'sm' | 'md' | 'lg' }> = {
  xs: { box: 'size-7 compact:size-6', icon: 'sm' },
  sm: { box: 'size-8 compact:size-7', icon: 'md' },
  md: { box: 'size-9 compact:size-8', icon: 'md' },
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: string | { set: IconSet; name: string };
  /** Accessible name (required); also the default tooltip text via `title`. */
  label: string;
  size?: ButtonSize;
  variant?: IconButtonVariant;
  /** Count badge (number) or new-activity dot (true). */
  badge?: number | boolean;
  /** Toggle state for toggle buttons. */
  pressed?: boolean;
  iconSize?: 'xs' | 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', variant = 'ghost', badge, pressed, iconSize, loading, className, type = 'button', disabled, ...rest },
  ref,
) {
  const glyph = typeof icon === 'string' ? { set: 'utility' as const, name: icon } : icon;
  const s = ICON_SIZE[size];
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled || loading}
      className={cn(
        'relative inline-grid shrink-0 place-items-center rounded-md transition-colors duration-(--dur-quick) focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
        // Pressed replaces the variant's colours (two text-colour utilities would resolve by CSS order).
        pressed ? 'bg-selected text-fg-heading' : ICON_VARIANT[variant],
        s.box,
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={iconSize ?? s.icon} /> : <Icon set={glyph.set} name={glyph.name} size={iconSize ?? s.icon} />}
      {typeof badge === 'number' && badge > 0 ? (
        <span className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-danger-600 px-1 text-micro font-bold text-on-solid ring-2 ring-surface tabular-nums">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : badge === true ? (
        <span className="absolute top-1 right-1 size-2 rounded-full bg-danger-500 ring-2 ring-surface" />
      ) : null}
    </button>
  );
});
