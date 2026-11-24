/**
 * `brief.generate` (queue `brief`, concurrency 1): the watched-channel briefs (BE-5, R-UI-21).
 *
 * Enqueued by the daily 07:30 schedule (src/worker/schedules.ts, run_once: a laptop asleep at 07:30 briefs on wake)
 * and by its own follow-ups ("Every 4 h" watches; a channel whose Slack scan is behind or not there yet, or whose
 * model call failed, is looked at again every 15 min, 8 times at most). Each run, for every
 * enabled channel watch that is due (src/engines/briefs/channel.ts `briefDue`):
 *
 *   1. period = (last brief's end, or 24 h back] → (now, or the channel scan's cursor when it is behind). A brief
 *      never claims what the scanner has not read; the next one starts where this one ended, so nothing is lost.
 *   2. the messages the Slack scanner stored for the channel in that period (source_items; no Slack call here);
 *   3. budget check (the global hard cap) → ONE tool-less Haiku call (brief-channel + brief-relevance) → validated;
 *      a quiet period writes a short "no new messages" brief, already read, with no call;
 *   4. one change set: the brief and its highlights (the DataSource's insertBrief, so the Briefs page reads it as
 *      it reads every brief), provenance links to the messages, and the watch's cursor (last_period_end, last brief).
 *
 * Before this handler the kind was a "not yet wired" stub and its schedule stayed disabled, so a watch added on the
 * Briefs page was scanned for items by scan-slack but never produced a brief (STRESS WATCH-1).
 *
 * Spend (caps audit 26 F-4): the run is under the job's governor hold (the worker's start gate took it). One call's SDK
 * budget is the runaway guard (4x the hold), not $0.10; past the hold, before the next watch's call, it raises a hand
 * (Health ▸ Spend) and the watches still due wait in one queued run carrying the hold (Allow runs it, Stop cancels).
 *
 * Opportunity, account, person and search watches are counted as `unsupported` (BE-5's other brief kinds).
 * jobs.result holds ids, counts and codes only, never message text.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import type { WatchCadence } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { sourceItems } from '@/db/schema';
import { briefIdFor, briefDue, channelBrief, type ChannelMessage } from '@/engines/briefs/channel';
import type { MyContext } from '@/engines/briefs/prompt/types';
import { connectorActive } from '@/personas';
import { agentSdkCompletionModel, type CompletionModel } from '@/scanner/completion';
import { slackChannelName } from '@/scanner/runtime/connectors';
import { DbScannerStore } from '@/scanner/store-db';
import { applyOverride, cadenceFromDb, type DbCadence, type Override } from '@/server/datasource/db/enums';
import { uuidFor } from '@/server/datasource/db/ids';
import { loadPersona } from '@/server/datasource/db/store/persona';
import { insertBrief } from '@/server/datasource/db/store/briefs';
import type { WriteCtx } from '@/server/datasource/db/store/common';
import { sourceRefOf } from '@/server/datasource/db/store/work';
import { ensureExtractor } from '@/server/datasource/db/seed';

import { ledgerHash } from '@/db/ledger';
import { finishJobSpend, gateOf, startJobSpend, type SpendGovernor } from '@/llm/spend';
import { dbSpendGovernor } from '@/server/datasource/db/spend';
import { QUEUES } from '../registry';
import { spendPauseResult, spendStartResult } from '../spend-pause';
import type { JobHandler, JobHandlerDef } from '../types';

export const BRIEF_JOB_KIND = 'brief.generate';
export const briefFollowUpKey = (userId: string) => `brief.generate:follow_up:${userId}`;

const DAY = 86_400_000;
const MIN = 60_000;
/** A first brief, or one after a long gap, covers at most this much (the prompt keeps the newest that fit). */
const MAX_PERIOD_MS = 7 * DAY;
const MAX_MESSAGES = 400;
/** The channel scan is "behind" when its cursor is within this of the period start: wait for it. */
const MIN_PERIOD_MS = 2 * MIN;
/** Retry a channel whose scan is behind (or not there yet, or whose call failed) this often, at most this many times in a row. */
const WAIT_RETRY_MS = 15 * MIN;
const MAX_WAIT_RETRIES = 8;
/** A cursor older than this when the brief is written: the brief says Slack was read only up to then. */
const STALE_COVERAGE_MS = 2 * 3_600_000;
const DEFAULT_MAX_CALL_USD = 0.1;

