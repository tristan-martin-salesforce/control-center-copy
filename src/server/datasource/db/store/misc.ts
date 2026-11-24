/**
 * Chat threads, missed-opp findings, triage mapping questions, spine slots and seeded history.
 *
 * chat_threads: title · isDefault ⇔ scope 'day' (the "Today" thread) · updatedAt → last_message_at.
 *   chat_messages: seq · role · text → content · model · parts/context/isMorningBrief/status/usage → content_blocks.
 *   messageCount / lastMessagePreview are derived (ext override when a seed disagrees, valid while the
 *   thread holds exactly the seeded messages). Thread context (POST /chat/threads) → ext.
 * missed_opp_findings: opportunity_id (an opportunities row; findings on opps outside the book get a
 *   `findingOnly` row) · first/last sweep → missed_opp_sweeps · verdict · tier (claim →
 *   strong_evidence_no_dc, check → light_touch) · evidence → evidence_summary (one line each) · status ·
 *   dismissReason → dismissed_reason · claimedWorkItemId → work_item_id · foundAt → created_at.
 *   oppName/accountName/amount/stage/closeDate come from the opportunity. Ext: otherDcs, a null oppId.
 * Mapping questions ("Is #proj-falcon ACME or Globex?"): DATA-MODEL Q9 derives them from low-confidence
 *   source_item_links; the question text and choices have no columns, so they live in
 *   `cc.ext/mapping_questions/<id>` until BE-2's mapper writes links.
 * Spine slots: the day plan's labels. priority_plan_steps needs a work item or event per step
 *   (priority_plan_steps_target_chk), and gap slots have neither, so the slots are `cc.plan.slots`
 *   until ENGINES-core's planner writes plan steps.
 * Seeded history (Seed.audit): display-only change_sets rows (undoable = false, closed) whose field
 *   changes live in `cc.ext/change_sets/<id>`.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { AuditEntry, ChatMessage, ChatThread, ChatThreadDetail, MappingQuestion, MissedOpp, SpineSlot } from '@/contract';
import type { Db, Tx } from '@/db/client';
import { changeSets, chatMessages, chatThreads, dealContributionRequests, missedOppFindings, missedOppSweeps } from '@/db/schema';

import { findingStatusFromDb, findingStatusToDb } from '../enums';
import { extKey } from '../ext';
import { uuidFor } from '../ids';
import { ext, isoReq, orderedAt, toDate, updateRow, writeExt, writeKv, type ReadCtx, type WriteCtx } from './common';

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * Thread side-car: the context it was opened with, plus a seed's messageCount / preview overrides. The
 * overrides hold only while the thread still has exactly the seeded messages (`atCount`), so appending a
 * message (an unaudited chat_messages insert) needs no side-car write.
 */
interface ThreadExt {
  context: ChatThread['context'];
  messageCount: number;
  lastMessagePreview: string | null;
  previewNull: boolean;
  atCount: number;
}

type Blocks = [{ context?: ChatMessage['context']; isMorningBrief?: boolean; parts?: ChatMessage['parts']; status?: ChatMessage['status']; usage?: ChatMessage['usage']; route?: ChatMessage['route'] }?];

export const NEW_THREAD_TITLE = 'New thread';

