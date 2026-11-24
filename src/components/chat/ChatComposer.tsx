'use client';
/**
 * Chat composer (v2 mockup, UI-SPEC §6): multi-line and growing; Enter sends, Shift+Enter is a newline,
 * ⌘↵ sends when there's text (otherwise it falls through to "apply the proposal"). ↑ in an empty box
 * edits your last message. `/` at the start opens the commands; `@` anywhere opens mentions (GET /search,
 * grouped). What you're looking at rides along as a dashed "Looking at:" chip you can remove and
 * re-attach. Toolbar: mention, commands, attach, model, dictation, send. Esc closes a popover first.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { ContextRef, SearchHit } from '@/contract';
import { api } from '@/client/api';
import { groupMentionHits, matchCommands, triggerAt, type SlashCommand } from './commands';
import { ChatIcon } from './icons';
import { useDictation } from './useDictation';
import s from './assistant.module.css';

export type ComposerModel = 'Auto' | 'Haiku' | 'Sonnet' | 'Opus';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onStop?: () => void;
  busy?: boolean;
  autoContext?: ContextRef | null;
  onRemoveAuto?: () => void;
  /** What's in view after you removed its chip: offers "+ Attach what you're looking at". */
  restorable?: ContextRef | null;
  onRestoreAuto?: () => void;
  explicitContext?: ContextRef[];
  onAddContext?: (ref: ContextRef) => void;
  onRemoveContext?: (ref: ContextRef) => void;
  search?: (q: string, signal: AbortSignal) => Promise<SearchHit[]>;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onEscape?: () => void;
  placeholder?: string;
  footnote?: boolean;
  maxHeight?: number;
  /** Initial caret (kit gallery: render with a popover already open). */
  defaultCaret?: number;
  /** Model picker (omit to hide it). */
  model?: ComposerModel;
  models?: ComposerModel[];
  onModelChange?: (m: ComposerModel) => void;
  /** ↑ in an empty composer: the text of your last message (null = nothing to edit). */
  onEditLast?: () => string | null;
  /** The composer was cleared or sent after ↑. */
  onEditEnd?: () => void;
  /** Suggestion chips under the box; picking one puts it in the composer. */
  suggestions?: string[];
  /** page = the full-page reading column (two-column command list). */
  variant?: 'panel' | 'page';
  /** Extra content above the box (e.g. a notice). */
  children?: ReactNode;
}

const defaultSearch = async (q: string, signal: AbortSignal) => (await api('search', { query: { q, limit: 30 } }, { signal })).hits;

type Item = { kind: 'command'; cmd: SlashCommand } | { kind: 'mention'; hit: SearchHit };

export const COMPOSER_FOOTNOTE = 'Can change tasks, priorities, links and policy, with undo. Never sends.';

const MODEL_NOTE: Record<ComposerModel, string> = { Auto: 'picks per message', Haiku: 'quickest', Sonnet: 'drafts', Opus: 'deepest' };

