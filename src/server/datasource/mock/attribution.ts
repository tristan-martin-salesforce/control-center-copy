/**
 * The attribution engine in mock mode (the db's twin: src/server/datasource/db/attribution.ts). Learned rules and DC
 * suggestions live in the store (collections `learnedRules`, `dcSuggestions`), so a correction's learning and a DC
 * decision undo with the change that made them. Engagement is rolled up from the store's rows on the fly (the db keeps
 * it in opp_engagement); the DC batch runs on the first read and on Refresh. No Org62 here: the covered-AE lookup
 * searches the store's people, and nothing is read or sent anywhere.
 */
import { attributionSettingsOf, type ActivityEntry, type CoveredAeLookupResult, type DcSuggestion, type DcSuggestionsPayload, type DecideDcSuggestionRequest, type MappingRuleView, type OppRundown, type Opportunity } from '@/contract';
import { weekStart } from '@/engines/activity/time';
import { decideDc, planDcSuggestions, type DcCandidateOpp } from '@/engines/attribution/dc';
import { oppRundown } from '@/engines/attribution/rundown';
import { planLearning, ruleActive, type Chosen } from '@/engines/attribution/rules';
import { rollupEngagement, totalsByOpp, engagementSummaries, type EngagementRow } from '@/engines/attribution/engagement';
import { coverageRefsOf } from '@/engines/attribution/coverage';
import { rowAttribution, worldOfContract, type RowExtras } from '@/engines/attribution/row';
import { touchesOf } from '@/engines/attribution/touches';
import { lastCallsByAccount } from '@/engines/attribution/resurface';
import { dcComment, dcPayload, ruleView } from '@/engines/attribution/view';
import { dcContextOf } from '@/engines/attribution/discover';
import type { LearnedRule } from '@/engines/attribution/types';
import { DEFAULT_MIN_AMOUNT } from '@/engines/deals/classify';
import { sfrQuarterBounds, sfrQuarterOfDay } from '@/engines/forecast/time';
import type { SuggestContext } from '@/lib/time-suggest';
import { featureActive, personaOf } from '@/personas';
import { invalid, notFound } from '@/server/errors';
import { liveDcRequest, type DcRequestRecord } from '@/server/deals/dc-requests';
import type { DcSuggestionRec, Store, Tx } from './store';

export interface MockAttributionHost {
  now(): Date;
  store(): Store;
  newId(prefix: string): string;
  /** The Time rows' suggestion context, without the extras. */
  suggestContext(): SuggestContext;
  /** One audited change (Undo reverts every put in it). */
  tx<R>(meta: { action: string; summary: string; entity: { type: 'opportunity' | 'settings' | 'activity_entry'; id: string; label?: string } }, fn: (tx: Tx) => R): { result: R; auditId: string | null };
  /** A DC request for the opp, as Deals ▸ Claim DC makes it (the existing DC path: it rides the next logging canvas). */
  dcRequestRecord(o: Opportunity, b: { split: number; comment: string; role?: string }): DcRequestRecord;
  dcRequests(): Array<{ oppId: string; status: DcRequestRecord['status'] }>;
  publish(ids: string[], reason: string): void;
}

