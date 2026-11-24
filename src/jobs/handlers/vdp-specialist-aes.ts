/**
 * `vdp.specialist_aes` (queue `vdp`, concurrency 1; D-63): who the VDP's AE is. One read of the Org62 Specialist
 * Forecasts of a VDP type (Data Cloud, BtL Data Cloud, Agentforce, BtL Agentforce) on my open 100%-DC opps, with their
 * owners: fixed SOQL (src/server/vdp/specialist-aes.ts), ONE `soqlQuery` call per batch of 200 opps through
 * runOneReadLookup (the scanners' Org62 read allowlist, not widened), cached per opp in kv `cc.vdp.specialist_aes`.
 *
 * Queued daily (06:50, a full refresh) and after an Org62 read (src/worker/vdp-autopilot-hook.ts `vdpAesHook`), which
 * only reads the opps the cache has not covered yet unless the last read is older than 20 hours. Runs for every persona
 * with VDP (D-55 feature `vdp`), the SE's too: it does not depend on the Specialist Forecast feature. Does nothing live
 * outside the launchd worker (CC_LIVE / NODE_ENV=production) unless a test injects the lookup. jobs.result holds counts
 * and codes only, never names or emails.
 */
import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { localDay } from '@/engines/activity/time';
import type { SpecialistAe } from '@/engines/vdp/gaps';
import { featureActive, type ResolvedPersona } from '@/personas';
import { liveOrg62 } from '@/server/chat/record-type';
import { putKv } from '@/server/datasource/db/ext';
import { loadPersona } from '@/server/datasource/db/store/persona';
import { loadSettingsSections } from '@/server/datasource/db/store/settings';
import { loadGapEntities } from '@/server/datasource/db/store/vdp';
import { VDP_ASSETS_QUEUE } from '@/server/datasource/db/store/vdp-candidates';
import { runOneReadLookup } from '@/server/onboarding/identity';
import { aeBatches, aeCacheOf, aeTargets, nextAeCache, parseSpecialistAes, SpecialistAeParseError, specialistAesSoql, VDP_AES_KV } from '@/server/vdp/specialist-aes';

import { JobError, type JobContext, type JobHandlerDef } from '../types';
import { FORECAST_LOOKUP_SKILL, recordSpend } from './forecast-sync';
import { relayGuard, type RelayGuard } from './relay-guard';
import { ledgerHash } from '@/db/ledger';

export const VDP_AES_JOB = 'vdp.specialist_aes';
/** A cache this old is read again in full, even when it covers every opp. */
export const AES_FRESH_MS = 20 * 60 * 60_000;

export interface VdpAesDeps {
  lookup?: typeof runOneReadLookup;
  live?: boolean;
  persona?: (ctx: JobContext) => Promise<ResolvedPersona>;
  /** D6: the budget guard (tests pass one that never refuses, or one that does). */
  guard?: (ctx: JobContext) => RelayGuard;
}

let deps: VdpAesDeps = {};
/** Tests swap the lookup or the persona. */
export function configureVdpAesJob(d: VdpAesDeps): void {
  deps = { ...deps, ...d };
}
export function resetVdpAesJobConfig(): void {
  deps = {};
}