export async function loadChat(rc: ReadCtx): Promise<ChatThreadDetail[]> {
  const threads = await rc.db.select().from(chatThreads).where(eq(chatThreads.ownerUserId, rc.userId)).orderBy(asc(chatThreads.createdAt));
  if (!threads.length) return [];
  const msgs = await rc.db.select().from(chatMessages).where(inArray(chatMessages.threadId, threads.map((t) => t.id))).orderBy(asc(chatMessages.seq));
  return threads.map((t) => {
    const x = ext<ThreadExt>(rc, 'chat_threads', t.id);
    const messages: ChatMessage[] = msgs
      .filter((m) => m.threadId === t.id)
      .map((m) => {
        const meta = ((m.contentBlocks ?? []) as Blocks)[0] ?? {};
        return {
          id: m.id,
          threadId: t.id,
          role: m.role === 'tool' ? 'system' : m.role,
          at: isoReq(m.createdAt),
          text: m.content ?? '',
          parts: meta.parts ?? [],
          context: meta.context ?? [],
          isMorningBrief: !!meta.isMorningBrief,
          ...(m.model === 'sonnet' || m.model === 'opus' || m.model === 'haiku' ? { model: m.model } : {}),
          ...(meta.status ? { status: meta.status } : {}),
          ...(meta.usage ? { usage: meta.usage } : {}),
          ...(meta.route ? { route: meta.route } : {}),
        };
      });
    const seeded = x.atCount === undefined || x.atCount === messages.length;
    return {
      thread: {
        id: t.id,
        title: t.title ?? 'Chat',
        isDefault: t.scope === 'day',
        createdAt: isoReq(t.createdAt),
        updatedAt: isoReq(t.lastMessageAt ?? t.updatedAt),
        messageCount: seeded && x.messageCount !== undefined ? x.messageCount : messages.length,
        lastMessagePreview: seeded && x.previewNull ? null : seeded && x.lastMessagePreview !== undefined ? x.lastMessagePreview : previewOf(messages),
        ...(x.context ? { context: x.context } : {}),
      },
      messages,
    };
  });
}

/** Latest non-empty message text (an empty assistant turn, e.g. an error, keeps the previous preview). */
function previewOf(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.text) return messages[i]!.text.slice(0, 120);
  return null;
}

export async function insertChatThread(w: WriteCtx, t: ChatThreadDetail): Promise<string> {
  const id = uuidFor(t.thread.id);
  await w.tx.insert(chatThreads).values({
    id,
    ownerUserId: w.userId,
    title: t.thread.title,
    scope: t.thread.isDefault ? 'day' : 'global',
    lastMessageAt: toDate(t.thread.updatedAt),
    createdAt: toDate(t.thread.createdAt)!,
    updatedAt: toDate(t.thread.updatedAt)!,
  });
  let seq = 0;
  for (const m of t.messages) await insertChatMessage(w.tx, id, m, seq++);
  const derivedPreview = previewOf(t.messages);
  const countOverride = t.thread.messageCount !== t.messages.length ? t.thread.messageCount : undefined;
  const previewOverride = t.thread.lastMessagePreview !== derivedPreview && t.thread.lastMessagePreview !== null ? t.thread.lastMessagePreview : undefined;
  const previewNull = t.thread.lastMessagePreview === null && derivedPreview !== null ? true : undefined;
  await writeExt(w, 'chat_threads', id, {
    context: t.thread.context?.length ? t.thread.context : undefined,
    messageCount: countOverride,
    lastMessagePreview: previewOverride,
    previewNull,
    atCount: countOverride !== undefined || previewOverride !== undefined || previewNull ? t.messages.length : undefined,
  });
  return id;
}

export async function insertChatMessage(tx: Tx, threadId: string, m: ChatMessage, seq: number) {
  await tx.insert(chatMessages).values({
    id: uuidFor(m.id),
    threadId,
    seq,
    role: m.role,
    content: m.text,
    contentBlocks: [{ parts: m.parts, context: m.context, isMorningBrief: m.isMorningBrief, ...(m.status ? { status: m.status } : {}), ...(m.usage ? { usage: m.usage } : {}), ...(m.route ? { route: m.route } : {}) }],
    model: m.model ?? null,
    createdAt: toDate(m.at)!,
  });
}

/**
 * Append one message (chat_threads / chat_messages are not audited: like the mock, chat messages have no
 * undo). An untitled thread takes its title from the first thing you asked.
 */
