'use client';
/**
 * The docked right panel (DESIGN-V2 principle 10): Details and Assistant ⌘J tabs plus ✕, 520 px
 * (600 at a 2,400 px frame). It sits beside #cc-main and pushes it; nothing overlays the page.
 *
 *   Details    the registered renderer for the entity (registerDetailRenderer), a generic fallback
 *              (label, kind, "Open page →") for kinds without one, or a legacy <SideSheet> docked
 *              into #cc-detail-dock.
 *   Assistant  the frame's chat slot, mounted on first use and kept mounted.
 */
import { AppLink } from './AppLink';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { EntityType } from '@/contract';
import { focusChat } from '@/components/chat';
import { IconButton } from '@/ui/Button';
import { cn } from '@/ui/cn';
import { ariaKeyShortcuts, KbdHint } from '@/ui/Kbd';
import { useIsMac } from '@/client/keyboard/KeyboardProvider';
import { PanelBoundary } from '@/ui/PanelBoundary';
import { EmptyState } from '@/ui/states';
import { Tooltip } from '@/ui/Tooltip';
import { hrefForRef } from './CommandPalette';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { useGone } from '@/components/lists/gone';
import { kindLabel, useDetailRenderer, usePanelInternals, useRightPanel, type PanelEntity, type PanelTab } from './panel';

/** Where a kind lives when it has no detail renderer yet (wave 2 registers more). */
const PAGE_FOR: Partial<Record<EntityType, string>> = {
  calendar_event: '/today',
  connector: '/settings?section=connectors',
  agent_run: '/agents',
};

export function pageForEntity(entity: Pick<PanelEntity, 'kind' | 'id'>): string | null {
  const href = PAGE_FOR[entity.kind] ?? hrefForRef({ type: entity.kind, id: entity.id });
  return href === '/' ? null : href;
}

/** Any kind without a registered renderer: its label, the kind in words, one quiet link to its page. Never blank. */
export function GenericDetail({ entity }: { entity: PanelEntity }) {
  const href = pageForEntity(entity);
  return (
    <div className="cc-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-5" data-generic-detail>
      <p className="text-caption text-muted">{kindLabel(entity.kind)}</p>
      <h2 className="text-title text-fg-heading">{entity.label ?? kindLabel(entity.kind)}</h2>
      {href ? (
        <AppLink href={href} className="self-start text-body font-bold">
          Open page →
        </AppLink>
      ) : null}
    </div>
  );
}

/**
 * The open item left its list because of something elsewhere (docs/UX.md "Live updates"): say so, keep it open,
 * offer Next and Close. Never a jump, never a toast.
 */
