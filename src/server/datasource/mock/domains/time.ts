/**
 * The mock DataSource, time domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id, I, Res } from '../shared';
import { loggingProfile, withPersonaTarget } from '@/engines/activity/persona';
import { personaOf, featureActive } from '@/personas';
import { canvasHolds, markCanvasHolds } from '@/lib/canvas/payload';
import { addDays, format, parseISO } from 'date-fns';
import type { ActivityEntry, OnsiteDay, TimeWeek } from '@/contract';
import { invalid, notFound } from '@/server/errors';
import { org62AccountIdOfUrl } from '@/engines/attribution/target';
import { patchedEntry, targetPatch, planDismissFromSource, planRemoveRule, rulesView } from '@/server/time/dismiss';
import { ucSyncView } from '@/server/deals/use-cases';
import { planUseCases } from '@/engines/activity/use-cases';
import { planRecheck, type CanvasChecks } from '@/lib/canvas/checks';
import { mockPreflightContext } from '../outbox';
import { resolvedEntry, resolvedSummary } from '@/server/time/relog';
import { isPendingLogCanvas, preflightDraft } from '@/server/time/canvas-preflight';
import { activityStamps, buildActivityLog } from '../../activity-log';
import { withSuggestions, type StoredSuggestion, type SuggestContext } from '@/lib/time-suggest';
import { MOCK_ORG62_OPPS, mockAccountIdFor, mockOppIdFor, mockOrg62AccountIdFor, mockOrg62IdFor, searchMockOrg62Opps } from '@/mock/org62-opps';
import { org62RecordUrl } from '@/projections/links';
import { fmtHM } from '../views';
import { oppOptionsView, timeLedgerView, timeWeekView } from '@/server/views/time';

export class MockTime {
  constructor(private readonly ctx: MockCtx) {}

  async getTime({ query }: I<'getTime'>): Promise<Res<'getTime'>> {
    return this.buildTime(query.week);
  }

  async getActivityLog({ query = {} }: I<'getActivityLog'>): Promise<Res<'getActivityLog'>> {
    const { timezone, workingHours } = this.ctx.store.settings().profile;
    return buildActivityLog(this.suggested(markCanvasHolds(this.ctx.store.all('activity'), canvasHolds(this.ctx.store.all('drafts')))), query, { meta: withPersonaTarget(this.ctx.store.meta(), personaOf(this.ctx.store.settings())), now: this.ctx.now(), tz: timezone, dayEnd: workingHours.end });
  }

  async getTimeLedger({ query = {} }: I<'getTimeLedger'>): Promise<Res<'getTimeLedger'>> {
    return timeLedgerView(this.ctx.store, query, this.ctx.now());
  }

  /** GET /time's week: the shared view (src/server/views/time.ts) with the mock's suggestions, onsite chips and canvas progress. */
  private buildTime(week?: string): TimeWeek {
    const now = this.ctx.now();
    const onsite = (from: string, to: string) => [...this.onsite.values()].filter((d) => d.day >= from && d.day <= to).sort((x, y) => x.day.localeCompare(y.day));
    return timeWeekView(this.ctx.store, { suggested: (entries) => this.suggested(entries), onsite, progress: this.canvasProgressSources(now) }, week, now);
  }

  /** 2026-11-13 audit C4: per-canvas checks (when you told Slackbot, the queued re-checks); the db keeps them in kv. */
  canvasChecks: CanvasChecks = {};

  /**
   * The model's stored answers for rows that need an opp (the db's kv `cc.time.suggestions`). The mock never calls a
   * model, so it has none unless a test puts some (`putStoredSuggestions`): its rows show the rules' suggestions.
   */
  private storedSuggestions: Record<string, StoredSuggestion> = {};

  /** Tests: the model's answers, as the `activity.suggest` job stores them on the db. */
  putStoredSuggestions(rows: Record<string, StoredSuggestion>): void {
    this.storedSuggestions = { ...rows };
    this.ctx.bus.publish({ topic: 'time', ids: Object.keys(rows), reason: 'time.suggestions' });
  }

  /** What a row that needs an opp is suggested (src/lib/time-suggest.ts, the db's twin), with the attribution engine's extras. */
  private suggestContext(): SuggestContext {
    return { ...this.baseSuggestContext(), attribution: this.ctx.ds.attribution.extras() };
  }

  /** The records the suggestion reads (no extras: the attribution engine adds them). */
  baseSuggestContext(): SuggestContext {
    const tz = this.ctx.store.settings().profile.timezone;
    return {
      opps: this.ctx.store.all('opps'),
      accounts: this.ctx.store.all('accounts'),
      events: this.ctx.store.all('events'),
      people: this.ctx.store.all('people'),
      assets: this.ctx.store.all('assets'),
      runs: this.ctx.store.all('agentRuns'),
      workItems: this.ctx.store.all('workItems'),
      activity: this.ctx.store.all('activity'),
      today: new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.ctx.now()),
      stored: this.storedSuggestions,
      internalActivity: loggingProfile(personaOf(this.ctx.store.settings())).internalActivity,
    };
  }

  private suggested(entries: ActivityEntry[]): ActivityEntry[] {
    // D-103 (c): every row gets its sentence (groundwork), the suggestion only while it needs an opp
    return withSuggestions(entries, this.suggestContext());
  }

  /** What each created canvas's progress line reads (the db's sources; the mock's reads are its connector's last success and the checks that came due). */
  private canvasProgressSources(now: Date) {
    const persona = personaOf(this.ctx.store.settings());
    const due = Object.values(this.canvasChecks).flatMap((c) => c.at).filter((x) => Date.parse(x) <= now.getTime()).sort().at(-1) ?? null;
    const org62 = this.ctx.store.all('connectors').find((c) => c.source === 'org62')?.lastSuccessAt ?? null;
    const read = [due, org62].filter((x): x is string => !!x).sort().at(-1) ?? null;
    return {
      dcRequests: featureActive(persona, 'dealContributions') ? this.ctx.ds.deals.dcRequests() : [],
      useCases: featureActive(persona, 'vdp') ? ucSyncView(planUseCases(this.ctx.ds.deals.ucPlanInput()), null).items : [],
      checks: this.canvasChecks,
      reads: { events: read, dcs: read, useCases: read },
    };
  }

  /** The db's checkCanvasOrg62 (2026-11-13 audit C4): the mock records the checks; nothing runs (no Org62 here). */
  async checkCanvasOrg62({ params, body }: I<'checkCanvasOrg62'>): Promise<Res<'checkCanvasOrg62'>> {
    const c = this.buildTime().logCanvases.find((x) => x.draftId === params.id);
    if (!c) throw notFound('Logging canvas', params.id);
    if (c.state !== 'applied' && c.state !== 'verified' && c.state !== 'unverified') throw invalid('This canvas is not in Slack yet: Apply it first, then tell Slackbot');
    const now = this.ctx.now();
    const plan = planRecheck(this.canvasChecks, c.draftId, body.reason, now);
    this.canvasChecks = plan.next;
    const persona = personaOf(this.ctx.store.settings());
    const reads: Array<'events' | 'dcs' | 'use_cases'> = ['events', ...(c.dcs > 0 && featureActive(persona, 'dealContributions') ? (['dcs'] as const) : []), ...(c.useCases > 0 && featureActive(persona, 'vdp') ? (['use_cases'] as const) : [])];
    this.ctx.bus.publish({ topic: 'time', ids: [c.draftId], reason: `time.canvas.check.${body.reason}` });
    return { draftId: c.draftId, queued: plan.slots.flatMap((at) => reads.map((read) => ({ read, at }))), nextCheckAt: plan.next[c.draftId]?.at.find((x) => Date.parse(x) > now.getTime() - 60_000) ?? null, note: 'Mock data: the checks are recorded, nothing reads Org62 here' };
  }

  async patchActivity({ params, body }: I<'patchActivity'>): Promise<Res<'patchActivity'>> {
    const cur = this.ctx.store.must('activity', params.id, 'Activity entry');
    this.ctx.checkVersion(cur, body.ifVersion, 'Activity entry', cur);
    // every edited field is locked except `status`: the pipeline's (a created canvas, the Org62 check) to move;
    // D-64: internal-ness (patchedEntry, the db's too)
    // D-103 (c): `target` stands for oppId / internal, or the account itself (targetPatch, the db's too)
    const tp = targetPatch(cur, body.patch);
    const opp = tp.oppId ? this.ctx.store.get('opps', tp.oppId) : undefined;
    const acct = body.patch.target?.kind === 'account' ? this.ctx.store.get('accounts', body.patch.target.id) : undefined;
    const { next: edited } = patchedEntry(cur, body.patch, opp ? { name: opp.name, accountName: this.ctx.store.get('accounts', opp.accountId)?.name ?? null } : null, acct ? { id: acct.id, name: acct.name } : null);
    const next = activityStamps(this.ctx.bump(edited));
    // D-65 (TL-25): an edit unstages a row a canvas item holds (the db's rule): the item is re-rendered without it
    const holder = canvasHolds(this.ctx.store.all('drafts')).rows.get(cur.id);
    const held = holder ? this.ctx.store.get('drafts', holder) : undefined;
    const { entry } = this.ctx.tx({ actor: 'user', action: 'activity.edit', summary: `Edited log row: ${cur.description}`, entity: { type: 'activity_entry', id: cur.id, label: cur.description }, coalesceKey: `activity:${cur.id}` }, (tx) => {
      // the attribution engine learns from a picked opp or an Internal (in this change: Undo reverts it too)
      if (tp.oppId !== undefined || tp.internal) this.ctx.ds.attribution.learnFromRow(tx, cur, next);
      tx.put('activity', next);
      if (held && isPendingLogCanvas(held)) {
        const out = preflightDraft(held, mockPreflightContext(this.ctx.store, new Set([cur.id])));
        if (out.next) tx.put('drafts', this.ctx.bump(out.next));
      }
    });
    // the row as GET /time reads it (its suggestion, while it still needs an opp)
    return { entity: this.suggested([next])[0]!, auditId: entry?.id ?? null };
  }

  // D-65 (TL-14, TL-20): Log again / Leave out on a row that is not in Org62 after all (the db's rule, relog.ts)
  async resolveActivity({ params, body }: I<'resolveActivity'>): Promise<Res<'resolveActivity'>> {
    const cur = this.ctx.store.must('activity', params.id, 'Activity entry');
    this.ctx.checkVersion(cur, body.ifVersion, 'Activity entry', cur);
    const next = activityStamps(this.ctx.bump(resolvedEntry(cur, body.action)));
    const { entry } = this.ctx.tx({ actor: 'user', action: `activity.org62.${body.action}`, summary: resolvedSummary(cur, body.action), entity: { type: 'activity_entry', id: cur.id, label: cur.description } }, (tx) => tx.put('activity', next));
    return { entity: next, auditId: entry?.id ?? null };
  }

  async getOppOptions({ query = {} }: I<'getOppOptions'>): Promise<Res<'getOppOptions'>> {
    const entry = query.entryId ? this.ctx.store.must('activity', query.entryId, 'Activity entry') : null;
    const tz = this.ctx.store.settings().profile.timezone;
    return oppOptionsView(this.ctx.store, entry, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.ctx.now()));
  }

  /**
   * "Search Org62" in mock mode: nothing is looked up. The placeholder records (src/mock/org62-opps.ts) the words
   * match, plus the app's own opps the words match (as hits already in the app, under placeholder Org62 ids).
   */
  async searchOrg62Opps({ body }: I<'searchOrg62Opps'>): Promise<Res<'searchOrg62Opps'>> {
    const accounts = this.ctx.store.all('accounts');
    const opps = this.ctx.store.all('opps');
    const acctByName = new Map(accounts.map((a) => [a.name.toLowerCase(), a]));
    const words = body.q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
    const inApp = opps
      .filter((o) => o.isOpen && words.length && words.every((w) => `${o.name} ${this.ctx.store.get('accounts', o.accountId)?.name ?? ''}`.toLowerCase().includes(w)))
      .map((o) => ({
        kind: 'opp' as const,
        org62Id: mockOrg62IdFor(o.id),
        name: o.name,
        accountName: this.ctx.store.get('accounts', o.accountId)?.name ?? null,
        accountOrg62Id: null,
        stage: o.stage || null,
        closeDate: o.closeDate,
        amount: o.amount,
        owner: o.owner?.name ?? null,
        isOpen: o.isOpen,
        oppId: o.id,
        accountId: o.accountId || null,
      }));
    const placeholders = searchMockOrg62Opps(body.q).map((r) => {
      const url = org62RecordUrl('Opportunity', r.Id);
      const imported = opps.find((o) => o.id === mockOppIdFor(r.Id) || (!!url && o.org62Url === url));
      const acct = accounts.find((a) => a.id === mockAccountIdFor(r.AccountId)) ?? acctByName.get(r.Account.Name.toLowerCase());
      return { kind: 'opp' as const, org62Id: r.Id, name: r.Name, accountName: r.Account.Name, accountOrg62Id: r.AccountId, stage: r.StageName, closeDate: r.CloseDate, amount: r.Amount, owner: r.Owner.Name, isOpen: !r.IsClosed, oppId: imported?.id ?? null, accountId: imported?.accountId ?? acct?.id ?? null };
    });
    // D-103 (c): accounts too (the db's one more SELECT on Account): the app's accounts every word names
    const acctHits = accounts
      .filter((a) => words.length && words.every((w) => a.name.toLowerCase().includes(w)))
      .slice(0, 5)
      .map((a) => ({ kind: 'account' as const, org62Id: org62AccountIdOfUrl(a.org62Url) ?? mockOrg62AccountIdFor(a.id), name: a.name, accountName: a.name, accountOrg62Id: org62AccountIdOfUrl(a.org62Url) ?? mockOrg62AccountIdFor(a.id), stage: null, closeDate: null, amount: null, owner: null, isOpen: true, oppId: null, accountId: a.id }));
    const hits = [...[...placeholders, ...inApp.filter((h) => !placeholders.some((p) => p.oppId === h.oppId))].slice(0, 10), ...acctHits];
    return { q: body.q, hits, notes: ['Mock mode: placeholder Org62 records; nothing was looked up.', ...(hits.length ? [] : ['Nothing in Org62 matches.'])], simulated: true, costUsd: 0 };
  }

  async pickOrg62Opp({ params, body }: I<'pickOrg62Opp'>): Promise<Res<'pickOrg62Opp'>> {
    const cur = this.ctx.store.must('activity', params.id, 'Activity entry');
    this.ctx.checkVersion(cur, body.ifVersion, 'Activity entry', cur);
    if (cur.status === 'logged' || cur.status === 'verified') throw invalid('This row is logged in Org62: its opportunity is fixed');
    const key = body.org62Id.slice(0, 15);
    const opps = this.ctx.store.all('opps');
    const shown = opps.find((o) => mockOrg62IdFor(o.id).slice(0, 15) === key || o.id === mockOppIdFor(body.org62Id) || (o.org62Url ?? '').includes(`/${body.org62Id}/`));
    const rec = shown ? null : MOCK_ORG62_OPPS.find((r) => r.Id.slice(0, 15) === key);
    if (!shown && !rec) throw notFound('Org62 opportunity', body.org62Id);
    const at = this.ctx.nowIso();
    const { entry, result } = this.ctx.tx({ actor: 'user', action: 'activity.org62_opp', summary: `Set the opportunity: ${shown?.name ?? rec!.Name}${rec ? ' (added from Org62)' : ''}`, entity: { type: 'activity_entry', id: cur.id, label: cur.description } }, (tx) => {
      const opp = shown ?? this.ctx.ds.deals.putMockOrg62Opp(tx, rec!, at);
      const next = activityStamps(
        this.ctx.bump({
          ...cur,
          oppId: opp!.id,
          oppName: opp!.name,
          accountName: this.ctx.store.get('accounts', opp!.accountId)?.name ?? cur.accountName,
          userLockedFields: [...new Set([...cur.userLockedFields, 'oppId' as const])],
          issues: cur.issues.filter((i) => !/opp/i.test(i)),
        }),
      );
      this.ctx.ds.attribution.learnFromRow(tx, cur, next);
      return tx.put('activity', next);
    });
    return { entity: result, auditId: entry?.id ?? null };
  }

  /**
   * Onsite days in mock mode (onsite lane): there is no detection here (the seed has no trips), so a correction is
   * the chip; kept in memory, not audited.
   */
  readonly onsite = new Map<string, OnsiteDay>();

  private onsiteChip(day: string, accountId: string | null, status: OnsiteDay['status']): OnsiteDay {
    const tz = this.ctx.store.settings().profile.timezone;
    const acct = accountId ? this.ctx.store.get('accounts', accountId) : undefined;
    return { day, status, accountId, accountName: acct?.name ?? null, whatOrg62Id: null, whatName: null, city: null, timezone: tz, frame: null, hoursLabel: '', signals: [{ kind: 'correction', label: status === 'not_onsite' ? 'You marked this day: not onsite' : 'You confirmed this day', used: true }], trip: null, locked: true };
  }

  async correctOnsiteDay({ params, body }: I<'correctOnsiteDay'>): Promise<Res<'correctOnsiteDay'>> {
    const cur = this.onsite.get(params.day) ?? null;
    if (body.action === 'clear') {
      this.onsite.delete(params.day);
      return { entity: null, auditId: null };
    }
    if (body.action === 'change_account' && body.accountId) this.ctx.store.must('accounts', body.accountId, 'Account');
    if (body.action === 'adjust_hours' && (!body.start || !body.end || body.end <= body.start)) throw invalid('adjust_hours needs start < end (HH:MM)');
    const next = this.onsiteChip(params.day, body.action === 'change_account' ? (body.accountId ?? null) : (cur?.accountId ?? null), body.action === 'not_onsite' ? 'not_onsite' : 'confirmed');
    if (body.action === 'adjust_hours') next.hoursLabel = `${body.start}–${body.end} · your hours`;
    this.onsite.set(params.day, next);
    return { entity: next, auditId: null };
  }

  async markTrip({ body }: I<'markTrip'>): Promise<Res<'markTrip'>> {
    if (body.to < body.from) throw invalid('The trip ends before it starts');
    this.ctx.store.must('accounts', body.accountId, 'Account');
    const out: OnsiteDay[] = [];
    for (let d = body.from; d <= body.to && out.length < 31; d = format(addDays(parseISO(d), 1), 'yyyy-MM-dd')) {
      const chip = { ...this.onsiteChip(d, body.accountId, 'confirmed'), city: body.city ?? null, trip: { from: body.from, to: body.to } };
      this.onsite.set(d, chip);
      out.push(chip);
    }
    return { entity: out, auditId: null };
  }

  // D-64: "Dismiss all from <source>" (src/server/time/dismiss.ts plans it; the db's twin)
  async listTimeDismissRules(_i: I<'listTimeDismissRules'>): Promise<Res<'listTimeDismissRules'>> {
    return { rules: rulesView(this.ctx.store.all('timeDismissRules'), this.ctx.store.all('activity')) };
  }

  async dismissFromSource({ body }: I<'dismissFromSource'>): Promise<Res<'dismissFromSource'>> {
    this.ctx.store.must('activity', body.entryId, 'Activity entry');
    const entries = markCanvasHolds(this.ctx.store.all('activity'), canvasHolds(this.ctx.store.all('drafts')));
    const { rule, changes } = planDismissFromSource(entries, body.entryId, this.ctx.nowIso());
    const { entry } = this.ctx.tx({ actor: 'user', action: 'time.dismiss_rule', summary: `Dismissed all from ${rule.label}: ${changes.length} ${changes.length === 1 ? 'row' : 'rows'}`, entity: { type: 'activity_entry', id: body.entryId, label: rule.label } }, (tx) => {
      tx.put('timeDismissRules', rule);
      for (const c of changes) {
        const { canvasDraftId: _held, ...row } = c;
        tx.put('activity', this.ctx.bump(row));
      }
    });
    return { entity: { rule: rulesView([rule], this.ctx.store.all('activity'))[0]!, dismissedIds: changes.map((c) => c.id) }, auditId: entry?.id ?? null };
  }

  async removeTimeDismissRule({ body }: I<'removeTimeDismissRule'>): Promise<Res<'removeTimeDismissRule'>> {
    const rule = this.ctx.store.get('timeDismissRules', body.key);
    if (!rule) return { entity: { rules: rulesView(this.ctx.store.all('timeDismissRules'), this.ctx.store.all('activity')) }, auditId: null };
    const back = planRemoveRule(this.ctx.store.all('activity'), body.key, this.ctx.nowIso(), loggingProfile(personaOf(this.ctx.store.settings())).taskTypeRequired);
    const { entry } = this.ctx.tx({ actor: 'user', action: 'time.dismiss_rule.remove', summary: `Removed the rule: all from ${rule.label} (${back.length} ${back.length === 1 ? 'row' : 'rows'} back)`, entity: { type: 'activity_entry', id: back[0]?.id ?? body.key, label: rule.label } }, (tx) => {
      tx.remove('timeDismissRules', body.key);
      for (const r of back) tx.put('activity', this.ctx.bump(r));
    });
    return { entity: { rules: rulesView(this.ctx.store.all('timeDismissRules'), this.ctx.store.all('activity')) }, auditId: entry?.id ?? null };
  }

  async syncCanvas({ body }: I<'syncCanvas'>): Promise<Res<'syncCanvas'>> {
    const week = this.buildTime();
    if (week.canvas.confirmRequired && !body.confirm) throw invalid('First canvas sync today needs confirm: true', { confirmRequired: true });
    const dryRun = this.ctx.store.settings().sending.dryRun;
    const tz = this.ctx.store.settings().profile.timezone;
    const rows = week.entries.filter((e) => e.status === 'approved' || e.status === 'synced_to_canvas');
    const payload = [
      `# ${week.canvas.label} · week of ${week.weekStart}`,
      '',
      ...rows.map((e) => `- [ ] ${e.date} ${fmtHM(e.start, tz)}–${fmtHM(e.end, tz)} · ${e.durationH}h · ${e.taskType ?? '?'} · ${e.oppName ?? 'no opp'} · ${e.meetingType ?? ''} · ${e.description}`),
    ].join('\n');
    const now = this.ctx.nowIso();
    const { entry } = this.ctx.tx({ actor: 'user', action: dryRun ? 'activity.sync_canvas.dry_run' : 'activity.sync_canvas', summary: `${dryRun ? 'Dry run: ' : ''}Synced ${rows.length} rows to canvas`, entity: { type: 'activity_entry', id: 'canvas', label: week.canvas.label }, undoable: !dryRun }, (tx) => {
      if (!dryRun) for (const e of rows) if (e.status === 'approved') tx.put('activity', this.ctx.bump({ ...e, status: 'synced_to_canvas' }));
      tx.put('meta', { ...this.ctx.store.meta(), canvas: { ...this.ctx.store.meta().canvas, lastSyncedAt: now, rowsChangedSince: 0 } });
    });
    return { dryRun, syncedAt: now, rowsSynced: rows.length, payload, entries: this.buildTime().entries, auditId: entry?.id ?? id('aud_noop') };
  }
}
