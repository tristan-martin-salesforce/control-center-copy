/**
 * The mock DataSource, engine domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id } from '../shared';
import type { Actor, AgentRun, Connector, EntityRef, LiveNotify, LiveTopic, NbaCard, Proposal, Resolution, ScenarioAction, ScenarioStatus, SourceRef, WorkItemRecord, WorkState } from '@/contract';
import { invalid } from '@/server/errors';
import { docFromText, plainText, renderAll, textDiff } from '../render';
import { Tx } from '../store';
import { hrefFor, isLive, itemRef } from '../views';

/** Scenario patches say '__now__' for "the scenario clock's now". */
const nowIn = (patch: Record<string, unknown>, now: string): Record<string, unknown> => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === '__now__' ? now : v]));

export class MockEngine {
  constructor(private readonly ctx: MockCtx) {}

  private flashReevaluating(itemId: string) {
    this.ctx.tx({ actor: 'engine', action: 'item.reevaluate', summary: 'Re-evaluating', entity: { type: 'work_item', id: itemId, label: itemId }, audit: false }, (tx) =>
      tx.update('workItems', itemId, (w) => ({ ...w, reevaluating: true })),
    );
    this.ctx.later(this.ctx.delays.reevalMs, () => {
      if (!this.ctx.store.get('workItems', itemId)) return;
      this.ctx.tx({ actor: 'engine', action: 'item.reevaluated', summary: 'Re-evaluated', entity: { type: 'work_item', id: itemId, label: itemId }, audit: false }, (tx) =>
        tx.update('workItems', itemId, (w) => ({ ...w, reevaluating: false })),
      );
    });
  }

  /** Apply an engine patch to a work item; locked fields become Proposals. */
  engineUpdateItem(itemId: string, patch: Record<string, unknown>, reason: string, opts: { actor?: Actor; state?: WorkState; evidence?: SourceRef; stepId?: string } = {}) {
    const cur = this.ctx.item(itemId);
    const actor = opts.actor ?? 'engine';
    const applied: string[] = [];
    const proposalIds: string[] = [];
    const locked = new Set<string>(cur.userLockedFields);
    const { entry } = this.ctx.tx({ actor, action: 'item.engine_update', summary: `${reason}: ${cur.title}`, entity: itemRef(cur), stepId: opts.stepId }, (tx) => {
      let next: WorkItemRecord = { ...cur };
      const fields: Record<string, unknown> = { ...patch, ...(opts.state ? { state: opts.state } : {}) };
      for (const [f, v] of Object.entries(fields)) {
        if (locked.has(f)) {
          proposalIds.push(this.propose(tx, { type: 'work_item', id: cur.id, label: cur.title }, [{ field: f, before: (cur as Record<string, unknown>)[f] ?? null, after: v }], reason, cur.version, actor, opts.evidence ?? null));
        } else {
          next = { ...next, [f]: v } as WorkItemRecord;
          applied.push(f);
        }
      }
      if (opts.state === 'in_progress' && next.deliverable) {
        next = {
          ...next,
          deliverable: {
            ...next.deliverable,
            lastEditedAt: this.ctx.nowIso(),
            lastEditedBy: this.ctx.store.meta().user.name,
            changedSinceCreated: true,
            diffSummary: reason,
            judgment: next.deliverable.judgment ? { ...next.deliverable.judgment, verdict: 'in_progress' } : null,
          },
        };
      }
      if (opts.evidence) {
        this.ctx.addEvidence(tx, cur.id, opts.state === 'done' ? 'completion' : 'progress', opts.evidence, reason);
        next = { ...next, newEvidenceCount: next.newEvidenceCount + 1 };
      }
      if (applied.length || opts.evidence) tx.put('workItems', this.ctx.bump(next));
    });
    if (opts.evidence) this.flashReevaluating(itemId);
    return { applied, proposalIds, auditId: entry?.id ?? null };
  }