export interface BriefHandlerDeps {
  /** The model seam (default: one tool-less Agent SDK turn). Tests pass a fake. */
  model?: CompletionModel;
  skillsDir?: string;
  /** One call's line without a governor hold (with one, the hold's runaway guard when larger). */
  maxCallUsd?: number;
  /** The spend governor (default: the database one; null: no hold, `maxCallUsd` is the line). */
  spend?: SpendGovernor | null;
}

type WatchRow = {
  id: string;
  scope_kind: string;
  label: string;
  cadence: DbCadence;
  style: 'digest' | 'narrative' | 'changes_only';
  detail_level: number;
  max_highlights: number;
  last_period_end: string | null;
  channel_row_id: string | null;
  channel_ref: string | null;
  last_brief_at: string | null;
  ext: { cadence?: Override<WatchCadence, DbCadence> } | null;
};

type Outcome = 'ready' | 'quiet' | 'not_due' | 'not_scanned' | 'waiting_for_scan' | 'deferred_budget' | 'failed' | 'exists' | 'unsupported';

async function userInfo(db: Db, userId: string): Promise<{ name: string; tz: string; slackId?: string }> {
  const r = await db.execute<{ name: string; tz: string | null; profile_tz: string | null; slack_id: string | null }>(sql`
    select coalesce(u.display_name, u.email) as name, u.timezone as tz,
           (select s.value->>'timezone' from user_settings s where s.owner_user_id = u.id and s.key in ('settings.profile', 'profile')
             order by (s.key = 'settings.profile') desc limit 1) as profile_tz,
           (select pi.external_id from person_identities pi where pi.person_id = u.person_id and pi.system = 'slack' order by pi.is_primary desc limit 1) as slack_id
      from users u where u.id = ${userId}`);
  const u = r.rows[0];
  return { name: u?.name ?? 'me', tz: u?.profile_tz || u?.tz || 'America/Denver', ...(u?.slack_id ? { slackId: u.slack_id } : {}) };
}

/** The user's own watches (auto-managed opp briefs are BE-5's opportunity engine). */
async function loadWatchRows(db: Db, userId: string): Promise<WatchRow[]> {
  const r = await db.execute<WatchRow>(sql`
    select w.id, w.scope_kind::text as scope_kind, w.label, w.cadence::text as cadence, w.style::text as style, w.detail_level, w.max_highlights,
           w.last_period_end, c.id as channel_row_id, c.external_id as channel_ref, b.generated_at as last_brief_at,
           (select s.value from user_settings s where s.owner_user_id = w.owner_user_id and s.key = 'cc.ext/watch_subscriptions/' || w.id::text) as ext
      from watch_subscriptions w
      left join channels c on c.id = w.channel_id and c.archived_at is null
      left join briefs b on b.id = w.last_brief_id
     where w.owner_user_id = ${userId} and w.enabled and not w.auto_managed
     order by w.created_at, w.id`);
  return r.rows.map((w) => ({
    ...w,
    last_period_end: w.last_period_end ? new Date(w.last_period_end).toISOString() : null,
    last_brief_at: w.last_brief_at ? new Date(w.last_brief_at).toISOString() : null,
  }));
}

/** My book, my open opps and my initiatives: what highlights are judged against (brief-relevance). */
async function myContext(db: Db, userId: string): Promise<MyContext> {
  const [accounts, opps, inits] = await Promise.all([
    db.execute<{ id: string; name: string; aliases: string[] | null }>(sql`
      select a.id, a.name, array_remove(array_agg(distinct al.value), null) as aliases
        from accounts a left join account_aliases al on al.account_id = a.id and al.kind in ('name', 'short_name')
       where a.owner_user_id = ${userId} and a.archived_at is null and a.is_my_book
       group by a.id, a.name order by a.name limit 60`),
    db.execute<{ id: string; name: string; account_id: string | null; stage: string | null }>(sql`
      select id, name, account_id, stage from opportunities
       where owner_user_id = ${userId} and archived_at is null and not coalesce(is_closed, false)
         and (on_my_team or is_watched
              -- a DC of mine is my book too (it is no longer "on my team")
              or coalesce((select (s.value->>'dcAssigned')::boolean from user_settings s where s.owner_user_id = ${userId} and s.key = 'cc.ext/opportunities/' || opportunities.id), false))
       order by close_date nulls last, name limit 40`),
    db.execute<{ id: string; title: string }>(sql`
      select id, title from initiatives where owner_user_id = ${userId} and status in ('proposed', 'active', 'paused') and archived_at is null
       order by updated_at desc limit 30`),
  ]);
  return {
    accounts: accounts.rows.map((a) => ({ id: a.id, name: a.name, ...(a.aliases?.filter((x) => x !== a.name).length ? { aliases: a.aliases.filter((x) => x !== a.name) } : {}) })),
    opportunities: opps.rows.map((o) => ({ id: o.id, name: o.name, ...(o.account_id ? { accountId: o.account_id } : {}), ...(o.stage ? { stage: o.stage } : {}) })),
    initiatives: inits.rows.map((i) => ({ id: i.id, title: i.title })),
    interests: [],
    people: [],
    policyRules: [],
  };
}

