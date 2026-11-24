'use client';
/**
 * Center pane: Run of day. The ordered hands-on list with start-by times and estimates; one selected row
 * carries the filled action, the rest show their verb as quiet text (snooze / done on hover or selection).
 * Below it: Fit-ins (today's few-minute items), Pull forward if you have time (each with a quiet "Pull in"),
 * Promises, and a closing line. Live arrivals append with an "n new ↓" marker; nothing reorders under the
 * cursor (useTodayModel), and rank changes wait in the "Re-rank ready" pill.
 */
import { forwardRef, type ReactNode } from 'react';
import { Button, EmptyState, Kbd, KbdHint, StaleMark } from '@/ui';
import { useToday } from './ctx';
import { Badge } from './DayHeader';
import { ActionErrorLine } from './parts';
import { InlineReauth, ItemPopovers } from './popovers';
import type { DayRow, DaySections } from './rows';

/** Lane 07 R7: the ranking's why in two parts: why now (late, deadline, start-by), then why it matters. */
function WhyParts({ parts }: { parts: NonNullable<DayRow['whyParts']> }) {
  const cap = (x: string) => x[0]!.toUpperCase() + x.slice(1);
  return (
    <>
      {parts.now ? <span data-why="now">{cap(parts.now)}</span> : null}
      {parts.now && parts.matters ? '. ' : null}
      {parts.matters ? <span data-why="matters">{cap(parts.matters)}</span> : null}
    </>
  );
}

export type RowAction = 'snooze' | 'done' | 'nudge' | 'renegotiate' | 'let_go';

export interface RowHandlers {
  selectedKey: string | null;
  /** The row whose action is the filled button (selected, unless the panel already shows it). */
  filledKey: string | null;
  hlItemId: string | null;
  /** Rows that arrived while the page was open: marked gently (docs/UX.md "Live updates"). */
  newIds?: ReadonlySet<string>;
  expandedKey: string | null;
  reauthFor: string | null;
  onCloseReauth: () => void;
  onSelect: (key: string) => void;
  onOpen: (row: DayRow) => void;
  onPrimary: (row: DayRow) => void;
  onAction: (row: DayRow, action: RowAction) => void;
  onHover: (itemId: string | null) => void;
}

const EXTRA_LABEL: Record<RowAction, string> = { snooze: 'Snooze', done: 'Done', nudge: 'Nudge', renegotiate: 'Renegotiate', let_go: 'Let go' };
const EXTRA_KEY: Partial<Record<RowAction, string>> = { snooze: 's', done: 'd' };

function extraLabel(row: DayRow, a: RowAction): string {
  if (a === 'nudge') {
    const who = row.item?.waiting?.who?.name?.split(' ')[0];
    return who ? `Nudge ${who}` : 'Nudge';
  }
  return EXTRA_LABEL[a];
}

function Extras({ row, h, kbd }: { row: DayRow; h: RowHandlers; kbd?: boolean }) {
  if (!row.extras.length) return null;
  return (
    <span className="td-hover">
      {row.extras.map((a) => (
        <Button
          key={a}
          size="sm"
          variant="ghost"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            h.onSelect(row.key);
            h.onAction(row, a);
          }}
        >
          {extraLabel(row, a)}
          {kbd && EXTRA_KEY[a] ? <Kbd className="ml-1">{EXTRA_KEY[a]}</Kbd> : null}
        </Button>
      ))}
    </span>
  );
}

