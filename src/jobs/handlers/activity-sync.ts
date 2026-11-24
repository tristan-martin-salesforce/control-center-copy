/**
 * `activity.sync` (daily 17:30, src/worker/schedules.ts): Settings ▸ Time ▸ Logging.
 *
 *   automatic, on a weekday → stage the logging batch: one Outbox canvas item per work order, waiting for the user's
 *                             one-click Apply (the approval gate only accepts a click; D-47/D-48). A day that already
 *                             has a staged batch, or nothing ready, stages nothing.
 *   on demand               → nothing to do here: a batch is staged only when the user starts one.
 *
 * The Org62 check (handed off but missing, hours or WhatId that differ) is derived on every read, so it runs in both
 * modes without a job (src/server/datasource/db/store/log-check.ts).
 */
import { sql } from 'drizzle-orm';

import type { DbHandle } from '@/db/client';
import type { JobHandler, JobHandlerDef } from '@/jobs/types';
import { DbDataSource } from '@/server/datasource/db';

export interface ActivitySyncDeps {
  handle: DbHandle;
  /** Tests: the staging call (default: the db DataSource's stageLogBatch). */
  stage?: (userId: string) => Promise<{ draftIds: string[]; events: number; hours: number }>;
}

const WEEKDAY = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

export function activitySyncHandler(deps: ActivitySyncDeps): JobHandler {
  return async (ctx) => {
    const r = await ctx.db.execute<{ time: { logging?: { mode?: string } } | null; profile: { timezone?: string } | null; staged: number }>(sql`
      select (select value from user_settings where owner_user_id = ${ctx.userId} and key = 'settings.time') as time,
             (select value from user_settings where owner_user_id = ${ctx.userId} and key = 'settings.profile') as profile,
             (select count(*)::int from drafts d where d.owner_user_id = ${ctx.userId} and d.channel = 'slack_canvas' and d.status = 'ready'
                and d.created_at > now() - interval '20 hours') as staged`);
    const row = r.rows[0];
    const mode = row?.time?.logging?.mode ?? 'on_demand';
    if (mode !== 'automatic') return { skipped: 'on_demand' };
    const tz = row?.profile?.timezone ?? 'UTC';
    const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(ctx.clock());
    if (!WEEKDAY.has(day)) return { skipped: 'weekend' };
    if ((row?.staged ?? 0) > 0) return { skipped: 'already_staged' };
    const stage = deps.stage ?? (async (userId: string) => (await new DbDataSource({ handle: deps.handle, userId }).stageLogBatch({ body: {} } as never)).entity);
    const res = await stage(ctx.userId);
    ctx.log('logging batch staged', { canvases: res.draftIds.length, rows: res.events });
    return { staged: res.draftIds.length, rows: res.events, hours: res.hours };
  };
}

/**
 * 06 R9: the Org62 re-checks a created logging canvas gets, queued by the `outbox.dispatch` job right after Apply
 * (src/outbox/job.ts `onCanvasApplied`; wired in src/worker/index.ts). The same call the "Copy Slackbot prompt" click
 * makes, with reason `applied` (reads about 5, 15, 30 and 60 minutes later, deduped per minute, without marking
 * Slackbot as told, W0-10), so the checks no longer depend on that click. It only queues read-only Org62 scans; nothing is written anywhere.
 */
export function canvasAppliedRecheck(handle: DbHandle, make: (userId: string) => Pick<DbDataSource, 'checkCanvasOrg62'> = (userId) => new DbDataSource({ handle, userId })) {
  return async (ctx: { userId: string }, draftId: string): Promise<void> => {
    await make(ctx.userId).checkCanvasOrg62({ params: { id: draftId }, body: { reason: 'applied' } } as never);
  };
}

export function activitySyncJobDef(deps: ActivitySyncDeps): JobHandlerDef {
  return {
    kind: 'activity.sync',
    queue: 'maintenance',
    wired: true,
    description: 'Logging (Settings ▸ Time ▸ Logging): in automatic mode, stage the weekday batch for Apply',
    handler: activitySyncHandler(deps),
  };
}
