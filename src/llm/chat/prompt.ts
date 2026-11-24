/**
 * Chat prompt (Assistant v2, lane 05 §5.3 "keep the system prompt byte-stable"). Layout:
 *
 *   systemPrompt = [ skills/chat-assistant.md body                        ← static, byte-stable (cached)
 *                  , SYSTEM_PROMPT_DYNAMIC_BOUNDARY
 *                  , persona block + which live sources this persona has ]  ← stable per persona (cached across turns)
 *   prompt       = ## Now · ## Looking at · ## Context pack (compact) · ## Remembered (pinned notes, preferences)
 *                  [ ## Thread so far: only when the SDK session can't be resumed, rebuilt from the stored history with
 *                    older turns replaced by their compaction summary ]
 *                  ## Message
 *
 * Nothing per turn sits before the boundary, so a resumed session pays cache reads for the skill, the tools and the
 * whole earlier thread, and writes only the new turn. Every dynamic string is credential-redacted.
 */
import type { ChatMemoryEntry, ChatMessage, ChatRoute, ContextRef } from '@/contract';
import { renderPersonaBlock, type ResolvedPersona } from '@/personas';
import { redactText } from '../redact';
import { stoppedAtStepLimit } from './router';
import { loadSkill } from '../skill-loader';

export const CHAT_SKILL_PATH = 'skills/chat-assistant.md';

export function loadChatSkill(repoRoot?: string, skillPath = CHAT_SKILL_PATH) {
  return loadSkill(skillPath, repoRoot);
}

/** "2026-11-05T09:12:00-08:00" in `tz` (the offset the model must use for times). */
export function localIso(d: Date, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const off = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** One line per card a message produced, so the model knows what is pending, applied or prepared. */
function partLines(m: ChatMessage): string[] {
  const out: string[] = [];
  for (const p of m.parts ?? []) {
    switch (p.type) {
      case 'proposal':
        out.push(`[proposal ${p.proposal.id} ${p.status ?? p.proposal.status}: ${p.summary ?? p.proposal.reason}]`);
        for (const c of p.proposal.changes) out.push(`  - ${c.label ?? c.field}: ${lineValue(c.before)} → ${lineValue(c.after)}`);
        break;
      case 'receipt': {
        out.push(`[receipt: ${p.receipt.summary}${p.receipt.changes.some((c) => c.undoneAt) ? ' (undone)' : ''}]`);
        for (const f of p.receipt.failed ?? []) out.push(`  - failed: ${f.label}: ${f.reason}`);
        break;
      }
      case 'plan':
        out.push(`[plan ${p.plan.id} ${p.plan.status}: ${p.plan.steps.map((s) => s.what).join('; ')}]`);
        break;
      case 'tool':
        out.push(`[${p.name}: ${p.summary}]`);
        break;
      case 'resource': {
        const c = p.card;
        if (c?.kind === 'draft') out.push(`[draft ${c.draft.draftId} to ${c.draft.to}: ${c.draft.status}, not sent]`);
        else if (c?.kind === 'session') out.push(`[session ${c.session.id} prepared in ${c.session.folder}, not opened]`);
        else out.push(`[link: ${p.resource.label}]`);
        break;
      }
      case 'error':
        out.push(`[error: ${p.error.message}]`);
        break;
      default:
        break;
    }
  }
  return out;
}

const lineValue = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

/** One message as the rebuilt thread shows it: whole (Assistant v2: no per-message cut; compaction bounds the thread). */
export function renderMessage(m: ChatMessage): string {
  const who = m.role === 'user' ? 'User' : 'Assistant';
  const body = [redactText(m.text || (m.role === 'assistant' ? '(no text)' : '')), ...partLines(m).map(redactText)].filter(Boolean).join('\n');
  return `${who}: ${body}`;
}

/** The thread so far, whole, oldest first. */
export function renderHistory(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role !== 'system')
    .map(renderMessage)
    .join('\n\n');
}

