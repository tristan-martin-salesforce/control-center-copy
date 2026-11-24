/**
 * The in-memory mock DataSource (CC_DATA=mock, the default until the wiring wave).
 *
 * Behaves like the real backend will: optimistic-concurrency versions (409 conflict), an audit log with
 * inverse payloads + universal undo, user-locked fields (engine writes become Proposals), capture with
 * delayed enrichment, autosave, dry-run dispatch (never any external call), deterministic policy re-rank,
 * live SSE invalidation, and the scenario clock.
 */
import { EMPTY_STORE } from '@/lib/landings/model';
import type { ClaimMissedRequest, Actor, AgentRun, Connector, DispatchMode, Draft, EntityRef, MissedOpp, PriorityPolicy, Proposal, Resolution, ScenarioAction, ScenarioStatus, Seed, SourceRef, WorkState } from '@/contract';
import { buildDefaultScenario, ScenarioPlayer, withLiveArrivals, type ScenarioHost } from '@/mock/scenario';
import type { ChatTurnRunner } from '@/llm/chat/types';
import { chatRunnerFor } from '@/server/chat/backend';
import { notFound } from '@/server/errors';
import type { DataSource } from '../types';
import { MockCtx } from './ctx';
import { MemoryEventBus } from './bus';
import { MockChatBe6 } from './chat-be6';
import { MockChatMemory } from './chat-memory';
import { MockClock } from './clock';
import { MockOutbox } from './outbox';
import { renderAll } from './render';
import { mockIdentityOverrides } from '@/mock/vdp';
import { actionDraftFor, vdpActionFor } from '@/server/vdp/coverage';
import { EMPTY_LEDGER } from '@/engines/vdp/autopilot';
import { MockReadIns } from './readin';
import { MockOnboarding } from './onboarding';
import { MockForecast } from './forecast'; // lane A
import { MockAttribution } from './attribution'; // attribution engine
import { MockUseCases } from './use-cases'; // use cases to add (src/engines/use-cases)
import { loadSeed, type LoadedSeed } from './seed-loader';
import { MockAuditLog, Store, Tx } from './store';
import { activityStamps } from '../activity-log';
import { type StoredSuggestion } from '@/lib/time-suggest';
import { itemRef } from './views';
import { MockPriority } from './priority';
import { MockDelays, id, I, Res } from './shared';
import { MockCalendar } from './domains/calendar';
import { MockBriefs } from './domains/briefs';
import { MockHistory } from './domains/history';
import { MockHealth } from './domains/health';
import { MockSettings } from './domains/settings';
import { MockTriage } from './domains/triage';
import { MockDeals } from './domains/deals';
import { MockVdp } from './domains/vdp';
import { MockTime } from './domains/time';
import { MockCanvas } from './domains/canvas';
import { MockToday } from './domains/today';
import { MockWork } from './domains/work';
import { MockNba } from './domains/nba';
import { MockDrafts } from './domains/drafts';
import { MockAgents } from './domains/agents';
import { MockChat } from './domains/chat';
import { MockUniversal } from './domains/universal';
import { MockNeeds } from './domains/needs';
import { MockFeedback } from './domains/feedback';
import { MockDev } from './domains/dev';
import { MockEngine } from './domains/engine';

const DEFAULT_DELAYS: MockDelays = { enrichMs: 3000, stepMs: 1500, chatTokenMs: 18, verifyMs: 2000, reevalMs: 1500 };

export interface MockOptions {
  seed?: Seed;
  seedPath?: string;
  delays?: Partial<MockDelays>;
  /** Overrides CC_SCENARIO=1. */
  autoplay?: boolean;
  /** BE-READIN: seed the demo read-ins (the app's DataSource turns it on; tests and db:seed leave it off). */
  readinDemo?: boolean;
  /** D-70: a placeholder Org62 read-back of use cases (src/mock/vdp.ts mockOrg62UseCaseDemo; the app's turns it on). */
  useCaseDemo?: boolean;
  clockMode?: string;
  /** BE-CHAT: the runner for the chat intents (default: the deterministic fake model). */
  chatRunner?: ChatTurnRunner;
}

export type { MockDelays } from './shared';

export { resolutionLabel } from './shared';