/**
 * The channel's messages in (from, to], as the Slack scanner stored them. A message is the channel's by its channel
 * id or name (scanner meta), its channels row, or the channel scope that recorded it; DMs never are.
 */
export async function channelMessages(db: Db, userId: string, ch: { rowId: string | null; ref: string; label: string }, period: { from: string; to: string }): Promise<ChannelMessage[]> {
  const name = slackChannelName(ch.ref) || slackChannelName(ch.label);
  const rows = await db
    .select()
    .from(sourceItems)
    .where(
      and(
        eq(sourceItems.ownerUserId, userId),
        eq(sourceItems.source, 'slack'),
        sql`${sourceItems.deletedUpstreamAt} is null`,
        sql`${sourceItems.occurredAt} > ${period.from}::timestamptz and ${sourceItems.occurredAt} <= ${period.to}::timestamptz`,
        sql`coalesce(${sourceItems.meta}->>'channelType', '') not in ('im', 'mpim')`,
        sql`(${ch.rowId ? sql`${sourceItems.channelId} = ${ch.rowId}::uuid or ` : sql``}${sourceItems.meta}->>'channelId' = ${ch.ref}
             or ${sourceItems.externalContainerId} = ${`channel:${ch.ref}`}
             ${name ? sql`or lower(ltrim(${sourceItems.meta}->>'channelName', '#')) = ${name}` : sql``})`,
      ),
    )
    .orderBy(desc(sourceItems.occurredAt))
    .limit(MAX_MESSAGES);
  return rows.map((si) => {
    const meta = (si.meta ?? {}) as { author?: { name?: string; isMe?: boolean }; threadRef?: string; isReply?: boolean };
    return {
      sourceItemId: si.id,
      at: si.occurredAt.toISOString(),
      ...(meta.author?.name ? { authorName: meta.author.name } : {}),
      ...(meta.author?.isMe || si.fromMe ? { authorIsMe: true } : {}),
      ...(meta.threadRef || si.externalParentId ? { threadRef: meta.threadRef ?? si.externalParentId ?? undefined } : {}),
      isReply: meta.isReply === true,
      text: si.body ?? si.title ?? '',
      source: sourceRefOf(si),
    };
  });
}

