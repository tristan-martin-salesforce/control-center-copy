// BE-CHAT (db) reads and spend of DbChatBe6. Split from chat-be6.ts (max-lines); the class is still exported from chat-be6.ts.
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';

import { insertLlmCall, ledgerHash } from '@/db/ledger';
import { type ChatModel, type ChatPart, type ChatScan, budgetsForDay } from '@/contract';
import { jobs as jobsTable, scanRuns as scanRunsTable } from '@/db/schema';
import { PgRuntimeJobQueue } from '@/jobs/runtime-queue';
import type { ChatUsageRecord } from '@/llm/chat/types';
import { redactText } from '@/llm/redact';
import { scanJob } from '@/scanner/runtime/jobs';
import { chatLimitsFromEnv, chatScan, findConnector, type ChatPlanRecord } from '@/server/chat/outputs';
import { refreshScanPart, scanIdOfPart } from '@/server/chat/turn';
import { AppError, invalid } from '@/server/errors';
import { scanStatusFromDb, type DbRunStatus } from './enums';
import type { ReadModel } from './model';
import { readSpend, writeSpend } from './store/health';
import {
  buildOrg62OppById, buildOrg62OppsByIds, buildOrg62AccountSearch, buildOrg62OppSearch, buildOrg62Query, matchInApp, Org62LookupError,
  parseOrg62Rows, type Org62LookupInput, type Org62Row,
} from '@/server/chat/org62';
import { runChatResearch, type ChatResearchInput } from '@/server/chat/research';
import { runOneReadLookup } from '@/server/onboarding/identity';
import { type DbChatKit, planKey, localDay, chatSkillTag, SCAN_SCOPE } from './chat-be6.shared';

/** BE-CHAT (db) reads: plans, spend, rescans, read-only lookups and hydration. DbChatBe6 (chat-be6.ts) adds the host backend and Apply / Dismiss. */
export abstract class DbChatBe6Reads {
  constructor(protected readonly k: DbChatKit) {}

  protected plan(model: ReadModel, id: string): ChatPlanRecord | undefined {
    return model.ctx.kv.get(planKey(id)) as ChatPlanRecord | undefined;
  }

