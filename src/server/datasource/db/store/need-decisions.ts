/**
 * Needs-you decisions in Postgres (src/contract/needs.ts). D-98 (0036): one `need_decisions` row per (rule, subject),
 * audited, so a decision is one change set with Undo, like the mock's `needDecisions` collection. The callers still
 * speak the kv shape (`cc.need/<rule>/<subjectId>` in the read model's kv map): the kv write helper routes the write to
 * the table and loadKv overlays the rows (../needs-decisions.ts), so this module is unchanged for them.
 */
import { NeedDecision } from '@/contract';
import { needDecisionOrder } from '@/lib/need-decisions';

import { NEED_KV_PREFIX, needKvKey } from '../needs-decisions';
import { writeKv, type WriteCtx } from './common';

export { NEED_KV_PREFIX, needKvKey };

/** Every stored decision (newest first); a value that no longer parses is left out, never thrown on. */
export function needDecisionsOf(kv: ReadonlyMap<string, unknown>): NeedDecision[] {
  const out: NeedDecision[] = [];
  for (const [k, v] of kv) {
    if (!k.startsWith(NEED_KV_PREFIX)) continue;
    const d = NeedDecision.safeParse(v);
    if (d.success) out.push(d.data);
  }
  return out.sort(needDecisionOrder);
}

/** Store (or, with null, drop) one decision inside a change set. */
export async function writeNeedDecision(w: WriteCtx, rule: string, subjectId: string, d: NeedDecision | null): Promise<void> {
  await writeKv(w, needKvKey(rule, subjectId), d);
}
