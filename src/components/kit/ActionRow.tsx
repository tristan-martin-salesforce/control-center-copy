'use client';
/**
 * ActionRow: the one row contract (01-ui-audit R10, UI-35). Every list row is a configuration of these slots:
 *
 *   [lead] [☐] ▌ Title ······································· meta (folds on narrow rows)
 *              ▌ [badge] Sure · ✦ AI · ↗ Slack · why, one muted line ········· [trailing | alt · verb]  ⋯
 *              ▌ extra (an inline error, a dry-run result)
 *                expansion (pickers, a preview), toggled with Space
 *
 * - The 3 px edge is the row's one colour signal (danger beats selection; selection is blue; `dashed` = a guess or
 *   pending, nothing looks done before it is).
 * - Quiet actions, loud selection (DESIGN-V2): the verb is quiet text until the row is selected or is the emphasised
 *   #1 (and not open in the panel, whose footer owns the filled button). Overflow verbs show on hover / focus /
 *   selection; the first `inlineOverflow` are icon buttons, the rest sit in a ⋯ menu.
 * - States: live `new` (tinted arrival) · `leaving` (fades, src/styles/live.css) · `gone` (left elsewhere while open in
 *   the panel: dimmed, verbs off) · `selected` · `held` (parked on something else: a scheduled send, a VDP item waiting
 *   on its parent; dashed and muted, verb off, the reason in the why line).
 * - Keys on the focused row: Enter details, ⇧Enter page, ⌘↵ the verb, Space the expansion, `o` the source, plus
 *   `keys` (single-key verbs). Focus ring: an inset 2 px focus-colour ring.
 *
 * Today's rows as configurations (the migration chunks follow this map):
 *   WorkRow     → title, why, badge (statePill), edge (itemIndicator), meta (timing · effort · account), lead (`when`),
 *                 verb (NBA verb), altVerb (Looks done "Not done"), overflow (done d · snooze s · edit e · Open in o),
 *                 keys {d, D, s, e, x}, done (struck title), extra, live, selected/emphasis/inPanel.
 *   TriageRow   → dashed, title, why, confidence, tint 'ai', source, meta (source label · effort), verb (Accept/Claim/
 *                 Confirm/Keep), altVerb (Not done/Close), overflow (edit e · merge m · Open in o), trailing (mapping
 *                 choices 1–9, Closed for you's Open message · Undo), expansion (the inline editor).
 *   OutboxRow   → title (destination), why (first line), badge (status / dry run), dashed (pending), edge (status tone),
 *                 source ("Open in Slack"), meta (For: item · drafted 9m ago · edited by you), verb (Approve & send, a,
 *                 loading), overflow (edit e · preview Space · View sent · Copy Slackbot prompt · Reject), extra (inline
 *                 error / dry-run result with Retry), expansion (preview + history).
 *   NeedRow     → check (tick), lead (when · hours), title (description), chips (sources · account), why (what is off),
 *                 tint 'ai' (a suggestion), trailing (opp / task type / hours pickers · Approve), expansion (how it
 *                 came in · other fields), live with liveTone 'ai'.
 *   ReadyRow    → as NeedRow; why = its state ("Approved · internal"), trailing = the pickers, no verb.
 *   VdpItemRow  → lead (step number), title, why (who · state · detail), held (waiting for VDP to refresh / chained:
 *                 "N first"), tint 'ai' (suggestion), verb (Apply / Apply suggestions / Review & apply), altVerb (Edit),
 *                 expansion (the apply form).
 *
 * `density="compact"` is the one-line row of dense lanes and `density="group"` a group's header line (both drawn by
 * ActionRowCompact.tsx: check · lead · title · amount · where · verb [▾ overflow] · chevron); Space and `x` tick.
 */
