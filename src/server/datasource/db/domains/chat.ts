/**
 * The db DataSource, chat domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res, blankItem, ITEM_PATCH_LOCK, resolvedRecord, resolutionLabel } from '../shared';
import { CHAT } from '../reads/scope';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { type ChatMemoryKind, type ChatMessage, type ChatModel, type ChatPart, type ChatResource, type ChatSseEvent, type ChatThread, type PolicyWeights, type Receipt, type Resolution, type ResolutionDetail, type WorkItemPatch as WorkItemPatchT, type WorkItemRecord, ItemsQuery, WorkItemPatch } from '@/contract';
import { engineUpdate } from '@/db/changeset';
import type { Db } from '@/db/client';
import { changeProposals, changeSets, chatMemory, chatMessages, chatThreads, workItems } from '@/db/schema';
import { invalid, notFound } from '@/server/errors';
import { receiptFromChangeSet } from '../audit';
import { chatProposalStatus, contextRefs, mergeThreadContext, runTurn, type DbChatContext } from '../chat';
import type { DbChatKit } from '../chat-be6';
import { deliverPlanAnswer } from '@/llm/chat/plan-waiters';
import { routeChatTurn } from '@/server/chat/route';
import { memorySource, type MemorySourceMessage } from '@/server/chat/memory-source';
import type { DbChatOps, DbChatPatchResult } from '../chat-ops';
import { chatLlmEnabled } from '@/server/chat/backend';
import { createChatHost } from '@/server/chat/host';
import { withBriefSummary } from '@/server/chat/brief';
import { beginChatRun } from '@/server/chat/registry';
import type { ReadModel } from '../model';
import { storedOrderFrom } from '../rank';
import { writeExt, type WriteCtx } from '../store/common';
import { appendChatMessage, insertChatThread, NEW_THREAD_TITLE } from '../store/misc';
import { logTransition, workItemColumns } from '../store/work';
import { hrefFor, hydrateItem, isLive } from '../views';

/** Current weights plus deltas, each clamped to 0–10 (as the mock). */
function weightsWith(base: PolicyWeights, deltas: Partial<PolicyWeights>): PolicyWeights {
  const weights = { ...base };
  for (const [k, d] of Object.entries(deltas)) weights[k as keyof PolicyWeights] = Math.max(0, Math.min(10, (weights[k as keyof PolicyWeights] ?? 0) + (d ?? 0)));
  return weights;
}

/**
 * Undo state of receipt lines from the audit undo/redo chain: auditId → its undo → that undo's undo
 * (redo) → …, following change_sets.undo_of_change_set_id. The latest link is live; an even chain length
 * means the line is currently undone (same reading as the mock's).
 */
