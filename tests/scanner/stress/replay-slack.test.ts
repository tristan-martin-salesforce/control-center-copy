/**
 * Slack replay semantics on placeholder fixtures shaped like the real tool output, plus the S-1 regression:
 * channel scopes must search by channel NAME (`in:#name`), because the `in:<#ID>` form matches nothing.
 */
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { slackChannelName, slackSpec } from '../../../src/scanner/runtime/connectors';
import type { ScanContext } from '../../../src/scanner/types';
import { addMessage, addThread, emptyIndex, markRecorded, parseSearchResults, parseThreadDetailed, ReplayMiss, SlackReplay } from '../../../scripts/stress/replay/slack';

const ME = 'U0ME00001';

function searchPage(rows: Array<{ ch: string; chLine: string; from: string; fromId: string; ts: string; text: string; threadTs?: string }>, cursor?: string) {
  const body = rows
    .map(
      (r, i) =>
        `### Result ${i + 1} of ${rows.length}\nChannel: ${r.chLine}\nFrom: ${r.from} <${r.from.toLowerCase()}@example.com> (ID: ${r.fromId}) \nTime: 2026-11-04 09:00:00 MST\nMessage_ts: ${r.ts}\nPermalink: [link](https://example.slack.com/archives/${r.ch}/p${r.ts.replace('.', '')}${r.threadTs ? `?thread_ts=${r.threadTs}&cid=${r.ch}` : ''})\nText: ${r.text}\n\n---\n`,
    )
    .join('');
  return [{ type: 'text', text: JSON.stringify({ results: `# Search Results for: q\n\n## Messages (${rows.length} results)\n${body}`, pagination_info: cursor ? `For the next page of results use cursor \`${cursor}\`` : 'End of results - No more pages available.\n' }) }];
}

// 2026-11-04 09:00 MST = 1793808000
const T0 = 1793808000;
function fixture() {
  const ix = emptyIndex(ME);
  const rows = [
    { ch: 'D0DM00001', chLine: 'DM (ID: D0DM00001)', from: 'PERSON_A', fromId: 'U0PERSONA', ts: `${T0 + 60}.000100`, text: 'can you send the ACME deck?' },
    { ch: 'C0ACME001', chLine: '#acme-account (ID: C0ACME001)', from: 'PERSON_B', fromId: 'U0PERSONB', ts: `${T0 + 120}.000200`, text: 'kickoff notes' },
    { ch: 'C0ACME001', chLine: '#acme-account (ID: C0ACME001)', from: 'PERSON_C', fromId: 'U0PERSONC', ts: `${T0 + 7200}.000300`, text: 'reply later in the day', threadTs: `${T0 + 120}.000200` },
  ];
  const parsed = parseSearchResults(searchPage(rows));
  addMessage(ix, parsed.msgs[0]!, 'dm');
  addMessage(ix, parsed.msgs[1]!, 'ch:C0ACME001');
  addMessage(ix, parsed.msgs[2]!, 'ch:C0ACME001');
  for (const c of ['dm', 'mentions', 'mine', 'ch:C0ACME001']) markRecorded(ix, c, '2026-11-04');
  const thread = [
    {
      type: 'text',
      text: JSON.stringify({
        messages: `=== THREAD PARENT MESSAGE ===\nFrom: PERSON_B <person_b@example.com> (U0PERSONB)\nTime: 2026-11-04 09:02:00 MST\nMessage TS: ${T0 + 120}.000200\nkickoff notes\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: PERSON_C <person_c@example.com> (U0PERSONC)\nTime: 2026-11-04 11:00:00 MST\nMessage TS: ${T0 + 7200}.000300\nreply later in the day\nReactions: +1 (1)\n`,
      }),
    },
  ];
  const t = parseThreadDetailed(thread, 'C0ACME001');
  addThread(ix, 'C0ACME001', `${T0 + 120}.000200`, t.parent, t.replies);
  return ix;
}

const args = (query: string, extra: Record<string, unknown> = {}) => ({ query, after: String(T0 - 3600), before: String(T0 + 86000), sort: 'timestamp', sort_dir: 'asc', limit: 20, ...extra });
const count = (out: string) => parseSearchResults([{ type: 'text', text: out }]).msgs.length;

