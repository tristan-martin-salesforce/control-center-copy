// DbScannerStore finish / fail, unlinked, triage and health. Split from store-db.ts (max-lines); the class is still exported from store-db.ts.
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { redact } from '@/connectors/redact';
import type { Tx } from '@/db/client';
import { enqueueResolutionTriggers } from './resolution/triggers-db';
import { trace } from '@/scanner/trace';
import type { UnlinkedSourceItemDetail } from './runtime/contract-ext';
import { clampToCursor, CoverageError, mergeRanges, RunStateError, toMs } from './store-memory';
import {
  scopeId, type ConnectorHealthProbe, type ConnectorId, type CoverageObject, type Cursor, type PersonRef,
  type ConversationLine, type ScanRunStats, type ScopeKey,
} from './types';
import {
  TOL, rangeOf, type Range, firstHole, isoMs, coverageToLedger, RUNS, type RunState, iso, textArr, LEDGER_KIND,
  cmpPos, parseFinding, UUID, uuidArr, type ConnectorStatus, CONNECTOR_META,
} from './store-db.shared';
import { insertLedger, contractErrorClass, failureCode, personOf, strings } from './store-db.rows';
import { DbScannerStoreProposals } from './store-db.proposals';

/** This process's mark on a scope's re-evaluation handoff (ask #14): a handoff from another process is a dead one's. */
const PROCESS_TOKEN = randomUUID();

/** DbScannerStore's finish / fail, cursors, unlinked items, conversation lines, triage verdicts and health. */
export abstract class DbScannerStoreFinish extends DbScannerStoreProposals {

  // ------------------------------------------------------------------ finish / fail

