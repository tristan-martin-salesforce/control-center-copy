/**
 * The db DataSource, work domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import { uniq, resolvedRecord, resolutionLabel, WHOLE, I, Res, blankItem, ITEM_PATCH_LOCK } from '../shared';
import type { DbCtx } from '../ctx';
import { addDays, setHours, setMinutes } from 'date-fns';
import { and, desc, eq } from 'drizzle-orm';
import type { AgentRun, Asset, Resolution, WorkItemDetail, WorkItemLockableField, WorkItemRecord, WorkTab } from '@/contract';
import { changeSets, workItemTransitions } from '@/db/schema';
import { invalid, notFound } from '@/server/errors';
import { enqueueEnrich } from '@/jobs/handlers/enrich';
import { enqueueRerank } from '@/jobs/handlers/rerank';
import { workItemChain } from '@/scanner/trace/queries';
import { itemHistory } from '../audit';
import { sourceFromDb, stateFromDb } from '../enums';
import { uuidFor } from '../ids';
import type { ReadModel } from '../model';
import { closedPage, pageList } from '../reads/page';
import { everything, itemScope, workScope } from '../reads/scope';
import { countsInSql, pagedInSql, workListCounts } from '../reads/work-list';
import * as resolution from '../resolution';
import { insertEvidence, insertWorkItem, logTransition, updateEvidence } from '../store/work';
import { hydrateItem, isLive, nowCardFor } from '../views';
import { slackLabels } from '../../draft-source';
import { evidenceRowNames } from '../store/draft-source';
import { buildEvidencePayload, evidenceTexts, inlineNames, unnamedMentions, whyMentionNames, whyTexts } from '../../evidence-view';
import { initiativeView, workListView } from '@/server/views/work';

const NOT_DONE_BACK = new Set<WorkItemRecord['state']>(['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'reopened']);

/** priority@2 R4: the patch fields that change a ranking input (a re-rank follows, debounced). */
const RERANK_PATCH_KEYS = ['due', 'dueKind', 'startBy', 'effort', 'importance', 'signals', 'servesEventId', 'oppId', 'accountId', 'kind', 'people', 'counterparty'] as const;

/** Is an instant on the user's local today? */
function isLocalToday(iso: string, now: Date, timeZone: string): boolean {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const t = Date.parse(iso);
  return Number.isFinite(t) && day(new Date(t)) === day(now);
}

export class DbWork {
  constructor(private readonly ctx: DbCtx) {}

  /**
   * GET /items through the `work` scope (post-2.0: before, every item of every state was loaded): the model holds
   * the rows the query can show (reads/work-list.ts), the view filters, orders and shapes them as before. On the
   * exact path the window is the tab's rows only, so every tab's count is one SQL query and the Closed tab pages in
   * SQL; on the text / source path the window covers every tab and the view counts. Without `limit` the payload is
   * unchanged; a failed count query reads every item (WL-3).
   */
  async listItems({ query }: I<'listItems'>): Promise<Res<'listItems'>> {
    const userId = await this.ctx.userId();
    let counts: Record<WorkTab, number> | null = null;
    if (countsInSql(query)) {
      try {
        counts = await workListCounts(this.ctx.db, userId, query);
      } catch {
        return this.ctx.read(everything('work list: the count query failed'), (m) => pageList(workListView(m, query), query));
      }
    }
    return this.ctx.read(workScope(query), (m) => {
      const view = workListView(m, query);
      // a model that is not this window (scopes off, a scope-miss retry, a failed window query) holds every item
      const windowed = m.scope.kind === 'work' && m.windowed.has('workItems');
      if (!windowed || !counts) return pageList(view, query);
      if (!pagedInSql(query)) return pageList({ ...view, counts }, query);
      // the window is the rows after the keyset cursor plus one (reads/work-list.ts): the page and its next cursor
      return closedPage({ ...view, counts, total: counts[query.tab] }, view.items, query.limit!);
    });
  }

  async getItem({ params }: I<'getItem'>): Promise<Res<'getItem'>> {
    return this.ctx.read(itemScope(params.id), (model) => this.itemPage(model, params.id));
  }

  private async itemPage(model: ReadModel, id: string): Promise<Res<'getItem'>> {
    const params = { id };
    const d = this.itemDetail(model, params.id);
    // the why line names someone neither the directory nor the texts do: the item's own Slack rows may (read only
    // when needed)
    const texts = whyTexts(d.item, d.nba);
    const people = slackLabels(model.all('people'));
    const evidence = model.all('evidence').filter((e) => e.workItemId === d.item.id);
    if (!unnamedMentions(texts, people, inlineNames([...texts, ...evidenceTexts(evidence)])).length) return d;
    return { ...d, mentions: whyMentionNames(texts, evidence, people, await evidenceRowNames(this.ctx.db, model.ctx.userId, d.item.id)) };
  }

