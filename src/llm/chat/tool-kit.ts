/**
 * The chat tools' shared kit (Assistant v2): the turn's tool state and context, the result shape, and the helpers the
 * eleven tools in ./tools.ts share (one card per list, live reads through the runtime with their cost booked, text
 * paging, the plan's estimate, the playbooks and the help text). No tool definitions here.
 */
import { z } from 'zod';
import { type ChatChange, type ChatPlan, type ChatRoute, type ChatScan } from '@/contract';
import { allows, type Gate, type ResolvedPersona } from '@/personas';
import { AppRouteError } from '@/server/chat/app-routes';
import { toolJson } from '@/server/chat/compact';
import { CHAT_READ_PAGE_NAMES, READ_PAGE_CHARS, type ChatReadPage } from '@/server/chat/read';
import { redactText } from '../redact';
import { loadSkill } from '../skill-loader';
import { defaultEstimate, type Estimate, type SpendGovernor, type SpendJob } from '../spend';
import type { PlanAnswer } from './plan-waiters';
import type { ChatHost, ChatRunStep, ChatTurnInput } from './types';

export const CHAT_SERVER_NAME = 'chat';
export const chatToolFullName = (name: string) => `mcp__${CHAT_SERVER_NAME}__${name}`;

export interface ChatToolState {
  scans: Map<string, ChatScan>;
  /** Scan id → the tool row that stays open (tool-progress) until the scan finishes. */
  scanRows: Map<string, string>;
  /** Proposal ids staged this message. */
  proposals: string[];
  /** The cards staged this message by their summary (normalized): a list is ONE card, never "(1 of 2)" (A2). */
  cards: Map<string, string>;
  /** Connectors rescanned this message (one scan per connector: scans run on the scanners' budget, not this one). */
  rescanned: Set<string>;
  /** The plans shown this message, and whether the user said Run to a research-class one. */
  plans: ChatPlan[];
  planApproved: boolean;
  /** Tool calls made this message (the receipt's steps). */
  steps: number;
}

export const newToolState = (): ChatToolState => ({ scans: new Map(), scanRows: new Map(), proposals: [], cards: new Map(), rescanned: new Set(), plans: [], planApproved: false, steps: 0 });

/**
 * The card key of a summary: words only, without the "(1 of 2)" / "part 2" / "batch 3" / "continued" a split list
 * adds, so a second card for the same list is caught (A2: one card holds any number of calls).
 */
