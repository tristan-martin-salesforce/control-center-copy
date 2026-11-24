/**
 * The attribution engine (holistic review 2026-11-20, lane 06 R1-R5): one ranked answer with reasons for "which opp or
 * account is this about?", for every time and activity path, that learns from every correction.
 *
 *   score.ts        attribute(signal, world): every evidence source in one pass
 *   rules.ts        learned rules (mapping_rules): read first, written on every accept / edit / reject
 *   activity.ts     the activity engine's meeting and Slack mappers (classify.ts, blocks.ts) through the engine
 *   row.ts          Time rows (the Needs you suggestion and the canvas pre-fill), with the legacy rules kept
 *   engagement.ts   opp_engagement: per opp × week, what I did (credit to the logged opp and the alternates)
 *   touches.ts      Time rows as engagement touches
 *   dc.ts           DC suggestions from engagement, covered AEs and dcProducts; several opps per engagement
 *   discover.ts     live Org62 discovery (fixed SELECTs) and the covered-AE lookup
 *   rundown.ts      the rundown of opps when unsure
 *   view.ts         the records as the contract shows them (rules, DC suggestions)
 */
export * from './types';
export * from './weights';
export * from './text';
export * from './rules';
export * from './score';
export * from './activity';
export * from './row';
export * from './engagement';
export * from './touches';
export * from './dc';
export * from './discover';
export * from './rundown';
export * from './view';
