'use client';
/**
 * Scan ledger: every scan run with its connector, real status, window and counts; trigger, model, scope and
 * cost join as the pane gets wider (`pane` container queries). A row expands in place (click or Space) to show
 * what was scanned and any coverage gap; Enter opens that connector in the docked panel. No side sheet.
 * The ledger is paged (GET /scans `cursor` → `nextCursor`, caps audit F-2): the newest 100 stay live, and "Show 100
 * more" appends older runs by the cursor, so every run back to the first is reachable.
 */
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import type { Connector, ScanRun, ScansPayload } from '@/contract';
import { api } from '@/client/api';
import { clock, dayLabel, dur, minutesBetween, sameDay } from '@/components/domain/lib/time';
import { Facts } from '@/components/panels/bits';
import { SCAN_STATUS } from '@/components/panels/derive';
import { useApi } from '@/client/hooks';
import { Button, cn, EmptyState, Icon, PanelError, Skeleton, usePanelState, useTimeZone } from '@/ui';
import { filterScans, usd } from './derive';

const TRIGGER: Record<ScanRun['kind'], string> = { poll: 'Scheduled poll', head: 'Head check', backfill: 'Backfill', reconcile: 'Reconcile', manual: 'Manual rescan' };
const COLS =
  'grid items-center gap-3 grid-cols-[minmax(6rem,1fr)_8rem_minmax(12rem,1.3fr)_5.5rem] @min-[50rem]/pane:grid-cols-[minmax(7rem,1fr)_8rem_minmax(12rem,1.3fr)_7.5rem_5.5rem_4.5rem] @min-[68rem]/pane:grid-cols-[minmax(7rem,1fr)_8rem_minmax(12rem,1.3fr)_7.5rem_6rem_minmax(8rem,1fr)_5.5rem_4.5rem]';
const MID = 'hidden @min-[50rem]/pane:block';
const WIDE = 'hidden @min-[68rem]/pane:block';
const TONE_TEXT = { ok: 'text-fg', brand: 'text-link', neutral: 'text-muted', warn: 'font-bold text-warning-700', risk: 'font-bold text-danger-700' } as const;

/** "Thu 5 Nov 07:00 → 08:21" within a day, else "22 Oct 09:21 → 5 Nov 08:21". */
function windowLabel(r: Pick<ScanRun, 'windowStart' | 'windowEnd'>, tz?: string): string {
  if (sameDay(r.windowStart, r.windowEnd, tz)) return `${dayLabel(r.windowStart, tz)} ${clock(r.windowStart, tz)} → ${clock(r.windowEnd, tz)}`;
  const short = (iso: string) => dayLabel(iso, tz).replace(/^\S+\s/, '');
  return `${short(r.windowStart)} ${clock(r.windowStart, tz)} → ${short(r.windowEnd)} ${clock(r.windowEnd, tz)}`;
}

/** Runs per page (the route's default `limit`). */
export const LEDGER_PAGE = 100;

/**
 * The live first page plus the older pages loaded by Show more. A loaded window keeps every row it showed (a new scan
 * pushing a row off the live page does not drop it); a row on the live page is its fresh copy.
 */
export function useScanPages(first: ScansPayload | undefined) {
  const [older, setOlder] = useState<{ rows: ScanRun[]; cursor: string | null } | null>(null);
  const [state, setState] = useState({ busy: false, failed: false });
  const runs = useMemo(() => {
    const live = first?.runs ?? [];
    if (!older) return live;
    const ids = new Set(live.map((r) => r.id));
    return [...live, ...older.rows.filter((r) => !ids.has(r.id))];
  }, [first, older]);
  const cursor = older ? older.cursor : (first?.nextCursor ?? null);
  const showMore = useCallback(async () => {
    if (!cursor || state.busy) return;
    setState({ busy: true, failed: false });
    try {
      const page = await api('getScans', { query: { cursor, limit: LEDGER_PAGE } });
      setOlder((o) => ({ rows: [...(o?.rows ?? first?.runs ?? []), ...page.runs], cursor: page.nextCursor ?? null }));
      setState({ busy: false, failed: false });
    } catch {
      setState({ busy: false, failed: true });
    }
  }, [cursor, state.busy, first]);
  return { runs, more: !!cursor, total: first?.total ?? runs.length, showMore, ...state };
}

