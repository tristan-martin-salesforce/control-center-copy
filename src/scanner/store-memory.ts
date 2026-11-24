/**
 * InMemoryScannerStore: the reference implementation of `ScannerStore` (src/scanner/types.ts).
 *
 * Every scanner test runs against it, and BE-1's Postgres store must mirror these semantics exactly.
 * The rules, in one place (numbers are referenced from the BE-2a return notes):
 *
 *  S1  Runs. `startRun` opens a run in status `running`. Only a running run accepts writes; any write to
 *      a finished/failed/unknown run throws `RunStateError`.
 *  S2  Source items are keyed by `dedupeKey` (one owner). Insert → `isNew`. Same key + different
 *      `contentHash` → update in place, `changed` (revision + 1). Same key + same hash → no-op. The
 *      `sourceItemId` for a key never changes. The connector must match the run's connector.
 *      Excerpts are capped at 4000 chars (R6; prompts clip per use).
 *  S3  Evidence is unique on (workItemId, sourceItemId, role). A repeat returns the existing
 *      `evidenceId` and creates nothing. Evidence updates the work item's digest (people, accounts,
 *      threadRefs, fileRefs, lastEvidenceAt).
 *  S4  `proposeItem` is idempotent on (kind, sorted sourceItemIds of `origin` evidence, or of all
 *      evidence when none is `origin`). A repeat returns the existing item and only adds missing
 *      evidence rows. Landing: `sure` → open; `likely` → open + new badge; `guess` → suggested (Triage).
 *  S5  `proposeInitiative` is idempotent on (normalized title, sorted workItemIds); it sets
 *      `initiativeId` on member items that have none.
 *  S6  `flagUnlinked`: one row per source item. Attempts = failed linking attempts. A non-reconcile run
 *      sets attempts = max(attempts, 1) (rescans never escalate); a `reconcile` run adds 1, at most once
 *      per run. Reasons starting with `deferred:` (budget pause) never count as an attempt. An item with
 *      any evidence row is no longer unlinked.
 *  S7  Coverage reported during a run is STAGED on the run. `finishRun` commits it; `failRun` keeps it
 *      with outcome `error`, and error coverage never counts for gaps, cursors or objects.
 *  S8  `finishRun` (one atomic step): (a) the run must be running; (b) `cursor.at` must lie within
 *      [window.from, window.to] (±1 s); (c) committed coverage of the scope plus this run's staged
 *      coverage must span [window.from, cursor.at) with no hole longer than the tolerance (1 s), else
 *      `CoverageError` and nothing changes (the caller then calls failRun); (d) commit staged coverage,
 *      mark the run succeeded, store the proposed cursor on the run; (e) advance the scope cursor
 *      (S9); (f) return and clear the scope's pending re-evaluation set (S10).
 *  S9  The cursor only moves forward and only over contiguous committed coverage. From the current
 *      cursor (or, for a first run, the scope's low watermark = earliest committed coverage start),
 *      find the end of the contiguous covered interval. The new cursor is the proposed cursor, among
 *      this run and earlier succeeded runs of the scope, with the greatest `at` that is > the current
 *      `at` and ≤ that end. A head run during catch-up therefore commits coverage but leaves the cursor
 *      where it is; when backfill closes the hole, the cursor fast-forwards to the head run's cursor.
 *  S10 Work items that get NEW evidence or are newly proposed join the scope's pending re-evaluation
 *      set, whether or not the run later fails. The next successful `finishRun` of that scope returns
 *      them as `touchedWorkItemIds`, so a killed run's touches are never lost and an idempotent re-run
 *      that creates nothing still fans out.
 *  S11 `coverageGaps(scope, window)` = parts of `window` not covered by committed coverage, clipped
 *      below at the scope's low watermark. A scope with no committed coverage returns [window].
 *  S12 `uncoveredObjects`: a listed object is covered by committed coverage of the scope with the same
 *      kind and ref whose `to` ≥ the listed `to` (when given), or, when the listed object carries
 *      `meta.parentRef` and `from`, by a committed range on that parent ref containing `from`.
 *  S13 `recordSpend` with costUsd ≤ 0 is a pure read (no row). Totals are per local day (`dayKey`).
 *  S14 `getContext` returns the seeded profile, the scope cursor, the gaps of the last 7 days, open
 *      work items plus items done within the reopen window (14 days, so requirement changes can link
 *      `contradiction`), and `skillVersion` = the skill version of the scope's latest succeeded run.
 *  S15 R-UI-22: work items carry optional `resolution` and `involvement`; digests and candidates
 *      expose them so linking can treat handed-off/watcher items as context-only. Digests also carry
 *      `expected` (R-UI-15 deliverable expectations).
 *  S16 `watch` runs may record items of the watched source (`slack`, `org62`) besides their own
 *      `watch` plan notes, so a Slack message has ONE row (`slack:<channel>:<ts>`) whoever saw it.
 *  S17 Thread joins are exact string matches. A thread ref `cc:<workItemId>` (sessions the app
 *      launched for an item) joins that work item directly (score 1.0).
 *  S18 `recordBriefHighlights` is idempotent on (subscription kind, ref, period.from, period.to): a
 *      repeat replaces the summary and highlights and returns the same `briefId`. Every cited
 *      `sourceItemId` must exist.
 */
