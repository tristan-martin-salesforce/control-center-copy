/**
 * What an FTI first scan costs, estimated from volumes and token counts (review 04 §4.1 #7, COST-6; no gateway here,
 * so the arithmetic is shown, src/scanner/interpret/estimate.ts prices it). Measured before: a 30-day first scan on one
 * SE's real data cost $16.24 = scan $12.34 + read-ins $3.90 (src/server/onboarding/cost.ts).
 *
 * The model of an FTI first scan:
 *   Slack inbox     one 24 h chunk a day: S1–S3 (+ S4) relay reads, a page more per 20 messages a query, ≤ 1 thread read
 *   Slack channels  one 7-day chunk a week per channel: one read, a page more per 20 messages
 *   Org62           opps (2 queries), events, dcs per 7-day chunk, a page more per 50 rows
 *   Gmail, Drive, notes   direct MCP (no model)
 *   classifier      the units rules leave (RULE_SETTLED shares), in large batches (BACKFILL_BUDGET: ~45 units a call),
 *                   the skill prefix cached, the batch uncached, ~70 output tokens a verdict
 * Every read and call of a first scan follows the one before within minutes, so relay and classifier prefixes are
 * written once per source and read after that.
 */
import { classifierUsd, relayUsd } from '../interpret/estimate';

export interface FirstScanVolume {
  days: number;
  slack: { inboxMessages: number; channelMessages: number; channels: number };
  gmail: { emails: number };
  drive: { revisions: number };
  notes: { docs: number; myStepsPerDoc: number };
  org62: { rows: number };
}

/** The share of each source's items rules settle with no model (review 04 §4.2: ~80 of ~250 Slack messages reach a model). */
export const RULE_SETTLED = { slackInbox: 0.6, slackChannel: 0.85, gmail: 0.5, drive: 0.7, org62: 0.95 } as const;
/** Tokens of one unit's entry in a batch (header, ≤ 4 context lines, the body; measured on the golden prompts). */
export const UNIT_TOKENS = { slack: 260, gmail: 420, drive: 300, notes: 120, org62: 120 } as const;
export const SYSTEM_TOKENS = 2_500;
export const UNITS_PER_CALL = 45;

export interface EstimateRow {
  source: string;
  relayReads: number;
  units: number;
  calls: number;
  usd: number;
  arithmetic: string;
}

const money = (x: number) => `$${x.toFixed(x < 0.1 ? 4 : 2)}`;

function classify(source: string, units: number, tokensPerUnit: number) {
  const calls = Math.ceil(units / UNITS_PER_CALL);
  let usd = 0;
  for (let i = 0; i < calls; i++) {
    const n = i === calls - 1 ? units - UNITS_PER_CALL * (calls - 1) : UNITS_PER_CALL;
    usd += classifierUsd({ systemTokens: SYSTEM_TOKENS, userTokens: n * tokensPerUnit, verdicts: n, cold: i === 0 });
  }
  return { calls, usd, text: `${units} units / ${UNITS_PER_CALL} a call = ${calls} classifier call(s) × (${SYSTEM_TOKENS} cached + ≤ ${UNITS_PER_CALL * tokensPerUnit} in + ≤ ${UNITS_PER_CALL * 70 + 60} out tokens) = ${money(usd)}` };
}

function relays(n: number, prefixTokens?: number) {
  let usd = 0;
  for (let i = 0; i < n; i++) usd += relayUsd(i === 0, prefixTokens);
  return usd;
}

export interface EstimateOptions {
  /** Override the rule-settled shares (0 everywhere: every item reaches the classifier). */
  ruleSettled?: Partial<Record<keyof typeof RULE_SETTLED, number>>;
  /** Override the relay request size (RELAY_PREFIX_TOKENS). */
  relayPrefixTokens?: number;
}

