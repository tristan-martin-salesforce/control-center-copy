/**
 * DbScannerStore: the Postgres implementation of `ScannerStore` (src/scanner/types.ts, SCANNER.md §3/§5).
 *
 * It mirrors InMemoryScannerStore (src/scanner/store-memory.ts) rule for rule; the numbers below are that
 * file's S1–S18, and tests/be1a/store-conformance.ts runs the same scenarios against both stores.
 *
 *  S1  Only a `running` run accepts writes (RunStateError otherwise).
 *  S2  source_items upsert on (owner, dedupeKey): new → isNew; changed contentHash → edit in place (revision + 1);
 *      same hash → no-op. The item's connector must match the run's (watch runs may record slack/org62).
 *      Bodies are redacted again, kept in `body` (90-day expiry) and never in `meta`; a purged body is never
 *      resurrected (W1).
 *  S3  work_item_evidence is unique on (item, source, role); the digest derives people/accounts/threads/files/
 *      lastEvidenceAt from evidence.
 *  S4  proposeItem is idempotent on (kind, sorted origin sourceItemIds, or all when none is origin). The key is
 *      kept on the proposing change set (`change_sets.editor_session_id = 'propose:<hash>'`, entity = the item).
 *  S5  proposeInitiative is idempotent on (normalized title, sorted member ids), same mechanism.
 *  S6  flagUnlinked keeps one reconcile_findings row per (source item, run); attempts are derived: a reconcile
 *      run adds one, any other run counts as one at most, `deferred:` reasons never count. Evidence ends it.
 *  S7  Coverage is staged in memory; finishRun commits it, failRun writes it with outcome `error`.
 *  S8  finishRun: cursor.at within the window (±1 s); committed + staged coverage spans [window.from, cursor.at)
 *      with no hole > 1 s (CoverageError); then ledger + run + cursor + touched set, in ONE transaction.
 *      S8c: an incomplete run (cursor.at < window.to) has its time ranges clamped to the cursor before commit.
 *  S9  The cursor moves forward over contiguous coverage only and fast-forwards to the newest held run cursor
 *      when backfill closes the hole (held cursors live in scan_runs.cursor_after until passed).
 *  S10 Work items with new evidence or newly proposed join the scope's pending set (scan_cursors.cursor_json
 *      .pending), surviving failed runs; the next successful finishRun returns and clears it.
 *  S11 coverageGaps clips at the scope's low watermark; no committed coverage → [window].
 *  S12 uncoveredObjects: same kind + ref with `to` ≥ the listed `to`, or meta.parentRef containment.
 *  S13 recordSpend(costUsd ≤ 0) is a pure read.
 *  S14 getContext: gaps of the last 7 days (when the scope has coverage), open items + items done within 14
 *      days, skillVersion of the latest succeeded run.
 *  S15 Digests and candidates carry resolution / involvement / handedOffTo / expected.
 *  S16 watch runs may record slack/org62 items. S17 `cc:<workItemId>` joins that item (score 1).
 *  S18 recordBriefHighlights is idempotent per (subscription, period); cited source items must exist.
 *
 * Every write runs inside `withChangeSet({ actor: actors.scanner(<connector>) })`. Linking also does the W2
 * new-info bump (generation, badge, coalesced re-eval) for non-context evidence, never a status change.
 */
import { sql } from 'drizzle-orm';