import { traceContext } from './trace';
import { noteLedgerGaps } from '../db/ledger';
import {
  type ConnectorHealthProbe, type ConnectorId, type ConversationLine, type CoverageObject, type ScanContext,
  type ScannerStore, type ScopeKey, type SpendBooked, type SpendRead, type TimeWindow, DEFAULT_SCANNING_PREFS,
  scopeId,
} from './types';
import type { UnlinkedSourceItemDetail } from './runtime/contract-ext';
import type { CompletionItem, CompletionSource } from './completion/types';
import {
  iso, DAY, toMs, mergeRanges, cmpPos, type SourceItemRow, COMPLETION_LIVE, completionFields,
} from './store-memory.rows';
import { InMemoryScannerStoreRuns } from './store-memory.runs';
export {
  RunStateError, CoverageError, NotFoundError, tokenize, normDriveRef, toMs, clampToCursor, mergeRanges, cmpPos,
} from './store-memory.rows';
export type { StoreClock, StoreProfile, InMemoryStoreOptions, LedgerRow } from './store-memory.rows';

export class InMemoryScannerStore extends InMemoryScannerStoreRuns implements ScannerStore {

  // ------------------------------------------------------------------ ScannerStore

  async getContext(scope: ScopeKey, opts: { maxOpenItems?: number } = {}): Promise<ScanContext> {
    const now = this.clock.now().getTime();
    const sid = scopeId(scope);
    const hasCoverage = this.committedRanges(sid).length > 0;
    const gaps = hasCoverage ? await this.coverageGaps(scope, { from: iso(now - 7 * DAY), to: iso(now) }) : [];
    const lastOk = [...this.runs.values()]
      .filter((r) => r.scopeId === sid && r.status === 'succeeded')
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
      .pop();
    const openItems = [...this.workItems.values()]
      .filter((w) => this.isLinkable(w, now))
      .sort((a, b) => (b.lastEvidenceAt ?? '').localeCompare(a.lastEvidenceAt ?? ''))
      .slice(0, opts.maxOpenItems ?? 60)
      .map((w) => this.digest(w));
    return {
      scope,
      cursor: this.cursors.get(sid) ?? null,
      gaps,
      me: this.profile.me,
      watchList: this.profile.watchList ?? [],
      aliases: this.profile.aliases ?? { accounts: [], channels: [] },
      openItems,
      initiatives: [...this.initiatives.values()].map((i) => ({
        initiativeId: i.id,
        title: i.title,
        purpose: i.purpose,
        accounts: i.accounts,
        keywords: i.keywords,
      })),
      skillVersion: lastOk?.skillVersion ?? '',
      scanning: { ...DEFAULT_SCANNING_PREFS, ...(this.profile.scanning ?? {}) },
      ...(this.profile.persona ? { persona: this.profile.persona } : {}),
    };
  }

