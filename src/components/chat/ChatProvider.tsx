'use client';
/**
 * One chat for the whole app: the panel, the full page, the legacy dock and the ask bar share a stream,
 * undo state, context chips and focus. Mount once in the shell; components auto-wrap if it's missing.
 *
 * Context (v2): "Looking at" follows the docked right panel's entity (`useRightPanel().entity`), falling
 * back to what a page attached with setChatContext. It rides along with every message until you remove
 * it, and comes back with "+ Attach what you're looking at" (or by selecting something else).
 * Model: `settings.chat.routing` (Assistant v2: Auto, or always Haiku / Sonnet / Opus), saved instantly when you pick one.
 *
 * Keyboard: ⌘J (Ctrl+J) focuses the composer from anywhere and toggles back; Esc in the composer returns
 * focus to where you were. The shell's key manager can take over with `registerHotkey={false}`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatModelChoice, ChatThread, ChatThreadsPayload, ContextRef, Settings } from '@/contract';
import { api, queryKey } from '@/client/api';
import { CHAT_KEYS, useChatActions, useChatStream, type ChatActionsApi, type ChatStreamApi } from '@/client/chat';
import { readString, writeString } from '@/client/chat/storage';
import { useOptimisticMutation } from '@/client/optimistic';
import { toast } from '@/client/toast/store';
import { useRightPanel } from '@/components/shell/panel';
import { toContextRef, useChatContextValue, type ChatContextInput } from './context-store';
import { lastUserMessage } from './thread-model';
import { ChatUiContext, type ChatUi } from './ui-context';

/** Assistant v2 (H-6): Auto routes each message (Haiku first); the others are "always <model>" (settings.chat.routing). */
export type ChatModel = 'Auto' | 'Haiku' | 'Sonnet' | 'Opus';
export const CHAT_MODELS: ChatModel[] = ['Auto', 'Haiku', 'Sonnet', 'Opus'];
const TO_CONTRACT: Record<ChatModel, ChatModelChoice> = { Auto: 'auto', Haiku: 'haiku', Sonnet: 'sonnet', Opus: 'opus' };
const FROM_CONTRACT: Record<ChatModelChoice, ChatModel> = { auto: 'Auto', haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

export interface ChatController {
  stream: ChatStreamApi;
  actions: ChatActionsApi;
  model: ChatModel;
  models: ChatModel[];
  setModel(m: ChatModel): void;
  timeZone?: string;
  autoContext: ContextRef | null;
  dismissAutoContext(): void;
  /** What's in view after its chip was removed (offer to re-attach it). */
  restorableContext: ContextRef | null;
  restoreAutoContext(): void;
  explicitContext: ContextRef[];
  addContext(ref: ContextRef): void;
  removeContext(ref: ContextRef): void;
  /** Send with the current context chips; clears explicit chips on success. */
  sendMessage(text: string): boolean;
  /** POST /chat/threads, then open it. Resolves to the new thread (null if it failed). */
  createThread(opts?: { title?: string; context?: ContextRef[] }): Promise<ChatThread | null>;
  creatingThread: boolean;
  /** ↑ in an empty composer: the last user message's text, and that message marked as being edited. */
  editLast(): string | null;
  endEdit(): void;
  editingId: string | null;
  collapsed: boolean;
  setCollapsed(c: boolean): void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  askRef: RefObject<HTMLInputElement | null>;
  focus(): void;
  returnFocus(): void;
  ui: ChatUi;
}

const Ctx = createContext<ChatController | null>(null);

export function useChat(): ChatController {
  const c = useContext(Ctx);
  if (!c) throw new Error('useChat() needs <ChatProvider> (the chat components add one automatically).');
  return c;
}

export function useOptionalChat(): ChatController | null {
  return useContext(Ctx);
}

// Module-level handles so non-React callers (the shell's key manager, ⌘K) can drive focus.
let focusHandle: (() => void) | null = null;
let toggleHandle: (() => void) | null = null;
export function focusChat(): void {
  focusHandle?.();
}
export function toggleChatFocus(): void {
  toggleHandle?.();
}
export const CHAT_HOTKEY = { key: 'j', mod: true, label: '⌘J' } as const;

const inChat = (el: Element | null) => !!el?.closest('[data-chat-root]');
const visible = (el: HTMLElement | null) => !!el && el.isConnected && el.offsetParent !== null;

const KIND_WORD: Record<string, string> = { work_item: 'Item', account: 'Account', opportunity: 'Opportunity', person: 'Person', initiative: 'Initiative', draft: 'Draft', calendar_event: 'Meeting', agent_run: 'Session', brief: 'Brief', vdp: 'VDP' };

export interface ChatProviderProps {
  children: ReactNode;
  initialThreadId?: string | null;
  /** Register the global ⌘J listener (default true). */
  registerHotkey?: boolean;
  /** Persist thread, drafts, width, model, undo state (default true). */
  persist?: boolean;
  models?: ChatModel[];
}

export function ChatProvider({ children, initialThreadId, registerHotkey = true, persist = true, models = CHAT_MODELS }: ChatProviderProps) {
  const qc = useQueryClient();
  const stream = useChatStream({ initialThreadId, persist });
  const actions = useChatActions({ persist });
  const settings = useQuery({ queryKey: queryKey('getSettings'), queryFn: ({ signal }) => api('getSettings', undefined, { signal }), staleTime: 60_000 });
  const timeZone = settings.data?.profile.timezone;

  // ── Model: settings.chat.routing (Auto by default), instant save; a local copy covers the first paint ──
  const [localModel, setLocalModel] = useState<ChatModel>('Auto');
  useEffect(() => {
    if (!persist) return;
    const m = readString(CHAT_KEYS.model) as ChatModel | null;
    if (m && models.includes(m)) setLocalModel(m);
  }, [persist, models]);
  const serverModel = settings.data?.chat?.routing;
  const model: ChatModel = serverModel ? FROM_CONTRACT[serverModel] : localModel;
  const patchModel = useOptimisticMutation({
    route: 'patchSettings',
    topics: ['settings'],
    writeBack: false,
    rebase: ({ input, current }) => ({ ...input, body: { ...input.body!, ifVersion: Number(current.version) } }),
    optimistic: (input, cache) =>
      cache.setQuery<Settings>(queryKey('getSettings'), (old) =>
        old ? { ...old, chat: { ...old.chat, routing: (input.body?.value as { routing: ChatModelChoice }).routing } } : old,
      ),
    onError: () => toast({ key: 'chat-model', tone: 'warning', title: "Couldn't change the model", body: 'New messages keep the previous model.' }),
  });
  const setModel = useCallback(
    (m: ChatModel) => {
      setLocalModel(m);
      if (persist) writeString(CHAT_KEYS.model, m);
      const chat = settings.data?.chat;
      if (chat) patchModel.mutate({ params: { section: 'chat' }, body: { ifVersion: chat.version, value: { routing: TO_CONTRACT[m] } } });
    },
    [persist, settings.data?.chat, patchModel],
  );

  // ── Collapsed (legacy dock) ──
  const [collapsed, setCollapsedState] = useState(false);
  useEffect(() => {
    if (persist) setCollapsedState(readString(CHAT_KEYS.collapsed) === '1');
  }, [persist]);
  const setCollapsed = useCallback(
    (c: boolean) => {
      setCollapsedState(c);
      if (persist) writeString(CHAT_KEYS.collapsed, c ? '1' : null);
    },
    [persist],
  );

  // ── Context: the right panel's entity (v2) or the page's focus, plus @-mentions ──
  const panel = useRightPanel();
  const pageFocus = useChatContextValue();
  const focused: ChatContextInput | null = panel.entity ? { kind: panel.entity.kind, id: panel.entity.id, label: panel.entity.label ?? KIND_WORD[panel.entity.kind] ?? 'Selection' } : pageFocus;
  const focusedKey = focused ? `${focused.kind}:${focused.id}` : null;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const inView = focused ? toContextRef(focused, 'auto') : null;
  const autoContext = inView && focusedKey !== dismissedKey ? inView : null;
  const restorableContext = inView && focusedKey === dismissedKey ? inView : null;
  const [explicitContext, setExplicit] = useState<ContextRef[]>([]);
  const addContext = useCallback((ref: ContextRef) => setExplicit((xs) => (xs.some((x) => x.type === ref.type && x.id === ref.id) ? xs : [...xs, ref])), []);
  const removeContext = useCallback((ref: ContextRef) => setExplicit((xs) => xs.filter((x) => !(x.type === ref.type && x.id === ref.id))), []);

  // ── ↑ edit last ──
  const [editingId, setEditingId] = useState<string | null>(null);
  const editLast = useCallback(() => {
    const last = lastUserMessage(stream.messages);
    if (!last) return null;
    setEditingId(last.id);
    return last.text;
  }, [stream.messages]);
  const endEdit = useCallback(() => setEditingId(null), []);

  const sendMessage = useCallback(
    (text: string) => {
      const ctx = [...(autoContext ? [autoContext] : []), ...explicitContext.filter((e) => !(autoContext && e.type === autoContext.type && e.id === autoContext.id))];
      const ok = stream.send(text, ctx);
      if (ok) {
        setExplicit([]);
        setEditingId(null);
      }
      return ok;
    },
    [autoContext, explicitContext, stream],
  );

  // ── New thread: persisted by the server (CONTRACT-1), then opened ──
  const [creatingThread, setCreating] = useState(false);
  const { selectThread } = stream;
  const createThread = useCallback(
    async (opts: { title?: string; context?: ContextRef[] } = {}) => {
      setCreating(true);
      try {
        const t = await api('createChatThread', { body: { ...(opts.title ? { title: opts.title } : {}), context: (opts.context ?? []).map(({ type, id, label }) => ({ type, id, label })) } });
        qc.setQueryData<ChatThreadsPayload>(queryKey('listChatThreads'), (old) => (old ? { threads: [...old.threads.filter((x) => x.id !== t.id), t] } : { threads: [t] }));
        selectThread(t.id);
        void qc.invalidateQueries({ queryKey: queryKey('listChatThreads') });
        return t;
      } catch (err) {
        toast({ key: 'chat-thread', tone: 'error', title: "Couldn't start a new thread", body: err instanceof Error ? err.message : undefined, durationMs: null });
        return null;
      } finally {
        setCreating(false);
      }
    },
    [qc, selectThread],
  );

  // ── Focus management ──
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const askRef = useRef<HTMLInputElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const focus = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && !inChat(active) && active !== document.body) returnTo.current = active;
    const go = () => {
      // Prefer a visible panel/page composer, then the ask bar (several surfaces can be mounted at once).
      const dom = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-root] [data-chat-input], [data-chat-root] [data-askbar-input]'));
      const target = [composerRef.current, ...dom, askRef.current].find((el): el is HTMLTextAreaElement | HTMLInputElement => visible(el as HTMLElement | null)) ?? null;
      target?.focus();
      if (target instanceof HTMLTextAreaElement) target.setSelectionRange(target.value.length, target.value.length);
    };
    if (collapsed) {
      setCollapsed(false);
      requestAnimationFrame(() => requestAnimationFrame(go));
    } else go();
  }, [collapsed, setCollapsed]);
  const returnFocus = useCallback(() => {
    const el = returnTo.current;
    returnTo.current = null;
    if (el && el.isConnected) el.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }, []);
  const toggle = useCallback(() => (inChat(document.activeElement) ? returnFocus() : focus()), [focus, returnFocus]);

  useEffect(() => {
    focusHandle = focus;
    toggleHandle = toggle;
    return () => {
      if (focusHandle === focus) focusHandle = null;
      if (toggleHandle === toggle) toggleHandle = null;
    };
  }, [focus, toggle]);

  useEffect(() => {
    if (!registerHotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === CHAT_HOTKEY.key) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [registerHotkey, toggle]);

  const { retry, busy, setDraft } = stream;
  const ui: ChatUi = useMemo(
    () => ({
      actions: actions.state,
      undo: (ids) => void actions.undoMany(ids),
      apply: (p) => void actions.apply(p),
      dismiss: (p) => void actions.dismiss(p),
      retry,
      followUp: (t) => {
        if (!sendMessage(t)) setDraft(t);
      },
      timeZone,
      busy,
    }),
    [actions, retry, busy, setDraft, sendMessage, timeZone],
  );

  const value: ChatController = {
    stream,
    actions,
    model,
    models,
    setModel,
    timeZone,
    autoContext,
    dismissAutoContext: () => setDismissedKey(focusedKey),
    restorableContext,
    restoreAutoContext: () => setDismissedKey(null),
    explicitContext,
    addContext,
    removeContext,
    sendMessage,
    createThread,
    creatingThread,
    editLast,
    endEdit,
    editingId,
    collapsed,
    setCollapsed,
    composerRef,
    askRef,
    focus,
    returnFocus,
    ui,
  };

  return (
    <Ctx.Provider value={value}>
      <ChatUiContext.Provider value={ui}>{children}</ChatUiContext.Provider>
    </Ctx.Provider>
  );
}

/** Wrap in a provider only if there isn't one above. */
export function EnsureChatProvider({ children }: { children: ReactNode }) {
  return useOptionalChat() ? <>{children}</> : <ChatProvider>{children}</ChatProvider>;
}