  propose(tx: Tx, entity: EntityRef, changes: Proposal['changes'], reason: string, baseVersion: number | null, actor: Proposal['actor'] | Actor, source: SourceRef | null, textDiffOps?: Proposal['textDiff']): string {
    for (const p of this.ctx.store.all('proposals')) {
      if (p.status === 'pending' && p.entity.type === entity.type && p.entity.id === entity.id && p.changes.some((c) => changes.some((n) => n.field === c.field))) {
        tx.put('proposals', { ...p, status: 'superseded', resolvedAt: this.ctx.nowIso() });
      }
    }
    const pActor: Proposal['actor'] = actor === 'chat' || actor === 'connector' || actor === 'scenario' ? actor : 'engine';
    const p: Proposal = {
      id: id('prop'),
      entity,
      changes,
      reason,
      source,
      createdAt: this.ctx.nowIso(),
      status: 'pending',
      actor: pActor,
      baseVersion,
      textDiff: textDiffOps ?? null,
      resolvedAt: null,
    };
    tx.put('proposals', p);
    return p.id;
  }

  /** New info revises an NBA's draft (in place if untouched, else a Proposal). */
  engineReviseDraft(nbaId: string, appendText: string, reason: string, source: SourceRef | undefined, opts: { actor?: Actor; stepId?: string } = {}) {
    const nba = this.ctx.store.must('nbas', nbaId, 'NBA');
    const draft = nba.draftId ? this.ctx.store.get('drafts', nba.draftId) : undefined;
    const actor = opts.actor ?? 'engine';
    this.ctx.tx({ actor, action: 'nba.revise', summary: `NBA updated: ${reason}`, entity: { type: 'nba', id: nba.id, label: nba.title }, stepId: opts.stepId }, (tx) => {
      let update: NbaCard['update'] = { at: this.ctx.nowIso(), reason, kind: 'revised', proposalId: null, diffSummary: `+ ${appendText}`, source: source ?? null };
      if (draft) {
        const newText = `${draft.plainText}\n\n${appendText}`;
        const newDoc = docFromText(newText);
        if (draft.userTouched) {
          const pid = this.propose(tx, { type: 'draft', id: draft.id, label: 'Draft body' }, [{ field: 'doc', label: 'Draft body', before: draft.doc, after: newDoc }], `New info: ${reason}`, draft.version, actor, source ?? null, textDiff(draft.plainText, newText));
          update = { ...update, kind: 'proposal', proposalId: pid };
        } else {
          tx.put('drafts', this.ctx.bump({ ...draft, doc: newDoc, plainText: plainText(newDoc), rendered: renderAll(draft.destination, newDoc) }));
        }
      }
      const nextVersion = update.kind === 'revised' ? nba.version + 1 : nba.version;
      tx.put('nbas', {
        ...nba,
        version: nextVersion,
        update,
        versions: update.kind === 'revised' ? [...nba.versions, { version: nextVersion, at: this.ctx.nowIso(), reason, diffSummary: update.diffSummary }] : nba.versions,
      });
      const item = this.ctx.store.get('workItems', nba.workItemId);
      if (item) {
        if (source) this.ctx.addEvidence(tx, item.id, 'context', source, reason);
        tx.put('workItems', this.ctx.bump({ ...item, newEvidenceCount: item.newEvidenceCount + 1 }));
      }
    });
    this.flashReevaluating(nba.workItemId);
  }

  engineCloseItem(itemId: string, reason: string, evidence: SourceRef, opts: { actor?: Actor; stepId?: string; resolution?: Resolution; personName?: string } = {}) {
    const cur = this.ctx.item(itemId);
    if (cur.userLockedFields.includes('state')) return this.engineUpdateItem(itemId, {}, reason, { ...opts, state: 'done', evidence });
    const { entry } = this.ctx.tx({ actor: opts.actor ?? 'engine', action: 'item.close', summary: `Closed for you: ${cur.title}`, entity: itemRef(cur), stepId: opts.stepId }, (tx) => {
      const ev = this.ctx.addEvidence(tx, cur.id, 'completion', evidence, reason);
      const resolution = opts.resolution ?? 'done_by_me';
      const person = opts.personName ? this.ctx.store.all('people').find((p) => p.name === opts.personName) : undefined;
      tx.put('workItems', this.ctx.bump({
        ...cur,
        state: 'done',
        doneAt: this.ctx.nowIso(),
        doneBy: 'engine',
        closedReason: reason,
        likelyDone: null,
        waiting: null,
        resolution,
        resolutionDetail: { inferred: true, evidenceIds: [ev.id], ...(opts.personName ? { personName: opts.personName } : {}), ...(person ? { personId: person.id } : {}) },
        involvement: resolution === 'handed_off' ? 'watcher' : cur.involvement,
      }));
    });
    return { applied: ['state'], proposalIds: [], auditId: entry?.id ?? null };
  }

