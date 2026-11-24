/**
 * Time ▸ Forecast in mock mode (lane A): placeholder Specialist Forecasts generated from the store's accounts and opps
 * (src/server/forecast/mock-records.ts), the same view, edits and canvas as the db (src/server/forecast/service.ts),
 * and the placeholder drafter instead of a model (no calls, $0). Nothing leaves: the canvas is an Outbox item the
 * simulated transport answers on Apply. "Sync now" stands in for Slackbot having run every handed-off canvas, and
 * "I created it, check now" for Org62 showing the record you created (after a short simulated read).
 */
import type { Draft, ForecastPayload, ForecastRecordDetail, ForecastRow, PatchForecastRequest, RouteInput, RouteOutput, Settings, SpecialistForecast } from '@/contract';
import { buildForecastView, DRAFT_CAP_USD, withForecast, type ForecastCheckInput } from '@/engines/forecast/view';
import { forecastCanvasIndex, NOTES_FIELD, ROLE_FIELD, updateKey } from '@/engines/forecast/canvas';
import { quarterPair } from '@/engines/forecast/time';
import { personaOf } from '@/personas';
import { placeholderDraft, PLACEHOLDER_MODEL } from '@/server/forecast/draft';
import { MOCK_OWNER_ORG62_ID, mockCreatedForecast, mockSpecialistForecasts } from '@/server/forecast/mock-records';
import { draftTargets, patchedPending, stagePlan } from '@/server/forecast/service';
import { notFound, invalid } from '@/server/errors';
import { actionDraftFor } from '@/server/vdp/coverage';
import type { Store } from './store';

export interface MockForecastHost {
  now(): Date;
  store(): Store;
  newId(prefix: string): string;
  /** One audited change: put the canvas item. */
  putDraft(draft: Draft, summary: string): { auditId: string | null };
  rendered(dest: Draft['destination'], doc: Draft['doc']): Draft['rendered'];
  /** Invalidate Time and Home (the records live outside the store). */
  publish(ids: string[], reason: string): void;
  /** Run later (the simulated worker read of "I created it, check now"). */
  later(ms: number, fn: () => void): void;
  checkMs(): number;
}

export class MockForecast {
  private records: SpecialistForecast[] | null = null;
  private storeRef: Store | null = null;
  private syncedAt: string | null = null;
  /** "I created it, check now", per opp (reset with the store). */
  private checks = new Map<string, ForecastCheckInput>();

  constructor(private readonly host: MockForecastHost) {}

  private settings(): Settings {
    return this.host.store().settings();
  }

  /** The placeholder records (regenerated when the store is reset). */
  all(): SpecialistForecast[] {
    const s = this.host.store();
    if (!this.records || this.storeRef !== s) {
      this.storeRef = s;
      const tz = s.settings().profile.timezone || s.meta().timezone;
      this.records = mockSpecialistForecasts(s.all('accounts'), s.all('opps'), this.host.now().getTime(), tz);
      this.syncedAt = this.records[0]?.syncedAt ?? null;
      this.checks = new Map();
    }
    return this.records;
  }

  /** Home ▸ Log & fix input. */
  homeInput(): { records: SpecialistForecast[]; sync: ForecastPayload['sync']; mode: 'mock' } {
    return { records: this.all(), sync: this.syncState(), mode: 'mock' };
  }

  private syncState(): ForecastPayload['sync'] {
    return { status: 'mock', lastAt: this.syncedAt, note: 'Mock mode: placeholder records, nothing is read from Org62', records: this.all().filter((r) => !r.goneAt).length, nextAt: null };
  }

  /** `all`: the rows even when the feature is not active (the details panel). */
  view(all = false): ForecastPayload {
    const s = this.host.store();
    const settings = this.settings();
    return buildForecastView({
      now: this.host.now().toISOString(),
      timezone: settings.profile.timezone || s.meta().timezone,
      persona: all ? withForecast(personaOf(settings)) : personaOf(settings),
      mode: 'mock',
      records: this.all(),
      opps: s.all('opps'),
      accounts: s.all('accounts'),
      drafts: s.all('drafts'),
      sync: this.syncState(),
      drafting: [],
      perDraftUsd: DRAFT_CAP_USD,
      dayLeftUsd: 0,
      checks: [...this.checks.values()],
    });
  }

