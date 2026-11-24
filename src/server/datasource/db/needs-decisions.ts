/**
 * D-98 (0036): Needs-you decisions in `need_decisions`, one row per (rule, subject). They were kv rows
 * `cc.need/<rule>/<subjectId>`; the table is audited, so a decision is still one change set with Undo.
 *
 *   write    `writeNeedDecisionRow` (routed from the kv write helper: store/common.ts writeKv) upserts or deletes the
 *            row and drops the old kv copy (kept only with CC_KV_DUAL_WRITE=1, the rollback window).
 *   read     `overlayNeedDecisions` puts the rows into the kv map the read model carries (`needDecisionsOf(kv)` keeps
 *            working unchanged): the row wins, a kv decision with no row yet is the fallback until `kv.backfill` copies
 *            it. `loadNeedDecisions` is the direct read for page-scoped readers (table first, kv fallback).
 */
import { sql } from 'drizzle-orm';

import { NeedDecision } from '@/contract';
import type { DbOrTx, Tx } from '@/db/client';
import { needDecisionOrder } from '@/lib/need-decisions';

import { readMemo } from './reads/session';
import { countKvFallback, dualWriteAll } from './store/sidecar';

export const NEED_KV_PREFIX = 'cc.need/';
export const needKvKey = (rule: string, subjectId: string) => `${NEED_KV_PREFIX}${rule}/${subjectId}`;

/** (rule, subject) of a `cc.need/<rule>/<subject>` key (the rule never holds a slash: NeedRule). */
export function parseNeedKey(key: string): { rule: string; subjectId: string } | null {
  if (!key.startsWith(NEED_KV_PREFIX)) return null;
  const rest = key.slice(NEED_KV_PREFIX.length);
  const i = rest.indexOf('/');
  return i > 0 && i < rest.length - 1 ? { rule: rest.slice(0, i), subjectId: rest.slice(i + 1) } : null;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

interface Row {
  rule: string;
  subject_id: string;
  kind: string;
  until: string | Date | null;
  reason: string | null;
  label: string | null;
  baseline: Record<string, unknown> | null;
  decided_at: string | Date;
}

function decisionOf(r: Row): NeedDecision | null {
  const d = NeedDecision.safeParse({ rule: r.rule, subjectId: r.subject_id, kind: r.kind, until: iso(r.until), reason: r.reason, label: r.label, baseline: r.baseline ?? {}, decidedAt: iso(r.decided_at) });
  return d.success ? d.data : null;
}

/** The user's rows; inside a read memo (reads/session.ts) once per request: the kv overlay and the use-case plan both read them. */
function rows(db: DbOrTx, userId: string): Promise<Row[]> {
  return readMemo(db, `needDecisionRows:${userId}`, async () => {
    const r = await db.execute<Row & Record<string, unknown>>(sql`
      select rule, subject_id, kind, until, reason, label, baseline, decided_at from need_decisions where owner_user_id = ${userId}::uuid order by rule, subject_id`);
    return r.rows;
  });
}

/** Upsert (or, with null, delete) one decision inside the caller's change set; the old kv copy goes. */
export async function writeNeedDecisionRow(tx: Tx, userId: string, rule: string, subjectId: string, d: NeedDecision | null): Promise<void> {
  if (!d) {
    await tx.execute(sql`delete from need_decisions where owner_user_id = ${userId}::uuid and rule = ${rule} and subject_id = ${subjectId}`);
    return;
  }
  const baseline = JSON.stringify(d.baseline ?? {});
  await tx.execute(sql`
    insert into need_decisions (owner_user_id, rule, subject_id, kind, until, reason, label, baseline, decided_at)
    values (${userId}::uuid, ${rule}, ${subjectId}, ${d.kind}, ${d.until}::timestamptz, ${d.reason}, ${d.label}, ${baseline}::jsonb, ${d.decidedAt}::timestamptz)
    on conflict (owner_user_id, rule, subject_id) do update
       set kind = excluded.kind, until = excluded.until, reason = excluded.reason, label = excluded.label, baseline = excluded.baseline,
           decided_at = excluded.decided_at, updated_at = now()
     where (need_decisions.kind, need_decisions.until, need_decisions.reason, need_decisions.label, need_decisions.baseline, need_decisions.decided_at)
           is distinct from (excluded.kind, excluded.until, excluded.reason, excluded.label, excluded.baseline, excluded.decided_at)`);
}

/** The routed kv write: keep the kv copy only in the rollback window. */
export const needDecisionKeepsKv = (): boolean => dualWriteAll();

/** Put the table's decisions into a kv map (`cc.need/…` entries): the row wins; a kv-only decision is a fallback. */
export async function overlayNeedDecisions(db: DbOrTx, userId: string, kv: Map<string, unknown>): Promise<void> {
  const have = new Set<string>();
  for (const r of await rows(db, userId)) {
    const d = decisionOf(r);
    if (!d) continue;
    const key = needKvKey(r.rule, r.subject_id);
    have.add(key);
    kv.set(key, d);
  }
  for (const k of kv.keys()) if (k.startsWith(NEED_KV_PREFIX) && !have.has(k)) countKvFallback();
}

/** Every decision of the user (newest first): the table, then any kv decision the backfill has not copied yet. */
export async function loadNeedDecisions(db: DbOrTx, userId: string): Promise<NeedDecision[]> {
  const out = new Map<string, NeedDecision>();
  for (const r of await rows(db, userId)) {
    const d = decisionOf(r);
    if (d) out.set(needKvKey(d.rule, d.subjectId), d);
  }
  const kv = await db.execute<{ key: string; value: unknown }>(sql`select key, value from user_settings where owner_user_id = ${userId}::uuid and key like 'cc.need/%'`);
  for (const r of kv.rows) {
    if (out.has(r.key)) continue;
    const d = NeedDecision.safeParse(r.value);
    if (!d.success) continue;
    countKvFallback();
    out.set(r.key, d.data);
  }
  return [...out.values()].sort(needDecisionOrder);
}