function RowView({ row, h, compact }: { row: DayRow; h: RowHandlers; compact: boolean }) {
  const ctx = useToday();
  const selected = h.selectedKey === row.key;
  const filled = h.filledKey === row.key;
  const itemId = row.item?.id ?? null;
  const errKey = itemId && ctx.actions.errors[itemId] ? itemId : null;
  const err = errKey ? ctx.actions.errors[errKey] : null;
  const primary = (
    <Button
      size="sm"
      variant="ghost"
      className="td-quiet-verb"
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        h.onSelect(row.key);
        h.onPrimary(row);
      }}
    >
      {row.verb}
    </Button>
  );
  const fill = (
    <Button
      size={compact ? 'sm' : 'md'}
      variant="primary"
      className={compact ? 'td-fill' : undefined}
      kbd="mod+enter"
      tabIndex={-1}
      data-primary
      onClick={(e) => {
        e.stopPropagation();
        h.onPrimary(row);
      }}
    >
      {row.verb}
    </Button>
  );
  const reauthId = row.primary.kind === 'reauth' ? row.primary.connectorId : null;
  return (
    <li
      className="td-row"
      data-row-key={row.key}
      data-item-id={itemId ?? undefined}
      data-section={row.section}
      data-selected={selected || undefined}
      data-filled={filled || undefined}
      data-tone={row.tone ?? undefined}
      data-hl={itemId && itemId === h.hlItemId ? '' : undefined}
      data-live={itemId && h.newIds?.has(itemId) ? 'new' : undefined}
      data-expanded={h.expandedKey === row.key || undefined}
      tabIndex={selected ? 0 : -1}
      aria-current={selected || undefined}
      aria-label={`${row.title}${row.when.main !== 'Any' ? `, ${row.when.main}` : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button,a,input,textarea,select,[role="menu"],[role="dialog"]')) return;
        h.onSelect(row.key);
        h.onOpen(row);
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget && !selected) h.onSelect(row.key);
      }}
      onMouseEnter={() => h.onHover(itemId)}
      onMouseLeave={() => h.onHover(null)}
    >
      <div className="td-when">
        <b>{row.when.main}</b>
        {row.when.sub ? <span>{row.when.sub}</span> : null}
      </div>
      <span className="td-edge" aria-hidden />
      {compact ? (
        <div className="td-title" title={row.title}>
          <span className="td-t">{row.title}</span>
          {row.badge ? <Badge tone={row.badge.tone}>{row.badge.label}</Badge> : null}
          {row.context ? <span className="td-ctx">{row.context}</span> : null}
        </div>
      ) : (
        <div className="td-title" title={row.title}>
          {row.title}
        </div>
      )}
      <div className={`td-why${row.item?.reevaluating ? ' td-reeval' : ''}`} title={row.whyDetail ?? row.why}>
        {h.expandedKey === row.key && row.whyDetail ? row.whyDetail : row.whyParts ? <WhyParts parts={row.whyParts} /> : row.why}
      </div>
      {!compact ? (
        <div className="td-meta">
          {row.badge ? <Badge tone={row.badge.tone}>{row.badge.label}</Badge> : null}
          {row.item?.stale ? <StaleMark reason={row.item.stale.reason} /> : null}
          <span>{row.meta}</span>
        </div>
      ) : null}
      <div className="td-act">
        <Extras row={row} h={h} kbd={compact && filled} />
        {primary}
        {compact ? fill : null}
      </div>
      {!compact ? (
        <div className="td-sel">
          {fill}
          <Extras row={row} h={h} kbd />
        </div>
      ) : null}
      {err && errKey ? (
        <div className="td-err pt-1">
          <ActionErrorLine error={err} onDismiss={() => ctx.actions.clearError(errKey)} />
        </div>
      ) : null}
      {reauthId && h.reauthFor === reauthId ? (
        <div className="td-inline">
          <InlineReauth connectorId={reauthId} onClose={h.onCloseReauth} />
        </div>
      ) : null}
      {row.item ? <ItemPopovers item={row.item} surface={row.section} anchorClassName="right-4 top-10" /> : null}
    </li>
  );
}

function RowList({ rows, h, compact, label }: { rows: DayRow[]; h: RowHandlers; compact?: boolean; label: string }) {
  return (
    <ul className={`td-list td-run${compact ? ' td-compact' : ''}`} aria-label={label} data-today-list={label}>
      {rows.map((r) => (
        <RowView key={r.key} row={r} h={h} compact={!!compact} />
      ))}
    </ul>
  );
}

function Sub({ title, note, children }: { title: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="td-sub">
      <h3>{title}</h3>
      {note ? <span>{note}</span> : null}
      {children}
    </div>
  );
}

export interface RunOfDayProps {
  sections: DaySections;
  handlers: RowHandlers;
  headCount: string;
  openLabel: string;
  rerankCount: number;
  reranking: boolean;
  onRerank: () => void;
  newCount: number;
  onShowNew: () => void;
  refreshError: boolean;
  onRetry: () => void;
  promisesOpen: boolean;
  onPromisesOpen: (v: boolean) => void;
  dayEnd: string;
  triageCount: number;
  state: 'ready' | 'empty' | 'loading' | 'error';
  error: Error | null;
}

export const RunOfDay = forwardRef<HTMLDivElement, RunOfDayProps>(function RunOfDay(p, scrollRef) {
  const ctx = useToday();
  const { run, fit, pull, promises } = p.sections;
  const rerankErr = ctx.actions.errors['today:rerank'];
  return (
    <section className="td-pane" aria-label="Run of day" data-today-run>
      <div className="td-pane-head">
        <h2>Run of day</h2>
        <span className="td-count">{p.headCount}</span>
        <div className="td-actions">
          {p.rerankCount > 0 ? (
            <button
              type="button"
              onClick={p.onRerank}
              data-rerank-pill
              disabled={p.reranking}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-selected px-2.5 text-caption font-bold text-link hover:border-accent focus-visible:shadow-focus focus-visible:outline-none"
            >
              Re-rank ready · <span className="tabular-nums">{p.rerankCount}</span> <Kbd>r</Kbd>
            </button>
          ) : null}
          <span className="hidden items-center gap-1 text-caption text-muted @min-[1300px]/main:inline-flex">
            <KbdHint combo="j|k" /> move
          </span>
        </div>
      </div>
      {rerankErr ? (
        <div className="px-5 pb-1">
          <ActionErrorLine error={rerankErr} onDismiss={() => ctx.actions.clearError('today:rerank')} />
        </div>
      ) : null}
      {p.refreshError ? (
        <p role="status" className="mx-5 mb-1 flex items-center gap-2 rounded-md bg-warning-50 px-2.5 py-1 text-caption text-warning-700">
          Couldn’t refresh; showing the last data.
          <button type="button" className="font-bold text-link hover:underline" onClick={p.onRetry}>
            Retry
          </button>
        </p>
      ) : null}
      <div className="td-scroll cc-scroll" ref={scrollRef} data-today-scroll>
        {p.state === 'loading' ? (
          <div className="space-y-3 pt-2" aria-busy>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-md bg-surface-sunken" />
            ))}
          </div>
        ) : p.state === 'error' ? (
          <EmptyState icon="error" title="Run of day didn’t load" body={p.error?.message ?? 'Try again.'} action={<Button onClick={p.onRetry}>Retry</Button>} />
        ) : (
          <>
            {run.length && p.state !== 'empty' ? (
              <RowList rows={run} h={p.handlers} label="Run of day" />
            ) : (
              <p className="py-3 text-body text-muted">Nothing hands-on is due today. Work due today joins this list as the scanners find it (you’ll see “N new”); meanwhile, pull work forward below.</p>
            )}
            {fit.length ? (
              <>
                <Sub title="Fit-ins" note="today, a few minutes each" />
                <RowList rows={fit} h={p.handlers} compact label="Fit-ins" />
              </>
            ) : null}
            {pull.length ? (
              <>
                <Sub title="Pull forward if you have time" note={`not due today · ${p.openLabel}`} />
                <RowList rows={pull} h={p.handlers} compact label="Pull forward" />
              </>
            ) : null}
            {promises.length ? (
              <>
                <Sub title="Promises" note={`said by you, going stale · ${promises.length}`}>
                  <button type="button" className="ml-auto text-caption font-bold text-link hover:underline" aria-expanded={p.promisesOpen} onClick={() => p.onPromisesOpen(!p.promisesOpen)}>
                    {p.promisesOpen ? 'Hide' : 'Show'}
                  </button>
                </Sub>
                {p.promisesOpen ? <RowList rows={promises} h={p.handlers} compact label="Promises" /> : null}
              </>
            ) : null}
            <p className="td-dayend">
              That’s the day. It ends at {p.dayEnd}.
              {p.triageCount > 0 ? (
                <>
                  {' '}
                  <button type="button" className="text-link hover:underline" onClick={() => ctx.navigate('/triage')}>
                    Triage {p.triageCount} ›
                  </button>
                </>
              ) : null}
            </p>
            {p.newCount > 0 ? (
              <div className="pointer-events-none sticky bottom-0 flex justify-center pt-2">
                <button
                  type="button"
                  data-new-marker
                  onClick={p.onShowNew}
                  className="pointer-events-auto inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface-raised px-3 text-caption font-bold text-link shadow-raise hover:border-accent focus-visible:shadow-focus focus-visible:outline-none"
                >
                  {p.newCount} new ↓
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
});