export async function appendChatMessage(db: Db, threadId: string, m: ChatMessage): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx.select().from(chatThreads).where(eq(chatThreads.id, threadId)).for('update');
    if (!t) throw new Error(`chat thread ${threadId} does not exist`);
    const res = await tx.execute<{ n: number; next: number }>(sql`select count(*)::int as n, coalesce(max(seq) + 1, 0)::int as next from chat_messages where thread_id = ${threadId}`);
    const { n, next } = res.rows[0]!;
    await insertChatMessage(tx, threadId, m, next);
    const retitle = m.role === 'user' && n === 0 && t.title === NEW_THREAD_TITLE && t.scope !== 'day';
    await tx
      .update(chatThreads)
      .set({ lastMessageAt: toDate(m.at), updatedAt: toDate(m.at)!, ...(retitle ? { title: threadTitleFrom(m.text) } : {}) })
      .where(eq(chatThreads.id, threadId));
  });
}

/** "move Globex prep after lunch and find the deck…" → "move Globex prep after lunch and find the…" (as the mock). */
export function threadTitleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= 48 ? one || NEW_THREAD_TITLE : `${one.slice(0, 47).replace(/\s+\S*$/, '')}…`;
}

// ---------------------------------------------------------------------------
// Missed opportunities
// ---------------------------------------------------------------------------

interface FindingExt {
  otherDcs: string[];
  oppIdNull: boolean;
  accountName: string;
}

export async function loadMissed(rc: ReadCtx, opp: (id: string) => { name: string; stage: string | null; amount: number | null; closeDate: string | null; accountName: string | null } | null): Promise<MissedOpp[]> {
  const [rows, reqs] = await Promise.all([
    rc.db.select().from(missedOppFindings).where(eq(missedOppFindings.ownerUserId, rc.userId)).orderBy(asc(missedOppFindings.createdAt), asc(missedOppFindings.id)),
    // the DC request a Claim added (newest first: the live one wins)
    rc.db
      .select({ id: dealContributionRequests.id, findingId: dealContributionRequests.missedOppFindingId })
      .from(dealContributionRequests)
      .where(and(eq(dealContributionRequests.ownerUserId, rc.userId), isNotNull(dealContributionRequests.missedOppFindingId)))
      .orderBy(desc(dealContributionRequests.createdAt)),
  ]);
  const reqBy = new Map<string, string>();
  for (const q of reqs) if (q.findingId && !reqBy.has(q.findingId)) reqBy.set(q.findingId, q.id);
  return rows.map((r) => {
    const x = ext<FindingExt>(rc, 'missed_opp_findings', r.id);
    const o = opp(r.opportunityId);
    return {
      id: r.id,
      verdict: r.verdict === 'claim' ? 'claim' : 'check',
      oppId: x.oppIdNull ? null : r.opportunityId,
      oppName: o?.name ?? '',
      accountName: x.accountName ?? o?.accountName ?? '',
      amount: o?.amount ?? null,
      stage: o?.stage ?? '',
      closeDate: o?.closeDate ?? null,
      evidence: r.evidenceSummary ? r.evidenceSummary.split('\n') : [],
      otherDcs: x.otherDcs ?? [],
      status: findingStatusFromDb(r.status),
      dismissReason: r.dismissedReason,
      claimedWorkItemId: r.workItemId,
      dcRequestId: reqBy.get(r.id) ?? null,
      foundAt: isoReq(r.createdAt),
    };
  });
}

export async function ensureSweep(w: WriteCtx, at: string): Promise<string> {
  const id = uuidFor(`sweep:${w.userId}:seed`);
  await w.tx.insert(missedOppSweeps).values({ id, ownerUserId: w.userId, status: 'succeeded', criteria: { source: 'seed' }, startedAt: new Date(at), finishedAt: new Date(at) }).onConflictDoNothing();
  return id;
}

