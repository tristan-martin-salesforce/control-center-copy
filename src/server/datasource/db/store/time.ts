/**
 * Activity entries and time blocks (Time page).
 *
 * activity_entries: start/end → starts_at/ends_at · durationH → duration_hours · taskType →
 *   se_task_type_id (team-pack vocabulary) · meetingType → meeting_type_id (Org62 picklist) +
 *   customer_facing/customer_related · oppId → opportunity_id (+ what_kind/what_name = oppName; an opp the row
 *   gets or loses also sets what_org62_id, the WhatId a logging batch writes: whatOfOpp) ·
 *   description → subject + description · status (+ approved/synced/logged/verified stamps) ·
 *   confidence · issues → flags · userLockedFields → user_locked_fields · version.
 *   date is the local day of start (profile timezone). Ext: sources, accountName (when not the opp's
 *   account), a date override when the row's day differs from its start.
 * time_blocks: lane → source/attention (focus counts as human hours; agent, Drive and Slack lanes are
 *   overlays that never count) · activityId → activity_entry_time_blocks. Ext: label, hatched.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { ActivityEntry, ActivityLockableField, TimelineBlock } from '@/contract';
import { lockableActivityFields } from '@/contract';
import { accounts, activityEntries, activityEntryTimeBlocks, opportunities, org62PicklistValues, seTaskTypes, timeBlocks, users } from '@/db/schema';
import { dismissSourceOf, isRuleDismissal } from '@/engines/activity/internal';
import { ORG62_CHECK_PREFIX } from '@/engines/activity/org62-check';
import { accountTargetWhat } from '@/engines/attribution/target';
import { isInternalEntry } from '@/lib/time-internal';
import { org62RecordUrl, sourceItemUrl } from '@/projections/links';

import { activityStatusFromDb, confToNum, excludedReasonFromDb, numToConf, type DbActivityStatus, type DbExcludedReason } from '../enums';
import { uuidFor, uuidOrNull } from '../ids';
import { ext, isoReq, localDay, same, toDate, updateRow, writeExt, type ReadCtx, type WriteCtx } from './common';

export type TimeBlockRec = TimelineBlock & { lane: 'meetings' | 'focus' | 'claude' | 'drive' | 'slack' };

const LOCK_COL: Record<ActivityLockableField, string> = {
  date: 'local_day',
  start: 'starts_at',
  end: 'ends_at',
  durationH: 'duration_hours',
  taskType: 'se_task_type_id',
  oppId: 'opportunity_id',
  meetingType: 'meeting_type_id',
  description: 'description',
  status: 'status',
  // D-66: ext-backed (the row's side-car), locked under this pseudo column like `date` (local_day)
  logNote: 'log_note',
};
const COL_LOCK = Object.fromEntries(Object.entries(LOCK_COL).map(([f, c]) => [c, f])) as Record<string, ActivityLockableField>;
export const activityLockColumns = (fields: ActivityLockableField[]) => fields.map((f) => LOCK_COL[f]);

interface ActivityExt {
  sources: ActivityEntry['sources'];
  accountName: string;
  accountNameNull: boolean;
  date: string;
  oppName: string;
  /** D-64: a row whose dedupe key does not name its source (one seeded or created here) keeps it here. */
  dismissSource: NonNullable<ActivityEntry['dismissSource']>;
  /** D-66: the Org62 Description's note and how the app drafted it (the projection writes both; your edit locks log_note). */
  logNote: string;
  logNoteBasis: NonNullable<ActivityEntry['logNoteBasis']>;
}

/** The user's team-pack vocabularies (task types, meeting types). */
export interface Vocab {
  teamPackId: string | null;
  taskTypeById: Map<string, string>;
  taskTypeByName: Map<string, string>;
  meetingTypeById: Map<string, 'CF' | 'CR'>;
  meetingTypeByValue: Map<string, string>;
}

/** A vocabulary with no task or meeting types (no team pack, or a read model whose scope reads no activity). */
export const emptyVocab = (teamPackId: string | null): Vocab => ({ teamPackId, taskTypeById: new Map(), taskTypeByName: new Map(), meetingTypeById: new Map(), meetingTypeByValue: new Map() });

