/**
 * BE-5 channel briefs (R-UI-21): what the `brief.generate` job (src/jobs/handlers/brief.ts) runs for each watch.
 *
 *  - `briefDue`: whether a watch is due, from its cadence and when its last brief was written. "Daily 7:30" (the
 *    Watches form's default) is due once per local day from 07:30; "Every 4 h" four hours after the last brief;
 *    "Since last open" has no open signal in the worker yet, so it is briefed daily like "Daily 7:30".
 *  - `channelBrief`: the messages the Slack scanner stored for the channel in the period → ONE tool-less model call
 *    with brief-channel + brief-relevance (./prompt) → a validated brief. A quiet period makes no call.
 *  - The result is a contract `Brief`, written by the DataSource's own `insertBrief`, so the Briefs page reads it
 *    exactly as it reads every other brief.
 *
 * Briefs are reading material: nothing here creates work, and nothing leaves the app.
 */
import type { Brief, BriefHighlight, SourceRef, WatchCadence } from '@/contract';
import type { CompletionModel } from '@/scanner/completion';
import { nextLocalTime } from '@/lib/local-time';

import { localStamp } from '../nba/prompt/render';
import { buildBriefPrompt, parseBriefReply, type BriefValidation } from './prompt/build';
import type { BriefOutput } from './prompt/schema';
import type { BriefInput, BriefItem, MyContext } from './prompt/types';

/** The local time of a daily brief: the Watches form offers "Daily 7:30". */
export const DAILY_BRIEF_AT = '07:30';
export const EVERY_4H_MS = 4 * 3_600_000;

export interface DueInput {
  cadence: WatchCadence;
  /** When this watch's last brief was written (null: never). */
  lastBriefAt: string | null;
}

/** The latest local `hhmm` at or before `now`. */
export function lastLocalSlot(now: Date, hhmm: string, timeZone: string): Date {
  const next = nextLocalTime(now, hhmm, timeZone);
  // A local day is 23–25 h long, so 25.5 h before the next slot lies between the previous slot and the one before it.
  return nextLocalTime(new Date(next.getTime() - 25.5 * 3_600_000), hhmm, timeZone);
}

/** Is the watch due now? `nextAt` is when to look again when it is not. */
export function briefDue(w: DueInput, now: Date, timeZone: string): { due: boolean; nextAt: Date } {
  const last = w.lastBriefAt ? Date.parse(w.lastBriefAt) : NaN;
  if (w.cadence === 'every_4h') {
    if (!Number.isFinite(last) || now.getTime() - last >= EVERY_4H_MS) return { due: true, nextAt: now };
    return { due: false, nextAt: new Date(last + EVERY_4H_MS) };
  }
  const slot = lastLocalSlot(now, DAILY_BRIEF_AT, timeZone);
  if (!Number.isFinite(last) || last < slot.getTime()) return { due: true, nextAt: now };
  return { due: false, nextAt: nextLocalTime(now, DAILY_BRIEF_AT, timeZone) };
}

/** One message the Slack scanner stored for the channel. */
export interface ChannelMessage {
  sourceItemId: string;
  at: string;
  authorName?: string;
  authorIsMe?: boolean;
  /** `slack:<channel>:<thread ts>` */
  threadRef?: string;
  isReply: boolean;
  text: string;
  /** Its source chip (deep link to the message). */
  source: SourceRef;
}

export interface ChannelBriefRequest {
  now: Date;
  user: { name: string; role: string; tz: string; slackId?: string };
  watch: {
    id: string;
    label: string;
    cadence: WatchCadence;
    /** The DB style enum (digest | narrative | changes_only) is the prompt's style. */
    style: 'digest' | 'narrative' | 'changes_only';
    detailLevel: number;
    maxHighlights: number;
  };
  period: { from: string; to: string };
  messages: ChannelMessage[];
  myContext: MyContext;
  coverage?: { complete: boolean; note?: string };
  model: CompletionModel;
  /** Hard stop per model call (Agent SDK maxBudgetUsd). */
  maxCallUsd: number;
  skillsDir?: string;
  signal?: AbortSignal;
}

export interface ChannelBriefSpend {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** D0: cache reads and writes, apart from input. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  promptVersion?: string;
  inputsHash?: string;
}

