// ScannerRuntime state and planning. Split from scanner-runtime.ts (max-lines); the class is still exported from scanner-runtime.ts.
import { classifyError } from '../../llm/errors';
import type { ResolvedPersona } from '../../personas/types';
import { loadSkill } from '../../llm/skill-loader';
import {
  type ConnectorId, type ScannerStore, type ScanTrigger, type ScopeKey, type SkillRunner, type TimeWindow, scopeId,
} from '../types';
import { DEFAULT_CADENCE, intervalMs, localParts, type CadenceConfig } from './cadence';
import { systemClock, type Clock } from './clock';
import { isTraversal, type ConnectorSpec } from './connectors';
import {
  InMemoryJobQueue, KeyedMutex, PRIORITY, scanJob, type JobQueue, type ReconcileJob, type RuntimeJob, type ScanJob,
} from './jobs';
import { planResume } from './resume-planner';
import { FileFirstScanLedger, FirstScan, firstScanFromEnv } from './first-scan';
import { Reconciler } from '../reconcile/reconciler';
import { fmtUsd, SCAN_DAY_BUDGET_PREFIX, type Hold } from '../../llm/spend';
import {
  type ScannerRuntimeDeps, type ScopeState, type RuntimeLogEvent, MIN, usesTraversalLlm, allowedForToday,
  FIRST_SCAN_REPLANS,
} from './scanner-runtime.shared';

/** ScannerRuntime state and planning: scopes, persona, budget asks, first scan. ScannerRuntimeOutcome and ScannerRuntimeJobs build on it; ScannerRuntime (scanner-runtime.ts) adds the loop. */
export abstract class ScannerRuntimePlan {
  readonly store: ScannerStore;
  readonly runner: SkillRunner;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly reconciler: Reconciler;
  protected readonly deps: ScannerRuntimeDeps;
  protected readonly cadence: CadenceConfig;
  protected readonly specs = new Map<ConnectorId, ConnectorSpec>();
  protected readonly scopes = new Map<string, ScopeState>();
  protected readonly connectorLock = new KeyedMutex();
  protected llmSlots: number;
  protected readonly llmWaiters: Array<() => void> = [];
  protected initialized = false;
  protected lastScopeRefresh = 0;
  /** D-55: the persona's planning signature at the last scope refresh (a change re-plans scopes at once). */
  protected personaSig?: string;
  /** D-55: the sources the persona has active (null: no persona known, every source is planned). */
  protected activeConnectors: Set<ConnectorId> | null = null;
  protected lastNightly?: string;
  /** First-scan status at the previous plan (FS-RELINK: relink once when it turns done). */
  protected lastFirstScanStatus?: string;
  /** 'retry': a planned split or fewer-items retry failed its first attempt (MIN-26): not degraded, but the next success writes ok (resets the failure count). */
  protected readonly healthState = new Map<ConnectorId, 'ok' | 'bad' | 'retry'>();
  protected loop?: { stop: () => void; done: Promise<void> };
  readonly firstScan?: FirstScan;

  constructor(deps: ScannerRuntimeDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.runner = deps.runner;
    this.clock = deps.clock ?? systemClock;
    this.queue = deps.queue ?? new InMemoryJobQueue();
    this.cadence = { ...DEFAULT_CADENCE, ...deps.cadence, baseMs: { ...DEFAULT_CADENCE.baseMs, ...deps.cadence?.baseMs } };
    for (const s of deps.specs) this.specs.set(s.connector, s);
    this.llmSlots = deps.maxConcurrentLlm ?? 3;
    if (deps.firstScan !== null) {
      const cfg = deps.firstScan ? undefined : firstScanFromEnv(process.env, process.argv, deps.firstScanDefaultDays);
      this.firstScan = deps.firstScan ?? (cfg ? new FirstScan(cfg, new FileFirstScanLedger()) : undefined);
    }
    this.reconciler = new Reconciler({
      store: deps.store,
      runner: deps.runner,
      clock: this.clock,
      specs: deps.specs,
      reevaluate: deps.reevaluate,
      onFinding: deps.onFinding,
      repoRoot: deps.repoRoot,
      withLlmSlot: (fn) => this.withLlmSlot(fn),
      // D-55: sources the persona doesn't scan get no coverage-gap, relink or stale passes.
      connectorActive: (connector) => this.connectorActive(connector),
      relinkMs: deps.skillUpgradeRelinkMs,
      // F-4: relink runs hold their estimate on the governor and ask past it
      spend: deps.spend ?? null,
      // Reconcile's LLM steps (relink, Sonnet escalation, skill-upgrade dry runs) respect the daily hard cap too.
      llmAllowed: async (connector) => {
        const b = await this.store.recordSpend({ connector, model: 'none', costUsd: 0 });
        return b.todayUsd < b.hardCapUsd;
      },
      // RCN-1: no stale re-reads while the connector's first scan still has scopes pending.
      firstScanActive: (connector) => {
        const fs = this.firstScan?.state();
        return !!fs && fs.status === 'active' && Object.entries(fs.scopes).some(([sid, v]) => v === 'pending' && sid.startsWith(`${connector}:`));
      },
    });
  }

