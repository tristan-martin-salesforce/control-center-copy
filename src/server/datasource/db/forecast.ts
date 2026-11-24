/**
 * Time ▸ Forecast on Postgres (lane A): the `specialist_forecasts` mirror the worker's `forecast.sync` writes, the same
 * view, edits and canvas as the mock (src/server/forecast/service.ts), and draft runs queued for the worker
 * (`forecast.draft`, $0.25 cap each, within what is left under today's hard cap). The canvas is one Outbox item,
 * applied on Time (D-52); nothing here calls Org62.
 */
import { sql } from 'drizzle-orm';

import { budgetsForDay, type Draft, type ForecastPayload, type ForecastRecordDetail, type ForecastRow, type PatchForecastRequest, type RouteInput, type RouteOutput } from '@/contract';
import type { Db } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { buildForecastView, CHECK_FOLLOW_UP_MS, DRAFT_CAP_USD, withForecast } from '@/engines/forecast/view';
import { localDay } from '@/engines/activity/time';
import { personaOf } from '@/personas';
import { draftTargets, patchedPending, stagePlan } from '@/server/forecast/service';
import { FORECAST_CHECK_SCOPE, FORECAST_DRAFT_JOB, FORECAST_QUEUE, FORECAST_SYNC_JOB, forecastCheckDedupeKey, forecastChecks, forecastDraftDedupeKey, forecastFollowUpDedupeKey, forecastSyncState, loadForecastRecord, loadForecastRecords, ownerOrg62Of, runningDraftIds, savePending } from '@/server/forecast/store';
import { invalid, notFound } from '@/server/errors';
import { actionDraftFor } from '@/server/vdp/coverage';
import type { ReadModel } from './model';

export interface DbForecastHost {
  db: Db;
  now(): Date;
  userId(): Promise<string>;
  model(): Promise<ReadModel>;
  /** One audited change set: insert the canvas item. */
  insertDraft(draft: Draft, summary: string): Promise<{ auditId: string }>;
  rendered(dest: Draft['destination'], doc: Draft['doc']): Draft['rendered'];
  /** Invalidate Time and Home (the table is unaudited). */
  publish(ids: string[], reason: string): void;
}

export class DbForecast {
  constructor(private readonly host: DbForecastHost) {}

  /** What is left under today's hard cap (every line counts), for "Draft all". */
  private async dayLeftUsd(m: ReadModel, userId: string): Promise<number> {
    const s = m.settings();
    const day = localDay(this.host.now().getTime(), s.profile.timezone || 'UTC');
    const hard = budgetsForDay(s.budgets, day).hardUsd;
    const r = await this.host.db.execute<{ total: string | null }>(sql`select coalesce(sum(cost_usd), 0) as total from llm_calls where owner_user_id = ${userId} and budget_day = ${day}::date and budget = 'daily'`);
    return Math.max(0, hard - Number(r.rows[0]?.total ?? 0));
  }

  /** Home ▸ Log & fix input (the same records the Time view reads). */
  async homeInput(m: ReadModel): Promise<{ records: Awaited<ReturnType<typeof loadForecastRecords>>; sync: ForecastPayload['sync']; mode: 'live' }> {
    const userId = m.ctx.userId;
    const [records, sync] = await Promise.all([loadForecastRecords(this.host.db, userId), forecastSyncState(this.host.db, userId)]);
    return { records, sync, mode: 'live' };
  }

  /** `all`: the rows even when the feature is not active (the details panel). */
  async view(m?: ReadModel, all = false): Promise<ForecastPayload> {
    const model = m ?? (await this.host.model());
    const userId = model.ctx.userId;
    const s = model.settings();
    const [records, sync, drafting, left, checks] = await Promise.all([loadForecastRecords(this.host.db, userId), forecastSyncState(this.host.db, userId), runningDraftIds(this.host.db, userId), this.dayLeftUsd(model, userId), forecastChecks(this.host.db, userId)]);
    return buildForecastView({
      now: this.host.now().toISOString(),
      timezone: s.profile.timezone || model.meta().timezone,
      persona: all ? withForecast(personaOf(s)) : personaOf(s),
      mode: 'live',
      records,
      opps: model.all('opps'),
      accounts: model.all('accounts'),
      drafts: model.all('drafts'),
      sync,
      drafting,
      perDraftUsd: DRAFT_CAP_USD,
      dayLeftUsd: left,
      checks,
    });
  }

