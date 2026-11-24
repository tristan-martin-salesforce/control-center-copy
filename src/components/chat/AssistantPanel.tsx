'use client';
/**
 * <AssistantPanel/>: the Assistant tab of the docked right panel (DESIGN-V2 §10, mockup home-1-chat.html).
 *
 *   header    thread title (opens the thread switcher) · n exchanges · New thread · pop out to /assistant
 *   thread    morning brief, messages, tool lines, proposal → receipt, draft, session and scan cards
 *   composer  "Looking at:" chip (follows the panel's selection), @ / commands, attach, model, dictation
 *
 * Keys: ↑ edits the last message, ⌘↵ applies the focused proposal, z undoes, Esc closes the panel.
 * V2-SHELL mounts it in the panel; the orchestrator swaps ChatTabPanel → AssistantPanel at merge.
 */
import { AppLink } from '@/components/shell/AppLink';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ChatThread } from '@/contract';
import type { ChatMessageView } from '@/client/chat';
import { PanelBoundary, useNow } from '@/ui';
import { useRightPanel } from '@/components/shell/panel';
import { AssistantSurfaceContext, useBaseSurface } from './assistant-context';
import { ConnectedComposer } from './ConnectedComposer';
import { MessageList } from './ChatMessages';
import { EnsureChatProvider, useChat } from './ChatProvider';
import { setChatContext } from './context-store';
import { fmtAgoShort, threadTitle } from './format';
import { ChatIcon } from './icons';
import { useAssistantCommands, useAssistantKeys } from './useAssistantKeys';
import s from './assistant.module.css';
import { navigate } from '@/components/shell/router';

/** Keep chat's "Looking at" in step with the panel's entity even if the provider sits above the panel's. */
export function usePanelContextBridge(): void {
  const { entity } = useRightPanel();
  const kind = entity?.kind;
  const id = entity?.id;
  const label = entity?.label;
  useEffect(() => {
    if (kind && id) setChatContext({ kind, id, label: label ?? 'Selection' });
  }, [kind, id, label]);
}

export function exchangesOf(messages: ChatMessageView[]): number {
  return messages.filter((m) => m.role === 'user').length;
}

// ── Thread switcher ──────────────────────────────────────────────────────────────────────────

export function ThreadSwitcher({
  threads,
  threadId,
  onSelect,
  onClose,
  now,
  tz,
  streamingThreadId,
  about,
}: {
  threads: ChatThread[];
  threadId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  now: Date;
  tz?: string;
  streamingThreadId?: string | null;
  /** Assistant v2: start a thread about what is open (its context rides on every turn of that thread). */
  about?: { label: string; start: () => void } | null;
}) {
  const [active, setActive] = useState(() => Math.max(0, threads.findIndex((t) => t.id === threadId)));
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [active]);
  const shown = threads.slice(0, 8);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % Math.max(1, shown.length));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className={s.threads} role="dialog" aria-label="Threads" onKeyDown={onKeyDown} data-thread-switcher>
      <div className={s.popH}>
        <span>Threads</span>
        <span>↑↓ · ↵ open</span>
      </div>
      <div ref={listRef} className={s.popList} role="listbox" aria-label="Threads">
        {shown.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="option"
            aria-selected={t.id === threadId}
            data-index={i}
            tabIndex={i === active ? 0 : -1}
            className={`${s.popI} ${s.one}`}
            onClick={() => {
              onSelect(t.id);
              onClose();
            }}
            data-thread-id={t.id}
          >
            <span className={s.n}>{threadTitle(t, now, tz)}</span>
            <span className={s.h}>{streamingThreadId === t.id ? 'answering…' : t.isDefault ? 'now' : fmtAgoShort(t.updatedAt, now, tz)}</span>
          </button>
        ))}
      </div>
      {about ? (
        <button
          type="button"
          className={s.seeAll}
          onClick={() => {
            about.start();
            onClose();
          }}
          data-thread-about
        >
          New thread about {about.label} →
        </button>
      ) : null}
      <AppLink className={s.seeAll} href="/assistant">
        {threads.length > shown.length ? `All ${threads.length} threads, full page →` : 'Open the full page →'}
      </AppLink>
    </div>
  );
}

// ── Presentational panel ─────────────────────────────────────────────────────────────────────

export interface AssistantPanelViewProps {
  threads: ChatThread[];
  threadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  creatingThread?: boolean;
  streamingThreadId?: string | null;
  messages: ChatMessageView[];
  loading?: boolean;
  loadError?: { message: string } | null;
  onReload?: () => void;
  notice?: string | null;
  composer: ReactNode;
  editingId?: string | null;
  anchor?: string | null;
  /** Esc: close the panel. */
  onClose?: () => void;
  status?: string;
  lastEvent?: string | null;
  timeZone?: string;
  initialThreadsOpen?: boolean;
  className?: string;
  /** Assistant v2: "New thread about <the open item>" in the thread list. */
  about?: { label: string; start: () => void } | null;
}