export class MockDataSource implements DataSource, ScenarioHost {
  /** R7: what every domain shares (the store and audit log, bus, clock, spend governor, the unit of work). */
  readonly ctx = new MockCtx(this);
  // R7 domains (each a field: they exist before any other field initializer runs)
  readonly engine = new MockEngine(this.ctx);
  readonly dev = new MockDev(this.ctx);
  readonly feedback = new MockFeedback(this.ctx);
  readonly needs = new MockNeeds(this.ctx);
  readonly universal = new MockUniversal(this.ctx);
  readonly chats = new MockChat(this.ctx);
  readonly agents = new MockAgents(this.ctx);
  readonly drafts = new MockDrafts(this.ctx);
  readonly nba = new MockNba(this.ctx);
  readonly work = new MockWork(this.ctx);
  readonly today = new MockToday(this.ctx);
  readonly canvas = new MockCanvas(this.ctx);
  readonly time = new MockTime(this.ctx);
  readonly vdp = new MockVdp(this.ctx);
  readonly deals = new MockDeals(this.ctx);
  readonly triage = new MockTriage(this.ctx);
  readonly settingsDomain = new MockSettings(this.ctx);
  readonly health = new MockHealth(this.ctx);
  readonly history = new MockHistory(this.ctx);
  readonly briefs = new MockBriefs(this.ctx);
  readonly calendar = new MockCalendar(this.ctx);
  readonly kind = 'mock' as const;
  get bus() { return this.ctx.bus; }
  get clock() { return this.ctx.clock; }
  get delays() { return this.ctx.delays; }
  readonly loaded: LoadedSeed;
  get store() { return this.ctx.store; }
  set store(v) { this.ctx.store = v; }
  get audit() { return this.ctx.audit; }
  set audit(v) { this.ctx.audit = v; }
  scenario: ScenarioPlayer;
  /** BE-OUTBOX: delivery (dry-run record, or the simulated adapters with dry-run off). */
  readonly outbox: MockOutbox = this.drafts.createOutbox();
  private snapshot: Seed;
  /** BE-READIN: deterministic read-ins (mock/readin.ts). */
  readins: MockReadIns | null = null;
  /** priority@2 (lane 07 R8): the preview, the feedback log and the learning rule, in memory (db parity: db/priority.ts). */
  readonly priority = new MockPriority();
  /** B-079: onboarding, reachable for development and never required (mock/onboarding.ts). */
  readonly onboarding = new MockOnboarding({
    now: () => this.ctx.now(),
    settings: () => this.ctx.store.settings(),
    connectors: () => this.ctx.store.all('connectors'),
    patchSettings: (i) => this.settingsDomain.patchSettings(i),
    applyPolicy: (i) => this.settingsDomain.applyPolicy(i),
  });
  /** The attribution engine: learned rules, DC suggestions, the rundown, AEs I cover (mock/attribution.ts). */
  readonly attribution = new MockAttribution({
    now: () => this.ctx.now(),
    store: () => this.ctx.store,
    newId: (p) => id(p),
    suggestContext: () => this.time.baseSuggestContext(),
    tx: (meta, fn) => {
      const { result, entry } = this.ctx.tx({ actor: 'user', action: meta.action, summary: meta.summary, entity: { type: meta.entity.type, id: meta.entity.id, label: meta.entity.label ?? meta.summary } }, fn);
      return { result, auditId: entry?.id ?? null };
    },
    dcRequestRecord: (o, b) => this.deals.dcRequestRecord(o, b),
    dcRequests: () => this.ctx.store.all('dcRequests'),
    publish: (ids, reason) => this.ctx.publish(['time', 'settings', 'deals', 'home'], ids, reason),
  });
  /** Use cases to add: candidates from meetings and placeholder notes; Accept drafts the VDP item + Org62 row (mock/use-cases.ts). */
  readonly useCases = new MockUseCases({
    now: () => this.ctx.now(),
    store: () => this.ctx.store,
    context: () => this.attribution.context(),
    engagement: () => this.attribution.engagement(),
    ucInput: () => this.deals.ucPlanInput(),
    tx: (meta, fn) => {
      const { result, entry } = this.ctx.tx({ actor: 'user', action: meta.action, summary: meta.summary, entity: { type: 'opportunity', id: meta.id, label: meta.summary } }, fn);
      return { result, auditId: entry?.id ?? null };
    },
    vdpDraft: (tx, req) => {
      const snap = this.vdp.vdpSnapshots().find((x) => x.slug === req.vdpSlug);
      if (!snap) throw notFound('VDP', req.vdpSlug);
      const dest = vdpActionFor(snap, { vdpSlug: req.vdpSlug, op: 'create_use_case', field: 'title', value: req.title, track: req.track }, { duplicateOf: this.deals.ucGuard() });
      const draft = actionDraftFor(dest, { id: id('d'), now: this.ctx.nowIso(), workItemId: null, rendered: (doc) => renderAll(dest, doc) });
      tx.put('drafts', draft);
      return draft.id;
    },
    publish: (ids, reason) => this.ctx.publish(['time', 'deals', 'outbox', 'draft'], ids, reason),
  });
  /** Lane A: Time ▸ Forecast over placeholder Specialist Forecasts (mock/forecast.ts). */
  readonly forecast = new MockForecast({ now: () => this.ctx.now(), store: () => this.ctx.store, newId: (p) => id(p), putDraft: (d, summary) => ({ auditId: this.ctx.tx({ actor: 'user', action: 'forecast.stage', summary: summary.slice(0, 200), entity: { type: 'draft', id: d.id, label: d.destination.kind === 'action' ? d.destination.target.label : 'Forecast canvas' } }, (tx) => tx.put('drafts', d)).entry?.id ?? null }), rendered: (dest, doc) => renderAll(dest, doc), publish: (ids, reason) => this.ctx.publish(['time', 'home'], ids, reason), later: (ms, fn) => this.ctx.later(ms, fn), checkMs: () => this.ctx.delays.stepMs });
  /** BE-CHAT: chat plans, scans, drafts, sessions and spend for the chat runner. */
  readonly be6: MockChatBe6;
  /** Assistant v2: memory and SDK sessions (the db's chat_memory, in memory). */
  readonly chatMemory: MockChatMemory;
  get spendGov() { return this.ctx.spendGov; }

