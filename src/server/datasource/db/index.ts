/**
 * The Postgres DataSource (CC_DATA=db): every /api/v1 route served from the DATA-MODEL schema.
 *
 * Reads load the user's read model (model.ts: rows → contract records via store/*.ts) and compose pages
 * (views.ts), with DATA-MODEL §6 statements choosing what they specify (Q1 ranked order, Q6 closed-for-you,
 * Q9 suggested items, Q13 history). Mutations run inside one `withChangeSet` each (actor user, the action
 * name as actor_ref), write columns through the change-set helper (409 on a stale `ifVersion`, user locks)
 * and return the change set id as `auditId`. `POST /audit/:id/undo` is `undoChangeSet`.
 *
 * Border rules: nothing here calls an external system. Dispatch records the intent (draft_send_attempts,
 * honoring dry-run, the default) and, only in live mode, enqueues an `outbox.dispatch` job for BE-4's send
 * adapters. Scans, re-auth, tool runs and enrichment are enqueued for the worker instead of simulated.
 */

import type { ClaimMissedRequest, Draft, MissedOpp, PriorityPolicy, Resolution, ClosingReason, WorkItemRecord } from '@/contract';
import { type ClosureSettings, type Signal } from '@/engines/types';
import { type RerankTrigger } from '@/jobs/handlers/rerank';

import type { DataSource } from '../types';
import { DbCtx } from './ctx';
import { renderAll } from '../mock/render';
import { chatRunnerBackend } from './chat';
import { DbChatBe6 } from './chat-be6';
import { dbChatMemory, type ChatMemoryStore } from './chat-memory';
import { chatRunnerFor } from '@/server/chat/backend';
import { type ReadModel } from './model';
import { everything } from './reads/scope';
import { DbOnboarding } from './onboarding';
import { DbForecast } from './forecast'; // lane A
import { DbAttribution } from './attribution'; // attribution engine
import { DbUseCases } from './use-cases'; // use cases to add (src/engines/use-cases)
import { type WriteCtx } from './store/common';
import { insertDraft } from './store/nba';
import { type VdpLiveReads } from '@/server/vdp/push';
import { liveOrg62 } from '@/server/chat/record-type';
import { type OutboxGateway } from '@/outbox';
import { DbDataSourceOptions, I, Res } from './shared';
import { DbCalendar } from './domains/calendar';
import { DbBriefs } from './domains/briefs';
import { DbHistory } from './domains/history';
import { DbHealth } from './domains/health';
import { DbSettings } from './domains/settings';
import { DbTriage } from './domains/triage';
import { DbDeals } from './domains/deals';
import { DbVdp } from './domains/vdp';
import { DbTime } from './domains/time';
import { DbCanvas } from './domains/canvas';
import { DbToday } from './domains/today';
import { DbWork } from './domains/work';
import { DbNba } from './domains/nba';
import { DbDrafts } from './domains/drafts';
import { DbAgents } from './domains/agents';
import { DbChat } from './domains/chat';
import { DbUniversal } from './domains/universal';
import { DbNeeds } from './domains/needs';
import { DbFeedback } from './domains/feedback';
import { DbDev } from './domains/dev';
import { DbEngine } from './domains/engine';

export { DbClock } from './shared';
export type { DbDataSourceOptions } from './shared';

export { resolutionLabel } from './shared';

export { PROPOSAL_CHANGED_SINCE } from './domains/nba';

export class DbDataSource implements DataSource {
  readonly kind = 'db' as const;
  /** R7: what every domain shares (pool, clock, bus, the read model, mutate, the user). */
  readonly ctx: DbCtx;
  get handle() { return this.ctx.handle; }
  get clock() { return this.ctx.clock; }
  get bus() { return this.ctx.bus; }
  /** BE-CHAT: chat plans (Apply / Dismiss), scans, drafts, sessions and spend for the chat runner. */
  readonly be6: DbChatBe6;
  /** Assistant v2: memory and SDK sessions (chat_memory, chat_threads.sdk_session_id). */
  readonly chatMemory: ChatMemoryStore;
  /** B-079: first-launch onboarding (db/onboarding.ts). */
  readonly onboarding: DbOnboarding;
  /** Lane A: Time ▸ Forecast (db/forecast.ts). */
  readonly forecast: DbForecast;
  /** The attribution engine: learned rules, DC suggestions, the rundown, AEs I cover (db/attribution.ts). */
  readonly attribution: DbAttribution;
  /** Use cases to add: candidates from notes, meetings, Slack and mail; Accept drafts the VDP item + Org62 row (db/use-cases.ts). */
  readonly useCases: DbUseCases;

