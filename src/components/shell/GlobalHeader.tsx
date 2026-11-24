'use client';
/**
 * v1 global-header compatibility. The header is gone (DESIGN-V2: sidebar + topbar). These pieces stay
 * because the primitives kit still renders them; new chrome uses Sidebar.tsx and Topbar.tsx.
 */
import { AppLink } from './AppLink';
import type { HealthPayload } from '@/contract';
import { cn } from '@/ui/cn';
import { fmtUsd } from '@/ui/format';
import { Icon } from '@/ui/Icon';
import { TONE_DOT } from '@/ui/tones';
import { Tooltip } from '@/ui/Tooltip';
import { CONNECTOR_STATE_LABEL, connectorTone } from './data';
import { SearchField } from './Topbar';

export { LogoTile } from './Sidebar';

/** @deprecated use SearchField (Topbar.tsx). */
export function SearchButton({ onClick }: { onClick: () => void }) {
  return <SearchField onOpen={onClick} />;
}

/** @deprecated the sidebar footer shows health only when something is broken. */
export function HealthButton({ health }: { health?: HealthPayload }) {
  const s = health?.summary;
  const tone = connectorTone(s?.worst);
  const broken = s?.broken ?? [];
  const tip = !s ? 'Checking connectors…' : broken.length ? broken.map((b) => `${b.label}: ${CONNECTOR_STATE_LABEL[b.state]}`).join(' · ') : `All ${s.total} sources healthy`;
  return (
    <Tooltip content={tip}>
      <AppLink
        href="/health"
        aria-label={`Connector health: ${tip}`}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-caption font-bold text-muted tabular-nums no-underline transition-colors hover:bg-surface-muted hover:text-fg hover:no-underline focus-visible:outline-none focus-visible:shadow-focus',
          broken.length && 'bg-danger-50 text-danger-700 hover:bg-danger-100 hover:text-danger-700',
        )}
      >
        <span className="relative">
          <Icon name="connected_apps" size="md" />
          <span aria-hidden className={cn('absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface', TONE_DOT[tone])} />
        </span>
        {s ? `${s.ok}/${s.total}` : '–'}
      </AppLink>
    </Tooltip>
  );
}

/** @deprecated the sidebar footer carries spend ("$0.64 of $5 today"). */
export function BudgetChip({ spend }: { spend?: HealthPayload['spend'] }) {
  if (!spend || spend.state === 'ok') return null;
  const capped = spend.state === 'capped';
  return (
    <Tooltip content={capped ? 'Hard cap reached: scans run on rules only (no AI) until tomorrow.' : `${Math.round(spend.today.pct)}% of today's soft budget used.`}>
      <AppLink
        href="/health"
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-caption font-bold tabular-nums no-underline hover:no-underline',
          capped ? 'bg-danger-50 text-danger-700' : 'bg-warning-50 text-warning-700',
        )}
      >
        <Icon name="money" size="xs" />
        {fmtUsd(spend.today.usd)} / {fmtUsd(spend.today.softBudgetUsd)}
      </AppLink>
    </Tooltip>
  );
}