/** `known`: the user's team pack when the caller already read the users row (the read model's base): no second read. */
export async function loadVocab(db: ReadCtx['db'] | WriteCtx['tx'], userId: string, known?: { teamPackId: string | null }): Promise<Vocab> {
  const teamPackId = known ? known.teamPackId : ((await db.select({ teamPackId: users.teamPackId }).from(users).where(eq(users.id, userId)))[0]?.teamPackId ?? null);
  if (!teamPackId) return emptyVocab(teamPackId);
  const tts = await db.select({ id: seTaskTypes.id, name: seTaskTypes.name }).from(seTaskTypes).where(eq(seTaskTypes.teamPackId, teamPackId));
  const mts = await db.select({ id: org62PicklistValues.id, value: org62PicklistValues.value }).from(org62PicklistValues).where(and(eq(org62PicklistValues.teamPackId, teamPackId), eq(org62PicklistValues.field, 'Meeting_Type__c')));
  return {
    teamPackId,
    taskTypeById: new Map(tts.map((t) => [t.id, t.name])),
    taskTypeByName: new Map(tts.map((t) => [t.name, t.id])),
    meetingTypeById: new Map(mts.filter((m) => m.value === 'CF' || m.value === 'CR').map((m) => [m.id, m.value as 'CF' | 'CR'])),
    meetingTypeByValue: new Map(mts.map((m) => [m.value, m.id])),
  };
}

/** Make sure a task type exists in the team pack (the vocabulary grows as rows are typed). */
export async function ensureTaskType(w: WriteCtx, vocab: Vocab, name: string): Promise<string> {
  const hit = vocab.taskTypeByName.get(name);
  if (hit) return hit;
  if (!vocab.teamPackId) throw new Error('user has no team pack: task types need one (seed creates it)');
  const [row] = await w.tx
    .insert(seTaskTypes)
    .values({ teamPackId: vocab.teamPackId, name, countsCustomerRelated: true, countsCustomerFacing: /demo|discovery|briefing|deep dive|workshop/i.test(name), bucket: 'pre_sale', ordinal: vocab.taskTypeByName.size })
    .onConflictDoNothing()
    .returning({ id: seTaskTypes.id });
  const id = row?.id ?? (await w.tx.select({ id: seTaskTypes.id }).from(seTaskTypes).where(and(eq(seTaskTypes.teamPackId, vocab.teamPackId), eq(seTaskTypes.name, name))))[0]!.id;
  vocab.taskTypeByName.set(name, id);
  vocab.taskTypeById.set(id, name);
  return id;
}

/** Rows projected before their sources carried links: an Org62 source opens its Event, a Claude source its session. */
function linkedSource(src: ActivityEntry['sources'][number]): ActivityEntry['sources'][number] {
  if (src.url || !src.externalId) return src;
  const url = src.kind === 'org62' ? org62RecordUrl('Event', src.externalId) : src.kind === 'claude' ? sourceItemUrl({ source: 'claude', externalId: src.externalId }) : null;
  return url ? { ...src, url } : src;
}

