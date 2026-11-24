/**
 * The db DataSource's context (R7): what every domain module shares: the pool, clock and bus, the user, the read
 * model (`model(scope)`, `read`), `mutate` (one change set), the spend governor and the work-item write helpers.
 */
import type { DbDataSource } from './index';
import { and, eq, sql } from 'drizzle-orm';
import { type Actor, type WorkItem, type WorkItemLockableField, type WorkItemRecord, budgetsForDay } from '@/contract';
import { localDay as localDayOf } from '@/engines/activity/time';
import { actors, withChangeSet } from '@/db/changeset';
import { createDb, resolveDatabaseUrl, type Db, type DbHandle } from '@/db/client';
import { ConflictError } from '@/db/errors';
import { changeProposals, changeSets, users } from '@/db/schema';
import { AppError, conflict, notFound } from '@/server/errors';
import { noUserMessage } from '@/server/health-no-user';
import type { Clock } from '@/server/ports';
import { notWiredChatBackend, type DbChatBackend } from './chat';
import { dbSpendGovernor } from './spend';
import { PgEventBus } from './events';
import { loadModel, type ReadModel } from './model';
import { everything, scopesOff, type ReadScope } from './reads/scope';
import { readScoped, SharedReads } from './reads/session';
import { enginesRanker, type DbRanker } from './rank';
import type { WriteCtx } from './store/common';
import { ensurePeople } from './store/entities';
import { updateWorkItem, type WorkLinkTargets } from './store/work';
import type { WithdrawnDraft } from './store/withdraw';
import { hydrateItem } from './views';
import { EDITOR_SESSION, WHOLE, DbDataSourceOptions, DbClock, toAppError } from './shared';

interface MutMeta {
  action: string;
  summary: string;
  entity?: { type: string; id: string };
  actor?: Actor;
  /** D-60: the change set's actor is this autonomy policy (VDP autopilot), not the user, chat or an engine. */
  policyActor?: string;
  undoable?: boolean;
  /** Autosave: coalesce into one change set per (entity) while idle < 30 s (W5/W6). */
  burst?: boolean;
  /** Rebuild the server's current entity for a 409 (`details.current`). */
  current?: () => Promise<unknown>;
  /** PERF-1: the mutation reads `jobs`/`scanRuns` from its model (`loadModel({ ops: true })`). */
  ops?: boolean;
}

export class DbCtx {
  constructor(readonly ds: DbDataSource, opts: DbDataSourceOptions) {
    const g = globalThis as { __ccDbShared?: { handle: DbHandle; clock: DbClock; bus: PgEventBus } };
    if (opts.shared && !opts.handle) {
      if (!g.__ccDbShared) {
        const clock = new DbClock();
        g.__ccDbShared = { handle: createDb({ url: opts.url, applicationName: 'command-center-web' }), clock, bus: new PgEventBus(resolveDatabaseUrl(opts.url), clock) };
      }
      this.handle = g.__ccDbShared.handle;
      this.ownsHandle = false;
      this.clock = opts.clock ?? g.__ccDbShared.clock;
      this.bus = g.__ccDbShared.bus;
    } else {
      this.handle = opts.handle ?? createDb({ url: opts.url, applicationName: 'command-center-web' });
      this.ownsHandle = !opts.handle;
      this.clock = opts.clock ?? new DbClock();
      this.bus = new PgEventBus(resolveDatabaseUrl(opts.url), this.clock);
    }
    this.ranker = opts.ranker ?? enginesRanker;
    this.chatBackend = opts.chatBackend ?? notWiredChatBackend;
    if (opts.userId) this.userIdPromise = Promise.resolve(opts.userId);
    this.fixedUser = !!opts.userId;
    this.org62Read = opts.org62Read;
  }

  readonly handle: DbHandle;
  readonly clock: DbClock | Clock;
  readonly bus: PgEventBus;
  readonly ranker: DbRanker;
  readonly chatBackend: DbChatBackend;
  userIdPromise: Promise<string> | null = null;
  readonly fixedUser: boolean;
  readonly ownsHandle: boolean;
  private extractorId: string | null = null;
  readonly org62Read: DbDataSourceOptions['org62Read'];
  /** p4-page-scoped-reads: the one model a composed read (GET /needs) shares across its page reads. */
  readonly reads = new SharedReads();

