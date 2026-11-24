/**
 * Asking for guidance on a page: Getting started's "Take the tour" and "Show me", and the "?" popover's "Show this
 * page's tips again". One window event that CoachMarks handles on the page it names, once the navigation that
 * usually follows has landed, or at once when you are already there (the same URL: no navigation, the tip still
 * plays). A short-lived copy in sessionStorage carries it over the full page load a new build forces.
 *
 * A request plays whether or not the page was seen before: a page tour from step 1 (replay), an item's tip always.
 */
import type { GuideItemId } from './checklist';
import type { RouteKey } from '@/components/shell/routes';

export interface GuideRequest {
  /** The page to play it on; null: the page you are on (the Assistant, Feedback). */
  page: RouteKey | null;
  /** An action item's tip (items.ts); null: the page's whole tour. */
  item: GuideItemId | null;
}

/** A request as CoachMarks holds it: bound to a page, with a count so asking twice plays twice. */
export interface ActiveRequest {
  page: RouteKey;
  item: GuideItemId | null;
  n: number;
}

export const GUIDE_EVENT = 'cc:guide';
const STORE_KEY = 'cc:guide-request';
/** A stored request older than this is stale (the load it waited for never came). */
export const REQUEST_TTL_MS = 20_000;

/** Ask for guidance (then navigate, if the item has a place). */
export function requestGuide(r: GuideRequest): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify({ ...r, at: Date.now() }));
  } catch {
    /* storage off: the event alone still works within the page */
  }
  window.dispatchEvent(new CustomEvent<GuideRequest>(GUIDE_EVENT, { detail: r }));
}

/** A stored request, if it is fresh and well formed. */
export function parseStoredRequest(raw: string | null, now: number): GuideRequest | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { page?: unknown; item?: unknown; at?: unknown };
    if (typeof v.at !== 'number' || now - v.at > REQUEST_TTL_MS || now < v.at - 1000) return null;
    const page = typeof v.page === 'string' ? (v.page as RouteKey) : null;
    const item = typeof v.item === 'string' ? (v.item as GuideItemId) : null;
    return { page, item };
  } catch {
    return null;
  }
}

/** The request a full page load carried over (read on mount). */
export function storedGuideRequest(now = Date.now()): GuideRequest | null {
  try {
    return parseStoredRequest(window.sessionStorage.getItem(STORE_KEY), now);
  } catch {
    return null;
  }
}

/** The request was played (or given up on): a later load must not replay it. */
export function clearGuideRequest(): void {
  try {
    window.sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing stored */
  }
}

/** Take a request on page `here`: it binds to the page it names, or to `here` when it names none. */
export function activate(r: GuideRequest, here: RouteKey, n: number): ActiveRequest {
  return { page: r.page ?? here, item: r.item, n };
}

/** After a navigation: a request survives only on the page it names (it was waiting for that page to land). */
export function keepOnRoute(r: ActiveRequest | null, routeKey: RouteKey): ActiveRequest | null {
  return r && r.page === routeKey ? r : null;
}
