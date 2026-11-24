'use client';
/**
 * The one live-list pattern (docs/UX.md "Live updates"): every page that lists rows applies fresh data through
 * `useLiveList`, so nothing moves under the cursor, arrivals are marked gently, and rows that leave elsewhere fade out
 * in place. `useArrivalHold` tells it when to hold arrivals (scrolled down, pointer moving, typing in the list);
 * `LivePill` (src/ui/Live.tsx) is the "N new · Show" affordance.
 *
 *   const hold = useArrivalHold(listRef);
 *   const live = useLiveList(rows, resetKey, { hold, keep: panel.openId });
 *   live.items        // display order; rows fading out are included (render them with live.rowProps(id))
 *   live.held         // arrivals waiting behind <LivePill count={live.held.length} onShow={live.showHeld} />
 *   live.isLeaving(id) // keep these out of keyboard ids
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { isLocalChange } from '@/client/intent';
import { departuresOf, mergeLive, survivorOf, type LiveMerge } from './live-merge';

/** `CSS.escape` where the environment has it (every browser); jsdom has none, so quote-escape the id there. */
const cssEscape = (s: string): string => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

/** How long a row that left elsewhere stays on screen (fading, then collapsing). Matches cc-live-out. */
export const LINGER_MS = 1_800;
/** How long an arrival keeps its mark (the highlight fades within it). Matches cc-live-in. */
export const MARK_MS = 3_000;
/** How long a row that left can come back to its old place (Undo windows are ~6 s; rollbacks can be slow). */
const RETURN_MS = 120_000;

export type LiveRowState = 'new' | 'leaving' | 'gone';

export interface LiveListOptions {
  /** Placeholder data while a new query loads: freeze the order so stale rows are never mistaken for new. */
  frozen?: boolean;
  /** Hold arrivals behind the pill (useArrivalHold: scrolled down or interacting). */
  hold?: boolean;
  /** More arrivals than this at once wait behind the pill. Default 3. */
  burst?: number;
  /** The row open in the panel (or selected): if it leaves elsewhere it stays on screen, marked gone, until you move on. */
  keep?: string | null;
  /** 'natural' (default): arrivals go where the server puts them; 'end': appended. */
  place?: 'natural' | 'end';
  /** Rows that leave elsewhere fade out in place (default true). */
  linger?: boolean;
  /** The highlight tone for arrivals: 'new' (blue, the default) or 'ai' (violet: AI drafts and suggestions). */
  tone?: 'new' | 'ai';
  /** The entity id behind a row id, when they differ (Home's `c:<id>`): what the user's writes name. */
  localId?: (id: string) => string;
}

export interface LiveRowProps {
  'data-live'?: LiveRowState;
  'data-live-tone'?: 'ai';
  'aria-hidden'?: true;
}

export interface LiveList<T extends { id: string }> {
  /** Items in display order: rows already on screen keep their place; rows fading out are included. */
  items: T[];
  /** Arrivals still marked as new (the highlight). */
  fresh: string[];
  /** Arrivals waiting behind the pill, in server order. */
  held: string[];
  /** Place the held arrivals now (the pill's Show), and bring the first into view. */
  showHeld: () => void;
  /** @deprecated the old "N new below" acknowledge: same as showHeld. */
  acknowledge: () => void;
  liveOf: (id: string) => LiveRowState | undefined;
  isLeaving: (id: string) => boolean;
  /** Spread on the row's root element: `data-live` drives the arrival highlight and the fade-out (src/styles/live.css). */
  rowProps: (id: string) => LiveRowProps;
}

/**
 * Live updates never reorder rows under the cursor (UI-SPEC §10, docs/UX.md "Live updates"). The first data (and any
 * `resetKey` change, such as a new tab or filter) takes the server's order; later data keeps the order on screen,
 * refreshes each row's fields in place, places arrivals at their natural place (or holds them behind the pill), and
 * lets rows that left elsewhere fade out. Rows the user removed in this tab leave at once (src/client/intent.ts).
 */
