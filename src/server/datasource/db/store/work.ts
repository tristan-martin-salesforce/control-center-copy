/**
 * Work items, evidence (+ their source items), initiatives and change proposals.
 *
 * Column map (WorkItemRecord → work_items unless noted):
 *   kind → kind (follow_up ↔ missed_meeting_followup; deliverable = task + override) · state → status
 *   (reopened = open + override) · title, purpose · notes → description · initiativeId/accountId/oppId →
 *   *_id · servesEventId → deadline_event_id · counterparty → counterparty_person_id · due → due_at ·
 *   effort.youMin → effort_minutes, youMin+agentMin → lead_time_minutes · confidence → numeric ·
 *   importance → importance, dueKind → due_kind (priority is derived from the rank, never stored: lane 07 R2) · snooze/waiting/done/resolution/involvement → their columns · owner →
 *   owner_person_id (null = me) · seenAt → seen_by_user_at · newEvidenceCount → unseen_evidence_count ·
 *   rank/score → priority_rank/priority_score (+ lane cache; isBackground ⇔ lane 'background') ·
 *   why → priority_scores.explanation and startBy → priority_scores.latest_start_at (Q1) · nbaId →
 *   current_nba_id · closedReason → status_reason · userLockedFields → user_locked_fields (column names) ·
 *   people → work_item_links (person, stakeholder) · assetIds → work_item_links (asset) · runIds →
 *   work_item_links (claude_session / tool_run) + ext order · training → work_item_training_details ·
 *   deliverable → work_item_deliverables (+ ext for the judged view).
 * Ext (no column yet): whyDetail, sources, rankReasons, signals, stale, likelyDone, reopened, dismissed,
 *   loopedBackIn, waiting.who/runId, enrichment, deliverable view, training provider/overdue, ageDays,
 *   runIds (they span three run tables), reevaluating, user-set startBy, resolution person name / extra
 *   evidence ids, kind/state overrides.
 */
import { eq, inArray, sql } from 'drizzle-orm';

import type { PersonRef, WorkItemLockableField, WorkItemRecord } from '@/contract';
import {
  priorityScoreRuleHits, priorityScores, workItemDeliverables, workItemLinks, workItems, workItemTrainingDetails,
  workItemTransitions,
} from '@/db/schema';
import { isClosedItemState } from '@/outbox/withdraw';
import { confToNum, kindToDb, originFor, stateToDb } from '../enums';
import { hashKey, uuidFor, uuidOrNull } from '../ids';
import type { ScoreDetail } from '../rank';
import { same, toDate, updateRow, writeExt, type WriteCtx } from './common';
import { withdrawDraftsOfClosedItems } from './withdraw';
import { type WorkRow, handoffInvolvement, workExt, trainingProviderEnum, type WorkExt } from './work.load';
import { lockColumns, TRAINING_DETAILS_WRITABLE } from './work.columns';
export { WORK_LOCK_COLUMNS, lockColumns, lockFieldsFromColumns, WORK_FIELD_COLUMN } from './work.columns';
export { loadWorkItems } from './work.load';
export { sourceRefOf, loadEvidence, evidenceNewOverride, insertEvidence, updateEvidence } from './work.evidence';
export {
  loadInitiatives, insertInitiative, PROPOSAL_TABLE, loadProposals, insertProposal, evidenceIdsFor,
} from './work.proposals';