  async getCursor(scope: ScopeKey) {
    return this.cursors.get(scopeId(scope)) ?? null;
  }

  /** Extension used by reconcile: [first committed coverage start, last committed coverage end] of a scope. */
  async coverageSpan(scope: ScopeKey): Promise<{ from: string; to: string } | null> {
    const r = this.committedRanges(scopeId(scope));
    if (!r.length) return null;
    return { from: iso(Math.min(...r.map((x) => x.from))), to: iso(Math.max(...r.map((x) => x.to))) };
  }

  async coverageGaps(scope: ScopeKey, window: TimeWindow): Promise<TimeWindow[]> {
    const sid = scopeId(scope);
    const committed = this.committedRanges(sid);
    if (!committed.length) return [{ ...window }];
    const low = Math.min(...committed.map((r) => r.from));
    const from = Math.max(toMs(window.from)!, low);
    const to = toMs(window.to)!;
    if (to <= from) return [];
    const merged = mergeRanges(committed, this.tol);
    const holes: TimeWindow[] = [];
    let at = from;
    for (const r of merged) {
      if (r.to <= at) continue;
      if (r.from > at + this.tol) holes.push({ from: iso(at), to: iso(Math.min(r.from, to)) });
      at = Math.max(at, r.to);
      if (at >= to) break;
    }
    if (at < to - this.tol) holes.push({ from: iso(at), to: iso(to) });
    return holes.filter((h) => toMs(h.to)! > toMs(h.from)!);
  }

  async uncoveredObjects(scope: ScopeKey, listed: CoverageObject[]): Promise<CoverageObject[]> {
    const sid = scopeId(scope);
    const committed = this.ledgerRows.filter((l) => l.scopeId === sid && l.outcome === 'complete');
    return listed.filter((L) => {
      const direct = committed.some((c) => c.object.kind === L.kind && c.object.ref === L.ref && (L.to == null || (c.object.to != null && cmpPos(c.object.to, L.to) >= 0)));
      if (direct) return false;
      const parent = typeof L.meta?.parentRef === 'string' ? (L.meta.parentRef as string) : undefined;
      const at = toMs(L.from);
      if (parent && at != null) {
        const inRange = committed.some((c) => c.object.ref === parent && c.fromMs != null && c.toMs != null && c.fromMs <= at && at < c.toMs);
        if (inRange) return false;
      }
      return true;
    });
  }

  async unlinkedSourceItems(opts: { connector?: ConnectorId; minAttempts?: number; maxAttempts?: number; limit?: number }): Promise<UnlinkedSourceItemDetail[]> {
    const min = opts.minAttempts ?? 0;
    const max = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
    return [...this.unlinked.values()]
      .filter((u) => !u.ignored && !this.hasEvidence(u.sourceItemId))
      .filter((u) => u.attempts >= min && u.attempts <= max)
      .map((u) => ({ u, s: this.sourceItems.get(u.sourceItemId)! }))
      .filter(({ s }) => !opts.connector || s.connector === opts.connector)
      .sort((a, b) => a.u.lastFlaggedAt.localeCompare(b.u.lastFlaggedAt) || a.u.sourceItemId.localeCompare(b.u.sourceItemId))
      .slice(0, opts.limit ?? 50)
      .map(({ u, s }) => ({
        sourceItemId: u.sourceItemId,
        attempts: u.attempts,
        reason: u.reason,
        hints: u.hints,
        connector: s.connector,
        excerpt: s.excerpt,
        title: s.title,
        threadRef: s.threadRef,
        occurredAt: s.occurredAt,
        fromMe: s.author?.isMe === true,
        toMe: (s.participants ?? []).some((x) => x.isMe) || (s.payload as { toMe?: boolean } | undefined)?.toMe === true,
      }));
  }

