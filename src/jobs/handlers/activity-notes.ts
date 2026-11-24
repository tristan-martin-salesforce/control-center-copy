/**
 * `activity.notes` (queue `engine`): D-66, the cheap model's note for a Time row whose meeting has notes. Every row
 * already has the template's note (src/engines/activity/note.ts, projected with the row); where Gemini notes exist,
 * one Haiku call turns them into a 1–2 sentence teammate's note (what was done, with whom by role or team, the use
 * case, the agreed next step). The answer is kept on the meeting note's side-car (`cc.ext/meeting_notes/<id>`
 * `logSummary`, keyed by the notes and the facts the prompt names), and the row's week is projected again, so the
 * row carries it (`logNoteBasis: summary`). A note you edited is yours: its row is never asked about again.
 *
 * Picked: notes of the last 21 days on a meeting whose row waits to be logged (needs input, proposed, approved; not
 * on a canvas, note not edited) and whose cached answer is missing or was made from other notes or facts. In pages of
 * 12 calls, each capped at $0.01 (Haiku), the page at $0.10; a page that stops with notes still due queues the next
 * page (src/jobs/pass-pages.ts, caps audit 2026-11-21). Cost (COST-1): the daily hard cap is checked
 * before every call; at the cap nothing is called (`deferred_budget`) and the template stays. Each call is one
 * llm_calls row (purpose `summarize`, skill `activity-note`, the daily budget). An unusable answer (SKIP, a refusal)
 * is cached as none, so the same notes never cost twice; a failed call is not cached (the next pass tries again).
 *
 * Live only in the launchd worker (CC_LIVE / production) unless a test injects the model. jobs.result holds counts
 * and codes only, never note text.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { insertLlmCall, ledgerHash } from '@/db/ledger';

import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { NOTE_PROMPT_VERSION, noteSummaryKey, noteSummaryRequest, parseNoteSummary, pickUseCase, type NoteFacts, type UseCaseOption } from '@/engines/activity/note';
import { localDay } from '@/engines/activity/time';
import { SCANNER_MODEL } from '@/llm/models';
import { oppIdsOf, type VdpSnapshot } from '@/lib/vdp/types';
import { meetingNoteExtKey, recomputeWeeks } from '@/projections/run';
import { id15 } from '@/projections/util';
import { agentSdkCompletionModel } from '@/scanner/completion/llm';
import type { CompletionModel } from '@/scanner/completion/types';
import { DbScannerStore } from '@/scanner/store-db';
import { putKv } from '@/server/datasource/db/ext';

import { nextPageDue, queueNextPage } from '../pass-pages';
import { QUEUES } from '../registry';
import type { JobContext, JobHandlerDef } from '../types';
import { projectionStore } from '@/server/datasource/db/store/projections.run';

export const ACTIVITY_NOTES_JOB = 'activity.notes';
export const ACTIVITY_NOTES_SKILL = 'activity-note';
const ACTIVITY_NOTES_ENGINE = 'activity-notes@1';
export const activityNotesDedupeKey = (userId: string) => `activity.notes:${userId}`;

const LOOKBACK_DAYS = 21;
/** A page (not a cap): the next page is queued while notes are due. */
const MAX_CALLS = 12;
const PER_CALL_USD = 0.01;
/** The page's $ line (a page boundary too); the daily hard cap is the budget. */
const PER_PASS_USD = 0.1;

export interface ActivityNotesDeps {
  /** The model seam (tests pass a fake; it also turns the job on outside the launchd worker). */
  model?: CompletionModel;
  maxCalls?: number;
}

let deps: ActivityNotesDeps = {};
export function configureActivityNotes(d: ActivityNotesDeps): void {
  deps = { ...deps, ...d };
}
export function resetActivityNotesConfig(): void {
  deps = {};
}

const live = () => process.env.CC_LIVE === '1' || (process.env.CC_LIVE === undefined && process.env.NODE_ENV === 'production');

/** Queue one pass (after new meeting notes; one queued at a time). */
export async function enqueueActivityNotes(db: Db, userId: string, trigger: string): Promise<boolean> {
  const r = await enqueueJob(db, { ownerUserId: userId, kind: ACTIVITY_NOTES_JOB, queue: QUEUES.engine, payload: { trigger }, dedupeKey: activityNotesDedupeKey(userId), maxAttempts: 2, timeoutSeconds: 900 });
  return r.inserted;
}

type Candidate = {
  note_id: string;
  body: string;
  event_title: string | null;
  external_domains: string[] | null;
  starts_at: Date | string;
  subject: string;
  what_name: string | null;
  what_org62_id: string | null;
  task_type: string | null;
  cached_key: string | null;
};