import { forwardRef, useCallback, useRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { EDGE_BG, type Indicator } from '@/components/domain/lib/v2';
import type { LiveRowState } from '@/components/lists/live-list';
import { Button, cn, ConfidenceWord, Icon, Menu, type ConfidenceValue, type MenuEntry } from '@/ui';
import { COMPACT_ROOT, CompactCells, type CompactSlots, type RowCheck } from './ActionRowCompact';

export interface ActionRowVerb {
  label: string;
  onClick: () => void;
  /** Key hint shown while the verb is filled ("a"). */
  kbd?: string;
  icon?: string;
  loading?: boolean;
  disabled?: boolean;
  title?: string;
  testId?: string;
}

export interface ActionRowOverflow {
  id: string;
  label: string;
  icon: string;
  onClick: () => void;
  /** The key that runs it (shown in the tooltip; wire it through `keys`). */
  k?: string;
  title?: string;
  disabled?: boolean;
  tone?: 'danger';
  testId?: string;
}

export interface ActionRowSource {
  /** "Open in Slack". */
  label: string;
  url: string;
}

export interface ActionRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'>, CompactSlots {
  id: string;
  title: string;
  /** Rendered instead of the plain title (the title stays the tooltip and the accessible name). */
  titleNode?: ReactNode;
  /** Closed: the title is struck through and muted. */
  done?: boolean;
  /** The leading column: a when ({ top: '08:35', bottom: 'in 13m' }), a step number, any node. */
  lead?: ReactNode | { top: string; bottom?: string };
  edge?: Indicator;
  /** A guess or a pending draft: the edge is dashed. */
  dashed?: boolean;
  /** A tick box before the edge (bulk rows: Needs you, Ready to log). */
  check?: RowCheck;
  why?: ReactNode;
  whyTitle?: string;
  /** The row's one status badge. */
  badge?: ReactNode;
  confidence?: ConfidenceValue;
  /** A meta chip: what the AI made ('ai', violet) or what is new ('new', blue). */
  tint?: 'ai' | 'new' | null;
  /** The origin source: a link ("Open in Slack"); `o` follows it. */
  source?: ActionRowSource | null;
  /** More meta chips on the why line (source chips, an account). */
  chips?: ReactNode;
  /** Right side of the title line (timing · effort · account); folds away on narrow rows. */
  meta?: ReactNode;
  verb?: ActionRowVerb | null;
  /** A second quiet verb beside the first ("Not done", "Edit"). */
  altVerb?: ActionRowVerb | null;
  overflow?: ActionRowOverflow[];
  /** How many overflow verbs show as icon buttons before the ⋯ menu. Default 3. */
  inlineOverflow?: number;
  /** Custom controls in place of the verbs (mapping choices, pickers). */
  trailing?: ReactNode;
  /** Under the why line. */
  extra?: ReactNode;
  /** The inline expansion (pickers, preview); Space toggles it. */
  expansion?: ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  live?: LiveRowState;
  liveTone?: 'ai';
  selected?: boolean;
  emphasis?: boolean;
  inPanel?: boolean;
  /** Parked on something else: true, or the reason ("Waiting for VDP to refresh"). */
  held?: boolean | string;
  onOpen?: (mode: 'details' | 'page') => void;
  /** Single-key verbs while the row has focus ({ d: done, D: resolve }). */
  keys?: Record<string, () => void>;
}

const EDGE_DASHED: Record<Indicator, string> = {
  now: 'border-accent',
  danger: 'border-danger-500',
  warning: 'border-warning-500',
  success: 'border-success-500',
  ai: 'border-ai-500',
  none: 'border-line-strong',
};

const COLS = {
  plain: 'grid-cols-[3px_minmax(0,1fr)]',
  lead: 'grid-cols-[4.25rem_3px_minmax(0,1fr)]',
  leadAuto: 'grid-cols-[auto_3px_minmax(0,1fr)]',
  check: 'grid-cols-[1.25rem_3px_minmax(0,1fr)]',
  both: 'grid-cols-[1.25rem_4.25rem_3px_minmax(0,1fr)]',
  bothAuto: 'grid-cols-[1.25rem_auto_3px_minmax(0,1fr)]',
} as const;

/** ROW-1: a mouse press on a row button must not move focus (the selected row redraws its buttons; the click is lost). */
const keepFocus = (e: MouseEvent) => e.preventDefault();

function isLeadPair(v: unknown): v is { top: string; bottom?: string } {
  return !!v && typeof v === 'object' && 'top' in (v as object) && typeof (v as { top: unknown }).top === 'string';
}

export function TintChip({ tint }: { tint: 'ai' | 'new' }) {
  return tint === 'ai' ? (
    <span data-tint="ai" className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-ai-200 bg-ai-50 px-1.5 text-micro font-bold text-ai-700">
      <span aria-hidden>✦</span> AI
    </span>
  ) : (
    <span data-tint="new" className="inline-flex h-5 shrink-0 items-center rounded-sm border border-info-200 bg-info-50 px-1.5 text-micro font-bold text-info-700">
      New
    </span>
  );
}