/** `ids`: only those rows (a page scope's window, reads/rows.ts); omitted = every row. */
export async function loadActivity(rc: ReadCtx, vocab: Vocab, oppName: (id: string) => { name: string; accountName: string | null } | null, ids?: readonly string[]): Promise<ActivityEntry[]> {
  if (ids && !ids.length) return [];
  const rows = await rc.db.select().from(activityEntries).where(ids ? and(eq(activityEntries.ownerUserId, rc.userId), inArray(activityEntries.id, [...ids])) : eq(activityEntries.ownerUserId, rc.userId)).orderBy(asc(activityEntries.createdAt), asc(activityEntries.id));
  return rows.map((r): ActivityEntry => {
    const x = ext<ActivityExt>(rc, 'activity_entries', r.id);
    const opp = r.opportunityId ? oppName(r.opportunityId) : null;
    const e: ActivityEntry = {
      id: r.id,
      version: r.version,
      date: x.date ?? localDay(r.startsAt, rc.timezone),
      start: isoReq(r.startsAt),
      end: isoReq(r.endsAt),
      durationH: r.durationHours,
      taskType: r.seTaskTypeId ? (vocab.taskTypeById.get(r.seTaskTypeId) ?? null) : null,
      oppId: r.opportunityId,
      oppName: x.oppName ?? r.whatName ?? opp?.name ?? null,
      accountName: x.accountNameNull ? null : (x.accountName ?? opp?.accountName ?? null),
      meetingType: r.meetingTypeId ? (vocab.meetingTypeById.get(r.meetingTypeId) ?? null) : null,
      description: r.description ?? r.subject,
      status: activityStatusFromDb(r.status),
      confidence: numToConf(r.confidence),
      sources: (x.sources ?? []).map(linkedSource),
      userLockedFields: r.userLockedFields.map((c) => COL_LOCK[c]).filter((f): f is ActivityLockableField => !!f),
      // D-65: what the Org62 check found (verify_issue) reads with the row's flags: "Org62 check: Deleted in Org62"
      issues: r.status === 'verify_failed' && r.verifyIssue ? [...r.flags, ...r.verifyIssue.split('; ').filter(Boolean).map((x) => `${ORG62_CHECK_PREFIX}${x}`)] : r.flags,
      updatedAt: isoReq(r.updatedAt),
      // the Org62 read-back writes its own rows (projections/activity.ts fromOrg62): logged by definition
      fromOrg62: r.dedupeKey.startsWith(ORG62_KEY),
      // D-64: a row a "Dismiss all from …" rule set aside says so (Dismissed by your rule)
      excludedReason: r.status === 'dismissed' && isRuleDismissal(r.flags) ? 'dismiss_rule' : excludedReasonFromDb(r.status, r.excludedReason),
      loggedAt: r.loggedAt ? isoReq(r.loggedAt) : null,
      verifiedAt: r.verifiedAt ? isoReq(r.verifiedAt) : null,
      internal: false,
      dismissSource: dismissSourceOf(r.dedupeKey, r.subject) ?? x.dismissSource ?? null,
      // D-98: the columns first (log_note, log_note_basis), the ext object as the kv fallback
      logNote: r.logNote ?? x.logNote ?? null,
      // a note you edited is yours: no app basis
      logNoteBasis: r.userLockedFields.includes(LOCK_COL.logNote) ? null : ((r.logNoteBasis as ActivityExt['logNoteBasis'] | null) ?? x.logNoteBasis ?? null),
      // the engine's reason for the row (its type pick, an estimate): Details ▸ How it came in
      why: r.reason || null,
      suggestion: null,
      // D-103 (c): a row that logs to the account itself (no opportunity)
      // (an engine fallback still asking for an opp is not one: its flag says so)
      ...(r.whatKind === 'account' && !r.opportunityId && r.accountId && !r.flags.some((f) => /^NEEDS WhatId|^WhatId = account fallback/.test(f)) ? { accountId: r.accountId } : {}),
    };
    // D-64: internal-only work: no opp, no account, no WhatId, no CF / CR, an internal task type
    e.internal = isInternalEntry(e) && !r.whatOrg62Id && !r.accountId && r.whatKind === 'none';
    return e;
  });
}

/** Dedupe-key prefix of the rows the Org62 read-back creates (an Event nobody proposed here). */
const ORG62_KEY = 'org62|';

/** The db status and exclusion reason of a contract row: a dismissed row is the engine's `excluded` (with its reason), `dropped`, or yours. */
export function activityStatusToDb(a: Pick<ActivityEntry, 'status' | 'excludedReason'>): { status: DbActivityStatus; excludedReason: DbExcludedReason | null } {
  if (a.status !== 'dismissed') return { status: a.status, excludedReason: null };
  if (a.excludedReason === 'dropped') return { status: 'dropped', excludedReason: null };
  if (a.excludedReason && a.excludedReason !== 'dismissed' && a.excludedReason !== 'dismiss_rule') return { status: 'excluded', excludedReason: a.excludedReason };
  return { status: 'dismissed', excludedReason: null };
}