  private active(v: ForecastPayload) {
    if (!v.active) throw invalid('Specialist Forecast is not active for your role: activate it in Settings ▸ Role & rules');
  }

  private put(rec: SpecialistForecast) {
    this.records = this.all().map((r) => (r.id === rec.id ? rec : r));
  }

  private rowOf(id: string): ForecastRow {
    const row = this.view().rows.find((r) => r.id === id);
    if (!row) throw notFound('Specialist Forecast', id);
    return row;
  }

  /** One record (a read: answers whether or not the feature is active, like any mirror read). */
  detail(id: string): ForecastRecordDetail {
    const v = this.view(true);
    const rec = this.all().find((r) => r.id === id);
    const row = v.rows.find((r) => r.id === id);
    if (!rec || !row) throw notFound('Specialist Forecast', id);
    const s = this.host.store();
    const opp = rec.opportunityId ? s.get('opps', rec.opportunityId) : undefined;
    return { row, record: rec, opportunity: opp ? { id: opp.id, name: opp.name, stage: opp.stage, nextStep: opp.nextStep, products: opp.products, url: opp.org62Url } : null, meetingsSince: this.meetingsSince(rec), thresholds: v.thresholds };
  }

  /** Meetings with the record's account since its notes last changed (newest first, past only). */
  private meetingsSince(rec: SpecialistForecast): Array<{ id: string; title: string; start: string }> {
    if (!rec.accountId) return [];
    const now = this.host.now().toISOString();
    const since = rec.notesUpdatedAt ?? new Date(this.host.now().getTime() - 14 * 86_400_000).toISOString();
    return this.host
      .store()
      .all('events')
      .filter((e) => e.accountId === rec.accountId && e.start >= since && e.start <= now)
      .sort((a, b) => b.start.localeCompare(a.start) || a.id.localeCompare(b.id))
      .map((e) => ({ id: e.id, title: e.title, start: e.start }));
  }

  /** Mock "Sync now": Slackbot is taken to have run every handed-off canvas (its values land), then a fresh read. */
  sync(): RouteOutput<'syncForecast'> {
    this.active(this.view());
    const nowIso = this.host.now().toISOString();
    const marks = forecastCanvasIndex(this.host.store().all('drafts'));
    this.records = this.all().map((r) => {
      const n = marks.get(updateKey(r.org62Id, NOTES_FIELD));
      const d = marks.get(updateKey(r.org62Id, ROLE_FIELD));
      let next = { ...r, syncedAt: nowIso };
      if (n?.kind === 'sent' && n.value !== r.notes) next = { ...next, prevNotes: r.notes, notes: n.value, notesUpdatedAt: nowIso };
      if (d?.kind === 'sent') next = { ...next, dealRole: d.value };
      return next;
    });
    this.syncedAt = nowIso;
    this.host.publish(this.records.map((r) => r.id), 'forecast.sync');
    return { entity: { queued: false, note: 'Mock mode: placeholder records refreshed; handed-off canvases count as run by Slackbot' }, auditId: null };
  }

  draft(i: RouteInput<'draftForecastNotes'>): RouteOutput<'draftForecastNotes'> {
    const v = this.view();
    this.active(v);
    const { targets, skipped } = draftTargets(v, i.body.ids);
    const nowIso = this.host.now().toISOString();
    const q = quarterPair(this.host.now().getTime(), this.settings().profile.timezone || 'UTC').current;
    for (const id of targets) {
      const rec = this.all().find((r) => r.id === id)!;
      const d = placeholderDraft({ record: rec, template: v.thresholds.template, meetingsSince: this.meetingsSince(rec) }, q);
      this.put({ ...rec, pending: { ...rec.pending, notes: { text: d.notes, state: 'drafted', origin: 'model', at: nowIso, basedOnNotesAt: rec.notesUpdatedAt, model: PLACEHOLDER_MODEL, costUsd: 0, sources: d.sources }, draftError: null } });
    }
    if (targets.length) this.host.publish(targets, 'forecast.draft');
    return { entity: { queued: [], drafted: targets, skipped, capUsd: 0 }, auditId: null };
  }

