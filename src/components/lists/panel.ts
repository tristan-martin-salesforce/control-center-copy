'use client';
/**
 * The list pages and the v2 docked right panel (docs/archive/2026-build/BUILD-V2.md "Seams"). Detail never opens in a
 * page-owned sheet: a click or Enter calls `openDetails({ kind, id, label })`, an open Details tab follows
 * the selection as j/k move it, and Esc closes the panel. `window.__ccOpenDetails` (smoke tests) sees
 * every Details request, which proves the calls while the provider is still a no-op.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
// The leaf module, not the shell barrel: the docked DraftPanel reuses useFollowWhenGone, and the shell barrel
// imports the detail barrel (an import cycle).
import { useRightPanel, type PanelEntity } from '@/components/shell/panel';
import { isLocalChange } from '@/client/intent';
import { clearGone, markGone } from './gone';

type Spy = (e: PanelEntity) => void;

/** Spy seam for smoke tests (same name Home uses). */
export function notifyOpenDetails(e: PanelEntity): void {
  if (typeof window === 'undefined') return;
  const spy = (window as { __ccOpenDetails?: Spy }).__ccOpenDetails;
  if (typeof spy === 'function') spy(e);
}

export interface ListPanel {
  /** The panel is open on Details. */
  detailsOpen: boolean;
  /** Id of the entity open in Details (its row's verb stays quiet: the panel footer holds the filled button). */
  openId: string | null;
  open: (e: PanelEntity) => void;
  /** Retarget an open Details tab (j/k moved the selection). No-op while the panel is closed. */
  follow: (e: PanelEntity) => void;
  /** Esc: close the panel. Returns false when it was not open (so the key can do something else). */
  close: () => boolean;
}

export function useListPanel(): ListPanel {
  const panel = useRightPanel();
  const detailsOpen = panel.open && panel.tab === 'details';
  const openId = detailsOpen ? (panel.entity?.id ?? null) : null;
  const { openDetails, close: closePanel, open: isOpen } = panel;
  const open = useCallback(
    (e: PanelEntity) => {
      notifyOpenDetails(e);
      openDetails(e);
    },
    [openDetails],
  );
  const follow = useCallback(
    (e: PanelEntity) => {
      if (!detailsOpen || openId === e.id) return;
      notifyOpenDetails(e);
      openDetails(e);
    },
    [detailsOpen, openId, openDetails],
  );
  const close = useCallback(() => {
    if (!isOpen) return false;
    closePanel();
    return true;
  }, [isOpen, closePanel]);
  return useMemo(() => ({ detailsOpen, openId, open, follow, close }), [detailsOpen, openId, open, follow, close]);
}

export interface FollowWhenGoneOptions {
  /** What the panel says when the open item left elsewhere (default "No longer in this list"). */
  goneTitle?: string;
  goneBody?: string;
  /** The Next button's label ("Next draft"). */
  nextLabel?: string;
}

/**
 * The "n of N" flow: when the item open in Details leaves the list because the user acted on it (done, accepted or
 * sent from the panel's own footer), Details moves on to its neighbour, the way the old sheet's j/k flow did.
 * When it left because of something elsewhere (docs/UX.md "Live updates"), the panel stays on it and says so
 * (`markGone`: "Applied elsewhere" with Next and Close) instead of jumping under the user.
 */
export function useFollowWhenGone(ids: string[], openId: string | null, select: (id: string) => void, listKey = '', opts: FollowWhenGoneOptions = {}): void {
  const prev = useRef<{ ids: string[]; key: string }>({ ids, key: listKey });
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => {
    const { ids: before, key } = prev.current;
    prev.current = { ids, key: listKey };
    if (openId && ids.includes(openId)) clearGone(openId); // it came back (Undo, a rollback)
    // A new tab or filter is a new list, not a removal.
    if (key !== listKey || !openId || ids.includes(openId) || !before.includes(openId)) return;
    const i = before.indexOf(openId);
    const next = before.slice(i + 1).find((x) => ids.includes(x)) ?? before.slice(0, i).reverse().find((x) => ids.includes(x));
    if (isLocalChange(openId)) {
      if (next) select(next);
      return;
    }
    markGone(openId, {
      title: o.current.goneTitle ?? 'No longer in this list',
      body: o.current.goneBody ?? 'It changed elsewhere while you had it open. It stays here so you can finish reading.',
      ...(next ? { next: () => select(next), nextLabel: o.current.nextLabel ?? 'Next' } : {}),
    });
  }, [ids, openId, select, listKey]);
  // Moving off the item (or closing the panel) drops its note.
  useEffect(() => {
    if (!openId) return;
    return () => clearGone(openId);
  }, [openId]);
}

const WIDE_QUERY = '(min-width: 2400px)';
const subscribeWide = (fn: () => void) => {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
};

/** 2,400 px and wider: sections show 5 rows instead of 3 (DESIGN-V2 principle 2). */
export function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}
