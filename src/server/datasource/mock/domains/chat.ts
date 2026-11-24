/**
 * The mock DataSource, chat domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id, I, Res, blankItem, ITEM_PATCH_LOCK, resolutionLabel } from '../shared';
import { type AuditEntry, type ChatMessage, type ChatModel, type ChatPart, type ChatProposalStatus, type ChatResource, type ChatSseEvent, type ChatThread, type ContextRef, type PolicyWeights, type Proposal, type Receipt, type ReceiptChange, type Resolution, type ResolutionDetail, type WorkItem, type WorkItemPatch as WorkItemPatchT, type WorkItemRecord, EntityType as EntityTypeSchema, ItemsQuery, WorkItemPatch } from '@/contract';
import { pickChatScript } from '@/mock/chat-script';
import type { ChatTurnRunner } from '@/llm/chat/types';
import { mockWantsRunner } from '@/server/chat/backend';
import { createChatHost } from '@/server/chat/host';
import { withBriefSummary } from '@/server/chat/brief';
import { beginChatRun } from '@/server/chat/registry';
import { runTurn } from '@/server/chat/turn';
import { invalid, notFound } from '@/server/errors';
import type { ChatOps, ChatPatchResult, ChatScriptContext } from '../chat-runtime';
import type { MockChatKit } from '../chat-be6';
import { deliverPlanAnswer } from '@/llm/chat/plan-waiters';
import { continuationOf } from '@/llm/chat/router';
import { routeChatTurn } from '@/server/chat/route';
import { memorySource, type MemorySourceMessage } from '@/server/chat/memory-source';
import { computeRanking, scoreItem, storedOrder } from '../rank';
import { buildItems, hrefFor, hydrateItem, isLive, itemRef, windowOrToday } from '../views';

/** Human labels for receipt / proposal lines (chat edits). */
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const NEW_THREAD_TITLE = 'New thread';

/** "move Globex prep after lunch and find the deck…" → "move Globex prep after lunch and find the…" */
function threadTitleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= 48 ? one || NEW_THREAD_TITLE : `${one.slice(0, 47).replace(/\s+\S*$/, '')}…`;
}

/** Chat card state: rejected and superseded both read as dismissed. */
function chatProposalStatus(s: Proposal['status']): ChatProposalStatus {
  return s === 'pending' ? 'pending' : s === 'applied' ? 'applied' : 'dismissed';
}

export class MockChat {
  constructor(private readonly ctx: MockCtx) {}

  /** The chat intents' runner (MockOptions.chatRunner, else the deterministic fake model); set once by MockDataSource. */
  chatRunner!: ChatTurnRunner;