  /**
   * One model call's spend (chat: a turn, or a sub-call such as the Org62 lookup): its `llm_calls` row, the day
   * rollups, and the Health spend projection. `requestKey` names a call outside a chat turn (the Time picker).
   */
  protected async recordSpend(u: ChatUsageRecord, requestKey?: string) {
    const k = this.k;
    const userId = await k.userId();
    const m = await k.model();
    const day = localDay(k.now(), m.settings().profile.timezone);
    const status = u.status === 'budget_blocked' ? 'budget_blocked' : u.status === 'timeout' ? 'timeout' : u.status === 'error' ? 'error' : 'ok';
    const skill = u.skill ?? chatSkillTag();
    const requestHash = requestKey ?? `chat:${u.messageId}:${randomUUID()}`;
    // D0: one writer for the ledger. A chat call is always the user's own message (or a lookup it made); each turn
    // is its own content, so its hash names the turn. The day roll-up stays below (it also counts the chat line).
    await insertLlmCall(k.db, {
      ownerUserId: userId,
      purpose: 'chat',
      model: u.model,
      skillKey: skill.split('@')[0]!,
      promptVersion: skill,
      requestHash,
      chatMessageId: /^[0-9a-f-]{36}$/i.test(u.messageId) ? u.messageId : null,
      status,
      errorCode: u.errorCode ?? null,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      costUsd: u.costUsd,
      costEstimated: u.estimated,
      latencyMs: u.latencyMs,
      budgetDay: day,
      startedAt: new Date(k.now().getTime() - u.latencyMs),
      finishedAt: k.now(),
      rollup: false,
      trigger: 'user_action',
      modelReason: 'default',
      contentHash: ledgerHash(u.model, skill, u.threadId, u.messageId, requestHash),
      outcome: u.errorCode ? `${status}:${u.errorCode}` : status,
    });
    if (!(u.costUsd > 0)) return;
    await k.db.execute(sql`
      insert into llm_budget_days (budget_id, day, spent_usd, call_count)
      select b.id, ${day}::date, ${u.costUsd}, 1 from llm_budgets b
       where b.owner_user_id = ${userId} and (b.scope = 'total' or (b.scope = 'purpose' and b.scope_value = 'chat'))
      on conflict (budget_id, day) do update set spent_usd = llm_budget_days.spent_usd + excluded.spent_usd,
                                                 call_count = llm_budget_days.call_count + 1, updated_at = now()`);
    // the Health spend projection (cc.spend): today, the chat line, the model line
    await k.mutate({ action: 'chat.spend', summary: 'Chat spend', entity: { type: 'settings', id: 'spend' }, actor: 'chat', undoable: false }, async (w, model) => {
      const sp = readSpend(model.ctx);
      const usd = Math.round((sp.today.usd + u.costUsd) * 1e6) / 1e6;
      const add = <T extends { usd: number }>(rows: T[], match: (r: T) => boolean, make: () => T) => (rows.some(match) ? rows.map((r) => (match(r) ? { ...r, usd: Math.round((r.usd + u.costUsd) * 1e6) / 1e6 } : r)) : [...rows, make()]);
      const soft = sp.today.softBudgetUsd || model.settings().budgets.softUsd;
      await writeSpend(w, {
        ...sp,
        today: { ...sp.today, usd, softBudgetUsd: soft, hardCapUsd: sp.today.hardCapUsd || model.settings().budgets.hardUsd, pct: soft > 0 ? Math.round((usd / soft) * 100) : 0 },
        byScanner: add(sp.byScanner, (r) => r.name === 'chat', () => ({ name: 'chat', usd: u.costUsd })),
        byModel: add(sp.byModel, (r) => r.model === u.model, () => ({ model: u.model, usd: u.costUsd })),
      });
    });
  }

  protected async budget(model: ChatModel) {
    const userId = await this.k.userId();
    const m = await this.k.model();
    const day = localDay(this.k.now(), m.settings().profile.timezone);
    const lim = chatLimitsFromEnv(process.env, model, m.settings().chat);
    const r = await this.k.db.execute<{ chat: string | null; total: string | null }>(sql`
      select (select coalesce(sum(cost_usd), 0) from llm_calls where owner_user_id = ${userId} and budget_day = ${day}::date and purpose = 'chat') as chat,
             (select coalesce(sum(cost_usd), 0) from llm_calls where owner_user_id = ${userId} and budget_day = ${day}::date and budget = 'daily') as total -- BUD-1`);
    const row = r.rows[0] ?? { chat: '0', total: '0' };
    const eff = budgetsForDay(m.settings().budgets, day);
    const spend = readSpend(m.ctx);
    return {
      chatTodayUsd: Number(row.chat ?? 0),
      // "Today only" raises the assistant's day line too, unless env pins it (tests, ops).
      chatDailyUsd: eff.chatUsd != null && process.env.CC_CHAT_DAILY_USD === undefined ? eff.chatUsd : lim.chatDailyUsd,
      totalTodayUsd: Math.max(Number(row.total ?? 0), spend.today.usd),
      hardCapUsd: eff.hardUsd,
      perMessageUsd: lim.perMessageUsd,
      maxTurns: lim.maxTurns,
      researchUsd: lim.researchUsd,
    };
  }

  // ---------------------------------------------------------------------------
  // Rescans (a RuntimeJob on the Postgres queue; the worker runs it)
  // ---------------------------------------------------------------------------

