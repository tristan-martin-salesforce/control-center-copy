/**
 * The db DataSource, vdp domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res } from '../shared';
import { eq, sql } from 'drizzle-orm';
import { type ActionDestination, type Draft, type Settings, allowAssistantToday, raiseSummary, type VdpPushRun } from '@/contract';
import { localDay as localDayOf } from '@/engines/activity/time';
import { enqueueJob } from '@/db/queue';
import { drafts as draftsTable, draftSendAttempts as draftAttemptsTable } from '@/db/schema';
import { featureActive, personaOf } from '@/personas';
import { invalid, notFound } from '@/server/errors';
import { payloadFor, renderAll } from '../../mock/render';
import type { ReadModel } from '../model';
import { VDP } from '../reads/scope';
import { readMemo, withReadMemo } from '../reads/session';
import { writeKv, type WriteCtx } from '../store/common';
import { writeSpend } from '../store/health';
import { insertDraft, updateDraft } from '../store/nba';
import { deletedOrg62OppIds, loadGapEntities, loadVdpRecords, loadVdpServer } from '../store/vdp';
import { assistantDayLeft, backfillRuns, checkTransition, enqueueBackfill, loadCandidates, setCandidateStatus, VDP_ASSETS_QUEUE } from '../store/vdp-candidates';
import { candidateKey, effectiveSlug, slugByAccount, vdpDetailFrom } from '@/server/vdp/detail';
import { expectedRunUsd, planFindAssets, vdpDetailCandidate } from '@/server/vdp/find';
import { actionDraftFor, gapEntities, vdpActionFor, vdpActionForItem, vdpCoverageAndQueue, type CoverageAutopilot } from '@/server/vdp/coverage';
import { runVdpAutopilot, type AutopilotApplyResult, type AutopilotPort, type AutopilotRunResult } from '@/server/vdp/autopilot';
import { activePushOf, liveMadeVia, nextPushRuns, publicPushRun, pushRunsOf, pushTimeoutSeconds, runVdpPush, settlePushRuns, startVdpPush, VDP_PUSH_JOB, VDP_PUSH_KV, type PushDelivery, type PushRoutePort, type VdpLiveReads } from '@/server/vdp/push';
import { identityIn, nextOverrides, overrideFrom, searchCompaniesLocal, searchResult, withoutOverride } from '@/server/vdp/identity';
import { judgmentsOf, overridesOf, VDP_IDENTITY_JUDGE_KV, VDP_IDENTITY_KV } from '@/engines/vdp/identity';
import { ACCOUNT_HIERARCHY_KV, hierarchyOf } from '@/lib/accounts/hierarchy';
import { VdpClient } from '@/connectors/vdp/client';
import { vdpCallLimiter } from '@/connectors/vdp/limiter';
import { aeCacheOf, aesByLocalOpp, VDP_AES_KV } from '@/server/vdp/specialist-aes';
import { ledgerOf, VDP_AUTOPILOT_KV, type AutopilotItem } from '@/engines/vdp/autopilot';
import { goneVdpDrafts, VDP_WITHDRAWN_REASON, vdpDraftRefs, vdpHomeOf } from '@/engines/vdp/status';
import { actionSummary } from '@/lib/actions';
import { dbOutboxPort, DELIVERED_STATUSES, dispatchAttempt, planDispatch, recordDispatch } from '../outbox';
import { writeSection } from '../store/settings';
import { liveOrg62 } from '@/server/chat/record-type';
import { loadUseCaseInput } from '../store/use-cases';
import { planUseCases } from '@/engines/activity/use-cases';
import { ucDuplicateGuard } from '@/server/deals/use-cases';
import { payloadHash, runOutboxJob, sendingOf, VDP_AUTOPILOT_POLICY, type OutboxGateway } from '@/outbox';

/** D-69: the push's live reads over the VDP read client (read tools only). */
function vdpLiveReads(c: VdpClient, signal?: AbortSignal): VdpLiveReads {
  const o = signal ? { signal } : {};
  return { findCompany: (q) => c.findCompany(q, o), vdpsOfCompany: (id) => c.vdpsOfCompany(id, o), getVdp: (slug) => c.getVdp(slug, undefined, o) };
}

export class DbVdp {
  constructor(private readonly ctx: DbCtx) {}

  /** D-59: Home's and the Time badge's VDP input (the coverage summary), only while VDP is active for the persona. */
  async vdpHome(model: ReadModel) {
    if (!featureActive(personaOf(model.settings()), 'vdp')) return undefined;
    return vdpHomeOf((await this.vdpState(model)).coverage);
  }

  /** Who "me" is for the gap check's copy text (the TA line). */
  private async meContact(userId: string): Promise<{ name: string; email: string | null }> {
    const r = await this.ctx.db.execute<{ name: string | null; email: string | null }>(sql`select display_name as name, email from users where id = ${userId}`).catch(() => ({ rows: [] as Array<{ name: string | null; email: string | null }> }));
    return { name: r.rows[0]?.name ?? '', email: r.rows[0]?.email ?? null };
  }

