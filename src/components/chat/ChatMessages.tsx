'use client';
/**
 * The conversation (v2, mockups home-1-chat.html + chat.html):
 *   - the morning brief, collapsible to one line;
 *   - your messages in a neutral bubble ("↑ to edit" under the last one);
 *   - assistant turns: ✦ Assistant · time, one tool line, scan rows, prose at body size (≤ 68ch, live
 *     caret while streaming), evidence chips, then the cards: proposal → receipt, receipt, draft, session;
 *   - inline errors with Retry, and a list that sticks to the bottom while you're there.
 */
import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiErrorBody } from '@/contract';
import type { ChatMessageView } from '@/client/chat';
import { readString, writeString } from '@/client/chat/storage';
import { isStepLimitError } from '@/client/chat/turn';
import { Button } from '@/ui';
import { useAssistantSurface } from './assistant-context';
import { DraftCard, ScanRow, SessionCard } from './ChatActionCards';
import { ProposalPart } from './ChatProposalCard';
import { ReceiptPart } from './ChatReceiptCard';
import { SpendAskCard } from './SpendAskCard';
import { PlanCard } from './PlanCard';
import { EvidenceChips } from './ChatResourceCard';
import { EMPTY_SUGGESTIONS } from './commands';
import { fmtDate, fmtDayLong, fmtTime } from './format';
import { ChatIcon } from './icons';
import { renderMarkdown, withCaret } from './markdown';
import { briefSummary, scanViews, splitResources } from './thread-model';
import { ToolRows } from './ToolRows';
import { useChatUi } from './ui-context';
import s from './assistant.module.css';

const CARET = `<span class="${s.caret}" aria-hidden="true"></span>`;

