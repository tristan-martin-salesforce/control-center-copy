/**
 * Shared builders for what chat creates inside the app (BE-CHAT): Outbox drafts, prepared Claude sessions,
 * scan cards, and the stored chat plan behind a proposal. Used by both DataSources. Nothing here sends,
 * posts or opens anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatChange, ChatDraftRef, ChatScan, ChatSettings, ChatSession, Destination, DispatchMode, Draft, EntityRef, FieldChange, Proposal, Receipt, ScanRun } from '@/contract';
import { redactText } from '@/llm/redact';
import type { DraftInput, SessionInput } from '@/llm/chat/types';
import { invalid } from '@/server/errors';

import { docFromText, plainText, renderAll } from '../datasource/mock/render';

/** The stored chat plan behind a chat proposal (mock: in memory; db: kv `cc.chat.plan/<id>`). */
export interface ChatPlanRecord {
  proposal: Proposal;
  changes: ChatChange[];
  threadId: string;
  messageId: string;
  /** Set on apply: the receipt (becomes a receipt part after the proposal on read) and its change set. */
  receipt?: Receipt;
  auditId?: string;
}

export const CHAT_PLAN_PREFIX = 'cc.chat.plan/';

/**
 * 2026-11-13 audit C8: the Assistant's proposal cards staged and not applied or discarded yet (the quiet Assistant nav
 * badge), from the stored chat plans: the db's kv (`cc.chat.plan/<proposal id>`), or the mock's plan map.
 */
export function pendingChatCards(plans: Iterable<unknown>): number {
  let n = 0;
  for (const v of plans) if ((v as { proposal?: { status?: string } } | undefined)?.proposal?.status === 'pending') n++;
  return n;
}

/** The chat plans in a kv map (the db's `cc.chat.plan/…` rows). */
export function chatPlansIn(kv: ReadonlyMap<string, unknown>): unknown[] {
  return [...kv].filter(([k]) => k.startsWith(CHAT_PLAN_PREFIX)).map(([, v]) => v);
}

