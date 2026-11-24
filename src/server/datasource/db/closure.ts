/**
 * The closure machine (ENGINES-core, src/engines/closure) on db records.
 *
 * Engine signals (scanner evidence, session states, Drive digests, replies, timers, loop-backs) go through
 * `applySignal()`; this module maps a WorkItemRecord to the machine's ClosureItem and its decision back
 * to the next WorkItemRecord. DbDataSource.applyClosureSignal writes that record with the same writers a
 * user verb uses (updateWorkItem + logTransition, one engine change set), so engine and user paths produce
 * the same rows, and undoChangeSet reverts a decision exactly (the transition row is stamped undone too).
 *
 * User verbs (done, resolve, snooze, accept, dismiss, confirm-done, reopen, not-now) are not closure
 * signals: they are unconditional user transitions, not evidence-gated engine decisions (no confidence,
 * no reopen window, no L4 autonomy), so they stay direct transitions in DbDataSource.itemAction. What they
 * share with this path is the record shape (resolvedRecord for R-UI-22) and the writers.
 *
 * BE-REEVAL adds `reevaluateWorkItem()`, the `reevaluate` job's writer: every evidence link since the last
 * evaluation goes through the closure machine (src/engines/reeval runReevalPass), and the result is written
 * as ONE `engine:reeval` change set, fenced on the item's reeval_generation and the job's cancel request.
 */
import { sql } from 'drizzle-orm';

