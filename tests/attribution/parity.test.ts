/**
 * Parity over sample-data: the three old guessers (the calendar mapper, the Slack burst mapper, the Time row pre-fill)
 * against the attribution engine that replaced them (src/engines/attribution/activity.ts, row.ts).
 *
 *   1. With nothing learned (no mapping_rules, no channel map) the engine answers exactly as the old code did, on every
 *      calendar event, every channel and every Time row.
 *   2. With sample-data's learned rules and confirmed channel map, wherever the old guess was right (it equals the
 *      sample's own label: the event's mapped account, the channel's confirmed account, the row's logged opp) the
 *      engine's is right too; what changes is only where the old guess was empty or wrong.
 * The counts are printed (the builder's `verify` line quotes them) and pinned loosely so a regression shows.
 */
import { describe, expect, it } from 'vitest';

import { accountByKey, legacyResolveAccount } from '@/engines/activity/classify';
import type { ActivityMappings } from '@/engines/activity/types';
import { channelAccount, meetingAccount } from '@/engines/attribution/activity';
import { legacyRowRule, rowAttribution, type RowContext, type RowExtras } from '@/engines/attribution/row';

import { entryOf, loadSample, type Sample } from './sample';

const s: Sample = loadSample();
const report: Record<string, unknown> = {};

/** The old calendar mapper: the projection's account, else the first title pattern, else a domain. */
const oldMeeting = (title: string, domains: string[], key: string | null, m: ActivityMappings) => (key ? accountByKey(m, key) : null) ?? legacyResolveAccount(title, domains, m);
/** The old Slack burst mapper: the channel map (never passed: always empty), else the channel's name. */
const oldChannel = (id: string, name: string | null, m: ActivityMappings) => m.channels[id] ?? (name ? (legacyResolveAccount(name.replace(/[-_]+/g, ' '), [], m)?.key ?? null) : null);

describe('parity: the calendar mapper (138 sample events)', () => {
  it('nothing learned: the engine maps every event to the account the old mapper did (with and without the projection key)', () => {
    let same = 0;
    for (const e of s.events) {
      const domains = s.domainsOf.get(e.id) ?? [];
      const key = s.matcher.resolve(e.title ?? '', domains)?.accountId ?? null;
      for (const k of [null, key]) {
        const old = oldMeeting(e.title ?? '', domains, k, s.baseMappings)?.key ?? null;
        const neu = meetingAccount({ summary: e.title ?? '', attendeeDomains: domains, accountKey: k }, s.baseMappings)?.key ?? null;
        expect(neu, `${e.title}`).toBe(old);
        if (neu === old) same++;
      }
    }
    report.calendarIdentical = `${same / 2}/${s.events.length}`;
  });

  it('learned rules on: wherever the old guess matched the label, the engine still does; it never loses one', () => {
    let labelled = 0;
    let oldRight = 0;
    let newRight = 0;
    let changed = 0;
    for (const e of s.events) {
      const domains = s.domainsOf.get(e.id) ?? [];
      const old = oldMeeting(e.title ?? '', domains, null, s.baseMappings)?.key ?? null;
      const neu = meetingAccount({ summary: e.title ?? '', attendeeDomains: domains, accountKey: null, seriesId: e.recurring_event_id }, s.learnedMappings)?.key ?? null;
      if (neu !== old) changed++;
      if (!e.account_id) continue;
      labelled++;
      if (old === e.account_id) {
        oldRight++;
        expect(neu, `${e.title}: the old guess was right`).toBe(e.account_id);
      }
      if (neu === e.account_id) newRight++;
    }
    report.calendar = { labelled, oldRight, engineRight: newRight, changed };
    expect(newRight).toBeGreaterThanOrEqual(oldRight);
  });
});

describe('parity: the Slack burst mapper (sample channels and slack_burst blocks)', () => {
  it('nothing learned: every channel maps as before (by its name)', () => {
    for (const c of s.channels) expect(channelAccount(c.external_id, c.name, s.baseMappings), String(c.name)).toBe(oldChannel(c.external_id, c.name, s.baseMappings));
  });

  it('the confirmed channel map and learned rules map the bursts the old mapper left blank, and keep every right one', () => {
    const chan = new Map(s.channels.map((c) => [c.external_id, c] as const));
    let bursts = 0;
    let oldMapped = 0;
    let newMapped = 0;
    let oldRight = 0;
    let newRight = 0;
    for (const b of s.timeBlocks.filter((x) => x.source === 'slack_burst')) {
      const si = s.sourceItems.get(b.source_item_id);
      const id = si?.external_container_id as string | undefined;
      if (!id) continue;
      bursts++;
      const name = chan.get(id)?.name ?? null;
      const old = oldChannel(id, name, s.baseMappings);
      const neu = channelAccount(id, name, s.learnedMappings);
      const label = s.channelMap[id] ?? null;
      if (old) oldMapped++;
      if (neu) newMapped++;
      if (label && old === label) {
        oldRight++;
        expect(neu).toBe(label);
      }
      if (label && neu === label) newRight++;
    }
    report.slack = { bursts, oldMapped, engineMapped: newMapped, oldRight, engineRight: newRight };
    expect(newMapped).toBeGreaterThanOrEqual(oldMapped);
  });
});

describe('parity: the Time row pre-fill (sample activity_entries)', () => {
  const ctxOf = (attribution?: RowExtras): RowContext => ({ opps: s.opps, accounts: s.accounts, events: s.contractEvents, people: s.people, assets: [], runs: [], workItems: [], activity: [], today: '2026-11-18', ...(attribution ? { attribution } : {}) });
  const rows = s.activity.filter((r) => r.opportunity_id && r.status !== 'excluded');

  it('nothing learned: the suggestion is the old rules’ suggestion on every row (opp, confidence and reason)', () => {
    const ctx = ctxOf();
    for (const r of rows) {
      const e = entryOf(r, s, { blankOpp: true });
      expect(rowAttribution(e, ctx).suggestion).toEqual(legacyRowRule(e, ctx));
    }
    report.rowsIdentical = `${rows.length}/${rows.length}`;
  });

  it('learned rules on: where the old guess recovered the logged opp the engine does too', () => {
    const extras: RowExtras = { rules: s.rules, channels: Object.fromEntries(s.channels.filter((c) => c.name).map((c) => [String(c.name).toLowerCase(), { id: c.external_id, accountId: s.channelMap[c.external_id] ?? null }])), seriesOf: Object.fromEntries(s.events.filter((e) => e.recurring_event_id).map((e) => [e.id, e.recurring_event_id])) };
    const base = ctxOf();
    const learned = ctxOf(extras);
    let oldRight = 0;
    let newRight = 0;
    let oldAny = 0;
    let newAny = 0;
    for (const r of rows) {
      const e = entryOf(r, s, { blankOpp: true });
      const old = legacyRowRule(e, base);
      const neu = rowAttribution(e, learned).suggestion;
      if (old) oldAny++;
      if (neu) newAny++;
      if (old?.oppId === r.opportunity_id) {
        oldRight++;
        expect(neu?.oppId, e.description).toBe(r.opportunity_id);
      }
      if (neu?.oppId === r.opportunity_id) newRight++;
    }
    report.rows = { rows: rows.length, oldGuessed: oldAny, engineGuessed: newAny, oldRight, engineRight: newRight };
    expect(newRight).toBeGreaterThanOrEqual(oldRight);
    // the numbers the builder quotes (old guess vs engine on sample-data)
    console.log(`attribution parity: ${JSON.stringify(report)}`);
  });
});