import { NOTES_NO_STEPS } from '@/connectors/google/gemini-notes';
import { mayAutoClose } from '@/engines/closure/correction';
import { loadCorrectionFacts } from '@/engines/closure/correction-db';
import { loadClosingSettings } from '@/engines/settle/select-db';
import { flushTrace, trace, traceContext } from '@/scanner/trace';
import { passSkill, passSpendOf, splitByPasses, TRIAGE_SKILL_KEY, type PassSpend } from '@/scanner/trace/queries';
import {
  MEASUREMENT_COLUMNS, measurementOf, measurementValues, noteLedgerGaps, recordDecision as recordLedgerDecision,
  reserveBudget, type CallMeasurement, type Decision, type Reservation,
} from '@/db/ledger';
import type { Involvement } from './runtime/contract-ext';
import type { CompletionEvidence, CompletionItem, CompletionSource } from './completion/types';
import { toMs } from './store-memory';
import type { ConnectorId, EvidenceRole, ScannerStore, SpendBooked } from './types';
import {
  type RecordSpendInput, type SpendRow, restRows, type CompletionRow, COMPLETION_COLUMNS, completionFieldsOf,
} from './store-db.rows';
import { localDay, UUID, CONNECTOR_META, modelTierOf, isoMs, textArr, uuidArr, iso, RUNS } from './store-db.shared';
import { DbScannerStoreFinish } from './store-db.finish';
export {
  CONNECTOR_META, isPrimaryOfKind, LEDGER_KIND, TEXT_KEYS, modelTierOf, localDay, readSkillVersion, coverageToLedger,
  splitPayload,
} from './store-db.shared';
export type { ConnectorStatus, HealthChange, BudgetStatus, DbScannerStoreOptions } from './store-db.shared';
export { failureCode, contractErrorClass, restRows } from './store-db.rows';
export type { RecordSpendInput } from './store-db.rows';

export class DbScannerStore extends DbScannerStoreFinish implements ScannerStore {