function activityColumns(a: ActivityEntry, w: Pick<WriteCtx, 'userId'>, taskTypeId: string | null, meetingTypeId: string | null) {
  const s = a.status;
  const db = activityStatusToDb(a);
  return {
    id: uuidFor(a.id),
    ownerUserId: w.userId,
    subject: a.description || '(no subject)',
    startsAt: new Date(a.start),
    endsAt: new Date(a.end),
    durationHours: a.durationH,
    seTaskTypeId: taskTypeId,
    meetingTypeId,
    whatKind: a.oppId ? ('opportunity' as const) : ('none' as const),
    opportunityId: uuidOrNull(a.oppId),
    whatName: a.oppName,
    customerFacing: a.meetingType === 'CF',
    customerRelated: a.meetingType === 'CR',
    description: a.description,
    confidence: confToNum(a.confidence),
    reason: a.why ?? null,
    // D-65: the read side's Org62-check lines (from verify_issue) are not flags: never written back
    flags: a.issues.filter((f) => !f.startsWith(ORG62_CHECK_PREFIX)),
    status: db.status,
    excludedReason: db.excludedReason,
    approvedAt: s === 'approved' || s === 'synced_to_canvas' || s === 'logged' || s === 'verified' || s === 'verify_failed' ? toDate(a.updatedAt) : null,
    approvalMethod: s === 'approved' || s === 'synced_to_canvas' || s === 'logged' || s === 'verified' || s === 'verify_failed' ? ('click' as const) : null,
    syncedToCanvasAt: s === 'synced_to_canvas' || s === 'logged' || s === 'verified' ? toDate(a.updatedAt) : null,
    // a stamp the row already carries is kept (the read-back's own time); otherwise the row's updatedAt
    loggedAt: s === 'logged' || s === 'verified' ? toDate(a.loggedAt ?? a.updatedAt) : null,
    verifiedAt: s === 'verified' ? toDate(a.verifiedAt ?? a.updatedAt) : null,
  };
}

function activityExt(a: ActivityEntry, tz: string, oppAccount: string | null, oppName: string | null): Record<string, unknown> {
  return {
    sources: a.sources,
    accountName: a.accountName !== null && a.accountName !== oppAccount ? a.accountName : undefined,
    accountNameNull: a.accountName === null && oppAccount !== null ? true : undefined,
    date: a.date !== localDay(a.start, tz) ? a.date : undefined,
    // oppName is what_name; only a name that disagrees with the opp and has no opp id needs ext
    oppName: !a.oppId && a.oppName && a.oppName !== oppName ? a.oppName : undefined,
    dismissSource: a.dismissSource ?? undefined,
    logNote: a.logNote ?? undefined,
    logNoteBasis: a.logNote && !a.userLockedFields.includes('logNote') ? (a.logNoteBasis ?? undefined) : undefined,
  };
}

async function typeIds(w: WriteCtx, vocab: Vocab, a: ActivityEntry) {
  const tt = a.taskType ? await ensureTaskType(w, vocab, a.taskType) : null;
  const mt = a.meetingType ? (vocab.meetingTypeByValue.get(a.meetingType) ?? null) : null;
  return { tt, mt };
}

/** An Org62 Opportunity id (a placeholder key like `cc:…` is not one: it must never reach a canvas as a WhatId). */
const ORG62_OPP_ID = /^006[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

/**
 * The WhatId columns of a row whose opp the user set or cleared: the opp's own Org62 id, kind and name (and its
 * account), so a logging batch logs to the opp the row shows. Clearing the opp clears them: the engine's account
 * fallback is for rows it never had an opp for, and a row you edited is yours (the projection never rewrites it).
 */
export async function whatOfOpp(w: Pick<WriteCtx, 'tx' | 'userId'>, oppId: string | null, oppName: string | null): Promise<{ whatKind: 'opportunity' | 'none'; whatOrg62Id: string | null; whatName: string | null; accountId?: string | null }> {
  if (!oppId) return { whatKind: 'none', whatOrg62Id: null, whatName: null };
  const [o] = await w.tx
    .select({ org62: opportunities.org62OpportunityId, name: opportunities.name, accountId: opportunities.accountId })
    .from(opportunities)
    .where(and(eq(opportunities.ownerUserId, w.userId), eq(opportunities.id, uuidFor(oppId))));
  return {
    whatKind: 'opportunity',
    whatOrg62Id: o && ORG62_OPP_ID.test(o.org62) ? o.org62 : null,
    whatName: oppName ?? o?.name ?? null,
    ...(o?.accountId ? { accountId: o.accountId } : {}),
  };
}

/** The WhatId columns of an account target (D-103 (c)): kind account, the account's Org62 id through accountTargetWhat. */
export async function whatOfAccount(w: Pick<WriteCtx, 'tx' | 'userId'>, accountId: string): Promise<{ whatKind: 'account'; whatOrg62Id: string | null; whatName: string | null; accountId: string; opportunityId: null }> {
  const [a] = await w.tx
    .select({ org62: accounts.org62AccountId, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.ownerUserId, w.userId), eq(accounts.id, uuidFor(accountId))));
  return { whatKind: 'account', whatOrg62Id: accountTargetWhat(a?.org62)?.whatId ?? null, whatName: a?.name ?? null, accountId: uuidFor(accountId), opportunityId: null };
}