/** A rough token count for text (4 characters a token): the compaction trigger's measure. */
export const approxTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * The compaction trigger (no arbitrary cap: a real price limit). A rebuilt thread stays under half of Haiku 5.5's
 * long-prompt price tier (100K prompt tokens, 5× above it; src/llm/models.ts), so the rest of the turn (skill, tools,
 * tool results) never pushes a fast-tier turn into the long tier. Older turns are summarized into `chat_memory`; the
 * latest turns and every pinned note stay whole.
 */
export const COMPACT_AT_TOKENS = 50_000;
/** Turns kept whole after a compaction (the recent context the next answer leans on). */
export const COMPACT_KEEP_RECENT = 6;

/**
 * The stored thread with older turns replaced by the newest summary that covers them. `needs` = what to summarize next
 * (the messages after the summary but before the recent ones) when the rebuilt thread is over the trigger.
 */
export function compactedHistory(messages: ChatMessage[], memory: ChatMemoryEntry[], o: { compactAt?: number; keepRecent?: number } = {}): { text: string; tokens: number; summaryId: string | null; needs: { from: number; to: number; messages: ChatMessage[] } | null } {
  const visible = messages.filter((m) => m.role !== 'system');
  const summary = memory.filter((e) => e.kind === 'summary' && e.coversThroughSeq !== null).sort((a, b) => (b.coversThroughSeq ?? 0) - (a.coversThroughSeq ?? 0))[0];
  const from = summary ? Math.min(visible.length, (summary.coversThroughSeq ?? -1) + 1) : 0;
  const rest = visible.slice(from);
  const head = summary ? `Summary of the earlier conversation (messages 1-${from}):\n${redactText(summary.text)}` : '';
  const text = [head, renderHistory(rest)].filter(Boolean).join('\n\n');
  const tokens = approxTokens(text);
  const keep = o.keepRecent ?? COMPACT_KEEP_RECENT;
  const over = tokens > (o.compactAt ?? COMPACT_AT_TOKENS) && rest.length > keep;
  return { text, tokens, summaryId: summary?.id ?? null, needs: over ? { from, to: visible.length - keep - 1, messages: visible.slice(from, visible.length - keep) } : null };
}

export function renderLookingAt(context: ContextRef[]): string | null {
  if (!context.length) return null;
  const auto = context.find((c) => c.via === 'auto');
  return context.map((c) => `- ${c.type} ${c.id}: ${redactText(c.label)}${c === auto ? ' (looking at)' : ''}`).join('\n');
}

/**
 * The compact context pack (Assistant v2): who, the counts, the top of the list, today's meetings, what is broken.
 * The rest is one `query` away, so it is not re-sent every turn.
 */
export function compactPack(pack: Record<string, unknown>): Record<string, unknown> {
  const t = (pack.today ?? {}) as { top3?: Array<{ id: string; title: string; rank?: number | null; due?: string | null; startBy?: string | null }>; moreTodayCount?: number; triageCount?: number; navCounts?: Record<string, unknown> };
  const cal = (pack.calendar ?? []) as Array<{ id?: string; title?: string; start?: string; end?: string; account?: string | null }>;
  const health = (pack.health ?? {}) as { broken?: Array<{ id: string; label: string; state: string }>; spend?: unknown; workerAlive?: boolean };
  const outbox = (pack.outbox ?? {}) as { dryRun?: boolean; counts?: unknown };
  return {
    me: pack.me ?? null,
    top3: (t.top3 ?? []).map((x) => ({ id: x.id, title: x.title, rank: x.rank ?? null, due: x.due ?? null, startBy: x.startBy ?? null })),
    counts: { moreToday: t.moreTodayCount ?? null, triage: t.triageCount ?? null, ...(t.navCounts ?? {}) },
    meetingsToday: cal.map((e) => ({ id: e.id, title: e.title, start: e.start, account: e.account ?? null })),
    outbox: { dryRun: outbox.dryRun ?? null, counts: outbox.counts ?? null },
    broken: (health.broken ?? []).map((c) => ({ id: c.id, label: c.label, state: c.state })),
    workerAlive: health.workerAlive ?? null,
  };
}