  private itemDetail(m: ReadModel, itemId: string): WorkItemDetail {
    const rec = this.ctx.item(m, itemId);
    const evidence = m.all('evidence').filter((e) => e.workItemId === rec.id);
    const card = nowCardFor(m, rec);
    const ini = rec.initiativeId ? (m.get('initiatives', rec.initiativeId) ?? null) : null;
    const siblings = ini ? m.all('workItems').filter((w) => w.initiativeId === ini.id && w.id !== rec.id).map((w) => hydrateItem(m, w)) : [];
    return {
      item: card.item,
      nba: card.nba,
      draft: card.draft,
      initiative: ini,
      siblings,
      proposals: card.proposals,
      runs: rec.runIds.map((r) => m.get('agentRuns', r)).filter((r): r is AgentRun => !!r),
      assets: uniq([...rec.assetIds, ...(ini?.assetIds ?? [])]).map((a) => m.get('assets', a)).filter((a): a is Asset => !!a),
      account: rec.accountId ? (m.get('accounts', rec.accountId) ?? null) : null,
      opp: rec.oppId ? (m.get('opps', rec.oppId) ?? null) : null,
      meeting: rec.servesEventId ? (m.get('events', rec.servesEventId) ?? null) : null,
      evidenceCount: evidence.length,
      mentions: whyMentionNames(whyTexts(card.item, card.nba), evidence, slackLabels(m.all('people'))),
    };
  }

  async captureItem({ body }: I<'captureItem'>): Promise<Res<'captureItem'>> {
    const r = await this.captureInternal(body, 'user');
    return { entity: await this.ctx.hydrated(r.result), auditId: r.auditId };
  }

  /** Quick capture. Users lock the title they typed; chat captures lock nothing (only user edits lock). */
  async captureInternal(body: { text: string; accountId?: string; initiativeId?: string; due?: string }, actor: 'user' | 'chat') {
    const byUser = actor === 'user';
    const now = this.ctx.now().toISOString();
    let text = body.text.trim();
    let youMin = 15;
    const eff = /~(\d+)\s*(m|min|h)\b/i.exec(text);
    if (eff) {
      youMin = eff[2]!.toLowerCase() === 'h' ? Number(eff[1]) * 60 : Number(eff[1]);
      text = text.replace(eff[0], '').trim();
    }
    const r = await this.ctx.mutate({ action: byUser ? 'item.capture' : 'chat.capture', summary: 'Captured', entity: undefined, actor }, async (w, model) => {
      let accountId = body.accountId ?? null;
      const acc = /#([\w-]+)/.exec(text);
      if (acc) {
        const match = model.all('accounts').find((a) => a.name.toLowerCase().startsWith(acc[1]!.toLowerCase()));
        if (match) accountId = match.id;
        text = text.replace(acc[0], match?.name ?? acc[1]!).trim();
      }
      const itemId = crypto.randomUUID();
      const label = byUser ? 'Quick capture' : 'Chat capture';
      const rec: WorkItemRecord = {
        ...blankItem(now, model.ctx.me),
        id: itemId,
        kind: 'task',
        state: 'open',
        title: text.replace(/\s+/g, ' '),
        initiativeId: body.initiativeId ?? null,
        accountId,
        confidence: 'sure',
        why: byUser ? 'Captured by you' : 'Captured from chat',
        sources: [{ kind: 'manual', label, at: now }],
        effort: { youMin, agentMin: 0 },
        due: body.due ?? null,
        signals: { customerFacing: !!accountId, fromManager: false, boost: 0 },
        userLockedFields: byUser ? ['title'] : [],
        reevaluating: false, // derived from the queued enrich job
        seenAt: now,
        enrichment: { status: 'enriching', startedAt: now, chips: [] },
      };
      await w.cs.tx.update(changeSets).set({ summary: `Captured: ${rec.title}`, entityType: 'work_item', entityId: itemId }).where(eq(changeSets.id, w.cs.id));
      await insertWorkItem(w, rec, this.ctx.links(model), { locks: byUser ? ['title'] : [] });
      await insertEvidence(w, { id: crypto.randomUUID(), workItemId: itemId, role: 'origin', source: { kind: 'manual', label, at: now }, at: now, summary: rec.why, snippet: null, author: null, isNew: false, confidence: null }, now, actor);
      // enrichment (related sessions, assets, threads → chips, NBA, draft) is the worker's job
      await enqueueEnrich(w.tx, w.userId, itemId); // src/jobs/handlers/enrich.ts (HYG-1: before, no worker handled `enrich`)
      await enqueueRerank(w.tx, w.userId, 'new_info'); // priority@2 R4: a new item ranks within a minute (debounced)
      return itemId;
    });
    this.ctx.bus.publishTables(['jobs'], [r.result], byUser ? 'item.capture' : 'chat.capture');
    return r;
  }

