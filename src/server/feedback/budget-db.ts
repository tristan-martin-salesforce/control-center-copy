/**
 * The diagnose run's money on Postgres (D-56): it spends from the Assistant's day line (llm_calls purpose `chat`,
 * skill `feedback-diagnose`), under the per-report cap and whatever the global hard cap leaves today once every live
 * spend hold is counted (the governor's day status, src/llm/spend: booked spend plus what running jobs hold).
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { insertLlmCall } from '@/db/ledger';

import { budgetsForDay, type Settings } from '@/contract';
import type { Db } from '@/db/client';
import { localDay } from '@/engines/activity/time';
import { DbSpendStore } from '@/server/datasource/db/spend';
import { assistantDayLeft } from '@/server/datasource/db/store/vdp-candidates';

import { FEEDBACK_CAP_USD } from './agent';
import type { FeedbackSpend } from './host';

export async function feedbackBudget(db: Db, userId: string, settings: Pick<Settings, 'chat' | 'budgets' | 'profile'>, now: Date): Promise<{ capUsd: number; note: string | null }> {
  const day = localDay(now.getTime(), settings.profile.timezone);
  const line = await assistantDayLeft(db, userId, settings, day);
  const hard = budgetsForDay(settings.budgets, day).hardUsd;
  const total = await db.execute<{ total: string | null }>(sql`select coalesce(sum(cost_usd), 0) as total from llm_calls where owner_user_id = ${userId} and budget_day = ${day}::date and budget = 'daily'`);
  // H-5: what live holds (scans, settle, relays running now) already hold counts against what is left today
  const held = await new DbSpendStore({ db, userId, clock: () => now }).dayStatus().then((d) => d.heldUsd).catch(() => 0);
  const hardLeft = hard - Number(total.rows[0]?.total ?? 0) - held;
  const capUsd = Math.max(0, Math.min(FEEDBACK_CAP_USD, line.dayLeftUsd, hardLeft));
  const note = line.dayLeftUsd <= 0 ? "The Assistant's daily limit is used up (Settings ▸ Budgets), so this was diagnosed without a model call" : hardLeft <= 0 ? "Today's hard spend cap is reached, so this was diagnosed without a model call" : null;
  return { capUsd, note };
}

export async function recordFeedbackSpend(db: Db, userId: string, timezone: string, now: Date, r: FeedbackSpend): Promise<void> {
  if (!r.model) return;
  const day = localDay(now.getTime(), timezone);
  await insertLlmCall(db, {
    ownerUserId: userId,
    purpose: 'chat',
    model: r.model,
    skillKey: 'feedback-diagnose',
    promptVersion: r.skill,
    requestHash: `feedback:${randomUUID()}`,
    status: r.ok ? 'ok' : r.errorCode === 'timeout' ? 'timeout' : 'error',
    errorCode: r.errorCode ?? null,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    cacheWriteTokens: r.cacheWriteTokens ?? 0,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    budgetDay: day,
    startedAt: new Date(now.getTime() - r.latencyMs),
    finishedAt: now,
    rollup: false,
    // Report a bug / idea ▸ Diagnose: the user asked.
    trigger: 'user_action',
    modelReason: 'default',
    contentHash: r.contentHash,
    outcome: r.ok ? 'ok' : (r.errorCode ?? 'error'),
  });
}