/** The notes worth a call: on a meeting whose row waits to be logged with the app's note, newest first, one per notes doc. */
async function candidates(db: Db, userId: string, now: Date): Promise<Candidate[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const r = await db.execute<Candidate>(sql`
    select distinct on (n.id) n.id as note_id, si.body, e.title as event_title, e.external_domains, e.starts_at,
           a.subject, a.what_name, a.what_org62_id, t.name as task_type, x.value -> 'logSummary' ->> 'key' as cached_key
      from meeting_notes n
      join source_items si on si.id = n.source_item_id
      join calendar_events e on e.id = n.calendar_event_id
      join activity_entries a on a.owner_user_id = n.owner_user_id
                             and starts_with(a.dedupe_key, 'cal|' || e.calendar_id || '|' || e.external_event_id || '|')
      left join se_task_types t on t.id = a.se_task_type_id
      left join user_settings x on x.owner_user_id = n.owner_user_id and x.key = 'cc.ext/meeting_notes/' || n.id::text
     where n.owner_user_id = ${userId} and n.arrived_at >= ${since}::timestamptz
       and si.body is not null and si.deleted_upstream_at is null
       and a.status in ('needs_input', 'proposed', 'approved') and a.synced_to_canvas_at is null
       and not ('log_note' = any(coalesce(a.user_locked_fields, '{}')))
     order by n.id, a.starts_at`);
  return r.rows.sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)));
}

async function vdpUseCasesByOpp(db: Db, userId: string): Promise<Map<string, UseCaseOption[]>> {
  const out = new Map<string, UseCaseOption[]>();
  const r = await db.execute<{ detail: VdpSnapshot | null }>(sql`select detail from vdp_records where owner_user_id = ${userId} and gone_at is null and not archived and detail is not null`);
  for (const { detail } of r.rows) {
    if (!detail?.useCases?.length) continue;
    for (const opp of oppIdsOf(detail)) out.set(id15(opp), [...(out.get(id15(opp)) ?? []), ...detail.useCases.map((u) => ({ title: u.title, priority: u.priority }))]);
  }
  return out;
}

/** The same facts the projection's template reads (src/projections/activity.ts noteFactsOf), for a meeting. */
function factsOf(c: Candidate, useCases: Map<string, UseCaseOption[]>): NoteFacts {
  const subject = c.event_title ?? c.subject;
  const opts = c.what_org62_id ? (useCases.get(id15(c.what_org62_id)) ?? []) : [];
  return {
    kind: 'meeting',
    subject,
    taskType: c.task_type,
    customer: c.what_name ? c.what_name.split(' - ')[0]!.trim() || null : null,
    externalDomains: c.external_domains ?? [],
    useCase: opts.length ? pickUseCase(opts, subject) : null,
  };
}

async function recordCall(ctx: JobContext, day: string, c: { model: string; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; ok: boolean; errorCode?: string; latencyMs: number; contentHash: string }) {
  const finished = new Date();
  await insertLlmCall(ctx.db, {
    ownerUserId: ctx.userId,
    purpose: 'summarize',
    model: c.model,
    skillKey: ACTIVITY_NOTES_SKILL,
    promptVersion: NOTE_PROMPT_VERSION,
    requestHash: `${ACTIVITY_NOTES_SKILL}:${ctx.job.id}:${randomUUID()}`,
    jobId: ctx.job.id,
    status: c.ok ? 'ok' : 'error',
    errorCode: c.errorCode ?? null,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheReadTokens: c.cacheReadTokens ?? 0,
    cacheWriteTokens: c.cacheWriteTokens ?? 0,
    costUsd: c.costUsd,
    latencyMs: c.latencyMs,
    budgetDay: day,
    budget: 'daily',
    startedAt: new Date(finished.getTime() - c.latencyMs),
    finishedAt: finished,
    rollup: false,
    trigger: typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : 'schedule',
    modelReason: 'default',
    contentHash: c.contentHash,
    outcome: c.ok ? 'ok' : (c.errorCode ?? 'error'),
  });
}