  async ignoreUnlinked(sourceItemId: string, note: string): Promise<void> {
    const row = this.unlinked.get(sourceItemId);
    if (row) row.ignored = note;
  }

  async recordTriageVerdicts(verdicts: Array<{ sourceItemId: string; v: 'act' | 'noise' | 'unsure'; why?: string }>): Promise<void> {
    for (const x of verdicts) if (this.sourceItems.has(x.sourceItemId)) this.verdicts.set(x.sourceItemId, { v: x.v, ...(x.why ? { why: x.why } : {}) });
  }

  /** Stored verdicts; a message with non-context evidence reads as `act` / `linked` (an earlier run linked it). */
  async triageVerdicts(sourceItemIds: string[]): Promise<Map<string, { v: 'act' | 'noise' | 'unsure'; why?: string }>> {
    const linked = (id: string) => [...this.evidence.values()].some((e) => e.sourceItemId === id && e.role !== 'context');
    return new Map(sourceItemIds.flatMap((id) => (linked(id) ? [[id, { v: 'act' as const, why: 'linked' }] as const] : this.verdicts.has(id) ? [[id, this.verdicts.get(id)!] as const] : [])));
  }

  async conversationLines(q: { channelId?: string; threadRef?: string; before: { at: string; limit: number }; after: { at: string; limit: number } }): Promise<ConversationLine[]> {
    const inConv = (s: SourceItemRow) =>
      s.connector === 'slack' && s.kind === 'message' && (q.threadRef ? s.threadRef === q.threadRef : !!q.channelId && (s.externalId.startsWith(`${q.channelId}:`) || (s.payload as { channelId?: string } | undefined)?.channelId === q.channelId));
    const all = [...this.sourceItems.values()].filter(inConv).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const b = toMs(q.before.at)!;
    const a = toMs(q.after.at)!;
    const before = all.filter((s) => toMs(s.occurredAt)! < b).slice(-Math.max(0, q.before.limit));
    const after = all.filter((s) => toMs(s.occurredAt)! > a).slice(0, Math.max(0, q.after.limit));
    return [...before, ...after].map(({ id, revision: _r, firstRunId: _f, lastRunId: _l, ...item }) => ({ sourceItemId: id, item }));
  }

  async recordHealth(connector: ConnectorId, probe: ConnectorHealthProbe) {
    const list = this.healthLog.get(connector) ?? [];
    list.push({ ...probe });
    this.healthLog.set(connector, list);
  }

  /** E3: the last recorded health is "needs re-auth": since its last auth failure (like the DB store's last_error_at). */
  async authPausedSince(connector: ConnectorId): Promise<string | null> {
    const last = this.healthLog.get(connector)?.at(-1);
    return last?.state === 'auth_required' ? last.checkedAt : null;
  }

  async recordSpend(input: SpendRead | SpendBooked) {
    const day = this.dayKey(this.clock.now());
    // D0: a booked call must carry its audit fields and tokens, like the DB store (tests fail on a gap).
    if (input.costUsd > 0) noteLedgerGaps(`memory.recordSpend:${input.connector}`, input as SpendBooked);
    // BUD-1: like the DB store, each call spends the budget its job runs under (the trace context), and the daily cap
    // counts daily spend only.
    const budget = input.budget ?? traceContext()?.budget ?? 'daily';
    if (input.costUsd > 0) this.spend.push({ day, connector: input.connector, model: input.model, costUsd: input.costUsd, runId: input.runId, budget });
    return { todayUsd: this.dailySpendToday(), softCapUsd: this.softCapUsd, hardCapUsd: this.hardCapUsd };
  }

  /** BUD-1: today's spend on the daily budget (the caps' measure). `spendToday()` is every budget. */
  dailySpendToday(): number {
    const day = this.dayKey(this.clock.now());
    return this.spend.filter((s) => s.day === day && s.budget === 'daily').reduce((a, s) => a + s.costUsd, 0);
  }

  // ------------------------------------------------------------------ completion pass read helpers (CMP-1)