export async function insertActivity(w: WriteCtx, vocab: Vocab, a: ActivityEntry, oppAccount: string | null): Promise<string> {
  const { tt, mt } = await typeIds(w, vocab, a);
  const cols = { ...activityColumns(a, w, tt, mt), ...(a.oppId ? await whatOfOpp(w, a.oppId, a.oppName) : {}) };
  // D-65: a row's "Org62 check: …" lines are its verify issue (loadActivity reads them back the same way)
  const checks = a.issues.filter((f) => f.startsWith(ORG62_CHECK_PREFIX)).map((f) => f.slice(ORG62_CHECK_PREFIX.length));
  await w.tx.insert(activityEntries).values({
    ...cols,
    ...(a.status === 'verify_failed' && checks.length ? { verifyIssue: checks.join('; ') } : {}),
    // a row read from Org62 keeps the read-back's key and origin, so it reads back as fromOrg62
    dedupeKey: a.fromOrg62 ? `${ORG62_KEY}${a.sources.find((s) => s.kind === 'org62')?.externalId ?? cols.id}` : `cc:activity:${cols.id}`,
    origin: a.fromOrg62 ? 'manual' : a.sources.some((s) => s.kind === 'calendar') ? 'calendar' : 'evidence',
    userLockedFields: activityLockColumns(a.userLockedFields).sort(),
    version: a.version,
    updatedAt: toDate(a.updatedAt)!,
  });
  await writeExt(w, 'activity_entries', cols.id, activityExt(a, w.timezone, oppAccount, a.oppName));
  return cols.id;
}

/**
 * `status` is never a user lock (lockableActivityFields): a lock an older edit left on it is dropped before a status
 * change, so a pipeline move (a created canvas, the Org62 check) applies instead of becoming a change proposal, which
 * held a handed-off row at approved and let the next batch log it again.
 */
export async function updateActivity(w: WriteCtx, vocab: Vocab, cur: ActivityEntry, next: ActivityEntry, o: { bump: boolean; ifVersion?: number; lock?: ActivityLockableField[] }, oppAccount: string | null) {
  const ca = await typeIds(w, vocab, cur);
  const cb = await typeIds(w, vocab, next);
  const a = activityColumns(cur, w, ca.tt, ca.mt);
  const b = activityColumns(next, w, cb.tt, cb.mt);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(b) as (keyof typeof b)[]) if (k !== 'id' && !same(a[k], b[k])) patch[k] = b[k];
  if ('status' in patch) {
    await w.tx
      .update(activityEntries)
      .set({ userLockedFields: sql`array_remove(${activityEntries.userLockedFields}, 'status')` })
      .where(and(eq(activityEntries.id, b.id), sql`'status' = any(${activityEntries.userLockedFields})`));
  }
  // the WhatId follows a changed opp (PATCH /activity/:id, the Assistant's edit_activities, an Org62 pick)
  if ((cur.oppId ?? null) !== (next.oppId ?? null)) Object.assign(patch, await whatOfOpp(w, next.oppId, next.oppName));
  // D-103 (c): an account target: the account's own WhatId (accountTargetWhat decides it, B-117)
  if (next.accountId && !next.oppId && next.accountId !== (cur.accountId ?? null)) Object.assign(patch, await whatOfAccount(w, next.accountId));
  // D-64: made internal: no WhatId at all (an account fallback goes too), neither customer-facing nor related
  if (next.internal && !cur.internal) Object.assign(patch, { whatKind: 'none', whatOrg62Id: null, whatName: null, opportunityId: null, accountId: null, customerFacing: false, customerRelated: false });
  // stamps follow the contract updatedAt the first time a status is reached
  for (const k of ['approvedAt', 'syncedToCanvasAt', 'loggedAt', 'verifiedAt'] as const) if (patch[k] instanceof Date) patch[k] = w.now;
  await updateRow(w, activityEntries, b.id, patch, { bump: o.bump, ifVersion: o.ifVersion, lock: o.lock ? activityLockColumns(lockableActivityFields(o.lock)) : false, extChanged: true });
  await writeExt(w, 'activity_entries', b.id, activityExt(next, w.timezone, oppAccount, next.oppName));
}