export function LedgerTab({ connectors, filterId, onFilter, onOpenConnector }: { connectors: Connector[]; filterId: string; onFilter: (id: string) => void; onOpenConnector: (id: string) => void }) {
  const tz = useTimeZone();
  const q = useApi('getScans', { query: {} });
  const pages = useScanPages(q.data);
  const [open, setOpen] = useState<string | null>(null);
  const runs = useMemo(() => filterScans(pages.runs, filterId), [pages.runs, filterId]);
  const label = (id: string) => connectors.find((c) => c.id === id)?.label ?? id;
  const state = usePanelState('health.ledger', { loading: q.isLoading, error: q.data ? null : q.error, empty: !runs.length });

  // older runs are one click away, also when the connector filter has none among the loaded ones
  const moreRow = pages.more ? (
    <div className="flex flex-wrap items-center gap-3 px-2 pt-3 pb-2" data-testid="ledger-more">
      <Button variant="secondary" size="sm" onClick={() => void pages.showMore()} aria-disabled={pages.busy || undefined} aria-busy={pages.busy || undefined} data-testid="ledger-more-button">
        {pages.busy ? 'Loading…' : `Show ${Math.min(LEDGER_PAGE, Math.max(1, pages.total - pages.runs.length))} more`}
      </Button>
      <span className="text-caption text-muted tabular-nums">{`${pages.runs.length} of ${pages.total} runs loaded`}</span>
      {pages.failed ? (
        <span className="text-caption text-danger-700" role="alert">
          Couldn’t load more. Try again.
        </span>
      ) : null}
    </div>
  ) : null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>, r: ScanRun) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === ' ') {
      e.preventDefault();
      setOpen((o) => (o === r.id ? null : r.id));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onOpenConnector(r.connectorId);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-health-ledger>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2 text-caption">
        <label className="text-muted" htmlFor="ledger-connector">
          Connector
        </label>
        <select id="ledger-connector" value={filterId} onChange={(e) => onFilter(e.target.value)} className="h-8 rounded-md border border-line-input bg-surface-input px-2 text-body text-fg">
          <option value="all">All connectors</option>
          {connectors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="ml-auto text-muted tabular-nums">{runs.length} runs</span>
      </div>
      {state === 'error' ? (
        <PanelError title="Couldn’t load the scan ledger" error={q.error ?? new Error('Forced error state (dev toolbar)')} onRetry={() => void q.refetch()} />
      ) : state === 'loading' ? (
        <Skeleton variant="row" count={6} />
      ) : state === 'empty' ? (
        <>
          <EmptyState title="No scans yet" body={filterId === 'all' ? 'Runs appear here as connectors scan, with their window, cost and counts.' : pages.more ? 'None for this connector among the runs loaded. Show more reads older runs.' : 'Nothing scanned for this connector yet. Rescan it, or show all connectors.'} />
          {moreRow}
        </>
      ) : (
        <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]">
          {/* a treegrid: a run's row opens its detail (aria-expanded is valid on a treegrid's row, not a table's) */}
          <div role="treegrid" aria-label="Scan ledger">
            <div role="row" className={cn(COLS, 'sticky top-0 z-[1] h-9 border-b border-line bg-surface px-2 text-caption font-bold text-muted')}>
              <span role="columnheader">Connector</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Window</span>
              <span role="columnheader" className={MID}>
                Trigger
              </span>
              <span role="columnheader" className={WIDE}>
                Model
              </span>
              <span role="columnheader" className={WIDE}>
                Scope
              </span>
              <span role="columnheader" className="text-right">
                New / seen
              </span>
              <span role="columnheader" className={cn(MID, 'text-right')}>
                Cost
              </span>
            </div>
            {runs.map((r) => {
              const s = SCAN_STATUS[r.status];
              // A partial window is routine (the rest arrives next poll): plain text, so warm colour stays for what needs you.
              const tone = r.status === 'partial' ? 'ok' : s.tone;
              const expanded = open === r.id;
              return (
                <div key={r.id} role="rowgroup" className="border-b border-line last:border-b-0">
                  <div
                    role="row"
                    tabIndex={0}
                    aria-expanded={expanded}
                    data-run={r.id}
                    data-status={r.status}
                    onClick={() => setOpen((o) => (o === r.id ? null : r.id))}
                    onKeyDown={(e) => onKey(e, r)}
                    className={cn(COLS, 'min-h-11 cursor-pointer rounded-md px-2 py-1.5 text-body outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)]', expanded ? 'bg-surface-muted' : 'hover:bg-surface-muted')}
                  >
                    <span role="cell" className="flex min-w-0 items-center gap-1.5">
                      <Icon name={expanded ? 'chevrondown' : 'chevronright'} size="xs" className="shrink-0 text-muted" />
                      <span className="truncate font-bold text-fg-heading">{label(r.connectorId)}</span>
                    </span>
                    <span role="cell" className={cn('truncate text-caption', TONE_TEXT[tone])}>
                      {s.label}
                    </span>
                    <span role="cell" className="truncate text-caption text-fg tabular-nums">
                      {windowLabel(r, tz)}
                    </span>
                    <span role="cell" className={cn(MID, 'truncate text-caption text-muted')}>
                      {TRIGGER[r.kind]}
                    </span>
                    <span role="cell" className={cn(WIDE, 'truncate text-caption text-muted')}>
                      {r.model ?? 'no LLM'}
                    </span>
                    <span role="cell" className={cn(WIDE, 'truncate font-mono text-caption text-muted')} title={r.scope}>
                      {r.scope}
                    </span>
                    <span role="cell" className="text-right text-caption tabular-nums">
                      {r.itemsNew}
                      <span className="text-muted"> / {r.itemsSeen}</span>
                    </span>
                    <span role="cell" className={cn(MID, 'text-right text-caption tabular-nums')}>
                      {usd(r.costUsd)}
                    </span>
                  </div>
                  {expanded ? <Coverage run={r} label={label(r.connectorId)} tz={tz} onOpen={() => onOpenConnector(r.connectorId)} /> : null}
                </div>
              );
            })}
          </div>
          {moreRow}
        </div>
      )}
    </div>
  );
}