  protected log(e: RuntimeLogEvent) {
    this.deps.log?.(e);
  }

  spec(connector: ConnectorId): ConnectorSpec | undefined {
    return this.specs.get(connector);
  }

  // ===================================================================== planning

  /** Jobs to enqueue now. The first call is the resume plan (SCANNER.md §5). Safe to call every tick. */
  async planJobs(now: Date = this.clock.now()): Promise<RuntimeJob[]> {
    const jobs: RuntimeJob[] = [];
    const t = now.getTime();
    const first = !this.initialized;
    let upgrades: NonNullable<ReconcileJob['upgrades']> = [];
    // D-55: the persona is reloaded on every plan pass, so a switch (or a source / feature activated) re-plans scopes
    // now, without a restart or waiting for the 10-minute refresh.
    const personaChanged = await this.reloadPersona();
    if (first || personaChanged || t - this.lastScopeRefresh >= (this.deps.scopeRefreshMs ?? 10 * MIN)) {
      upgrades = await this.refreshScopes(now);
    }
    let anyCatchUp = false;
    const budgets = new Map<ConnectorId, { todayUsd: number; hardCapUsd: number; softCapUsd: number }>();
    let dayAsk: Promise<'waiting' | 'allowed'> | undefined;
    let staleAsks: Promise<void> | undefined;
    for (const st of this.scopes.values()) {
      const spec = this.specs.get(st.key.connector);
      if (!spec) continue;
      this.expireStale(st, t);
      if (st.pending.size) continue;
      // Paused until re-auth (Health "Re-auth" → connector.reauth job, or a manual Rescan; WORKER.md).
      if (st.paused === 'auth') continue;
      // D-55: a scope (or source) the persona does not scan: no runs, no coverage gaps; the cursor waits.
      if (st.paused === 'persona') continue;
      // W0-7: a window too large to read even in smaller pages waits for a manual Rescan (Health says so).
      if (st.paused === 'prompt_cap') continue;
      // 11 R5: stopped on a failure retrying cannot fix (Health says why and offers Report this; Rescan resumes it)
      if (st.paused === 'stopped') continue;
      if (usesTraversalLlm(spec)) {
        let b = budgets.get(spec.connector);
        if (!b) {
          b = await this.store.recordSpend({ connector: spec.connector, model: 'none', costUsd: 0 });
          budgets.set(spec.connector, b);
        }
        // First-scan backfill spend (B-080) has its own one-time budget: it never pauses regular scans. BUD-1: the stores'
        // daily figure no longer holds it, so nothing is subtracted here.
        if (b.todayUsd >= b.hardCapUsd && !this.firstScan?.eligible(spec.connector, scopeId(st.key))) {
          // W12-1: with the governor, the cap raises a hand (one ask for all scans: Allow for today) instead of
          // waiting silently for tomorrow; an allowed ask resumes the scope on this tick.
          dayAsk ??= this.deps.spend ? this.dayBudgetAsk(spec.connector, b, now) : Promise.resolve('waiting' as const);
          const ask = await dayAsk;
          if (ask !== 'allowed') {
            if (st.paused !== 'budget') {
              st.paused = 'budget';
              this.log({ event: 'paused', connector: spec.connector, scope: st.key.scope, code: 'budget_hard_cap', costUsd: b.todayUsd });
              const then = this.deps.spend ? 'traversal waits for your answer in Health (Allow for today), else resumes tomorrow' : 'traversal resumes tomorrow';
              await this.store.recordHealth(spec.connector, { state: 'degraded', detail: `paused: daily LLM hard cap $${b.hardCapUsd} reached; ${then}`, checkedAt: now.toISOString() });
            }
            continue;
          }
        }
        if (st.paused === 'budget') {
          st.paused = undefined;
          st.nextDueAt = t;
          this.log({ event: 'resumed', connector: spec.connector, scope: st.key.scope, code: 'budget' });
          if (this.deps.spend) staleAsks ??= this.closeDayBudgetAsks();
        }
      }
      if (t < st.nextDueAt) continue;
      const planned = await this.planScope(st, spec, now, first ? 'catch_up' : 'schedule');
      if (planned.some((j) => j.mode === 'head' || j.mode === 'backfill')) anyCatchUp = true;
      jobs.push(...planned);
    }
    if (first) {
      if (upgrades.length) {
        const j = this.reconcileJob(['skill_upgrade'], 'reconcile', now, 'skill_upgrade');
        j.upgrades = upgrades;
        jobs.push(j);
      }
      if (anyCatchUp) jobs.push(this.reconcileJob(['unlinked', 'stale_active'], 'reconcile', now, 'resume'));
      this.log({ event: 'plan', detail: `startup: ${jobs.length} jobs, ${this.scopes.size} scopes` });
    }
    // FS-RELINK: the first scan just finished. Relink what it parked as unlinked now, not at 02:00, so the first list
    // is whole the same day (Settle judges what the relink proposes on its next pass). Only on the transition this
    // process saw: a restart after the first scan doesn't repeat it.
    const fsStatus = this.firstScan?.state()?.status;
    if (!first && this.lastFirstScanStatus === 'active' && fsStatus === 'done') {
      jobs.push(this.reconcileJob(['unlinked'], 'reconcile', now, 'first_scan_done'));
      this.log({ event: 'plan', detail: 'first scan done: relinking its unlinked items now (FS-RELINK)' });
    }
    this.lastFirstScanStatus = fsStatus;
    await staleAsks;
    // Nightly reconcile (SCANNER.md §6).
    const lp = localParts(now, this.cadence.workHours.timeZone);
    const hour = this.deps.nightlyReconcileHour ?? 2;
    if (first) this.lastNightly = lp.hour >= hour ? lp.date : undefined;
    else if (lp.hour >= hour && this.lastNightly !== lp.date) {
      this.lastNightly = lp.date;
      jobs.push(this.reconcileJob(['coverage_gaps', 'unlinked', 'stale_active'], 'reconcile', now, `nightly:${lp.date}`));
    }
    return jobs;
  }