  /** The mirror, my book (with the tables' Org62 ids), the asset candidates, the "Find assets" runs and the budget. */
  /**
   * VDP autopilot's coverage inputs (D-60): the stored setting, its ledger (kv `vdp.autopilot`), VDP's sign-in (the
   * connector's Health, for the page; a run passes the live check) and today in the user's zone.
   */
  async vdpAutopilotInputs(m: ReadModel, auth?: 'ok' | 'stale' | null): Promise<CoverageAutopilot> {
    const sending = sendingOf(m.settings().sending);
    const tz = m.settings().profile.timezone;
    let a = auth;
    if (a === undefined) {
      const db = this.ctx.db;
      const r = await readMemo(db, `vdpConnectorStatus:${m.ctx.userId}`, async () => db.execute<{ status: string }>(sql`select status from connectors where owner_user_id = ${m.ctx.userId} and kind = 'vdp' order by updated_at desc limit 1`)); // async: a drizzle query runs on every await
      const s = r.rows[0]?.status;
      a = !s ? null : s === 'auth_required' || s === 'disabled' ? 'stale' : 'ok';
    }
    return {
      settings: { on: sending.channels.vdp.autopilot, dryRun: sending.dryRun, cap: sending.channels.vdp.dailyCap, assetHosts: sending.autopilotAssetHosts },
      ledger: ledgerOf(m.ctx.kv.get(VDP_AUTOPILOT_KV)),
      auth: a,
      today: localDayOf(this.ctx.now().getTime(), tz),
      dayOf: (iso) => localDayOf(Date.parse(iso), tz),
    };
  }

  private async vdpState(model?: ReadModel, ap?: CoverageAutopilot) {
    const m = model ?? (await this.ctx.model(WHOLE));
    const userId = m.ctx.userId;
    const db = this.ctx.db;
    // post-2.0 Home SQL: the reads are independent (all on the pool), so they run together, not one after another
    const [records, t, candidates, runs, budget, server, autopilot, me, pushRuns, deletedOppIds, uc] = await Promise.all([
      loadVdpRecords(db, userId),
      // Org62 ids from the tables, the same ones the mirror sink linked with.
      loadGapEntities(db, userId),
      loadCandidates(db, userId),
      backfillRuns(db, userId),
      assistantDayLeft(db, userId, m.settings(), localDayOf(this.ctx.now().getTime(), m.settings().profile.timezone)),
      loadVdpServer(db, userId),
      ap ?? this.vdpAutopilotInputs(m),
      this.meContact(userId),
      // 2026-11-16: every recent push, settled against its worker job (a push whose job ended reads as stopped)
      this.settledPushRuns(pushRunsOf(m.ctx.kv.get(VDP_PUSH_KV))),
      deletedOrg62OppIds(db, userId),
      // D-67: the use-case round trip with Org62: its VDP-side items, and the duplicate check before a new use case
      loadUseCaseInput(db, userId),
    ]);
    const entities = gapEntities(m.all('accounts'), m.all('opps'), { accounts: new Map(t.accounts.map((a) => [a.id, a.org62AccountId])), opps: new Map(t.opps.map((o) => [o.id, o.org62OpportunityId])) });
    const running = [...runs.values()].filter((r) => r.status === 'queued' || r.status === 'running').length;
    const drafts = m.all('drafts');
    // D-63: who the AE is (the Specialist Forecast cache), seed VDPs I am on (my emails), and the latest push
    const aesByOpp = aesByLocalOpp(aeCacheOf(m.ctx.kv.get(VDP_AES_KV)), entities.opps);
    const myEmails = [me.email, ...(process.env.CC_ME_ALIASES ?? '').split(',').map((s) => s.trim())].filter((e): e is string => !!e && e.includes('@'));
    const pushes = pushRuns.map(publicPushRun);
    const push = pushes[0] ?? null;
    // D-69: the Org62 hierarchy, the judgment cache and your mappings (Change…), all kv
    const rawHierarchy = m.ctx.kv.get(ACCOUNT_HIERARCHY_KV);
    const identity = { hierarchy: rawHierarchy ? hierarchyOf(rawHierarchy) : null, judgments: judgmentsOf(m.ctx.kv.get(VDP_IDENTITY_JUDGE_KV)), overrides: overridesOf(m.ctx.kv.get(VDP_IDENTITY_KV)), deletedOrg62OppIds: deletedOppIds };
    const useCaseGaps = planUseCases(uc).vdpGaps;
    const duplicateOf = ucDuplicateGuard({ vdps: [...uc.vdps, ...(uc.goneVdps ?? [])], records: uc.org62.records, opps: uc.opps, drafts });
    const { coverage, queue, identityPending } = vdpCoverageAndQueue({ records, accounts: m.all('accounts'), opps: m.all('opps'), entities, me, myEmails, now: this.ctx.now().toISOString(), assets: { candidates, perRunUsd: budget.perRunUsd, runUsd: expectedRunUsd(runs, budget.perRunUsd), dayLeftUsd: budget.dayLeftUsd, running }, drafts, server, autopilot, aesByOpp, push, pushes, useCaseGaps, ...identity });
    const snapshots = records.filter((r) => r.snapshot && !r.goneAt).map((r) => r.snapshot!);
    return { m, userId, coverage, queue, snapshots, candidates, runs, budget, server, drafts, duplicateOf, identityPending };
  }

  /** D-69: the ambiguous company identities waiting for a judgment, from the very inputs the VDP view uses (the
   *  `vdp.identity` job judges exactly these, so a judgment it stores is always one the view applies). */
  async vdpIdentityPending() {
    return (await this.vdpState()).identityPending;
  }

  /** VDP coverage from the read-only mirror (vdp_records, written by scan.vdp). Never calls VDP. */
  async getVdpCoverage(_i: I<'getVdpCoverage'>): Promise<Res<'getVdpCoverage'>> {
    // a pure read: inside the read memo the mirror and my book read once (vdpState and the gap entities share them)
    return withReadMemo(() => this.ctx.read(VDP, async (m) => (await this.vdpState(m)).coverage));
  }