describe('slack replay', () => {
  it('never returns anything newer than the simulated now (search and thread)', () => {
    const ix = fixture();
    let now = (T0 + 600) * 1000;
    const r = new SlackReplay(ix, { now: () => now });
    expect(count(r.search(args('in:#acme-account', { channel_types: 'public_channel,private_channel' })))).toBe(1);
    expect(r.readThread({ channel_id: 'C0ACME001', message_ts: `${T0 + 120}.000200`, response_format: 'concise' })).not.toContain('reply later');
    now = (T0 + 8000) * 1000;
    expect(count(r.search(args('in:#acme-account', { channel_types: 'public_channel,private_channel' })))).toBe(2);
    expect(r.readThread({ channel_id: 'C0ACME001', message_ts: `${T0 + 120}.000200`, response_format: 'concise' })).toContain('reply later');
    expect(r.stats.leaks).toBe(0);
  });

  it('S-1: the id form of in: matches nothing (real tool behavior); the name form works', () => {
    const r = new SlackReplay(fixture(), { now: () => (T0 + 9000) * 1000 });
    expect(count(r.search(args('in:<#C0ACME001>', { channel_types: 'public_channel,private_channel' })))).toBe(0);
    expect(count(r.search(args('in:#acme-account', { channel_types: 'public_channel,private_channel' })))).toBe(2);
  });

  it('fails loudly on calls the recordings cannot answer', () => {
    const r = new SlackReplay(fixture(), { now: () => (T0 + 9000) * 1000 });
    expect(() => r.search(args('quarterly planning'))).toThrow(ReplayMiss);
    expect(() => r.search(args('-from:<@U0ME00001>', { after: String(T0 - 3 * 86400), channel_types: 'im,mpim' }))).toThrow(/not recorded/);
    expect(() => r.readThread({ channel_id: 'C0OTHER01', message_ts: '1.1' })).toThrow(ReplayMiss);
    expect(r.stats.misses).toBe(3);
  });

  it('a full page offers a cursor like the real tool (the next page may be empty)', () => {
    const r = new SlackReplay(fixture(), { now: () => (T0 + 9000) * 1000 });
    const p1 = JSON.parse(r.search(args('in:#acme-account', { channel_types: 'public_channel,private_channel', limit: 2 }))) as { pagination_info?: string };
    const cur = p1.pagination_info?.match(/cursor `([^`]+)`/)?.[1];
    expect(cur).toBeTruthy();
    expect(count(r.search(args('in:#acme-account', { channel_types: 'public_channel,private_channel', limit: 2, cursor: cur })))).toBe(0);
  });
});

describe('S-1 regression: channel scopes search by name', () => {
  const ctx = {
    watchList: [{ kind: 'channel', ref: 'C0WATCH01', label: '#Team-Watch' }],
    aliases: { accounts: [], channels: [{ channelId: 'C0ACME001', accountId: 'acct_1', label: '#acme-account' }, { channelId: 'C0NONAME1', accountId: 'acct_2' }] },
  } as unknown as ScanContext;

  it('scopeVars carry the bare channel name, or empty when none is usable', () => {
    const spec = slackSpec();
    expect(spec.scopeVars('channel:C0ACME001', ctx)['channel.label']).toBe('acme-account');
    expect(spec.scopeVars('channel:C0WATCH01', ctx)['channel.label']).toBe('team-watch');
    expect(spec.scopeVars('channel:C0NONAME1', ctx)['channel.label']).toBe('');
    expect(slackChannelName('ZC:C0X:Some Display Name')).toBe('');
  });

  it('scan-slack C1 uses in:#{{channel.label}} with a read_channel fallback, never the id form', () => {
    const skill = fs.readFileSync('skills/scan-slack.md', 'utf8');
    const c1 = skill.split('\n').find((l) => l.startsWith('| C1 '))!;
    expect(c1).toContain('in:#{{channel.label}}');
    expect(c1).not.toContain('in:<#');
    expect(skill).toMatch(/C1′.*slack_read_channel/s);
    expect(skill).toMatch(/^version: 1\.[1-9]/m);
  });
});
