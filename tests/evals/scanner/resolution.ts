/**
 * The resolution check over the in-memory scanner store (the eval harness's closer when `closer: 'resolution'`): the
 * store the engine reads (ResolutionStore, as src/server/datasource/db/resolution.ts reads Postgres) and the trigger
 * view (TriggerItem / TriggerSource, as src/scanner/resolution/triggers-db.ts reads it in SQL). Placeholder data only.
 */
import { DEFAULT_CLOSING_SETTINGS } from '@/contract';
import type { ResolutionStore } from '@/engines/resolution/check';
import { deliverableWords } from '@/engines/resolution/pack';
import type { CheckRecord, RawFileRevision, RawSession, ResolutionItem, ResolutionRaw } from '@/engines/resolution/types';
import type { PolicyItem } from '@/engines/settle/policy';
import type { ClosureItem } from '@/engines/types';
import type { TriggerItem, TriggerSource } from '@/scanner/resolution/triggers';
import type { InMemoryScannerStore } from '@/scanner/store-memory';
import type { NormalizedSourceItem, PersonRef } from '@/scanner/types';

import { conversationKey, settleRawOf, surroundings } from './pack';

type Row = NormalizedSourceItem & { id: string };
const keysOf = (p: PersonRef | undefined) => (p && !p.isMe ? [p.externalId, p.email, p.name].filter((x): x is string => !!x).map((x) => x.toLowerCase()) : []);
const bare = (f: string) => f.replace(/^drive:/, '');
/** Evidence the check itself wrote (never a trigger for itself). */
export const isCheckEvidence = (reason: string | undefined) => /resolution:/.test(reason ?? '');

export interface HarnessItemState {
  version: Map<string, number>;
  doneAt: Map<string, string>;
  reopened: Map<string, number>;
  reopenedAt: Map<string, string>;
}

function rowsOf(store: InMemoryScannerStore, ids: Iterable<string>): Row[] {
  return [...new Set(ids)].map((id) => store.getSourceItem(id) as Row | undefined).filter((r): r is Row => !!r);
}

function fileRefsOfItem(store: InMemoryScannerStore, workItemId: string): string[] {
  return [...new Set(store.evidenceFor(workItemId).flatMap((e) => (store.getSourceItem(e.sourceItemId)?.fileRefs ?? []).map(bare)))];
}

export function triggerItemsOf(store: InMemoryScannerStore, sourceIds: Iterable<string>, st: HarnessItemState): TriggerItem[] {
  const out: TriggerItem[] = [];
  for (const w of store.listWorkItems()) {
    const s = surroundings(store, w.workItemId, sourceIds);
    if (!s) continue;
    const ev = store.evidenceFor(w.workItemId).filter((e) => e.role !== 'context');
    const convs = new Set([conversationKey(s.origin), ...ev.map((e) => store.getSourceItem(e.sourceItemId)).map((r) => (r ? conversationKey(r as Row) : undefined))].filter((x): x is string => !!x));
    const sessions = ev.map((e) => store.getSourceItem(e.sourceItemId)).filter((r) => r?.connector === 'claude_sessions').map((r) => String((r!.payload as { sessionId?: string } | undefined)?.sessionId ?? ''));
    out.push({ id: w.workItemId, status: w.state, title: w.title, doneAt: st.doneAt.get(w.workItemId) ?? null, doneBy: w.state === 'done' ? 'engine' : null, askAt: s.origin.occurredAt, conversationKeys: [...convs], fileRefs: fileRefsOfItem(store, w.workItemId), askerKeys: [...s.askerKeys], sessionIds: sessions.filter(Boolean) });
  }
  return out;
}

export function triggerSourceOf(r: Row): TriggerSource {
  const p = (r.payload ?? {}) as { toMe?: boolean; mentionsMe?: boolean; channelType?: string; sessionId?: string; summary?: string; status?: string };
  return {
    id: r.id,
    connector: r.connector,
    kind: r.kind,
    occurredAt: r.occurredAt,
    fromMe: r.author?.isMe === true,
    authorKeys: keysOf(r.author),
    addressedToMe: p.toMe === true || p.mentionsMe === true || p.channelType === 'im' || p.channelType === 'mpim' || (r.participants ?? []).some((x) => x.isMe),
    recipientKeys: r.author?.isMe ? (r.participants ?? []).flatMap(keysOf) : [],
    conversationKey: conversationKey(r) ?? null,
    fileRefs: (r.fileRefs ?? []).map(bare),
    text: [r.title, r.excerpt, p.summary].filter(Boolean).join(' '),
    sessionId: p.sessionId ?? null,
  };
}