  async finishRun(runId: string, input: { cursor: Cursor; summary?: string; stats: ScanRunStats }): Promise<{ touchedWorkItemIds: string[] }> {
    const run = await this.run(runId);
    const sid = scopeId(run.scope);
    const touched = await this.cs(
      run.scope.connector,
      `scan ${sid} finished`,
      async (tx) => {
        await this.mustRunning(tx, runId);
        const wFrom = toMs(run.window.from)!;
        const wTo = toMs(run.window.to)!;
        const at = toMs(input.cursor.at);
        if (at == null) throw new CoverageError('finishRun: cursor.at is not a timestamp');
        if (at < wFrom - TOL || at > wTo + TOL) throw new CoverageError(`finishRun: cursor.at ${input.cursor.at} is outside the run window`);

        // (c) committed + staged coverage must span [window.from, cursor.at); an incomplete run claims nothing past its cursor (S8c)
        if (at < wTo - TOL) run.staged = clampToCursor(run.staged, at);
        const committed = await this.mergedRanges(tx, run.connectorId, sid, wFrom - TOL);
        const staged = run.staged.map(rangeOf).filter((r): r is Range => !!r);
        const hole = firstHole(mergeRanges([...committed, ...staged], TOL), wFrom, at, TOL);
        if (hole) throw new CoverageError(`finishRun: coverage does not span up to the cursor (hole ${isoMs(hole.from)} → ${isoMs(hole.to)})`);

        // (d) commit coverage, close the run, keep the proposed cursor on it
        await insertLedger(tx, run.connectorId, sid, runId, coverageToLedger(run.staged, 'complete'));
        const st = input.stats ?? ({} as ScanRunStats);
        const fetched = Math.max(0, Math.trunc(st.fetched ?? 0));
        const nw = Math.max(0, Math.trunc(st.new ?? 0));
        const ch = Math.max(0, Math.trunc(st.changed ?? 0));
        await tx.execute(sql`
          update scan_runs set
                 status = 'succeeded', finished_at = ${this.now().toISOString()}::timestamptz,
                 items_seen = ${fetched}, items_new = ${nw}, items_updated = ${ch}, items_unchanged = ${Math.max(0, fetched - nw - ch)},
                 links_created = ${Math.max(0, Math.trunc(st.linked ?? 0))}, candidates_created = ${Math.max(0, Math.trunc(st.proposed ?? 0))},
                 cost_usd = greatest(cost_usd, ${Number(st.costUsd ?? 0)}),
                 input_tokens = ${Math.max(0, Math.trunc(st.inputTokens ?? 0))}, output_tokens = ${Math.max(0, Math.trunc(st.outputTokens ?? 0))},
                 cursor_after = ${JSON.stringify({ value: input.cursor.value, at: isoMs(at), unlinked: st.unlinked ?? 0, turns: st.turns ?? null })}::jsonb
           where id = ${runId}`);

        // (e) S9 cursor advance
        await this.advanceCursor(tx, run, sid);

        // (f) S10 fan-out set. The runtime queues their re-evaluations after this commits, so a worker killed in between
        // lost them (ask #14, crash drill (c)): the set is kept as the scope's `handoff`, and the next finish of the
        // scope in another process (the worker that wrote it is gone) hands back every id of it that no re-evaluation
        // job picked up since (none queued or running, none created after the handoff). In the same process the runtime
        // owns the enqueue and its retry (scanner-runtime.jobs.ts `reevalBacklog`), so a repeat touches nothing (S10).
        const p = await tx.execute<{ pending: string[] | null; lost: string[] | null }>(sql`
          select array(select jsonb_array_elements_text(cursor_json->'pending')) as pending,
                 array(select h.id from jsonb_array_elements_text(coalesce(cursor_json->'handoff'->'ids', '[]'::jsonb)) as h(id)
                        where coalesce(cursor_json->'handoff'->>'proc', '') <> ${PROCESS_TOKEN}
                          and not exists (select 1 from jobs j where j.dedupe_key = concat('reeval:work_item:', h.id) and j.owner_user_id = ${this.userId}
                                             and (j.status in ('queued', 'running') or j.created_at >= (cursor_json->'handoff'->>'at')::timestamptz))) as lost
            from scan_cursors where connector_id = ${run.connectorId} and scope = ${sid} for update`);
        const handoff = [...new Set([...(p.rows[0]?.pending ?? []), ...(p.rows[0]?.lost ?? [])])].sort();
        await tx.execute(sql`
          update scan_cursors set cursor_json = (coalesce(cursor_json, '{}'::jsonb) - 'pending' - 'handoff')
                                                || jsonb_build_object('handoff', jsonb_build_object('at', now(), 'proc', ${PROCESS_TOKEN}::text, 'ids', to_jsonb(${textArr(handoff)})))
           where connector_id = ${run.connectorId} and scope = ${sid}`);
        await tx.execute(sql`
          update connectors set last_success_at = ${this.now().toISOString()}::timestamptz
           where id = ${run.connectorId} and (last_success_at is null or last_success_at < ${this.now().toISOString()}::timestamptz - interval '60 seconds')`);
        // AUDIT: a success closes this scope's open failure events in the Health error feed (the next failure opens a new
        // one). Its own savepoint: it never fails the commit.
        await tx
          .transaction((sp) =>
            sp.execute(sql`
              update app_events set resolved_at = now()
               where owner_user_id = ${this.userId} and resolved_at is null and component = ${`scanner.${run.scope.connector}`}
                 and code in ('scan_run_failed', 'prefix_tripwire', 'cost_cap') and entity_type = 'scope' and entity_id = ${sid}`),
          )
          .catch(() => undefined);
        // The failure count is reset by recordHealth(ok), when the connector recovers (HEALTH-1). Resetting it on any
        // success gave a Degraded connector "0 failures" while another scope kept failing.
        return handoff;
      },
      false,
    );
    RUNS.delete(runId);
    trace(runId, 'commit', { cursorAt: input.cursor.at, coverage: run.staged.length, touched: touched.length });
    // R3: the run's new lines trigger the resolution check (after the commit; never fails the scan)
    if (!/:(completion|resolution):check$/.test(sid)) await enqueueResolutionTriggers(this.db, this.userId, runId, this.now(), { connector: run.scope.connector }).catch(() => undefined);
    return { touchedWorkItemIds: touched };
  }

