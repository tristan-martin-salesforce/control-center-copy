/**
 * The db DataSource, time domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res } from '../shared';
import { and, eq, sql } from 'drizzle-orm';
import type { ActivityEntry, OppOption, TimeWeek } from '@/contract';
import { localDay as localDayOf } from '@/engines/activity/time';
import type { Tx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { accounts as accountsTable, activityEntries, changeSets, opportunities as opportunitiesTable } from '@/db/schema';
import { featureActive, personaOf } from '@/personas';
import { AppError, invalid, notFound } from '@/server/errors';
import { PgRuntimeJobQueue } from '@/jobs/runtime-queue';
import { scanJob } from '@/scanner/runtime/jobs';
import { ORG62_READBACK_SCOPE } from '@/scanner/scope-catalog';
import { ORG62_READBACK_JOB, ORG62_READBACK_QUEUE } from '@/jobs/handlers/org62-readback';
import { CANVAS_CHECKS_KV, canvasChecksOf, planRecheck, recheckWindow, slotOf, type Org62Reads } from '@/lib/canvas/checks';
import { buildOppOptions } from '@/lib/opp-options';
import { rowsForModel, SUGGEST_LOOKBACK_DAYS, wantsSuggestion, withSuggestions, type StoredSuggestion, type SuggestContext } from '@/lib/time-suggest';
import { org62AccountHit, org62OppHit, type Org62Row } from '@/server/chat/org62';
import type { ReadModel } from '../model';
import { activityScope } from '../reads/scope';
import { contextOf } from '../attribution';
import { writeKv, type WriteCtx } from '../store/common';
import { addTripOverride, applyOnsiteCorrection, daysBetween, ONSITE_OVERRIDES_KEY, onsiteDaysIn, readOnsiteOverrides } from '../store/onsite';
import { updateDraft } from '../store/nba';
import { writeMeta } from '../store/settings';
import { canvasHolds, markCanvasHolds } from '@/lib/canvas/payload';
import { loggingProfile, withPersonaTarget } from '@/engines/activity/persona';
import { loadUseCaseSync } from '../store/use-cases';
import { loadDcRequests } from '../store/dc-requests';
import { readTimeDismissRules, TIME_DISMISS_RULES_KEY, withRule } from '../store/time-rules';
import { patchedEntry, targetPatch, planDismissFromSource, planRemoveRule, rulesView } from '@/server/time/dismiss';
import { updateActivity } from '../store/time';
import { recomputeWeeks } from '@/projections/run';
import { dbPreflightContextFor } from '../store/canvas-preflight';
import { isPendingLogCanvas, preflightDraft } from '@/server/time/canvas-preflight';
import { resolvedEntry, resolvedSummary } from '@/server/time/relog';
import { buildActivityLog } from '../../activity-log';
import { logCanvasesOf } from '../../log-canvases';
import { fmtHM } from '../views';
import { oppOptionsView, timeLedgerView, timeWeekView } from '@/server/views/time';
import { projectionStore } from '../store/projections.run';

/** The Org62 id and name an onsite trip logs to: the chosen opp, else the account's default opp (the engine's), else the account. */
async function onsiteWhat(tx: Tx, userId: string, accountId: string, oppId: string | null | undefined): Promise<{ whatId: string | null; whatName: string | null } | null> {
  const [a] = await tx.select({ name: accountsTable.name, org62: accountsTable.org62AccountId }).from(accountsTable).where(and(eq(accountsTable.ownerUserId, userId), eq(accountsTable.id, accountId)));
  if (!a) return null;
  if (oppId) {
    const [o] = await tx.select({ name: opportunitiesTable.name, org62: opportunitiesTable.org62OpportunityId }).from(opportunitiesTable).where(and(eq(opportunitiesTable.ownerUserId, userId), eq(opportunitiesTable.id, oppId)));
    if (o?.org62) return { whatId: o.org62, whatName: o.name };
  }
  // null: the engine picks the account's default opp (Matcher.mappings), like any meeting of the account
  return oppId === undefined ? { whatId: null, whatName: null } : { whatId: a.org62 ?? null, whatName: a.name };
}

export class DbTime {
  constructor(private readonly ctx: DbCtx) {}