export async function insertFinding(w: WriteCtx, m: MissedOpp, opportunityId: string, sweepId: string, accountNameOfOpp: string | null, opts: { ordinal?: number } = {}): Promise<string> {
  const id = uuidFor(m.id);
  await w.tx.insert(missedOppFindings).values({
    id,
    ownerUserId: w.userId,
    opportunityId,
    firstSweepId: sweepId,
    lastSweepId: sweepId,
    tier: m.verdict === 'claim' ? 'strong_evidence_no_dc' : 'light_touch',
    verdict: m.verdict,
    evidenceStrength: m.verdict === 'claim' ? 'strong' : 'some',
    otherArchitectDcCount: m.otherDcs.length,
    evidenceSummary: m.evidence.join('\n'),
    status: findingStatusToDb(m.status),
    workItemId: m.claimedWorkItemId ? uuidFor(m.claimedWorkItemId) : null,
    dismissedReason: m.dismissReason,
    createdAt: orderedAt(opts.ordinal, m.foundAt),
  });
  await writeExt(w, 'missed_opp_findings', id, { otherDcs: m.otherDcs, oppIdNull: m.oppId === null ? true : undefined, accountName: m.accountName !== accountNameOfOpp ? m.accountName : undefined });
  return id;
}

export async function updateFinding(w: WriteCtx, cur: MissedOpp, next: MissedOpp) {
  const patch: Record<string, unknown> = {};
  if (cur.status !== next.status) patch.status = findingStatusToDb(next.status);
  if (cur.dismissReason !== next.dismissReason) patch.dismissedReason = next.dismissReason;
  if (cur.claimedWorkItemId !== next.claimedWorkItemId) patch.workItemId = next.claimedWorkItemId ? uuidFor(next.claimedWorkItemId) : null;
  await updateRow(w, missedOppFindings, uuidFor(cur.id), patch, { bump: false });
}

// ---------------------------------------------------------------------------
// Mapping questions, spine slots
// ---------------------------------------------------------------------------

export function loadMappings(rc: { kv: Map<string, unknown> }): MappingQuestion[] {
  const out: MappingQuestion[] = [];
  for (const [k, v] of rc.kv) if (k.startsWith('cc.ext/mapping_questions/')) out.push(v as MappingQuestion);
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function writeMapping(w: WriteCtx, q: MappingQuestion) {
  await writeKv(w, extKey('mapping_questions', uuidFor(q.id)), { ...q, id: uuidFor(q.id) });
}

export const SLOTS_KEY = 'cc.plan.slots';
export function loadSlots(rc: { kv: Map<string, unknown> }): SpineSlot[] {
  return (rc.kv.get(SLOTS_KEY) as SpineSlot[] | undefined) ?? [];
}
export async function writeSlots(w: WriteCtx, slots: SpineSlot[]) {
  await writeKv(w, SLOTS_KEY, slots);
}

// ---------------------------------------------------------------------------
// Seeded history (display-only audit entries)
// ---------------------------------------------------------------------------

const ACTOR_KIND: Record<AuditEntry['actor'], 'user' | 'engine' | 'chat' | 'connector' | 'system'> = { user: 'user', engine: 'engine', chat: 'chat', connector: 'connector', system: 'system', scenario: 'engine' };

export async function insertHistoryEntry(w: WriteCtx, e: AuditEntry): Promise<string> {
  const id = uuidFor(e.id);
  await w.tx
    .insert(changeSets)
    .values({
      id,
      ownerUserId: w.userId,
      kind: 'system',
      actorKind: ACTOR_KIND[e.actor],
      actorRef: e.action,
      entityType: e.entity.type,
      entityId: e.entity.id,
      summary: e.summary,
      undoable: false,
      closedAt: new Date(e.at),
      createdAt: new Date(e.at),
    })
    .onConflictDoNothing();
  await writeExt(w, 'change_sets', id, { changes: e.changes, entity: e.entity, related: e.related, actor: e.actor === 'scenario' ? 'scenario' : undefined });
  return id;
}