  /** S9: forward only, over contiguous committed coverage, to the newest proposed cursor it reaches. */
  protected async advanceCursor(tx: Tx, run: RunState, sid: string): Promise<void> {
    await tx.execute(sql`
      insert into scan_cursors (owner_user_id, connector_id, scope, cursor_kind)
      values (${this.userId}, ${run.connectorId}, ${sid}, 'composite')
      on conflict (connector_id, scope) do nothing`);
    const cur = await tx.execute<{ id: string; high_watermark_at: string | null }>(sql`
      select id, high_watermark_at from scan_cursors where connector_id = ${run.connectorId} and scope = ${sid} for update`);
    const curRow = cur.rows[0]!;
    const curAt = curRow.high_watermark_at ? Date.parse(iso(curRow.high_watermark_at)!) : Number.NEGATIVE_INFINITY;
    const low = await tx.execute<{ low: string | null }>(sql`
      select min(covered_from) as low from scan_ledger_entries
       where connector_id = ${run.connectorId} and scope = ${sid} and outcome = 'complete' and covered is not null and not isempty(covered)`);
    const lowMs = low.rows[0]?.low ? Date.parse(iso(low.rows[0].low)!) : undefined;
    let reach = Number.POSITIVE_INFINITY;
    if (lowMs !== undefined) {
      const base = Number.isFinite(curAt) ? curAt : lowMs;
      const merged = await this.mergedRanges(tx, run.connectorId, sid, base - TOL);
      const seg = merged.find((r) => r.from <= base + TOL && base <= r.to + TOL);
      reach = seg ? seg.to : base;
    }
    const cand = await tx.execute<{ id: string; value: string; at: string }>(sql`
      select id, cursor_after->>'value' as value, cursor_after->>'at' as at from scan_runs
       where connector_id = ${run.connectorId} and scope = ${sid} and status = 'succeeded' and cursor_after ? 'value'
         and (cursor_after->>'at')::timestamptz > ${Number.isFinite(curAt) ? isoMs(curAt) : '-infinity'}::timestamptz
         ${Number.isFinite(reach) ? sql`and (cursor_after->>'at')::timestamptz <= ${isoMs(reach + TOL)}::timestamptz` : sql``}
       order by (cursor_after->>'at')::timestamptz desc, finished_at desc limit 1`);
    const next = cand.rows[0];
    if (!next) return;
    await tx.execute(sql`
      update scan_cursors set cursor_kind = 'composite', cursor_value = ${next.value}, high_watermark_at = ${next.at}::timestamptz,
             low_watermark_at = coalesce(low_watermark_at, ${lowMs !== undefined ? isoMs(lowMs) : null}::timestamptz),
             last_run_id = ${next.id}, last_advanced_at = now(), updated_at = now()
       where id = ${curRow.id}`);
    // Passed cursors can never be chosen again: drop their (possibly large) opaque values.
    await tx.execute(sql`
      update scan_runs set cursor_after = cursor_after - 'value'
       where connector_id = ${run.connectorId} and scope = ${sid} and cursor_after ? 'value'
         and (cursor_after->>'at')::timestamptz <= ${next.at}::timestamptz`);
  }

  async failRun(
    runId: string,
    input: { error: string; errorClass?: ConnectorHealthProbe['errorClass']; stats?: Partial<ScanRunStats> },
  ): Promise<void> {
    const run = await this.run(runId);
    await this.cs(
      run.scope.connector,
      `scan ${scopeId(run.scope)} failed`,
      async (tx) => {
        const r = await tx.execute<{ status: string }>(sql`select status from scan_runs where id = ${runId} for update`);
        if (!r.rows[0]) throw new RunStateError(`failRun: unknown run ${runId}`);
        if (r.rows[0].status !== 'running') return; // idempotent
        // S7: staged coverage is kept, as `error` (never counts for gaps, cursors or objects).
        await insertLedger(tx, run.connectorId, scopeId(run.scope), runId, coverageToLedger(run.staged, 'error'));
        const aborted = /abort|cancel/i.test(input.error ?? '');
        await tx.execute(sql`
          update scan_runs set
                 status = ${aborted ? 'cancelled' : 'failed'}, finished_at = ${this.now().toISOString()}::timestamptz,
                 error_code = ${input.errorClass ?? (aborted ? 'aborted' : 'unknown')},
                 error_message = ${redact(input.error ?? '').text.slice(0, 300)},
                 error_count = error_count + 1,
                 items_seen = greatest(items_seen, ${Math.max(0, Math.trunc(input.stats?.fetched ?? 0))}),
                 items_new = greatest(items_new, ${Math.max(0, Math.trunc(input.stats?.new ?? 0))}),
                 cost_usd = greatest(cost_usd, ${Number(input.stats?.costUsd ?? 0)})
           where id = ${runId}`);
        if (!aborted) {
          await tx.execute(sql`
            update connectors set last_error_at = ${this.now().toISOString()}::timestamptz, last_error_code = ${contractErrorClass(input.errorClass)},
                   consecutive_failures = consecutive_failures + 1
             where id = ${run.connectorId}`);
          // Its own savepoint: the Health error event never fails (or rolls back) the run's failure record.
          await tx.transaction((sp) => this.failureEvent(sp, run, runId, input.error ?? '', input.errorClass)).catch(() => undefined);
        }
      },
      false,
    );
    RUNS.delete(runId);
    trace(runId, 'failed', { errorClass: input.errorClass ?? null, code: failureCode(input.error ?? ''), error: input.error ?? null });
  }

