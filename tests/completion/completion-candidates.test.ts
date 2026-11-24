/**
 * CMP-1 completion pass, deterministic part: which newly arrived source items are candidates for an open item.
 * Placeholder data only.
 */
import { describe, expect, it } from 'vitest';

import { collectCandidates, isPleasantry, itemFacts, normFileRef, relationsOf, slackChannel } from '../../src/scanner/completion/candidates';
import type { CompletionEvidence, CompletionItem, CompletionSource } from '../../src/scanner/completion/types';

const T0 = Date.parse('2026-10-21T15:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ts = (min: number) => ((T0 + min * 60_000) / 1000).toFixed(6);
const ASKER = { name: 'PERSON_A', externalId: 'U0PERSONA' };
const OTHER = { name: 'PERSON_B', externalId: 'U0PERSONB' };
const ME = { name: 'ME', externalId: 'U0ME00001', isMe: true };

const ev = (o: Partial<CompletionEvidence> & { externalId: string; occurredAt: string }): CompletionEvidence => ({
  sourceItemId: `src-${o.externalId}`,
  role: 'origin',
  connector: 'slack',
  kind: 'message',
  fromMe: false,
  fileRefs: [],
  accountHints: [],
  ...o,
});

const src = (o: Partial<CompletionSource> & { externalId: string; occurredAt: string }): CompletionSource => ({
  sourceItemId: `src-${o.externalId}`,
  connector: 'slack',
  kind: 'message',
  seenAt: o.occurredAt,
  fromMe: false,
  fileRefs: [],
  accountHints: [],
  ...o,
});

function item(evidence: CompletionEvidence[], extra: Partial<CompletionItem> = {}): CompletionItem {
  return { workItemId: 'wi-1', kind: 'ask', title: 'Send the ACME pilot deck', status: 'open', createdAt: at(1), accountNames: [], fileRefs: [], evidence, ...extra };
}

/** An ask in a DM from PERSON_A. */
const dmAsk = ev({ externalId: `D0DM00001:${ts(0)}`, threadRef: `slack:D0DM00001:${ts(0)}`, occurredAt: at(0), author: ASKER, participants: [ASKER, ME], text: 'Can you send me the ACME pilot deck?' });
/** An ask in a channel thread (a reply to PERSON_B's root, mentioning me). */
const threadAsk = ev({ externalId: `C0CHAN0001:${ts(0)}`, threadRef: `slack:C0CHAN0001:${ts(-30)}`, occurredAt: at(0), author: ASKER, text: '<@U0ME00001> can you share the sizing?' });

describe('candidate refs', () => {
  it('parses Slack channels and Drive refs', () => {
    expect(slackChannel(`slack:C0CHAN0001:${ts(0)}`)).toBe('C0CHAN0001');
    expect(slackChannel(`D0DM00001:${ts(0)}`)).toBe('D0DM00001');
    expect(slackChannel('gmail-thread:abc')).toBeUndefined();
    expect(normFileRef('drive:FILE_ACME_POV_000001')).toBe('FILE_ACME_POV_000001');
    expect(normFileRef('https://docs.google.com/presentation/d/FILE_ACME_POV_000001/edit#slide=2')).toBe('FILE_ACME_POV_000001');
  });
});

describe('relations', () => {
  it('my later message in the same DM is a strong candidate, the ask itself is not', () => {
    const it0 = item([dmAsk]);
    const f = itemFacts(it0);
    expect(f.counterpartKeys.has('u0persona')).toBe(true);
    const reply = src({ externalId: `D0DM00001:${ts(30)}`, threadRef: `slack:D0DM00001:${ts(30)}`, occurredAt: at(30), author: ME, fromMe: true, participants: [ASKER, ME], text: 'Here you go: https://docs.google.com/presentation/d/FILE_ACME_POV_000001/edit' });
    expect(relationsOf(f, reply)).toEqual(expect.arrayContaining(['same_dm', 'to_asker']));
    const cands = collectCandidates(it0, [reply, src({ ...dmAsk, sourceItemId: dmAsk.sourceItemId })], { seenAfter: 0, seenUntil: T0 + 3_600_000 });
    expect(cands.map((c) => c.source.sourceItemId)).toEqual([reply.sourceItemId]);
    expect(cands[0]!.strong).toBe(true);
  });

  it('a reply in the same channel thread is strong; my top-level post in the channel is only medium', () => {
    const f = itemFacts(item([threadAsk]));
    const inThread = src({ externalId: `C0CHAN0001:${ts(20)}`, threadRef: `slack:C0CHAN0001:${ts(-30)}`, occurredAt: at(20), author: ME, fromMe: true, text: 'Sizing sheet attached' });
    const topLevel = src({ externalId: `C0CHAN0001:${ts(25)}`, threadRef: `slack:C0CHAN0001:${ts(25)}`, occurredAt: at(25), author: ME, fromMe: true, text: 'Morning all' });
    const othersTopLevel = src({ externalId: `C0CHAN0001:${ts(26)}`, threadRef: `slack:C0CHAN0001:${ts(26)}`, occurredAt: at(26), author: OTHER, text: 'Lunch?' });
    expect(relationsOf(f, inThread)).toContain('same_thread');
    expect(relationsOf(f, topLevel)).toEqual(['same_channel']);
    expect(relationsOf(f, othersTopLevel)).toEqual([]);
  });

  it('the same Gmail thread, a mail to the asker, and the asker writing to me directly', () => {
    const mailAsk = ev({ connector: 'gmail', kind: 'email', externalId: 'msg-001', threadRef: 'gmail-thread:t-001', occurredAt: at(0), author: { name: 'PERSON_C', email: 'person.c@example.com' }, participants: [{ name: 'ME', email: 'me@example.com', isMe: true }] });
    const f = itemFacts(item([mailAsk]));
    const reply = src({ connector: 'gmail', kind: 'email', externalId: 'msg-002', threadRef: 'gmail-thread:t-001', occurredAt: at(60), author: { name: 'ME', email: 'me@example.com', isMe: true }, fromMe: true, participants: [{ name: 'PERSON_C', email: 'person.c@example.com' }] });
    expect(relationsOf(f, reply)).toEqual(expect.arrayContaining(['same_email_thread', 'to_asker']));
    const fresh = src({ connector: 'gmail', kind: 'email', externalId: 'msg-003', threadRef: 'gmail-thread:t-009', occurredAt: at(70), author: { name: 'ME', email: 'me@example.com', isMe: true }, fromMe: true, participants: [{ email: 'person.c@example.com' }] });
    expect(relationsOf(f, fresh)).toEqual(['to_asker']);
    const thanks = src({ connector: 'gmail', kind: 'email', externalId: 'msg-004', threadRef: 'gmail-thread:t-010', occurredAt: at(80), author: { name: 'PERSON_C', email: 'person.c@example.com' }, participants: [{ name: 'ME', email: 'me@example.com', isMe: true }] });
    expect(relationsOf(f, thanks)).toEqual(['from_asker']);
  });

  it('a Drive revision of the item file, and a calendar event I scheduled with the asker', () => {
    const f = itemFacts(item([dmAsk], { fileRefs: ['FILE_ACME_POV_000001'] }));
    const rev = src({ connector: 'drive', kind: 'file_revision', externalId: `FILE_ACME_POV_000001@${at(40)}`, occurredAt: at(40), author: ME, fromMe: true, fileRefs: ['FILE_ACME_POV_000001'] });
    expect(relationsOf(f, rev)).toEqual(['same_file', 'file_revision']); // R7: a revision has its own relation
    const meeting = src({ connector: 'calendar', kind: 'calendar_event', externalId: 'evt-001', threadRef: 'calendar:evt-001', occurredAt: at(60 * 48), seenAt: at(50), author: ME, fromMe: true, participants: [ME, { name: 'PERSON_A', email: 'person.a@example.com', externalId: 'U0PERSONA' }] });
    expect(relationsOf(f, meeting)).toEqual(['same_event']);
  });

  it('same account counts only for my messages that share two title keywords', () => {
    const f = itemFacts(item([dmAsk], { accountId: 'acct-1', accountNames: ['ACME'] }));
    const related = src({ externalId: `C0ACME0001:${ts(30)}`, threadRef: `slack:C0ACME0001:${ts(30)}`, occurredAt: at(30), author: ME, fromMe: true, accountHints: ['ACME'], text: 'Pilot deck is in the shared folder' });
    const unrelated = src({ externalId: `C0ACME0001:${ts(31)}`, threadRef: `slack:C0ACME0001:${ts(31)}`, occurredAt: at(31), author: ME, fromMe: true, accountHints: ['ACME'], text: 'Reminder: QBR on Friday' });
    expect(relationsOf(f, related)).toEqual(['same_account']);
    expect(relationsOf(f, unrelated)).toEqual([]);
  });
});

describe('collectCandidates', () => {
  it('only what arrived in the window and happened after the ask, strongest first, at most N, oldest first', () => {
    const it0 = item([dmAsk]);
    const mk = (min: number, fromMe = true) => src({ externalId: `D0DM00001:${ts(min)}`, threadRef: `slack:D0DM00001:${ts(min)}`, occurredAt: at(min), author: fromMe ? ME : ASKER, fromMe, participants: [ASKER, ME], text: `message ${min}` });
    const before = mk(-10);
    const old = { ...mk(5), seenAt: at(5) };
    const fresh = [mk(20), mk(30), mk(40, false), mk(50)];
    const c = collectCandidates(it0, [before, old, ...fresh], { seenAfter: T0 + 10 * 60_000, seenUntil: T0 + 3_600_000, maxPerItem: 3 });
    expect(c.map((x) => x.source.occurredAt)).toEqual([at(20), at(30), at(50)]);
    expect(c.every((x) => x.strong)).toBe(true);
  });

  it('skips sources already linked as completion and non-candidate connectors', () => {
    const done = ev({ role: 'completion', externalId: `D0DM00001:${ts(30)}`, occurredAt: at(30), author: ME, fromMe: true });
    const it0 = item([dmAsk, done]);
    const again = src({ externalId: `D0DM00001:${ts(30)}`, occurredAt: at(30), author: ME, fromMe: true, participants: [ASKER, ME] });
    const notes = src({ connector: 'gemini_notes', kind: 'meeting_notes', externalId: 'doc-1', occurredAt: at(40), fromMe: true, participants: [ASKER] });
    expect(collectCandidates(it0, [again, notes], { seenAfter: 0, seenUntil: T0 + 3_600_000 })).toEqual([]);
  });
});

describe('RES-1: the asker settling it ranks first; pleasantries are not candidates', () => {
  it('a decision in a related group DM survives the cap ahead of closing chatter and my own replies', () => {
    const it0 = item([dmAsk], { title: 'Decide whether the ACME prep session is still needed', kind: 'task' });
    const GD = 'C0GROUPDM01';
    const group = [ASKER, OTHER, ME, { name: 'PERSON_C', externalId: 'U0PERSONC' }];
    const msg = (min: number, author: typeof ASKER | typeof ME, text: string) =>
      src({ externalId: `${GD}:${ts(min)}`, threadRef: `slack:${GD}:${ts(min)}`, occurredAt: at(min), author, participants: group, fromMe: author === ME, text });
    const sources = [
      // the item's own DM: three strong candidates
      src({ externalId: `D0DM00001:${ts(1)}`, threadRef: `slack:D0DM00001:${ts(0)}`, occurredAt: at(1), author: ME, fromMe: true, participants: [ASKER, ME], text: 'Oh I thought that was internal' }),
      src({ externalId: `D0DM00001:${ts(4)}`, threadRef: `slack:D0DM00001:${ts(0)}`, occurredAt: at(4), author: ASKER, participants: [ASKER, ME], text: 'This is with the program architect' }),
      src({ externalId: `D0DM00001:${ts(5)}`, threadRef: `slack:D0DM00001:${ts(0)}`, occurredAt: at(5), author: ASKER, participants: [ASKER, ME], text: 'He drives the agentic strategy' }),
      msg(58, ME, 'Cool, if it is the same content I am good from my end'),
      msg(94, ASKER, 'Invite request for a quick prep this afternoon?'),
      msg(174, ASKER, "Thanks PERSON_C for the notes - I'll go ahead and cancel the prep."),
      msg(183, ME, "Yep that's perfect, thanks for the context"),
      msg(184, ASKER, 'Awesome! Thanks all. Have an amazing weekend'),
      msg(185, OTHER, 'Fantastic - thanks team!'),
    ];
    const c = collectCandidates(it0, sources, { seenAfter: Date.parse(at(-5)), seenUntil: Date.parse(at(300)), maxPerItem: 6 });
    const texts = c.map((x) => x.source.text);
    expect(texts).toContain("Thanks PERSON_C for the notes - I'll go ahead and cancel the prep.");
    expect(texts).not.toContain('Awesome! Thanks all. Have an amazing weekend'); // a pleasantry, not a candidate
    expect(texts).not.toContain('Fantastic - thanks team!');
    expect(c.length).toBeLessThanOrEqual(6);
  });

  it('the asker getting it from someone else in the same group DM survives the cap ahead of later call chatter', () => {
    const GD = 'C0GROUPDM02';
    const group = [ASKER, OTHER, ME, { name: 'PERSON_C', externalId: 'U0PERSONC' }];
    const ask = ev({ externalId: `${GD}:${ts(0)}`, threadRef: `slack:${GD}:${ts(0)}`, occurredAt: at(0), author: ASKER, participants: group, text: '<@U0PERSONB> <@U0ME00001> do you have a Data 360 workbook we could share?' });
    const it0 = item([ask], { title: 'Share a Data 360 workbook with PERSON_D', kind: 'ask' });
    const m = (min: number, author: typeof ASKER | typeof ME | typeof OTHER, text: string) => src({ externalId: `${GD}:${ts(min)}`, threadRef: `slack:${GD}:${ts(min)}`, occurredAt: at(min), author, participants: group, fromMe: author === ME, text });
    const sources = [
      m(1, ME, 'PERSON_C may have something better for this, otherwise I can look'),
      m(2, ASKER, 'ok, PERSON_C mentioned she has something so I will follow up with her'),
      m(3, ME, 'Next steps: PERSON_D to list the data sources'),
      m(16, ASKER, 'https://notes.example.com/t/placeholder'),
      m(19, OTHER, 'That was a great call. Got lots of good information.'),
      m(20, ASKER, 'We can put together a good POV and plan based on that'),
      m(145, ASKER, 'You should all have a meeting invite for Monday'),
      m(150, OTHER, 'Following up on the volumes by email'),
    ];
    const c = collectCandidates(it0, sources, { seenAfter: Date.parse(at(-5)), seenUntil: Date.parse(at(300)), maxPerItem: 6 });
    expect(c.map((x) => x.source.text)).toContain('ok, PERSON_C mentioned she has something so I will follow up with her');
  });

  it('pleasantries are recognised only when nothing else is said', () => {
    expect(isPleasantry('Awesome! Thanks all. Have an amazing weekend')).toBe(true);
    expect(isPleasantry('<@U0PERSONA> thanks!')).toBe(true);
    expect(isPleasantry("Thanks for the notes - I'll go ahead and cancel the prep")).toBe(false);
    expect(isPleasantry('great, sent it')).toBe(false);
  });
});

describe('R7: acknowledgements, notes, sessions and revisions are candidates', () => {
  const window = { seenAfter: 0, seenUntil: T0 + 3_600_000 * 48 };
  const dmLine = (min: number, o: Partial<CompletionSource>) => src({ externalId: `D0DM00001:${ts(min)}`, threadRef: `slack:D0DM00001:${ts(min)}`, occurredAt: at(min), participants: [ASKER, ME], ...o });

  it("keeps the asker's 'got it, thanks' after my line, tagged ack; drops it with no line of mine before it", () => {
    const it0 = item([dmAsk]);
    const mine = dmLine(20, { author: ME, fromMe: true, text: 'Here it is: https://docs.google.com/presentation/d/FILE_ACME_POV_000001/edit' });
    const ack = dmLine(25, { author: ASKER, text: 'got it, thanks!' });
    const cands = collectCandidates(it0, [mine, ack], window);
    expect(cands.find((c) => c.source.sourceItemId === ack.sourceItemId)?.relations).toEqual(expect.arrayContaining(['same_dm', 'from_asker', 'ack']));
    // Without my line first, the same words are chatter.
    expect(collectCandidates(it0, [dmLine(25, { author: ASKER, text: 'got it, thanks!' })], window)).toEqual([]);
    // My line linked as evidence earlier (not in this pass's sources) counts too.
    const linked = item([dmAsk, ev({ ...mine, role: 'progress', fromMe: true })]);
    expect(collectCandidates(linked, [ack], window)[0]?.relations).toContain('ack');
  });

  it("meeting notes of the item's meeting and a session naming the item get their own relation", () => {
    const meetingAsk = ev({ connector: 'calendar', kind: 'calendar_event', externalId: 'evt-002', threadRef: 'calendar:evt-002', occurredAt: at(-60), author: ASKER, role: 'context' });
    const it0 = item([dmAsk, meetingAsk]);
    const notes = src({ connector: 'gemini_notes', kind: 'meeting_notes', externalId: 'DOC_NOTES_0000001', threadRef: 'calendar:evt-002', occurredAt: at(120), title: 'ACME sync', text: 'Pat to send the pilot deck' });
    const session = src({ connector: 'claude_sessions', kind: 'claude_session', externalId: 'sess-1', occurredAt: at(90), fromMe: true, author: ME, title: 'ACME pilot deck', text: 'Built the ACME pilot deck, ready to send' });
    const unrelated = src({ connector: 'claude_sessions', kind: 'claude_session', externalId: 'sess-2', occurredAt: at(95), fromMe: true, author: ME, title: 'Refactor', text: 'renamed a function' });
    expect(relationsOf(itemFacts(it0), notes)).toEqual(['meeting_notes']);
    expect(relationsOf(itemFacts(it0), session)).toEqual(['session']);
    const cands = collectCandidates(it0, [notes, session, unrelated], window);
    expect(cands.map((c) => c.source.sourceItemId).sort()).toEqual([notes.sourceItemId, session.sourceItemId].sort());
    expect(cands.every((c) => !c.strong)).toBe(true); // at most "Likely done · Confirm"
  });
});
