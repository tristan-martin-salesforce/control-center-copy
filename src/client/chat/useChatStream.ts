'use client';
/**
 * useChatStream: the chat transport (R-UI-10, UI-SPEC §6).
 *
 * - POST /chat with fetch + ReadableStream SSE parsing (./sse), folded into a LiveTurn (./turn).
 * - text-delta is buffered and flushed once per animation frame, so long answers don't re-render per token.
 * - Stop aborts the request; the server persists the partial answer and the thread refetches.
 * - Reconnect: a connection that fails before any response is retried with backoff (only if the server
 *   has not recorded the message). A stream that drops mid-answer is never re-POSTed (that would repeat
 *   mutations); the hook re-reads the thread with backoff until the persisted answer appears.
 * - Resume: the active thread and each thread's draft persist in localStorage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiErrorBody, ChatMessage, ChatModelChoice, ChatSseEvent, ChatSseEventType, ChatThread, ChatThreadDetail, ContextRef, Settings } from '@/contract';
import { ApiErrorEnvelope } from '@/contract';
import { api, ApiError, queryKey, urlFor } from '@/client/api';
import { isAbortError, parseChatFrame, readSseStream } from './sse';
import { CHAT_KEYS, readJson, readString, writeJson, writeString } from './storage';
import { extrasFor, failTurn, isReconciled, isStepLimitError, localId, mergeMessages, newServerMessages, reconciledAssistantId, reduceTurn, startTurn, stopTurn, TERMINAL } from './turn';
import type { ChatMessageView, ChatTurnStatus, LiveTurn, TurnExtras } from './types';

export interface UseChatStreamOptions {
  /** Thread to open first; otherwise the remembered thread, then the default ("Today"). */
  initialThreadId?: string | null;
  reconnect?: { attempts?: number; baseMs?: number };
  /** Called for every parsed event (dock uses it for `data-chat-last-event`). */
  onEvent?: (ev: ChatSseEvent) => void;
  /** Persist thread + drafts (default true). The kit gallery turns it off for side-by-side docks. */
  persist?: boolean;
  /**
   * The model each message asks for (BE-CHAT). Default: settings.chat.defaultModel from the query cache, else
   * the locally chosen model (localStorage), else none (the server's default).
   */
  model?: ChatModelChoice;
}

export type ChatStatus = 'idle' | ChatTurnStatus;

export interface ChatStreamApi {
  threads: ChatThread[];
  threadsLoading: boolean;
  threadId: string | null;
  selectThread(id: string): void;
  newThread(): void;
  isLocalThread(id: string | null): boolean;
  messages: ChatMessageView[];
  /** Live or just-finished turn for the active thread. */
  turn: LiveTurn | null;
  status: ChatStatus;
  busy: boolean;
  /** Thread whose turn is streaming (tab dot), if any. */
  streamingThreadId: string | null;
  loading: boolean;
  loadError: ApiError | null;
  reload(): void;
  draft: string;
  setDraft(value: string): void;
  send(text: string, context?: ContextRef[]): boolean;
  stop(): void;
  /**
   * Ask the failed message again. With `allowExtraUsd` (the user's one-time "Allow more") on an answer stopped at its
   * cost limit, continue that answer instead (ASSIST-2).
   */
  retry(opts?: { allowExtraUsd?: number }): void;
  notice: string | null;
  dismissNotice(): void;
  lastEvent: ChatSseEventType | null;
}

const LOCAL_PREFIX = 'local_';
const isLocal = (id: string | null | undefined) => !!id && id.startsWith(LOCAL_PREFIX);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const raf: (cb: () => void) => number =
  typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function' ? (cb) => window.requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16) as unknown as number;
const caf: (h: number) => void =
  typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function' ? (h) => window.cancelAnimationFrame(h) : (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>);

