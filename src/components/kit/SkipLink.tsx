'use client';
/**
 * SkipLink: the first tab stop of the frame (WCAG 2.4.1). Hidden until it has focus, then a pill over the sidebar.
 * Enter moves focus into the page: its first row or control (so the page's keyboard model, j/k and the row keys, is
 * live at once), else the main landmark itself (`tabIndex={-1}` on #cc-main).
 */
import type { MouseEvent } from 'react';
import { cn } from '@/ui/cn';

const FIRST_STOP = '[data-row], a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/** Focus the first visible stop inside `target`, else `target` itself. Returns what took focus. */
export function focusInto(target: HTMLElement): HTMLElement {
  const stop = Array.from(target.querySelectorAll<HTMLElement>(FIRST_STOP)).find((el) => el.getClientRects().length > 0 && !el.closest('[hidden],[aria-hidden="true"]'));
  const el = stop ?? target;
  el.focus({ preventScroll: false });
  return el;
}

export function SkipLink({ targetId = 'cc-main', label = 'Skip to content', className }: { targetId?: string; label?: string; className?: string }) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(targetId);
    if (!target) return;
    e.preventDefault(); // no hash in the URL: the client router owns it
    focusInto(target);
  };
  return (
    <a
      href={`#${targetId}`}
      onClick={go}
      data-skip-link
      className={cn(
        'sr-only z-[100] rounded-md bg-surface-overlay px-4 py-2 text-body font-bold text-link shadow-pop',
        'focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus-visible:shadow-focus focus-visible:outline-none',
        className,
      )}
    >
      {label}
    </a>
  );
}