  /** A page read: its scope's model, rendered (reads/session.ts readScoped: a scope miss throws in tests, retries once at runtime). */
  read<T>(scope: ReadScope, render: (m: ReadModel) => Promise<T> | T): Promise<T> {
    return readScoped(scope, (s) => this.model(s), render);
  }

  get db(): Db {
    return this.handle.db;
  }

  now(): Date {
    return this.clock.now();
  }

  userId(): Promise<string> {
    this.userIdPromise ??= (async () => {
      if (process.env.CC_USER_ID) return process.env.CC_USER_ID;
      const rows = await this.db.select({ id: users.id }).from(users).where(eq(users.isActive, true)).limit(2);
      if (!rows.length) throw new AppError('internal', noUserMessage(), undefined, false);
      if (rows.length > 1) throw new AppError('internal', 'CC_DATA=db: several users; set CC_USER_ID', undefined, false);
      return rows[0]!.id;
    })().catch((e) => {
      this.userIdPromise = null;
      throw e;
    });
    return this.userIdPromise;
  }

  async extractor(): Promise<string> {
    if (this.extractorId) return this.extractorId;
    const { ensureExtractor } = await import('./seed');
    this.extractorId = await ensureExtractor(this.db);
    return this.extractorId;
  }

  /**
   * The user's read model. PERF-1: on the pool its loaders run concurrently, and it leaves out the operational ledgers
   * (`jobs`, `scanRuns`) unless `ops` (Health's ledger, the jobs list, a manual scan's run).
   */
  async model(scope: ReadScope = everything('unscoped caller'), db: Db = this.db, lookAgain = !this.fixedUser, ops = false): Promise<ReadModel> {
    // CC_READ_SCOPES=off: the kill switch (every read loads every collection, no shared model: the 1.x reads)
    if (scopesOff()) return this.loadScoped(everything('CC_READ_SCOPES=off'), db, lookAgain, ops);
    // a composed read (GET /needs) shares one model across its page reads (reads/session.ts; never a write's)
    const shared = db === this.db && !ops ? this.reads.covering(scope, (s) => this.loadScoped(s, db, lookAgain, false)) : null;
    return shared ?? this.loadScoped(scope, db, lookAgain, ops);
  }

  private async loadScoped(scope: ReadScope, db: Db, lookAgain: boolean, ops: boolean): Promise<ReadModel> {
    const userId = await this.userId();
    try {
      const m = await loadModel(db, userId, this.now(), { scope, parallel: db === this.db, ops });
      if (this.clock instanceof DbClock) this.clock.bindSeedAnchor(m.meta().asOf);
      return m;
    } catch (e) {
      if ((e as Error).name === 'NotSeededError') {
        // B-079: the user changed under this process (onboarding after a database reset): look it up once more
        if (lookAgain) {
          this.userIdPromise = null;
          if ((await this.userId().catch(() => userId)) !== userId) return this.loadScoped(scope, db, false, ops);
        }
        throw new AppError('internal', (e as Error).message, undefined, false);
      }
      throw e;
    }
  }

