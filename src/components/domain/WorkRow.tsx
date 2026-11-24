'use client';
/**
 * WorkRow: the work-item list row, a configuration of the kit's ActionRow (01-ui-audit R10; the map in
 * src/components/kit/ActionRow.tsx):
 *
 *   ▌ Title ······································· start by / due · you ~20m · account   (meta, folds when narrow)
 *   ▌ [one status badge] why, one muted line ·············· alt · quiet verb  (filled when selected)
 *                                                    hover / selection: ✓ done · ◔ snooze · ✎ edit · ↗ Open in Slack
 *
 * The 3 px edge is the row's one colour signal (itemIndicator). Keys on the focused row: Enter details, ⇧Enter page,
 * ⌘↵ the verb, d done, ⇧D resolve, s snooze, e edit, x select, o the origin source. The props and data attributes
 * are the ones callers always used; ActionRow owns the layout, focus ring and live states.
 *
 * WorkList (container + j/k focus movement) and WorkGroup (collapsible "Do now 4" header) live here too.
 */
import type { EntityRef, NbaVerb, SourceRef, WorkItem } from '@/contract';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { ActionRow, type ActionRowOverflow } from '@/components/kit/ActionRow';
import { cn, Icon, StaleMark } from '@/ui';
import { AccountTag, itemIndicator, StartBy, StatusBadge, TONE_TO_BADGE, useClock, type Indicator } from './lib';
import { openInLabel, originSource } from './lib/source-link';
import { age } from './lib/time';
import { hm, sentence } from './lib/v2';
import { leadTiming } from './derive';
import { statePill, VERB_LABEL } from './vocab';

export type WorkRowActionKey = 'done' | 'snooze' | 'edit' | 'open_source' | 'resolve' | 'select';

export interface WorkRowProps {
  item: WorkItem;
  /** The item's NBA verb (the row's quiet action); omit to hide it. */
  nbaVerb?: NbaVerb | null;
  selected?: boolean;
  /** Spine ↔ list hover link. */
  highlighted?: boolean;
  now?: string;
  className?: string;
  onOpen?: (item: WorkItem, mode: 'sheet' | 'page') => void;
  onAction?: (key: WorkRowActionKey, item: WorkItem) => void;
  /** The verb / ⌘↵. */
  onVerb?: (verb: NbaVerb, item: WorkItem) => void;
  onOpenSource?: (source: SourceRef, item: WorkItem) => void;
  onOpenEntity?: (ref: EntityRef) => void;
  onHover?: (itemId: string | null) => void;

  /** @deprecated The one-line table row is gone (ActionRow has one layout); kept so old callers compile. */
  dense?: boolean;
  /** v2: #1 of its list: the verb is filled even when not selected. */
  emphasis?: boolean;
  /** v2: the item is open in the docked panel (the panel footer holds the filled action). */
  inPanel?: boolean;
  /** v2: the page knows the item is blocked (red edge + "Blocked" badge). */
  blocked?: boolean;
  /** Live updates (docs/UX.md): arrived ('new'), left elsewhere ('leaving'), or left while open in the panel ('gone'). */
  live?: 'new' | 'leaving' | 'gone';
  /** v2: override the edge indicator. */
  edge?: Indicator;
  /** v2: override the computed status badge (e.g. a "◷ 114 d" age badge). `null` hides it. */
  badge?: ReactNode;
  /** v2: override the why line (default: item.why). */
  why?: ReactNode;
  /** v2: override the verb's label (default: the NBA verb's label). */
  verbLabel?: string;
  /** LD-1: a second quiet verb beside the first (Looks done: "Not done"). */
  altVerb?: { label: string; title?: string; onClick: (item: WorkItem) => void };
  /** v2: an extra line under the row (a progress meter, a checklist). */
  extra?: ReactNode;
  /** v2: hide the meta column (timing · effort · account) even on wide containers. */
  hideMeta?: boolean;
  /** v2: a leading "when" column (Today's run of day: "08:35" over "in 13m"). */
  when?: { top: string; bottom?: string };
}