function GoneNotice({ entityId }: { entityId: string }) {
  const note = useGone(entityId);
  const panel = useRightPanel();
  if (!note) return null;
  return (
    <div role="status" data-gone-notice className="flex shrink-0 items-start gap-3 border-b border-line bg-surface-muted px-6 py-3 text-caption">
      <Icon name="info" size="sm" className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <p className="font-bold text-fg-heading">{note.title}</p>
        {note.body ? <p className="text-muted">{note.body}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {note.next ? (
          <Button size="xs" variant="secondary" onClick={note.next}>
            {note.nextLabel ?? 'Next'}
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={() => panel.close()}>
          Close
        </Button>
      </div>
    </div>
  );
}

function EntityDetails({ entity }: { entity: PanelEntity }) {
  const render = useDetailRenderer(entity.kind);
  // Full-height flex column: panel renderers scroll their own body and pin their footer (the one filled action).
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-panel-entity={entity.kind}>
      <GoneNotice entityId={entity.id} />
      <PanelBoundary name="panel-details" resetKeys={[entity.kind, entity.id]}>
        {render ? render(entity) : <GenericDetail entity={entity} />}
      </PanelBoundary>
    </div>
  );
}

const TABS: Array<{ id: PanelTab; label: string; kbd?: string }> = [
  { id: 'details', label: 'Details' },
  { id: 'assistant', label: 'Assistant', kbd: 'mod+j' },
];

export interface RightPanelViewProps {
  /** The Assistant tab's content (the chat slot). */
  assistant: ReactNode;
  width: number;
  /** Kit specimens: unique ids instead of the frame's fixed ones (#cc-panel, #cc-detail-dock…). */
  specimen?: boolean;
  className?: string;
}

export function RightPanelView({ assistant, width, specimen, className }: RightPanelViewProps) {
  const uid = useId();
  const ids = specimen ? `cc-panel${uid.replace(/:/g, '')}` : 'cc-panel';
  const panel = useRightPanel();
  const internals = usePanelInternals();
  const tabRefs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});
  const isMac = useIsMac();
  const { source } = internals;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next: PanelTab = e.key === 'Home' ? 'details' : e.key === 'End' ? 'assistant' : panel.tab === 'details' ? 'assistant' : 'details';
    panel.setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <aside
      ref={internals.setPanelEl}
      id={ids}
      aria-label="Details and assistant"
      hidden={!internals.visible}
      data-tab={panel.tab}
      style={{ width }}
      className={cn('relative flex min-h-0 shrink-0 flex-col border-l border-line bg-surface', className)}
    >
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-3 pl-4">
        {/* the tablist holds only its tabs; Close sits beside it */}
        <div role="tablist" aria-label="Panel" className="flex items-center gap-1">
        {TABS.map((t) => {
          const sel = panel.tab === t.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${ids}-tab-${t.id}`}
              aria-selected={sel}
              aria-controls={`${ids}-${t.id}`}
              aria-keyshortcuts={t.kbd ? ariaKeyShortcuts(t.kbd, isMac) : undefined}
              tabIndex={sel ? 0 : -1}
              // On /assistant the page is the assistant: its tab focuses the page composer instead.
              onClick={() => (t.id === 'assistant' && internals.assistantHere ? focusChat() : panel.setTab(t.id))}
              onKeyDown={onTabKey}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-md px-3 text-body font-bold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:shadow-focus',
                sel ? 'bg-selected text-fg-heading' : 'text-muted hover:bg-surface-muted hover:text-fg',
              )}
            >
              {t.label}
              {t.kbd ? <KbdHint combo={t.kbd} tone="quiet" decorative /> : null}
            </button>
          );
        })}
        </div>
        <span className="flex-1" />
        <Tooltip content={<span className="inline-flex items-center gap-1.5">Close <KbdHint combo="escape" tone="inverse" /></span>} side="bottom">
          <IconButton icon="close" label="Close panel" onClick={internals.closeAndRestore} />
        </Tooltip>
      </div>

      <div role="tabpanel" id={`${ids}-details`} aria-labelledby={`${ids}-tab-details`} hidden={panel.tab !== 'details'} className="relative flex min-h-0 flex-1 flex-col">
        {source === 'entity' && panel.entity ? <EntityDetails entity={panel.entity} /> : null}
        {source === null || (source === 'entity' && !panel.entity) ? (
          <EmptyState size="panel" icon="preview" title="Nothing selected" body="Click a row or card, or press Enter on it, to see its details here." />
        ) : null}
        {/* Legacy <SideSheet>s portal here (SheetHost.dock), so pages that still open one land in the panel. */}
        <div
          ref={internals.setDockEl}
          id={specimen ? undefined : 'cc-detail-dock'}
          hidden={source !== 'sheet'}
          className="relative flex min-h-0 flex-1 flex-col [&_[data-docked]]:border-l-0 [&_[data-docked]>header_button[aria-label=Close]]:hidden"
        />
      </div>

      <div role="tabpanel" id={`${ids}-assistant`} aria-labelledby={`${ids}-tab-assistant`} hidden={panel.tab !== 'assistant'} className="relative flex min-h-0 flex-1 flex-col">
        {internals.assistantMounted ? (
          <PanelBoundary name="panel-assistant">
            <div id={specimen ? undefined : 'cc-rail-chat'} className="flex min-h-0 flex-1 flex-col">
              {assistant}
            </div>
          </PanelBoundary>
        ) : null}
      </div>
    </aside>
  );
}

