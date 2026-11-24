/**
 * The static estimate table: what the governor assumes before measurement has at least 10 samples for a skill
 * (llm_calls over 14 days). USD per run (or per item for the scopes that scale with items). Checked against the list
 * prices in src/llm/models.ts (Haiku 5.5 $0.10 / $0.50 per MTok, cache read $0.01, write $0.125; Sonnet 5.5 $2 / $10,
 * read $0.20, write $2.50) and the token profiles of review 04 §3.1:
 *  - a Haiku scan run: a ~40K-token prefix written once, re-read over ~5 turns, ~3K out: about $0.008; a busy Slack or
 *    Org62 page about $0.03.
 *  - an Assistant message on Sonnet: ~30K tokens written, ~1K out, a few reads: about $0.10; a long list turn $0.35.
 *  - a relay (one MCP call through a 2-turn Haiku run): about $0.002.
 * These are estimates, never limits: a run that passes its p90 raises a hand and continues on a yes.
 */
import type { Estimate, SpendScope } from './types';

export interface DefaultCost {
  p50: number;
  p90: number;
  /** The figure is per item (multiply by the job's items). */
  perItem?: boolean;
}

/** By scope, then by skill (llm_calls.skill_key) where one skill differs from its scope's default. */
export const DEFAULT_COSTS: Record<SpendScope, { default: DefaultCost; skills?: Record<string, DefaultCost> }> = {
  scan_run: {
    default: { p50: 0.008, p90: 0.03 },
    skills: {
      'scan-slack': { p50: 0.012, p90: 0.045 },
      'scan-org62': { p50: 0.015, p90: 0.05 },
      'scan-gmail': { p50: 0.01, p90: 0.04 },
      // F-4: a relink run (Haiku, then the one Sonnet escalation) before it has history: its old caps
      relink: { p50: 0.02, p90: 0.05 },
      'relink-escalated': { p50: 0.1, p90: 0.25 },
    },
  },
  chat_message: {
    default: { p50: 0.1, p90: 0.35 },
    skills: { 'chat-assistant@opus': { p50: 0.2, p90: 0.7 } },
  },
  research: { default: { p50: 0.15, p90: 0.45 } },
  relay: {
    default: { p50: 0.002, p90: 0.01 },
    // post-relay-holds: a relay job runs under one hold for all its lookups (~$0.002 each), so its row is the job's:
    // a few batches of opps or accounts (hierarchy: up to five levels), a read-back's Events, DCs, opps and use cases,
    // discovery's 20 lookups a day at most
    skills: {
      'vdp-specialist-aes': { p50: 0.004, p90: 0.02 },
      'accounts-hierarchy': { p50: 0.006, p90: 0.03 },
      'org62-readback': { p50: 0.02, p90: 0.06 },
      'org62-discover': { p50: 0.02, p90: 0.05 },
    },
  },
  // Settle judges one item per call (Haiku), ~38% escalated (Sonnet, review 04 COST-10).
  settle_pass: { default: { p50: 0.002, p90: 0.012, perItem: true } },
  feedback: { default: { p50: 0.12, p90: 0.35 } },
  job: {
    default: { p50: 0.02, p90: 0.08 },
    skills: {
      // F-4: a completion pass pages at $0.40 (maxPassUsd); until it has history its estimate is that page
      'completion-check': { p50: 0.05, p90: 0.4 },
    },
  },
};

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The table's estimate for a job: its skill's row when there is one, else its scope's; × items when per item. */
export function defaultEstimate(scope: SpendScope, skill?: string, items?: number): Estimate {
  const row = DEFAULT_COSTS[scope];
  const c = (skill && row.skills?.[skill]) || row.default;
  const k = c.perItem ? Math.max(1, items ?? 1) : 1;
  return { p50: round6(c.p50 * k), p90: round6(c.p90 * k), basis: 'default', n: 0 };
}

/**
 * First scan (COST-9): one day of history per source, USD (p50 / p90). From the measured 14-day first scan on one
 * SE's data (src/server/onboarding/cost.ts: Slack $3.66, Org62 $0.50, Gemini notes $0.46, Gmail $0.27, Claude
 * sessions $0.20, Calendar $0.07 over 14 days), p90 at 1.6× for a busier history. Read-ins have their own day line.
 */
export const FIRST_SCAN_SOURCE_DAY_USD: Record<string, { p50: number; p90: number }> = {
  slack: { p50: 0.26, p90: 0.42 },
  org62: { p50: 0.036, p90: 0.06 },
  gemini: { p50: 0.033, p90: 0.053 },
  gmail: { p50: 0.019, p90: 0.031 },
  claude: { p50: 0.014, p90: 0.023 },
  calendar: { p50: 0.005, p90: 0.008 },
  drive: { p50: 0.01, p90: 0.016 },
  vdp: { p50: 0, p90: 0 },
};

/** Read-ins during the first scan: about $1.9-2 measured, under their own $2/day line. */
export const FIRST_SCAN_READINS_USD = { p50: 1.5, p90: 2 };

/** A day of background scanning before 5 measured days: every source's day from the table (Health ▸ Spend). */
export function backgroundDayDefault(): { p50: number; p90: number; basis: 'default' } {
  const t = Object.values(FIRST_SCAN_SOURCE_DAY_USD).reduce((a, c) => ({ p50: a.p50 + c.p50, p90: a.p90 + c.p90 }), { p50: 0, p90: 0 });
  return { p50: Math.round(t.p50 * 100) / 100, p90: Math.round(t.p90 * 100) / 100, basis: 'default' };
}