  /**
   * W12-1: scans at the daily hard cap ask once (`SCAN_DAY_BUDGET_PREFIX`: one asked hold and one SPEND.DAY_BUDGET
   * event, through the governor) and wait for the answer. Asked or Stopped: they wait (Stop: until tomorrow). Allow for
   * today: the governor moved today's cap up by the hold (`raiseToday`); the ask settles (releasing what it held) and
   * scans run past the cap for the rest of the day without asking again (each run still asks past its own estimate).
   * Allow $Z more: today's cap moves up by Z, the ask settles, scans resume, and the next cap hit asks again.
   * The governor never breaks a scan: if it can't answer, the scope waits as before.
   */
  protected async dayBudgetAsk(connector: ConnectorId, b: { todayUsd: number; hardCapUsd: number }, now: Date): Promise<'waiting' | 'allowed'> {
    const gov = this.deps.spend!;
    try {
      const day = await gov.store.today();
      const prefix = `${SCAN_DAY_BUDGET_PREFIX}${day}:`;
      const [last] = await gov.store.listHolds({ jobKeyPrefix: prefix, limit: 1 });
      if (last?.state === 'asked' || last?.state === 'denied') return 'waiting';
      if (last && allowedForToday(last)) {
        if (last.state === 'approved') {
          await gov.settle(last, 0);
          this.log({ event: 'resumed', connector, code: 'budget_allowed_today', detail: last.id });
        }
        return 'allowed';
      }
      if (last?.state === 'approved') {
        if (last.answerUsd != null) await gov.store.raiseToday?.(last.answerUsd, 'Allowed more from the scans’ day-cap ask');
        await gov.settle(last, 0);
        this.log({ event: 'resumed', connector, code: 'budget_allowed_more', detail: last.id });
        return 'allowed';
      }
      const job = { scope: 'scan_run' as const, jobKey: `${prefix}${now.getTime()}`, budget: 'daily' as const };
      const { hold } = await gov.askDayBudget(job, await gov.estimate(job), (d) => `Scans that use the model are paused at today's spend cap: ${fmtUsd(d.spentUsd)} spent and ${fmtUsd(d.heldUsd)} held of ${fmtUsd(d.hardUsd)}. Allow for today, or they resume tomorrow.`, { connector, capUsd: b.hardCapUsd });
      this.log({ event: 'budget', connector, code: 'day_budget_ask', detail: hold.id, costUsd: b.todayUsd });
      return 'waiting';
    } catch (err) {
      this.log({ event: 'skip', connector, code: 'spend_hold_error', detail: String(err instanceof Error ? err.message : err).slice(0, 160) });
      return 'waiting';
    }
  }