async function responseError(res: Response): Promise<ApiErrorBody> {
  try {
    const parsed = ApiErrorEnvelope.safeParse(await res.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    /* not JSON */
  }
  return { code: res.status >= 500 ? 'internal' : 'validation', message: `The assistant answered HTTP ${res.status}.`, retryable: res.status >= 500 };
}

/** drafts[] key for text typed while no thread is selected yet. */
const PENDING_DRAFT = '\u0000pending';

export function useChatStream(opts: UseChatStreamOptions = {}): ChatStreamApi {
  const persist = opts.persist !== false;
  const attempts = opts.reconnect?.attempts ?? 3;
  const baseMs = opts.reconnect?.baseMs ?? 500;
  const qc = useQueryClient();
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;
  const modelRef = useRef(opts.model);
  modelRef.current = opts.model;
  /** The model this message is sent with (see UseChatStreamOptions.model). */
  const currentModel = useCallback((): ChatModelChoice | undefined => {
    if (modelRef.current) return modelRef.current;
    // Assistant v2: Settings ▸ Budgets ▸ Assistant routing (auto, or "always <model>"); the server routes `auto`
    const fromSettings = qc.getQueryData<Settings>(queryKey('getSettings'))?.chat?.routing;
    if (fromSettings) return fromSettings;
    const local = readString(CHAT_KEYS.model)?.toLowerCase();
    return local === 'auto' || local === 'haiku' || local === 'sonnet' || local === 'opus' ? local : undefined;
  }, [qc]);

  // ── Threads ───────────────────────────────────────────────────────────
  const threadsQ = useQuery({ queryKey: queryKey('listChatThreads'), queryFn: ({ signal }) => api('listChatThreads', undefined, { signal }) });
  const [localThreads, setLocalThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(opts.initialThreadId ?? null);

  useEffect(() => {
    if (!persist) return;
    setLocalThreads(readJson<ChatThread[]>(CHAT_KEYS.localThreads, []));
    if (!opts.initialThreadId) {
      const remembered = readString(CHAT_KEYS.thread);
      if (remembered) setThreadId(remembered);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const serverThreads = threadsQ.data?.threads;
  const threads = useMemo(() => [...(serverThreads ?? []), ...localThreads], [serverThreads, localThreads]);
  const defaultThreadId = serverThreads?.find((t) => t.isDefault)?.id ?? serverThreads?.[0]?.id ?? null;

  // Unknown or missing thread → the default ("Today").
  useEffect(() => {
    if (!serverThreads) return;
    if (!threadId || (!isLocal(threadId) && !serverThreads.some((t) => t.id === threadId)) || (isLocal(threadId) && !localThreads.some((t) => t.id === threadId))) {
      setThreadId(defaultThreadId);
    }
  }, [serverThreads, localThreads, threadId, defaultThreadId]);

  useEffect(() => {
    if (persist && threadId) writeString(CHAT_KEYS.thread, threadId);
  }, [persist, threadId]);

  const threadQ = useQuery({
    queryKey: queryKey('getChatThread', { params: { id: threadId ?? '' } }),
    queryFn: ({ signal }) => api('getChatThread', { params: { id: threadId as string } }, { signal }),
    enabled: !!threadId && !isLocal(threadId),
  });

  // ── Drafts (per thread) ───────────────────────────────────────────────
  // Text typed before the thread is known (the list has not landed yet) waits under PENDING_DRAFT and
  // becomes that thread's draft once it resolves, so early keystrokes are not dropped.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!threadId || threadId in drafts) return;
    const pending = drafts[PENDING_DRAFT];
    const saved = pending ? pending : persist ? (readString(CHAT_KEYS.draft(threadId)) ?? '') : '';
    if (pending && persist) writeString(CHAT_KEYS.draft(threadId), pending);
    setDrafts(({ [PENDING_DRAFT]: _p, ...d }) => ({ ...d, [threadId]: saved }));
  }, [persist, threadId, drafts]);
  const setDraft = useCallback(
    (value: string) => {
      setDrafts((d) => ({ ...d, [threadId ?? PENDING_DRAFT]: value }));
      if (persist && threadId) writeString(CHAT_KEYS.draft(threadId), value);
    },
    [persist, threadId],
  );

  // ── Live turn ─────────────────────────────────────────────────────────
  const [turn, setTurnState] = useState<LiveTurn | null>(null);
  const turnRef = useRef<LiveTurn | null>(null);
  const setTurn = useCallback((next: LiveTurn | null | ((prev: LiveTurn | null) => LiveTurn | null)) => {
    const value = typeof next === 'function' ? next(turnRef.current) : next;
    turnRef.current = value;
    setTurnState(value);
  }, []);
  const [extras, setExtras] = useState<Record<string, TurnExtras>>({});
  useEffect(() => {
    if (persist) setExtras((e) => ({ ...readJson<Record<string, TurnExtras>>(CHAT_KEYS.extras, {}), ...e }));
  }, [persist]);
  const rememberExtras = useCallback(
    (id: string, x: TurnExtras) =>
      setExtras((e) => {
        const next = Object.fromEntries([...Object.entries(e).filter(([k]) => k !== id), [id, x]].slice(-40));
        if (persist) writeJson(CHAT_KEYS.extras, next);
        return next;
      }),
    [persist],
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<ChatSseEventType | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** A5 (2026-11-13): an "Allow more" lasts the thread, not one message: thread id → the extra each later turn may spend. */
  const allowRef = useRef(new Map<string, number>());
  const textBuf = useRef<{ key: string; messageId: string; delta: string; handle: number | null }>({ key: '', messageId: '', delta: '', handle: null });

  /** Update the turn only if it is still the one this stream belongs to. */
  const updateTurn = useCallback((key: string, fn: (t: LiveTurn) => LiveTurn) => setTurn((prev) => (prev && prev.key === key ? fn(prev) : prev)), [setTurn]);

  const flushText = useCallback(() => {
    const b = textBuf.current;
    if (b.handle !== null) {
      caf(b.handle);
      b.handle = null;
    }
    if (!b.delta) return;
    const ev: ChatSseEvent = { type: 'text-delta', messageId: b.messageId, delta: b.delta };
    b.delta = '';
    updateTurn(b.key, (t) => reduceTurn(t, ev));
  }, [updateTurn]);

  const threadData = useCallback((id: string) => qc.getQueryData<ChatThreadDetail>(queryKey('getChatThread', { params: { id } })), [qc]);

  const refetchThread = useCallback(
    async (id: string): Promise<ChatThreadDetail | null> => {
      try {
        const detail = await api('getChatThread', { params: { id } });
        qc.setQueryData(queryKey('getChatThread', { params: { id } }), detail);
        return detail;
      } catch {
        return null;
      }
    },
    [qc],
  );

  /** Re-read the thread until this turn's answer is persisted (mid-stream drop). */
  const resync = useCallback(
    async (t: LiveTurn) => {
      for (let i = 1; i <= attempts; i++) {
        updateTurn(t.key, (cur) => ({ ...cur, status: 'reconnecting', attempt: i }));
        await sleep(baseMs * 2 ** (i - 1));
        if (turnRef.current?.key !== t.key) return;
        const detail = await refetchThread(t.threadId);
        if (detail && newServerMessages(t, detail.messages).some((m) => m.role === 'assistant')) {
          updateTurn(t.key, (cur) => ({ ...cur, status: 'done', tools: cur.tools.map((x) => (x.ok === null ? { ...x, ok: true } : x)) }));
          void qc.invalidateQueries({ queryKey: ['chat'] });
          return;
        }
      }
      updateTurn(t.key, (cur) => failTurn(cur, { code: 'upstream_unavailable', message: 'The connection dropped before the answer finished. Nothing was re-sent.', retryable: true }));
    },
    [attempts, baseMs, refetchThread, updateTurn, qc],
  );

  const run = useCallback(
    async (t: LiveTurn) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const model = currentModel();
      const body = JSON.stringify({ threadId: t.threadId, text: t.userText, context: t.context.map(({ type, id, label, via }) => ({ type, id, label, via })), ...(model ? { model } : {}), ...(t.allowExtraUsd ? { allowExtraUsd: t.allowExtraUsd } : {}), ...(t.continueMessageId ? { continueMessageId: t.continueMessageId } : {}) });
      let res: Response | null = null;
      for (let i = 0; ; i++) {
        try {
          res = await fetch(urlFor('chat'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body, signal: ac.signal, cache: 'no-store' });
          break;
        } catch (err) {
          if (ac.signal.aborted || isAbortError(err)) {
            updateTurn(t.key, stopTurn);
            return;
          }
          // Did the server record it anyway? Then never re-POST: wait for the persisted answer instead.
          const detail = await refetchThread(t.threadId);
          if (detail && newServerMessages(t, detail.messages).some((m) => m.role === 'user')) return void resync(t);
          if (i >= attempts) {
            updateTurn(t.key, (cur) => failTurn(cur, { code: 'upstream_unavailable', message: "Can't reach the assistant. Check that Command Center is running, then retry.", retryable: true }));
            return;
          }
          updateTurn(t.key, (cur) => ({ ...cur, status: 'reconnecting', attempt: i + 1 }));
          await sleep(baseMs * 2 ** i);
          if (ac.signal.aborted) {
            updateTurn(t.key, stopTurn);
            return;
          }
        }
      }
      if (!res.ok || !res.body) {
        const error = await responseError(res);
        updateTurn(t.key, (cur) => failTurn(cur, error));
        setLastEvent('error');
        return;
      }
      updateTurn(t.key, (cur) => ({ ...cur, status: 'streaming', attempt: 0 }));
      let terminal = false;
      try {
        await readSseStream(
          res.body,
          (frame) => {
            const ev = parseChatFrame(frame);
            if (!ev) return;
            onEventRef.current?.(ev);
            if (ev.type === 'text-delta') {
              const b = textBuf.current;
              if (b.key !== t.key) Object.assign(b, { key: t.key, delta: '' });
              b.messageId = ev.messageId;
              b.delta += ev.delta;
              if (b.handle === null) b.handle = raf(flushText);
              return;
            }
            flushText();
            if (ev.type === 'done' || ev.type === 'error') terminal = true;
            updateTurn(t.key, (cur) => reduceTurn(cur, ev));
            setLastEvent(ev.type);
          },
          ac.signal,
        );
        flushText();
      } catch (err) {
        flushText();
        if (ac.signal.aborted || isAbortError(err)) {
          updateTurn(t.key, stopTurn);
          setTimeout(() => void qc.invalidateQueries({ queryKey: ['chat'] }), 200);
          return;
        }
        if (!terminal) return void resync(turnRef.current ?? t);
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
      if (!terminal) return void resync(turnRef.current ?? t);
      void qc.invalidateQueries({ queryKey: ['chat'] });
    },
    [attempts, baseMs, currentModel, flushText, qc, refetchThread, resync, updateTurn],
  );

  // Reconcile: once the persisted thread holds the turn's answer, render the server copy (+ extras).
  const turnThreadData = turn ? (turn.threadId === threadId ? threadQ.data : threadData(turn.threadId)) : undefined;
  useEffect(() => {
    if (!turn || !TERMINAL.has(turn.status) || !turnThreadData) return;
    if (!isReconciled(turn, turnThreadData.messages)) return;
    const aid = reconciledAssistantId(turn, turnThreadData.messages);
    if (aid) rememberExtras(aid, extrasFor(turn));
    setTurn(null);
  }, [turn, turnThreadData, setTurn, rememberExtras]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Public actions ────────────────────────────────────────────────────
  const send = useCallback(
    (raw: string, context: ContextRef[] = [], allowExtraUsd?: number) => {
      const text = raw.trim();
      if (!text) return false;
      // CHAT-1: never a silent no-op. Before, with no thread (a fresh install had none) Send did nothing at all.
      if (!threadId) {
        setNotice(threadsQ.isError ? "Couldn't load your chat threads, so this wasn't sent. Your text is kept." : 'Chat is still loading, so this wasn’t sent yet. Your text is kept; try again in a moment.');
        void threadsQ.refetch();
        return false;
      }
      const cur = turnRef.current;
      if (cur && !TERMINAL.has(cur.status)) return false;
      let target = threadId;
      if (isLocal(threadId)) {
        if (!defaultThreadId) return false;
        // No create-thread route in the API yet: say so, and keep the message instead of losing it.
        target = defaultThreadId;
        setLocalThreads((ls) => {
          const next = ls.filter((l) => l.id !== threadId);
          if (persist) writeJson(CHAT_KEYS.localThreads, next);
          return next;
        });
        setNotice('New threads are not saved by the server yet, so this went to Today.');
        setThreadId(target);
      }
      const detail = threadData(target);
      if (allowExtraUsd) allowRef.current.set(target, Math.max(allowRef.current.get(target) ?? 0, allowExtraUsd));
      const extra = allowExtraUsd ?? allowRef.current.get(target);
      const t = startTurn({ threadId: target, text, context, baseIds: (detail?.messages ?? []).map((m: ChatMessage) => m.id), ...(extra ? { allowExtraUsd: extra } : {}) });
      setTurn(t);
      setLastEvent(null);
      setDrafts((d) => ({ ...d, [threadId]: '' }));
      if (persist) writeString(CHAT_KEYS.draft(threadId), null);
      void run(t);
      return true;
    },
    [threadId, defaultThreadId, persist, threadData, setTurn, run, threadsQ],
  );

  const stop = useCallback(() => {
    const cur = turnRef.current;
    if (!cur || TERMINAL.has(cur.status)) return;
    abortRef.current?.abort();
    flushText();
    updateTurn(cur.key, stopTurn);
    setTimeout(() => void qc.invalidateQueries({ queryKey: ['chat'] }), 200);
  }, [flushText, updateTurn, qc]);

  const retry = useCallback(
    (opts: { allowExtraUsd?: number } = {}) => {
      const extra = typeof opts.allowExtraUsd === 'number' && opts.allowExtraUsd > 0 ? opts.allowExtraUsd : undefined;
      const cur = turnRef.current;
      // ASSIST-2: "Allow more" on an answer stopped at its cost limit continues that answer (the server keeps it, with
      // its tool rows, as context); it never re-sends the question, which would pay for the same work twice.
      if (extra) {
        const msgs = threadData(cur?.threadId ?? threadId ?? '')?.messages ?? threadQ.data?.messages ?? [];
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
        const stoppedId =
          cur?.status === 'error' && cur.error?.code === 'budget_exceeded' && cur.messageId
            ? cur.messageId
            : lastAssistant && msgs.at(-1)?.id === lastAssistant.id && lastAssistant.parts.some((p) => p.type === 'error' && p.error.code === 'budget_exceeded')
              ? lastAssistant.id
              : null;
        const target = cur?.threadId ?? threadId;
        if (stoppedId && target) {
          allowRef.current.set(target, Math.max(allowRef.current.get(target) ?? 0, extra));
          const t = startTurn({ threadId: target, text: `Continue (allowed $${extra.toFixed(2)} more)`, context: cur?.context ?? [], baseIds: [...msgs.map((m) => m.id), ...(cur?.userMessageId ? [cur.userMessageId] : []), ...(cur?.messageId ? [cur.messageId] : [])], allowExtraUsd: extra, continueMessageId: stoppedId });
          setTurn(t);
          void run(t);
          return;
        }
      }
      // P33-2: an answer stopped at Steps per message is continued, like the typed "continue": the server picks the
      // stopped answer up by `continueMessageId`, and the question is never sent again (that would redo the same steps).
      if (!extra) {
        const msgs = threadData(cur?.threadId ?? threadId ?? '')?.messages ?? threadQ.data?.messages ?? [];
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
        const stoppedId =
          cur?.status === 'error' && isStepLimitError(cur.error) && cur.messageId
            ? cur.messageId
            : !cur && lastAssistant && msgs.at(-1)?.id === lastAssistant.id && lastAssistant.parts.some((p) => p.type === 'error' && isStepLimitError(p.error))
              ? lastAssistant.id
              : null;
        const target = cur?.threadId ?? threadId;
        if (stoppedId && target) {
          const t = startTurn({ threadId: target, text: 'Continue', context: cur?.context ?? [], baseIds: [...msgs.map((m) => m.id), ...(cur?.userMessageId ? [cur.userMessageId] : []), ...(cur?.messageId ? [cur.messageId] : [])], continueMessageId: stoppedId });
          setTurn(t);
          void run(t);
          return;
        }
      }
      const failedText = cur?.status === 'error' ? cur.userText : null;
      if (failedText !== null && cur) {
        const detail = threadData(cur.threadId);
        if (extra) allowRef.current.set(cur.threadId, Math.max(allowRef.current.get(cur.threadId) ?? 0, extra));
        const t = startTurn({ threadId: cur.threadId, text: failedText, context: cur.context, baseIds: (detail?.messages ?? []).map((m) => m.id), ...(extra ? { allowExtraUsd: extra } : {}) });
        setTurn(t);
        void run(t);
        return;
      }
      // A reconciled failed answer: ask the last user message again.
      const msgs = threadQ.data?.messages ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      if (lastUser) send(lastUser.text, lastUser.context, extra);
    },
    [threadData, threadId, setTurn, run, threadQ.data, send],
  );

  const selectThread = useCallback((id: string) => setThreadId(id), []);
  const newThread = useCallback(() => {
    const now = new Date().toISOString();
    const t: ChatThread = { id: localId(LOCAL_PREFIX.slice(0, -1)), title: 'New thread', isDefault: false, createdAt: now, updatedAt: now, messageCount: 0, lastMessagePreview: null };
    setLocalThreads((ls) => {
      const next = [...ls, t];
      if (persist) writeJson(CHAT_KEYS.localThreads, next);
      return next;
    });
    setThreadId(t.id);
  }, [persist]);

  const visibleTurn = turn && turn.threadId === threadId ? turn : null;
  const serverMessages = threadQ.data?.messages;
  const messages = useMemo(() => mergeMessages(serverMessages ?? [], visibleTurn, extras), [serverMessages, visibleTurn, extras]);
  const status: ChatStatus = turn?.status ?? 'idle';

  return {
    threads,
    threadsLoading: threadsQ.isPending,
    threadId,
    selectThread,
    newThread,
    isLocalThread: isLocal,
    messages,
    turn: visibleTurn,
    status,
    busy: !!turn && !TERMINAL.has(turn.status),
    streamingThreadId: turn && !TERMINAL.has(turn.status) ? turn.threadId : null,
    loading: !!threadId && !isLocal(threadId) && threadQ.isPending,
    loadError: (threadQ.error as ApiError | null) ?? (threadsQ.error as ApiError | null) ?? null,
    reload: () => {
      void threadsQ.refetch();
      void threadQ.refetch();
    },
    draft: (threadId ? drafts[threadId] : drafts[PENDING_DRAFT]) || '',
    setDraft,
    send,
    stop,
    retry,
    notice,
    dismissNotice: () => setNotice(null),
    lastEvent,
  };
}
