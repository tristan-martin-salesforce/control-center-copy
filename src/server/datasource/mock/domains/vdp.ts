/**
 * The mock DataSource, vdp domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id, I, Res } from '../shared';
import { personaOf, featureActive } from '@/personas';
import { type ActionDestination, type VdpBackfillRun, allowAssistantToday, budgetsForDay, raiseSummary, type VdpPushRun } from '@/contract';
import { invalid, notFound } from '@/server/errors';
import { planUseCases } from '@/engines/activity/use-cases';
import { renderAll } from '../render';
import { MOCK_VDP_BASE, mockAccountHierarchy, mockBackfillFinds, mockCompanySearch, mockIdentityJudgments, mockSpecialistAes, mockVdpCandidates, mockVdpServer, mockVdpSnapshots } from '@/mock/vdp';
import { identityIn, nextOverrides, overrideFrom, searchCompaniesLocal, searchResult, withoutOverride } from '@/server/vdp/identity';
import { resolveCompanyIdentity } from '@/engines/vdp/identity';
import type { AccountHierarchy } from '@/lib/accounts/hierarchy';
import { vdpDraftRefs, vdpHomeOf } from '@/engines/vdp/status';
import { inVdp, screenCandidates } from '@/engines/vdp/assets';
import { assetTargets, candidateKey, checkTransition, effectiveSlug, slugByAccount, vdpDetailFrom, type CandidateRecord } from '@/server/vdp/detail';
import { expectedRunUsd, planFindAssets, targetForKey, vdpDetailCandidate } from '@/server/vdp/find';
import { chatLimitsFromEnv } from '@/server/chat/outputs';
import type { VdpServerInfo, VdpSnapshot } from '@/lib/vdp/types';
import { actionDraftFor, gapEntities, vdpActionFor, vdpActionForItem, vdpCoverageAndQueue, vdpCoverageFrom, type CoverageAutopilot } from '@/server/vdp/coverage';
import { runVdpAutopilot, type AutopilotPort, type AutopilotRunResult } from '@/server/vdp/autopilot';
import { startVdpPush, type PushRoutePort } from '@/server/vdp/push';
import { EMPTY_LEDGER, type AutopilotLedger } from '@/engines/vdp/autopilot';
import { localDay as vdpLocalDay } from '@/engines/activity/time';
import { sendingOf as sendingSection } from '@/outbox/settings';
import { actionSummary } from '@/lib/actions';

export class MockVdp {
  constructor(private readonly ctx: MockCtx) {}

  /** D-59: Home's and the Time badge's VDP input (the coverage summary), only while VDP is active for the persona. */
  vdpHome() {
    if (!featureActive(personaOf(this.ctx.store.settings()), 'vdp')) return undefined;
    return vdpHomeOf(this.vdpCoverageNow());
  }

  /** Placeholder VDPs (src/mock/vdp.ts), built once from the seed's accounts and opps. The mock never calls VDP. */
  private vdpMirror: VdpSnapshot[] | null = null;
  vdpSnapshots(): VdpSnapshot[] {
    this.vdpMirror ??= mockVdpSnapshots(this.ctx.store.all('accounts'), this.ctx.store.all('opps'), this.ctx.store.meta().user, this.ctx.nowIso());
    return this.vdpMirror;
  }

  /** What the placeholder VDP server lists (src/mock/vdp.ts mockVdpServer), built once like the mirror. */
  vdpServerInfo: VdpServerInfo | null = null;
  private vdpServer(): VdpServerInfo {
    this.vdpServerInfo ??= mockVdpServer(this.ctx.store.all('accounts'), this.ctx.store.all('opps'), this.vdpSnapshots(), this.ctx.nowIso());
    return this.vdpServerInfo;
  }

  /** Placeholder asset candidates (src/mock/vdp.ts) and the simulated "Find assets" runs, per store reset. */
  vdpCands: CandidateRecord[] | null = null;
  vdpRuns = new Map<string, VdpBackfillRun>();
  private vdpRunSeq = 0;
  vdpCandidates(): CandidateRecord[] {
    if (!this.vdpCands) {
      const cov = this.vdpCoverageBase();
      this.vdpCands = screenCandidates(mockVdpCandidates(this.vdpSnapshots(), assetTargets(cov, this.vdpSnapshots(), this.ctx.store.all('accounts')), this.ctx.nowIso()));
    }
    return this.vdpCands;
  }
  /** The research budget, as the db reads it (per run, the assistant's day line; the mock spends nothing on research). */
  private vdpBudget() {
    const s = this.ctx.store.settings();
    const lim = chatLimitsFromEnv(process.env, 'sonnet', s.chat);
    const eff = budgetsForDay(s.budgets, this.mockDay());
    const line = eff.chatUsd != null && process.env.CC_CHAT_DAILY_USD === undefined ? eff.chatUsd : lim.chatDailyUsd;
    return { perRunUsd: lim.researchUsd, dayLeftUsd: line, lineUsd: line, hardLeftUsd: Math.max(0, eff.hardUsd - this.ctx.store.spend().today.usd) };
  }
  private mockDay(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.ctx.store.settings().profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.ctx.now());
  }
  /** VDP autopilot's ledger (D-60), per store reset like the mirror. */
  vdpLedger: AutopilotLedger = EMPTY_LEDGER;
  /** VDP's sign-in in mock mode: always fine unless a test says otherwise. */
  private vdpAuth: 'ok' | 'stale' = 'ok';
  vdpAutopilotInputs(): CoverageAutopilot {
    const sending = sendingSection(this.ctx.store.settings().sending);
    const tz = this.ctx.store.settings().profile.timezone;
    return { settings: { on: sending.channels.vdp.autopilot, dryRun: sending.dryRun, cap: sending.channels.vdp.dailyCap, assetHosts: sending.autopilotAssetHosts }, ledger: this.vdpLedger, auth: this.vdpAuth, today: vdpLocalDay(this.ctx.now().getTime(), tz), dayOf: (iso) => vdpLocalDay(Date.parse(iso), tz) };
  }
  private vdpCoverageBase(assets?: Parameters<typeof vdpCoverageFrom>[0]['assets'], ap?: CoverageAutopilot) {
    return this.vdpCoverageAndQueueBase(assets, ap).coverage;
  }
  /** D-63: the latest "Push N to VDP" (its progress), per store reset like the mirror. */
  vdpPush: VdpPushRun | null = null;
  /** D-69: the placeholder Org62 hierarchy (src/mock/vdp.ts), built once per store reset like the mirror. */
  vdpHierarchy: AccountHierarchy | null = null;
  private vdpIdentityInputs() {
    this.vdpHierarchy ??= mockAccountHierarchy(this.ctx.store.all('accounts'), this.ctx.nowIso());
    const ents = gapEntities(this.ctx.store.all('accounts'), this.ctx.store.all('opps'));
    const overrides = this.ctx.store.all('vdpIdentity');
    // the placeholder judgment is made for the units as they read now (its hash is theirs), like a cached decision
    const units = resolveCompanyIdentity({ accounts: ents.accounts, opps: ents.opps, vdps: this.vdpSnapshots(), hierarchy: this.vdpHierarchy, lookups: this.vdpServer().companies, overrides }).units;
    return { hierarchy: this.vdpHierarchy, overrides, judgments: mockIdentityJudgments(units, this.ctx.nowIso()) };
  }
  private vdpCoverageAndQueueBase(assets?: Parameters<typeof vdpCoverageFrom>[0]['assets'], ap?: CoverageAutopilot) {
    const user = this.ctx.store.meta().user;
    const at = this.ctx.nowIso();
    return vdpCoverageAndQueue({
      ...this.vdpIdentityInputs(),
      // D-63: the placeholder Specialist Forecast AEs (the db reads Org62's, src/server/vdp/specialist-aes.ts)
      aesByOpp: mockSpecialistAes(this.ctx.store.all('accounts'), this.ctx.store.all('opps')),
      push: this.vdpPush,
      autopilot: ap ?? this.vdpAutopilotInputs(),
      records: this.vdpSnapshots().map((s) => ({ snapshot: s, goneAt: null, lastSeenAt: s.lastActivityAt ?? at })),
      accounts: this.ctx.store.all('accounts'),
      opps: this.ctx.store.all('opps'),
      me: { name: user.name, email: user.email },
      now: at,
      vdpBaseUrl: MOCK_VDP_BASE,
      drafts: this.ctx.store.all('drafts'),
      server: this.vdpServer(),
      ...(assets ? { assets } : {}),
      // D-67: the use-case round trip's VDP-side items
      useCaseGaps: planUseCases(this.ctx.ds.deals.ucPlanInput()).vdpGaps,
    });
  }
  private vdpCoverageNow() {
    const b = this.vdpBudget();
    const running = [...this.vdpRuns.values()].filter((r) => r.status === 'queued' || r.status === 'running').length;
    return this.vdpCoverageBase({ candidates: this.vdpCandidates(), perRunUsd: b.perRunUsd, runUsd: expectedRunUsd(this.vdpRuns, b.perRunUsd), dayLeftUsd: b.dayLeftUsd, running });
  }

  async getVdpCoverage(_i: I<'getVdpCoverage'>): Promise<Res<'getVdpCoverage'>> {
    return this.vdpCoverageNow();
  }

  async getVdpDetail({ query }: I<'getVdpDetail'>): Promise<Res<'getVdpDetail'>> {
    const b = this.vdpBudget();
    return vdpDetailFrom({
      key: query.key,
      coverage: this.vdpCoverageNow(),
      snapshots: this.vdpSnapshots(),
      accounts: this.ctx.store.all('accounts'),
      opps: this.ctx.store.all('opps'),
      candidates: this.vdpCandidates(),
      backfill: { last: this.vdpRuns.get(query.key) ?? null, perRunUsd: b.perRunUsd, dayLeftUsd: b.dayLeftUsd, available: true, note: null },
      server: this.vdpServer(),
      assetDrafts: vdpDraftRefs(this.ctx.store.all('drafts')),
    });
  }

  async setVdpCandidate({ params, body }: I<'setVdpCandidate'>): Promise<Res<'setVdpCandidate'>> {
    const list = this.vdpCandidates();
    const i = list.findIndex((c) => c.id === params.id);
    if (i < 0) throw notFound('Asset candidate', params.id);
    const cur = list[i]!;
    checkTransition(cur.status, body.status);
    const next = cur.status === body.status ? cur : { ...cur, status: body.status, statusAt: this.ctx.nowIso() };
    list[i] = next;
    const cov = this.vdpCoverageNow();
    const key = candidateKey(next, slugByAccount(cov.vdps)) ?? next.targetKey;
    const verb = body.status === 'added' ? 'Marked added' : body.status === 'dismissed' ? 'Dismissed' : cur.status === 'unsure' ? 'Confirmed' : 'Put back';
    const entry = this.ctx.audit.record({ at: this.ctx.nowIso(), actor: 'user', action: `vdp.candidate.${body.status}`, summary: `${verb}: ${next.title} (VDP asset)`.slice(0, 200), entity: { type: 'vdp', id: key, label: next.companyName }, related: [], ops: [], undoable: false, undoOf: null });
    this.ctx.publish(['deals', 'audit'], [key], `vdp.candidate.${body.status}`);
    return { entity: vdpDetailCandidate({ coverage: cov, snapshots: this.vdpSnapshots() }, next), auditId: entry.id };
  }

  /** "Find assets" in mock mode: queued → running → done after a few seconds, with placeholder finds. Never calls anything. */
  async findVdpAssets({ body }: I<'findVdpAssets'>): Promise<Res<'findVdpAssets'>> {
    let b = this.vdpBudget();
    let auditId: string | null = null;
    if (body.allowUsd && !body.estimateOnly) {
      const s = this.ctx.store.settings();
      let out: ReturnType<typeof allowAssistantToday>;
      try {
        out = allowAssistantToday(s.budgets, { day: this.mockDay(), atIso: this.ctx.nowIso(), addUsd: body.allowUsd, lineUsd: b.lineUsd, assistantLeftUsd: b.dayLeftUsd, hardLeftUsd: b.hardLeftUsd, reason: 'Find assets for all' });
      } catch (e) {
        throw invalid(e instanceof Error ? e.message : String(e));
      }
      const { next: budgets, raise } = out;
      const { entry } = this.ctx.tx({ actor: 'user', action: 'settings.budgets', summary: raiseSummary(raise), entity: { type: 'settings', id: 'budgets', label: 'Settings · budgets' } }, (tx) => {
        tx.put('settings', { ...s, budgets });
        const sp = this.ctx.store.spend();
        const pct = raise.toSoftUsd > 0 ? Math.round((sp.today.usd / raise.toSoftUsd) * 100) : 0;
        tx.put('spend', { ...sp, today: { ...sp.today, softBudgetUsd: raise.toSoftUsd, hardCapUsd: raise.toHardUsd, pct }, state: sp.today.usd >= raise.toHardUsd ? 'capped' : pct >= budgets.alertPct ? 'soft_alert' : 'ok' });
      });
      auditId = entry?.id ?? null;
      b = this.vdpBudget();
    }
    const cov = this.vdpCoverageNow();
    const plan = planFindAssets({ body, coverage: cov, snapshots: this.vdpSnapshots(), accounts: this.ctx.store.all('accounts'), runs: this.vdpRuns, perRunUsd: b.perRunUsd, dayLeftUsd: b.dayLeftUsd });
    if (body.estimateOnly || !plan.queued.length) return { entity: { ...plan, started: false }, auditId };
    plan.queued.forEach((q, n) => {
      const t = targetForKey(q.key, cov, this.vdpSnapshots(), this.ctx.store.all('accounts'))!;
      const run = ++this.vdpRunSeq;
      const at = this.ctx.nowIso();
      this.vdpRuns.set(q.key, { status: 'queued', startedAt: at, finishedAt: null, found: 0, costUsd: null, note: null });
      const step = Math.max(20, this.ctx.delays.stepMs);
      this.ctx.later(step * (n + 1), () => {
        const r = this.vdpRuns.get(q.key);
        if (r?.status === 'queued') this.vdpRuns.set(q.key, { ...r, status: 'running' });
        this.ctx.publish(['deals'], [q.key], 'vdp.assets.running');
      });
      this.ctx.later(step * (n + 2), () => {
        const list = this.vdpCandidates();
        const finds = mockBackfillFinds(t, run, this.ctx.nowIso()).filter((f) => !list.some((c) => c.targetKey === f.targetKey && c.assetKey === f.assetKey) && !inVdp(f, t.inVdp));
        list.push(...finds);
        this.vdpRuns.set(q.key, { status: 'done', startedAt: at, finishedAt: this.ctx.nowIso(), found: finds.length, costUsd: 0, note: 'Simulated in mock mode: placeholder finds' });
        this.ctx.publish(['deals'], [q.key], 'vdp.assets.done');
      });
    });
    this.ctx.publish(['deals'], plan.queued.map((q) => q.key), 'vdp.assets.queued');
    return { entity: { ...plan, started: true }, auditId };
  }

  async draftVdpUpdate({ body }: I<'draftVdpUpdate'>): Promise<Res<'draftVdpUpdate'>> {
    let dest: ActionDestination;
    if (body.itemKey) {
      // One item's Apply, rebuilt from the mirror (D-59): the call the page shows, never the client's ids.
      const cov = this.vdpCoverageNow();
      const c = body.itemKey.startsWith('asset:') ? this.vdpCandidates().find((x) => `asset:${x.id}` === body.itemKey) : undefined;
      const slug = c ? effectiveSlug(c, slugByAccount(cov.vdps)) : null;
      const views = slug ? (await this.getVdpDetail({ query: { key: slug } } as I<'getVdpDetail'>)).candidates.filter((x) => x.id === c!.id).map((x) => ({ id: x.id, vdpSlug: x.vdpSlug, title: x.title, apply: x.apply, draftId: x.draftId })) : [];
      dest = vdpActionForItem(cov, this.vdpSnapshots(), body, views, { duplicateOf: this.ctx.ds.deals.ucGuard() });
    } else {
      const snap = this.vdpSnapshots().find((s) => s.slug === body.vdpSlug);
      if (!snap) throw notFound('VDP', body.vdpSlug ?? '(none)');
      dest = vdpActionFor(snap, body, { duplicateOf: this.ctx.ds.deals.ucGuard() });
    }
    const draft = actionDraftFor(dest, { id: id('d'), now: this.ctx.nowIso(), workItemId: body.workItemId ?? null, rendered: (doc) => renderAll(dest, doc) });
    const { entry } = this.ctx.tx({ actor: 'user', action: 'vdp.update.draft', summary: `VDP change for approval: ${actionSummary(dest)}`.slice(0, 200), entity: { type: 'draft', id: draft.id, label: dest.target.label } }, (tx) => tx.put('drafts', draft));
    return { entity: { draft, destination: dest }, auditId: entry?.id ?? null };
  }

  /**
   * D-60, D-63: "Push N to VDP": the ticked items and what they need first, staged and applied in order on this click,
   * each new id passed down (the simulated transport; dry run records only). The mock has no worker: it runs here.
   */
  async pushVdpChanges({ body }: I<'pushVdpChanges'>): Promise<Res<'pushVdpChanges'>> {
    return startVdpPush(this.vdpPushPort(), body);
  }

  // ---- D-69: company identity (Change… on a company node); the mock never calls VDP

  async searchVdpCompanies({ query }: I<'searchVdpCompanies'>): Promise<Res<'searchVdpCompanies'>> {
    return searchResult(query.q, searchCompaniesLocal(query.q, this.vdpSnapshots(), this.vdpServer(), mockCompanySearch(query.q)), false, 'Placeholder companies (mock data)');
  }

  async setVdpIdentity({ body }: I<'setVdpIdentity'>): Promise<Res<'setVdpIdentity'>> {
    const next = overrideFrom(body, this.ctx.store.all('accounts'), this.ctx.nowIso());
    const all = nextOverrides(this.ctx.store.all('vdpIdentity'), next, body.key ?? null);
    const label = next.pick.kind === 'match' ? next.pick.name : `create “${next.pick.name}”`;
    const { entry } = this.ctx.tx({ actor: 'user', action: 'vdp.identity.set', summary: `VDP company: ${label} for ${next.accountIds.length} ${next.accountIds.length === 1 ? 'account' : 'accounts'} (yours)`.slice(0, 200), entity: { type: 'vdp', id: next.key, label } }, (tx) => {
      for (const o of this.ctx.store.all('vdpIdentity')) if (!all.some((x) => x.key === o.key)) tx.remove('vdpIdentity', o.key);
      for (const o of all) tx.put('vdpIdentity', o);
    });
    return { entity: { identity: identityIn(this.vdpCoverageNow(), next.key), overrides: this.ctx.store.all('vdpIdentity').length }, auditId: entry?.id ?? null };
  }

  async clearVdpIdentity({ body }: I<'clearVdpIdentity'>): Promise<Res<'clearVdpIdentity'>> {
    const cur = this.ctx.store.get('vdpIdentity', body.key);
    if (!cur) return { entity: { identity: identityIn(this.vdpCoverageNow(), body.key), overrides: this.ctx.store.all('vdpIdentity').length }, auditId: null };
    const rest = withoutOverride(this.ctx.store.all('vdpIdentity'), body.key);
    const { entry } = this.ctx.tx({ actor: 'user', action: 'vdp.identity.clear', summary: 'VDP company: back to the app’s own decision', entity: { type: 'vdp', id: body.key, label: cur.pick.name } }, (tx) => {
      tx.remove('vdpIdentity', body.key);
      for (const o of rest) tx.put('vdpIdentity', o);
    });
    return { entity: { identity: identityIn(this.vdpCoverageNow(), body.key), overrides: this.ctx.store.all('vdpIdentity').length }, auditId: entry?.id ?? null };
  }

  /** The push's port over the mock store (stage, withdraw, the simulated Outbox delivery, progress). */
  private vdpPushPort(): PushRoutePort {
    const vdpDrafts = () => new Map(this.ctx.store.all('drafts').filter((d) => d.destination.kind === 'action' && d.destination.action.startsWith('vdp.')).map((d) => [d.id, d] as const));
    return {
      now: () => this.ctx.now(),
      newId: () => id('push'),
      dryRunNow: async () => sendingSection(this.ctx.store.settings().sending).dryRun,
      // the mock's mirror is VDP itself (always current): a live push never waits for a read here (D-69 VD-22)
      state: async () => {
        const coverage = this.vdpCoverageNow();
        return { coverage: { ...coverage, lastReadAt: coverage.lastReadAt ? this.ctx.nowIso() : null }, snapshots: this.vdpSnapshots(), drafts: vdpDrafts(), duplicateOf: this.ctx.ds.deals.ucGuard() };
      },
      draft: async (draftId) => this.ctx.store.get('drafts', draftId) ?? null,
      stage: async (dest) => {
        const draft = actionDraftFor(dest, { id: id('d'), now: this.ctx.nowIso(), rendered: (doc) => renderAll(dest, doc) });
        this.ctx.tx({ actor: 'user', action: 'vdp.update.draft', summary: `VDP change for approval: ${actionSummary(dest)}`.slice(0, 200), entity: { type: 'draft', id: draft.id, label: dest.target.label } }, (tx) => tx.put('drafts', draft));
        return draft;
      },
      discard: async (draftId, reason) => {
        const d = this.ctx.store.get('drafts', draftId);
        if (!d || (d.status !== 'ready' && d.status !== 'failed')) return;
        this.ctx.tx({ actor: 'system', action: 'vdp.push.withdraw', summary: `${reason}: ${d.destination.kind === 'action' ? d.destination.target.label : 'VDP change'}`.slice(0, 200), entity: { type: 'draft', id: d.id, label: 'VDP change' }, undoable: false }, (tx) => tx.put('drafts', this.ctx.bump({ ...d, status: 'discarded', rejectedReason: reason })));
      },
      deliver: async (draft) => {
        try {
          const cur = this.ctx.store.get('drafts', draft.id) ?? draft;
          const r = await this.ctx.ds.outbox.dispatch({ params: { id: cur.id }, body: { ifVersion: cur.version, mode: 'send', confirmToken: this.ctx.ds.drafts.confirmTokenFor(cur, 'send') } } as I<'dispatchDraft'>);
          if (r.dryRun) return { outcome: 'dry_run', externalId: null, link: null, detail: 'Dry run: recorded, nothing sent' };
          return { outcome: 'applied', externalId: r.draft.externalId ?? null, link: r.draft.resultUrl ?? null, detail: 'Applied (simulated)' };
        } catch (err) {
          return { outcome: 'failed', externalId: null, link: null, detail: ((err as Error).message || 'Delivery failed').slice(0, 300) };
        }
      },
      progress: async (run) => {
        this.vdpPush = run;
        this.ctx.publish(['deals', 'outbox'], [], 'vdp.push');
      },
    };
  }

  /**
   * D-60: one VDP autopilot run in mock mode: the shared runner, staging each item from the placeholder mirror and
   * applying it through the simulated Outbox (never anything real). `auth` lets a test make VDP's sign-in stale.
   */
  async runVdpAutopilot(deps: { auth?: 'ok' | 'stale' } = {}): Promise<AutopilotRunResult> {
    if (deps.auth) this.vdpAuth = deps.auth;
    const port: AutopilotPort = {
      now: () => this.ctx.now(),
      settings: async () => ({ sending: this.ctx.store.settings().sending, timezone: this.ctx.store.settings().profile.timezone }),
      auth: async () => this.vdpAuth,
      ledger: async () => this.vdpLedger,
      saveLedger: async (next) => {
        this.vdpLedger = next;
        this.ctx.publish(['deals', 'outbox'], [], 'vdp.autopilot');
      },
      plan: async (ap) => {
        const b = this.vdpBudget();
        const r = this.vdpCoverageAndQueueBase({ candidates: this.vdpCandidates(), perRunUsd: b.perRunUsd, runUsd: expectedRunUsd(this.vdpRuns, b.perRunUsd), dayLeftUsd: b.dayLeftUsd, running: 0 }, ap);
        return { coverage: r.coverage, queue: r.queue, snapshots: this.vdpSnapshots() };
      },
      apply: async (_item, dest) => {
        if (sendingSection(this.ctx.store.settings().sending).dryRun) return { draftId: null, outcome: 'dry_run', detail: null, url: null };
        const draft = { ...actionDraftFor(dest, { id: id('d'), now: this.ctx.nowIso(), rendered: (doc) => renderAll(dest, doc) }), appliedBy: 'autopilot' as const };
        this.ctx.tx({ actor: 'system', action: 'vdp.autopilot.apply', summary: `VDP autopilot applied: ${actionSummary(dest)}`.slice(0, 200), entity: { type: 'draft', id: draft.id, label: dest.target.label } }, (tx) => tx.put('drafts', draft));
        try {
          const r = await this.ctx.ds.outbox.dispatch({ params: { id: draft.id }, body: { ifVersion: draft.version, mode: 'send', confirmToken: this.ctx.ds.drafts.confirmTokenFor(draft, 'send') } } as I<'dispatchDraft'>);
          // the draft keeps appliedBy: 'autopilot' through the dispatch (Outbox ▸ Sent: "Applied automatically")
          return r.dryRun ? { draftId: draft.id, outcome: 'dry_run', detail: null, url: null } : { draftId: draft.id, outcome: 'applied', detail: 'Applied (simulated)', url: r.draft.resultUrl };
        } catch (err) {
          return { draftId: draft.id, outcome: 'failed', detail: ((err as Error).message || 'Delivery failed').slice(0, 300), url: null };
        }
      },
    };
    return runVdpAutopilot(port);
  }
}