  /** W12-1: the user answered today's scan day-cap ask with Allow for today (scans run past the cap until midnight). */
  protected async scansAllowedToday(): Promise<boolean> {
    const gov = this.deps.spend;
    if (!gov) return false;
    const day = await gov.store.today().catch(() => null);
    if (!day) return false;
    const [last] = await gov.store.listHolds({ jobKeyPrefix: `${SCAN_DAY_BUDGET_PREFIX}${day}:`, limit: 1 }).catch(() => [] as Hold[]);
    return !!last && allowedForToday(last);
  }

  /** A new budget day: an unanswered day-cap ask from an earlier day is moot (the cap reset); it is abandoned. */
  protected async closeDayBudgetAsks(): Promise<void> {
    const gov = this.deps.spend!;
    const day = await gov.store.today().catch(() => null);
    if (!day) return;
    const live = await gov.store.listHolds({ states: ['asked', 'approved'], jobKeyPrefix: SCAN_DAY_BUDGET_PREFIX }).catch(() => [] as Hold[]);
    for (const h of live) if (h.budgetDay !== day) await gov.settle(h, 0, 'abandoned').catch(() => undefined);
  }

  /** Register new scopes (watch list / channel map changes). Returns skill upgrades seen at startup. */
  protected async refreshScopes(now: Date): Promise<NonNullable<ReconcileJob['upgrades']>> {
    const first = !this.initialized;
    this.lastScopeRefresh = now.getTime();
    const upgrades: NonNullable<ReconcileJob['upgrades']> = [];
    for (const spec of this.specs.values()) {
      // D-55: a source the persona has not activated is not planned at all: its scopes pause where they are.
      if (!this.connectorActive(spec.connector)) {
        this.pauseForPersona(spec.connector, () => true, now);
        continue;
      }
      let names: string[];
      try {
        names = isTraversal(spec)
          ? spec.scopes(await this.store.getContext({ connector: spec.connector, scope: 'inbox' }, { maxOpenItems: 0 }))
          : await spec.fetcher.scopes({ userId: (await this.store.getContext({ connector: spec.connector, scope: '_' }, { maxOpenItems: 0 })).me.userId });
      } catch (err) {
        this.log({ event: 'skip', connector: spec.connector, code: 'scopes_failed', detail: classifyError(err).code });
        continue;
      }
      let versionTag: string | undefined;
      try {
        versionTag = loadSkill(spec.skillPath, this.deps.repoRoot).versionTag;
      } catch {
        versionTag = undefined;
      }
      // D-55: scopes the persona dropped (the AE's `dcs`, `missed_opps`) pause; nothing is deleted, and they resume
      // from their cursor when the persona brings them back.
      const wanted = new Set(names);
      this.pauseForPersona(spec.connector, (scope) => !wanted.has(scope), now);
      // E3: a new scope of an auth-paused connector waits with it; at startup the stored pause counts too
      let authPause: number | undefined | null = null; // null: not looked up yet
      const pausedAt = async (): Promise<number | undefined> => {
        if (authPause !== null) return authPause;
        const live = [...this.scopes.values()].find((o) => o.key.connector === spec.connector && o.paused === 'auth');
        authPause = live ? (live.authPausedAt ?? now.getTime()) : first ? await this.storedAuthPause(spec, now) : undefined;
        return authPause;
      };
      for (const name of names) {
        const key = { connector: spec.connector, scope: name };
        const sid = scopeId(key);
        const known = this.scopes.get(sid);
        if (known) {
          if (known.paused === 'persona') {
            known.paused = undefined;
            known.nextDueAt = now.getTime();
            this.log({ event: 'resumed', connector: spec.connector, scope: name, code: 'persona' });
          }
          continue;
        }
        const paused = await pausedAt();
        this.scopes.set(sid, { key, nextDueAt: now.getTime(), quietLevel: this.deps.cadenceSeed?.(sid) ?? 0, failures: 0, transientStreak: 0, pending: new Map(), ...(paused !== undefined ? { paused: 'auth' as const, authPausedAt: paused } : {}) });
        if (paused !== undefined) this.log({ event: 'paused', connector: spec.connector, scope: name, code: first ? 'auth_stored' : 'auth' });
        if (first && versionTag) {
          const ctx = await this.store.getContext(key, { maxOpenItems: 0 });
          if (ctx.skillVersion && ctx.skillVersion !== versionTag) upgrades.push({ connector: spec.connector, scope: name, fromVersion: ctx.skillVersion, toVersion: versionTag });
        }
      }
    }
    this.initialized = true;
    return upgrades;
  }

