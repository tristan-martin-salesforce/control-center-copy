/**
 * ON-24: GET /health before any user exists (a fresh install, before Getting started), as GET /version does (ON-17).
 * The installer, `npm run shot` and monitors probe /health; until onboarding makes the user they get this payload in
 * the declared shape (no connectors, no spend, the worker's heartbeat) with `reason: 'no_user'`, not a 500.
 */
import type { HealthPayload } from '@/contract';

/** The one sentence a no-user database answers with (ctx.ts `userId`): onboarding makes the user. */
export function noUserMessage(port: string | number | undefined = process.env.PORT): string {
  return `CC_DATA=db: no user in this database yet; finish Getting started at http://localhost:${Number(port) || 4327}/onboarding (a source checkout can also run npm run setup)`;
}

/** Is this the "no user yet" error (not "several users", not a database error)? */
export const isNoUserError = (e: unknown): boolean => e instanceof Error && e.message.startsWith('CC_DATA=db: no user in this database');

export function noUserHealth(lastBeat: Date | null, now: number = Date.now()): HealthPayload {
  return {
    connectors: [],
    summary: { ok: 0, total: 0, worst: 'ok', broken: [] },
    spend: { today: { usd: 0, softBudgetUsd: 0, hardCapUsd: 0, pct: 0 }, state: 'ok', last7d: [], byScanner: [], byModel: [] },
    worker: { alive: !!lastBeat && now - lastBeat.getTime() < 120_000, lastHeartbeatAt: lastBeat ? lastBeat.toISOString() : null, queueDepth: 0, blocked: null },
    dryRun: true,
    firstScan: null,
    reason: 'no_user',
  };
}