export function chatProposal(o: { id: string; entity: EntityRef; lines: FieldChange[]; reason: string; at: string }): Proposal {
  return { id: o.id, entity: o.entity, changes: o.lines, reason: o.reason, source: null, createdAt: o.at, status: 'pending', actor: 'chat', baseVersion: null, textDiff: null, resolvedAt: null };
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const SLACK_ID = /^[CDGU][A-Z0-9]{6,}$/;

export function destinationFor(i: DraftInput): Destination {
  if (i.channel === 'email') {
    const addrs = i.to
      .split(/[,;]\s*/)
      .map((s) => s.trim().replace(/^.*<([^>]+)>$/, '$1'))
      .filter(Boolean);
    if (!addrs.length || addrs.some((a) => !EMAIL.test(a))) throw invalid(`email drafts need addresses in "to" (got "${redactText(i.to).slice(0, 80)}")`);
    return { kind: 'email', target: i.threadRef ? 'reply' : 'new', to: addrs.map((email) => ({ email })), cc: [], subject: (i.subject ?? i.intent).slice(0, 200), threadId: i.threadRef ?? null, inReplyTo: null };
  }
  const to = i.to.trim();
  const isId = SLACK_ID.test(to);
  const name = isId ? to : to.startsWith('#') || to.startsWith('@') ? to : `#${to}`;
  return { kind: 'slack', target: i.threadRef ? 'thread' : name.startsWith('@') ? 'dm' : 'channel', channelId: isId ? to : name, channelName: name, threadTs: i.threadRef ?? null };
}

/** A chat draft (status `drafting`: the card's Add to Outbox queues it as `ready`). Body: the model's text, credential-redacted. */
export function chatDraft(i: DraftInput, o: { id: string; now: string; mode: DispatchMode; workItemId: string | null }): Draft {
  const destination = destinationFor(i);
  const body = redactText((i.body ?? i.intent).trim());
  const doc = docFromText(body);
  return {
    id: o.id,
    version: 1,
    workItemId: o.workItemId,
    nbaId: null,
    destination,
    mode: o.mode,
    doc,
    plainText: plainText(doc),
    rendered: renderAll(destination, doc),
    userTouched: false,
    userLockedFields: [],
    status: 'drafting',
    threadContext: [],
    createdAt: o.now,
    updatedAt: o.now,
    savedAt: null,
    scheduledFor: null,
    attempts: [],
    verification: null,
    rejectedReason: null,
    resultUrl: null,
  };
}

export function draftRef(d: Draft, i: Pick<DraftInput, 'threadRef'>): ChatDraftRef {
  const dest = d.destination;
  return {
    draftId: d.id,
    channel: dest.kind,
    to: dest.kind === 'slack' ? dest.channelName : dest.kind === 'action' ? dest.target.label : dest.to.map((t) => t.email).join(', '),
    subject: dest.kind === 'email' ? dest.subject : null,
    threadRef: i.threadRef ?? null,
    workItemId: d.workItemId,
    status: d.status,
    preview: d.plainText.split('\n').slice(0, 3).join('\n').slice(0, 280),
    href: `/outbox?draft=${encodeURIComponent(d.id)}`,
  };
}

const expandHome = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

/**
 * Repo → folder: an absolute or ~ path as given; a known repo by name; else ~/Projects/<name> when it
 * exists; else the fallback (the app's repo folder). Only reads the filesystem (existsSync).
 */
export function resolveRepoFolder(repo: string, known: Array<{ name: string; path: string }>, fallback: string): string {
  const r = repo.trim();
  if (r.startsWith('/') || r.startsWith('~')) return path.normalize(expandHome(r));
  const byName = known.find((k) => k.name.toLowerCase() === r.toLowerCase() || path.basename(k.path).toLowerCase() === r.toLowerCase());
  if (byName) return byName.path;
  const guess = path.join(os.homedir(), 'Projects', r);
  try {
    if (fs.existsSync(guess)) return guess;
  } catch {
    /* fall through */
  }
  return fallback;
}

/** The deep link the UI opens on click: claude://code/new?folder=…&q=…[cc:<id>] (prompt capped like launchAgent). */
export function sessionLink(folder: string, prompt: string, ccId: string): { url: string; prompt: string } {
  const tag = `[cc:${ccId}]`;
  let p = redactText(prompt.trim());
  if (!p.includes(tag)) p = `${p}\n\n${tag}`;
  if (p.length > 14336) p = `${p.slice(0, 14336 - tag.length - 2)}\n${tag}`;
  return { url: `claude://code/new?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(p)}`, prompt: p };
}

export function chatSession(i: SessionInput, o: { id: string; folder: string; now: string; workItemId: string | null; title: string }): ChatSession {
  const link = sessionLink(o.folder, i.prompt, o.workItemId ?? o.id);
  return { id: o.id, repo: i.repo, folder: o.folder, title: o.title, prompt: link.prompt, url: link.url, workItemId: o.workItemId, state: 'prepared', createdAt: o.now };
}

export const TERMINAL_SCAN = new Set(['ok', 'partial', 'auth_failed', 'transient_failed', 'budget_exceeded', 'aborted']);

/** A scan card from the job + run rows. */
export function chatScan(o: {
  id: string;
  connector: { id: string; label: string; source: ChatScan['source'] };
  windowHours: number;
  window: { from: string; to: string };
  jobId: string | null;
  jobStatus: 'queued' | 'running' | 'retrying' | 'succeeded' | 'dead' | 'cancelled' | null;
  run: Pick<ScanRun, 'id' | 'status' | 'itemsSeen' | 'itemsNew' | 'itemsChanged' | 'error'> | null;
  now: string;
  authBroken?: boolean;
}): ChatScan {
  const label = o.connector.label;
  let status: ChatScan['status'];
  if (o.authBroken) status = 'auth_failed';
  else if (o.run && (TERMINAL_SCAN.has(o.run.status) || o.jobStatus === 'running')) status = o.run.status;
  else if (o.jobStatus === 'dead' || o.jobStatus === 'cancelled') status = 'aborted';
  else if (o.jobStatus === 'succeeded') status = o.run?.status ?? 'ok';
  else if (o.jobStatus === 'running') status = 'running';
  else status = o.run?.status ?? 'queued';
  const done = TERMINAL_SCAN.has(status);
  const counts = o.run ? `${o.run.itemsSeen} seen · ${o.run.itemsNew} new · ${o.run.itemsChanged} changed` : '';
  const summary = o.authBroken
    ? `${label} needs re-auth; the scan was not started`
    : status === 'queued'
      ? `${label} scan queued (last ${o.windowHours} h)`
      : status === 'running'
        ? `${label} scan running${counts ? `: ${counts}` : ''}`
        : status === 'ok' || status === 'partial'
          ? `${label} scan ${status === 'ok' ? 'done' : 'partly done'}${counts ? `: ${counts}` : ''}`
          : `${label} scan ${status.replace(/_/g, ' ')}${o.run?.error ? `: ${redactText(o.run.error).slice(0, 120)}` : ''}`;
  return {
    id: o.id,
    scanRunId: o.run?.id ?? null,
    connectorId: o.connector.id,
    connector: label,
    source: o.connector.source,
    windowHours: o.windowHours,
    windowStart: o.window.from,
    windowEnd: o.window.to,
    status,
    done,
    jobId: o.jobId,
    itemsSeen: o.run?.itemsSeen ?? 0,
    itemsNew: o.run?.itemsNew ?? 0,
    itemsChanged: o.run?.itemsChanged ?? 0,
    summary,
    updatedAt: o.now,
    href: o.run ? `/health?scan=${encodeURIComponent(o.run.id)}` : '/health',
  };
}

/** Connector lookup by id, source kind or label ("slack", "Slack", "<uuid>"). */
export function findConnector<T extends { id: string; label: string; source: string }>(all: T[], q: string): T | null {
  const s = q.trim().toLowerCase();
  return all.find((c) => c.id.toLowerCase() === s) ?? all.find((c) => c.source.toLowerCase() === s) ?? all.find((c) => c.label.toLowerCase() === s) ?? all.find((c) => c.label.toLowerCase().includes(s)) ?? null;
}

/** Chat limits: Settings ▸ Budgets ▸ Assistant (settings.chat), each overridable by env for tests and ops. */
export function chatLimitsFromEnv(env: NodeJS.ProcessEnv = process.env, model: 'sonnet' | 'opus' | 'haiku' = 'sonnet', chat?: Partial<Pick<ChatSettings, 'dailyUsd' | 'maxSteps' | 'researchUsd'>> & { messageUsd?: Partial<ChatSettings['messageUsd']> }) {
  const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    chatDailyUsd: num(env.CC_CHAT_DAILY_USD, chat?.dailyUsd ?? 3),
    perMessageUsd: num(env.CC_CHAT_MESSAGE_USD, chat?.messageUsd?.[model] ?? (model === 'opus' ? 0.6 : model === 'haiku' ? 0.05 : 0.25)),
    // Assistant v2 (lane 05 §3a): steps are a runaway guard only (200); cost bounds a turn through the governor's
    // estimate → raise a hand → continue. A setting above it still wins.
    maxTurns: Math.max(1, Math.trunc(num(env.CC_CHAT_MAX_TURNS, chat?.maxSteps ?? 200))),
    researchUsd: num(env.CC_CHAT_RESEARCH_USD, chat?.researchUsd ?? 0.5),
  };
}
