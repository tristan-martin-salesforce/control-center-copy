/**
 * `accounts.hierarchy` (queue `vdp`, concurrency 1; D-69): the Org62 account hierarchy, read-only. For every account of
 * my book with an Org62 id, then level by level for the parents that names, up to five levels:
 * `SELECT Id, Name, ParentId, SystemModstamp FROM Account WHERE Id IN (…)` (src/engines/deals/soql.ts `accounts`, which
 * was unused), ONE `soqlQuery` call per batch of 200 ids through runOneReadLookup (the scanners' Org62 read allowlist,
 * not widened). Stored in kv `cc.org62.account_hierarchy` (src/lib/accounts/hierarchy.ts).
 *
 * Queued daily (06:55, a full refresh) and after an Org62 read (src/worker/vdp-autopilot-hook.ts `vdpHierarchyHook`),
 * which reads only the ids not read yet unless the stored hierarchy is older than 20 hours. Runs for every persona with
 * VDP (the company identity reads it) and does nothing live outside the launchd worker (CC_LIVE / NODE_ENV=production)
 * unless a test injects the lookup. jobs.result holds counts and codes only, never names.
 */
import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { localDay } from '@/engines/activity/time';
import { accounts as accountsSoql } from '@/engines/deals/soql';
import { ACCOUNT_HIERARCHY_KV, hierarchyBatches, hierarchyOf, HIERARCHY_MAX_LEVELS, HierarchyParseError, isAccountId, nextHierarchy, parseHierarchyRecords, unreadParents, type HierarchyNode } from '@/lib/accounts/hierarchy';
import { featureActive, type ResolvedPersona } from '@/personas';
import { liveOrg62 } from '@/server/chat/record-type';
import { putKv } from '@/server/datasource/db/ext';
import { loadPersona } from '@/server/datasource/db/store/persona';
import { loadSettingsSections } from '@/server/datasource/db/store/settings';
import { loadGapEntities } from '@/server/datasource/db/store/vdp';
import { runOneReadLookup } from '@/server/onboarding/identity';

import { JobError, type JobContext, type JobHandlerDef } from '../types';
import { FORECAST_LOOKUP_SKILL, recordSpend } from './forecast-sync';
import { relayGuard, type RelayGuard } from './relay-guard';
import { ledgerHash } from '@/db/ledger';

export const HIERARCHY_JOB = 'accounts.hierarchy';
/** A hierarchy this old is read again in full. */
export const HIERARCHY_FRESH_MS = 20 * 60 * 60_000;

export interface HierarchyDeps {
  lookup?: typeof runOneReadLookup;
  live?: boolean;
  persona?: (ctx: JobContext) => Promise<ResolvedPersona>;
  /** D6: the budget guard (tests pass one that never refuses, or one that does). */
  guard?: (ctx: JobContext) => RelayGuard;
}

let deps: HierarchyDeps = {};
/** Tests swap the lookup or the persona. */
export function configureHierarchyJob(d: HierarchyDeps): void {
  deps = { ...deps, ...d };
}
export function resetHierarchyJobConfig(): void {
  deps = {};
}

