/**
 * The mock DataSource, health domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id, I, Res } from '../shared';
import { healthForPersona, personaOf } from '@/personas';
import { withReauthCommand } from '@/server/datasource/reauth-command';
import { vdpRefreshCommand } from '@/contract';
import { answerHold, backgroundDayDefault } from '@/llm/spend';
import { eventLogView, scanPage, spendAskOf, spendHoldsPayload, spendHoldView } from '@/server/views/health';
import { invalid, notFound } from '@/server/errors';
import { connectorOfName, normalizeScanScope, placeholderScopeId } from '@/scanner/scope-catalog';
import { mockResolutionShadow } from '../resolution';
import { autopilotHealth } from '@/engines/vdp/autopilot';
import { buildInfo, versionPayload } from '@/server/version';
import { guidePayload } from '@/guide/checklist';
import { readReadme } from '@/server/guide';
import { mockCadenceSnapshot, withNextChecks } from '../../db/scan-cadence';
import { fmtHM, healthSummary } from '../views';
import { mockSpendAudit, mockSpendAuditDetail } from '../spend-audit';
import { mockDoctorPayload, mockHealthSetup } from '../health-setup';
import { simulatedSmoke } from '@/ops/smoke';

export class MockHealth {
  constructor(private readonly ctx: MockCtx) {}

  async getHealth(_i: I<'getHealth'>): Promise<Res<'getHealth'>> {
    const jobs = this.ctx.store.all('jobs');
    const vdpCommand = vdpRefreshCommand(this.ctx.store.settings().scanning);
    const health: Res<'getHealth'> = {
      // FTI mock parity: each healthy source's next check one base interval after its last success
      connectors: (() => {
        const cs = this.ctx.store.all('connectors').map((c) => withReauthCommand(c, vdpCommand));
        return withNextChecks(cs, mockCadenceSnapshot(cs, this.ctx.now()), this.ctx.now());
      })(),
      summary: healthSummary(this.ctx.store),
      spend: this.ctx.store.spend(),
      worker: { alive: true, lastHeartbeatAt: this.ctx.nowIso(), queueDepth: jobs.filter((j) => j.status === 'queued' || j.status === 'retrying').length },
      dryRun: this.ctx.store.settings().sending.dryRun,
      firstScan: this.ctx.ds.onboarding.firstScanProgress(), // B-079: the simulated first scan after mock onboarding
      vdpAutopilot: autopilotHealth(this.ctx.ds.vdp.vdpAutopilotInputs()), // D-60
      setup: mockHealthSetup(this.ctx.store.all('connectors'), new Date(this.ctx.nowIso())), // 11 R6: fixture states
      spendAsks: (await this.ctx.spendGov.store.listHolds({ states: ['asked'] })).map((h) => spendAskOf(h)),
      resolutionShadow: mockResolutionShadow(this.ctx.store.settings().closing.resolutionEngine, this.ctx.store.all('workItems'), this.ctx.clock.now()), // H-7
      priority: this.ctx.ds.priority.health(this.ctx.store, this.ctx.now()), // priority@2 R8: live comparison + the learning rule
    };
    // the mock has no measured scanning days: a day of background scanning from the table, as the db before 5 days
    health.spend = { ...health.spend, background: { ...backgroundDayDefault(), heldUsd: (await this.ctx.spendGov.store.dayStatus()).heldUsd } };
    // D-55: a source the persona has not activated has no Health row (it is listed in Settings ▸ Role & rules)
    return healthForPersona(health, personaOf(this.ctx.store.settings()));
  }

  async listSpendHolds({ query }: I<'listSpendHolds'>): Promise<Res<'listSpendHolds'>> {
    const since = query?.since ?? new Date(this.ctx.now().getTime() - 7 * 86_400_000).toISOString();
    const holds = await this.ctx.spendGov.store.listHolds({ since, ...(query?.state ? { states: [query.state] } : {}) });
    return spendHoldsPayload(holds, await this.ctx.spendGov.store.listHolds({ states: ['asked'] }));
  }

  async answerSpendHold({ params, body }: I<'answerSpendHold'>): Promise<Res<'answerSpendHold'>> {
    const r = await answerHold(this.ctx.spendGov, params.id, body);
    if (!r) throw notFound('Spend hold', params.id);
    this.ctx.publish(['health'], [params.id], 'spend.answer');
    return { hold: spendHoldView(r.hold), resumed: r.resumed };
  }

  async chatSpendAnswer({ body }: I<'chatSpendAnswer'>): Promise<Res<'chatSpendAnswer'>> {
    return this.answerSpendHold({ params: { id: body.holdId }, body: { answer: body.answer, ...(body.usd !== undefined ? { usd: body.usd } : {}) } } as never);
  }

  async getSpendAudit({ query }: I<'getSpendAudit'>): Promise<Res<'getSpendAudit'>> {
    return mockSpendAudit(this.ctx.store.spend(), query ?? {}, { now: new Date(this.ctx.nowIso()), timezone: this.ctx.store.settings().profile.timezone });
  }

  async getSpendAuditDetail({ query }: I<'getSpendAuditDetail'>): Promise<Res<'getSpendAuditDetail'>> {
    return mockSpendAuditDetail(this.ctx.store.spend(), query);
  }

  async getReadme(_i: I<'getReadme'>): Promise<Res<'getReadme'>> {
    return readReadme();
  }

  async getGuide(_i: I<'getGuide'>): Promise<Res<'getGuide'>> {
    const settings = this.ctx.store.settings();
    const threads = this.ctx.store.all('chatThreads').map((t) => t.thread);
    return guidePayload({
      connectors: this.ctx.store.all('connectors'),
      drafts: this.ctx.store.all('drafts'),
      assistantMessages: threads.reduce((n, t) => n + t.messageCount, 0),
      firstScan: null,
      persona: personaOf(settings),
      personaVersion: settings.persona.version,
      guide: settings.guide,
      // the Getting started DC outcome ticks on a DC request made in the app (any state)
      dcRequests: this.ctx.store.all('dcRequests').length,
    });
  }

  async getDoctor(_i: I<'getDoctor'>): Promise<Res<'getDoctor'>> {
    // 11 R6: fixture checks (nothing on this Mac is run in mock mode)
    return mockDoctorPayload(this.ctx.store.all('connectors'), new Date(this.ctx.nowIso()));
  }

  async smokeClaude(_i: I<'smokeClaude'>): Promise<Res<'smokeClaude'>> {
    return simulatedSmoke(new Date(this.ctx.nowIso()));
  }

  async checkForUpdates(_i: I<'checkForUpdates'>): Promise<Res<'checkForUpdates'>> {
    // D-90: no worker and no Drive in mock mode: nothing is queued or read
    return { queued: false, jobId: null, update: null };
  }

  async getVersion(_i: I<'getVersion'>): Promise<Res<'getVersion'>> {
    // Mock: no database and no worker process; the persona is the mock settings'.
    return versionPayload({ build: buildInfo(), migration: null, persona: personaOf(this.ctx.store.settings()), workerVersion: null, dataSource: 'mock' });
  }

  async reauthConnector({ params }: I<'reauthConnector'>): Promise<Res<'reauthConnector'>> {
    const vdpCommand = vdpRefreshCommand(this.ctx.store.settings().scanning);
    const c = withReauthCommand(this.ctx.store.must('connectors', params.id, 'Connector'), vdpCommand);
    const action = c.reauth ?? { kind: 'instructions' as const, label: 'No re-auth needed', command: null, instructions: `${c.label} does not need re-auth` };
    const started = action.kind === 'in_app' || action.kind === 'refresh_script' || action.kind === 'terminal_command';
    if (started) {
      this.ctx.tx({ actor: 'user', action: 'connector.reauth', summary: `Re-auth started: ${c.label}`, entity: { type: 'connector', id: c.id, label: c.label }, audit: false }, (tx) => tx.put('connectors', { ...c, state: 'catching_up', since: this.ctx.nowIso(), catchUpPct: 0, impact: `Catching up ${c.label}…` }));
      const steps = [35, 70, 100];
      steps.forEach((pct, i) =>
        this.ctx.later(this.ctx.delays.stepMs * (i + 1), () => {
          const cur = this.ctx.store.get('connectors', c.id);
          if (!cur || cur.state !== 'catching_up') return;
          if (pct === 100) this.ctx.ds.engine.engineConnectorState(c.id, 'ok', undefined, undefined, { actor: 'connector' });
          else this.ctx.tx({ actor: 'connector', action: 'connector.catch_up', summary: `${c.label} ${pct}%`, entity: { type: 'connector', id: c.id, label: c.label }, audit: false }, (tx) => tx.put('connectors', { ...cur, catchUpPct: pct }));
        }),
      );
    }
    return { connector: withReauthCommand(this.ctx.store.get('connectors', c.id)!, vdpCommand), action, started };
  }

  async scanConnector({ params, body }: I<'scanConnector'>): Promise<Res<'scanConnector'>> {
    const { run, entry } = this.scanInternal(params.id, body.scope ?? 'manual', 'user');
    return { entity: run, auditId: entry?.id ?? null };
  }

  scanInternal(connectorId: string, scope: string, actor: 'user' | 'chat') {
    const c = this.ctx.store.must('connectors', connectorId, 'Connector');
    // HYG-1: the same scope check as db mode (an optional `<connector>:` prefix; an unknown scope is a 400)
    const runtime = connectorOfName(c.id) ?? connectorOfName(c.source);
    // chat's `/rescan slack 2d` labels its run `chat:<window>`: the connector's default scope over that window
    const chatWindow = actor === 'chat' && scope.startsWith('chat:');
    const check = runtime && !chatWindow ? normalizeScanScope(runtime, scope) : ({ ok: true, scope: null } as const);
    if (!check.ok) throw invalid(`Unknown scope "${check.scope}" for ${c.id}. Valid scopes: ${check.valid.join(', ')}`, { scope: check.scope, valid: check.valid });
    const now = this.ctx.nowIso();
    const authBroken = c.state === 'auth_needed';
    const run = {
      id: id('scan'),
      connectorId: c.id,
      scope: chatWindow || !runtime ? scope : placeholderScopeId(runtime, check.scope),
      kind: 'manual' as const,
      windowStart: c.cursor.at ?? now,
      windowEnd: now,
      status: authBroken ? ('auth_failed' as const) : ('running' as const),
      startedAt: now,
      endedAt: authBroken ? now : null,
      itemsSeen: 0,
      itemsNew: 0,
      itemsChanged: 0,
      costUsd: 0,
      model: c.source === 'slack' || c.source === 'org62' ? 'haiku' : null,
      error: authBroken ? `${c.label} needs re-auth` : null,
    };
    const { entry } = this.ctx.tx({ actor, action: actor === 'chat' ? 'chat.scan' : 'connector.scan', summary: `Scan ${c.label}`, entity: { type: 'connector', id: c.id, label: c.label }, undoable: false }, (tx) => tx.put('scanRuns', run));
    if (!authBroken) {
      this.ctx.later(this.ctx.delays.stepMs, () => {
        const cur = this.ctx.store.get('scanRuns', run.id);
        const conn = this.ctx.store.get('connectors', c.id);
        if (!cur || !conn) return;
        this.ctx.tx({ actor: 'connector', action: 'scan.ok', summary: `Scan ${c.label} ok`, entity: { type: 'connector', id: c.id, label: c.label }, audit: false }, (tx) => {
          tx.put('scanRuns', { ...cur, status: 'ok', endedAt: this.ctx.nowIso(), itemsSeen: 12, itemsNew: 1, itemsChanged: 2, costUsd: cur.model ? 0.004 : 0 });
          tx.put('connectors', { ...conn, lastSuccessAt: this.ctx.nowIso(), cursor: { label: `${conn.label} through ${fmtHM(this.ctx.now(), this.ctx.store.settings().profile.timezone)}`, at: this.ctx.nowIso() }, itemsToday: conn.itemsToday + 1 });
        });
      });
    }
    return { run, entry, connector: c };
  }

  async getScans({ query }: I<'getScans'>): Promise<Res<'getScans'>> {
    return scanPage(this.ctx.store.all('scanRuns'), query); // the db's paging (server/views/health.ts)
  }

  async getJobs(_i: I<'getJobs'>): Promise<Res<'getJobs'>> {
    const jobs = this.ctx.store.all('jobs').sort((a, b) => b.runAt.localeCompare(a.runAt));
    const counts = { queued: 0, running: 0, retrying: 0, succeeded: 0, dead: 0, cancelled: 0 };
    for (const j of jobs) counts[j.status]++;
    return { jobs, counts };
  }

  async retryJob({ params }: I<'retryJob'>): Promise<Res<'retryJob'>> {
    const j = this.ctx.store.must('jobs', params.id, 'Job');
    if (!['dead', 'cancelled', 'retrying'].includes(j.status)) throw invalid(`Job is ${j.status}`);
    const next = { ...j, status: 'queued' as const, attempts: 0, error: null, runAt: this.ctx.nowIso(), finishedAt: null };
    const { entry } = this.ctx.tx({ actor: 'user', action: 'job.retry', summary: `Requeued ${j.type}`, entity: { type: 'job', id: j.id, label: j.type } }, (tx) => tx.put('jobs', next));
    this.ctx.later(this.ctx.delays.stepMs, () => {
      const cur = this.ctx.store.get('jobs', j.id);
      if (cur?.status !== 'queued') return;
      this.ctx.tx({ actor: 'system', action: 'job.succeeded', summary: `${j.type} succeeded`, entity: { type: 'job', id: j.id, label: j.type }, audit: false }, (tx) =>
        tx.put('jobs', { ...cur, status: 'succeeded', attempts: 1, startedAt: this.ctx.nowIso(), finishedAt: this.ctx.nowIso() }),
      );
    });
    return { entity: next, auditId: entry?.id ?? null };
  }

  async getEventLog(_i: I<'getEventLog'>): Promise<Res<'getEventLog'>> {
    return eventLogView(this.ctx.store);
  }

  async ackEvent({ params }: I<'ackEvent'>): Promise<Res<'ackEvent'>> {
    const e = this.ctx.store.must('eventLog', params.id, 'Event');
    const next = { ...e, acknowledged: true, acknowledgedAt: this.ctx.nowIso() };
    const { entry } = this.ctx.tx({ actor: 'user', action: 'event.ack', summary: `Acknowledged ${e.code}`, entity: { type: 'event_log', id: e.id, label: e.code } }, (tx) => tx.put('eventLog', next));
    return { entity: next, auditId: entry?.id ?? null };
  }
}
