/**
 * The FTI first-scan estimate, with its arithmetic printed: the sample dataset's last 30 days (sample-data, a synthetic
 * copy of the database) and review 04's busy SE for 30 days, against the measured $16.24 agentic first scan
 * (scan $12.34 + read-ins $3.90, src/server/onboarding/cost.ts). Plus the pessimistic case: every item reaches the
 * classifier and a relay read is 15K tokens.
 */
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { RELAY_PREFIX_TOKENS_HIGH } from '@/scanner/interpret/estimate';
import { busySeVolume, estimateFtiFirstScan, type FirstScanVolume } from '@/scanner/runtime/first-scan-estimate';

interface Row { source: string; occurred_at: string; from_me: boolean; addressed_to_me?: boolean | null; channel_id?: string | null; external_id?: string | null }

/** The sample dataset's last 30 days, by source (Slack inbox = DMs, to me or from me; the rest is channel traffic). */
function sampleVolume(): FirstScanVolume {
  const rows = JSON.parse(fs.readFileSync('sample-data/tables/source_items.json', 'utf8')) as Row[];
  const end = Math.max(...rows.map((r) => Date.parse(r.occurred_at)));
  const win = rows.filter((r) => Date.parse(r.occurred_at) >= end - 30 * 86_400_000);
  const of = (s: string) => win.filter((r) => r.source === s);
  const slack = of('slack');
  const inbox = slack.filter((r) => r.from_me || r.addressed_to_me || (r.external_id ?? '').startsWith('D'));
  return {
    days: 30,
    slack: { inboxMessages: inbox.length, channelMessages: slack.length - inbox.length, channels: new Set(slack.map((r) => r.channel_id)).size },
    gmail: { emails: of('gmail').length },
    drive: { revisions: of('drive').length },
    notes: { docs: of('gemini_notes').length, myStepsPerDoc: 2 },
    org62: { rows: of('org62').length },
  };
}

function print(title: string, e: ReturnType<typeof estimateFtiFirstScan>) {
  console.log([``, title, '| source | relay reads | units to the classifier | classifier calls | est. $ | arithmetic |', '|---|---|---|---|---|---|', ...e.rows.map((r) => `| ${r.source} | ${r.relayReads} | ${r.units} | ${r.calls} | ${r.usd.toFixed(4)} | ${r.arithmetic} |`), `| **total** | ${e.rows.reduce((s, r) => s + r.relayReads, 0)} | ${e.rows.reduce((s, r) => s + r.units, 0)} | ${e.rows.reduce((s, r) => s + r.calls, 0)} | **${e.totalUsd.toFixed(2)}** | |`].join('\n'));
}

describe('FTI first-scan estimate (30 days)', () => {
  it('the sample dataset costs cents', () => {
    const e = estimateFtiFirstScan(sampleVolume());
    print('Sample dataset, last 30 days', e);
    expect(e.totalUsd).toBeLessThan(0.25);
  });
  it('a busy SE’s 30 days stays inside the $1–3 target with room, pessimistic case included', () => {
    const e = estimateFtiFirstScan(busySeVolume(30));
    print('Busy SE (review 04 §4.2), 30 days', e);
    const worst = estimateFtiFirstScan(busySeVolume(30), { ruleSettled: { slackInbox: 0, slackChannel: 0, gmail: 0, drive: 0, org62: 0 }, relayPrefixTokens: RELAY_PREFIX_TOKENS_HIGH });
    print('Busy SE, pessimistic (no rule settles anything; 15K-token relay reads)', worst);
    expect(e.totalUsd).toBeLessThan(1);
    expect(worst.totalUsd).toBeLessThan(3);
    expect(worst.totalUsd).toBeGreaterThan(e.totalUsd);
  });
});
