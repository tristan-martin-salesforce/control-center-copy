/**
 * The starting weight of each evidence source (lane 06 §4a). Config, not code: a caller (and later Settings, once the
 * accept-rate log says how) overrides any of them through `World.weights`. Tune by data (attribution_outcomes), not by
 * decision prose.
 */
import type { AttributionWeights } from './types';

export const DEFAULT_WEIGHTS: Readonly<AttributionWeights> = {
  explicitOpp: 0.9,
  explicitAccount: 0.8,
  ruleOpp: 0.9,
  ruleAccount: 0.7,
  channelMapOpp: 0.88,
  channelMapAccount: 0.85,
  channelName: 0.8,
  titleName: 0.8,
  titleAlias: 0.75,
  personAccount: 0.6,
  domainAccount: 0.6,
  relatedAccount: 0.55,
  keywordOpp: 0.5,
  keywordOppStrong: 0.7,
  teamOverlap: 0.5,
  coveredAe: 0.3,
  engagementRecent: 0.15,
  recentUse: 0.15,
  mine: 0.1,
  closedPenalty: 0.3,
  settle: 0.75,
  margin: 0.15,
};

export const weightsOf = (w?: Partial<AttributionWeights>): AttributionWeights => ({ ...DEFAULT_WEIGHTS, ...(w ?? {}) });

/** 1 − Π(1 − wᵢ): independent evidence adds up and never passes 1. */
export function combine(ws: readonly number[]): number {
  let miss = 1;
  for (const w of ws) miss *= 1 - Math.max(0, Math.min(1, w));
  return Math.round((1 - miss) * 1000) / 1000;
}