  // R7 domains
  readonly engine: DbEngine;
  readonly dev: DbDev;
  readonly feedback: DbFeedback;
  readonly needs: DbNeeds;
  readonly universal: DbUniversal;
  readonly chats: DbChat;
  readonly agents: DbAgents;
  readonly drafts: DbDrafts;
  readonly nba: DbNba;
  readonly work: DbWork;
  readonly today: DbToday;
  readonly canvas: DbCanvas;
  readonly time: DbTime;
  readonly vdp: DbVdp;
  readonly deals: DbDeals;
  readonly triage: DbTriage;
  readonly settingsDomain: DbSettings;
  readonly health: DbHealth;
  readonly history: DbHistory;
  readonly briefs: DbBriefs;
  readonly calendar: DbCalendar;
  constructor(opts: DbDataSourceOptions = {}) {
    this.ctx = new DbCtx(this, opts);
    // R7 domains (constructed)
    this.engine = new DbEngine(this.ctx);
    this.dev = new DbDev(this.ctx);
    this.feedback = new DbFeedback(this.ctx);
    this.needs = new DbNeeds(this.ctx);
    this.universal = new DbUniversal(this.ctx);
    this.chats = new DbChat(this.ctx);
    this.agents = new DbAgents(this.ctx);
    this.drafts = new DbDrafts(this.ctx);
    this.nba = new DbNba(this.ctx);
    this.work = new DbWork(this.ctx);
    this.today = new DbToday(this.ctx);
    this.canvas = new DbCanvas(this.ctx);
    this.time = new DbTime(this.ctx);
    this.vdp = new DbVdp(this.ctx);
    this.deals = new DbDeals(this.ctx);
    this.triage = new DbTriage(this.ctx);
    this.settingsDomain = new DbSettings(this.ctx);
    this.health = new DbHealth(this.ctx);
    this.history = new DbHistory(this.ctx);
    this.briefs = new DbBriefs(this.ctx);
    this.calendar = new DbCalendar(this.ctx);
    this.be6 = new DbChatBe6(this.chats.chatKit());
    this.chatMemory = dbChatMemory(this.ctx.handle.db, () => this.ctx.userId());
    this.onboarding = new DbOnboarding(this.ctx.handle.db, () => this.ctx.now(), { getSettings: () => this.settingsDomain.getSettings({} as I<'getSettings'>), patchSettings: (i) => this.settingsDomain.patchSettings(i), applyPolicy: (i) => this.settingsDomain.applyPolicy(i) }, opts.onboarding);
    this.attribution = new DbAttribution({ db: this.ctx.handle.db, now: () => this.ctx.now(), userId: () => this.ctx.userId(), model: () => this.ctx.model(everything('attribution engine')), suggestContext: (m) => this.time.suggestContext(m), mutate: (meta, fn) => this.ctx.mutate(meta, fn), claimDc: (w, model, o, b) => this.deals.dcRequestIn(w, model, o, b), org62Live: !!this.ctx.org62Read || liveOrg62(), publish: (t, ids, r) => this.ctx.bus.publishTables(t, ids, r) });
    this.useCases = new DbUseCases({ db: this.ctx.handle.db, now: () => this.ctx.now(), userId: () => this.ctx.userId(), model: () => this.ctx.model(everything('use-case engine')), mutate: (meta, fn) => this.ctx.mutate(meta, fn), draftVdpIn: (w, model, req) => this.vdp.vdpUseCaseDraftIn(w, model, req), publish: (t, ids, r) => this.ctx.bus.publishTables(t, ids, r) });
    this.forecast = new DbForecast({ db: this.ctx.handle.db, now: () => this.ctx.now(), userId: () => this.ctx.userId(), model: () => this.ctx.model(everything('forecast')), insertDraft: (d, summary) => this.ctx.mutate({ action: 'forecast.stage', summary: summary.slice(0, 200), entity: { type: 'draft', id: d.id }, undoable: false }, (w) => insertDraft(w, d)).then((r) => (this.ctx.bus.publishTables(['drafts'], [d.id], 'forecast.stage'), { auditId: r.auditId })), rendered: (dest, doc) => renderAll(dest, doc), publish: (ids, reason) => this.ctx.bus.publishTables(['specialist_forecasts'], ids, reason) });
  }
  get db() { return this.ctx.db; }