export function estimateFtiFirstScan(v: FirstScanVolume, o: EstimateOptions = {}): { rows: EstimateRow[]; totalUsd: number } {
  const rows: EstimateRow[] = [];
  const settled = { ...RULE_SETTLED, ...(o.ruleSettled ?? {}) };
  const relayCost = (n: number) => relays(n, o.relayPrefixTokens);
  const weeks = Math.ceil(v.days / 7);
  {
    const perDay = v.slack.inboxMessages / Math.max(1, v.days);
    const pages = Math.max(0, Math.ceil(perDay / 3 / 20) - 1); // three queries share a day's messages
    const inboxReads = v.days * (4 + 3 * pages + 1);
    const channelReads = v.slack.channels * weeks * (1 + Math.max(0, Math.ceil(v.slack.channelMessages / Math.max(1, v.slack.channels) / weeks / 20) - 1));
    const units = Math.round(v.slack.inboxMessages * (1 - settled.slackInbox) + v.slack.channelMessages * (1 - settled.slackChannel));
    const reads = inboxReads + channelReads;
    const r = relayCost(reads);
    const c = classify('slack', units, UNIT_TOKENS.slack);
    rows.push({ source: 'slack', relayReads: reads, units, calls: c.calls, usd: r + c.usd, arithmetic: `${v.days} days × (S1–S4 + ${3 * pages} page(s) + 1 thread) + ${v.slack.channels} channel(s) × ${weeks} week(s) = ${reads} relay reads × ~${money(relayUsd(false, o.relayPrefixTokens))} = ${money(r)}; ${c.text}` });
  }
  {
    const units = Math.round(v.gmail.emails * (1 - settled.gmail));
    const c = classify('gmail', units, UNIT_TOKENS.gmail);
    rows.push({ source: 'gmail', relayReads: 0, units, calls: c.calls, usd: c.usd, arithmetic: `${v.gmail.emails} emails read by direct MCP ($0); ${c.text}` });
  }
  {
    const units = Math.round(v.drive.revisions * (1 - settled.drive));
    const c = classify('drive', units, UNIT_TOKENS.drive);
    rows.push({ source: 'drive', relayReads: 0, units, calls: c.calls, usd: c.usd, arithmetic: `${v.drive.revisions} revisions by direct MCP ($0), ${units} with a candidate deliverable; ${c.text}` });
  }
  {
    const units = Math.round(v.notes.docs * v.notes.myStepsPerDoc);
    const c = classify('notes', units, UNIT_TOKENS.notes);
    rows.push({ source: 'gemini_notes', relayReads: 0, units, calls: c.calls, usd: c.usd, arithmetic: `${v.notes.docs} notes × ${v.notes.myStepsPerDoc} steps of mine; ${c.text}` });
  }
  {
    const reads = weeks * 4 + Math.ceil(v.org62.rows / 50);
    const r = relayCost(reads);
    const units = Math.round(v.org62.rows * (1 - settled.org62));
    const c = classify('org62', units, UNIT_TOKENS.org62);
    rows.push({ source: 'org62', relayReads: reads, units, calls: c.calls, usd: r + c.usd, arithmetic: `${weeks} week(s) × 4 queries + ${Math.ceil(v.org62.rows / 50)} page(s) = ${reads} relay reads = ${money(r)}; ${v.org62.rows} rows, rules settle ${Math.round(settled.org62 * 100)}%; ${c.text}` });
  }
  return { rows, totalUsd: rows.reduce((s, r) => s + r.usd, 0) };
}

/** Review 04 §4.2's busy SE weekday, for `days` days (weekends quiet: 5/7 of the days count). */
export function busySeVolume(days = 30): FirstScanVolume {
  const work = Math.round((days * 5) / 7);
  return { days, slack: { inboxMessages: 250 * work, channelMessages: 60 * work, channels: 12 }, gmail: { emails: 40 * work }, drive: { revisions: 10 * work }, notes: { docs: 4 * work, myStepsPerDoc: 2 }, org62: { rows: 30 * work } };
}