export function AssistantPanelView(p: AssistantPanelViewProps) {
  const now = useNow(60_000);
  const [threadsOpen, setThreadsOpen] = useState(!!p.initialThreadsOpen);
  const thread = p.threads.find((t) => t.id === p.threadId) ?? null;
  const exchanges = exchangesOf(p.messages);
  const keys = useAssistantKeys(p.messages, { onClose: p.onClose });
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!threadsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-thread-switcher], [data-threads-toggle]')) setThreadsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [threadsOpen]);

  return (
    <section
      ref={rootRef}
      className={`${s.root} ${s.panel} ${p.className ?? ''}`}
      aria-label="Assistant"
      data-chat-root
      data-assistant-panel
      data-chat-status={p.status ?? 'idle'}
      data-chat-last-event={p.lastEvent ?? ''}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && threadsOpen) {
          e.preventDefault();
          setThreadsOpen(false);
          return;
        }
        keys(e);
      }}
    >
      <header className={s.head}>
        <button type="button" className={s.title} aria-expanded={threadsOpen} aria-haspopup="dialog" title="Switch thread" onClick={() => setThreadsOpen((o) => !o)} data-threads-toggle>
          <span>{threadTitle(thread, now, p.timeZone)}</span>
          <ChatIcon name="chev-d" size={14} />
        </button>
        <span className={s.meta}>{exchanges ? `${exchanges} exchange${exchanges === 1 ? '' : 's'}` : thread?.isDefault ? 'Morning brief' : 'New'}</span>
        <span className={s.sp} />
        <button type="button" className={s.iconBtn} aria-label="New thread" title="New thread" onClick={p.onNewThread} disabled={p.creatingThread} data-new-thread>
          <ChatIcon name="plus" />
        </button>
        <AppLink className={s.iconBtn} href={p.threadId ? `/assistant?thread=${encodeURIComponent(p.threadId)}` : '/assistant'} aria-label="Open as full page" title="Open as full page" data-popout>
          <ChatIcon name="popout" />
        </AppLink>
      </header>
      {threadsOpen ? (
        <ThreadSwitcher threads={p.threads} threadId={p.threadId} onSelect={p.onSelectThread} onClose={() => setThreadsOpen(false)} now={now} tz={p.timeZone} streamingThreadId={p.streamingThreadId} about={p.about ?? null} />
      ) : null}
      {p.notice ? (
        <div className={s.notice} role="status">
          {p.notice}
        </div>
      ) : null}
      <PanelBoundary name="assistant-thread" resetKeys={[p.threadId]} onRetry={p.onReload}>
        <MessageList messages={p.messages} loading={p.loading} error={p.loadError} onReload={p.onReload} editingId={p.editingId} anchor={p.anchor} />
      </PanelBoundary>
      <div className={s.composer}>{p.composer}</div>
    </section>
  );
}

// ── Connected ────────────────────────────────────────────────────────────────────────────────

function ConnectedPanel({ anchor, initialThreadsOpen, className }: AssistantPanelProps) {
  const chat = useChat();
  const panel = useRightPanel();
  const base = useBaseSurface();
  const st = chat.stream;
  usePanelContextBridge();
  const close = () => {
    panel.close();
    chat.returnFocus();
  };
  const newThread = () => {
    void chat.createThread().then((t) => {
      if (t) requestAnimationFrame(() => chat.composerRef.current?.focus());
    });
  };
  useAssistantCommands(st.messages, {
    onNewThread: newThread,
    onFocus: chat.focus,
    switchSurface: { title: 'Open the assistant as a full page', run: () => navigate(st.threadId ? `/assistant?thread=${encodeURIComponent(st.threadId)}` : '/assistant') },
  });
  return (
    <AssistantSurfaceContext.Provider value={base}>
      <AssistantPanelView
        threads={st.threads}
        threadId={st.threadId}
        onSelectThread={st.selectThread}
        onNewThread={newThread}
        creatingThread={chat.creatingThread}
        streamingThreadId={st.streamingThreadId}
        messages={st.messages}
        loading={st.loading}
        loadError={st.loadError}
        onReload={st.reload}
        notice={st.notice}
        composer={<ConnectedComposer variant="panel" onEscape={close} />}
        editingId={chat.editingId}
        anchor={anchor}
        onClose={close}
        status={st.status}
        lastEvent={st.lastEvent}
        timeZone={chat.timeZone}
        initialThreadsOpen={initialThreadsOpen}
        className={className}
        about={
          chat.autoContext
            ? {
                label: chat.autoContext.label,
                start: () => {
                  const ctx = chat.autoContext!;
                  void chat.createThread({ title: ctx.label, context: [ctx] }).then((t) => {
                    if (t) requestAnimationFrame(() => chat.composerRef.current?.focus());
                  });
                },
              }
            : null
        }
      />
    </AssistantSurfaceContext.Provider>
  );
}

export interface AssistantPanelProps {
  /** Scroll this message into view first (dev preview `?at=`). */
  anchor?: string | null;
  initialThreadsOpen?: boolean;
  className?: string;
}

export function AssistantPanel(props: AssistantPanelProps) {
  return (
    <EnsureChatProvider>
      <ConnectedPanel {...props} />
    </EnsureChatProvider>
  );
}

/** For lanes that only need the title the panel shows ("Today · Thu 5 Nov"). */
export function useAssistantThreadTitle(): string {
  const chat = useChat();
  const now = useNow(60_000);
  const t = chat.stream.threads.find((x) => x.id === chat.stream.threadId) ?? null;
  return useMemo(() => threadTitle(t, now, chat.timeZone), [t, now, chat.timeZone]);
}