  failRate(): number {
    return 0;
  }

  async dispose(): Promise<void> {
    await this.ctx.bus.stop();
    if (this.ctx.ownsHandle) await this.ctx.handle.close();
  }
  now() { return this.ctx.now(); }
  model(...a: Parameters<DbCtx['model']>) { return this.ctx.model(...a); }
  rankedIds() { return this.today.rankedIds(); }
  getHome(i: I<'getHome'>) { return this.today.getHome(i); }
  getToday(_i: I<'getToday'>) { return this.today.getToday(_i); }
  notePresence(awaySinceMs: number) { return this.today.notePresence(awaySinceMs); }
  rerankToday(_i: I<'rerankToday'>) { return this.today.rerankToday(_i); }
  autoRerank(trigger: RerankTrigger) { return this.today.autoRerank(trigger); }
  systemRerank(reason: string) { return this.today.systemRerank(reason); }
  rerankIn(w: WriteCtx, model: ReadModel, policy: PriorityPolicy, rankedIds: string[], now: Date, policyRowId?: string, opts?: { trigger?: 'user_reprioritize' | 'new_info' | 'calendar_change' | 'schedule' | 'startup'; stable?: boolean }) { return this.today.rerankIn(w, model, policy, rankedIds, now, policyRowId, opts); }
  getPriorityPreview(_i: I<'getPriorityPreview'>) { return this.today.getPriorityPreview(_i); }
  decidePriorityRule(i: I<'decidePriorityRule'>) { return this.today.decidePriorityRule(i); }
  rerankAllUsers(_i: I<'rerankAllUsers'>) { return this.today.rerankAllUsers(_i); }
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
  draft(m: ReadModel, did: string) { return this.drafts.draft(m, did); }
  getDraft(i: I<'getDraft'>) { return this.drafts.getDraft(i); }
  getDraftSource(i: I<'getDraftSource'>) { return this.drafts.getDraftSource(i); }
  patchDraft(i: I<'patchDraft'>) { return this.drafts.patchDraft(i); }
  confirmTokenFor(d: Draft, mode: 'draft' | 'send') { return this.drafts.confirmTokenFor(d, mode); }
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
  checkCanvasOrg62(i: I<'checkCanvasOrg62'>) { return this.time.checkCanvasOrg62(i); }
  getActivityLog(i: I<'getActivityLog'>) { return this.time.getActivityLog(i); }
  suggestContext(m: ReadModel) { return this.time.suggestContext(m); }
  activitySuggestPending() { return this.time.activitySuggestPending(); }
  getTimeLedger(i: I<'getTimeLedger'>) { return this.time.getTimeLedger(i); }
  getHistoryMonth(i: I<'getHistoryMonth'>) { return this.history.getHistoryMonth(i); }
  getHistoryDay(i: I<'getHistoryDay'>) { return this.history.getHistoryDay(i); }
  correctOnsiteDay(i: I<'correctOnsiteDay'>) { return this.time.correctOnsiteDay(i); }
  markTrip(i: I<'markTrip'>) { return this.time.markTrip(i); }
  patchActivity(i: I<'patchActivity'>) { return this.time.patchActivity(i); }
  resolveActivity(i: I<'resolveActivity'>) { return this.time.resolveActivity(i); }
  getOppOptions(i: I<'getOppOptions'>) { return this.time.getOppOptions(i); }
  searchOrg62Opps(i: I<'searchOrg62Opps'>) { return this.time.searchOrg62Opps(i); }
  pickOrg62Opp(i: I<'pickOrg62Opp'>) { return this.time.pickOrg62Opp(i); }
  listTimeDismissRules(_i: I<'listTimeDismissRules'>) { return this.time.listTimeDismissRules(_i); }
  dismissFromSource(i: I<'dismissFromSource'>) { return this.time.dismissFromSource(i); }
  removeTimeDismissRule(i: I<'removeTimeDismissRule'>) { return this.time.removeTimeDismissRule(i); }
  syncCanvas(i: I<'syncCanvas'>) { return this.time.syncCanvas(i); }
  getDeals(i: I<'getDeals'>) { return this.deals.getDeals(i); }
  listNeedDecisions(_i: I<'listNeedDecisions'>) { return this.needs.listNeedDecisions(_i); }
  decideNeed(i: I<'decideNeed'>) { return this.needs.decideNeed(i); }
  listNeeds(_i: I<'listNeeds'>) { return this.needs.listNeeds(_i); }
  decideNeedRow(i: I<'decideNeedRow'>) { return this.needs.decideNeedRow(i); }
  clearNeedDecision(i: I<'clearNeedDecision'>) { return this.needs.clearNeedDecision(i); }
  getMissed(_i: I<'getMissed'>) { return this.deals.getMissed(_i); }
  getUseCaseSync(_i: I<'getUseCaseSync'>) { return this.deals.getUseCaseSync(_i); }
  listDcRequests(_i: I<'listDcRequests'>) { return this.deals.listDcRequests(_i); }
  addOrg62Opps(i: I<'addOrg62Opps'>) { return this.deals.addOrg62Opps(i); }
  createDcRequest(i: I<'createDcRequest'>) { return this.deals.createDcRequest(i); }
  patchDcRequest(i: I<'patchDcRequest'>) { return this.deals.patchDcRequest(i); }
  withdrawDcRequest(i: I<'withdrawDcRequest'>) { return this.deals.withdrawDcRequest(i); }
  withdrawDcRequests(i: I<'withdrawDcRequests'>) { return this.deals.withdrawDcRequests(i); }
  vdpAutopilotInputs(m: ReadModel, auth?: 'ok' | 'stale' | null) { return this.vdp.vdpAutopilotInputs(m, auth); }
  vdpIdentityPending() { return this.vdp.vdpIdentityPending(); }
  getVdpCoverage(_i: I<'getVdpCoverage'>) { return this.vdp.getVdpCoverage(_i); }
  getVdpDetail(i: I<'getVdpDetail'>) { return this.vdp.getVdpDetail(i); }
  setVdpCandidate(i: I<'setVdpCandidate'>) { return this.vdp.setVdpCandidate(i); }
  findVdpAssets(i: I<'findVdpAssets'>) { return this.vdp.findVdpAssets(i); }
  stageLogBatch(i: I<'stageLogBatch'>) { return this.canvas.stageLogBatch(i); }
  syncLandingsQuietly(reason: string) { return this.canvas.syncLandingsQuietly(reason); }
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
  withdrawGoneVdpDrafts() { return this.vdp.withdrawGoneVdpDrafts(); }
  pushVdpChanges(i: I<'pushVdpChanges'>) { return this.vdp.pushVdpChanges(i); }
  runVdpPush(deps: { pushId: string; gateway: OutboxGateway | null; signal?: AbortSignal; reads?: VdpLiveReads | null }) { return this.vdp.runVdpPush(deps); }
  runVdpAutopilot(deps: { gateway: OutboxGateway | null; auth: () => Promise<'ok' | 'stale'>; notify?: (why: 'reauth' | 'dry_run' | 'cap') => Promise<void>; signal?: AbortSignal }) { return this.vdp.runVdpAutopilot(deps); }
  searchVdpCompanies(i: I<'searchVdpCompanies'>) { return this.vdp.searchVdpCompanies(i); }
  setVdpIdentity(i: I<'setVdpIdentity'>) { return this.vdp.setVdpIdentity(i); }
  clearVdpIdentity(i: I<'clearVdpIdentity'>) { return this.vdp.clearVdpIdentity(i); }
  getAccount(i: I<'getAccount'>) { return this.deals.getAccount(i); }
  claimIn(w: WriteCtx, model: ReadModel, mo: MissedOpp, body?: ClaimMissedRequest) { return this.deals.claimIn(w, model, mo, body); }
  claimMissed(i: I<'claimMissed'>) { return this.deals.claimMissed(i); }
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
  stillNeededBackfill(opts: { apply: boolean }) { return this.engine.stillNeededBackfill(opts); }
  settleApply(entries: Array<{ itemId: string; expectedState: string; action: 'close' | 'ask_looks_done' | 'ask_still_needed' | 'reopen' | 'wait'; reasonClass: ClosingReason | null; resolution?: Resolution; reason: string; verdict: string; confidence: number; check: string; cite?: { sourceItemId?: string; url?: string; byName?: string; fromMe?: boolean; at?: string }; duplicateOf?: string }>) { return this.engine.settleApply(entries); }
  mergeTriage(i: I<'mergeTriage'>) { return this.triage.mergeTriage(i); }
  getHealth(i: I<'getHealth'>) { return this.health.getHealth(i); }
  getSpendAudit(i: I<'getSpendAudit'>) { return this.health.getSpendAudit(i); }
  getSpendAuditDetail(i: I<'getSpendAuditDetail'>) { return this.health.getSpendAuditDetail(i); }
  getReadme(_i: I<'getReadme'>) { return this.health.getReadme(_i); }
  getGuide(_i: I<'getGuide'>) { return this.health.getGuide(_i); }
  getDoctor(i: I<'getDoctor'>) { return this.health.getDoctor(i); }
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
  listSpendHolds(i: I<'listSpendHolds'>) { return this.health.listSpendHolds(i); }
  answerSpendHold(i: I<'answerSpendHold'>) { return this.health.answerSpendHold(i); }
  chatSpendAnswer(i: I<'chatSpendAnswer'>) { return this.health.chatSpendAnswer(i); }
  chatPlanAnswer(i: I<'chatPlanAnswer'>) { return this.chats.chatPlanAnswer(i); }
  listChatMemory(i: I<'listChatMemory'>) { return this.chats.listChatMemory(i); }
  deleteChatMemory(i: I<'deleteChatMemory'>) { return this.chats.deleteChatMemory(i); }
  previewPolicy(i: I<'previewPolicy'>) { return this.settingsDomain.previewPolicy(i); }
  applyPolicy(i: I<'applyPolicy'>) { return this.settingsDomain.applyPolicy(i); }
  revertPolicy(i: I<'revertPolicy'>) { return this.settingsDomain.revertPolicy(i); }
  getPolicyVersions(_i: I<'getPolicyVersions'>) { return this.settingsDomain.getPolicyVersions(_i); }
  undoAudit(i: I<'undoAudit'>) { return this.universal.undoAudit(i); }
  search(i: I<'search'>) { return this.universal.search(i); }
  getSince(i: I<'getSince'>) { return this.universal.getSince(i); }
  getPeople(i: I<'getPeople'>) { return this.universal.getPeople(i); }
  listChatThreads(_i: I<'listChatThreads'>) { return this.chats.listChatThreads(_i); }
  createChatThread(i: I<'createChatThread'>) { return this.chats.createChatThread(i); }
  getReadIn(i: I<'getReadIn'>) { return this.universal.getReadIn(i); }
  requestReadIn(i: I<'requestReadIn'>) { return this.universal.requestReadIn(i); }

