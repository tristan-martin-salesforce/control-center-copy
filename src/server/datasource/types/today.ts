/** Today and Home, ranking and priority@2. */
import type { In, Out } from './route';

export interface TodaySource {
  getToday(i: In<'getToday'>): Out<'getToday'>;
  rerankToday(i: In<'rerankToday'>): Out<'rerankToday'>;
  getHome(i: In<'getHome'>): Out<'getHome'>;
  /** priority@2 (lane 07 R8): Today's "Preview new ranking" (nothing is persisted). */
  getPriorityPreview(i: In<'getPriorityPreview'>): Out<'getPriorityPreview'>;
  /** Health ▸ the suggested priority rule: apply or dismiss (local, undoable). */
  decidePriorityRule(i: In<'decidePriorityRule'>): Out<'decidePriorityRule'>;
  /** Ops: queue the deterministic re-rank for every user. */
  rerankAllUsers(i: In<'rerankAllUsers'>): Out<'rerankAllUsers'>;
  /**
   * MIN-27: the browser says when the user last left (`x-cc-away-since`, ms). The since-you-left start
   * (`meta.lastActiveAt`) moves forward to it, never back. Optional: the mock keeps its seeded start.
   */
  notePresence?(awaySinceMs: number): Promise<void>;
}
