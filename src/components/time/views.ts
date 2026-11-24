/**
 * Activity's views (pure; tests/time/views.test.ts). D-87: three tabs, plus Forecast for the AE:
 *
 *   To log   ?view=log (the default): what the app can log for me, grouped by day, with what needs me on top. A
 *            List / Week toggle (`&show=week`, `&week=<Monday>` for another week) and the Review page
 *            (`&review=1`: one page of checkboxes, then one "Log these").
 *   History  ?view=history: what was logged (the quarter as a report, then its rows), with each row's Org62 record,
 *            Undo while it can still be taken back, and the corrections.
 *   VDP      ?view=vdp: the VDP changes staged and applied, and what autopilot did; `&sub=mine` filters to My VDPs.
 *   Forecast ?view=forecast: the AE's weekly duty (their default), only for a persona with Specialist Forecast.
 *
 * Every old link still lands (docs/UX.md "Activity: old links"): `week` → To log; `needs` → To log at what needs me;
 * `weeks` (and any `?week=`) → To log's Week; `usecases` → To log at the use cases; `ledger` → History; `forecast`
 * without the feature → To log; anything unknown → To log. The redirect replaces the URL, so Back skips the old one.
 * `/time` (any query) already redirects to `/activity` (src/components/shell/routes.ts) and lands here.
 */
import type { PersonaFeature } from '@/contract';
import { allows } from '@/personas/gates';
import type { ResolvedPersona } from '@/personas/types';

export type ActivityView = 'log' | 'history' | 'vdp' | 'forecast';
export type VdpSub = 'changes' | 'mine';
/** To log's toggle: the list (the default) or one week, day by day. */
export type LogShow = 'list' | 'week';

export const ACTIVITY_PATH = '/activity';

export const ACTIVITY_VIEWS: Array<{ value: ActivityView; label: string; feature?: PersonaFeature }> = [
  { value: 'log', label: 'To log' },
  { value: 'history', label: 'History' },
  { value: 'vdp', label: 'VDP', feature: 'vdp' },
  { value: 'forecast', label: 'Forecast', feature: 'specialistForecast' },
];

/** The anchors To log's sections carry (the old views land on them). */
export const LOG_ANCHORS = { needs: 'time-needs', ready: 'time-ready', runs: 'time-runs', dcs: 'time-dcs', useCases: 'time-usecases', internal: 'time-internal' } as const;

/** Where each old `?view=` lands. */
export const LEGACY_VIEWS: Readonly<Record<string, { view: ActivityView; show?: LogShow; anchor?: string }>> = {
  week: { view: 'log' },
  needs: { view: 'log', anchor: LOG_ANCHORS.needs },
  weeks: { view: 'log', show: 'week' },
  usecases: { view: 'log', anchor: LOG_ANCHORS.useCases },
  ledger: { view: 'history' },
};

/** The persona's default view: Forecast for an AE with Specialist Forecast (their weekly duty), else To log. */
export function defaultViewFor(persona?: ResolvedPersona | null): ActivityView {
  return persona && persona.id === 'ae' && allows(persona, { feature: 'specialistForecast' }) ? 'forecast' : 'log';
}

export interface ActivityRoute {
  view: ActivityView;
  show: LogShow;
  /** To log's Review page. */
  review: boolean;
  /** `?week=` (To log's Week). */
  week: string | null;
  sub: VdpSub;
  /** A section to scroll to (an old view's place inside To log). */
  anchor: string | null;
  /** The canonical URL when the one asked for was an old one (replace it); null when it is already canonical. */
  redirect: string | null;
}

const KNOWN: ReadonlySet<string> = new Set(ACTIVITY_VIEWS.map((v) => v.value));

/**
 * `?view=…` → the view and, for an old value, where it lands now. `persona` undefined: not known yet, so a `forecast`
 * link waits (no redirect) until the persona says whether it has the feature.
 */
