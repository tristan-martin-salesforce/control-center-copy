/**
 * `enrich` (queue `engine`; jobs queued before HYG-1 sit on `default`, which the maintenance pool drains): the capture enrichment of a quick capture or a chat
 * capture (captureItem, chat-be6 capture). HYG-1: captures queued this job since BE-1b, but no worker handled the
 * kind, so it dead-lettered ("no handler for enrich") and every captured to-do stayed "enriching" for good.
 *
 * The cheap, deterministic part only (no model call: no decision allows an LLM pass here; DECISIONS has none):
 *  - account and opportunity through the projections' matcher (the same names, aliases and short names as calendar
 *    events and sessions; never over a user-set or user-cleared account);
 *  - related work where a deterministic link exists: Claude sessions and assets on the same account or sharing a
 *    distinctive title word, and the account's next meeting in the coming two weeks.
 * It always ends the item's `enrichment` state: `done`, with whatever chips it found (none is a fine answer). One
 * engine change set (History, Undo). jobs.result holds ids and counts only, never titles.
 */
import { sql } from 'drizzle-orm';

import type { EnrichmentChip, WorkItemRecord } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db, DbOrTx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { accountMatcher } from '@/projections/run';
import { extKey, putKv } from '@/server/datasource/db/ext';

import type { JobHandlerDef } from '../types';
import { projectionStore } from '@/server/datasource/db/store/projections.run';

export const ENRICH_JOB_KIND = 'enrich';
export const ENRICH_QUEUE = 'engine';
export const ENRICH_ENGINE = 'enrich@1';
export const enrichDedupeKey = (itemId: string) => `enrich:work_item:${itemId}`;

const MAX_CHIPS = 4;
/** Words that say nothing about which piece of work it is. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'about', 'from', 'into', 'this', 'that', 'next', 'week', 'today', 'tomorrow', 'call', 'talk', 'team', 'send', 'follow',
  'review', 'check', 'update', 'prep', 'meeting', 'notes', 'deck', 'demo', 'email', 'slack', 'reply', 'ask', 'need', 'needs', 'make', 'draft', 'share',
  'data', 'cloud', 'agentforce', 'salesforce', 'customer', 'account', 'opportunity', 'opp', 'deal', 'plan', 'work', 'item', 'task', 'todo', 'new',
]);

/** Distinctive words of a title (4+ letters, not stopwords), lowercase. */
export function distinctiveWords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOP.has(w)))];
}

const sharedWord = (words: readonly string[], text: string | null | undefined): string | undefined => {
  if (!text) return undefined;
  const t = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return words.find((w) => t.has(w));
};

/** Queue the enrichment of one captured item (one queued job per item). */
export async function enqueueEnrich(db: DbOrTx, userId: string, itemId: string): Promise<void> {
  await enqueueJob(db, { ownerUserId: userId, kind: ENRICH_JOB_KIND, queue: ENRICH_QUEUE, payload: { workItemId: itemId }, dedupeKey: enrichDedupeKey(itemId), maxAttempts: 3, timeoutSeconds: 120 });
}

export interface EnrichResult {
  status: 'done' | 'gone' | 'not_enriching';
  chips: number;
  accountSet: boolean;
  oppSet: boolean;
}

type ItemRow = { id: string; title: string; purpose: string | null; account_id: string | null; opportunity_id: string | null; locked: string[] | null; created_at: Date | string };

/**
 * Enrich one work item now: find its account / opp and related work deterministically, then end its `enriching`
 * state. Also what the hygiene sweep runs for an item left "enriching" (src/server/hygiene). `force` enriches an item
 * whose ext no longer says enriching (tests; never the job).
 */
