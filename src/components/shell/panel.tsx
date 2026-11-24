'use client';
/**
 * v2 right-panel seam (docs/archive/2026-build/DESIGN-V2.md principle 10, docs/archive/2026-build/BUILD-V2.md "Seams").
 *
 * The frame has ONE docked right panel, shared by item detail and the assistant, with two tabs:
 *   - Details: whatever was clicked (a work item, draft, gap, event…), rendered by a registered renderer;
 *   - Assistant: the chat (⌘J), which always knows the current entity.
 * The panel pushes the content (no overlay). `#cc-main` carries `data-panel="open|closed"` and is the
 * `main` CSS container, so pages condense with `@container main (…)` queries.
 *
 * THE API BELOW IS FROZEN for the v2 lanes (RightPanelApi, PanelEntity, PanelTab, DetailRenderer,
 * registerDetailRenderer, getDetailRenderer, RightPanelProvider, useRightPanel). Pages and other lanes
 * only call `useRightPanel()` and `registerDetailRenderer()`.
 *
 * Shell-only extras (not for pages): `usePanelInternals()` (the Details dock that legacy SideSheets
 * portal into, visibility, focus return, lazy assistant mount), `useDetailRenderer()`,
 * `EnsureRightPanelProvider` and `PanelUrlSync`. Rendering lives in RightPanel.tsx; keys (⌘J, Esc, `]`)
 * in GlobalKeys.tsx.
 *
 * Mount order: the root layout puts RightPanelProvider ABOVE ChatProvider, so chat's "Looking at" chip
 * reads `useRightPanel().entity` directly (no bridge needed).
 *
 * /assistant: the page is the assistant, so the panel never shows its Assistant tab there. The state is
 * kept (leaving the page shows the panel again, which is how "Open as a panel" works); `visible` is what
 * the frame renders.
 */
import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { EntityType } from '@/contract';
import { api } from '@/client/api';

export type PanelTab = 'details' | 'assistant';

export interface PanelEntity {
  kind: EntityType;
  id: string;
  /** Short label for the tab header and the assistant's "Looking at:" chip. */
  label?: string;
}

export interface RightPanelApi {
  open: boolean;
  tab: PanelTab;
  entity: PanelEntity | null;
  /** Open (or retarget) the panel on Details for this entity; also becomes the assistant's context. */
  openDetails(entity: PanelEntity): void;
  /** Open on the Assistant tab. Passing an entity sets the context; omitting keeps the current one. */
  openAssistant(entity?: PanelEntity | null): void;
  /** ⌘J: open on Assistant, or close if Assistant is already showing. */
  toggleAssistant(): void;
  setTab(tab: PanelTab): void;
  /** Esc: close the panel; the page returns to full width. */
  close(): void;
}

export type DetailRenderer = (entity: PanelEntity) => ReactNode;

// ── Renderer registry ───────────────────────────────────────────────────────────────────────

const renderers = new Map<string, DetailRenderer>();
let registryVersion = 0;
const registryListeners = new Set<() => void>();
function bumpRegistry() {
  registryVersion += 1;
  registryListeners.forEach((l) => l());
}

/** Register how Details renders an entity kind (e.g. 'work_item' → <ItemDetail variant="panel">). Returns an unregister fn. */
export function registerDetailRenderer(kind: EntityType, renderer: DetailRenderer): () => void {
  renderers.set(kind, renderer);
  bumpRegistry();
  return () => {
    if (renderers.get(kind) === renderer) {
      renderers.delete(kind);
      bumpRegistry();
    }
  };
}

export function getDetailRenderer(kind: EntityType): DetailRenderer | undefined {
  return renderers.get(kind);
}

/** Shell: the renderer for a kind, re-rendering when registrations change. */
export function useDetailRenderer(kind: EntityType | undefined): DetailRenderer | undefined {
  useSyncExternalStore(
    (l) => {
      registryListeners.add(l);
      return () => registryListeners.delete(l);
    },
    () => registryVersion,
    () => registryVersion,
  );
  return kind ? renderers.get(kind) : undefined;
}

