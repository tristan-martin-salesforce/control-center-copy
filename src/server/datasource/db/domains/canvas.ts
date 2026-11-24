/**
 * The db DataSource, canvas domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res } from '../shared';
import { eq } from 'drizzle-orm';
import type { ActionDestination, Draft } from '@/contract';
import { changeSets } from '@/db/schema';
import { personaOf } from '@/personas';
import { AppError, invalid, notFound } from '@/server/errors';
import { renderAll } from '../../mock/render';
import type { ReadModel } from '../model';
import { suggestedCandidates } from '../use-cases';
import { markSuggested } from '@/lib/canvas/prefill';
import { writeKv, type WriteCtx } from '../store/common';
import { insertDraft, updateDraft } from '../store/nba';
import { actionDraftFor } from '@/server/vdp/coverage';
import { canvasActionFor, canvasHolds, canvasInputOf as canvasInputOfDest } from '@/lib/canvas/payload';
import { liveOrg62, recordTypeKv, resolveRecordTypeId } from '@/server/chat/record-type';
import { loggingProfile } from '@/engines/activity/persona';
import { batchEventFor, buildLogBatch } from '../store/log-batch';
import { loadLandingWorld, syncLandingsDb, writeLandingChanges } from '../store/landings';
import { applyChanges } from '@/lib/landings/model';
import { eventUpdatesView, patchEventUpdate, proposeEventUpdates } from '@/lib/landings/updates';
import { canvasWritesView, recordLandingsView, ucLandingsView } from '@/lib/landings/views';
import { fixEdits, labelsFor, pickEdit, UC_LEAVE } from '@/server/landings/ops';
import { batchSelectionOf } from '@/server/time/batch-canvases';
import { loadRowOverrides } from '../store/use-cases';
import { loadDcRequests, updateDcRequest } from '../store/dc-requests';
import { writeNeedDecision } from '../store/need-decisions';
import { patchedEntry } from '@/server/time/dismiss';
import { planNeedDecisions } from '@/server/deals/needs';
import { updateActivity } from '../store/time';
import { restagedCanvas } from '@/server/time/canvas-preflight';
import { assertReviewable, canvasReviewOf, checkedUpdateValue, checkedUseCaseFields, reviewRowOf, updateLineWith, ucCreateOfRow, withoutRows, withRowReplaced } from '@/server/time/canvas-review';
import { dcAddOf, dcAddRow, dcChangeRows, org62OppIdOf } from '@/server/deals/dc-requests';
import { eventLine } from '@/engines/activity/slackbot';
import { ucCreateLine, withUcOverride } from '@/engines/activity/use-cases';
import { ROW_OVERRIDES_KV, withRowOverride } from '@/lib/canvas/overrides';

export class DbCanvas {
  constructor(private readonly ctx: DbCtx) {}

  /**
   * Time ▸ "Log these" (and chat_log_batch stage): approved rows, plus complete proposed ones when asked, become
   * Slackbot work orders, one Outbox canvas item each (ready; sent only on its own Apply). The proposed rows the batch
   * takes are approved in the same change set, so Undo puts them back and removes the items. Rows an earlier batch's
   * item still holds are left out (`waiting`), so clicking twice never stages a row twice.
   */
  async stageLogBatch({ body }: I<'stageLogBatch'>): Promise<Res<'stageLogBatch'>> {
    const m = await this.ctx.model(WHOLE);
    const tz = m.settings().profile.timezone;
    const logging = m.settings().time.logging;
    // D-55: the persona's record type (SE: Solutions Event; AE: Sales Events), cached per record type
    const profile = loggingProfile(personaOf(m.settings()));
    const rtKv = recordTypeKv(profile.recordType);
    const recordTypeId = await resolveRecordTypeId({
      setting: logging.org62RecordTypeId,
      cached: (m.ctx.kv.get(rtKv) as string | undefined) ?? null,
      live: liveOrg62(),
      recordType: profile.recordType,
      save: async (id) => void (await this.ctx.mutate({ action: 'logging.record_type', summary: `Found the ${profile.recordTypeName} record type in Org62`, entity: { type: 'settings', id: 'logging' }, undoable: false }, async (w) => writeKv(w, rtKv, id))),
    });
    if (!recordTypeId) throw invalid(`The ${profile.recordTypeName} record type is not known yet: it is looked up in Org62 on the first batch (live), or set it in Settings ▸ Time ▸ Logging`);
    const now = this.ctx.now();
    // D-70: what you ticked (rows, use cases, Event updates); nothing ticked: everything ready
    const sel = batchSelectionOf(body);
    const b = await buildLogBatch(this.ctx.db, m.ctx.userId, { now, timezone: tz, approveComplete: body.includeProposed ?? logging.approveComplete, recordTypeId, held: canvasHolds(m.all('drafts')), logging: profile, ...(body.from ? { from: body.from } : {}), ...(body.to ? { to: body.to } : {}), ...(body.dcOnly ? { dcOnly: true } : {}), ...(sel.rows ? { ids: sel.rows } : {}), useCases: sel.useCases, eventUpdates: sel.updates });
    if (!b.canvases.length) return { entity: { draftIds: [], canvases: [], events: 0, hours: 0, approved: 0, skipped: b.skipped, waiting: b.waiting, useCases: b.useCases, eventUpdates: 0 }, auditId: null };
    if (!b.owner) throw invalid('Your Org62 user id is not set, so Slackbot would not know whose Events to create (onboarding ▸ Sources)');
    const at = now.toISOString();
    const items = b.canvases.map((c) => {
      const dest = canvasActionFor({ title: c.title, markdown: c.markdown, eventIds: c.eventIds, hours: c.hours, updates: c.updates, updateIds: c.updateIds, part: c.part, parts: c.parts });
      return { c, draft: actionDraftFor(dest, { id: crypto.randomUUID(), now: at, rendered: (doc) => renderAll(dest, doc) }) };
    });
    const approve = new Set(b.approveIds);
    const r = await this.ctx.mutate({ action: 'time.log_batch', summary: `Logging batch for approval: ${b.events} rows · ${b.hours} h${b.useCases.rows ? ` · ${b.useCases.rows} use case${b.useCases.rows === 1 ? '' : 's'}` : ''} in ${items.length} canvas${items.length === 1 ? '' : 'es'}`, entity: { type: 'draft', id: items[0]!.draft.id } }, async (w, model) => {
      for (const id of approve) {
        const cur = model.get('activity', id);
        if (cur && cur.status === 'proposed') await updateActivity(w, model.extra.vocab, cur, { ...cur, status: 'approved' }, { bump: true }, cur.accountName);
      }
      for (const { draft } of items) await insertDraft(w, draft);
      // D-70: the batch stages one write per canvas row (record_landings / landing_writes), in the same transaction
      await this.landingSyncIn(w, model, items.map((x) => x.draft));
    });
    this.ctx.bus.publishTables(['drafts', 'activity_entries', 'landing_writes'], items.map((x) => x.draft.id), 'time.log_batch');
    return {
      entity: {
        draftIds: items.map((x) => x.draft.id),
        canvases: items.map(({ c, draft }) => ({ draftId: draft.id, title: c.title, rows: c.eventIds.length, hours: c.hours, updates: c.updates })),
        events: b.events,
        hours: b.hours,
        approved: approve.size,
        skipped: b.skipped,
        waiting: b.waiting,
        useCases: b.useCases,
        eventUpdates: b.eventUpdates,
      },
      auditId: r.auditId,
    };
  }

  // ---- D-70 landings (docs/design/landings.md): where every record lands, and every write that put it there ----------

  /** One landing sync (the read model → the world → the pure pass → stored) and what the views read. */
  private async landings(o: { model?: ReadModel } = {}) {
    const m = o.model ?? (await this.ctx.model(WHOLE));
    const world = await loadLandingWorld(this.ctx.db, m.ctx.userId, m, this.ctx.now());
    const { store, useCaseByKey } = await syncLandingsDb(this.ctx.db, m.ctx.userId, world);
    const draftTitle = (id: string) => {
      const d = m.get('drafts', id);
      return d?.destination.kind === 'action' ? d.destination.target.label : null;
    };
    return { m, world, store, useCaseByKey, labelOf: labelsFor(world, store), draftTitle };
  }

  /** Inside a mutation (a batch staged): the sync runs in its transaction, on a savepoint, so it never fails the batch. */
  private async landingSyncIn(w: WriteCtx, model: ReadModel, drafts: Draft[]): Promise<void> {
    try {
      await w.tx.transaction(async (sp) => {
        const world = await loadLandingWorld(sp, w.userId, model, w.now, { drafts });
        await syncLandingsDb(sp, w.userId, world);
      });
    } catch {
      // the next sync (any landing read) stages them: every sync is the whole pass
    }
  }

  /** After a write elsewhere (a row taken off a canvas, a reject, a VDP push): the landings follow; never fails it. */
  async syncLandingsQuietly(reason: string): Promise<void> {
    try {
      await this.landings();
      this.ctx.bus.publishTables(['record_landings', 'landing_writes'], [], `landings.${reason}`);
    } catch {
      // the next sync catches up
    }
  }

  async getCanvasWrites({ params }: I<'getCanvasWrites'>): Promise<Res<'getCanvasWrites'>> {
    const L = await this.landings();
    const d = L.m.get('drafts', params.id) ?? null;
    if (!d && !L.store.writes.some((w) => w.draftId === params.id)) throw notFound('Logging canvas', params.id);
    return canvasWritesView(L.store, params.id, d, L.labelOf, L.draftTitle);
  }

  async getRecordLandings({ query }: I<'getRecordLandings'>): Promise<Res<'getRecordLandings'>> {
    const L = await this.landings();
    return recordLandingsView(L.store, query.kind, query.id, L.labelOf, L.draftTitle);
  }

  async getEventUpdates(_i: I<'getEventUpdates'>): Promise<Res<'getEventUpdates'>> {
    const L = await this.landings();
    return { updates: eventUpdatesView(L.store, (id) => L.m.get('activity', id)) };
  }

  async proposeEventUpdates({ body }: I<'proposeEventUpdates'>): Promise<Res<'proposeEventUpdates'>> {
    const L = await this.landings();
    const r = proposeEventUpdates(L.store, body.candidates, { now: this.ctx.now().toISOString(), newId: () => crypto.randomUUID(), activity: (id) => L.m.get('activity', id) });
    await writeLandingChanges(this.ctx.db, L.m.ctx.userId, r.changes);
    this.ctx.bus.publishTables(['landing_writes'], r.proposed, 'landings.propose');
    return { proposed: r.proposed, skipped: r.skipped };
  }

  async patchEventUpdate({ params, body }: I<'patchEventUpdate'>): Promise<Res<'patchEventUpdate'>> {
    const L = await this.landings();
    const r = patchEventUpdate(L.store, params.id, body.action, this.ctx.now().toISOString());
    if ('error' in r) throw r.error === 'not_found' ? notFound('Event update', params.id) : new AppError('conflict', r.why);
    await writeLandingChanges(this.ctx.db, L.m.ctx.userId, r.changes);
    this.ctx.bus.publishTables(['landing_writes'], [params.id], `landings.${body.action}`);
    const row = eventUpdatesView(applyChanges(L.store, r.changes), (id) => L.m.get('activity', id)).find((x) => x.writeId === params.id)!;
    return { entity: row, auditId: null };
  }

  private useCaseView(L: Awaited<ReturnType<DbCanvas['landings']>>) {
    return ucLandingsView({ store: L.store, world: L.world, useCaseByKey: L.useCaseByKey, accountName: (id) => L.m.get('accounts', id)?.name ?? null, labelOf: L.labelOf, draftTitle: L.draftTitle, readAt: L.world.useCases?.input.org62.readAt ?? null });
  }

  async getUseCaseLandings(_i: I<'getUseCaseLandings'>): Promise<Res<'getUseCaseLandings'>> {
    const v = this.useCaseView(await this.landings());
    // use cases to add: a question on a use case the app suggested carries the `suggested` marker (src/lib/canvas/prefill.ts)
    const sc = v.items.some((x) => x.question) ? await suggestedCandidates(this.ctx.db, await this.ctx.userId()).catch(() => []) : [];
    return sc.length ? { ...v, items: v.items.map((x) => ({ ...x, question: markSuggested(x.question, { title: x.title, accountId: x.accountId }, sc) })) } : v;
  }

  async pickUseCaseValue({ params, body }: I<'pickUseCaseValue'>): Promise<Res<'pickUseCaseValue'>> {
    const L = await this.landings();
    const view = this.useCaseView(L).items.find((x) => x.key === params.key);
    if (!view) throw notFound('Use case', params.key);
    const edit = pickEdit(view, L.world.useCases?.plan.items.find((x) => x.key === params.key), body);
    const label = body.take ? `${body.take === 'org62' ? 'Org62' : 'VDP'}’s ${body.field} is right for ${view.title}` : `Cleared your pick of ${view.title}’s ${body.field}`;
    const r = await this.ctx.mutate({ action: 'use_case.pick', summary: label.slice(0, 200), entity: { type: 'settings', id: 'use_cases' } }, async (w) => {
      await writeKv(w, ROW_OVERRIDES_KV, withRowOverride(await loadRowOverrides(w.tx, w.userId), edit.key, edit.fields, w.now.toISOString()));
    });
    this.ctx.bus.publishTables(['drafts', 'use_cases'], [params.key], 'use_case.pick');
    const after = this.useCaseView(await this.landings()).items.find((x) => x.key === params.key) ?? view;
    return { entity: after, auditId: r.undoable ? r.auditId : null };
  }

  async fixUseCase({ params, body }: I<'fixUseCase'>): Promise<Res<'fixUseCase'>> {
    const L = await this.landings();
    const view = this.useCaseView(L).items.find((x) => x.key === params.key);
    if (!view) throw notFound('Use case', params.key);
    const opps = (L.world.useCases?.input.opps ?? []).map((o) => ({ org62Id: o.org62Id, open: o.isOpen, mine100: o.dcSplit === 100 }));
    const { edit, leave } = fixEdits(L.world.useCases?.plan.items.find((x) => x.key === params.key), body, opps);
    const tz = L.m.settings().profile.timezone || L.m.meta().timezone;
    const r = await this.ctx.mutate({ action: 'use_case.fix', summary: (leave === true ? `Left ${view.title} out of Org62` : leave === false ? `${view.title} goes to Org62 again` : `Answered ${view.title}`).slice(0, 200), entity: { type: 'settings', id: 'use_cases' } }, async (w) => {
      if (edit) await writeKv(w, ROW_OVERRIDES_KV, withRowOverride(await loadRowOverrides(w.tx, w.userId), edit.key, edit.fields, w.now.toISOString()));
      if (leave === true) for (const d of planNeedDecisions({ rule: UC_LEAVE, subjectIds: [params.key], kind: 'not_needed', reason: 'Not for Org62', label: view.title }, w.now, L.m.all('opps'), tz)) await writeNeedDecision(w, d.rule, d.subjectId, d);
      if (leave === false) await writeNeedDecision(w, UC_LEAVE, params.key, null);
    });
    this.ctx.bus.publishTables(['drafts', 'use_cases', 'need_decisions'], [params.key], 'use_case.fix');
    const after = this.useCaseView(await this.landings()).items.find((x) => x.key === params.key) ?? view;
    return { entity: after, auditId: r.undoable ? r.auditId : null };
  }

  // ---- 2026-11-13 audit B2: the canvas review before Apply (src/server/time/canvas-review.ts) -----------------------

  private async canvasReview(draftId: string): Promise<Res<'getCanvasReview'>> {
    const m = await this.ctx.model(WHOLE);
    const d = this.ctx.ds.drafts.draft(m, draftId);
    const opp15 = new Map(m.all('opps').flatMap((o) => { const id = org62OppIdOf(o); return id ? [[id.slice(0, 15), o.name] as const] : []; }));
    return canvasReviewOf(d, { entry: (id) => m.get('activity', id), dcRequests: await loadDcRequests(this.ctx.db, m.ctx.userId), oppName: (id) => opp15.get(id.slice(0, 15)) ?? null, now: this.ctx.now() });
  }

  async getCanvasReview({ params }: I<'getCanvasReview'>): Promise<Res<'getCanvasReview'>> {
    return this.canvasReview(params.id);
  }

  /** Rows off the canvas before Apply: they go back to waiting (nothing holds them any more). One undoable change. */
  async removeCanvasRows({ params, body }: I<'removeCanvasRows'>): Promise<Res<'removeCanvasRows'>> {
    const r = await this.ctx.mutate({ action: 'canvas.rows.remove', summary: 'Took rows off a logging canvas', entity: { type: 'draft', id: params.id } }, async (w, model) => {
      const d = this.ctx.ds.drafts.draft(model, params.id);
      assertReviewable(d, body.ifVersion);
      const { input, removed } = withoutRows(canvasInputOfDest(d.destination as ActionDestination), body.keys);
      await w.tx.update(changeSets).set({ summary: `Took ${removed.length} row${removed.length === 1 ? '' : 's'} off ${d.destination.kind === 'action' ? d.destination.target.label : 'a canvas'}: back to waiting`.slice(0, 200) }).where(eq(changeSets.id, w.cs.id));
      await updateDraft(w, d, restagedCanvas(d, input), { bump: true, ifVersion: body.ifVersion });
    });
    this.ctx.bus.publishTables(['drafts', 'activity_entries', 'deal_contribution_requests'], [params.id], 'canvas.rows.remove');
    // D-70: the rows taken off keep their writes, as removed
    await this.syncLandingsQuietly('canvas.rows.remove');
    return { entity: await this.canvasReview(params.id), auditId: r.auditId };
  }

  /** One row edited before Apply: kept on its record, then its line written again. One undoable change. */
  async editCanvasRow({ params, body }: I<'editCanvasRow'>): Promise<Res<'editCanvasRow'>> {
    const m0 = await this.ctx.model(WHOLE);
    const profile = loggingProfile(personaOf(m0.settings()));
    const r = await this.ctx.mutate({ action: 'canvas.rows.edit', summary: 'Edited a logging canvas row', entity: { type: 'draft', id: params.id } }, async (w, model) => {
      const d = this.ctx.ds.drafts.draft(model, params.id);
      assertReviewable(d, body.ifVersion);
      const input = canvasInputOfDest(d.destination as ActionDestination);
      const row = reviewRowOf(input, body.key);
      const first = row.rows[0]!;
      let lines: string[];
      let what = 'a row';
      if (row.kind === 'event' && body.event) {
        const id = first.ref;
        const cur = id ? model.get('activity', id) : undefined;
        if (!cur) throw notFound('Activity entry', id ?? body.key);
        this.ctx.checkVersion(cur, body.event.entryVersion, 'Activity entry', cur);
        if (body.event.taskType !== undefined && profile.taskTypeRequired && !profile.taskTypes.includes(body.event.taskType)) throw invalid(`Not one of your task types: ${body.event.taskType}`);
        const patch = { ...(body.event.taskType !== undefined ? { taskType: body.event.taskType } : {}), ...(body.event.durationH !== undefined ? { durationH: body.event.durationH } : {}), ...(body.event.oppId !== undefined ? { oppId: body.event.oppId } : {}), ...(body.event.note !== undefined ? { logNote: body.event.note } : {}) };
        const opp = patch.oppId ? model.get('opps', patch.oppId) : undefined;
        if (patch.oppId && !opp) throw notFound('Opportunity', patch.oppId);
        const { next, newLocks } = patchedEntry(cur, patch, opp ? { name: opp.name, accountName: model.get('accounts', opp.accountId)?.name ?? null } : null);
        const oppAccount = next.oppId ? (model.get('accounts', model.get('opps', next.oppId)?.accountId ?? '')?.name ?? null) : null;
        // the row stays on this canvas as edited (not unstaged: TL-25 is for edits made elsewhere)
        await updateActivity(w, model.extra.vocab, cur, next, { bump: true, ifVersion: body.event.entryVersion, lock: newLocks }, oppAccount);
        const ev = await batchEventFor(w.tx, w.userId, cur.id, profile);
        if ('why' in ev) throw invalid(`That edit leaves the row unable to log: it ${ev.why}`);
        lines = [eventLine(Number(first.cells[0]) || 1, ev.event)];
        what = cur.description;
      } else if ((row.kind === 'dc' || row.kind === 'dcchange') && body.dc) {
        const review = canvasReviewOf(d, { entry: (x) => model.get('activity', x), dcRequests: await loadDcRequests(w.tx, w.userId), now: w.now });
        const reqId = review.dcs.find((x) => x.key === body.key)?.requestId;
        const cur = reqId ? (await loadDcRequests(w.tx, w.userId)).find((x) => x.id === reqId) : undefined;
        if (!cur) throw notFound('DC request', body.key);
        if (cur.kind === 'change' && body.dc.split !== undefined && cur.dc?.split === body.dc.split) throw invalid(`Your DC is at ${body.dc.split}% already: remove the row instead`);
        await updateDcRequest(w, cur.id, { ...(body.dc.split !== undefined ? { splitPercent: body.dc.split } : {}), ...(body.dc.role !== undefined ? { role: body.dc.role } : {}), ...(body.dc.comment !== undefined ? { comment: body.dc.comment } : {}) });
        const add = dcAddOf({ ...cur, splitPercent: body.dc.split ?? cur.splitPercent, role: body.dc.role ?? cur.role, comment: body.dc.comment ?? cur.comment, org62OpportunityId: cur.org62OpportunityId ?? first.cells[7] ?? null });
        const n = Number(first.cells[0]) || 1;
        lines = cur.kind === 'change' ? dcChangeRows(add).map((f, k) => f(n + k)) : [dcAddRow(n, add)];
        what = `the DC on ${cur.oppName}`;
      } else if (row.kind === 'use_case' && body.useCase) {
        const fields = checkedUseCaseFields(body.useCase);
        const key = body.key;
        await writeKv(w, ROW_OVERRIDES_KV, withRowOverride(await loadRowOverrides(w.tx, w.userId), key, fields, w.now.toISOString()));
        const c = withUcOverride(ucCreateOfRow(first), { fields });
        lines = [ucCreateLine(Number(first.cells[0]) || 1, c)];
        what = `the use case ${c.name}`;
      } else if (row.kind === 'update' && body.update) {
        const v = checkedUpdateValue(first, body.update.newValue);
        await writeKv(w, ROW_OVERRIDES_KV, withRowOverride(await loadRowOverrides(w.tx, w.userId), body.key, { newValue: v }, w.now.toISOString()));
        lines = [updateLineWith(first, v)];
        what = `${first.cells[3]} on ${first.cells[2]}`;
      } else throw invalid(`That edit does not fit this row (a ${row.kind.replace('dcchange', 'DC change').replace('_', ' ')} row)`);
      await w.tx.update(changeSets).set({ summary: `Edited ${what} on ${d.destination.kind === 'action' ? d.destination.target.label : 'a canvas'}`.slice(0, 200) }).where(eq(changeSets.id, w.cs.id));
      await updateDraft(w, d, restagedCanvas(d, withRowReplaced(input, body.key, lines)), { bump: true, ifVersion: body.ifVersion });
    });
    this.ctx.bus.publishTables(['drafts', 'activity_entries', 'deal_contribution_requests'], [params.id], 'canvas.rows.edit');
    await this.syncLandingsQuietly('canvas.rows.edit');
    return { entity: await this.canvasReview(params.id), auditId: r.auditId };
  }
}