/** Assistant prose: sanitized markdown at body size, ≤ 68ch, with a caret while it streams. */
export function MarkdownBubble({ text, streaming }: { text: string; streaming?: boolean; tone?: 'assistant' | 'brief' }) {
  const html = useMemo(() => {
    const h = renderMarkdown(text);
    return streaming ? withCaret(h, CARET) : h;
  }, [text, streaming]);
  return <div className={s.prose} aria-busy={streaming || undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A capped message's offer (ChatErrorDetails.allowMore): continue it once with this much more (ASSIST-2). */
export function allowMoreOf(error: ApiErrorBody): { usd: number; scope: 'message' | 'day' } | null {
  const a = (error.details as { allowMore?: { usd?: unknown; scope?: unknown } } | undefined)?.allowMore;
  return a && typeof a.usd === 'number' && a.usd > 0 && (a.scope === 'message' || a.scope === 'day') ? { usd: a.usd, scope: a.scope } : null;
}

export function InlineError({ error, onRetry }: { error: ApiErrorBody; onRetry?: (opts?: { allowExtraUsd?: number }) => void }) {
  const more = error.code === 'budget_exceeded' ? allowMoreOf(error) : null;
  const hint =
    error.code === 'upstream_unavailable'
      ? 'A connector or the model is unavailable. Nothing was changed.'
      : error.code === 'budget_exceeded'
        ? more?.scope === 'message'
          ? 'Allow more to let this answer finish: it continues from where it stopped (nothing already done is run again). It holds for the rest of this thread, and your limits stay as they are.'
          : more
            ? "Allow more for this thread, or raise today's limits (they go back to normal at midnight)."
            : 'The daily spend cap is reached.'
        : error.code === 'validation'
          ? 'The request was not valid.'
          : error.code === 'not_found'
            ? 'That thread or item no longer exists.'
            : null;
  return (
    <div role="alert" className={s.alert} data-chat-error={error.code}>
      <ChatIcon name="alert" />
      <div>
        <p className={s.t}>{error.message}</p>
        {hint ? <p className={s.s}>{hint}</p> : null}
      </div>
      {more?.scope === 'day' ? (
        <Link className={s.more} href="/settings?section=budgets" data-raise-today>
          Raise today&rsquo;s limits
        </Link>
      ) : null}
      {onRetry && more ? (
        <Button variant="secondary" size="sm" onClick={() => onRetry({ allowExtraUsd: more.usd })} data-allow-more={more.usd}>
          Allow ${more.usd.toFixed(2)} more
        </Button>
      ) : onRetry && error.retryable ? (
        <Button variant="secondary" size="sm" onClick={() => onRetry()} data-retry>
          {isStepLimitError(error) ? 'Continue' : 'Retry'}
        </Button>
      ) : null}
    </div>
  );
}

/** Quick replies under an answer (kept for compatibility; v2 shows suggestions under the composer). */
export function FollowUps({ items, onPick }: { items: string[]; onPick: (t: string) => void }) {
  if (!items.length) return null;
  return (
    <div className={s.sugg} data-followups>
      {items.map((t) => (
        <button key={t} type="button" onClick={() => onPick(t)} className={`${s.chipBtn} ${t.startsWith('/') ? s.mono : ''}`}>
          {t}
        </button>
      ))}
    </div>
  );
}

function CommandText({ text }: { text: string }) {
  const m = /^(\/[\w-]+)([\s\S]*)$/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      <b>{m[1]}</b>
      {m[2]}
    </>
  );
}

export function UserMessage({ m, timeZone, last, editing, showContext = true }: { m: ChatMessageView; timeZone?: string; last?: boolean; editing?: boolean; /** Off when it repeats the previous message's context. */ showContext?: boolean }) {
  const cmd = m.text.trim().startsWith('/');
  const ctx = showContext ? m.context.filter((c) => c.via === 'auto' || m.context.length === 1) : [];
  return (
    <article className={`${s.msg} ${s.user} ${editing ? s.editing : ''}`} data-role="user" data-message-id={m.id} data-last={last || undefined}>
      {ctx.length ? (
        <div className={s.ctxLine}>
          {ctx.map((c) => (
            <span key={`${c.type}:${c.id}`}>
              {c.via === 'auto' ? 'Looking at' : 'With'} <b>{c.label}</b>
            </span>
          ))}
        </div>
      ) : null}
      <div className={`${s.bubble} ${cmd ? s.cmd : ''} ${m.pending ? s.pending : ''}`}>{cmd ? <CommandText text={m.text} /> : m.text}</div>
      <span className={s.editHint}>{m.pending ? 'Sending…' : last ? `${fmtTime(m.at, timeZone)} · ↑ to edit` : fmtTime(m.at, timeZone)}</span>
    </article>
  );
}

const BRIEF_KEY = (id: string) => `cc.chat.brief:${id}`;

/** The morning brief: first message of the day's thread. Collapse leaves one line; it stays in the thread. */
export function BriefCard({ m }: { m: ChatMessageView }) {
  const ui = useChatUi();
  const [collapsed, setCollapsed] = useState(!!ui.defaults?.briefCollapsed);
  useEffect(() => {
    const saved = readString(BRIEF_KEY(m.id));
    if (saved) setCollapsed(saved === '1');
  }, [m.id]);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeString(BRIEF_KEY(m.id), next ? '1' : '0');
  };
  const { evidence } = splitResources(m.resources);
  return (
    <article className={`${s.msg} ${s.card} ${s.brief}`} data-role="assistant" data-message-id={m.id} data-brief data-collapsed={collapsed || undefined}>
      <header className={s.cardHead}>
        <span className={s.aiMark}>Morning brief</span>
        <span className={s.tm} title={fmtDate(m.at, ui.timeZone)}>
          {fmtTime(m.at, ui.timeZone)}
        </span>
        <Button variant="ghost" size="sm" onClick={toggle} aria-expanded={!collapsed} data-brief-toggle>
          {collapsed ? 'Expand' : 'Collapse'}
        </Button>
      </header>
      {collapsed ? (
        <p className={s.briefSum}>{briefSummary(m.text)}</p>
      ) : (
        <>
          <MarkdownBubble text={m.text} streaming={m.streaming} />
          <EvidenceChips resources={evidence} />
        </>
      )}
    </article>
  );
}

/** "claude-sonnet-5-5" → "Sonnet" (the receipt's model name). */
export function modelLabel(id: string | undefined): string | null {
  const k = /(haiku|sonnet|opus)/i.exec(id ?? '')?.[1];
  return k ? k[0]!.toUpperCase() + k.slice(1).toLowerCase() : id || null;
}

/** USD for the cost line: tenths of a cent under $0.10, cents above; a fraction of a tenth of a cent reads "<$0.001". */
export const fmtUsd = (n: number) => (n > 0 && n < 0.0005 ? '<$0.001' : `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`);

/**
 * ASSIST-9 (2026-11-20): what this answer costs. While it runs: the spend so far (`usage-delta`); once settled: the
 * receipt, model · $ actual, with what the stopped answer it continued cost beside it (ASSIST-2: paid once, shown both).
 */
export function costText(m: Pick<ChatMessageView, 'streaming' | 'spentUsd' | 'spentModel' | 'usage'>): string | null {
  if (m.usage) {
    const model = modelLabel(m.usage.model);
    const prior = m.usage.continuedFromUsd;
    const total = prior !== undefined ? ` (+ ${fmtUsd(prior)} before Allow more = ${fmtUsd(prior + m.usage.costUsd)})` : '';
    // Assistant v2 receipt: tier · steps · $
    const steps = m.usage.steps ? `${m.usage.steps} step${m.usage.steps === 1 ? '' : 's'} · ` : '';
    // W12-8: compaction is a model call of its own: say so beside the cost it adds (no hidden spend)
    const compacted = m.usage.summarizedTurns ? ` · summarised ${m.usage.summarizedTurns} turn${m.usage.summarizedTurns === 1 ? '' : 's'}` : '';
    return `${model ? `${model} · ` : ''}${steps}${fmtUsd(m.usage.costUsd)}${total}${compacted}`;
  }
  if (m.spentUsd !== undefined) return `${m.spentModel ? `${modelLabel(m.spentModel)} · ` : ''}${fmtUsd(m.spentUsd)}${m.streaming ? ' so far' : ''}`;
  return null;
}

