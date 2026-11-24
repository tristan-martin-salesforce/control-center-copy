'use client';
/**
 * The v2 sidebar (DESIGN-V2 principle 10): 232 px, dimmer than the content, collapsible to a 64 px
 * icon rail with `[` (and collapsed by default below a 1,440 px frame).
 *
 *   Brand     the gradient tile + "Command Center"
 *   Nav       Home · Today · Triage · Outbox · Assistant, then Context: Work · Deals · Briefs · Agents · Time
 *   Footer    Settings · one health line only when something is broken · "7/8 sources live · dry run"
 *             (Sources, Sending and Since you left) · "$0.64 of $5 today" · the scanner pulse as the
 *             status dot (it breathes only while a source catches up)
 *
 * Colour is an indicator: blue = active, red = broken (and the Outbox count while approvals wait).
 * Items that belong to a persona feature show only while it is active (navGroupsFor, D-55).
 */
import { AppLink } from './AppLink';
import { quietCountWhat } from './count-label';
import { usePathname } from 'next/navigation';
import { forwardRef, useMemo, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { HealthPayload, TodayPayload } from '@/contract';
import { usePersona } from '@/client/persona';
import { useLiveStatus } from '@/client/providers';
import { IconButton } from '@/ui/Button';
import { useNow } from '@/ui/clock';
import { cn } from '@/ui/cn';
import { Icon } from '@/ui/Icon';
import { KbdHint } from '@/ui/Kbd';
import { Tooltip } from '@/ui/Tooltip';
import { LiveCount } from '@/ui/Live';
import { useChromeData } from './data';
import { isNavActive, navGroupsFor, SETTINGS_NAV, SIDEBAR_RAIL_W, SIDEBAR_W, type NavCountKey, type NavItemDef } from './nav';
import { usePendingPath } from './nav-pending';
import { ago, pulseFor } from './ScannerPulse';
import { useShellOptional } from './ShellContext';
import { SpendPopover, StatusPopover } from './StatusPanels';
import { FooterVersion } from './FooterVersion';
import { GuideRoot } from '@/guide/GuideRoot';
import { timeBadges } from '@/components/time/badges';
import { useNeeds } from '@/components/needs/useNeeds';
import { needsCount } from '@/engines/needs/count';

export function LogoTile({ className }: { className?: string }) {
  return (
    <AppLink
      href="/"
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-brand text-caption leading-none font-bold text-white no-underline hover:text-white hover:no-underline focus-visible:outline-none focus-visible:shadow-focus',
        className,
      )}
    >
      {/* named by the sr-only text, not an aria-label: the visible "cc" mark is not a word of the name (WCAG 2.5.3) */}
      <span aria-hidden>cc</span>
      <span className="sr-only">Command Center: Home</span>
    </AppLink>
  );
}

// ── Counts ──────────────────────────────────────────────────────────────────────────────────

/** `needs`: the Needs-you queue's total (needsCount over GET /needs), the one count every surface shows. */
export function navCount(today: TodayPayload | undefined, key: NavCountKey | undefined, needs?: number): number | undefined {
  if (key === 'needs') return needs;
  if (!today || !key) return undefined;
  if (key === 'today') return today.nowStack.cards.length + today.moreToday.count;
  // Time: the admin items waiting for Apply (loud), else the VDPs that need you (quiet, D-59); the sum of Time's tab
  // badges, and its link lands on the tab that holds the count (D-60)
  if (key === 'adminWaiting') return timeBadges(today.navCounts).sidebar;
  return today.navCounts[key];
}

/** Where a nav item's link lands: Time goes to the tab that holds its count (D-60); every other item to its page. */
export function navHref(today: TodayPayload | undefined, item: Pick<NavItemDef, 'href' | 'count'>): string {
  return item.count === 'adminWaiting' && today ? timeBadges(today.navCounts).href : item.href;
}

/** Only approvals waiting are loud: messages in the Outbox, admin items (canvases, VDP changes) on Time. */
export function navAttn(today: TodayPayload | undefined, key: NavCountKey | undefined): boolean {
  if (!today) return false;
  return key === 'outbox' ? today.navCounts.outbox > 0 : key === 'adminWaiting' ? today.navCounts.adminWaiting > 0 : false;
}

// ── Items ───────────────────────────────────────────────────────────────────────────────────

const ITEM =
  'group relative flex items-center rounded-md text-body no-underline transition-colors hover:no-underline focus-visible:outline-none focus-visible:shadow-focus';