/** One line per live source the turn can read (or that it can't). Deterministic per persona: before the boundary. */
export function renderLiveReads(r: { live: boolean; sources: string[] }): string {
  if (!r.live) return "No live reads in this mode (the app's own data only): search and fetch on slack, gmail, drive, calendar, org62 and vdp say \"not available here\". Say so when it matters.";
  return `Live sources (search, fetch; read only): ${r.sources.join(', ')}. Org62 only through find/name/account (the app builds the SELECT).`;
}

export interface ChatPromptInput {
  skillBody: string;
  pack: Record<string, unknown>;
  context: ContextRef[];
  text: string;
  now: Date;
  timezone: string;
  persona?: ResolvedPersona | null;
  reads?: { live: boolean; sources: string[] };
  /** Pinned notes and preferences (memory). */
  remembered?: ChatMemoryEntry[];
  /** The rebuilt thread (no resumable session); absent when the session resumes. */
  history?: string | null;
  route?: ChatRoute | null;
  /** ASSIST-2: a stopped answer this turn continues ("Allow more"). */
  continuation?: ChatMessage | null;
}

/** Why the stopped answer stopped, in the continuation's first line: Steps per message (P31-1, "continue") or the cost limit ("Allow more"). */
export const CONTINUE_AFTER_STEP_LIMIT = 'Your previous answer stopped at your Steps per message limit before it finished. The user said continue: continue it from where it stopped. Do not start over.';
export const CONTINUE_AFTER_COST_LIMIT = 'Your previous answer stopped at its cost limit before it finished. The user allowed more: continue it from where it stopped. Do not start over.';

/** ASSIST-2: the stopped answer a continuation picks up, whole: its text and every tool call with its recorded result. */
export function renderContinuation(m: ChatMessage): string {
  const tools = (m.parts ?? []).filter((p): p is Extract<ChatMessage['parts'][number], { type: 'tool' }> => p.type === 'tool');
  const head = stoppedAtStepLimit(m) ? CONTINUE_AFTER_STEP_LIMIT : CONTINUE_AFTER_COST_LIMIT;
  const lines = [head, '', '### What you wrote so far', redactText(m.text || '(nothing yet)')];
  if (tools.length) {
    lines.push('', '### Calls you made, with their results as recorded');
    for (const t of tools) lines.push(`- ${t.name} (${redactText(t.args ?? t.summary)}): ${t.ok === false ? 'failed: ' : ''}${redactText(t.result ?? t.summary)}`);
  }
  return lines.join('\n');
}

export function buildChatPrompt(i: ChatPromptInput, boundary: string): { systemPrompt: string[]; prompt: string } {
  const stable = [...(i.persona ? [renderPersonaBlock(i.persona)] : []), ...(i.reads ? [`## Live reads\n${renderLiveReads(i.reads)}`] : [])].join('\n\n');
  const looking = renderLookingAt(i.context);
  const remembered = (i.remembered ?? []).filter((e) => e.kind !== 'summary' && (e.pinned || e.kind === 'preference' || e.threadId !== null));
  const header = [
    `## Now\n${localIso(i.now, i.timezone)} (${i.timezone})`,
    looking ? `## Looking at\n${looking}` : '## Looking at\n(nothing in focus)',
    `## Context pack (JSON)\n${JSON.stringify(compactPack(i.pack))}`,
    ...(remembered.length ? [`## Remembered\n${remembered.map((e) => `- ${e.kind === 'preference' ? 'preference' : 'note'}${e.pinned ? ' (pinned)' : ''}: ${redactText(e.text)}`).join('\n')}`] : []),
    ...(i.route ? [`## Route\n${i.route.intent} on ${i.route.model}${i.route.intent === 'research' ? ': plan first (plan), then run' : ''}`] : []),
  ];
  const prompt = [...header, i.history ? `## Thread so far\n${i.history}` : '', i.continuation ? `## Continue your stopped answer\n${renderContinuation(i.continuation)}` : '', `## Message\n${redactText(i.text)}`].filter(Boolean).join('\n\n');
  return { systemPrompt: [i.skillBody, boundary, stable], prompt };
}
