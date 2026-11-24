// Loading work items (ext, handoff involvement, training providers). Split from work.ts (max-lines); work.ts re-exports the public names.
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { SourceRef, WorkItemRecord } from '@/contract';
import {
  jobs, priorityScores, sourceItems, workItemEvidence, workItemLinks, workItems, workItemTrainingDetails,
} from '@/db/schema';
import {
  applyOverride, kindFromDb, numToConf, overrideIfLossy, stateFromDb, type DbWorkKind, type DbWorkStatus,
  type Override,
} from '../enums';
import { derivedPriority } from '../../mock/rank';
import { ext, iso, isoReq, personRef, type ReadCtx } from './common';
import { TRAINING_DETAILS_WRITABLE, lockFieldsFromColumns } from './work.columns';
import { sourceChipCols, sourceRefOf } from './work.evidence';

export const FIELD_LABEL: Record<string, string> = { title: 'Title', purpose: 'Purpose', due: 'Due', notes: 'Notes', state: 'State', kind: 'Kind', initiativeId: 'Initiative', accountId: 'Account', oppId: 'Opportunity', doc: 'Draft body' };
// ---------------------------------------------------------------------------
// Ext shape
// ---------------------------------------------------------------------------

export interface WorkExt {
  /** why for an item without a priority_scores row yet (fresh capture). */
  why: string;
  whyDetail: string;
  sources: SourceRef[];
  rankReasons: WorkItemRecord['rankReasons'];
  signals: WorkItemRecord['signals'];
  stale: WorkItemRecord['stale'];
  likelyDone: WorkItemRecord['likelyDone'];
  reopened: WorkItemRecord['reopened'];
  dismissed: WorkItemRecord['dismissed'];
  loopedBackIn: WorkItemRecord['loopedBackIn'];
  waitingWhoId: string;
  waitingRunId: string;
  enrichment: WorkItemRecord['enrichment'];
  deliverable: WorkItemRecord['deliverable'];
  trainingProvider: string;
  trainingOverdue: boolean;
  /** Whole TrainingInfo while work_item_training_details is unwritable (BLOCKER B1, see upsertTraining). */
  training: WorkItemRecord['training'];
  ageDays: number;
  runIds: string[];
  /** @deprecated derived from queued jobs; older rows may still carry it and it is ignored. */
  reevaluating: boolean;
  startByUser: { value: string | null };
  resolutionPersonName: string;
  resolutionEvidenceIds: string[];
  /** SETTLE-1: why the app closed it for you (reason class, confidence, the message link, the skill version). */
  resolutionSettle: NonNullable<NonNullable<WorkItemRecord['resolutionDetail']>['settle']>;
  kindOverride: Override<WorkItemRecord['kind'], DbWorkKind>;
  stateOverride: Override<WorkItemRecord['state'], DbWorkStatus>;
  /** doneAt/doneBy survive a non-done status in the contract (work_items_done_chk forbids it in the row). */
  keptDone: { doneAt: string | null; doneBy: WorkItemRecord['doneBy'] };
  /** Display copy of who it was handed to when no people row resolves (owner = synthetic person). */
  ownerName: string;
  /** work_items_handoff_chk: a hand-off stores watcher; the contract may say otherwise. */
  involvementOverride: Override<WorkItemRecord['involvement'], 'watcher'>;
}
export function workExt(w: WorkItemRecord, dbKind: DbWorkKind, dbStatus: DbWorkStatus): Partial<WorkExt> {
  const signals = w.signals.customerFacing || w.signals.fromManager || w.signals.boost ? w.signals : undefined;
  const resPersonName = w.resolutionDetail?.personName && !w.resolutionDetail.personId ? w.resolutionDetail.personName : undefined;
  const evIds = w.resolutionDetail?.evidenceIds && w.resolutionDetail.evidenceIds.length > 1 ? w.resolutionDetail.evidenceIds : undefined;
  return {
    why: w.why || undefined,
    whyDetail: w.whyDetail ?? undefined,
    sources: w.sources,
    rankReasons: w.rankReasons,
    signals,
    stale: w.stale,
    likelyDone: w.likelyDone,
    reopened: w.reopened,
    dismissed: w.dismissed,
    loopedBackIn: w.loopedBackIn,
    waitingWhoId: w.waiting?.who?.id,
    waitingRunId: w.waiting?.runId,
    enrichment: w.enrichment,
    deliverable: w.deliverable,
    trainingProvider: TRAINING_DETAILS_WRITABLE && w.training && trainingProviderLabel(trainingProviderEnum(w.training.provider)) !== w.training.provider ? w.training.provider : undefined,
    trainingOverdue: TRAINING_DETAILS_WRITABLE ? w.training?.overdue || undefined : undefined,
    training: TRAINING_DETAILS_WRITABLE ? undefined : w.training,
    ageDays: w.ageDays || undefined,
    runIds: w.runIds,
    // reevaluating is derived from queued jobs on every read; never persisted (a stored copy stuck on for good).
    resolutionPersonName: resPersonName,
    resolutionEvidenceIds: evIds,
    resolutionSettle: w.resolutionDetail?.settle ?? undefined,
    kindOverride: overrideIfLossy(w.kind, dbKind, kindFromDb) ?? undefined,
    stateOverride: overrideIfLossy(w.state, dbStatus, (s) => stateFromDb(s, false)) ?? undefined,
    keptDone: w.state !== 'done' && (w.doneAt || w.doneBy) ? { doneAt: w.doneAt, doneBy: w.doneBy } : undefined,
    involvementOverride: handoffInvolvement(w) !== w.involvement ? { value: w.involvement, when: 'watcher' } : undefined,
  };
}
/** A handed-off item must be watcher / not_involved in the row (work_items_handoff_chk). */
export function handoffInvolvement(w: WorkItemRecord): WorkItemRecord['involvement'] {
  return w.resolution === 'handed_off' && w.involvement !== 'watcher' && w.involvement !== 'not_involved' ? 'watcher' : w.involvement;
}
// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function loadWorkItems(rc: ReadCtx, ids?: string[]): Promise<WorkItemRecord[]> {
  const where = ids ? and(eq(workItems.ownerUserId, rc.userId), inArray(workItems.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])) : eq(workItems.ownerUserId, rc.userId);
  const rows = await rc.db
    .select({ w: workItems, why: priorityScores.explanation, startBy: priorityScores.latestStartAt })
    .from(workItems)
    .leftJoin(priorityScores, eq(priorityScores.id, workItems.priorityScoreId))
    .where(where)
    .orderBy(asc(workItems.createdAt), asc(workItems.id));
  if (!rows.length) return [];
  const itemIds = rows.map((r) => r.w.id);
  const links = await rc.db
    .select()
    .from(workItemLinks)
    .where(inArray(workItemLinks.workItemId, itemIds))
    .orderBy(asc(workItemLinks.createdAt), asc(workItemLinks.id));
  const training = await rc.db.select().from(workItemTrainingDetails).where(inArray(workItemTrainingDetails.workItemId, itemIds));
  // "re-evaluating…": a queued or running job for the item. Re-eval jobs (W2, scanner, BE-3) key the item as
  // `work_item_id`; enrich jobs (captureItem) as `workItemId`.
  const jobItem = sql<string>`coalesce(${jobs.payload} ->> 'work_item_id', ${jobs.payload} ->> 'workItemId')`;
  const busy = await rc.db
    .select({ id: jobItem })
    .from(jobs)
    .where(and(eq(jobs.ownerUserId, rc.userId), inArray(jobs.status, ['queued', 'running']), inArray(jobs.kind, ['enrich', 'reevaluate']), isNotNull(jobItem)));
  const busyIds = new Set(busy.map((b) => b.id));
  // Scanner-made items carry no `sources` of their own: their origin chip is the evidence they were made from (origin
  // first), each linked to the original (tenet: Provenance on everything).
  const bare = rows.filter((r) => ext<WorkExt>(rc, 'work_items', r.w.id).sources === undefined).map((r) => r.w.id);
  const derivedSources = new Map<string, SourceRef[]>();
  if (bare.length) {
    const ev = await rc.db
      .select({ wid: workItemEvidence.workItemId, role: workItemEvidence.role, si: sourceChipCols })
      .from(workItemEvidence)
      .innerJoin(sourceItems, eq(sourceItems.id, workItemEvidence.sourceItemId))
      .where(and(inArray(workItemEvidence.workItemId, bare), sql`${sourceItems.dedupeKey} not like 'cc.evidence:%'`))
      .orderBy(asc(workItemEvidence.createdAt), asc(workItemEvidence.id));
    const rank = (role: string) => (role === 'origin' ? 0 : role === 'completion' ? 2 : 1);
    for (const e of [...ev].sort((a, b) => rank(a.role) - rank(b.role))) {
      const list = derivedSources.get(e.wid) ?? [];
      const ref = sourceRefOf(e.si);
      if (list.length < 3 && !list.some((x) => (x.url && x.url === ref.url) || (x.externalId && x.externalId === ref.externalId))) list.push(ref);
      derivedSources.set(e.wid, list);
    }
  }
  const trainingBy = new Map(training.map((t) => [t.workItemId, t]));
  const linksBy = new Map<string, (typeof links)[number][]>();
  for (const l of links) {
    if (!linksBy.has(l.workItemId)) linksBy.set(l.workItemId, []);
    linksBy.get(l.workItemId)!.push(l);
  }

  return rows.map(({ w: r, why, startBy }) => {
    // D-98: the promoted columns first (start_by_user, dismissed); the ext object is the kv fallback (store/sidecar.ts)
    const x = { ...ext<WorkExt>(rc, 'work_items', r.id), ...(r.startByUser ? { startByUser: r.startByUser } : {}), ...(r.dismissed ? { dismissed: r.dismissed as unknown as WorkExt['dismissed'] } : {}) };
    const kind = applyOverride(r.kind, kindFromDb(r.kind), x.kindOverride);
    const state = applyOverride(r.status, stateFromDb(r.status, false), x.stateOverride);
    const ls = linksBy.get(r.id) ?? [];
    const t = trainingBy.get(r.id);
    const owner = r.ownerPersonId ? personRef(rc, r.ownerPersonId) : { id: rc.me.id, name: rc.me.name };
    const resolutionPerson = r.resolutionPersonId ? personRef(rc, r.resolutionPersonId) : null;
    const youMin = r.effortMinutes ?? 0;
    const agentMin = Math.max(0, (r.leadTimeMinutes ?? youMin) - youMin);
    const rec: WorkItemRecord = {
      id: r.id,
      version: r.version,
      kind,
      state,
      title: r.title,
      purpose: r.purpose,
      initiativeId: r.initiativeId,
      accountId: r.accountId,
      oppId: r.opportunityId,
      servesEventId: r.deadlineEventId,
      confidence: numToConf(r.confidence),
      why: why ?? x.why ?? '',
      whyDetail: x.whyDetail ?? null,
      sources: x.sources ?? derivedSources.get(r.id) ?? [],
      effort: { youMin, agentMin },
      startBy: x.startByUser ? x.startByUser.value : iso(startBy),
      due: iso(r.dueAt),
      createdAt: isoReq(r.createdAt),
      updatedAt: isoReq(r.updatedAt),
      ageDays: x.ageDays ?? 0,
      isBackground: r.priorityLane === 'background',
      rank: r.priorityRank,
      rankReasons: x.rankReasons ?? [],
      score: r.priorityScore,
      priority: derivedPriority(r.priorityRank),
      // absent = the defaults (normal, hard), so records without them round-trip unchanged
      ...(r.importance !== 'normal' ? { importance: r.importance } : {}),
      ...(r.dueKind ? { dueKind: r.dueKind } : {}),
      signals: x.signals ?? { customerFacing: false, fromManager: false, boost: 0 },
      stale: x.stale ?? null,
      userLockedFields: lockFieldsFromColumns(r.userLockedFields),
      newEvidenceCount: r.unseenEvidenceCount,
      reevaluating: busyIds.has(r.id),
      seenAt: iso(r.seenByUserAt),
      nbaId: r.currentNbaId,
      owner,
      people: ls.filter((l) => l.personId && l.role === 'stakeholder').map((l) => personRef(rc, l.personId)!),
      waiting:
        r.waitingReason && r.waitingSince
          ? {
              on: r.status === 'waiting_on_me' ? 'me' : 'others',
              reason: r.waitingReason,
              ...(x.waitingWhoId ? { who: personRef(rc, x.waitingWhoId)! } : {}),
              since: isoReq(r.waitingSince),
              ...(x.waitingRunId ? { runId: x.waitingRunId } : {}),
            }
          : null,
      snoozedUntil: iso(r.snoozedUntil),
      snoozedFrom: r.snoozedFromStatus ? stateFromDb(r.snoozedFromStatus, false) : null,
      doneAt: r.doneAt ? iso(r.doneAt) : (x.keptDone?.doneAt ?? null),
      doneBy: r.doneBy ? (r.doneBy === 'user' || r.doneBy === 'chat' ? r.doneBy : 'engine') : (x.keptDone?.doneBy ?? null),
      closedReason: r.statusReason,
      resolution: r.resolution,
      resolutionDetail: r.resolution
        ? {
            ...(resolutionPerson ? { personId: resolutionPerson.id, personName: resolutionPerson.name } : x.resolutionPersonName ? { personName: x.resolutionPersonName } : {}),
            ...(r.resolutionWorkItemId ? { relatedItemId: r.resolutionWorkItemId } : {}),
            ...(r.resolutionNote ? { note: r.resolutionNote } : {}),
            inferred: r.resolutionInferred,
            ...(x.resolutionEvidenceIds ? { evidenceIds: x.resolutionEvidenceIds } : r.resolutionEvidenceId ? { evidenceIds: [r.resolutionEvidenceId] } : {}),
            ...(x.resolutionSettle ? { settle: x.resolutionSettle } : {}),
          }
        : null,
      involvement: applyOverride(r.involvement as 'watcher', r.involvement, x.involvementOverride as Override<WorkItemRecord['involvement'], 'watcher'> | undefined),
      loopedBackIn: x.loopedBackIn ?? null,
      likelyDone: x.likelyDone ?? null,
      reopened: x.reopened ?? null,
      dismissed: x.dismissed ?? null,
      notes: r.description ?? '',
      enrichment: x.enrichment ?? null,
      deliverable: x.deliverable ?? null,
      training: x.training
        ? x.training
        : t
        ? {
            course: t.courseTitle,
            provider: x.trainingProvider ?? trainingProviderLabel(t.provider),
            minutes: t.estimatedMinutes ?? 0,
            dueDate: t.requiredBy ? isoReq(t.requiredBy).slice(0, 10) : null,
            overdue: !!x.trainingOverdue,
            ...(t.courseUrl ? { url: t.courseUrl } : {}),
          }
        : null,
      runIds: x.runIds ?? [],
      assetIds: ls.filter((l) => l.assetId).map((l) => l.assetId!),
      counterparty: personRef(rc, r.counterpartyPersonId),
    };
    return rec;
  });
}
// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type WorkRow = typeof workItems.$inferInsert;
const PROVIDER_LABEL = { trailhead: 'Trailhead', workday_learning: 'Workday Learning', internal_lms: 'Internal LMS', slack: 'Slack', email: 'Email', other: 'Other' } as const;
function trainingProviderLabel(p: keyof typeof PROVIDER_LABEL): string {
  return PROVIDER_LABEL[p];
}
export function trainingProviderEnum(p: string): 'trailhead' | 'workday_learning' | 'internal_lms' | 'slack' | 'email' | 'other' {
  if (/trailhead/i.test(p)) return 'trailhead';
  if (/workday/i.test(p)) return 'workday_learning';
  if (/slack/i.test(p)) return 'slack';
  if (/mail/i.test(p)) return 'email';
  if (/readiness|lms|clo|compliance/i.test(p)) return 'internal_lms';
  return 'other';
}