  // ---- the attribution engine (db/attribution.ts) ----
  async getAttributionRules(_i: I<'getAttributionRules'>): Promise<Res<'getAttributionRules'>> { return this.attribution.rules(); } // prettier-ignore
  async patchAttributionRule({ params, body }: I<'patchAttributionRule'>): Promise<Res<'patchAttributionRule'>> { return this.attribution.patchRule(params.id, body.enabled); } // prettier-ignore
  async deleteAttributionRule({ params }: I<'deleteAttributionRule'>): Promise<Res<'deleteAttributionRule'>> { return this.attribution.deleteRule(params.id); } // prettier-ignore
  async getDcSuggestions(_i: I<'getDcSuggestions'>): Promise<Res<'getDcSuggestions'>> { return this.attribution.dcSuggestions(); } // prettier-ignore
  async decideDcSuggestion({ params, body }: I<'decideDcSuggestion'>): Promise<Res<'decideDcSuggestion'>> { return this.attribution.decide(params.id, body); } // prettier-ignore
  async refreshDcSuggestions(_i: I<'refreshDcSuggestions'>): Promise<Res<'refreshDcSuggestions'>> { return this.attribution.refresh(); } // prettier-ignore
  async getOppRundown({ query = {} }: I<'getOppRundown'>): Promise<Res<'getOppRundown'>> { return this.attribution.rundown(query); } // prettier-ignore
  async lookupCoveredAe({ body }: I<'lookupCoveredAe'>): Promise<Res<'lookupCoveredAe'>> { return this.attribution.lookupAe(body.q); } // prettier-ignore
  // ---- use cases to add (db/use-cases.ts) ----
  async getUseCaseCandidates(_i: I<'getUseCaseCandidates'>): Promise<Res<'getUseCaseCandidates'>> { return this.useCases.list(); } // prettier-ignore
  async decideUseCaseCandidate({ params, body }: I<'decideUseCaseCandidate'>): Promise<Res<'decideUseCaseCandidate'>> { return this.useCases.decide(params.id, body); } // prettier-ignore
  async addUseCaseCandidate({ body }: I<'addUseCaseCandidate'>): Promise<Res<'addUseCaseCandidate'>> { return this.useCases.add(body); } // prettier-ignore
  async refreshUseCaseCandidates(_i: I<'refreshUseCaseCandidates'>): Promise<Res<'refreshUseCaseCandidates'>> { return this.useCases.refresh(); } // prettier-ignore