  patch(id: string, body: PatchForecastRequest): RouteOutput<'patchForecast'> {
    this.active(this.view());
    const rec = this.all().find((r) => r.id === id);
    if (!rec) throw notFound('Specialist Forecast', id);
    const pending = patchedPending(rec, this.rowOf(id), body, this.host.now().toISOString());
    this.put({ ...rec, pending });
    this.host.publish([id], 'forecast.patch');
    return { entity: this.rowOf(id), auditId: null };
  }

  /**
   * "I created it, check now" on mock: the check runs a moment later (as the worker would) and finds the record you
   * created, a placeholder with no notes and Deal Role None, so it joins the queue. Nothing is read from Org62.
   */
  checkMissing(opportunityId: string): RouteOutput<'checkMissingForecast'> {
    const v = this.view();
    this.active(v);
    const nowIso = this.host.now().toISOString();
    const done = v.found.find((f) => f.opportunityId === opportunityId);
    if (done) return { entity: { queued: false, note: 'Already found: its Specialist Forecast is in your list', check: done, followUpAt: null }, auditId: null };
    const miss = v.queue.missing.find((x) => x.opportunityId === opportunityId);
    if (!miss) throw invalid('This opportunity is not missing a Specialist Forecast (or is no longer one of yours this or next quarter)');
    const cur = this.checks.get(opportunityId);
    const running = !!cur && (cur.status === 'queued' || cur.status === 'running');
    if (!running) {
      const store = this.store();
      this.checks.set(opportunityId, { opportunityId, status: 'running', askedAt: nowIso, finishedAt: null, note: null });
      this.host.later(this.host.checkMs(), () => {
        if (this.storeRef !== store) return; // reset meanwhile
        const opp = store.get('opps', opportunityId);
        const at = this.host.now();
        if (opp && !this.all().some((r) => r.opportunityId === opportunityId)) {
          const n = Math.max(5, ...this.all().map((r) => Number(r.id.slice(-12)) || 0)) + 1;
          const acc = store.get('accounts', opp.accountId);
          this.records = [...this.all(), mockCreatedForecast(n, opp, acc?.name ?? null, at.getTime())];
        }
        this.checks.set(opportunityId, { opportunityId, status: 'succeeded', askedAt: nowIso, finishedAt: at.toISOString(), note: null });
        this.host.publish([opportunityId], 'forecast.check');
      });
      this.host.publish([opportunityId], 'forecast.check.queued');
    }
    return {
      entity: { queued: !running, note: running ? 'A check is already running' : 'Mock mode: checking stands in for Org62 showing the record you created', check: { opportunityId, opportunityName: miss.opportunityName, status: 'checking', at: running && cur ? cur.askedAt : nowIso, note: null, recordId: null }, followUpAt: null },
      auditId: null,
    };
  }

  private store(): Store {
    return this.host.store();
  }

  stage(i: RouteInput<'stageForecast'>): RouteOutput<'stageForecast'> {
    const v = this.view();
    this.active(v);
    const nowIso = this.host.now().toISOString();
    const plan = stagePlan(v, { ownerName: this.settings().profile.name || 'me', ownerOrg62Id: MOCK_OWNER_ORG62_ID, nowIso, sourceLabel: 'Command Center (mock) · forecast notes', ...(i.body.ids ? { ids: i.body.ids } : {}) });
    if (!plan.destination) {
      if (plan.deferred.length) throw invalid('These notes are too long for one canvas: shorten them, then try again');
      return { entity: { draftId: null, title: null, notes: 0, roles: 0, waiting: plan.waiting, deferred: plan.deferred }, auditId: null };
    }
    const dest = plan.destination;
    const draft = actionDraftFor(dest, { id: this.host.newId('d'), now: nowIso, rendered: (doc) => this.host.rendered(dest, doc) });
    const r = this.host.putDraft(draft, `Specialist Forecast canvas for approval: ${plan.title}`);
    return { entity: { draftId: draft.id, title: plan.title, notes: plan.notes, roles: plan.roles, waiting: plan.waiting, deferred: plan.deferred }, auditId: r.auditId };
  }
}