const ITEM_IDLE = 'text-muted hover:bg-surface-muted hover:text-fg';
const ITEM_ACTIVE = 'bg-selected font-bold text-fg-heading hover:text-fg-heading';

export interface SidebarLinkProps {
  item: NavItemDef;
  active: boolean;
  count?: number;
  /** The count is approvals waiting (red); else a quiet count. */
  attn?: boolean;
  collapsed?: boolean;
  /** Where the link lands when it is not the item's page (Time: the tab that holds its count, D-60). */
  href?: string;
}

export function SidebarLink({ item, active, count, attn: attnProp, collapsed, href }: SidebarLinkProps) {
  const attn = (attnProp ?? ((item.count === 'outbox' || item.count === 'adminWaiting') && !!count)) && !!count;
  // a quiet count says what it counts (2026-11-13 audit C2: Time's also counts DCs and use cases waiting for a canvas)
  const quietWhat = quietCountWhat(item.count, count ?? 0);
  const countLabel = count ? ` (${count}${attn ? ' waiting for approval' : quietWhat})` : '';
  const link = (
    <AppLink
      href={href ?? item.href}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? `${item.label}${countLabel}` : undefined}
      className={cn(ITEM, active ? ITEM_ACTIVE : ITEM_IDLE, collapsed ? 'size-10 justify-center' : 'h-10 gap-2.5 px-2.5')}
    >
      <Icon name={item.icon} size="lg" className={cn('opacity-90', active && 'opacity-100')} />
      {collapsed ? (
        attn ? <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger-500" /> : null
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {count ? (
            <span className={cn('text-caption tabular-nums', attn ? 'font-bold text-danger-700' : 'text-muted')}>
              <LiveCount value={count} />
              {/* what the count counts, read after the number (an aria-label on a plain span is dropped) */}
              <span className="sr-only">{attn ? ' waiting for approval' : quietWhat}</span>
            </span>
          ) : null}
        </>
      )}
    </AppLink>
  );
  if (!collapsed) return link;
  return (
    <Tooltip
      side="right"
      content={
        <span className="inline-flex items-center gap-1.5">
          {item.label}
          {count ? <span className="tabular-nums">· {count}</span> : null}
          <KbdHint combo={item.chord} tone="inverse" />
        </span>
      }
    >
      {link}
    </Tooltip>
  );
}

/** A footer button that can be a Popover trigger and still carry a tooltip. */
const FootButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { tip?: ReactNode }>(function FootButton({ tip, className, children, ...rest }, ref) {
  const btn = (
    <button
      ref={ref}
      type="button"
      className={cn('flex min-w-0 items-center gap-2 rounded-md text-left transition-colors hover:bg-surface-muted hover:text-fg focus-visible:outline-none focus-visible:shadow-focus aria-expanded:bg-surface-muted aria-expanded:text-fg', className)}
      {...rest}
    >
      {children}
    </button>
  );
  return tip ? (
    <Tooltip side="right" content={tip}>
      {btn}
    </Tooltip>
  ) : (
    btn
  );
});

// ── Footer pieces (pure, so the kit can render every state) ─────────────────────────────────

export interface BrokenLine {
  id: string;
  text: string;
}

/** What's broken, worst first: re-auth and failing connectors, and a stopped worker. */
export function brokenLines(health: HealthPayload | undefined): BrokenLine[] {
  if (!health) return [];
  const out: BrokenLine[] = [];
  if (health.worker && !health.worker.alive) out.push({ id: 'worker', text: 'Scanner worker stopped' });
  for (const b of health.summary.broken) {
    if (b.state === 'auth_needed') out.push({ id: b.id, text: `${b.label} needs re-auth` });
    else if (b.state === 'error') out.push({ id: b.id, text: `${b.label} is failing` });
  }
  return out;
}

const PULSE_DOT = { live: 'bg-success-500', catching: 'bg-accent', stale: 'bg-warning-500', off: 'bg-faint' } as const;

export interface StatusLineModel {
  text: string;
  sending: 'dry run' | 'live send';
  tone: keyof typeof PULSE_DOT;
  detail: string;
}

