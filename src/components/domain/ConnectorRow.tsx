'use client';
/**
 * ConnectorRow (Health, UI-SPEC §12, R-UI-12): state · last success · cursor · backlog · last error ·
 * Re-auth affordance by `reauth.kind` (brief 09):
 *   in_app → a Reconnect button · terminal_command → the exact command + "Open Terminal" ·
 *   refresh_script → the script + "Run refresh" · instructions → text only.
 * Commands never contain secrets (contract). The row shows them; the parent runs or copies them.
 * DESIGN-V2: sources are neutral glyphs; only the state carries color (one signal per row). The re-auth
 * button is filled only for a connector that is actually broken (auth needed / error).
 */
import type { Connector, ReauthAffordance } from '@/contract';
import { Button, cn, Icon, SOURCE_META } from '@/ui';
import { StatusBadge, TONE_TO_BADGE, useClock } from './lib';
import { ago, clock, sameDay, dayLabel } from './lib/time';
import { CONNECTOR_META } from './vocab';

export const CONNECTOR_COLS = 'grid grid-cols-[minmax(10rem,1.1fr)_10rem_minmax(9rem,0.9fr)_minmax(10rem,1fr)_5rem_minmax(13rem,1.6fr)_minmax(13rem,1.4fr)] items-center gap-4';

export interface ConnectorRowProps {
  connector: Connector;
  now?: string;
  className?: string;
  onReauth?: (connector: Connector, reauth: ReauthAffordance) => void;
  onCopyCommand?: (command: string, connector: Connector) => void;
  onScan?: (connector: Connector) => void;
  onOpen?: (connector: Connector) => void;
}

const NEEDS_REAUTH = new Set(['auth_needed', 'error']);
const NEEDS_ATTENTION = new Set(['auth_needed', 'error', 'degraded', 'offline']);

export function ConnectorRowHeader({ className }: { className?: string }) {
  return (
    <div className={cn(CONNECTOR_COLS, 'h-10 border-b border-line bg-surface-muted px-4 text-caption font-bold text-muted', className)} role="row">
      <span>Connector</span>
      <span>State</span>
      <span>Last success</span>
      <span>Cursor</span>
      <span className="text-right">Backlog</span>
      <span>Last error</span>
      <span>Re-auth</span>
    </div>
  );
}

export function ConnectorRow({ connector: c, className, onReauth, onCopyCommand, onScan, onOpen, ...rest }: ConnectorRowProps) {
  const { now, tz } = useClock({ now: rest.now });
  const meta = CONNECTOR_META[c.state];
  const src = SOURCE_META[c.source];
  const broken = NEEDS_REAUTH.has(c.state);
  const last = c.lastSuccessAt ? `${sameDay(c.lastSuccessAt, now, tz) ? clock(c.lastSuccessAt, tz) : `${dayLabel(c.lastSuccessAt, tz)} ${clock(c.lastSuccessAt, tz)}`}` : '—';
  return (
    <div role="row" className={cn(CONNECTOR_COLS, 'relative min-h-14 border-b border-line px-4 py-2.5 text-body last:border-b-0 hover:bg-surface-muted', className)}>
      {broken ? <span aria-hidden className="absolute inset-y-2 left-1 w-[3px] rounded-full bg-danger-500" /> : null}
      <button type="button" onClick={() => onOpen?.(c)} className="flex min-w-0 items-center gap-2.5 text-left hover:underline hover:underline-offset-2">
        <Icon set={src.icon.set} name={src.icon.name} size="md" className="text-faint" />
        <span className="truncate font-bold text-fg-heading">{c.label}</span>
      </button>
      <span className="flex items-center gap-1.5">
        {meta.tone === 'neutral' || meta.tone === 'ok' ? (
          <span className="inline-flex items-center gap-1.5 text-caption text-fg">
            <span aria-hidden className={cn('size-2 rounded-full', meta.tone === 'ok' ? 'bg-success-500' : 'bg-faint')} />
            {meta.label}
          </span>
        ) : (
          <StatusBadge tone={TONE_TO_BADGE[meta.tone]} icon={meta.tone === 'risk' ? 'close' : meta.tone === 'warn' ? 'warning' : 'sync'}>
            {meta.label}
          </StatusBadge>
        )}
        {c.state === 'catching_up' && c.catchUpPct !== null ? <span className="text-caption text-muted tabular-nums">{c.catchUpPct}%</span> : null}
      </span>
      <span className="text-caption tabular-nums text-fg" title={c.lastSuccessAt ?? undefined}>
        {last}
        {c.lastSuccessAt ? <span className="block text-muted">{ago(c.lastSuccessAt, now)}</span> : null}
      </span>
      <span className="truncate text-caption text-fg" title={c.cursor.label}>
        {c.cursor.label}
        <span className="block text-muted">{c.itemsToday} items today</span>
      </span>
      <span className={cn('text-right text-caption tabular-nums', c.backlog ? 'font-bold text-fg' : 'text-faint')}>{c.backlog || '—'}</span>
      <span className="min-w-0 text-caption">
        {c.lastError ? (
          <>
            <span className={cn('font-bold', c.lastError.class === 'auth' ? 'text-danger-700' : 'text-warning-700')}>
              {c.lastError.class.replace('_', ' ')}
              {c.lastError.count > 1 ? ` ×${c.lastError.count}` : ''}
            </span>
            <span className="text-muted"> · {clock(c.lastError.at, tz)}</span>
            <span className="block truncate text-fg" title={c.lastError.message}>
              {c.lastError.message}
            </span>
            {c.impact ? <span className="block truncate text-muted">{c.impact}</span> : null}
          </>
        ) : (
          <span className="text-faint">—</span>
        )}
      </span>
      <span className="min-w-0">
        <ReauthCell connector={c} broken={NEEDS_ATTENTION.has(c.state)} onReauth={onReauth} onCopyCommand={onCopyCommand} onScan={onScan} />
      </span>
    </div>
  );
}

