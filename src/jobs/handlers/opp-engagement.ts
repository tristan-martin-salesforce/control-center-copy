/**
 * `attribution.opp_engagement` (queue `maintenance`, lane 06 R4): rebuild `opp_engagement` (per opp × ISO week: what I
 * did on it) from the Time rows of this quarter and the 4 weeks before it, the engine's alternates crediting rows with
 * no opp (src/engines/attribution/engagement.ts; hours only on the opp a row is logged to). Then the DC batch runs on
 * the fresh rollup (`attribution.dc_suggest`, src/jobs/handlers/dc-suggest.ts), so a suggestion follows the work.
 *
 * Queued nightly (02:50 local, schedules.ts) and, as the fast path, a minute after a correction on a row
 * (db/attribution.ts learnFromRow, deduped per burst) or a Refresh on the DC suggestions. Local data only: nothing is
 * read from or written to any external system. jobs.result holds counts only.
 */
import { DC_SUGGEST_JOB, OPP_ENGAGEMENT_JOB, ATTRIBUTION_QUEUE, rebuildEngagement } from '@/server/datasource/db/attribution';

import type { JobContext, JobHandlerDef } from '../types';
import { runDcSuggest } from './dc-suggest';

export async function runOppEngagement(ctx: JobContext): Promise<Record<string, unknown>> {
  const now = ctx.clock();
  const r = await rebuildEngagement(ctx.db, ctx.userId, now);
  void ctx.heartbeat().catch(() => undefined);
  const dc = await runDcSuggest(ctx);
  return { rows: r.rows, touches: r.touches, from: r.from, dc };
}

export function oppEngagementJobDef(): JobHandlerDef {
  return { kind: OPP_ENGAGEMENT_JOB, queue: ATTRIBUTION_QUEUE, wired: true, description: 'opp_engagement rollup (attribution engine): per opp × week, what I did, then the DC suggestion batch (local data only)', handler: (ctx) => runOppEngagement(ctx) };
}

export { DC_SUGGEST_JOB };