/** The work_items columns a contract record implies (everything but bookkeeping and the score pointer). */
export function workItemColumns(w: WorkItemRecord, wc: Pick<WriteCtx, 'userId' | 'me'>): WorkRow {
  const dbStatus = stateToDb(w.state);
  const rd = w.resolutionDetail;
  const done = w.state === 'done';
  return {
    id: uuidFor(w.id),
    ownerUserId: wc.userId,
    kind: kindToDb(w.kind),
    origin: originFor(w.kind, w.sources[0]?.kind),
    status: dbStatus,
    statusReason: w.closedReason,
    title: w.title,
    purpose: w.purpose,
    description: w.notes ? w.notes : null,
    initiativeId: uuidOrNull(w.initiativeId),
    accountId: uuidOrNull(w.accountId),
    opportunityId: uuidOrNull(w.oppId),
    counterpartyPersonId: w.counterparty ? uuidFor(w.counterparty.id) : null,
    dueAt: toDate(w.due),
    deadlineEventId: uuidOrNull(w.servesEventId),
    effortMinutes: w.effort.youMin,
    leadTimeMinutes: w.effort.youMin + w.effort.agentMin,
    backgroundable: w.effort.agentMin > 0,
    // R2: the extractor's importance round-trips; a re-rank no longer overwrites it with a function of rank
    importance: w.importance ?? 'normal',
    dueKind: w.dueKind ?? null,
    confidence: confToNum(w.confidence),
    snoozedUntil: w.state === 'snoozed' || w.snoozedUntil ? toDate(w.snoozedUntil) : null,
    snoozedFromStatus: w.snoozedFrom ? stateToDb(w.snoozedFrom) : null,
    waitingReason: w.waiting?.reason ?? null,
    waitingSince: toDate(w.waiting?.since),
    doneAt: done ? toDate(w.doneAt ?? w.updatedAt) : null,
    doneBy: done ? (w.doneBy ?? 'user') : null,
    resolution: w.resolution,
    resolutionPersonId: rd?.personId ? uuidFor(rd.personId) : null,
    resolutionWorkItemId: rd?.relatedItemId ? uuidFor(rd.relatedItemId) : null,
    resolutionNote: rd?.note ?? null,
    resolutionInferred: rd?.inferred ?? false,
    resolutionEvidenceId: rd?.evidenceIds?.[0] ? uuidFor(rd.evidenceIds[0]) : null,
    ownerPersonId: w.owner && w.owner.id !== wc.me.id ? uuidFor(w.owner.id) : null,
    involvement: handoffInvolvement(w),
    seenByUserAt: toDate(w.seenAt),
    unseenEvidenceCount: w.newEvidenceCount,
    priorityRank: w.rank,
    priorityScore: w.score,
    priorityLane: w.isBackground ? 'background' : w.rank === null ? null : w.rank <= 3 ? 'top3' : w.rank <= 15 ? 'now' : w.rank <= 30 ? 'next' : 'later',
    currentNbaId: uuidOrNull(w.nbaId),
  };
}

export interface ScoreInput {
  runId: number;
  policyId: string;
  /**
   * ENGINES-core output for this item: the component columns, lane, latest_start_at, slack, inputs hash
   * and rule hits come from the engine instead of being derived from rankReasons.
   */
  detail?: ScoreDetail;
  /** rule_key → priority_policy_rules.id of the policy version (rule hits reference rule rows). */
  ruleIds?: Map<string, string>;
}

/** A priority_scores row carrying why / startBy / the components (+ rule hits when the engine ranked it). */
export async function insertScore(w: WriteCtx, rec: WorkItemRecord, s: ScoreInput, computedAt: Date): Promise<number> {
  if (s.detail) {
    const d = s.detail;
    const [row] = await w.tx
      .insert(priorityScores)
      .values({
        runId: s.runId,
        workItemId: uuidFor(rec.id),
        policyId: s.policyId,
        total: rec.score ?? 0,
        ...d.components,
        lane: d.lane,
        rank: rec.rank,
        latestStartAt: toDate(d.startBy),
        slackMinutes: d.slackMinutes,
        inputsHash: d.inputsHash,
        explanation: rec.why,
        computedAt,
      })
      .returning({ id: priorityScores.id });
    const hits = d.ruleHits.flatMap((h) => {
      const ruleId = s.ruleIds?.get(h.ruleKey);
      return ruleId ? [{ scoreId: row!.id, ruleId, effect: h.effect, explanation: h.explanation }] : [];
    });
    if (hits.length) await w.tx.insert(priorityScoreRuleHits).values(hits).onConflictDoNothing();
    return row!.id;
  }
  const comp: Record<string, number> = {};
  const COMPONENT: Record<string, string> = {
    customer_facing: 'stakeholderImportance',
    meeting_proximity: 'calendarPressure',
    due_urgency: 'deadlineProximity',
    manager_ask: 'commitmentWeight',
    deal_value: 'dealValue',
    lead_time: 'leadTime',
    age: 'staleness',
    effort_fit: 'effortFit',
    boost: 'userAdjustment',
  };
  for (const r of rec.rankReasons) {
    const col = r.key.startsWith('rule:') ? 'obligationBoost' : COMPONENT[r.key];
    if (col) comp[col] = Math.round(((comp[col] ?? 0) + r.contribution) * 1000) / 1000;
  }
  const lane = rec.isBackground ? 'background' : rec.rank === null ? 'hidden' : rec.rank <= 3 ? 'top3' : rec.rank <= 15 ? 'now' : rec.rank <= 30 ? 'next' : 'later';
  const [row] = await w.tx
    .insert(priorityScores)
    .values({
      runId: s.runId,
      workItemId: uuidFor(rec.id),
      policyId: s.policyId,
      total: rec.score ?? 0,
      ...comp,
      lane,
      rank: rec.rank,
      latestStartAt: toDate(rec.startBy),
      inputsHash: hashKey(rec.rank, rec.score, rec.rankReasons, rec.why),
      explanation: rec.why,
      computedAt,
    })
    .returning({ id: priorityScores.id });
  return row!.id;
}