  protected async rescan(connector: string, hours: number): Promise<ChatScan> {
    const m = await this.k.model();
    const c = findConnector(m.all('connectors'), connector);
    if (!c) throw invalid(`Unknown connector "${connector}" (one of ${m.all('connectors').map((x) => x.source).join(', ')})`);
    const now = this.k.now();
    const window = { from: new Date(now.getTime() - hours * 3_600_000).toISOString(), to: now.toISOString() };
    const conn = { id: c.id, label: c.label, source: c.source };
    if (c.state === 'auth_needed') return chatScan({ id: randomUUID(), connector: conn, windowHours: hours, window, jobId: null, jobStatus: null, run: null, now: now.toISOString(), authBroken: true });
    const target = SCAN_SCOPE[c.source];
    if (!target) throw invalid(`${c.label} has no scan from chat`);
    const job = scanJob({ connector: target.connector, scope: target.scope, window, mode: 'manual', trigger: 'chat', runAt: now.toISOString() });
    const userId = await this.k.userId();
    await new PgRuntimeJobQueue(this.k.db, userId).enqueue([job]);
    const [row] = await this.k.db.select({ id: jobsTable.id, status: jobsTable.status }).from(jobsTable).where(and(eq(jobsTable.ownerUserId, userId), eq(jobsTable.dedupeKey, job.dedupeKey))).orderBy(desc(jobsTable.id)).limit(1);
    if (!row) throw new AppError('internal', 'scan job was not enqueued');
    this.k.publish(['jobs'], [String(row.id)], 'chat.scan');
    return chatScan({ id: String(row.id), connector: conn, windowHours: hours, window, jobId: String(row.id), jobStatus: row.status === 'queued' ? 'queued' : (row.status as 'running'), run: null, now: now.toISOString() });
  }

  async scanStatus(scanId: string): Promise<ChatScan | null> {
    if (!/^\d+$/.test(scanId)) return null;
    const userId = await this.k.userId();
    const [j] = await this.k.db.select().from(jobsTable).where(and(eq(jobsTable.id, Number(scanId)), eq(jobsTable.ownerUserId, userId)));
    if (!j) return null;
    const p = j.payload as { kind?: string; connector?: string; window?: { from: string; to: string } };
    if (p.kind !== 'scan' || !p.window) return null;
    const [r] = await this.k.db.select().from(scanRunsTable).where(eq(scanRunsTable.jobId, j.id)).orderBy(desc(scanRunsTable.startedAt)).limit(1);
    const m = await this.k.model();
    const source = Object.entries(SCAN_SCOPE).find(([, v]) => v.connector === p.connector)?.[0] ?? p.connector ?? '';
    const c = m.all('connectors').find((x) => x.source === source);
    const hours = Math.max(1, Math.round((Date.parse(p.window.to) - Date.parse(p.window.from)) / 3_600_000));
    return chatScan({
      id: scanId,
      connector: { id: c?.id ?? source, label: c?.label ?? source, source: (c?.source ?? null) as ChatScan['source'] },
      windowHours: hours,
      window: p.window,
      jobId: scanId,
      jobStatus: j.status,
      run: r ? { id: r.id, status: scanStatusFromDb(r.status as DbRunStatus, r.errorCode), itemsSeen: r.itemsSeen, itemsNew: r.itemsNew, itemsChanged: r.itemsUpdated, error: r.errorMessage } : null,
      now: this.k.now().toISOString(),
    });
  }

  /** One question-scoped research run over live Slack, Gmail, Calendar, Drive and Org62 (src/server/chat/research.ts). */
  protected async research(i: ChatResearchInput, o: { costCapUsd: number; signal: AbortSignal; onTool?: (fullName: string) => void }) {
    const userId = await this.k.userId();
    const m = await this.k.model();
    const { GoogleWorkspaceClient } = await import('@/connectors/google/client');
    const { dbLedgerSearch } = await import('./readin');
    return runChatResearch(i, {
      db: this.k.db,
      userId,
      now: this.k.now(),
      timezone: m.settings().profile.timezone,
      google: new GoogleWorkspaceClient({ timeoutMs: 30_000, maxRetries: 0 }),
      ledger: dbLedgerSearch(this.k.db, userId),
      costCapUsd: o.costCapUsd,
      signal: o.signal,
      ...(o.onTool ? { onTool: o.onTool } : {}),
    });
  }

