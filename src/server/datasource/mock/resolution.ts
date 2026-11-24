/**
 * Mock parity for the resolution check's read models (H-7). The mock records no closure_checks, exactly like a database
 * loaded from the same seed: "Why is this still open?" says "Not checked yet" with what would run the next check, and
 * Health shows the same shadow line the DB computes (this week's closes for me, no checks). The real reads live in
 * src/server/datasource/db/resolution.ts.
 */
import type { ResolutionCheckPayload, ResolutionShadow, WorkItemRecord } from '@/contract';
import { nextCheckText } from '@/engines/resolution/explain';
import { compareShadow } from '@/engines/resolution/shadow';

export function mockResolutionCheck(rec: WorkItemRecord, now: Date, mode: 'legacy' | 'shadow' | 'live'): ResolutionCheckPayload {
  return { itemId: rec.id, mode, last: null, history: [], reopenUndoId: null, nextCheck: nextCheckText(rec.state, mode, null, now) };
}

/** The same comparison as the DB (closes for me this week vs the checks); the mock records no checks. */
export function mockResolutionShadow(mode: 'legacy' | 'shadow' | 'live', items: WorkItemRecord[], now: Date): ResolutionShadow | null {
  if (mode !== 'shadow') return null;
  const since = now.getTime() - 7 * 86_400_000;
  const legacy = items.filter((w) => w.state === 'done' && w.doneBy === 'engine' && !!w.doneAt && Date.parse(w.doneAt) >= since).map((w) => w.id);
  const { agreed: _a, ...c } = compareShadow(legacy, []);
  return c;
}