export function briefHandler(deps: BriefHandlerDeps = {}): JobHandler {
  let model: CompletionModel | undefined = deps.model;
  return async (ctx) => {
    const now = ctx.clock();
    const retry = typeof ctx.job.payload.retry === 'number' ? ctx.job.payload.retry : 0;
    const counts: Record<Outcome, number> = { ready: 0, quiet: 0, not_due: 0, not_scanned: 0, waiting_for_scan: 0, deferred_budget: 0, failed: 0, exists: 0, unsupported: 0 };
    const briefs: Array<{ watchId: string; briefId: string; status: 'ready' | 'quiet'; messages: number; highlights: number; costUsd: number }> = [];
    const errors: Array<{ watchId: string; code: string }> = [];
    const persona = await loadPersona(ctx.db, ctx.userId);
    if (!connectorActive(persona, 'watch')) return { status: 'watch_inactive', counts, briefs, errors };

    const gov = deps.spend === undefined ? dbSpendGovernor({ db: ctx.db, userId: ctx.userId, clock: ctx.clock }) : deps.spend;
    const envelope = await startJobSpend(gov, ctx.job, { scope: 'job', skill: 'brief-channel' });
    const early = await spendStartResult(ctx, envelope, { dedupeKey: briefFollowUpKey(ctx.userId) });
    if (early) return { status: 'nothing_due', counts, briefs, errors, ...early };
    const gate = gateOf(envelope);
    let askNext = false;
    const store = new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
    const user = await userInfo(ctx.db, ctx.userId);
    const watches = await loadWatchRows(ctx.db, ctx.userId);
    let context: MyContext | undefined;
    let costUsd = 0;
    let next: number | undefined;
    const later = (at: number) => (next = next === undefined ? at : Math.min(next, at));
    /** A watch to look at again soon (scan not there yet, failed call): bounded by MAX_WAIT_RETRIES runs in a row. */
    let retrySoon = false;
    const soon = () => {
      if (retry >= MAX_WAIT_RETRIES) return;
      retrySoon = true;
      later(now.getTime() + WAIT_RETRY_MS);
    };

    for (const w of watches) {
      if (ctx.signal.aborted) break;
      const cadence = applyOverride(w.cadence, cadenceFromDb(w.cadence), w.ext?.cadence);
      if (w.scope_kind !== 'channel' || !w.channel_ref) {
        counts.unsupported++;
        continue;
      }
      const due = briefDue({ cadence, lastBriefAt: w.last_brief_at }, now, user.tz);
      if (cadence === 'every_4h') later(due.nextAt.getTime());
      if (!due.due) {
        counts.not_due++;
        continue;
      }
      // The channel's Slack scope (scan-slack plans `channel:<ref>` for every watched channel).
      const cursor = await store.getCursor({ connector: 'slack', scope: `channel:${w.channel_ref}` });
      if (!cursor) {
        // A watch added minutes ago: scan-slack plans its channel scope on its next scope refresh.
        counts.not_scanned++;
        soon();
        continue;
      }
      const from = new Date(Math.max(w.last_period_end ? Date.parse(w.last_period_end) : now.getTime() - DAY, now.getTime() - MAX_PERIOD_MS));
      const to = new Date(Math.min(now.getTime(), Date.parse(cursor.at)));
      if (to.getTime() - from.getTime() < MIN_PERIOD_MS) {
        counts.waiting_for_scan++;
        soon();
        continue;
      }
      const period = { from: from.toISOString(), to: to.toISOString() };
      const briefRowId = uuidFor(briefIdFor(w.id, period));
      const existing = await ctx.db.execute<{ id: string }>(sql`select id from briefs where id = ${briefRowId} or (subscription_id = ${w.id} and period_start = ${period.from}::timestamptz and period_end = ${period.to}::timestamptz) limit 1`);
      if (existing.rows[0]) {
        counts.exists++;
        continue;
      }
      const messages = await channelMessages(ctx.db, ctx.userId, { rowId: w.channel_row_id, ref: w.channel_ref, label: w.label }, period);
      const lagMs = now.getTime() - to.getTime();
      const coverage = lagMs > STALE_COVERAGE_MS ? { complete: false, note: `Slack was read for ${w.label} only up to ${to.toISOString()}; later messages come in the next brief.` } : undefined;
      if (messages.some((m) => m.text.trim())) {
        const budget = await store.budgetStatus();
        if (budget.state === 'capped') {
          counts.deferred_budget++;
          continue;
        }
      }
      if (askNext && gate && messages.some((m) => m.text.trim())) {
        // H-5: past the hold with a paid brief still to write: raise a hand before this call; the rest waits for it
        await gate.ask({ pctDone: null }).catch(() => undefined);
        break;
      }
      context ??= await myContext(ctx.db, ctx.userId);
      model ??= agentSdkCompletionModel();
      const out = await channelBrief({
        now,
        user: { name: user.name, role: persona.label, tz: user.tz, ...(user.slackId ? { slackId: user.slackId } : {}) },
        watch: { id: w.id, label: w.label, cadence, style: w.style, detailLevel: w.detail_level, maxHighlights: w.max_highlights },
        period,
        messages,
        myContext: context,
        ...(coverage ? { coverage } : {}),
        model,
        maxCallUsd: gate ? Math.max(deps.maxCallUsd ?? DEFAULT_MAX_CALL_USD, gate.ceilingUsd()) : (deps.maxCallUsd ?? DEFAULT_MAX_CALL_USD),
        skillsDir: deps.skillsDir,
        signal: ctx.signal,
      });
      if (out.costUsd > 0)
        await store.recordSpend({
          connector: 'brief',
          model: out.model ?? 'unknown',
          costUsd: out.costUsd,
          jobId: ctx.job.id,
          skill: 'brief-channel',
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          cacheReadTokens: out.cacheReadTokens ?? 0,
          cacheWriteTokens: out.cacheWriteTokens ?? 0,
          trigger: typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : 'schedule',
          modelReason: 'default',
          // D0: the prompt's own inputs hash (the brief engine's), else the watch and its period
          contentHash: ledgerHash(out.model ?? 'unknown', out.promptVersion ?? null, out.inputsHash ?? `${w.id}:${period.from}:${period.to}`),
          outcome: out.status === 'failed' ? `failed:${out.code}` : out.status,
        });
      costUsd += out.costUsd;
      if (gate?.observe(costUsd) === 'ask') askNext = true;
      if (out.status === 'failed') {
        counts.failed++;
        errors.push({ watchId: w.id, code: out.code });
        if (out.code !== 'model_auth') soon();
        continue;
      }
      await writeBrief(ctx.db, ctx.userId, now, user.tz, { watchId: w.id, label: w.label, jobId: ctx.job.id, out, messages, coverage });
      counts[out.status]++;
      briefs.push({ watchId: w.id, briefId: briefRowId, status: out.status, messages: messages.length, highlights: out.brief.highlights.length, costUsd: Number(out.costUsd.toFixed(6)) });
      if (cadence === 'every_4h') later(now.getTime() + 4 * 3_600_000);
    }

    await finishJobSpend(gov, envelope, costUsd);
    // asked: the watches still due wait in one queued run carrying the hold (the follow-up key keeps one queued)
    const paused = await spendPauseResult(ctx, envelope, { dedupeKey: briefFollowUpKey(ctx.userId), payload: { trigger: 'follow_up', retry: 0 } });
    let followUpAt: string | null = null;
    if (!paused.paused && next !== undefined && !ctx.signal.aborted && next - now.getTime() < DAY) {
      const at = new Date(Math.max(next, now.getTime() + 5 * MIN));
      const waiting = retrySoon && next <= now.getTime() + WAIT_RETRY_MS;
      await enqueueJob(ctx.db, {
        ownerUserId: ctx.userId,
        kind: BRIEF_JOB_KIND,
        queue: QUEUES.brief,
        dedupeKey: briefFollowUpKey(ctx.userId),
        runAt: at,
        payload: { trigger: 'follow_up', retry: waiting ? retry + 1 : 0 },
        maxAttempts: 3,
      });
      followUpAt = at.toISOString();
    }
    const status = counts.failed ? 'partial' : counts.ready || counts.quiet ? 'ok' : 'nothing_due';
    return { status, counts, briefs, errors, costUsd: Number(costUsd.toFixed(6)), followUpAt, ...paused };
  };
}