  async getTime({ query }: I<'getTime'>): Promise<Res<'getTime'>> {
    return this.ctx.read(activityScope('log'), async (m) => {
      await this.ctx.ds.attribution.ensureExtras(m);
      return this.withCanvasProgress(m, this.buildTime(m, query.week));
    });
  }

  /**
   * 2026-11-13 audit C4: each created canvas's own progress (Events, DCs and use cases in Org62, when it was checked,
   * the next re-check). Loads the DC requests and the use cases only when a created canvas carries them.
   */
  private async withCanvasProgress(m: ReadModel, t: TimeWeek): Promise<TimeWeek> {
    const created = t.logCanvases.filter((c) => c.state === 'applied' || c.state === 'verified' || c.state === 'unverified');
    if (!created.length) return t;
    const userId = m.ctx.userId;
    const persona = personaOf(m.settings());
    const [dcRequests, uc, reads] = await Promise.all([
      created.some((c) => c.dcs > 0) && featureActive(persona, 'dealContributions') ? loadDcRequests(this.ctx.db, userId) : Promise.resolve([]),
      created.some((c) => c.useCases > 0) && featureActive(persona, 'vdp') ? loadUseCaseSync(this.ctx.db, userId) : Promise.resolve(null),
      this.org62Reads(userId),
    ]);
    const logCanvases = logCanvasesOf(m.all('drafts'), m.all('activity'), this.ctx.now(), { dcRequests, useCases: uc?.items ?? [], checks: canvasChecksOf(m.ctx.kv.get(CANVAS_CHECKS_KV)), reads });
    return { ...t, logCanvases };
  }

  /** The latest successful Org62 read of each kind a canvas needs (scan_runs): Events, DCs, the use-case read-back. */
  private async org62Reads(userId: string): Promise<Org62Reads> {
    const r = await this.ctx.db.execute<{ scope: string; at: Date | string | null }>(sql`
      select scope, max(finished_at) as at from scan_runs
       where owner_user_id = ${userId} and status = 'succeeded' and scope in ('org62:events', 'org62:dcs', ${`org62:${ORG62_READBACK_SCOPE}`})
       group by scope`);
    const at = (scope: string) => {
      const v = r.rows.find((x) => x.scope === scope)?.at;
      return v ? new Date(v).toISOString() : null;
    };
    return { events: at('org62:events'), dcs: at('org62:dcs'), useCases: at(`org62:${ORG62_READBACK_SCOPE}`) };
  }