  private active(v: ForecastPayload) {
    if (!v.active) throw invalid('Specialist Forecast is not active for your role: activate it in Settings ▸ Role & rules');
  }

  private rowIn(v: ForecastPayload, id: string): ForecastRow {
    const row = v.rows.find((r) => r.id === id);
    if (!row) throw notFound('Specialist Forecast', id);
    return row;
  }

  /** One record (a read: answers whether or not the feature is active, like any mirror read). */
  async detail(id: string): Promise<ForecastRecordDetail> {
    const m = await this.host.model();
    const v = await this.view(m, true);
    const rec = await loadForecastRecord(this.host.db, m.ctx.userId, id);
    if (!rec) throw notFound('Specialist Forecast', id);
    const row = this.rowIn(v, id);
    const opp = rec.opportunityId ? m.get('opps', rec.opportunityId) : undefined;
    const nowIso = this.host.now().toISOString();
    const since = rec.notesUpdatedAt ?? new Date(this.host.now().getTime() - 14 * 86_400_000).toISOString();
    const meetingsSince = rec.accountId
      ? m
          .all('events')
          .filter((e) => e.accountId === rec.accountId && e.start >= since && e.start <= nowIso)
          .sort((a, b) => b.start.localeCompare(a.start) || a.id.localeCompare(b.id))
          .map((e) => ({ id: e.id, title: e.title, start: e.start }))
      : [];
    return { row, record: rec, opportunity: opp ? { id: opp.id, name: opp.name, stage: opp.stage, nextStep: opp.nextStep, products: opp.products, url: opp.org62Url } : null, meetingsSince, thresholds: v.thresholds };
  }

  /** Sync now: one `forecast.sync` job (a queued one absorbs repeats). */
  async sync(): Promise<RouteOutput<'syncForecast'>> {
    const m = await this.host.model();
    this.active(await this.view(m));
    const r = await enqueueJob(this.host.db, { ownerUserId: m.ctx.userId, kind: FORECAST_SYNC_JOB, queue: FORECAST_QUEUE, dedupeKey: FORECAST_SYNC_JOB, payload: { trigger: 'manual' }, maxAttempts: 2, timeoutSeconds: 900 });
    this.host.publish([], 'forecast.sync.queued');
    return { entity: { queued: r.inserted, note: r.inserted ? 'Reading your Specialist Forecasts from Org62 (read-only)…' : 'A read is already queued' }, auditId: null };
  }

  /** Draft one note, or Draft all: one worker job per record, $0.25 cap each, within what is left today. */
  async draft(i: RouteInput<'draftForecastNotes'>): Promise<RouteOutput<'draftForecastNotes'>> {
    const m = await this.host.model();
    const v = await this.view(m);
    this.active(v);
    const { targets, skipped } = draftTargets(v, i.body.ids);
    let left = v.drafting.dayLeftUsd;
    const queued: string[] = [];
    for (const id of targets) {
      if (left < DRAFT_CAP_USD) {
        skipped.push({ id, why: "today's budget is used up: raise it in Settings ▸ Budgets" });
        continue;
      }
      const r = await enqueueJob(this.host.db, { ownerUserId: m.ctx.userId, kind: FORECAST_DRAFT_JOB, queue: FORECAST_QUEUE, dedupeKey: forecastDraftDedupeKey(id), payload: { recordId: id, cap_usd: DRAFT_CAP_USD }, maxAttempts: 1, timeoutSeconds: 300 });
      if (r.inserted) {
        queued.push(id);
        left -= DRAFT_CAP_USD;
      } else skipped.push({ id, why: 'already drafting' });
    }
    if (queued.length) this.host.publish(queued, 'forecast.draft.queued');
    return { entity: { queued, drafted: [], skipped, capUsd: Math.round(queued.length * DRAFT_CAP_USD * 100) / 100 }, auditId: null };
  }

  async patch(id: string, body: PatchForecastRequest): Promise<RouteOutput<'patchForecast'>> {
    const m = await this.host.model();
    const v = await this.view(m);
    this.active(v);
    const rec = await loadForecastRecord(this.host.db, m.ctx.userId, id);
    if (!rec) throw notFound('Specialist Forecast', id);
    const pending = patchedPending(rec, this.rowIn(v, id), body, this.host.now().toISOString());
    await savePending(this.host.db, m.ctx.userId, id, pending);
    this.host.publish([id], 'forecast.patch');
    return { entity: this.rowIn(await this.view(), id), auditId: null };
  }