import type { WorkItemRecord } from '@/contract';
import { actors, engineUpdate, withChangeSet } from '@/db/changeset';
import type { Db, Tx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { reopenDecisions, workItemEvidence, workItemRelations, workItems } from '@/db/schema';
import { closureSettingsFrom, signalFromEvidence, type EvidenceLink } from '@/engines/closure/signals';
import type { ClosureDecision, ClosureField, FieldChange } from '@/engines/closure/types';
import { autoCloseBlock } from '@/engines/closure/correction';
import { loadCorrectionFacts } from '@/engines/closure/correction-db';
import { loadClosingSettings } from '@/engines/settle/select-db';
import { reevalDedupeKey, shouldCommit } from '@/engines/reeval/generation';
import { runReevalPass, type ReevalPass } from '@/engines/reeval/pass';
import {
  type ClosureItem, type ClosureKind, type PersonLite, type Resolution, type ResolutionDetail, type SignalSource,
  type WorkItemStatus, CLOSURE_SETTING_KEYS,
} from '@/engines/types';
import { numToConf } from './enums';
import { loadKv } from './ext';
import { ensureExtractor } from './seed';
import { writeExt, type ReadCtx, type WriteCtx } from './store/common';
import { loadPeople, loadPersonRefs } from './store/entities';
import { readMeta } from './store/settings';
import {
  insertWorkItem, loadWorkItems, logTransition, updateWorkItem, workItemColumns, type WorkLinkTargets,
} from './store/work';
import { closureItemOf, recordAfterDecision } from './closure.record';
export { stateFromEngine, closureItemOf, recordAfterDecision, reopenedFromDone } from './closure.record';

// ===========================================================================
// Re-evaluation writer (BE-REEVAL): the `reevaluate` job (src/jobs/handlers/reevaluate.ts)
// ===========================================================================

/** The job the pass runs for. `id` null = a direct call (no watermark is stored). */
export interface ReevalJobRef {
  id: number | null;
  /** The work item generation the job was enqueued for (W3 fence). Null = no fence. */
  generation: number | null;
}

export interface ReevaluateOptions {
  db: Db;
  userId: string;
  workItemId: string;
  job: ReevalJobRef;
  /** The job's abort signal: cancel, timeout, shutdown. Checked between writes; an abort rolls everything back. */
  signal?: AbortSignal;
  clock?: () => Date;
  /** Test seam: runs inside the change set after each written step (e.g. to abort mid-run). */
  onStep?: (index: number) => Promise<void> | void;
}

/** What one evaluation decided for one evidence link. */
export interface ReevalDecisionLine {
  evidenceId: string | null;
  kind: ClosureDecision['kind'];
  to: WorkItemStatus | null;
  reason: string;
  ruleKey: string | null;
}

/** Stored in `jobs.result.reeval` (never undone with the change set): what the next pass starts after. */
export interface ReevalWatermark {
  at: string;
  generation: number | null;
  evidenceIds: string[];
}

export interface ReevalWritten {
  outcome: 'nothing_new' | 'evaluated' | 'written';
  workItemId: string;
  generation: number | null;
  /** The undoable change set (the Undo target); null when nothing was written. */
  changeSetId: string | null;
  newEvidence: number;
  decisions: ReevalDecisionLine[];
  transitions: number;
  proposalIds: string[];
  siblingIds: string[];
  followUpJobIds: number[];
  plan: string[];
  watermark: ReevalWatermark | null;
}

export type ReevaluateOutcome =
  | { outcome: 'missing'; workItemId: string }
  | { outcome: 'stale' | 'cancelled'; workItemId: string; reason: string; generation: number | null; current: number | null }
  | ReevalWritten;

/** change_sets.actor_ref of every re-evaluation write (actor `engine:reeval`). */
export const REEVAL_ACTOR = 'reeval';

/** Thrown inside the transaction to roll it back with an outcome. */
class Abandon extends Error {
  override name = 'ReevalAbandon';
  constructor(readonly result: ReevaluateOutcome) {
    super(result.outcome);
  }
}

const SOURCE: Record<string, SignalSource> = {
  slack: 'slack',
  gmail: 'gmail',
  calendar: 'calendar',
  drive: 'drive',
  gemini_notes: 'gemini',
  org62: 'org62',
  vdp: 'vdp',
  claude: 'claude',
  manual: 'manual',
};

const iso = (v: unknown): string => new Date(v as string).toISOString();

interface EvidenceRow extends EvidenceLink {
  sourceItemId: string | null;
  extractorId: string;
  confidenceNum: number;
  actorPersonId: string | null;
}

interface PassContext {
  rc: ReadCtx;
  rec: WorkItemRecord;
  evidence: EvidenceRow[];
  fresh: EvidenceRow[];
  pass: ReevalPass;
}

type Fenced = { current: number } | ReevaluateOutcome;

async function lockAndFence(tx: Tx, o: ReevaluateOptions): Promise<Fenced> {
  const r = await tx.execute<{ g: string }>(sql`
    select reeval_generation as g from work_items where id = ${o.workItemId} and owner_user_id = ${o.userId} for update`);
  if (!r.rows[0]) return { outcome: 'missing', workItemId: o.workItemId };
  const current = Number(r.rows[0].g);
  const job = o.job.id === null ? undefined : (await tx.execute<{ c: string | null }>(sql`select cancel_requested_at as c from jobs where id = ${o.job.id}`)).rows[0];
  if (o.signal?.aborted) return { outcome: 'cancelled', workItemId: o.workItemId, reason: 'aborted', generation: o.job.generation, current };
  const verdict = shouldCommit({ generation: o.job.generation ?? current, cancelRequestedAt: job?.c ?? null }, { reevalGeneration: current, version: 0 });
  if (!verdict.commit) {
    return {
      outcome: verdict.reason === 'cancel_requested' ? 'cancelled' : 'stale',
      workItemId: o.workItemId,
      reason: verdict.reason === 'cancel_requested' ? 'cancel requested' : `${verdict.reason}: job generation ${o.job.generation}, item ${current}`,
      generation: o.job.generation,
      current,
    };
  }
  return { current };
}

async function readCtx(tx: Tx, userId: string, now: Date): Promise<ReadCtx> {
  const db = tx as unknown as Db;
  const kv = await loadKv(db, userId);
  const u = (
    await tx.execute<{ person_id: string | null; display_name: string | null; timezone: string | null }>(sql`
      select person_id, display_name, timezone from users where id = ${userId}`)
  ).rows[0];
  const base = { db, userId, kv };
  const { managerId } = await loadPeople(base);
  const people = await loadPersonRefs(base, managerId);
  return {
    db,
    userId,
    me: { id: u?.person_id ?? userId, name: u?.display_name ?? readMeta({ kv })?.user.name ?? 'Me' },
    timezone: u?.timezone ?? 'UTC',
    kv,
    people,
    now,
  };
}

/** Exported for tests (DONE-1). */
export async function loadEvidenceRows(tx: Tx, workItemId: string, me: { id: string; name: string }): Promise<EvidenceRow[]> {
  const r = await tx.execute<{
    id: string;
    role: EvidenceLink['role'];
    confidence: number;
    rationale: string | null;
    created_at: string;
    source_item_id: string | null;
    extractor_id: string;
    source: string | null;
    occurred_at: string | null;
    from_me: boolean | null;
    actor_person_id: string | null;
    actor_name: string | null;
    actor_is_me: boolean | null;
    file_ref: string | null;
  }>(sql`
    select e.id, e.role, e.confidence::float8 as confidence, e.rationale, e.created_at, e.source_item_id, e.extractor_id,
           si.source, si.occurred_at, si.from_me, si.actor_person_id,
           -- DONE-1: meta.author is a person object ({name, email, externalId, isMe}) on scanner records; its text form
           -- leaked into "Done by {…}" (and showed an email) when the author was not resolved to a person.
           coalesce(p.display_name, case when jsonb_typeof(si.meta -> 'author') = 'object' then si.meta -> 'author' ->> 'name' else si.meta ->> 'author' end) as actor_name,
           coalesce(p.is_me, case when jsonb_typeof(si.meta -> 'author') = 'object' then (si.meta -> 'author' ->> 'isMe')::boolean end) as actor_is_me,
           coalesce(si.asset_id::text, case when si.source = 'drive' then coalesce(si.external_parent_id, si.external_id) end) as file_ref
      from work_item_evidence e
      left join source_items si on si.id = e.source_item_id
      left join people p on p.id = si.actor_person_id
     where e.work_item_id = ${workItemId}
     order by coalesce(si.occurred_at, e.created_at), e.created_at, e.id`);
  return r.rows.map((x) => {
    const isMe = x.from_me === true || x.actor_is_me === true || (!!x.actor_person_id && x.actor_person_id === me.id);
    const actor: PersonLite | undefined = isMe
      ? { name: me.name, isMe: true }
      : x.actor_person_id || x.actor_name
        ? { ...(x.actor_person_id ? { id: x.actor_person_id } : {}), name: x.actor_name ?? 'someone' }
        : undefined;
    const source = x.source ? SOURCE[x.source] : undefined;
    return {
      id: x.id,
      role: x.role,
      confidence: numToConf(Number(x.confidence)),
      confidenceNum: Number(x.confidence),
      reason: x.rationale,
      at: iso(x.occurred_at ?? x.created_at),
      linkedAt: iso(x.created_at),
      ...(source ? { source } : {}),
      ...(actor ? { actor } : {}),
      fileRef: x.file_ref,
      sourceItemId: x.source_item_id,
      extractorId: x.extractor_id,
      actorPersonId: isMe ? null : x.actor_person_id,
    };
  });
}

async function lastWatermark(tx: Tx, userId: string, workItemId: string): Promise<ReevalWatermark | null> {
  const r = await tx.execute<{ wm: ReevalWatermark }>(sql`
    select result -> 'reeval' as wm from jobs
     where owner_user_id = ${userId} and kind = 'reevaluate' and result ? 'reeval'
       and (dedupe_key = ${reevalDedupeKey(workItemId)} or payload ->> 'work_item_id' = ${workItemId})
     order by (result -> 'reeval' ->> 'at')::timestamptz desc nulls last, id desc
     limit 1`);
  return r.rows[0]?.wm ?? null;
}

async function closureSettings(tx: Tx, userId: string) {
  const keys = Object.values(CLOSURE_SETTING_KEYS);
  const r = await tx.execute<{ key: string; value: unknown }>(sql`
    select key, value from user_settings where owner_user_id = ${userId}
       and key in (${sql.join(
         keys.map((k) => sql`${k}`),
         sql`, `,
       )})`);
  return closureSettingsFrom(Object.fromEntries(r.rows.map((x) => [x.key, x.value])));
}

/** Everything one pass needs, read inside the caller's transaction (the item row is already locked). */
async function passContext(tx: Tx, o: ReevaluateOptions, now: Date): Promise<PassContext | null> {
  const rc = await readCtx(tx, o.userId, now);
  const [rec] = await loadWorkItems(rc, [o.workItemId]);
  if (!rec) return null;
  const row = (
    await tx.execute<{
      closure_kind: ClosureKind;
      closure_target: string | null;
      status_changed_at: string;
      reopened_count: number;
      last_reopened_at: string | null;
      parent_id: string | null;
      has_draft: boolean;
      draft_user_locked: boolean;
    }>(sql`
      select w.closure_kind, w.closure_target, w.status_changed_at, w.reopened_count, w.last_reopened_at, w.parent_id,
             (n.draft_id is not null) as has_draft, coalesce(d.edited_by_user, false) as draft_user_locked
        from work_items w
        left join next_best_actions n on n.id = w.current_nba_id
        left join drafts d on d.id = n.draft_id
       where w.id = ${o.workItemId}`)
  ).rows[0]!;
  const evidence = await loadEvidenceRows(tx, o.workItemId, rc.me);
  const wm = await lastWatermark(tx, o.userId, o.workItemId);
  // Since the last evaluation. Before the first one: since the item's last status change (what was linked
  // before that was already accounted for by whoever moved it).
  const seen = wm ? new Set(wm.evidenceIds) : null;
  const statusChangedAt = Date.parse(iso(row.status_changed_at));
  const fresh = evidence.filter((e) => (seen ? !seen.has(e.id) : Date.parse(e.linkedAt) > statusChangedAt));
  // R1: the correction rule Settle uses too (reopened, kept, Not done, ask-first lists), computed by the same query.
  const facts = (await loadCorrectionFacts(tx, o.userId, [o.workItemId])).get(o.workItemId);
  const block = facts ? autoCloseBlock(facts, await loadClosingSettings(tx, o.userId)) : null;
  const item: ClosureItem = {
    ...closureItemOf(rec, rc.me),
    mayAutoClose: block === null,
    autoCloseBlock: block,
    statusChangedAt: iso(row.status_changed_at),
    closureKind: row.closure_kind,
    closureTarget: row.closure_target,
    parentId: row.parent_id,
    reopenedCount: Number(row.reopened_count),
    lastReopenedAt: row.last_reopened_at ? iso(row.last_reopened_at) : null,
  };
  const pass = runReevalPass({
    item,
    signals: fresh.map(signalFromEvidence),
    settings: await closureSettings(tx, o.userId),
    draft: { hasDraft: row.has_draft, draftUserLocked: row.draft_user_locked },
  });
  return { rc, rec, evidence, fresh, pass };
}

async function writeWatermark(tx: Tx, jobId: number | null, ctx: PassContext, generation: number | null): Promise<ReevalWatermark | null> {
  if (jobId === null) return null;
  const ids = ctx.evidence.map((e) => e.id);
  const r = await tx.execute<{ wm: ReevalWatermark }>(sql`
    update jobs set result = coalesce(result, '{}'::jsonb)
                         || jsonb_build_object('reeval', jsonb_build_object('at', clock_timestamp(), 'generation', ${generation}::bigint,
                                                                            'evidenceIds', ${JSON.stringify(ids)}::jsonb)),
                    updated_at = now()
     where id = ${jobId}
    returning result -> 'reeval' as wm`);
  return r.rows[0]?.wm ?? null;
}

const decisionLines = (p: ReevalPass): ReevalDecisionLine[] =>
  p.steps.map((s) => ({
    evidenceId: s.signal.evidenceId,
    kind: s.decision.kind,
    to: s.decision.transition?.to ?? null,
    reason: s.decision.reason,
    ruleKey: s.decision.reopenDecision?.ruleKey ?? null,
  }));

const noRunLinks = (assets: Set<string>): WorkLinkTargets => ({ runLinks: () => [], hasAsset: (a) => assets.has(a) });

/** A proposal group ("New info → update?") for what the machine would have written to a user-locked item. */
async function stageProposal(w: WriteCtx, cur: WorkItemRecord, d: ClosureDecision, ev: EvidenceRow | undefined, at: string): Promise<string | null> {
  if (!d.proposals.length) return null;
  const st = d.proposals.find((p) => p.field === 'status');
  const fieldChanges: FieldChange[] = d.proposals.filter((p) => p.field !== 'status').map((p) => ({ field: p.field as ClosureField, before: p.currentValue, after: p.proposedValue }));
  const res = fieldChanges.find((c) => c.field === 'resolution')?.after as Resolution | null | undefined;
  const resDetail = fieldChanges.find((c) => c.field === 'resolutionDetail')?.after as ResolutionDetail | null | undefined;
  const wanted: ClosureDecision = {
    ...d,
    kind: st ? 'transition' : 'update',
    transition: st ? { from: st.currentValue as WorkItemStatus, to: st.proposedValue as WorkItemStatus, actor: 'engine', reason: d.reason, evidenceId: ev?.id ?? null, autonomy: null } : null,
    fieldChanges,
    // enforceLocks drops the inferred resolution with the transition; the proposed close keeps it (R-UI-22)
    resolution: res && resDetail ? { resolution: res, detail: resDetail } : d.resolution,
  };
  const next = recordAfterDecision(cur, wanted, at, w.me);
  const a = workItemColumns(cur, w);
  const b = workItemColumns(next, w);
  const cols: Record<string, unknown> = {};
  for (const k of Object.keys(b) as (keyof typeof b)[]) {
    if (k === 'id' || k === 'ownerUserId' || k === 'origin') continue;
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) cols[k] = b[k];
  }
  if (!Object.keys(cols).length) return null;
  const groupId = crypto.randomUUID();
  const r = await engineUpdate(w.tx, workItems, cur.id, cols as never, {
    lockAll: true,
    reason: d.reason,
    groupId,
    provenance: ev ? { evidenceId: ev.id, extractorId: ev.extractorId, confidence: ev.confidenceNum, ...(ev.sourceItemId ? { sourceItemId: ev.sourceItemId } : {}) } : undefined,
  });
  if (!r.proposals.length) return null;
  await writeExt(w, 'change_proposals', groupId, { label: cur.title, labels: st ? { state: 'State' } : undefined });
  return groupId;
}