  /**
   * POST /time/canvases/:id/org62-check (2026-11-13 audit C4): a created logging canvas, read back from Org62 sooner
   * than the scan cadence. `copied` (its Slackbot prompt was just copied) queues checks about 5, 15, 30 and 60 min later;
   * `now` (Slackbot's done) one at once. Each check is the Org62 `events` and `dcs` scans (manual, read only, through
   * the same queue Health's Rescan uses), plus the use-case read-back when use cases ride on it; deduped per minute
   * slot, so two canvases told together share their reads. Nothing external is written. Not undoable (a queue entry).
   */
  async checkCanvasOrg62({ params, body }: I<'checkCanvasOrg62'>): Promise<Res<'checkCanvasOrg62'>> {
    const m0 = await this.ctx.model(WHOLE);
    const c = this.buildTime(m0).logCanvases.find((x) => x.draftId === params.id);
    if (!c) throw notFound('Logging canvas', params.id);
    if (c.state !== 'applied' && c.state !== 'verified' && c.state !== 'unverified') throw invalid('This canvas is not in Slack yet: Apply it first, then tell Slackbot');
    const org62 = m0.all('connectors').find((x) => x.source === 'org62');
    if (!org62) return { draftId: c.draftId, queued: [], nextCheckAt: null, note: 'No Org62 connector here: nothing to read' };
    if (org62.state === 'auth_needed') return { draftId: c.draftId, queued: [], nextCheckAt: null, note: 'Org62 needs re-auth (Health ▸ Org62) before the app can read it back' };
    const now = this.ctx.now();
    const plan = planRecheck(canvasChecksOf(m0.ctx.kv.get(CANVAS_CHECKS_KV)), c.draftId, body.reason, now);
    const queued: Res<'checkCanvasOrg62'>['queued'] = [];
    const persona = personaOf(m0.settings());
    const withUc = c.useCases > 0 && featureActive(persona, 'vdp');
    const withDcs = c.dcs > 0 && featureActive(persona, 'dealContributions');
    await this.ctx.mutate({ action: 'time.canvas.check', summary: `Check Org62 for ${c.title}`.slice(0, 200), entity: { type: 'draft', id: c.draftId }, undoable: false }, async (w) => {
      await writeKv(w, CANVAS_CHECKS_KV, plan.next);
      const q = new PgRuntimeJobQueue(this.ctx.db, w.userId);
      for (const at of plan.slots) {
        const window = recheckWindow(at, c.appliedAt);
        const reads: Array<'events' | 'dcs'> = c.rows > 0 || !withDcs ? ['events'] : [];
        if (withDcs) reads.push('dcs');
        await q.enqueue(reads.map((scope) => scanJob({ connector: 'org62', scope, window, mode: 'manual', trigger: 'manual', runAt: at, dedupeKey: `org62-recheck:${scope}:${slotOf(at)}` })), w.tx);
        for (const r of reads) queued.push({ read: r, at });
        if (withUc) {
          await enqueueJob(w.tx, { ownerUserId: w.userId, kind: ORG62_READBACK_JOB, queue: ORG62_READBACK_QUEUE, payload: { trigger: 'manual' }, dedupeKey: `org62.readback:${w.userId}:recheck:${slotOf(at)}`, runAt: new Date(at), maxAttempts: 3, timeoutSeconds: 900 });
          queued.push({ read: 'use_cases', at });
        }
      }
    });
    this.ctx.bus.publishTables(['jobs', 'user_settings'], [c.draftId], `time.canvas.check.${body.reason}`);
    const nextCheckAt = plan.next[c.draftId]?.at.find((x) => Date.parse(x) > now.getTime() - 60_000) ?? null;
    return { draftId: c.draftId, queued, nextCheckAt, note: null };
  }

  async getActivityLog({ query = {} }: I<'getActivityLog'>): Promise<Res<'getActivityLog'>> {
    return this.ctx.read(activityScope('rows'), (m) => this.activityLogOf(m, query));
  }

  private async activityLogOf(m: ReadModel, query: NonNullable<I<'getActivityLog'>['query']>): Promise<Res<'getActivityLog'>> {
    await this.ctx.ds.attribution.ensureExtras(m);
    const { timezone, workingHours } = m.settings().profile;
    return buildActivityLog(this.suggested(m, markCanvasHolds(m.all('activity'), canvasHolds(m.all('drafts')))), query, { meta: withPersonaTarget(m.meta(), personaOf(m.settings())), now: this.ctx.now(), tz: timezone, dayEnd: workingHours.end });
  }

  /** What a row that needs an opp is suggested (src/lib/time-suggest.ts, the mock's twin): the rules, and the model's stored answers. */
  suggestContext(m: ReadModel): SuggestContext {
    // the attribution engine's extras (learned rules, the channel map, engagement, covered AEs): db/attribution.ts
    return contextOf(m, this.ctx.now(), this.ctx.ds.attribution?.cached(m.ctx.userId));
  }

  private suggested(m: ReadModel, entries: ActivityEntry[]): ActivityEntry[] {
    // D-103 (c): every row gets its sentence (groundwork), the suggestion only while it needs an opp
    return withSuggestions(entries, this.suggestContext(m));
  }

