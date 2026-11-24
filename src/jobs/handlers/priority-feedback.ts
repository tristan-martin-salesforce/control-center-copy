/**
 * `priority.feedback` (nightly, queue `maintenance`): the learning pass of priority@2 (lane 07 R8, PRIO-14; tenet
 * *Suggest, then learn*). It reads the last 30 days of `priority_feedback` (your reorders, snoozes, "not today"s,
 * pins and "do first"s with the ranking's terms at the time), measures per term how often the model's term agreed
 * with what you did, and when one term keeps pointing the wrong way it writes ONE suggested `priority_rules` row
 * (a bounded persona weight nudge). Health shows it as a line with one click; nothing changes before that click.
 * Deterministic: no model call, no spend. jobs.result holds counts only.
 */
import type { DbOrTx } from '@/db/client';
import { runFeedbackPass } from '@/server/datasource/db/priority';

import type { JobHandlerDef } from '../types';

export const PRIORITY_FEEDBACK_JOB_KIND = 'priority.feedback';
export const PRIORITY_FEEDBACK_QUEUE = 'maintenance';

export function priorityFeedbackJobDef(o: { pass?: (db: DbOrTx, userId: string, now: Date) => Promise<{ rows: number; suggested: string | null }> } = {}): JobHandlerDef {
  const pass = o.pass ?? runFeedbackPass;
  return {
    kind: PRIORITY_FEEDBACK_JOB_KIND,
    queue: PRIORITY_FEEDBACK_QUEUE,
    wired: true,
    description: 'nightly priority learning pass: per-term agreement from your moves, at most one suggested rule for Health',
    handler: async (ctx) => {
      const r = await pass(ctx.db, ctx.userId, ctx.clock());
      ctx.log('priority: feedback pass', { rows: r.rows, suggested: r.suggested ? 1 : 0 });
      return { rows: r.rows, suggested: r.suggested ? 1 : 0 };
    },
  };
}