// ---------------------------------------------------------------------------
// Time blocks
// ---------------------------------------------------------------------------

const LANE: Record<TimeBlockRec['lane'], { source: 'manual' | 'claude_background' | 'doc_edit' | 'slack_burst' | 'travel'; attention: 'focused' | 'background' | 'ambient' | 'meeting'; human: boolean; overlay: boolean; precedence: number }> = {
  meetings: { source: 'travel', attention: 'meeting', human: true, overlay: false, precedence: 30 },
  focus: { source: 'manual', attention: 'focused', human: true, overlay: false, precedence: 50 },
  claude: { source: 'claude_background', attention: 'background', human: false, overlay: true, precedence: 10 },
  drive: { source: 'doc_edit', attention: 'focused', human: false, overlay: true, precedence: 20 },
  slack: { source: 'slack_burst', attention: 'ambient', human: false, overlay: true, precedence: 20 },
};
function laneOf(source: string): TimeBlockRec['lane'] {
  // travel and onsite frames are time with the customer: the Meetings lane, beside the meetings (onsite lane)
  if (source === 'travel' || source === 'onsite') return 'meetings';
  // hands-on Claude time is my focus work (counted); only agent / background time is the hatched Claude lane
  if (source === 'claude_background') return 'claude';
  if (source === 'doc_edit') return 'drive';
  if (source === 'slack_burst') return 'slack';
  return 'focus';
}

/** `ids`: only those blocks (a page scope's window, reads/rows.ts); omitted = every block. */
export async function loadTimeBlocks(rc: ReadCtx, ids?: readonly string[]): Promise<TimeBlockRec[]> {
  if (ids && !ids.length) return [];
  const rows = await rc.db.select().from(timeBlocks).where(ids ? and(eq(timeBlocks.ownerUserId, rc.userId), inArray(timeBlocks.id, [...ids])) : eq(timeBlocks.ownerUserId, rc.userId)).orderBy(asc(timeBlocks.createdAt), asc(timeBlocks.id));
  if (!rows.length) return [];
  const joins = await rc.db.select().from(activityEntryTimeBlocks).where(inArray(activityEntryTimeBlocks.timeBlockId, rows.map((r) => r.id)));
  return rows
    // meetings come from the events; travel and onsite frames show only where they count (their overlay pieces
    // under a session would paint the same time twice)
    .filter((r) => r.source !== 'calendar' && !((r.source === 'travel' || r.source === 'onsite') && r.isOverlay))
    .map((r) => {
      const x = ext<{ label: string; hatched: boolean }>(rc, 'time_blocks', r.id);
      return {
        id: r.id,
        start: isoReq(r.startsAt),
        end: isoReq(r.endsAt),
        label: x.label ?? '',
        activityId: joins.find((j) => j.timeBlockId === r.id)?.activityEntryId ?? null,
        hatched: !!x.hatched,
        lane: laneOf(r.source),
      };
    });
}

export async function insertTimeBlock(w: WriteCtx, b: TimeBlockRec): Promise<string> {
  const id = uuidFor(b.id);
  const l = LANE[b.lane];
  await w.tx.insert(timeBlocks).values({
    id,
    ownerUserId: w.userId,
    source: l.source,
    startsAt: new Date(b.start),
    endsAt: new Date(b.end),
    localDay: localDay(b.start, w.timezone),
    attention: l.attention,
    countsAsHumanHours: l.human,
    precedence: l.precedence,
    isOverlay: l.overlay,
    dedupeKey: `cc:time_block:${id}`,
    engineVersion: 'cc-seed@1',
  });
  if (b.activityId) {
    await w.tx.insert(activityEntryTimeBlocks).values({ activityEntryId: uuidFor(b.activityId), timeBlockId: id, allocatedMinutes: Math.max(1, Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60_000)) });
  }
  await writeExt(w, 'time_blocks', id, { label: b.label, hatched: b.hatched || undefined });
  return id;
}
