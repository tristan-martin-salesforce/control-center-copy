/** Needs you (01 R1, D-86) and need decisions. */
import type { In, Out } from './route';

export interface NeedsSource {
  /** Needs you: every Snooze / Not needed decision on a needs row (Deals, the account page, Home ▸ Log & fix). */
  listNeedDecisions(i: In<'listNeedDecisions'>): Out<'listNeedDecisions'>;
  /** Set needs rows aside (one decision per subject, one audited change set, Undo); nothing leaves the app. */
  decideNeed(i: In<'decideNeed'>): Out<'decideNeed'>;
  /** Bring set-aside rows back (drop their decisions; audited, Undo). */
  clearNeedDecision(i: In<'clearNeedDecision'>): Out<'clearNeedDecision'>;
  /** The Needs-you queue (01 R1, D-86): one row per fact, composed from the existing reads (db/needs.ts). */
  listNeeds(i: In<'listNeeds'>): Out<'listNeeds'>;
  /** One verb of a queue row through the existing route it names (same audit, same Undo); never sends. */
  decideNeedRow(i: In<'decideNeedRow'>): Out<'decideNeedRow'>;
}
