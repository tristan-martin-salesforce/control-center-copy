'use client';
/**
 * The Needs-you queue's data (GET /needs) and its verbs on the client.
 *
 *  - useNeeds(): the one query every surface reads (sidebar count, Home, Activity, review mode). It follows the topics
 *    whose changes can move a row (live updates, docs/UX.md "Live updates"), plus the 5-minute safety net.
 *  - useNeedActions(): a verb with a call goes through POST /needs/:id/decide (the route the page already calls),
 *    optimistic: the row leaves the cached queue at once, the toast offers Undo (the route's audit id), and a failure
 *    puts it back with an error toast. A verb with an href navigates. Nothing here sends anything.
 */
import { useCallback, useRef } from 'react';
import type { LiveTopic, NeedRow, NeedsPayload, NeedVerb } from '@/contract';
import { queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { SAFETY_NET_MS, useLiveFollow } from '@/client/live';
import { useOptimisticMutation } from '@/client/optimistic';
import { toast } from '@/client/toast';
import { navigate } from '@/components/shell/router';
import { withoutNeed } from './model';

/** Topics whose changes can add, remove or change a queue row. */
export const NEEDS_LIVE_TOPICS: readonly LiveTopic[] = ['home', 'today', 'triage', 'outbox', 'draft', 'items', 'item', 'time', 'deals', 'health', 'settings', 'onboarding'];

/** Every cached copy of the queue: GET /needs is topic `home`. */
const TOPICS = ['home', 'today', 'triage', 'outbox', 'items', 'item', 'time', 'deals', 'health'];

export function useNeeds(opts: { enabled?: boolean } = {}) {
  const q = useApi('listNeeds', undefined, { staleTime: 15_000, refetchInterval: SAFETY_NET_MS, enabled: opts.enabled ?? true });
  useLiveFollow(queryKey('listNeeds'), NEEDS_LIVE_TOPICS, opts.enabled ?? true);
  return q;
}

const short = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function useNeedActions() {
  const labels = useRef(new Map<string, string>());
  const decide = useOptimisticMutation({
    route: 'decideNeedRow',
    topics: TOPICS,
    writeBack: false,
    entityId: () => undefined,
    optimistic: (input, cache) => {
      cache.client.setQueriesData<NeedsPayload>({ queryKey: queryKey('listNeeds').slice(0, 2) }, (old) => (old && Array.isArray(old.rows) ? withoutNeed(old, input.params.id) : old));
    },
    toast: (res) => ({ key: `needs:${res.entity.row.id}`, title: labels.current.get(res.entity.row.id) ?? `Done: ${short(res.entity.row.title)}` }),
    onError: (err, input) =>
      toast({ key: `needs:${input.params.id}:err`, title: `Couldn't ${labels.current.get(input.params.id)?.split(':')[0]?.toLowerCase() ?? 'do that'}`, body: `${err.message}. It is back in the list.`, tone: 'error', durationMs: null }),
  });

  /** Run a verb of a row: decide it (a call) or go to its page (an href). */
  const run = useCallback(
    (row: NeedRow, v: NeedVerb, extra: { choiceId?: string; choiceLabel?: string } = {}) => {
      if (v.call) {
        labels.current.set(row.id, `${v.id === 'answer' && extra.choiceLabel ? `Answered ${extra.choiceLabel}` : v.label}: ${short(row.title)}`);
        decide.mutate({ params: { id: row.id }, body: { verb: v.id, ...(extra.choiceId ? { choiceId: extra.choiceId } : {}) } });
        return;
      }
      if (v.href) navigate(v.href);
    },
    [decide],
  );
  return { run, decideAsync: decide.mutateAsync, pending: decide.isPending };
}
