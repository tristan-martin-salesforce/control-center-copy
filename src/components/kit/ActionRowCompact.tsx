'use client';
/**
 * ActionRow's dense variants (Activity-at-scale C3, AX-3, AX-9; docs/UX.md "Component kit"): one line, about 44 px.
 *
 *   compact:  [☐] ▌ when  Title (truncates) ··········  1.5 h  where it goes  Verb [▾]  ›
 *   The title takes two shares of the free space and the where cell one (`whereFit`: its natural width, capped, when
 *   the group names the target); in a lane under 44rem (`@container/lane`) the lead shows `leadShort` ("Thu 08:00").
 *   group:    [☐] Group label  9 ····································· Verb ("Accept 9")
 *
 * - "Where it goes" is a button: a click (or Enter on it) puts the row in edit, and the row's `editor` (its pickers)
 *   replaces the cell. Pickers render only on the row being edited, never on every row; Esc in the editor ends it.
 * - `failure` is the red ▲ mark: the short reason takes the where cell (the full one, `failureDetail`, is its title)
 *   and the edge turns danger.
 * - The chevron `›`, Enter on the row and a click on the title open the details panel (`onOpen('details')`): the one
 *   dive-deeper affordance. No inline expanders on a compact row.
 * - Space and `x` tick the row (or the group); j / k move between the rows of a `RowGrid`.
 * The root (role `row`, the keys, the click, the states) stays ActionRow's; this file draws the cells.
 */
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { EDGE_BG, type Indicator } from '@/components/domain/lib/v2';
import { Button, cn, Icon, Menu, type MenuEntry } from '@/ui';
import type { ActionRowOverflow, ActionRowVerb } from './ActionRow';

export type RowDensity = 'regular' | 'compact' | 'group';

/** The compact and group slots (ActionRow props; a regular row ignores them). */
export interface CompactSlots {
  /** `compact`: the one-line row. `group`: a group's header line (its tick ticks the group). Default `regular`. */
  density?: RowDensity;
  /** The amount column (hours: "1.5 h"). */
  amount?: ReactNode;
  /** "Where it goes" (account · opp, a suggestion, "Pick an opp"): a button that starts the edit. */
  where?: ReactNode;
  /** The where button's accessible name ("87 percent likely Globex · Data 360 Expansion"); defaults to its text. */
  whereLabel?: string;
  /** The pickers, drawn in place of `where` only while `editing`. */
  editor?: ReactNode;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** The red ▲ mark and its short reason ("Not found in Org62"), in the where cell. */
  failure?: string | null;
  /** The failure's full sentence ("Not found in Org62 after the batch ran"): the where cell's title and name. */
  failureDetail?: string | null;
  /** The lead in a narrow lane (`@container/lane` under 44rem, e.g. two columns at 1440): "Thu 08:00". */
  leadShort?: ReactNode;
  /** The where cell holds only a little (its group already names the target): natural width, capped, not flex-1. */
  whereFit?: boolean;
  /** A group header's count, beside its label. */
  count?: number;
}

export interface RowCheck {
  checked: boolean;
  onChange: () => void;
  label: string;
  /** Some of the group is ticked (the box shows a dash). */
  mixed?: boolean;
}

export interface CompactCellsProps extends CompactSlots {
  title: string;
  titleNode?: ReactNode;
  done?: boolean;
  lead?: ReactNode;
  check?: RowCheck;
  verb?: ActionRowVerb | null;
  overflow: ActionRowOverflow[];
  edge: Indicator;
  dashed: boolean;
  off: boolean;
  filled: boolean;
  onOpen?: (mode: 'details' | 'page') => void;
  rowRef: { current: HTMLDivElement | null };
}

const keepFocus = (e: MouseEvent) => e.preventDefault();

/** The root classes of a dense row (ActionRow puts them on its `row`). */
export const COMPACT_ROOT = 'group/row relative flex min-h-11 min-w-0 cursor-default items-center gap-x-2 border-b border-line @max-[44rem]/lane:gap-x-1 px-3 py-1.5 last:border-b-0';

function Tick({ check }: { check: RowCheck }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!check.mixed;
  }, [check.mixed]);
  return <input ref={ref} type="checkbox" checked={check.checked} onChange={check.onChange} aria-label={check.label} data-testid="row-check" className="size-4 shrink-0 accent-[var(--color-accent)]" />;
}