function Coverage({ run: r, label, tz, onOpen }: { run: ScanRun; label: string; tz?: string; onOpen: () => void }) {
  return (
    <div className="@container/panel mx-2 mb-2 rounded-md border border-line bg-surface-muted px-4 py-3" data-coverage-for={r.id}>
      <Facts
        rows={[
          ['Scope scanned', <code key="s" className="font-mono text-caption">{r.scope}</code>],
          ['Window', `${dayLabel(r.windowStart, tz)} ${clock(r.windowStart, tz)} to ${dayLabel(r.windowEnd, tz)} ${clock(r.windowEnd, tz)} (${dur(minutesBetween(r.windowStart, r.windowEnd))})`],
          ['Trigger', TRIGGER[r.kind]],
          ['Started', `${dayLabel(r.startedAt, tz)} ${clock(r.startedAt, tz)}${r.endedAt ? ` · took ${dur(minutesBetween(r.startedAt, r.endedAt))}` : ' · still running'}`],
          ['Model', r.model ?? 'None (a plain read, no AI)'],
          ['Items', `${r.itemsSeen} seen · ${r.itemsNew} new · ${r.itemsChanged} changed`],
          ['Cost', usd(r.costUsd)],
        ]}
      />
      {r.error ? (
        <p className="mt-3 rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-body text-fg">
          <span className="font-bold text-warning-700">Coverage gap: </span>
          {r.error}
        </p>
      ) : (
        <p className="mt-3 text-caption text-muted">Everything in this window and scope was read.</p>
      )}
      <button type="button" onClick={onOpen} className="mt-2 text-caption font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
        Open {label} →
      </button>
    </div>
  );
}