  constructor(opts: MockOptions = {}) {
    this.loaded = opts.seed ? { seed: opts.seed, path: '(inline)', shiftedDays: 0 } : loadSeed({ path: opts.seedPath });
    this.snapshot = structuredClone(this.loaded.seed);
    // the read-side stamps (why a row is excluded, when it was logged / verified), as the db columns hold them
    this.snapshot.activity = this.snapshot.activity.map(activityStamps);
    this.ctx.clock = new MockClock(new Date(this.snapshot.meta.asOf), opts.clockMode);
    this.ctx.bus = new MemoryEventBus(this.ctx.clock);
    this.ctx.delays = { ...DEFAULT_DELAYS, ...opts.delays };
    this.be6 = new MockChatBe6(this.chats.chatKit());
    this.chatMemory = new MockChatMemory(() => this.ctx.now());
    this.chats.chatRunner = opts.chatRunner ?? chatRunnerFor('mock');
    this.resetStore();
    this.readins = new MockReadIns(this, { demo: opts.readinDemo ?? false });
    this.deals.useCaseDemo = opts.useCaseDemo ?? false;
    if (this.deals.useCaseDemo) this.deals.applyUseCaseDemo();
    this.readins.reset();
    // the live pass's arrivals (a draft, a suggestion, a Needs-you row, a run…) play with every scenario
    const events = withLiveArrivals(this.snapshot.scenario ?? buildDefaultScenario(this.ctx.store), this.ctx.store);
    const autoplay = opts.autoplay ?? process.env.CC_SCENARIO === '1';
    this.scenario = new ScenarioPlayer(this, events, this.snapshot.scenario ? 'seed' : 'default', autoplay);
    if (autoplay) this.scenario.play();
  }

  // =========================================================================
  // Infrastructure
  // =========================================================================

  dispose(): void {
    this.scenario.dispose();
    this.readins?.dispose();
    for (const t of this.ctx.timers) clearTimeout(t);
    this.ctx.timers.clear();
  }
  now() { return this.ctx.now(); }

  /** The chat runner's ops (tests/contract/helpers.ts and the parity suite drive them directly). */
  chatOps() { return this.chats.chatOps(); }
  /** tests/time/use-cases-mock.test.ts sets the placeholder Org62 use-case read-back (R7: it lives in the deals domain). */
  get ucRecords() { return this.deals.ucRecords; }
  set ucRecords(v) { this.deals.ucRecords = v; }

  failRate(): number {
    return this.dev.devFailRate;
  }