  // ---- lane A: Specialist Forecast (db/forecast.ts) ----
  async getForecast(_i: I<'getForecast'>): Promise<Res<'getForecast'>> { return this.forecast.view(); } // prettier-ignore
  async getForecastRecord({ params }: I<'getForecastRecord'>): Promise<Res<'getForecastRecord'>> { return this.forecast.detail(params.id); } // prettier-ignore
  async syncForecast(_i: I<'syncForecast'>): Promise<Res<'syncForecast'>> { return this.forecast.sync(); } // prettier-ignore
  async draftForecastNotes(i: I<'draftForecastNotes'>): Promise<Res<'draftForecastNotes'>> { return this.forecast.draft(i); } // prettier-ignore
  async patchForecast({ params, body }: I<'patchForecast'>): Promise<Res<'patchForecast'>> { return this.forecast.patch(params.id, body); } // prettier-ignore
  async stageForecast(i: I<'stageForecast'>): Promise<Res<'stageForecast'>> { return this.forecast.stage(i); } // prettier-ignore
  async checkMissingForecast({ params }: I<'checkMissingForecast'>): Promise<Res<'checkMissingForecast'>> { return this.forecast.checkMissing(params.id); } // prettier-ignore

  // ---- Onboarding (B-079; db/onboarding.ts) ----
  async getOnboarding(_i: I<'getOnboarding'>): Promise<Res<'getOnboarding'>> {
    return this.onboarding.state();
  }
  async saveOnboardingStep({ body }: I<'saveOnboardingStep'>): Promise<Res<'saveOnboardingStep'>> {
    return this.onboarding.save(body);
  }
  async getOnboardingSources({ query }: I<'getOnboardingSources'>): Promise<Res<'getOnboardingSources'>> {
    return this.onboarding.sources(query?.refresh ?? false);
  }
  async completeOnboarding(_i: I<'completeOnboarding'>): Promise<Res<'completeOnboarding'>> {
    return this.onboarding.complete();
  }
  getChatThread(i: I<'getChatThread'>) { return this.chats.getChatThread(i); }
  chat(i: I<'chat'> & { signal: AbortSignal }) { return this.chats.chat(i); }
  chatOps() { return this.chats.chatOps(); }
  events(i: { signal: AbortSignal }) { return this.universal.events(i); }
  getFeedback(_i: I<'getFeedback'>) { return this.feedback.getFeedback(_i); }
  diagnoseFeedback(i: I<'diagnoseFeedback'>) { return this.feedback.diagnoseFeedback(i); }
  stageFeedback(i: I<'stageFeedback'>) { return this.feedback.stageFeedback(i); }
  getScenario(_i: I<'getScenario'>) { return this.dev.getScenario(_i); }
  controlScenario(_i: I<'controlScenario'>) { return this.dev.controlScenario(_i); }
  getDevFail(_i: I<'getDevFail'>) { return this.dev.getDevFail(_i); }
  setDevFail(_i: I<'setDevFail'>) { return this.dev.setDevFail(_i); }
  devEngineChange(_i: I<'devEngineChange'>) { return this.dev.devEngineChange(_i); }
  engineUpdateItem(itemId: string, patch: Partial<WorkItemRecord>, reason: string) { return this.engine.engineUpdateItem(itemId, patch, reason); }
  applyClosureSignal(itemId: string, signal: Signal, settings?: ClosureSettings) { return this.engine.applyClosureSignal(itemId, signal, settings); }
  engineReviseDraft(draftId: string, newText: string, reason: string) { return this.engine.engineReviseDraft(draftId, newText, reason); }
  changeSet(csId: string) { return this.engine.changeSet(csId); }
  rawKv() { return this.engine.rawKv(); }
}

/**
 * The app's db DataSource. BE-CHAT: chat answers with the Agent SDK runner when CC_CHAT_LLM=1, else with
 * the same runner over the deterministic fake model (a bare `new DbDataSource()` keeps "not wired").
 */
export function createDbDataSource(opts?: DbDataSourceOptions): DbDataSource {
  return new DbDataSource({ chatBackend: chatRunnerBackend(chatRunnerFor('db')), ...opts });
}