export async function runActivityNotes(ctx: JobContext, d: ActivityNotesDeps = deps): Promise<Record<string, unknown>> {
  if (!d.model && !live()) return { skipped: 'not_live', note: 'Meeting-note summaries run in the launchd worker only (CC_LIVE)' };
  const now = ctx.clock();
  const tz = (await ctx.db.execute<{ tz: string | null }>(sql`select timezone as tz from users where id = ${ctx.userId}`)).rows[0]?.tz ?? 'UTC';
  const all = await candidates(ctx.db, ctx.userId, now);
  const useCases = all.length ? await vdpUseCasesByOpp(ctx.db, ctx.userId) : new Map<string, UseCaseOption[]>();
  const due = all.map((c) => ({ c, facts: factsOf(c, useCases) })).map((x) => ({ ...x, key: noteSummaryKey({ facts: x.facts, notes: x.c.body }) })).filter((x) => x.key !== x.c.cached_key);
  if (!due.length) return { status: 'nothing_to_do', candidates: all.length, summarized: 0 };
  const store = new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
  const model = d.model ?? agentSdkCompletionModel({ timeoutMs: 60_000 });
  const day = localDay(now.getTime(), tz);
  const maxCalls = d.maxCalls ?? MAX_CALLS;
  let calls = 0;
  let spent = 0;
  let summarized = 0;
  let skipped = 0;
  let failed = 0;
  let deferred: string | null = null;
  let atPage = false;
  const days = new Set<string>();
  for (const { c, facts, key } of due) {
    if (calls >= maxCalls || spent + PER_CALL_USD > PER_PASS_USD) {
      atPage = true;
      break;
    }
    // COST-1: the daily hard cap first; at the cap nothing is called and the template stays
    if ((await store.budgetStatus()).state === 'capped') {
      deferred = 'daily_hard_cap';
      break;
    }
    if (ctx.signal.aborted) break;
    const req = noteSummaryRequest({ facts, notes: c.body });
    const started = Date.now();
    const out = await model({ system: req.system, user: req.user, model: SCANNER_MODEL, effort: 'low', maxBudgetUsd: PER_CALL_USD, signal: ctx.signal });
    calls += 1;
    spent += Math.max(0, out.costUsd || 0);
    await recordCall(ctx, day, { model: SCANNER_MODEL, costUsd: out.costUsd, inputTokens: out.inputTokens, outputTokens: out.outputTokens, cacheReadTokens: out.cacheReadTokens ?? 0, cacheWriteTokens: out.cacheWriteTokens ?? 0, contentHash: ledgerHash(SCANNER_MODEL, NOTE_PROMPT_VERSION, req.system, req.user), ok: out.ok, ...(out.ok ? {} : { errorCode: out.error?.errorClass ?? 'unknown' }), latencyMs: Date.now() - started }).catch(() => undefined);
    void ctx.heartbeat().catch(() => undefined);
    if (!out.ok) {
      failed += 1;
      continue;
    }
    const note = parseNoteSummary(out.text);
    if (note) summarized += 1;
    else skipped += 1;
    // the answer (or none: SKIP) is kept for these notes and facts, so they never cost a second call
    const extK = meetingNoteExtKey(c.note_id);
    await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.engine(ACTIVITY_NOTES_ENGINE), reason: 'Meeting notes: the Org62 Description note', undoable: false }, async (tx) => {
      const prev = (await tx.execute<{ value: Record<string, unknown> }>(sql`select value from user_settings where owner_user_id = ${ctx.userId} and key = ${extK}`)).rows[0]?.value ?? {};
      await putKv(tx, ctx.userId, extK, { ...prev, logSummary: { key, note, model: SCANNER_MODEL, at: now.toISOString() } }, prev);
    });
    days.add(localDay(new Date(c.starts_at).getTime(), tz));
  }
  // the rows of those meetings take the new note now (their weeks are projected again)
  const re = days.size ? await recomputeWeeks({ store: projectionStore(ctx.db), userId: ctx.userId, days: [...days], now }) : { weeks: [], errors: [] };
  const more = nextPageDue({ stoppedAtPage: atPage, left: due.length - calls, progressed: summarized + skipped, aborted: ctx.signal.aborted });
  const nextPage = more ? await queueNextPage(ctx, { kind: ACTIVITY_NOTES_JOB, queue: QUEUES.engine, dedupeKey: activityNotesDedupeKey(ctx.userId), maxAttempts: 2, timeoutSeconds: 900 }) : false;
  return { status: deferred ? 'deferred_budget' : 'done', candidates: all.length, due: due.length, calls, summarized, skipped, failed, costUsd: Math.round(spent * 10_000) / 10_000, weeks: re.weeks.length, ...(deferred ? { deferred } : {}), ...(more ? { more, nextPage } : {}), ...(re.errors.length ? { errors: re.errors } : {}) };
}

export function activityNotesJobDef(): JobHandlerDef {
  return { kind: ACTIVITY_NOTES_JOB, queue: QUEUES.engine, wired: true, spends: true, description: 'D-66: the cheap model’s Org62 Description note for Time rows whose meetings have notes (under the daily hard cap)', handler: (ctx) => runActivityNotes(ctx) };
}

/**
 * The worker's hook: a pass after new or changed meeting notes (and one after each start). The job's dedupe key keeps
 * one queued; with nothing due it is a read.
 */
export function activityNotesHook(db: Db, userId: string, log: (msg: string, f?: Record<string, unknown>) => void, o: { everyMs?: number } = {}) {
  let seen: string | null | undefined;
  return {
    name: 'activity.notes',
    everyMs: o.everyMs ?? 5 * 60_000,
    run: async () => {
      try {
        const r = await db.execute<{ last: Date | string | null }>(sql`select max(updated_at) as last from meeting_notes where owner_user_id = ${userId}`);
        const last = r.rows[0]?.last ? new Date(r.rows[0].last).toISOString() : null;
        if (last === seen) return;
        seen = last;
        if (!last) return;
        if (await enqueueActivityNotes(db, userId, 'notes')) log('activity.notes: queued after new meeting notes');
      } catch (err) {
        log('activity.notes: could not queue a pass', { code: (err as Error).name });
      }
    },
  };
}