  /**
   * E3: the connector's stored "needs re-auth" (a spec that opts in): the time of its last auth failure, or undefined
   * to start unpaused (no stored pause, a store without one, a read that failed, or a sign-in refreshed since).
   */
  protected async storedAuthPause(spec: ConnectorSpec, now: Date): Promise<number | undefined> {
    if (!spec.persistAuthPause || !this.store.authPausedSince) return undefined;
    let since: string | null;
    try {
      since = await this.store.authPausedSince(spec.connector);
    } catch (err) {
      this.log({ event: 'skip', connector: spec.connector, code: 'auth_pause_read_failed', detail: classifyError(err).code });
      return undefined;
    }
    if (!since) return undefined;
    const at = Number.isFinite(Date.parse(since)) ? Date.parse(since) : now.getTime();
    if (spec.persistAuthPause.credentialsChangedSince?.(at)) {
      this.log({ event: 'resumed', connector: spec.connector, code: 'credentials_refreshed', detail: 'the stored sign-in is newer than the last refusal' });
      return undefined;
    }
    return at;
  }

  /**
   * D-55: reload the persona (Settings ▸ Role & rules). Returns true when what it plans changed: its active sources or
   * its Org62 scopes and book. A store without personas (tests, the dry-run store) plans every source.
   */
  protected async reloadPersona(): Promise<boolean> {
    let p: ResolvedPersona | null = null;
    try {
      p = (await this.store.persona?.()) ?? null;
    } catch (err) {
      this.log({ event: 'skip', code: 'persona_failed', detail: classifyError(err).code });
      return false; // keep the last known persona
    }
    const sig = p ? JSON.stringify([p.id, p.connectors, p.org62Scopes, p.org62Book]) : '';
    this.activeConnectors = p ? new Set(p.connectors) : null;
    if (sig === this.personaSig) return false;
    const changed = this.personaSig !== undefined;
    this.personaSig = sig;
    if (changed) this.log({ event: 'plan', detail: `persona changed (${p?.id ?? 'none'}): re-planning scopes` });
    return changed;
  }

  /** Whether the persona scans this source (no persona known: yes). */
  connectorActive(connector: ConnectorId): boolean {
    return !this.activeConnectors || this.activeConnectors.has(connector);
  }

  protected pauseForPersona(connector: ConnectorId, drop: (scope: string) => boolean, now: Date): void {
    for (const st of this.scopes.values()) {
      if (st.key.connector !== connector || st.paused === 'persona' || !drop(st.key.scope)) continue;
      st.paused = 'persona';
      st.catchUp = undefined; // a paused scope isn't catching up (Health, the heartbeat)
      // nor does it hold the first scan open: it has no first-scan work left for this persona
      this.firstScan?.scopeDone(scopeId(st.key), now);
      this.log({ event: 'paused', connector, scope: st.key.scope, code: 'persona' });
    }
  }