  async patchItem({ params, body }: I<'patchItem'>): Promise<Res<'patchItem'>> {
    const r = await this.ctx.mutate(
      { action: 'item.edit', summary: 'Edited', entity: { type: 'work_item', id: params.id }, burst: true, current: () => this.ctx.hydrated(params.id) },
      async (w, model) => {
        const cur = this.ctx.item(model, params.id);
        this.ctx.checkVersion(cur, body.ifVersion, 'Work item', hydrateItem(model, cur));
        const locks = new Set(cur.userLockedFields);
        const newly: WorkItemLockableField[] = [];
        for (const k of Object.keys(body.patch)) if (ITEM_PATCH_LOCK[k]) {
          locks.add(ITEM_PATCH_LOCK[k]);
          newly.push(ITEM_PATCH_LOCK[k]);
        }
        await w.tx.update(changeSets).set({ summary: `Edited: ${cur.title}` }).where(eq(changeSets.id, w.cs.id));
        const next = { ...cur, ...body.patch, userLockedFields: [...locks] } as WorkItemRecord;
        // priority@2 R8: a start-by pulled into today is a pin, a boost a reorder (both feed the learning loop)
        const patch = body.patch as Partial<WorkItemRecord>;
        if (patch.startBy && isLocalToday(patch.startBy, w.now, model.settings().profile.timezone) && (!cur.startBy || !isLocalToday(cur.startBy, w.now, model.settings().profile.timezone))) await this.ctx.ds.today.priorityFeedbackIn(w, model, cur, 'pin', null);
        else if (patch.signals && patch.signals.boost !== cur.signals.boost && cur.rank !== null) await this.ctx.ds.today.priorityFeedbackIn(w, model, cur, 'reorder', Math.max(1, cur.rank + (patch.signals.boost > cur.signals.boost ? -1 : 1)));
        await this.ctx.writeItem(w, model, cur, next, { bump: true, ifVersion: body.ifVersion, lock: newly });
        if (RERANK_PATCH_KEYS.some((k) => k in body.patch)) await enqueueRerank(w.tx, w.userId, 'new_info');
      },
    );
    return { entity: await this.ctx.hydrated(params.id), auditId: r.auditId };
  }

