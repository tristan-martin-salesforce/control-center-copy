'use client';
/**
 * DetailPanel: the docked Details panel's one frame (01-ui-audit R10), with the two item menus (R6).
 *
 *   WORK ITEM
 *   Title                                                     [header actions]
 *   subtitle
 *   ─ sections (registered per kind, detail-sections.ts, plus any passed in) ─
 *   [Later ▾] [Done ▾] ······························································ [primary]
 *
 * Done ▾: done by me · someone else · not mine · not needed. Later ▾: tomorrow · next week · pick a date · not now.
 * Keys while focus is in the panel (not in a field): `d` done by me, `⇧D` opens Done ▾, `l` opens Later ▾. Each choice
 * maps onto the existing item mutations (item-menus.ts → useItemMenus); the panel only presents them.
 *
 * A rich panel (the work item's) keeps its own pieces in the frame: `header` replaces the plain title block (an
 * editable title), `children` is the body before the registered sections, `primaryNode` replaces the footer's filled
 * button (a primary claimed by the next step, a send countdown), `doneExtra` adds entries under Done ▾ ("More ways it
 * ended…"), `laterKeys` adds keys that open Later ▾. DoneMenu and LaterMenu are exported for headers (sheet, page).
 */
import { createElement, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Placement } from '@/ui';
import type { EntityType } from '@/contract';
import { fmtWhen } from '@/components/detail/lib/tz';
import { registerDetailRenderer, type PanelEntity } from '@/components/shell/panel';
import { Button, cn, Icon, Menu, type MenuEntry } from '@/ui';
import { sortSections, useDetailSections, type DetailSection } from './detail-sections';
import { DONE_CHOICES, laterTargets, pickedDayAt9, type DoneChoice, type LaterChoice } from './item-menus';
import type { ItemMenuHandlers } from './useItemMenus';

export interface DetailPanelProps {
  entity: PanelEntity;
  /** The panel's heading (default: the entity's label). */
  title?: string;
  subtitle?: ReactNode;
  /** The eyebrow over the title ("Work item"). */
  eyebrow?: string;
  headerActions?: ReactNode;
  /** Sections beside the registered ones for the entity's kind (same ordering rules). */
  sections?: DetailSection[];
  /** Done ▾ / Later ▾ (useItemMenus for a work item). Omit for entities that are not closeable work. */
  menus?: ItemMenuHandlers | null;
  /** The footer's one filled button (the next step: Review, Send, Log). */
  primary?: { label: string; onClick: () => void; kbd?: string; disabled?: boolean };
  /** Replaces the default header block (eyebrow, title, subtitle, header actions). */
  header?: ReactNode;
  /** The body before the registered sections. */
  children?: ReactNode;
  /** Replaces the body's padding (default `px-5 py-3`). */
  bodyClassName?: string;
  /** A custom filled primary in the primary's place (a claimed next step, a countdown). Wins over `primary`. */
  primaryNode?: ReactNode;
  /** More Done ▾ entries after the four ways it ended. */
  doneExtra?: MenuEntry[];
  /** Keys that open Later ▾ (default ['l']). */
  laterKeys?: readonly string[];
  className?: string;
}

const EDITABLE = 'input,textarea,select,[contenteditable="true"]';
/** Rows and popovers inside the panel own their keys (a related item's `d` is that item's). */
const OWNS_KEYS = '[role="row"],[data-row],[role="dialog"],[role="menu"]';