export function resolveActivityRoute(search: URLSearchParams | string, persona?: ResolvedPersona | null): ActivityRoute {
  const sp = typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = sp.get('view');
  const week = sp.get('week');
  const sub: VdpSub = sp.get('sub') === 'mine' ? 'mine' : 'changes';
  const review = sp.get('review') === '1';
  let view: ActivityView;
  let show: LogShow = sp.get('show') === 'week' ? 'week' : 'list';
  let anchor: string | null = null;
  let legacy = false;
  if (raw && KNOWN.has(raw)) view = raw as ActivityView;
  else if (raw && LEGACY_VIEWS[raw]) {
    const to = LEGACY_VIEWS[raw]!;
    view = to.view;
    if (to.show) show = to.show;
    anchor = to.anchor ?? null;
    legacy = true;
  } else {
    view = raw ? 'log' : defaultViewFor(persona);
    legacy = !!raw;
  }
  // an old ?week= deep link (no view, or Log it's / Needs you's) opens To log's Week on that week
  if (week && (!raw || raw === 'week' || raw === 'needs')) {
    view = 'log';
    show = 'week';
    anchor = null;
    legacy = legacy || raw !== 'log';
  }
  // Forecast belongs to a feature: without it (once the persona is known), To log
  if (view === 'forecast' && persona && !allows(persona, { feature: 'specialistForecast' })) {
    view = 'log';
    legacy = true;
  }
  const route: ActivityRoute = { view, show: view === 'log' ? show : 'list', review: view === 'log' && review, week: view === 'log' ? week : null, sub, anchor, redirect: null };
  if (legacy || (raw === null && week)) route.redirect = hrefFor(route, persona, sp);
  return route;
}

/** The params a view keeps when it is rewritten (the details panel's and the Ledger's own filters; History's `batch`, C10). */
const KEEP = ['draft', 'panel', 'kind', 'item', 'row', 'quarter', 'status', 'q', 'account', 'opp', 'type', 'batch'];

/** The canonical URL of a route (the persona's default view is the bare /activity). */
export function hrefFor(r: Pick<ActivityRoute, 'view' | 'show' | 'review' | 'week' | 'sub' | 'anchor'>, persona?: ResolvedPersona | null, keep?: URLSearchParams): string {
  const sp = new URLSearchParams();
  if (r.view !== defaultViewFor(persona)) sp.set('view', r.view);
  if (r.view === 'log' && r.show === 'week') sp.set('show', 'week');
  if (r.view === 'log' && r.show === 'week' && r.week) sp.set('week', r.week);
  if (r.view === 'log' && r.review) sp.set('review', '1');
  if (r.view === 'vdp' && r.sub === 'mine') sp.set('sub', 'mine');
  for (const k of r.view === 'history' ? [...KEEP, 'week'] : KEEP) {
    const v = keep?.get(k);
    if (v !== null && v !== undefined) sp.set(k, v);
  }
  const q = sp.toString();
  return `${ACTIVITY_PATH}${q ? `?${q}` : ''}${r.anchor ? `#${r.anchor}` : ''}`;
}

const BASE: Omit<ActivityRoute, 'view' | 'redirect'> = { show: 'list', review: false, week: null, sub: 'changes', anchor: null };

/** Where a tab goes. */
export const hrefForView = (v: ActivityView, persona?: ResolvedPersona | null): string => hrefFor({ ...BASE, view: v }, persona);

/** To log's Week on one week (its Monday), or the current one. */
export const hrefForWeek = (monday: string | null, persona?: ResolvedPersona | null): string => hrefFor({ ...BASE, view: 'log', show: 'week', week: monday }, persona);

/** To log at one of its sections. */
export const hrefForAnchor = (anchor: string, persona?: ResolvedPersona | null): string => hrefFor({ ...BASE, view: 'log', anchor }, persona);

/** The Review page. */
export const hrefForReview = (persona?: ResolvedPersona | null): string => hrefFor({ ...BASE, view: 'log', review: true }, persona);

/** VDP, or VDP filtered to My VDPs. */
export const hrefForVdpSub = (s: VdpSub, persona?: ResolvedPersona | null): string => hrefFor({ ...BASE, view: 'vdp', sub: s }, persona);

/** The tabs this persona sees, in order (a gated one stays hidden while the persona loads). */
export function activityTabsFor(persona: ResolvedPersona | null | undefined): Array<{ value: ActivityView; label: string }> {
  return ACTIVITY_VIEWS.filter((t) => allows(persona, t.feature ? { feature: t.feature } : undefined)).map(({ value, label }) => ({ value, label }));
}

/**
 * What a view renders for this persona: the view, a neutral frame while the persona loads (a gated view's words never
 * flash), or the feature that is not active (shown as available to activate).
 */
export function viewAccess(view: ActivityView, persona: ResolvedPersona | null | undefined): { state: 'show' } | { state: 'loading' } | { state: 'inactive'; feature: PersonaFeature } {
  const feature = ACTIVITY_VIEWS.find((t) => t.value === view)?.feature;
  if (!feature) return { state: 'show' };
  if (!persona) return { state: 'loading' };
  return allows(persona, { feature }) ? { state: 'show' } : { state: 'inactive', feature };
}