  /** One live soqlQuery built from fixed fields (src/server/chat/org62.ts), matched to the app's opps and accounts. */
  protected async org62Lookup(i: Org62LookupInput) {
    return this.org62Soql(buildOrg62Query(i), i.find);
  }

  /**
   * Assistant v2: one live read for `search` / `fetch`. Slack through the one-call relay (H-3: MCP through Claude Code,
   * the scan allowlist's tools only, our arguments swapped in); VDP over its read-only JSON-RPC runtime (the manifest's
   * read tools only). The relay's own model cost comes back to be booked with the thread id.
   */
  protected async liveRead(connector: 'slack' | 'vdp', tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; costUsd: number; model?: string; inputTokens?: number; outputTokens?: number; ok: boolean }> {
    if (connector === 'vdp') {
      const { vdpReadRuntime } = await import('@/connectors/vdp/client');
      try {
        const r = await vdpReadRuntime({}).call(tool, args, signal ? { signal } : {});
        return { text: redactText(r.text), costUsd: 0, ok: true };
      } catch (err) {
        return { text: `VDP read failed: ${redactText((err as Error).message ?? String(err)).slice(0, 200)}`, costUsd: 0, ok: false };
      }
    }
    const r = await (this.k.readLookup ?? runOneReadLookup)({ connector: 'slack', tool, args }, { skillPath: 'skills/read-lookup.md', timeoutMs: 90_000 });
    return { text: r.text === null ? `The Slack read did not finish: ${r.message}` : redactText(r.text), costUsd: r.costUsd, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ok: r.text !== null };
  }

  /** Run one SELECT through the read-only lookup (the scan allowlist's soqlQuery), parsed and matched to the app. */
  protected async org62Soql(soql: string, find: Org62LookupInput['find']) {
    const started = Date.now();
    const r = await (this.k.readLookup ?? runOneReadLookup)({ connector: 'org62', tool: 'soqlQuery', args: { q: soql } }, { skillPath: 'skills/read-lookup.md', timeoutMs: 60_000 });
    const usage = { model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens ?? 0, cacheWriteTokens: r.cacheWriteTokens ?? 0, status: r.code === 'timeout' ? ('timeout' as const) : r.text === null ? ('error' as const) : ('ok' as const), ...(r.text === null ? { errorCode: r.code } : {}), latencyMs: Date.now() - started };
    if (r.text === null) return { soql, rows: [] as Org62Row[], notes: [`The Org62 lookup did not finish: ${r.message}`], costUsd: r.costUsd, usage };
    const m = await this.k.model();
    const rows = matchInApp(
      parseOrg62Rows(r.text, find),
      m.all('opps').map((o) => ({ id: o.id, accountId: o.accountId, org62Url: o.org62Url, isMine: o.isMine, myDc: o.myDc, dcAssigned: o.dcAssigned })),
      m.all('accounts').map((a) => ({ id: a.id, org62Url: a.org62Url })),
    );
    return { soql, rows, notes: rows.length ? [] : ['Nothing in Org62 matches.'], costUsd: r.costUsd, usage };
  }

