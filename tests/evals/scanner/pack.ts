/**
 * The item's surroundings, read from the in-memory store the way the Settle pack loader reads Postgres
 * (src/engines/settle/load-db.ts): the ask, the same conversation (Slack thread or DM, Gmail thread), my later lines
 * to the asker elsewhere. Two views over it:
 *   - `settleRawOf` → `buildSettleContext` (the real pack builder): "is the deciding line in the pack?", the idea of
 *     scripts/settle/context-check.ts as a unit test, with no private answer key and no database;
 *   - `ruleInputOf` → the D1–D6 rules (src/scanner/resolution/rules.ts).
 */
import type { RawSource, SettleRaw } from '@/engines/settle/context';
import { SOURCE_EXCERPT_MAX } from '@/engines/settle/context';
import type { RuleInput, RuleLine } from '@/scanner/resolution/rules';
import type { InMemoryScannerStore } from '@/scanner/store-memory';
import type { NormalizedSourceItem, PersonRef } from '@/scanner/types';

type Row = NormalizedSourceItem & { id: string };

const payloadOf = (r: Row) => (r.payload ?? {}) as { channelId?: string; channelType?: string; channelName?: string; threadTs?: string; ts?: string; toMe?: boolean; files?: { name?: string; mimetype?: string }[]; hasFile?: boolean };
const keysOf = (p: PersonRef | undefined) => (p && !p.isMe ? [p.externalId, p.email, p.name].filter((x): x is string => !!x).map((x) => x.toLowerCase()) : []);

/** Every source item in the store (the store has no list call: walk the evidence and the known ids). */
function allRows(store: InMemoryScannerStore, ids: Iterable<string>): Row[] {
  const out = new Map<string, Row>();
  for (const id of ids) {
    const r = store.getSourceItem(id);
    if (r) out.set(r.id, r);
  }
  return [...out.values()];
}

export function conversationKey(r: Row): string | undefined {
  const p = payloadOf(r);
  if (r.connector === 'slack' && (p.channelType === 'im' || p.channelType === 'mpim') && p.channelId) return `dm:${p.channelId}`;
  return r.threadRef;
}

function toRaw(r: Row, role?: string): RawSource {
  const p = payloadOf(r);
  return {
    id: r.id,
    source: r.connector,
    kind: r.kind,
    externalId: r.externalId,
    parent: p.threadTs ?? null,
    url: r.permalink ?? null,
    at: r.occurredAt,
    fromMe: r.author?.isMe === true,
    addressedToMe: p.toMe ?? null,
    title: r.title ?? null,
    text: r.excerpt ?? null,
    author: r.author?.isMe ? 'me' : (r.author?.name ?? null),
    channelId: p.channelId ?? null,
    channelType: p.channelType ?? null,
    channelName: p.channelName ?? null,
    threadTs: p.threadTs && p.threadTs !== p.ts ? p.threadTs : null,
    ts: p.ts ?? null,
    ...((r.excerpt?.length ?? 0) >= SOURCE_EXCERPT_MAX ? { cut: true } : {}),
    ...(p.files?.length ? { files: p.files } : {}),
    ...(p.hasFile ? { hasFile: true } : {}),
    ...(role ? { role } : {}),
  };
}

export interface Surroundings {
  origin: Row;
  askerKeys: Set<string>;
  conversation: Row[];
  elsewhere: Row[];
}

/** The item's origin, its conversation and my lines to the asker elsewhere (after the ask). */
export function surroundings(store: InMemoryScannerStore, workItemId: string, sourceIds: Iterable<string>): Surroundings | null {
  const ev = store.evidenceFor(workItemId);
  const originEv = ev.find((e) => e.role === 'origin');
  const origin = originEv ? (store.getSourceItem(originEv.sourceItemId) as Row | undefined) : undefined;
  if (!origin) return null;
  const rows = allRows(store, [...sourceIds, ...ev.map((e) => e.sourceItemId)]);
  const askerKeys = new Set(keysOf(origin.author));
  const conv = conversationKey(origin);
  // Evidence threads count as the item's conversation too (a linked email thread).
  const convKeys = new Set([conv, ...ev.filter((e) => e.role !== 'context').map((e) => store.getSourceItem(e.sourceItemId)).map((r) => (r ? conversationKey(r as Row) : undefined))].filter((x): x is string => !!x));
  const askAt = Date.parse(origin.occurredAt);
  const conversation = rows.filter((r) => r.id !== origin.id && convKeys.has(conversationKey(r) ?? '')).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const inConv = new Set(conversation.map((r) => r.id));
  const elsewhere = rows.filter((r) => r.id !== origin.id && !inConv.has(r.id) && r.author?.isMe && Date.parse(r.occurredAt) > askAt && (r.participants ?? []).some((p) => keysOf(p).some((k) => askerKeys.has(k))));
  return { origin, askerKeys, conversation, elsewhere };
}

/** Raw rows for the real Settle pack builder (buildSettleContext). */
export function settleRawOf(store: InMemoryScannerStore, workItemId: string, sourceIds: Iterable<string>): SettleRaw | null {
  const s = surroundings(store, workItemId, sourceIds);
  const w = store.getWorkItem(workItemId);
  if (!s || !w) return null;
  const roles = new Map(store.evidenceFor(workItemId).map((e) => [e.sourceItemId, e.role]));
  const evidence = store
    .evidenceFor(workItemId)
    .map((e) => store.getSourceItem(e.sourceItemId) as Row | undefined)
    .filter((r): r is Row => !!r)
    .map((r) => toRaw(r, roles.get(r.id)));
  return {
    item: { id: workItemId, kind: w.kind, status: w.state, title: w.title, purpose: w.purpose ?? null, description: null, dueAt: null, createdAt: s.origin.occurredAt, counterparty: s.origin.author?.isMe ? null : (s.origin.author?.name ?? null), account: null },
    evidence,
    conversation: s.conversation.map((r) => toRaw(r)),
    elsewhere: s.elsewhere.map((r) => toRaw(r)),
    events: [],
    siblings: [],
    keywords: w.title.toLowerCase().split(/[^a-z0-9-]+/).filter((x) => x.length >= 4),
  };
}

/** The rules' view: the ask time and every later line of the item's own conversation. */
export function ruleInputOf(store: InMemoryScannerStore, workItemId: string, sourceIds: Iterable<string>, alias: (sourceItemId: string) => string = (x) => x): RuleInput | null {
  const s = surroundings(store, workItemId, sourceIds);
  const w = store.getWorkItem(workItemId);
  if (!s || !w) return null;
  const line = (r: Row): RuleLine => {
    const p = payloadOf(r);
    return {
      id: alias(r.id),
      at: r.occurredAt,
      fromMe: r.author?.isMe === true,
      byAsker: keysOf(r.author).some((k) => s.askerKeys.has(k)),
      text: [r.connector === 'gmail' ? r.title : undefined, r.excerpt].filter(Boolean).join('\n'),
      ...(p.files?.length ? { files: p.files } : {}),
      ...(p.hasFile ? { hasFile: true } : {}),
    };
  };
  return { item: { kind: w.kind, title: w.title, purpose: w.purpose ?? null }, askAt: s.origin.occurredAt, after: s.conversation.filter((r) => r.occurredAt > s.origin.occurredAt).map(line) };
}
