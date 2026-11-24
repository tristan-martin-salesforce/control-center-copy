'use client';
/**
 * The spotlight tours on a page, in two ways (SpotlightTour.tsx draws them, tour.ts holds the rules):
 *
 *   first visit   on a page you haven't seen, a tour of 1–4 steps (src/guide/pages.ts), once per visit
 *   requested     Getting started's "Take the tour" (the page's whole tour from step 1, seen or not) and "Show me"
 *                 (an item's tip: the element to use, items.ts), and the "?" popover's "Show this page's tips
 *                 again". A request (request.ts) plays on the page it names once the navigation lands, or at once
 *                 when you are already there; asking again plays again.
 *
 * Seen state is settings.guide.seen (every browser, one user). Next records the step it leaves, so a tour cut short
 * resumes where it stopped; Skip tour or Esc records the page's whole set; Done on the last step also records the
 * page as toured (`tour.<page>`), which ticks its Getting started item. A mark whose element is missing (another
 * persona, an empty state) is skipped and stays unseen. An item's tip records nothing: its item ticks from real
 * state (its "Looks right" button is the one exception, the role check).
 *
 * A first-visit tour starts once the page has settled (a pause, then two looks that agree on the steps) and never
 * over another dialog, menu or the ⌘K palette (one opening mid-tour hides it until it closes). While the first scan
 * fills in it waits for a visit after the scan is done: pages are half-empty and the first-scan banner is the thing
 * to read. A request runs anyway, first scan or not, as soon as all its steps are on the page (or three looks agree);
 * when none of them shows up, a toast says what the tip would have said.
 *
 * First visits are off for automation (navigator.webdriver: screenshots and crawls stay clean) unless the URL says
 * `?coach=1`; `?coach=0` turns them off for one load. Requests always play.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast/store';
import { firstScanView } from '@/components/shell/first-scan';
import type { RouteKey } from '@/components/shell/routes';
import type { ResolvedPersona } from '@/personas';
import { useWallClock } from '@/ui/clock';
import { itemDoneKey, type GuideItemId } from './checklist';
import { itemGuideFor, type GuideStepDef } from './items';
import { pageHelpFor, tourDoneKey } from './pages';
import { activate, clearGuideRequest, GUIDE_EVENT, keepOnRoute, requestGuide, storedGuideRequest, type ActiveRequest, type GuideRequest } from './request';
import { findAnchor, SpotlightTour, TOUR_SELECTOR, type TourStep } from './SpotlightTour';
import { finishRecord, mayStart, moveTour, readyToStart, resolveSteps, sameSteps, tourQueue, type TourMove, type TourRun } from './tour';
import { useGuideSettings } from './useGuide';

/** Let the page settle before the first look. */
const SETTLE_MS = 1200;
const REQUEST_SETTLE_MS = 150;
const POLL_MS = 400;
const POLL_TRIES = 20;

/** Show a page's tour again from step 1 (the "?" popover's "Show this page's tips again"). */
export function replayCoachMarks(key: RouteKey) {
  requestGuide({ page: key, item: null });
}

export function coachMarksEnabled(loc: Pick<Location, 'search'> = window.location, nav: Pick<Navigator, 'webdriver'> = navigator): boolean {
  const q = new URLSearchParams(loc.search).get('coach');
  if (q === '0') return false;
  if (q === '1') return true;
  return !nav.webdriver;
}

/** Another popover, dialog, menu or the ⌘K palette is open (not the tour's own card). */
function dialogOpen(): boolean {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')].some((el) => !el.closest(TOUR_SELECTOR));
}

type Step = GuideStepDef & TourStep;

interface Tour {
  key: RouteKey;
  /** A page tour, or an item's tip. */
  kind: 'page' | 'item';
  /** The Getting started item an item's tip is for: Done on it ticks that item. */
  item?: GuideItemId | null;
  steps: Step[];
  run: TourRun;
}

