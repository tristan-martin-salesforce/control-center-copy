/**
 * The resolution check on Postgres (src/engines/resolution): what one check reads (read-only), the closure_checks
 * ledger it writes, and the read models over it: the item panel's "Why still open", Health's shadow comparison,
 * `scan:explain --item` and `scan:report --yield`. Ids, codes and numbers only in the ledger, never message text.
 */
import { sql } from 'drizzle-orm';

import type { ClosingSettings, ResolutionCheckPayload, ResolutionCheckView } from '@/contract';
import { checkWhy, nextCheckText } from '@/engines/resolution/explain';
import type { Db, DbOrTx } from '@/db/client';
import { closureChecks } from '@/db/schema';
import type { ResolutionStore } from '@/engines/resolution/check';
import { deliverableWords } from '@/engines/resolution/pack';
import { compareShadow, type ShadowComparison } from '@/engines/resolution/shadow';
import { RESOLUTION_SKILL, type CheckRecord, type EscalationReason, type EscalationStat, type LastCheck, type RawFileRevision, type RawSession, type ResolutionItem, type ResolutionOutcome, type ResolutionRaw } from '@/engines/resolution/types';
import { autoCloseBlock } from '@/engines/closure/correction';
import { loadCorrectionFacts } from '@/engines/closure/correction-db';
import { loadSettleRaw } from '@/engines/settle/load-db';
import { loadClosingSettings, policyFacts } from '@/engines/settle/select-db';
import type { ClosureItem } from '@/engines/types';
import { ESCALATION_WINDOW_DAYS } from '@/engines/resolution/escalation';

const DAY = 86_400_000;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
type R = Record<string, unknown>;

