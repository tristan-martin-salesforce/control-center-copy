'use client';
/**
 * The v2 frame the Triage, Work and Outbox pages share (DESIGN-V2; the Today mockup's header line and
 * panels). The topbar already names the page, so the frame leads with ONE sentence (lead size) and keeps
 * the page's quiet facts on the right ("3 of 34"). Below it sits one panel: pinned tabs and filters, then
 * the verb sections, which flow into columns on wide containers and condense when the docked panel opens.
 * The page itself never scrolls; the panel body does.
 *
 * (`ListPage` is the v1 frame; Briefs still uses it.)
 */
import type { ReactNode, Ref } from 'react';
import { cn } from '@/ui';
import './lists.css';

export interface ListFrameProps {
  /** Accessible name of the page region ("Work"). */
  label: string;
  /** One sentence, bold where it matters. */
  lead?: ReactNode;
  /**
   * The page's own header in place of lead / sub / aside: the kit PageHeader (01-ui-audit R10, one title source),
   * drawn in the same padded head.
   */
  header?: ReactNode;
  /** A quiet second line under the lead (keys, the border rule). */
  sub?: ReactNode;
  /** Right of the lead: "3 of 34", one page action at most. */
  aside?: ReactNode;
  /** Page-scoped banner (stale connector). */
  banner?: ReactNode;
  /** Pinned at the top of the panel: tabs, filters, the batch bar. */
  tools?: ReactNode;
  children: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
  /** Extra class on the scrolling body. */
  bodyClassName?: string;
  'data-state'?: string;
}

export function ListFrame({ label, lead, header, sub, aside, banner, tools, children, bodyRef, bodyClassName, ...rest }: ListFrameProps) {
  return (
    <div className="cc-list" role="region" aria-label={label} data-state={rest['data-state']}>
      {header ? (
        <div className="cc-list-head">
          <div className="min-w-0 flex-1">{header}</div>
        </div>
      ) : (
        <header className="cc-list-head">
          <div className="min-w-0 flex-[1_1_36rem]">
            <p className="cc-list-lead" data-testid="list-lead" aria-live="polite">
              {lead}
            </p>
            {sub ? <div className="cc-list-sub">{sub}</div> : null}
          </div>
          {aside ? <div className="cc-list-aside">{aside}</div> : null}
        </header>
      )}
      {banner ? <div className="cc-list-banner">{banner}</div> : null}
      <div className="cc-list-body">
        <section className="cc-list-panel" aria-label={`${label} list`}>
          {tools ? <div className="cc-list-tools">{tools}</div> : null}
          <div ref={bodyRef} className={cn('cc-list-scroll cc-scroll', bodyClassName)}>
            {children}
          </div>
        </section>
      </div>
    </div>
  );
}

/** "3 of 34": where the selection sits in the list (the old sheet's "n of N"), with the keys that move it. */
export function SelectionPosition({ index, total, noun = 'item', nouns }: { index: number; total: number; noun?: string; nouns?: string }) {
  if (total <= 0) return null;
  return (
    <span className="inline-flex items-center gap-2 tabular-nums" data-testid="n-of-N">
      {index >= 0 ? (
        <span>
          <b className="font-bold text-fg">{index + 1}</b> of {total}
        </span>
      ) : (
        <span>
          {total} {total === 1 ? noun : (nouns ?? `${noun}s`)}
        </span>
      )}
      <span className="cc-hide-narrow inline-flex items-center gap-1 text-muted" aria-hidden>
        <kbd className="rounded-sm border border-line bg-surface-sunken px-1.5 font-mono text-micro text-muted">j</kbd>
        <kbd className="rounded-sm border border-line bg-surface-sunken px-1.5 font-mono text-micro text-muted">k</kbd>
        move · <kbd className="rounded-sm border border-line bg-surface-sunken px-1.5 font-mono text-micro text-muted">↵</kbd> details
      </span>
    </span>
  );
}

/**
 * A refresh failed but the list is still on screen (stale, not broken): say so where the facts are and
 * offer Retry, instead of replacing rows the user may be acting on (and a rolled-back row) with an error.
 */
export function StaleRefresh({ onRetry }: { onRetry: () => void }) {
  return (
    <span role="status" data-testid="list-stale" className="inline-flex items-center gap-2 text-caption text-muted">
      <span aria-hidden>☾</span>
      Couldn’t refresh, showing the last copy
      <button type="button" onClick={onRetry} className="rounded-sm font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus">
        Retry
      </button>
    </span>
  );
}

/** The end of the list: "That's everything." plus one quiet status line. */
export function ListEnd({ children, title = 'That’s everything.' }: { children?: ReactNode; title?: string }) {
  return (
    <p className="cc-list-end" data-testid="list-end">
      <b>{title}</b>
      {children ? <span className="min-w-0">{children}</span> : null}
    </p>
  );
}