  /** Reload the store from the seed snapshot (scenario reset/seek). Keeps the event bus and its seq. */
  resetStore(): void {
    this.ctx.store = new Store(structuredClone(this.snapshot));
    this.vdp.vdpCands = null;
    this.vdp.vdpServerInfo = null;
    this.vdp.vdpRuns = new Map();
    this.vdp.vdpLedger = EMPTY_LEDGER;
    this.vdp.vdpPush = null;
    this.vdp.vdpHierarchy = null;
    this.time.canvasChecks = {};
    // D-70: the landings start empty with the store; the first read backfills them from it (like the db's first sync)
    this.canvas.landingStore = EMPTY_STORE;
    // D-69: the placeholder mapping you made with Change… (Soylent Foods → Soylent Corporation), not an audited change
    for (const o of mockIdentityOverrides(this.ctx.store.all('accounts'), this.ctx.nowIso())) this.ctx.store.c.vdpIdentity.set(o.key, o);
    this.ctx.audit = new MockAuditLog();
    this.be6?.reset();
    this.chatMemory?.reset();
    for (const e of this.snapshot.audit) this.ctx.audit.importEntry({ ...e, undoable: false });
    // Engine closes in the seed become real, undoable audit entries (Closed for you → Undo).
    for (const w of this.ctx.store.all('workItems')) {
      if (w.state !== 'done' || w.doneBy !== 'engine') continue;
      const before = { ...w, state: 'open' as WorkState, doneAt: null, doneBy: null, closedReason: null };
      this.ctx.audit.importEntry(
        {
          id: `aud_seed_${w.id}`,
          at: w.doneAt ?? w.updatedAt,
          actor: 'engine',
          action: 'item.close',
          summary: `Closed for you: ${w.title}`,
          entity: itemRef(w),
          related: [],
          changes: [
            { field: 'state', before: 'open', after: 'done' },
            { field: 'closedReason', before: null, after: w.closedReason },
          ],
          undoable: true,
          undoneAt: null,
          undoOf: null,
        },
        [{ col: 'workItems', id: w.id, before, after: w, fields: ['state', 'doneAt', 'doneBy', 'closedReason'] }],
      );
    }
    this.ctx.audit.entries.sort((a, b) => a.at.localeCompare(b.at));
    this.today.rankAllDirect();
    this.readins?.reset();
  }
  engineUpdateItem(itemId: string, patch: Record<string, unknown>, reason: string, opts?: { actor?: Actor; state?: WorkState; evidence?: SourceRef; stepId?: string }) { return this.engine.engineUpdateItem(itemId, patch, reason, opts); }
  propose(tx: Tx, entity: EntityRef, changes: Proposal['changes'], reason: string, baseVersion: number | null, actor: Proposal['actor'] | Actor, source: SourceRef | null, textDiffOps?: Proposal['textDiff']) { return this.engine.propose(tx, entity, changes, reason, baseVersion, actor, source, textDiffOps); }
  engineReviseDraft(nbaId: string, appendText: string, reason: string, source: SourceRef | undefined, opts?: { actor?: Actor; stepId?: string }) { return this.engine.engineReviseDraft(nbaId, appendText, reason, source, opts); }
  engineCloseItem(itemId: string, reason: string, evidence: SourceRef, opts?: { actor?: Actor; stepId?: string; resolution?: Resolution; personName?: string }) { return this.engine.engineCloseItem(itemId, reason, evidence, opts); }
  engineReopen(itemId: string, reason: string, source: SourceRef, opts?: { actor?: Actor; stepId?: string }) { return this.engine.engineReopen(itemId, reason, source, opts); }
  engineLoopBack(itemId: string, byPersonName: string, reason: string, source: SourceRef, opts?: { actor?: Actor; stepId?: string }) { return this.engine.engineLoopBack(itemId, byPersonName, reason, source, opts); }
  engineRunState(runId: string, state: AgentRun['state'], lastEvent: string, waiting: { reason: string; question?: string | null; choices?: string[] } | undefined, opts?: { actor?: Actor; stepId?: string }) { return this.engine.engineRunState(runId, state, lastEvent, waiting, opts); }
  engineConnectorState(connectorId: string, state: Connector['state'], error?: string, impact?: string, opts?: { actor?: Actor; stepId?: string }) { return this.engine.engineConnectorState(connectorId, state, error, impact, opts); }
  engineRerankSignal(itemId: string, boost: number, reason: string, opts?: { actor?: Actor; stepId?: string }) { return this.engine.engineRerankSignal(itemId, boost, reason, opts); }
  applyScenarioAction(a: ScenarioAction, stepId: string) { return this.engine.applyScenarioAction(a, stepId); }
  resetForScenario(offsetSec: number) { return this.engine.resetForScenario(offsetSec); }
  scenarioChanged(status: ScenarioStatus) { return this.engine.scenarioChanged(status); }
  getToday(_i: I<'getToday'>) { return this.today.getToday(_i); }
  waitingForCanvas() { return this.today.waitingForCanvas(); }
  dcNeeds() { return this.deals.dcNeeds(); }
  vdpHome() { return this.vdp.vdpHome(); }
  getHome(i: I<'getHome'>) { return this.today.getHome(i); }
  rerankToday(_i: I<'rerankToday'>) { return this.today.rerankToday(_i); }
  rerankAll(actor: Actor, action: string, summary: string, policy?: PriorityPolicy, extra?: (tx: Tx) => void, entity?: { type: 'settings' | 'policy'; id: string; label: string }) { return this.today.rerankAll(actor, action, summary, policy, extra, entity); }
  listItems(i: I<'listItems'>) { return this.work.listItems(i); }
  getItem(i: I<'getItem'>) { return this.work.getItem(i); }
  captureItem(i: I<'captureItem'>) { return this.work.captureItem(i); }
  patchItem(i: I<'patchItem'>) { return this.work.patchItem(i); }
  itemAction(i: I<'itemAction'>) { return this.work.itemAction(i); }
  getItemEvidence(i: I<'getItemEvidence'>) { return this.work.getItemEvidence(i); }
  getResolutionCheck(i: I<'getResolutionCheck'>) { return this.work.getResolutionCheck(i); }
  getItemTrace(i: I<'getItemTrace'>) { return this.work.getItemTrace(i); }
  getItemHistory(i: I<'getItemHistory'>) { return this.work.getItemHistory(i); }
  markItemSeen(i: I<'markItemSeen'>) { return this.work.markItemSeen(i); }
  getInitiative(i: I<'getInitiative'>) { return this.work.getInitiative(i); }
  getItemNba(i: I<'getItemNba'>) { return this.nba.getItemNba(i); }
  regenerateNba(i: I<'regenerateNba'>) { return this.nba.regenerateNba(i); }
  applyProposal(i: I<'applyProposal'>) { return this.nba.applyProposal(i); }
  rejectProposal(i: I<'rejectProposal'>) { return this.nba.rejectProposal(i); }
  getDraft(i: I<'getDraft'>) { return this.drafts.getDraft(i); }
  getDraftSource(i: I<'getDraftSource'>) { return this.drafts.getDraftSource(i); }
  patchDraft(i: I<'patchDraft'>) { return this.drafts.patchDraft(i); }
  confirmTokenFor(d: Draft, mode: DispatchMode) { return this.drafts.confirmTokenFor(d, mode); }
  queueDraft(i: I<'queueDraft'>) { return this.drafts.queueDraft(i); }
  rejectDraft(i: I<'rejectDraft'>) { return this.drafts.rejectDraft(i); }
  previewDraft(i: I<'previewDraft'>) { return this.drafts.previewDraft(i); }
  dispatchDraft(i: I<'dispatchDraft'>) { return this.drafts.dispatchDraft(i); }
  getOutbox(_i: I<'getOutbox'>) { return this.drafts.getOutbox(_i); }
  stageRelease(i: I<'stageRelease'>) { return this.drafts.stageRelease(i); }
  getCalendar(i: I<'getCalendar'>) { return this.calendar.getCalendar(i); }
  getCalendarEvent(i: I<'getCalendarEvent'>) { return this.calendar.getCalendarEvent(i); }
  getAgents(_i: I<'getAgents'>) { return this.agents.getAgents(_i); }
  launchAgent(i: I<'launchAgent'>) { return this.agents.launchAgent(i); }
  answerAgent(i: I<'answerAgent'>) { return this.agents.answerAgent(i); }
  cancelAgent(i: I<'cancelAgent'>) { return this.agents.cancelAgent(i); }
  getTools(_i: I<'getTools'>) { return this.agents.getTools(_i); }
  startToolRun(i: I<'startToolRun'>) { return this.agents.startToolRun(i); }
  getToolRun(i: I<'getToolRun'>) { return this.agents.getToolRun(i); }
  getTime(i: I<'getTime'>) { return this.time.getTime(i); }
  getActivityLog(i: I<'getActivityLog'>) { return this.time.getActivityLog(i); }
  getTimeLedger(i: I<'getTimeLedger'>) { return this.time.getTimeLedger(i); }
  putStoredSuggestions(rows: Record<string, StoredSuggestion>) { return this.time.putStoredSuggestions(rows); }
  checkCanvasOrg62(i: I<'checkCanvasOrg62'>) { return this.time.checkCanvasOrg62(i); }
  patchActivity(i: I<'patchActivity'>) { return this.time.patchActivity(i); }
  resolveActivity(i: I<'resolveActivity'>) { return this.time.resolveActivity(i); }
  getOppOptions(i: I<'getOppOptions'>) { return this.time.getOppOptions(i); }
  searchOrg62Opps(i: I<'searchOrg62Opps'>) { return this.time.searchOrg62Opps(i); }
  pickOrg62Opp(i: I<'pickOrg62Opp'>) { return this.time.pickOrg62Opp(i); }
  get onsite() { return this.time.onsite; }
  correctOnsiteDay(i: I<'correctOnsiteDay'>) { return this.time.correctOnsiteDay(i); }
  markTrip(i: I<'markTrip'>) { return this.time.markTrip(i); }
  listTimeDismissRules(_i: I<'listTimeDismissRules'>) { return this.time.listTimeDismissRules(_i); }
  dismissFromSource(i: I<'dismissFromSource'>) { return this.time.dismissFromSource(i); }
  removeTimeDismissRule(i: I<'removeTimeDismissRule'>) { return this.time.removeTimeDismissRule(i); }
  syncCanvas(i: I<'syncCanvas'>) { return this.time.syncCanvas(i); }
  getHistoryMonth(i: I<'getHistoryMonth'>) { return this.history.getHistoryMonth(i); }
  getHistoryDay(i: I<'getHistoryDay'>) { return this.history.getHistoryDay(i); }
  getDeals(i: I<'getDeals'>) { return this.deals.getDeals(i); }
  listNeedDecisions(_i: I<'listNeedDecisions'>) { return this.needs.listNeedDecisions(_i); }
  decideNeed(i: I<'decideNeed'>) { return this.needs.decideNeed(i); }
  listNeeds(_i: I<'listNeeds'>) { return this.needs.listNeeds(_i); }
  decideNeedRow(i: I<'decideNeedRow'>) { return this.needs.decideNeedRow(i); }
  clearNeedDecision(i: I<'clearNeedDecision'>) { return this.needs.clearNeedDecision(i); }
  getMissed(_i: I<'getMissed'>) { return this.deals.getMissed(_i); }
  vdpSnapshots() { return this.vdp.vdpSnapshots(); }
  vdpAutopilotInputs() { return this.vdp.vdpAutopilotInputs(); }
  getVdpCoverage(_i: I<'getVdpCoverage'>) { return this.vdp.getVdpCoverage(_i); }
  getVdpDetail(i: I<'getVdpDetail'>) { return this.vdp.getVdpDetail(i); }
  setVdpCandidate(i: I<'setVdpCandidate'>) { return this.vdp.setVdpCandidate(i); }
  findVdpAssets(i: I<'findVdpAssets'>) { return this.vdp.findVdpAssets(i); }
  stageLogBatch(i: I<'stageLogBatch'>) { return this.canvas.stageLogBatch(i); }
  getCanvasWrites(i: I<'getCanvasWrites'>) { return this.canvas.getCanvasWrites(i); }
  getRecordLandings(i: I<'getRecordLandings'>) { return this.canvas.getRecordLandings(i); }
  getEventUpdates(_i: I<'getEventUpdates'>) { return this.canvas.getEventUpdates(_i); }
  proposeEventUpdates(i: I<'proposeEventUpdates'>) { return this.canvas.proposeEventUpdates(i); }
  patchEventUpdate(i: I<'patchEventUpdate'>) { return this.canvas.patchEventUpdate(i); }
  getUseCaseLandings(_i: I<'getUseCaseLandings'>) { return this.canvas.getUseCaseLandings(_i); }
  pickUseCaseValue(i: I<'pickUseCaseValue'>) { return this.canvas.pickUseCaseValue(i); }
  fixUseCase(i: I<'fixUseCase'>) { return this.canvas.fixUseCase(i); }
  getCanvasReview(i: I<'getCanvasReview'>) { return this.canvas.getCanvasReview(i); }
  removeCanvasRows(i: I<'removeCanvasRows'>) { return this.canvas.removeCanvasRows(i); }
  editCanvasRow(i: I<'editCanvasRow'>) { return this.canvas.editCanvasRow(i); }
  draftVdpUpdate(i: I<'draftVdpUpdate'>) { return this.vdp.draftVdpUpdate(i); }
  pushVdpChanges(i: I<'pushVdpChanges'>) { return this.vdp.pushVdpChanges(i); }
  searchVdpCompanies(i: I<'searchVdpCompanies'>) { return this.vdp.searchVdpCompanies(i); }
  setVdpIdentity(i: I<'setVdpIdentity'>) { return this.vdp.setVdpIdentity(i); }
  clearVdpIdentity(i: I<'clearVdpIdentity'>) { return this.vdp.clearVdpIdentity(i); }
  runVdpAutopilot(deps?: { auth?: 'ok' | 'stale' }) { return this.vdp.runVdpAutopilot(deps); }
  getAccount(i: I<'getAccount'>) { return this.deals.getAccount(i); }
  getUseCaseSync(_i: I<'getUseCaseSync'>) { return this.deals.getUseCaseSync(_i); }
  listDcRequests(_i: I<'listDcRequests'>) { return this.deals.listDcRequests(_i); }
  addOrg62Opps(i: I<'addOrg62Opps'>) { return this.deals.addOrg62Opps(i); }
  createDcRequest(i: I<'createDcRequest'>) { return this.deals.createDcRequest(i); }
  patchDcRequest(i: I<'patchDcRequest'>) { return this.deals.patchDcRequest(i); }
  withdrawDcRequest(i: I<'withdrawDcRequest'>) { return this.deals.withdrawDcRequest(i); }
  withdrawDcRequests(i: I<'withdrawDcRequests'>) { return this.deals.withdrawDcRequests(i); }
  recordMyDcs(dcs: ReadonlyArray<{ oppId: string; split: number | null; role: string | null; org62DcId: string }>, o?: { complete?: boolean }) { return this.deals.recordMyDcs(dcs, o); }
  claimMissed(i: I<'claimMissed'>) { return this.deals.claimMissed(i); }
  claimMissedTx(m: MissedOpp, body?: ClaimMissedRequest) { return this.deals.claimMissedTx(m, body); }
  dismissMissed(i: I<'dismissMissed'>) { return this.deals.dismissMissed(i); }
  getBriefs(_i: I<'getBriefs'>) { return this.briefs.getBriefs(_i); }
  getBrief(i: I<'getBrief'>) { return this.briefs.getBrief(i); }
  promoteHighlight(i: I<'promoteHighlight'>) { return this.briefs.promoteHighlight(i); }
  taskFromHighlight(i: I<'taskFromHighlight'>) { return this.briefs.taskFromHighlight(i); }
  dismissHighlight(i: I<'dismissHighlight'>) { return this.briefs.dismissHighlight(i); }
  listWatches(_i: I<'listWatches'>) { return this.briefs.listWatches(_i); }
  createWatch(i: I<'createWatch'>) { return this.briefs.createWatch(i); }
  patchWatch(i: I<'patchWatch'>) { return this.briefs.patchWatch(i); }
  getTriage(_i: I<'getTriage'>) { return this.triage.getTriage(_i); }
  acceptTriage(i: I<'acceptTriage'>) { return this.triage.acceptTriage(i); }
  dismissTriage(i: I<'dismissTriage'>) { return this.triage.dismissTriage(i); }
  mergeTriage(i: I<'mergeTriage'>) { return this.triage.mergeTriage(i); }
  getPriorityPreview(_i: I<'getPriorityPreview'>) { return this.today.getPriorityPreview(_i); }
  decidePriorityRule(i: I<'decidePriorityRule'>) { return this.today.decidePriorityRule(i); }
  rerankAllUsers(_i: I<'rerankAllUsers'>) { return this.today.rerankAllUsers(_i); }
  getHealth(_i: I<'getHealth'>) { return this.health.getHealth(_i); }
  listSpendHolds(i: I<'listSpendHolds'>) { return this.health.listSpendHolds(i); }
  answerSpendHold(i: I<'answerSpendHold'>) { return this.health.answerSpendHold(i); }
  chatSpendAnswer(i: I<'chatSpendAnswer'>) { return this.health.chatSpendAnswer(i); }
  chatPlanAnswer(i: I<'chatPlanAnswer'>) { return this.chats.chatPlanAnswer(i); }
  listChatMemory(i: I<'listChatMemory'>) { return this.chats.listChatMemory(i); }
  deleteChatMemory(i: I<'deleteChatMemory'>) { return this.chats.deleteChatMemory(i); }
  getSpendAudit(i: I<'getSpendAudit'>) { return this.health.getSpendAudit(i); }
  getSpendAuditDetail(i: I<'getSpendAuditDetail'>) { return this.health.getSpendAuditDetail(i); }
  getReadme(_i: I<'getReadme'>) { return this.health.getReadme(_i); }
  getGuide(_i: I<'getGuide'>) { return this.health.getGuide(_i); }
  getDoctor(_i: I<'getDoctor'>) { return this.health.getDoctor(_i); }
  smokeClaude(_i: I<'smokeClaude'>) { return this.health.smokeClaude(_i); }
  checkForUpdates(_i: I<'checkForUpdates'>) { return this.health.checkForUpdates(_i); }
  getVersion(_i: I<'getVersion'>) { return this.health.getVersion(_i); }
  reauthConnector(i: I<'reauthConnector'>) { return this.health.reauthConnector(i); }
  scanConnector(i: I<'scanConnector'>) { return this.health.scanConnector(i); }
  getScans(i: I<'getScans'>) { return this.health.getScans(i); }
  getJobs(_i: I<'getJobs'>) { return this.health.getJobs(_i); }
  retryJob(i: I<'retryJob'>) { return this.health.retryJob(i); }
  getEventLog(_i: I<'getEventLog'>) { return this.health.getEventLog(_i); }
  ackEvent(i: I<'ackEvent'>) { return this.health.ackEvent(i); }
  getSettings(_i: I<'getSettings'>) { return this.settingsDomain.getSettings(_i); }
  patchSettings(i: I<'patchSettings'>) { return this.settingsDomain.patchSettings(i); }
  raiseBudgetToday(i: I<'raiseBudgetToday'>) { return this.settingsDomain.raiseBudgetToday(i); }
  getRetention(_i: I<'getRetention'>) { return this.settingsDomain.getRetention(_i); }
  patchRetention(i: I<'patchRetention'>) { return this.settingsDomain.patchRetention(i); }
  runRetention(i: I<'runRetention'>) { return this.settingsDomain.runRetention(i); }
  previewPolicy(i: I<'previewPolicy'>) { return this.settingsDomain.previewPolicy(i); }
  applyPolicy(i: I<'applyPolicy'>) { return this.settingsDomain.applyPolicy(i); }
  revertPolicy(i: I<'revertPolicy'>) { return this.settingsDomain.revertPolicy(i); }
  getPolicyVersions(_i: I<'getPolicyVersions'>) { return this.settingsDomain.getPolicyVersions(_i); }
  undoAudit(i: I<'undoAudit'>) { return this.universal.undoAudit(i); }
  search(i: I<'search'>) { return this.universal.search(i); }
  getPeople(i: I<'getPeople'>) { return this.universal.getPeople(i); }
  getSince(i: I<'getSince'>) { return this.universal.getSince(i); }
  listChatThreads(_i: I<'listChatThreads'>) { return this.chats.listChatThreads(_i); }
  createChatThread(i: I<'createChatThread'>) { return this.chats.createChatThread(i); }
  getReadIn(i: I<'getReadIn'>) { return this.universal.getReadIn(i); }
  requestReadIn(i: I<'requestReadIn'>) { return this.universal.requestReadIn(i); }

