/**
 * The mock DataSource, deals domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id, I, Res, blankItem } from '../shared';
import { personaOf, featureActive } from '@/personas';
import { type AccountDetail, type AccountRow, type AddedOrg62Opp, type ClaimMissedRequest, type MissedOpp, type DcRequest, type DealsNeed, type Opportunity, type WorkItemRecord, dcRoleFor } from '@/contract';
import { AppError, invalid } from '@/server/errors';
import { buildDealsPipeline, pipelineBasisOf } from '@/server/deals/pipeline';
import { dealsNeedsFor, vdpOppIdsOf, withMyDcFlag } from '@/server/deals/needs';
import { missedDismissal, missedShown, type MissedSource } from '@/server/deals/dismissals';
import { mockCallsOf } from '../attribution';
import { ucDecisionsOf, ucDuplicateGuard, ucHolds, ucSyncView } from '@/server/deals/use-cases';
import { planUseCases, type Org62UseCase, type UseCaseLink, type UseCasePlanInput } from '@/engines/activity/use-cases';
import { linkVdp, onVdp } from '@/engines/vdp/gaps';
import { assertDcEditable, planWithdrawDcs, claimComment, DC_INACTIVE, dcHolds, dcLiveConflict, dcOppNotFound, dcOppNotInOrg62, dcRequestOrder, dcRequestView, dcRequestWords, liveDcRequest, myDcRowsOf, myDcsByOpp, ORG62_OPP_ID, org62OppIdOf, pendingDcAdds, planDcRequest, reconcileDcRequests, resolveDcOpp, spendNotCreated, type DcAdd, type DcRequestRecord } from '@/server/deals/dc-requests';
import { rowOverridesOf } from '@/lib/canvas/overrides';
import { mockOrg62UseCaseDemo } from '@/mock/vdp';
import { gapEntities } from '@/server/vdp/coverage';
import { Tx } from '../store';
import { appliedAtOf } from '../../log-canvases';
import { MOCK_ORG62_OPPS, mockAccountIdFor, mockOppIdFor, mockOrg62IdFor } from '@/mock/org62-opps';
import { org62RecordUrl } from '@/projections/links';
import { pageOf } from '../../db/reads/page';
import { hydrateItem } from '../views';
import { accountRows } from '@/server/views/deals';

export class MockDeals {
  constructor(private readonly ctx: MockCtx) {}

  /** DC-31: Home's DC row reads the Deals Log & fix rows (one count source), while deal contributions are active. */
  dcNeeds() {
    if (!featureActive(personaOf(this.ctx.store.settings()), 'dealContributions')) return undefined;
    return this.dealsNeeds().filter((n) => n.section === 'fix');
  }

  /** A picked Org62 hit in mock mode: the app's opp, or the placeholder record added (with its account) in one undoable change. */
  /** Store one placeholder Org62 Opportunity the app doesn't track (and its account, when the app lacks it), inside a tx. */
  putMockOrg62Opp(tx: Tx, rec: (typeof MOCK_ORG62_OPPS)[number], at: string): Opportunity {
    const acct =
      this.ctx.store.get('accounts', mockAccountIdFor(rec.AccountId)) ??
      this.ctx.store.all('accounts').find((a) => a.name.toLowerCase() === rec.Account.Name.toLowerCase()) ??
      tx.put('accounts', { id: mockAccountIdFor(rec.AccountId), name: rec.Account.Name, industry: null, dcStatus: 'none', vdpStatus: 'none', hoursQtd: 0, team: [], org62Url: org62RecordUrl('Account', rec.AccountId), notes: '' });
    return tx.put('opps', {
      id: mockOppIdFor(rec.Id),
      accountId: acct.id,
      name: rec.Name,
      stage: rec.StageName,
      amount: rec.Amount,
      closeDate: rec.CloseDate,
      isOpen: !rec.IsClosed,
      isMine: false,
      dcAssigned: false,
      vdpLinked: false,
      hoursQtd: 0,
      nextStep: null,
      // added from a one-opp read, like the db's (no NextStep): no next step is unknown, not missing
      nextStepRead: false,
      products: [],
      owner: null,
      org62Url: org62RecordUrl('Opportunity', rec.Id),
      myDc: null,
      forecastCategory: rec.ForecastCategoryName,
      isWon: rec.IsWon,
      updatedAt: at,
    });
  }

  /** The placeholder Org62 record with this id (15 or 18 characters), when there is one. */
  private mockOrg62Opp(org62Id: string) {
    const key = org62Id.trim().slice(0, 15);
    return MOCK_ORG62_OPPS.find((r) => r.Id.slice(0, 15) === key) ?? null;
  }

  async getDeals({ query }: I<'getDeals'>): Promise<Res<'getDeals'>> {
    const accounts = this.accountRows();
    accounts.sort((a, b) => b.pipelineAmount - a.pipelineAmount);
    // the summary and pipeline by quarter (src/server/deals/pipeline.ts: the same function the db calls)
    const s = this.ctx.store.settings();
    const basis = pipelineBasisOf(personaOf(s));
    const pipeline = buildDealsPipeline({ now: this.ctx.now(), timezone: s.profile.timezone || this.ctx.store.meta().timezone, basis, opps: this.ctx.store.all('opps'), accounts: this.ctx.store.all('accounts'), forecasts: basis === 'specialist_forecast' ? this.ctx.ds.forecast.all() : [] });
    // p4-page-scoped-reads: the same additive paging as the db (db/reads/page.ts); needs and pipeline count every account
    const page = pageOf(accounts, query);
    return { accounts: page.rows, missedCount: this.missed().filter((m) => m.status === 'new').length, pipeline, needs: this.dealsNeeds(accounts), ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
  }

  accountRows(): AccountRow[] {
    return accountRows(this.ctx.store);
  }

  /** Deals needs (src/engines/deals/needs.ts via src/server/deals/needs.ts: the same call the db makes). */
  private dealsNeeds(accounts: AccountRow[] = this.accountRows()): DealsNeed[] {
    const s = this.ctx.store.settings();
    return dealsNeedsFor({ now: this.ctx.now(), timezone: s.profile.timezone || this.ctx.store.meta().timezone, persona: personaOf(s), accounts, opps: this.ctx.store.all('opps').map(withMyDcFlag), missed: this.missed(), requests: this.dcRequests(), decisions: this.ctx.store.all('needDecisions'), vdpOppIds: this.vdpOppIds(), calls: mockCallsOf(this.ctx.store, this.ctx.nowIso()).calls });
  }

  /** DC-32: open opps a VDP I'm on links (the placeholder mirror; the db reads vdp_records). */
  private vdpOppIds(): Set<string> | undefined {
    if (!featureActive(personaOf(this.ctx.store.settings()), 'vdp')) return undefined;
    const ents = gapEntities(this.ctx.store.all('accounts'), this.ctx.store.all('opps'));
    const me = this.ctx.store.meta().user.email;
    const open = new Set(this.ctx.store.all('opps').filter((o) => o.isOpen).map((o) => o.id));
    return vdpOppIdsOf(
      this.ctx.ds.vdp.vdpSnapshots().map((v) => ({ linkedOppIds: linkVdp(v, ents.accounts, ents.opps).opportunityIds, onIt: !me || onVdp(v, [me]), live: !v.archivedAt })),
      open,
    );
  }

  async getMissed(_i: I<'getMissed'>): Promise<Res<'getMissed'>> {
    const missed = this.missed().sort((a, b) => (a.verdict === b.verdict ? (b.amount ?? 0) - (a.amount ?? 0) : a.verdict === 'claim' ? -1 : 1));
    return { missed, lastSweepAt: missed.map((m) => m.foundAt).sort().pop() ?? null };
  }

  async getAccount({ params }: I<'getAccount'>): Promise<Res<'getAccount'>> {
    const account = this.ctx.store.must('accounts', params.accountId, 'Account');
    // my DC (split, role) on each opp; dcAssigned = myDc held or Org62 says so (never a DC with no split shown)
    const opps = this.ctx.store.all('opps').filter((o) => o.accountId === account.id).map(withMyDcFlag);
    const items = this.ctx.store.all('workItems').filter((w) => w.accountId === account.id && w.state !== 'dismissed');
    const detail: AccountDetail = {
      account,
      opps,
      needs: this.dealsNeeds().filter((n) => n.accountId === account.id),
      initiatives: this.ctx.store.all('initiatives').filter((i) => i.accountId === account.id),
      items: items.map((w) => hydrateItem(this.ctx.store, w)),
      assets: this.ctx.store.all('assets').filter((a) => a.accountId === account.id),
      runs: this.ctx.store.all('agentRuns').filter((r) => items.some((w) => w.id === r.workItemId)),
      briefs: this.ctx.store
        .all('briefs')
        .filter((b) => b.accountId === account.id || (b.oppId && opps.some((o) => o.id === b.oppId)))
        .map((b) => this.ctx.ds.briefs.promotedAs(b)),
      missed: this.missed().filter((m) => m.accountName === account.name),
    };
    return detail;
  }

  // ---- Deal Contribution requests (D-58): ADD rows on the next logging canvas -----------------------------
  /** The requests as the contract shows them (where each one is: waiting, in a canvas item, handed off). */
  dcRequests(): DcRequest[] {
    const recs = this.ctx.store.all('dcRequests');
    const holds = spendNotCreated(
      dcHolds(this.ctx.store.all('drafts')),
      recs.map((r) => {
        const o = this.ctx.store.get('opps', r.oppId);
        return { r, org62OppId: o ? this.org62OppIdOf(o) : null };
      }),
    );
    return recs
      .map((r) => {
        const o = this.ctx.store.get('opps', r.oppId);
        // the Org62 id the db would have (null without a link); the canvas row carries the placeholder the Time rows use
        return dcRequestView(r, o ? { name: o.name, accountId: o.accountId, accountName: this.ctx.store.get('accounts', o.accountId)?.name ?? null, org62OpportunityId: org62OppIdOf(o) } : null, holds, o ? this.org62OppIdOf(o) : null, o?.myDc ?? null);
      })
      .sort(dcRequestOrder);
  }

  /** The 006… id the mock uses for an opp (its link, else the placeholder the Time rows' WhatId uses). */
  org62OppIdOf(o: Opportunity): string {
    return org62OppIdOf(o) ?? mockOrg62IdFor(o.id);
  }

  /**
   * D-67 in mock mode: the placeholder VDPs, the seed's opps and accounts (placeholder Org62 ids where the seed has
   * none, as the Time rows' WhatId), the canvases in the store, and a placeholder read of Org62 at the mock's clock
   * that found no use case (the mock never calls Org62).
   */
  /**
   * D-67 in mock mode: the placeholder Org62 use cases a read would have found and their links (none unless a test
   * sets them: the mock never calls Org62), at a placeholder read time (the mock's clock).
   */
  ucRecords: Org62UseCase[] = [];
  private ucLinks: UseCaseLink[] = [];
  useCaseDemo = false;
  /** D-70: the app's placeholder Org62 read-back (MockOptions.useCaseDemo). */
  applyUseCaseDemo() {
    const d = mockOrg62UseCaseDemo(this.ctx.ds.vdp.vdpSnapshots(), '005XX0000000MOCKAA', this.ctx.nowIso());
    this.ucRecords = d.records;
    this.ucLinks = d.links;
  }
  ucPlanInput(): UseCasePlanInput {
    const accounts = this.ctx.store.all('accounts');
    const ents = gapEntities(accounts, this.ctx.store.all('opps'));
    const byId = new Map(accounts.map((a) => [a.id, a] as const));
    const accOrg62 = (id: string) => byId.get(id)?.org62Url?.match(/\/(001[A-Za-z0-9]{12,15})(?:\/|$|\?)/)?.[1] ?? `001XX${id.replace(/[^A-Za-z0-9]/g, '').slice(0, 10).padEnd(10, '0')}AAA`;
    return {
      vdps: this.ctx.ds.vdp.vdpSnapshots().map((snapshot) => ({ snapshot, accountId: linkVdp(snapshot, ents.accounts, ents.opps).accountId })),
      opps: this.ctx.store.all('opps').map((o) => ({ id: o.id, org62Id: this.org62OppIdOf(o), name: o.name, accountId: o.accountId, accountOrg62Id: accOrg62(o.accountId), isOpen: o.isOpen, dcSplit: o.myDc?.split ?? null, closeDate: o.closeDate })),
      org62: { readAt: this.ctx.nowIso(), records: this.ucRecords },
      links: this.ucLinks,
      holds: ucHolds(this.ctx.store.all('drafts').map((d) => ({ ...d, sentAt: appliedAtOf(d) }))),
      me: '005XX0000000MOCKAA',
      decisions: ucDecisionsOf(this.ctx.store.all('needDecisions'), this.ctx.now()),
      overrides: rowOverridesOf(Object.fromEntries(this.ctx.store.all('rowOverrides').map((o) => [o.key, { fields: o.fields, at: o.at }] as const))),
    };
  }

  /** D-67: the duplicate check before a new use case is staged (both systems and what is on its way). */
  ucGuard() {
    const i = this.ucPlanInput();
    return ucDuplicateGuard({ vdps: i.vdps, records: i.org62.records, opps: i.opps, drafts: this.ctx.store.all('drafts') });
  }

  async getUseCaseSync(_i: I<'getUseCaseSync'>): Promise<Res<'getUseCaseSync'>> {
    const input = this.ucPlanInput();
    return ucSyncView(planUseCases(input), input.org62.readAt);
  }

  async listDcRequests(_i: I<'listDcRequests'>): Promise<Res<'listDcRequests'>> {
    return { requests: this.dcRequests(), myDcs: myDcRowsOf(this.ctx.store.all('opps'), (aid) => this.ctx.store.get('accounts', aid)?.name ?? null) };
  }

  /**
   * A DC request record for an opp, after the shared rules (src/server/deals/dc-requests.ts): my DC with this split →
   * refused; another split → a change of my DC; one request in flight per opp. Stored by the caller's tx.
   */
  dcRequestRecord(o: Opportunity, b: { split: number; comment: string; role?: string }): DcRequestRecord {
    const plan = planDcRequest({ name: o.name, dcAssigned: o.dcAssigned, myDc: o.myDc ?? null }, b.split);
    const live = this.dcRequests().find((r) => r.oppId === o.id && liveDcRequest(r));
    if (live) throw dcLiveConflict(o.name, live);
    const at = this.ctx.nowIso();
    return { id: id('dcr'), oppId: o.id, kind: plan.kind, role: b.role ?? dcRoleFor(personaOf(this.ctx.store.settings()).id), splitPercent: b.split, fromSplit: plan.fromSplit, comment: b.comment, status: 'approved', approvedAt: at, createdAt: at, updatedAt: at, org62DcId: plan.org62DcId };
  }

  async addOrg62Opps({ body }: I<'addOrg62Opps'>): Promise<Res<'addOrg62Opps'>> {
    const ids = [...new Map(body.org62Ids.map((i) => [i.trim().slice(0, 15), i.trim()] as const)).values()];
    const opps = this.ctx.store.all('opps');
    const view = (o: Opportunity): AddedOrg62Opp => ({ oppId: o.id, org62OpportunityId: this.org62OppIdOf(o), name: o.name, accountName: this.ctx.store.get('accounts', o.accountId)?.name ?? null });
    const tracked: AddedOrg62Opp[] = [];
    const want: string[] = [];
    for (const i of ids) {
      const o = resolveDcOpp(opps, i, (x) => this.org62OppIdOf(x));
      if (o) tracked.push(view(o));
      else want.push(i);
    }
    const found = want.flatMap((i) => {
      const r = this.mockOrg62Opp(i);
      return r ? [r] : [];
    });
    const missing = want.filter((i) => !this.mockOrg62Opp(i));
    if (!found.length) return { entity: { added: [], tracked, missing }, auditId: null };
    const at = this.ctx.nowIso();
    const { entry, result } = this.ctx.tx({ actor: 'user', action: 'deals.add_org62_opps', summary: `Added from Org62: ${found.length === 1 ? found[0]!.Name : `${found.length} opportunities`}`.slice(0, 200), entity: { type: 'opportunity', id: mockOppIdFor(found[0]!.Id), label: found[0]!.Name } }, (tx) => found.map((r) => this.putMockOrg62Opp(tx, r, at)));
    return { entity: { added: result.map((o) => ({ ...view(o), org62OpportunityId: this.org62OppIdOf(o) })), tracked, missing }, auditId: entry?.id ?? null };
  }

  async createDcRequest({ body }: I<'createDcRequest'>): Promise<Res<'createDcRequest'>> {
    if (!featureActive(personaOf(this.ctx.store.settings()), 'dealContributions')) throw invalid(DC_INACTIVE);
    const want = body.opp.trim();
    const have = resolveDcOpp(this.ctx.store.all('opps'), want, (x) => this.org62OppIdOf(x));
    // an Org62 id the app doesn't track (a teammate's deal): read from Org62 and added with the request, one change set
    const org62 = have ? null : ORG62_OPP_ID.test(want) ? this.mockOrg62Opp(want) : null;
    if (!have && !ORG62_OPP_ID.test(want)) throw new AppError('not_found', dcOppNotFound(want));
    if (!have && !org62) throw new AppError('not_found', dcOppNotInOrg62(want));
    const at = this.ctx.nowIso();
    const o: Opportunity = have ?? { id: mockOppIdFor(org62!.Id), accountId: '', name: org62!.Name, stage: org62!.StageName, amount: org62!.Amount, closeDate: org62!.CloseDate, isOpen: !org62!.IsClosed, isMine: false, dcAssigned: false, vdpLinked: false, hoursQtd: 0, nextStep: null, nextStepRead: false, products: [], owner: null, org62Url: org62RecordUrl('Opportunity', org62!.Id), myDc: null, forecastCategory: org62!.ForecastCategoryName, isWon: org62!.IsWon, updatedAt: at };
    const rec = this.dcRequestRecord(o, body);
    // DC-31: Claim DC on Deals answers the sweep's open finding on the opp too (as Missed ▸ Claim does)
    const finding = this.ctx.store.all('missedOpps').find((m) => m.oppId === o.id && m.status === 'new');
    const { entry } = this.ctx.tx({ actor: 'user', action: 'dc.request', summary: `${dcRequestWords({ kind: rec.kind, fromSplit: rec.fromSplit, split: rec.splitPercent })}: ${o.name}${org62 ? ', added from Org62' : ''}`.slice(0, 200), entity: { type: 'opportunity', id: o.id, label: o.name } }, (tx) => {
      if (org62) this.putMockOrg62Opp(tx, org62, at);
      tx.put('dcRequests', rec);
      if (finding) tx.put('missedOpps', { ...finding, status: 'claimed', dcRequestId: rec.id });
    });
    return { entity: this.dcRequests().find((x) => x.id === rec.id)!, auditId: entry?.id ?? null };
  }

  async patchDcRequest({ params, body }: I<'patchDcRequest'>): Promise<Res<'patchDcRequest'>> {
    if (!featureActive(personaOf(this.ctx.store.settings()), 'dealContributions')) throw invalid(DC_INACTIVE);
    const rec = this.ctx.store.must('dcRequests', params.id, 'DC request');
    const cur = this.dcRequests().find((x) => x.id === rec.id)!;
    assertDcEditable(cur, 'edit');
    const o = this.ctx.store.get('opps', rec.oppId);
    const split = body.split ?? rec.splitPercent;
    const plan = planDcRequest({ name: cur.oppName, dcAssigned: o?.dcAssigned ?? false, myDc: o?.myDc ?? null }, split);
    const next: DcRequestRecord = { ...rec, kind: plan.kind, fromSplit: plan.fromSplit, org62DcId: plan.org62DcId, splitPercent: split, ...(body.role !== undefined ? { role: body.role } : {}), ...(body.comment !== undefined ? { comment: body.comment } : {}), updatedAt: this.ctx.nowIso() };
    const { entry } = this.ctx.tx({ actor: 'user', action: 'dc.request.edit', summary: `Edited the DC request: ${cur.oppName} (${dcRequestWords({ kind: plan.kind, fromSplit: plan.fromSplit, split })})`.slice(0, 200), entity: { type: 'opportunity', id: rec.oppId, label: cur.oppName } }, (tx) => tx.put('dcRequests', next));
    return { entity: this.dcRequests().find((x) => x.id === rec.id)!, auditId: entry?.id ?? null };
  }

  async withdrawDcRequest({ params }: I<'withdrawDcRequest'>): Promise<Res<'withdrawDcRequest'>> {
    if (!featureActive(personaOf(this.ctx.store.settings()), 'dealContributions')) throw invalid(DC_INACTIVE);
    const rec = this.ctx.store.must('dcRequests', params.id, 'DC request');
    const cur = this.dcRequests().find((x) => x.id === rec.id)!;
    assertDcEditable(cur, 'withdraw');
    const { entry } = this.ctx.tx({ actor: 'user', action: 'dc.request.withdraw', summary: `Withdrew the DC request: ${cur.oppName} (${rec.splitPercent}%)`.slice(0, 200), entity: { type: 'opportunity', id: rec.oppId, label: cur.oppName } }, (tx) => tx.put('dcRequests', { ...rec, status: 'dismissed', updatedAt: this.ctx.nowIso() }));
    return { entity: this.dcRequests().find((x) => x.id === rec.id)!, auditId: entry?.id ?? null };
  }

  /** 2026-11-13 audit C7: the db's withdrawDcRequests: every waiting one (or the ids asked) in one change set, one Undo. */
  async withdrawDcRequests({ body }: I<'withdrawDcRequests'>): Promise<Res<'withdrawDcRequests'>> {
    if (!featureActive(personaOf(this.ctx.store.settings()), 'dealContributions')) throw invalid(DC_INACTIVE);
    const plan = planWithdrawDcs(this.dcRequests(), body?.ids);
    if (!plan.withdraw.length) return { entity: { withdrawn: [], skipped: plan.skipped }, auditId: null };
    const n = plan.withdraw.length;
    const at = this.ctx.nowIso();
    const first = plan.withdraw[0]!;
    const { entry } = this.ctx.tx({ actor: 'user', action: 'dc.request.withdraw_all', summary: `Withdrew ${n} DC ${n === 1 ? 'request' : 'requests'} waiting for a canvas`, entity: { type: 'opportunity', id: first.oppId, label: first.oppName } }, (tx) => {
      for (const x of plan.withdraw) {
        const rec = this.ctx.store.must('dcRequests', x.id, 'DC request');
        tx.put('dcRequests', { ...rec, status: 'dismissed', updatedAt: at });
      }
    });
    return { entity: { withdrawn: plan.withdraw.map((x) => x.id), skipped: plan.skipped }, auditId: entry?.id ?? null };
  }

  /**
   * What an Org62 scan read of my DCs does here (the db's projection: deal_contributions + syncMyDcs): each opp's
   * `myDc` (split, role; DC-14: two of mine on one opp summed) and `dcAssigned`, then the reconcile (D-68): requests
   * confirmed, withdrawn or `not_created` (`reconcileDcRequests`). `complete`: the list is every DC of mine (a complete
   * book read at now): an opp it leaves out loses its DC and flag (DC-11), and "not created" can be decided. Tests call
   * it; nothing else writes my DCs in the mock. Returns the requests it confirmed.
   */
  recordMyDcs(dcs: ReadonlyArray<{ oppId: string; split: number | null; role: string | null; org62DcId: string }>, o: { complete?: boolean } = {}): number {
    const at = this.ctx.nowIso();
    const byOpp = myDcsByOpp(dcs.map((d) => ({ split: d.split, role: d.role, org62DcId: d.org62DcId, lastSeenAt: at, oppId: d.oppId })));
    let confirmed = 0;
    this.ctx.tx({ actor: 'connector', action: 'org62.dcs', summary: `Org62 scan: ${dcs.length} DC${dcs.length === 1 ? '' : 's'} of mine`, entity: { type: 'opportunity', id: dcs[0]?.oppId ?? 'none', label: 'My DCs' } }, (tx) => {
      for (const [oppId, dc] of byOpp) {
        const opp = this.ctx.store.get('opps', oppId);
        if (opp) tx.put('opps', { ...opp, myDc: dc, dcAssigned: true });
      }
      // DC-11: a complete read without my DC on an opp: the DC was removed in Org62, and the flag goes with it
      if (o.complete) for (const opp of this.ctx.store.all('opps')) if ((opp.myDc || opp.dcAssigned) && !byOpp.has(opp.id)) tx.put('opps', { ...opp, myDc: null, dcAssigned: false });
    });
    const plan = reconcileDcRequests({
      requests: this.dcRequests(),
      read: o.complete ? { at, complete: true } : null,
      deliveredAt: new Map(this.ctx.store.all('drafts').map((d) => [d.id, d.updatedAt] as const)),
      openOppIds: new Set(this.ctx.store.all('opps').filter((x) => x.isOpen).map((x) => x.id)),
    });
    if (plan.confirm.length || plan.close.length) {
      this.ctx.tx({ actor: 'connector', action: 'org62.dcs.reconcile', summary: `Org62 scan: ${plan.confirm.length} DC request${plan.confirm.length === 1 ? '' : 's'} confirmed, ${plan.close.length} closed`, entity: { type: 'opportunity', id: (plan.confirm[0] ?? plan.close[0]?.request)!.oppId, label: 'DC requests' } }, (tx) => {
        for (const r of plan.confirm) {
          const rec = this.ctx.store.get('dcRequests', r.id);
          if (rec) tx.put('dcRequests', { ...rec, status: 'verified', org62DcId: r.dc?.org62DcId ?? rec.org62DcId, updatedAt: at });
        }
        for (const { request, outcome } of plan.close) {
          const rec = this.ctx.store.get('dcRequests', request.id);
          if (rec) tx.put('dcRequests', { ...rec, status: 'dismissed', outcome, updatedAt: at });
          // not created: the finding it claimed is open again
          if (outcome === 'not_created') for (const m of this.ctx.store.all('missedOpps')) if (m.dcRequestId === request.id && m.status === 'claimed') tx.put('missedOpps', { ...m, status: 'new' });
        }
      });
      confirmed = plan.confirm.length;
    }
    return confirmed;
  }

  /** The pending DC rows a logging batch takes (when the role has deal contributions). */
  pendingDcAdds(): DcAdd[] {
    if (!featureActive(personaOf(this.ctx.store.settings()), 'dealContributions')) return [];
    // placeholder Org62 ids for opps the seed has no link for (as the Time rows' WhatId), so the mock canvas shows them
    return pendingDcAdds(this.dcRequests().map((r) => ({ ...r, org62OpportunityId: r.org62OpportunityId ?? mockOrg62IdFor(r.oppId) })));
  }

  async claimMissed({ params, body }: I<'claimMissed'>): Promise<Res<'claimMissed'>> {
    const m = this.missed([this.ctx.store.must('missedOpps', params.id, 'Missed opp')])[0]!;
    if (m.status !== 'new') throw invalid(`Already ${m.status}`);
    const r = this.claimMissedTx(m, body ?? {});
    return { entity: this.ctx.store.get('missedOpps', m.id)!, auditId: r.entry?.id ?? null, receipt: this.ctx.receiptFrom(r.entry, r.ops, 'user', `Claimed ${m.oppName}`) };
  }

  /**
   * One Claim verb (Missed ▸ Claim, Triage's Claim): a DC request on the finding's opp, with the createDcRequest rules.
   * Only when the app doesn't know the opp, the old fallback: a task to add the DC by hand.
   */
  claimMissedTx(m: MissedOpp, body: ClaimMissedRequest = {}) {
    const opp = m.oppId ? this.ctx.store.get('opps', m.oppId) : undefined;
    if (opp && featureActive(personaOf(this.ctx.store.settings()), 'dealContributions')) {
      const rec = this.dcRequestRecord(opp, { split: body.split ?? 100, comment: body.comment ?? claimComment(m.evidence), ...(body.role ? { role: body.role } : {}) });
      return this.ctx.tx({ actor: 'user', action: 'missed.claim', summary: `Claimed ${m.oppName}`, entity: { type: 'missed_opp', id: m.id, label: m.oppName } }, (tx) => {
        tx.put('dcRequests', rec);
        tx.put('missedOpps', { ...m, status: 'claimed', dcRequestId: rec.id });
      });
    }
    return this.claimTaskTx(m);
  }

  private claimTaskTx(m: MissedOpp) {
    const now = this.ctx.nowIso();
    const account = this.ctx.store.all('accounts').find((a) => a.name === m.accountName);
    const task: WorkItemRecord = {
      ...blankItem(now, this.ctx.store.meta().user),
      id: id('w'),
      kind: 'task',
      state: 'open',
      title: `Add yourself as DC on ${m.oppName}`,
      purpose: `Missed-opp sweep: ${m.accountName}`,
      accountId: account?.id ?? null,
      oppId: m.oppId,
      confidence: 'likely',
      why: m.evidence[0] ?? 'Possible missed opportunity',
      sources: [{ kind: 'org62', label: `Org62 · ${m.oppName}` }],
      effort: { youMin: 10, agentMin: 0 },
      signals: { customerFacing: false, fromManager: false, boost: 0 },
    };
    return this.ctx.tx({ actor: 'user', action: 'missed.claim', summary: `Claimed ${m.oppName}`, entity: { type: 'missed_opp', id: m.id, label: m.oppName } }, (tx) => {
      tx.put('workItems', task);
      tx.put('missedOpps', { ...m, status: 'claimed', claimedWorkItemId: task.id });
    });
  }

  async dismissMissed({ params, body }: I<'dismissMissed'>): Promise<Res<'dismissMissed'>> {
    const m = this.ctx.store.must('missedOpps', params.id, 'Missed opp');
    const reason = body.note ? `${body.reason}: ${body.note}` : body.reason;
    // D-103 (d): the Dismiss is remembered (a `missed_opp` decision), so it comes back once on a call on its account
    const d = missedDismissal(m, reason, this.missedSource());
    const { entry, result } = this.ctx.tx({ actor: 'user', action: 'missed.dismiss', summary: `Dismissed ${m.oppName}: ${body.reason}`, entity: { type: 'missed_opp', id: m.id, label: m.oppName } }, (tx) => {
      tx.put('needDecisions', d);
      return tx.put('missedOpps', { ...m, status: 'dismissed', dismissReason: reason });
    });
    return { entity: result, auditId: entry?.id ?? null };
  }

  // ---- D-103 (d): missed-opp findings as shown (a dismissed one comes back once on a call, server/deals/dismissals.ts)
  private missedSource(): MissedSource {
    const st = this.ctx.store;
    return { now: this.ctx.now(), timezone: st.settings().profile.timezone || st.meta().timezone, opps: st.all('opps'), accounts: st.all('accounts'), activity: st.all('activity'), decisions: st.all('needDecisions') };
  }

  missed(rows: readonly MissedOpp[] = this.ctx.store.all('missedOpps')): MissedOpp[] {
    return missedShown(rows, this.missedSource());
  }
}
