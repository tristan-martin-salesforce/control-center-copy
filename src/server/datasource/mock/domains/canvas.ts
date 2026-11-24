/**
 * The mock DataSource, canvas domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id, I, Res } from '../shared';
import { eventLine, eventRow, type WorkOrderEvent } from '@/engines/activity/slackbot';
import { heldNotOnTeam, NOT_ON_TEAM_SKIP } from '@/engines/activity/classify';
import { loggingProfile } from '@/engines/activity/persona';
import { personaOf, featureActive } from '@/personas';
import { canvasActionFor, canvasHolds, canvasInputOf } from '@/lib/canvas/payload';
import { batchCanvases, batchSelectionOf, batchSpan } from '@/server/time/batch-canvases';
import { applyChanges, EMPTY_STORE, type LandingStore } from '@/lib/landings/model';
import { syncLandings, type LandingWorld } from '@/lib/landings/sync';
import { eventUpdatesForBatch, eventUpdatesView, patchEventUpdate, proposeEventUpdates } from '@/lib/landings/updates';
import { canvasWritesView, recordLandingsView, ucLandingsView } from '@/lib/landings/views';
import { fixEdits, labelsFor, pickEdit, UC_LEAVE } from '@/server/landings/ops';
import type { ActionDestination } from '@/contract';
import { AppError, invalid, notFound } from '@/server/errors';
import { planNeedDecisions } from '@/server/deals/needs';
import { needKey } from '@/lib/need-decisions';
import { patchedEntry } from '@/server/time/dismiss';
import { planUseCases, ucCreateLine, withUcOverride } from '@/engines/activity/use-cases';
import { dcAddOf, dcAddRow, dcChangeRows, type DcRequestRecord } from '@/server/deals/dc-requests';
import { LOG_AGAIN_FLAG } from '@/engines/activity/org62-check';
import { restagedCanvas } from '@/server/time/canvas-preflight';
import { assertReviewable, canvasReviewOf, checkedUpdateValue, checkedUseCaseFields, reviewRowOf, updateLineWith, ucCreateOfRow, withoutRows, withRowReplaced } from '@/server/time/canvas-review';
import { renderAll } from '../render';
import { actionDraftFor } from '@/server/vdp/coverage';
import { markSuggested } from '@/lib/canvas/prefill';
import { Tx, type Collections } from '../store';
import { activityStamps } from '../../activity-log';
import { mockOrg62AccountIdFor, mockOrg62IdFor } from '@/mock/org62-opps';
import { accountTargetWhat, org62AccountIdOfUrl } from '@/engines/attribution/target';

export class MockCanvas {
  constructor(private readonly ctx: MockCtx) {}

  /**
   * Time ▸ "Log these" in mock mode: the same work orders and Outbox canvas items as the db, over the store's rows,
   * with placeholder Org62 ids (the seed has none). Nothing leaves: the simulated transport answers an Apply.
   */
  async stageLogBatch({ body }: I<'stageLogBatch'>): Promise<Res<'stageLogBatch'>> {
    const s = this.ctx.store.settings();
    const tz = s.profile.timezone;
    const logging = s.time.logging ?? { approveComplete: true };
    const takeProposed = body.includeProposed ?? logging.approveComplete;
    const profile = loggingProfile(personaOf(s));
    const now = this.ctx.now();
    const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    const events: WorkOrderEvent[] = [];
    const approve: string[] = [];
    const skipped: Array<{ id: string; date: string; description: string; why: string }> = [];
    const held = canvasHolds(this.ctx.store.all('drafts'));
    const waiting = { rows: 0, hours: 0, draftIds: new Set<string>() };
    // D-70: what you ticked (rows, use cases, Event updates); nothing ticked: everything ready
    const sel = batchSelectionOf(body);
    const only = sel.rows;
    for (const e of body.dcOnly ? [] : [...this.ctx.store.all('activity')].sort((a, b) => a.start.localeCompare(b.start))) {
      if (Date.parse(e.end) > now.getTime() || !(e.status === 'approved' || (takeProposed && e.status === 'proposed'))) continue;
      // Log it ▸ the rows you ticked: only those (each still has to be ready)
      if (only && !only.has(e.id)) continue;
      const date = dayOf(e.start);
      if ((body.from && date < body.from) || (body.to && date > body.to)) continue;
      // already handed off by a sent canvas (the db also skips a row whose synced_to_canvas_at is set)
      // D-65: unless you put it back with Log again (not in Org62 after all, TL-14 / TL-20)
      if (held.sent?.has(e.id) && !e.issues.includes(LOG_AGAIN_FLAG)) continue;
      const holder = held.rows.get(e.id);
      if (holder) {
        waiting.rows += 1;
        waiting.hours += e.durationH;
        waiting.draftIds.add(holder);
        continue;
      }
      // a proposed row on an opp I'm not on waits for the user's own Approve (the db's buildLogBatch, same rule)
      if (e.status === 'proposed' && heldNotOnTeam(e.issues)) {
        skipped.push({ id: e.id, date, description: e.description, why: NOT_ON_TEAM_SKIP });
        continue;
      }
      // D-64: an internal row waits for your own Log; once approved it logs with Related To empty
      if (e.status === 'proposed' && e.internal) continue;
      // D-55: only a persona whose logging needs one (the SE's Solutions Events) asks for an SE task type
      const needsType = profile.taskTypeRequired && !e.taskType;
      if (needsType || (!e.oppId && !e.accountId && !e.internal)) {
        skipped.push({ id: e.id, date, description: e.description, why: `needs ${[needsType ? 'an SE task type' : null, !e.oppId && !e.accountId ? 'a WhatId (opportunity or account)' : null].filter(Boolean).join(' and ')}` });
        continue;
      }
      if (e.status === 'proposed') approve.push(e.id);
      events.push(this.workOrderEventOf(e, profile.taskTypeRequired));
    }
    const wait = { rows: waiting.rows, hours: waiting.hours, draftIds: [...waiting.draftIds] };
    // D-58: pending Deal Contribution requests ride on the batch as ADD rows (src/server/deals/dc-requests.ts)
    // ...on a canvas with rows; a canvas of their own only when asked (dcOnly: Log DCs now)
    const dcAdds = this.ctx.ds.deals.pendingDcAdds();
    // D-70: use cases are rows (they log on their own; the ticked ones only when you ticked some), and approved Event
    // updates ride in the UPDATE table ("update · Duration 2 h → 3 h")
    const plan0 = !body.dcOnly && featureActive(personaOf(s), 'vdp') ? planUseCases(this.ctx.ds.deals.ucPlanInput()) : { creates: [], updates: [] };
    // use cases to add: accepted candidates' Org62 rows ride too (mock/use-cases.ts; the plan's twins of them are left out)
    const planAll = { creates: !body.dcOnly && featureActive(personaOf(s), 'vdp') ? this.ctx.ds.useCases.canvasRows(plan0.creates) : plan0.creates, updates: plan0.updates };
    const ucOnly = sel.useCases;
    const plan = ucOnly ? { creates: planAll.creates.filter((c) => ucOnly.has(`uc:${c.vdpUseCaseId}`)), updates: planAll.updates.filter((u) => ucOnly.has(`uc:${u.vdpUseCaseId}`)) } : planAll;
    const evUpdates = body.dcOnly ? [] : eventUpdatesForBatch(this.landingStore, { approveComplete: takeProposed, only: sel.updates }).filter((u) => !held.updates.has(u.recordId));
    const updates = evUpdates.map(({ writeId: _w, ...u }) => u);
    const none = { entity: { draftIds: [], canvases: [], events: 0, hours: 0, approved: 0, skipped, waiting: wait, useCases: { rows: 0, later: 0 }, eventUpdates: 0 }, auditId: null };
    if (!events.length && !updates.length && !plan.creates.length && !plan.updates.length && !(body.dcOnly && dcAdds.length)) return none;
    const base = { ownerName: s.profile.name, ownerOrg62Id: '005XX0000000MOCKAA', recordTypeId: '012XX0000000MOCKAA', generatedAt: now.toISOString(), sourceLabel: 'Command Center (mock)', logging: { recordTypeName: profile.recordTypeName, taskTypeRequired: profile.taskTypeRequired } };
    // 2026-11-13 (B1): ONE canvas per batch: the rows, the DCs and (D-67) the VDP use cases; parts only past Slack's limit
    const span = batchSpan(events.map((e) => dayOf(e.startUtc))) ?? (updates.length ? 'Duration fixes' : null);
    const b = batchCanvases(base, { events, updates, dcs: dcAdds, ucCreates: plan.creates, ucUpdates: plan.updates }, { span, ...(body.dcOnly ? { dcOnly: true } : {}) });
    const uc = b.useCases;
    const canvases = b.canvases;
    if (!canvases.length) return none;
    const items = canvases.map((c) => {
      const dest = canvasActionFor({ title: c.title, markdown: c.markdown, eventIds: c.eventIds, hours: c.hours, updates: c.updates, updateIds: c.updateIds, part: c.part, parts: c.parts });
      return { title: c.title, hours: c.hours, rows: c.eventIds.length, updates: c.updates, draft: actionDraftFor(dest, { id: id('d'), now: this.ctx.nowIso(), rendered: (doc) => renderAll(dest, doc) }) };
    });
    const { entry } = this.ctx.tx({ actor: 'user', action: 'time.log_batch', summary: `Logging batch for approval: ${events.length} rows${dcAdds.length ? ` · ${dcAdds.length} DC${dcAdds.length === 1 ? '' : 's'}` : ''}${uc.rows ? ` · ${uc.rows} use case${uc.rows === 1 ? '' : 's'}` : ''}`, entity: { type: 'draft', id: items[0]!.draft.id, label: items[0]!.title } }, (tx) => {
      for (const aid of approve) {
        const cur = this.ctx.store.get('activity', aid);
        if (cur) tx.put('activity', this.ctx.bump({ ...cur, status: 'approved' }));
      }
      for (const x of items) tx.put('drafts', x.draft);
    });
    // D-70: the batch stages one write per canvas row (the db does it in the batch's transaction)
    this.landings();
    return {
      entity: { draftIds: items.map((x) => x.draft.id), canvases: items.map((x) => ({ draftId: x.draft.id, title: x.title, rows: x.rows, hours: x.hours, updates: x.updates })), events: events.length, hours: events.reduce((t, e) => t + e.durationH, 0), approved: approve.length, skipped, waiting: wait, useCases: { rows: uc.rows, later: uc.later }, eventUpdates: evUpdates.length },
      auditId: entry?.id ?? null,
    };
  }

  // ---- D-70 landings (docs/design/landings.md): the db's twin over memory (src/lib/landings) -------------------------

  /** The landings (not part of the undoable store, like the db's unaudited tables): reset with the store. */
  landingStore: LandingStore = EMPTY_STORE;
  private landingWorld(): LandingWorld {
    const persona = personaOf(this.ctx.store.settings());
    const vdp = featureActive(persona, 'vdp');
    const input = vdp ? this.ctx.ds.deals.ucPlanInput() : null;
    return {
      now: this.ctx.nowIso(),
      drafts: this.ctx.store.all('drafts'),
      activity: this.ctx.store.all('activity'),
      dcRequests: featureActive(persona, 'dealContributions') ? this.ctx.ds.deals.dcRequests() : [],
      useCases: input ? { plan: planUseCases(input), input } : null,
      candidates: vdp ? this.ctx.ds.vdp.vdpCandidates() : [],
    };
  }
  /** One landing sync over the store, and what the views read. */
  landings() {
    const world = this.landingWorld();
    const r = syncLandings(this.landingStore, world, { newId: () => globalThis.crypto.randomUUID() });
    this.landingStore = applyChanges(this.landingStore, r.changes);
    const store = this.landingStore;
    const draftTitle = (did: string) => {
      const d = this.ctx.store.get('drafts', did);
      return d?.destination.kind === 'action' ? d.destination.target.label : null;
    };
    return { world, store, useCaseByKey: r.useCaseByKey, labelOf: labelsFor(world, store), draftTitle };
  }
  private useCaseView(L: ReturnType<MockCanvas['landings']>) {
    return ucLandingsView({ store: L.store, world: L.world, useCaseByKey: L.useCaseByKey, accountName: (aid) => this.ctx.store.get('accounts', aid)?.name ?? null, labelOf: L.labelOf, draftTitle: L.draftTitle, readAt: L.world.useCases?.input.org62.readAt ?? null });
  }

  async getCanvasWrites({ params }: I<'getCanvasWrites'>): Promise<Res<'getCanvasWrites'>> {
    const L = this.landings();
    const d = this.ctx.store.get('drafts', params.id) ?? null;
    if (!d && !L.store.writes.some((w) => w.draftId === params.id)) throw notFound('Logging canvas', params.id);
    return canvasWritesView(L.store, params.id, d, L.labelOf, L.draftTitle);
  }

  async getRecordLandings({ query }: I<'getRecordLandings'>): Promise<Res<'getRecordLandings'>> {
    const L = this.landings();
    return recordLandingsView(L.store, query.kind, query.id, L.labelOf, L.draftTitle);
  }

  async getEventUpdates(_i: I<'getEventUpdates'>): Promise<Res<'getEventUpdates'>> {
    const L = this.landings();
    return { updates: eventUpdatesView(L.store, (aid) => this.ctx.store.get('activity', aid)) };
  }

  async proposeEventUpdates({ body }: I<'proposeEventUpdates'>): Promise<Res<'proposeEventUpdates'>> {
    const L = this.landings();
    const r = proposeEventUpdates(L.store, body.candidates, { now: this.ctx.nowIso(), newId: () => globalThis.crypto.randomUUID(), activity: (aid) => this.ctx.store.get('activity', aid) });
    this.landingStore = applyChanges(this.landingStore, r.changes);
    this.ctx.publish(['time', 'deals'], r.proposed, 'landings.propose');
    return { proposed: r.proposed, skipped: r.skipped };
  }

  async patchEventUpdate({ params, body }: I<'patchEventUpdate'>): Promise<Res<'patchEventUpdate'>> {
    const L = this.landings();
    const r = patchEventUpdate(L.store, params.id, body.action, this.ctx.nowIso());
    if ('error' in r) throw r.error === 'not_found' ? notFound('Event update', params.id) : new AppError('conflict', r.why);
    this.landingStore = applyChanges(this.landingStore, r.changes);
    this.ctx.publish(['time', 'deals'], [params.id], `landings.${body.action}`);
    const row = eventUpdatesView(this.landingStore, (aid) => this.ctx.store.get('activity', aid)).find((x) => x.writeId === params.id)!;
    return { entity: row, auditId: null };
  }

  async getUseCaseLandings(_i: I<'getUseCaseLandings'>): Promise<Res<'getUseCaseLandings'>> {
    const v = this.useCaseView(this.landings());
    // use cases to add: a question on a use case the app suggested carries the `suggested` marker (src/lib/canvas/prefill.ts)
    const sc = v.items.some((x) => x.question) ? this.ctx.ds.useCases.suggested() : [];
    return sc.length ? { ...v, items: v.items.map((x) => ({ ...x, question: markSuggested(x.question, { title: x.title, accountId: x.accountId }, sc) })) } : v;
  }

  async pickUseCaseValue({ params, body }: I<'pickUseCaseValue'>): Promise<Res<'pickUseCaseValue'>> {
    const L = this.landings();
    const view = this.useCaseView(L).items.find((x) => x.key === params.key);
    if (!view) throw notFound('Use case', params.key);
    const edit = pickEdit(view, L.world.useCases?.plan.items.find((x) => x.key === params.key), body);
    const label = body.take ? `${body.take === 'org62' ? 'Org62' : 'VDP'}’s ${body.field} is right for ${view.title}` : `Cleared your pick of ${view.title}’s ${body.field}`;
    const had = this.ctx.store.get('rowOverrides', edit.key);
    const { entry } = this.ctx.tx({ actor: 'user', action: 'use_case.pick', summary: label.slice(0, 200), entity: { type: 'settings', id: 'use_cases', label: view.title } }, (tx) => tx.put('rowOverrides', { key: edit.key, fields: { ...(had?.fields ?? {}), ...edit.fields }, at: this.ctx.nowIso() }));
    const after = this.useCaseView(this.landings()).items.find((x) => x.key === params.key) ?? view;
    return { entity: after, auditId: entry?.id ?? null };
  }

  async fixUseCase({ params, body }: I<'fixUseCase'>): Promise<Res<'fixUseCase'>> {
    const L = this.landings();
    const view = this.useCaseView(L).items.find((x) => x.key === params.key);
    if (!view) throw notFound('Use case', params.key);
    const opps = (L.world.useCases?.input.opps ?? []).map((o) => ({ org62Id: o.org62Id, open: o.isOpen, mine100: o.dcSplit === 100 }));
    const { edit, leave } = fixEdits(L.world.useCases?.plan.items.find((x) => x.key === params.key), body, opps);
    const tz = this.ctx.store.settings().profile.timezone || this.ctx.store.meta().timezone;
    const decisions = leave === true ? planNeedDecisions({ rule: UC_LEAVE, subjectIds: [params.key], kind: 'not_needed', reason: 'Not for Org62', label: view.title }, this.ctx.now(), this.ctx.store.all('opps'), tz) : [];
    const had = edit ? this.ctx.store.get('rowOverrides', edit.key) : undefined;
    const { entry } = this.ctx.tx({ actor: 'user', action: 'use_case.fix', summary: (leave === true ? `Left ${view.title} out of Org62` : leave === false ? `${view.title} goes to Org62 again` : `Answered ${view.title}`).slice(0, 200), entity: { type: 'settings', id: 'use_cases', label: view.title } }, (tx) => {
      if (edit) tx.put('rowOverrides', { key: edit.key, fields: { ...(had?.fields ?? {}), ...edit.fields }, at: this.ctx.nowIso() });
      for (const d of decisions) tx.put('needDecisions', d);
      if (leave === false && this.ctx.store.get('needDecisions', needKey(UC_LEAVE, params.key))) tx.remove('needDecisions', needKey(UC_LEAVE, params.key));
    });
    const after = this.useCaseView(this.landings()).items.find((x) => x.key === params.key) ?? view;
    return { entity: after, auditId: entry?.id ?? null };
  }

  /** A Time row's Event as a batch writes it (the db's batchEventOf): its note then the CC# key, the opp's placeholder id. */
  private workOrderEventOf(e: Collections['activity'], taskTypeRequired: boolean): WorkOrderEvent {
    // D-66: the row's note (yours, or the seed's draft), then the CC# key; none: one from the row's fields
    const origin = e.sources.some((x) => x.kind === 'calendar') || !e.sources.length ? 'calendar' : 'evidence';
    return eventRow({ id: e.id, subject: e.description, start: e.start, end: e.end, durationH: e.durationH, taskType: taskTypeRequired ? (e.taskType ?? '') : '', whatOrg62Id: e.oppId ? (this.ctx.store.get('opps', e.oppId)?.org62Url?.match(/\/(006\w{12,15})\//)?.[1] ?? mockOrg62IdFor(e.oppId)) : e.accountId ? (accountTargetWhat(org62AccountIdOfUrl(this.ctx.store.get('accounts', e.accountId)?.org62Url))?.whatId ?? mockOrg62AccountIdFor(e.accountId)) : '', origin, note: e.logNote, customer: e.accountName });
  }

  // ---- 2026-11-13 audit B2: the canvas review before Apply (the db's twin; src/server/time/canvas-review.ts) -------

  private canvasReview(draftId: string): Res<'getCanvasReview'> {
    const d = this.ctx.store.must('drafts', draftId, 'Draft');
    const names = new Map(this.ctx.store.all('opps').map((o) => [this.ctx.ds.deals.org62OppIdOf(o).slice(0, 15), o.name] as const));
    return canvasReviewOf(d, { entry: (id) => this.ctx.store.get('activity', id), dcRequests: this.ctx.ds.deals.dcRequests(), oppName: (id) => names.get(id.slice(0, 15)) ?? null, now: this.ctx.now() });
  }

  async getCanvasReview({ params }: I<'getCanvasReview'>): Promise<Res<'getCanvasReview'>> {
    return this.canvasReview(params.id);
  }

  async removeCanvasRows({ params, body }: I<'removeCanvasRows'>): Promise<Res<'removeCanvasRows'>> {
    const d = this.ctx.store.must('drafts', params.id, 'Draft');
    assertReviewable(d, body.ifVersion);
    const { input, removed } = withoutRows(canvasInputOf(d.destination as ActionDestination), body.keys);
    const label = (d.destination as ActionDestination).target.label;
    const { entry } = this.ctx.tx({ actor: 'user', action: 'canvas.rows.remove', summary: `Took ${removed.length} row${removed.length === 1 ? '' : 's'} off ${label}: back to waiting`.slice(0, 200), entity: { type: 'draft', id: d.id, label } }, (tx) => tx.put('drafts', this.ctx.bump(restagedCanvas(d, input))));
    // D-70: the rows taken off keep their writes, as removed
    this.landings();
    return { entity: this.canvasReview(d.id), auditId: entry?.id ?? null };
  }

  async editCanvasRow({ params, body }: I<'editCanvasRow'>): Promise<Res<'editCanvasRow'>> {
    const d = this.ctx.store.must('drafts', params.id, 'Draft');
    assertReviewable(d, body.ifVersion);
    const profile = loggingProfile(personaOf(this.ctx.store.settings()));
    const input = canvasInputOf(d.destination as ActionDestination);
    const row = reviewRowOf(input, body.key);
    const first = row.rows[0]!;
    const n = Number(first.cells[0]) || 1;
    const label = (d.destination as ActionDestination).target.label;
    const puts: Array<(tx: Tx) => void> = [];
    let lines: string[];
    let what = 'a row';
    if (row.kind === 'event' && body.event) {
      const cur = this.ctx.store.must('activity', first.ref ?? body.key, 'Activity entry');
      this.ctx.checkVersion(cur, body.event.entryVersion, 'Activity entry', cur);
      if (body.event.taskType !== undefined && profile.taskTypeRequired && !profile.taskTypes.includes(body.event.taskType)) throw invalid(`Not one of your task types: ${body.event.taskType}`);
      const patch = { ...(body.event.taskType !== undefined ? { taskType: body.event.taskType } : {}), ...(body.event.durationH !== undefined ? { durationH: body.event.durationH } : {}), ...(body.event.oppId !== undefined ? { oppId: body.event.oppId } : {}), ...(body.event.note !== undefined ? { logNote: body.event.note } : {}) };
      const opp = patch.oppId ? this.ctx.store.must('opps', patch.oppId, 'Opportunity') : undefined;
      const next = activityStamps(this.ctx.bump(patchedEntry(cur, patch, opp ? { name: opp.name, accountName: this.ctx.store.get('accounts', opp.accountId)?.name ?? null } : null).next));
      if ((profile.taskTypeRequired && !next.taskType) || (!next.oppId && !next.accountId && !next.internal)) throw invalid(`That edit leaves the row unable to log: it needs ${profile.taskTypeRequired && !next.taskType ? 'an SE task type' : 'a WhatId (opportunity or account)'}`);
      // the row stays on this canvas as edited (not unstaged: TL-25 is for edits made elsewhere)
      puts.push((tx) => tx.put('activity', next));
      lines = [eventLine(n, this.workOrderEventOf(next, profile.taskTypeRequired))];
      what = cur.description;
    } else if ((row.kind === 'dc' || row.kind === 'dcchange') && body.dc) {
      const reqId = this.canvasReview(d.id).dcs.find((x) => x.key === body.key)?.requestId;
      const rec = reqId ? this.ctx.store.get('dcRequests', reqId) : undefined;
      const view = reqId ? this.ctx.ds.deals.dcRequests().find((x) => x.id === reqId) : undefined;
      if (!rec || !view) throw notFound('DC request', body.key);
      if (view.kind === 'change' && body.dc.split !== undefined && view.dc?.split === body.dc.split) throw invalid(`Your DC is at ${body.dc.split}% already: remove the row instead`);
      const next: DcRequestRecord = { ...rec, ...(body.dc.split !== undefined ? { splitPercent: body.dc.split } : {}), ...(body.dc.role !== undefined ? { role: body.dc.role } : {}), ...(body.dc.comment !== undefined ? { comment: body.dc.comment } : {}), updatedAt: this.ctx.nowIso() };
      puts.push((tx) => tx.put('dcRequests', next));
      const add = dcAddOf({ ...view, splitPercent: next.splitPercent, role: next.role, comment: next.comment, org62OpportunityId: view.org62OpportunityId ?? mockOrg62IdFor(view.oppId) });
      lines = view.kind === 'change' ? dcChangeRows(add).map((f, k) => f(n + k)) : [dcAddRow(n, add)];
      what = `the DC on ${view.oppName}`;
    } else if (row.kind === 'use_case' && body.useCase) {
      const fields = checkedUseCaseFields(body.useCase);
      const had = this.ctx.store.get('rowOverrides', body.key);
      puts.push((tx) => tx.put('rowOverrides', { key: body.key, fields: { ...(had?.fields ?? {}), ...fields }, at: this.ctx.nowIso() }));
      const c = withUcOverride(ucCreateOfRow(first), { fields });
      lines = [ucCreateLine(n, c)];
      what = `the use case ${c.name}`;
    } else if (row.kind === 'update' && body.update) {
      const v = checkedUpdateValue(first, body.update.newValue);
      puts.push((tx) => tx.put('rowOverrides', { key: body.key, fields: { newValue: v }, at: this.ctx.nowIso() }));
      lines = [updateLineWith(first, v)];
      what = `${first.cells[3]} on ${first.cells[2]}`;
    } else throw invalid(`That edit does not fit this row (a ${row.kind.replace('dcchange', 'DC change').replace('_', ' ')} row)`);
    const draft = this.ctx.bump(restagedCanvas(d, withRowReplaced(input, body.key, lines)));
    const { entry } = this.ctx.tx({ actor: 'user', action: 'canvas.rows.edit', summary: `Edited ${what} on ${label}`.slice(0, 200), entity: { type: 'draft', id: d.id, label } }, (tx) => {
      for (const p of puts) p(tx);
      tx.put('drafts', draft);
    });
    this.landings();
    return { entity: this.canvasReview(d.id), auditId: entry?.id ?? null };
  }
}