  /** One VDP (slug) or one engaged account with no VDP (`account:<id>`): steps, assets to add, what VDP has. */
  async getVdpDetail({ query }: I<'getVdpDetail'>): Promise<Res<'getVdpDetail'>> {
    const st = await this.vdpState();
    return vdpDetailFrom({
      key: query.key,
      coverage: st.coverage,
      snapshots: st.snapshots,
      accounts: st.m.all('accounts'),
      opps: st.m.all('opps'),
      candidates: st.candidates,
      backfill: { last: st.runs.get(query.key) ?? null, perRunUsd: st.budget.perRunUsd, dayLeftUsd: st.budget.dayLeftUsd, available: true, note: null },
      server: st.server,
      assetDrafts: vdpDraftRefs(st.drafts),
    });
  }

  /** The asset candidate an `asset:<id>` item adds, with its Apply (the VDP details view of it). */
  private assetCandidatesFor(st: Awaited<ReturnType<DbVdp['vdpState']>>, key: string) {
    const c = st.candidates.find((x) => `asset:${x.id}` === key);
    if (!c) return [];
    const slug = effectiveSlug(c, slugByAccount(st.coverage.vdps));
    if (!slug) return [];
    const d = vdpDetailFrom({ key: slug, coverage: st.coverage, snapshots: st.snapshots, accounts: st.m.all('accounts'), opps: st.m.all('opps'), candidates: st.candidates, backfill: { last: null, perRunUsd: 0, dayLeftUsd: 0, available: false, note: null }, server: st.server, assetDrafts: vdpDraftRefs(st.drafts) });
    return d.candidates.filter((x) => x.id === c.id).map((x) => ({ id: x.id, vdpSlug: x.vdpSlug, title: x.title, apply: x.apply, draftId: x.draftId }));
  }

  /** Confirm / mark added / dismiss an asset candidate. Local state: VDP is never written (adding is a handoff). */
  async setVdpCandidate({ params, body }: I<'setVdpCandidate'>): Promise<Res<'setVdpCandidate'>> {
    const st = await this.vdpState();
    const cur = st.candidates.find((c) => c.id === params.id);
    if (!cur) throw notFound('Asset candidate', params.id);
    checkTransition(cur.status, body.status);
    const verb = body.status === 'added' ? 'Marked added' : body.status === 'dismissed' ? 'Dismissed' : cur.status === 'unsure' ? 'Confirmed' : 'Put back';
    const r = await this.ctx.mutate({ action: `vdp.candidate.${body.status}`, summary: `${verb}: ${cur.title} (VDP asset)`.slice(0, 200), entity: { type: 'vdp', id: candidateKey(cur, slugByAccount(st.coverage.vdps)) ?? cur.targetKey }, undoable: false }, async (w) => setCandidateStatus(w.tx, st.userId, params.id, body.status, this.ctx.now()));
    this.ctx.bus.publishTables(['vdp_asset_candidates'], [params.id], `vdp.candidate.${body.status}`);
    const view = vdpDetailCandidate(st, r.result.after);
    return { entity: view, auditId: r.auditId };
  }

  /** "Find assets": queue read-only research runs (the worker's `vdp.assets.find`), within the per-run and total caps. */
  async findVdpAssets({ body }: I<'findVdpAssets'>): Promise<Res<'findVdpAssets'>> {
    let st = await this.vdpState();
    let auditId: string | null = null;
    if (body.allowUsd && !body.estimateOnly) {
      // the user's "Allow $N more today": today's assistant line (and the hard cap when it would bind) goes up first
      const tz = st.m.settings().profile.timezone;
      const day = localDayOf(this.ctx.now().getTime(), tz);
      const allowIn = (s: Settings) => {
        try {
          return allowAssistantToday(s.budgets, { day, atIso: this.ctx.now().toISOString(), addUsd: body.allowUsd!, lineUsd: st.budget.lineUsd, assistantLeftUsd: st.budget.dayLeftUsd, hardLeftUsd: st.budget.hardLeftUsd, reason: 'Find assets for all' });
        } catch (e) {
          throw invalid(e instanceof Error ? e.message : String(e));
        }
      };
      const first = allowIn(st.m.settings()).raise;
      const r = await this.ctx.mutate({ action: 'settings.budgets', summary: raiseSummary(first), entity: { type: 'settings', id: 'budgets' }, current: async () => (await this.ctx.model(WHOLE)).settings() }, async (w, model) => {
        const { next: budgets, raise } = allowIn(model.settings());
        await writeSection(w, 'budgets', budgets);
        const sp = model.spend();
        const pct = raise.toSoftUsd > 0 ? Math.round((sp.today.usd / raise.toSoftUsd) * 100) : 0;
        await writeSpend(w, { ...sp, today: { ...sp.today, softBudgetUsd: raise.toSoftUsd, hardCapUsd: raise.toHardUsd, pct }, state: sp.today.usd >= raise.toHardUsd ? 'capped' : pct >= budgets.alertPct ? 'soft_alert' : 'ok' });
      });
      auditId = r.auditId;
      st = await this.vdpState();
    }
    const plan = planFindAssets({ body, coverage: st.coverage, snapshots: st.snapshots, accounts: st.m.all('accounts'), runs: st.runs, perRunUsd: st.budget.perRunUsd, dayLeftUsd: st.budget.dayLeftUsd });
    if (body.estimateOnly || !plan.queued.length) return { entity: { ...plan, started: false }, auditId };
    const batch = plan.queued.length > 1 ? crypto.randomUUID() : null;
    for (const q of plan.queued) await enqueueBackfill(this.ctx.db, st.userId, { key: q.key, capUsd: plan.perRunUsd, batch });
    this.ctx.bus.publishTables(['vdp_asset_candidates'], plan.queued.map((q) => q.key), 'vdp.assets.queued');
    return { entity: { ...plan, started: true }, auditId: null };
  }

