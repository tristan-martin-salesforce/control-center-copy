'use client';
/**
 * The client router (ROUTER): renders the in-frame page for the current URL from the route table
 * (src/components/shell/routes.ts). Navigation is router.ts `navigate` / `<AppLink>`: history.pushState, which
 * Next's History API integration turns into a usePathname / useSearchParams update with no server request.
 *
 *   URL → matchRoute → that route's page chunk (code-split; warmed on hover, focus and idle) → the page
 *
 * Each pathname gets its own Suspense boundary (keyed), so a page whose chunk is still loading shows its route
 * skeleton, and a different path (/work/a → /work/b) mounts a fresh page while a query-only change keeps it.
 * Once a chunk has loaded, the page renders without suspending at all.
 *
 * Also here: document.title, a polite route announcement, focus on the noun tabs after a keyboard tab switch,
 * hash targets, legacy redirects and the plain-anchor safety net (an `<a href="/…">` that is not an AppLink still
 * navigates client-side).
 */
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, use, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { AppLink } from '@/components/shell/AppLink';
import { RouteSkeleton } from '@/components/shell/RouteSkeleton';
import { isClientNavigable, isPlainLinkClick, navigate, noteNavKind, registerClientRouter, takeNavKind } from '@/components/shell/router';
import { documentTitleFor, isClientPath, matchRoute, NOT_FOUND_TITLE, redirectFor, type RouteKey, type RouteMatch } from '@/components/shell/routes';
import { usePageTitle } from '@/components/shell/titles';
import { EmptyState } from '@/ui';

type Query = { get(name: string): string | null; forEach(cb: (value: string, key: string) => void): void };

export interface RouteProps {
  params: Record<string, string>;
  search: Query;
}

type PageKey = Exclude<RouteKey, 'notFound'>;
type RoutePage = ComponentType<RouteProps>;

/**
 * One code-split chunk per page. A page without props is its own route component (it ignores `params` and `search`);
 * the others get a small adapter from the URL (params, query) to their props.
 */
const LOADERS: Record<PageKey, () => Promise<RoutePage>> = {
  home: () => import('@/components/home/HomePage').then((m) => m.HomePage),
  today: () => import('@/components/today/TodayPage').then((m) => m.TodayPage),
  triage: () => import('../triage/_triage/TriagePage').then((m) => m.TriagePage),
  outbox: () => import('../outbox/_outbox/OutboxPage').then((m) => m.OutboxPage),
  // 01 R9: its own app/ route too (app/getting-started/page.tsx), so a reload renders it on the server
  gettingStarted: () => import('../getting-started/page').then((m) => m.default),
  assistant: () =>
    Promise.all([
      import('@/components/chat/AssistantPage'),
      // Dev only: the assistant's screenshot harness (?embed=panel|page); the branch is dropped from production builds.
      process.env.NODE_ENV !== 'production' ? import('../assistant/_preview/AssistantPreview') : Promise.resolve(null),
    ]).then(([{ AssistantPage }, preview]) =>
      function AssistantRoute({ search }: RouteProps) {
        const AssistantPreview = preview?.AssistantPreview;
        const embed = search.get('embed');
        if (AssistantPreview && (embed === 'panel' || embed === 'page')) {
          const params: Record<string, string> = {};
          search.forEach((v, k) => {
            if (!(k in params)) params[k] = v;
          });
          return <AssistantPreview params={params} />;
        }
        return <AssistantPage initialThreadId={search.get('thread')} anchor={search.get('at')} />;
      },
    ),
  work: () => import('../work/_list/WorkPage').then((m) => m.WorkPage),
  // `?variant=panel` previews the docked panel's Details tab (V2-DETAIL).
  workItem: () =>
    Promise.all([import('@/components/detail/WorkItemPage'), import('@/components/detail/WorkItemPanelPreview')]).then(
      ([{ WorkItemPage }, { WorkItemPanelPreview }]) =>
        function WorkItemRoute({ params, search }: RouteProps) {
          return search.get('variant') === 'panel' ? <WorkItemPanelPreview id={params.id!} draftId={search.get('draft')} /> : <WorkItemPage id={params.id!} />;
        },
    ),
  deals: () => import('@/components/deals/DealsView').then((m) => m.DealsView),
  missed: () => import('@/components/deals/MissedView').then((m) => m.MissedView),
  dcs: () => import('@/components/deals/DcView').then((m) => m.DcView),
  account: () =>
    import('@/components/deals/AccountPage').then(({ AccountPage }) =>
      function AccountRoute({ params }: RouteProps) {
        return <AccountPage accountId={params.accountId!} />;
      },
    ),
  briefs: () => import('../briefs/_briefs/BriefsPage').then((m) => m.BriefsPage),
  agents: () => import('@/components/agents/AgentsView').then((m) => m.AgentsView),
  tools: () => import('@/components/agents/ToolsView').then((m) => m.ToolsView),
  // 01 R1: Activity mounts its slice of the Needs-you queue above the page (app/activity/_activity)
  time: () => import('../activity/_activity/ActivityPage').then((m) => m.ActivityPage),
  health: () => import('@/components/health/HealthPage').then((m) => m.HealthPage),
  settings: () => import('@/components/settings/SettingsPage').then((m) => m.SettingsPage),
  history: () => import('@/components/history/HistoryPage').then((m) => m.HistoryPage),
  initiative: () =>
    import('@/components/detail/initiative/InitiativePage').then(({ InitiativePage }) =>
      function InitiativeRoute({ params }: RouteProps) {
        return <InitiativePage id={params.id!} />;
      },
    ),
};