const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The sibling's record: a fresh open item under the same initiative, account and opportunity. */
function siblingRecord(cur: WorkItemRecord, d: ClosureDecision, ev: EvidenceRow | undefined, at: string, me: { id: string; name: string }): WorkItemRecord {
  const s = d.sibling!;
  const loopedBack = s.label.kind === 'looped_back_in';
  return {
    id: crypto.randomUUID(),
    version: 1,
    kind: s.kind,
    state: 'open',
    title: sentence(s.title),
    purpose: cur.purpose,
    initiativeId: s.initiativeId ?? cur.initiativeId,
    accountId: cur.accountId,
    oppId: cur.oppId,
    servesEventId: null,
    confidence: ev?.confidence ?? 'likely',
    // the label's "· Undo" is the inline action; the why line is the reason alone
    why: s.label.text.replace(/\s*·\s*Undo$/, ''),
    whyDetail: d.reopenDecision?.explanation ?? null,
    sources: cur.sources.slice(0, 1),
    effort: { youMin: 15, agentMin: 0 },
    startBy: null,
    due: null,
    createdAt: at,
    updatedAt: at,
    ageDays: 0,
    isBackground: false,
    rank: null,
    rankReasons: [],
    score: null,
    priority: cur.priority,
    signals: cur.signals,
    stale: null,
    userLockedFields: [],
    newEvidenceCount: 1,
    reevaluating: false,
    seenAt: null,
    nbaId: null,
    owner: { id: me.id, name: me.name },
    people: cur.people,
    waiting: null,
    snoozedUntil: null,
    snoozedFrom: null,
    doneAt: null,
    doneBy: null,
    closedReason: null,
    resolution: null,
    resolutionDetail: null,
    involvement: s.involvement,
    loopedBackIn: loopedBack && ev ? { at: ev.at, byPersonName: ev.actor?.name ?? 'someone', evidenceId: null } : null,
    likelyDone: null,
    reopened: null,
    dismissed: null,
    notes: '',
    enrichment: null,
    deliverable: null,
    training: null,
    runIds: [],
    assetIds: [],
    counterparty: cur.counterparty,
  };
}

