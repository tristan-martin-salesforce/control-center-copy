'use client';
/**
 * The Details panel's section registry (01-ui-audit R10): the pattern of src/components/panels/register.ts (one
 * renderer per entity kind) extended one level down, to sections. A kind's panel is a DetailPanel whose body is the
 * sections registered for that kind, in `order`; a lane adds a section (an evidence list, a VDP summary, a DC claim)
 * without touching the panel or the other sections.
 *
 *   registerDetailSections('work_item', [{ id: 'why', title: 'Why it is here', order: 10, render: (e) => <Why id={e.id} /> }]);
 *   registerSectionedPanel('work_item', (e) => ({ title: e.label ?? 'Work item' }));   // DetailPanel.tsx
 *
 * Browser only for registration (like panels/register.ts): call it from a module guarded by `typeof window`.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import type { EntityType } from '@/contract';
import type { PanelEntity } from '@/components/shell/panel';

export interface DetailSection {
  id: string;
  /** Section heading ("Why it is here"); none for a lead section. */
  title?: string;
  /** Lower first. Default 100. */
  order?: number;
  /** Shown only when this holds for the entity. */
  when?: (entity: PanelEntity) => boolean;
  /** Starts collapsed (a disclosure); default open. */
  collapsed?: boolean;
  render: (entity: PanelEntity) => ReactNode;
}

const registry = new Map<string, DetailSection[]>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version += 1;
  listeners.forEach((l) => l());
};

/** Add (or replace, by id) sections for a kind. Returns the unregister function. */
export function registerDetailSections(kind: EntityType, sections: DetailSection[]): () => void {
  const ids = new Set(sections.map((s) => s.id));
  registry.set(kind, [...(registry.get(kind) ?? []).filter((s) => !ids.has(s.id)), ...sections]);
  bump();
  return () => {
    const left = (registry.get(kind) ?? []).filter((s) => !sections.includes(s));
    if (left.length) registry.set(kind, left);
    else registry.delete(kind);
    bump();
  };
}

/** The sections for a kind, sorted by order (then registration order). */
export function getDetailSections(kind: EntityType): DetailSection[] {
  return sortSections(registry.get(kind) ?? []);
}

export function sortSections(sections: readonly DetailSection[]): DetailSection[] {
  return sections.map((s, i) => [s, i] as const).sort((a, b) => (a[0].order ?? 100) - (b[0].order ?? 100) || a[1] - b[1]).map(([s]) => s);
}

/** The sections for a kind, re-rendering when registrations change. */
export function useDetailSections(kind: EntityType): DetailSection[] {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
  return getDetailSections(kind);
}