  async itemAction({ params, body }: I<'itemAction'>): Promise<Res<'itemAction'>> {
    const r = await this.ctx.mutate(
      { action: `item.${params.verb}`, summary: params.verb, entity: { type: 'work_item', id: params.id }, current: () => this.ctx.hydrated(params.id) },
      async (w, model) => {
        const cur = this.ctx.item(model, params.id);
        this.ctx.checkVersion(cur, body.ifVersion, 'Work item', hydrateItem(model, cur));
        const now = w.now.toISOString();
        const done = (reason: string, resolution: Resolution = 'done_by_me'): WorkItemRecord =>
          resolvedRecord(model, cur, { reason, resolution, detail: body.detail ?? {}, involvement: body.involvement, doneBy: 'user', at: now });
        let next: WorkItemRecord;
        let label: string;
        switch (params.verb) {
          case 'done':
            if (!isLive(cur) && cur.state !== 'snoozed' && cur.state !== 'suggested') throw invalid(`Cannot mark a ${cur.state} item done`);
            next = done(body.resolution && body.resolution !== 'done_by_me' ? resolutionLabel(body.resolution, body.detail?.personName) : 'Marked done by you', body.resolution ?? 'done_by_me');
            label = 'Done';
            break;
          case 'resolve':
            if (!body.resolution) throw invalid('resolve needs a `resolution`');
            if (!isLive(cur) && cur.state !== 'snoozed' && cur.state !== 'suggested' && cur.state !== 'done') throw invalid(`Cannot resolve a ${cur.state} item`);
            next = done(resolutionLabel(body.resolution, body.detail?.personName ?? (body.detail?.personId ? model.get('people', body.detail.personId)?.name : undefined)), body.resolution);
            label = 'Resolved';
            break;
          case 'snooze':
            if (!body.until) throw invalid('snooze needs `until`');
            if (!isLive(cur) && cur.state !== 'snoozed') throw invalid(`Cannot snooze a ${cur.state} item`);
            next = { ...cur, state: 'snoozed', snoozedUntil: body.until, snoozedFrom: cur.state === 'snoozed' ? cur.snoozedFrom : cur.state };
            label = 'Snoozed';
            break;
          case 'accept':
            if (cur.state !== 'suggested') throw invalid('Only suggested items can be accepted');
            next = { ...cur, state: 'open', confidence: cur.confidence === 'guess' ? 'likely' : cur.confidence };
            label = 'Accepted';
            break;
          case 'dismiss':
            next = { ...cur, state: 'dismissed', dismissed: { reason: body.reason ?? 'other', note: body.note, at: now } };
            label = 'Dismissed';
            break;
          case 'confirm-done':
            if (cur.state !== 'likely_done') throw invalid('Only likely-done items can be confirmed');
            next = done(cur.likelyDone?.reason ?? 'Confirmed done');
            label = 'Confirmed done';
            break;
          case 'not-done': {
            // LD-1: back to the live state it had before the engine called it likely done (the last transition into
            // likely_done says which; in_progress as the closure machine's own step-back); the evidence stays linked, so the same reply does not flag it again.
            if (cur.state !== 'likely_done') throw invalid('Only likely-done items can be marked not done');
            const [t] = await w.tx
              .select({ from: workItemTransitions.fromStatus })
              .from(workItemTransitions)
              .where(and(eq(workItemTransitions.workItemId, uuidFor(cur.id)), eq(workItemTransitions.toStatus, 'likely_done')))
              .orderBy(desc(workItemTransitions.occurredAt), desc(workItemTransitions.id))
              .limit(1);
            const prior = t?.from ? stateFromDb(t.from, false) : null;
            next = { ...cur, state: prior && NOT_DONE_BACK.has(prior) ? prior : 'in_progress', likelyDone: null };
            label = 'Not done';
            break;
          }
          case 'reopen':
            if (cur.state !== 'done' && cur.state !== 'dismissed') throw invalid('Only done or dismissed items can be reopened');
            // OUTBOX-W: drafts withdrawn when it closed stay discarded (they answered the old state of the thread);
            // the user can draft again. Undo of the close, not a reopen, is what restores them.
            next = { ...cur, state: 'reopened', doneAt: null, doneBy: null, closedReason: null, dismissed: null, resolution: null, resolutionDetail: null, involvement: 'owner', reopened: { reason: body.note ?? 'Reopened by you', at: now } };
            label = 'Reopened';
            break;
          case 'not-now': {
            if (!body.reason) throw invalid('not-now needs a `reason` (done_elsewhere · not_mine · later · wrong_account · other)');
            label = 'Not now';
            if (body.reason === 'done_elsewhere') next = done('Done elsewhere');
            else if (body.reason === 'later') {
              const until = body.until ?? setMinutes(setHours(addDays(w.now, 1), 9), 0).toISOString();
              next = { ...cur, state: 'snoozed', snoozedUntil: until, snoozedFrom: cur.state };
            } else if (body.reason === 'wrong_account') next = { ...cur, accountId: null, oppId: null, notes: `${cur.notes}${cur.notes ? '\n' : ''}Wrong account (not now)` };
            else next = { ...cur, state: 'dismissed', dismissed: { reason: body.reason, note: body.note, at: now } };
            break;
          }
        }
        await w.tx.update(changeSets).set({ summary: `${label}: ${cur.title}` }).where(eq(changeSets.id, w.cs.id));
        // priority@2 R8: a snooze or a "not today" (Not now ▸ later) of ranked work feeds the learning loop
        if (cur.rank !== null && (params.verb === 'snooze' || (params.verb === 'not-now' && body.reason === 'later'))) await this.ctx.ds.today.priorityFeedbackIn(w, model, cur, params.verb === 'snooze' ? 'snooze' : 'not_today', null);
        await this.ctx.writeItem(w, model, cur, next, { bump: true, ifVersion: body.ifVersion });
        await logTransition(w, cur.id, cur.state, next.state, next.closedReason ?? next.dismissed?.note ?? label);
        if (next.state !== cur.state) await enqueueRerank(w.tx, w.userId, 'new_info');
      },
    );
    return { entity: await this.ctx.hydrated(params.id), auditId: r.auditId };
  }