  /**
   * `activity.suggest` (src/jobs/handlers/activity-suggest.ts): the rows the model would be asked about now (no rules
   * answer that settles them, no stored answer for their inputs), each with its ranked candidates, from the same read
   * model GET /time reads, so the key of every answer stored is the one the read side looks up. `live`: the ids of every
   * row that still wants a suggestion (stored answers for other rows are dropped). Only rows of the last
   * SUGGEST_LOOKBACK_DAYS are asked about (Needs you shows the quarter and the last 3 weeks): an old held row never
   * costs a call on its own.
   */
  async activitySuggestPending(): Promise<{ rows: Array<{ entry: ActivityEntry; candidates: OppOption[] }>; live: string[]; stored: Record<string, StoredSuggestion>; internalActivity: boolean }> {
    const m = await this.ctx.model(WHOLE);
    await this.ctx.ds.attribution.ensureExtras(m);
    const ctx = this.suggestContext(m);
    const entries = markCanvasHolds(m.all('activity'), canvasHolds(m.all('drafts')));
    const live = entries.filter(wantsSuggestion).map((e) => e.id);
    const since = new Date(Date.parse(`${ctx.today}T12:00:00Z`) - SUGGEST_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const rows = rowsForModel(
      entries.filter((e) => e.date >= since),
      ctx,
    ).map((entry) => ({ entry, candidates: buildOppOptions({ entry, opps: ctx.opps, accounts: ctx.accounts, events: ctx.events, people: ctx.people, assets: ctx.assets, runs: ctx.runs, workItems: ctx.workItems, activity: ctx.activity, today: ctx.today }).opps }));
    return { rows, live, stored: ctx.stored, internalActivity: ctx.internalActivity };
  }

  async getTimeLedger({ query = {} }: I<'getTimeLedger'>): Promise<Res<'getTimeLedger'>> {
    return this.ctx.read(activityScope('ledger'), (m) => timeLedgerView(m, query, this.ctx.now()));
  }

  /** GET /time's week: the shared view (src/server/views/time.ts) with the db's suggestions and stored onsite overrides. */
  private buildTime(m: ReadModel, week?: string): TimeWeek {
    return timeWeekView(m, { suggested: (entries) => this.suggested(m, entries), onsite: (from, to) => onsiteDaysIn(m.ctx.kv, from, to) }, week, this.ctx.now());
  }

  // Onsite days (onsite lane): a correction is one undoable change set on the stored overrides; the week it touches
  // is recomputed right away (an engine change set), and the projections tick recomputes after an Undo.
  async correctOnsiteDay({ params, body }: I<'correctOnsiteDay'>): Promise<Res<'correctOnsiteDay'>> {
    const day = params.day;
    const verb = { confirm: 'Confirmed onsite', not_onsite: 'Marked not onsite', change_account: 'Changed the onsite account', adjust_hours: 'Adjusted the onsite hours', clear: 'Cleared the onsite correction' }[body.action];
    const r = await this.ctx.mutate({ action: `time.onsite.${body.action}`, summary: `${verb}: ${day}`, entity: { type: 'onsite_day', id: day } }, async (w, model) => {
      const cur = onsiteDaysIn(model.ctx.kv, day, day)[0] ?? null;
      const what = body.action === 'change_account' && body.accountId ? await onsiteWhat(w.tx, w.userId, body.accountId, body.oppId) : null;
      if (body.action === 'change_account' && body.accountId && !what) throw notFound('Account', body.accountId);
      let next;
      try {
        next = applyOnsiteCorrection(readOnsiteOverrides(model.ctx.kv), day, body, { current: cur, what: () => what, now: w.now.toISOString() });
      } catch (e) {
        throw invalid(e instanceof Error ? e.message : 'Invalid onsite correction');
      }
      await writeKv(w, ONSITE_OVERRIDES_KEY, next);
    });
    await recomputeWeeks({ store: projectionStore(this.ctx.db), userId: await this.ctx.userId(), days: [day], now: this.ctx.now() });
    this.ctx.bus.publishTables(['activity_entries'], [], 'time.onsite');
    const m = await this.ctx.model(WHOLE);
    return { entity: onsiteDaysIn(m.ctx.kv, day, day)[0] ?? null, auditId: r.auditId };
  }

  async markTrip({ body }: I<'markTrip'>): Promise<Res<'markTrip'>> {
    if (body.to < body.from) throw invalid('The trip ends before it starts');
    const days = daysBetween(body.from, body.to);
    if (days.length > 30) throw invalid('A trip is at most 30 days');
    const r = await this.ctx.mutate({ action: 'time.onsite.trip', summary: `Marked a trip:  to `, entity: { type: 'onsite_day', id: body.from } }, async (w, model) => {
      const what = await onsiteWhat(w.tx, w.userId, body.accountId, body.oppId);
      if (!what) throw notFound('Account', body.accountId);
      void model;
      const next = addTripOverride(readOnsiteOverrides(model.ctx.kv), { from: body.from, to: body.to, accountKey: body.accountId, whatId: what?.whatId ?? null, whatName: what?.whatName ?? null, city: body.city ?? null, timezone: body.timezone ?? null }, w.now.toISOString());
      await writeKv(w, ONSITE_OVERRIDES_KEY, next);
    });
    await recomputeWeeks({ store: projectionStore(this.ctx.db), userId: await this.ctx.userId(), days, now: this.ctx.now() });
    this.ctx.bus.publishTables(['activity_entries'], [], 'time.onsite');
    const m = await this.ctx.model(WHOLE);
    return { entity: onsiteDaysIn(m.ctx.kv, body.from, body.to), auditId: r.auditId };
  }

  async patchActivity({ params, body }: I<'patchActivity'>): Promise<Res<'patchActivity'>> {
    const r = await this.ctx.mutate(
      { action: 'activity.edit', summary: 'Edited log row', entity: { type: 'activity_entry', id: params.id }, burst: true, current: async () => (await this.ctx.model(WHOLE)).get('activity', params.id) ?? null },
      async (w, model) => {
        const cur = model.get('activity', params.id);
        if (!cur) throw notFound('Activity entry', params.id);
        this.ctx.checkVersion(cur, body.ifVersion, 'Activity entry', cur);
        // every edited field is locked except `status` (the pipeline's: lockableActivityFields); D-64: internal-ness
        // (src/server/time/dismiss.ts patchedEntry, the mock's too)
        // D-103 (c): `target` stands for oppId / internal, or the account itself (targetPatch, the mock's too)
        const tp = targetPatch(cur, body.patch);
        const opp = tp.oppId ? model.get('opps', tp.oppId) : undefined;
        const acct = body.patch.target?.kind === 'account' ? model.get('accounts', body.patch.target.id) : undefined;
        const { next, newLocks: newly } = patchedEntry(cur, body.patch, opp ? { name: opp.name, accountName: model.get('accounts', opp.accountId)?.name ?? null } : null, acct ? { id: acct.id, name: acct.name } : null);
        await w.tx.update(changeSets).set({ summary: `Edited log row: ${cur.description}` }).where(eq(changeSets.id, w.cs.id));
        const oppAccount = next.oppId ? (model.get('accounts', model.get('opps', next.oppId)?.accountId ?? '')?.name ?? null) : null;
        await updateActivity(w, model.extra.vocab, cur, next, { bump: true, ifVersion: body.ifVersion, lock: newly }, oppAccount);
        // the attribution engine learns from a picked opp or an Internal (in this change set: Undo reverts it too)
        if (tp.oppId !== undefined || tp.internal) await this.ctx.ds.attribution.learnFromRow(w, model, cur, next);
        // D-65 (TL-25): an edit unstages a row a canvas item holds (it goes on the next canvas, as you have it now)
        await this.unstageEdited(w, model, params.id);
      },
    );
    const m = await this.ctx.model(WHOLE);
    await this.ctx.ds.attribution.ensureExtras(m);
    // the row as GET /time reads it (its suggestion, while it still needs an opp)
    return { entity: this.suggested(m, [m.get('activity', params.id)!])[0]!, auditId: r.auditId };
  }

  /** TL-25: the canvas item holding this row, re-rendered without it (discarded when it was the last row). */
  private async unstageEdited(w: WriteCtx, model: ReadModel, rowId: string): Promise<void> {
    const holder = canvasHolds(model.all('drafts')).rows.get(rowId);
    const d = holder ? model.get('drafts', holder) : null;
    if (!d || !isPendingLogCanvas(d)) return;
    const ctx = await dbPreflightContextFor(w.tx, w.userId, d, { taskTypeRequired: loggingProfile(personaOf(model.settings())).taskTypeRequired, unstage: new Set([rowId]) });
    const out = preflightDraft(d, ctx);
    if (out.next) await updateDraft(w, d, out.next, { bump: true });
  }

  // D-65 (TL-14, TL-20): Log again / Leave out on a row that is not in Org62 after all (src/server/time/relog.ts)
  async resolveActivity({ params, body }: I<'resolveActivity'>): Promise<Res<'resolveActivity'>> {
    const r = await this.ctx.mutate(
      { action: `activity.org62.${body.action}`, summary: 'Resolved a row not in Org62', entity: { type: 'activity_entry', id: params.id }, current: async () => (await this.ctx.model(WHOLE)).get('activity', params.id) ?? null },
      async (w, model) => {
        const cur = model.get('activity', params.id);
        if (!cur) throw notFound('Activity entry', params.id);
        this.ctx.checkVersion(cur, body.ifVersion, 'Activity entry', cur);
        const next = resolvedEntry(cur, body.action);
        await w.tx.update(changeSets).set({ summary: resolvedSummary(cur, body.action) }).where(eq(changeSets.id, w.cs.id));
        const oppAccount = next.oppId ? (model.get('accounts', model.get('opps', next.oppId)?.accountId ?? '')?.name ?? null) : null;
        await updateActivity(w, model.extra.vocab, cur, next, { bump: true, ifVersion: body.ifVersion }, oppAccount);
        // Log again: the old Event link, its verify issue and the canvas stamp go (the next batch takes the row)
        if (body.action === 'log_again') await w.tx.update(activityEntries).set({ org62EventRowId: null, verifyIssue: null, syncedToCanvasAt: null, loggedAt: null, verifiedAt: null }).where(and(eq(activityEntries.id, params.id), eq(activityEntries.ownerUserId, w.userId)));
        else await w.tx.update(activityEntries).set({ verifyIssue: null }).where(and(eq(activityEntries.id, params.id), eq(activityEntries.ownerUserId, w.userId)));
      },
    );
    this.ctx.bus.publishTables(['activity_entries'], [params.id], `activity.org62.${body.action}`);
    const m = await this.ctx.model(WHOLE);
    return { entity: m.get('activity', params.id)!, auditId: r.auditId };
  }

  async getOppOptions({ query = {} }: I<'getOppOptions'>): Promise<Res<'getOppOptions'>> {
    const m = await this.ctx.model(WHOLE);
    const entry = query.entryId ? m.get('activity', query.entryId) : null;
    if (query.entryId && !entry) throw notFound('Activity entry', query.entryId);
    return oppOptionsView(m, entry ?? null, localDayOf(this.ctx.now().getTime(), m.settings().profile.timezone));
  }

  async searchOrg62Opps({ body }: I<'searchOrg62Opps'>): Promise<Res<'searchOrg62Opps'>> {
    const r = await this.ctx.ds.be6.pickerOrg62({ search: body.q });
    // D-103 (c): accounts follow the opps (a hit can set either target)
    return { q: body.q, hits: [...r.rows.map(org62OppHit), ...(r.accounts ?? []).map(org62AccountHit)], notes: r.notes, simulated: !r.live, costUsd: r.costUsd ?? 0 };
  }

  /**
   * An Org62 hit picked for a row. An opp the app shows is just set. Otherwise the record is re-read from Org62 by
   * id (read-only; never the client's copy) and written the way the Org62 scan's projection writes it (same
   * upserts, same row ids), with its account when the app lacks that too; then the row's opp, WhatId and lock are
   * set. One change set: Undo removes the added opp and account and restores the row.
   */
  async pickOrg62Opp({ params, body }: I<'pickOrg62Opp'>): Promise<Res<'pickOrg62Opp'>> {
    const m0 = await this.ctx.model(WHOLE);
    const cur0 = m0.get('activity', params.id);
    if (!cur0) throw notFound('Activity entry', params.id);
    this.ctx.checkVersion(cur0, body.ifVersion, 'Activity entry', cur0);
    if (cur0.status === 'logged' || cur0.status === 'verified') throw invalid('This row is logged in Org62: its opportunity is fixed');
    const userId = await this.ctx.userId();
    const key = body.org62Id.slice(0, 15);
    const [have] = await this.ctx.db
      .select({ id: opportunitiesTable.id })
      .from(opportunitiesTable)
      .where(and(eq(opportunitiesTable.ownerUserId, userId), sql`left(${opportunitiesTable.org62OpportunityId}, 15) = ${key}`));
    const shown = have ? m0.get('opps', have.id) : undefined;
    let rec: Org62Row | null = null;
    if (!shown) {
      const r = await this.ctx.ds.be6.pickerOrg62({ byId: body.org62Id });
      if (!r.live) throw new AppError('upstream_unavailable', r.notes[0] ?? 'Org62 is not available here', undefined, false);
      rec = r.rows.find((x) => x.org62Id.slice(0, 15) === key) ?? null;
      if (!rec) throw notFound('Org62 opportunity', body.org62Id);
    }
    const name = shown?.name ?? rec!.name;
    const r = await this.ctx.mutate({ action: 'activity.org62_opp', summary: `Set the opportunity: ${name}${rec ? ' (added from Org62)' : ''}`, entity: { type: 'activity_entry', id: params.id }, current: async () => (await this.ctx.model(WHOLE)).get('activity', params.id) ?? null }, async (w, model) => {
      const cur = model.get('activity', params.id)!;
      let oppId = shown?.id ?? null;
      let accountName = shown ? (model.get('accounts', shown.accountId)?.name ?? null) : (rec!.account ?? null);
      if (rec) {
        const added = await this.ctx.ds.deals.putOrg62Opp(w, rec);
        oppId = added.id;
        accountName = added.accountName ?? accountName;
      }
      const next: ActivityEntry = {
        ...cur,
        oppId,
        oppName: name,
        accountName: accountName ?? cur.accountName,
        userLockedFields: [...new Set([...cur.userLockedFields, 'oppId' as const])],
        issues: cur.issues.filter((i) => !/opp/i.test(i)),
      };
      await updateActivity(w, model.extra.vocab, cur, next, { bump: true, ifVersion: body.ifVersion, lock: ['oppId'] }, accountName);
      await this.ctx.ds.attribution.learnFromRow(w, model, cur, next, 'org62_pick');
    });
    const m = await this.ctx.model(WHOLE);
    return { entity: m.get('activity', params.id)!, auditId: r.auditId };
  }

  // D-64: "Dismiss all from <source>": the rule in user_settings (cc.time.dismiss-rules) and the rows it sets aside, one
  // audited change set (Undo reverts both); Remove brings the rows back and recomputes their weeks right away.
  async listTimeDismissRules(_i: I<'listTimeDismissRules'>): Promise<Res<'listTimeDismissRules'>> {
    const m = await this.ctx.model(WHOLE);
    return { rules: rulesView(readTimeDismissRules(m.ctx.kv), m.all('activity')) };
  }

  async dismissFromSource({ body }: I<'dismissFromSource'>): Promise<Res<'dismissFromSource'>> {
    const m0 = await this.ctx.model(WHOLE);
    if (!m0.get('activity', body.entryId)) throw notFound('Activity entry', body.entryId);
    const plan = planDismissFromSource(markCanvasHolds(m0.all('activity'), canvasHolds(m0.all('drafts'))), body.entryId, this.ctx.now().toISOString());
    const r = await this.ctx.mutate({ action: 'time.dismiss_rule', summary: `Dismissed all from ${plan.rule.label}: ${plan.changes.length} ${plan.changes.length === 1 ? 'row' : 'rows'}`, entity: { type: 'activity_entry', id: body.entryId } }, async (w, model) => {
      await writeKv(w, TIME_DISMISS_RULES_KEY, withRule(readTimeDismissRules(model.ctx.kv), plan.rule));
      for (const c of plan.changes) {
        const cur = model.get('activity', c.id);
        if (cur) await updateActivity(w, model.extra.vocab, cur, { ...c, canvasDraftId: undefined }, { bump: true }, cur.accountName);
      }
    });
    this.ctx.bus.publishTables(['activity_entries'], plan.changes.map((c) => c.id), 'time.dismiss_rule');
    const m = await this.ctx.model(WHOLE);
    return { entity: { rule: rulesView([plan.rule], m.all('activity'))[0]!, dismissedIds: plan.changes.map((c) => c.id) }, auditId: r.undoable ? r.auditId : null };
  }

  async removeTimeDismissRule({ body }: I<'removeTimeDismissRule'>): Promise<Res<'removeTimeDismissRule'>> {
    const m0 = await this.ctx.model(WHOLE);
    const stored = readTimeDismissRules(m0.ctx.kv);
    const rule = stored.find((x) => x.key === body.key);
    if (!rule) return { entity: { rules: rulesView(stored, m0.all('activity')) }, auditId: null };
    const back = planRemoveRule(m0.all('activity'), body.key, this.ctx.now().toISOString(), loggingProfile(personaOf(m0.settings())).taskTypeRequired);
    const r = await this.ctx.mutate({ action: 'time.dismiss_rule.remove', summary: `Removed the rule: all from ${rule.label} (${back.length} ${back.length === 1 ? 'row' : 'rows'} back)`, entity: { type: 'activity_entry', id: back[0]?.id ?? body.key } }, async (w, model) => {
      await writeKv(w, TIME_DISMISS_RULES_KEY, withRule(readTimeDismissRules(model.ctx.kv), null, body.key));
      for (const b of back) {
        const cur = model.get('activity', b.id);
        if (cur) await updateActivity(w, model.extra.vocab, cur, b, { bump: true }, cur.accountName);
      }
    });
    // the projection's rows come back as the engine proposes them now (their weeks recompute, as an onsite correction
    // does); a row the projection does not own keeps the status restoredStatus gave it
    const owned = back.length
      ? (await this.ctx.db.execute<{ day: string }>(sql`select distinct to_char(starts_at at time zone ${m0.settings().profile.timezone || 'UTC'}, 'YYYY-MM-DD') as day from activity_entries
           where owner_user_id = ${await this.ctx.userId()} and id::text = any(array[${sql.join(back.map((b) => sql`${b.id}::text`), sql`, `)}])
             and (dedupe_key like 'wb|%' or dedupe_key like 'cal|%' or dedupe_key like 'onsite|%')`)).rows.map((r) => r.day)
      : [];
    if (owned.length) await recomputeWeeks({ store: projectionStore(this.ctx.db), userId: await this.ctx.userId(), days: owned, now: this.ctx.now() });
    this.ctx.bus.publishTables(['activity_entries'], back.map((b) => b.id), 'time.dismiss_rule.remove');
    const m = await this.ctx.model(WHOLE);
    return { entity: { rules: rulesView(readTimeDismissRules(m.ctx.kv), m.all('activity')) }, auditId: r.undoable ? r.auditId : null };
  }

  async syncCanvas({ body }: I<'syncCanvas'>): Promise<Res<'syncCanvas'>> {
    const m0 = await this.ctx.model(WHOLE);
    const week = this.buildTime(m0);
    if (week.canvas.confirmRequired && !body.confirm) throw invalid('First canvas sync today needs confirm: true', { confirmRequired: true });
    // HYG-1: always the preview. The logging canvas is the Outbox's (D-47: Time ▸ Log stages it, the user Applies it);
    // the old live branch marked rows `synced_to_canvas` with no canvas behind them and queued a `canvas.sync` job no
    // worker handles, so those rows waited for a canvas that never existed.
    const dryRun = true;
    const tz = m0.settings().profile.timezone;
    const rows = week.entries.filter((e) => e.status === 'approved' || e.status === 'synced_to_canvas');
    const payload = [
      `# ${week.canvas.label} · week of ${week.weekStart}`,
      '',
      ...rows.map((e) => `- [ ] ${e.date} ${fmtHM(e.start, tz)}–${fmtHM(e.end, tz)} · ${e.durationH}h · ${e.taskType ?? '?'} · ${e.oppName ?? 'no opp'} · ${e.meetingType ?? ''} · ${e.description}`),
    ].join('\n');
    const now = this.ctx.now().toISOString();
    const r = await this.ctx.mutate({ action: dryRun ? 'activity.sync_canvas.dry_run' : 'activity.sync_canvas', summary: `${dryRun ? 'Dry run: ' : ''}Synced ${rows.length} rows to canvas`, entity: { type: 'activity_entry', id: 'canvas' }, undoable: !dryRun }, async (w, model) => {
      await writeMeta(w, { ...model.meta(), canvas: { ...model.meta().canvas, lastSyncedAt: now, rowsChangedSince: 0 } });
    });
    return { dryRun, syncedAt: now, rowsSynced: rows.length, payload, entries: this.buildTime(await this.ctx.model(WHOLE)).entries, auditId: r.auditId };
  }
}
