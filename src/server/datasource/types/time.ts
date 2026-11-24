/** Time: the week, the Log, the ledger, the opp picker, onsite days, dismiss rules. */
import type { In, Out } from './route';

export interface TimeSource {
  getTime(i: In<'getTime'>): Out<'getTime'>;
  /** Every activity row in a range, filtered, with week / month / fiscal-quarter totals (the Log view). */
  getActivityLog(i: In<'getActivityLog'>): Out<'getActivityLog'>;
  getTimeLedger(i: In<'getTimeLedger'>): Out<'getTimeLedger'>;
  /** 2026-11-13 audit C4: a created logging canvas, read back from Org62 sooner (after the copied prompt, or now); reads only. */
  checkCanvasOrg62(i: In<'checkCanvasOrg62'>): Out<'checkCanvasOrg62'>;
  patchActivity(i: In<'patchActivity'>): Out<'patchActivity'>;
  /** A row's opportunity picker: every opp ranked for the row (shared builder: src/server/datasource/opp-options.ts). */
  getOppOptions(i: In<'getOppOptions'>): Out<'getOppOptions'>;
  /** "Search Org62 for '…'": one live, read-only lookup (mock: placeholder rows). */
  searchOrg62Opps(i: In<'searchOrg62Opps'>): Out<'searchOrg62Opps'>;
  /** Set a row's opp from an Org62 hit, adding the opp (and its account) the app lacks: one undoable change set. */
  pickOrg62Opp(i: In<'pickOrg62Opp'>): Out<'pickOrg62Opp'>;
  resolveActivity(i: In<'resolveActivity'>): Out<'resolveActivity'>;
  syncCanvas(i: In<'syncCanvas'>): Out<'syncCanvas'>;
  /** Onsite lane: the day chip's corrections and Mark trip (locked overrides the projections respect). */
  correctOnsiteDay(i: In<'correctOnsiteDay'>): Out<'correctOnsiteDay'>;
  markTrip(i: In<'markTrip'>): Out<'markTrip'>;
  /** D-64: the remembered "Dismiss all from <source>" rules (Settings ▸ Time ▸ Dismissed sources). */
  listTimeDismissRules(i: In<'listTimeDismissRules'>): Out<'listTimeDismissRules'>;
  /** D-64: dismiss every live row of this row's source and remember it (one audited change set, Undo). */
  dismissFromSource(i: In<'dismissFromSource'>): Out<'dismissFromSource'>;
  /** D-64: remove a rule; the rows it set aside come back as proposals (one audited change set, Undo). */
  removeTimeDismissRule(i: In<'removeTimeDismissRule'>): Out<'removeTimeDismissRule'>;
}
