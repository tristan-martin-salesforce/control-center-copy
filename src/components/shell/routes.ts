/**
 * The app's route table (ROUTER): every in-frame page is a client route. One optional catch-all
 * (`app/(app)/[[...path]]`, rendered by the client router in `app/(app)/layout.tsx`) serves them all, so a tab
 * switch is a `history.pushState` and never a server round-trip (router.ts). This module is pure (no React, no
 * window): the server page, the client router, links and tests all read it.
 *
 *   matchRoute(pathname)        → { key, params, path } (key 'notFound' when nothing matches)
 *   isClientPath(pathname)      → true when the catch-all serves it (not /onboarding, /dev/**, /api/**)
 *   redirectFor(pathname, q)    → a legacy URL's new home, else null (served by the page and the client router)
 *   pageTitleFor(pathname)      → the topbar / document title for a route
 *
 * Own routes stay their own: /onboarding renders without the frame, /dev/kit/** is the kit, /api/** the API.
 */

export type RouteKey =
  | 'home'
  | 'today'
  | 'triage'
  | 'outbox'
  | 'assistant'
  | 'work'
  | 'workItem'
  | 'deals'
  | 'missed'
  | 'dcs'
  | 'account'
  | 'briefs'
  | 'agents'
  | 'tools'
  | 'time'
  | 'health'
  | 'settings'
  | 'history'
  | 'initiative'
  | 'gettingStarted'
  | 'notFound';

interface RouteDef {
  key: Exclude<RouteKey, 'notFound'>;
  /** `/deals/:accountId`: static segments and `:param` segments (one path segment each). */
  pattern: string;
  title: string;
}

/** Static patterns first: `/deals/missed` wins over `/deals/:accountId`. */
export const ROUTES: readonly RouteDef[] = [
  { key: 'home', pattern: '/', title: 'Home' },
  { key: 'today', pattern: '/today', title: 'Today' },
  { key: 'triage', pattern: '/triage', title: 'Triage' },
  { key: 'outbox', pattern: '/outbox', title: 'Outbox' },
  { key: 'assistant', pattern: '/assistant', title: 'Assistant' },
  { key: 'work', pattern: '/work', title: 'Work' },
  { key: 'workItem', pattern: '/work/:id', title: 'Work item' },
  { key: 'deals', pattern: '/deals', title: 'Deals' },
  { key: 'missed', pattern: '/deals/missed', title: 'Missed opportunities' },
  { key: 'dcs', pattern: '/deals/dcs', title: 'Deal contributions' },
  { key: 'account', pattern: '/deals/:accountId', title: 'Account' },
  { key: 'briefs', pattern: '/briefs', title: 'Briefs' },
  { key: 'agents', pattern: '/agents', title: 'Agents' },
  { key: 'tools', pattern: '/agents/tools', title: 'Tools' },
  // Activity (was Time): `/activity` is its home; `/time` (any query) redirects there, so every old link lands
  { key: 'time', pattern: '/activity', title: 'Activity' },
  { key: 'time', pattern: '/time', title: 'Activity' },
  { key: 'health', pattern: '/health', title: 'Health' },
  { key: 'settings', pattern: '/settings', title: 'Settings' },
  { key: 'history', pattern: '/history', title: 'Journal' },
  { key: 'initiative', pattern: '/initiatives/:id', title: 'Initiative' },
  // 01 R9: five outcomes (app/getting-started/page.tsx, also loaded by the client router)
  { key: 'gettingStarted', pattern: '/getting-started', title: 'Getting started' },
];

export interface RouteMatch {
  key: RouteKey;
  /** Decoded `:param` values. */
  params: Record<string, string>;
  /** The normalized pathname (no query, hash or trailing slash). */
  path: string;
}

/** Paths the catch-all never serves: they have their own app/ routes (or are not pages at all). */
const OWN_ROUTE_PREFIXES = ['/onboarding', '/dev', '/api', '/_next'];