async function readStored(db: Db, userId: string) {
  const r = await db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${ACCOUNT_HIERARCHY_KV}`);
  return hierarchyOf(r.rows[0]?.value);
}

export async function runHierarchyJob(ctx: JobContext, d: HierarchyDeps = deps): Promise<Record<string, unknown>> {
  const persona = d.persona ? await d.persona(ctx) : await loadPersona(ctx.db, ctx.userId);
  if (!featureActive(persona, 'vdp')) return { skipped: 'vdp_inactive' };
  const live = d.live ?? (!!d.lookup || liveOrg62());
  if (!live) return { skipped: 'not_live', note: 'Org62 reads run in the launchd worker only (CC_LIVE)' };
  const now = ctx.clock();
  const ents = await loadGapEntities(ctx.db, ctx.userId);
  const book = [...new Set(ents.accounts.map((a) => a.org62AccountId).filter(isAccountId).map((x) => x.slice(0, 15)))];
  if (!book.length) return { skipped: 'no_accounts', accounts: 0 };
  const prev = await readStored(ctx.db, ctx.userId);
  const full = ctx.job.payload.trigger === 'daily' || !prev.readAt || now.getTime() - Date.parse(prev.readAt) >= HIERARCHY_FRESH_MS;
  const asked = new Set(prev.read);
  let ask = full ? book : book.filter((x) => !asked.has(x));
  // a continuation after a spend ask also picks up the parents its earlier leg named and did not reach
  if (!full && ctx.job.payload.trigger === 'spend_continue') ask = [...new Set([...ask, ...unreadParents(prev, Object.values(prev.nodes))])];
  if (!ask.length) return { skipped: 'fresh', accounts: book.length };
  const sections = await loadSettingsSections({ db: ctx.db, userId: ctx.userId });
  const day = localDay(now.getTime(), sections.profile?.timezone ?? 'America/Denver');
  const lookup = d.lookup ?? runOneReadLookup;
  let h = prev;
  const read: string[] = [];
  const found: HierarchyNode[] = [];
  let costUsd = 0;
  let partial: string | null = null;
  // one hold per job (the start gate's): every lookup books into it, and past it the job asks once (relay-guard.ts)
  const guard = d.guard?.(ctx) ?? relayGuard(ctx, 'accounts-hierarchy');
  const early = await guard.start?.();
  if (early) return early;
  try {
    // level 0 is my book; each next level is the parents the last one named that are not known yet
    for (let level = 0; level <= HIERARCHY_MAX_LEVELS && ask.length && !partial; level++) {
      const got: HierarchyNode[] = [];
      for (const batch of hierarchyBatches(ask)) {
        const started = Date.now();
        const q = accountsSoql(batch);
        const r = await guard.run(async () => {
          const r = await lookup({ connector: 'org62', tool: 'soqlQuery', args: { q } }, { skillPath: FORECAST_LOOKUP_SKILL, timeoutMs: 90_000 });
          await recordSpend(ctx, day, { purpose: 'other', skillKey: 'accounts-hierarchy', promptVersion: 'records', model: r.model, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, contentHash: ledgerHash(r.model, 'soqlQuery', q), ok: r.text !== null, ...(r.text === null ? { errorCode: r.code } : {}), latencyMs: Date.now() - started }).catch(() => undefined);
          return r;
        });
        if (!r) {
          if (guard.stop === 'spend') {
            partial = 'spend';
            break;
          }
          if (!read.length) return { skipped: 'hard_cap', accounts: book.length };
          partial = 'hard_cap';
          break;
        }
        costUsd += r.costUsd;
        void ctx.heartbeat().catch(() => undefined);
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
        if (r.code === 'disallowed_tool') throw new JobError('the hierarchy read tried a tool outside the read-only allowlist', 'bug', { code: r.code });
        if (r.text === null) {
          if (!read.length) throw new JobError(`the Org62 account hierarchy read did not finish (${r.code})`, r.code === 'config' ? 'validation' : 'transient', { code: r.code });
          partial = r.code;
          break;
        }
        try {
          got.push(...parseHierarchyRecords(r.text));
        } catch (e) {
          throw new JobError('Org62 answered in a way the app could not read', 'transient', { code: e instanceof HierarchyParseError ? 'unreadable' : 'parse' });
        }
        read.push(...batch.map((x) => x.slice(0, 15)));
      }
      found.push(...got);
      h = nextHierarchy(h, read, found, now.toISOString());
      // a full refresh re-reads the parents too; otherwise only the ones not known yet
      ask = full ? [...new Set(got.map((n) => n.parentId).filter((p): p is string => !!p && !read.includes(p)))] : unreadParents(h, got);
    }
    await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.system(HIERARCHY_JOB), reason: `Org62 account hierarchy: ${read.length} accounts read`, entity: { type: 'settings', id: ACCOUNT_HIERARCHY_KV }, undoable: false }, async (tx) => putKv(tx, ctx.userId, ACCOUNT_HIERARCHY_KV, h));
    const withParent = found.filter((n) => !!n.parentId).length;
    // past the hold the job asked: its continuation reads the accounts not read yet (and their parents), on the same hold
    const paused = (await guard.finish?.({ payload: { trigger: 'spend_continue' } })) ?? {};
    return { accounts: read.length, withParent, full, ...(partial ? { partial } : {}), costUsd: Math.round(costUsd * 10_000) / 10_000, ...paused };
  } finally {
    await guard.finish?.().catch(() => undefined);
  }
}

export function hierarchyJobDef(): JobHandlerDef {
  return { kind: HIERARCHY_JOB, queue: 'vdp', wired: true, spends: true, description: 'Org62 account hierarchy (D-69): my accounts and their parents up to five levels (fixed SOQL, read-only) → kv', handler: (ctx) => runHierarchyJob(ctx) };
}
