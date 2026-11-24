/**
 * `attribution.dc_suggest` (queue `maintenance`, lane 06 R5, H-9): the daily DC suggestion batch. From opp_engagement,
 * my teams, the AEs I cover (Settings ▸ Time) and the products that count (`dcProducts`), it proposes Deal Contribution
 * claims (src/engines/attribution/dc.ts: several opps per engagement with their evidence shares, covered-AE deals I
 * touched, closed opps stopped, rejected ones back only on a material change) as `dc_suggestions` rows the user
 * accepts, edits or rejects on Activity ▸ Needs you. Nothing is claimed here: Accept drafts a DC request that rides the
 * next logging canvas, an Outbox item applied by the user (tenet: Nothing leaves without approval).
 *
 * Queued daily at 06:45 local (after the book read, schedules.ts) and after every engagement rebuild. Local data only.
 */
import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import { DC_SUGGEST_JOB, DC_SUGGEST_KV, ATTRIBUTION_QUEUE, runDcBatch } from '@/server/datasource/db/attribution';
import { putKv } from '@/server/datasource/db/ext';

import type { JobContext, JobHandlerDef } from '../types';

export async function runDcSuggest(ctx: JobContext): Promise<Record<string, unknown>> {
  const now = ctx.clock();
  const r = await runDcBatch(ctx.db, ctx.userId, now);
  if (r.skipped) return { skipped: r.skipped };
  await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.system(DC_SUGGEST_JOB), reason: 'DC suggestions: batch ran', entity: { type: 'settings', id: DC_SUGGEST_KV }, undoable: false }, async (tx) => putKv(tx, ctx.userId, DC_SUGGEST_KV, { at: now.toISOString(), suggestions: r.suggestions }));
  if (r.changed) await notifyDcSuggest(ctx.db, r.changed, now).catch(() => undefined);
  return { suggestions: r.suggestions, changed: r.changed };
}

/** Topics an open Activity or Deals page refetches when the batch changed a suggestion (R3-9: the time → DC ripple). */
export const DC_SUGGEST_TOPICS = ['time', 'deals'] as const;

/**
 * R3-9: wake the lane. The ripple (`refreshDcSuggestions`) only queues this job, and the client's own invalidation runs
 * before it; so when the batch's change set lands, the job says so on `cc_live` (small payload, like the read-in's
 * notices) and Activity ▸ To log and Deals refetch.
 */
export async function notifyDcSuggest(db: JobContext['db'], changed: number, now: Date): Promise<void> {
  for (const t of DC_SUGGEST_TOPICS) {
    const payload = JSON.stringify({ o: DC_SUGGEST_JOB, t, i: [], r: `dc.suggest.changed:${changed}`, a: now.toISOString() });
    await db.execute(sql`select pg_notify('cc_live', ${payload})`);
  }
}

export function dcSuggestJobDef(): JobHandlerDef {
  return { kind: DC_SUGGEST_JOB, queue: ATTRIBUTION_QUEUE, wired: true, description: 'DC suggestions (attribution engine): from engagement, my teams, covered AEs and dcProducts → dc_suggestions rows to accept, edit or reject (local data only; nothing is claimed)', handler: (ctx) => runDcSuggest(ctx) };
}