/** The engine's view of the in-memory store. `checks` collects every row the check records. */
export function memoryResolutionStore(store: InMemoryScannerStore, sourceIds: () => Iterable<string>, st: HarnessItemState, checks: CheckRecord[]): ResolutionStore {
  return {
    async loadForCheck(itemId) {
      const w = store.getWorkItem(itemId);
      const raw0 = settleRawOf(store, itemId, sourceIds());
      if (!w || !raw0) return null;
      const s = surroundings(store, itemId, sourceIds())!;
      const all = rowsOf(store, sourceIds());
      const askMs = Date.parse(s.origin.occurredAt);
      const fileRefs = new Set(fileRefsOfItem(store, itemId));
      const noun = deliverableWords(w.title);
      const names = (t: string, n: number) => {
        const ws = new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
        return noun.filter((x) => ws.has(x)).length >= n;
      };
      const files: RawFileRevision[] = all
        .filter((r) => r.connector === 'drive' && Date.parse(r.occurredAt) > askMs && (r.fileRefs ?? []).some((f) => fileRefs.has(bare(f))))
        .map((r) => ({ sourceItemId: r.id, fileId: bare(r.fileRefs![0]!), title: r.title ?? null, at: r.occurredAt, byMe: r.author?.isMe === true, editor: r.author?.name ?? null, changes: r.excerpt ?? null, url: r.permalink ?? null }));
      const linked = new Set(store.evidenceFor(itemId).map((e) => e.sourceItemId));
      const sessions: RawSession[] = all
        .filter((r) => r.connector === 'claude_sessions' && Date.parse(r.occurredAt) > askMs && (linked.has(r.id) || names(`${r.title ?? ''} ${r.excerpt ?? ''}`, 2)))
        .map((r) => {
          const p = (r.payload ?? {}) as { sessionId?: string; status?: string; summary?: string };
          return { sourceItemId: r.id, sessionId: p.sessionId ?? r.externalId, status: p.status ?? 'unknown', title: r.title ?? null, at: r.occurredAt, lastMessage: (p.summary ?? r.excerpt ?? '').slice(-300) || null };
        });
      const raw: ResolutionRaw = {
        ...raw0,
        files,
        sessions,
        notes: [],
        record: null,
        lastCheck: (() => {
          const c = [...checks].reverse().find((x) => x.workItemId === itemId);
          return c ? { at: c.at, verdict: c.verdict, outcome: c.outcome, citeAlias: c.citeAlias } : null;
        })(),
        latestInputAt: [...raw0.conversation, ...raw0.evidence, ...files.map((f) => ({ at: f.at })), ...sessions.map((x) => ({ at: x.at }))].map((r) => r.at).sort().at(-1) ?? null,
      };
      const status = w.state;
      const closure: ClosureItem = { id: itemId, version: st.version.get(itemId) ?? 1, kind: w.kind as ClosureItem['kind'], status: status as ClosureItem['status'], title: w.title, resolution: null, involvement: 'owner', ...(st.doneAt.has(itemId) ? { doneAt: st.doneAt.get(itemId)!, doneBy: 'engine' as const } : {}), reopenedCount: st.reopened.get(itemId) ?? 0 };
      const policy: PolicyItem = { id: itemId, kind: w.kind, status, userTouched: false, userReopened: false, userKept: false, doneByEngine: status === 'done', externalCommitment: false, people: [], channels: [], originSource: s.origin.connector };
      const item: ResolutionItem = { id: itemId, kind: w.kind, status, title: w.title, closure, policy, reopenedCount: st.reopened.get(itemId) ?? 0, lastReopenAt: st.reopenedAt.get(itemId) ?? null };
      return { item, raw };
    },
    async recordCheck(row) {
      checks.push(row);
    },
  };
}

export const HARNESS_CLOSING = { ...DEFAULT_CLOSING_SETTINGS, resolutionEngine: 'live' as const };