  async uncoveredObjects(scope: ScopeKey, listed: CoverageObject[]): Promise<CoverageObject[]> {
    if (!listed.length) return [];
    const connectorId = await this.connectorId(scope.connector);
    const parentOf = (o: CoverageObject) => (typeof o.meta?.parentRef === 'string' ? (o.meta.parentRef as string) : undefined);
    const refs = [...new Set(listed.flatMap((o) => [o.ref, ...(parentOf(o) ? [parentOf(o)!] : [])]))];
    const res = await this.db.execute<{ k: string; r: string; f: string | null; t: string | null; et: string | null }>(sql`
      select object_kind::text as k, object_external_id as r, covered_from as f, covered_to as t, end_token as et
        from scan_ledger_entries
       where connector_id = ${connectorId} and scope = ${scopeId(scope)} and outcome = 'complete' and object_external_id = any(${textArr(refs)})`);
    const rows = res.rows;
    return listed.filter((L) => {
      const kind = LEDGER_KIND[L.kind];
      const direct = rows.some((c) => c.k === kind && c.r === L.ref && (L.to == null || ((c.et ?? iso(c.t)) != null && cmpPos((c.et ?? iso(c.t))!, L.to) >= 0)));
      if (direct) return false;
      const parent = parentOf(L);
      const at = toMs(L.from);
      if (parent && at != null) {
        const inRange = rows.some((c) => c.r === parent && c.f && c.t && Date.parse(iso(c.f)!) <= at && at < Date.parse(iso(c.t)!));
        if (inRange) return false;
      }
      return true;
    });
  }

  async unlinkedSourceItems(opts: {
    connector?: ConnectorId;
    minAttempts?: number;
    maxAttempts?: number;
    limit?: number;
  }): Promise<UnlinkedSourceItemDetail[]> {
    const res = await this.db.execute<{
      source_item_id: string;
      detail: string | null;
      trig: string | null;
      run_id: string | null;
      at: string;
      created: string;
      connector: string | null;
      title: string | null;
      body: string | null;
      thread: string | null;
      occurred: string;
      from_me: boolean;
      to_me: boolean;
    }>(sql`
      select f.source_item_id, f.detail, r.trigger::text as trig, f.scan_run_id as run_id, f.updated_at as at, f.created_at as created,
             si.meta->>'connector' as connector, si.title, left(si.body, 1000) as body, si.external_parent_id as thread, si.occurred_at as occurred,
             si.from_me, si.addressed_to_me as to_me
        from reconcile_findings f
        join source_items si on si.id = f.source_item_id
        left join scan_runs r on r.id = f.scan_run_id
       where f.owner_user_id = ${this.userId} and f.kind = 'unlinked_item'
         and not exists (select 1 from work_item_evidence e where e.source_item_id = f.source_item_id)
         and not exists (select 1 from reconcile_findings g where g.source_item_id = f.source_item_id and g.kind = 'unlinked_item' and g.status = 'ignored')
         ${opts.connector ? sql`and si.meta->>'connector' = ${opts.connector}` : sql``}
       order by f.created_at, f.id`);
    const by = new Map<string, typeof res.rows>();
    for (const r of res.rows) by.set(r.source_item_id, [...(by.get(r.source_item_id) ?? []), r]);
    const out: Array<UnlinkedSourceItemDetail & { last: number }> = [];
    for (const [sourceItemId, rows] of by) {
      // rows are per run, in order of each run's first flag
      const counted = rows.filter((r) => parseFinding(r.detail).counts);
      const reconcileRuns = new Set(counted.filter((r) => r.trig === 'reconcile').map((r) => r.run_id));
      const attempts = reconcileRuns.size + (counted[0] && counted[0].trig !== 'reconcile' ? 1 : 0);
      const latest = [...rows].sort((a, b) => Date.parse(iso(b.at)!) - Date.parse(iso(a.at)!))[0]!;
      const hints = [...new Set([...rows].reverse().flatMap((r) => parseFinding(r.detail).hints))].slice(0, 20);
      out.push({
        sourceItemId,
        attempts,
        reason: parseFinding(latest.detail).reason,
        hints,
        connector: (latest.connector ?? undefined) as ConnectorId | undefined,
        excerpt: latest.body ?? undefined,
        title: latest.title ?? undefined,
        threadRef: latest.thread ?? undefined,
        occurredAt: iso(latest.occurred),
        fromMe: latest.from_me === true,
        toMe: latest.to_me === true,
        last: Date.parse(iso(latest.at)!),
      });
    }
    const min = opts.minAttempts ?? 0;
    const max = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
    return out
      .filter((u) => u.attempts >= min && u.attempts <= max)
      .sort((a, b) => a.last - b.last || a.sourceItemId.localeCompare(b.sourceItemId))
      .slice(0, opts.limit ?? 50)
      .map(({ last: _last, ...u }) => u);
  }