  /** Use cases to add: the VDP create_use_case Outbox item an accepted candidate drafts, in its change set (D-49 / D-67 checks). */
  async vdpUseCaseDraftIn(w: WriteCtx, _model: ReadModel, req: { vdpSlug: string; title: string; track: 'd360' | 'agentforce' }): Promise<{ id: string }> {
    const rec = (await loadVdpRecords(w.tx, w.userId)).find((r) => r.vdpSlug === req.vdpSlug && !r.goneAt);
    if (!rec?.snapshot) throw notFound('VDP', req.vdpSlug);
    const dest = vdpActionFor(rec.snapshot, { vdpSlug: req.vdpSlug, op: 'create_use_case', field: 'title', value: req.title, track: req.track }, { duplicateOf: (await this.vdpState()).duplicateOf });
    const draft = actionDraftFor(dest, { id: crypto.randomUUID(), now: w.now.toISOString(), workItemId: null, rendered: (doc) => renderAll(dest, doc) });
    await insertDraft(w, draft);
    return { id: draft.id };
  }

  async draftVdpUpdate({ body }: I<'draftVdpUpdate'>): Promise<Res<'draftVdpUpdate'>> {
    const m = await this.ctx.model(WHOLE);
    let dest: ActionDestination;
    if (body.itemKey) {
      // One item's Apply, rebuilt from the mirror (D-59): the call the page shows, never the client's ids.
      const st = await this.vdpState();
      const detail = body.itemKey.startsWith('asset:') ? this.assetCandidatesFor(st, body.itemKey) : [];
      dest = vdpActionForItem(st.coverage, st.snapshots, body, detail, { duplicateOf: st.duplicateOf });
    } else {
      const rec = (await loadVdpRecords(this.ctx.db, m.ctx.userId)).find((r) => r.vdpSlug === body.vdpSlug && !r.goneAt);
      if (!rec?.snapshot) throw notFound('VDP', body.vdpSlug ?? '(none)');
      // D-67: a new use case is checked against both systems first
      dest = vdpActionFor(rec.snapshot, body, body.op === 'create_use_case' ? { duplicateOf: (await this.vdpState(m)).duplicateOf } : {});
    }
    const workItemId = body.workItemId && m.get('workItems', body.workItemId) ? body.workItemId : null;
    const draft = actionDraftFor(dest, { id: crypto.randomUUID(), now: this.ctx.now().toISOString(), workItemId, rendered: (doc) => renderAll(dest, doc) });
    const r = await this.ctx.mutate({ action: 'vdp.update.draft', summary: `VDP change for approval: ${actionSummary(dest)}`.slice(0, 200), entity: { type: 'draft', id: draft.id }, undoable: false }, async (w) => {
      await insertDraft(w, draft);
    });
    this.ctx.bus.publishTables(['drafts'], [draft.id], 'vdp.update.draft');
    const saved = (await this.ctx.model(WHOLE)).get('drafts', draft.id) ?? draft;
    return { entity: { draft: saved, destination: dest }, auditId: r.auditId };
  }

  /**
   * D-60: withdraw the staged VDP changes whose item is open nowhere after a newer VDP read (VDP already has it): each
   * becomes discarded with "Withdrawn: VDP already has this", in one system change set. Returns the ids. The worker
   * runs it after each VDP read; it never touches an approved or applied item.
   */
  async withdrawGoneVdpDrafts(): Promise<string[]> {
    const st = await this.vdpState();
    // VD-24: the items of a push that is queued or running are its own to finish (a read landing mid-push withdraws none)
    const nowMs = this.ctx.now().getTime();
    const running = new Set(pushRunsOf(st.m.ctx.kv.get(VDP_PUSH_KV)).filter((r) => r.state !== 'done' && nowMs - Date.parse(r.at) < 30 * 60_000).flatMap((r) => r.nodes.map((n) => n.draftId).filter((x): x is string => !!x)));
    const ids = goneVdpDrafts(st.coverage, st.drafts, { running });
    if (!ids.length) return [];
    await this.ctx.mutate({ action: 'vdp.withdraw', summary: `Withdrew ${ids.length} staged VDP ${ids.length === 1 ? 'change' : 'changes'}: VDP already has ${ids.length === 1 ? 'it' : 'them'}`, entity: { type: 'draft', id: ids[0]! }, actor: 'system', undoable: false }, async (w, model) => {
      for (const id of ids) {
        const d = model.get('drafts', id);
        if (!d || (d.status !== 'ready' && d.status !== 'failed')) continue;
        await updateDraft(w, d, { ...d, status: 'discarded', rejectedReason: VDP_WITHDRAWN_REASON }, { bump: true });
      }
    });
    this.ctx.bus.publishTables(['drafts'], ids, 'vdp.withdraw');
    return ids;
  }

  /**
   * D-60, D-63: "Push N to VDP": the ticked items and what they need first, each staged as its own Outbox item now.
   * Dry run records them here (placeholders for ids a parent would create). Live, the worker's `vdp.push` runs them in
   * order (src/server/vdp/push.ts), approved by this click, passing each new id down; the Changes tab follows it.
   */
  async pushVdpChanges({ body }: I<'pushVdpChanges'>): Promise<Res<'pushVdpChanges'>> {
    return startVdpPush(this.vdpPushPort({ route: true }), body);
  }