  async recordSpend(spend: RecordSpendInput): Promise<{ todayUsd: number; softCapUsd: number; hardCapUsd: number }> {
    // S13: costUsd <= 0 is a pure read.
    if (Number.isFinite(spend.costUsd) && spend.costUsd > 0) {
      const input = spend as SpendBooked;
      const day = localDay(this.now(), await this.timezone());
      const purpose = input.connector === 'nba' ? 'nba_generate' : input.connector === 'chat' ? 'chat' : input.connector === 'brief' ? 'summarize' : 'scan_extract';
      const runId = input.runId && UUID.test(input.runId) ? input.runId : null;
      // AUDIT: every call is attributed to a run or job and to its budget. The caller's, else the current job's (context).
      const tc = traceContext();
      const jobId = input.jobId ?? tc?.jobId ?? null;
      const budget = input.budget ?? tc?.budget ?? 'daily';
      const connectorSkill = input.skill ?? (input.connector in CONNECTOR_META ? CONNECTOR_META[input.connector as ConnectorId].skill ?? null : null);
      // SPEND-1: a run's spend is booked on the models that made it. Its passes (traversal, triage, escalation) each ran
      // on their own model, and their `pass` trace rows carry model, cost and tokens: the spend is split over the rows
      // not booked yet, one llm_calls row each. Before, a whole run was booked on the run's model with no tokens, so a
      // Sonnet escalation showed as Haiku. What no pass row covers stays on the caller's model, with the caller's tokens.
      let passes: PassSpend[] = [];
      const passMeasure = new Map<number, CallMeasurement | undefined>();
      if (runId) {
        await flushTrace();
        const ev = await this.db.execute<{ seq: number; payload: Record<string, unknown> }>(sql`
          select e.seq, e.payload from scan_run_events e
           where e.run_id = ${runId}::uuid and e.kind = 'pass'
             and not exists (select 1 from llm_calls c where c.request_hash = concat('pass:', e.run_id::text, ':', e.seq))
           order by e.seq`);
        passes = ev.rows.map((r) => passSpendOf(r.seq, r.payload));
        // 0027: each pass row carries what its query measured (`m`).
        for (const r of ev.rows) passMeasure.set(Number(r.seq), measurementOf(r.payload?.m));
      }
      const split = splitByPasses(input.costUsd, passes);
      const trigger = input.trigger ?? null;
      const rows: SpendRow[] = split.parts.map((p) => ({
        model: p.model ?? input.model,
        skill: passSkill(p.pass, connectorSkill),
        usd: p.costUsd,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        cacheReadTokens: p.cacheReadTokens,
        cacheWriteTokens: p.cacheWriteTokens,
        status: p.ok ? 'ok' : 'error',
        errorCode: p.ok ? null : (p.errorClass ?? 'unknown'),
        hash: `pass:${runId}:${p.seq}`,
        contentHash: p.contentHash,
        modelReason: p.pass === 'escalate' ? 'escalation:unsure' : (input.modelReason ?? 'default'),
        outcome: p.pass === 'traversal' ? (input.outcome ?? null) : p.pass,
        measure: passMeasure.get(p.seq),
        escalation: p.pass === 'escalate',
      }));
      // D0: what no pass row covers is booked with its own tokens: the SDK's per-model usage less what the pass rows
      // booked, so no dollar lands on a row without tokens (and a Sonnet residue is booked as Sonnet).
      if (split.restUsd > 0) rows.push(...restRows(split.restUsd, split.parts, input, connectorSkill, runId));
      await this.cs(
        input.connector,
        `spend ${input.connector} ${input.model}`,
        async (tx) => {
          const isRun = runId
            ? (await tx.execute<{ ok: boolean }>(sql`select exists (select 1 from scan_runs where id = ${runId} and owner_user_id = ${this.userId}) as ok`)).rows[0]?.ok === true
            : false;
          for (const r of rows) {
            await tx.execute(sql`
              insert into llm_calls (owner_user_id, purpose, model, model_tier, skill_key, request_hash, scan_run_id, job_id, status, error_code,
                                     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, budget_day, budget, started_at, finished_at,
                                     trigger, model_reason, content_hash, outcome, ${MEASUREMENT_COLUMNS})
              values (${this.userId}, ${purpose}, ${r.model}, ${modelTierOf(r.model)}, ${r.skill},
                      ${r.hash}, ${isRun ? runId : null},
                      coalesce((select id from jobs where id = ${jobId}::bigint), (select job_id from scan_runs where id = ${isRun ? runId : null}::uuid)),
                      ${r.status}, ${r.errorCode}, ${r.inputTokens}, ${r.outputTokens}, ${r.cacheReadTokens}, ${r.cacheWriteTokens}, ${r.usd}, ${day}::date, ${budget},
                      ${this.now().toISOString()}::timestamptz, ${this.now().toISOString()}::timestamptz,
                      ${trigger}, ${r.modelReason}, ${r.contentHash}, ${r.outcome},
                      ${measurementValues(
                        r.measure,
                        // 0027: an escalation re-did the run's latest cheaper triage call (booked just before it, same run).
                        r.escalation && isRun
                          ? sql`(select c.id from llm_calls c where c.scan_run_id = ${runId}::uuid and c.skill_key = ${r.skill} and coalesce(c.model_reason, '') not like 'escalation:%' order by c.id desc limit 1)`
                          : undefined,
                      )})`);
          }
          if (isRun) await tx.execute(sql`update scan_runs set cost_usd = cost_usd + ${input.costUsd} where id = ${runId}`);
          // BUD-1: the daily roll-up (Q15's meter, doctor) is the daily budget's; first-scan spend stays on its own ledger rows.
          if (budget === 'daily') await tx.execute(sql`
            insert into llm_budget_days (budget_id, day, spent_usd, call_count)
            select b.id, ${day}::date, ${input.costUsd}, ${rows.length} from llm_budgets b where b.owner_user_id = ${this.userId} and b.scope = 'total'
            on conflict (budget_id, day) do update set spent_usd = llm_budget_days.spent_usd + excluded.spent_usd,
                                                       call_count = llm_budget_days.call_count + excluded.call_count, updated_at = now()`);
        },
        false,
      );
      // D0: a row missing an audit field, or booking dollars with no tokens, is noted (tests fail on it); still written.
      for (const r of rows) noteLedgerGaps(`recordSpend:${r.skill ?? input.connector}`, { costUsd: r.usd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, trigger, modelReason: r.modelReason, outcome: r.outcome, contentHash: r.contentHash, measure: r.measure });
      trace(runId, 'spend', { costUsd: input.costUsd, model: input.model, models: [...new Set(rows.map((r) => r.model))], parts: rows.length, purpose, budget, jobId });
    }
    const b = await this.budgetStatus();
    return { todayUsd: b.todayUsd, softCapUsd: b.softCapUsd, hardCapUsd: b.hardCapUsd };
  }