const KIND_LABEL: Partial<Record<EntityType, string>> = {
  work_item: 'Work item',
  initiative: 'Initiative',
  account: 'Account',
  opportunity: 'Opportunity',
  person: 'Person',
  asset: 'File',
  agent_run: 'Agent run',
  chat_thread: 'Chat',
  brief: 'Brief',
  calendar_event: 'Meeting',
  tool_adapter: 'Tool',
  vdp: 'VDP',
};

/** "Work item", "Meeting"… (the fallback header, and the assistant chip when an entity has no label). */
export function kindLabel(kind: EntityType): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ── Provider ────────────────────────────────────────────────────────────────────────────────

/** What the Details tab shows: a registered entity renderer, or a legacy SideSheet docked into it. */
export type DetailSource = 'entity' | 'sheet' | null;

export interface PanelInternals {
  source: DetailSource;
  /** Legacy SideSheets currently docked in Details. */
  sheetClaims: number;
  /** The Details container SideSheets portal into (SheetHost.dock). */
  dockEl: HTMLElement | null;
  setDockEl: (el: HTMLElement | null) => void;
  /** SheetHost.claimDock: a SideSheet opened; the panel shows it on Details until released. */
  claimSheet: () => () => void;
  setPanelEl: (el: HTMLElement | null) => void;
  /** The Assistant pane mounts on first use and then stays mounted (thread and drafts survive tab flips). */
  assistantMounted: boolean;
  /** Close from the frame (Esc, ✕, ⌘J, `]`): also closes any docked sheet and returns focus to the opener. */
  closeAndRestore: () => void;
  /** `]`: close, or reopen on the last useful tab. */
  togglePanel: () => void;
  /** What the frame renders: open, and not the Assistant tab on the assistant page. */
  visible: boolean;
  /** The current route is the full assistant page (/assistant). */
  assistantHere: boolean;
  /** Fill in a label for the current entity (URL restores carry none) without moving the panel. */
  labelEntity: (kind: EntityType, id: string, label: string) => void;
}

/** The full-page assistant route: there the page is the assistant, not the panel. */
export function isAssistantRoute(pathname: string | null | undefined): boolean {
  const p = (pathname ?? '').split('?')[0] ?? '';
  return p === '/assistant' || p.startsWith('/assistant/');
}

const NOOP_INTERNALS: PanelInternals = {
  source: null,
  sheetClaims: 0,
  dockEl: null,
  setDockEl: () => {},
  claimSheet: () => () => {},
  setPanelEl: () => {},
  assistantMounted: false,
  closeAndRestore: () => {},
  togglePanel: () => {},
  visible: false,
  assistantHere: false,
  labelEntity: () => {},
};

const noop = () => {};
const NOOP_API: RightPanelApi = {
  open: false,
  tab: 'details',
  entity: null,
  openDetails: noop,
  openAssistant: noop,
  toggleAssistant: noop,
  setTab: noop,
  close: noop,
};

const RightPanelContext = createContext<RightPanelApi | null>(null);
const PanelInternalsContext = createContext<PanelInternals>(NOOP_INTERNALS);

/** True while a click or key press is recent (transient user activation); true where the API is missing. */
function hasUserGesture(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return ua ? ua.isActive : true;
}

/** The docked SideSheet's own close button (src/ui/SideSheet header). Clicking it runs the page's onClose. */
const DOCKED_SHEET_CLOSE = '[data-docked] > header button[aria-label="Close"]';