  /**
   * D-63: the worker's `vdp.push` for one push: its items in order, each approved by the push click (approval method
   * `click`, approved at the push) and delivered by the Outbox job inline through the gateway (read-back included).
   */
  async runVdpPush(deps: { pushId: string; gateway: OutboxGateway | null; signal?: AbortSignal; reads?: VdpLiveReads | null }): Promise<Record<string, unknown>> {
    const run = pushRunsOf((await this.ctx.model(WHOLE)).ctx.kv.get(VDP_PUSH_KV)).find((r) => r.id === deps.pushId);
    if (!run) return { skipped: 'push_missing' };
    if (run.state === 'done') return { skipped: 'done' };
    // D-69 (VD-23, VD-25): the live check before each create reads VDP through the read client (the worker, live only)
    const reads = deps.reads !== undefined ? deps.reads : liveOrg62() ? vdpLiveReads(new VdpClient({ limiter: vdpCallLimiter }), deps.signal) : null;
    const out = await runVdpPush(this.vdpPushPort({ route: false, gateway: deps.gateway, ...(deps.signal ? { signal: deps.signal } : {}), reads }), run);
    // D-70: the VDP push → VDP landings (each use-case and asset item a write, sent; the mirror's read verifies it)
    await this.ctx.ds.canvas.syncLandingsQuietly('vdp.push');
    const count = (s: string) => out.nodes.filter((n) => n.state === s).length;
    return { items: out.nodes.length, applied: count('applied'), failed: count('failed'), skipped: count('skipped'), dryRun: count('dry_run') };
  }

  /** The pushes settled against their `vdp.push` jobs (src/server/vdp/push.ts settlePushRuns): a dead job's push is stopped. */
  private async settledPushRuns(runs: VdpPushRun[]): Promise<VdpPushRun[]> {
    const open = runs.filter((r) => r.state === 'queued' || r.state === 'running').map((r) => r.id);
    const jobs = new Map<string, string>();
    if (open.length) {
      const rows = await this.ctx.db.execute<{ push_id: string; status: string }>(
        sql`select distinct on (payload->>'pushId') payload->>'pushId' as push_id, status::text as status from jobs where owner_user_id = ${await this.ctx.userId()} and kind = ${VDP_PUSH_JOB} and payload->>'pushId' = any(${`{${open.map((id) => `"${id.replace(/["\\]/g, '\\$&')}"`).join(',')}}`}::text[]) order by payload->>'pushId', id desc`,
      );
      for (const r of rows.rows) jobs.set(r.push_id, r.status);
    }
    return settlePushRuns(runs, jobs, this.ctx.now().getTime());
  }

  /** The push's port over this database (D-63). `route`: the web request (dry run only); else the worker (live). */
  private vdpPushPort(o: { route: boolean; gateway?: OutboxGateway | null; signal?: AbortSignal; reads?: VdpLiveReads | null }): PushRoutePort {
    const port: PushRoutePort = {
      ...(o.reads ? { liveMade: (node, draft) => liveMadeVia(o.reads!, node, draft) } : {}),
      now: () => this.ctx.now(),
      newId: () => crypto.randomUUID(),
      dryRunNow: async () => sendingOf((await this.ctx.model(WHOLE)).settings().sending).dryRun,
      state: async () => {
        const st = await this.vdpState();
        return { coverage: st.coverage, snapshots: st.snapshots, drafts: new Map(st.drafts.filter((d) => d.destination.kind === 'action' && d.destination.action.startsWith('vdp.')).map((d) => [d.id, d] as const)), duplicateOf: st.duplicateOf };
      },
      draft: async (id) => (await this.ctx.model(WHOLE)).get('drafts', id) ?? null,
      stage: async (dest, so) => {
        // the worker stages under a fixed id: a push resumed after a restart finds the one it staged
        if (so?.id) {
          const [have] = await this.ctx.db.select({ id: draftsTable.id }).from(draftsTable).where(eq(draftsTable.id, so.id)).limit(1);
          if (have) return (await this.ctx.model(WHOLE)).get('drafts', so.id)!;
        }
        const draft = actionDraftFor(dest, { id: so?.id ?? crypto.randomUUID(), now: this.ctx.now().toISOString(), rendered: (doc) => renderAll(dest, doc) });
        await this.ctx.mutate({ action: 'vdp.update.draft', summary: `VDP change for approval: ${actionSummary(dest)}`.slice(0, 200), entity: { type: 'draft', id: draft.id }, undoable: false }, async (w) => {
          await insertDraft(w, draft);
        });
        this.ctx.bus.publishTables(['drafts'], [draft.id], 'vdp.update.draft');
        return draft;
      },
      discard: async (id, reason) => {
        await this.ctx.mutate({ action: 'vdp.push.withdraw', summary: reason.slice(0, 200), entity: { type: 'draft', id }, actor: 'system', undoable: false }, async (w, model) => {
          const d = model.get('drafts', id);
          if (d && (d.status === 'ready' || d.status === 'failed')) await updateDraft(w, d, { ...d, status: 'discarded', rejectedReason: reason }, { bump: true });
        });
        this.ctx.bus.publishTables(['drafts'], [id], 'vdp.push.withdraw');
      },
      // a dry-run push records only, wherever it runs (2026-11-16: the worker runs dry runs too, so the click returns)
      deliver: (draft, x) => (o.route || x.run.dryRun ? this.vdpPushDryRun(draft) : this.vdpPushDeliver(draft, x.run, { gateway: o.gateway ?? null, ...(o.signal ? { signal: o.signal } : {}) })),
      progress: async (run) => {
        await this.ctx.mutate({ action: 'vdp.push.progress', summary: `Push to VDP: ${run.nodes.filter((n) => n.state === 'applied' || n.state === 'dry_run').length} of ${run.nodes.length} done`, entity: { type: 'settings', id: VDP_PUSH_KV }, actor: o.route ? 'user' : 'system', undoable: false }, async (w, model) => writeKv(w, VDP_PUSH_KV, nextPushRuns(pushRunsOf(model.ctx.kv.get(VDP_PUSH_KV)), run)));
        this.ctx.bus.publishTables(['drafts'], [], 'vdp.push');
      },
      ...(o.route
        ? {
            activePush: async () => activePushOf(await this.settledPushRuns(pushRunsOf((await this.ctx.model(WHOLE)).ctx.kv.get(VDP_PUSH_KV)))),
            enqueue: async (run) => {
              await enqueueJob(this.ctx.db, { ownerUserId: await this.ctx.userId(), kind: VDP_PUSH_JOB, queue: VDP_ASSETS_QUEUE, payload: { pushId: run.id }, idempotencyKey: `vdp.push:${run.id}`, maxAttempts: 1, timeoutSeconds: pushTimeoutSeconds(run.nodes) });
              this.ctx.bus.publishTables(['jobs'], [], 'vdp.push');
            },
          }
        : {}),
    };
    return port;
  }

