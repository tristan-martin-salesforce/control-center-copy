/**
 * Helpers the db DataSource's facade, context and domains share (R7).
 */
import type { DbHandle } from '@/db/client';
import { AlreadyUndoneError, ConflictError, ConstraintViolationError, DbError, InvalidStateError, NotFoundError, NotUndoableError, UndoConflictError, ValidationError } from '@/db/errors';
import { AppError, conflict, invalid, notFound } from '@/server/errors';
import type { Clock } from '@/server/ports';
import type { DbChatBackend } from './chat';
import type { runOneReadLookup } from '@/server/onboarding/identity';
import { everything } from './reads/scope';
import type { DbOnboardingOptions } from './onboarding';
import type { DbRanker } from './rank';
import { type RouteInput, type RouteKey, type RouteOutput, type Brief, type WorkItemRecord, withPromotedAs, type WorkItemLockableField, type Resolution, type ResolutionDetail } from '@/contract';
import type { ReadModel } from './model';
import { uuidFor } from './ids';

/** Editor session for autosave bursts: one per API process (single user, one browser). */
export const EDITOR_SESSION = 'api';

/**
 * p4-page-scoped-reads: the read of a route outside the page table (docs/reviews/2026-11-20-holistic/15-page-reads.md):
 * writes' pre- and re-reads, the Assistant's tools, settings and the engines' hosts. Every collection, by name.
 */
export const WHOLE = everything('not page-scoped: writes and their re-reads, settings, engine hosts');

export interface DbDataSourceOptions {
  url?: string;
  handle?: DbHandle;
  /** Process-wide pool, clock and bus (several instances in one server: one per Next route bundle). */
  shared?: boolean;
  /** Defaults to CC_USER_ID, else the one seeded user in the database. */
  userId?: string;
  clock?: Clock;
  /** Defaults to ENGINES-core (`enginesRanker`); the parity suite injects the mock's scorer (`interimRanker`). */
  ranker?: DbRanker;
  /** Chat backend (BE-6). Defaults to "not wired": the turn ends in upstream_unavailable. */
  chatBackend?: DbChatBackend;
  /** Onboarding (B-079): draft store, sources probe, first-scan starter. Tests inject fakes. */
  onboarding?: DbOnboardingOptions;
  /**
   * The one read-only Org62 call of the Time picker's search and pick (default: runOneReadLookup, live behind the
   * Assistant's gate CC_CHAT_LLM=1 + connectors on). Tests inject a fake, which also turns the picker's reads on.
   */
  org62Read?: typeof runOneReadLookup;
}

/** CC_DB_NOW: real (default) | seed (the seeded asOf, running) | ISO instant | HH:MM today. */
export class DbClock implements Clock {
  private anchor: number | null = null;
  private started = Date.now();
  constructor(private readonly mode: string = process.env.CC_DB_NOW ?? 'real') {}
  bindSeedAnchor(asOf: string) {
    if (this.anchor !== null) return;
    const m = this.mode.trim();
    if (m === 'seed') this.anchor = Date.parse(asOf);
    else if (/^\d{1,2}:\d{2}$/.test(m)) {
      const [h, mm] = m.split(':').map(Number);
      const d = new Date();
      d.setHours(h!, mm!, 0, 0);
      this.anchor = d.getTime();
    } else if (m !== 'real' && !Number.isNaN(Date.parse(m))) this.anchor = Date.parse(m);
    this.started = Date.now();
  }
  now(): Date {
    return this.anchor === null ? new Date() : new Date(this.anchor + (Date.now() - this.started));
  }
}

export function toAppError(e: unknown, current?: unknown): AppError | unknown {
  if (e instanceof AppError) return e;
  if (e instanceof ConflictError) return conflict(e.table.replace(/_/g, ' '), current ?? null);
  if (e instanceof UndoConflictError) return new AppError('conflict', `Changed since: ${e.table} ${e.reason.replace('_', ' ')}; review before undoing`, { current: current ?? null, reason: e.reason });
  if (e instanceof NotFoundError) return notFound(e.table, e.id);
  if (e instanceof NotUndoableError) return invalid('This change cannot be undone');
  if (e instanceof AlreadyUndoneError) return invalid('Already undone');
  if (e instanceof InvalidStateError || e instanceof ValidationError) return invalid(e.message);
  if (e instanceof ConstraintViolationError) return invalid(`Rejected by the database: ${e.message}`, { constraint: e.constraint });
  if (e instanceof DbError) return new AppError('internal', `${e.code}: database error`, undefined, true);
  return e;
}