export const ActionRow = forwardRef<HTMLDivElement, ActionRowProps>(function ActionRow(p, ref) {
  const {
    id, title, titleNode, done, lead, edge = 'none', dashed, check, why, whyTitle, badge, confidence, tint, source, chips, meta, verb, altVerb,
    overflow = [], inlineOverflow = 3, trailing, extra, expansion, expanded, onExpandedChange, live, liveTone, selected, emphasis, inPanel, held,
    onOpen, keys, className, onKeyDown, onClick, density = 'regular', amount, where, whereLabel, whereFit, editor, editing, onEditingChange, failure, failureDetail, leadShort, count, ...rest
  } = p;
  const sourceRef = useRef<HTMLAnchorElement>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      rowRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  const dense = density !== 'regular';
  const gone = live === 'gone';
  const parked = !!held;
  const off = gone || parked;
  const filled = Boolean((selected || emphasis) && !inPanel && !off);
  const ind: Indicator = edge === 'danger' || (dense && failure) ? 'danger' : selected ? 'now' : edge;
  const isDashed = dashed || parked;

  const runVerb = (v: ActionRowVerb | null | undefined) => {
    if (v && !v.disabled && !v.loading && !off) v.onClick();
  };
  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.target !== e.currentTarget) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && mod) runVerb(verb);
    else if (e.key === 'Enter' && !e.altKey) onOpen?.(e.shiftKey ? 'page' : 'details');
    else if (dense && check && (e.key === ' ' || e.key === 'x') && !mod && !e.altKey) check.onChange();
    else if (e.key === ' ' && expansion !== undefined && onExpandedChange) onExpandedChange(!expanded);
    else if (mod || e.altKey) return;
    else if (keys?.[e.key] && !off) keys[e.key]!();
    else if (e.key === 'o' && source) sourceRef.current?.click();
    else return;
    e.preventDefault();
  };
  const click = (e: MouseEvent<HTMLDivElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || (e.target as HTMLElement).closest('button,a,input,label,select,textarea,[data-no-open]')) return;
    onOpen?.('details');
  };

  const shownOverflow = overflow.slice(0, inlineOverflow);
  const menuOverflow = overflow.slice(inlineOverflow);
  const iconButtons = shownOverflow.map((a) => (
    <button
      key={a.id}
      type="button"
      title={a.title ?? (a.k ? `${a.label} (${a.k})` : a.label)}
      aria-label={a.label}
      disabled={a.disabled || off}
      data-testid={a.testId ?? `overflow-${a.id}`}
      onMouseDown={keepFocus}
      onClick={(e) => {
        e.stopPropagation();
        a.onClick();
      }}
      className={cn(
        'inline-grid size-7 place-items-center rounded-sm hover:bg-surface focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
        a.tone === 'danger' ? 'text-danger-700' : 'text-muted hover:text-fg',
      )}
    >
      <Icon name={a.icon} size="sm" />
    </button>
  ));
  const menuEntries: MenuEntry[] = menuOverflow.map((a) => ({ id: a.id, label: a.label, icon: a.icon, kbd: a.k, tone: a.tone, disabled: a.disabled || off, onSelect: a.onClick }));
  const more = menuEntries.length ? (
    <Menu
      key="more"
      label="More actions"
      items={menuEntries}
      trigger={
        <button type="button" aria-label="More actions" title="More actions" data-testid="overflow-more" onMouseDown={keepFocus} className="inline-grid size-7 place-items-center rounded-sm text-muted hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:shadow-focus">
          <Icon name="threedots" size="sm" />
        </button>
      }
    />
  ) : null;
  const tools = iconButtons.length || more ? [...iconButtons, more] : null;

  const verbButton = (v: ActionRowVerb, kind: 'verb' | 'alt') => (
    <Button
      variant={kind === 'verb' && filled ? 'primary' : 'quiet'}
      size="sm"
      icon={v.icon}
      kbd={kind === 'verb' && filled ? v.kbd : undefined}
      loading={v.loading}
      disabled={v.disabled || off}
      title={v.title}
      data-row-verb={kind === 'alt' ? 'alt' : filled ? 'filled' : 'quiet'}
      data-testid={v.testId}
      onMouseDown={keepFocus}
      onClick={(e) => {
        e.stopPropagation();
        v.onClick();
      }}
    >
      {v.label}
    </Button>
  );

  const leadNode = lead === undefined || lead === null ? null : isLeadPair(lead) ? (
    <div className="flex flex-col pt-0.5" data-slot="lead">
      <b className="text-body-lg leading-7 font-bold text-fg-heading tabular-nums">{lead.top}</b>
      {lead.bottom ? <span className="text-caption whitespace-nowrap text-muted tabular-nums">{lead.bottom}</span> : null}
    </div>
  ) : (
    <div className="flex items-start pt-1" data-slot="lead">
      {lead}
    </div>
  );
  const heldText = typeof held === 'string' ? held : null;
  // a when ("08:35" over "in 13m") takes a fixed column so times line up across rows; any other lead sizes to itself
  const pair = isLeadPair(lead);
  const cols = leadNode && check ? (pair ? COLS.both : COLS.bothAuto) : leadNode ? (pair ? COLS.lead : COLS.leadAuto) : check ? COLS.check : COLS.plain;

  return (
    <div
      ref={setRef}
      role="row"
      tabIndex={0}
      data-row=""
      data-density={dense ? density : undefined}
      data-item-id={id}
      data-live={live}
      data-live-tone={live === 'new' && liveTone === 'ai' ? 'ai' : undefined}
      data-selected={selected || undefined}
      data-held={parked || undefined}
      aria-selected={selected || undefined}
      aria-hidden={live === 'leaving' || undefined}
      aria-label={title}
      onKeyDown={keyDown}
      onClick={click}
      className={cn(
        dense ? cn(COMPACT_ROOT, density === 'group' && 'bg-surface-muted') : cn('group/row @container relative grid cursor-default items-stretch gap-x-3 rounded-md border-b border-line px-3 py-2.5 last:border-b-0', cols),
        // gone dims through src/styles/live.css ([data-live='gone'])
        selected ? 'bg-selected' : 'hover:bg-surface-muted',
        'focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)] focus-visible:outline-none',
        className,
      )}
      {...rest}
    >
      {dense ? (
        <CompactCells
          {...{ density, title, titleNode, done, check, verb, overflow, dashed: isDashed, off, filled, onOpen, rowRef, amount, where, whereLabel, whereFit, editor, editing, onEditingChange, failure, failureDetail, leadShort, count }}
          lead={isLeadPair(lead) ? `${lead.top}${lead.bottom ? ` ${lead.bottom}` : ''}` : lead}
          edge={ind}
        />
      ) : (
      <>
      {/* ARIA: a row owns cells, never bare buttons (axe aria-required-children). One cell that takes no box
          (`contents`), so the slots stay the row's grid columns. */}
      <div role="gridcell" data-slot="cell" className="contents">
        {check ? (
          <span className="pt-1.5">
            <input type="checkbox" checked={check.checked} onChange={check.onChange} aria-label={check.label} data-testid="row-check" className="size-4 accent-[var(--color-accent)]" />
          </span>
        ) : null}
        {leadNode}
        <span aria-hidden data-slot="edge" data-edge={ind} className={cn('min-h-10 w-[3px]', isDashed ? cn('border-l-[3px] border-dashed', EDGE_DASHED[ind]) : cn('rounded-full', EDGE_BG[ind]))} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 truncate text-body-lg font-bold', done ? 'text-muted line-through decoration-line-strong' : parked ? 'text-fg' : 'text-fg-heading')} title={title}>
              {titleNode ?? title}
            </span>
            {meta ? <span className="ml-auto hidden max-w-[50%] min-w-0 shrink items-center gap-3 overflow-hidden pl-2 text-caption whitespace-nowrap text-muted @3xl:flex">{meta}</span> : null}
          </div>
          <div className="flex min-h-8 min-w-0 items-center gap-2 text-body text-muted">
            {badge ? <span className="flex min-w-0 shrink">{badge}</span> : null}
            {confidence ? <ConfidenceWord value={confidence} /> : null}
            {tint ? <TintChip tint={tint} /> : null}
            {source ? (
              <a
                ref={sourceRef}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="row-source-link"
                title={`${source.label} (o)`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex shrink-0 items-center gap-1 rounded-sm text-caption font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none"
              >
                <Icon name="new_window" size="xs" />
                {source.label}
              </a>
            ) : null}
            {chips ? <span className="flex min-w-0 shrink items-center gap-1">{chips}</span> : null}
            <span className="min-w-0 flex-1 truncate" title={whyTitle ?? (typeof why === 'string' ? why : heldText ?? undefined)}>
              {gone ? <span className="font-bold text-fg">Handled elsewhere · </span> : heldText ? <span className="font-bold text-fg">{heldText} · </span> : null}
              {why}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1" onClick={trailing ? (e) => e.stopPropagation() : undefined}>
              {selected && tools ? (
                <span data-row-actions="inline" className="flex items-center gap-0.5">
                  {tools}
                </span>
              ) : null}
              {trailing ?? (
                <>
                  {altVerb ? verbButton(altVerb, 'alt') : null}
                  {verb ? verbButton(verb, 'verb') : null}
                </>
              )}
            </span>
          </div>
          {extra ? <div className="min-w-0">{extra}</div> : null}
          {expansion !== undefined && expanded ? (
            <div data-slot="expansion" data-no-open className="mt-1.5 min-w-0 rounded-md bg-surface-muted p-3">
              {expansion}
            </div>
          ) : null}
        </div>
        {!selected && tools ? (
          <span data-row-actions="hover" className="absolute top-1.5 right-1.5 z-[1] hidden items-center gap-0.5 rounded-sm bg-surface-muted p-0.5 group-focus-within/row:flex group-hover/row:flex">
            {tools}
          </span>
        ) : null}
      </div>
      </>
      )}
    </div>
  );
});