const dayOf = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export class MockAttribution {
  private ranFor: Store | null = null;
  private generatedAt: string | null = null;
  private outcomes: Array<{ subjectId: string; outcome: string; at: string }> = [];

  constructor(private readonly host: MockAttributionHost) {}

  private today(): string {
    return dayOf(this.host.now(), this.host.store().settings().profile.timezone);
  }

  private rules(): LearnedRule[] {
    return this.host.store().all('learnedRules');
  }

  /** The rollup from the store's rows (the db's opp_engagement), from this quarter's start minus 4 weeks. */
  engagement(ctx?: SuggestContext): EngagementRow[] {
    const c = ctx ?? this.context(false);
    const today = this.today();
    const q = sfrQuarterBounds(sfrQuarterOfDay(today));
    const from = weekStart(new Date(Date.parse(`${q?.start ?? today}T12:00:00Z`) - 28 * 86_400_000).toISOString().slice(0, 10));
    const open = new Map<string, string[]>();
    for (const o of c.opps) if (o.isOpen && o.accountId) open.set(o.accountId, [...(open.get(o.accountId) ?? []), o.id]);
    return rollupEngagement(touchesOf(this.host.store().all('activity'), c, from), open);
  }

  /** What the engine reads besides the store's records. */
  extras(withEngagement = true): RowExtras {
    const s = this.host.store().settings();
    const base: RowExtras = {
      rules: this.rules().filter((r) => r.enabled),
      coveredAes: coverageRefsOf(attributionSettingsOf(s.time).coveredAes),
      internalDomains: [s.profile.email?.split('@')[1]?.toLowerCase()].filter((x): x is string => !!x),
    };
    if (!withEngagement) return base;
    return { ...base, engagement: engagementSummaries(this.engagement({ ...this.host.suggestContext(), attribution: base }), this.today()) };
  }

  context(withEngagement = true): SuggestContext {
    return { ...this.host.suggestContext(), attribution: this.extras(withEngagement) };
  }

  /** A correction on a Time row: learn inside the row's own change (the caller's tx), as the db does. */
  learnFromRow(tx: Tx, cur: ActivityEntry, next: ActivityEntry): void {
    const chosen: Chosen | null = next.internal && !cur.internal ? { oppId: null, accountId: null, internal: true } : next.oppId && next.oppId !== cur.oppId ? { oppId: next.oppId, accountId: this.host.store().get('opps', next.oppId)?.accountId ?? null } : null;
    if (!chosen) return;
    const ctx = this.context(false);
    const ra = rowAttribution(cur, ctx, { internalOk: ctx.internalActivity });
    const shown = ra.suggestion;
    const outcome = shown && ((shown.kind === 'internal' && chosen.internal) || (shown.oppId && shown.oppId === chosen.oppId)) ? 'accept' : 'edit';
    const changes = planLearning({ signal: ra.signal, chosen, outcome, shown: shown ? { oppId: shown.oppId, accountId: null, internal: shown.kind === 'internal' } : null, world: worldOfContract(ctx) }, this.rules(), this.host.now().toISOString(), () => this.host.newId('rule'));
    for (const c of changes) tx.put('learnedRules', c.after);
    this.outcomes.push({ subjectId: cur.id, outcome, at: this.host.now().toISOString() });
  }

  rulesView(): { rules: MappingRuleView[] } {
    const s = this.host.store();
    return { rules: this.rules().map((r) => ruleView(r, { opp: (id) => s.get('opps', id), account: (id) => s.get('accounts', id) })) };
  }

  patchRule(id: string, enabled: boolean): { entity: MappingRuleView; auditId: string | null } {
    const cur = this.host.store().get('learnedRules', id);
    if (!cur) throw notFound('Learned rule', id);
    const { auditId } = this.host.tx({ action: enabled ? 'attribution.rule.enable' : 'attribution.rule.disable', summary: `${enabled ? 'Turned on' : 'Turned off'} a learned rule`, entity: { type: 'settings', id } }, (tx) => tx.put('learnedRules', { ...cur, enabled }));
    this.host.publish([id], 'attribution.rule');
    return { entity: this.rulesView().rules.find((r) => r.id === id)!, auditId };
  }

  deleteRule(id: string): { entity: { rules: MappingRuleView[] }; auditId: string | null } {
    if (!this.host.store().get('learnedRules', id)) throw notFound('Learned rule', id);
    const { auditId } = this.host.tx({ action: 'attribution.rule.delete', summary: 'Removed a learned rule', entity: { type: 'settings', id } }, (tx) => tx.remove('learnedRules', id));
    this.host.publish([id], 'attribution.rule.delete');
    return { entity: this.rulesView(), auditId };
  }

  private candidates(): DcCandidateOpp[] {
    const s = this.host.store();
    const requested = new Set(this.host.dcRequests().filter((r) => liveDcRequest(r)).map((r) => r.oppId));
    const claims = new Set(s.all('missedOpps').filter((x) => x.verdict === 'claim' && x.status === 'new' && x.oppId).map((x) => x.oppId!));
    const other = new Set(s.all('missedOpps').filter((x) => x.otherDcs.length && x.oppId).map((x) => x.oppId!));
    const acct = new Map(s.all('accounts').map((a) => [a.id, a.name] as const));
    const world = worldOfContract({ opps: s.all('opps'), accounts: s.all('accounts'), people: s.all('people'), activity: [], today: '9999-12-31', attribution: this.extras(false) });
    return world.opps.map((o) => ({ ...o, accountName: o.accountId ? (acct.get(o.accountId) ?? null) : null, requested: requested.has(o.id), sweepClaim: claims.has(o.id), otherArchitectDc: other.has(o.id), ...mockSfrFields(o.id, o.products) }));
  }

  /** The DC batch (the db's `attribution.dc_suggest`): plan from engagement and write the changes (not undoable: the app's own). */
  runBatch(): number {
    const s = this.host.store();
    this.ranFor = s;
    const settings = s.settings();
    if (!featureActive(personaOf(settings), 'dealContributions')) return 0;
    const quarter = sfrQuarterOfDay(this.today());
    const qStart = sfrQuarterBounds(quarter)?.start ?? this.today();
    const a = attributionSettingsOf(settings.time);
    const plan = planDcSuggestions({
      opps: this.candidates(),
      totals: totalsByOpp(this.engagement(), weekStart(qStart)),
      coveredAes: this.extras(false).coveredAes ?? [],
      asOf: this.today(),
      dcProducts: a.dcProducts,
      minAmount: Number(personaOf(settings).thresholds.missedOppMinAmountUsd ?? DEFAULT_MIN_AMOUNT),
      dcSplit: a.dcSplit,
      quarter,
      existing: s.all('dcSuggestions'),
      newId: () => this.host.newId('dcs'),
      ...mockCallsOf(s, this.host.now().toISOString()),
    });
    for (const u of plan.upserts) s._set('dcSuggestions', { ...u, decidedAt: s.get('dcSuggestions', u.id)?.decidedAt ?? null });
    this.generatedAt = this.host.now().toISOString();
    return plan.upserts.filter((u) => u.state === 'new').length;
  }

  private view(rows: readonly DcSuggestionRec[]): DcSuggestion[] {
    const s = this.host.store();
    const size = new Map<string, number>();
    for (const r of rows) if (r.state === 'new') size.set(r.groupKey, (size.get(r.groupKey) ?? 0) + 1);
    return rows.flatMap((r) => {
      const o = s.get('opps', r.oppId);
      if (!o) return [];
      return [{ id: r.id, oppId: r.oppId, oppName: o.name, accountId: o.accountId || null, accountName: s.get('accounts', o.accountId)?.name ?? null, amount: o.amount, stage: o.stage, closeDate: o.closeDate, quarter: r.quarter, groupKey: r.groupKey, groupSize: Math.max(1, size.get(r.groupKey) ?? 1), sharePercent: r.sharePercent, splitPercent: r.splitPercent, preTicked: r.preTicked, state: r.state, reasons: r.reasons, evidence: r.evidence, coveredAe: r.coveredAe, dcRequestId: r.dcRequestId, decidedAt: r.decidedAt, context: mockDcContext(s, r.oppId, r.coveredAe) }];
    });
  }

  suggestions(): DcSuggestionsPayload {
    const s = this.host.store();
    if (this.ranFor !== s) this.runBatch();
    const settings = s.settings();
    const quarter = sfrQuarterOfDay(this.today());
    return dcPayload(this.view(s.all('dcSuggestions').filter((x) => x.quarter === quarter)), quarter, { generatedAt: this.generatedAt, dcProducts: attributionSettingsOf(settings.time).dcProducts, enabled: featureActive(personaOf(settings), 'dealContributions') });
  }

  decide(id: string, body: DecideDcSuggestionRequest): { entity: { suggestion: DcSuggestion; dcRequestId: string | null }; auditId: string | null } {
    const s = this.host.store();
    if (!featureActive(personaOf(s.settings()), 'dealContributions')) throw invalid('Deal contributions are off for this persona');
    const cur = s.get('dcSuggestions', id);
    if (!cur) throw notFound('DC suggestion', id);
    if (cur.state !== 'new') throw invalid(`This suggestion is ${cur.state} already`);
    const opp = s.get('opps', cur.oppId);
    if (!opp) throw notFound('Opportunity', cur.oppId);
    const view = this.view([cur])[0]!;
    const split = body.split ?? cur.splitPercent ?? undefined;
    let rec: DcRequestRecord | null = null;
    if (body.decision !== 'reject') {
      if (split === undefined) throw invalid('Another architect has a DC on this opportunity: agree the split, then Edit with your split');
      rec = this.host.dcRequestRecord(opp, { split, comment: body.comment ?? dcComment(view), ...(body.role ? { role: body.role } : {}) });
    }
    const hours = totalsByOpp(this.engagement(), '0000-00-00').get(cur.oppId)?.hoursLogged ?? 0;
    const at = this.host.now().toISOString();
    const next: DcSuggestionRec = { ...decideDc(cur, body.decision, { hours, onTeam: opp.isMine, lastCallAt: (opp.accountId && mockCallsOf(s, at).calls.get(opp.accountId)) || null, at }, rec?.id ?? null, split), decidedAt: at };
    const { auditId } = this.host.tx({ action: `dc.suggestion.${body.decision}`, summary: `${body.decision === 'reject' ? 'Rejected' : 'Accepted'} the suggested DC: ${opp.name}`.slice(0, 200), entity: { type: 'opportunity', id: opp.id, label: opp.name } }, (tx) => {
      if (rec) tx.put('dcRequests', rec);
      tx.put('dcSuggestions', next);
    });
    this.outcomes.push({ subjectId: id, outcome: body.decision, at });
    this.host.publish([id], `dc.suggestion.${body.decision}`);
    return { entity: { suggestion: this.view([next])[0]!, dcRequestId: rec?.id ?? null }, auditId };
  }

  refresh(): { queued: boolean; suggestions: number; note: string | null } {
    const n = this.runBatch();
    this.host.publish([], 'attribution.refresh');
    return { queued: false, suggestions: n, note: 'Mock data: the batch ran here, from the placeholder rows' };
  }

  rundown(q: { entryId?: string; accountId?: string }): OppRundown {
    const s = this.host.store();
    const ctx = this.context();
    let a = null;
    if (q.entryId) {
      const e = s.get('activity', q.entryId);
      if (!e) throw notFound('Activity entry', q.entryId);
      a = rowAttribution(e, ctx).attribution;
    }
    const today = this.today();
    const totals = totalsByOpp(this.engagement(ctx), weekStart(new Date(Date.parse(`${today}T12:00:00Z`) - 27 * 86_400_000).toISOString().slice(0, 10)));
    const world = worldOfContract(ctx);
    const opps = oppRundown(a, { opps: world.opps, totals4w: totals, coveredAes: ctx.attribution?.coveredAes ?? [], asOf: today, ...(q.accountId ? { accountIds: [q.accountId] } : {}) });
    return { entryId: q.entryId ?? null, needsAsk: a ? a.needsAsk : true, opps: opps.map((o) => ({ ...o, accountName: o.accountId ? (s.get('accounts', o.accountId)?.name ?? null) : null })) };
  }

  lookupAe(q: string): CoveredAeLookupResult {
    const t = q.trim().toLowerCase();
    const s = this.host.store();
    const owners = new Map(s.all('opps').filter((o) => o.owner).map((o) => [o.owner!.id, o.owner!] as const));
    const hits = s
      .all('people')
      .filter((p) => p.name.toLowerCase().includes(t) && (/\bAE\b|account exec/i.test(p.role ?? '') || owners.has(p.id)))
      .slice(0, 10)
      .map((p) => ({ name: p.name, org62UserId: null, email: p.email ?? null, title: p.role ?? null, source: 'app' as const }));
    return { q, hits, live: false, note: 'Mock data: the app’s placeholder people (no Org62 here)' };
  }

  /** Rules the engine reads now (tests and the parity check). */
  activeRules(): LearnedRule[] {
    return this.rules().filter(ruleActive);
  }
}