  /**
   * "I created it, check now" on an opp with no Specialist Forecast: ONE read-only re-read of that opp's records, a
   * `forecast.sync` job (scope `opp`) the worker runs (nothing here calls Org62), and a full read CHECK_FOLLOW_UP_MS
   * later (the mirror otherwise reads once a day), so a record created just after the click still shows up today.
   */
  async checkMissing(opportunityId: string): Promise<RouteOutput<'checkMissingForecast'>> {
    const m = await this.host.model();
    const v = await this.view(m);
    this.active(v);
    const nowIso = this.host.now().toISOString();
    const done = v.found.find((f) => f.opportunityId === opportunityId);
    if (done) return { entity: { queued: false, note: 'Already found: its Specialist Forecast is in your list', check: done, followUpAt: v.sync.nextAt }, auditId: null };
    const miss = v.queue.missing.find((x) => x.opportunityId === opportunityId);
    if (!miss) throw invalid('This opportunity is not missing a Specialist Forecast (or is no longer one of yours this or next quarter)');
    const userId = m.ctx.userId;
    const r = await enqueueJob(this.host.db, { ownerUserId: userId, kind: FORECAST_SYNC_JOB, queue: FORECAST_QUEUE, dedupeKey: forecastCheckDedupeKey(opportunityId), payload: { scope: FORECAST_CHECK_SCOPE, opportunityId, trigger: 'missing_check' }, maxAttempts: 2, timeoutSeconds: 300 });
    // the database's clock schedules it, as the sync state reads it (run_at > now())
    const followUpAt = new Date(this.host.now().getTime() + CHECK_FOLLOW_UP_MS);
    await enqueueJob(this.host.db, { ownerUserId: userId, kind: FORECAST_SYNC_JOB, queue: FORECAST_QUEUE, dedupeKey: forecastFollowUpDedupeKey(userId), payload: { trigger: 'missing_check_followup' }, delaySeconds: CHECK_FOLLOW_UP_MS / 1000, maxAttempts: 2, timeoutSeconds: 900 });
    this.host.publish([], 'forecast.check.queued');
    return {
      entity: {
        queued: r.inserted,
        note: r.inserted ? 'Checking Org62 for its Specialist Forecast (read-only)…' : 'A check is already queued',
        check: { opportunityId, opportunityName: miss.opportunityName, status: 'checking', at: nowIso, note: null, recordId: null },
        followUpAt: followUpAt.toISOString(),
      },
      auditId: null,
    };
  }

  /** "Stage N notes": the approved updates not held by a waiting canvas → ONE Outbox canvas item. */
  async stage(i: RouteInput<'stageForecast'>): Promise<RouteOutput<'stageForecast'>> {
    const m = await this.host.model();
    const v = await this.view(m);
    this.active(v);
    const owner = await ownerOrg62Of(this.host.db, m.ctx.userId);
    const nowIso = this.host.now().toISOString();
    const plan = stagePlan(v, { ownerName: owner?.name ?? 'me', ownerOrg62Id: owner?.org62Id ?? '', nowIso, sourceLabel: 'Command Center · forecast notes', ...(i.body.ids ? { ids: i.body.ids } : {}) });
    if (!plan.destination) {
      if (plan.deferred.length) throw invalid('These notes are too long for one canvas: shorten them, then try again');
      return { entity: { draftId: null, title: null, notes: 0, roles: 0, waiting: plan.waiting, deferred: plan.deferred }, auditId: null };
    }
    if (!owner) throw invalid('Your Org62 user id is not set, so Slackbot would not know whose records to update (onboarding ▸ Sources)');
    const dest = plan.destination;
    const draft = actionDraftFor(dest, { id: crypto.randomUUID(), now: nowIso, rendered: (doc) => this.host.rendered(dest, doc) });
    const r = await this.host.insertDraft(draft, `Specialist Forecast canvas for approval: ${plan.title}`);
    return { entity: { draftId: draft.id, title: plan.title, notes: plan.notes, roles: plan.roles, waiting: plan.waiting, deferred: plan.deferred }, auditId: r.auditId };
  }
}