  /** Today's spend vs the caps, in the DB store's shape (completion pass budget gate). */
  async budgetStatus(): Promise<{ todayUsd: number; softCapUsd: number; hardCapUsd: number; state: 'ok' | 'soft_alert' | 'capped' }> {
    const todayUsd = this.dailySpendToday();
    const state = todayUsd >= this.hardCapUsd ? 'capped' : this.softCapUsd > 0 && todayUsd >= this.softCapUsd * 0.8 ? 'soft_alert' : 'ok';
    return { todayUsd, softCapUsd: this.softCapUsd, hardCapUsd: this.hardCapUsd, state };
  }

  /** Open items that are mine (completion LIVE_STATUSES, involvement owner/contributor), with their evidence. */
  async completionItems(opts: { asOf?: string; limit?: number; statuses?: readonly string[] } = {}): Promise<CompletionItem[]> {
    const asOf = toMs(opts.asOf) ?? this.clock.now().getTime();
    const statuses: readonly string[] = opts.statuses?.length ? opts.statuses : COMPLETION_LIVE;
    const runAt = (runId: string | undefined) => toMs(runId ? this.runs.get(runId)?.startedAt : undefined);
    const out: CompletionItem[] = [];
    for (const w of this.workItems.values()) {
      if (!statuses.includes(w.state)) continue;
      if (w.involvement && w.involvement !== 'owner' && w.involvement !== 'contributor') continue;
      if (w.resolution) continue;
      const ev = [...this.evidence.values()].filter((e) => e.workItemId === w.id && (runAt(e.runId) ?? 0) <= asOf);
      const created = runAt(w.createdRunId) ?? Math.min(...ev.map((e) => toMs(this.sourceItems.get(e.sourceItemId)?.occurredAt) ?? asOf), asOf);
      if (created > asOf) continue;
      out.push({
        ...(w.correction ? { mayAutoClose: false } : {}),
        workItemId: w.id,
        kind: w.kind,
        title: w.title,
        ...(w.purpose ? { purpose: w.purpose } : {}),
        status: w.state,
        ...(w.due ? { due: w.due } : {}),
        createdAt: iso(created),
        ...(w.involvement ? { involvement: w.involvement } : {}),
        ...(w.accountId ? { accountId: w.accountId } : {}),
        accountNames: w.accountId ? (this.profile.aliases?.accounts.find((a) => a.accountId === w.accountId)?.names ?? []) : [],
        fileRefs: [...new Set([...(w.expected?.fileId ? [w.expected.fileId] : [])])],
        evidence: ev.flatMap((e) => {
          const s = this.sourceItems.get(e.sourceItemId);
          return s ? [{ sourceItemId: s.id, role: e.role, ...completionFields(s), ...(e.reason ? { reason: e.reason } : {}) }] : [];
        }),
      });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
  }

  /** Source items that arrived (first recorded, or last changed) in (seenAfter, seenUntil], newest first. */
  async completionSources(opts: { seenAfter: string; seenUntil: string; limit?: number }): Promise<CompletionSource[]> {
    const after = toMs(opts.seenAfter) ?? 0;
    const until = toMs(opts.seenUntil) ?? Number.POSITIVE_INFINITY;
    const out: CompletionSource[] = [];
    for (const s of this.sourceItems.values()) {
      const seen = toMs(this.runs.get(s.revision > 1 ? s.lastRunId : s.firstRunId)?.startedAt);
      if (seen == null || seen <= after || seen > until) continue;
      out.push({
        sourceItemId: s.id,
        ...completionFields(s),
        ...(s.excerpt ? { text: s.excerpt.slice(0, 1200) } : {}),
        seenAt: iso(seen),
        ...(s.title ? { title: s.title } : {}),
        ...(s.permalink ? { url: s.permalink } : {}),
      });
    }
    return out.sort((a, b) => b.seenAt.localeCompare(a.seenAt)).slice(0, opts.limit ?? 4000);
  }
}