  /** The route's delivery: a dry run only (the record of the payload; the worker makes every live write). */
  private async vdpPushDryRun(draft: Draft): Promise<PushDelivery> {
    try {
      const d0 = this.ctx.ds.drafts.draft(await this.ctx.model(WHOLE), draft.id);
      const plan = await planDispatch(d0, { mode: 'send', confirmToken: this.ctx.ds.drafts.confirmTokenFor(d0, 'send'), expectedToken: this.ctx.ds.drafts.confirmTokenFor(d0, 'send'), dryRun: true, now: this.ctx.now() });
      await this.ctx.mutate({ action: 'draft.dispatch.dry_run', summary: `Dry run: ${d0.destination.kind === 'action' ? d0.destination.target.label : 'VDP change'}`.slice(0, 200), entity: { type: 'draft', id: d0.id }, undoable: false }, async (w, model) => {
        const d = this.ctx.ds.drafts.draft(model, d0.id);
        const res = await updateDraft(w, d, { ...d, mode: 'send', attempts: [...d.attempts, dispatchAttempt(plan, w.now.toISOString())] }, { bump: true });
        await recordDispatch(w, d.id, res.attemptIds[res.attemptIds.length - 1]!, plan);
      });
      this.ctx.bus.publishTables(['drafts'], [d0.id], 'vdp.push');
      return { outcome: 'dry_run', externalId: null, link: null, detail: 'Dry run: recorded, nothing sent' };
    } catch (err) {
      return { outcome: 'failed', externalId: null, link: null, detail: ((err as Error).message || 'Could not record it').slice(0, 300) };
    }
  }

  /** The worker's delivery of one pushed item: approved by the push click, delivered now by the Outbox job, read back. */
  private async vdpPushDeliver(draft: Draft, run: VdpPushRun, deps: { gateway: OutboxGateway | null; signal?: AbortSignal }): Promise<PushDelivery> {
    const d0 = this.ctx.ds.drafts.draft(await this.ctx.model(WHOLE), draft.id);
    const at = this.ctx.now().toISOString();
    const payload = payloadFor(d0.destination, d0.doc, 'send');
    const hash = payloadHash(payload);
    let attemptId: string;
    try {
      if (d0.destination.kind !== 'action' || !d0.destination.action.startsWith('vdp.')) throw invalid('A push applies VDP items only');
      const what = actionSummary(d0.destination);
      const r = await this.ctx.mutate({ action: 'vdp.push.apply', summary: `Pushed to VDP: ${what}`.slice(0, 200), entity: { type: 'draft', id: d0.id }, undoable: false }, async (w, model) => {
        const d = this.ctx.ds.drafts.draft(model, d0.id);
        if (DELIVERED_STATUSES.has(d.status)) throw invalid(`Draft is ${d.status}: it was already delivered, so nothing was sent again`);
        const attempt = { id: '0', at, mode: 'send' as const, dryRun: false, outcome: 'unconfirmed' as const, detail: `Approved with Push to VDP (${run.at}): on its way to VDP` };
        const res = await updateDraft(w, d, { ...d, mode: 'send', attempts: [...d.attempts, attempt], status: 'sending', verification: { state: 'pending', at: null, detail: 'Waiting for the send adapter' } }, { bump: true });
        const id = res.attemptIds[res.attemptIds.length - 1]!;
        await w.tx.update(draftAttemptsTable).set({ requestHash: hash }).where(eq(draftAttemptsTable.id, Number(id)));
        // the push click is the approval of each item it lists (approval method `click`, at the push)
        await w.tx.update(draftsTable).set({ approvedContentHash: sql`${draftsTable.contentHash}`, approvedAt: new Date(run.at), approvalMethod: 'click' }).where(eq(draftsTable.id, d.id));
        return { id, version: d.version + 1 };
      });
      attemptId = r.result.id;
      this.ctx.bus.publishTables(['drafts'], [d0.id], 'vdp.push');
      const userId = await this.ctx.userId();
      const out = await runOutboxJob({ draftId: d0.id, attemptId, mode: 'send', version: r.result.version, payloadHash: hash }, dbOutboxPort(this.ctx.db, userId, { extractorId: () => this.ctx.extractor(), now: () => this.ctx.now() }), deps.gateway, { now: () => this.ctx.now(), ...(deps.signal ? { signal: deps.signal } : {}) });
      this.ctx.bus.publishTables(['drafts'], [d0.id], 'vdp.push');
      const d = (await this.ctx.model(WHOLE)).get('drafts', d0.id);
      if (out.state === 'dry_run_delivered') return { outcome: 'dry_run', externalId: null, link: null, detail: 'Dry run came on: recorded, nothing sent' };
      if (out.state !== 'delivered') return { outcome: 'failed', externalId: null, link: null, detail: (d?.attempts.at(-1)?.detail || String(out.code ?? out.state ?? 'not delivered')).slice(0, 300) };
      if (out.readback === 'missing') return { outcome: 'failed', externalId: d?.externalId ?? null, link: d?.resultUrl ?? null, detail: (d?.verification?.detail || 'Read-back: not in VDP').slice(0, 300) };
      return { outcome: 'applied', externalId: d?.externalId ?? null, link: d?.resultUrl ?? null, detail: out.readback === 'confirmed' ? 'Verified in VDP ✓' : (d?.verification?.detail ?? 'Applied; not read back yet').slice(0, 300) };
    } catch (err) {
      return { outcome: 'failed', externalId: null, link: null, detail: ((err as Error).message || 'Not delivered').slice(0, 300) };
    }
  }