export function RightPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTabState] = useState<PanelTab>('details');
  const [entity, setEntity] = useState<PanelEntity | null>(null);
  const [source, setSource] = useState<DetailSource>(null);
  const [sheetClaims, setSheetClaims] = useState(0);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const [assistantMounted, setAssistantMounted] = useState(false);
  const assistantHere = isAssistantRoute(usePathname());
  const visible = open && !(assistantHere && tab === 'assistant');

  // Live mirrors for callbacks that must stay stable (SideSheet re-claims when claimDock changes).
  const live = useRef({ open, tab, entity, source, claims: 0, visible, assistantHere });
  live.current = { ...live.current, open, tab, entity, source, visible, assistantHere };
  const panelEl = useRef<HTMLElement | null>(null);
  const dockRef = useRef<HTMLElement | null>(null);
  dockRef.current = dockEl;
  const opener = useRef<HTMLElement | null>(null);

  const rememberOpener = useCallback(() => {
    if (typeof document === 'undefined') return;
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body || panelEl.current?.contains(a)) return;
    opener.current = a;
  }, []);

  const show = useCallback((t: PanelTab) => {
    setTabState(t);
    if (t === 'assistant') setAssistantMounted(true);
    setOpen(true);
  }, []);

  const openDetails = useCallback(
    (e: PanelEntity) => {
      rememberOpener();
      setEntity(e);
      setSource('entity');
      show('details');
    },
    [rememberOpener, show],
  );

  const openAssistant = useCallback(
    (e?: PanelEntity | null) => {
      rememberOpener();
      if (e !== undefined) setEntity(e);
      show('assistant');
    },
    [rememberOpener, show],
  );

  const setTab = useCallback((t: PanelTab) => {
    setTabState(t);
    if (t === 'assistant') setAssistantMounted(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const closeAndRestore = useCallback(() => {
    // A docked legacy sheet belongs to its page: close it the way its own ✕ would (focus goes back to its row).
    const sheetClose = live.current.claims > 0 ? dockRef.current?.querySelector<HTMLButtonElement>(DOCKED_SHEET_CLOSE) : null;
    setOpen(false);
    if (sheetClose) {
      sheetClose.click();
      return;
    }
    const target = opener.current;
    if (target?.isConnected) requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }, []);

  const toggleAssistant = useCallback(() => {
    const { open: isOpen, tab: t } = live.current;
    if (isOpen && t === 'assistant') closeAndRestore();
    else openAssistant();
  }, [closeAndRestore, openAssistant]);

  const togglePanel = useCallback(() => {
    const { visible: shown, entity: e, claims, assistantHere: here } = live.current;
    if (shown) return closeAndRestore();
    rememberOpener();
    show(e || claims > 0 || here ? 'details' : 'assistant');
  }, [closeAndRestore, rememberOpener, show]);

  const claimSheet = useCallback(() => {
    live.current.claims += 1;
    setSheetClaims(live.current.claims);
    rememberOpener();
    setSource('sheet');
    // A sheet a page restores or auto-opens (no click or key behind it) never steals a showing Assistant.
    const { open: isOpen, tab: t } = live.current;
    if (!(isOpen && t === 'assistant' && !hasUserGesture())) show('details');
    let released = false;
    return () => {
      if (released) return;
      released = true;
      live.current.claims = Math.max(0, live.current.claims - 1);
      setSheetClaims(live.current.claims);
      if (live.current.claims === 0 && live.current.source === 'sheet') {
        // The sheet returns focus to its own row; the panel just steps aside (unless the user is chatting).
        if (live.current.tab === 'details') setOpen(false);
        setSource(live.current.entity ? 'entity' : null);
      }
    };
  }, [rememberOpener, show]);

  const setPanelEl = useCallback((el: HTMLElement | null) => {
    panelEl.current = el;
  }, []);

  const labelEntity = useCallback((kind: EntityType, id: string, label: string) => {
    setEntity((e) => (e && e.kind === kind && e.id === id && !e.label ? { ...e, label } : e));
  }, []);

  const api = useMemo<RightPanelApi>(
    () => ({ open, tab, entity, openDetails, openAssistant, toggleAssistant, setTab, close }),
    [open, tab, entity, openDetails, openAssistant, toggleAssistant, setTab, close],
  );
  const internals = useMemo<PanelInternals>(
    () => ({ source, sheetClaims, dockEl, setDockEl, claimSheet, setPanelEl, assistantMounted, closeAndRestore, togglePanel, visible, assistantHere, labelEntity }),
    [source, sheetClaims, dockEl, claimSheet, setPanelEl, assistantMounted, closeAndRestore, togglePanel, visible, assistantHere, labelEntity],
  );
  return (
    <RightPanelContext.Provider value={api}>
      <PanelInternalsContext.Provider value={internals}>{children}</PanelInternalsContext.Provider>
    </RightPanelContext.Provider>
  );
}

/** Mount a provider only when none is above (AppFrame outside the root layout: kits, tests). */
export function EnsureRightPanelProvider({ children }: { children: ReactNode }) {
  return useContext(RightPanelContext) ? <>{children}</> : <RightPanelProvider>{children}</RightPanelProvider>;
}

/** Safe anywhere: outside the provider (kits, tests) it returns a no-op API. */
export function useRightPanel(): RightPanelApi {
  return useContext(RightPanelContext) ?? NOOP_API;
}

/** Shell-only: the Details dock, sheet claims and frame-level close. */
export function usePanelInternals(): PanelInternals {
  return useContext(PanelInternalsContext);
}

// ── URL sync: ?panel=details&item=<id>[&kind=<kind>] · ?panel=assistant ───────────────────

const PANEL_PARAMS = ['panel', 'item', 'kind'] as const;

/** The work item a docked legacy sheet is showing (ItemDetail marks its root with data-item-id). */
function useDockedItemId(dockEl: HTMLElement | null, active: boolean): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!dockEl || !active) {
      setId(null);
      return;
    }
    const read = () => setId(dockEl.querySelector<HTMLElement>('[data-item-detail][data-item-id]')?.dataset.itemId ?? null);
    read();
    const mo = new MutationObserver(read);
    mo.observe(dockEl, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-item-id'] });
    return () => mo.disconnect();
  }, [dockEl, active]);
  return id;
}

