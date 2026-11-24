/**
 * The projections' store port: every read and write the tick needs that goes through the schema, the change-set
 * machinery or the DataSource's writers. The projection layer is pure (CONTRIBUTING "Where code goes"), so it names
 * them here by type only; `projectionStore(db)` (src/server/datasource/db/store/projections.run.ts) implements them,
 * and the caller (worker hook, DataSource domains, jobs, scripts) hands it in. Raw `sql` reads over `store.db` / `tx`
 * stay in the projection files, as in run.model.ts and work-accounts.ts.
 */
import type { ChangeSetContext } from '@/db/changeset';
import type { Db, Tx } from '@/db/client';
import type { OverlapMode, OnsiteConfig } from '@/engines/activity';
import type { LoggingProfile } from '@/engines/activity/persona';
import type { loadLearnedMappings } from '@/server/datasource/db/attribution';
import type { uuidFor } from '@/server/datasource/db/ids';
import type { WriteCtx } from '@/server/datasource/db/store/common';
import type { syncMyDcs } from '@/server/datasource/db/store/dc-requests';
import type { OnsiteWeekRecord, readOnsiteOverrides } from '@/server/datasource/db/store/onsite';
import type * as P from '@/server/datasource/db/store/projections';
import type { loadVocab } from '@/server/datasource/db/store/time';
import type { heldActivityRows, readTimeDismissRules } from '@/server/datasource/db/store/time-rules';

import type { MissedResult } from './missed';
import type { State } from './run.model';
import type { Me, Org62Book } from './types';

/** Who the pass runs for: the user, their workday and pack, the quarter's hours target and the persona's logging. */
export interface ProjectionMe {
  me: Me;
  workday: { start: string; end: string };
  packSlug: string | null;
  packRaw: Record<string, unknown>;
  quarterTargetH: number;
  logging: LoggingProfile;
}

/** A Claude session row of a week (claude_sessions), as the week pass reads it. */
export interface WeekSessionRow {
  id: string;
  title: string | null;
  cwd: string | null;
  startedAt: Date | null;
  lastActivityAt: Date | null;
  accountId: string | null;
  sourceItemId: string | null;
  sessionExternalId: string | null;
  desktopSessionId: string | null;
}

export interface ProjectionStore {
  /** The handle for the raw `sql` reads the projection files run themselves (loadSources, loadMatcher, …). */
  db: Db;

  // ---- the pass's frame
  loadMe(userId: string): Promise<ProjectionMe>;
  /** The stored watermark (`cc.projections`), or null when absent or of another PROJECTIONS_VERSION. */
  readState(userId: string): Promise<State | null>;
  /** Writes the watermark in its own change set (actor `projections@<version>`). */
  writeState(userId: string, s: State): Promise<void>;
  ensureExtractor(): Promise<string>;
  /** One change set that commits only when `fn` says it wrote something (no empty change sets, no audit rows). */
  changeSet<T>(userId: string, reason: string, fn: (tx: Tx, cs: ChangeSetContext) => Promise<{ result: T; wrote: boolean }>): Promise<T | null>;
  writeCtx(tx: Tx, cs: WriteCtx['cs'], me: Me, now: Date, extractorId: string): Promise<WriteCtx>;
  /** One READ ONLY transaction with a write context nothing writes through (rederive). */
  readOnly<T>(me: Me, now: Date, fn: (tx: Tx, w: WriteCtx) => Promise<T>): Promise<T>;
  loadVocab: typeof loadVocab;
  /** Settings ▸ Time: onsite days and the overlap mode (a row saved before the setting existed reads the preset). */
  loadTimeConfig(userId: string, presetOverlaps: OverlapMode): Promise<{ onsite: OnsiteConfig; overlaps: OverlapMode }>;
  /** Weeks an onsite correction touches whose stored record was computed without it (or before an Undo). */
  onsiteWeeksDue(userId: string): Promise<string[]>;
  uuidFor: typeof uuidFor;

  // ---- Stage A: entities
  upsertAccountFromOrg62: typeof P.upsertAccountFromOrg62;
  upsertOpportunityFromOrg62: typeof P.upsertOpportunityFromOrg62;
  upsertMyTeamMembership: typeof P.upsertMyTeamMembership;
  syncMyDcs: typeof syncMyDcs;
  upsertOrg62Event: typeof P.upsertOrg62Event;
  driftedLoggedRowStarts: typeof P.driftedLoggedRowStarts;
  hiddenOrg62RowStarts: typeof P.hiddenOrg62RowStarts;
  /** One `missed_opp_findings` row per opp, refreshed each pass unless the user locked it; returns rows written. */
  writeMissedFindings(w: WriteCtx, res: MissedResult, book: Org62Book): Promise<number>;
  markCalendarEventGone: typeof P.markCalendarEventGone;
  upsertCalendarEventFromSource: typeof P.upsertCalendarEventFromSource;
  upsertSessionFromSource: typeof P.upsertSessionFromSource;
  /** The account / opp a calendar event row is mapped to (an invite attachment's fallback match). */
  eventMapping(tx: Tx, eventRowId: string): Promise<{ accountId: string | null; opportunityId: string | null } | null>;
  upsertDriveAsset: typeof P.upsertDriveAsset;
  /** The calendar event row of an external event id, when the app has one. */
  eventRowId(tx: Tx, userId: string, externalEventId: string): Promise<string | null>;
  upsertMeetingNote: typeof P.upsertMeetingNote;
  setEventTakeaways: typeof P.setEventTakeaways;

  // ---- Stage B: the Time page, per week
  loadLearnedMappings: typeof loadLearnedMappings;
  readOnsiteOverrides: typeof readOnsiteOverrides;
  /** Claude sessions active in [from, end). */
  weekSessions(tx: Tx, userId: string, from: Date, end: Date): Promise<WeekSessionRow[]>;
  loadActivityWindow: typeof P.loadActivityWindow;
  /** My activity rows whose dedupe key names one of these meetings (`cal|<calendar>|<event>|`), wherever they sit. */
  sameMeetingRows(tx: Tx, userId: string, idents: string[]): Promise<P.ActivityRow[]>;
  loadBlockWindow: typeof P.loadBlockWindow;
  heldActivityRows: typeof heldActivityRows;
  readTimeDismissRules: typeof readTimeDismissRules;
  applyActivityWindow: typeof P.applyActivityWindow;
  applyBlockWindow: typeof P.applyBlockWindow;
  /** The week's onsite record (kv `cc.onsite.week/<week>`) when it changed; returns 1 when written. */
  writeOnsiteWeek(w: WriteCtx, weekStart: string, overrides: ReturnType<typeof readOnsiteOverrides>, days: OnsiteWeekRecord['days']): Promise<number>;
}
