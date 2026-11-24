'use client';
/**
 * Every Home action. Quiet verbs reuse the existing routes and flows; nothing here sends anything:
 * - done / snooze / not-now (a card's reason) / confirm-done / not-done (LD-1, the Looks done group): POST /items/:id/actions/:verb, optimistic (the row leaves Home at once), rollback with an
 *   inline "Couldn't … · Retry", Undo toast through the audit id;
 * - Open in Claude: POST /agents/launch, then Review prompt (the whole prompt, "runs with your permissions"; SEC-10,
 *   components/agents/LaunchReview) and only its Open in Claude click opens the claude:// link; a waiting session's
 *   continue link carries no prompt and opens on the click;
 * - re-auth: POST /connectors/:id/reauth (the health flow), result in a toast; the Health page has the rest;
 * - review / send / draft / nudge / confirm / map / plan / open: navigate to the verb's href (Outbox review
 *   link, the item's composer, the nudge draft, Time, Deals…).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { HomeCard, HomeDayRef, HomeItemRef, HomePayload, HomeVerb, NotNowReason } from '@/contract';
import { api, ApiError } from '@/client/api';
import { useOptimisticMutation, type OptimisticCache } from '@/client/optimistic';
import { toast, toastStore } from '@/client/toast';
import { useLaunchReview } from '@/components/agents/LaunchReview';
import { leavesHome, notNowToast, stripItem } from './model';
import { navigate } from '@/components/shell/router';

const TOPICS = ['home', 'item', 'items', 'today'];

/**
 * Opening things outside the app, only from an explicit click or key press. Test seam: Playwright defines
 * `window.__ccOpenExternal` so smoke tests never launch a real app.
 */
