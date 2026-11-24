'use client';
/**
 * AppFrame: the v2 cockpit frame (DESIGN-V2 principle 10). The page never scrolls as a whole:
 *
 *   ┌ Sidebar 232 (64 with `[`) ┬ Topbar 64: title · strip · ⌘K ······· next · Capture · Assistant ┐
 *   │ brand · nav · footer      ├ #cc-main (@container/main, scrolls) ┬ docked panel 520 / 600 ────┤
 *   │                           │                                     │ Details · Assistant ⌘J  ✕  │
 *
 * The panel pushes #cc-main (no overlay); #cc-main carries data-panel="open|closed". Legacy
 * <SideSheet>s land in the panel's Details tab through the SheetHost (always dock). Sheets that opt
 * out of docking still overlay the right of #cc-main.
 *
 * Navigation (router.ts): every in-frame page is a client route, so a click, `g` chord or ⌘K "Go to" changes the
 * URL at once (history.pushState, no server round-trip) and marks the navigation pending (nav-pending.ts): while it
 * is pending, #cc-main shows the destination's skeleton (RouteSkeleton.tsx) in place of the old page and the
 * sidebar and topbar follow the destination. The page replaces the skeleton as soon as React renders it, usually in
 * the same task. Focus the old page took with it stays on the body, where each page's keyboard model treats it as
 * "the page's main list is live"; the client router announces the new page instead.
 *
 * Slots: `children` = the page, `chatRail` = the Assistant tab content, `devToolbar` (dev only).
 */
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useResumeScroll, useResumeTracker } from '@/client/resume/hooks';
import { TimeZoneProvider } from '@/ui/clock';
import { PanelBoundary } from '@/ui/PanelBoundary';
import { SheetHostProvider, type SheetHost } from '@/ui/SideSheet';
import { CheatSheet } from './CheatSheet';
import { CommandPalette } from './CommandPalette';
import { useChromeData } from './data';
import { DETAIL_RENDERERS_REGISTERED } from './detail-renderers';
import { FirstScanBanner } from './FirstScanBanner';
import { GlobalKeys } from './GlobalKeys';
import { panelWidthFor } from './nav';
import { useNavPendingSync, usePendingPath } from './nav-pending';
import { registerFallbackRouter } from './router';
import { EnsureRightPanelProvider, PanelUrlSync, usePanelInternals } from './panel';
import { PrefsProvider } from './prefs';
import { RightPanelView } from './RightPanel';
import { RouteSkeleton } from './RouteSkeleton';
import { ShellProvider, useShell } from './ShellContext';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { BuildWatch } from './BuildWatch';
import { SkipLink } from '@/components/kit/SkipLink';

void DETAIL_RENDERERS_REGISTERED;

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function useFrameWidth(ref: RefObject<HTMLElement | null>) {
  const [w, setW] = useState(1440);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || window.innerWidth);
    const ro = new ResizeObserver((entries) => setW(Math.round(entries[0]!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function Workspace({ children, chatRail, devToolbar }: { children: ReactNode; chatRail: ReactNode; devToolbar?: ReactNode }) {
  const shell = useShell();
  const { dockEl, claimSheet, visible } = usePanelInternals();
  const pathname = usePathname();
  const mainRef = useRef<HTMLElement | null>(null);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  useResumeScroll(mainRef, 'main');
  useNavPendingSync();
  const pendingPath = usePendingPath();

  // Always dock: every dockable SideSheet portals into the panel's Details tab and opens the panel.
  const host = useMemo<SheetHost>(() => ({ overlay, dock: dockEl, claimDock: claimSheet }), [overlay, dockEl, claimSheet]);

  return (
    <SheetHostProvider value={host}>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <main
            ref={mainRef}
            id="cc-main"
            // the skip link's target: focusable from script only, never a tab stop of its own
            tabIndex={-1}
            data-slot="main"
            data-panel={visible ? 'open' : 'closed'}
            data-nav-pending={pendingPath ?? undefined}
            className="cc-scroll @container/main relative min-w-0 flex-1 overflow-y-auto focus:outline-none"
          >
            <PanelBoundary name="page" resetKeys={[pathname]}>
              {/* While a navigation is pending the old page stays mounted but hidden (an abandoned navigation puts
                  it back as it was) and the destination's skeleton shows; `contents` keeps the page sizing
                  against #cc-main. */}
              <div className="contents" style={pendingPath ? { display: 'none' } : undefined}>
                {children}
              </div>
              {pendingPath ? <RouteSkeleton pathname={pendingPath} /> : null}
            </PanelBoundary>
          </main>
          {/* Overlay host for sheets that opt out of docking: over the right of main, non-modal. */}
          <div ref={setOverlay} id="cc-sheet-host" className="pointer-events-none absolute inset-0 z-30 overflow-hidden" />
          {/* Dev toolbar sits bottom-right of the content, clear of the panel. */}
          {devToolbar}
        </div>
        <RightPanelView assistant={chatRail} width={panelWidthFor(shell.width)} />
      </div>
    </SheetHostProvider>
  );
}

/** Navigation to paths the client router does not serve (/onboarding, the kit) goes through Next's router. */
function FallbackRouter() {
  const router = useRouter();
  useEffect(() => {
    registerFallbackRouter(router);
    return () => registerFallbackRouter(null);
  }, [router]);
  return null;
}

function Overlays() {
  const shell = useShell();
  return (
    <>
      <FallbackRouter />
      <GlobalKeys />
      <PanelUrlSync />
      <CommandPalette open={shell.paletteOpen} onClose={() => shell.setPaletteOpen(false)} />
      <CheatSheet open={shell.cheatOpen} onClose={() => shell.setCheatOpen(false)} />
    </>
  );
}

function TimeZoneFromSettings({ children }: { children: ReactNode }) {
  const { settings } = useChromeData();
  return <TimeZoneProvider timeZone={settings.data?.profile.timezone}>{children}</TimeZoneProvider>;
}

export interface AppFrameProps {
  children: ReactNode;
  /** The Assistant tab content (ChatRail today, P-CHAT's AssistantPanel at merge). */
  chatRail: ReactNode;
  devToolbar?: ReactNode;
}

export function AppFrame({ children, chatRail, devToolbar }: AppFrameProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const width = useFrameWidth(rootRef);
  useResumeTracker();
  return (
    <div ref={rootRef} data-frame className="flex h-dvh w-full overflow-hidden">
      {/* WCAG 2.4.1: the first tab stop on every framed page */}
      <SkipLink />
      {/* The root layout mounts RightPanelProvider above ChatProvider; this only covers frames rendered elsewhere. */}
      <EnsureRightPanelProvider>
        <ShellProvider width={width}>
          <PrefsProvider>
            <TimeZoneFromSettings>
              <PanelBoundary name="sidebar">
                <Sidebar />
              </PanelBoundary>
              <div className="flex min-w-0 flex-1 flex-col">
                <PanelBoundary name="topbar">
                  <Topbar />
                </PanelBoundary>
                <FirstScanBanner />
                <BuildWatch />
                <Workspace chatRail={chatRail} devToolbar={devToolbar}>
                  {children}
                </Workspace>
              </div>
              <Overlays />
            </TimeZoneFromSettings>
          </PrefsProvider>
        </ShellProvider>
      </EnsureRightPanelProvider>
    </div>
  );
}