async function writeLinks(w: WriteCtx, itemId: string, people: PersonRef[], assetIds: string[], runLinks: { claudeSessionId?: string; toolRunId?: string }[], prev?: { people: PersonRef[]; assetIds: string[]; runLinks: { claudeSessionId?: string; toolRunId?: string }[] }) {
  const want: { key: string; values: typeof workItemLinks.$inferInsert }[] = [];
  let i = 0;
  const at = (n: number) => new Date(w.now.getTime() + n);
  for (const p of people) want.push({ key: `p:${uuidFor(p.id)}`, values: { workItemId: itemId, personId: uuidFor(p.id), role: 'stakeholder', confidence: 1, extractorId: w.extractorId, createdAt: at(i++) } });
  for (const a of assetIds) want.push({ key: `a:${uuidFor(a)}`, values: { workItemId: itemId, assetId: uuidFor(a), role: 'related', confidence: 1, extractorId: w.extractorId, createdAt: at(i++) } });
  for (const r of runLinks) {
    if (r.claudeSessionId) want.push({ key: `c:${r.claudeSessionId}`, values: { workItemId: itemId, claudeSessionId: r.claudeSessionId, role: 'working_session', confidence: 1, extractorId: w.extractorId, createdAt: at(i++) } });
    if (r.toolRunId) want.push({ key: `t:${r.toolRunId}`, values: { workItemId: itemId, toolRunId: r.toolRunId, role: 'working_session', confidence: 1, extractorId: w.extractorId, createdAt: at(i++) } });
  }
  if (!prev) {
    if (want.length) await w.tx.insert(workItemLinks).values(want.map((x) => x.values)).onConflictDoNothing();
    return;
  }
  const existing = await w.tx.select().from(workItemLinks).where(eq(workItemLinks.workItemId, itemId));
  const keyOf = (l: (typeof existing)[number]) => (l.personId ? `p:${l.personId}` : l.assetId ? `a:${l.assetId}` : l.claudeSessionId ? `c:${l.claudeSessionId}` : l.toolRunId ? `t:${l.toolRunId}` : `x:${l.id}`);
  const wantKeys = new Set(want.map((x) => x.key));
  const haveKeys = new Set(existing.map(keyOf));
  const managed = (k: string) => k.startsWith('p:') || k.startsWith('a:') || k.startsWith('c:') || k.startsWith('t:');
  const drop = existing.filter((l) => managed(keyOf(l)) && !wantKeys.has(keyOf(l)) && (l.role === 'stakeholder' || l.role === 'related' || l.role === 'working_session'));
  if (drop.length) await w.tx.delete(workItemLinks).where(inArray(workItemLinks.id, drop.map((d) => d.id)));
  const add = want.filter((x) => !haveKeys.has(x.key));
  if (add.length) await w.tx.insert(workItemLinks).values(add.map((x) => x.values)).onConflictDoNothing();
}

export interface WorkLinkTargets {
  /** contract run id → claude session / tool run row ids (the Agents mirror rows have their own ids). */
  runLinks: (runIds: string[]) => { claudeSessionId?: string; toolRunId?: string }[];
  /** Asset ids that exist (deliverables reference assets by FK). */
  hasAsset: (id: string) => boolean;
}

/** Insert a work item with its children and ext. Returns the uuid. */
/**
 * `ordinal` breaks ties between items created in the same millisecond (a seed loads many at once): it is
 * added as microseconds, below the contract's millisecond precision, so `ORDER BY created_at` keeps the
 * seed's order.
 */