export type ChannelBriefResult =
  | ({ status: 'quiet'; brief: Brief } & ChannelBriefSpend)
  | ({ status: 'ready'; brief: Brief; warnings: string[]; evidence: Record<string, string[]> } & ChannelBriefSpend)
  | ({ status: 'failed'; code: string; errors: string[] } & ChannelBriefSpend);

/** The brief's id for a watch and period: a retry of the same period finds the same row. */
export const briefIdFor = (watchId: string, period: { from: string; to: string }) => `brief:${watchId}:${period.from}:${period.to}`;

const MSG_ID = (i: number) => `s_${i + 1}`;
const EXCERPT = 280;
/** Validation errors that make a reply unusable even after the repair attempt. */
const FATAL = new Set(['json', 'secret_in_brief']);

function briefInput(r: ChannelBriefRequest): { input: BriefInput; byId: Map<string, ChannelMessage> } {
  const sorted = [...r.messages].sort((a, b) => a.at.localeCompare(b.at));
  const byId = new Map(sorted.map((m, i) => [MSG_ID(i), m]));
  const replies = new Map<string, number>();
  for (const m of sorted) if (m.isReply && m.threadRef) replies.set(m.threadRef, (replies.get(m.threadRef) ?? 0) + 1);
  const items: BriefItem[] = sorted.map((m, i) => ({
    id: MSG_ID(i),
    source: 'slack',
    at: m.at,
    author: m.authorName ? { name: m.authorName, ...(m.authorIsMe ? { isMe: true } : {}) } : undefined,
    where: r.watch.label,
    threadRef: m.threadRef,
    text: m.text,
    ...(m.source.url ? { permalink: m.source.url } : {}),
    ...(!m.isReply && m.threadRef && replies.get(m.threadRef) ? { replyCount: replies.get(m.threadRef) } : {}),
  }));
  return {
    byId,
    input: {
      kind: 'channel',
      now: r.now.toISOString(),
      user: r.user,
      period: r.period,
      subscription: { id: r.watch.id, label: r.watch.label, scopeKind: 'channel', style: r.watch.style, detailLevel: r.watch.detailLevel, maxHighlights: r.watch.maxHighlights },
      items,
      myContext: r.myContext,
      ...(r.coverage ? { coverage: r.coverage } : {}),
    },
  };
}

/**
 * A reply that is still invalid after the repair attempt keeps what is usable: highlights that cite only messages of
 * the period (at most maxHighlights), and a `high` without a strong reason reads as `medium`.
 */
function salvage(v: BriefValidation, input: BriefInput): BriefOutput | null {
  if (!v.output || v.errors.some((e) => FATAL.has(e.code))) return null;
  const ids = new Set(input.items.map((i) => i.id));
  const strong = new Set(['mentions_me', 'my_opportunity', 'my_account', 'org62_change', 'stakeholder', 'my_initiative', 'policy_rule']);
  const highlights = v.output.highlights
    .filter((h) => h.evidenceIds.length > 0 && h.evidenceIds.every((e) => ids.has(e)))
    .map((h) => (h.level === 'high' && !h.reasons.some((x) => strong.has(x.kind)) ? { ...h, level: 'medium' as const } : h))
    .slice(0, input.subscription.maxHighlights);
  return { ...v.output, highlights, nothingNew: v.output.nothingNew && highlights.length === 0 };
}

