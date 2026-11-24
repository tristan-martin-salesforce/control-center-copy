'use client';
/**
 * Accept · dismiss · merge for Triage. Each is instant and optimistic (UI-SPEC §8): the item leaves the
 * list and the Triage count drops now (the nav badge reads the Today payload, patched in the same step),
 * an Undo toast says what happened, and a failure rolls everything back with a persistent error toast.
 */
import { useRef } from 'react';
import type { TodayPayload, TriageItem, TriagePayload } from '@/contract';
import type { OptimisticCache } from '@/client/optimistic';
import { useOptimisticMutation } from '@/client/optimistic';
import { toast } from '@/client/toast';
import { withoutTriageItem, withTriageCount } from './cache-patches';

const TOPICS = ['triage', 'today', 'items', 'item'];

function leave(id: string, cache: OptimisticCache) {
  let counted = false;
  for (const [key, data] of cache.client.getQueriesData<TriagePayload>({ queryKey: ['triage'] })) {
    if (!data || !Array.isArray(data.groups)) continue;
    const next = withoutTriageItem(data, id);
    // a Closed for you row was never in the count (SETTLE-1), so the badge only drops for a guess
    if (next.count !== data.count) counted = true;
    cache.setQuery<TriagePayload>(key, () => next);
  }
  if (counted) cache.client.setQueriesData<TodayPayload>({ queryKey: ['today'] }, (old) => (old && old.navCounts ? withTriageCount(old, -1) : old));
}

const fail = (verb: string) => (err: { message: string }) =>
  toast({ key: `triage:${verb}:err`, title: `Couldn't ${verb} that`, body: `${err.message}. It is back in the list.`, tone: 'error', durationMs: null });

