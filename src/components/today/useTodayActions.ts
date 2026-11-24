'use client';
/**
 * Every Today mutation (UI-SPEC §8–10): optimistic cache patch → server → write-back, rollback with an
 * inline error on failure ("Couldn't … · Retry"), silent 409 rebase, and an Undo toast for reversible
 * changes. Nothing here sends anything outside the machine: Send / Push as draft only opens the composer.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { NbaCard as NbaCardVm, NotNowReason, Proposal, RailEntry, ReauthResult, TodayPayload, WorkItem, WorkState } from '@/contract';
import { api, ApiError, queryKey } from '@/client/api';
import { useOptimisticMutation, type OptimisticCache } from '@/client/optimistic';
import { toast, toastStore } from '@/client/toast';
import type { ResolveValue } from '@/components/domain';
import { resolutionLabel } from '@/components/domain';
import { needsReview, useLaunchReview } from '@/components/agents/LaunchReview';
import { failFromUrl, openExternal } from './external';

const TODAY_KEY = queryKey('getToday');
const TOPICS = ['item', 'today', 'items'];

export interface ActionError {
  message: string;
  verb: string;
  retry: () => void;
}

export interface TodayActionsOptions {
  /** The user is about to remove an item from NOW / more today (done, snooze…): free its slot. */
  onRemove?: (itemId: string) => void;
  /** A re-rank or undo landed: take the server order. */
  onAdopt?: () => void;
  tz?: string;
}

function patchToday(cache: OptimisticCache, fn: (t: TodayPayload) => TodayPayload) {
  cache.setQuery<TodayPayload>(TODAY_KEY, (old) => (old ? fn(old) : old));
}

const VERB_LABEL: Record<string, string> = {
  done: 'mark done',
  resolve: 'resolve',
  snooze: 'snooze',
  'not-now': 'set aside',
  'confirm-done': 'confirm done',
  accept: 'accept',
  dismiss: 'dismiss',
  reopen: 'reopen',
};

const NOT_NOW_LABEL: Record<NotNowReason, string> = {
  done_elsewhere: 'done elsewhere',
  not_mine: 'not mine',
  later: 'later',
  wrong_account: 'wrong account',
  other: 'other',
};

function nextStateFor(verb: string, reason?: NotNowReason): WorkState | null {
  switch (verb) {
    case 'done':
    case 'resolve':
    case 'confirm-done':
      return 'done';
    case 'snooze':
      return 'snoozed';
    case 'accept':
      return 'open';
    case 'dismiss':
      return 'dismissed';
    case 'reopen':
      return 'reopened';
    case 'not-now':
      return reason === 'done_elsewhere' ? 'done' : reason === 'later' ? 'snoozed' : reason === 'wrong_account' ? null : 'dismissed';
    default:
      return null;
  }
}