  /** D0: a decision not to call the model (or to escalate, or a refused call), on today's local day. Never throws. */
  async recordDecision(d: Omit<Decision, 'day'> & { day?: string }): Promise<void> {
    // R11: Gemini notes with 0 parsed steps are a Health counter (one open app_events row, its count bumped per doc
    // seen), not a skip decision: nothing was kept from the model.
    if (d.reason === NOTES_NO_STEPS) {
      await this.db.execute(sql`
        insert into app_events (owner_user_id, severity, component, code, message, detail, fingerprint)
        values (${this.userId}, 'warn', 'scanner.gemini_notes', ${NOTES_NO_STEPS}, 'Gemini notes with 0 parsed next steps',
                ${JSON.stringify({ docId: d.subject ?? null, suggestedAction: 'Open the notes doc: its next-steps heading or line format is not one the parser knows' })}::jsonb,
                ${`scanner.gemini_notes|${NOTES_NO_STEPS}`})
        on conflict (fingerprint) where resolved_at is null
        do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now(), detail = excluded.detail`);
      return;
    }
    const day = d.day ?? localDay(d.at ?? this.now(), await this.timezone().catch(() => 'UTC'));
    await recordLedgerDecision(this.db, this.userId, { ...d, day, at: d.at ?? this.now() });
  }

  /** D3: CLI session ids whose recorded `claude_session` item is evidence on a live work item. */
  async linkedClaudeSessions(): Promise<Set<string>> {
    const r = await this.db.execute<{ id: string }>(sql`
      select distinct s.external_id as id from source_items s
        join work_item_evidence e on e.source_item_id = s.id
        join work_items w on w.id = e.work_item_id
       where s.owner_user_id = ${this.userId} and s.kind = 'claude_session'
         and w.status in ('suggested', 'open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done')`);
    return new Set(r.rows.map((x) => x.id));
  }

  /** D6: today's Slack triage escalation allowance and the stronger model's triage spend so far (daily budget). */
  async escalationAllowance(): Promise<{ capUsd: number; spentUsd: number }> {
    const day = localDay(this.now(), await this.timezone());
    const r = await this.db.execute<{ cap: string | null; spent: string | null }>(sql`
      select (select value->>'triageEscalationUsdPerDay' from user_settings where owner_user_id = ${this.userId} and key = 'settings.budgets') as cap,
             (select coalesce(sum(cost_usd), 0) from llm_calls where owner_user_id = ${this.userId} and budget_day = ${day}::date and budget = 'daily'
                 and skill_key = ${TRIAGE_SKILL_KEY} and model_tier::text <> 'haiku') as spent`);
    const cap = Number(r.rows[0]?.cap ?? NaN);
    // The default is BudgetSettings.triageEscalationUsdPerDay's ($1).
    return { capUsd: Number.isFinite(cap) && cap >= 0 ? cap : 1, spentUsd: Number(r.rows[0]?.spent ?? 0) };
  }