  engineReopen(itemId: string, reason: string, source: SourceRef, opts: { actor?: Actor; stepId?: string } = {}) {
    const cur = this.ctx.item(itemId);
    this.ctx.tx({ actor: opts.actor ?? 'engine', action: 'item.reopen', summary: `Reopened: ${cur.title}`, entity: itemRef(cur), stepId: opts.stepId }, (tx) => {
      this.ctx.addEvidence(tx, cur.id, 'origin', source, reason);
      tx.put('workItems', this.ctx.bump({ ...cur, state: 'reopened', doneAt: null, doneBy: null, closedReason: null, resolution: null, resolutionDetail: null, reopened: { reason, at: this.ctx.nowIso(), from: source }, newEvidenceCount: cur.newEvidenceCount + 1 }));
    });
  }

  /** R-UI-22: a direct ask of me on a handed-off item reopens it and re-involves me. */
  engineLoopBack(itemId: string, byPersonName: string, reason: string, source: SourceRef, opts: { actor?: Actor; stepId?: string } = {}) {
    const cur = this.ctx.item(itemId);
    if (cur.resolution !== 'handed_off' && cur.involvement !== 'watcher' && cur.involvement !== 'not_involved') {
      throw invalid('Loop-back applies to handed-off items (resolution handed_off or involvement watcher/not_involved)');
    }
    const label = `Looped back in: ${byPersonName} asked you directly`;
    this.ctx.tx({ actor: opts.actor ?? 'engine', action: 'item.loop_back', summary: `${label}: ${cur.title}`, entity: itemRef(cur), stepId: opts.stepId, notify: { channel: 'rail', title: label, body: cur.title, tone: 'warn', href: hrefFor({ type: 'work_item', id: cur.id }) } }, (tx) => {
      const ev = this.ctx.addEvidence(tx, cur.id, 'origin', source, reason);
      tx.put('workItems', this.ctx.bump({
        ...cur,
        state: 'reopened',
        doneAt: null,
        doneBy: null,
        closedReason: null,
        resolution: null,
        resolutionDetail: null,
        involvement: 'owner',
        owner: { id: this.ctx.store.meta().user.id, name: this.ctx.store.meta().user.name },
        loopedBackIn: { at: this.ctx.nowIso(), byPersonName, evidenceId: ev.id },
        reopened: { reason: label, at: this.ctx.nowIso(), from: source },
        newEvidenceCount: cur.newEvidenceCount + 1,
      }));
    });
  }

  engineRunState(runId: string, state: AgentRun['state'], lastEvent: string, waiting: { reason: string; question?: string | null; choices?: string[] } | undefined, opts: { actor?: Actor; stepId?: string } = {}) {
    const run = this.ctx.store.must('agentRuns', runId, 'Agent run');
    const notify: LiveNotify | undefined =
      state === 'waiting_on_you'
        ? { channel: 'os', title: `${run.kind === 'claude_session' ? 'Claude session' : 'Run'} needs you`, body: waiting?.question ?? waiting?.reason ?? run.title, tone: 'warn', href: run.deepLink ?? undefined }
        : state === 'failed'
          ? { channel: 'os', title: 'Run failed', body: run.title, tone: 'risk' }
          : undefined;
    this.ctx.tx({ actor: opts.actor ?? 'engine', action: `run.${state}`, summary: `${run.title}: ${state.replace(/_/g, ' ')}`, entity: { type: 'agent_run', id: run.id, label: run.title }, stepId: opts.stepId, notify }, (tx) => {
      tx.put('agentRuns', {
        ...run,
        state,
        lastEvent,
        updatedAt: this.ctx.nowIso(),
        waiting: state === 'waiting_on_you' ? { reason: waiting?.reason ?? 'input needed', question: waiting?.question ?? null, choices: waiting?.choices ?? [], since: this.ctx.nowIso() } : null,
        finishedAt: state === 'done' || state === 'done_review' || state === 'failed' ? this.ctx.nowIso() : run.finishedAt,
      });
      const item = run.workItemId ? this.ctx.store.get('workItems', run.workItemId) : undefined;
      if (item && isLive(item)) {
        if (state === 'waiting_on_you') {
          tx.put('workItems', this.ctx.bump({ ...item, state: 'waiting_on_me', waiting: { on: 'me', reason: waiting?.question ?? waiting?.reason ?? 'Session needs input', since: this.ctx.nowIso(), runId: run.id } }));
        } else if (item.state === 'waiting_on_me') {
          tx.put('workItems', this.ctx.bump({ ...item, state: 'in_progress', waiting: null }));
        }
      }
    });
  }

