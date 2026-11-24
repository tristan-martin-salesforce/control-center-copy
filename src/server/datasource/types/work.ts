/** Work items. */
import type { In, Out } from './route';

export interface WorkSource {
  listItems(i: In<'listItems'>): Out<'listItems'>;
  captureItem(i: In<'captureItem'>): Out<'captureItem'>;
  getItem(i: In<'getItem'>): Out<'getItem'>;
  patchItem(i: In<'patchItem'>): Out<'patchItem'>;
  itemAction(i: In<'itemAction'>): Out<'itemAction'>;
  getItemEvidence(i: In<'getItemEvidence'>): Out<'getItemEvidence'>;
  /** AUDIT "why is this here?": evidence → source → scan run → triage verdict → spend. The mock has no runs. */
  getItemTrace(i: In<'getItemTrace'>): Out<'getItemTrace'>;
  /** H-7 "Why is this still open?": the last resolution check (closure_checks) and what triggers the next. */
  getResolutionCheck(i: In<'getResolutionCheck'>): Out<'getResolutionCheck'>;
  getItemHistory(i: In<'getItemHistory'>): Out<'getItemHistory'>;
  markItemSeen(i: In<'markItemSeen'>): Out<'markItemSeen'>;
  getInitiative(i: In<'getInitiative'>): Out<'getInitiative'>;
}