  /**
   * D6: hold `usd` against today's hard cap while a call runs (reserve, then spend, then release). Refused when the
   * booked spend + what calls in flight hold + `usd` would pass the cap. First-scan spend has its own budget (no hold).
   */
  async reserveSpend(usd: number, o: { budget?: 'daily' | 'first_scan' } = {}): Promise<Reservation> {
    const b = await this.budgetStatus();
    if ((o.budget ?? traceContext()?.budget ?? 'daily') === 'first_scan') return { ok: true, heldUsd: 0, spentUsd: b.todayUsd, reservedUsd: 0, hardCapUsd: b.hardCapUsd, release: async () => undefined };
    return reserveBudget(this.db, this.userId, { day: localDay(this.now(), await this.timezone()), usd, hardCapUsd: b.hardCapUsd });
  }

  // ------------------------------------------------------------------ completion pass read helpers (CMP-1)

  /**
   * Open items that are mine (status open / in progress / waiting / likely done, involvement owner or contributor,
   * not owned by someone else), created at or before `asOf`, with their evidence as of then.
   */
  async completionItems(opts: { asOf?: string; limit?: number; statuses?: readonly string[] } = {}): Promise<CompletionItem[]> {
    const asOf = opts.asOf && toMs(opts.asOf) != null ? isoMs(toMs(opts.asOf)!) : this.now().toISOString();
    // CMP-SUG: suggested items (Triage) are checked too, so an ask already answered can be found settled before anyone
    // has to click it (before, the pass skipped them, and 132 of them waited as Still needed? after the first scan).
    const statuses = opts.statuses?.length ? [...opts.statuses] : ['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done', 'suggested'];
    const items = await this.db.execute<{
      id: string;
      kind: string;
      title: string;
      purpose: string | null;
      status: string;
      due_at: string | null;
      created_at: string;
      involvement: Involvement;
      account_id: string | null;
      account_names: string[] | null;
      cp_name: string | null;
      cp_email: string | null;
      cp_slack: string | null;
      file_refs: string[] | null;
    }>(sql`
      select wi.id, wi.kind::text as kind, wi.title, wi.purpose, wi.status::text as status, wi.due_at, wi.created_at,
             wi.involvement, wi.account_id::text as account_id,
             (select array_remove(array_agg(distinct n), null) from (
                select a.name as n from accounts a where a.id = wi.account_id
                union all select al.value from account_aliases al where al.account_id = wi.account_id) an) as account_names,
             cp.display_name as cp_name, cp.primary_email as cp_email,
             (select pi.external_id from person_identities pi where pi.person_id = cp.id and pi.system = 'slack' order by pi.is_primary desc limit 1) as cp_slack,
             (select array_remove(array_agg(distinct f), null) from (
                select x.external_id as f from work_item_links l join assets x on x.id = l.asset_id where l.work_item_id = wi.id
                union all select x.external_id from work_item_deliverables d join assets x on x.id = d.asset_id where d.work_item_id = wi.id) fr) as file_refs
        from work_items wi
        left join people cp on cp.id = wi.counterparty_person_id
       where wi.owner_user_id = ${this.userId}
         and wi.status::text = any(${textArr(statuses)})
         and wi.involvement in ('owner', 'contributor') and wi.owner_person_id is null
         and wi.created_at <= ${asOf}::timestamptz
       order by wi.created_at desc
       ${opts.limit != null ? sql`limit ${Math.max(1, opts.limit)}` : sql``}`);
    if (!items.rows.length) return [];
    const ev = await this.db.execute<CompletionRow & { work_item_id: string; role: EvidenceRole; rationale: string | null }>(sql`
      select e.work_item_id, e.role::text as role, e.rationale, ${COMPLETION_COLUMNS},
             left(concat_ws(E'\n', si.title, si.body, (case when jsonb_typeof(si.meta->'files') = 'array' then '[attached: ' || (select string_agg(f->>'name', ', ') from jsonb_array_elements(si.meta->'files') f) || ']' when si.meta->>'hasFile' = 'true' then '[attached: a file]' end)), 900) as text
        from work_item_evidence e join source_items si on si.id = e.source_item_id
       where e.work_item_id = any(${uuidArr(items.rows.map((r) => r.id))}) and e.created_at <= ${asOf}::timestamptz
       order by si.occurred_at`);
    const byItem = new Map<string, CompletionEvidence[]>();
    for (const r of ev.rows) {
      const list = byItem.get(r.work_item_id) ?? [];
      list.push({ sourceItemId: r.id, role: r.role, ...completionFieldsOf(r), ...(r.rationale ? { reason: r.rationale } : {}) });
      byItem.set(r.work_item_id, list);
    }
    // R1: the correction rule both closers share, from the same query Settle and the re-evaluation read.
    const corrections = await loadCorrectionFacts(this.db, this.userId, items.rows.map((r) => r.id));
    const closing = await loadClosingSettings(this.db, this.userId);
    return items.rows.map((r) => ({
      ...(corrections.has(r.id) && !mayAutoClose(corrections.get(r.id)!, closing) ? { mayAutoClose: false } : {}),
      workItemId: r.id,
      kind: r.kind,
      title: r.title,
      ...(r.purpose ? { purpose: r.purpose } : {}),
      status: r.status,
      ...(r.due_at ? { due: iso(r.due_at)! } : {}),
      createdAt: iso(r.created_at)!,
      involvement: r.involvement,
      ...(r.account_id ? { accountId: r.account_id } : {}),
      accountNames: r.account_names ?? [],
      ...(r.cp_name || r.cp_email || r.cp_slack ? { counterparty: { ...(r.cp_name ? { name: r.cp_name } : {}), ...(r.cp_email ? { email: r.cp_email } : {}), ...(r.cp_slack ? { externalId: r.cp_slack } : {}) } } : {}),
      fileRefs: r.file_refs ?? [],
      evidence: byItem.get(r.id) ?? [],
    }));
  }