/**
 * Mirror the panel into the URL so Next's router adopts it (B-073b). Next's patched replaceState skips its
 * sync for a state carrying its own `__NA` marker, which `window.history.state` does. The router then kept
 * the URL without the panel params: `useSearchParams` never saw them, and Next's next history write (a
 * page's router.replace such as Health's tab switch, a refresh, HMR) put the bare `/health` back. A fresh
 * state is adopted (Next copies its tree into it and restores in place: no fetch, no scroll).
 */
export function replacePanelUrl(url: URL | string) {
  window.history.replaceState(null, '', url);
}

/** Mount once in the frame: restores the panel from the URL on load and mirrors it with history.replaceState. */
export function PanelUrlSync() {
  const panel = useRightPanel();
  const { source, dockEl, visible, labelEntity } = usePanelInternals();
  const pathname = usePathname();
  const restored = useRef(false);
  const dockedItem = useDockedItemId(dockEl, visible && source === 'sheet');

  // Declared before the restore effect so the first commit never wipes the incoming params.
  useEffect(() => {
    if (!restored.current) return;
    const url = new URL(window.location.href);
    PANEL_PARAMS.forEach((k) => url.searchParams.delete(k));
    if (visible) {
      url.searchParams.set('panel', panel.tab);
      const item = panel.tab === 'details' ? (source === 'sheet' ? (dockedItem ? { kind: 'work_item' as const, id: dockedItem } : null) : panel.entity) : null;
      if (item) {
        url.searchParams.set('item', item.id);
        if (item.kind !== 'work_item') url.searchParams.set('kind', item.kind);
      }
    }
    if (url.href !== window.location.href) replacePanelUrl(url);
  }, [visible, panel.tab, panel.entity, source, dockedItem, pathname]);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const q = new URLSearchParams(window.location.search);
    const which = q.get('panel');
    if (which === 'assistant') panel.openAssistant();
    else if (which === 'details') {
      const id = q.get('item');
      const kind = EntityType.safeParse(q.get('kind') ?? 'work_item');
      if (id && kind.success) {
        panel.openDetails({ kind: kind.data, id });
        // The URL carries no label: fetch a work item's title so the assistant's "Looking at" chip reads well.
        if (kind.data === 'work_item') {
          void api('getItem', { params: { id } })
            .then((d) => labelEntity('work_item', id, d.item.title))
            .catch(() => undefined);
        }
      }
    }
    // once, on first mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