  /** MAP-1: no mapping question for this item (not an ask or commitment of mine): its findings are ignored for good. */
  async ignoreUnlinked(sourceItemId: string, note: string): Promise<void> {
    await this.db.execute(sql`
      update reconcile_findings set status = 'ignored', resolution_note = ${redact(note).text.slice(0, 200)}, resolved_at = now(), updated_at = now()
       where owner_user_id = ${this.userId} and source_item_id = ${sourceItemId} and kind = 'unlinked_item' and status <> 'ignored'`);
  }

  // ------------------------------------------------------------------ triage context (TRI-CTX, TRI-NOISE)

  /**
   * A conversation's recorded messages from any run or window, oldest first: the last `before.limit` before
   * `before.at` and the first `after.limit` after `after.at`. A DM by its channel id, a thread by its root ref.
   */
  async conversationLines(q: { channelId?: string; threadRef?: string; before: { at: string; limit: number }; after: { at: string; limit: number } }): Promise<ConversationLine[]> {
    if (!q.threadRef && !q.channelId) return [];
    const where = q.threadRef ? sql`si.external_parent_id = ${q.threadRef}` : sql`(si.external_id like ${`${q.channelId!.replace(/[%_\\]/g, '')}:%`} or si.meta->>'channelId' = ${q.channelId!})`;
    const cols = sql.raw(`si.id, si.external_id, si.external_parent_id, si.occurred_at, si.from_me, si.addressed_to_me, si.url, left(si.body, 1000) as body, si.meta`);
    type Row = { id: string; external_id: string; external_parent_id: string | null; occurred_at: string; from_me: boolean; addressed_to_me: boolean; url: string | null; body: string | null; meta: Record<string, unknown> | null };
    const [before, after] = await Promise.all([
      q.before.limit > 0
        ? this.db.execute<Row>(sql`
            select ${cols} from source_items si
             where si.owner_user_id = ${this.userId} and si.source = 'slack' and si.kind = 'slack_message' and ${where}
               and si.occurred_at < ${q.before.at}::timestamptz
             order by si.occurred_at desc limit ${Math.min(q.before.limit, 50)}`)
        : Promise.resolve({ rows: [] as Row[] }),
      q.after.limit > 0
        ? this.db.execute<Row>(sql`
            select ${cols} from source_items si
             where si.owner_user_id = ${this.userId} and si.source = 'slack' and si.kind = 'slack_message' and ${where}
               and si.occurred_at > ${q.after.at}::timestamptz
             order by si.occurred_at asc limit ${Math.min(q.after.limit, 50)}`)
        : Promise.resolve({ rows: [] as Row[] }),
    ]);
    const line = (r: Row): ConversationLine => {
      const m = r.meta ?? {};
      const author = personOf(m.author);
      const participants = Array.isArray(m.participants) ? m.participants.map(personOf).filter((p): p is PersonRef => !!p) : [];
      const { itemKind: _k, connector: _c, threadRef: _t, fileRefs, accountHints, oppHints, author: _a, participants: _p, triage: _v, ...payload } = m as Record<string, unknown>;
      return {
        sourceItemId: r.id,
        item: {
          connector: 'slack',
          kind: 'message',
          externalId: r.external_id,
          dedupeKey: `slack:${r.external_id}`,
          contentHash: '',
          occurredAt: iso(r.occurred_at)!,
          ...(author ? { author } : {}),
          ...(participants.length ? { participants } : {}),
          excerpt: r.body ?? '',
          ...(r.external_parent_id ? { threadRef: r.external_parent_id } : {}),
          fileRefs: strings(fileRefs),
          accountHints: strings(accountHints),
          oppHints: strings(oppHints),
          ...(r.url ? { permalink: r.url } : {}),
          redacted: false,
          payload,
        },
      };
    };
    return [...[...before.rows].reverse(), ...after.rows].map(line);
  }