export function openExternal(url: string): void {
  if (typeof window === 'undefined' || !url) return;
  const hook = (window as { __ccOpenExternal?: (u: string) => void }).__ccOpenExternal;
  if (hook) return hook(url);
  if (/^(claude|slack|mailto):/i.test(url)) window.location.assign(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** `?fail=1` on the page forces Home mutations to fail (rollback testing). */
export function failFromUrl(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('fail') === '1';
}

export interface HomeActionError {
  verb: string;
  message: string;
  retry: () => void;
}

const VERB_TEXT: Record<string, string> = { snooze: 'snooze', 'confirm-done': 'confirm', 'not-done': 'mark not done', 'not-now': 'set it aside', reopen: 'reopen' };
const short = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const errText = (err: unknown) => (err instanceof ApiError ? (err.code === 'upstream_unavailable' ? 'the server is unavailable' : err.message) : String(err));

/** Tomorrow at the start of the working day, as an ISO instant (quick snooze). */
function tomorrowMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

function dropFromHome(cache: OptimisticCache, itemId: string) {
  cache.client.setQueriesData<HomePayload>({ queryKey: ['home'] }, (old) => (old ? stripItem(old, itemId) : old));
}

/**
 * `moveTo`: where "Move to …" (snooze) sends an item, the working-day start after the day shown (GET /home's
 * `moveTo`); without it, tomorrow 08:00.
 */
export function useHomeActions(moveTo: HomeDayRef | null = null) {
  const moveRef = useRef(moveTo);
  moveRef.current = moveTo;
  const [errors, setErrors] = useState<Record<string, HomeActionError>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const setError = useCallback((id: string, e: HomeActionError | null) => {
    setErrors((prev) => {
      if (!e) {
        if (!(id in prev)) return prev;
        const { [id]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: e };
    });
  }, []);
  const labels = useRef(new Map<string, string>());

  // ---- done / snooze (optimistic) ----------------------------------------------------------------
  const item = useOptimisticMutation({
    route: 'itemAction',
    topics: TOPICS,
    fail: failFromUrl,
    writeBack: false,
    optimistic: (input, cache) => {
      if (leavesHome(input.params.verb, input.body?.reason)) dropFromHome(cache, input.params.id);
    },
    toast: (_res, input) => ({ key: `home:${input.params.id}`, title: labels.current.get(input.params.id) ?? 'Updated' }),
    onSuccess: (_res, input) => setError(input.params.id, null),
    onError: (err, input) =>
      setError(input.params.id, {
        verb: VERB_TEXT[input.params.verb] ?? 'mark done',
        message: errText(err),
        retry: () => item.mutate(input),
      }),
  });
  const done = useCallback(
    (ref: HomeItemRef, title: string) => {
      labels.current.set(ref.id, `Done: ${short(title)}`);
      setError(ref.id, null);
      item.mutate({ params: { id: ref.id, verb: 'done' }, body: { ifVersion: item.versionOf(ref.id) ?? ref.version } });
    },
    [item, setError],
  );
  const snooze = useCallback(
    (ref: HomeItemRef, title: string) => {
      const to = moveRef.current;
      labels.current.set(ref.id, `${to ? `Moved to ${to.short}` : 'Snoozed until tomorrow'}: ${short(title)}`);
      setError(ref.id, null);
      item.mutate({ params: { id: ref.id, verb: 'snooze' }, body: { ifVersion: item.versionOf(ref.id) ?? ref.version, until: to?.startsAt ?? tomorrowMorning() } });
    },
    [item, setError],
  );

  /** LD-1: a likely-done item, confirmed (it closes) or not done (it goes back to its live state). */
  const confirmDone = useCallback(
    (ref: HomeItemRef, title: string) => {
      labels.current.set(ref.id, `Confirmed done: ${short(title)}`);
      setError(ref.id, null);
      item.mutate({ params: { id: ref.id, verb: 'confirm-done' }, body: { ifVersion: item.versionOf(ref.id) ?? ref.version } });
    },
    [item, setError],
  );
  const notDone = useCallback(
    (ref: HomeItemRef, title: string) => {
      labels.current.set(ref.id, `Back to open: ${short(title)}`);
      setError(ref.id, null);
      item.mutate({ params: { id: ref.id, verb: 'not-done' }, body: { ifVersion: item.versionOf(ref.id) ?? ref.version } });
    },
    [item, setError],
  );

  /** Undo a close for you from Home (a card closed while Home was open): the same reopen Triage ▸ Closed for you runs. */
  const reopen = useCallback(
    (ref: HomeItemRef, title: string) => {
      labels.current.set(ref.id, `Reopened: ${short(title)}`);
      setError(ref.id, null);
      item.mutate({ params: { id: ref.id, verb: 'reopen' }, body: { ifVersion: item.versionOf(ref.id) ?? ref.version, note: 'Reopened from Home (closed for you)' } });
    },
    [item, setError],
  );

  /**
   * A card's "Not now" reason: the same `not-now` action Details runs (done elsewhere closes it, not mine dismisses
   * it, later snoozes it to the day "Move to …" uses, wrong account unlinks it), optimistic with an Undo toast.
   */
  const notNow = useCallback(
    (ref: HomeItemRef, title: string, reason: NotNowReason) => {
      const to = moveRef.current;
      labels.current.set(ref.id, notNowToast(reason, title, to?.short));
      setError(ref.id, null);
      item.mutate({ params: { id: ref.id, verb: 'not-now' }, body: { ifVersion: item.versionOf(ref.id) ?? ref.version, reason, ...(reason === 'later' && to ? { until: to.startsAt } : {}) } });
    },
    [item, setError],
  );

  // ---- Claude Code ---------------------------------------------------------------------------------
  // SEC-10: a prepared session (claude://code/new, with its prompt) opens only from Review prompt's Open in Claude
  const openClaude = useCallback((url: string) => {
    toast({ key: `claude:${url}`, title: 'Opening Claude Code…', durationMs: 4000 });
    openExternal(url);
  }, []);
  const { review: reviewLaunch, dialog: launchDialog } = useLaunchReview(openClaude);
  const launch = useOptimisticMutation({
    route: 'launchAgent',
    topics: ['home', 'agents', 'item'],
    fail: failFromUrl,
    writeBack: false,
    onSuccess: (res, input) => {
      if (input.body?.workItemId) setError(input.body.workItemId, null);
      // the review is on screen now: "Preparing the Claude Code session…" would sit over it, saying the wrong thing
      if (input.body?.workItemId) toastStore.dismissKey(`claude:${input.body.workItemId}`);
      reviewLaunch(res.url, res.run.title);
    },
    onError: (err, input) => {
      const id = input.body?.workItemId ?? 'home:launch';
      setError(id, { verb: 'open Claude Code', message: errText(err), retry: () => launch.mutate(input) });
    },
  });
  const openInClaude = useCallback(
    (card: HomeCard | undefined, itemId: string, title: string) => {
      const link = card?.now?.run?.kind === 'claude_session' ? card.now.run.deepLink : null;
      if (link && /^claude:\/\/code\/(continue|needs-input)/.test(link) && card?.now?.run?.state === 'waiting_on_you') openClaude(link);
      else {
        toast({ key: `claude:${itemId}`, title: 'Preparing the Claude Code session…', body: short(title, 80), durationMs: 4000 });
        launch.mutate({ body: { workItemId: itemId, title } });
      }
    },
    [launch, openClaude],
  );

  // ---- connectors (the health re-auth flow) -----------------------------------------------------------
  const reauth = useCallback(
    async (connectorId: string, label: string) => {
      setError(`connector:${connectorId}`, null);
      setBusy((b) => ({ ...b, [connectorId]: true }));
      try {
        const r = await api('reauthConnector', { params: { id: connectorId }, body: {} }, { fail: failFromUrl() });
        const a = r.action;
        toast({
          key: `reauth:${connectorId}`,
          title: r.started ? `${label}: started` : label,
          body: a.command ? `Run in Terminal: ${a.command}` : (a.instructions ?? 'Follow the steps on the Health page.'),
          action: { label: 'Open Health', href: `/health?connector=${connectorId}` },
          durationMs: 9000,
        });
      } catch (err) {
        setError(`connector:${connectorId}`, { verb: label.toLowerCase(), message: errText(err), retry: () => void reauth(connectorId, label) });
      } finally {
        setBusy((b) => ({ ...b, [connectorId]: false }));
      }
    },
    [setError],
  );

  /** Run a row's or card's verb (an explicit click, ⌘↵, or ⌘K). */
  const run = useCallback(
    (v: HomeVerb, ctx: { title: string; card?: HomeCard; fallbackHref?: string }) => {
      switch (v.action) {
        case 'open_in_claude':
          if (v.targetId) openInClaude(ctx.card, v.targetId, ctx.title);
          return;
        case 'reauth':
          if (v.targetId) void reauth(v.targetId, v.label === 'Re-auth' ? `Re-auth ${ctx.title.replace(/^Re-auth\s+/i, '')}` : v.label);
          return;
        default: {
          const href = v.href ?? ctx.fallbackHref;
          if (href) navigate(href);
        }
      }
    },
    [openInClaude, reauth],
  );

  const clearError = useCallback((id: string) => setError(id, null), [setError]);

  return useMemo(
    () => ({ done, snooze, confirmDone, notDone, notNow, reopen, run, errors, busy, clearError, launching: launch.isPending, reviewLaunch, launchDialog }),
    [done, snooze, confirmDone, notDone, notNow, reopen, run, errors, busy, clearError, launch.isPending, reviewLaunch, launchDialog],
  );
}

export type HomeActions = ReturnType<typeof useHomeActions>;