  /** Plan one scope from its cursor: incremental, or head + backfill when the gap is large. */
  protected async planScope(st: ScopeState, spec: ConnectorSpec, now: Date, trigger: ScanTrigger): Promise<ScanJob[]> {
    const t = now.getTime();
    const cursor = await this.store.getCursor(st.key);
    // FS-ORDER: while first-scan jobs are outstanding, the backfill walks oldest → newest up to where its plan ended, and
    // the cursor trails it. Live polls cover only what came after the plan (the cursor fast-forwards over them once the
    // backfill reaches them, S9). Before, the head hour set the cursor at now and the backfill ran newest first behind it.
    const tail = st.firstScanJobs?.size ? st.firstScanTo : undefined;
    if (st.firstScanJobs?.size && tail === undefined) return [];
    const fs = st.firstScanJobs?.size ? undefined : this.firstScan?.claim(spec.connector, scopeId(st.key), !!cursor, now);
    // The first scan never shortens a connector's own lookback (Org62 keeps 30 d when the setting is 7).
    if (fs) return this.planFirstScan(st, spec, now, new Date(Math.min(Date.parse(fs.floorAt), Date.parse(fs.startedAt) - spec.initialLookbackMs)).toISOString(), fs.baseFloorAt);
    const from = tail !== undefined ? new Date(Math.max(tail, cursor ? Date.parse(cursor.at) : tail)).toISOString() : cursor ? cursor.at : new Date(t - spec.initialLookbackMs).toISOString();
    if (tail !== undefined && Date.parse(from) >= t - 1000) return [];
    const window = { from, to: now.toISOString() };
    const gaps = cursor || tail !== undefined ? await this.store.coverageGaps(st.key, window) : [window];
    // A poll the live loop scheduled itself (slow off-hours / quiet cadence can exceed an hour) is incremental, not a
    // catch-up: only a gap well beyond the interval we chose means downtime. Before, every off-hours poll became
    // head + backfill and the connector reported "catching up" all night and weekend (stress finding CAD-1).
    const headMs = trigger === 'schedule' && st.lastIntervalMs ? Math.max(60 * MIN, Math.ceil(st.lastIntervalMs * 1.5)) : undefined;
    const floorMs = spec.maxBackfillMsFor?.(st.key.scope);
    const plan = planResume({ now, gaps, chunkMs: spec.chunkMsFor?.(st.key.scope) ?? spec.chunkMs, headMs, ...(floorMs ? { maxBackfillMs: floorMs } : {}) });
    const catchUp = plan.some((p) => p.mode !== 'incremental');
    const jobs = plan.map((p) =>
      scanJob({
        connector: spec.connector,
        scope: st.key.scope,
        window: p.window,
        mode: p.mode,
        trigger: catchUp ? 'catch_up' : trigger,
        runAt: new Date(t + p.order).toISOString(),
        model: spec.model,
        vars: this.varsFor(spec, st.key.scope),
      }),
    );
    for (const j of jobs) st.pending.set(j.id, t);
    if (catchUp) st.catchUp = { planned: plan.map((p) => p.window), jobs: new Map(jobs.map((j) => [j.id, j.window])), done: new Set(), at: t };
    st.lastIntervalMs = intervalMs(this.cadence, spec.connector, st.key.scope, now, st.quietLevel);
    st.nextDueAt = t + st.lastIntervalMs;
    return jobs;
  }