  /** One mutation = one change set. `fn` gets a write context and the read model loaded inside the transaction. */
  async mutate<T>(m: MutMeta, fn: (w: WriteCtx, model: ReadModel) => Promise<T>): Promise<{ result: T; auditId: string; undoable: boolean }> {
    const userId = await this.userId();
    const extractorId = await this.extractor();
    const now = this.now();
    const actor = m.policyActor
      ? actors.autonomyPolicy(m.policyActor)
      : m.actor === 'engine' ? actors.engine(m.action) : m.actor === 'system' ? actors.system(m.action) : m.actor === 'connector' ? actors.scanner(m.action) : m.actor === 'chat' ? actors.chat(m.action) : actors.user(m.action);
    try {
      const { result, changeSetId } = await withChangeSet(
        {
          db: this.db,
          userId,
          actor,
          reason: m.summary,
          entity: m.entity,
          undoable: m.undoable,
          ...(m.burst && m.entity ? { kind: 'autosave_burst' as const, editorSessionId: EDITOR_SESSION } : {}),
        },
        async (tx, cs) => {
          const model = await loadModel(tx as unknown as Db, userId, now, { scope: everything(`write: ${m.action}`), ops: m.ops ?? false });
          const w: WriteCtx = { tx, cs, userId, me: model.ctx.me, now, extractorId, timezone: model.settings().profile.timezone, kv: model.ctx.kv };
          const r = await fn(w, model);
          // audit time follows the logical clock (== wall clock unless CC_DB_NOW pins it)
          if (cs.kind !== 'autosave_burst') await tx.update(changeSets).set({ createdAt: now }).where(eq(changeSets.id, cs.id));
          // proposals the helper created in this transaction (created_at = now() = transaction start)
          await tx.update(changeProposals).set({ createdAt: now }).where(and(eq(changeProposals.ownerUserId, userId), sql`${changeProposals.createdAt} = now()`));
          return r;
        },
      );
      // an empty change set (nothing audited: unaudited tables, or no change at all) is closed undoable = false
      const [cs] = await this.db.select({ undoable: changeSets.undoable }).from(changeSets).where(eq(changeSets.id, changeSetId));
      return { result, auditId: changeSetId, undoable: !!cs?.undoable };
    } catch (e) {
      const current = e instanceof ConflictError && m.current ? await m.current().catch(() => null) : undefined;
      throw toAppError(e, current);
    }
  }

  links(model: ReadModel): WorkLinkTargets {
    const sessions = new Set(model.all('agentRuns').filter((r) => r.kind === 'claude_session').map((r) => r.id));
    const toolByMirror = new Map(model.all('toolRuns').filter((t) => t.agentRunId).map((t) => [t.agentRunId!, t.id]));
    const assets = new Set(model.all('assets').map((a) => a.id));
    return {
      runLinks: (runIds) =>
        runIds.flatMap((r): { claudeSessionId?: string; toolRunId?: string }[] => (sessions.has(r) ? [{ claudeSessionId: r }] : toolByMirror.has(r) ? [{ toolRunId: toolByMirror.get(r)! }] : [])),
      hasAsset: (a) => assets.has(a),
    };
  }

  item(model: ReadModel, itemId: string): WorkItemRecord {
    const w = model.get('workItems', itemId);
    if (!w) throw notFound('Work item', itemId);
    return w;
  }

  checkVersion(cur: { version: number }, ifVersion: number | undefined, what: string, current: unknown) {
    if (ifVersion !== undefined && cur.version !== ifVersion) throw conflict(what, current);
  }

  async writeItem(w: WriteCtx, model: ReadModel, cur: WorkItemRecord, next: WorkItemRecord, o: { bump: boolean; ifVersion?: number; lock?: WorkItemLockableField[] }) {
    const known = new Set([...model.ctx.people.keys()]);
    await ensurePeople(w, [next.owner, next.counterparty, ...next.people], known);
    const r = await updateWorkItem(w, cur, next, this.links(model), o);
    model.put('workItems', next);
    this.putWithdrawn(model, r.withdrawn, w.now);
    return r;
  }

  /** OUTBOX-W: the drafts a close just withdrew, as the rest of this request's read model sees them. */
  putWithdrawn(model: ReadModel, withdrawn: readonly WithdrawnDraft[], now: Date) {
    for (const x of withdrawn) {
      const d = model.get('drafts', x.id);
      if (d) model.put('drafts', { ...d, status: 'discarded', rejectedReason: x.reason, version: d.version + 1, updatedAt: now.toISOString() });
    }
  }

  async hydrated(itemId: string): Promise<WorkItem> {
    const model = await this.model(WHOLE);
    return hydrateItem(model, this.item(model, itemId));
  }

  /** The governor for this user: holds in spend_holds; "Allow for today" raises today's cap like the Raise button. */
  spendGovernor(userId: string) {
    return dbSpendGovernor({
      db: this.db,
      userId,
      clock: () => this.now(),
      raiseToday: async (addUsd, reason) => {
        const s = (await this.model(WHOLE)).settings();
        const hard = budgetsForDay(s.budgets, localDayOf(this.now().getTime(), s.profile.timezone)).hardUsd;
        await this.ds.settingsDomain.raiseBudgetToday({ body: { hardUsd: Math.round((hard + addUsd) * 100) / 100, reason } } as never);
      },
    });
  }
}