function CommandName({ cmd }: { cmd: SlashCommand }) {
  return (
    <span className={s.c}>
      {cmd.name}
      {cmd.args ? <i> {cmd.args.replace(/[<>[\]]/g, '')}</i> : null}
    </span>
  );
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  autoContext,
  onRemoveAuto,
  restorable,
  onRestoreAuto,
  explicitContext = [],
  onAddContext,
  onRemoveContext,
  search = defaultSearch,
  inputRef,
  onEscape,
  placeholder = 'Ask, or tell me what to change. @ mentions, / commands',
  footnote = true,
  maxHeight = 168,
  defaultCaret = 0,
  model,
  models = ['Auto', 'Haiku', 'Sonnet', 'Opus'],
  onModelChange,
  onEditLast,
  onEditEnd,
  suggestions = [],
  variant = 'panel',
  children,
}: ChatComposerProps) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? localRef;
  const listId = useId();
  const [caret, setCaret] = useState(defaultCaret);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState<'model' | 'attach' | null>(null);
  const [flash, setFlash] = useState(false);
  const dictation = useDictation((append) => onChange(append(value)));

  const trigger = triggerAt(value, caret);
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}` : null;
  const open = !!trigger && triggerKey !== dismissed;

  // The chip flashes when what you're looking at changes.
  const autoKey = autoContext ? `${autoContext.type}:${autoContext.id}` : null;
  const firstAuto = useRef(true);
  useEffect(() => {
    if (firstAuto.current) {
      firstAuto.current = false;
      return;
    }
    if (!autoKey) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 600);
    return () => clearTimeout(t);
  }, [autoKey]);

  // Mention search (debounced, cancellable).
  const mentionQuery = open && trigger?.kind === 'mention' ? trigger.query : null;
  useEffect(() => {
    if (mentionQuery === null) return;
    if (!mentionQuery) {
      setHits([]);
      return;
    }
    const ac = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      search(mentionQuery, ac.signal)
        .then((h) => setHits(h))
        .catch(() => undefined)
        .finally(() => !ac.signal.aborted && setSearching(false));
    }, 120);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [mentionQuery, search]);

  const groups = mentionQuery !== null ? groupMentionHits(hits) : [];
  const items: Item[] = open
    ? trigger?.kind === 'command'
      ? matchCommands(trigger.query).map((cmd) => ({ kind: 'command' as const, cmd }))
      : groups.flatMap((g) => g.hits.map((hit) => ({ kind: 'mention' as const, hit })))
    : [];
  useEffect(() => setActive(0), [triggerKey, items.length]);

  // Grow to fit, up to maxHeight.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight, ref]);

  // Menus close on an outside click.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-composer-menu], [data-composer-menu-trigger]')) setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? value.length);

  const place = (next: string, sel: [number, number]) => {
    onChange(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(sel[0], sel[1]);
      setCaret(sel[1]);
    });
  };

  const choose = (item: Item) => {
    if (!trigger) return;
    if (item.kind === 'command') {
      const c = item.cmd;
      place(c.insert, c.select ?? [c.insert.length, c.insert.length]);
      setDismissed(`command:0`);
      return;
    }
    const label = item.hit.ref.label || item.hit.title;
    const before = value.slice(0, trigger.start);
    const after = value.slice(caret);
    const inserted = `@${label} `;
    place(`${before}${inserted}${after.replace(/^\s+/, '')}`, [before.length + inserted.length, before.length + inserted.length]);
    onAddContext?.({ type: item.hit.ref.type, id: item.hit.ref.id, label, ...(item.hit.ref.href ? { href: item.hit.ref.href } : {}), via: 'explicit' });
  };

  const send = () => {
    const text = value.trim();
    if (!text || busy) return;
    dictation.stop();
    onSend(text);
    onEditEnd?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
        e.preventDefault();
        choose(items[active]);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(triggerKey);
        return;
      }
      if (menu) {
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        return;
      }
      if (onEscape) {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      }
      return;
    }
    if (e.key === 'ArrowUp' && !value && onEditLast && !e.shiftKey && !e.metaKey && !e.altKey) {
      const last = onEditLast();
      if (last !== null) {
        e.preventDefault();
        place(last, [last.length, last.length]);
      }
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // With text: send. Empty: let ⌘↵ reach the assistant (apply the focused proposal).
      if (value.trim()) {
        e.preventDefault();
        send();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const insertTrigger = (ch: '@' | '/') => {
    const el = ref.current;
    if (ch === '/') {
      if (!value.startsWith('/')) place(`/${value}`, [1, 1]);
      else place(value, [1, 1]);
      setDismissed(null);
      return;
    }
    const pos = el?.selectionStart ?? value.length;
    const pre = value.slice(0, pos);
    const sep = pre && !/\s$/.test(pre) ? ' ' : '';
    const next = `${pre}${sep}@${value.slice(pos)}`;
    place(next, [pre.length + sep.length + 1, pre.length + sep.length + 1]);
    setDismissed(null);
  };

  const activeId = items.length ? `${listId}-${active}` : undefined;
  const hasText = !!value.trim();

  const popover =
    open && (items.length || trigger?.kind === 'mention') ? (
      <div className={s.pop} role="listbox" id={listId} aria-label={trigger?.kind === 'command' ? 'Commands' : 'Mention'} data-chat-pop={trigger?.kind === 'command' ? 'slash' : 'mention'}>
        {trigger?.kind === 'command' ? (
          <>
            <div className={s.popH}>
              <span>Commands</span>
              <span>↑↓ move · ↵ insert · Esc close</span>
            </div>
            <div className={`${s.popList} ${variant === 'page' ? s.cols2 : ''}`}>
              {items.map((it, i) =>
                it.kind === 'command' ? (
                  <button
                    key={it.cmd.name}
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(it)}
                    onMouseEnter={() => setActive(i)}
                    className={s.popI}
                    data-cmd={it.cmd.name}
                  >
                    <CommandName cmd={it.cmd} />
                    <span className={s.h}>{it.cmd.hint}</span>
                  </button>
                ) : null,
              )}
            </div>
          </>
        ) : (
          <>
            <div className={s.popH}>
              <span>Mention</span>
              <span>↵ add · Esc close</span>
            </div>
            {!trigger?.query ? (
              <p className={s.popEmpty}>Type to find a person, item, account, initiative, session or file.</p>
            ) : groups.length ? (
              groups.map((g) => (
                <div key={g.type} role="group" aria-label={g.label}>
                  <div className={s.popG}>{g.label}</div>
                  <div className={s.popList}>
                    {g.hits.map((h) => {
                      const i = items.findIndex((it) => it.kind === 'mention' && it.hit.ref.id === h.ref.id && it.hit.ref.type === h.ref.type);
                      return (
                        <button
                          key={`${h.ref.type}:${h.ref.id}`}
                          id={`${listId}-${i}`}
                          type="button"
                          role="option"
                          aria-selected={i === active}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => choose(items[i])}
                          onMouseEnter={() => setActive(i)}
                          className={`${s.popI} ${s.one}`}
                          data-mention={h.ref.type}
                        >
                          <span className={s.n}>{h.title}</span>
                          {h.subtitle ? <span className={s.h}>{h.subtitle}</span> : <span />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            ) : (
              <p className={s.popEmpty}>{searching ? 'Searching…' : `Nothing matches “${trigger.query}”.`}</p>
            )}
          </>
        )}
      </div>
    ) : null;

  return (
    // Popovers anchor to the nearest positioned box: the page's 712 px column, or the panel's composer strip.
    <div ref={rootRef} className={variant === 'page' ? s.composerIn : undefined} data-chat-composer>
      {popover}
      {children}
      <div className={s.box} data-has-text={hasText || undefined}>
        {autoContext || explicitContext.length || restorable ? (
          <div className={s.ctx}>
            {autoContext ? (
              <span className={`${s.ctxChip} ${flash ? s.flash : ''}`} title="In view. Sent with your message." data-context-chip="auto">
                <span>Looking at:</span>
                <b>{autoContext.label}</b>
                {onRemoveAuto ? (
                  <button type="button" aria-label="Remove context" title="Remove" onClick={onRemoveAuto} data-ctx-remove>
                    <ChatIcon name="x" size={14} />
                  </button>
                ) : null}
              </span>
            ) : restorable && onRestoreAuto ? (
              <button type="button" className={s.reattach} onClick={onRestoreAuto} data-ctx-add>
                + Attach what you’re looking at
              </button>
            ) : null}
            {explicitContext.map((c) => (
              <span key={`${c.type}:${c.id}`} className={`${s.ctxChip} ${s.explicit}`} title={`${c.label}. Sent with your message.`} data-context-chip="explicit">
                <b>{c.label}</b>
                {onRemoveContext ? (
                  <button type="button" aria-label={`Remove ${c.label}`} title="Remove" onClick={() => onRemoveContext(c)}>
                    <ChatIcon name="x" size={14} />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
        {dictation.listening ? (
          <div className={s.rec} role="status">
            <span className={s.dotRec} aria-hidden /> Listening…
            <button type="button" onClick={dictation.stop}>
              Stop
            </button>
          </div>
        ) : null}
        {dictation.error ? <p className={s.err}>{dictation.error}</p> : null}
        <textarea
          ref={ref}
          value={value}
          rows={variant === 'page' ? 2 : 1}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            if (dismissed && !triggerAt(e.target.value, e.target.selectionStart ?? 0)) setDismissed(null);
            if (!e.target.value) onEditEnd?.();
          }}
          onKeyDown={onKeyDown}
          onSelect={syncCaret}
          onClick={syncCaret}
          placeholder={placeholder}
          aria-label="Message the assistant"
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? activeId : undefined}
          className={s.ta}
          data-chat-input
        />
        <div className={s.tb}>
          <button type="button" className={`${s.iconBtn} ${s.sm}`} onClick={() => insertTrigger('@')} aria-label="Mention (@)" title="Mention a person, item, account, session or file (@)" data-insert="@">
            <ChatIcon name="at" />
          </button>
          <button type="button" className={`${s.iconBtn} ${s.sm}`} onClick={() => insertTrigger('/')} aria-label="Commands (/)" title="Commands (/)" data-insert="/">
            <ChatIcon name="slash" />
          </button>
          <span style={{ position: 'relative' }}>
            <button
              type="button"
              className={`${s.iconBtn} ${s.sm}`}
              aria-label="Attach context"
              title="Attach what you're looking at, an item, a file or a person"
              aria-expanded={menu === 'attach'}
              aria-haspopup="menu"
              onClick={() => setMenu((m) => (m === 'attach' ? null : 'attach'))}
              data-composer-menu-trigger
            >
              <ChatIcon name="clip" />
            </button>
            {menu === 'attach' ? (
              <div className={s.menu} role="menu" style={{ bottom: 'calc(100% + 6px)', left: 0 }} data-composer-menu>
                <button
                  type="button"
                  role="menuitem"
                  className={`${s.popI} ${s.one}`}
                  disabled={!restorable && !autoContext}
                  onClick={() => {
                    onRestoreAuto?.();
                    setMenu(null);
                    ref.current?.focus();
                  }}
                >
                  <span className={s.n}>What you’re looking at</span>
                  <span className={s.h}>{autoContext ? 'attached' : (restorable?.label ?? 'nothing selected')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${s.popI} ${s.one}`}
                  onClick={() => {
                    setMenu(null);
                    insertTrigger('@');
                  }}
                >
                  <span className={s.n}>An item, account, person or file</span>
                  <span className={s.h}>@</span>
                </button>
              </div>
            ) : null}
          </span>
          <span className={s.sp} />
          {model && onModelChange ? (
            <span style={{ position: 'relative' }}>
              <button
                type="button"
                className={s.model}
                title="Model for new messages"
                aria-expanded={menu === 'model'}
                aria-haspopup="menu"
                onClick={() => setMenu((m) => (m === 'model' ? null : 'model'))}
                data-model={model}
                data-composer-menu-trigger
              >
                {model} <ChatIcon name="chev-d" size={14} />
              </button>
              {menu === 'model' ? (
                <div className={s.menu} role="menu" aria-label="Model" style={{ bottom: 'calc(100% + 6px)', right: 0 }} data-composer-menu>
                  {models.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="menuitemradio"
                      aria-checked={m === model}
                      className={`${s.popI} ${s.one} ${m === model ? s.on : ''}`}
                      onClick={() => {
                        onModelChange(m);
                        setMenu(null);
                        ref.current?.focus();
                      }}
                    >
                      <span className={s.n}>
                        {m === model ? '✓ ' : ''}Claude {m}
                      </span>
                      <span className={s.h}>{MODEL_NOTE[m]}</span>
                    </button>
                  ))}
                  <p className={s.menuNote}>For new messages in every thread.</p>
                </div>
              ) : null}
            </span>
          ) : null}
          <button
            type="button"
            className={`${s.iconBtn} ${s.sm} ${s.mic}`}
            onClick={dictation.toggle}
            disabled={!dictation.supported}
            aria-pressed={dictation.listening}
            aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'}
            title={dictation.supported ? 'Dictate' : 'Dictation isn’t available in this browser'}
            data-dictation
          >
            <ChatIcon name="mic" />
          </button>
          {busy ? (
            <button type="button" className={`${s.send} ${s.stop}`} onClick={onStop} aria-label="Stop the answer" title="Stop" data-stop>
              <ChatIcon name="stop" size={14} />
            </button>
          ) : (
            <button type="button" className={`${s.send} ${hasText ? s.ready : ''}`} onClick={send} disabled={!hasText} aria-label="Send (↵)" title="Send (↵)" data-send>
              <ChatIcon name="send" />
            </button>
          )}
        </div>
      </div>
      {suggestions.length ? (
        <div className={s.sugg} data-suggestions>
          {suggestions.map((t) => (
            <button
              key={t}
              type="button"
              className={`${s.chipBtn} ${t.startsWith('/') ? s.mono : ''}`}
              onClick={() => {
                place(t, [t.length, t.length]);
                setDismissed(t.startsWith('/') ? 'command:0' : null);
              }}
            >
              {t}
            </button>
          ))}
        </div>
      ) : null}
      {footnote ? (
        <div className={s.foot}>
          <span>
            Can change tasks, priorities, links and policy, with undo. <b>Never sends.</b>
          </span>
          <span className={s.keys}>
            <span>↵ send · ⇧↵ new line</span>
            {onEditLast ? <span>↑ edit last</span> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