export function DetailPanel({ entity, title, subtitle, eyebrow, headerActions, sections = [], menus, primary, header, children, bodyClassName, primaryNode, doneExtra, laterKeys = ['l'], className }: DetailPanelProps) {
  const registered = useDetailSections(entity.kind);
  const all = sortSections([...registered.filter((r) => !sections.some((s) => s.id === r.id)), ...sections]).filter((s) => !s.when || s.when(entity));
  const [doneOpen, setDoneOpen] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const heading = title ?? entity.label ?? 'Details';
  const hid = useId();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!menus || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest(EDITABLE) || (e.target as HTMLElement).closest(OWNS_KEYS)) return;
    if (e.key === 'd') menus.onDone('by_me');
    else if (e.key === 'D') setDoneOpen(true);
    else if (laterKeys.includes(e.key)) setLaterOpen(true);
    else return;
    e.preventDefault();
  };

  return (
    <div role="region" aria-labelledby={hid} data-detail-panel={entity.kind} tabIndex={-1} onKeyDown={onKeyDown} className={cn('flex h-full min-h-0 flex-col bg-surface text-fg outline-none', className)}>
      {header !== undefined ? (
        <div id={hid} className="contents">
          {header}
        </div>
      ) : (
        <header className="flex min-w-0 flex-col gap-0.5 border-b border-line px-5 pt-4 pb-3">
          {eyebrow ? <p className="text-caption font-bold text-muted">{eyebrow}</p> : null}
          <div className="flex min-w-0 items-start gap-3">
            <h2 id={hid} className="min-w-0 flex-1 text-title font-bold text-fg-heading" data-testid="detail-title">
              {heading}
            </h2>
            {headerActions ? <div className="flex shrink-0 items-center gap-1">{headerActions}</div> : null}
          </div>
          {subtitle ? <div className="text-body text-muted">{subtitle}</div> : null}
        </header>
      )}
      <div className={cn('cc-scroll relative min-h-0 flex-1 overflow-y-auto', bodyClassName ?? 'px-5 py-3')} data-panel-scroll>
        {children}
        {all.map((s) => (
          <PanelSection key={s.id} section={s} entity={entity} />
        ))}
      </div>
      {menus || primary || primaryNode ? (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3" data-panel-footer>
          {menus ? (
            <>
              <LaterMenu menus={menus} open={laterOpen} onOpenChange={setLaterOpen} />
              <DoneMenu menus={menus} open={doneOpen} onOpenChange={setDoneOpen} extra={doneExtra} />
            </>
          ) : null}
          {primaryNode ? (
            <div className="ml-auto flex min-w-0 items-center">{primaryNode}</div>
          ) : primary ? (
            <Button variant="primary" size="sm" kbd={primary.kbd} disabled={primary.disabled} onClick={primary.onClick} className="ml-auto" data-testid="detail-primary">
              {primary.label}
            </Button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

function PanelSection({ section, entity }: { section: DetailSection; entity: PanelEntity }) {
  const [open, setOpen] = useState(!section.collapsed);
  if (!section.title) return <section data-detail-section={section.id} className="py-2">{section.render(entity)}</section>;
  return (
    <section data-detail-section={section.id} className="border-b border-line py-3 last:border-b-0">
      <h3>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="-ml-1 inline-flex items-center gap-1.5 rounded-sm px-1 text-caption font-bold text-fg-heading focus-visible:shadow-focus focus-visible:outline-none">
          <Icon name={open ? 'chevrondown' : 'chevronright'} size="xs" className="text-faint" />
          {section.title}
        </button>
      </h3>
      {open ? <div className="mt-2 min-w-0 text-body">{section.render(entity)}</div> : null}
    </section>
  );
}

export interface ItemMenuProps {
  menus: ItemMenuHandlers;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Where the menu opens (default above: a footer). */
  placement?: Placement;
  size?: 'xs' | 'sm';
}

/** Done ▾: done by me · someone else · not mine · not needed (plus `extra`). */
export function DoneMenu({ menus, open, onOpenChange, extra, placement = 'top-start', size = 'sm' }: ItemMenuProps & { extra?: MenuEntry[] }) {
  const items: MenuEntry[] = [
    ...DONE_CHOICES.map((c): MenuEntry => ({ id: `done-${c.choice}`, label: c.label, description: c.description, kbd: c.kbd, onSelect: () => menus.onDone(c.choice as DoneChoice) })),
    ...(extra?.length ? [{ type: 'separator' } as MenuEntry, ...extra] : []),
  ];
  return (
    <Menu
      open={open}
      onOpenChange={onOpenChange}
      label="Done"
      placement={placement}
      width={260}
      items={items}
      trigger={
        <Button size={size} variant="secondary" iconRight="chevrondown" title="Done (d) · more ways it ended (⇧D)" data-testid="menu-done">
          Done
        </Button>
      }
    />
  );
}

/** Later ▾: tomorrow · next week · pick a date · not now (the next working day). */
export function LaterMenu({ menus, open, onOpenChange, placement = 'top-start', size = 'sm' }: ItemMenuProps) {
  const t = laterTargets(menus.now, menus.tz);
  const when = (iso: string) => fmtWhen(iso, menus.now, menus.tz);
  const fixed = (choice: Exclude<LaterChoice, 'pick'>, label: string, extra = ''): MenuEntry => ({ id: `later-${choice}`, label, description: `${when(t[choice])}${extra}`, onSelect: () => menus.onLater(choice) });
  const items: MenuEntry[] = [
    fixed('tomorrow', 'Tomorrow'),
    fixed('next_week', 'Next week'),
    { type: 'custom', id: 'later-pick', render: (close) => <PickDate menus={menus} close={close} /> },
    { type: 'separator' },
    fixed('not_now', 'Not now', ' · next working day'),
  ];
  return (
    <Menu
      open={open}
      onOpenChange={onOpenChange}
      label="Later"
      placement={placement}
      width={272}
      items={items}
      trigger={
        <Button size={size} variant="secondary" iconRight="chevrondown" title="Later (l)" data-testid="menu-later">
          Later
        </Button>
      }
    />
  );
}

function PickDate({ menus, close }: { menus: ItemMenuHandlers; close: () => void }) {
  const [day, setDay] = useState('');
  const at = day ? pickedDayAt9(day, menus.now, menus.tz) : null;
  return (
    <form
      className="flex items-center gap-2 px-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!at) return;
        menus.onLater('pick', at);
        close();
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-caption text-muted">
        Pick a date
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} data-testid="later-pick-date" className="h-8 rounded-sm border border-line-input bg-surface-input px-2 text-body text-fg" />
      </label>
      <Button type="submit" size="xs" variant="secondary" disabled={!at} data-testid="later-pick-set">
        Set
      </Button>
    </form>
  );
}

/**
 * Register a kind's Details as a DetailPanel over its section registry (the panels/register.ts pattern, one level
 * up): `registerSectionedPanel('vdp_record', (e) => ({ eyebrow: 'VDP', title: e.label }))`. Browser only.
 */
export function registerSectionedPanel(kind: EntityType, props: (entity: PanelEntity) => Omit<DetailPanelProps, 'entity'> = () => ({})): () => void {
  return registerDetailRenderer(kind, (e) => createElement(DetailPanel, { key: e.id, entity: e, ...props(e) }));
}
