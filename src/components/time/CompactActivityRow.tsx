'use client';
/**
 * The one-line activity row every To log lane uses (Activity-at-scale C3, AX-3, AX-9; docs/UX.md "Activity"): the kit
 * ActionRow with `density="compact"`. Tick · when · title · hours · where it goes · the lane's one verb · ›.
 *
 * - Where it goes: the row's own account · opp, Internal, the app's suggestion ("87% likely Globex · Data 360
 *   Expansion", the AI colour, ✓ at or over the settle line), or "Pick an opp". A click on it (or Enter on it) edits
 *   the row: the pickers (opportunity, task type, hours) replace the cell on that row only; Esc ends the edit.
 * - The chevron, Enter on the row and a click on the title open the details panel (useRowNav's openRow).
 * - `failure` draws the red ▲ and the short reason in the where cell (lane 3); the full sentence is its title.
 * - In a narrow lane (two columns at 1440) the lead drops the date ("Thu 08:00"); a failure row's keeps the day only.
 * - `CompactGroupHeader`: a group's header line (tick the group, its label and count, its one verb "Accept 9").
 */
import { useState, type ReactNode } from 'react';
import type { ActivityEntry } from '@/contract';
import { ActionRow, type ActionRowOverflow, type ActionRowVerb, type RowCheck } from '@/components/kit';
import type { LiveRowState } from '@/components/lists/live-list';
import { cn } from '@/ui';
import { compactDay, compactHours, compactWhen, compactWhenShort, shortFailure, whereOf, type FailureReason, type WhereCell } from './compact-derive';

/** The where cell's text: a suggestion in the AI colour with how likely ("87% likely") and a ✓ at the settle line. */
export function WhereText({ w }: { w: WhereCell & { review?: boolean } }): ReactNode {
  // C11, the Review band: quiet, how likely and "review" (never the ✓ or the AI colour); "Pick an opp" when there is none
  if (w.review && w.kind === 'suggested')
    return (
      <span className="flex min-w-0 items-center gap-1 text-muted" data-where={w.kind} data-review="">
        <span className="shrink-0 tabular-nums" data-testid="where-percent">{`${w.percent} · review`}</span>
        {w.target ? <span className="min-w-0 truncate">{w.target}</span> : null}
      </span>
    );
  if (w.review && w.kind === 'pick')
    return (
      <span className="min-w-0 truncate text-muted" data-where={w.kind} data-review="">
        {w.target}
      </span>
    );
  if (w.kind === 'suggested')
    return (
      <span className="flex min-w-0 items-center gap-1" data-where={w.kind}>
        {/* the group names the target (empty here): "87% ✓" alone, so the title keeps the room (R2-2) */}
        <span className="shrink-0 font-bold text-ai-700 tabular-nums" data-testid="where-percent">{w.target ? `${w.percent} likely` : w.percent}</span>
        {w.target ? <span className="min-w-0 truncate">{w.target}</span> : null}
        {w.sure ? (
          <span aria-hidden className="shrink-0 font-bold text-ai-700" data-testid="where-sure" title="Sure enough to tick for you">
            ✓
          </span>
        ) : null}
      </span>
    );
  return (
    <span className={cn('min-w-0 truncate', w.kind === 'pick' ? 'font-bold text-warning-700' : w.kind === 'internal' ? 'text-muted' : 'text-fg')} data-where={w.kind}>
      {w.target}
    </span>
  );
}