  /**
   * B-080 first scan: everything uncovered between the fixed floor and now, backfilled OLDEST → NEWEST with no head hour
   * (FS-ORDER), every job tagged `budget: 'first_scan'`. An ask is then recorded before the replies that settle it, and
   * triage and the completion pass see the conversation in the order it happened. On a restart the same chunks are
   * planned again (ids are deterministic, so queued ones dedupe); covered ones are skipped (the low-watermark clamp of
   * coverageGaps is undone by planning [floor, low) explicitly).
   */
  protected async planFirstScan(st: ScopeState, spec: ConnectorSpec, now: Date, floorAt: string, baseFloorAt?: string): Promise<ScanJob[]> {
    const t = now.getTime();
    const window = { from: floorAt, to: now.toISOString() };
    const span = (await this.store.coverageSpan?.(st.key)) ?? null;
    let gaps = span ? await this.store.coverageGaps(st.key, window) : [window];
    if (span && Date.parse(span.from) > Date.parse(floorAt) + 1000) gaps = [{ from: floorAt, to: span.from }, ...gaps];
    const chunkMs = spec.firstScanChunkMsFor?.(st.key.scope) ?? spec.chunkMsFor?.(st.key.scope) ?? spec.chunkMs;
    // FS-DEEP: past the shared floor (a deeper per-scope lookback), the scope may use bigger chunks.
    const base = baseFloorAt ? Date.parse(baseFloorAt) : NaN;
    const deepChunk = Date.parse(floorAt) < base ? spec.firstScanDeepChunkMsFor?.(st.key.scope) : undefined;
    // A deep chunk never straddles the shared floor, so the chunks inside it keep their boundaries. No head hour, except
    // for a scope that reads the current state (its head run is the read).
    const head = !!spec.readsCurrentState?.(st.key.scope);
    const plan = planResume({ now, gaps, chunkMs, maxBackfillMs: t - Date.parse(floorAt) + 1000, head, ...(deepChunk ? { chunkMsAt: (a: number) => (a < base ? Math.min(deepChunk, base - a) : chunkMs) } : {}) });
    const jobs = plan.map((p) =>
      scanJob({
        connector: spec.connector,
        scope: st.key.scope,
        window: p.window,
        mode: p.mode,
        trigger: 'catch_up',
        runAt: new Date(t + p.order).toISOString(),
        model: spec.model,
        vars: this.varsFor(spec, st.key.scope),
        ...(p.mode !== 'incremental' ? { budget: 'first_scan' as const } : {}),
      }),
    );
    for (const j of jobs) st.pending.set(j.id, t);
    st.firstScanJobs = new Set(jobs.filter((j) => j.budget === 'first_scan').map((j) => j.id));
    st.firstScanTo = t;
    if (!st.firstScanJobs.size) this.firstScan?.scopeDone(scopeId(st.key), now);
    if (jobs.some((j) => j.mode !== 'incremental')) st.catchUp = { planned: plan.map((p) => p.window), jobs: new Map(jobs.map((j) => [j.id, j.window])), done: new Set(), at: t };
    this.log({ event: 'plan', connector: spec.connector, scope: st.key.scope, detail: `first scan: ${jobs.length} jobs from ${floorAt} (oldest first)` });
    st.lastIntervalMs = intervalMs(this.cadence, spec.connector, st.key.scope, now, st.quietLevel);
    st.nextDueAt = t + st.lastIntervalMs;
    return jobs;
  }

  /**
   * A first-scan job will not run again: drop it, adopt its first-scan follow-ups. When none are left, the scope is done
   * only if its first-scan span has no holes. Before, a window that failed for good (a tripwire, a stuck agent) still
   * ended the scope, and a done scope never re-plans, so its hole stayed for good: only the nightly 7-day reconcile could
   * find it (FS-2). Now the holes are re-planned after a backoff, at most FIRST_SCAN_REPLANS rounds.
   */
  protected async settleFirstScan(st: ScopeState, job: ScanJob, followUps: RuntimeJob[], now: Date, final: boolean) {
    if (job.budget !== 'first_scan' || !st.firstScanJobs) return;
    for (const f of followUps) if (f.kind === 'scan' && f.budget === 'first_scan' && scopeId({ connector: f.connector, scope: f.scope }) === scopeId(st.key)) st.firstScanJobs.add(f.id);
    if (final) st.firstScanJobs.delete(job.id);
    if (st.firstScanJobs.size) return;
    const planEnd = st.firstScanTo;
    st.firstScanJobs = undefined;
    st.firstScanTo = undefined;
    const sid = scopeId(st.key);
    const fsState = this.firstScan?.state();
    // Holes count up to where the first-scan plan ended: past it is the live polls' (Org62 polls every 30 min), not a
    // hole. Before, the unpolled tail made every slow-polling scope look holed and re-plan for nothing (FS-3). The bound
    // is the plan's end, not the cursor: oldest first (FS-ORDER), the cursor stops at a hole, so it would hide every one.
    const cursor = await this.store.getCursor(st.key);
    const bound = planEnd ?? (cursor ? Date.parse(cursor.at) : now.getTime());
    const until = new Date(Math.min(bound, now.getTime() - 5 * MIN));
    const holes = fsState ? await this.firstScanHoles(st, this.firstScan!.floorFor(sid)!, until) : [];
    const rounds = this.firstScan?.replans(sid) ?? 0;
    if (holes.length && rounds < FIRST_SCAN_REPLANS && this.firstScan?.hasBudget()) {
      this.firstScan.noteReplan(sid);
      st.nextDueAt = now.getTime() + 30 * MIN * 2 ** rounds;
      this.log({ event: 'plan', connector: st.key.connector, scope: st.key.scope, detail: `first scan: ${holes.length} hole(s) left; re-plan ${rounds + 1}/${FIRST_SCAN_REPLANS} at ${new Date(st.nextDueAt).toISOString()}` });
      return;
    }
    this.firstScan?.scopeDone(sid, now);
    this.log({ event: 'plan', connector: st.key.connector, scope: st.key.scope, detail: `first scan done (status ${this.firstScan?.state()?.status ?? 'n/a'}${holes.length ? `; ${holes.length} hole(s) left to reconcile` : ''})` });
  }

