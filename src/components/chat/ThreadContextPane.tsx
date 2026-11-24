'use client';
/**
 * "In this thread" (v2 full page, mockup chat.html): everything the thread touched — changes, items,
 * drafts, sessions, scans, sources — each with its live state and one quiet action, so you scan it
 * instead of scrolling back. The footer keeps your hands-on time and agent time apart: agent time runs
 * in the background and never counts against your day (DESIGN-V2, capacity).
 */
import { AppLink } from '@/components/shell/AppLink';
import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import type { ChatResource, WorkItem } from '@/contract';
import { api, queryKey } from '@/client/api';
import { undoStateOf, type ChatMessageView } from '@/client/chat';
import { useApi } from '@/client/hooks';
import { Button } from '@/ui';
import { destinationShort } from '@/components/composer/destination';
import { useAssistantSurface } from './assistant-context';
import { needsReview, OPEN_IN_CLAUDE_LABEL, REVIEW_PROMPT_LABEL, useLaunchReview } from '@/components/agents/LaunchReview';
import { openDeepLink } from './ChatActionCards';
import { fieldLabel, fmtTime } from './format';
import { fmtMin, threadTouched, touchedCount, withPersistedUndo, type TouchedChange } from './thread-model';
import { useChatUi } from './ui-context';
import { useReveal } from './card-parts';
import s from './assistant.module.css';

const SOURCE_WORD: Partial<Record<string, string>> = { calendar_event: 'Calendar', brief: 'Brief', policy: 'Policy', asset: 'File', file: 'File', url: 'Link', account: 'Account', opportunity: 'Opportunity', person: 'Person', initiative: 'Initiative' };

function itemLine(i: WorkItem, tz?: string): string {
  const bits: string[] = [];
  if (i.state === 'done') bits.push('Done');
  else if (i.rank) bits.push(`#${i.rank}`);
  if (i.startBy && i.state !== 'done') bits.push(`start by ${fmtTime(i.startBy, tz)}`);
  else if (i.due && i.state !== 'done') bits.push(`due ${fmtTime(i.due, tz)}`);
  if (i.effort.youMin) bits.push(`you ~${fmtMin(i.effort.youMin)}`);
  return bits.join(' · ');
}