// ---------------------------------------------------------------------------
// D-103 (b): the mock's Specialist Forecasts (placeholders) and each suggestion's context
// ---------------------------------------------------------------------------

/**
 * The mock Org62's open Data & AI Specialist Forecasts of covered AEs (placeholders only): one on an opp I have never
 * touched (not on its team, no hours), so the suggestion and its chips show at scale 1.
 */
export const MOCK_SPECIALIST_FORECASTS: ReadonlyArray<{ oppId: string; recordId: string; ownerOrg62Id: string; ownerName: string; productLine: string }> = [
  { oppId: 'opp_globex_renew', recordId: 'a0X000000000001AAA', ownerOrg62Id: '005000000000001AAA', ownerName: 'Elena Cruz', productLine: 'Data Cloud' },
];

/** The candidate's Specialist Forecast fields (chunk 1's matcher reads `specialistForecastOwnerIds`; R3-3: the product lines join the products). */
export function mockSfrFields(oppId: string, products?: readonly string[]): { specialistForecastOwnerIds?: string[]; seenVia?: 'sfr'; products?: string[] } {
  const rows = MOCK_SPECIALIST_FORECASTS.filter((r) => r.oppId === oppId);
  if (!rows.length) return {};
  const merged = [...(products ?? [])];
  for (const r of rows) if (!merged.some((x) => x.toLowerCase() === r.productLine.toLowerCase())) merged.push(r.productLine);
  return { specialistForecastOwnerIds: rows.map((r) => r.ownerOrg62Id), seenVia: 'sfr', products: merged };
}

/** A suggestion's context in the mock: the other DCs the sweep saw on the opp, and its Specialist Forecasts' owners. */
export function mockDcContext(s: Store, oppId: string, coveredOwner: string | null): DcSuggestion['context'] {
  const other = s.all('missedOpps').filter((x) => x.oppId === oppId).flatMap((x) => x.otherDcs);
  const sfr = MOCK_SPECIALIST_FORECASTS.filter((r) => r.oppId === oppId);
  return dcContextOf({
    dcs: [...new Set(other)].map((n) => ({ ownerName: n, role: null, split: null, isMine: false })),
    team: [],
    sfr: sfr.length ? { ownerNames: sfr.map((r) => r.ownerName) } : null,
    coveredOnTeam: coveredOwner,
  });
}

/** D-103 (d): the last call on each account and the time zone, for the one dismissal rule (resurface.ts). */
export function mockCallsOf(s: Store, nowIso: string): { calls: Map<string, string>; timezone: string } {
  return { calls: lastCallsByAccount(s.all('activity'), s.all('accounts'), s.all('opps'), nowIso), timezone: s.settings().profile.timezone || s.meta().timezone };
}