/** "7/8 sources live · dry run"; the pulse takes over the first half only when it has news. */
export function statusLine(health: HealthPayload | undefined, now: Date, live: string): StatusLineModel {
  const sending = health?.dryRun === false ? 'live send' : 'dry run';
  if (!health) return { text: 'Checking sources…', sending, tone: 'off', detail: '' };
  const p = pulseFor(health.connectors, now, live);
  const s = health.summary;
  const latest = health.connectors.map((c) => (c.lastSuccessAt ? Date.parse(c.lastSuccessAt) : 0)).reduce((a, b) => Math.max(a, b), 0);
  const text =
    p.tone === 'live'
      ? `${s.ok}/${s.total} sources live`
      : p.tone === 'stale' && latest
        ? `Last scan ${ago((now.getTime() - latest) / 1000)}`
        : p.label;
  return { text, sending, tone: p.tone, detail: p.detail };
}

function fmtBudget(n: number) {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export function spendLine(spend: HealthPayload['spend'] | undefined): { text: string; tone: 'quiet' | 'warn' | 'risk' } | null {
  if (!spend) return null;
  if (spend.state === 'capped') return { text: `Spend cap reached · ${fmtBudget(spend.today.usd)}`, tone: 'risk' };
  return { text: `${fmtBudget(spend.today.usd)} of ${fmtBudget(spend.today.softBudgetUsd)} today`, tone: spend.state === 'ok' ? 'quiet' : 'warn' };
}

export interface SidebarFooterProps {
  health?: HealthPayload;
  pathname: string;
  collapsed?: boolean;
  /** Kit specimens render without popovers. */
  static?: boolean;
}

export function SidebarFooter({ health, pathname, collapsed, static: isStatic }: SidebarFooterProps) {
  const now = useNow(5_000);
  const live = useLiveStatus();
  const broken = brokenLines(health);
  const status = statusLine(health, now, live);
  const spend = spendLine(health?.spend);
  const statusLabel = `${status.text} · ${status.sending}`;
  const dot = (
    <span className="relative grid size-2 shrink-0 place-items-center" aria-hidden>
      {status.tone === 'catching' ? <span className="absolute inset-0 rounded-full bg-accent opacity-50 motion-safe:animate-ping" style={{ animationDuration: '2.4s' }} /> : null}
      <span className={cn('relative size-2 rounded-full', PULSE_DOT[status.tone])} />
    </span>
  );

  const statusTrigger = (
    <FootButton
      aria-label={`${statusLabel}. Sources, sending and since you left.`}
      tip={collapsed ? statusLabel : status.detail || null}
      className={collapsed ? 'size-10 justify-center' : '-mx-2 min-h-8 px-2 py-1.5'}
    >
      {dot}
      {collapsed ? null : (
        <span className="min-w-0">
          {status.text} · <span className={status.sending === 'live send' ? 'font-bold text-warning-700' : undefined}>{status.sending}</span>
        </span>
      )}
    </FootButton>
  );

  const spendTrigger = spend ? (
    <FootButton aria-label={`AI spend: ${spend.text}`} className={cn('-mx-2 min-h-8 px-2 py-1.5', spend.tone === 'quiet' ? 'text-faint' : spend.tone === 'warn' ? 'font-bold text-warning-700' : 'font-bold text-danger-700')}>
      <span className="min-w-0">{spend.text}</span>
    </FootButton>
  ) : null;

  return (
    <div className={cn('flex shrink-0 flex-col border-t border-line pt-3 text-caption text-muted', collapsed ? 'items-center gap-1' : 'gap-0.5')}>
      <SidebarLink item={SETTINGS_NAV} active={isNavActive(SETTINGS_NAV, pathname)} collapsed={collapsed} />
      <div className={cn('flex flex-col', collapsed ? 'items-center gap-1 pt-1' : 'gap-0.5 px-2.5 pt-1.5')}>
        {broken.length ? (
          collapsed ? (
            <Tooltip side="right" content={broken.map((b) => b.text).join(' · ')}>
              <AppLink href="/health" aria-label={`Broken: ${broken.map((b) => b.text).join(', ')}. Open Health.`} className="grid size-10 place-items-center rounded-md text-danger-700 hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus">
                <Icon name="warning" size="md" />
              </AppLink>
            </Tooltip>
          ) : (
            <AppLink
              href="/health"
              className="-mx-2 flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-fg no-underline hover:bg-surface-muted hover:text-fg hover:no-underline focus-visible:outline-none focus-visible:shadow-focus"
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger-500" />
              <span className="min-w-0">
                {broken[0]!.text}
                {broken.length > 1 ? <span className="font-normal text-muted"> · +{broken.length - 1}</span> : null}
              </span>
            </AppLink>
          )
        ) : null}
        {isStatic ? statusTrigger : <StatusPopover health={health} trigger={statusTrigger} />}
        {collapsed || !spendTrigger ? null : isStatic ? spendTrigger : <SpendPopover spend={health?.spend} trigger={spendTrigger} />}
        {isStatic ? null : <FooterVersion collapsed={collapsed} />}
      </div>
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────────────────────

export interface SidebarProps {
  /** Override the shell's collapsed state (kit specimens). */
  collapsed?: boolean;
  /** Override the data (kit specimens); otherwise the live chrome queries. */
  today?: TodayPayload;
  health?: HealthPayload;
  /** Override the Needs-you count (kit specimens); otherwise GET /needs. */
  needs?: number;
  /** Override the active route (kit specimens). */
  pathname?: string;
  static?: boolean;
  className?: string;
}

export function Sidebar({ collapsed: collapsedProp, today: todayProp, health: healthProp, needs: needsProp, pathname: pathnameProp, static: isStatic, className }: SidebarProps) {
  const shell = useShellOptional();
  const routePath = usePathname() ?? '/';
  // A pending navigation lights its destination at once (the route may still be compiling or loading).
  const pendingPath = usePendingPath();
  const pathname = pathnameProp ?? pendingPath ?? routePath;
  const chrome = useChromeData();
  const today = todayProp ?? chrome.today.data;
  const health = healthProp ?? chrome.health.data;
  const needsQ = useNeeds({ enabled: needsProp === undefined });
  const needs = needsProp ?? (needsQ.data ? needsCount(needsQ.data) : undefined);
  const collapsed = collapsedProp ?? shell?.sidebarCollapsed ?? false;
  const toggle = shell?.toggleSidebar;
  const persona = usePersona();
  const groups = useMemo(() => navGroupsFor(persona), [persona]);

  return (
    <aside
      aria-label="Sidebar"
      data-collapsed={collapsed ? '' : undefined}
      // rem-based (the --sidebar-w token), so the sidebar grows with the text-size pref: 232 / 64 px at 16 px.
      style={{ width: collapsed ? `${SIDEBAR_RAIL_W / 16}rem` : `var(--sidebar-w, ${SIDEBAR_W / 16}rem)` }}
      className={cn('group/sidebar relative z-20 flex h-full min-h-0 shrink-0 flex-col border-r border-line bg-sidebar pt-4 pb-4 transition-[width] duration-(--dur-prompt)', collapsed ? 'items-center px-3' : 'px-3', className)}
    >
      <div className={cn('relative flex shrink-0 items-center', collapsed ? 'flex-col gap-3 pb-4' : 'gap-2.5 px-2 pt-1 pb-4')}>
        <LogoTile />
        {collapsed ? null : <span className="min-w-0 flex-1 text-body font-bold whitespace-nowrap text-fg-heading">Command Center</span>}
        {toggle && !isStatic ? (
          <Tooltip side="right" content={<span className="inline-flex items-center gap-1.5">{collapsed ? 'Expand sidebar' : 'Collapse sidebar'} <KbdHint combo="[" tone="inverse" /></span>}>
            <IconButton
              icon={collapsed ? 'toggle_panel_right' : 'toggle_panel_left'}
              label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              size="sm"
              className={cn(
                'text-faint',
                !collapsed && 'absolute top-0.5 right-0 bg-sidebar opacity-0 transition-opacity group-hover/sidebar:opacity-100 group-focus-within/sidebar:opacity-100 focus-visible:opacity-100',
              )}
              aria-keyshortcuts="["
              onClick={toggle}
            />
          </Tooltip>
        ) : null}
      </div>

      <nav aria-label="Primary" className={cn('cc-scroll flex min-h-0 flex-1 flex-col overflow-y-auto', collapsed ? 'items-center gap-1' : 'gap-0.5')}>
        {groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.label ?? 'Main'} className={cn('flex flex-col', collapsed ? 'items-center gap-1' : 'gap-0.5', g.label && (collapsed ? 'mt-2 border-t border-line pt-3' : 'mt-3'))}>
            {g.label && !collapsed ? <span className="px-2.5 pt-1 pb-1 text-caption text-faint">{g.label}</span> : null}
            {g.items.map((it) => (
              <SidebarLink key={it.href} item={it} active={isNavActive(it, pathname)} count={navCount(today, it.count, needs)} attn={navAttn(today, it.count)} href={navHref(today, it)} collapsed={collapsed} />
            ))}
          </div>
        ))}
      </nav>

      {isStatic ? null : <GuideRoot collapsed={collapsed} />}
      <SidebarFooter health={health} pathname={pathname} collapsed={collapsed} static={isStatic} />
    </aside>
  );
}
