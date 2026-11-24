/**
 * Frame navigation (DESIGN-V2 principle 10): the sidebar's groups, their `g` chords, and the frame
 * sizes. Counts only where you must act (UI-SPEC §2); the Outbox count turns red while approvals wait, and so does
 * Time's while logging canvases or VDP changes wait for Apply (D-52: admin items are applied on Time).
 *
 * Personas (D-55): an item that belongs to a persona feature names it (`feature`); `navGroupsFor` and
 * `navDestinationsFor` drop it while the feature is inactive (inactive means no daily surface). No item has one yet,
 * so every persona sees the same sidebar today: this is the seam.
 */
import type { PersonaFeature } from '@/contract';
import { allows } from '@/personas/gates';
import type { ResolvedPersona } from '@/personas/types';

export type NavCountKey = 'needs' | 'today' | 'triage' | 'agentsWaiting' | 'outbox' | 'briefsUnread' | 'adminWaiting' | 'assistantPending';

export interface NavItemDef {
  href: string;
  label: string;
  /** Utility icon name. */
  icon: string;
  /** `g` chord ("g h"). */
  chord: string;
  count?: NavCountKey;
  /** Extra path prefixes that light this item (detail pages). */
  also?: string[];
  /** The persona feature this destination belongs to (D-55): hidden while it is inactive. */
  feature?: PersonaFeature;
}

export interface NavGroupDef {
  id: string;
  /** Group label ("Context"); none for the first group. */
  label?: string;
  items: NavItemDef[];
}

export const NAV_GROUPS: NavGroupDef[] = [
  {
    id: 'main',
    items: [
      // 01 R5 / D-86: the one Needs-you count (the queue's total, src/engines/needs/count.ts) sits on Home until Needs you has its own page
      { href: '/', label: 'Home', icon: 'home', chord: 'g h', count: 'needs' },
      { href: '/today', label: 'Today', icon: 'event', chord: 'g y', count: 'today' },
      { href: '/triage', label: 'Triage', icon: 'filterList', chord: 'g t', count: 'triage' },
      { href: '/outbox', label: 'Outbox', icon: 'send', chord: 'g o', count: 'outbox' },
      // 2026-11-13 audit C8: a quiet count of the cards staged and not applied yet
      { href: '/assistant', label: 'Assistant', icon: 'sparkles', chord: 'g c', count: 'assistantPending' },
    ],
  },
  {
    id: 'context',
    label: 'Context',
    items: [
      { href: '/work', label: 'Work', icon: 'task', chord: 'g w', also: ['/initiatives'] },
      { href: '/deals', label: 'Deals', icon: 'opportunity', chord: 'g d' },
      { href: '/briefs', label: 'Briefs', icon: 'summary', chord: 'g b', count: 'briefsUnread' },
      { href: '/agents', label: 'Agents', icon: 'agent_session', chord: 'g a', count: 'agentsWaiting' },
      { href: '/activity', label: 'Activity', icon: 'clock', chord: 'g l', count: 'adminWaiting', also: ['/time'] },
      { href: '/history', label: 'Journal', icon: 'recent', chord: 'g i' },
    ],
  },
];

export const SETTINGS_NAV: NavItemDef = { href: '/settings', label: 'Settings', icon: 'settings', chord: 'mod+,' };
export const HEALTH_NAV: NavItemDef = { href: '/health', label: 'Health', icon: 'connected_apps', chord: 'g s' };

/** Every chord-reachable destination, in sidebar order (GlobalKeys, ⌘K "Go to", the cheat sheet). */
export const NAV_DESTINATIONS: NavItemDef[] = [...NAV_GROUPS.flatMap((g) => g.items), HEALTH_NAV];

/** Whether this persona has the destination (a gated item is hidden while the persona loads). */
export function navAllows(item: Pick<NavItemDef, 'feature'>, persona: ResolvedPersona | null | undefined): boolean {
  return allows(persona, item.feature ? { feature: item.feature } : undefined);
}

/** The sidebar's groups for this persona: items whose feature is inactive drop, and so does a group left empty. */
export function navGroupsFor(persona: ResolvedPersona | null | undefined, groups: NavGroupDef[] = NAV_GROUPS): NavGroupDef[] {
  return groups.map((g) => ({ ...g, items: g.items.filter((it) => navAllows(it, persona)) })).filter((g) => g.items.length > 0);
}

/** The chord-reachable destinations for this persona (GlobalKeys, ⌘K "Go to"). */
export function navDestinationsFor(persona: ResolvedPersona | null | undefined, list: NavItemDef[] = NAV_DESTINATIONS): NavItemDef[] {
  return list.filter((it) => navAllows(it, persona));
}

export function isNavActive(item: Pick<NavItemDef, 'href' | 'also'>, pathname: string): boolean {
  const p = pathname.split('?')[0] || '/';
  if (item.href === '/') return p === '/';
  return [item.href, ...(item.also ?? [])].some((h) => p === h || p.startsWith(`${h}/`));
}

// ── Frame sizes ─────────────────────────────────────────────────────────────────────────────

export const SIDEBAR_W = 232;
/** Collapsed icon rail (`[`). */
export const SIDEBAR_RAIL_W = 64;
/** Below this frame width the sidebar starts collapsed. */
export const SIDEBAR_AUTO_COLLAPSE = 1440;
export const TOPBAR_H = 64;
/** Docked right panel (Details · Assistant): 520 below a 2,400 px frame, 600 at 2,400 and wider. */
export const PANEL_W = 520;
export const PANEL_W_XL = 600;
export const PANEL_XL_FRAME = 2400;

export function panelWidthFor(frameWidth: number): number {
  return frameWidth >= PANEL_XL_FRAME ? PANEL_W_XL : PANEL_W;
}

/** Frame width tiers from UI-SPEC §3 (pages still read them through useShell().tier). */
export type FrameTier = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export function frameTier(width: number): FrameTier {
  if (width >= 2400) return 'xl';
  if (width >= 1920) return 'lg';
  if (width >= 1600) return 'md';
  if (width >= 1360) return 'sm';
  return 'xs';
}

// ── v1 compatibility (the primitives kit still renders NavTab specimens) ────────────────────

/** @deprecated v1 nav-bar tab shape; use NavItemDef. */
export type NavTabDef = NavItemDef;
/** @deprecated v1 flat tab list; use NAV_GROUPS. */
export const NAV_TABS: NavTabDef[] = NAV_GROUPS.flatMap((g) => g.items);
/** @deprecated v1 name; use isNavActive. */
export const isTabActive = isNavActive;