async function writeBrief(
  db: Db,
  userId: string,
  now: Date,
  timezone: string,
  b: { watchId: string; label: string; jobId: number; out: Extract<Awaited<ReturnType<typeof channelBrief>>, { brief: unknown }>; messages: ChannelMessage[]; coverage?: { complete: boolean; note?: string } },
): Promise<void> {
  const extractorId = await ensureExtractor(db);
  const { brief } = b.out;
  await withChangeSet({ db, userId, actor: actors.engine('brief-channel'), reason: `brief for ${b.label}`, undoable: false, entity: { type: 'brief', id: uuidFor(brief.id) } }, async (tx, cs) => {
    // insertBrief only touches the brief rows and their ext; me and the kv are for other DataSource writers.
    const w: WriteCtx = { tx, cs, userId, me: { id: userId, name: '' }, now, extractorId, timezone, kv: new Map() };
    const id = await insertBrief(w, brief, b.watchId, b.label);
    await tx.execute(sql`
      update briefs set job_id = ${b.jobId}, cost_usd = ${b.out.costUsd}, input_tokens = ${b.out.inputTokens}, output_tokens = ${b.out.outputTokens},
             model = ${b.out.model ?? null}, inputs_hash = ${b.out.inputsHash ?? null}, source_item_count = ${b.messages.length},
             nothing_new = ${b.out.status === 'quiet'}, coverage_complete = ${b.coverage?.complete ?? true}, coverage_note = ${b.coverage?.note ?? null}
       where id = ${id}`);
    for (const m of b.messages) {
      await tx.execute(sql`insert into provenance_links (source_item_id, brief_id, role, extractor_id) values (${m.sourceItemId}, ${id}, 'context', ${extractorId}) on conflict do nothing`);
    }
    const evidence = b.out.status === 'ready' ? b.out.evidence : {};
    for (const h of brief.highlights) {
      for (const sid of new Set(evidence[h.id] ?? [])) {
        await tx.execute(sql`insert into provenance_links (source_item_id, brief_highlight_id, role, extractor_id) values (${sid}, ${uuidFor(h.id)}, 'basis', ${extractorId}) on conflict do nothing`);
      }
    }
    await tx.execute(sql`
      update watch_subscriptions set last_period_end = greatest(coalesce(last_period_end, '-infinity'), ${brief.period.to}::timestamptz), last_brief_id = ${id}
       where id = ${b.watchId}`);
  });
}

export function briefJobDef(deps: BriefHandlerDeps = {}): JobHandlerDef {
  return {
    kind: BRIEF_JOB_KIND,
    queue: QUEUES.brief,
    wired: true,
    spends: true,
    description: 'watched-channel briefs: the period since the last brief, one Haiku call, the Briefs page (BE-5, R-UI-21)',
    handler: briefHandler(deps),
  };
}
