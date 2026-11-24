/**
 * BE-CHAT in db mode: the chat host backend and Apply / Dismiss / hydration for chat proposals.
 *
 * - Chat plans: kv `cc.chat.plan/<id>` (user_settings), written when the tool stages them. Apply runs every
 *   change in ONE change set with actor `chat` (plus one re-rank when needed), returns its id as `auditId`
 *   and a receipt; the plan is marked applied in a second, non-undoable write, so Undo reverts the changes
 *   and the card keeps its receipt (undo / redo through the receipt lines).
 * - Rescans: a RuntimeJob (`scan.<connector>`, mode manual, trigger chat) on the Postgres job queue; the
 *   card follows the job row and the scan run the worker records for it (scan_runs.job_id).
 * - Drafts: an Outbox draft (status ready, never sent). Sessions: a `launching` Claude session record with a
 *   claude:// deep link the UI opens on click.
 * - Spend: one `llm_calls` row per turn (purpose chat) + the day rollups + the Health spend projection.
 * Nothing here calls an external system, except the read-only Gmail / Drive lookups of `chat_search_sources`
 * when live connectors are on (CC_CHAT_LLM=1 and CC_CHAT_CONNECTORS≠0).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { errorFields } from '@/lib/log';
import {
  type ActivityEntry, type AgentRun, type Draft, type Evidence, type PolicyRule, type PriorityPolicy, type Proposal,
  type Receipt, type ReceiptChange, type ReceiptFailure, type ResolutionDetail, type SourceRef, type WorkItemRecord,
  WorkItemPatch,
} from '@/contract';
import { enqueueEnrich } from '@/jobs/handlers/enrich';
import type { ChatSourceHit } from '@/llm/chat/types';
import { redactText } from '@/llm/redact';
import {
  activityReceiptLines, editedActivity, needsRerank, RESOLUTION_LABEL, weightsWith,
} from '@/server/chat/changes';
import { appliedSummary, applyRouteCalls, type AppliedCalls, type RouteCall } from '@/server/chat/app-routes';
import type { ChatHostBackend } from '@/server/chat/host';
import type { DataSource } from '@/server/datasource/types';
import { personaOf } from '@/personas';
import {
  chatDraft, chatProposal, chatSession, draftRef, resolveRepoFolder, type ChatPlanRecord,
} from '@/server/chat/outputs';
import { AppError, invalid } from '@/server/errors';
import { ruleOp } from '../mock/chat-be6';
import type { ReadModel } from './model';
import { insertSession } from './store/agents';
import { writeKv, type WriteCtx } from './store/common';
import { insertDraft } from './store/nba';
import { insertPolicyVersion } from './store/settings';
import { buildOrg62OppById } from '@/server/chat/org62';
import { recordTypeKv } from '@/server/chat/record-type';
import { loggingProfile } from '@/engines/activity/persona';
import { canvasHolds } from '@/lib/canvas/payload';
import { buildLogBatch } from './store/log-batch';
import { appliedLogCanvases } from '../log-canvases';
import { logDiscrepancies } from './store/log-check';
import { updateActivity } from './store/time';
import { insertEvidence, insertWorkItem, logTransition } from './store/work';
import { planKey, ledgerLog, editConflict, changeLabel, RECEIPT_FIELDS } from './chat-be6.shared';
import { DbChatBe6Reads } from './chat-be6.reads';
export type { DbChatKit } from './chat-be6.shared';

export class DbChatBe6 extends DbChatBe6Reads {

  // ---------------------------------------------------------------------------
  // Host backend
  // ---------------------------------------------------------------------------

  backend(opts: { liveConnectors?: boolean } = {}): ChatHostBackend {
    const k = this.k;
    let tz: string | undefined; // one turn = one host: the profile timezone is read once
    return {
      kind: 'db',
      timezone: async () => (tz ??= (await k.model()).settings().profile.timezone),
      history: async (threadId, exclude) => {
        const m = await k.model();
        const t = m.get('chatThreads', threadId);
        return (t?.messages ?? []).filter((x) => !exclude.includes(x.id)).map((x) => ({ ...x, parts: this.hydrateSync(m, x.parts) }));
      },
      stageChanges: async (i) => {
        const id = randomUUID();
        const proposal = chatProposal({ id, entity: i.entity, lines: i.lines, reason: i.reason, at: k.now().toISOString() });
        const rec: ChatPlanRecord = { proposal, changes: i.changes, threadId: i.threadId, messageId: i.messageId };
        await k.mutate({ action: 'chat.propose', summary: `Proposed from chat: ${i.reason}`, entity: { type: 'chat_thread', id: i.threadId }, actor: 'chat', undoable: false }, async (w) => writeKv(w, planKey(id), rec));
        k.publish(['chat_threads'], [i.threadId], 'chat.propose');
        return proposal;
      },
      rescan: (connector, hours) => this.rescan(connector, hours),
      scanStatus: (scanId) => this.scanStatus(scanId),
      createDraft: async (i) => {
        const m = await k.model();
        const workItemId = i.workItemId && m.get('workItems', i.workItemId) ? i.workItemId : null;
        const d: Draft = chatDraft(i, { id: randomUUID(), now: k.now().toISOString(), mode: m.settings().sending.defaultMode, workItemId });
        const ref = draftRef(d, i);
        await k.mutate({ action: 'chat.draft', summary: `Draft for ${ref.to} (from chat)`, entity: { type: 'draft', id: d.id }, actor: 'chat' }, async (w) => {
          await insertDraft(w, d);
        });
        k.publish(['drafts'], [d.id], 'chat.draft');
        return ref;
      },
      prepareSession: async (i) => {
        const m = await k.model();
        const item = i.workItemId ? m.get('workItems', i.workItemId) : undefined;
        const repos = await k.db.execute<{ name: string; path: string }>(sql`select name, path from repos where owner_user_id = ${m.ctx.userId} and not ignored`).then((r) => r.rows).catch(() => []);
        const folder = resolveRepoFolder(i.repo, repos, m.meta().repoFolder ?? process.cwd());
        const runId = randomUUID();
        const now = k.now().toISOString();
        const title = i.title ?? (item ? item.title : `Claude session: ${i.prompt.split('\n')[0]!.slice(0, 60)}`);
        const s = chatSession(i, { id: runId, folder, now, workItemId: item?.id ?? null, title });
        const run: AgentRun = {
          id: runId,
          kind: 'claude_session',
          title,
          workItemId: item?.id ?? null,
          state: 'queued',
          startedAt: now,
          updatedAt: now,
          finishedAt: null,
          lastEvent: 'Prepared from chat; opens on your click',
          waiting: null,
          deepLink: s.url,
          sessionId: null,
          cwd: folder,
          bgAgents: 0,
          toolRunId: null,
          progress: null,
          resultUrl: null,
          error: null,
          costUsd: null,
          scheduled: false,
        };
        await k.mutate({ action: 'chat.session', summary: `Prepared a Claude session: ${title}`, entity: { type: 'agent_run', id: runId }, actor: 'chat' }, async (w, model) => {
          await insertSession(w, run, { launchedByApp: true, launchPrompt: s.prompt });
          model.put('agentRuns', run);
          if (item && !item.runIds.includes(runId)) await k.writeItem(w, model, item, { ...item, runIds: [...item.runIds, runId] }, { bump: true });
        });
        k.publish(['claude_sessions'], [runId], 'chat.session');
        return s;
      },
      searchLedger: (q, limit) => this.searchLedger(q, limit),
      logBatch: (i) => this.logBatch(i, opts.liveConnectors === true),
      activityLookup: async (entryIds, oppIds) => {
        const m = await this.k.model();
        return { entries: new Map(entryIds.flatMap((id) => { const e = m.get('activity', id); return e ? [[id, e] as const] : []; })), opps: this.oppNames(m, oppIds), taskTypes: [...m.extra.vocab.taskTypeByName.keys()] };
      },
      ...(opts.liveConnectors
        ? {
            org62Lookup: (i) => this.org62Lookup(i),
            // Assistant v2: one opportunity by id through the fixed template, and Slack / VDP reads through the runtime
            org62Record: (id: string) => this.org62Soql(buildOrg62OppById(id), 'opportunities'),
            liveRead: (connector: 'slack' | 'vdp', tool: string, args: Record<string, unknown>, signal?: AbortSignal) => this.liveRead(connector, tool, args, signal),
            research: (i, o) => this.research(i, o),
            // D-58: the Assistant's own live reads: the scanners' Slack / Org62 servers and the read-only Google client
            liveReads: true,
            google: async () => new (await import('@/connectors/google/client')).GoogleWorkspaceClient({ timeoutMs: 30_000, maxRetries: 0 }),
          }
        : {}),
      budget: (model) => this.budget(model),
      recordUsage: (u) => this.recordSpend(u),
    };
  }

  /**
   * DM-10 (2026-11-20): the Assistant's search over what the app recorded. Postgres full-text search on
   * `source_items.search_tsv` (title + body, the GIN-indexed generated column) ranked by `ts_rank`, newest first on a tie;
   * the excerpt is computed from `body` (null once the body expired, D-7). ILIKE over title + body only when the tsvector
   * can't answer: the query has no searchable words (an id, a number) or the column is missing (an old schema). A SQL
   * error is logged by its code and returned as a note, never turned into an empty list.
   */
  protected async searchLedger(q: string, limit: number): Promise<{ hits: ChatSourceHit[]; notes: string[] }> {
    const userId = await this.k.userId();
    const text = q.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (text.length < 2) return { hits: [], notes: [] };
    const n = Math.max(1, Math.min(50, Math.trunc(limit)));
    type Row = { source: string; kind: string; title: string | null; excerpt: string | null; url: string | null; external_id: string; at: Date | null; work_item_id: string | null; work_item_title: string | null };
    const cols = sql`s.source::text as source, s.kind::text as kind, s.title, left(regexp_replace(coalesce(s.body, ''), '\\s+', ' ', 'g'), 400) as excerpt,
                     s.url, s.external_id, s.occurred_at as at, e.work_item_id, w.title as work_item_title`;
    const joins = sql`left join lateral (select work_item_id from work_item_evidence ev where ev.source_item_id = s.id order by ev.created_at desc limit 1) e on true
                      left join work_items w on w.id = e.work_item_id`;
    const ilike = async (): Promise<Row[]> => {
      const tokens = text.toLowerCase().split(/[^\p{L}\p{N}@._-]+/u).filter((t) => t.length >= 2).slice(0, 6);
      if (!tokens.length) return [];
      const like = sql.join(
        tokens.map((t) => sql`(coalesce(s.title, '') || ' ' || coalesce(s.body, '')) ilike ${`%${t.replace(/[%_\\]/g, (c) => `\\${c}`)}%`}`),
        sql` and `,
      );
      return (await this.k.db.execute<Row>(sql`select ${cols} from source_items s ${joins} where s.owner_user_id = ${userId} and (${like}) order by s.occurred_at desc nulls last limit ${n}`)).rows;
    };
    let rows: Row[];
    let how: 'fts' | 'ilike' = 'fts';
    try {
      const probe = await this.k.db.execute<{ words: number }>(sql`select numnode(websearch_to_tsquery('english', ${text})) as words`);
      if (Number(probe.rows[0]?.words ?? 0) === 0) {
        how = 'ilike';
        rows = await ilike();
      } else {
        rows = (
          await this.k.db.execute<Row>(sql`
            select ${cols}
              from source_items s ${joins}
             where s.owner_user_id = ${userId} and s.search_tsv @@ websearch_to_tsquery('english', ${text})
             order by ts_rank(s.search_tsv, websearch_to_tsquery('english', ${text})) desc, s.occurred_at desc nulls last
             limit ${n}`)
        ).rows;
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown';
      if (code === '42703' && how === 'fts') {
        // no search_tsv on this schema: the plain-text match is the only way to answer
        try {
          how = 'ilike';
          rows = await ilike();
        } catch (err2) {
          const code2 = (err2 as { code?: string }).code ?? 'unknown';
          ledgerLog().warn({ ...errorFields(err2), how: 'ilike' }, 'chat ledger search failed');
          return { hits: [], notes: [`ledger search failed (database error ${code2}); this is not "nothing found": say the app's own search is unavailable and use the live sources`] };
        }
      } else {
        ledgerLog().warn({ ...errorFields(err), how }, 'chat ledger search failed');
        return { hits: [], notes: [`ledger search failed (database error ${code}); this is not "nothing found": say the app's own search is unavailable and use the live sources`] };
      }
    }
    const hits = rows.map((r) => ({
      source: (r.source === 'google_drive' ? 'drive' : r.source === 'google_calendar' ? 'calendar' : r.source) as ChatSourceHit['source'],
      kind: r.kind,
      title: redactText(r.title ?? r.external_id).slice(0, 160),
      excerpt: redactText(r.excerpt ?? '').slice(0, 240),
      url: r.url,
      externalId: r.external_id,
      at: r.at ? new Date(r.at).toISOString() : null,
      workItemId: r.work_item_id,
      workItemTitle: r.work_item_title,
    }));
    return { hits, notes: how === 'ilike' ? ['ledger: matched words in titles and bodies (the query has no full-text words)'] : [] };
  }

  // ---------------------------------------------------------------------------
  // Apply / Dismiss
  // ---------------------------------------------------------------------------

  async apply(pid: string, ds: DataSource): Promise<{ entity: Proposal; auditId: string | null; receipt: Receipt } | null> {
    const m0 = await this.k.model();
    const plan = this.plan(m0, pid);
    if (!plan) return null;
    if (plan.proposal.status !== 'pending') throw invalid(`Proposal is ${plan.proposal.status}`);
    const now = this.k.now();
    const at = now.toISOString();
    // D-58: app route calls run after the edits, each through the DataSource (its own change set, Undo all reverts them).
    const calls = plan.changes.filter((c): c is RouteCall => c.op === 'route_call');
    const all = plan.changes.filter((c) => c.op !== 'route_call');
    // A3 (2026-11-13): Apply lands what works. An edit that no longer fits (closed since, a row logged since) is listed
    // with its reason and the rest land; nothing is rolled back for one bad line.
    const failed: ReceiptFailure[] = [];
    const edits = all.filter((c) => {
      const err = editConflict(c, m0, now);
      if (err) failed.push({ label: changeLabel(c, m0), reason: `Changed since it was proposed: ${err}` });
      return !err;
    });
    const rankedIds = needsRerank(edits) ? await this.k.rankedIds() : [];
    const created: WorkItemRecord[] = [];
    const linked: Array<{ ev: Evidence; item: WorkItemRecord }> = [];
    const actEdits: Array<{ cur: ActivityEntry; next: ActivityEntry }> = [];
    const summary = `Applied from chat: ${plan.proposal.reason}`;
    const r = !edits.length ? null : await this.k.mutate({ action: 'chat.apply', summary, entity: { type: plan.proposal.entity.type, id: plan.proposal.entity.id }, actor: 'chat' }, async (w, model) => {
      for (const c of edits) {
        const err = editConflict(c, model, now);
        if (err) throw new AppError('conflict', `Changed since it was proposed: ${err}`, { current: 'itemId' in c ? (model.get('workItems', c.itemId) ?? null) : null });
      }
      let policy: PriorityPolicy | undefined;
      let rowId: string | undefined;
      if (edits.some((c) => c.op === 'policy_weights' || c.op === 'policy_rule')) {
        const s = model.settings();
        let weights = s.policy.weights;
        let rules: PolicyRule[] = [...s.policy.rules];
        for (const c of edits) {
          if (c.op === 'policy_weights') weights = weightsWith(weights, c.deltas);
          else if (c.op === 'policy_rule') rules = ruleOp(rules, c, `rule_${randomUUID().slice(0, 8)}`);
        }
        policy = { ...s.policy, version: s.policy.version + 1, weights, rules, updatedAt: at, note: plan.proposal.reason };
        rowId = await insertPolicyVersion(w, policy, { at, by: 'chat', note: plan.proposal.reason, activate: true, changeSetId: w.cs.id });
      }
      for (const c of edits) if (c.op !== 'pin') await this.applyOne(w, model, c, at, created, linked, actEdits);
      // pins last, against the plan's own policy and edits, so "#1" holds after the re-rank
      for (const c of edits) if (c.op === 'pin') await this.pin(w, model, c.itemId, policy ?? model.settings().policy, now);
      if (needsRerank(edits)) await this.k.rerankIn(w, model, policy ?? model.settings().policy, rankedIds, now, rowId);
    });
    const editAudit = r && (r.undoable || created.length || linked.length || actEdits.length) ? r.auditId : null;
    if (!editAudit && edits.length && !calls.length && !failed.length) throw invalid('Nothing to apply: everything is already as proposed');
    const routed: AppliedCalls = calls.length ? await applyRouteCalls(ds, calls, personaOf(m0.settings())) : { lines: [], auditIds: [], failed: [], landed: 0 };
    failed.push(...routed.failed);
    const total = all.length + calls.length;
    // nothing landed at all: the card stays pending (Retry apply), and the error says why
    if (!editAudit && !routed.landed && failed.length) throw new AppError('conflict', `Nothing was applied: ${failed.map((f) => `${f.label}: ${f.reason}`).slice(0, 3).join('; ')}${failed.length > 3 ? ` (and ${failed.length - 3} more)` : ''}`);
    const base = editAudit ? await this.k.receipt(editAudit, summary, (table, f) => (table === 'work_items' ? RECEIPT_FIELDS.has(f) : table === 'priority_policies')) : null;
    const lines: ReceiptChange[] = [
      ...(base?.changes ?? []),
      ...(editAudit
        ? [
            ...created.map((w): ReceiptChange => ({ auditId: editAudit, entity: { type: 'work_item', id: w.id, label: w.title, href: `/work/${w.id}` }, field: 'state', label: 'Created', before: null, after: w.state })),
            ...linked.map(({ ev, item }): ReceiptChange => ({ auditId: editAudit, entity: { type: 'work_item', id: item.id, label: item.title, href: `/work/${item.id}` }, field: 'evidence', label: 'Evidence', before: null, after: ev.source.label })),
            ...actEdits.flatMap(({ cur, next }) => activityReceiptLines(editAudit, cur, next)),
          ]
        : []),
      ...routed.lines,
    ];
    const auditId = editAudit ?? routed.auditIds.at(-1) ?? null;
    const outcome = { ...(failed.length ? { failed, summary: `${appliedSummary(total - failed.length, total, failed)}. ${plan.proposal.reason}` } : { summary }), total };
    const receipt: Receipt = base ? { ...base, actor: 'chat', changes: lines, ...outcome } : { id: randomUUID(), at, actor: 'chat', changes: lines, staged: false, ...outcome };
    const applied: Proposal = { ...plan.proposal, status: 'applied', resolvedAt: at };
    await this.k.mutate({ action: 'chat.plan', summary: `Chat proposal applied: ${plan.proposal.reason}`, entity: { type: 'chat_thread', id: plan.threadId }, actor: 'chat', undoable: false }, async (w) =>
      writeKv(w, planKey(pid), { ...plan, proposal: applied, receipt, ...(auditId ? { auditId } : {}) } satisfies ChatPlanRecord),
    );
    this.k.publish(['chat_threads', 'work_items'], [plan.threadId], 'chat.apply');
    return { entity: applied, auditId, receipt };
  }

  async reject(pid: string): Promise<{ entity: Proposal; auditId: null } | null> {
    const m = await this.k.model();
    const plan = this.plan(m, pid);
    if (!plan) return null;
    if (plan.proposal.status !== 'pending') throw invalid(`Proposal is ${plan.proposal.status}`);
    const rejected: Proposal = { ...plan.proposal, status: 'rejected', resolvedAt: this.k.now().toISOString() };
    await this.k.mutate({ action: 'chat.dismiss', summary: `Chat proposal dismissed: ${plan.proposal.reason}`, entity: { type: 'chat_thread', id: plan.threadId }, actor: 'chat', undoable: false }, async (w) =>
      writeKv(w, planKey(pid), { ...plan, proposal: rejected } satisfies ChatPlanRecord),
    );
    this.k.publish(['chat_threads'], [plan.threadId], 'chat.dismiss');
    return { entity: rejected, auditId: null };
  }

  /** Boost an item until the ranker puts it first (score gap + 1, doubled until it holds; 8 tries). */
  protected async pin(w: WriteCtx, model: ReadModel, itemId: string, policy: PriorityPolicy, now: Date) {
    const cur = model.get('workItems', itemId)!;
    const top = this.k.rankTop(model, policy, now);
    let boost = top && top.id !== cur.id ? Math.max(1, Math.ceil(top.score - this.k.scoreOf(model, cur, policy, now) + 1)) : 0;
    let next = cur;
    for (let i = 0; i < 8 && boost > 0; i++) {
      next = { ...cur, signals: { ...cur.signals, boost: cur.signals.boost + boost } };
      model.put('workItems', next);
      if (this.k.rankTop(model, policy, now)?.id === cur.id) break;
      boost *= 2;
    }
    model.put('workItems', cur);
    if (next !== cur) await this.k.writeItem(w, model, cur, next, { bump: true });
  }

  /**
   * The next logging batch: work orders, skips, the Org62 check. A preview, so it reads only: no Org62 lookup and no kv
   * write (D-58 fix). An unknown record type stays a placeholder here; staging the batch looks it up and keeps it.
   */
  protected async logBatch(i: { from?: string; to?: string; includeProposed?: boolean; appliedOffset?: number }, _live: boolean) {
    const userId = await this.k.userId();
    const m = await this.k.model();
    const tz = m.settings().profile.timezone;
    const logging = m.settings().time.logging;
    // D-55: the persona's record type, cached per record type. A preview reads only (D-58): no lookup, no kv write;
    // staging the batch looks it up and keeps it.
    const profile = loggingProfile(personaOf(m.settings()));
    const recordTypeId = logging.org62RecordTypeId ?? ((m.ctx.kv.get(recordTypeKv(profile.recordType)) as string | undefined) ?? null);
    const now = this.k.now();
    const b = await buildLogBatch(this.k.db, userId, { now, timezone: tz, approveComplete: i.includeProposed ?? logging.approveComplete, recordTypeId: recordTypeId ?? `(${profile.recordTypeName} record type: not found yet)`, held: canvasHolds(m.all('drafts')), logging: profile, ...(i.from ? { from: i.from } : {}), ...(i.to ? { to: i.to } : {}) });
    const disc = await logDiscrepancies(this.k.db, userId, { now, timezone: tz });
    return {
      available: true,
      mode: logging.mode,
      canvasStyle: logging.canvas,
      events: b.events,
      hours: b.hours,
      updates: b.updates,
      approveCount: b.approveIds.length,
      canvases: b.canvases.map((c) => ({ part: c.part, parts: c.parts, title: c.title, rows: c.eventIds.length, hours: c.hours, updates: c.updates, chars: c.markdown.length, preview: c.markdown.split('\n').slice(0, 14).join('\n') })),
      skipped: b.skipped,
      waiting: b.waiting,
      discrepancies: disc.map(({ id, date, description, kind, detail }) => ({ id, date, description, kind, detail })),
      recordTypeKnown: !!recordTypeId,
      ownerKnown: !!b.owner,
      // the canvases already applied (created in Slack), with their link and where their rows are (Time's receipts):
      // a page of 10 with the total and the next offset, so the Assistant reaches every one (caps audit F-5)
      ...appliedLogCanvases(m.all('drafts'), m.all('activity'), now, { offset: i.appliedOffset }),
    };
  }

  protected async applyOne(w: WriteCtx, model: ReadModel, c: ChatPlanRecord['changes'][number], at: string, created: WorkItemRecord[], linked: Array<{ ev: Evidence; item: WorkItemRecord }>, actEdits: Array<{ cur: ActivityEntry; next: ActivityEntry }> = []) {
    const cur = 'itemId' in c ? model.get('workItems', c.itemId)! : undefined;
    const write = async (next: WorkItemRecord, reason?: string) => {
      await this.k.writeItem(w, model, cur!, next, { bump: true });
      if (reason) await logTransition(w, cur!.id, cur!.state, next.state, reason);
    };
    switch (c.op) {
      case 'pin': // handled by pin(), after the other changes
      case 'rerank':
      case 'policy_weights':
      case 'policy_rule':
        return;
      case 'snooze':
        return write({ ...cur!, state: 'snoozed', snoozedUntil: c.until, snoozedFrom: cur!.state === 'snoozed' ? cur!.snoozedFrom : cur!.state }, 'Snoozed (asked in chat)');
      case 'done':
        return write(this.k.resolvedRecord(model, cur!, { reason: 'Done (asked in chat)', resolution: 'done_by_me', detail: c.note ? { note: c.note } : {}, doneBy: 'chat', at }), 'Done (asked in chat)');
      case 'resolve': {
        const detail: Partial<Omit<ResolutionDetail, 'inferred'>> = { ...(c.personName ? { personName: c.personName } : {}), ...(c.relatedItemId ? { relatedItemId: c.relatedItemId } : {}), ...(c.note ? { note: c.note } : {}) };
        const label = `${c.personName ? `${RESOLUTION_LABEL[c.resolution]} (${c.personName})` : RESOLUTION_LABEL[c.resolution]} (asked in chat)`;
        return write(this.k.resolvedRecord(model, cur!, { reason: label, resolution: c.resolution, detail, doneBy: 'chat', at }), label);
      }
      case 'reopen':
        return write({ ...cur!, state: 'reopened', doneAt: null, doneBy: null, closedReason: null, dismissed: null, resolution: null, resolutionDetail: null, involvement: 'owner', reopened: { reason: c.reason ?? 'Reopened from chat', at } }, c.reason ?? 'Reopened from chat');
      case 'link_evidence': {
        const src: SourceRef = { kind: c.source.kind, label: c.source.label, ...(c.source.url ? { url: c.source.url } : {}), ...(c.source.externalId ? { externalId: c.source.externalId } : {}), at };
        const ev: Evidence = { id: randomUUID(), workItemId: cur!.id, role: c.role ?? 'context', source: src, at, summary: c.summary, snippet: null, author: null, isNew: false, confidence: null };
        await insertEvidence(w, ev, cur!.seenAt, 'chat');
        linked.push({ ev, item: cur! });
        return;
      }
      case 'create_item': {
        const rec: WorkItemRecord = {
          ...this.k.blankItem(at, model.ctx.me),
          id: randomUUID(),
          kind: c.kind ?? 'task',
          state: c.snoozeUntil ? 'snoozed' : 'open',
          snoozedUntil: c.snoozeUntil ?? null,
          snoozedFrom: c.snoozeUntil ? 'open' : null,
          title: c.title.replace(/\s+/g, ' ').trim(),
          purpose: c.purpose ?? null,
          due: c.due ?? null,
          accountId: c.accountId && model.get('accounts', c.accountId) ? c.accountId : null,
          initiativeId: c.initiativeId && model.get('initiatives', c.initiativeId) ? c.initiativeId : null,
          effort: { youMin: c.effortMin ?? 15, agentMin: 0 },
          confidence: 'sure',
          why: 'Created from chat',
          sources: [{ kind: 'manual', label: 'Chat', at }],
          signals: { customerFacing: !!c.accountId, fromManager: false, boost: 0 },
          userLockedFields: [],
          reevaluating: false,
          seenAt: at,
          enrichment: { status: 'enriching', startedAt: at, chips: [] },
        };
        await insertWorkItem(w, rec, this.k.links(model), { locks: [] });
        await insertEvidence(w, { id: randomUUID(), workItemId: rec.id, role: 'origin', source: { kind: 'manual', label: 'Chat', at }, at, summary: rec.why, snippet: null, author: null, isNew: false, confidence: null }, at, 'chat');
        await enqueueEnrich(w.tx, w.userId, rec.id);
        model.put('workItems', rec);
        created.push(rec);
        return;
      }
      case 'edit_fields': {
        const patch = WorkItemPatch.parse(c.patch);
        return write({ ...cur!, ...patch } as WorkItemRecord); // no user locks: the Apply was the approval
      }
      case 'edit_activities': {
        const opp = c.patch.oppId ? this.oppNames(model, [c.patch.oppId]).get(c.patch.oppId) : undefined;
        for (const id of c.entryIds) {
          const before = model.get('activity', id)!;
          const { next, locked } = editedActivity(before, c.patch, opp);
          const oppAccount = next.oppId ? (model.get('accounts', model.get('opps', next.oppId)?.accountId ?? '')?.name ?? null) : null;
          await updateActivity(w, model.extra.vocab, before, next, { bump: true, lock: locked }, oppAccount);
          actEdits.push({ cur: before, next });
        }
        return;
      }
    }
  }
}