  /** Triage verdicts go onto their messages (`meta.triage`); an edit replaces the meta, so an edited message is judged again. */
  async recordTriageVerdicts(verdicts: Array<{ sourceItemId: string; v: 'act' | 'noise' | 'unsure'; why?: string }>): Promise<void> {
    const rows = verdicts.filter((x) => UUID.test(x.sourceItemId));
    if (!rows.length) return;
    const at = this.now().toISOString();
    const json = JSON.stringify(rows.map((x) => ({ id: x.sourceItemId, t: { v: x.v, ...(x.why ? { why: redact(x.why).text.slice(0, 160) } : {}), at } })));
    await this.db.execute(sql`
      update source_items si set meta = jsonb_set(coalesce(si.meta, '{}'::jsonb), '{triage}', x.t, true)
        from jsonb_to_recordset(${json}::jsonb) as x(id uuid, t jsonb)
       where si.id = x.id and si.owner_user_id = ${this.userId}`);
  }

  async triageVerdicts(sourceItemIds: string[]): Promise<Map<string, { v: 'act' | 'noise' | 'unsure'; why?: string }>> {
    const ids = sourceItemIds.filter((x) => UUID.test(x));
    if (!ids.length) return new Map();
    // A message with non-context evidence reads as `act` / `linked`: an earlier run linked it, so it is handled.
    const r = await this.db.execute<{ id: string; v: string | null; why: string | null }>(sql`
      select si.id,
             case when exists (select 1 from work_item_evidence e where e.source_item_id = si.id and e.role <> 'context') then 'act' else si.meta->'triage'->>'v' end as v,
             case when exists (select 1 from work_item_evidence e where e.source_item_id = si.id and e.role <> 'context') then 'linked' else si.meta->'triage'->>'why' end as why
        from source_items si
       where si.owner_user_id = ${this.userId} and si.id = any(${uuidArr(ids)})
         and (si.meta ? 'triage' or exists (select 1 from work_item_evidence e where e.source_item_id = si.id and e.role <> 'context'))`);
    const ok = (v: string | null): v is 'act' | 'noise' | 'unsure' => v === 'act' || v === 'noise' || v === 'unsure';
    return new Map(r.rows.flatMap((x) => (ok(x.v) ? [[x.id, { v: x.v, ...(x.why ? { why: x.why } : {}) }] as const] : [])));
  }

  // ------------------------------------------------------------------ health + spend