  // ---- the attribution engine (mock/attribution.ts) ----
  async getAttributionRules(_i: I<'getAttributionRules'>): Promise<Res<'getAttributionRules'>> { return this.attribution.rulesView(); } // prettier-ignore
  async patchAttributionRule({ params, body }: I<'patchAttributionRule'>): Promise<Res<'patchAttributionRule'>> { return this.attribution.patchRule(params.id, body.enabled); } // prettier-ignore
  async deleteAttributionRule({ params }: I<'deleteAttributionRule'>): Promise<Res<'deleteAttributionRule'>> { return this.attribution.deleteRule(params.id); } // prettier-ignore
  async getDcSuggestions(_i: I<'getDcSuggestions'>): Promise<Res<'getDcSuggestions'>> { return this.attribution.suggestions(); } // prettier-ignore
  async decideDcSuggestion({ params, body }: I<'decideDcSuggestion'>): Promise<Res<'decideDcSuggestion'>> { return this.attribution.decide(params.id, body); } // prettier-ignore
  async refreshDcSuggestions(_i: I<'refreshDcSuggestions'>): Promise<Res<'refreshDcSuggestions'>> { return this.attribution.refresh(); } // prettier-ignore
  async getOppRundown({ query = {} }: I<'getOppRundown'>): Promise<Res<'getOppRundown'>> { return this.attribution.rundown(query); } // prettier-ignore
  async lookupCoveredAe({ body }: I<'lookupCoveredAe'>): Promise<Res<'lookupCoveredAe'>> { return this.attribution.lookupAe(body.q); } // prettier-ignore
  // ---- use cases to add (mock/use-cases.ts) ----
  async getUseCaseCandidates(_i: I<'getUseCaseCandidates'>): Promise<Res<'getUseCaseCandidates'>> { return this.useCases.list(); } // prettier-ignore
  async decideUseCaseCandidate({ params, body }: I<'decideUseCaseCandidate'>): Promise<Res<'decideUseCaseCandidate'>> { return this.useCases.decide(params.id, body); } // prettier-ignore
  async addUseCaseCandidate({ body }: I<'addUseCaseCandidate'>): Promise<Res<'addUseCaseCandidate'>> { return this.useCases.add(body); } // prettier-ignore
  async refreshUseCaseCandidates(_i: I<'refreshUseCaseCandidates'>): Promise<Res<'refreshUseCaseCandidates'>> { return this.useCases.refresh(); } // prettier-ignore