export async function insertWorkItem(w: WriteCtx, rec: WorkItemRecord, t: WorkLinkTargets, opts: { createdAt?: string; statusChangedAt?: string; locks?: string[]; ordinal?: number } = {}): Promise<string> {
  const cols = workItemColumns(rec, w);
  const id = cols.id!;
  await w.tx.insert(workItems).values({
    ...cols,
    version: rec.version,
    statusChangedAt: toDate(opts.statusChangedAt ?? rec.updatedAt)!,
    lastReopenedAt: rec.reopened ? toDate(rec.reopened.at) : null,
    reopenedCount: rec.reopened ? 1 : 0,
    likelyDoneAt: rec.state === 'likely_done' ? toDate(rec.updatedAt) : null,
    lastNewInfoAt: rec.newEvidenceCount > 0 ? toDate(rec.updatedAt) : null,
    userLockedFields: opts.locks ?? lockColumns(rec.userLockedFields).sort(),
    createdAt: opts.ordinal ? (sql`${toDate(opts.createdAt ?? rec.createdAt)!.toISOString()}::timestamptz + make_interval(secs => ${opts.ordinal}::float8 / 1000000)` as unknown as Date) : toDate(opts.createdAt ?? rec.createdAt)!,
    updatedAt: toDate(rec.updatedAt)!,
  });
  await writeLinks(w, id, rec.people, rec.assetIds.filter(t.hasAsset), t.runLinks(rec.runIds));
  if (rec.training) await upsertTraining(w, id, rec.training);
  if (rec.deliverable?.assetId && t.hasAsset(rec.deliverable.assetId)) await upsertDeliverable(w, id, rec);
  await writeExt(w, 'work_items', id, workExt(rec, cols.kind!, cols.status!) as Record<string, unknown>);
  return id;
}

async function upsertTraining(w: WriteCtx, itemId: string, tr: NonNullable<WorkItemRecord['training']>) {
  if (!TRAINING_DETAILS_WRITABLE) return;
  const values = {
    workItemId: itemId,
    provider: trainingProviderEnum(tr.provider),
    courseTitle: tr.course,
    courseUrl: tr.url ?? null,
    requiredBy: tr.dueDate ? new Date(`${tr.dueDate}T00:00:00.000Z`) : null,
    estimatedMinutes: tr.minutes,
    // the contract has no flag: a training with a required-by date (or already overdue) is mandatory
    mandatory: !!tr.dueDate || tr.overdue,
  };
  await w.tx.insert(workItemTrainingDetails).values(values).onConflictDoUpdate({ target: workItemTrainingDetails.workItemId, set: values });
}

async function upsertDeliverable(w: WriteCtx, itemId: string, rec: WorkItemRecord) {
  const d = rec.deliverable!;
  const verdict = d.judgment?.verdict;
  const status = verdict === 'complete' ? 'complete' : verdict === 'partial' || verdict === 'in_progress' || verdict === 'regressed' ? 'in_progress' : verdict === 'not_started' ? 'not_started' : 'in_progress';
  const kind = d.mimeKind === 'slides' ? 'slides' : d.mimeKind === 'doc' ? 'doc' : d.mimeKind === 'sheet' ? 'sheet' : 'other';
  const existing = await w.tx.select({ id: workItemDeliverables.id }).from(workItemDeliverables).where(eq(workItemDeliverables.workItemId, itemId));
  if (existing.length) {
    await w.tx.update(workItemDeliverables).set({ status, kind }).where(eq(workItemDeliverables.id, existing[0]!.id));
  } else {
    await w.tx.insert(workItemDeliverables).values({ workItemId: itemId, assetId: uuidFor(d.assetId!), kind, baselineAt: toDate(rec.createdAt)!, status, assetHint: d.fileName });
  }
}

export interface WorkUpdateOpts {
  /** Contract version bump (true for every mutation the mock `bump()`s). */
  bump: boolean;
  ifVersion?: number;
  /** Newly user-locked contract fields (patch edits); actions lock nothing. */
  lock?: WorkItemLockableField[];
}