async function undoStates(db: Db, userId: string, auditIds: string[]): Promise<Map<string, { undoneAt: string | null; undoAuditId: string | null }>> {
  const out = new Map<string, { undoneAt: string | null; undoAuditId: string | null }>();
  const ids = [...new Set(auditIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!ids.length) return out;
  const res = await db.execute<{ root: string; id: string; depth: number; created_at: Date }>(sql`
    with recursive chain as (
      select cs.id as root, cs.id, 1 as depth, cs.created_at from change_sets cs
       where cs.owner_user_id = ${userId} and cs.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
      union all
      select c.root, n.id, c.depth + 1, n.created_at from chain c join change_sets n on n.undo_of_change_set_id = c.id
       where c.depth < 100
    )
    select distinct on (root) root, id, depth, created_at from chain order by root, depth desc`);
  for (const r of res.rows) {
    if (r.depth === 1) out.set(r.root, { undoneAt: null, undoAuditId: null });
    else out.set(r.root, { undoneAt: r.depth % 2 === 0 ? new Date(r.created_at).toISOString() : null, undoAuditId: r.id });
  }
  return out;
}

/** Persisted parts carry stream-time snapshots; refresh proposal status and receipt undo state on read. */
function hydrateChatMessage(m: ReadModel, msg: ChatMessage, undo: Map<string, { undoneAt: string | null; undoAuditId: string | null }>): ChatMessage {
  if (!msg.parts.some((p) => p.type === 'proposal' || p.type === 'receipt')) return msg;
  return {
    ...msg,
    parts: msg.parts.map((p): ChatPart => {
      if (p.type === 'proposal') {
        const cur = m.get('proposals', p.proposal.id) ?? p.proposal;
        return { ...p, proposal: cur, status: chatProposalStatus(cur.status) };
      }
      if (p.type === 'receipt') return { ...p, receipt: { ...p.receipt, changes: p.receipt.changes.map((c) => ({ ...c, ...(undo.get(c.auditId) ?? { undoneAt: null, undoAuditId: null }) })) } };
      return p;
    }),
  };
}

/** Human labels for receipt / proposal lines (chat edits), as the mock. */
const ITEM_FIELD_LABEL: Record<string, string> = {
  title: 'Title',
  purpose: 'Purpose',
  due: 'Due',
  startBy: 'Start by',
  effort: 'Effort',
  notes: 'Notes',
  initiativeId: 'Initiative',
  accountId: 'Account',
  oppId: 'Opportunity',
  kind: 'Kind',
  state: 'State',
  resolution: 'Resolution',
};

const labelled = (r: Receipt): Receipt => ({ ...r, changes: r.changes.map((c) => (c.label || !ITEM_FIELD_LABEL[c.field] ? c : { ...c, label: ITEM_FIELD_LABEL[c.field] })) });

export class DbChat {
  constructor(private readonly ctx: DbCtx) {}

  // ---- Assistant v2 (H-6): the plan card's answer and memory (src/server/datasource/{db,mock}/chat-memory.ts) ----
  async chatPlanAnswer({ body }: I<'chatPlanAnswer'>): Promise<Res<'chatPlanAnswer'>> {
    return { delivered: deliverPlanAnswer(body.planId, { answer: body.answer, ...(body.note ? { note: body.note } : {}) }) };
  }
  async listChatMemory({ query }: I<'listChatMemory'>): Promise<Res<'listChatMemory'>> {
    if (query?.scope !== 'pinned') return { entries: await this.ctx.ds.chatMemory.list(query?.threadId ?? null) };
    // SEC-8: every pinned entry and preference, any thread, each with the message it came from (as the mock)
    const uid = await this.ctx.userId();
    const rows = await this.ctx.db
      .select()
      .from(chatMemory)
      .where(and(eq(chatMemory.ownerUserId, uid), or(eq(chatMemory.pinned, true), isNull(chatMemory.threadId))))
      .orderBy(asc(chatMemory.createdAt), asc(chatMemory.id));
    if (!rows.length) return { entries: [] };
    // 0038: rows with a stored source read that message by its key; rows written before it, every message up to the latest
    const ids = [...new Set(rows.flatMap((r) => (r.sourceMessageId ? [r.sourceMessageId] : [])))];
    const legacy = rows.filter((r) => !r.sourceMessageId);
    const until = new Date(Math.max(0, ...legacy.map((r) => new Date(r.createdAt).getTime())) + 5_000);
    const which = or(...(ids.length ? [inArray(chatMessages.id, ids)] : []), ...(legacy.length ? [lte(chatMessages.createdAt, until)] : []));
    const msgs = await this.ctx.db
      .select({ id: chatMessages.id, threadId: chatMessages.threadId, threadTitle: chatThreads.title, at: chatMessages.createdAt, text: chatMessages.content })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
      .where(and(eq(chatThreads.ownerUserId, uid), eq(chatMessages.role, 'user'), which));
    const mine: MemorySourceMessage[] = msgs.map((m) => ({ id: m.id, threadId: m.threadId, threadTitle: m.threadTitle ?? NEW_THREAD_TITLE, at: new Date(m.at).toISOString(), text: m.text ?? '' }));
    return {
      entries: rows.map((r) => {
        const e = { id: r.id, threadId: r.threadId, kind: r.kind as ChatMemoryKind, text: r.text, pinned: r.pinned, coversThroughSeq: r.coversThroughSeq ?? null, createdAt: new Date(r.createdAt).toISOString() };
        return { ...e, source: memorySource({ ...e, sourceMessageId: r.sourceMessageId }, mine) };
      }),
    };
  }
  async deleteChatMemory({ params }: I<'deleteChatMemory'>): Promise<Res<'deleteChatMemory'>> {
    return { deleted: await this.ctx.ds.chatMemory.remove(params.id) };
  }

  /**
   * CHAT-1: the default "Today" thread. Only the example seed wrote one, so a real install (a fresh first scan, a
   * teammate's bootstrap) had no thread: the client's Send had nowhere to post and did nothing, and POST /chat without
   * a thread id failed "Chat thread (default) not found". Idempotent: an advisory lock serializes concurrent callers.
   */
  /** Returns true when the model it checked had no default thread (so the caller reloads). */
  private async ensureDefaultChatThread(loaded?: ReadModel): Promise<boolean> {
    if ((loaded ?? (await this.ctx.model(WHOLE))).all('chatThreads').some((t) => t.thread.isDefault)) return false;
    const now = this.ctx.now().toISOString();
    const thread: ChatThread = { id: crypto.randomUUID(), title: 'Today', isDefault: true, createdAt: now, updatedAt: now, messageCount: 0, lastMessagePreview: null, context: [] };
    const { result: created } = await this.ctx.mutate({ action: 'chat.thread', summary: 'Default chat thread: Today', entity: { type: 'chat_thread', id: thread.id }, undoable: false, actor: 'system' }, async (w) => {
      await w.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cc.chat.default:${w.userId}`}))`);
      const has = await w.tx.execute(sql`select 1 from chat_threads where owner_user_id = ${w.userId} and scope = 'day' limit 1`);
      if (has.rows.length) return false;
      await insertChatThread(w, { thread, messages: [] });
      return true;
    });
    if (created) this.ctx.bus.publishTables(['chat_threads'], [thread.id], 'chat.thread');
    // True = the caller's model predates the default thread (made here or by a concurrent caller): reload it.
    return true;
  }

  async listChatThreads(_i: I<'listChatThreads'>): Promise<Res<'listChatThreads'>> {
    // the thread list reads only the threads (post-2.0 read profile: it loaded every collection)
    let m = await this.ctx.model(CHAT);
    if (await this.ensureDefaultChatThread(m)) m = await this.ctx.model(CHAT); // CHAT-1: one model build unless a thread was made
    return { threads: m.all('chatThreads').map((t) => t.thread).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt.localeCompare(a.updatedAt)) };
  }

  /** A new empty thread. Not undoable (like the mock, which does not audit it); its context rides in ext. */
  async createChatThread({ body }: I<'createChatThread'>): Promise<Res<'createChatThread'>> {
    const now = this.ctx.now().toISOString();
    const thread: ChatThread = { id: crypto.randomUUID(), title: body.title ?? NEW_THREAD_TITLE, isDefault: false, createdAt: now, updatedAt: now, messageCount: 0, lastMessagePreview: null, context: contextRefs(body.context, 'auto') };
    await this.ctx.mutate({ action: 'chat.thread', summary: `New thread: ${thread.title}`, entity: { type: 'chat_thread', id: thread.id }, undoable: false }, async (w) => {
      await insertChatThread(w, { thread, messages: [] });
    });
    this.ctx.bus.publishTables(['chat_threads'], [thread.id], 'chat.thread');
    return (await this.ctx.model(WHOLE)).get('chatThreads', thread.id)!.thread;
  }

  async getChatThread({ params }: I<'getChatThread'>): Promise<Res<'getChatThread'>> {
    const m = await this.ctx.model(WHOLE);
    const t = m.get('chatThreads', params.id);
    if (!t) throw notFound('Chat thread', params.id);
    // BE-CHAT first: chat plans (status + the applied receipt after the card) and scan cards
    const messages = await Promise.all(t.messages.map(async (msg) => ({ ...msg, parts: await this.ctx.ds.be6.hydrate(m, msg.parts) })));
    const ids = messages.flatMap((msg) => msg.parts.flatMap((p) => (p.type === 'receipt' ? p.receipt.changes.map((c) => c.auditId) : [])));
    const undo = await undoStates(this.ctx.db, m.ctx.userId, ids);
    return { thread: t.thread, messages: messages.map((msg) => withBriefSummary(hydrateChatMessage(m, msg, undo))) };
  }

  /**
   * One turn: `start` (ids + model = body.model ?? settings.chat.defaultModel), the backend's events, then
   * `done` or `error`. The user message is persisted first; the assistant message exactly once in a
   * `finally` (runTurn). Until BE-6 the backend is not wired: `start`, then the `upstream_unavailable` error.
   */
  async *chat({ body, signal }: I<'chat'> & { signal: AbortSignal }): AsyncGenerator<ChatSseEvent> {
    let m = await this.ctx.model(WHOLE);
    if (!body.threadId && (await this.ensureDefaultChatThread(m))) m = await this.ctx.model(WHOLE); // CHAT-1
    const thread = body.threadId ? m.get('chatThreads', body.threadId) : (m.all('chatThreads').find((t) => t.thread.isDefault) ?? m.all('chatThreads')[0]);
    if (!thread) throw notFound('Chat thread', body.threadId ?? '(default)');
    const threadId = thread.thread.id;
    // Assistant v2 (H-6): the router picks the tier unless the message or Settings ▸ Budgets names a model
    const route = await routeChatTurn({ text: body.text, choice: body.model ?? null, setting: m.settings().chat.routing ?? 'auto', messages: thread.messages, budget: (x) => this.ctx.ds.be6.backend().budget(x), messageUsd: m.settings().chat.messageUsd });
    const model: ChatModel = route.model;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), threadId, role: 'user', at: this.ctx.now().toISOString(), text: body.text, parts: [], context: contextRefs(body.context), isMorningBrief: false };
    await appendChatMessage(this.ctx.db, threadId, userMsg);
    this.ctx.bus.publishTables(['chat_threads'], [threadId], 'chat.message');
    // BE-CHAT: a newer message in this thread (or Stop / the client leaving) cancels this turn.
    const run = beginChatRun(threadId, signal);
    const messageId = crypto.randomUUID();
    const host = createChatHost(this.ctx.ds, { ...this.ctx.ds.be6.backend({ liveConnectors: chatLlmEnabled() && process.env.CC_CHAT_CONNECTORS !== '0' }), spend: () => this.ctx.spendGovernor(m.ctx.userId), memory: this.ctx.ds.chatMemory, applyStaged: async (pid, ds) => (await this.ctx.ds.be6.apply(pid, ds))?.receipt ?? null }, () => this.ctx.now());
    const ctx: DbChatContext = { text: body.text, context: mergeThreadContext(userMsg.context, thread.thread.context), threadId, now: this.ctx.now(), model, route, ops: this.chatOps(), signal: run.signal, messageId, userMessageId: userMsg.id, host, ...(body.allowExtraUsd ? { allowExtraUsd: body.allowExtraUsd } : {}), ...(body.continueMessageId ? { continueMessageId: body.continueMessageId } : {}) };
    try {
      yield* runTurn({ threadId, messageId, userMessageId: userMsg.id, model, route }, this.ctx.chatBackend(ctx), {
        signal: run.signal,
        now: () => this.ctx.now().toISOString(),
        newId: () => crypto.randomUUID(),
        persist: async (msg) => {
          await appendChatMessage(this.ctx.db, threadId, msg);
          // the turn's ledger row was written before the message existed: link it now
          await this.ctx.db.execute(sql`update llm_calls set chat_message_id = ${msg.id}::uuid where purpose = 'chat' and chat_message_id is null and request_hash like ${`chat:${msg.id}:%`}`).catch(() => undefined);
          this.ctx.bus.publishTables(['chat_threads'], [threadId], 'chat.message');
        },
      });
    } finally {
      run.end();
    }
  }

  /** BE-CHAT: the bound helpers chat plans, scans, drafts, sessions and spend use (chat-be6.ts). */
  chatKit(): DbChatKit {
    return {
      db: this.ctx.handle.db,
      now: () => this.ctx.now(),
      userId: () => this.ctx.userId(),
      model: () => this.ctx.model(WHOLE),
      mutate: (m, fn) => this.ctx.mutate({ ...m, actor: 'chat' }, fn),
      writeItem: (w, model, cur, next, o) => this.ctx.writeItem(w, model, cur, next, o),
      rankedIds: () => this.ctx.ds.today.rankedIds(),
      rerankIn: (w, model, policy, rankedIds, now, rowId) => this.ctx.ds.today.rerankIn(w, model, policy, rankedIds, now, rowId),
      resolvedRecord: (model, cur, o) => resolvedRecord(model, cur, o),
      blankItem: (now, me) => blankItem(now, me),
      links: (model) => this.ctx.links(model),
      rankTop: (model, policy, now) => {
        const top = this.ctx.ranker.rank(model, policy, now).ranked[0];
        return top ? { id: top.id, score: top.score } : undefined;
      },
      scoreOf: (model, w, policy, now) => this.ctx.ranker.scoreOf(w, model, policy, now),
      receipt: async (auditId, summary, filter) => labelled(await receiptFromChangeSet(this.ctx.db, auditId, await this.ctx.model(WHOLE), 'chat', summary, this.ctx.now().toISOString(), filter)),
      publish: (tables, ids, reason) => this.ctx.bus.publishTables(tables, ids, reason),
      ...(this.ctx.org62Read ? { readLookup: this.ctx.org62Read } : {}),
      org62Live: !!this.ctx.org62Read || (chatLlmEnabled() && process.env.CC_CHAT_CONNECTORS !== '0'),
    };
  }

  /** Chat ops for the backend (actor `chat`; see chat-ops.ts). */
  chatOps(): DbChatOps {
    const hydrate = async (id: string) => this.ctx.hydrated(id);
    return {
      topItems: async (n) => {
        const m = await this.ctx.model(WHOLE);
        return storedOrderFrom(m, await this.ctx.ds.today.rankedIds()).slice(0, n).map((w) => hydrateItem(m, w));
      },
      findItem: async (q) => {
        const m = await this.ctx.model(WHOLE);
        const w = m.get('workItems', q) ?? m.all('workItems').find((x) => x.title.toLowerCase().includes(q.toLowerCase()));
        return w ? hydrateItem(m, w) : null;
      },
      listItems: async (q) => (await this.ctx.ds.work.listItems({ query: ItemsQuery.parse(q ?? {}) })).items,
      calendarToday: async () => (await this.ctx.ds.calendar.getCalendar({ query: {} })).events,
      settings: async () => (await this.ctx.model(WHOLE)).settings(),
      findAssets: async (q) => {
        const tokens = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
        return (await this.ctx.model(WHOLE)).all('assets').filter((a) => tokens.some((t) => a.title.toLowerCase().includes(t)));
      },
      resourceForAsset: (a): ChatResource => ({ kind: 'asset', id: a.id, label: a.title, href: a.url ?? `/search?q=${encodeURIComponent(a.title)}` }),
      resourceForItem: (w): ChatResource => ({ kind: 'work_item', id: w.id, label: w.title, href: hrefFor({ type: 'work_item', id: w.id }) }),
      moveToTop: async (itemId, reason) => {
        const m0 = await this.ctx.model(WHOLE);
        const w0 = this.ctx.item(m0, itemId);
        const pol = m0.settings().policy;
        const now = this.ctx.now();
        const top = this.ctx.ranker.rank(m0, pol, now).ranked[0];
        const boost = top && top.id !== w0.id ? Math.ceil(top.score - this.ctx.ranker.scoreOf(w0, m0, pol, now) + 1) : 0;
        const rankedIds = await this.ctx.ds.today.rankedIds();
        const r = await this.ctx.mutate({ action: 'chat.move', summary: `Moved to #1: ${w0.title}`, entity: { type: 'work_item', id: itemId }, actor: 'chat' }, async (w, model) => {
          const cur = this.ctx.item(model, itemId);
          await this.ctx.ds.today.priorityFeedbackIn(w, model, cur, 'do_first', 1); // priority@2 R8: "do first" feeds the learning loop
          await this.ctx.writeItem(w, model, cur, { ...cur, signals: { ...cur.signals, boost: cur.signals.boost + boost } }, { bump: true });
          await this.ctx.ds.today.rerankIn(w, model, pol, rankedIds, now);
        });
        return labelled(await receiptFromChangeSet(this.ctx.db, r.auditId, await this.ctx.model(WHOLE), 'chat', `${w0.title} → #1 (${reason})`, now.toISOString(), (table, f) => table === 'work_items' && (f === 'rank' || f === 'signals')));
      },
      addNote: async (itemId, note) => {
        const r = await this.ctx.mutate({ action: 'chat.note', summary: 'Noted', entity: { type: 'work_item', id: itemId }, actor: 'chat' }, async (w, model) => {
          const cur = this.ctx.item(model, itemId);
          await w.tx.update(changeSets).set({ summary: `Noted on ${cur.title}` }).where(eq(changeSets.id, w.cs.id));
          await this.ctx.writeItem(w, model, cur, { ...cur, notes: cur.notes ? `${cur.notes}\n${note}` : note }, { bump: true });
          return cur.title;
        });
        return labelled(await receiptFromChangeSet(this.ctx.db, r.auditId, await this.ctx.model(WHOLE), 'chat', `Added a note to ${r.result}`, this.ctx.now().toISOString()));
      },
      patchItem: (itemId, patch, reason) => this.chatPatchItem(itemId, patch, reason),
      resolveItem: (itemId, resolution, detail, note) => this.chatResolveItem(itemId, resolution, detail ?? {}, note),
      capture: async (text, opts = {}) => {
        const r = await this.ctx.ds.work.captureInternal({ text, ...opts }, 'chat');
        const item = await hydrate(r.result);
        return { item, receipt: labelled(await receiptFromChangeSet(this.ctx.db, r.auditId, await this.ctx.model(WHOLE), 'chat', `Captured ${item.title}`, this.ctx.now().toISOString(), (table, f) => table === 'work_items' && f === 'state')) };
      },
      scan: async (connectorId, scope) => {
        try {
          const { run } = await this.ctx.ds.health.scanInternal(connectorId, scope, 'chat');
          const ok = !['auth_failed', 'transient_failed', 'budget_exceeded', 'aborted'].includes(run.status);
          return { ok, run, summary: ok ? `Scan ${run.id.slice(-6)} queued; it shows in the Health ledger` : (run.error ?? 'Scan failed') };
        } catch (err) {
          return { ok: false, run: null, summary: (err as Error).message };
        }
      },
      policyPreview: async (deltas) => {
        const m = await this.ctx.model(WHOLE);
        return this.ctx.ds.settingsDomain.preview(m, storedOrderFrom(m, await this.ctx.ds.today.rankedIds()), { ...m.settings().policy, weights: weightsWith(m.settings().policy.weights, deltas) });
      },
      policyApply: async (deltas, note) => {
        const m = await this.ctx.model(WHOLE);
        const pol = m.settings().policy;
        const weights = weightsWith(pol.weights, deltas);
        const preview = this.ctx.ds.settingsDomain.preview(m, storedOrderFrom(m, await this.ctx.ds.today.rankedIds()), { ...pol, weights });
        const r = await this.ctx.ds.settingsDomain.applyPolicyInternal(weights, pol.rules, note, 'chat', pol.version);
        return { receipt: r.receipt, preview };
      },
      proposeItemPatch: async (itemId, patch, reason) => {
        let pid = '';
        await this.ctx.mutate({ action: 'chat.propose', summary: reason, entity: { type: 'work_item', id: itemId }, actor: 'chat' }, async (w, model) => {
          pid = await this.chatPropose(w, model, this.ctx.item(model, itemId), patch as Record<string, unknown>, reason);
        });
        return this.ctx.ds.nba.proposal(await this.ctx.model(WHOLE), pid);
      },
    };
  }

  /** Stage chat field changes as one proposal group (Apply / Keep mine). */
  private async chatPropose(w: WriteCtx, model: ReadModel, cur: WorkItemRecord, patch: Record<string, unknown>, reason: string): Promise<string> {
    const labels = Object.fromEntries(Object.keys(patch).filter((f) => ITEM_FIELD_LABEL[f]).map((f) => [f, ITEM_FIELD_LABEL[f]!]));
    return this.stageRecord(w, model, cur, { ...cur, ...patch } as WorkItemRecord, reason, 'chat', labels);
  }

  /**
   * Stage `next` as one proposal group instead of writing it: the changed columns go through the engine
   * path of the change-set helper with lockAll, so the rows are real change_proposals that applyProposal
   * can apply. Fields with no column of their own (startBy) cannot be staged.
   */
  async stageRecord(w: WriteCtx, model: ReadModel, cur: WorkItemRecord, next: WorkItemRecord, reason: string, actor: 'chat' | 'engine', labels: Record<string, string> = {}): Promise<string> {
    const a = workItemColumns(cur, w);
    const b = workItemColumns(next, w);
    const cols: Record<string, unknown> = {};
    for (const k of Object.keys(b) as (keyof typeof b)[]) if (k !== 'id' && k !== 'ownerUserId' && k !== 'origin' && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) cols[k] = b[k];
    if (!Object.keys(cols).length) throw invalid('Nothing to propose: no stored column changes');
    const res = await engineUpdate(w.tx, workItems, cur.id, cols as never, { lockAll: true, reason });
    const pid = res.proposals[0]?.proposalId;
    if (!pid) throw invalid('Nothing to propose: the values are unchanged');
    const [row] = await w.tx.select({ g: changeProposals.groupId }).from(changeProposals).where(eq(changeProposals.id, pid));
    const groupId = row!.g;
    await writeExt(w, 'change_proposals', groupId, { actor: actor === 'engine' ? undefined : actor, label: cur.title, labels: Object.keys(labels).length ? labels : undefined });
    model.remove('proposals', groupId);
    return groupId;
  }

  /**
   * A chat field edit: actor `chat`, undoable, never adds userLockedFields; a field the user already
   * locked does not change and becomes a proposal instead (same change set).
   */
  private async chatPatchItem(itemId: string, patch: WorkItemPatchT, reason: string): Promise<DbChatPatchResult> {
    const parsed = WorkItemPatch.safeParse(patch);
    if (!parsed.success) throw invalid(`Invalid patch: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    let applied: string[] = [];
    const pids: string[] = [];
    let title = '';
    const r = await this.ctx.mutate({ action: 'chat.edit', summary: reason, entity: { type: 'work_item', id: itemId }, actor: 'chat' }, async (w, model) => {
      const cur = this.ctx.item(model, itemId);
      title = cur.title;
      const locked = new Set<string>(cur.userLockedFields);
      const apply: Record<string, unknown> = {};
      const staged: Record<string, unknown> = {};
      for (const [f, v] of Object.entries(parsed.data)) {
        if (v === undefined) continue;
        if (locked.has(ITEM_PATCH_LOCK[f] ?? f)) staged[f] = v;
        else if (JSON.stringify((cur as Record<string, unknown>)[f] ?? null) !== JSON.stringify(v)) apply[f] = v;
      }
      applied = Object.keys(apply);
      await w.tx.update(changeSets).set({ summary: `${reason}: ${cur.title}` }).where(eq(changeSets.id, w.cs.id));
      let next = cur;
      if (applied.length) {
        next = { ...cur, ...apply } as WorkItemRecord; // userLockedFields unchanged on purpose
        await this.ctx.writeItem(w, model, cur, next, { bump: true });
      }
      for (const [f, v] of Object.entries(staged)) pids.push(await this.chatPropose(w, model, next, { [f]: v }, `${reason} (you set ${ITEM_FIELD_LABEL[f] ?? f} yourself)`));
    });
    const m = await this.ctx.model(WHOLE);
    const receipt = applied.length && r.undoable ? labelled(await receiptFromChangeSet(this.ctx.db, r.auditId, m, 'chat', `${reason}: ${title}`, this.ctx.now().toISOString(), (table, f) => table === 'work_items' && applied.includes(f))) : null;
    return { item: hydrateItem(m, this.ctx.item(m, itemId)), receipt, proposals: await Promise.all(pids.map((p) => this.ctx.ds.nba.proposal(m, p))) };
  }

  /** Chat closes an item with an R-UI-22 resolution (doneBy `chat`). A user-locked state becomes a proposal. */
  private async chatResolveItem(itemId: string, resolution: Resolution, detail: Partial<Omit<ResolutionDetail, 'inferred'>>, note?: string): Promise<DbChatPatchResult> {
    const m0 = await this.ctx.model(WHOLE);
    const cur0 = this.ctx.item(m0, itemId);
    if (!isLive(cur0) && cur0.state !== 'snoozed' && cur0.state !== 'suggested') throw invalid(`Cannot resolve a ${cur0.state} item`);
    const label = resolutionLabel(resolution, detail.personName ?? (detail.personId ? m0.get('people', detail.personId)?.name : undefined));
    if (cur0.userLockedFields.includes('state')) {
      let pid = '';
      await this.ctx.mutate({ action: 'chat.propose', summary: `${label} (asked in chat)`, entity: { type: 'work_item', id: itemId }, actor: 'chat' }, async (w, model) => {
        pid = await this.chatPropose(w, model, this.ctx.item(model, itemId), { state: 'done', resolution }, `${label} (asked in chat)`);
      });
      const m = await this.ctx.model(WHOLE);
      return { item: hydrateItem(m, this.ctx.item(m, itemId)), receipt: null, proposals: [await this.ctx.ds.nba.proposal(m, pid)] };
    }
    const summary = `${label}: ${cur0.title}`;
    const r = await this.ctx.mutate({ action: 'chat.resolve', summary, entity: { type: 'work_item', id: itemId }, actor: 'chat', current: () => this.ctx.hydrated(itemId) }, async (w, model) => {
      const cur = this.ctx.item(model, itemId);
      const next = resolvedRecord(model, cur, { reason: label, resolution, detail: note ? { ...detail, note } : detail, doneBy: 'chat', at: w.now.toISOString() });
      await this.ctx.writeItem(w, model, cur, next, { bump: true });
      await logTransition(w, cur.id, cur.state, next.state, label);
    });
    const m = await this.ctx.model(WHOLE);
    const receipt = labelled(await receiptFromChangeSet(this.ctx.db, r.auditId, m, 'chat', summary, this.ctx.now().toISOString(), (table, f) => table === 'work_items' && (f === 'state' || f === 'resolution')));
    return { item: hydrateItem(m, this.ctx.item(m, itemId)), receipt, proposals: [] };
  }
}