async function rows<T = R>(db: DbOrTx, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

/** Everything one check needs about an item. Null: gone, merged, or not this user's. */
export async function loadResolutionForCheck(db: Db, userId: string, itemId: string, now: Date, settings?: ClosingSettings): Promise<{ item: ResolutionItem; raw: ResolutionRaw } | null> {
  const w = (
    await rows(db, sql`
      select wi.id::text as id, wi.version, wi.kind::text as kind, wi.status::text as status, wi.title, wi.done_at, wi.done_by::text as done_by,
             wi.reopened_count, wi.last_reopened_at, wi.status_changed_at, wi.involvement::text as involvement, wi.resolution::text as resolution,
             wi.merged_into_id, o.amount as deal_usd, cp.tier::text as person_tier
        from work_items wi
        left join opportunities o on o.id = wi.opportunity_id
        left join people cp on cp.id = wi.counterparty_person_id
       where wi.owner_user_id = ${userId} and wi.id::text = ${itemId}`)
  )[0];
  if (!w || w.merged_into_id) return null;
  const settle = await loadSettleRaw(db, userId, itemId, { now });
  if (!settle) return null;
  const s = settings ?? (await loadClosingSettings(db, userId));
  const policy = (await policyFacts(db, userId, [itemId])).get(itemId);
  if (!policy) return null;
  const block = autoCloseBlock({ userReopened: policy.userReopened, userKept: !!policy.userKept, externalCommitment: policy.externalCommitment, people: policy.people, channels: policy.channels }, s);
  const ask = settle.evidence.find((e) => e.role === 'origin') ?? settle.evidence[0];
  const askAt = ask?.at ?? settle.item.createdAt;

  // Attachments on the conversation and evidence rows (D1's delivery match needs names, not text).
  const ids = [...new Set([...settle.evidence, ...settle.conversation].map((r) => r.id))];
  const files = new Map<string, { files?: Array<{ name?: string; mimetype?: string }>; hasFile?: boolean }>();
  if (ids.length) {
    for (const r of await rows(db, sql`select id::text as id, meta->'files' as files, (meta->>'hasFile') = 'true' as has_file from source_items where id::text = any(${sql`array[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::text[]`})`)) {
      const f = Array.isArray(r.files) ? (r.files as Array<{ name?: string; mimetype?: string }>).map((x) => ({ ...(x.name ? { name: x.name } : {}), ...(x.mimetype ? { mimetype: x.mimetype } : {}) })) : [];
      files.set(String(r.id), { ...(f.length ? { files: f } : {}), ...(r.has_file ? { hasFile: true } : {}) });
    }
  }
  const withFiles = <T extends { id: string }>(r: T) => ({ ...r, ...files.get(r.id) });

  // Revisions and shares of the item's files, after the ask.
  const revisions: RawFileRevision[] = (
    await rows(db, sql`
      select si.id::text as id, ref.value as file_id, si.title, si.occurred_at, si.from_me, si.kind::text as kind, si.url,
             coalesce(si.meta->'author'->>'name', si.meta->>'lastModifyingUser') as editor,
             left(coalesce(si.meta->>'changes', si.body), 300) as changes
        from source_items si join source_item_refs ref on ref.source_item_id = si.id and ref.kind = 'drive_file'
       where si.owner_user_id = ${userId} and si.source = 'drive' and si.occurred_at > ${askAt}::timestamptz
         and ref.value in (select r2.value from work_item_evidence e join source_item_refs r2 on r2.source_item_id = e.source_item_id and r2.kind = 'drive_file' where e.work_item_id = ${itemId}::uuid)
       order by si.occurred_at desc limit 4`)
  ).map((r) => ({ sourceItemId: String(r.id), fileId: String(r.file_id), title: (r.title as string) ?? null, at: iso(r.occurred_at)!, byMe: !!r.from_me, editor: (r.editor as string) ?? null, changes: (r.changes as string) ?? null, ...(String(r.kind).includes('share') ? { share: true } : {}), url: (r.url as string) ?? null }));

  // Claude sessions: linked as evidence, launched for it, or naming two of its deliverable words, after the ask.
  const noun = deliverableWords(settle.item.title);
  const names = (t: string) => {
    const ws = new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
    return noun.filter((x) => ws.has(x)).length;
  };
  const sessions: RawSession[] = (
    await rows(db, sql`
      select si.id::text as id, coalesce(si.meta->>'sessionId', si.external_id) as session_id, coalesce(si.meta->>'status', 'unknown') as status, si.title, si.occurred_at,
             right(coalesce(si.meta->>'summary', si.body, ''), 300) as last_message,
             (exists (select 1 from work_item_evidence e where e.work_item_id = ${itemId}::uuid and e.source_item_id = si.id)
              or exists (select 1 from claude_sessions cs where cs.source_item_id = si.id and cs.launch_work_item_id = ${itemId}::uuid)) as linked
        from source_items si
       where si.owner_user_id = ${userId} and si.source = 'claude' and si.occurred_at > ${askAt}::timestamptz and si.occurred_at > ${new Date(now.getTime() - 30 * DAY).toISOString()}::timestamptz
       order by si.occurred_at desc limit 20`)
  )
    .filter((r) => !!r.linked || names(`${r.title ?? ''} ${r.last_message ?? ''}`) >= 2)
    .slice(0, 2)
    .map((r) => ({ sourceItemId: String(r.id), sessionId: String(r.session_id), status: String(r.status), title: (r.title as string) ?? null, at: iso(r.occurred_at)!, lastMessage: (r.last_message as string) || null }));

  // Gemini notes linked to it.
  const notes = settle.evidence.filter((e) => e.source === 'gemini_notes');
  const last = await lastClosureCheck(db, userId, itemId);
  const latestInputAt = [...settle.conversation, ...settle.evidence, ...revisions, ...sessions].map((r) => r.at).sort().at(-1) ?? null;
  const raw: ResolutionRaw = {
    ...settle,
    evidence: settle.evidence.map(withFiles),
    conversation: settle.conversation.map(withFiles),
    files: revisions,
    sessions,
    notes,
    record: null,
    lastCheck: last ? { at: last.at, verdict: last.verdict, outcome: last.outcome as ResolutionOutcome, citeAlias: last.citeAlias } : null,
    latestInputAt,
  };
  const closure: ClosureItem = {
    id: String(w.id),
    version: Number(w.version ?? 1),
    kind: String(w.kind) as ClosureItem['kind'],
    status: String(w.status) as ClosureItem['status'],
    statusChangedAt: iso(w.status_changed_at),
    title: String(w.title),
    resolution: (w.resolution as ClosureItem['resolution']) ?? null,
    involvement: (w.involvement as ClosureItem['involvement']) ?? 'owner',
    doneAt: iso(w.done_at),
    doneBy: (w.done_by as ClosureItem['doneBy']) ?? null,
    mayAutoClose: block === null,
    autoCloseBlock: block,
    reopenedCount: Number(w.reopened_count ?? 0),
    lastReopenedAt: iso(w.last_reopened_at),
  };
  const item: ResolutionItem = {
    id: closure.id,
    kind: closure.kind,
    status: closure.status,
    title: closure.title,
    closure,
    policy,
    worth: { dealUsd: w.deal_usd == null ? null : Number(w.deal_usd), personTier: (w.person_tier as string) ?? null },
    reopenedCount: closure.reopenedCount ?? 0,
    lastReopenAt: closure.lastReopenedAt ?? null,
  };
  return { item, raw };
}

export async function recordClosureCheck(db: DbOrTx, userId: string, r: CheckRecord): Promise<number> {
  const [row] = await db
    .insert(closureChecks)
    .values({
      ownerUserId: userId,
      workItemId: r.workItemId,
      at: new Date(r.at),
      trigger: r.trigger,
      mode: r.mode,
      statusBefore: r.statusBefore,
      packDigest: r.packDigest,
      packTokens: r.packTokens,
      packLines: r.packLines,
      rulesFired: r.rulesFired,
      ruleHit: r.ruleHit,
      decidedBy: r.decidedBy,
      verdict: r.verdict,
      basis: r.basis,
      confidence: r.confidence,
      citeAlias: r.citeAlias,
      citeSourceItemId: r.citeSourceItemId,
      escalated: r.escalated,
      escalationReason: r.escalationReason,
      escalationChanged: r.escalationChanged,
      outcome: r.outcome,
      blockedBy: r.blockedBy ? r.blockedBy.slice(0, 120) : null,
      model: r.model,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      llmCallId: r.llmCallId ?? null,
      durationMs: r.durationMs,
      engineVersion: r.engineVersion,
    })
    .returning({ id: closureChecks.id });
  return row!.id;
}

export interface ClosureCheckView extends CheckRecord {
  id: number;
}

function viewOf(r: R): ClosureCheckView {
  return {
    id: Number(r.id),
    workItemId: String(r.work_item_id),
    at: iso(r.at)!,
    trigger: r.trigger as CheckRecord['trigger'],
    mode: r.mode as CheckRecord['mode'],
    statusBefore: String(r.status_before),
    packDigest: String(r.pack_digest),
    packTokens: Number(r.pack_tokens),
    packLines: Number(r.pack_lines),
    rulesFired: (r.rules_fired as string[]) ?? [],
    ruleHit: (r.rule_hit as string) ?? null,
    decidedBy: r.decided_by as CheckRecord['decidedBy'],
    verdict: (r.verdict as string) ?? null,
    basis: (r.basis as string) ?? null,
    confidence: r.confidence == null ? null : Number(r.confidence),
    citeAlias: (r.cite_alias as string) ?? null,
    citeSourceItemId: (r.cite_source_item_id as string) ?? null,
    escalated: !!r.escalated,
    escalationReason: (r.escalation_reason as string) ?? null,
    escalationChanged: r.escalation_changed == null ? null : !!r.escalation_changed,
    outcome: r.outcome as ResolutionOutcome,
    blockedBy: (r.blocked_by as string) ?? null,
    model: (r.model as string) ?? null,
    costUsd: Number(r.cost_usd ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    llmCallId: r.llm_call_id == null ? null : Number(r.llm_call_id),
    durationMs: Number(r.duration_ms ?? 0),
    engineVersion: String(r.engine_version),
  };
}

export async function closureCheckHistory(db: DbOrTx, userId: string, itemId: string, limit = 10): Promise<ClosureCheckView[]> {
  return (await rows(db, sql`select * from closure_checks where owner_user_id = ${userId} and work_item_id::text = ${itemId} order by at desc, id desc limit ${limit}`)).map(viewOf);
}

export async function lastClosureCheck(db: DbOrTx, userId: string, itemId: string): Promise<ClosureCheckView | null> {
  return (await closureCheckHistory(db, userId, itemId, 1))[0] ?? null;
}

/**
 * The escalation data gate: the stronger model's resolution calls over the last 14 days, per reason (model_reason
 * `escalation:<reason>`), and how many of their items got a different verdict (llm_calls.escalation_changed_items).
 */
export async function resolutionEscalationStats(db: DbOrTx, userId: string, now: Date): Promise<EscalationStat[]> {
  const since = new Date(now.getTime() - ESCALATION_WINDOW_DAYS * DAY).toISOString();
  return (
    await rows(db, sql`
      select substr(model_reason, 12) as reason, coalesce(sum(coalesce(items_in, 1)), 0)::int as escalations, coalesce(sum(escalation_changed_items), 0)::int as changed
        from llm_calls
       where owner_user_id = ${userId} and skill_key = ${RESOLUTION_SKILL} and model_reason like 'escalation:%'
         and escalation_changed_items is not null and started_at >= ${since}::timestamptz
       group by 1`)
  ).map((r) => ({ reason: String(r.reason) as EscalationReason, escalations: Number(r.escalations), changed: Number(r.changed) }));
}

/** Health: the shadow check against what the legacy closers closed for me over the last 7 days. */
export async function resolutionShadowComparison(db: DbOrTx, userId: string, now: Date): Promise<ShadowComparison> {
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const legacy = await rows<{ id: string }>(db, sql`select id::text as id from work_items where owner_user_id = ${userId} and status = 'done' and done_by = 'engine' and done_at >= ${since}::timestamptz`);
  const checks = await rows(db, sql`select work_item_id::text as id, at, outcome from closure_checks where owner_user_id = ${userId} and mode = 'shadow' and at >= ${since}::timestamptz`);
  return compareShadow(
    legacy.map((r) => r.id),
    checks.map((c) => ({ workItemId: String(c.id), at: iso(c.at)!, outcome: c.outcome as ResolutionOutcome })),
  );
}

/** scan:report --yield: what the checks cost and decided. */
export async function resolutionYield(db: DbOrTx, userId: string | null, since: string): Promise<{ checks: number; byRules: number; costUsd: number; perCheckUsd: number; closed: number; likely: number; asked: number; reopened: number; escalated: number }> {
  const r = (
    await rows(db, sql`
      select count(*)::int as n, count(*) filter (where decided_by = 'rule')::int as rules, coalesce(sum(cost_usd), 0)::float as usd,
             count(*) filter (where outcome = 'closed')::int as closed, count(*) filter (where outcome = 'likely')::int as likely,
             count(*) filter (where outcome = 'asked')::int as asked, count(*) filter (where outcome = 'reopened')::int as reopened,
             count(*) filter (where escalated)::int as escalated
        from closure_checks where at >= ${since}::timestamptz ${userId ? sql`and owner_user_id = ${userId}` : sql``}`)
  )[0]!;
  const n = Number(r.n);
  return { checks: n, byRules: Number(r.rules), costUsd: Number(r.usd), perCheckUsd: n ? Number(r.usd) / n : 0, closed: Number(r.closed), likely: Number(r.likely), asked: Number(r.asked), reopened: Number(r.reopened), escalated: Number(r.escalated) };
}

/** The engine's store over Postgres. */
export function dbResolutionStore(db: Db, userId: string, settings?: ClosingSettings): ResolutionStore {
  return {
    loadForCheck: (id, now) => loadResolutionForCheck(db, userId, id, now, settings),
    recordCheck: (row) => recordClosureCheck(db, userId, row),
    escalationStats: (now) => resolutionEscalationStats(db, userId, now),
  };
}

export type { LastCheck };

/** "Why is this still open?": the last checks of an item in plain words, and what runs the next one. */
export async function getResolutionCheckPayload(db: Db, userId: string, itemId: string, now: Date): Promise<ResolutionCheckPayload> {
  const settings = await loadClosingSettings(db, userId);
  const st = (await rows<{ status: string }>(db, sql`select status::text as status from work_items where owner_user_id = ${userId} and id::text = ${itemId}`))[0];
  const hist = await closureCheckHistory(db, userId, itemId, 6);
  const urls = new Map<string, string | null>();
  const cites = [...new Set(hist.map((h) => h.citeSourceItemId).filter((x): x is string => !!x))];
  if (cites.length) for (const r of await rows(db, sql`select id::text as id, url from source_items where id::text = any(${sql`array[${sql.join(cites.map((c) => sql`${c}`), sql`, `)}]::text[]`})`)) urls.set(String(r.id), (r.url as string) ?? null);
  const view = (h: ClosureCheckView): ResolutionCheckView => ({
    at: h.at,
    trigger: h.trigger,
    mode: h.mode,
    decidedBy: h.decidedBy,
    ruleHit: h.ruleHit,
    verdict: h.verdict,
    confidence: h.confidence,
    outcome: h.outcome,
    blockedBy: h.blockedBy,
    escalated: h.escalated,
    costUsd: h.costUsd,
    citeSourceItemId: h.citeSourceItemId,
    citeUrl: h.citeSourceItemId ? (urls.get(h.citeSourceItemId) ?? null) : null,
    why: checkWhy(h),
  });
  return {
    itemId,
    mode: settings.resolutionEngine,
    last: hist[0] ? view(hist[0]) : null,
    history: hist.slice(1).map(view),
    nextCheck: nextCheckText(st?.status ?? 'open', settings.resolutionEngine, hist[0]?.at ?? null, now),
    reopenUndoId: (await loadCorrectionFacts(db, userId, [itemId])).get(itemId)?.reopenUndoId ?? null,
  };
}