export function cardKey(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/\(?\s*(part|batch|page|set|group)?\s*\d+\s*(of|\/)\s*\d+\s*\)?/g, ' ')
    .replace(/\b(part|batch|page|set|group)\s*\d+\b/g, ' ')
    .replace(/\b(continued|cont\.?|the rest|remaining|more)\b/g, ' ')
    .replace(/\d+/g, '#')
    .replace(/[^a-z#]+/g, ' ')
    .trim();
}

/** The payload sanity bound of one card: far above real use (55 claims), well under what one Apply can run. */
export const CARD_MAX_CALLS = 2_000;

const ECHO_LINES = 100;
export const echoLines = (lines: unknown[]) => ({ lines: lines.slice(0, ECHO_LINES), ...(lines.length > ECHO_LINES ? { linesOnCard: lines.length, linesNote: `The card shows all ${lines.length} lines; the first ${ECHO_LINES} are echoed here.` } : {}) });

/** Steps of a chat-started scan for `tool-progress`: queued 0/3 · running 1/3 · items seen 2/3 · finished 3/3. */
export const SCAN_STEPS = 3;
export function scanProgress(s: Pick<ChatScan, 'status' | 'done' | 'itemsSeen'>): { done: number; total: number } {
  const done = s.done ? SCAN_STEPS : s.status === 'running' ? (s.itemsSeen > 0 ? 2 : 1) : 0;
  return { done, total: SCAN_STEPS };
}

export const windowTag = (h: number) => (h % 24 === 0 ? `${h / 24}d` : `${h}h`);
export const SOURCES = new Set(['slack', 'gmail', 'calendar', 'drive', 'gemini', 'org62', 'vdp', 'claude']);

/** The `run` kinds that are research-class: a plan the user said Run to comes first (the plan card). */
export const RESEARCH_RUNS: ReadonlySet<string> = new Set(['research', 'read_in', 'vdp_find_assets']);

export interface ChatToolCtx {
  host: ChatHost;
  input: ChatTurnInput;
  emit: (step: ChatRunStep) => void;
  state: ChatToolState;
  signal: AbortSignal;
  /** Push the turn's no-progress deadline out (a long tool that is still working). */
  extend?: (ms: number) => void;
  persona?: ResolvedPersona | null;
  /** The router's reading of this turn: `act` runs allow-class actions only when the turn is an `act`. */
  route?: ChatRoute;
  /** A sub-run's or live read's actual spend: it joins the turn's live meter (it has its own hold or relay line). */
  spend?: (usd: number, what: string) => void;
  /** What is left of the assistant's day line after this turn's spend so far. */
  dayLeft?: () => number;
  /** The spend governor: plan estimates and each run's own hold. */
  gov?: SpendGovernor;
  /** Show a plan that waits and wait for its answer (the runner pauses the watchdog); null = unanswered. */
  waitPlan?: (plan: ChatPlan) => Promise<PlanAnswer | null>;
  /** Kept for old callers: a stop that offers "Allow more". */
  needMore?: (usd: number, what: string, scope?: 'message' | 'day') => void;
  budgetLeft?: () => number;
}

export interface ChatToolResult {
  /** What the model sees (JSON or a sentence). */
  text: string;
  ok: boolean;
  /** One human line for the tool row. */
  summary: string;
  /** The row stays open: the runner sends its tool-progress and tool-result later (scans). */
  defer?: boolean;
  /** What the call cost on its own (relay, sub-run): shown on the tool row. */
  costUsd?: number;
  /** A guard held the call for the user (ok is false, not a failure): the row is neutral (SEC-8, SEC-9). */
  held?: boolean;
}

export interface ChatToolDef<S extends z.ZodRawShape> {
  name: string;
  row?: (args: z.infer<z.ZodObject<S>>) => string;
  description: string | ((p: ResolvedPersona | null | undefined) => string);
  shape: S;
  start: (args: z.infer<z.ZodObject<S>>) => string;
  run: (ctx: ChatToolCtx, args: z.infer<z.ZodObject<S>>, rowId: string) => Promise<ChatToolResult>;
}

export const def = <S extends z.ZodRawShape>(d: ChatToolDef<S>) => d;
export const q = (s: string, n = 48) => `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"`;
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

/** A long text, a page at a time (characters): the result says where the next page starts. Never cut silently. */
export function pageText(text: string, offset = 0, budget = READ_PAGE_CHARS): { text: string; offset: number; total: number; nextOffset: number | null } {
  const end = Math.min(text.length, offset + budget);
  return { text: text.slice(offset, end), offset, total: text.length, nextOffset: end < text.length ? end : null };
}

export function splitCard(ctx: ChatToolCtx, summary: string): ChatToolResult | null {
  const prior = ctx.state.cards.get(cardKey(summary));
  if (!prior) return null;
  return {
    text: toolJson({ staged: false, error: `You already staged a card like this one this message ("${summary}", proposal ${prior}). One card holds any number of changes: a list is never split.` }),
    ok: false,
    summary: 'Already on a card this message',
  };
}

/** Stage changes as one proposal card (shared by propose and act's stage class). */
export async function stageCard(ctx: ChatToolCtx, changes: ChatChange[], summary0: string): Promise<{ ok: true; proposalId: string; lines: unknown[] } | { ok: false; result: ChatToolResult }> {
  const split = splitCard(ctx, summary0);
  if (split) return { ok: false, result: split };
  const preview = await ctx.host.previewChanges(changes, ctx.input.threadId);
  if (preview.errors.length) return { ok: false, result: { text: toolJson({ staged: false, errors: preview.errors, hint: 'Fix the ids, states or bodies (read or query first) and call again with the whole list.' }), ok: false, summary: `Can't stage: ${preview.errors[0]}` } };
  if (!preview.lines.length) return { ok: false, result: { text: toolJson({ staged: false, errors: ['Nothing would change.'] }), ok: false, summary: 'Nothing would change' } };
  const summary = redactText(summary0);
  const proposal = await ctx.host.stageChanges({ threadId: ctx.input.threadId, messageId: ctx.input.messageId, changes: preview.changes, lines: preview.lines, entity: preview.entity, reason: summary });
  ctx.state.proposals.push(proposal.id);
  ctx.state.cards.set(cardKey(summary0), proposal.id);
  ctx.emit({ type: 'proposal', proposal, summary, changes: preview.changes });
  return { ok: true, proposalId: proposal.id, lines: preview.lines };
}

/** Book a live read's or sub-run's own model spend with the thread id (llm_calls, purpose chat). */
export async function book(ctx: ChatToolCtx, r: { model?: string; inputTokens?: number; outputTokens?: number; costUsd: number; ok: boolean; skill: string; latencyMs?: number }) {
  if (!(r.costUsd > 0) && !r.model) return;
  await ctx.host
    .recordUsage({ threadId: ctx.input.threadId, messageId: ctx.input.messageId, model: r.model || 'relay', inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: r.costUsd, estimated: false, status: r.ok ? 'ok' : 'error', latencyMs: r.latencyMs ?? 0, skill: r.skill })
    .catch(() => undefined);
  if (r.costUsd > 0) ctx.spend?.(r.costUsd, r.skill);
}

/** A live Google read through the host (the research run's handlers), as a tool result. */
export async function google(ctx: ChatToolCtx, tool: 'gmail_search' | 'gmail_thread' | 'drive_search' | 'drive_read' | 'calendar_events', args: Record<string, unknown>, what: string): Promise<ChatToolResult> {
  const r = await ctx.host.googleRead(tool, args, ctx.signal);
  if (!r.available) return { text: r.text, ok: false, summary: `${what}: not available here` };
  const n = /^(\d+) event/.exec(r.text)?.[1];
  return { text: r.text, ok: r.ok, summary: r.ok ? (n ? `${n} event${n === '1' ? '' : 's'}` : `${what}: read`) : `${what} failed` };
}

/** One live Slack / VDP read through the connector runtime, its own cost booked. */
export async function live(ctx: ChatToolCtx, connector: 'slack' | 'vdp', tool: string, args: Record<string, unknown>, offset: number | undefined, what: string): Promise<ChatToolResult> {
  if (!ctx.host.liveRead) return { text: `Live ${connector === 'slack' ? 'Slack' : 'VDP'} reads aren't available here (${ctx.host.kind} mode, or the connectors are off): answer from the app's data (query, search source ledger) and say so.`, ok: false, summary: `${what}: not available here` };
  const t0 = Date.now();
  const r = await ctx.host.liveRead(connector, tool, args, ctx.signal);
  await book(ctx, { ...r, skill: `relay:${connector}:${tool}`, latencyMs: Date.now() - t0 });
  const page = pageText(r.text, offset ?? 0);
  const more = page.nextOffset !== null ? `\n[${page.total} characters; read the rest with the same call and offset=${page.nextOffset}]` : '';
  return { text: `${page.text}${more}`, ok: r.ok, summary: r.ok ? `${what}: read${r.costUsd > 0 ? ` · ${usd(r.costUsd)}` : ''}` : `${what} failed`, costUsd: r.costUsd };
}

export const FREE_SOQL = /^\s*select\b/i;

/** A `plan` step's estimate: model steps from the turn's own history, sub-runs from their scope (llm_calls p50/p90). */
export async function estimatePlan(ctx: ChatToolCtx, steps: Array<{ tool: string; run?: string | undefined }>): Promise<{ steps: number[]; total: Estimate }> {
  const gov = ctx.gov;
  const per: number[] = [];
  let p50 = 0;
  let p90 = 0;
  let history = true;
  const model = ctx.route?.model ?? ctx.input.model;
  for (const s of steps) {
    const job: SpendJob =
      s.tool === 'run' && s.run && RESEARCH_RUNS.has(s.run)
        ? { scope: 'research', jobKey: `${ctx.input.messageId}:plan`, skill: s.run === 'research' ? 'research-question' : s.run }
        : s.tool === 'run'
          ? { scope: 'relay', jobKey: `${ctx.input.messageId}:plan`, skill: s.run }
          : { scope: 'chat_message', jobKey: `${ctx.input.messageId}:plan`, skill: `chat-step@${model}` };
    const e = gov ? await gov.estimate(job).catch(() => defaultEstimate(job.scope, job.skill)) : defaultEstimate(job.scope, job.skill);
    // a model step is one request, not a whole message: a tenth of a message's figure (the default table is per message)
    const k = job.scope === 'chat_message' && e.basis === 'default' ? (model === 'haiku' ? 0.005 : model === 'opus' ? 0.2 : 0.1) : 1;
    if (e.basis === 'default') history = false;
    per.push(Math.round(e.p90 * k * 1e4) / 1e4);
    p50 += e.p50 * k;
    p90 += e.p90 * k;
  }
  return { steps: per, total: { p50: Math.round(p50 * 1e4) / 1e4, p90: Math.round(p90 * 1e4) / 1e4, basis: history ? 'history' : 'default', n: 0 } };
}

export const isPage = (r: string): r is ChatReadPage => (CHAT_READ_PAGE_NAMES as string[]).includes(r);

export const PROPOSE_KINDS = ['changes', 'calls', 'draft', 'vdp', 'use_case', 'time_entry', 'log_batch', 'session'] as const;

/** The on-demand playbooks (skills/chat-assistant-playbooks.md, one `## <topic>` section each): off the cached prefix. */
export const PLAYBOOKS = ['dc', 'vdp', 'logging', 'lists'] as const;
export const PLAYBOOKS_PATH = 'skills/chat-assistant-playbooks.md';
/** D-55: a playbook for a feature the persona has off is not served (dc: deal contributions; vdp: VDP). */
export const PLAYBOOK_GATES: Readonly<Partial<Record<(typeof PLAYBOOKS)[number], { gate: Gate; name: string }>>> = {
  dc: { gate: { feature: 'dealContributions' }, name: 'Deal contributions' },
  vdp: { gate: { feature: 'vdp' }, name: 'VDP' },
};
/** A persona's playbooks. undefined (no persona) = every one; null (still loading) = the ungated ones. */
export const playbooksFor = (p: ResolvedPersona | null | undefined): Array<(typeof PLAYBOOKS)[number]> => PLAYBOOKS.filter((t) => p === undefined || allows(p, PLAYBOOK_GATES[t]?.gate));
/** The plain answer for a gated playbook the persona has off (the words the other persona gates use). */
export const playbookOffText = (topic: string) => `${PLAYBOOK_GATES[topic as keyof typeof PLAYBOOK_GATES]?.name ?? topic} is not active for your role, so there is no ${topic} playbook to read (Settings ▸ Role & rules lists it as available to activate).`;
export function playbook(topic: string, repoRoot?: string): string {
  const body = loadSkill(PLAYBOOKS_PATH, repoRoot).body;
  const section = body.split(/^## /m).find((x) => x.startsWith(`${topic}\n`));
  return section ? section.slice(topic.length + 1).trim() : `No playbook "${topic}".`;
}

/** `help` without a topic: what the Assistant can do, in the user's words, with examples. */
export const HELP_TEXT = [
  'I can:',
  '- answer from your data: "what are my top 3 today and why?", "which opps close this quarter with no hours logged?" (query, explain)',
  '- find things: "the deck I made for Globex", "Dana\'s mail about pricing" (search, fetch)',
  '- do the small things you ask: snooze, pin, done, not mine, re-rank (act; Undo on the receipt)',
  '- stage the rest for your Apply: card edits, DC claims, time-row fixes, VDP changes, logging canvases, drafts for the Outbox (propose; nothing sends)',
  '- research live across Slack, Gmail, Calendar, Drive and Org62, after showing you a plan and its cost (plan, run)',
  '- remember a note for this thread or a standing preference (remember)',
  'I never send, post, apply, sign in for you, or change dry run, sending or budgets.',
].join('\n');

/** `help` without a topic, for a persona: the stage line names only its features, and the topics are its own. */
export function helpTextFor(p: ResolvedPersona | null | undefined): string {
  const on = (feature: Gate['feature']) => p === undefined || allows(p, { feature });
  const stage = ['card edits', ...(on('dealContributions') ? ['DC claims'] : []), 'time-row fixes', ...(on('vdp') ? ['VDP changes'] : []), 'logging canvases', 'drafts for the Outbox'];
  const lines = HELP_TEXT.split('\n').map((l) => (l.startsWith('- stage the rest') ? `- stage the rest for your Apply: ${stage.join(', ')} (propose; nothing sends)` : l));
  return [...lines, `Topics (help topic): pages, routes, stage_routes, views, and the playbooks ${playbooksFor(p).join(', ')}.`].join('\n');
}

/** A readable page of one app route (calendar event, VDP detail), credential-redacted, paged by characters. */
export async function readPaged(ctx: ChatToolCtx, route: string, raw: { params?: Record<string, unknown>; query?: Record<string, unknown> }, offset: number | undefined, what: string): Promise<ChatToolResult> {
  try {
    const r = await ctx.host.appRead(route, raw, {});
    const page = pageText(toolJson({ route, data: r.data }, Number.POSITIVE_INFINITY), offset ?? 0);
    return { text: `${page.text}${page.nextOffset !== null ? `\n[${page.total} characters; read the rest with offset=${page.nextOffset}]` : ''}`, ok: true, summary: `${what}: read` };
  } catch (err) {
    if (err instanceof AppRouteError) return { text: `Can't read that: ${err.message}.`, ok: false, summary: `${what}: not found` };
    throw err;
  }
}