function shortTitle(t: string, n = 60) {
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function useTodayActions(opts: TodayActionsOptions = {}) {
  const [errors, setErrors] = useState<Record<string, ActionError>>({});
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const setError = useCallback((id: string, e: ActionError | null) => {
    setErrors((prev) => {
      if (!e) {
        if (!(id in prev)) return prev;
        const { [id]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: e };
    });
  }, []);
  const errText = (err: ApiError) => (err.code === 'upstream_unavailable' ? 'the server is unavailable' : err.message);

  // ---- work-item verbs ------------------------------------------------------
  const pendingLabel = useRef(new Map<string, string>());
  const item = useOptimisticMutation({
    route: 'itemAction',
    topics: TOPICS,
    fail: failFromUrl,
    optimistic: (input, cache) => {
      const b = input.body ?? { ifVersion: 0 };
      const next = nextStateFor(input.params.verb, b.reason);
      cache.patchEntity(input.params.id, (e) => ({
        ...e,
        ...(next ? { state: next } : {}),
        ...(next === 'snoozed' ? { snoozedUntil: b.until ?? null } : {}),
        ...(input.params.verb === 'not-now' && b.reason === 'wrong_account' ? { accountId: null, oppId: null } : {}),
        ...(next === 'done' ? { resolution: b.resolution ?? 'done_by_me', reopened: null, loopedBackIn: null } : {}),
      }));
    },
    toast: (res, input) => ({ key: `item:${input.params.id}`, title: pendingLabel.current.get(input.params.id) ?? `Updated: ${shortTitle(res.entity.title)}` }),
    onSuccess: (_res, input) => setError(input.params.id, null),
    onError: (err, input) => {
      setError(input.params.id, { verb: VERB_LABEL[input.params.verb] ?? input.params.verb, message: errText(err), retry: () => item.mutate(input) });
    },
  });

  const run = useCallback(
    (w: WorkItem, verb: 'done' | 'resolve' | 'snooze' | 'not-now' | 'confirm-done' | 'accept' | 'dismiss' | 'reopen', body: Record<string, unknown>, label: string) => {
      const next = nextStateFor(verb, body.reason as NotNowReason | undefined);
      if (next && next !== 'open' && next !== 'reopened') optsRef.current.onRemove?.(w.id);
      pendingLabel.current.set(w.id, label);
      setError(w.id, null);
      item.mutate({ params: { id: w.id, verb }, body: { ifVersion: item.versionOf(w.id) ?? w.version, ...body } });
    },
    [item, setError],
  );

  const done = useCallback((w: WorkItem) => run(w, 'done', {}, `Done: ${shortTitle(w.title)}`), [run]);
  const confirmDone = useCallback((w: WorkItem) => run(w, 'confirm-done', {}, `Confirmed done: ${shortTitle(w.title)}`), [run]);
  const accept = useCallback((w: WorkItem) => run(w, 'accept', {}, `Accepted: ${shortTitle(w.title)}`), [run]);
  const resolve = useCallback(
    (w: WorkItem, v: ResolveValue) => run(w, 'resolve', { resolution: v.resolution, detail: v.detail, involvement: v.involvement }, `${resolutionLabel(v.resolution, v.detail?.personName)}: ${shortTitle(w.title)}`),
    [run],
  );
  const letGo = useCallback((w: WorkItem) => run(w, 'resolve', { resolution: 'not_needed', detail: { note: 'Let go from the Promises shelf' } }, `Let go: ${shortTitle(w.title)}`), [run]);
  const snooze = useCallback((w: WorkItem, until: string, label: string) => run(w, 'snooze', { until }, `Snoozed until ${label}: ${shortTitle(w.title)}`), [run]);
  const notNow = useCallback((w: WorkItem, reason: NotNowReason) => run(w, 'not-now', { reason }, `Not now (${NOT_NOW_LABEL[reason]}): ${shortTitle(w.title)}`), [run]);

  // ---- proposals ------------------------------------------------------------
  const dropProposal = (cache: OptimisticCache, id: string, clearUpdate: boolean) =>
    patchToday(cache, (t) => ({
      ...t,
      nowStack: {
        ...t.nowStack,
        cards: t.nowStack.cards.map((c) =>
          c.proposals.some((p) => p.id === id)
            ? { ...c, proposals: c.proposals.filter((p) => p.id !== id), nba: clearUpdate && c.nba?.update?.proposalId === id ? { ...c.nba, update: null } : c.nba }
            : c,
        ),
      },
    }));
  const apply = useOptimisticMutation({
    route: 'applyProposal',
    topics: TOPICS.concat('nba', 'draft'),
    fail: failFromUrl,
    writeBack: false,
    optimistic: (input, cache) => dropProposal(cache, input.params.id, false),
    toast: (res) => ({ key: `proposal:${res.entity.id}`, title: `Applied: ${shortTitle(res.entity.reason)}` }),
    onError: (err, input) => setError(`proposal:${input.params.id}`, { verb: 'apply the update', message: errText(err), retry: () => apply.mutate(input) }),
  });
  const reject = useOptimisticMutation({
    route: 'rejectProposal',
    topics: TOPICS.concat('nba', 'draft'),
    fail: failFromUrl,
    writeBack: false,
    optimistic: (input, cache) => dropProposal(cache, input.params.id, true),
    toast: () => ({ title: 'Kept yours' }),
    onError: (err, input) => setError(`proposal:${input.params.id}`, { verb: 'keep yours', message: errText(err), retry: () => reject.mutate(input) }),
  });
  const applyProposal = useCallback((p: Proposal) => apply.mutate({ params: { id: p.id }, body: {} }), [apply]);
  const keepMine = useCallback((p: Proposal) => reject.mutate({ params: { id: p.id }, body: {} }), [reject]);
  /** Accept all (agent's plan): resolves to the audit id for a later per-row Undo, or null when it failed. */
  const applyProposalAsync = useCallback(async (p: Proposal): Promise<string | null> => {
    try {
      return (await apply.mutateAsync({ params: { id: p.id }, body: {} })).auditId ?? null;
    } catch {
      return null;
    }
  }, [apply]);

  // ---- universal undo (Closed for you, reopen labels) -----------------------
  const undoLabel = useRef(new Map<string, string>());
  const undoItem = useRef(new Map<string, string>());
  const undo = useOptimisticMutation({
    route: 'undoAudit',
    topics: TOPICS,
    fail: failFromUrl,
    writeBack: false,
    optimistic: (input, cache) => {
      const itemId = undoItem.current.get(input.params.id);
      if (itemId) cache.patchEntity(itemId, (e) => ({ ...e, state: 'done', reopened: null, loopedBackIn: null }));
    },
    toast: (_res, input) => ({ title: undoLabel.current.get(input.params.id) ?? 'Undone' }),
    onSuccess: () => optsRef.current.onAdopt?.(),
    onError: (err, input) => setError(`audit:${input.params.id}`, { verb: 'undo', message: err.code === 'conflict' ? 'it changed since; open its history to roll back' : errText(err), retry: () => undo.mutate(input) }),
  });
  /** Generic Undo for a digest line or receipt (POST /audit/:id/undo). */
  const undoAudit = useCallback(
    (auditId: string, label: string) => {
      undoLabel.current.set(auditId, `Undone: ${shortTitle(label)}`);
      setError(`audit:${auditId}`, null);
      undo.mutate({ params: { id: auditId }, body: {} });
    },
    [undo, setError],
  );

  const undoReopen = useCallback(
    async (w: WorkItem) => {
      setError(w.id, null);
      try {
        const h = await api('getItemHistory', { params: { id: w.id } }, { fail: failFromUrl() });
        const entry = h.entries.find((e) => (e.action === 'item.reopen' || e.action === 'item.loop_back') && e.undoable && !e.undoneAt);
        if (!entry) throw new ApiError('not_found', 'no reopen to undo', 404, false);
        optsRef.current.onRemove?.(w.id);
        undoItem.current.set(entry.id, w.id);
        undoLabel.current.set(entry.id, `Undid the reopen: ${shortTitle(w.title)}`);
        undo.mutate({ params: { id: entry.id }, body: {} });
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError('internal', String(err), 0, true);
        setError(w.id, { verb: 'undo the reopen', message: errText(e), retry: () => void undoReopen(w) });
      }
    },
    [undo, setError],
  );

  // ---- re-rank --------------------------------------------------------------
  const rerankM = useOptimisticMutation({
    route: 'rerankToday',
    topics: ['today', 'items'],
    fail: failFromUrl,
    writeBack: false,
    toast: (res) => ({ key: 'today:rerank', title: res.entity.changed ? `Re-ranked · ${res.entity.changed} moved` : 'Re-ranked · no change' }),
    onSuccess: () => {
      setError('today:rerank', null);
      optsRef.current.onAdopt?.();
    },
    onError: (err) => setError('today:rerank', { verb: 're-rank', message: errText(err), retry: () => rerankM.mutate({ body: {} }) }),
  });
  const rerank = useCallback(() => rerankM.mutate({ body: {} }), [rerankM]);
  const rerankAsync = useCallback(async (): Promise<string | null> => {
    try {
      return (await rerankM.mutateAsync({ body: {} })).auditId ?? null;
    } catch {
      return null;
    }
  }, [rerankM]);

  // ---- NBA rewrite (Shorter) ------------------------------------------------
  const regen = useOptimisticMutation({
    route: 'regenerateNba',
    topics: TOPICS.concat('nba', 'draft'),
    fail: failFromUrl,
    writeBack: false,
    toast: () => ({ title: 'Made the draft shorter' }),
    onError: (err, input) => setError(`nba:${input.params.id}`, { verb: 'rewrite the draft', message: errText(err), retry: () => regen.mutate(input) }),
  });
  const shorter = useCallback((nba: NbaCardVm) => regen.mutate({ params: { id: nba.id }, body: { ifVersion: nba.version, instruction: 'shorter' } }), [regen]);

  // ---- Pull forward: start-by today (the engine treats it as pinned to today) -----------------------
  const startByLabel = useRef(new Map<string, string>());
  const patchStart = useOptimisticMutation({
    route: 'patchItem',
    topics: TOPICS,
    fail: failFromUrl,
    optimistic: (input, cache) => {
      const patch = input.body?.patch;
      // A start-by you set is user-locked (that's what pins it to today for the engine): mirror the lock.
      if (patch && 'startBy' in patch)
        cache.patchEntity(input.params.id, (e) => {
          const locked = Array.isArray(e.userLockedFields) ? (e.userLockedFields as string[]) : [];
          return { ...e, startBy: patch.startBy ?? null, userLockedFields: locked.includes('startBy') ? locked : [...locked, 'startBy'] };
        });
    },
    toast: (res, input) => ({ key: `start:${input.params.id}`, title: startByLabel.current.get(input.params.id) ?? `Start-by changed: ${shortTitle(res.entity.title)}`, body: 'It counts toward today from the next re-rank. Your calendar is unchanged.' }),
    onSuccess: (_res, input) => setError(input.params.id, null),
    onError: (err, input) => setError(input.params.id, { verb: 'pull it into today', message: errText(err), retry: () => patchStart.mutate(input) }),
  });
  /** Optimistic PATCH of `startBy` (Undo through the audit). Resolves to the audit id, or null on failure. */
  const setStartBy = useCallback(
    async (w: WorkItem, startBy: string | null, label: string): Promise<string | null> => {
      startByLabel.current.set(w.id, label);
      setError(w.id, null);
      try {
        const res = await patchStart.mutateAsync({ params: { id: w.id }, body: { ifVersion: Math.max(patchStart.versionOf(w.id) ?? 0, w.version), patch: { startBy } } });
        return res.auditId ?? null;
      } catch {
        return null;
      }
    },
    [patchStart, setError],
  );

  // ---- Claude Code ------------------------------------------------------------
  // SEC-10: a prepared session (claude://code/new, with its prompt) opens only from Review prompt's Open in Claude
  const { review: reviewLaunch, dialog: launchDialog } = useLaunchReview(openExternal);
  const launch = useOptimisticMutation({
    route: 'launchAgent',
    topics: TOPICS.concat('agents'),
    fail: failFromUrl,
    writeBack: false,
    optimistic: (input, cache) => {
      const id = input.body?.workItemId;
      if (id) cache.patchEntity(id, (e) => (e.state === 'open' || e.state === 'reopened' ? { ...e, state: 'in_progress' } : e));
    },
    onSuccess: (res, input) => {
      if (input.body?.workItemId) setError(input.body.workItemId, null);
      // the review is on screen now: "Preparing the Claude Code session…" would sit over it, saying the wrong thing
      if (input.body?.workItemId) toastStore.dismissKey(`claude:${input.body.workItemId}`);
      reviewLaunch(res.url, res.run.title);
    },
    onError: (err, input) => {
      const id = input.body?.workItemId ?? 'today:launch';
      setError(id, { verb: 'start in Claude', message: errText(err), retry: () => launch.mutate(input) });
    },
  });
  /** Explicit click only: the server builds the context-packed claude://code/new link and records the run. */
  const launchClaude = useCallback(
    (w: WorkItem, title?: string) => {
      toast({ key: `claude:${w.id}`, title: 'Preparing the Claude Code session…', body: shortTitle(title ?? w.title, 80), durationMs: 4000 });
      launch.mutate({ body: { workItemId: w.id, title: title ?? w.title } });
    },
    [launch],
  );
  /** Explicit click only: an existing session's continue / needs-input link (a claude://code/new link is reviewed first). */
  const openClaude = useCallback(
    (url: string, label?: string) => {
      if (needsReview(url)) return reviewLaunch(url, label);
      toast({ key: `claude:${url}`, title: 'Opening Claude Code…', body: label ? shortTitle(label, 80) : undefined, durationMs: 4000 });
      openExternal(url);
    },
    [reviewLaunch],
  );

  // ---- tools ----------------------------------------------------------------
  const toolNames = useRef(new Map<string, string>());
  const tool = useOptimisticMutation({
    route: 'startToolRun',
    topics: TOPICS.concat('tools', 'agents'),
    fail: failFromUrl,
    writeBack: false,
    optimistic: (input, cache) => {
      const id = input.body?.workItemId;
      if (id) cache.patchEntity(id, (e) => (e.state === 'open' ? { ...e, state: 'in_progress' } : e));
    },
    toast: (res) => ({ key: `tool:${res.entity.id}`, title: `Running ${toolNames.current.get(res.entity.adapterId) ?? res.entity.adapterId}…`, body: 'Progress shows under Agents; the link lands on the card.' }),
  });
  const runTool = useCallback(
    async (adapterId: string, inputs: Record<string, unknown>, w: WorkItem | null, nbaId?: string | null, name?: string): Promise<string | null> => {
      if (name) toolNames.current.set(adapterId, name);
      try {
        await tool.mutateAsync({ params: { id: adapterId }, body: { inputs, workItemId: w?.id, nbaId: nbaId ?? undefined } });
        if (w) setError(w.id, null);
        return null;
      } catch (err) {
        return err instanceof ApiError ? errText(err) : String(err);
      }
    },
    [tool, setError],
  );

  // ---- agents: inline answers -------------------------------------------------
  const answerM = useOptimisticMutation({
    route: 'answerAgent',
    topics: TOPICS.concat('agents'),
    fail: failFromUrl,
    writeBack: false,
    optimistic: (input, cache) =>
      patchToday(cache, (t) => ({
        ...t,
        rail: t.rail.map((l) => (l.lane === 'waiting_on_you' ? { ...l, count: Math.max(0, l.count - 1), entries: l.entries.filter((e) => e.ref.id !== input.params.id) } : l)),
        nowStack: {
          ...t.nowStack,
          cards: t.nowStack.cards.map((c) =>
            c.run?.id === input.params.id
              ? { ...c, run: { ...c.run, state: 'running', waiting: null, lastEvent: `You answered: ${input.body?.answer ?? ''}` }, item: c.item.state === 'waiting_on_me' ? { ...c.item, state: 'in_progress', waiting: null } : c.item }
              : c,
          ),
        },
      })),
    toast: (_r, input) => ({ key: `answer:${input.params.id}`, title: `Answered: ${shortTitle(input.body?.answer ?? '', 50)}` }),
    onError: (err, input) => setError(`run:${input.params.id}`, { verb: 'send the answer', message: errText(err), retry: () => answerM.mutate(input) }),
  });
  const answer = useCallback((runId: string, text: string) => answerM.mutate({ params: { id: runId }, body: { answer: text } }), [answerM]);

  // Closed-for-you undo removes its rail entry optimistically through a dedicated transform.
  const undoCloseM = useOptimisticMutation({
    route: 'undoAudit',
    topics: TOPICS,
    fail: failFromUrl,
    writeBack: false,
    optimistic: (input, cache) =>
      patchToday(cache, (t) => ({
        ...t,
        rail: t.rail.map((l) => (l.lane === 'closed_for_you' ? { ...l, count: Math.max(0, l.count - 1), entries: l.entries.filter((e) => e.action?.auditId !== input.params.id) } : l)),
      })),
    toast: (_res, input) => ({ title: undoLabel.current.get(input.params.id) ?? 'Undone' }),
    onError: (err, input) => setError(`audit:${input.params.id}`, { verb: 'undo', message: err.code === 'conflict' ? 'it changed since; open its history to roll back' : errText(err), retry: () => undoCloseM.mutate(input) }),
  });
  const undoClosed = useCallback(
    (entry: RailEntry, auditId: string) => {
      undoLabel.current.set(auditId, `Reopened: ${shortTitle(entry.title)}`);
      setError(`audit:${auditId}`, null);
      undoCloseM.mutate({ params: { id: auditId }, body: {} });
    },
    [undoCloseM, setError],
  );

  // ---- connectors -----------------------------------------------------------
  const reauth = useCallback(async (connectorId: string): Promise<{ result: ReauthResult | null; error: string | null }> => {
    try {
      const result = await api('reauthConnector', { params: { id: connectorId }, body: {} }, { fail: failFromUrl() });
      return { result, error: null };
    } catch (err) {
      return { result: null, error: err instanceof ApiError ? errText(err) : String(err) };
    }
  }, []);

  // ---- read markers ---------------------------------------------------------
  // Not an optimistic mutation on purpose: nothing to roll back, and it must not cancel the sheet's
  // in-flight reads (useOptimisticMutation cancels its topics' queries on start).
  const qc = useQueryClient();
  const markSeen = useCallback(
    (w: WorkItem) => {
      if (w.newEvidenceCount <= 0) return;
      void api('markItemSeen', { params: { id: w.id }, body: {} })
        .then(() => Promise.all(['today', 'items'].map((t) => qc.invalidateQueries({ queryKey: [t] }))))
        .catch(() => undefined);
    },
    [qc],
  );

  const clearError = useCallback((id: string) => setError(id, null), [setError]);

  return useMemo(
    () => ({
      done,
      confirmDone,
      accept,
      resolve,
      letGo,
      snooze,
      notNow,
      applyProposal,
      applyProposalAsync,
      keepMine,
      undoReopen,
      undoClose: undoClosed,
      undoAudit,
      rerank,
      rerankAsync,
      reranking: rerankM.isPending,
      setStartBy,
      shorter,
      launchClaude,
      openClaude,
      launchDialog,
      runTool,
      answer,
      reauth,
      markSeen,
      errors,
      clearError,
    }),
    [done, confirmDone, accept, resolve, letGo, snooze, notNow, applyProposal, applyProposalAsync, keepMine, undoReopen, undoClosed, undoAudit, rerank, rerankAsync, rerankM.isPending, setStartBy, shorter, launchClaude, openClaude, launchDialog, runTool, answer, reauth, markSeen, errors, clearError],
  );
}

export type TodayActions = ReturnType<typeof useTodayActions>;