  async recordHealth(connector: ConnectorId, probe: ConnectorHealthProbe): Promise<void> {
    const connectorId = await this.connectorId(connector);
    const to: ConnectorStatus = (
      { ok: 'healthy', degraded: 'degraded', auth_required: 'auth_required', down: 'error', disabled: 'disabled' } as const
    )[probe.state];
    if (!to) throw new RangeError(`recordHealth: unknown state ${probe.state}`);
    const checkedAt = toMs(probe.checkedAt) != null ? isoMs(toMs(probe.checkedAt)!) : this.now().toISOString();
    const detail = probe.detail ? redact(probe.detail).text.slice(0, 240) : null;
    const label = CONNECTOR_META[connector]?.label ?? connector;
    const errClass = (c: ConnectorHealthProbe['errorClass']) =>
      c === 'config' ? 'validation' : c === 'auth' ? 'auth' : c === 'rate_limited' ? 'rate_limited' : c === 'transient' ? 'transient' : 'unknown';
    // B-084: connectors carry the contract's error classes and the re-auth affordance the probe named.
    const lastCode = contractErrorClass(probe.errorClass);
    const reauth = probe.reauth ? JSON.stringify({ kind: probe.reauth.kind, label: `Re-auth ${label}`, command: probe.reauth.command ?? null, instructions: probe.reauth.instructions ?? null }) : null;
    const from = await this.cs(
      connector,
      `health ${connector}: ${probe.state}`,
      async (tx) => {
        const cur = await tx.execute<{ status: ConnectorStatus }>(sql`select status from connectors where id = ${connectorId} for update`);
        const prev = cur.rows[0]?.status ?? null;
        const ok = probe.state === 'ok';
        await tx.execute(sql`
          update connectors set
                 status = ${to}, status_reason = ${ok ? null : detail},
                 status_changed_at = case when status is distinct from ${to}::connector_status then ${checkedAt}::timestamptz else status_changed_at end,
                 last_success_at = case when ${ok} then ${checkedAt}::timestamptz else last_success_at end,
                 last_error_at = case when ${ok} then last_error_at else ${checkedAt}::timestamptz end,
                 last_error_code = case when ${ok} then last_error_code else ${lastCode} end,
                 consecutive_failures = case when ${ok} then 0 else consecutive_failures + 1 end,
                 config = case when ${reauth}::jsonb is null then config else coalesce(config, '{}'::jsonb) || jsonb_build_object('reauth', ${reauth}::jsonb) end
           where id = ${connectorId}`);
        await tx.execute(sql`
          insert into connector_health_checks (connector_id, checked_at, ok, status, probe, error_code, error_message)
          values (${connectorId}, ${checkedAt}::timestamptz, ${ok}, ${to}, 'probe', ${ok ? null : lastCode}, ${ok ? null : detail})`);
        const dedupe = `connector:${connectorId}:status`;
        if (to === 'auth_required' || to === 'error') {
          await tx.execute(sql`
            insert into notifications (owner_user_id, kind, severity, title, body, entity_type, entity_id, connector_id, action_route,
                                       action_kind, dedupe_key)
            values (${this.userId}, ${to === 'auth_required' ? 'connector_auth_required' : 'connector_degraded'},
                    ${to === 'auth_required' ? 'warn' : 'error'},
                    ${to === 'auth_required' ? `${label} needs re-auth` : `${label} is not responding`},
                    ${probe.reauth?.instructions ?? detail ?? null}, 'connector', ${connector}, ${connectorId}, ${`/health#${connector}`},
                    ${probe.reauth ? 'reauth' : null}, ${dedupe})
            on conflict (owner_user_id, dedupe_key) where status in ('open', 'seen', 'snoozed')
            do update set title = excluded.title, body = excluded.body, kind = excluded.kind, severity = excluded.severity, updated_at = now()`);
          // D-39: schedules of an auth-broken connector pause until it is healthy again.
          if (to === 'auth_required') {
            await tx.execute(sql`update job_schedules set paused_reason = 'auth_required' where connector_id = ${connectorId} and paused_reason is null`);
          }
        } else if (to === 'healthy') {
          await tx.execute(sql`
            update notifications set status = 'resolved', resolved_at = now(), resolved_by = 'system', updated_at = now()
             where owner_user_id = ${this.userId} and dedupe_key = ${dedupe} and status in ('open', 'seen', 'snoozed')`);
          await tx.execute(sql`update job_schedules set paused_reason = null where connector_id = ${connectorId} and paused_reason = 'auth_required'`);
        }
        if (prev !== to) {
          await tx.execute(sql`
            insert into app_events (owner_user_id, severity, component, code, error_class, message, connector_id, detail, fingerprint)
            values (${this.userId}, ${to === 'healthy' ? 'info' : to === 'degraded' ? 'warn' : 'error'}, ${`connector.${connector}`},
                    ${`connector_${to}`}, ${to === 'healthy' ? null : errClass(probe.errorClass)},
                    ${`${label}: ${prev ?? 'new'} -> ${to}`}, ${connectorId}, ${JSON.stringify({ from: prev, to })}::jsonb,
                    ${`connector.${connector}|${to}`})
            on conflict (fingerprint) where resolved_at is null
            do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now(), message = excluded.message`);
        }
        return prev;
      },
      false,
    );
    if (from !== to) await this.o.onHealthChange?.({ connector, from, to, probe });
  }
}
