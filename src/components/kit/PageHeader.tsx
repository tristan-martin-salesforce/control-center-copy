'use client';
/**
 * PageHeader: one title source for every page (01-ui-audit R10). The title comes from the route table
 * (src/components/shell/routes.ts, the same table the topbar and the document title read), never from the tab, so a
 * page cannot say "Activity" on one tab and "Time" or "VDP" on the next.
 *
 *   Activity  › Saltmere Health                                        [right actions]
 *   One sentence about where things stand.
 *   [ To log 6 ][ History ][ VDP 2 ]
 *
 * `crumb` names the entity on an entity page (an account, an initiative) after the page's own title.
 *
 * Inside the app frame the topbar is the page's h1 and reads the same route table (shell/titles.ts), so app pages
 * pass `titleIn="topbar"`: the header draws the crumb, sentence, tabs and actions, and the title shows once. `inset
 * ={false}` drops the header's own padding inside a frame that already pads (ContextPage, a ListFrame head).
 */
import type { ReactNode } from 'react';
import { ROUTES, type RouteKey } from '@/components/shell/routes';
import { cn, Tabs, type TabItem } from '@/ui';

export type PageRoute = Exclude<RouteKey, 'notFound'>;

/** The page's title from the route table (the first pattern for the key). */
export function pageTitle(route: PageRoute): string {
  return ROUTES.find((r) => r.key === route)?.title ?? route;
}

export interface PageHeaderProps<V extends string = string> {
  route: PageRoute;
  /** The entity this page shows ("Saltmere Health"), after the title. */
  crumb?: string;
  /** One sentence: where things stand. */
  sentence?: ReactNode;
  tabs?: TabItem<V>[];
  tab?: V;
  onTab?: (tab: V) => void;
  /** Right side: the page's actions (quiet, at most one filled). */
  actions?: ReactNode;
  /** The hairline under the header (default true; off inside a box that has its own edge). */
  rule?: boolean;
  /** Where the title shows: in this header (default; the kit gallery) or in the app topbar (app pages). */
  titleIn?: 'header' | 'topbar';
  /** The header's own padding (default true; false inside a frame that already pads). */
  inset?: boolean;
  className?: string;
}

export function PageHeader<V extends string = string>({ route, crumb, sentence, tabs, tab, onTab, actions, rule = true, titleIn = 'header', inset = true, className }: PageHeaderProps<V>) {
  const title = pageTitle(route);
  const inHeader = titleIn === 'header';
  const crumbNode = crumb ? (
    <span className="min-w-0 truncate text-body-lg font-normal text-muted" data-testid="page-crumb">
      {inHeader ? (
        <span aria-hidden className="mr-2 text-faint">
          ›
        </span>
      ) : null}
      {crumb}
    </span>
  ) : null;
  return (
    <header
      data-page-header={route}
      data-title-in={titleIn}
      className={cn('flex min-w-0 flex-col gap-1', inset && 'px-6 pt-5', rule && 'border-b border-line', tabs?.length ? 'pb-0' : inset ? 'pb-4' : rule ? 'pb-3' : 'pb-0', className)}
    >
      {inHeader ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="flex min-w-0 items-baseline gap-2 text-heading font-bold text-fg-heading">
              <span className="truncate" data-testid="page-title">
                {title}
              </span>
              {crumbNode}
            </h1>
            {actions ? <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
          {sentence ? <p className="max-w-[72ch] text-body text-muted" data-testid="page-sentence">{sentence}</p> : null}
        </>
      ) : (
        <>
          {/* the title is the topbar's: the crumb leads, and the sentence shares its row with the actions */}
          {crumbNode ? <div className="flex min-w-0">{crumbNode}</div> : null}
          {sentence || actions ? (
            <div className="flex min-w-0 flex-wrap items-start gap-x-6 gap-y-2">
              {sentence ? <p className="min-w-0 max-w-[110ch] flex-[1_1_32rem] text-body-lg text-muted" data-testid="page-sentence">{sentence}</p> : null}
              {actions ? <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
          ) : null}
        </>
      )}
      {tabs?.length && tab !== undefined && onTab ? <Tabs tabs={tabs} value={tab} onChange={onTab} label={`${title} views`} className="mt-1 border-b-0" /> : null}
    </header>
  );
}