  /**
   * The Time picker's Org62 reads (outside a chat turn): live only behind the Assistant's own gate (CC_CHAT_LLM=1,
   * connectors on) and while the Assistant's day budget lasts; the spend is recorded like the Assistant's lookup
   * (purpose chat, skill read-lookup@1). `search` is the picker's word search; `byId` re-reads one picked record;
   * `byIds` reads several in one SELECT (adding untracked opps, e.g. to claim DCs on them).
   */
  async pickerOrg62(op: { search: string } | { byId: string } | { byIds: readonly string[] }): Promise<{ rows: Org62Row[]; accounts?: Org62Row[]; notes: string[]; live: boolean; costUsd?: number }> {
    if (!this.k.org62Live) return { rows: [], notes: ['Org62 live lookups are not available here: the Assistant is off (CC_CHAT_LLM) or its connectors are (CC_CHAT_CONNECTORS=0).'], live: false };
    let soql: string;
    try {
      soql = 'search' in op ? buildOrg62OppSearch(op.search) : 'byIds' in op ? buildOrg62OppsByIds(op.byIds) : buildOrg62OppById(op.byId);
    } catch (e) {
      if (e instanceof Org62LookupError) throw invalid(`Can't search Org62 like that: ${e.message}`);
      throw e;
    }
    const m = await this.k.model();
    const b = await this.budget(m.settings().chat.defaultModel);
    if (b.chatTodayUsd >= b.chatDailyUsd) return { rows: [], notes: [`Today's Assistant budget ($${b.chatDailyUsd.toFixed(2)}) is used up: raise it in Settings ▸ Budgets ▸ Assistant limits, or try again tomorrow.`], live: true };
    const r = await this.org62Soql(soql, 'opportunities');
    await this.recordSpend({ threadId: '', messageId: randomUUID(), ...r.usage, costUsd: r.costUsd, estimated: false, skill: 'read-lookup@1' }, `${'byIds' in op ? 'deals:add-org62-opps' : 'time:opp-picker'}:${randomUUID()}`).catch(() => undefined);
    // D-103 (c): the word search reads accounts too: one more fixed SELECT on the same read, inside the same day budget
    if (!('search' in op)) return { rows: r.rows, notes: r.notes, live: true, costUsd: r.costUsd ?? 0 };
    const b2 = await this.budget(m.settings().chat.defaultModel);
    if (b2.chatTodayUsd >= b2.chatDailyUsd) return { rows: r.rows, accounts: [], notes: r.notes, live: true, costUsd: r.costUsd ?? 0 };
    const a = await this.org62Soql(buildOrg62AccountSearch(op.search), 'accounts');
    await this.recordSpend({ threadId: '', messageId: randomUUID(), ...a.usage, costUsd: a.costUsd, estimated: false, skill: 'read-lookup@1' }, `time:opp-picker:${randomUUID()}`).catch(() => undefined);
    const notes = r.rows.length || a.rows.length ? [] : ['Nothing in Org62 matches.'];
    return { rows: r.rows, accounts: a.rows, notes, live: true, costUsd: (r.costUsd ?? 0) + (a.costUsd ?? 0) };
  }

  /** Opportunity id → its name and account (for previews and Time-page rows). */
  protected oppNames(m: ReadModel, ids: string[]) {
    return new Map(
      ids.flatMap((id) => {
        const o = m.get('opps', id);
        return o ? [[id, { name: o.name, accountName: m.get('accounts', o.accountId)?.name ?? null }] as const] : [];
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Read-time hydration
  // ---------------------------------------------------------------------------

  /** Chat proposals → current status (+ the applied receipt right after the card). */
  hydrateSync(m: ReadModel, parts: ChatPart[]): ChatPart[] {
    if (!parts.some((p) => p.type === 'proposal')) return parts;
    const out: ChatPart[] = [];
    for (const p of parts) {
      const plan = p.type === 'proposal' ? this.plan(m, p.proposal.id) : undefined;
      if (p.type !== 'proposal' || !plan) {
        out.push(p);
        continue;
      }
      out.push({ ...p, proposal: plan.proposal, status: plan.proposal.status === 'pending' ? 'pending' : plan.proposal.status === 'applied' ? 'applied' : 'dismissed' });
      if (plan.receipt && !parts.some((x) => x.type === 'receipt' && x.receipt.id === plan.receipt!.id)) out.push({ type: 'receipt', receipt: plan.receipt });
    }
    return out;
  }

  /** hydrateSync plus scan rows refreshed from the job / scan-run tables. */
  async hydrate(m: ReadModel, parts: ChatPart[]): Promise<ChatPart[]> {
    const out = this.hydrateSync(m, parts);
    if (!out.some((p) => scanIdOfPart(p))) return out;
    return Promise.all(
      out.map(async (p) => {
        const scanId = scanIdOfPart(p);
        if (!scanId || p.type !== 'tool') return p;
        const scan = await this.scanStatus(scanId).catch(() => null);
        return scan ? refreshScanPart(p, scan) : p;
      }),
    );
  }
}
