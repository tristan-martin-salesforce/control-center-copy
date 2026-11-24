'use client';
/**
 * Done ▾ / Later ▾ wired to the work-item mutations (src/components/detail/lib/mutations.ts, unchanged): each choice
 * becomes one `itemAction` call through useItemAction, so the cache patch, rollback, 409 rebase and the Undo toast are
 * the ones every other surface already uses.
 *
 *   const menus = useItemMenus({ id, version }, { now, tz });
 *   <DetailPanel … menus={menus} />
 */
import { useCallback, useMemo } from 'react';
import { useItemAction } from '@/components/detail/lib/mutations';
import { doneRequest, laterRequest, type DoneChoice, type LaterChoice, type MenuRequest } from './item-menus';

export interface ItemMenuHandlers {
  onDone: (choice: DoneChoice, opts?: { personName?: string }) => void;
  onLater: (choice: LaterChoice, picked?: string | null) => void;
  now: string;
  tz?: string;
}

/**
 * `sendVia` hands each request to a caller that already owns a useItemAction (the work-item detail, whose action
 * error banner and Retry must see menu choices too); without it the hook uses its own.
 */
export function useItemMenus(item: { id: string; version: number }, clock: { now: string; tz?: string }, sendVia?: (r: MenuRequest) => void): ItemMenuHandlers {
  const action = useItemAction();
  const send = useCallback(
    (r: MenuRequest | null) => {
      if (!r) return;
      if (sendVia) return sendVia(r);
      action.mutate({ params: { id: item.id, verb: r.verb }, body: { ifVersion: action.versionOf(item.id) ?? item.version, ...r.body } });
    },
    [action, item.id, item.version, sendVia],
  );
  const { now, tz } = clock;
  return useMemo(
    () => ({
      now,
      tz,
      onDone: (choice, opts) => send(doneRequest(choice, opts)),
      onLater: (choice, picked) => send(laterRequest(choice, now, tz, picked)),
    }),
    [send, now, tz],
  );
}