  // ---- lane A: Specialist Forecast (mock/forecast.ts) ----
  async getForecast(_i: I<'getForecast'>): Promise<Res<'getForecast'>> { return this.forecast.view(); } // prettier-ignore
  async getForecastRecord({ params }: I<'getForecastRecord'>): Promise<Res<'getForecastRecord'>> { return this.forecast.detail(params.id); } // prettier-ignore
  async syncForecast(_i: I<'syncForecast'>): Promise<Res<'syncForecast'>> { return this.forecast.sync(); } // prettier-ignore
  async draftForecastNotes(i: I<'draftForecastNotes'>): Promise<Res<'draftForecastNotes'>> { return this.forecast.draft(i); } // prettier-ignore
  async patchForecast({ params, body }: I<'patchForecast'>): Promise<Res<'patchForecast'>> { return this.forecast.patch(params.id, body); } // prettier-ignore
  async stageForecast(i: I<'stageForecast'>): Promise<Res<'stageForecast'>> { return this.forecast.stage(i); } // prettier-ignore
  async checkMissingForecast({ params }: I<'checkMissingForecast'>): Promise<Res<'checkMissingForecast'>> { return this.forecast.checkMissing(params.id); } // prettier-ignore

  // ---- Onboarding (B-079; mock/onboarding.ts) ----
  async getOnboarding(_i: I<'getOnboarding'>): Promise<Res<'getOnboarding'>> {
    return this.onboarding.state();
  }
  async saveOnboardingStep({ body }: I<'saveOnboardingStep'>): Promise<Res<'saveOnboardingStep'>> {
    return this.onboarding.save(body);
  }
  async getOnboardingSources(_i: I<'getOnboardingSources'>): Promise<Res<'getOnboardingSources'>> {
    return this.onboarding.sources();
  }
  async completeOnboarding(_i: I<'completeOnboarding'>): Promise<Res<'completeOnboarding'>> {
    return this.onboarding.complete();
  }
  getChatThread(i: I<'getChatThread'>) { return this.chats.getChatThread(i); }
  chat(i: I<'chat'> & { signal: AbortSignal }) { return this.chats.chat(i); }
  events(i: { signal: AbortSignal }) { return this.universal.events(i); }
  getFeedback(_i: I<'getFeedback'>) { return this.feedback.getFeedback(_i); }
  diagnoseFeedback(i: I<'diagnoseFeedback'>) { return this.feedback.diagnoseFeedback(i); }
  stageFeedback(i: I<'stageFeedback'>) { return this.feedback.stageFeedback(i); }
  getScenario(_i: I<'getScenario'>) { return this.dev.getScenario(_i); }
  controlScenario(i: I<'controlScenario'>) { return this.dev.controlScenario(i); }
  getDevFail(_i: I<'getDevFail'>) { return this.dev.getDevFail(_i); }
  setDevFail(i: I<'setDevFail'>) { return this.dev.setDevFail(i); }
  devEngineChange(i: I<'devEngineChange'>) { return this.dev.devEngineChange(i); }
}

export function createMockDataSource(opts?: MockOptions): MockDataSource {
  return new MockDataSource(opts);
}

/**
 * Dev only (datasource/index.ts): the mock's code, facade + context + every domain (R7), so an edit to any of them
 * replaces a dev server's stale singleton, not only an edit to this file.
 */
export function mockCodeText(): string {
  return [MockDataSource, MockCtx, MockCalendar, MockBriefs, MockHistory, MockHealth, MockSettings, MockTriage, MockDeals, MockVdp, MockTime, MockCanvas, MockToday, MockWork, MockNba, MockDrafts, MockAgents, MockChat, MockUniversal, MockNeeds, MockFeedback, MockDev, MockEngine].map(String).join('\n');
}