async function readCache(db: Db, userId: string) {
  const r = await db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${VDP_AES_KV}`);
  return aeCacheOf(r.rows[0]?.value);
}

export async function runVdpAesJob(ctx: JobContext, d: VdpAesDeps = deps): Promise<Record<string, unknown>> {
  const persona = d.persona ? await d.persona(ctx) : await loadPersona(ctx.db, ctx.userId);
  if (!featureActive(persona, 'vdp')) return { skipped: 'vdp_inactive' };
  const live = d.live ?? (!!d.lookup || liveOrg62());
  if (!live) return { skipped: 'not_live', note: 'Org62 reads run in the launchd worker only (CC_LIVE)' };
  const now = ctx.clock();
  const ents = await loadGapEntities(ctx.db, ctx.userId);
  const targets = aeTargets(ents.opps);
  if (!targets.length) return { skipped: 'no_opps', opps: 0 };
  const cache = await readCache(ctx.db, ctx.userId);
  const full = ctx.job.payload.trigger === 'daily' || !cache.readAt || now.getTime() - Date.parse(cache.readAt) >= AES_FRESH_MS;
  const covered = new Set(cache.read);
  const ask = full ? targets : targets.filter((x) => !covered.has(x.slice(0, 15)));
  if (!ask.length) return { skipped: 'fresh', opps: targets.length };
  const sections = await loadSettingsSections({ db: ctx.db, userId: ctx.userId });
  const day = localDay(now.getTime(), sections.profile?.timezone ?? 'America/Denver');
  const lookup = d.lookup ?? runOneReadLookup;
  const found = new Map<string, SpecialistAe[]>();
  const read: string[] = [];
  let costUsd = 0;
  let partial: string | null = null;
  // one hold per job (the start gate's): every lookup books into it, and past it the job asks once (relay-guard.ts)
  const guard = d.guard?.(ctx) ?? relayGuard(ctx, 'vdp-specialist-aes');
  const early = await guard.start?.();
  if (early) return early;
  try {
    const batches = aeBatches(ask);
    for (const [i, batch] of batches.entries()) {
      const started = Date.now();
      const q = specialistAesSoql(batch);
      const r = await guard.run(async () => {
        const r = await lookup({ connector: 'org62', tool: 'soqlQuery', args: { q } }, { skillPath: FORECAST_LOOKUP_SKILL, timeoutMs: 90_000 });
        await recordSpend(ctx, day, { purpose: 'other', skillKey: 'vdp-specialist-aes', promptVersion: 'records', model: r.model, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, contentHash: ledgerHash(r.model, 'soqlQuery', q), ok: r.text !== null, ...(r.text === null ? { errorCode: r.code } : {}), latencyMs: Date.now() - started }).catch(() => undefined);
        return r;
      }, { pctDone: (100 * i) / batches.length });
      if (!r) {
        if (guard.stop === 'spend') {
          partial = 'spend';
          break;
        }
        if (!read.length) return { skipped: 'hard_cap', opps: targets.length };
        partial = 'hard_cap';
        break;
      }
      costUsd += r.costUsd;
      void ctx.heartbeat().catch(() => undefined);
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
      if (r.code === 'disallowed_tool') throw new JobError('the AE read tried a tool outside the read-only allowlist', 'bug', { code: r.code });
      if (r.text === null) {
        if (!read.length) throw new JobError(`the Specialist Forecast AE read did not finish (${r.code})`, r.code === 'config' ? 'validation' : 'transient', { code: r.code });
        partial = r.code;
        break;
      }
      try {
        for (const [k, v] of parseSpecialistAes(r.text)) found.set(k, v);
      } catch (e) {
        throw new JobError('Org62 answered in a way the app could not read', 'transient', { code: e instanceof SpecialistAeParseError ? 'unreadable' : 'parse' });
      }
      read.push(...batch);
    }
    const next = nextAeCache(cache, read, found, now.toISOString());
    await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.system(VDP_AES_JOB), reason: `VDP AEs from the Specialist Forecasts: ${read.length} opportunities read`, entity: { type: 'settings', id: VDP_AES_KV }, undoable: false }, async (tx) => putKv(tx, ctx.userId, VDP_AES_KV, next));
    // past the hold the job asked: its continuation reads the opps the cache has not read yet, on the same hold
    const paused = (await guard.finish?.({ payload: { trigger: 'spend_continue' } })) ?? {};
    return { opps: read.length, withAe: [...found.keys()].length, full, ...(partial ? { partial } : {}), costUsd: Math.round(costUsd * 10_000) / 10_000, ...paused };
  } finally {
    await guard.finish?.().catch(() => undefined);
  }
}

export function vdpAesJobDef(): JobHandlerDef {
  return { kind: VDP_AES_JOB, queue: VDP_ASSETS_QUEUE, wired: true, spends: true, description: "VDP AEs (D-63): the owners of my 100%-DC opps' Specialist Forecasts of a VDP type (fixed SOQL, read-only) → kv cache", handler: (ctx) => runVdpAesJob(ctx) };
}