/**
 * Re-evaluate one work item: its evidence links since the last evaluation go through the closure machine and
 * the planner (runReevalPass), and everything the pass decided is written as ONE `engine:reeval` change set:
 * transitions (work_item_transitions), field updates, proposals for user-locked fields, siblings and
 * reopen_decisions. Undo of that change set reverts all of it; the commit hook publishes the live events.
 *
 * Fences (W3, R-UI-20): the item row is locked FOR UPDATE and its reeval_generation must equal the job's
 * (a stale or future generation writes nothing); a cancel request on the job, or an aborted `signal`, rolls the
 * whole change set back (no partial writes). The watermark (which evidence was evaluated) goes into the job row
 * in the same transaction but outside the change set, so an Undo never makes the engine re-apply what was
 * undone. Follow-ups (`nba.generate`) are enqueued in the same transaction.
 */
export async function reevaluateWorkItem(o: ReevaluateOptions): Promise<ReevaluateOutcome> {
  const now = () => o.clock?.() ?? new Date();
  const extractorId = await ensureExtractor(o.db);

  // 1. Decide under the row lock. A pass that writes nothing records its watermark here, with no change set.
  const first = await o.db.transaction(async (tx): Promise<ReevaluateOutcome | null> => {
    const f = await lockAndFence(tx, o);
    if ('outcome' in f) return f;
    const ctx = await passContext(tx, o, now());
    if (!ctx) return { outcome: 'missing', workItemId: o.workItemId };
    if (ctx.pass.writes) return null;
    const watermark = await writeWatermark(tx, o.job.id, ctx, o.job.generation);
    return {
      outcome: ctx.fresh.length ? 'evaluated' : 'nothing_new',
      workItemId: o.workItemId,
      generation: o.job.generation,
      changeSetId: null,
      newEvidence: ctx.fresh.length,
      decisions: decisionLines(ctx.pass),
      transitions: 0,
      proposalIds: [],
      siblingIds: [],
      followUpJobIds: [],
      plan: ctx.pass.plan.steps.map((s) => s.step),
      watermark,
    };
  });
  if (first) return first;

  // 2. One engine:reeval change set, decided again inside it (the item may have moved in between).
  try {
    const { result, changeSetId } = await withChangeSet(
      { db: o.db, userId: o.userId, actor: actors.engine(REEVAL_ACTOR), reason: 'Re-evaluated with new info', entity: { type: 'work_item', id: o.workItemId } },
      async (tx, cs) => {
        const f = await lockAndFence(tx, o);
        if ('outcome' in f) throw new Abandon(f);
        const at = now();
        const ctx = await passContext(tx, o, at);
        if (!ctx) throw new Abandon({ outcome: 'missing', workItemId: o.workItemId });
        const atIso = at.toISOString();
        const w: WriteCtx = { tx, cs, userId: o.userId, me: ctx.rc.me, now: at, extractorId, timezone: ctx.rc.timezone, kv: ctx.rc.kv };
        const byId = new Map(ctx.evidence.map((e) => [e.id, e]));
        const assets = new Set((await tx.execute<{ id: string }>(sql`select id from assets where owner_user_id = ${o.userId}`)).rows.map((r) => r.id));
        const abortIf = () => {
          if (o.signal?.aborted) throw new Abandon({ outcome: 'cancelled', workItemId: o.workItemId, reason: 'aborted mid-run', generation: o.job.generation, current: f.current });
        };

        let cur = ctx.rec;
        let transitions = 0;
        const proposalIds: string[] = [];
        const siblingIds: Array<string | null> = [];
        for (const [i, step] of ctx.pass.steps.entries()) {
          siblingIds.push(null);
          const d = step.decision;
          if (d.kind === 'none') continue;
          abortIf();
          const ev = step.signal.evidenceId ? byId.get(step.signal.evidenceId) : undefined;
          const reopen = (outcome: 'reopened' | 'new_sibling', transitionId: number | null, newWorkItemId: string | null) =>
            tx.insert(reopenDecisions).values({
              ownerUserId: o.userId,
              doneWorkItemId: cur.id,
              triggerSourceItemId: ev?.sourceItemId ?? null,
              triggerEvidenceId: ev?.id ?? null,
              triggerPersonId: ev?.actorPersonId ?? null,
              outcome,
              ruleKey: d.reopenDecision!.ruleKey,
              explanation: d.reopenDecision!.explanation,
              newWorkItemId,
              initiativeId: cur.initiativeId,
              transitionId,
              confidence: ev?.confidenceNum ?? null,
              decidedBy: 'engine',
              changeSetId: cs.id,
            });
          if (d.kind === 'proposal') {
            const pid = await stageProposal(w, cur, d, ev, atIso);
            if (pid) proposalIds.push(pid);
          } else if (d.kind === 'sibling' && d.sibling) {
            const sib = siblingRecord(cur, d, ev, atIso, ctx.rc.me);
            await insertWorkItem(w, sib, noRunLinks(assets), { locks: [] });
            // the new item's provenance: the same source item, as its origin
            if (ev?.sourceItemId) {
              await tx
                .insert(workItemEvidence)
                .values({ workItemId: sib.id, sourceItemId: ev.sourceItemId, role: 'origin', confidence: ev.confidenceNum, extractorId: ev.extractorId, rationale: ev.reason, createdBy: 'engine' });
            }
            await tx.insert(workItemRelations).values({ fromWorkItemId: sib.id, toWorkItemId: cur.id, kind: 'follow_up_of', createdBy: 'engine' });
            // cites the trigger on the original item: Undo deletes the sibling's own evidence first, and a transition
            // pointing at it would be nulled (ON DELETE SET NULL), which the append-only guard refuses
            await logTransition(w, sib.id, null, 'open', d.sibling.label.text, ev?.id ?? null);
            // new_work_item_id is ON DELETE CASCADE (0007): undoing this change set deletes the sibling and the row with it
            if (d.reopenDecision) await reopen('new_sibling', null, sib.id);
            siblingIds[i] = sib.id;
          } else {
            const next = recordAfterDecision(cur, d, atIso, ctx.rc.me);
            const r = await updateWorkItem(w, cur, next, noRunLinks(assets), { bump: true });
            for (const p of r.proposals) if (!proposalIds.includes(p.proposalId)) proposalIds.push(p.proposalId);
            let transitionId: number | null = null;
            if (d.transition) {
              transitionId = await logTransition(w, cur.id, cur.state, next.state, d.transition.reason, ev?.id ?? null);
              if (transitionId !== null) transitions++;
            }
            if (d.reopenDecision?.outcome === 'reopened' && transitionId !== null) await reopen('reopened', transitionId, null);
            // locked side fields the machine proposed while the rest applied
            if (d.proposals.length) {
              const pid = await stageProposal(w, next, { ...d, transition: null, proposals: d.proposals.filter((p) => p.field !== 'status') }, ev, atIso);
              if (pid) proposalIds.push(pid);
            }
            cur = next;
          }
          await o.onStep?.(i);
        }
        abortIf();

        const watermark = await writeWatermark(tx, o.job.id, ctx, o.job.generation);
        const followUpJobIds: number[] = [];
        for (const fu of ctx.pass.followUps) {
          const target = 'workItemId' in fu.target ? fu.target.workItemId : siblingIds[fu.target.siblingOfStep];
          if (!target) continue;
          const j = await enqueueJob(tx, {
            ownerUserId: o.userId,
            kind: fu.kind,
            queue: 'nba',
            payload: { work_item_id: target, trigger: 'reeval', mode: fu.mode, reason: fu.reason.slice(0, 300), change_set_id: cs.id, steps: ctx.pass.plan.steps.map((s) => s.step) },
            dedupeKey: `nba:work_item:${target}`,
          });
          followUpJobIds.push(j.id);
        }
        await tx.execute(sql`update change_sets set summary = ${`${ctx.pass.summary}: ${ctx.rec.title}`.slice(0, 500)} where id = ${cs.id}`);

        // Last fence before commit: the job row is locked, so a cancel lands either before it (rollback) or after the commit.
        abortIf();
        if (o.job.id !== null) {
          const j = (await tx.execute<{ c: string | null }>(sql`select cancel_requested_at as c from jobs where id = ${o.job.id} for update`)).rows[0];
          if (j?.c) throw new Abandon({ outcome: 'cancelled', workItemId: o.workItemId, reason: 'cancel requested', generation: o.job.generation, current: f.current });
        }
        return {
          // decided again under the lock: the item may have moved so that nothing is left to write
          outcome: ctx.pass.writes ? ('written' as const) : ctx.fresh.length ? ('evaluated' as const) : ('nothing_new' as const),
          newEvidence: ctx.fresh.length,
          decisions: decisionLines(ctx.pass),
          transitions,
          proposalIds,
          siblingIds: siblingIds.filter((s): s is string => !!s),
          followUpJobIds,
          plan: ctx.pass.plan.steps.map((s) => s.step),
          watermark,
        };
      },
    );
    const [cs] = (await o.db.execute<{ undoable: boolean }>(sql`select undoable from change_sets where id = ${changeSetId}`)).rows;
    return { workItemId: o.workItemId, generation: o.job.generation, changeSetId: cs?.undoable ? changeSetId : null, ...result };
  } catch (e) {
    if (e instanceof Abandon) return e.result;
    throw e;
  }
}