/** Diff two contract records and write the difference. Returns proposals created by an engine write. */
export async function updateWorkItem(w: WriteCtx, cur: WorkItemRecord, next: WorkItemRecord, t: WorkLinkTargets, o: WorkUpdateOpts) {
  const a = workItemColumns(cur, w);
  const b = workItemColumns(next, w);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(b) as (keyof WorkRow)[]) {
    if (k === 'origin' || k === 'id' || k === 'ownerUserId') continue;
    if (!same(a[k], b[k])) patch[k] = b[k];
  }
  if (patch.status !== undefined || cur.state !== next.state) {
    patch.statusChangedAt = w.now;
    if (next.state === 'reopened' && cur.state !== 'reopened') {
      patch.lastReopenedAt = w.now;
      patch.reopenedCount = sql`${workItems.reopenedCount} + 1`;
    }
    if (next.state === 'likely_done') patch.likelyDoneAt = w.now;
  }
  if (next.newEvidenceCount > cur.newEvidenceCount) patch.lastNewInfoAt = w.now;
  const extA = workExt(cur, a.kind!, a.status!);
  const extB = workExt(next, b.kind!, b.status!);
  const extChanged = !same(extA, extB) || !same(cur.people, next.people) || !same(cur.assetIds, next.assetIds) || !same(cur.training, next.training);
  // startBy edited by the user lives in ext (priority_scores is engine output)
  const extNext: Partial<WorkExt> = { ...extB };
  if (!same(cur.startBy, next.startBy)) extNext.startByUser = { value: next.startBy };
  else {
    const prev = (w.kv.get(`cc.ext/work_items/${b.id}`) as Partial<WorkExt> | undefined)?.startByUser;
    if (prev) extNext.startByUser = prev;
  }
  const r = await updateRow(w, workItems, b.id!, patch, {
    bump: o.bump,
    ifVersion: o.ifVersion,
    lock: o.lock ? lockColumns(o.lock) : false,
    extChanged: extChanged || !same(cur.startBy, next.startBy),
    stampUpdatedAt: o.bump,
  });
  // why lives on the current score row (Q1); an engine rewrite of the line updates it in place
  if (cur.why !== next.why) {
    await w.tx.execute(sql`update priority_scores set explanation = ${next.why}
                            where id = (select priority_score_id from work_items where id = ${b.id})`);
  }
  if (!same(cur.people, next.people) || !same(cur.assetIds, next.assetIds) || !same(cur.runIds, next.runIds)) {
    await writeLinks(w, b.id!, next.people, next.assetIds.filter(t.hasAsset), t.runLinks(next.runIds), {
      people: cur.people,
      assetIds: cur.assetIds,
      runLinks: t.runLinks(cur.runIds),
    });
  }
  if (next.training && !same(cur.training, next.training)) await upsertTraining(w, b.id!, next.training);
  await writeExt(w, 'work_items', b.id!, extNext as Record<string, unknown>);
  // OUTBOX-W: an item that closes here withdraws its pending reply drafts, in this change set. Every closing writer
  // comes through here (user verbs, chat, triage, settle, the closure machine, re-eval). The status the row actually
  // holds decides (a locked status became a proposal: nothing closed); reopening never brings them back.
  const withdrawn = isClosedItemState(next.state) && !isClosedItemState(cur.state) ? await withdrawDraftsOfClosedItems(w.tx, w.userId, { itemIds: [b.id!], at: w.now }) : [];
  return { ...r, withdrawn };
}

/** Status transitions are the state-machine log (Q6 "closed for you", undo stamps them). */
export async function logTransition(w: WriteCtx, itemId: string, from: WorkItemRecord['state'] | null, to: WorkItemRecord['state'], reason: string | null, evidenceId?: string | null): Promise<number | null> {
  const f = from ? stateToDb(from) : null;
  const t = stateToDb(to);
  if (f === t) return null;
  const [row] = await w.tx.insert(workItemTransitions).values({
    workItemId: uuidFor(itemId),
    fromStatus: f,
    toStatus: t,
    actorKind: w.cs.actor.kind,
    actorRef: w.cs.actor.ref ?? null,
    reason,
    evidenceId: evidenceId ? uuidFor(evidenceId) : null,
    changeSetId: w.cs.id,
    occurredAt: w.now,
  }).returning({ id: workItemTransitions.id });
  return row?.id ?? null;
}