export interface CompactActivityRowProps {
  e: ActivityEntry;
  /**
   * The pickers of the row being edited, called only while it is: pass `(e) => <CompactEditor e={e} pick={pick} />`
   * (./CompactEditor.tsx). A render prop, so the row itself does not pull the field code into every importer.
   */
  editor?: (e: ActivityEntry) => ReactNode;
  /** The settle line (review-derive `settleLineFor`): a suggestion at or over it shows ✓. */
  settle: number;
  tz?: string;
  /** The lane's one verb (Accept, Log it here, Internal). */
  verb?: ActionRowVerb | null;
  /** The verb's ▾ menu (Set opp, Leave out…). */
  menu?: ActionRowOverflow[];
  check?: RowCheck;
  /**
   * The red ▲ and its reason in the where cell (lane 3). A sentence ("Not found in Org62 after the batch ran") shows
   * its short form in the row (`shortFailure`) and the whole as the title; a `FailureReason` names both.
   */
  failure?: string | FailureReason | null;
  /** Controlled edit (one row at a time per lane); the row keeps its own when omitted. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** Opens the details panel (useRowNav's openRow). */
  onOpen: (id: string) => void;
  selected?: boolean;
  live?: LiveRowState;
  /** `data-*` attributes for the row's root (a lane's own hooks: `data-review-row`, `data-kind`). */
  attrs?: Record<`data-${string}`, string>;
  /** The account · opp its group's label already names: the where cell does not repeat it (C4: it would truncate). */
  groupTarget?: string | null;
  /** C11, lane 1's Review band: grayed, the where cell reads "47% · review" or "Pick an opp". */
  review?: boolean;
}

export function CompactActivityRow({ e, editor, settle, tz, verb, menu, check, failure, editing, onEditingChange, onOpen, selected, live, attrs, groupTarget, review = false }: CompactActivityRowProps) {
  const [own, setOwn] = useState(false);
  const isEditing = editing ?? own;
  const setEditing = onEditingChange ?? setOwn;
  const full = whereOf(e, settle);
  const fit = !!groupTarget && full.kind === 'suggested' && full.target === groupTarget;
  const w0 = fit ? { ...full, target: '' } : full;
  const w = review ? { ...w0, review: true } : w0;
  const fail = !failure ? null : typeof failure === 'string' ? { short: shortFailure(failure), long: failure } : failure;
  return (
    <ActionRow
      {...attrs}
      {...(review ? { 'data-review-band': '' } : {})}
      id={e.id}
      density="compact"
      title={e.description || 'Activity row'}
      lead={compactWhen(e, tz)}
      leadShort={fail ? compactDay(e) : compactWhenShort(e, tz)}
      amount={compactHours(e.durationH)}
      where={
        // D-103 (c): the where cell's tooltip says why it logs there (one plain sentence from the facts)
        e.groundwork ? (
          <span className="flex min-w-0" title={e.groundwork.text} data-groundwork={e.groundwork.code}>
            <WhereText w={w} />
          </span>
        ) : (
          <WhereText w={w} />
        )
      }
      whereLabel={w.label}
      whereFit={fit}
      editor={isEditing && editor ? editor(e) : null}
      editing={isEditing}
      onEditingChange={fail || !editor ? undefined : setEditing}
      failure={fail?.short ?? null}
      failureDetail={fail?.long ?? null}
      verb={verb}
      overflow={menu}
      check={check}
      selected={selected}
      live={live}
      dashed={w.kind === 'suggested' && !w.sure}
      onOpen={() => onOpen(e.id)}
    />
  );
}

export interface CompactGroupHeaderProps {
  id: string;
  /** "Suggested: Globex · Data 360 Expansion". */
  label: string;
  count: number;
  /** Ticks (or unticks) the whole group; `mixed` when some of it is ticked. */
  check?: RowCheck;
  /** The group's one verb ("Accept 9"). */
  verb?: ActionRowVerb | null;
  menu?: ActionRowOverflow[];
  /** A group that opens and closes (lane 1): the label is a button that toggles it. */
  open?: boolean;
  onToggle?: () => void;
}

/** A group's header line (kit ActionRow `density="group"`): tick the group · label and count · its one verb. */
export function CompactGroupHeader({ id, label, count, check, verb, menu, open, onToggle }: CompactGroupHeaderProps) {
  const titleNode = onToggle ? (
    <button type="button" aria-expanded={!!open} onClick={onToggle} data-testid="group-toggle" className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-left font-bold hover:underline focus-visible:shadow-focus focus-visible:outline-none">
      <span aria-hidden className="w-3 text-muted">
        {open ? '▾' : '▸'}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  ) : undefined;
  return <ActionRow id={id} data-group-id={id} density="group" title={label} titleNode={titleNode} count={count} check={check} verb={verb} overflow={menu} aria-label={`${label}, ${count}`} />;
}