  /**
   * D-60: one VDP autopilot run (the worker's `vdp.autopilot`): the shared runner over this database. Each item is
   * staged from the mirror and approved under the autonomy policy (approval_method `autonomy_policy`, the user's
   * `autonomy_policies` row for vdp_update at L4), then delivered by the Outbox job inline, which re-checks the policy,
   * dry run and the payload before the write and reads it back. History: actor = the autonomy policy.
   */
  async runVdpAutopilot(deps: { gateway: OutboxGateway | null; auth: () => Promise<'ok' | 'stale'>; notify?: (why: 'reauth' | 'dry_run' | 'cap') => Promise<void>; signal?: AbortSignal }): Promise<AutopilotRunResult> {
    const port: AutopilotPort = {
      now: () => this.ctx.now(),
      settings: async () => {
        const m = await this.ctx.model(WHOLE);
        return { sending: m.settings().sending, timezone: m.settings().profile.timezone };
      },
      auth: deps.auth,
      ledger: async () => ledgerOf((await this.ctx.model(WHOLE)).ctx.kv.get(VDP_AUTOPILOT_KV)),
      saveLedger: async (next, o) => {
        // an idle run (nothing applied, the pause unchanged) writes nothing: no History entry every half hour
        if (!o.changed) return;
        const summary = o.applied || o.failed ? `VDP autopilot: ${o.applied} applied${o.failed ? `, ${o.failed} failed` : ''}` : next.paused ? `VDP autopilot paused (${next.paused})` : 'VDP autopilot: nothing to apply';
        await this.ctx.mutate({ action: 'vdp.autopilot.run', summary, entity: { type: 'settings', id: VDP_AUTOPILOT_KV }, undoable: false, policyActor: VDP_AUTOPILOT_POLICY }, async (w) => writeKv(w, VDP_AUTOPILOT_KV, next));
        this.ctx.bus.publishTables(['drafts'], [], 'vdp.autopilot');
      },
      plan: async (ap) => {
        const m = await this.ctx.model(WHOLE);
        const st = await this.vdpState(m, { ...ap, auth: ap.auth });
        return { coverage: st.coverage, queue: st.queue, snapshots: st.snapshots };
      },
      apply: (item, dest) => this.autopilotApply(item, dest, deps),
      ...(deps.notify ? { notifyPaused: deps.notify } : {}),
    };
    return runVdpAutopilot(port, { signal: deps.signal });
  }

  /** Stage one autopilot item and deliver it now (the Outbox job, inline): how it ended, for the ledger. */
  private async autopilotApply(item: AutopilotItem, dest: ActionDestination, deps: { gateway: OutboxGateway | null; signal?: AbortSignal }): Promise<AutopilotApplyResult> {
    const m0 = await this.ctx.model(WHOLE);
    // dry run is re-read right before staging (and again by the Outbox before the write): switching it on wins
    if (sendingOf(m0.settings().sending).dryRun) return { draftId: null, outcome: 'dry_run', detail: null, url: null };
    const at = this.ctx.now().toISOString();
    const draft = { ...actionDraftFor(dest, { id: crypto.randomUUID(), now: at, rendered: (doc) => renderAll(dest, doc) }), appliedBy: 'autopilot' as const };
    const payload = payloadFor(dest, draft.doc, 'send');
    const hash = payloadHash(payload);
    const r = await this.ctx.mutate({ action: 'vdp.autopilot.apply', summary: `VDP autopilot applied: ${actionSummary(dest)}`.slice(0, 200), entity: { type: 'draft', id: draft.id }, undoable: false, policyActor: VDP_AUTOPILOT_POLICY }, async (w) => {
      // the user's autonomy policy row for VDP changes (Settings ▸ Sending ▸ VDP autopilot): the approval's anchor
      const pol = await w.tx.execute<{ id: string }>(sql`
        insert into autonomy_policies (owner_user_id, action_type, level, target_external_id, note)
        values (${w.userId}, 'vdp_update', 'L4_auto', null, 'VDP autopilot (D-60): Settings ▸ Sending')
        on conflict (owner_user_id, action_type, target_external_id) do update set level = 'L4_auto', updated_at = now()
        returning id`);
      const policyId = pol.rows[0]!.id;
      await insertDraft(w, draft);
      const attempt = { id: '0', at, mode: 'send' as const, dryRun: false, outcome: 'unconfirmed' as const, detail: 'Applied automatically (VDP autopilot): on its way to VDP' };
      const res = await updateDraft(w, draft, { ...draft, attempts: [attempt], status: 'sending', verification: { state: 'pending', at: null, detail: 'Waiting for the send adapter' } }, { bump: true });
      const attemptId = res.attemptIds[res.attemptIds.length - 1]!;
      await w.tx.update(draftAttemptsTable).set({ requestHash: hash }).where(eq(draftAttemptsTable.id, Number(attemptId)));
      await w.tx
        .update(draftsTable)
        .set({ approvedContentHash: sql`${draftsTable.contentHash}`, approvedAt: new Date(at), approvalMethod: 'autonomy_policy', autonomyPolicyId: policyId, autonomyLevel: 'L4_auto' })
        .where(eq(draftsTable.id, draft.id));
      return attemptId;
    });
    this.ctx.bus.publishTables(['drafts'], [draft.id], 'vdp.autopilot');
    const userId = await this.ctx.userId();
    const out = await runOutboxJob({ draftId: draft.id, attemptId: r.result, mode: 'send', version: draft.version + 1, payloadHash: hash }, dbOutboxPort(this.ctx.db, userId, { extractorId: () => this.ctx.extractor(), now: () => this.ctx.now() }), deps.gateway, { now: () => this.ctx.now(), ...(deps.signal ? { signal: deps.signal } : {}) });
    this.ctx.bus.publishTables(['drafts'], [draft.id], 'vdp.autopilot');
    const d = (await this.ctx.model(WHOLE)).get('drafts', draft.id);
    if (out.state === 'dry_run_delivered') return { draftId: draft.id, outcome: 'dry_run', detail: null, url: null };
    const ok = out.state === 'delivered' && out.readback === 'confirmed';
    // a failed delivery says why on its attempt; a write that did not read back says so on its verification
    const detail = ok ? 'Verified in VDP ✓' : out.state === 'failed' ? d?.attempts.at(-1)?.detail || String(out.code ?? 'not delivered') : d?.verification?.detail || d?.attempts.at(-1)?.detail || String(out.readback ?? out.state ?? 'not applied');
    return { draftId: draft.id, outcome: ok ? 'applied' : 'failed', detail: detail.slice(0, 300), url: d?.resultUrl ?? null };
  }