interface Entry {
  promise: Promise<RoutePage>;
  page?: RoutePage;
}

const chunks = new Map<PageKey, Entry>();

/** Start (or reuse) loading a page's chunk. A failed load is forgotten, so the next attempt retries. */
function loadPage(key: PageKey): Entry {
  const hit = chunks.get(key);
  if (hit) return hit;
  const entry = {} as Entry;
  entry.promise = LOADERS[key]().then(
    (page) => {
      entry.page = page;
      return page;
    },
    (err: unknown) => {
      chunks.delete(key);
      throw err;
    },
  );
  chunks.set(key, entry);
  return entry;
}

function preloadPage(key: RouteKey) {
  if (key === 'notFound') return;
  loadPage(key).promise.catch(() => undefined);
}

// The landing page's chunk starts loading as this module evaluates, before hydration reaches it.
if (typeof window !== 'undefined' && isClientPath(window.location.pathname)) preloadPage(matchRoute(window.location.pathname).key);

/** Warm every page's chunk, one per idle period, so later tab switches never wait on the network. */
function useIdlePreload() {
  useEffect(() => {
    const keys = Object.keys(LOADERS) as PageKey[];
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    let id = 0;
    let cancelled = false;
    const schedule = (fn: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(fn, { timeout: 4000 }) : window.setTimeout(fn, 200));
    const next = () => {
      if (cancelled) return;
      const k = keys.shift();
      if (!k) return;
      loadPage(k)
        .promise.catch(() => undefined)
        .then(() => {
          if (!cancelled) id = schedule(next);
        });
    };
    // Let the landing page settle first.
    const start = window.setTimeout(() => (id = schedule(next)), 1500);
    return () => {
      cancelled = true;
      clearTimeout(start);
      if (w.cancelIdleCallback) w.cancelIdleCallback(id);
      else clearTimeout(id);
    };
  }, []);
}

function RouteView({ match, search }: { match: RouteMatch; search: Query }) {
  if (match.key === 'notFound') return <NotFound />;
  const entry = loadPage(match.key);
  const Page = entry.page ?? use(entry.promise);
  return <Page params={match.params} search={search} />;
}