  /** Uncovered windows of a scope's first-scan span [floor, until), the low-watermark clamp undone (as planFirstScan). */
  protected async firstScanHoles(st: ScopeState, floorAt: string, until: Date): Promise<TimeWindow[]> {
    if (until.getTime() <= Date.parse(floorAt)) return [];
    const window = { from: floorAt, to: until.toISOString() };
    const span = (await this.store.coverageSpan?.(st.key)) ?? null;
    if (!span) return [window];
    const gaps = await this.store.coverageGaps(st.key, window);
    const all = Date.parse(span.from) > Date.parse(floorAt) + 1000 ? [{ from: floorAt, to: span.from }, ...gaps] : gaps;
    return all.filter((g) => Date.parse(g.to) - Date.parse(g.from) > MIN);
  }

  /** Next local midnight (+1 min) in the user's zone: when the daily LLM budget resets. */
  protected nextBudgetDay(now: Date): number {
    const tz = this.cadence.workHours.timeZone;
    const today = localParts(now, tz).date;
    let t = now.getTime() + 60 * MIN;
    while (localParts(new Date(t), tz).date === today) t += 60 * MIN;
    // Step back to the first minute of the new day.
    while (localParts(new Date(t - MIN), tz).date !== today) t -= MIN;
    return t + MIN;
  }

  protected markCatchUpDone(st: ScopeState, jobId: string) {
    st.catchUp?.done.add(jobId);
  }

  protected varsFor(spec: ConnectorSpec, scope: string): Record<string, string> | undefined {
    if (!isTraversal(spec)) return undefined;
    // Context-free vars only (channel id/ts); labels are resolved at execution time from the fresh context.
    if (scope.startsWith('channel:')) return { 'channel.id': scope.slice(8) };
    if (scope.startsWith('thread:')) {
      const [, channel, ts] = scope.split(':');
      return { 'thread.channelId': channel ?? '', 'thread.ts': ts ?? '' };
    }
    return undefined;
  }

  protected expireStale(st: ScopeState, t: number) {
    const lease = this.deps.leaseMs ?? 15 * MIN;
    for (const [id, at] of st.pending) if (t - at > lease) st.pending.delete(id);
  }

  protected reconcileJob(passes: ReconcileJob['passes'], trigger: ScanTrigger, now: Date, tag: string): ReconcileJob {
    const id = `reconcile:${tag}:${passes.join('+')}`;
    return { kind: 'reconcile', id, passes, trigger, priority: PRIORITY.reconcile, runAt: now.toISOString(), dedupeKey: id };
  }

  protected scopeState(key: ScopeKey): ScopeState {
    const sid = scopeId(key);
    let st = this.scopes.get(sid);
    if (!st) {
      st = { key, nextDueAt: this.clock.now().getTime(), quietLevel: 0, failures: 0, transientStreak: 0, pending: new Map() };
      // Ad-hoc scopes (threads, targeted) are not polled; they exist only while a job runs.
      if (!key.scope.startsWith('thread:') && !key.scope.startsWith('reconcile:')) this.scopes.set(sid, st);
    }
    return st;
  }

  protected async withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.llmSlots <= 0) await new Promise<void>((r) => this.llmWaiters.push(r));
    this.llmSlots -= 1;
    try {
      return await fn();
    } finally {
      this.llmSlots += 1;
      this.llmWaiters.shift()?.();
    }
  }
}
