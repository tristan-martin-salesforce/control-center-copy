/**
 * `vdp.identity` (queue `vdp`, concurrency 1; D-69): the company-identity judgment for the units the rules call
 * ambiguous (src/engines/vdp/identity.ts): one tool-less Haiku call per unit with the `vdp-company-identity` skill,
 * each capped by the skill's per-call budget, at most `max_units_per_run` per run, and within what is left of today's
 * hard cap. Cached in kv `cc.vdp.identity.judgments` per unit with the hash of its inputs: a unit is judged again only
 * when those change. Spend goes to `llm_calls` (purpose `other`, skill `vdp-company-identity`).
 *
 * Queued after a VDP read or an Org62 hierarchy read when a unit is pending (src/worker/vdp-autopilot-hook.ts
 * `vdpIdentityHook`). No model call outside the launchd worker (CC_LIVE / NODE_ENV=production) unless a test injects
 * the model. jobs.result holds counts and codes only, never names.
 */
import { sql } from 'drizzle-orm';

import { budgetsForDay, type Settings } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import { localDay } from '@/engines/activity/time';
import type { DbHandle } from '@/db/client';
import { judgmentsOf, overridesOf, resolveCompanyIdentity, VDP_IDENTITY_JUDGE_KV, VDP_IDENTITY_KV } from '@/engines/vdp/identity';
import { DbDataSource } from '@/server/datasource/db';
import { judgeIdentityUnits, IDENTITY_SKILL } from '@/engines/vdp/identity-judge';
import { featureActive, type ResolvedPersona } from '@/personas';
import { agentSdkCompletionModel } from '@/scanner/completion/llm';
import type { CompletionModel } from '@/scanner/completion/types';
import { liveOrg62 } from '@/server/chat/record-type';
import { putKv } from '@/server/datasource/db/ext';
import { loadPersona } from '@/server/datasource/db/store/persona';
import { loadSettingsSections } from '@/server/datasource/db/store/settings';
import { loadAccountHierarchy, loadGapEntities, loadKv, loadVdpRecords, loadVdpServer } from '@/server/datasource/db/store/vdp';

import type { JobContext, JobHandlerDef } from '../types';
import { recordSpend } from './forecast-sync';

export const VDP_IDENTITY_JOB = 'vdp.identity';

export interface VdpIdentityDeps {
  model?: CompletionModel;
  live?: boolean;
  persona?: (ctx: JobContext) => Promise<ResolvedPersona>;
  /** The worker's database handle: the pending units then come from the VDP view's own computation. */
  handle?: DbHandle;
}

let deps: VdpIdentityDeps = {};
/** Tests swap the model or the persona. */
export function configureVdpIdentityJob(d: VdpIdentityDeps): void {
  deps = { ...deps, ...d };
}
export function resetVdpIdentityJobConfig(): void {
  deps = {};
}

/**
 * The units the judgment would decide now (none when every ambiguous one has a decision for its current inputs). With
 * the worker's handle they come from the VDP view's own computation (`DbDataSource.vdpIdentityPending`), so the key and
 * hash of every unit judged are the ones the view looks up: a judgment is never stored for inputs the view does not
 * use (it then never applied, and the unit never came back as pending). Without one (tests): the tables directly.
 */
export async function pendingIdentityUnits(db: JobContext['db'], userId: string, handle: DbHandle | null = deps.handle ?? null) {
  if (handle) {
    const pending = await new DbDataSource({ handle, userId }).vdpIdentityPending();
    return { pending, judgments: judgmentsOf(await loadKv(db, userId, VDP_IDENTITY_JUDGE_KV)) };
  }
  const ents = await loadGapEntities(db, userId);
  const records = await loadVdpRecords(db, userId);
  const live = records.filter((r) => r.snapshot && !r.goneAt && !r.snapshot.archivedAt).map((r) => r.snapshot!);
  const gone = records.filter((r) => r.snapshot && (r.goneAt || r.snapshot.archivedAt)).map((r) => r.snapshot!);
  const server = await loadVdpServer(db, userId);
  const judgments = judgmentsOf(await loadKv(db, userId, VDP_IDENTITY_JUDGE_KV));
  const res = resolveCompanyIdentity({ accounts: ents.accounts, opps: ents.opps, vdps: live, tombstones: gone, hierarchy: await loadAccountHierarchy(db, userId), lookups: server?.companies ?? [], judgments, overrides: overridesOf(await loadKv(db, userId, VDP_IDENTITY_KV)) });
  return { pending: res.pending, judgments };
}

export async function runVdpIdentityJob(ctx: JobContext, d: VdpIdentityDeps = deps): Promise<Record<string, unknown>> {
  const persona = d.persona ? await d.persona(ctx) : await loadPersona(ctx.db, ctx.userId);
  if (!featureActive(persona, 'vdp')) return { skipped: 'vdp_inactive' };
  const live = d.live ?? (!!d.model || liveOrg62());
  if (!live) return { skipped: 'not_live', note: 'Model calls run in the launchd worker only (CC_LIVE)' };
  const { pending, judgments } = await pendingIdentityUnits(ctx.db, ctx.userId, d.handle ?? deps.handle ?? null);
  if (!pending.length) return { skipped: 'nothing_ambiguous', units: 0 };
  const sections = await loadSettingsSections({ db: ctx.db, userId: ctx.userId });
  const now = ctx.clock();
  const day = localDay(now.getTime(), sections.profile?.timezone ?? 'America/Denver');
  const budgets = sections.budgets ?? ({ version: 1, softUsd: 10, hardUsd: 15, alertPct: 80, readinUsdPerDay: 2, today: null } as Settings['budgets']);
  const spent = await ctx.db.execute<{ total: string | null }>(sql`select coalesce(sum(cost_usd), 0) as total from llm_calls where owner_user_id = ${ctx.userId} and budget_day = ${day}::date`);
  const left = budgetsForDay(budgets, day).hardUsd - Number(spent.rows[0]?.total ?? 0);
  if (left < 0.02) return { skipped: 'budget', units: pending.length, note: "Today's model budget is used up: the ambiguous companies wait for you (Needs you)" };
  const started = Date.now();
  const r = await judgeIdentityUnits(pending, d.model ?? agentSdkCompletionModel(), { now, budgetUsd: Math.min(0.5, left), prev: judgments, signal: ctx.signal });
  await recordSpend(ctx, day, { purpose: 'other', skillKey: IDENTITY_SKILL, promptVersion: 'v1', model: 'claude-haiku-5-5', costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, contentHash: r.contentHash, ok: r.failed === 0, ...(r.failed ? { errorCode: 'unreadable' } : {}), latencyMs: Date.now() - started }).catch(() => undefined);
  if (r.judged || r.failed) {
    await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.system(VDP_IDENTITY_JOB), reason: `VDP company identity: ${r.judged} ambiguous ${r.judged === 1 ? 'company' : 'companies'} judged`, entity: { type: 'settings', id: VDP_IDENTITY_JUDGE_KV }, undoable: false }, async (tx) => putKv(tx, ctx.userId, VDP_IDENTITY_JUDGE_KV, { units: r.judgments }));
  }
  return { units: pending.length, judged: r.judged, failed: r.failed, left: r.left, costUsd: Math.round(r.costUsd * 10_000) / 10_000 };
}

export function vdpIdentityJobDef(): JobHandlerDef {
  return { kind: VDP_IDENTITY_JOB, queue: 'vdp', wired: true, spends: true, description: 'VDP company identity (D-69): the cheap judgment (Haiku, capped) for the companies the rules call ambiguous → kv cache', handler: (ctx) => runVdpIdentityJob(ctx) };
}