  /** Source items that arrived (first seen, or last content change) in (seenAfter, seenUntil], newest first. */
  async completionSources(opts: { seenAfter: string; seenUntil: string; limit?: number }): Promise<CompletionSource[]> {
    const after = toMs(opts.seenAfter);
    const until = toMs(opts.seenUntil);
    if (after == null || until == null || until <= after) return [];
    const res = await this.db.execute<CompletionRow & { seen_at: string; title: string | null; url: string | null }>(sql`
      select ${COMPLETION_COLUMNS}, si.title, si.url, left(concat_ws(E'\n', si.body, (case when jsonb_typeof(si.meta->'files') = 'array' then '[attached: ' || (select string_agg(f->>'name', ', ') from jsonb_array_elements(si.meta->'files') f) || ']' when si.meta->>'hasFile' = 'true' then '[attached: a file]' end)), 1200) as text, -- DLV-1: attachments shown to the check
             greatest(si.first_seen_at, coalesce(si.content_changed_at, si.first_seen_at)) as seen_at
        from source_items si
       where si.owner_user_id = ${this.userId} and si.deleted_upstream_at is null
         and si.source in ('slack', 'gmail', 'calendar', 'drive', 'gemini_notes', 'claude') -- R7: notes and sessions too
         and greatest(si.first_seen_at, coalesce(si.content_changed_at, si.first_seen_at)) > ${isoMs(after)}::timestamptz
         and greatest(si.first_seen_at, coalesce(si.content_changed_at, si.first_seen_at)) <= ${isoMs(until)}::timestamptz
       order by seen_at desc
       limit ${Math.max(1, Math.min(opts.limit ?? 4000, 20_000))}`);
    return res.rows.map((r) => ({
      sourceItemId: r.id,
      ...completionFieldsOf(r),
      seenAt: iso(r.seen_at)!,
      ...(r.title ? { title: r.title } : {}),
      ...(r.url ? { url: r.url } : {}),
    }));
  }

  /** Test/ops helper: forget in-flight run state (e.g. after a simulated crash). */
  static forgetRuns(): void {
    RUNS.clear();
  }
}