function NotFound() {
  usePageTitle(NOT_FOUND_TITLE);
  return (
    <EmptyState
      size="page"
      icon="search"
      title="This page doesn't exist"
      body="The link may be old, or the page moved."
      action={
        <AppLink href="/" className="font-bold text-link hover:underline">
          Go to Home
        </AppLink>
      }
    />
  );
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Is focus nowhere useful (the old page took it with it)? */
function focusIsLost(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
}

/** Set when a navigation starts from a key press on a tab (role="tab"), so focus follows to the destination's selected tab. */
const followTab = { current: false };

/**
 * After a navigation commits: announce the page, keep a keyboard user on the noun tabs (Deals · Missed, Runs · Tools),
 * and scroll to a #hash target. Focus the old page took with it stays on the body: each page's keyboard model treats
 * that as "the page's main list is live".
 */
function useAfterNavigation(path: string, title: string) {
  const first = useRef(true);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const kind = takeNavKind();
    const fromTab = followTab.current;
    followTab.current = false;
    if (kind === 'replace') return;
    setAnnouncement(title);
    const hash = kind === 'push' ? decodeURIComponent(window.location.hash.slice(1)) : '';
    if (!hash && !fromTab) return;
    // The page may still be loading its chunk or data: look for the targets for up to ~1.5 s.
    let frames = 0;
    let raf = 0;
    const settle = () => {
      const target = hash ? document.getElementById(hash) : null;
      const tab = fromTab ? document.querySelector<HTMLElement>('#cc-main [role="tab"][aria-selected="true"]') : null;
      if (target) target.scrollIntoView({ block: 'start' });
      if (tab && focusIsLost()) tab.focus({ preventScroll: true });
      if (((hash && !target) || (fromTab && !tab)) && frames++ < 90) raf = requestAnimationFrame(settle);
    };
    settle();
    return () => cancelAnimationFrame(raf);
    // Once per committed path; the title is read for the announcement only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return announcement;
}

/**
 * The browser tab's title follows the topbar's (a page's usePageTitle wins over the route map). Next only writes the
 * server's <title> on a full load or a refresh, and that may land after this effect (streamed metadata): keep ours.
 */
function useDocumentTitle(want: string) {
  useEffect(() => {
    const apply = () => {
      if (document.title !== want) document.title = want;
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [want]);
}

/** Plain `<a href="/…">` anchors (sanitized markdown, legacy markup) navigate client-side too; back/forward are noted. */
function useDocumentNavigation() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || !isPlainLinkClick(e, a) || a.hasAttribute('data-native') || a.isContentEditable) return;
      if (!isClientNavigable(a.href)) return;
      e.preventDefault();
      navigate(a.href);
    };
    const onPop = () => noteNavKind('pop');
    // Read before the handlers run: the tab unmounts with its page. A pointer press never follows (mouse users keep
    // the page's keys live).
    const onKey = (e: KeyboardEvent) => {
      followTab.current = (e.target as Element | null)?.closest?.('[role="tab"]') != null;
    };
    const onPointer = () => {
      followTab.current = false;
    };
    window.addEventListener('click', onClick);
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);
}

export function ClientRouter() {
  const pathname = usePathname() ?? '/';
  const search = useSearchParams();
  const match = matchRoute(pathname);
  const redirect = redirectFor(match.path, search);
  const title = usePageTitle();

  useIsoLayoutEffect(() => registerClientRouter(preloadPage), []);
  useIdlePreload();
  useDocumentNavigation();
  useDocumentTitle(documentTitleFor(title));
  const announcement = useAfterNavigation(match.path, title);
  useIsoLayoutEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);

  return (
    <>
      <p aria-live="polite" aria-atomic="true" className="sr-only" data-route-announcer>
        {announcement}
      </p>
      {redirect ? (
        <RouteSkeleton pathname={redirect} />
      ) : (
        <Suspense key={match.path} fallback={<RouteSkeleton pathname={match.path} />}>
          <RouteView match={match} search={search} />
        </Suspense>
      )}
    </>
  );
}
