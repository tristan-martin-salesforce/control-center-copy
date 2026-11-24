/**
 * Activity's views (D-87; src/components/time/views.ts): To log · History · VDP, Forecast for an AE. Every old
 * `?view=` lands on the nearest of the three with the right anchor (docs/UX.md "Activity: old links"), and the URL is
 * replaced by the canonical one.
 */
import { describe, expect, it } from 'vitest';
import { personaOf } from '@/personas';
import { redirectFor } from '@/components/shell/routes';
import { activityTabsFor, hrefForReview, hrefForVdpSub, hrefForView, hrefForWeek, LOG_ANCHORS, resolveActivityRoute, viewAccess } from '@/components/time/views';

const SE = personaOf({ persona: { id: 'se' } });
const AE = personaOf({ persona: { id: 'ae' } });

describe('Activity views', () => {
  it('three tabs for the SE, Forecast added for the AE (and VDP only where active)', () => {
    expect(activityTabsFor(SE).map((t) => t.label)).toEqual(['To log', 'History', 'VDP']);
    expect(activityTabsFor(AE).map((t) => t.label)).toEqual(['To log', 'History', 'Forecast']);
    expect(activityTabsFor(null).map((t) => t.label)).toEqual(['To log', 'History']);
    expect(viewAccess('vdp', AE)).toEqual({ state: 'inactive', feature: 'vdp' });
    expect(viewAccess('vdp', null)).toEqual({ state: 'loading' });
    expect(viewAccess('log', null)).toEqual({ state: 'show' });
  });

  it('the canonical views need no redirect; the bare /activity is the persona default', () => {
    for (const q of ['', 'view=history', 'view=vdp', 'view=vdp&sub=mine', 'view=log&show=week', 'view=log&review=1'])
      expect(resolveActivityRoute(q, SE).redirect, q).toBeNull();
    expect(resolveActivityRoute('', SE).view).toBe('log');
    expect(resolveActivityRoute('', AE).view).toBe('forecast');
    expect(resolveActivityRoute('view=log', SE)).toMatchObject({ view: 'log', show: 'list', review: false, redirect: null });
    expect(resolveActivityRoute('view=log&review=1', SE).review).toBe(true);
    expect(resolveActivityRoute('view=vdp&sub=mine', SE).sub).toBe('mine');
  });

  it('old views redirect to the nearest of the three, with the right anchor', () => {
    const r = (q: string, p = SE) => resolveActivityRoute(q, p);
    expect(r('view=week')).toMatchObject({ view: 'log', anchor: null, redirect: '/activity' });
    expect(r('view=needs')).toMatchObject({ view: 'log', anchor: LOG_ANCHORS.needs, redirect: '/activity#time-needs' });
    expect(r('view=weeks')).toMatchObject({ view: 'log', show: 'week', redirect: '/activity?show=week' });
    expect(r('view=usecases')).toMatchObject({ view: 'log', anchor: LOG_ANCHORS.useCases, redirect: '/activity#time-usecases' });
    expect(r('view=ledger')).toMatchObject({ view: 'history', redirect: '/activity?view=history' });
    // C10: a batch link (History ▸ Batches' `?batch=`) survives the old-link rewrite
    expect(r('view=ledger&batch=d_123')).toMatchObject({ view: 'history', redirect: '/activity?view=history&batch=d_123' });
    expect(r('view=bogus')).toMatchObject({ view: 'log', redirect: '/activity' });
    // Forecast without the feature: To log; with it, it stays
    expect(r('view=forecast')).toMatchObject({ view: 'log', redirect: '/activity' });
    expect(r('view=forecast', AE)).toMatchObject({ view: 'forecast', redirect: null });
    // while the persona loads, a forecast link waits (no redirect yet)
    expect(resolveActivityRoute('view=forecast', null)).toMatchObject({ view: 'forecast', redirect: null });
    // an AE's old Log it link names the view (their default is Forecast)
    expect(r('view=week', AE)).toMatchObject({ view: 'log', redirect: '/activity?view=log' });
  });

  it('an old ?week= opens To log’s Week on that week; the panel and Ledger params survive the redirect', () => {
    expect(resolveActivityRoute('week=2026-11-02', SE)).toMatchObject({ view: 'log', show: 'week', week: '2026-11-02', redirect: '/activity?show=week&week=2026-11-02' });
    expect(resolveActivityRoute('view=week&week=2026-11-02', SE).redirect).toBe('/activity?show=week&week=2026-11-02');
    expect(resolveActivityRoute('view=needs&week=2026-11-02&row=r1', SE).redirect).toBe('/activity?show=week&week=2026-11-02&row=r1');
    expect(resolveActivityRoute('view=weeks&week=2026-11-02', SE).redirect).toBe('/activity?show=week&week=2026-11-02');
    expect(resolveActivityRoute('view=needs&draft=d1', SE).redirect).toBe('/activity?draft=d1#time-needs');
    expect(resolveActivityRoute('view=ledger&quarter=Q3+FY27&status=logged', SE).redirect).toBe('/activity?view=history&quarter=Q3+FY27&status=logged');
    // the vdp panel link (contract vdpHrefFor) is canonical as it is
    expect(resolveActivityRoute('view=vdp&panel=details&kind=vdp&item=k1', SE).redirect).toBeNull();
  });

  it('links', () => {
    expect(hrefForView('log', SE)).toBe('/activity');
    expect(hrefForView('history', SE)).toBe('/activity?view=history');
    expect(hrefForView('forecast', AE)).toBe('/activity');
    expect(hrefForView('log', AE)).toBe('/activity?view=log');
    expect(hrefForWeek('2026-11-02', SE)).toBe('/activity?show=week&week=2026-11-02');
    expect(hrefForWeek(null, SE)).toBe('/activity?show=week');
    expect(hrefForReview(SE)).toBe('/activity?review=1');
    expect(hrefForVdpSub('mine', SE)).toBe('/activity?view=vdp&sub=mine');
    expect(hrefForVdpSub('changes', SE)).toBe('/activity?view=vdp');
  });

  it('every old /time link lands on /activity with its query (then the view redirect applies)', () => {
    expect(redirectFor('/time', new URLSearchParams(''))).toBe('/activity');
    expect(redirectFor('/time', new URLSearchParams('view=needs&draft=d1'))).toBe('/activity?view=needs&draft=d1');
    expect(redirectFor('/activity', new URLSearchParams('view=needs'))).toBeNull();
  });
});
