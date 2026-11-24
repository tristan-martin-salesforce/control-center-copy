/**
 * Use-case candidates (holistic review 2026-11-20 lane 06 R6; H-9; docs/EDGE-CASES.md UC-11..UC-20):
 *
 *   vocab.ts     the product vocabulary (Settings ▸ Time dcProducts + VDP's tracks and agent types)
 *   extract.ts   the deterministic extractor: use-case shaped statements in notes, meetings, Slack and mail
 *   confirm.ts   the tool-less Haiku pass for the statements the extractor is unsure of (prompt + strict parse)
 *   similar.ts   the dedupe key and the fuzzy title match (pg_trgm's similarity)
 *   plan.ts      mentions → candidates through attribute(), deduped against both systems and the candidates
 *   stage.ts     Accept / Edit / Reject, the two drafts Accept stages, the canvas row, the landing
 *   view.ts      the contract's view
 *   mentions.ts  every source's mentions, split into sure and unsure
 */
export * from './types';
export * from './vocab';
export * from './extract';
export * from './confirm';
export * from './similar';
export * from './plan';
export * from './stage';
export * from './view';
export * from './mentions';