export function WorkRow(props: WorkRowProps) {
  const { item, nbaVerb, selected, highlighted, className, onOpen, onAction, onVerb, onOpenSource, onOpenEntity, onHover, emphasis, inPanel, blocked, verbLabel, altVerb, extra, hideMeta, when } = props;
  const { now } = useClock({ now: props.now });
  const timing = leadTiming(item);
  const pill = item.state === 'open' || item.state === 'in_progress' ? null : statePill(item, { waitingAge: item.waiting ? age(item.waiting.since, now) : undefined });
  const openable = originSource(item.sources);
  const done = item.state === 'done' || item.state === 'dismissed';
  const ind = props.edge ?? itemIndicator(item, now, { selected, blocked });
  const act = (key: WorkRowActionKey) => onAction?.(key, item);

  const badgeNode =
    props.badge !== undefined ? (
      props.badge
    ) : blocked ? (
      <StatusBadge tone="danger" icon="ban">
        Blocked
      </StatusBadge>
    ) : pill ? (
      <StatusBadge tone={TONE_TO_BADGE[pill.tone]} dashed={pill.dashed}>
        {pill.label}
      </StatusBadge>
    ) : item.training?.overdue ? (
      <StatusBadge tone="danger" icon="clock">
        Overdue
      </StatusBadge>
    ) : null;

  const timingText = timing ? <StartBy at={timing.at} kind={timing.kind} note={false} /> : null;
  const meta = hideMeta ? null : (
    <>
      {timingText}
      <span className="tabular-nums" title={item.effort.agentMin ? `agent ~${hm(item.effort.agentMin)} runs in the background` : undefined}>
        you ~{hm(item.effort.youMin)}
        {item.effort.agentMin ? <span className="text-ai-700"> · ✦</span> : null}
      </span>
      {item.refs.account ? <AccountTag label={item.refs.account.label} plain onOpen={onOpenEntity ? () => onOpenEntity(item.refs.account!) : undefined} /> : null}
    </>
  );
  // The timing rides on the why line when the meta column is folded (narrow rows) or hidden.
  const chips = timingText ? <span className={cn('min-w-0 shrink truncate', !hideMeta && '@3xl:hidden')}>{timingText}</span> : null;

  const overflow: ActionRowOverflow[] = [
    { id: 'done', label: 'Done', icon: 'check', k: 'd', onClick: () => act('done') },
    { id: 'snooze', label: 'Snooze', icon: 'clock', k: 's', onClick: () => act('snooze') },
    { id: 'edit', label: 'Edit', icon: 'edit', k: 'e', onClick: () => act('edit') },
    ...(openable && onOpenSource ? [{ id: 'open', label: openInLabel(openable.kind), icon: 'new_window', k: 'o', onClick: () => onOpenSource(openable, item) }] : []),
  ];

  const titleNode = (
    <>
      {item.title}
      {item.stale ? (
        <span className="ml-2 inline-flex align-middle">
          <StaleMark reason={item.stale.reason} />
        </span>
      ) : null}
      {item.newEvidenceCount > 0 ? <span className="ml-2 inline-block size-1.5 rounded-full bg-muted align-middle" title={`${item.newEvidenceCount} new`} /> : null}
    </>
  );

  return (
    <ActionRow
      id={item.id}
      title={item.title}
      titleNode={titleNode}
      done={done}
      lead={when}
      edge={ind}
      badge={badgeNode}
      chips={chips}
      why={<span className={cn(item.reevaluating && 'cc-reeval px-1')}>{props.why ?? item.why}</span>}
      whyTitle={typeof props.why === 'string' ? props.why : item.why}
      meta={meta}
      verb={nbaVerb ? { label: verbLabel ?? VERB_LABEL[nbaVerb], onClick: () => onVerb?.(nbaVerb, item) } : null}
      altVerb={altVerb ? { label: altVerb.label, title: altVerb.title, onClick: () => altVerb.onClick(item) } : null}
      overflow={overflow}
      inlineOverflow={4}
      extra={extra}
      live={props.live}
      selected={selected}
      emphasis={emphasis}
      inPanel={inPanel}
      onOpen={(mode) => onOpen?.(item, mode === 'page' ? 'page' : 'sheet')}
      keys={{ d: () => act('done'), D: () => act('resolve'), s: () => act('snooze'), e: () => act('edit'), x: () => act('select'), ...(openable && onOpenSource ? { o: () => onOpenSource(openable, item) } : {}) }}
      onMouseEnter={() => onHover?.(item.id)}
      onMouseLeave={() => onHover?.(null)}
      className={cn(highlighted && !selected && 'bg-surface-muted', className)}
    />
  );
}

/** List container. Default: a bordered panel; `bare` drops the box (rows inside a SectionColumn or pane). j/k (and ↑/↓) move focus between rows. */
export function WorkList({ children, className, label, bare }: { children: ReactNode; className?: string; label?: string; bare?: boolean }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
    const dir = keys[e.key];
    if (!dir || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (!target.matches('[data-row]')) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-row]'));
    const next = rows[rows.indexOf(target) + dir];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return (
    <div role="grid" aria-label={label} onKeyDown={onKeyDown} className={cn('flex flex-col', bare ? 'min-w-0' : 'overflow-clip rounded-lg border border-line bg-surface p-1.5', className)}>
      {children}
    </div>
  );
}

export interface WorkGroupProps {
  label: string;
  count: number;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onToggle?: (collapsed: boolean) => void;
  /** Right side of the header: a batch action or "See all 37 →". */
  action?: ReactNode;
  children: ReactNode;
}

/** Collapsible group: a verb-named, sentence-case header with a count ("Do now 4"), sticky in its scroller. */
export function WorkGroup({ label, count, collapsed: controlled, defaultCollapsed, onToggle, action, children }: WorkGroupProps) {
  const [inner, setInner] = useState(defaultCollapsed ?? false);
  const collapsed = controlled ?? inner;
  const toggle = () => {
    if (controlled === undefined) setInner(!collapsed);
    onToggle?.(!collapsed);
  };
  return (
    // a div: a section can't take the rowgroup role
    <div role="rowgroup">
      {/* the group's header row (a rowgroup holds rows only), its one header cell taking no box */}
      <div role="row" className="sticky top-0 z-10 flex h-11 items-center gap-2 border-b border-line bg-surface px-2">
        <div role="rowheader" className="contents">
        <button type="button" onClick={toggle} aria-expanded={!collapsed} className="inline-flex min-w-0 items-baseline gap-2 rounded-sm px-1 hover:text-fg focus-visible:outline-none focus-visible:shadow-focus">
          <Icon name={collapsed ? 'chevronright' : 'chevrondown'} size="xs" className="self-center text-faint" />
          <span className="truncate text-body-lg font-bold text-fg-heading">{sentence(label)}</span>
          <span className="text-body text-muted tabular-nums">{count}</span>
        </button>
        {action ? <span className="ml-auto text-caption font-bold">{action}</span> : null}
        </div>
      </div>
      {collapsed ? null : children}
    </div>
  );
}