export function CoachMarks({ routeKey, persona, paused = false }: { routeKey: RouteKey; persona: ResolvedPersona | null; paused?: boolean }) {
  const { guide, markSeen } = useGuideSettings();
  const health = useApi('getHealth'); // live: the health topic (no poll)
  const now = useWallClock(60_000);
  const [enabled, setEnabled] = useState(false);
  const [request, setRequest] = useState<ActiveRequest | null>(null);
  const [acked, setAcked] = useState<ReadonlySet<string>>(() => new Set());
  const [tour, setTour] = useState<Tour | null>(null);
  /** The page whose visit is spent: a tour ran on it, or the first scan was filling in when it began. */
  const [ranOn, setRanOn] = useState<RouteKey | null>(null);
  /** Another dialog opened over the tour: hidden until it closes. */
  const [blocked, setBlocked] = useState(false);
  /** Where focus was when the tour started; it goes back there at the end. */
  const restoreRef = useRef<HTMLElement | null>(null);
  const routeRef = useRef(routeKey);
  routeRef.current = routeKey;
  /** Counts requests, so asking for the same tour twice plays it twice. */
  const asks = useRef(0);

  useEffect(() => setEnabled(coachMarksEnabled()), []);
  // requests: the event, and one a full page load carried over (a new build reloads the tab on navigation)
  useEffect(() => {
    const take = (r: GuideRequest | null) => {
      if (!r) return;
      setTour(null);
      setRequest(activate(r, routeRef.current, ++asks.current));
    };
    take(storedGuideRequest());
    const on = (e: Event) => take((e as CustomEvent<GuideRequest>).detail);
    window.addEventListener(GUIDE_EVENT, on);
    return () => window.removeEventListener(GUIDE_EVENT, on);
  }, []);
  // a new page ends the tour on screen, and a request for another page
  useEffect(() => {
    setTour(null);
    setRanOn(null);
    setRequest((r) => keepOnRoute(r, routeKey));
  }, [routeKey]);

  const marks = useMemo(() => pageHelpFor(routeKey, persona)?.marks ?? [], [routeKey, persona]);
  const pageIds = useMemo(() => marks.map((m) => m.id), [marks]);
  const seen = guide?.seen;
  const asked = request && request.page === routeKey ? request : null;
  const queue = useMemo<Step[]>(() => {
    if (!seen) return [];
    if (asked) return asked.item ? itemGuideFor(asked.item, persona) : [...marks];
    return tourQueue(marks, seen, acked, false);
  }, [marks, seen, acked, asked, persona]);
  const scanFilling = firstScanView(health.data?.firstScan, now) !== null;
  // a visit that began while the first scan filled in stays tour-free: one finishing mid-task never interrupts you
  useEffect(() => {
    if (scanFilling) setRanOn(routeKey);
  }, [scanFilling, routeKey]);
  const looking =
    !tour &&
    queue.length > 0 &&
    mayStart({ enabled, replay: !!asked, personaReady: !!persona, seenReady: !!seen, paused, ranThisVisit: ranOn === routeKey, scanKnown: health.isSuccess || health.isError, scanFilling });

  // after the page settles, look until the steps are there (missing ones are skipped; a fallback stands in)
  const queueKey = queue.map((m) => m.id).join(',');
  const askedN = asked?.n ?? 0;
  useEffect(() => {
    if (!looking) return;
    let tries = 0;
    let agreed = 0;
    let last: Step[] | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const look = () => {
      // wait out an open popover or dialog without using up the tries
      if (dialogOpen()) {
        timer = setTimeout(look, 1000);
        return;
      }
      const steps = resolveSteps(queue, (sel) => !!findAnchor(sel));
      agreed = sameSteps(last, steps) ? agreed + 1 : 0;
      if (readyToStart({ found: steps.length, queued: queue.length, agreed, tries, maxTries: POLL_TRIES, requested: !!asked })) {
        restoreRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        setBlocked(false);
        setTour({ key: routeKey, kind: asked?.item ? 'item' : 'page', item: asked?.item ?? null, steps, run: { steps: steps.map((s) => s.id), index: 0 } });
        if (asked) clearGuideRequest();
        return;
      }
      last = steps;
      if (tries++ < POLL_TRIES) {
        timer = setTimeout(look, POLL_MS);
      } else if (asked) {
        // nothing to point at (an empty page): say what the tip would have, rather than nothing
        clearGuideRequest();
        setRequest(null);
        const first = queue[0];
        if (first && asked.item) toast({ key: 'guide:missing', tone: 'info', title: first.title, body: first.text });
        else toast({ key: 'guide:missing', tone: 'info', title: 'Nothing to tour here yet', body: 'This page is still empty. Its ? button explains what it shows.' });
      }
    };
    timer = setTimeout(look, asked ? REQUEST_SETTLE_MS : SETTLE_MS);
    return () => clearTimeout(timer);
    // queueKey stands for `queue`, askedN for `asked`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looking, queueKey, askedN, routeKey]);

  // a dialog opened over the page (not by us) hides the tour until it closes
  const touring = tour !== null;
  useEffect(() => {
    if (!touring) return;
    const t = setInterval(() => setBlocked(dialogOpen()), POLL_MS);
    return () => clearInterval(t);
  }, [touring]);

  const end = useCallback(() => {
    setTour(null);
    setRanOn(routeKey);
    setRequest(null);
    const el = restoreRef.current;
    restoreRef.current = null;
    if (el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
  }, [routeKey]);

  const onMove = useCallback(
    (move: TourMove) => {
      if (!tour) return;
      const present = (id: string) => {
        const m = tour.steps.find((s) => s.id === id);
        return !!m && !!findAnchor(m.selector);
      };
      const out = moveTour(tour.run, move, tour.kind === 'page' ? pageIds : [], present);
      // a page tour records its steps (and, run to its end, the page); an item's tip, run to Done, ticks its item
      const itemDone = tour.kind === 'item' && tour.item && out.run === null && move === 'next' ? [itemDoneKey(tour.item)] : [];
      const record = [...(tour.kind === 'page' ? out.record : []), ...finishRecord(move, out.run === null, tour.kind, tourDoneKey(tour.key)), ...itemDone];
      if (record.length) {
        setAcked((prev) => new Set([...prev, ...record]));
        markSeen(record);
      }
      if (out.run) setTour({ ...tour, run: out.run });
      else end();
    },
    [tour, pageIds, markSeen, end],
  );

  const onConfirm = useCallback(
    (step: TourStep) => {
      const ids = (step as Step).confirm?.seen ?? [];
      if (ids.length) markSeen(ids);
      end();
    },
    [markSeen, end],
  );

  if (!tour || tour.key !== routeKey || blocked || paused) return null;
  return <SpotlightTour steps={tour.steps} index={tour.run.index} onMove={onMove} onConfirm={onConfirm} />;
}