/** Assistant v2: which tier answered and why ("Haiku · a lookup"; "Sonnet · you chose Sonnet"). */
export function RouteChip({ m }: { m: Pick<ChatMessageView, 'route'> }) {
  if (!m.route) return null;
  const label = modelLabel(m.route.model);
  const why = m.route.why;
  return (
    <span className="rounded-full border border-line px-1.5 text-caption text-muted" title={m.route.override ? 'Your choice (the composer menu or Settings ▸ Budgets)' : `Auto routing: ${why}`} data-chat-route={m.route.tier}>
      {label} · {why}
    </span>
  );
}

export function CostLine({ m }: { m: ChatMessageView }) {
  // the route chip already names the model: the cost line keeps steps and $
  const t0 = costText(m);
  const t = t0 && m.route ? t0.replace(/^(Haiku|Sonnet|Opus) · /, '') : t0;
  if (!t) return null;
  return (
    <span className="tabular-nums" data-chat-cost={m.usage ? 'final' : 'live'} title={m.usage ? 'What this answer cost (the model and any research it ran)' : 'Spent so far on this answer'}>
      · {t}
    </span>
  );
}

export function AssistantMessage({ m, latest }: { m: ChatMessageView; latest: boolean }) {
  const ui = useChatUi();
  const surface = useAssistantSurface();
  if (m.isMorningBrief) return <BriefCard m={m} />;
  const waiting = m.streaming && !m.text && !m.tools.length && !(m.plans ?? []).length;
  const { drafts, sessions, evidence } = splitResources(m.resources);
  const scans = scanViews(m.tools);
  const consumed = new Set(scans.flatMap((x) => x.consumed));
  const lineTools = consumed.size ? m.tools.filter((t) => !consumed.has(t.id)) : m.tools;
  const empty = !m.streaming && !m.text && !scans.length && !m.receipts.length && !m.proposals.length && !m.resources.length && !(m.plans ?? []).length && !m.error && !m.stopped;
  const changed = m.receipts.length > 0 || m.proposals.length > 0;
  return (
    <article className={s.msg} data-role="assistant" data-message-id={m.id} data-streaming={m.streaming || undefined} data-status={m.status}>
      <div className={s.msgMeta}>
        <span className={s.who}>Assistant</span>
        <span>{fmtTime(m.at, ui.timeZone)}</span>
        <RouteChip m={m} />
        <CostLine m={m} />
        {m.status === 'reconnecting' ? <span className={s.err}>· Reconnecting…</span> : null}
      </div>
      {(m.plans ?? []).map((pl) => (
        <PlanCard key={pl.id} plan={pl} live={m.streaming} />
      ))}
      <ToolRows tools={lineTools} live={m.streaming} changed={changed} />
      {scans.map((x) => (
        <ScanRow key={x.id} scan={x} />
      ))}
      {waiting ? (
        <span className={s.thinking} role="status">
          <span className={s.dotPulse} aria-hidden /> Thinking…
        </span>
      ) : m.text ? (
        <MarkdownBubble text={m.text} streaming={m.streaming} />
      ) : null}
      <EvidenceChips resources={evidence} onOpenItem={(r) => surface.openItem({ id: r.id, label: r.label })} />
      {m.proposals.map((p) => (
        <ProposalPart key={p.proposal.id} proposal={p.proposal} summary={p.summary} receipt={p.receipt} />
      ))}
      {m.receipts.map((r) => (
        <ReceiptPart key={r.id} receipt={r} />
      ))}
      {drafts.map((r) => (
        <DraftCard key={r.id} resource={r} />
      ))}
      {sessions.map((r) => (
        <SessionCard key={r.id} resource={r} />
      ))}
      {m.spendAsk && m.streaming ? <SpendAskCard ask={m.spendAsk} onFallback={latest ? (usd) => ui.retry({ allowExtraUsd: usd }) : undefined} /> : null}
      {m.error ? <InlineError error={m.error} onRetry={latest ? ui.retry : undefined} /> : null}
      {m.stopped && !m.error ? <p className={s.note}>Stopped. Anything already changed is on the card above, with Undo.</p> : null}
      {empty ? (
        <p className={s.note}>
          No answer came back{m.tools.some((t) => t.ok === false) ? ': a tool failed' : ''}.{' '}
          {latest ? (
            <button type="button" onClick={() => ui.retry()} className={s.more}>
              Ask again
            </button>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

export function ChatEmptyState({ onPick, title = 'Ask about your day, re-prioritize, or find what the app missed.' }: { onPick: (t: string) => void; title?: string }) {
  return (
    <div className={s.empty} data-chat-empty>
      <span className={s.aiMark}>Assistant</span>
      <h3>{title}</h3>
      <p>Changes to tasks, priorities and policy come back as a card you can undo. Nothing is sent from here.</p>
      <div className={s.sugg} style={{ marginTop: 0 }}>
        {EMPTY_SUGGESTIONS.map((t) => (
          <button key={t} type="button" onClick={() => onPick(t)} className={`${s.chipBtn} ${t.startsWith('/') ? s.mono : ''}`}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className={s.skel} aria-hidden data-chat-skeleton>
      {[72, 44, 88].map((w, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: i === 1 ? 'flex-end' : 'flex-start' }}>
          <span className={s.skelLine} style={{ width: `${w}%` }} />
          <span className={s.skelLine} style={{ width: `${w / 2}%` }} />
        </div>
      ))}
    </div>
  );
}

export interface MessageListProps {
  messages: ChatMessageView[];
  loading?: boolean;
  error?: { message: string } | null;
  onReload?: () => void;
  empty?: ReactNode;
  className?: string;
  /** page = the 760 px reading column of /assistant. */
  variant?: 'panel' | 'page';
  /** The user message being edited (↑): outlined. */
  editingId?: string | null;
  /** Scroll this message into view on first render (`?at=<id>`), instead of the bottom. */
  anchor?: string | null;
}

export function MessageList({ messages, loading, error, onReload, empty, className = '', variant = 'panel', editingId, anchor }: MessageListProps) {
  const ui = useChatUi();
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const anchored = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const last = messages.at(-1);
  const signature = `${messages.length}:${last?.id}:${last?.text.length}:${last?.tools.length}:${last?.plans?.length ?? 0}:${last?.receipts.length}:${last?.proposals.length}:${last?.resources.length}:${last?.error ? 1 : 0}`;

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (pinned.current) setShowJump(false);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (anchor && !anchored.current && messages.length) {
      const target = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor)}"]`);
      if (target) {
        anchored.current = true;
        pinned.current = false;
        el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 16;
        return;
      }
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // A new outgoing message always brings you to the bottom (not the first load of an anchored thread).
  const lastUserId = [...messages].reverse().find((m) => m.role === 'user')?.id;
  const prevUser = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevUser.current;
    prevUser.current = lastUserId;
    if (!lastUserId || lastUserId === prev) return;
    if (anchored.current && prev === undefined) return;
    pinned.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastUserId]);

  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf('assistant');
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
  // "Looking at X" only when it changes from your previous message.
  const ctxKey = (m: ChatMessageView) => m.context.map((c) => `${c.type}:${c.id}`).join(',');
  const showCtx = new Set<string>();
  let prevCtx = '';
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const k = ctxKey(m);
    if (k && k !== prevCtx) showCtx.add(m.id);
    prevCtx = k;
  }
  const list = (
    <div className={s.thread}>
      {loading ? <Skeleton /> : null}
      {error ? <InlineError error={{ code: 'internal', message: `Couldn't load this thread: ${error.message}`, retryable: true }} onRetry={onReload} /> : null}
      {!loading && !error && !messages.length ? (empty ?? <ChatEmptyState onPick={ui.followUp} />) : null}
      {variant === 'page' && messages.length ? <div className={s.daySep}>{fmtDayLong(messages[0].at, ui.timeZone)}</div> : null}
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <UserMessage key={m.id} m={m} timeZone={ui.timeZone} last={i === lastUserIdx} editing={editingId === m.id} showContext={showCtx.has(m.id)} />
        ) : (
          <AssistantMessage key={m.id} m={m} latest={i === lastAssistantIdx && i >= messages.length - 1} />
        ),
      )}
    </div>
  );
  return (
    <div className={`${s.listWrap} ${className}`}>
      <div ref={ref} onScroll={onScroll} className={variant === 'page' ? s.cvScroll : s.scroll} role="log" aria-live="polite" aria-relevant="additions text" data-chat-messages>
        {variant === 'page' ? <div className={s.cvCol}>{list}</div> : list}
      </div>
      {showJump ? (
        <button
          type="button"
          className={s.jump}
          onClick={() => {
            const el = ref.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            pinned.current = true;
            setShowJump(false);
          }}
        >
          <ChatIcon name="chev-d" size={14} /> Latest
        </button>
      ) : null}
    </div>
  );
}