export type I<K extends RouteKey> = RouteInput<K>;

export type Res<K extends RouteKey> = RouteOutput<K>;

/** A promoted highlight's one state (in Triage, or a task), from its item. Read-time only, like the mock twin. */
export const promotedAs = <B extends Pick<Brief, 'highlights'>>(m: ReadModel, b: B): B => withPromotedAs(b, (wid) => m.get('workItems', wid)?.state);

export function blankItem(now: string, me: { id: string; name: string }): WorkItemRecord {
  return {
    id: '',
    version: 1,
    kind: 'task',
    state: 'open',
    title: '',
    purpose: null,
    initiativeId: null,
    accountId: null,
    oppId: null,
    servesEventId: null,
    confidence: 'likely',
    why: '',
    whyDetail: null,
    sources: [],
    effort: { youMin: 15, agentMin: 0 },
    startBy: null,
    due: null,
    createdAt: now,
    updatedAt: now,
    ageDays: 0,
    isBackground: false,
    rank: null,
    rankReasons: [],
    score: null,
    priority: 'medium',
    signals: { customerFacing: false, fromManager: false, boost: 0 },
    stale: null,
    userLockedFields: [],
    newEvidenceCount: 0,
    reevaluating: false,
    seenAt: null,
    nbaId: null,
    owner: { id: me.id, name: me.name },
    people: [],
    waiting: null,
    snoozedUntil: null,
    snoozedFrom: null,
    doneAt: null,
    doneBy: null,
    closedReason: null,
    resolution: null,
    resolutionDetail: null,
    involvement: 'owner',
    loopedBackIn: null,
    likelyDone: null,
    reopened: null,
    dismissed: null,
    notes: '',
    enrichment: null,
    deliverable: null,
    training: null,
    runIds: [],
    assetIds: [],
    counterparty: null,
  };
}

export const ITEM_PATCH_LOCK: Record<string, WorkItemLockableField> = {
  title: 'title',
  purpose: 'purpose',
  due: 'due',
  startBy: 'startBy',
  effort: 'effort',
  notes: 'notes',
  initiativeId: 'initiativeId',
  accountId: 'accountId',
  oppId: 'oppId',
  kind: 'kind',
};

export const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** The closed record for done / resolve / confirm-done (user) and chat's resolveItem (same as the mock). */
export function resolvedRecord(
  model: ReadModel,
  cur: WorkItemRecord,
  o: { reason: string; resolution: Resolution; detail: Partial<Omit<ResolutionDetail, 'inferred'>>; involvement?: 'watcher' | 'not_involved' | 'contributor'; doneBy: 'user' | 'chat'; at: string },
): WorkItemRecord {
  const { detail, resolution } = o;
  const person = detail.personId ? model.get('people', detail.personId) : detail.personName ? model.all('people').find((p) => p.name === detail.personName) : undefined;
  const personName = detail.personName ?? person?.name;
  if (resolution === 'handed_off' && !personName) throw invalid('handed_off needs detail.personId or detail.personName (who took it over)');
  if ((resolution === 'duplicate' || resolution === 'superseded') && detail.relatedItemId && !model.get('workItems', detail.relatedItemId)) throw notFound('Related work item', detail.relatedItemId);
  return {
    ...cur,
    state: 'done',
    doneAt: o.at,
    doneBy: o.doneBy,
    closedReason: o.reason,
    likelyDone: null,
    waiting: null,
    snoozedUntil: null,
    resolution,
    resolutionDetail: { inferred: false, ...detail, ...(personName ? { personName } : {}), ...(person ? { personId: person.id } : {}) },
    involvement: resolution === 'handed_off' ? (o.involvement ?? 'watcher') : cur.involvement,
    owner: resolution === 'handed_off' && personName ? { id: person?.id ?? uuidFor(`person:${personName}`), name: personName } : cur.owner,
    loopedBackIn: null,
  };
}

export function resolutionLabel(r: Resolution, personName?: string): string {
  switch (r) {
    case 'done_by_me':
      return 'Done by you';
    case 'handed_off':
      return personName ? `Handed off → ${personName}` : 'Handed off';
    case 'done_by_other':
      return personName ? `Done by ${personName}` : 'Done by someone else';
    case 'not_needed':
      return 'Not needed';
    case 'duplicate':
      return 'Duplicate';
    case 'declined':
      return 'Declined';
    case 'superseded':
      return 'Superseded';
  }
}