  engineConnectorState(connectorId: string, state: Connector['state'], error?: string, impact?: string, opts: { actor?: Actor; stepId?: string } = {}) {
    const c = this.ctx.store.must('connectors', connectorId, 'Connector');
    const broken = ['auth_needed', 'error', 'offline'].includes(state);
    const notify: LiveNotify | undefined = broken ? { channel: 'os', title: `${c.label} ${state === 'auth_needed' ? 'needs re-auth' : 'is down'}`, body: impact ?? error, tone: 'risk', href: '/health' } : undefined;
    this.ctx.tx({ actor: opts.actor ?? 'connector', action: broken ? 'connector.fail' : 'connector.recover', summary: `${c.label}: ${state.replace('_', ' ')}`, entity: { type: 'connector', id: c.id, label: c.label }, stepId: opts.stepId, notify }, (tx) => {
      tx.put('connectors', {
        ...c,
        state,
        since: this.ctx.nowIso(),
        lastSuccessAt: state === 'ok' ? this.ctx.nowIso() : c.lastSuccessAt,
        lastError: error ? { class: state === 'auth_needed' ? 'auth' : state === 'offline' ? 'offline' : 'transient', message: error, at: this.ctx.nowIso(), count: (c.lastError?.count ?? 0) + 1 } : state === 'ok' ? null : c.lastError,
        impact: broken ? (impact ?? `${c.label} items may be stale`) : null,
        catchUpPct: state === 'catching_up' ? (c.catchUpPct ?? 0) : null,
      });
      for (const w of this.ctx.store.all('workItems')) {
        const affected = isLive(w) && w.sources.some((s) => s.kind === c.source);
        if (broken && affected) tx.put('workItems', { ...w, stale: { connectorId: c.id, reason: impact ?? `${c.label} is disconnected`, since: this.ctx.nowIso() } });
        if (!broken && w.stale?.connectorId === c.id) tx.put('workItems', { ...w, stale: null });
      }
      if (broken) {
        tx.put('eventLog', {
          id: id('evt'),
          at: this.ctx.nowIso(),
          level: 'error',
          source: c.id,
          code: state,
          message: error ?? `${c.label} ${state}`,
          count: 1,
          lastSeenAt: this.ctx.nowIso(),
          suggestedAction: c.reauth?.label ?? null,
          acknowledged: false,
          acknowledgedAt: null,
        });
      }
    });
  }

  engineRerankSignal(itemId: string, boost: number, reason: string, opts: { actor?: Actor; stepId?: string } = {}) {
    const cur = this.ctx.item(itemId);
    this.ctx.tx({ actor: opts.actor ?? 'engine', action: 'item.signal', summary: `${reason}: ${cur.title}`, entity: itemRef(cur), stepId: opts.stepId }, (tx) => {
      this.ctx.addEvidence(tx, cur.id, 'context', { kind: 'calendar', label: 'Calendar · change' }, reason);
      tx.put('workItems', this.ctx.bump({ ...cur, signals: { ...cur.signals, boost: cur.signals.boost + boost }, newEvidenceCount: cur.newEvidenceCount + 1 }));
    });
  }

  // ScenarioHost ------------------------------------------------------------

