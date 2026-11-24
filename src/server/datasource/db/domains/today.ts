/**
 * The db DataSource, today domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res } from '../shared';
import { eq, sql } from 'drizzle-orm';
import type { PriorityPolicy, SinceDigest, WorkItemRecord, PriorityFeedbackAction } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import { priorityPlanSteps, priorityPolicyRules, priorityRuns, workItems, priorityScores } from '@/db/schema';
import { buildHome } from '@/engines/home/build';
import { nextWorkingDay } from '@/engines/home/time';
import { connectorRowsFor, featureActive, personaOf } from '@/personas';
import { AppError } from '@/server/errors';
import { enqueueRerank, type RerankTrigger } from '@/jobs/handlers/rerank';
import { rankWork } from '@/engines/priority/rank';
import { rerank as stableRerank } from '@/engines/priority/stability';
import { rankWorkV2 } from '@/engines/priority/v2/rank';
import { closeEntries, sinceEntries } from '../audit';
import type { ReadModel } from '../model';
import { BRIEFING } from '../reads/scope';
import { withReadMemo } from '../reads/session';
import { derivedPriority, priorityInputs, storedOrderFrom, todayCapacity, toRankRows } from '../rank';
import { allUserIds, decideRule, engineSettingOf, feedbackSnapshot, previewOf, recordFeedback, shownEngineVersion, writeRanking, writeShadow } from '../priority';
import type { WriteCtx } from '../store/common';
import { vdpNeedYouCount } from '@/engines/vdp/status';
import { writeMeta } from '../store/settings';
import { loadUseCaseSync } from '../store/use-cases';
import { dcWaitingCount, ucWaitingCount, type WaitingForCanvas } from '@/lib/waiting-work';
import { chatPlansIn, pendingChatCards } from '@/server/chat/outputs';
import { loadDcRequests } from '../store/dc-requests';
import { needDecisionsOf } from '../store/need-decisions';
import { insertScore, updateWorkItem } from '../store/work';
import { buildSince, hydrateItem } from '../views';
import { todayView } from '@/server/views/today';
import { uuidFor } from '../ids';

export class DbToday {
  constructor(private readonly ctx: DbCtx) {}

  /**
   * The stored home-list order: Q1's rows (DATA-MODEL §6: its WHERE, ORDER BY and LIMIT), ids only. Every caller reads
   * just the ids, and Q1's display columns (the score's why, the NBA, the origin link, the degradation view per row)
   * were most of Home's slowest statement (post-2.0 Home SQL).
   */
  async rankedIds(): Promise<string[]> {
    const userId = await this.ctx.userId();
    const r = await this.ctx.db.execute<{ id: string }>(sql`
      select wi.id from work_items wi
       where wi.owner_user_id = ${userId}
         and wi.status in ('open', 'in_progress', 'waiting_on_me', 'likely_done')
         and wi.priority_lane in ('top3', 'now', 'next', 'later')
       order by wi.priority_lane, wi.priority_rank
       limit 40`);
    return r.rows.map((x) => x.id);
  }

  /** GET /home: the pure Home engine over the read model, with Today's own capacity (same numbers on both pages). */
  async getHome(i: I<'getHome'>): Promise<Res<'getHome'>> {
    // post-2.0 Home SQL: one read per request of what its helpers share (the VDP mirror, opps, use cases, DC requests)
    return withReadMemo(() => this.ctx.read(BRIEFING, (model) => this.homeOf(model, i)));
  }

  private async homeOf(model: ReadModel, { query }: I<'getHome'>): Promise<Res<'getHome'>> {
    const now = this.ctx.now();
    const meta = model.meta();
    const settings = model.settings();
    const spend = model.spend();
    // PERF-1: Today's capacity and the since digest from this request's model (it loaded both twice)
    const sinceP = this.sinceDigest(model, now);
    const timezone = settings.profile.timezone || meta.timezone;
    const day = query?.day ?? 'today';
    // Planning the next working day: the CAPACITY engine at that day's working-hours start (Today's own is today's)
    const planAt = day === 'next' ? new Date(nextWorkingDay(now.getTime(), timezone, settings.profile.workingHours).startMs) : null;
    const persona = personaOf(settings);
    // post-2.0 Home SQL: every read after the model runs together (they were awaited one after another)
    const [capacity, since, forecast, vdp, dcNeeds, waitingForCanvas] = await Promise.all([
      planAt ? todayCapacity(model, planAt) : this.todayOf(model, now, sinceP).then((t) => t.header.capacity),
      sinceP,
      this.ctx.ds.forecast.homeInput(model), // lane A
      this.ctx.ds.vdp.vdpHome(model), // D-59
      featureActive(persona, 'dealContributions') ? this.ctx.ds.deals.dealsNeeds(model).then((ns) => ns.filter((n) => n.section === 'fix')) : undefined, // DC-31: one count source with Deals
      this.waitingForCanvas(model), // 2026-11-13 audit C2: never "Nothing missing" while they wait
    ]);
    return buildHome({
      now: now.toISOString(),
      timezone,
      workingHours: settings.profile.workingHours,
      wide: query?.wide ?? false,
      day,
      persona,
      items: model.all('workItems').map((w) => hydrateItem(model, w)),
      nbas: model.all('nbas'),
      drafts: model.all('drafts'),
      proposals: model.all('proposals'),
      events: model.all('events'),
      slots: model.all('slots'),
      initiatives: model.all('initiatives'),
      accounts: model.all('accounts'),
      opps: model.all('opps'),
      missedOpps: model.all('missedOpps'),
      activity: model.all('activity'),
      // D-55: Home's footer and Log & fix name only the persona's active sources
      connectors: connectorRowsFor(model.all('connectors'), persona),
      agentRuns: model.all('agentRuns'),
      briefs: model.all('briefs'),
      quarter: meta.quarter,
      canvasLabel: meta.canvas.label,
      since: { changed: since.counts.changed, closed: since.counts.closed, new: since.counts.new, show: since.show },
      spend: { usd: spend.today.usd, softBudgetUsd: spend.today.softBudgetUsd },
      dryRun: settings.sending.dryRun,
      capacity,
      closedSince: settings.closing.tellMeWhatClosed ? meta.lastActiveAt : null,
      forecast,
      vdp,
      decisions: needDecisionsOf(model.ctx.kv), // Log & fix rows set aside (Not now / Not needed)
      dcNeeds,
      waitingForCanvas,
      priorityEngine: engineSettingOf(model), // the shown ranking: Home's Admin row (batch math with priority@2)
    });
  }

  async getToday(_i: I<'getToday'>): Promise<Res<'getToday'>> {
    return withReadMemo(() => this.ctx.read(BRIEFING, (model) => this.todayPage(model)));
  }

  private async todayPage(model: ReadModel): Promise<Res<'getToday'>> {
    const now = this.ctx.now();
    const [t, v, waitingForCanvas] = await Promise.all([this.todayOf(model, now, this.sinceDigest(model, now)), this.ctx.ds.vdp.vdpHome(model), this.waitingForCanvas(model)]);
    // D-59: the Time badge also counts the VDPs that need you (quiet; only approvals waiting are loud); 2026-11-13 audit
    // C2: and the DCs and use cases waiting for a canvas; C8: the Assistant's staged cards
    return { ...t, navCounts: { ...t.navCounts, vdpOpen: v ? vdpNeedYouCount(v.summary) : 0, waitingForCanvas, assistantPending: pendingChatCards(chatPlansIn(model.ctx.kv)) } };
  }

  /**
   * 2026-11-13 audit C2: DC requests (approved, not on a canvas yet) and VDP use cases (creates, Stage / Go-Live
   * fixes) waiting for a logging canvas, while the persona has each feature: the sidebar badge and Home ▸ Log & fix.
   * The same counts Time ▸ Log it reads from listDcRequests and getUseCaseSync (src/lib/waiting-work.ts).
   */
  private async waitingForCanvas(model: ReadModel): Promise<WaitingForCanvas> {
    const persona = personaOf(model.settings());
    const userId = model.ctx.userId;
    const [dcs, useCases] = await Promise.all([
      featureActive(persona, 'dealContributions') ? loadDcRequests(this.ctx.db, userId).then(dcWaitingCount) : 0,
      featureActive(persona, 'vdp') ? loadUseCaseSync(this.ctx.db, userId).then((u) => ucWaitingCount(u.counts)) : 0,
    ]);
    return { dcs, useCases };
  }

  /** MIN-27: the latest away-since already applied (or found applied), so repeat headers cost nothing. */
  private awayNoted = 0;

  /**
   * MIN-27: the browser's "when the user last left" (`x-cc-away-since`, ms). `cc.meta.lastActiveAt`, where Home's,
   * Today's and the shell's since-you-left start, moves forward to it (never back, never past now). One small
   * change set per return (actor user, so the digest never lists it; not undoable).
   */
  async notePresence(awaySinceMs: number): Promise<void> {
    if (!(awaySinceMs > this.awayNoted)) return;
    const now = this.ctx.now().getTime();
    // a browser ahead of this clock (CC_DB_NOW pins it in the past) says nothing about this timeline
    if (awaySinceMs > now + 60_000) return;
    const at = Math.min(awaySinceMs, now);
    const userId = await this.ctx.userId();
    const [row] = await this.ctx.db
      .execute<{ at: string | null }>(sql`select value->>'lastActiveAt' as at from user_settings where owner_user_id = ${userId} and key = 'cc.meta'`)
      .then((r) => r.rows);
    const cur = row?.at ? Date.parse(row.at) : NaN;
    if (!row || (Number.isFinite(cur) && cur >= at)) {
      this.awayNoted = Math.max(this.awayNoted, Number.isFinite(cur) ? cur : at, at);
      return;
    }
    const iso = new Date(at).toISOString();
    await withChangeSet({ db: this.ctx.db, userId, actor: actors.user('presence.return'), reason: 'Back: since-you-left starts when you left', undoable: false }, async (tx) => {
      await tx.execute(sql`
        update user_settings set value = jsonb_set(value, '{lastActiveAt}', to_jsonb(${iso}::text)), updated_at = now()
         where owner_user_id = ${userId} and key = 'cc.meta'
           and coalesce((value->>'lastActiveAt')::timestamptz < ${iso}::timestamptz, true)`);
    });
    this.awayNoted = at;
    for (const topic of ['home', 'since'] as const) this.ctx.bus.publish({ topic, ids: [], reason: 'presence.return' });
  }

  private async sinceDigest(model: ReadModel, now: Date): Promise<SinceDigest> {
    const meta = model.meta();
    return buildSince(model, await sinceEntries(this.ctx.db, model.ctx.userId, new Date(meta.lastActiveAt), model, model.ctx.kv), meta.lastActiveAt, now);
  }

  /** Today over one model; its SQL reads (Q1 ranked ids, Q6 closes, the since digest) run concurrently. */
  private async todayOf(model: ReadModel, now: Date, sinceP: Promise<SinceDigest>): Promise<Res<'getToday'>> {
    const meta = model.meta();
    const [rankedIds, closeUndo, since] = await Promise.all([
      this.rankedIds(),
      closeEntries(this.ctx.db, model.ctx.userId, new Date(Date.parse(meta.lastActiveAt) - 12 * 3_600_000)),
      sinceP,
    ]);
    // Top 3 stability: the ranker keeps the stored positions (ENGINES-core `rerank`) and counts what a re-rank would change
    const rank = this.ctx.ranker.today(model, storedOrderFrom(model, rankedIds), now);
    // the shared view (src/server/views/today.ts); a close is keyed by the row's uuid (the Triage lookup's rule)
    return todayView(model, { rank, since, closeUndo: (id) => closeUndo.get(id) ?? closeUndo.get(uuidFor(id)) ?? null, capacity: () => todayCapacity(model, now) }, now);
  }

  async rerankToday(_i: I<'rerankToday'>): Promise<Res<'rerankToday'>> {
    const now = this.ctx.now();
    const ids = await this.rankedIds();
    const r = await this.ctx.mutate({ action: 'today.rerank', summary: 'Applied re-rank', entity: { type: 'policy', id: 'ranking' } }, async (w, model) => this.rerankIn(w, model, model.settings().policy, ids, now));
    return { entity: r.result.result, auditId: r.undoable ? r.auditId : null };
  }

  /**
   * A system re-rank (actor `system`) with this DataSource's ranker: `db:seed` runs it once after loading, so
   * a fresh database starts from ENGINES-core's ranking instead of the seed's (the mock's load-time ranks).
   */
  /**
   * priority@2 R4 (`priority.rerank`, debounced 60 s after inputs change): a system re-rank that keeps the shown Top 3
   * where it is (only an urgent pre-emption moves it: D-73) and gives the rest the new order. No model call.
   */
  async autoRerank(trigger: RerankTrigger): Promise<{ top3: string[]; changed: number }> {
    const now = this.ctx.now();
    const ids = await this.rankedIds();
    const r = await this.ctx.mutate({ action: 'system.rerank', summary: 'Re-ranked after new information', entity: { type: 'policy', id: 'ranking' }, actor: 'system' }, async (w, model) =>
      this.rerankIn(w, model, model.settings().policy, ids, now, undefined, { trigger: trigger === 'calendar_change' ? 'calendar_change' : trigger === 'startup' ? 'startup' : trigger === 'schedule' ? 'schedule' : 'new_info', stable: true }),
    );
    return { top3: r.result.scored.slice(0, 3).map((s) => s.id), changed: r.result.result.changed };
  }

  async systemRerank(reason: string): Promise<{ top3: string[]; auditId: string | null }> {
    const now = this.ctx.now();
    const ids = await this.rankedIds();
    const r = await this.ctx.mutate({ action: 'system.rerank', summary: reason, entity: { type: 'policy', id: 'ranking' }, actor: 'system' }, async (w, model) => this.rerankIn(w, model, model.settings().policy, ids, now));
    return { top3: r.result.result.top.slice(0, 3).map((t) => t.workItemId), auditId: r.undoable ? r.auditId : null };
  }

  /**
   * Rank (ENGINES-core by default), write a priority run (engine version, policy version row, focus
   * minutes, next meeting) + a priority_scores row per changed item (components, lane, latest_start_at,
   * slack, inputs hash, rule hits) + the plan steps, refresh the work-item rank cache and meta. One
   * change set: undo restores the previous ranks and score pointers.
   */
  async rerankIn(w: WriteCtx, model: ReadModel, policy: PriorityPolicy, rankedIds: string[], now: Date, policyRowId?: string, opts: { trigger?: 'user_reprioritize' | 'new_info' | 'calendar_change' | 'schedule' | 'startup'; stable?: boolean } = {}) {
    const before = storedOrderFrom(model, rankedIds).map((i) => i.id);
    const rowId = policyRowId ?? model.extra.policyRowId;
    if (!rowId) throw new AppError('internal', 'no active priority policy row', undefined, false);
    const ranking = this.ctx.ranker.rank(model, policy, now);
    // priority@2 shadow: the inputs as the re-rank starts (an injected ranker without engine output, the parity
    // suite's interim one, is compared as priority@1.1 would rank them)
    const shadowInputs = engineSettingOf(model) === 'shadow' ? priorityInputs(model, policy, now, { rowId }) : null;
    let scored = ranking.ranked;
    // the auto re-rank keeps the shown Top 3 (stability.ts: only a pre-emption or the user's apply moves it)
    if (opts.stable && ranking.result) {
      const keep = stableRerank(before.slice(0, ranking.result.top3Size), ranking.result).top3;
      const pos = new Map(scored.map((s) => [s.id, s]));
      scored = [...keep.map((id) => pos.get(id)).filter((s): s is (typeof scored)[number] => !!s), ...scored.filter((s) => !keep.includes(s.id))];
    }
    const byId = new Map(scored.map((s, i) => [s.id, { ...s, rank: i + 1 }]));
    const [run] = await w.tx
      .insert(priorityRuns)
      .values({
        ownerUserId: w.userId,
        trigger: opts.trigger ?? 'user_reprioritize',
        engineVersion: ranking.engineVersion,
        policyId: rowId,
        startedAt: now,
        finishedAt: now,
        itemsConsidered: ranking.result ? Object.keys(ranking.result.scores).length : scored.length,
        availableFocusMinutes: ranking.result ? Math.round(ranking.result.capacity.focusMinLeft) : null,
        nextMeetingAt: ranking.result?.nextMeeting ? new Date(ranking.result.nextMeeting.start) : null,
      })
      .returning({ id: priorityRuns.id });
    const ruleIds = new Map((await w.tx.select({ id: priorityPolicyRules.id, key: priorityPolicyRules.ruleKey }).from(priorityPolicyRules).where(eq(priorityPolicyRules.policyId, rowId))).map((r) => [r.key, r.id]));
    let changedItems = 0;
    for (const cur of model.all('workItems')) {
      const s = byId.get(cur.id);
      const detail = ranking.details?.get(cur.id);
      // the engine also derives the background lane (R-UI-8); an explicit isBackground stays
      const isBackground = cur.isBackground || detail?.lane === 'background';
      const next: WorkItemRecord = s
        ? { ...cur, rank: s.rank, score: s.score, rankReasons: s.reasons, priority: derivedPriority(s.rank), isBackground }
        : { ...cur, rank: null, score: detail && isBackground ? cur.score : null, isBackground, priority: derivedPriority(null) };
      const startByChanged = !!detail && !cur.userLockedFields.includes('startBy') && (detail.startBy ?? null) !== (cur.startBy ?? null);
      if (next.rank === cur.rank && next.score === cur.score && next.isBackground === cur.isBackground && JSON.stringify(next.rankReasons) === JSON.stringify(cur.rankReasons) && next.priority === cur.priority && !startByChanged) continue;
      changedItems++;
      const scoreId = await insertScore(w, next, { runId: run!.id, policyId: rowId, detail, ruleIds }, now);
      if (detail?.v2) await w.tx.update(priorityScores).set({ value: detail.v2.value, urgency: detail.v2.urgency, terms: detail.v2.terms }).where(eq(priorityScores.id, scoreId));
      await updateWorkItem(w, cur, next, this.ctx.links(model), { bump: false });
      await w.tx
        .update(workItems)
        .set({ priorityScoreId: scoreId, priorityComputedAt: now, ...(detail ? { priorityLane: s ? detail.lane : isBackground ? 'background' : null } : {}), updatedAt: sql`${workItems.updatedAt}` })
        .where(eq(workItems.id, cur.id));
      model.put('workItems', detail && startByChanged ? { ...next, startBy: detail.startBy } : next);
    }
    await w.tx.update(priorityRuns).set({ itemsChanged: changedItems }).where(eq(priorityRuns.id, run!.id));
    // priority@2 shadow (R8): v2 ranks the same inputs beside it; recorded in priority_runs, no scores, no ranks
    if (shadowInputs) await writeShadow(w, { inputs: shadowInputs, shown: ranking.result ?? rankWork(shadowInputs), runId: run!.id });
    else if (ranking.result) await writeRanking(w, { shown: ranking.result, runId: run!.id });
    const steps = (ranking.result?.planSteps ?? []).filter((p) => p.workItemId || p.calendarEventId);
    if (steps.length) {
      await w.tx.insert(priorityPlanSteps).values(
        steps.map((p, i) => ({ runId: run!.id, ordinal: i, workItemId: p.workItemId, calendarEventId: p.calendarEventId, mode: p.mode, plannedStartAt: new Date(p.plannedStartAt), plannedEndAt: new Date(p.plannedEndAt), reason: p.reason })),
      );
    }
    await writeMeta(w, { ...model.meta(), rankedAt: now.toISOString(), policyRankVersion: policy.version });
    const top = toRankRows(model, scored, before, 10);
    return { scored, result: { rankedAt: now.toISOString(), changed: top.filter((t) => t.moved !== 0).length, top } };
  }

  /** priority@2 R8: one `priority_feedback` row (ids, ranks and the terms at the time; never text). */
  async priorityFeedbackIn(w: WriteCtx, model: ReadModel, cur: WorkItemRecord, action: PriorityFeedbackAction, toRank: number | null): Promise<void> {
    const inputs = priorityInputs(model, model.settings().policy, w.now);
    await recordFeedback(w, { itemId: cur.id, action, fromRank: cur.rank, toRank, engineVersion: shownEngineVersion(engineSettingOf(model)), snapshot: feedbackSnapshot(cur.id, rankWorkV2(inputs)) });
  }

  /** Today's "Preview new ranking": priority@2 over today's inputs for the session; nothing is written. */
  async getPriorityPreview(_i: I<'getPriorityPreview'>): Promise<Res<'getPriorityPreview'>> {
    const m = await this.ctx.model(WHOLE);
    return previewOf(priorityInputs(m, m.settings().policy, this.ctx.now()), (id) => m.get('workItems', id)?.title ?? '');
  }

  /** Health ▸ the suggested priority rule: apply (a bounded persona weight nudge) or dismiss. Undoable. */
  async decidePriorityRule({ params, body }: I<'decidePriorityRule'>): Promise<Res<'decidePriorityRule'>> {
    const r = await this.ctx.mutate({ action: `priority.rule.${body.decision}`, summary: body.decision === 'apply' ? 'Applied a learned priority rule' : 'Dismissed a priority rule', entity: { type: 'settings', id: 'priority' } }, async (w) => {
      const rule = await decideRule(w, params.id, body.decision);
      if (!rule) throw new AppError('not_found', 'That priority rule is gone', { id: params.id }, false);
      if (body.decision === 'apply') await enqueueRerank(w.tx, w.userId, 'new_info', { delaySeconds: 5 });
      return rule;
    });
    return { entity: r.result, auditId: r.auditId };
  }

  /** Ops: queue the re-rank for every user (deterministic, no model call). */
  async rerankAllUsers(_i: I<'rerankAllUsers'>): Promise<Res<'rerankAllUsers'>> {
    const ids = await allUserIds(this.ctx.db);
    let enqueued = 0;
    for (const id of ids) if ((await enqueueRerank(this.ctx.db, id, 'ops', { delaySeconds: 0 })).id) enqueued++;
    return { users: ids.length, enqueued };
  }
}
