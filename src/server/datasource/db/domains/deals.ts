/**
 * The db DataSource, deals domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res, promotedAs, blankItem } from '../shared';
import { and, eq, sql } from 'drizzle-orm';
import { type AccountDetail, type AccountRow, type ClaimMissedRequest, type DcRequest, type DealsNeed, type MissedOpp, type WorkItemRecord, dcRoleFor, type AddedOrg62Opp } from '@/contract';
import { accounts as accountsTable, changeSets, opportunities as opportunitiesTable } from '@/db/schema';
import { featureActive, personaOf } from '@/personas';
import { AppError, invalid, notFound } from '@/server/errors';
import { receiptFromChangeSet } from '../audit';
import { uuidFor } from '../ids';
import { upsertAccountFromOrg62, upsertOpportunityFromOrg62 } from '../store/projections';
import type { Org62Row } from '@/server/chat/org62';
import { org62RecordUrl } from '@/projections/links';
import type { ReadModel } from '../model';
import { accountScope, DEALS } from '../reads/scope';
import { pageOf } from '../reads/page';
import type { WriteCtx } from '../store/common';
import { updateFinding } from '../store/misc';
import { loadUseCaseSync } from '../store/use-cases';
import { insertDcRequest, loadDcRequestStatuses, loadDcRequests, loadMyDcs, updateDcRequest } from '../store/dc-requests';
import { loadVdpOppIds } from '../store/deals-sync';
import { needDecisionsOf, writeNeedDecision } from '../store/need-decisions';
import { missedDismissal, missedShown, type MissedSource } from '@/server/deals/dismissals';
import { dbCallsOf } from '../attribution';
import { dealsNeedsFor, withMyDcFlag } from '@/server/deals/needs';
import { buildDealsPipeline, pipelineBasisOf } from '@/server/deals/pipeline';
import { loadForecastRecords } from '@/server/forecast/store';
import { assertDcEditable, claimComment, DC_INACTIVE, planWithdrawDcs, dcLiveConflict, dcOppNotFound, dcOppNotInOrg62, dcRequestWords, liveDcRequest, ORG62_OPP_ID, planDcRequest, type DcRequestRecord } from '@/server/deals/dc-requests';
import { insertWorkItem } from '../store/work';
import { hydrateItem } from '../views';
import { accountRows } from '@/server/views/deals';

export class DbDeals {
  constructor(private readonly ctx: DbCtx) {}

  /**
   * Store one Org62 Opportunity the app doesn't track (and its account, when the app lacks it) inside a change set:
   * an account the app has keeps its own record (an upsert would reset its DC status and hours). The read does not
   * say whether I am on its team: the next Org62 scan turns membership on if I am.
   */
  async putOrg62Opp(w: WriteCtx, rec: Org62Row): Promise<{ id: string; accountName: string | null }> {
    let accountId: string | null = null;
    let accountName: string | null = rec.account ?? null;
    if (rec.accountOrg62Id) {
      const acctKey = rec.accountOrg62Id.slice(0, 15);
      const [a] = await w.tx
        .select({ id: accountsTable.id, name: accountsTable.name })
        .from(accountsTable)
        .where(and(eq(accountsTable.ownerUserId, w.userId), sql`left(${accountsTable.org62AccountId}, 15) = ${acctKey}`));
      accountId = a?.id ?? (await upsertAccountFromOrg62(w, { org62AccountId: rec.accountOrg62Id, name: rec.account ?? rec.accountOrg62Id, ext: { org62Url: org62RecordUrl('Account', rec.accountOrg62Id)!, dcStatus: 'none', hoursQtd: 0 } }, uuidFor(`proj:account:${w.userId}:${rec.accountOrg62Id}`))).id;
      accountName = a?.name ?? accountName;
    }
    const o = await upsertOpportunityFromOrg62(
      w,
      {
        org62OpportunityId: rec.org62Id,
        accountId,
        name: rec.name,
        stage: rec.stage ?? null,
        amount: rec.amount ?? null,
        closeDate: rec.closeDate ?? null,
        forecastCategory: rec.forecast ?? null,
        type: rec.type ?? null,
        isClosed: rec.open === false,
        isWon: rec.won === true,
        onMyTeam: false,
        myTeamRole: null,
        org62ModifiedAt: null,
        ext: { dcAssigned: false, nextStep: null, org62Url: org62RecordUrl('Opportunity', rec.org62Id)!, hoursQtd: 0 },
      },
      uuidFor(`proj:opportunity:${w.userId}:${rec.org62Id}`),
    );
    return { id: o.id, accountName };
  }

  /** Org62 Opportunities by id, one read (live only behind the Assistant's gate and day budget: pickerOrg62). */
  private async org62OppsByIds(ids: readonly string[]): Promise<Org62Row[]> {
    const r = await this.ctx.ds.be6.pickerOrg62({ byIds: ids });
    if (!r.live) throw new AppError('upstream_unavailable', r.notes[0] ?? 'Org62 is not available here', undefined, false);
    if (!r.rows.length && r.notes.some((n) => /did not finish|budget/i.test(n))) throw new AppError('upstream_unavailable', r.notes[0]!, undefined, true);
    return r.rows;
  }

  async getDeals(i: I<'getDeals'>): Promise<Res<'getDeals'>> {
    return this.ctx.read(DEALS, (m) => this.dealsOf(m, i));
  }

  private async dealsOf(m: ReadModel, { query }: I<'getDeals'>): Promise<Res<'getDeals'>> {
    const accounts = this.accountRows(m);
    accounts.sort((a, b) => b.pipelineAmount - a.pipelineAmount);
    // the summary and pipeline by quarter (src/server/deals/pipeline.ts: the same function the mock calls)
    const s = m.settings();
    const basis = pipelineBasisOf(personaOf(s));
    const forecasts = basis === 'specialist_forecast' ? await loadForecastRecords(this.ctx.handle.db, m.ctx.userId) : [];
    const pipeline = buildDealsPipeline({ now: this.ctx.now(), timezone: s.profile.timezone || m.meta().timezone, basis, opps: m.all('opps'), accounts: m.all('accounts'), forecasts });
    // the needs and the pipeline count every account; the list pages (additive `cursor`/`limit`, no limit = every row)
    const page = pageOf(accounts, query);
    return { accounts: page.rows, missedCount: this.missed(m).filter((x) => x.status === 'new').length, pipeline, needs: await this.dealsNeeds(m, accounts), ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
  }

  accountRows(m: ReadModel): AccountRow[] {
    return accountRows(m);
  }

  /** Deals needs (src/engines/deals/needs.ts via src/server/deals/needs.ts: the same call the mock makes). */
  async dealsNeeds(m: ReadModel, accounts: AccountRow[] = this.accountRows(m)): Promise<DealsNeed[]> {
    const s = m.settings();
    // DC-32: the VDP mirror's links count only while VDP is active for the persona (dealsFeaturesOf gates it too)
    const vdpOppIds = featureActive(personaOf(s), 'vdp') ? await loadVdpOppIds(this.ctx.handle.db, m.ctx.userId) : undefined;
    return dealsNeedsFor({ now: this.ctx.now(), timezone: s.profile.timezone || m.meta().timezone, persona: personaOf(s), accounts, opps: m.all('opps').map(withMyDcFlag), missed: this.missed(m), requests: await loadDcRequestStatuses(this.ctx.db, m.ctx.userId), decisions: needDecisionsOf(m.ctx.kv), vdpOppIds, calls: dbCallsOf(m, this.ctx.now().toISOString()).calls });
  }

  async getMissed(_i: I<'getMissed'>): Promise<Res<'getMissed'>> {
    const m = await this.ctx.model(WHOLE);
    const missed = this.missed(m).sort((a, b) => (a.verdict === b.verdict ? (b.amount ?? 0) - (a.amount ?? 0) : a.verdict === 'claim' ? -1 : 1));
    return { missed, lastSweepAt: missed.map((x) => x.foundAt).sort().pop() ?? null };
  }

  // ---- Deal Contribution requests (D-58): ADD rows on the next logging canvas -----------------------------
  /** D-67: my VDP use cases and their Org62 Use_Case__c (read only; the rows ride the next logging canvas). */
  async getUseCaseSync(_i: I<'getUseCaseSync'>): Promise<Res<'getUseCaseSync'>> {
    return loadUseCaseSync(this.ctx.db, await this.ctx.userId());
  }

  async listDcRequests(_i: I<'listDcRequests'>): Promise<Res<'listDcRequests'>> {
    const userId = await this.ctx.userId();
    const mine = await loadMyDcs(this.ctx.db, userId);
    return { requests: await loadDcRequests(this.ctx.db, userId, undefined, mine.byOpp), myDcs: mine.rows };
  }

  /** The opportunity a DC request names (the app's id or its Org62 006… id), when the app tracks it. */
  private async dcOpp(userId: string, opp: string): Promise<{ id: string; name: string } | null> {
    const want = opp.trim();
    const where = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(want)
      ? eq(opportunitiesTable.id, want)
      : ORG62_OPP_ID.test(want)
        ? sql`left(${opportunitiesTable.org62OpportunityId}, 15) = ${want.slice(0, 15)}`
        : sql`false`;
    const [o] = await this.ctx.db.select({ id: opportunitiesTable.id, name: opportunitiesTable.name }).from(opportunitiesTable).where(and(eq(opportunitiesTable.ownerUserId, userId), where)).limit(1);
    return o ?? null;
  }

  /**
   * The opp a DC request names: tracked, or (an Org62 id the app doesn't track) the Org62 record to add with the
   * request, read now. Anything else is not_found.
   */
  private async dcOppOrOrg62(userId: string, opp: string): Promise<{ have: { id: string; name: string } | null; rec: Org62Row | null }> {
    const want = opp.trim();
    const have = await this.dcOpp(userId, want);
    if (have) return { have, rec: null };
    if (!ORG62_OPP_ID.test(want)) throw new AppError('not_found', dcOppNotFound(want));
    const rec = (await this.org62OppsByIds([want])).find((x) => x.org62Id.slice(0, 15) === want.slice(0, 15)) ?? null;
    if (!rec) throw new AppError('not_found', dcOppNotInOrg62(want));
    return { have: null, rec };
  }

  /** Untracked opps (and their accounts) from Org62, one read, one change set (D-58: claim DCs on a teammate's deal). */
  async addOrg62Opps({ body }: I<'addOrg62Opps'>): Promise<Res<'addOrg62Opps'>> {
    const userId = await this.ctx.userId();
    const ids = [...new Map(body.org62Ids.map((i) => [i.trim().slice(0, 15), i.trim()] as const)).values()];
    const keys = ids.map((i) => i.slice(0, 15));
    const have = await this.ctx.db
      .select({ id: opportunitiesTable.id, name: opportunitiesTable.name, org62: opportunitiesTable.org62OpportunityId, accountId: opportunitiesTable.accountId })
      .from(opportunitiesTable)
      .where(and(eq(opportunitiesTable.ownerUserId, userId), sql`left(${opportunitiesTable.org62OpportunityId}, 15) in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`));
    const m = await this.ctx.model(WHOLE);
    const tracked: AddedOrg62Opp[] = have.map((h) => ({ oppId: h.id, org62OpportunityId: h.org62 ?? '', name: h.name, accountName: h.accountId ? (m.get('accounts', h.accountId)?.name ?? null) : null }));
    const haveKeys = new Set(have.map((h) => (h.org62 ?? '').slice(0, 15)));
    const want = ids.filter((i) => !haveKeys.has(i.slice(0, 15)));
    if (!want.length) return { entity: { added: [], tracked, missing: [] }, auditId: null };
    const byKey = new Map((await this.org62OppsByIds(want)).map((r) => [r.org62Id.slice(0, 15), r] as const));
    const found = want.flatMap((i) => {
      const r = byKey.get(i.slice(0, 15));
      return r ? [r] : [];
    });
    const missing = want.filter((i) => !byKey.has(i.slice(0, 15)));
    if (!found.length) return { entity: { added: [], tracked, missing }, auditId: null };
    const added: AddedOrg62Opp[] = [];
    const summary = `Added from Org62: ${found.length === 1 ? found[0]!.name : `${found.length} opportunities`}`.slice(0, 200);
    const r = await this.ctx.mutate({ action: 'deals.add_org62_opps', summary, entity: { type: 'opportunity', id: uuidFor(`proj:opportunity:${userId}:${found[0]!.org62Id}`) } }, async (w) => {
      added.length = 0;
      for (const rec of found) {
        const a = await this.putOrg62Opp(w, rec);
        added.push({ oppId: a.id, org62OpportunityId: rec.org62Id, name: rec.name, accountName: a.accountName });
      }
    });
    this.ctx.bus.publishTables(['opportunities', 'accounts'], added.map((a) => a.oppId), 'deals.add_org62_opps');
    return { entity: { added, tracked, missing }, auditId: r.undoable ? r.auditId : null };
  }

  /**
   * Store one DC request inside a change set, after the shared rules (src/server/deals/dc-requests.ts): my DC with
   * this split → refused; another split → a change of my DC; one request in flight per opp.
   */
  async dcRequestIn(w: WriteCtx, model: ReadModel, o: { id: string; name: string }, b: { split: number; comment: string; role?: string }, opts: { missedOppFindingId?: string | null } = {}): Promise<DcRequestRecord> {
    const opp = model.get('opps', o.id);
    const plan = planDcRequest({ name: o.name, dcAssigned: opp?.dcAssigned ?? false, myDc: opp?.myDc ?? null }, b.split);
    const live = (await loadDcRequests(w.tx, w.userId)).find((r) => r.oppId === o.id && liveDcRequest(r));
    if (live) throw dcLiveConflict(o.name, live);
    const at = w.now.toISOString();
    const rec: DcRequestRecord = { id: crypto.randomUUID(), oppId: o.id, kind: plan.kind, role: b.role ?? dcRoleFor(personaOf(model.settings()).id), splitPercent: b.split, fromSplit: plan.fromSplit, comment: b.comment, status: 'approved', approvedAt: at, createdAt: at, updatedAt: at, org62DcId: plan.org62DcId };
    await insertDcRequest(w, rec, opts);
    await w.tx.update(changeSets).set({ summary: `${dcRequestWords({ kind: rec.kind, fromSplit: rec.fromSplit, split: rec.splitPercent })}: ${o.name}`.slice(0, 200) }).where(eq(changeSets.id, w.cs.id));
    return rec;
  }

  private async dcRequestOut(id: string): Promise<DcRequest> {
    const entity = (await loadDcRequests(this.ctx.db, await this.ctx.userId())).find((x) => x.id === id);
    if (!entity) throw new AppError('internal', 'the DC request was not stored');
    return entity;
  }

  async createDcRequest({ body }: I<'createDcRequest'>): Promise<Res<'createDcRequest'>> {
    const m = await this.ctx.model(WHOLE);
    if (!featureActive(personaOf(m.settings()), 'dealContributions')) throw invalid(DC_INACTIVE);
    // an Org62 id the app doesn't track (a teammate's deal): read from Org62 and added with the request, one change set
    const { have, rec } = await this.dcOppOrOrg62(m.ctx.userId, body.opp);
    const name = have?.name ?? rec!.name;
    let id = '';
    const r = await this.ctx.mutate({ action: 'dc.request', summary: `DC request: ${name} (${body.split}%)${rec ? ', added from Org62' : ''}`.slice(0, 200), entity: { type: 'opportunity', id: have?.id ?? uuidFor(`proj:opportunity:${m.ctx.userId}:${rec!.org62Id}`) } }, async (w, model) => {
      const o = have ?? { id: (await this.putOrg62Opp(w, rec!)).id, name };
      // DC-31: Claim DC on Deals answers the sweep's open finding on the opp too (as Missed ▸ Claim does)
      const finding = model.all('missedOpps').find((x) => x.oppId === o.id && x.status === 'new');
      id = (await this.dcRequestIn(w, model, o, body, { missedOppFindingId: finding ? uuidFor(finding.id) : null })).id;
      if (finding) await updateFinding(w, finding, { ...finding, status: 'claimed' });
    });
    this.ctx.bus.publishTables(['deal_contribution_requests'], [id], 'dc.request');
    return { entity: await this.dcRequestOut(id), auditId: r.undoable ? r.auditId : null };
  }

  async patchDcRequest({ params, body }: I<'patchDcRequest'>): Promise<Res<'patchDcRequest'>> {
    const m = await this.ctx.model(WHOLE);
    if (!featureActive(personaOf(m.settings()), 'dealContributions')) throw invalid(DC_INACTIVE);
    const cur = (await loadDcRequests(this.ctx.db, m.ctx.userId)).find((x) => x.id === params.id);
    if (!cur) throw notFound('DC request', params.id);
    assertDcEditable(cur, 'edit');
    const opp = m.get('opps', cur.oppId);
    const split = body.split ?? cur.splitPercent;
    const plan = planDcRequest({ name: cur.oppName, dcAssigned: opp?.dcAssigned ?? false, myDc: opp?.myDc ?? null }, split);
    const r = await this.ctx.mutate({ action: 'dc.request.edit', summary: `Edited the DC request: ${cur.oppName} (${dcRequestWords({ kind: plan.kind, fromSplit: plan.fromSplit, split })})`.slice(0, 200), entity: { type: 'opportunity', id: cur.oppId } }, async (w) => {
      await updateDcRequest(w, cur.id, { kind: plan.kind, fromSplit: plan.fromSplit, org62DcId: plan.org62DcId, splitPercent: split, ...(body.role !== undefined ? { role: body.role } : {}), ...(body.comment !== undefined ? { comment: body.comment } : {}) });
    });
    this.ctx.bus.publishTables(['deal_contribution_requests'], [cur.id], 'dc.request.edit');
    return { entity: await this.dcRequestOut(cur.id), auditId: r.undoable ? r.auditId : null };
  }

  async withdrawDcRequest({ params }: I<'withdrawDcRequest'>): Promise<Res<'withdrawDcRequest'>> {
    const m = await this.ctx.model(WHOLE);
    if (!featureActive(personaOf(m.settings()), 'dealContributions')) throw invalid(DC_INACTIVE);
    const cur = (await loadDcRequests(this.ctx.db, m.ctx.userId)).find((x) => x.id === params.id);
    if (!cur) throw notFound('DC request', params.id);
    assertDcEditable(cur, 'withdraw');
    const r = await this.ctx.mutate({ action: 'dc.request.withdraw', summary: `Withdrew the DC request: ${cur.oppName} (${cur.splitPercent}%)`.slice(0, 200), entity: { type: 'opportunity', id: cur.oppId } }, async (w) => {
      await updateDcRequest(w, cur.id, { status: 'dismissed' });
    });
    this.ctx.bus.publishTables(['deal_contribution_requests'], [cur.id], 'dc.request.withdraw');
    return { entity: await this.dcRequestOut(cur.id), auditId: r.undoable ? r.auditId : null };
  }

  /** 2026-11-13 audit C7: withdraw every waiting DC request (or the ids asked) in ONE change set: one Undo. */
  async withdrawDcRequests({ body }: I<'withdrawDcRequests'>): Promise<Res<'withdrawDcRequests'>> {
    const m = await this.ctx.model(WHOLE);
    if (!featureActive(personaOf(m.settings()), 'dealContributions')) throw invalid(DC_INACTIVE);
    const plan = planWithdrawDcs(await loadDcRequests(this.ctx.db, m.ctx.userId), body?.ids);
    if (!plan.withdraw.length) return { entity: { withdrawn: [], skipped: plan.skipped }, auditId: null };
    const n = plan.withdraw.length;
    const r = await this.ctx.mutate({ action: 'dc.request.withdraw_all', summary: `Withdrew ${n} DC ${n === 1 ? 'request' : 'requests'} waiting for a canvas`, entity: { type: 'opportunity', id: plan.withdraw[0]!.oppId } }, async (w) => {
      for (const x of plan.withdraw) await updateDcRequest(w, x.id, { status: 'dismissed' });
    });
    this.ctx.bus.publishTables(['deal_contribution_requests'], plan.withdraw.map((x) => x.id), 'dc.request.withdraw_all');
    return { entity: { withdrawn: plan.withdraw.map((x) => x.id), skipped: plan.skipped }, auditId: r.undoable ? r.auditId : null };
  }

  async getAccount({ params }: I<'getAccount'>): Promise<Res<'getAccount'>> {
    return this.ctx.read(accountScope(params.accountId), (m) => this.accountPage(m, params.accountId));
  }

  private async accountPage(m: ReadModel, accountId: string): Promise<Res<'getAccount'>> {
    const params = { accountId };
    const account = m.get('accounts', params.accountId);
    if (!account) throw notFound('Account', params.accountId);
    // my DC (split, role) from deal_contributions on each opp (loadOpportunities); dcAssigned = myDc or Org62 says so
    const opps = m.all('opps').filter((o) => o.accountId === account.id).map(withMyDcFlag);
    const items = m.all('workItems').filter((w) => w.accountId === account.id && w.state !== 'dismissed');
    const detail: AccountDetail = {
      account,
      opps,
      // the account scope holds this account's items only: its needs from its own row (the other rows' counts would be 0)
      needs: (await this.dealsNeeds(m, this.accountRows(m).filter((a) => a.id === account.id))).filter((n) => n.accountId === account.id),
      initiatives: m.all('initiatives').filter((i) => i.accountId === account.id),
      items: items.map((w) => hydrateItem(m, w)),
      assets: m.all('assets').filter((a) => a.accountId === account.id),
      runs: m.all('agentRuns').filter((r) => items.some((w) => w.id === r.workItemId)),
      briefs: m
        .all('briefs')
        .filter((b) => b.accountId === account.id || (b.oppId && opps.some((o) => o.id === b.oppId)))
        .map((b) => promotedAs(m, b)),
      missed: this.missed(m).filter((x) => x.accountName === account.name),
    };
    return detail;
  }

  /**
   * One Claim verb (Missed ▸ Claim, Triage's Claim): a DC request on the finding's opp, with the createDcRequest rules.
   * Only when the app doesn't know the opp, the old fallback: a task to add the DC by hand.
   */
  async claimIn(w: WriteCtx, model: ReadModel, mo: MissedOpp, body: ClaimMissedRequest = {}): Promise<{ dcRequestId: string | null; workItemId: string | null }> {
    const opp = mo.oppId ? model.get('opps', mo.oppId) : undefined;
    if (opp && featureActive(personaOf(model.settings()), 'dealContributions')) {
      const rec = await this.dcRequestIn(w, model, { id: opp.id, name: opp.name }, { split: body.split ?? 100, comment: body.comment ?? claimComment(mo.evidence), ...(body.role ? { role: body.role } : {}) }, { missedOppFindingId: uuidFor(mo.id) });
      await updateFinding(w, mo, { ...mo, status: 'claimed' });
      return { dcRequestId: rec.id, workItemId: null };
    }
    return { dcRequestId: null, workItemId: await this.claimTaskIn(w, model, mo) };
  }

  private async claimTaskIn(w: WriteCtx, model: ReadModel, mo: MissedOpp): Promise<string> {
    const now = w.now.toISOString();
    const account = model.all('accounts').find((a) => a.name === mo.accountName);
    const task: WorkItemRecord = {
      ...blankItem(now, model.ctx.me),
      id: crypto.randomUUID(),
      kind: 'task',
      state: 'open',
      title: `Add yourself as DC on ${mo.oppName}`,
      purpose: `Missed-opp sweep: ${mo.accountName}`,
      accountId: account?.id ?? null,
      oppId: mo.oppId && model.get('opps', mo.oppId) ? mo.oppId : null,
      confidence: 'likely',
      why: mo.evidence[0] ?? 'Possible missed opportunity',
      sources: [{ kind: 'org62', label: `Org62 · ${mo.oppName}` }],
      effort: { youMin: 10, agentMin: 0 },
    };
    await insertWorkItem(w, task, this.ctx.links(model), { locks: [] });
    await updateFinding(w, mo, { ...mo, status: 'claimed', claimedWorkItemId: task.id });
    return task.id;
  }

  async claimMissed({ params, body }: I<'claimMissed'>): Promise<Res<'claimMissed'>> {
    let oppName = '';
    let dcId = null as string | null;
    const r = await this.ctx.mutate({ action: 'missed.claim', summary: 'Claimed', entity: { type: 'missed_opp', id: params.id } }, async (w, model) => {
      const found = model.get('missedOpps', params.id);
      if (!found) throw notFound('Missed opp', params.id);
      const mo = this.missed(model, [found])[0]!;
      if (mo.status !== 'new') throw invalid(`Already ${mo.status}`);
      oppName = mo.oppName;
      dcId = (await this.claimIn(w, model, mo, body ?? {})).dcRequestId;
      await w.tx.update(changeSets).set({ summary: `Claimed ${mo.oppName}` }).where(eq(changeSets.id, w.cs.id));
    });
    if (dcId) this.ctx.bus.publishTables(['deal_contribution_requests'], [dcId], 'dc.request');
    const m = await this.ctx.model(WHOLE);
    return { entity: m.get('missedOpps', params.id)!, auditId: r.auditId, receipt: await receiptFromChangeSet(this.ctx.db, r.auditId, m, 'user', `Claimed ${oppName}`, this.ctx.now().toISOString()) };
  }

  async dismissMissed({ params, body }: I<'dismissMissed'>): Promise<Res<'dismissMissed'>> {
    const r = await this.ctx.mutate({ action: 'missed.dismiss', summary: 'Dismissed', entity: { type: 'missed_opp', id: params.id } }, async (w, model) => {
      const mo = model.get('missedOpps', params.id);
      if (!mo) throw notFound('Missed opp', params.id);
      await w.tx.update(changeSets).set({ summary: `Dismissed ${mo.oppName}: ${body.reason}` }).where(eq(changeSets.id, w.cs.id));
      const reason = body.note ? `${body.reason}: ${body.note}` : body.reason;
      // D-103 (d): the Dismiss is remembered (a `missed_opp` decision), so it comes back once on a call on its account
      const d = missedDismissal(mo, reason, this.missedSource(model));
      await writeNeedDecision(w, d.rule, d.subjectId, d);
      await updateFinding(w, mo, { ...mo, status: 'dismissed', dismissReason: reason });
    });
    const m = await this.ctx.model(WHOLE);
    return { entity: m.get('missedOpps', params.id)!, auditId: r.auditId };
  }

  // ---- D-103 (d): missed-opp findings as shown (a dismissed one comes back once on a call, server/deals/dismissals.ts)
  private missedSource(m: ReadModel): MissedSource {
    return { now: this.ctx.now(), timezone: m.settings().profile.timezone || m.meta().timezone, opps: m.all('opps'), accounts: m.all('accounts'), activity: m.all('activity'), decisions: needDecisionsOf(m.ctx.kv) };
  }

  missed(m: ReadModel, rows: readonly MissedOpp[] = m.all('missedOpps')): MissedOpp[] {
    return missedShown(rows, this.missedSource(m));
  }
}