export function useTriageActions() {
  const mergeTarget = useRef<string>('');
  const mapChoice = useRef<string>('');

  const accept = useOptimisticMutation({
    route: 'acceptTriage',
    topics: TOPICS,
    optimistic: (input, cache) => leave(input.params.id, cache),
    toast: (res: { entity: TriageItem }) => ({
      // one Claim verb: a missed opp the app knows becomes a DC request (100%, editable in Deals ▸ DCs)
      ...(res.entity.kind === 'missed_opp' ? { body: 'DC request added: it goes in your next batch (Deals ▸ DCs). Nothing was sent.' } : {}),
      title:
        res.entity.kind === 'mapping'
          ? `Mapped: ${mapChoice.current || res.entity.title}`
          : res.entity.kind === 'missed_opp'
            ? `Claimed: ${res.entity.title.replace(/^Claim:\s*/, '')}`
            : res.entity.group === 'still_needed'
              ? `Kept: ${res.entity.title}`
              : `Accepted: ${res.entity.title}`,
      key: `triage:${res.entity.id}`,
    }),
    onError: fail('accept'),
  });
  const dismiss = useOptimisticMutation({
    route: 'dismissTriage',
    topics: TOPICS,
    optimistic: (input, cache) => leave(input.params.id, cache),
    toast: (res: { entity: TriageItem }) => ({ title: `Dismissed: ${res.entity.title}`, key: `triage:${res.entity.id}` }),
    onError: fail('dismiss'),
  });
  // LD-1: the Looks done group. Confirm closes the item (Undo on the toast); Not done returns it to its live state.
  const settle = useOptimisticMutation({
    route: 'itemAction',
    topics: [...TOPICS, 'home'],
    optimistic: (input, cache) => leave(input.params.id, cache),
    toast: (res: { entity: { id: string; title: string; state: string } }) => ({ title: res.entity.state === 'done' ? `Confirmed done: ${res.entity.title}` : `Back to open: ${res.entity.title}`, key: `triage:${res.entity.id}` }),
    onError: fail('update'),
  });
  // DEEP-1: Still needed? Close resolves it as not needed (Undo on the toast); Keep is accept.
  const close = useOptimisticMutation({
    route: 'itemAction',
    topics: [...TOPICS, 'home'],
    optimistic: (input, cache) => leave(input.params.id, cache),
    toast: (res: { entity: { id: string; title: string } }) => ({ title: `Closed, not needed: ${res.entity.title}`, key: `triage:${res.entity.id}` }),
    onError: fail('close'),
  });
  // SETTLE-1: Closed for you. Undo reverses the close's own change set (back to how it was); Reopen, when there is no
  // change set to undo, makes it open work again. Either way the engine never closes it for you again.
  const undoTitles = useRef(new Map<string, { itemId: string; title: string }>());
  const undoClose = useOptimisticMutation({
    route: 'undoAudit',
    topics: [...TOPICS, 'home'],
    writeBack: false,
    entityId: () => undefined,
    optimistic: (input, cache) => {
      const it = undoTitles.current.get(input.params.id);
      if (it) leave(it.itemId, cache);
    },
    toast: (_res, input) => ({ title: `Reopened: ${undoTitles.current.get(input.params.id)?.title ?? 'the item'}`, key: `triage:undo:${input.params.id}` }),
    onError: (err, input) =>
      toast({
        key: `triage:undo:${input.params.id}:err`,
        title: "Couldn't undo that close",
        body: `${err.code === 'conflict' ? 'It changed since it closed; open it to reopen it.' : err.message}. It is back in the list.`,
        tone: 'error',
        durationMs: null,
      }),
  });
  const reopen = useOptimisticMutation({
    route: 'itemAction',
    topics: [...TOPICS, 'home'],
    optimistic: (input, cache) => leave(input.params.id, cache),
    toast: (res: { entity: { id: string; title: string } }) => ({ title: `Reopened: ${res.entity.title}`, key: `triage:${res.entity.id}` }),
    onError: fail('reopen'),
  });
  const merge = useOptimisticMutation({
    route: 'mergeTriage',
    topics: TOPICS,
    optimistic: (input, cache) => leave(input.params.id, cache),
    toast: (res: { entity: TriageItem }) => ({ title: `Merged into ${mergeTarget.current || 'an existing item'}`, body: res.entity.title, key: `triage:${res.entity.id}` }),
    onError: fail('merge'),
  });

  return {
    accept: (id: string, opts: { choiceId?: string; choiceLabel?: string; edits?: { title?: string; purpose?: string | null } } = {}) => {
      mapChoice.current = opts.choiceLabel ?? '';
      accept.mutate({ params: { id }, body: { ...(opts.choiceId ? { choiceId: opts.choiceId } : {}), ...(opts.edits ? { edits: opts.edits } : {}) } });
    },
    dismiss: (id: string, reason: string) => dismiss.mutate({ params: { id }, body: { reason } }),
    confirmDone: (it: TriageItem) => settle.mutate({ params: { id: it.id, verb: 'confirm-done' }, body: { ifVersion: it.workItem!.version } }),
    notDone: (it: TriageItem) => settle.mutate({ params: { id: it.id, verb: 'not-done' }, body: { ifVersion: it.workItem!.version } }),
    closeNotNeeded: (it: TriageItem) => close.mutate({ params: { id: it.id, verb: 'resolve' }, body: { ifVersion: it.workItem!.version, resolution: 'not_needed' } }),
    /** SETTLE-1: undo a close for you (its audit id), else reopen the item. */
    undoClose: (it: TriageItem) => {
      if (it.undoAuditId) {
        undoTitles.current.set(it.undoAuditId, { itemId: it.id, title: it.title });
        undoClose.mutate({ params: { id: it.undoAuditId }, body: {} });
      } else reopen.mutate({ params: { id: it.id, verb: 'reopen' }, body: { ifVersion: it.workItem!.version, note: 'Reopened from Closed for you' } });
    },
    reopen: (it: TriageItem) => reopen.mutate({ params: { id: it.id, verb: 'reopen' }, body: { ifVersion: it.workItem!.version, note: 'Reopened from Closed for you' } }),
    merge: (id: string, intoId: string, intoTitle: string) => {
      mergeTarget.current = intoTitle;
      merge.mutate({ params: { id }, body: { intoId } });
    },
  };
}