  // ---- Assistant v2 (H-6): the plan card's answer and memory (src/server/datasource/{db,mock}/chat-memory.ts) ----
  async chatPlanAnswer({ body }: I<'chatPlanAnswer'>): Promise<Res<'chatPlanAnswer'>> {
    return { delivered: deliverPlanAnswer(body.planId, { answer: body.answer, ...(body.note ? { note: body.note } : {}) }) };
  }
  async listChatMemory({ query }: I<'listChatMemory'>): Promise<Res<'listChatMemory'>> {
    if (query?.scope !== 'pinned') return { entries: await this.ctx.ds.chatMemory.list(query?.threadId ?? null) };
    // SEC-8: every pinned entry and preference, any thread, each with the message it came from
    const threads = this.ctx.store.all('chatThreads');
    const entries = (await Promise.all(threads.map((t) => this.ctx.ds.chatMemory.list(t.thread.id)).concat(this.ctx.ds.chatMemory.list(null)))).flat();
    const kept = [...new Map(entries.filter((e) => e.pinned || e.threadId === null).map((e) => [e.id, e])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const mine: MemorySourceMessage[] = threads.flatMap((t) => t.messages.filter((m) => m.role === 'user').map((m) => ({ id: m.id, threadId: t.thread.id, threadTitle: t.thread.title, at: m.at, text: m.text })));
    return { entries: kept.map((e) => ({ ...e, source: memorySource({ ...e, sourceMessageId: this.ctx.ds.chatMemory.sourceMessageIdOf(e.id) }, mine) })) };
  }
  async deleteChatMemory({ params }: I<'deleteChatMemory'>): Promise<Res<'deleteChatMemory'>> {
    return { deleted: await this.ctx.ds.chatMemory.remove(params.id) };
  }

  async listChatThreads(_i: I<'listChatThreads'>): Promise<Res<'listChatThreads'>> {
    return { threads: this.ctx.store.all('chatThreads').map((t) => t.thread).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt.localeCompare(a.updatedAt)) };
  }

  async createChatThread({ body }: I<'createChatThread'>): Promise<Res<'createChatThread'>> {
    const now = this.ctx.nowIso();
    const thread: ChatThread = {
      id: id('thread'),
      title: body.title ?? NEW_THREAD_TITLE,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastMessagePreview: null,
      context: this.contextRefs(body.context, 'auto'),
    };
    // Not audited (like chat messages): there is nothing to undo in an empty thread.
    this.ctx.tx({ actor: 'user', action: 'chat.thread', summary: `New thread: ${thread.title}`, entity: { type: 'chat_thread', id: thread.id, label: thread.title }, audit: false }, (tx) => tx.put('chatThreads', { thread, messages: [] }));
    return thread;
  }

  async getChatThread({ params }: I<'getChatThread'>): Promise<Res<'getChatThread'>> {
    const t = this.ctx.store.must('chatThreads', params.id, 'Chat thread');
    return { thread: t.thread, messages: t.messages.map((m) => withBriefSummary(this.hydrateChatMessage(m))) };
  }

  /** Persisted parts carry stream-time snapshots; refresh what changed since (proposal status, receipt undo state). */
  private hydrateChatMessage(m: ChatMessage): ChatMessage {
    if (!m.parts.some((p) => p.type === 'proposal' || p.type === 'receipt' || p.type === 'tool')) return m;
    return {
      ...m,
      // BE-CHAT first: chat plans (status + the applied receipt after the card) and scan cards
      parts: this.ctx.ds.be6.hydrate(m.parts).map((p): ChatPart => {
        if (p.type === 'proposal' && this.ctx.ds.be6.plans.has(p.proposal.id)) return p;
        if (p.type === 'proposal') {
          const cur = this.ctx.store.get('proposals', p.proposal.id) ?? p.proposal;
          return { ...p, proposal: cur, status: chatProposalStatus(cur.status) };
        }
        if (p.type === 'receipt') return { ...p, receipt: { ...p.receipt, changes: p.receipt.changes.map((c) => ({ ...c, ...this.undoStateOf(c.auditId) })) } };
        return p;
      }),
    };
  }

  /**
   * Undo state of one receipt line from the audit log. The undo/redo chain is auditId → its undo → that
   * undo's undo (redo) → …; the last entry is the live one. An even-length chain means the line is undone.
   */
  private undoStateOf(auditId: string): { undoneAt: string | null; undoAuditId: string | null } {
    let cur = this.ctx.audit.get(auditId);
    if (!cur) return { undoneAt: null, undoAuditId: null };
    let length = 1;
    while (cur.undoneAt) {
      const curId: string = cur.id;
      const next: AuditEntry | undefined = this.ctx.audit.entries.find((e) => e.undoOf === curId);
      if (!next) break;
      cur = next;
      length++;
    }
    if (length === 1) return { undoneAt: null, undoAuditId: null };
    return { undoneAt: length % 2 === 0 ? cur.at : null, undoAuditId: cur.id };
  }

  /** Chat context chips from a request. Unknown entity types are dropped (the stored message must stay contract-valid). */
  private contextRefs(input: Array<{ type: string; id: string; label: string; via?: 'auto' | 'explicit' }>, via?: 'auto' | 'explicit'): ContextRef[] {
    const out: ContextRef[] = [];
    for (const c of input) {
      const t = EntityTypeSchema.safeParse(c.type);
      if (t.success) out.push({ type: t.data, id: c.id, label: c.label, via: via ?? c.via ?? 'explicit' });
    }
    return out;
  }

  private appendMessage(threadId: string, msg: ChatMessage) {
    const t = this.ctx.store.must('chatThreads', threadId, 'Chat thread');
    // An untitled thread takes its title from the first thing you asked.
    const title = msg.role === 'user' && t.messages.length === 0 && t.thread.title === NEW_THREAD_TITLE && !t.thread.isDefault ? threadTitleFrom(msg.text) : t.thread.title;
    this.ctx.tx({ actor: msg.role === 'user' ? 'user' : 'chat', action: 'chat.message', summary: 'Message', entity: { type: 'chat_thread', id: threadId, label: title }, audit: false }, (tx) =>
      tx.put('chatThreads', {
        thread: { ...t.thread, title, updatedAt: msg.at, messageCount: t.messages.length + 1, lastMessagePreview: msg.text.slice(0, 120) || t.thread.lastMessagePreview },
        messages: [...t.messages, msg],
      }),
    );
  }

  chatOps(): ChatOps {
    return {
      topItems: (n) => storedOrder(this.ctx.store).slice(0, n).map((w) => hydrateItem(this.ctx.store, w)),
      findItem: (q) => {
        const byId = this.ctx.store.get('workItems', q);
        if (byId) return hydrateItem(this.ctx.store, byId);
        const ql = q.toLowerCase();
        const w = this.ctx.store.all('workItems').find((x) => x.title.toLowerCase().includes(ql));
        return w ? hydrateItem(this.ctx.store, w) : null;
      },
      listItems: (q) => buildItems(this.ctx.store, ItemsQuery.parse(q ?? {})).items,
      calendarToday: () => {
        const { from, to } = windowOrToday(this.ctx.now());
        return this.ctx.store
          .all('events')
          .filter((e) => Date.parse(e.start) >= from.getTime() && Date.parse(e.start) <= to.getTime())
          .sort((a, b) => a.start.localeCompare(b.start));
      },
      settings: () => this.ctx.store.settings(),
      moveToTop: (itemId, reason) => {
        const w = this.ctx.item(itemId);
        const pol = this.ctx.store.settings().policy;
        const now = this.ctx.now();
        const top = computeRanking(this.ctx.store, pol, now)[0];
        const mine = scoreItem(w, this.ctx.store, pol, now).score;
        const boost = top && top.id !== w.id ? Math.ceil(top.score - mine + 1) : 0;
        this.ctx.ds.priority.record(this.ctx.store, now, { itemId: w.id, action: 'do_first', fromRank: w.rank, toRank: 1 }); // priority@2 R8
        const r = this.ctx.ds.today.rerankAll('chat', 'chat.move', `Moved to #1: ${w.title}`, undefined, (tx) => {
          tx.put('workItems', this.ctx.bump({ ...w, signals: { ...w.signals, boost: w.signals.boost + boost } }));
        });
        return this.ctx.receiptFrom(r.entry, r.ops, 'chat', `${w.title} → #1 (${reason})`, (op, f) => op.col === 'workItems' && (f === 'rank' || f === 'signals'))!;
      },
      addNote: (itemId, note) => {
        const w = this.ctx.item(itemId);
        const r = this.ctx.tx({ actor: 'chat', action: 'chat.note', summary: `Noted on ${w.title}`, entity: itemRef(w) }, (tx) => tx.put('workItems', this.ctx.bump({ ...w, notes: w.notes ? `${w.notes}\n${note}` : note })));
        return this.labelled(this.ctx.receiptFrom(r.entry, r.ops, 'chat', `Added a note to ${w.title}`))!;
      },
      patchItem: (itemId, patch, reason) => this.chatPatchItem(itemId, patch, reason),
      resolveItem: (itemId, resolution, detail, note) => this.chatResolveItem(itemId, resolution, detail ?? {}, note),
      capture: (text, opts = {}) => {
        const { item, entry } = this.ctx.ds.work.captureInternal({ text, ...opts }, 'chat');
        const line: ReceiptChange = { auditId: entry!.id, entity: itemRef(item), field: 'state', label: 'Captured', before: null, after: item.state };
        return { item, receipt: { id: id('rcpt'), at: entry!.at, actor: 'chat', summary: `Captured ${item.title}`, changes: [line], staged: false } };
      },
      scan: (connectorId, scope) => {
        try {
          const { run } = this.ctx.ds.health.scanInternal(connectorId, scope, 'chat');
          const ok = !['auth_failed', 'transient_failed', 'budget_exceeded', 'aborted'].includes(run.status);
          return { ok, run, summary: ok ? `Scan ${run.id.slice(-6)} started (${run.kind}); it shows in the Health ledger` : (run.error ?? 'Scan failed') };
        } catch (err) {
          return { ok: false, run: null, summary: (err as Error).message };
        }
      },
      policyPreview: (deltas) => this.ctx.ds.settingsDomain.preview({ ...this.ctx.store.settings().policy, weights: this.weightsWith(deltas) }),
      policyApply: (deltas, note) => {
        const pol = this.ctx.store.settings().policy;
        const weights = this.weightsWith(deltas);
        const preview = this.ctx.ds.settingsDomain.preview({ ...pol, weights });
        const r = this.ctx.ds.settingsDomain.applyPolicyInternal(weights, pol.rules, note, 'chat');
        return { receipt: r.receipt!, preview };
      },
      proposeItemPatch: (itemId, patch, reason) => this.chatPropose(this.ctx.item(itemId), patch, reason),
      proposePolicy: (deltas, note) => {
        const pol = this.ctx.store.settings().policy;
        const weights = this.weightsWith(deltas);
        const preview = this.ctx.ds.settingsDomain.preview({ ...pol, weights });
        let pid = '';
        this.ctx.tx({ actor: 'chat', action: 'chat.propose_policy', summary: note, entity: { type: 'policy', id: pol.id, label: pol.name }, audit: false }, (tx) => {
          pid = this.ctx.ds.engine.propose(
            tx,
            { type: 'policy', id: pol.id, label: pol.name },
            Object.keys(deltas).map((k) => ({ field: `weights.${k}`, label: k.replace(/_/g, ' '), before: pol.weights[k as keyof PolicyWeights], after: weights[k as keyof PolicyWeights] })),
            note,
            pol.version,
            'chat',
            null,
          );
        });
        return { proposal: this.ctx.store.get('proposals', pid)!, preview };
      },
      findAssets: (q) => {
        const tokens = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
        return this.ctx.store.all('assets').filter((a) => tokens.some((t) => a.title.toLowerCase().includes(t)));
      },
      resourceForAsset: (a): ChatResource => ({ kind: 'asset', id: a.id, label: a.title, href: a.url ?? `/search?q=${encodeURIComponent(a.title)}` }),
      resourceForItem: (w: WorkItem): ChatResource => ({ kind: 'work_item', id: w.id, label: w.title, href: hrefFor({ type: 'work_item', id: w.id }) }),
    };
  }

  /** Current weights plus deltas, each clamped to 0–10. */
  private weightsWith(deltas: Partial<PolicyWeights>): PolicyWeights {
    const weights = { ...this.ctx.store.settings().policy.weights } as PolicyWeights;
    for (const [k, d] of Object.entries(deltas)) weights[k as keyof PolicyWeights] = Math.max(0, Math.min(10, (weights[k as keyof PolicyWeights] ?? 0) + (d ?? 0)));
    return weights;
  }

  /** Add human labels to receipt lines. */
  private labelled(r: Receipt | null | undefined): Receipt | null {
    if (!r) return null;
    return { ...r, changes: r.changes.map((c) => (c.label || !ITEM_FIELD_LABEL[c.field] ? c : { ...c, label: ITEM_FIELD_LABEL[c.field] })) };
  }

  /** Stage a chat field change (Apply / Keep mine). Not audited until applied. */
  private chatPropose(w: WorkItemRecord, patch: Record<string, unknown>, reason: string): Proposal {
    let pid = '';
    this.ctx.tx({ actor: 'chat', action: 'chat.propose', summary: reason, entity: itemRef(w), audit: false }, (tx) => {
      pid = this.ctx.ds.engine.propose(tx, itemRef(w), Object.entries(patch).map(([f, v]) => ({ field: f, ...(ITEM_FIELD_LABEL[f] ? { label: ITEM_FIELD_LABEL[f] } : {}), before: (w as Record<string, unknown>)[f] ?? null, after: v })), reason, w.version, 'chat', null);
    });
    return this.ctx.store.get('proposals', pid)!;
  }

  /**
   * A chat field edit. Audited as actor `chat` and undoable; it never adds `userLockedFields` (only user
   * edits lock). A field the user already locked does not change: it becomes a proposal instead.
   */
  private chatPatchItem(itemId: string, patch: WorkItemPatchT, reason: string): ChatPatchResult {
    const parsed = WorkItemPatch.safeParse(patch);
    if (!parsed.success) throw invalid(`Invalid patch: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const cur = this.ctx.item(itemId);
    const locked = new Set<string>(cur.userLockedFields);
    const apply: Record<string, unknown> = {};
    const staged: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (locked.has(ITEM_PATCH_LOCK[f] ?? f)) staged[f] = v;
      else if (JSON.stringify((cur as Record<string, unknown>)[f] ?? null) !== JSON.stringify(v)) apply[f] = v;
    }
    let receipt: Receipt | null = null;
    let next = cur;
    if (Object.keys(apply).length) {
      next = this.ctx.bump({ ...cur, ...apply } as WorkItemRecord); // userLockedFields unchanged on purpose
      const summary = `${reason}: ${cur.title}`;
      const r = this.ctx.tx({ actor: 'chat', action: 'chat.edit', summary, entity: itemRef(cur) }, (tx) => tx.put('workItems', next));
      receipt = this.labelled(this.ctx.receiptFrom(r.entry, r.ops, 'chat', summary, (op, f) => op.col === 'workItems' && f in apply));
    }
    const proposals = Object.entries(staged).map(([f, v]) => this.chatPropose(next, { [f]: v }, `${reason} (you set ${ITEM_FIELD_LABEL[f] ?? f} yourself)`));
    return { item: hydrateItem(this.ctx.store, this.ctx.item(itemId)), receipt, proposals };
  }

  /** Chat closes an item with an R-UI-22 resolution (doneBy `chat`). A user-locked state becomes a proposal. */
  private chatResolveItem(itemId: string, resolution: Resolution, detail: Partial<Omit<ResolutionDetail, 'inferred'>>, note?: string): ChatPatchResult {
    const cur = this.ctx.item(itemId);
    if (!isLive(cur) && cur.state !== 'snoozed' && cur.state !== 'suggested') throw invalid(`Cannot resolve a ${cur.state} item`);
    const label = resolutionLabel(resolution, detail.personName ?? (detail.personId ? this.ctx.store.get('people', detail.personId)?.name : undefined));
    if (cur.userLockedFields.includes('state')) {
      return { item: hydrateItem(this.ctx.store, cur), receipt: null, proposals: [this.chatPropose(cur, { state: 'done', resolution }, `${label} (asked in chat)`)] };
    }
    const next = this.ctx.bump(this.ctx.ds.work.resolvedRecord(cur, { reason: label, resolution, detail: note ? { ...detail, note } : detail, doneBy: 'chat' }));
    const summary = `${label}: ${cur.title}`;
    const r = this.ctx.tx({ actor: 'chat', action: 'chat.resolve', summary, entity: itemRef(cur) }, (tx) => tx.put('workItems', next));
    const receipt = this.labelled(this.ctx.receiptFrom(r.entry, r.ops, 'chat', summary, (op, f) => op.col === 'workItems' && (f === 'state' || f === 'resolution')));
    return { item: hydrateItem(this.ctx.store, next), receipt, proposals: [] };
  }

  async *chat({ body, signal }: I<'chat'> & { signal: AbortSignal }): AsyncGenerator<ChatSseEvent> {
    const thread = body.threadId ? this.ctx.store.get('chatThreads', body.threadId) : this.ctx.store.all('chatThreads').find((t) => t.thread.isDefault) ?? this.ctx.store.all('chatThreads')[0];
    if (!thread) throw notFound('Chat thread', body.threadId ?? '(default)');
    const threadId = thread.thread.id;
    // Assistant v2 (H-6): the router picks the tier unless the message or Settings ▸ Budgets names a model
    const route = await routeChatTurn({ text: body.text, choice: body.model ?? null, setting: this.ctx.store.settings().chat.routing ?? 'auto', messages: thread.messages, budget: (x) => this.ctx.ds.be6.backend().budget(x), messageUsd: this.ctx.store.settings().chat.messageUsd });
    const model: ChatModel = route.model;
    // P31-1: a typed "continue" after a step-stop continues that answer, so the runner takes it (no scripted demo)
    const continuesStop = continuationOf(thread.messages, { text: body.text }) !== null;
    const userMsg: ChatMessage = { id: id('msg'), threadId, role: 'user', at: this.ctx.nowIso(), text: body.text, parts: [], context: this.contextRefs(body.context), isMorningBrief: false };
    this.appendMessage(threadId, userMsg);
    const messageId = id('msg');
    const threadContext = (thread.thread.context ?? []).filter((c) => !userMsg.context.some((u) => u.type === c.type && u.id === c.id)).map((c) => ({ ...c, via: 'auto' as const }));
    const context = [...userMsg.context, ...threadContext];
    // BE-CHAT: a newer message in this thread (or Stop / the client leaving) cancels this turn.
    const run = beginChatRun(threadId, signal);
    // BE-CHAT intents (proposals, scans, drafts, sessions) go to the runner over the fake model; the rest keep the scripted demos.
    const scriptCtx: ChatScriptContext = { text: body.text, context, threadId, now: this.ctx.now(), model, ops: this.chatOps() };
    const steps = mockWantsRunner(body.text) || body.continueMessageId || continuesStop
      ? this.chatRunner({ threadId, messageId, userMessageId: userMsg.id, text: body.text, context, model, signal: run.signal, ...(body.allowExtraUsd ? { allowExtraUsd: body.allowExtraUsd } : {}), ...(body.continueMessageId ? { continueMessageId: body.continueMessageId } : {}), route }, createChatHost(this.ctx.ds, { ...this.ctx.ds.be6.backend(), spend: () => this.ctx.spendGov, memory: this.ctx.ds.chatMemory, applyStaged: async (pid, ds) => (await this.ctx.ds.be6.apply(pid, ds))?.receipt ?? null }, () => this.ctx.now()))
      : pickChatScript(body.text, scriptCtx).run(scriptCtx);
    try {
      yield* runTurn({ threadId, messageId, userMessageId: userMsg.id, model, route }, steps, {
        signal: run.signal,
        now: () => this.ctx.nowIso(),
        newId: () => id('tool'),
        persist: (m) => this.appendMessage(threadId, m),
        chunkText: true,
        textChunkMs: this.ctx.delays.chatTokenMs,
        toolPauseMs: this.ctx.delays.chatTokenMs * 12,
      });
    } finally {
      run.end();
    }
  }

  /** BE-CHAT: the bound helpers the chat plans, scans, drafts and sessions use (chat-be6.ts). */
  chatKit(): MockChatKit {
    return {
      store: () => this.ctx.store,
      now: () => this.ctx.now(),
      stepMs: this.ctx.delays.stepMs,
      tx: (m, fn) => this.ctx.tx(m, fn),
      rerankAll: (actor, action, summary, policy, extra) => this.ctx.ds.today.rerankAll(actor, action, summary, policy, extra),
      receiptFrom: (entry, ops, actor, summary, filter) => this.ctx.receiptFrom(entry, ops, actor, summary, filter),
      labelled: (r) => this.labelled(r),
      bump: (v) => this.ctx.bump(v),
      resolvedRecord: (cur, o) => this.ctx.ds.work.resolvedRecord(cur, o),
      addEvidence: (tx, wid, role, source, summary, isNew) => this.ctx.addEvidence(tx, wid, role, source, summary, isNew),
      blankItem: (now) => blankItem(now, this.ctx.store.meta().user),
      topBoost: (w) => {
        const pol = this.ctx.store.settings().policy;
        const now = this.ctx.now();
        const top = computeRanking(this.ctx.store, pol, now)[0];
        const mine = scoreItem(w, this.ctx.store, pol, now).score;
        return top && top.id !== w.id ? Math.ceil(top.score - mine + 1) : 0;
      },
      undoStateOf: (auditId) => this.undoStateOf(auditId),
      later: (ms, fn) => this.ctx.later(ms, fn),
      enrich: (itemId) => this.ctx.ds.work.enrich(itemId),
      publish: (topics, ids, reason) => this.ctx.publish(topics, ids, reason),
      history: (threadId, exclude) => (this.ctx.store.get('chatThreads', threadId)?.messages ?? []).filter((m) => !exclude.includes(m.id)).map((m) => this.hydrateChatMessage(m)),
    };
  }
}
