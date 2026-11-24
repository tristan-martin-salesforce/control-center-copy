/**
 * ask #14 (docs/EDGE-CASES.md "Worker", W2): a window read again after a run that never finished (the worker was
 * killed, the run failed after recording) finds its messages already stored, so the store says "not new, not
 * changed". Paths that interpret only new or changed messages (linking deferred at the hard cap, LLM linking off)
 * then never looked at them: lost. A stored message nobody judged (no verdict, no evidence) counts as unread.
 */
import type { ScannerStore } from '../types';

type Recorded = { sourceItemId: string; isNew: boolean; changed: boolean };

/** The recorded rows to interpret: new, changed, or unchanged with no verdict and no evidence yet. */
export async function toInterpret<R extends Recorded>(store: Pick<ScannerStore, 'triageVerdicts'>, rows: R[]): Promise<R[]> {
  const fresh = rows.filter((r) => r.isNew || r.changed);
  const seen = rows.filter((r) => !r.isNew && !r.changed);
  if (!seen.length || !store.triageVerdicts) return fresh;
  // the store can't say: keep the old rule (new or changed only) rather than re-flag everything
  const judged = await store.triageVerdicts(seen.map((r) => r.sourceItemId)).catch(() => null);
  if (!judged) return fresh;
  return rows.filter((r) => r.isNew || r.changed || !judged.has(r.sourceItemId));
}