export function useLiveList<T extends { id: string }>(data: T[] | undefined, resetKey: string, opts: LiveListOptions = {}): LiveList<T> {
  const shownRef = useRef<string[]>([]);
  const heldRef = useRef<string[]>([]);
  const keyRef = useRef<string | null>(null);
  /** id → [the id that followed it when it left, when it left]. */
  const leftRef = useRef<Map<string, [string | null, number]>>(new Map());
  /** The last data of every row on screen: a row fading out renders from it. */
  const seenRef = useRef<Map<string, T>>(new Map());
  const lingerUntil = useRef<Map<string, number>>(new Map());
  const markedAt = useRef<Map<string, number>>(new Map());
  const flushRef = useRef(false);
  const scrollTo = useRef<string | null>(null);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const { frozen = false, hold = false, burst, keep = null, place, linger = true } = opts;
  const localIdRef = useRef(opts.localId);
  localIdRef.current = opts.localId;

  const merge = useMemo((): (LiveMerge & { initial: boolean }) | null => {
    if (!data || frozen) return null;
    const initial = keyRef.current !== resetKey;
    const now = Date.now();
    const cutoff = now - RETURN_MS;
    const returning = new Map([...leftRef.current].filter(([, [, at]]) => at >= cutoff).map(([id, [next]]) => [id, next] as const));
    const m = mergeLive({
      shown: shownRef.current,
      incoming: data.map((d) => d.id),
      held: heldRef.current,
      initial,
      returning,
      hold,
      burst,
      flush: flushRef.current,
      place,
      markReturning: (id) => !isLocalChange(localIdRef.current ? localIdRef.current(id) : id, now),
      linger: (id) => {
        if (!linger || !seenRef.current.has(id)) return false;
        if (id === keep) return true;
        const until = lingerUntil.current.get(id);
        return until !== undefined ? until > now : !isLocalChange(localIdRef.current ? localIdRef.current(id) : id, now);
      },
    });
    return { ...m, initial };
    // `tick` re-runs the merge when a fade or a mark expires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, resetKey, frozen, hold, burst, keep, place, linger, tick]);

  useEffect(() => {
    if (!merge || !data) return;
    const now = Date.now();
    if (merge.initial) {
      keyRef.current = resetKey;
      leftRef.current = new Map();
      lingerUntil.current = new Map();
      markedAt.current = new Map();
    } else {
      for (const [id, next] of departuresOf(shownRef.current, merge.order)) leftRef.current.set(id, [next, now]);
    }
    const onScreen = new Set(merge.order);
    for (const id of merge.order) leftRef.current.delete(id);
    for (const d of data) seenRef.current.set(d.id, d);
    for (const id of [...seenRef.current.keys()]) if (!onScreen.has(id)) seenRef.current.delete(id);
    const lingering = new Set(merge.lingering);
    for (const id of merge.lingering) if (!lingerUntil.current.has(id)) lingerUntil.current.set(id, now + LINGER_MS);
    for (const id of [...lingerUntil.current.keys()]) if (!lingering.has(id)) lingerUntil.current.delete(id);
    for (const id of merge.inserted) markedAt.current.set(id, now);
    for (const [id, at] of [...markedAt.current]) if (!onScreen.has(id) || now - at >= MARK_MS) markedAt.current.delete(id);
    shownRef.current = merge.order;
    heldRef.current = merge.held;
    if (flushRef.current) {
      flushRef.current = false;
      const first = scrollTo.current;
      scrollTo.current = null;
      if (first && typeof document !== 'undefined')
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-item-id="${cssEscape(first)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
    // One timer for the next fade or mark to expire.
    let next = Infinity;
    for (const [id, until] of lingerUntil.current) if (id !== keep) next = Math.min(next, until);
    for (const at of markedAt.current.values()) next = Math.min(next, at + MARK_MS);
    if (next === Infinity) return;
    const t = setTimeout(bump, Math.max(16, next - now + 16));
    return () => clearTimeout(t);
  }, [merge, data, resetKey, keep]);

  const order = merge?.order ?? shownRef.current;
  const held = merge?.held ?? heldRef.current;
  const items = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.map((d) => [d.id, d] as const));
    return order.map((id) => byId.get(id) ?? seenRef.current.get(id)).filter((d): d is T => !!d);
  }, [data, order]);

  const now = Date.now();
  const marked = new Set<string>(merge?.inserted ?? []);
  for (const [id, at] of markedAt.current) if (now - at < MARK_MS) marked.add(id);
  const lingeringSet = new Set(merge?.lingering ?? [...lingerUntil.current.keys()]);
  const fresh = order.filter((id) => marked.has(id) && !lingeringSet.has(id));
  const freshKey = fresh.join(',');
  const lingerKey = [...lingeringSet].join(',');
  const tone = opts.tone;

  const liveOf = useCallback(
    (id: string): LiveRowState | undefined => {
      if (lingeringSet.has(id)) return id === keep ? 'gone' : 'leaving';
      return fresh.includes(id) ? 'new' : undefined;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [freshKey, lingerKey, keep],
  );
  const rowProps = useCallback(
    (id: string): LiveRowProps => {
      const s = liveOf(id);
      if (!s) return {};
      return { 'data-live': s, ...(s === 'new' && tone === 'ai' ? { 'data-live-tone': 'ai' as const } : {}), ...(s === 'leaving' ? { 'aria-hidden': true as const } : {}) };
    },
    [liveOf, tone],
  );
  const isLeaving = useCallback((id: string) => lingeringSet.has(id), [lingerKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const showHeld = useCallback(() => {
    if (!heldRef.current.length && !(merge?.held.length ?? 0)) return;
    flushRef.current = true;
    scrollTo.current = (merge?.held ?? heldRef.current)[0] ?? null;
    bump();
  }, [merge]);

  return { items, fresh, held, showHeld, acknowledge: showHeld, liveOf, isLeaving, rowProps };
}

/**
 * For a small list a page renders as is (a card's drafts, a run's steps): the ids that appeared since the last render,
 * marked for MARK_MS. Never on the first render (that is the list, not arrivals).
 */
export function useNewIds(ids: readonly string[]): ReadonlySet<string> {
  const prev = useRef<ReadonlySet<string> | null>(null);
  const [marked, setMarked] = useState<ReadonlyMap<string, number>>(() => new Map());
  const key = ids.join('\u0000');
  useEffect(() => {
    const before = prev.current;
    prev.current = new Set(ids);
    if (!before) return;
    const fresh = ids.filter((id) => !before.has(id));
    if (!fresh.length) return;
    const at = Date.now();
    setMarked((m) => new Map([...m, ...fresh.map((id) => [id, at] as const)]));
    const t = setTimeout(() => setMarked((m) => new Map([...m].filter(([, when]) => Date.now() - when < MARK_MS))), MARK_MS + 16);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => new Set([...marked.keys()].filter((id) => ids.includes(id))), [marked, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Keyboard selection keeps its row: when the selected row leaves the list (done here or elsewhere), the selection moves
 * to its neighbour (the next row, else the previous) instead of jumping back to the top or vanishing.
 */
export function useSelectionSurvives(ids: readonly string[], selected: string | null | undefined, setSelected: (id: string) => void): void {
  const prev = useRef<readonly string[]>(ids);
  const set = useRef(setSelected);
  set.current = setSelected;
  useEffect(() => {
    const before = prev.current;
    prev.current = ids;
    const next = survivorOf(before, ids, selected);
    if (next) set.current(next);
  }, [ids, selected]);
}

// ── when to hold arrivals ───────────────────────────────────────────────────────────────────

/** The pointer counts as "moving toward a click" for this long after it last moved over the list. */
const MOVING_MS = 700;
/** Scrolled past the list's top by more than this: arrivals wait behind the pill. */
const SCROLLED_PX = 80;
const EDITABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=button]),textarea,select,[contenteditable=true]';

function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll' || o === 'overlay') return p;
  }
  return null;
}

/**
 * True while arrivals should not enter the list: the list's top is scrolled out of view, the pointer is moving over it
 * (a row must never jump under a click), a button is pressed in it, or the user is typing in a field inside it.
 * Arrivals then wait behind the pill; when the hold ends a few of them slide in on their own.
 */
export function useArrivalHold(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolled, setScrolled] = useState(false);
  const [busy, setBusy] = useState(false);
  // The list element mounts after the first data: pick it up on any later commit (a ref change triggers no render,
  // so this runs after every commit; it only sets state when the element changed, so it never loops).
  const [node, setNode] = useState<HTMLElement | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ref.current !== node) setNode(ref.current);
  });
  useEffect(() => {
    if (!node || typeof window === 'undefined') return;
    let moving: ReturnType<typeof setTimeout> | null = null;
    let pressed = false;
    let typing = false;
    let isBusy = false;
    const sync = () => {
      const b = pressed || typing || moving !== null;
      if (b !== isBusy) {
        isBusy = b;
        setBusy(b);
      }
    };
    const onMove = () => {
      if (moving) clearTimeout(moving);
      moving = setTimeout(() => {
        moving = null;
        sync();
      }, MOVING_MS);
      sync();
    };
    const onDown = () => {
      pressed = true;
      sync();
    };
    const onUp = () => {
      if (!pressed) return;
      pressed = false;
      onMove();
    };
    const onFocusIn = (e: FocusEvent) => {
      typing = e.target instanceof HTMLElement && e.target.matches(EDITABLE);
      sync();
    };
    const onFocusOut = () => {
      typing = false;
      sync();
    };
    let scroller = scrollParentOf(node);
    const onScroll = () => {
      // the list is its own scroller (a list frame's body): how far it scrolled; else how far its top is above the view
      if (scroller === node) return setScrolled(node.scrollTop > SCROLLED_PX);
      const top = node.getBoundingClientRect().top;
      const edge = scroller ? scroller.getBoundingClientRect().top : 0;
      setScrolled(top < edge - SCROLLED_PX);
    };
    const target: HTMLElement | Window = scroller ?? window;
    node.addEventListener('pointermove', onMove, { passive: true });
    node.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });
    node.addEventListener('focusin', onFocusIn);
    node.addEventListener('focusout', onFocusOut);
    target.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      if (moving) clearTimeout(moving);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      node.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('focusout', onFocusOut);
      target.removeEventListener('scroll', onScroll);
      scroller = null;
    };
  }, [node]);
  return scrolled || busy;
}
