/**
 * time_ready_to_log: unlogged time is one fact, so one row (01 R1), never one per activity row: the live rows not on a
 * canvas yet (GET /time/log), what they still need (an opportunity, a task type, hours, a check) and the logging
 * canvases waiting for your Apply (the Outbox's admin items, D-52). Open lands on the Activity tab that holds the
 * work: Needs you while rows need a fix, else Log it. Logging itself stays on Activity (one "Log N" button), so
 * nothing here logs or applies anything. Internal-only rows the app suggests (D-64) are never a need.
 */
import type { ActivityEntry, NeedRow } from '@/contract';
import { adminSurfaceOf } from '@/contract';
import { appliedRowIds, openNeedOf, toLogLanes } from '@/engines/activity/to-log-count';
import { rowsIn, toLogBase, toLogRange } from '@/engines/activity/to-log-rows';
import { isSnoozed, laterVerb, needRow, sinceOf, verb } from '../row';
import type { NeedProvider, NeedsContext } from '../types';
import { KIND_URGENCY } from '../urgency';
import { hasTarget } from '@/lib/time-internal';

const LIVE = new Set<ActivityEntry['status']>(['needs_input', 'proposed', 'approved']);
const SOURCE_ID = 'activity';

const r2 = (n: number) => Math.round(n * 100) / 100;
const hrs = (h: number) => `${r2(h)} h`;
const rows = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;
const batches = (n: number) => `${n} ${n === 1 ? 'batch' : 'batches'}`;

/**
 * A live row that cannot log without you (the same test as Activity ▸ Needs you): no opportunity (and not internal),
 * no task type where the persona needs one, zero hours, or held by the scan.
 */
export function needsFix(e: Pick<ActivityEntry, 'status' | 'oppId' | 'internal' | 'durationH' | 'taskType'>, taskTypeRequired = true): boolean {
  return e.status === 'needs_input' || !hasTarget(e) || (taskTypeRequired && !e.taskType) || e.durationH <= 0;
}

/** Activity's one count (src/components/time/lanes-derive.ts lanesOf `badge`): fix rows plus sending failures. */
export function timeNeedCount(n: { fix: number; notFound: number; failedBatches: number }): number {
  return n.fix + n.notFound + n.failedBatches;
}

export const timeReadyProvider: NeedProvider = {
  kind: 'time_ready_to_log',
  feature: 'activityLogging',
  run(ctx: NeedsContext): NeedRow[] {
    if (isSnoozed(ctx, 'time_ready_to_log', SOURCE_ID)) return [];
    const req = ctx.taskTypeRequired ?? true;
    // F1 (2026-11-23 lanes review, R2-1): To log's one row set (src/engines/activity/to-log-rows.ts) and its one rule
    // (to-log-count.ts), the same inputs Activity's lanes and the sidebar's navCounts.toLog read: no row that needs
    // you is counted here and shown on no page, and no row on the page is missing here
    const today = new Date(ctx.nowMs + ctx.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
    const all = ctx.activity?.entries ?? [];
    const set = rowsIn(all, toLogRange({ rows: all, canvases: ctx.canvases, taskTypeRequired: req, base: toLogBase(today) }));
    const applied = appliedRowIds(ctx.canvases);
    const live = set.filter((e) => LIVE.has(e.status) && !e.canvasDraftId && !applied.has(e.id) && !(e.internal && e.status === 'proposed'));
    // R3-8 (wave-2 review): the parts below the number are lane 2 and lane 3 as Activity counts them: lane 2's ready
    // rule (Settings ▸ approve complete included) and lane 3's open batches, from the same row set and batches
    const n = toLogLanes({ rows: set, canvases: ctx.canvases, nowMs: ctx.nowMs, taskTypeRequired: req, approveComplete: ctx.approveComplete });
    const fix = set.filter((e) => openNeedOf(e, applied, req) === 'fix' && !e.internal);
    // D-65: a row handed to Slackbot that Org62 does not have after all needs you too (Log again or Leave out)
    const relog = set.filter((e) => openNeedOf(e, applied, req) === 'org62');
    const ready = n.ready;
    const canvases = (ctx.outbox?.admin.items ?? []).filter((i) => adminSurfaceOf(i.draft) === 'log');
    // C6: lane 3's batches (NeedsContext.canvases) when known: waiting for your Apply (the verb), open in Sending, failed
    const waiting = ctx.canvases ? ctx.canvases.filter((c) => c.state === 'pending').length : canvases.length;
    const sending = ctx.canvases ? n.sending : canvases.length;
    const failedBatches = n.failedBatches;
    if (!live.length && !relog.length && !canvases.length && !sending && !failedBatches) return [];
    // C7: the row's number is Activity's badge, lanesOf's `fix.rows + sending.failed` (fix rows, rows not found in
    // Org62, batches that failed); ready and suggested rows are never counted as needing you
    const need = n.badge;
    const toLog = ready.length;
    const hours = r2((need ? [...fix, ...relog] : ready).reduce((s, e) => s + e.durationH, 0));
    const parts = [
      fix.length ? `${rows(fix.length)} need a fix` : null,
      relog.length ? `${relog.length} not found in Org62` : null,
      ready.length ? `${ready.length} ready` : null,
      sending ? `${batches(sending)} in Sending` : null,
      failedBatches ? `${batches(failedBatches)} failed` : null,
    ].filter(Boolean);
    const title = need ? `${need} to fix in Activity${hours ? ` (${hrs(hours)})` : ''}` : toLog ? `Log ${rows(toLog)} of activity (${hrs(hours)})` : `Apply ${waiting === 1 ? 'the logging batch' : `${waiting} logging batches`}`;
    return [
      needRow({
        kind: 'time_ready_to_log',
        sourceId: SOURCE_ID,
        title,
        why: parts.join(' · '),
        verbs: [
          verb({ id: 'open', label: fix.length || relog.length || failedBatches ? 'Fix rows' : waiting && !ready.length ? 'Apply' : 'Log', kbd: 'a', primary: true, href: fix.length ? '/activity?view=needs' : relog.length || failedBatches || (waiting && !ready.length) ? '/activity#time-runs' : '/activity?view=week', feature: 'activityLogging' }),
          laterVerb('time_ready_to_log', SOURCE_ID, 'Activity to log', ctx, 'activityLogging'),
        ],
        groupKey: 'admin',
        urgency: waiting || failedBatches ? 0.6 : KIND_URGENCY.time_ready_to_log,
        since: sinceOf([...[...live, ...relog].map((e) => e.end), ...canvases.map((c) => c.draft.createdAt)], ctx.nowMs),
        estimateMin: Math.max(1, fix.length + relog.length + (ready.length ? 2 : 0) + (waiting + failedBatches) * 2),
      }),
    ];
  },
};