  applyScenarioAction(a: ScenarioAction, stepId: string): void {
    const o = { stepId };
    switch (a.op) {
      case 'nba_update':
        return this.engineReviseDraft(a.nbaId, a.appendText, a.reason, a.source, o);
      case 'run_state':
        return this.engineRunState(a.runId, a.state, a.lastEvent, a.waiting, o);
      case 'close_item':
        this.engineCloseItem(a.itemId, a.reason, a.evidence, { ...o, resolution: a.resolution, personName: a.personName });
        return;
      case 'loop_back':
        return this.engineLoopBack(a.itemId, a.byPersonName, a.reason, a.source, o);
      case 'engine_patch':
        this.engineUpdateItem(a.itemId, a.patch, a.reason, { ...o, state: a.state, evidence: a.evidence });
        return;
      case 'connector_state':
        return this.engineConnectorState(a.connectorId, a.state, a.error, a.impact, o);
      case 'reopen':
        return this.engineReopen(a.itemId, a.reason, a.source, o);
      case 'rerank_ready':
        return this.engineRerankSignal(a.itemId, a.boost, a.reason, o);
      case 'arrive':
        return this.scenarioArrive(a, o);
      case 'elsewhere':
        return this.scenarioElsewhere(a, o);
    }
  }

  /** Live pass: a copy of a seeded record arrives with a new id, stamped now (what a scan or an engine would add). */
  private scenarioArrive(a: Extract<ScenarioAction, { op: 'arrive' }>, o: { stepId: string }) {
    const src = this.ctx.store.get(a.collection, a.fromId) as unknown as Record<string, unknown> | undefined;
    if (!src) return;
    const now = this.ctx.nowIso();
    const stamp: Record<string, unknown> = {};
    for (const k of ['createdAt', 'updatedAt', 'startedAt', 'detectedAt', 'firstSeenAt']) if (k in src) stamp[k] = now;
    const prefix = { drafts: 'd', workItems: 'w', activity: 'act', agentRuns: 'run' }[a.collection];
    const rec = { ...src, ...stamp, ...nowIn(a.patch ?? {}, now), id: a.newId ?? id(prefix), version: 1 };
    if (this.ctx.store.get(a.collection, rec.id as string)) return; // replayed: arrived already
    this.ctx.tx({ actor: 'engine', action: 'scenario.arrive', summary: a.reason, entity: this.ctx.refFor(a.collection, rec), stepId: o.stepId, undoable: false }, (tx) => tx.put(a.collection, rec as never));
  }

  /** Live pass: a record changes elsewhere (another tab, Slack, autopilot): no toast, the views follow. */
  private scenarioElsewhere(a: Extract<ScenarioAction, { op: 'elsewhere' }>, o: { stepId: string }) {
    const cur = this.ctx.store.get(a.collection, a.id) as unknown as Record<string, unknown> | undefined;
    if (!cur) return;
    const rec = { ...cur, ...nowIn(a.patch, this.ctx.nowIso()), version: Number(cur.version ?? 0) + 1, ...('updatedAt' in cur ? { updatedAt: this.ctx.nowIso() } : {}) };
    this.ctx.tx({ actor: 'engine', action: 'scenario.elsewhere', summary: a.reason, entity: this.ctx.refFor(a.collection, rec), stepId: o.stepId, undoable: false }, (tx) => tx.put(a.collection, rec as never));
  }

  resetForScenario(offsetSec: number): void {
    for (const t of this.ctx.timers) clearTimeout(t);
    this.ctx.timers.clear();
    this.ctx.clock.reset(offsetSec);
    this.ctx.ds.resetStore();
    const all: LiveTopic[] = ['today', 'items', 'item', 'initiative', 'nba', 'draft', 'outbox', 'calendar', 'agents', 'tools', 'tool_run', 'time', 'deals', 'briefs', 'watches', 'triage', 'health', 'scans', 'jobs', 'event_log', 'settings', 'policy', 'chat', 'since', 'search', 'audit'];
    this.ctx.publish(all, [], 'scenario.reset');
  }

  scenarioChanged(status: ScenarioStatus): void {
    this.ctx.bus.publish({ topic: 'scenario', ids: status.fired, reason: `scenario.${status.state}` });
  }
}