  // ---- D-69: company identity (Change… on a company node)

  /** Search VDP companies: the mirror, the stored lookups, and (live, in the launchd app) VDP's own list_companies. */
  async searchVdpCompanies({ query }: I<'searchVdpCompanies'>): Promise<Res<'searchVdpCompanies'>> {
    const userId = await this.ctx.userId();
    const records = await loadVdpRecords(this.ctx.db, userId);
    const snaps = records.filter((r) => r.snapshot).map((r) => r.snapshot!);
    const server = await loadVdpServer(this.ctx.db, userId);
    if (!liveOrg62()) return searchResult(query.q, searchCompaniesLocal(query.q, snaps, server), false, 'From what the app read; VDP is asked live in the running app');
    try {
      const look = await new VdpClient({ limiter: vdpCallLimiter }).findCompany(query.q);
      return searchResult(query.q, searchCompaniesLocal(query.q, snaps, server, look.matches), true);
    } catch (err) {
      return searchResult(query.q, searchCompaniesLocal(query.q, snaps, server), false, `VDP could not be asked now (${(err as Error).name}): from what the app read`);
    }
  }

  async setVdpIdentity({ body }: I<'setVdpIdentity'>): Promise<Res<'setVdpIdentity'>> {
    const m = await this.ctx.model(WHOLE);
    const next = overrideFrom(body, m.all('accounts'), this.ctx.now().toISOString());
    const label = next.pick.kind === 'match' ? next.pick.name : `create “${next.pick.name}”`;
    const r = await this.ctx.mutate({ action: 'vdp.identity.set', summary: `VDP company: ${label} for ${next.accountIds.length} ${next.accountIds.length === 1 ? 'account' : 'accounts'} (yours)`.slice(0, 200), entity: { type: 'vdp', id: next.key } }, async (w, model) => {
      await writeKv(w, VDP_IDENTITY_KV, { overrides: nextOverrides(overridesOf(model.ctx.kv.get(VDP_IDENTITY_KV)), next, body.key ?? null) });
    });
    this.ctx.bus.publishTables(['vdp_records'], [next.key], 'vdp.identity.set');
    const st = await this.vdpState();
    return { entity: { identity: identityIn(st.coverage, next.key), overrides: overridesOf(st.m.ctx.kv.get(VDP_IDENTITY_KV)).length }, auditId: r.undoable ? r.auditId : null };
  }

  async clearVdpIdentity({ body }: I<'clearVdpIdentity'>): Promise<Res<'clearVdpIdentity'>> {
    const m0 = await this.ctx.model(WHOLE);
    const list = overridesOf(m0.ctx.kv.get(VDP_IDENTITY_KV));
    if (!list.some((o) => o.key === body.key)) {
      const st0 = await this.vdpState(m0);
      return { entity: { identity: identityIn(st0.coverage, body.key), overrides: list.length }, auditId: null };
    }
    const r = await this.ctx.mutate({ action: 'vdp.identity.clear', summary: 'VDP company: back to the app’s own decision', entity: { type: 'vdp', id: body.key } }, async (w, model) => {
      await writeKv(w, VDP_IDENTITY_KV, { overrides: withoutOverride(overridesOf(model.ctx.kv.get(VDP_IDENTITY_KV)), body.key) });
    });
    this.ctx.bus.publishTables(['vdp_records'], [body.key], 'vdp.identity.clear');
    const st = await this.vdpState();
    return { entity: { identity: identityIn(st.coverage, body.key), overrides: overridesOf(st.m.ctx.kv.get(VDP_IDENTITY_KV)).length }, auditId: r.undoable ? r.auditId : null };
  }
}