  async getItemEvidence({ params }: I<'getItemEvidence'>): Promise<Res<'getItemEvidence'>> {
    const model = await this.ctx.model(WHOLE);
    this.ctx.item(model, params.id);
    const evidence = model.all('evidence').filter((e) => e.workItemId === params.id);
    const people = slackLabels(model.all('people'));
    // names the directory lacks: the ones the item's own Slack rows carry (read only when a snippet needs them)
    const rows = unnamedMentions(evidenceTexts(evidence), people).length ? await evidenceRowNames(this.ctx.db, model.ctx.userId, params.id) : {};
    return buildEvidencePayload(params.id, evidence, people, rows);
  }

  /** H-7 "Why is this still open?" (src/server/datasource/db/resolution.ts). */
  async getResolutionCheck({ params }: I<'getResolutionCheck'>): Promise<Res<'getResolutionCheck'>> {
    this.ctx.item(await this.ctx.model(WHOLE), params.id);
    return resolution.getResolutionCheckPayload(this.ctx.db, await this.ctx.userId(), params.id, this.ctx.now());
  }

  /** AUDIT "why is this here?": evidence → source (link) → the scan run that made it → triage verdict → spend. */
  async getItemTrace({ params }: I<'getItemTrace'>): Promise<Res<'getItemTrace'>> {
    const model = await this.ctx.model(WHOLE);
    this.ctx.item(model, params.id);
    const userId = await this.ctx.userId();
    const chain = await workItemChain(this.ctx.db, userId, params.id);
    const evidence = new Map(model.all('evidence').filter((e) => e.workItemId === params.id).map((e) => [e.id, e]));
    return {
      workItemId: params.id,
      createdBy: chain.createdBy,
      steps: chain.steps.map((s) => {
        const ev = evidence.get(s.evidenceId);
        return {
          evidenceId: s.evidenceId,
          role: s.role,
          confidence: s.confidence === 0.5 ? null : s.confidence,
          rationale: s.rationale,
          at: s.createdAt,
          // the evidence chip's own source (label, link) when the model has it, else the chain's
          source: ev?.source ?? (s.source ? { kind: sourceFromDb(s.source.kind as Parameters<typeof sourceFromDb>[0]), label: s.source.title ?? s.source.kind, ...(s.source.url ? { url: s.source.url } : {}), ...(s.source.externalId ? { externalId: s.source.externalId } : {}), ...(s.source.occurredAt ? { at: s.source.occurredAt } : {}) } : null),
          sourceItemId: s.sourceItemId,
          run: s.run ? { id: s.run.id, connector: s.run.connector, scope: s.run.scope, trigger: s.run.trigger, mode: s.run.mode, status: s.run.status, windowStart: s.run.windowStart, windowEnd: s.run.windowEnd, startedAt: s.run.startedAt, finishedAt: s.run.finishedAt, skillVersion: s.run.skillVersion, model: s.run.model, costUsd: s.run.costUsd, via: s.run.via } : null,
          verdict: s.verdict,
          spend: s.spend,
        };
      }),
    };
  }

  async getItemHistory({ params }: I<'getItemHistory'>): Promise<Res<'getItemHistory'>> {
    const model = await this.ctx.model(WHOLE);
    const rec = this.ctx.item(model, params.id);
    const nba = rec.nbaId ? model.get('nbas', rec.nbaId) : undefined;
    const entries = await itemHistory(this.ctx.db, model.ctx.userId, rec.id, model, model.ctx.kv);
    return { workItemId: rec.id, entries, nbaVersions: nba?.versions ?? [] };
  }

  async markItemSeen({ params }: I<'markItemSeen'>): Promise<Res<'markItemSeen'>> {
    await this.ctx.mutate({ action: 'item.seen', summary: 'Seen', entity: { type: 'work_item', id: params.id }, undoable: false }, async (w, model) => {
      const cur = this.ctx.item(model, params.id);
      const seenAt = w.now.toISOString();
      for (const e of model.all('evidence')) if (e.workItemId === cur.id && e.isNew) await updateEvidence(w, e, { ...e, isNew: false }, seenAt);
      await this.ctx.writeItem(w, model, cur, { ...cur, newEvidenceCount: 0, seenAt }, { bump: false });
      for (const e of model.all('evidence')) if (e.workItemId === cur.id && !e.isNew) await updateEvidence(w, e, e, seenAt);
    });
    return { entity: await this.ctx.hydrated(params.id), auditId: null };
  }

  async getInitiative({ params }: I<'getInitiative'>): Promise<Res<'getInitiative'>> {
    const m = await this.ctx.model(WHOLE);
    const ini = m.get('initiatives', params.id);
    if (!ini) throw notFound('Initiative', params.id);
    return initiativeView(m, ini);
  }
}