export async function enrichWorkItem(db: Db, userId: string, itemId: string, o: { now: Date; force?: boolean; reason?: string }): Promise<EnrichResult> {
  const r = await db.execute<ItemRow>(sql`
    select id, title, purpose, account_id, opportunity_id, user_locked_fields as locked, created_at
      from work_items where id = ${itemId}::uuid and owner_user_id = ${userId}`);
  const item = r.rows[0];
  if (!item) return { status: 'gone', chips: 0, accountSet: false, oppSet: false };
  const key = extKey('work_items', itemId);
  const extRow = await db.execute<{ value: Record<string, unknown> }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${key}`);
  const ext = extRow.rows[0]?.value ?? {};
  const cur = ext.enrichment as WorkItemRecord['enrichment'] | undefined;
  if (!o.force && cur?.status !== 'enriching') return { status: 'not_enriching', chips: 0, accountSet: false, oppSet: false };

  const text = [item.title, item.purpose].filter(Boolean).join(' ');
  const locked = new Set(item.locked ?? []);
  const { matcher } = await accountMatcher(projectionStore(db), userId);
  let accountId = item.account_id;
  let oppId = item.opportunity_id;
  let accountSet = false;
  let oppSet = false;
  let matchedVia: string | null = null;
  if (!accountId && !locked.has('account_id')) {
    const m = matcher.resolve(text);
    if (m) {
      accountId = m.accountId;
      accountSet = true;
      matchedVia = m.via;
      if (!oppId && m.oppId && !locked.has('opportunity_id')) {
        oppId = m.oppId;
        oppSet = true;
      }
    }
  }

  const chips: EnrichmentChip[] = [];
  const chip = (c: Omit<EnrichmentChip, 'id' | 'status'>) => {
    if (chips.length >= MAX_CHIPS || chips.some((x) => x.ref?.id === c.ref?.id)) return;
    chips.push({ id: `chip:${itemId}:${c.kind}:${c.ref?.id ?? chips.length}`, status: 'suggested', ...c });
  };
  const acct = accountId ? matcher.accounts.get(accountId) : undefined;
  if (acct) chip({ kind: 'account', label: `Account '${acct.name}'`, reason: accountSet ? (matchedVia === 'title' ? 'Named in the title' : 'An alias of it is in the title') : 'Set at capture', ref: { type: 'account', id: acct.id, label: acct.name } });
  const opp = oppId ? matcher.opps.get(oppId) : undefined;
  if (opp) chip({ kind: 'opportunity', label: `Opportunity '${opp.name}'`, reason: oppSet ? 'The account’s opp the title points at' : 'Set at capture', ref: { type: 'opportunity', id: opp.id, label: opp.name } });

  const words = distinctiveWords(text);
  const since = new Date(o.now.getTime() - 30 * 86_400_000).toISOString();
  const sessions = await db.execute<{ id: string; title: string | null; account_id: string | null }>(sql`
    select id, title, account_id from claude_sessions
     where owner_user_id = ${userId} and coalesce(last_activity_at, started_at, created_at) >= ${since}::timestamptz
       and (${accountId}::uuid is not null and account_id = ${accountId}::uuid or title is not null)
     order by coalesce(last_activity_at, started_at, created_at) desc limit 200`);
  for (const s of sessions.rows) {
    const w = sharedWord(words, s.title);
    const same = !!accountId && s.account_id === accountId;
    if (!w && !same) continue;
    const label = s.title ?? 'Claude session';
    chip({ kind: 'claude_session', label: `Claude session '${label}'`, reason: w ? `Mentions "${w}"` : 'Same account', ref: { type: 'agent_run', id: s.id, label } });
  }
  const assets = await db.execute<{ id: string; title: string | null; url: string | null; account_id: string | null }>(sql`
    select id, title, url, account_id from assets
     where owner_user_id = ${userId} and archived_at is null and coalesce(last_modified_at, created_at) >= ${since}::timestamptz
       and (${accountId}::uuid is not null and account_id = ${accountId}::uuid or title is not null)
     order by coalesce(last_modified_at, created_at) desc limit 200`);
  for (const a of assets.rows) {
    const w = sharedWord(words, a.title);
    const same = !!accountId && a.account_id === accountId;
    if (!w && !same) continue;
    const label = a.title ?? 'File';
    chip({ kind: 'asset', label: `File '${label}'`, reason: w ? `Title matches "${w}"` : 'Same account', ref: { type: 'asset', id: a.id, label }, ...(a.url && /^https:\/\//.test(a.url) ? { url: a.url } : {}) });
  }
  if (accountId) {
    const ev = await db.execute<{ id: string; title: string | null; starts_at: Date | string }>(sql`
      select id, title, starts_at from calendar_events
       where owner_user_id = ${userId} and account_id = ${accountId}::uuid and status <> 'cancelled' and deleted_upstream_at is null
         and starts_at >= ${o.now.toISOString()}::timestamptz and starts_at < ${new Date(o.now.getTime() + 14 * 86_400_000).toISOString()}::timestamptz
       order by starts_at limit 1`);
    const e = ev.rows[0];
    if (e) chip({ kind: 'meeting', label: `Meeting '${e.title ?? 'Meeting'}'`, reason: 'The account’s next meeting', ref: { type: 'calendar_event', id: e.id, label: e.title ?? 'Meeting' } });
  }

  const startedAt = cur?.startedAt ?? new Date(item.created_at).toISOString();
  await withChangeSet(
    { db, userId, actor: actors.engine(ENRICH_ENGINE), reason: o.reason ?? `Enriched: ${chips.length} related item${chips.length === 1 ? '' : 's'}`, entity: { type: 'work_item', id: itemId }, undoable: true },
    async (tx) => {
      if (accountSet || oppSet) {
        await tx.execute(sql`
          update work_items set account_id = coalesce(account_id, ${accountSet ? accountId : null}::uuid),
                 opportunity_id = coalesce(opportunity_id, ${oppSet ? oppId : null}::uuid),
                 version = version + 1, updated_at = now()
           where id = ${itemId}::uuid and owner_user_id = ${userId}`);
      }
      await putKv(tx, userId, key, { ...ext, enrichment: { status: 'done', startedAt, chips } }, ext);
    },
  );
  return { status: 'done', chips: chips.length, accountSet, oppSet };
}

export function enrichJobDef(): JobHandlerDef {
  return {
    kind: ENRICH_JOB_KIND,
    queue: ENRICH_QUEUE,
    wired: true,
    description: 'capture enrichment: account / opp match and related sessions, assets, meetings (deterministic, no model call)',
    handler: async (ctx) => {
      const p = ctx.job.payload as { workItemId?: unknown; work_item_id?: unknown };
      const itemId = typeof p.workItemId === 'string' ? p.workItemId : typeof p.work_item_id === 'string' ? p.work_item_id : null;
      if (!itemId || !/^[0-9a-f-]{36}$/i.test(itemId)) return { status: 'skipped', reason: 'bad_payload' };
      const r = await enrichWorkItem(ctx.db, ctx.userId, itemId, { now: ctx.clock() });
      return { ...r, workItemId: itemId };
    },
  };
}
