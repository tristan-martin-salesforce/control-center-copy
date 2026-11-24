'use client';
/**
 * The work item's verbs (01-ui-audit R6, UI-5): the item's ONE own verb (Accept a suggestion, Confirm a likely-done,
 * Reopen a closed item) plus the kit's two menus, **Later ▾** and **Done ▾** (src/components/kit). They replace the
 * five near-synonyms the header and footer used to show (Snooze · Done · Not now · Resolve, plus Open source).
 *
 *   sheet / page header:  [Accept]  [Later ▾] [Done ▾]  [Open source]
 *   panel footer:         the kit DetailPanel draws Later ▾ / Done ▾; the ResolvePopover anchors beside its primary
 *
 * Done ▾ ends with "More ways it ended…": the ResolvePicker (handed off, duplicate, superseded, done by a named
 * person), so nothing the old Resolve button did is lost. Each choice is one existing item action (item-menus.ts).
 */
import type { PersonRef, SourceRef, WorkItem } from '@/contract';
import { DoneMenu, LaterMenu, type ItemMenuHandlers } from '@/components/kit';
import { ResolvePicker, type ResolveValue } from '@/components/domain';
import { Button, Popover, type MenuEntry, type Placement } from '@/ui';
import { CLOSED_STATES } from '../lib/derive';

/** Done ▾'s extra entry: the full resolution picker. */
export function moreWaysEntry(open: () => void): MenuEntry {
  // The menu returns focus to its trigger as it closes; open the picker after that settles.
  return { id: 'done-more', label: 'More ways it ended…', description: 'Handed off, duplicate, superseded', onSelect: () => setTimeout(open, 0) };
}

export interface ResolvePopoverProps {
  item: WorkItem;
  people: PersonRef[];
  threadPeople: string[];
  relatedItems: Array<{ id: string; title: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolve: (v: ResolveValue) => void;
  placement?: Extract<Placement, 'bottom-end' | 'top-end' | 'top-start' | 'bottom-start'>;
}

/** The ResolvePicker, opened from Done ▾ or ⌘K; anchored to an invisible point beside the menus. */
export function ResolvePopover(p: ResolvePopoverProps) {
  return (
    <Popover
      open={p.open}
      onOpenChange={p.onOpenChange}
      placement={p.placement ?? 'bottom-end'}
      label="Resolve"
      initialFocus="first"
      // ResolvePicker brings its own surface; the popover only positions it.
      style={{ border: 'none', boxShadow: 'none', background: 'transparent' }}
      trigger={<span aria-hidden className="inline-block h-8 w-0" data-resolve-anchor />}
    >
      {({ close }) => (
        <ResolvePicker
          title={p.item.title}
          people={p.people}
          threadPeople={p.threadPeople}
          relatedItems={p.relatedItems}
          onCancel={close}
          onResolve={(v) => {
            close();
            p.onResolve(v);
          }}
        />
      )}
    </Popover>
  );
}

export interface ItemVerbsProps extends Omit<ResolvePopoverProps, 'open' | 'onOpenChange' | 'placement'> {
  menus: ItemMenuHandlers;
  source: SourceRef | null;
  doneOpen: boolean;
  onDoneOpenChange: (open: boolean) => void;
  laterOpen: boolean;
  onLaterOpenChange: (open: boolean) => void;
  resolveOpen: boolean;
  onResolveOpenChange: (open: boolean) => void;
  onReopen: () => void;
  onAccept: () => void;
  onConfirmDone: () => void;
  onOpenSource: (s: SourceRef) => void;
  className?: string;
}

/** The sheet's and the page's header verbs. Quiet: the view's one filled button belongs to the next step. */
export function ItemVerbs(p: ItemVerbsProps) {
  const { item } = p;
  const closed = CLOSED_STATES.has(item.state);
  return (
    <div className={p.className ?? 'flex flex-wrap items-center gap-1'} role="group" aria-label="Item actions">
      {item.state === 'suggested' ? (
        <Button size="sm" variant="ghost" icon="check" title="Accept (a)" onClick={p.onAccept} data-action="accept">
          Accept
        </Button>
      ) : null}
      {item.state === 'likely_done' ? (
        <Button size="sm" variant="ghost" icon="check" onClick={p.onConfirmDone} data-action="confirm">
          Confirm done
        </Button>
      ) : null}
      {closed ? (
        <Button size="sm" variant="ghost" icon="undo" onClick={p.onReopen} data-action="reopen">
          Reopen
        </Button>
      ) : (
        <>
          <LaterMenu menus={p.menus} open={p.laterOpen} onOpenChange={p.onLaterOpenChange} placement="bottom-end" />
          <DoneMenu menus={p.menus} open={p.doneOpen} onOpenChange={p.onDoneOpenChange} placement="bottom-end" extra={[moreWaysEntry(() => p.onResolveOpenChange(true))]} />
          <ResolvePopover {...p} open={p.resolveOpen} onOpenChange={p.onResolveOpenChange} />
        </>
      )}
      {p.source ? (
        <Button size="sm" variant="ghost" icon="new_window" onClick={() => p.onOpenSource(p.source!)} title={`${p.source.label} (o)`} data-action="open-source">
          Open source
        </Button>
      ) : null}
    </div>
  );
}