export function normalizePath(p: string): string {
  const bare = p.split('?')[0]!.split('#')[0]!;
  return bare.replace(/\/+$/, '') || '/';
}

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

const split = (p: string) => (p === '/' ? [] : p.slice(1).split('/'));

export function matchRoute(pathname: string): RouteMatch {
  const path = normalizePath(pathname);
  const segs = split(path);
  for (const r of ROUTES) {
    const pat = split(r.pattern);
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      const want = pat[i]!;
      const got = segs[i]!;
      if (want.startsWith(':')) {
        if (!got) {
          ok = false;
          break;
        }
        params[want.slice(1)] = decode(got);
      } else if (want !== got) {
        ok = false;
        break;
      }
    }
    if (ok) return { key: r.key, params, path };
  }
  return { key: 'notFound', params: {}, path };
}

/** True when the catch-all serves this path (in-frame pages, and unknown paths, which get the not-found view). */
export function isClientPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return !OWN_ROUTE_PREFIXES.some((pre) => path === pre || path.startsWith(`${pre}/`));
}

/** Read-only view of a query, from a URLSearchParams or Next's searchParams record. */
type QueryLike = { get(name: string): string | null; forEach?(cb: (value: string, key: string) => void): void };

/**
 * Legacy URLs and their new homes. The NavBar waffle (FE-1a) links to /agents?tab=tools&tool=<id>; tools live at
 * /agents/tools?run=<id>.
 */
export function redirectFor(pathname: string, q: QueryLike): string | null {
  const path = normalizePath(pathname);
  if (path === '/agents' && q.get('tab') === 'tools') {
    const tool = q.get('tool');
    return tool ? `/agents/tools?run=${encodeURIComponent(tool)}` : '/agents/tools';
  }
  // Time is Activity: the same query (view, sub, week, draft…) on the new home
  if (path === '/time') {
    const sp = new URLSearchParams();
    q.forEach?.((v, k) => sp.append(k, v));
    if (!q.forEach) for (const k of ['view', 'sub', 'week', 'draft', 'quarter']) if (q.get(k) !== null) sp.set(k, q.get(k)!);
    return `/activity${sp.size ? `?${sp}` : ''}`;
  }
  return null;
}

/** Next's `searchParams` record as a QueryLike (first value of a repeated key). */
export function queryFromRecord(sp: Record<string, string | string[] | undefined>): QueryLike {
  return {
    get: (name) => {
      const v = sp[name];
      return (Array.isArray(v) ? v[0] : v) ?? null;
    },
    forEach: (cb) => {
      for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) cb(x, k);
    },
  };
}

// ── Titles ──────────────────────────────────────────────────────────────────────────────────

const EXACT_TITLES: Record<string, string> = {
  ...Object.fromEntries(ROUTES.filter((r) => !r.pattern.includes(':')).map((r) => [r.pattern, r.title])),
  '/onboarding': 'Set up',
  '/dev/kit': 'Kit',
};

/** Longest prefix wins. */
const PREFIX_TITLES: Array<[string, string]> = [
  ['/dev/kit/', 'Kit'],
  ['/work/', 'Work item'],
  ['/initiatives/', 'Initiative'],
  ['/deals/', 'Account'],
  ['/agents/', 'Agents'],
  ['/briefs/', 'Briefs'],
  ['/settings/', 'Settings'],
];

export const APP_NAME = 'Command Center';
/** The not-found view's title (topbar and browser tab). */
export const NOT_FOUND_TITLE = 'Not found';

export function pageTitleFor(pathname: string | null | undefined): string {
  const p = normalizePath(pathname ?? '/');
  if (EXACT_TITLES[p]) return EXACT_TITLES[p]!;
  const hit = PREFIX_TITLES.filter(([pre]) => p.startsWith(pre)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : APP_NAME;
}

/** The browser tab's title: "Deals · Command Center" (Home is just the app name). */
export function documentTitleFor(title: string): string {
  return !title || title === APP_NAME || title === 'Home' ? APP_NAME : `${title} · ${APP_NAME}`;
}