/** "rank and snooze": what a change set touched, in words. */
function changeFields(c: TouchedChange): string | null {
  const changes = c.receipt?.changes.length ? c.receipt.changes : (c.proposal?.changes ?? []);
  const words = [...new Set(changes.map((x) => fieldLabel(x.field, x.label).toLowerCase()))];
  if (!words.length) return null;
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function ItemRow({ id, label, item, loading }: { id: string; label: string; item?: WorkItem; loading?: boolean }) {
  const ui = useChatUi();
  const surface = useAssistantSurface();
  const snoozed = item?.snoozedUntil && item.state === 'snoozed';
  return (
    <li className={s.cxIt} data-cx-item={id}>
      <span className={s.t}>{item?.title ?? label}</span>
      <span className={s.s}>
        {snoozed ? <span className={s.badge}>◷ Snoozed until {fmtTime(item.snoozedUntil, ui.timeZone)}</span> : null}
        {item ? itemLine(item, ui.timeZone) : loading ? 'Loading…' : 'Not found'}
      </span>
      <Button variant="ghost" size="sm" onClick={() => surface.openItem({ id, label: item?.title ?? label })}>
        Open
      </Button>
    </li>
  );
}

function DraftRow({ resource }: { resource: ChatResource }) {
  const surface = useAssistantSurface();
  const q = useApi('getDraft', { params: { id: resource.id } }, { staleTime: 15_000 });
  const d = q.data;
  const where = d ? `${d.destination.kind === 'slack' ? 'Slack' : 'Gmail'} · ${destinationShort(d.destination)}` : null;
  const state = !d ? (q.isError ? 'Couldn’t load' : 'Loading…') : d.status === 'ready' ? 'in the Outbox' : d.status === 'drafting' ? (surface.openDraftId === d.id ? 'in the composer · not in Outbox' : 'not in Outbox') : d.status.replace(/_/g, ' ');
  return (
    <li className={s.cxIt} data-cx-draft={resource.id}>
      <span className={s.t}>{resource.label}</span>
      <span className={s.s}>{[where, state].filter(Boolean).join(' · ')}</span>
      {d && d.status === 'drafting' && surface.addToOutbox ? (
        <Button variant="ghost" size="sm" onClick={() => void surface.addToOutbox?.(d)}>
          Add to Outbox
        </Button>
      ) : d ? (
        <Button variant="ghost" size="sm" onClick={() => surface.openDraft(d)}>
          Open
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}

export function SessionRow({ resource }: { resource: ChatResource }) {
  const agents = useApi('getAgents', undefined, { staleTime: 10_000 });
  const run = agents.data?.runs.find((r) => r.id === resource.id);
  // SEC-10: a prepared session (claude://code/new) shows Review prompt first, as the thread's session card does (exported for its test)
  const { review, dialog } = useLaunchReview(openDeepLink);
  const since = run?.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(run.startedAt)) / 60_000)) : null;
  const line = !run
    ? agents.isPending
      ? 'Loading…'
      : 'Not found'
    : run.state === 'running'
      ? `Running${since !== null ? ` · ${fmtMin(since)}` : ''} · waiting on you: no`
      : run.state === 'waiting_on_you'
        ? `Waiting on you · ${run.waiting?.reason ?? 'input needed'}`
        : run.state === 'done_review'
          ? 'Done · ready for review'
          : run.state === 'queued'
            ? 'Ready · opens when you click'
            : run.state.replace(/_/g, ' ');
  const dot = run?.state === 'running' ? s.run : run?.state === 'waiting_on_you' || run?.state === 'stale' ? s.warn : run?.state === 'failed' ? s.bad : run?.state.startsWith('done') ? s.good : '';
  return (
    <li className={s.cxIt} data-cx-session={resource.id}>
      <span className={s.t}>{run?.title ?? resource.label}</span>
      <span className={s.s}>
        <span className={`${s.dot} ${dot}`} aria-hidden />
        <span>{line}</span>
      </span>
      {run?.deepLink ? (
        <Button variant="ghost" size="sm" onClick={() => review(run.deepLink!, run.title)} data-open-claude={needsReview(run.deepLink) ? 'review' : 'open'}>
          {needsReview(run.deepLink) ? REVIEW_PROMPT_LABEL : OPEN_IN_CLAUDE_LABEL}
        </Button>
      ) : (
        <AppLink href={resource.href} className={s.more}>
          Open
        </AppLink>
      )}
      {dialog}
    </li>
  );
}

export function ThreadContextPane({ messages, className = '' }: { messages: ChatMessageView[]; className?: string }) {
  const ui = useChatUi();
  const surface = useAssistantSurface();
  const t = threadTouched(messages, ui.actions);
  const total = touchedCount(t);
  // caps audit F-13: six items, three agent lines and six sources first; Show more reaches every one
  const itemReveal = useReveal(t.itemIds.length, 6);
  const sourceReveal = useReveal(t.sources.length, 6);
  const [allAgents, setAllAgents] = useState(false);
  const itemIds = t.itemIds.slice(0, itemReveal.shown);
  const items = useQueries({
    queries: itemIds.map((x) => ({
      queryKey: queryKey('getItem', { params: { id: x.id } }),
      queryFn: ({ signal }: { signal: AbortSignal }) => api('getItem', { params: { id: x.id } }, { signal }),
      staleTime: 15_000,
    })),
  });
  const today = useApi('getToday', undefined, { staleTime: 60_000 });
  const agents = useApi('getAgents', undefined, { staleTime: 10_000, enabled: t.sessions.length > 0 });

  const loaded = items.map((q) => q.data?.item).filter((x): x is WorkItem => !!x);
  const youMin = loaded.filter((i) => i.state !== 'done').reduce((n, i) => n + i.effort.youMin, 0);
  const agentAll = [
    ...loaded.filter((i) => i.effort.agentMin > 0 && i.state !== 'done').map((i) => `${i.title} ~${fmtMin(i.effort.agentMin)}`),
    ...t.sessions.map((r) => agents.data?.runs.find((x) => x.id === r.id)).filter((r) => r && (r.state === 'running' || r.state === 'queued')).map((r) => `${r!.title}, running`),
  ];
  const agentLines = allAgents ? agentAll : agentAll.slice(0, 3);
  // CAPACITY: today-scoped hands-on minutes, what's still open, and agent time running in parallel.
  const cap = today.data?.header.capacity;

  return (
    <aside className={`${s.pane} ${s.cx} ${className}`} aria-label="In this thread" data-thread-context>
      <header className={s.cxHead}>
        <h2>In this thread</h2>
        <span className={s.count}>{total}</span>
      </header>

      {!total ? <p className={s.cxEmpty}>Nothing yet. Changes, items, drafts, sessions and scans this thread touches show up here, each with one action.</p> : null}

      {t.changes.length || t.pending.length ? (
        <section className={s.cxGroup}>
          <h3>Changes</h3>
          <ul className={s.cxList}>
            {t.pending.map((p) => (
              <li key={p.proposal.id} className={s.cxIt} data-cx-pending={p.proposal.id}>
                <span className={s.t}>
                  1 proposal waiting · {p.proposal.changes.length} change{p.proposal.changes.length === 1 ? '' : 's'}
                </span>
                <span className={s.s}>
                  <span className={s.aiMark}>Proposed</span> · nothing changes until you apply
                </span>
                <Button variant="ghost" size="sm" onClick={() => surface.scrollToMessage(p.messageId)}>
                  Review
                </Button>
              </li>
            ))}
            {t.changes.map((c) => {
              const actions = c.kind === 'receipt' && c.receipt ? withPersistedUndo(c.receipt, ui.actions) : ui.actions;
              const live = c.auditIds.filter((id) => undoStateOf(actions, id).status !== 'undone');
              const pending = c.auditIds.some((id) => undoStateOf(actions, id).status === 'pending');
              return (
                <li key={c.key} className={s.cxIt} data-cx-change={c.key}>
                  <span className={s.t}>{live.length ? `${c.count} change${c.count === 1 ? '' : 's'} applied` : 'Undone'}</span>
                  <span className={s.s}>
                    {live.length ? <span className={s.good}>✓</span> : null}
                    <span>
                      {fmtTime(c.at, ui.timeZone)} · {changeFields(c) ?? c.title}
                    </span>
                  </span>
                  {live.length ? (
                    <Button variant="ghost" size="sm" kbd="z" loading={pending} onClick={() => ui.undo([...live].reverse())} data-undo>
                      Undo
                    </Button>
                  ) : (
                    <span />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {itemIds.length ? (
        <section className={s.cxGroup}>
          <h3>
            Items <span>{t.itemIds.length}</span>
          </h3>
          <ul className={s.cxList}>
            {itemIds.map((x, i) => (
              <ItemRow key={x.id} id={x.id} label={x.label} item={items[i]?.data?.item} loading={items[i]?.isPending} />
            ))}
          </ul>
          {itemReveal.control}
        </section>
      ) : null}

      {t.drafts.length ? (
        <section className={s.cxGroup}>
          <h3>Drafts</h3>
          <ul className={s.cxList}>
            {t.drafts.map((r) => (
              <DraftRow key={r.id} resource={r} />
            ))}
          </ul>
        </section>
      ) : null}

      {t.sessions.length ? (
        <section className={s.cxGroup}>
          <h3>Sessions</h3>
          <ul className={s.cxList}>
            {t.sessions.map((r) => (
              <SessionRow key={r.id} resource={r} />
            ))}
          </ul>
        </section>
      ) : null}

      {t.scans.length ? (
        <section className={s.cxGroup}>
          <h3>Scans</h3>
          <ul className={s.cxList}>
            {t.scans.map((x) => (
              <li key={x.id} className={s.cxIt} data-cx-scan={x.id}>
                <span className={s.t}>
                  {x.source}
                  {x.window ? ` · ${x.window}` : ''}
                </span>
                <span className={s.s}>
                  {x.status === 'running' ? 'Scanning…' : x.status === 'failed' ? <span className={s.bad}>✕ {x.title}</span> : `✓ Done ${fmtTime(x.at, ui.timeZone)} · ${x.title}`}
                </span>
                <AppLink href={x.status === 'failed' ? '/health' : '/triage'} className={s.more}>
                  {x.status === 'failed' ? 'Open Health' : 'Open in Triage'}
                </AppLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {t.sources.length ? (
        <section className={s.cxGroup}>
          <h3>Sources cited</h3>
          <ul className={s.cxList}>
            {t.sources.slice(0, sourceReveal.shown).map((r) => {
              const ext = /^https?:\/\//i.test(r.href);
              return (
                <li key={`${r.kind}:${r.id}`} className={s.cxIt}>
                  <span className={s.t}>{r.label}</span>
                  <span className={s.s}>{SOURCE_WORD[r.kind] ?? 'Link'}</span>
                  {ext ? (
                    <a href={r.href} target="_blank" rel="noopener noreferrer" className={s.more}>
                      Open ↗
                    </a>
                  ) : (
                    <AppLink href={r.href} className={s.more}>
                      Open
                    </AppLink>
                  )}
                </li>
              );
            })}
          </ul>
          {sourceReveal.control}
        </section>
      ) : null}

      <div className={s.cxTime} data-cx-time>
        {cap ? (
          <span>
            Your time today <b>≈ {fmtMin(cap.youMinToday)}</b> · {cap.openMin >= 0 ? `~${fmtMin(cap.openMin)} open` : `over by ${fmtMin(-cap.openMin)}`}
          </span>
        ) : null}
        {loaded.length ? (
          <span>
            On this thread’s items <b>≈ {fmtMin(youMin)}</b>
          </span>
        ) : null}
        <span className={s.bg}>
          {agentLines.length ? (
            <>
              {`✦ Agent time, in the background: ${agentLines.join(' · ')}`}
              {agentAll.length > 3 ? (
                <button type="button" className={s.more} onClick={() => setAllAgents((v) => !v)} data-agents-more>
                  {allAgents ? 'Show fewer' : `Show all ${agentAll.length}`}
                </button>
              ) : null}
            </>
          ) : cap?.agentRunsBackground
              ? `✦ Agent: ${cap.agentRunsBackground} run${cap.agentRunsBackground === 1 ? '' : 's'} in the background (~${fmtMin(cap.agentMinBackground)})`
              : '✦ Agent time runs in the background and never counts against your day.'}
        </span>
      </div>
    </aside>
  );
}