export function CompactCells(p: CompactCellsProps) {
  const { density, title, titleNode, done, lead, leadShort, check, verb, overflow, edge, dashed, off, filled, onOpen, rowRef, amount, where, whereLabel, whereFit, editor, editing, onEditingChange, failure, failureDetail, count } = p;
  const failureText = failureDetail || failure;
  const group = density === 'group';
  const verbButton = verb ? (
    <Button
      variant={filled || group ? 'secondary' : 'quiet'}
      size="xs"
      icon={verb.icon}
      loading={verb.loading}
      disabled={verb.disabled || off}
      title={verb.title}
      data-row-verb={filled ? 'filled' : 'quiet'}
      className={group ? undefined : '@max-[44rem]/lane:px-1.5'}
      data-testid={verb.testId}
      onMouseDown={keepFocus}
      onClick={(e) => {
        e.stopPropagation();
        verb.onClick();
      }}
    >
      {verb.label}
    </Button>
  ) : null;
  const menu: MenuEntry[] = overflow.map((a) => ({ id: a.id, label: a.label, icon: a.icon, kbd: a.k, tone: a.tone, disabled: a.disabled || off, onSelect: a.onClick }));
  const verbMenu = menu.length ? (
    <Menu
      label="More actions"
      items={menu}
      trigger={
        <button type="button" aria-label="More actions" title="More actions" data-testid="row-verb-menu" onMouseDown={keepFocus} className="inline-grid size-7 place-items-center rounded-sm text-muted hover:bg-surface hover:text-fg focus-visible:shadow-focus focus-visible:outline-none @max-[44rem]/lane:w-5">
          <Icon name="chevrondown" size="xs" />
        </button>
      }
    />
  ) : null;
  const titleSpan = (
    <span className={cn('min-w-0 flex-[2] truncate text-body font-bold', done ? 'text-muted line-through decoration-line-strong' : 'text-fg-heading')} title={title} data-slot="title">
      {titleNode ?? title}
      {group && typeof count === 'number' ? (
        <span className="ml-2 font-normal text-muted tabular-nums" data-slot="count">
          {count}
        </span>
      ) : null}
    </span>
  );
  if (group) {
    return (
      <div role="rowheader" data-slot="cell" className="contents">
        {check ? <Tick check={check} /> : null}
        {titleSpan}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {verbButton}
          {verbMenu}
        </span>
      </div>
    );
  }
  const endEdit = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onEditingChange?.(false);
    rowRef.current?.focus();
  };
  return (
    <div role="gridcell" data-slot="cell" className="contents">
      {check ? <Tick check={check} /> : null}
      <span aria-hidden data-slot="edge" data-edge={edge} className={cn('h-6 w-[3px] shrink-0', dashed ? 'border-l-[3px] border-dashed border-line-strong' : cn('rounded-full', EDGE_BG[edge]))} />
      {lead !== undefined && lead !== null ? (
        <span className={cn('w-[6.25rem] shrink-0 truncate text-caption text-muted tabular-nums', leadShort != null && '@max-[44rem]/lane:hidden')} data-slot="lead">
          {lead}
        </span>
      ) : null}
      {lead != null && leadShort != null ? (
        <span aria-hidden className={cn('hidden shrink-0 truncate text-caption text-muted tabular-nums @max-[44rem]/lane:inline', failure ? 'w-auto min-w-[2.75rem]' : 'w-[4.5rem]')} data-slot="lead-short">
          {leadShort}
        </span>
      ) : null}
      {titleSpan}
      {amount !== undefined && amount !== null ? (
        <span className="w-10 shrink-0 whitespace-nowrap text-right text-body text-fg tabular-nums" data-slot="amount">
          {amount}
        </span>
      ) : null}
      {editing && editor ? (
        <div data-slot="editor" data-no-open onKeyDown={endEdit} onClick={(e) => e.stopPropagation()} className="flex max-w-[30rem] min-w-[16rem] flex-[2] items-center gap-1.5">
          {editor}
        </div>
      ) : (
        <button
          type="button"
          data-slot="where"
          data-failure={failure ? '' : undefined}
          data-fit={whereFit && !failure ? '' : undefined}
          aria-label={failure ? `Failed: ${failureText}` : whereLabel}
          title={failure ? (failureText ?? undefined) : whereLabel}
          disabled={off || !onEditingChange}
          onMouseDown={keepFocus}
          onClick={(e) => {
            e.stopPropagation();
            onEditingChange?.(true);
          }}
          className={cn(
            'flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 text-left text-body hover:bg-surface focus-visible:shadow-focus focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent',
            failure ? 'max-w-[12rem] flex-none' : whereFit ? 'max-w-[10rem] flex-initial' : 'max-w-[20rem] flex-1',
            failure ? 'font-bold text-danger-700' : 'text-fg',
          )}
        >
          {failure ? (
            <>
              <span aria-hidden>▲</span>
              <span className="min-w-0 truncate">{failure}</span>
            </>
          ) : (
            where
          )}
        </button>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {verbButton}
        {verbMenu}
        {onOpen ? (
          <button
            type="button"
            aria-label={`Details: ${title}`}
            title="Details (Enter)"
            data-testid="row-chevron"
            onMouseDown={keepFocus}
            onClick={(e) => {
              e.stopPropagation();
              onOpen('details');
            }}
            className="inline-grid size-7 place-items-center rounded-sm text-muted hover:bg-surface hover:text-fg focus-visible:shadow-focus focus-visible:outline-none @max-[44rem]/lane:w-5"
          >
            <span aria-hidden className="text-body-lg leading-none">
              ›
            </span>
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** j / k (and ↓ / ↑) between the rows of a list: focus moves to the next row. */
export function moveRowFocus(e: KeyboardEvent<HTMLElement>): void {
  const dir = ({ j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
  if (!dir || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (!target.matches('[data-row]')) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-row]:not([aria-hidden="true"])'));
  const next = rows[rows.indexOf(target) + dir];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/** The container of compact rows (and their group headers): a `grid` with j / k. */
export function RowGrid({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="grid" aria-label={label} onKeyDown={moveRowFocus} className={cn('flex min-w-0 flex-col', className)}>
      {children}
    </div>
  );
}