function ReauthCell({ connector: c, broken, onReauth, onCopyCommand, onScan }: { connector: Connector; broken: boolean; onReauth?: ConnectorRowProps['onReauth']; onCopyCommand?: ConnectorRowProps['onCopyCommand']; onScan?: ConnectorRowProps['onScan'] }) {
  const r = c.reauth;
  if (!broken) {
    return (
      <Button size="sm" variant="ghost" icon="sync" onClick={() => onScan?.(c)} className="-ml-2">
        Scan now
      </Button>
    );
  }
  if (!r) return <span className="text-caption text-muted">No re-auth needed: retrying</span>;
  const command = r.command ? (
    <span className="mt-1 flex min-w-0 items-center gap-1">
      <code className="min-w-0 truncate rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-micro text-fg" title={r.command}>
        {r.command}
      </code>
      <button type="button" title="Copy command" aria-label="Copy command" onClick={() => onCopyCommand?.(r.command!, c)} className="inline-grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-fg">
        <Icon name="copy" size="xs" />
      </button>
    </span>
  ) : null;
  switch (r.kind) {
    case 'in_app':
      return (
        <Button size="sm" variant={c.state === 'auth_needed' || c.state === 'error' ? 'primary' : 'secondary'} onClick={() => onReauth?.(c, r)}>
          {r.label}
        </Button>
      );
    case 'terminal_command':
      return (
        <div className="min-w-0">
          <Button size="sm" variant={c.state === 'auth_needed' || c.state === 'error' ? 'primary' : 'secondary'} onClick={() => onReauth?.(c, r)}>
            Open Terminal
          </Button>
          {command}
          {r.instructions ? <span className="mt-0.5 block truncate text-caption text-muted">{r.instructions}</span> : null}
        </div>
      );
    case 'refresh_script':
      return (
        <div className="min-w-0">
          <Button size="sm" variant={c.state === 'auth_needed' || c.state === 'error' ? 'primary' : 'secondary'} onClick={() => onReauth?.(c, r)}>
            {r.label || 'Run refresh'}
          </Button>
          {command}
          {r.instructions ? <span className="mt-0.5 block truncate text-caption text-muted" title={r.instructions}>{r.instructions}</span> : null}
        </div>
      );
    case 'instructions':
      return <p className="text-caption text-fg">{r.instructions ?? r.label}</p>;
  }
}
