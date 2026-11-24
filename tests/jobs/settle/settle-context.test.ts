/**
 * Settle pass, deterministic part: the context pack (ask, before, after oldest first, elsewhere, events, siblings,
 * hints) and the reply checks (citations must back the verdict). Placeholder data only.
 */
import { describe, expect, it } from 'vitest';

import { buildSettleContext, type RawSource, type SettleRaw } from '../../../src/engines/settle/context';
import { onlyPromises, parseSettleReply, renderSettlePrompt } from '../../../src/engines/settle/prompt';
import { salientWords } from '../../../src/engines/settle/load-db';

const T0 = Date.parse('2026-10-21T15:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const NOW = new Date('2026-11-09T15:00:00.000Z');

let n = 0;
const msg = (o: Partial<RawSource> & { at: string }): RawSource => ({
  id: `src-${++n}`,
  source: 'slack',
  kind: 'slack_message',
  externalId: `C0GROUP01:${n}`,
  parent: null,
  url: `https://example.slack.com/archives/C0GROUP01/p${n}`,
  fromMe: false,
  addressedToMe: null,
  title: null,
  text: 'text',
  author: 'PERSON_A',
  channelId: 'C0GROUP01',
  channelType: 'mpim',
  channelName: null,
  threadTs: null,
  ts: String(n),
  ...o,
});

function raw(): SettleRaw {
  n = 0;
  const b1 = msg({ at: at(-60 * 18), author: 'PERSON_A', text: '@PERSON_B can you present tomorrow afternoon?' });
  const b2 = msg({ at: at(-60 * 17), author: 'PERSON_B', text: 'Yes, around 2' });
  const ask = msg({ at: at(0), author: 'PERSON_A', text: 'Can you confirm if you can present this afternoon?', role: 'origin' });
  const c1 = msg({ at: at(4), fromMe: true, author: 'ME', text: 'What time is the demo?' });
  const c2 = msg({ at: at(100), author: 'PERSON_A', text: '2pm MT' });
  return {
    item: { id: 'w-1', kind: 'ask', status: 'in_progress', title: 'Confirm to PERSON_A whether I can present at ACME this afternoon', purpose: null, description: null, dueAt: '2026-10-21T00:00:00.000Z', createdAt: at(60 * 24 * 16), counterparty: 'PERSON_A', account: 'ACME' },
    evidence: [ask],
    conversation: [c2, b1, ask, c1, b2],
    elsewhere: [msg({ at: at(200), fromMe: true, author: 'ME', channelType: 'im', text: 'deck attached' })],
    events: [{ id: 'ev-1', title: 'ACME demo', startsAt: at(180), endsAt: at(420), status: 'confirmed', myResponse: 'accepted', attendance: null, allDay: false }],
    siblings: [{ id: 'w-2', title: 'Huddle with PERSON_A on the ACME demo', status: 'done', resolution: 'done_by_me', createdAt: at(60 * 24 * 16), sameConversation: true }],
  };
}

describe('buildSettleContext', () => {
  it('splits the conversation around the ask, oldest first, and computes the hints', () => {
    const c = buildSettleContext(raw(), { now: NOW, timezone: 'America/Denver', me: 'ME' });
    expect(c.ask?.id).toBe('a1');
    expect(c.before.map((l) => l.by)).toEqual(['PERSON_A', 'PERSON_B']);
    expect(c.after.map((l) => [l.id, l.by])).toEqual([
      ['c1', 'me'],
      ['c2', 'PERSON_A'],
    ]);
    expect(c.elsewhere).toHaveLength(1);
    expect(c.events[0]).toMatchObject({ id: 'e1', passed: true });
    expect(c.siblings[0]).toMatchObject({ id: 'k1', workItemId: 'w-2', where: 'same conversation' });
    expect(c.hints).toMatchObject({ conversation: 'group_dm', myRepliesAfterAsk: 1, askerMessagesAfterAsk: 1, firstReplyAfterMin: 4, dueBeforeFirstSeen: true, duePassed: true, ageDaysWhenSeen: 16 });
  });

  it('keeps the head and tail of a long conversation and says how many lines it dropped', () => {
    const r = raw();
    r.conversation.push(...Array.from({ length: 60 }, (_, i) => msg({ at: at(200 + i), text: `line ${i}` })));
    const c = buildSettleContext(r, { now: NOW, timezone: 'UTC', me: 'ME', afterHead: 10, afterTail: 5 });
    expect(c.after).toHaveLength(15);
    expect(c.hints.omittedAfter).toBe(62 - 15);
    expect(c.after[0]!.by).toBe('me');
  });

  it('renders JSON with aliases only (no source ids or urls)', () => {
    const c = buildSettleContext(raw(), { now: NOW, timezone: 'UTC', me: 'ME' });
    const s = renderSettlePrompt(c);
    expect(s).not.toContain('src-');
    expect(s).not.toContain('https://');
    expect(JSON.parse(s).after[0].id).toBe('c1');
  });
});

describe('parseSettleReply', () => {
  const c = buildSettleContext(raw(), { now: NOW, timezone: 'UTC', me: 'ME' });

  it('accepts a not_yours verdict citing the ask', () => {
    const p = parseSettleReply('{"verdict":"not_yours","confidence":0.85,"cite":"a1","reason":"PERSON_A was asking PERSON_B","owner":"other"}', c);
    expect(p).toMatchObject({ verdict: 'not_yours', valid: true, owner: 'other' });
  });

  it('rejects done_by_you that cites someone else, and resolved_by_other that cites me', () => {
    expect(parseSettleReply('{"verdict":"done_by_you","confidence":0.9,"cite":"c2","reason":"x"}', c)).toMatchObject({ valid: false });
    expect(parseSettleReply('{"verdict":"resolved_by_other","confidence":0.9,"cite":"c1","reason":"x"}', c)).toMatchObject({ valid: false });
    expect(parseSettleReply('{"verdict":"done_by_you","confidence":0.9,"cite":"b1","reason":"x"}', c)).toMatchObject({ valid: false });
  });

  it('rejects done_by_you that cites a promise of mine; a delivery still counts', () => {
    const r = raw();
    r.conversation.push(msg({ at: at(10), fromMe: true, author: 'ME', text: 'Yep accepted. And yes I’ll get that over to PERSON_A tonight.' }));
    r.conversation.push(msg({ at: at(20), fromMe: true, author: 'ME', text: 'Here’s the deck, I’ll tidy the last slide tomorrow' }));
    const ctx = buildSettleContext(r, { now: NOW, timezone: 'UTC', me: 'ME' });
    const promise = ctx.after.find((l) => /tonight/.test(l.text))!.id;
    const delivery = ctx.after.find((l) => /deck/.test(l.text))!.id;
    expect(parseSettleReply(`{"verdict":"done_by_you","confidence":0.55,"cite":"${promise}","reason":"x"}`, ctx)).toMatchObject({ valid: false, invalidWhy: expect.stringMatching(/promise/) });
    expect(parseSettleReply(`{"verdict":"done_by_you","confidence":0.8,"cite":"${delivery}","reason":"x"}`, ctx)).toMatchObject({ valid: true });
    expect(onlyPromises('Yep good to go')).toBe(false);
    // Rescan false positives: an answer about the future, and a delivery with a promise for the next part.
    expect(onlyPromises('I’ll be remote PERSON_A so I can be on. Can you forward me the invite?')).toBe(false);
    expect(onlyPromises('PERSON_A Just shared access to the demo org. I’ll work on the second one next.')).toBe(false);
    expect(onlyPromises('And yes I’ll get that over to him tonight.')).toBe(true);
    expect(onlyPromises('I will send the deck after my call')).toBe(true);
    expect(onlyPromises('let me check with PERSON_B')).toBe(true);
    expect(onlyPromises('I answered in the thread: https://example.com/x')).toBe(false);
  });

  it('waiting_on_them must cite my question after the ask', () => {
    expect(parseSettleReply('{"verdict":"waiting_on_them","confidence":0.75,"cite":"c1","reason":"x","needs":"PERSON_A: the demo time"}', c)).toMatchObject({ valid: true, verdict: 'waiting_on_them' });
    expect(parseSettleReply('{"verdict":"waiting_on_them","confidence":0.75,"cite":"c2","reason":"x"}', c)).toMatchObject({ valid: false });
    expect(parseSettleReply('{"verdict":"waiting_on_them","confidence":0.75,"cite":"b1","reason":"x"}', c)).toMatchObject({ valid: false });
  });

  it('maps a duplicate to the sibling item and rejects an unknown line', () => {
    expect(parseSettleReply('{"verdict":"duplicate","confidence":0.9,"duplicate_of":"k1","reason":"x"}', c)).toMatchObject({ valid: true, duplicateOf: 'w-2' });
    expect(parseSettleReply('{"verdict":"moment_passed","confidence":0.9,"cite":"e9","reason":"x"}', c)).toMatchObject({ valid: false });
    expect(parseSettleReply('not json', c)).toHaveProperty('error');
  });
});

describe('salientWords', () => {
  it('keeps names and topics, drops verbs and short words', () => {
    expect(salientWords('Confirm to PERSON whether I can present at ACME this afternoon', ['ACME Corp'])).toEqual(['person', 'whether', 'present', 'acme', 'afternoon', 'corp']);
  });
});
