// DbScannerStore proposals. Split from store-db.ts (max-lines); the class is still exported from store-db.ts.
import { sql, type SQL } from 'drizzle-orm';

import { redact } from '@/connectors/redact';
import { engineUpdate } from '@/db/changeset';
import type { Tx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { workItems } from '@/db/schema';
import { loadClosingSettings } from '@/engines/settle/select-db';
import { pastDueOnArrival, pastDueReason, staleOnArrival, stillNeededReason } from '@/engines/still-needed';
import { trace } from '@/scanner/trace';
import type { BriefHighlightsInput } from './runtime/contract-ext';
import { counterpartNames, nameWords, parseDue, sameDeliverable } from './propose-rules';
import { NotFoundError as StoreNotFoundError, toMs } from './store-memory';
import { scopeId, type CoverageObject, type ProposeItemInput } from './types';
import {
  hashKey, isoMs, uuidArr, iso, DAY, CONFIDENCE_NUM, parseFinding, type FindingDetail, LEDGER_KIND, modelTierOf,
  RELEVANCE_NUM, RELEVANCE_LEVEL,
} from './store-db.shared';
import { DbScannerStoreItems } from './store-db.items';

/** DbScannerStore's proposals: items, deliverables, initiatives, unlinked flags, coverage, brief highlights, subscriptions. */
export abstract class DbScannerStoreProposals extends DbScannerStoreItems {

  async proposeItem(runId: string, input: ProposeItemInput): Promise<{ workItemId: string; landedAs: 'open' | 'suggested' }> {
    const run = await this.run(runId);
    if (!input.evidence?.length) throw new RangeError('proposeItem: at least one evidence row is required');
    if (!input.title?.trim()) throw new RangeError('proposeItem: title is required');
    const kind = (
      { task: 'task', commitment: 'commitment', ask: 'ask', training: 'training', follow_up: 'task', travel: 'travel', deliverable: 'task' } as const
    )[input.kind];
    if (!kind) throw new RangeError(`proposeItem: unknown kind ${input.kind}`);
    const origins = input.evidence.filter((e) => e.role === 'origin').map((e) => e.sourceItemId);
    const keyIds = [...(origins.length ? origins : input.evidence.map((e) => e.sourceItemId))].sort();
    const key = `propose:${hashKey(`${input.kind}|${keyIds.join(',')}`)}`;
    const extractorId = await this.extractorId(run.scope.connector, run.skillVersion, run.model);
    const title = redact(input.title.trim()).text.slice(0, 300);
    const tz = await this.timezone();
    const proposed = await this.cs(run.scope.connector, `propose ${input.kind}: ${title.slice(0, 80)}`, async (tx) => {
      await this.mustRunning(tx, runId);
      await this.mustSources(tx, [...new Set(input.evidence.map((e) => e.sourceItemId))]);
      // S4: same (kind, origin sources) → the item from the original proposal; only missing evidence is added.
      const existing = await tx.execute<{ id: string; landed: string | null }>(sql`
        select wi.id,
               (select t.to_status from work_item_transitions t where t.work_item_id = wi.id order by t.id limit 1) as landed
          from work_items wi
         where wi.owner_user_id = ${this.userId}
           and wi.id in (select e.work_item_id from work_item_evidence e where e.source_item_id = ${keyIds[0]!})
           and exists (select 1 from change_sets c where c.entity_type = 'work_items' and c.entity_id = wi.id::text
                          and c.editor_session_id = ${key} and c.undone_at is null)
         limit 1`);
      if (existing.rows[0]) {
        const w = existing.rows[0];
        for (const e of input.evidence) await this.addEvidence(tx, run, w.id, e.sourceItemId, e.role, input.confidence, e.reason, extractorId);
        return { workItemId: w.id, landedAs: (w.landed === 'suggested' ? 'suggested' : 'open') as 'open' | 'suggested' };
      }
      // DUP-1: the same conversation, the same person and the same deliverable (title words) is the item already there,
      // open or closed. An open one gets the new evidence; a closed one only context, except R2: the asker writing to me
      // again after a close for you (within the reopen window, Reopen on follow-up on) is a `contradiction` with
      // `follow_up:`, and the closure machine reopens it ("Reopened: PERSON wrote again", Undo on the change set).
      const dup = await this.conversationDuplicate(tx, origins, title);
      if (dup) {
        for (const e of input.evidence) {
          const followUp = !!dup.followUpBy && e.role === 'origin';
          const role = followUp ? 'contradiction' : dup.closed ? 'context' : e.role;
          const reason = followUp ? `follow_up: ${dup.followUpBy} wrote again: ${e.reason}` : `duplicate_of_existing: ${e.reason}`;
          await this.addEvidence(tx, run, dup.id, e.sourceItemId, role, input.confidence, reason, extractorId);
        }
        trace(runId, 'proposal', () => ({ kind: input.kind, deduped: dup.id, closed: dup.closed, followUp: !!dup.followUpBy }), { workItemId: dup.id, sourceItemId: origins[0] ?? null });
        return { workItemId: dup.id, landedAs: (dup.status === 'suggested' ? 'suggested' : 'open') as 'open' | 'suggested' };
      }
      const owned = await tx.execute<{ ini: string | null; acc: string | null; opp: string | null }>(sql`
        select (select id from initiatives where owner_user_id = ${this.userId} and id::text = ${input.initiativeId ?? ''}) as ini,
               (select id from accounts where owner_user_id = ${this.userId} and (id::text = ${input.accountId ?? ''} or org62_account_id = ${input.accountId ?? ''}) limit 1) as acc,
               (select id from opportunities where owner_user_id = ${this.userId} and (id::text = ${input.oppId ?? ''} or org62_opportunity_id = ${input.oppId ?? ''}) limit 1) as opp`);
      const o = owned.rows[0]!;
      if (input.initiativeId && !o.ini) throw new StoreNotFoundError(`initiative ${input.initiativeId}`);
      // DUE-1: a bare date is 17:00 in my timezone, a zone-less date-time is read there too (propose-rules).
      const dueMs = parseDue(input.due, tz);
      const due = Number.isFinite(dueMs) ? isoMs(dueMs) : null;
      // TRAIN-1: a training whose due date passed over two weeks before it was first seen, from a notice that old too (a
      // first scan reading old mail; Trainings looks back 120 days), is most likely done. It lands in Triage ("still
      // needed?") instead of leading Do now as overdue. A fresh overdue reminder still lands open.
      // MIN-9: the same for a training with no due date whose newest notice is over 30 days old (an onboarding curriculum
      // from months ago). A recent notice without a date stays open.
      // DEEP-1: any ask whose newest origin message was over 30 days old when first seen (the 90-day inbox reading
      // months-old asks) waits in Triage as "Still needed?" too, unless it is due after today. The status reason
      // carries the mark Triage groups by (src/engines/still-needed.ts).
      let staleOverdue = false;
      let stillNeeded: string | null = null;
      const nowMs = this.now().getTime();
      const originIds = input.evidence.filter((e) => e.role === 'origin').map((e) => e.sourceItemId);
      const r = originIds.length ? await tx.execute<{ newest: string | null }>(sql`select max(occurred_at) as newest from source_items where id = any(${uuidArr(originIds)})`) : { rows: [] };
      const newest = r.rows[0]?.newest ? Date.parse(iso(r.rows[0].newest)!) : NaN;
      if (input.kind === 'training' && (due ? Date.parse(due) < nowMs - 14 * DAY : true)) staleOverdue = Number.isFinite(newest) && newest < nowMs - (due ? 14 : 30) * DAY;
      // R15: Settings ▸ Closing ▸ Old asks sets the age (before: a hard-coded 30 days).
      const oldAskDays = (await loadClosingSettings(tx, this.userId)).oldAskDays;
      if (!staleOverdue && staleOnArrival({ originAt: newest, firstSeenAt: nowMs, dueAt: due, days: oldAskDays })) stillNeeded = stillNeededReason(newest, nowMs, `scanner:${run.scope.connector}`);
      // PAST-1: its due date had already passed when it was found (a first scan reading old asks): Still needed? too.
      // Trainings keep TRAIN-1's rule (a fresh overdue reminder stays open).
      else if (!staleOverdue && input.kind !== 'training' && due && pastDueOnArrival({ dueAt: due, firstSeenAt: nowMs })) stillNeeded = pastDueReason(due, `scanner:${run.scope.connector}`, tz);
      const status = input.confidence === 'guess' || staleOverdue || stillNeeded ? 'suggested' : 'open';
      const origin =
        run.trigger === 'reconcile'
          ? 'reconcile'
          : (
              { task: 'asked_of_me', commitment: 'said_by_me', ask: 'asked_of_me', training: 'system_rule', follow_up: 'meeting_next_step', travel: 'system_rule', deliverable: 'asked_of_me' } as const
            )[input.kind];
      const youMin = input.effort?.youMin;
      const agentMin = input.effort?.agentMin;
      const lead = youMin !== undefined || agentMin !== undefined ? (youMin ?? 0) + (agentMin ?? 0) : null;
      const likely = input.confidence === 'likely';
      const ins = await tx.execute<{ id: string }>(sql`
        insert into work_items (owner_user_id, kind, origin, status, status_reason, title, purpose, initiative_id, account_id,
                                opportunity_id, due_at, due_kind, effort_minutes, lead_time_minutes, effort_source, backgroundable,
                                confidence, created_by_extractor_id, last_new_info_at, unseen_evidence_count)
        values (${this.userId}, ${kind}, ${origin}, ${status}, ${staleOverdue ? `${due ? `Overdue since ${due.slice(0, 10)}` : 'An old notice with no due date'} when first seen: still needed? (scanner:${run.scope.connector})` : (stillNeeded ?? `Proposed by scanner:${run.scope.connector} (${input.confidence})`)},
                ${title}, ${input.purpose ? redact(input.purpose).text.slice(0, 500) : null}, ${o.ini}, ${o.acc}, ${o.opp},
                ${due}::timestamptz, ${due ? 'inferred' : null}, ${youMin ?? null}, ${lead}, ${youMin !== undefined ? 'llm' : 'default'},
                ${(agentMin ?? 0) > 0}, ${CONFIDENCE_NUM[input.confidence] ?? 0.5}, ${extractorId},
                ${likely ? this.now().toISOString() : null}::timestamptz, ${likely ? input.evidence.length : 0})
        returning id`);
      const id = ins.rows[0]!.id;
      await tx.execute(sql`
        update change_sets set entity_type = 'work_items', entity_id = ${id}, editor_session_id = ${key}
         where id = nullif(current_setting('cc.change_set_id', true), '')::uuid`);
      await tx.execute(sql`
        insert into work_item_transitions (work_item_id, from_status, to_status, actor_kind, actor_ref, reason, change_set_id)
        values (${id}, null, ${status}, 'connector', ${`scanner:${run.scope.connector}`}, ${`proposed (${input.confidence})`},
                nullif(current_setting('cc.change_set_id', true), '')::uuid)`);
      await this.markPending(tx, run, [id]);
      for (const e of input.evidence) {
        await tx.execute(sql`
          insert into work_item_evidence (work_item_id, source_item_id, role, confidence, extractor_id, rationale, created_by)
          values (${id}, ${e.sourceItemId}, ${e.role}, ${CONFIDENCE_NUM[input.confidence] ?? 0.5}, ${extractorId},
                  ${redact(e.reason ?? '').text.slice(0, 1000)}, 'connector')
          on conflict on constraint work_item_evidence_target_uq do nothing`);
      }
      if (input.kind === 'training') {
        await tx.execute(sql`
          insert into work_item_training_details (work_item_id, provider, course_title, required_by)
          values (${id}, 'email', ${title}, ${due}::timestamptz) on conflict do nothing`);
      }
      if (input.expected || input.kind === 'deliverable') await this.addDeliverable(tx, id, title, input, extractorId, keyIds[0]!);
      if (status === 'open') {
        await enqueueJob(tx, {
          ownerUserId: this.userId,
          kind: 'reevaluate',
          queue: 'engine',
          payload: { work_item_id: id },
          dedupeKey: `reeval:work_item:${id}`,
          generation: 0,
          supersedesRunning: true,
          delaySeconds: 2,
        });
      }
      return { workItemId: id, landedAs: status as 'open' | 'suggested' };
    });
    // AUDIT: what was proposed from which evidence (ids and the model's short reasons; the title lives on the item).
    trace(runId, 'proposal', () => ({ kind: input.kind, confidence: input.confidence, landedAs: proposed.landedAs, due: input.due ?? null, evidence: input.evidence.map((e) => ({ sourceItemId: e.sourceItemId, role: e.role, reason: e.reason })) }), { workItemId: proposed.workItemId, sourceItemId: origins[0] ?? input.evidence[0]?.sourceItemId });
    return proposed;
  }

  /**
   * DUP-1: an item whose origin is in the same conversation (a DM or group DM, else the thread), from the same person
   * (the origin's author: me for my commitments), with the same deliverable in its title. Open items of any age; closed
   * ones (done, dismissed, merged) only when their origin is within 14 days of this one.
   */
  protected async conversationDuplicate(tx: Tx, originIds: string[], title: string): Promise<{ id: string; status: string; closed: boolean; followUpBy: string | null } | null> {
    if (!originIds.length) return null;
    const conv = sql.raw(`coalesce(case when s.meta->>'channelType' in ('im', 'mpim') and s.meta->>'channelId' is not null then 'dm:' || (s.meta->>'channelId') end, s.external_parent_id)`);
    const convO = sql.raw(`coalesce(case when o.meta->>'channelType' in ('im', 'mpim') and o.meta->>'channelId' is not null then 'dm:' || (o.meta->>'channelId') end, o.external_parent_id)`);
    const r = await tx.execute<{
      id: string;
      status: string;
      title: string;
      author: string | null;
      done_by: string | null;
      done_at: string | null;
      m_from_me: boolean;
      m_to_me: boolean;
      m_at: string;
      m_parts: unknown;
    }>(sql`
      with mine as (
        select ${conv} as conv, case when s.from_me then 'me' else lower(coalesce(s.actor_external_id, s.meta->'author'->>'externalId', s.meta->'author'->>'name', '')) end as who,
               s.occurred_at, s.meta->'author'->>'name' as author, s.from_me,
               (s.addressed_to_me or coalesce(s.meta->>'channelType', '') in ('im', 'mpim')) as to_me, s.meta->'participants' as parts
          from source_items s where s.id = any(${uuidArr(originIds)}))
      select distinct on (wi.id) wi.id, wi.status::text as status, wi.title, m.author, wi.done_by::text as done_by, wi.done_at,
             m.from_me as m_from_me, m.to_me as m_to_me, m.occurred_at as m_at, m.parts as m_parts
        from mine m
        join source_items o on o.owner_user_id = ${this.userId} and ${convO} = m.conv and m.conv is not null and m.who <> ''
             and (case when o.from_me then 'me' else lower(coalesce(o.actor_external_id, o.meta->'author'->>'externalId', o.meta->'author'->>'name', '')) end) = m.who
        join work_item_evidence e on e.source_item_id = o.id and e.role = 'origin'
        join work_items wi on wi.id = e.work_item_id and wi.owner_user_id = ${this.userId}
       where o.id <> all(${uuidArr(originIds)})
         and (wi.status::text not in ('done', 'dismissed', 'merged') or abs(extract(epoch from (o.occurred_at - m.occurred_at))) <= 14 * 86400)
       order by wi.id, o.occurred_at desc
       limit 20`);
    // SCN-14: the people's names never make two titles one; for my commitments that is the counterpart (the others in
    // the conversation), not only me.
    const exclude = nameWords(...r.rows.map((x) => x.author), ...r.rows.filter((x) => x.m_from_me).flatMap((x) => counterpartNames(x.m_parts)));
    const hit = r.rows
      .filter((x) => sameDeliverable(title, x.title, exclude))
      .sort((a, b) => Number(['done', 'dismissed', 'merged'].includes(a.status)) - Number(['done', 'dismissed', 'merged'].includes(b.status)))[0];
    if (!hit) return null;
    const closed = ['done', 'dismissed', 'merged'].includes(hit.status);
    // R2: the asker (not me) writing to me again after a close for you, within the reopen window.
    let followUpBy: string | null = null;
    if (closed && hit.status === 'done' && hit.done_by === 'engine' && hit.done_at && !hit.m_from_me && hit.m_to_me) {
      const f = await this.followUpSettings(tx);
      const after = Date.parse(iso(hit.m_at)!) - Date.parse(iso(hit.done_at)!);
      if (f.reopenOnFollowUp && after > 0 && after <= f.windowDays * DAY) followUpBy = hit.author?.trim() || 'the asker';
    }
    return { id: hit.id, status: hit.status, closed, followUpBy };
  }

  protected async addDeliverable(tx: Tx, workItemId: string, title: string, input: ProposeItemInput, extractorId: string, firstSource: string) {
    const fileId = input.expected?.fileId;
    let assetId: string | null = null;
    if (fileId) {
      await tx.execute(sql`
        insert into assets (owner_user_id, system, external_id, kind, tracking_tier)
        values (${this.userId}, 'drive', ${fileId}, 'other', 'watched')
        on conflict (owner_user_id, system, external_id) do nothing`);
      assetId = (await tx.execute<{ id: string }>(sql`
        select id from assets where owner_user_id = ${this.userId} and system = 'drive' and external_id = ${fileId}`)).rows[0]!.id;
    }
    const d = await tx.execute<{ id: string }>(sql`
      insert into work_item_deliverables (work_item_id, asset_id, asset_hint, kind, baseline_at, status)
      values (${workItemId}, ${assetId}, ${assetId ? null : title}, 'other', ${this.now().toISOString()}::timestamptz,
              ${assetId ? 'not_started' : 'file_unresolved'})
      returning id`);
    const changes = (input.expected?.changes ?? []).filter((c) => c.trim()).slice(0, 30);
    for (let i = 0; i < changes.length; i++) {
      await tx.execute(sql`
        insert into deliverable_requirements (deliverable_id, ordinal, description, requested_by_source_item_id, extractor_id)
        values (${d.rows[0]!.id}, ${i}, ${redact(changes[i]!).text.slice(0, 500)}, ${firstSource}, ${extractorId})`);
    }
  }

  async proposeInitiative(
    runId: string,
    input: { title: string; purpose: string; accountId?: string; oppId?: string; workItemIds: string[] },
  ): Promise<{ initiativeId: string }> {
    const run = await this.run(runId);
    if (!input.title?.trim()) throw new RangeError('proposeInitiative: title is required');
    const norm = input.title.trim().toLowerCase();
    const key = `initiative:${hashKey(`${norm}|${[...input.workItemIds].sort().join(',')}`)}`;
    const title = redact(input.title.trim()).text.slice(0, 200);
    const purpose = redact((input.purpose ?? '').trim()).text.slice(0, 1000);
    return this.cs(run.scope.connector, `propose initiative: ${title.slice(0, 80)}`, async (tx) => {
      await this.mustRunning(tx, runId);
      for (const id of input.workItemIds) await this.mustWork(tx, id);
      const ex = await tx.execute<{ id: string }>(sql`
        select i.id from initiatives i
         where i.owner_user_id = ${this.userId} and lower(btrim(i.title)) = ${norm}
           and exists (select 1 from change_sets c where c.entity_type = 'initiatives' and c.entity_id = i.id::text
                          and c.editor_session_id = ${key} and c.undone_at is null)
         limit 1`);
      if (ex.rows[0]) return { initiativeId: ex.rows[0].id };
      const ins = await tx.execute<{ id: string }>(sql`
        insert into initiatives (owner_user_id, title, purpose, status, account_id, opportunity_id, created_by, confidence)
        values (${this.userId}, ${title}, ${purpose}, 'proposed',
                (select id from accounts where owner_user_id = ${this.userId} and (id::text = ${input.accountId ?? ''} or org62_account_id = ${input.accountId ?? ''}) limit 1),
                (select id from opportunities where owner_user_id = ${this.userId} and (id::text = ${input.oppId ?? ''} or org62_opportunity_id = ${input.oppId ?? ''}) limit 1),
                'connector', 0.6)
        returning id`);
      const initiativeId = ins.rows[0]!.id;
      await tx.execute(sql`
        update change_sets set entity_type = 'initiatives', entity_id = ${initiativeId}, editor_session_id = ${key}
         where id = nullif(current_setting('cc.change_set_id', true), '')::uuid`);
      for (const wid of [...new Set(input.workItemIds)]) {
        const cur = await tx.execute<{ initiative_id: string | null }>(sql`select initiative_id from work_items where id = ${wid}`);
        if (cur.rows[0]?.initiative_id) continue; // never move an item between initiatives silently
        await engineUpdate(tx, workItems, wid, { initiativeId }, { reason: `grouped under initiative "${title}"` });
      }
      return { initiativeId };
    });
  }

  async flagUnlinked(runId: string, input: { sourceItemId: string; reason: string; hints?: string[] }): Promise<void> {
    const run = await this.run(runId);
    const reason = redact(input.reason ?? '').text.split('\n')[0]!.slice(0, 300);
    const hints = (input.hints ?? []).map((h) => redact(h).text.slice(0, 120)).slice(0, 20);
    await this.cs(
      run.scope.connector,
      'flag unlinked source item',
      async (tx) => {
        await this.mustRunning(tx, runId);
        await this.mustSources(tx, [input.sourceItemId]);
        // One row per (source item, run). The run's FIRST flag decides whether it counts as an attempt (S6);
        // a repeat in the same run only refreshes the reason and merges hints.
        const prev = await tx.execute<{ id: string; detail: string | null }>(sql`
          select id, detail from reconcile_findings
           where source_item_id = ${input.sourceItemId} and scan_run_id = ${runId} and kind = 'unlinked_item' for update`);
        if (prev.rows[0]) {
          const d = parseFinding(prev.rows[0].detail);
          const next: FindingDetail = { ...d, reason, hints: [...new Set([...d.hints, ...hints])].slice(0, 20) };
          await tx.execute(sql`update reconcile_findings set detail = ${JSON.stringify(next)}, status = 'open', updated_at = now() where id = ${prev.rows[0].id}`);
        } else {
          const detail: FindingDetail = { reason, hints, counts: !reason.startsWith('deferred:') };
          await tx.execute(sql`
            insert into reconcile_findings (owner_user_id, connector_id, scan_run_id, kind, scope, source_item_id, detail)
            values (${this.userId}, ${run.connectorId}, ${runId}, 'unlinked_item', ${scopeId(run.scope)}, ${input.sourceItemId}, ${JSON.stringify(detail)})`);
        }
      },
      false,
    );
    trace(runId, 'unlinked', { reason, hints: hints.length }, { sourceItemId: input.sourceItemId });
  }

  async reportCoverage(runId: string, objects: CoverageObject[]): Promise<void> {
    const run = await this.run(runId);
    await this.mustRunning(this.db, runId, false);
    for (const o of objects) {
      if (!o?.kind || !o.ref) throw new RangeError('reportCoverage: kind and ref are required');
      if (!LEDGER_KIND[o.kind]) throw new RangeError(`reportCoverage: unknown kind ${String(o.kind)}`);
    }
    run.staged.push(...objects.map((o) => ({ ...o })));
    // ORG-7: what a coverage object covered beyond its window (Q2's account count) shows in the trace.
    const notes = objects.filter((o) => o.meta && (o.meta as Record<string, unknown>).accounts != null).map((o) => `${o.ref}:accounts=${String((o.meta as Record<string, unknown>).accounts)}`);
    trace(runId, 'coverage', () => ({ n: objects.length, kinds: [...new Set(objects.map((o) => o.kind))], refs: objects.slice(0, 20).map((o) => `${o.kind}:${o.ref}${o.from ? `@${o.from}` : ''}${o.to ? `→${o.to}` : ''}`), ...(notes.length ? { notes } : {}) }));
  }

  async recordBriefHighlights(runId: string, input: BriefHighlightsInput): Promise<{ briefId: string }> {
    const run = await this.run(runId);
    if (!(toMs(input.period.to)! > toMs(input.period.from)!)) throw new RangeError('recordBriefHighlights: period.to must be after period.from');
    const extractorId = await this.extractorId(run.scope.connector, run.skillVersion, run.model);
    return this.cs(run.scope.connector, `brief for ${input.subscription.kind}:${input.subscription.ref}`, async (tx) => {
      await this.mustRunning(tx, runId);
      const srcIds = [...new Set(input.highlights.flatMap((h) => h.sourceItemIds))];
      await this.mustSources(tx, srcIds);
      const subId = await this.ensureSubscription(tx, input.subscription);
      const b = await tx.execute<{ id: string }>(sql`
        insert into briefs (owner_user_id, subscription_id, period_start, period_end, status, summary, source_item_count,
                            highlight_count, nothing_new, model, model_tier, generated_at)
        values (${this.userId}, ${subId}, ${isoMs(toMs(input.period.from)!)}::timestamptz, ${isoMs(toMs(input.period.to)!)}::timestamptz, 'ready',
                ${redact(input.summary ?? '').text}, ${srcIds.length}, ${Math.min(input.highlights.length, 32000)}, ${input.highlights.length === 0},
                ${run.model ?? null}, ${modelTierOf(run.model) === 'none' ? 'haiku' : modelTierOf(run.model)}, ${this.now().toISOString()}::timestamptz)
        on conflict (subscription_id, period_start, period_end) do update set
               summary = excluded.summary, status = 'ready', source_item_count = excluded.source_item_count,
               highlight_count = excluded.highlight_count, nothing_new = excluded.nothing_new, generated_at = excluded.generated_at
        returning id`);
      const briefId = b.rows[0]!.id;
      await tx.execute(sql`delete from brief_highlights where brief_id = ${briefId}`);
      for (let i = 0; i < input.highlights.length; i++) {
        const h = input.highlights[i]!;
        const hTitle = redact(h.title).text.slice(0, 300);
        const topic = h.sourceItemIds[0] ? `source:${h.sourceItemIds[0]}` : `title:${hTitle.toLowerCase().slice(0, 80)}`;
        const hi = await tx.execute<{ id: string }>(sql`
          insert into brief_highlights (owner_user_id, brief_id, ordinal, title, body, relevance_score, level, topic_key, extractor_id)
          values (${this.userId}, ${briefId}, ${i}, ${hTitle}, ${`Suggested: ${h.suggestedAction}`}, ${RELEVANCE_NUM[h.relevance] ?? 0.3},
                  ${RELEVANCE_LEVEL[h.relevance] ?? 'fyi'}, ${topic}, ${extractorId})
          returning id`);
        const hid = hi.rows[0]!.id;
        for (const [j, r] of [...new Set(h.reasons)].slice(0, 10).entries()) {
          const text = redact(r).text.slice(0, 300);
          await tx.execute(sql`
            insert into brief_highlight_reasons (highlight_id, kind, feature_key, weight, explanation)
            values (${hid}, 'keyword', ${`reason:${j}:${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`}, ${1}, ${text})
            on conflict (highlight_id, feature_key) do nothing`);
        }
        for (const sid of new Set(h.sourceItemIds)) {
          await tx.execute(sql`
            insert into provenance_links (source_item_id, brief_highlight_id, role, extractor_id)
            values (${sid}, ${hid}, 'basis', ${extractorId}) on conflict do nothing`);
        }
      }
      for (const sid of srcIds) {
        await tx.execute(sql`
          insert into provenance_links (source_item_id, brief_id, role, extractor_id)
          values (${sid}, ${briefId}, 'context', ${extractorId}) on conflict do nothing`);
      }
      await tx.execute(sql`insert into brief_scan_runs (brief_id, scan_run_id) values (${briefId}, ${runId}) on conflict do nothing`);
      await tx.execute(sql`
        update watch_subscriptions set last_period_end = greatest(coalesce(last_period_end, '-infinity'), ${isoMs(toMs(input.period.to)!)}::timestamptz),
               last_brief_id = ${briefId}
         where id = ${subId}`);
      return { briefId };
    });
  }

  protected async ensureSubscription(tx: Tx, sub: BriefHighlightsInput['subscription']): Promise<string> {
    const ref = sub.ref.trim();
    if (!ref) throw new RangeError('subscription ref is required');
    const one = async (q: SQL) => (await tx.execute<{ id: string }>(q)).rows[0]?.id;
    let scopeKind: 'channel' | 'opportunity' | 'account' | 'person' | 'search_query';
    let col: SQL;
    let target: string;
    switch (sub.kind) {
      case 'channel':
        scopeKind = 'channel';
        col = sql`channel_id`;
        await tx.execute(sql`
          insert into channels (owner_user_id, system, external_id, kind, watch_mode)
          values (${this.userId}, 'slack', ${ref}, 'public', 'digest')
          on conflict (owner_user_id, system, external_id) do nothing`);
        target = (await one(sql`select id from channels where owner_user_id = ${this.userId} and system = 'slack' and external_id = ${ref}`))!;
        break;
      case 'opp':
        scopeKind = 'opportunity';
        col = sql`opportunity_id`;
        target =
          (await one(sql`select id from opportunities where owner_user_id = ${this.userId} and (id::text = ${ref} or org62_opportunity_id = ${ref}) limit 1`)) ??
          (await one(sql`insert into opportunities (owner_user_id, org62_opportunity_id, name) values (${this.userId}, ${ref}, ${ref})
                         on conflict (owner_user_id, org62_opportunity_id) do update set name = opportunities.name returning id`))!;
        break;
      case 'account':
        scopeKind = 'account';
        col = sql`account_id`;
        target =
          (await one(sql`select id from accounts where owner_user_id = ${this.userId}
                           and (id::text = ${ref} or org62_account_id = ${ref} or lower(name) = lower(${ref})) limit 1`)) ??
          (await one(sql`insert into accounts (owner_user_id, name, org62_account_id)
                         values (${this.userId}, ${ref}, ${/^001[A-Za-z0-9]{12,15}$/.test(ref) ? ref : null}) returning id`))!;
        break;
      case 'person':
        scopeKind = 'person';
        col = sql`person_id`;
        target =
          (await one(sql`select id from people where owner_user_id = ${this.userId} and (id::text = ${ref} or lower(primary_email) = lower(${ref})) limit 1`)) ??
          (await one(sql`insert into people (owner_user_id, display_name, primary_email)
                         values (${this.userId}, ${ref}, ${ref.includes('@') ? ref.toLowerCase() : null}) returning id`))!;
        break;
      case 'search':
        scopeKind = 'search_query';
        col = sql`search_query`;
        target = ref;
        break;
      default:
        throw new RangeError(`unknown subscription kind ${String((sub as { kind: string }).kind)}`);
    }
    const existing = await one(sql`
      select id from watch_subscriptions where owner_user_id = ${this.userId} and scope_kind = ${scopeKind} and ${col} = ${target}`);
    if (existing) return existing;
    return (await one(sql`
      insert into watch_subscriptions (owner_user_id, scope_kind, ${col}, label)
      values (${this.userId}, ${scopeKind}, ${target}, ${`${sub.kind}: ${ref}`.slice(0, 120)})
      returning id`))!;
  }
}