/** The brief, and the source item ids each highlight cites (provenance). */
function toBrief(r: ChannelBriefRequest, out: BriefOutput, byId: Map<string, ChannelMessage>): { brief: Brief; evidence: Record<string, string[]> } {
  const id = briefIdFor(r.watch.id, r.period);
  const generatedAt = r.now.toISOString();
  const cited = (ids: string[]) => ids.map((e) => byId.get(e)).filter((m): m is ChannelMessage => !!m);
  const chips = (ms: ChannelMessage[]) => [...new Map(ms.map((m) => [m.source.url ?? m.sourceItemId, m.source])).values()];
  const evidence: Record<string, string[]> = {};
  const highlights: BriefHighlight[] = out.highlights.map((h, i) => {
    const ms = cited(h.evidenceIds);
    evidence[`${id}:h${i}`] = ms.map((m) => m.sourceItemId);
    return {
      id: `${id}:h${i}`,
      version: 1,
      briefId: id,
      title: h.title,
      summary: h.body,
      relevance: h.level,
      reasons: h.reasons.map((x) => x.explanation),
      sources: chips(ms),
      status: 'new',
      promotedWorkItemId: null,
      at: ms.map((m) => m.at).sort().pop() ?? generatedAt,
    };
  });
  const everythingElse = out.everythingElse.map((t) => {
    const ms = t.evidenceIds.length ? cited(t.evidenceIds) : [...byId.values()].filter((m) => m.threadRef === t.threadRef);
    return {
      thread: t.gist,
      url: ms.find((m) => m.source.url)?.source.url ?? null,
      items: ms.map((m) => ({ at: m.at, author: m.authorName ?? 'Someone', text: m.text.length > EXCERPT ? `${m.text.slice(0, EXCERPT - 1)}…` : m.text })),
    };
  });
  const brief: Brief = {
    id,
    kind: 'channel',
    title: r.watch.label,
    subscriptionId: r.watch.id,
    oppId: null,
    accountId: null,
    period: r.period,
    through: r.period.to,
    sources: [{ kind: 'slack', label: r.watch.label }],
    summary: out.coverageNote ? `${out.summary}\n\n_${out.coverageNote}_` : out.summary,
    unread: true,
    status: 'ready',
    highlights,
    everythingElse,
    generatedAt,
  };
  return { brief, evidence };
}

/** A period with no messages: a brief that says so, already read, and no model call. */
function quietBrief(r: ChannelBriefRequest): Brief {
  const id = briefIdFor(r.watch.id, r.period);
  const note = r.coverage && !r.coverage.complete && r.coverage.note ? `\n\n_${r.coverage.note}_` : '';
  return {
    id,
    kind: 'channel',
    title: r.watch.label,
    subscriptionId: r.watch.id,
    oppId: null,
    accountId: null,
    period: r.period,
    through: r.period.to,
    sources: [{ kind: 'slack', label: r.watch.label }],
    summary: `No new messages in ${r.watch.label} since ${localStamp(r.period.from, r.user.tz)}.${note}`,
    unread: false,
    status: 'ready',
    highlights: [],
    everythingElse: [],
    generatedAt: r.now.toISOString(),
  };
}

export async function channelBrief(r: ChannelBriefRequest): Promise<ChannelBriefResult> {
  const spend: ChannelBriefSpend = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const usable = r.messages.filter((m) => m.text.trim());
  if (!usable.length) return { status: 'quiet', brief: quietBrief(r), ...spend };
  const { input, byId } = briefInput({ ...r, messages: usable });
  const prompt = buildBriefPrompt(input, { skillsDir: r.skillsDir });
  Object.assign(spend, { model: prompt.model, promptVersion: prompt.promptVersion, inputsHash: prompt.inputsHash });
  let v: BriefValidation | undefined;
  let user = prompt.user;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (r.signal?.aborted) break;
    const res = await r.model({ system: prompt.system, user, model: prompt.model, effort: 'low', maxBudgetUsd: r.maxCallUsd, signal: r.signal });
    spend.calls += 1;
    spend.costUsd += res.costUsd;
    spend.inputTokens += res.inputTokens;
    spend.outputTokens += res.outputTokens;
    spend.cacheReadTokens = (spend.cacheReadTokens ?? 0) + (res.cacheReadTokens ?? 0);
    spend.cacheWriteTokens = (spend.cacheWriteTokens ?? 0) + (res.cacheWriteTokens ?? 0);
    if (!res.ok) return { status: 'failed', code: res.error?.errorClass === 'auth' ? 'model_auth' : 'model_error', errors: [res.error?.message ?? 'model call failed'], ...spend };
    v = parseBriefReply(res.text, input);
    if (v.ok) break;
    user = `${prompt.user}\n\n<validation>Your previous reply was rejected: ${v.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}. Return the corrected JSON object only.</validation>`;
  }
  if (!v) return { status: 'failed', code: 'aborted', errors: [], ...spend };
  const out = v.ok ? v.output! : salvage(v, input);
  if (!out) return { status: 'failed', code: 'invalid_reply', errors: v.errors.map((e) => e.code), ...spend };
  return { status: 'ready', ...toBrief(r, out, byId), warnings: [...v.warnings, ...(v.ok ? [] : v.errors)].map((e) => e.code), ...spend };
}
