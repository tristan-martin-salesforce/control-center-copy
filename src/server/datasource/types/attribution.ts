/** The attribution engine (src/engines/attribution; db/attribution.ts, mock/attribution.ts). */
import type { In, Out } from './route';

export interface AttributionSource {
  /** Settings ▸ Time ▸ Learned rules: the rules the engine learned from your corrections. */
  getAttributionRules(i: In<'getAttributionRules'>): Out<'getAttributionRules'>;
  patchAttributionRule(i: In<'patchAttributionRule'>): Out<'patchAttributionRule'>;
  deleteAttributionRule(i: In<'deleteAttributionRule'>): Out<'deleteAttributionRule'>;
  /** The DCs the app suggests claiming (from engagement, teams, covered AEs); nothing is claimed until Accept. */
  getDcSuggestions(i: In<'getDcSuggestions'>): Out<'getDcSuggestions'>;
  /** Accept / Edit (a DC request that rides the next logging canvas) or Reject; teaches the engine. */
  decideDcSuggestion(i: In<'decideDcSuggestion'>): Out<'decideDcSuggestion'>;
  refreshDcSuggestions(i: In<'refreshDcSuggestions'>): Out<'refreshDcSuggestions'>;
  /** The rundown of opps when unsure (a row's or an account's likely opps with my recent work on each). */
  getOppRundown(i: In<'getOppRundown'>): Out<'getOppRundown'>;
  /** AEs I cover: the app's people, then one read-only Org62 User read (queued for the worker where Org62 is live). */
  lookupCoveredAe(i: In<'lookupCoveredAe'>): Out<'lookupCoveredAe'>;
}
