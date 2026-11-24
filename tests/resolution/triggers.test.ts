/** Triggers (R3), their dedupe, the closed-item relevance filter (W0-2), the quiet detector and the sweep. */
import { describe, expect, it } from 'vitest';

import { closedItemLineCounts, isQuiet, sweepDue, triggerDedupeKey, triggersFor, type TriggerItem, type TriggerSource } from '@/scanner/resolution/triggers';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const it0: TriggerItem = { id: 'w1', status: 'open', title: 'Send PERSON_A the ACME pricing deck', askAt: '2026-11-09T10:00:00.000Z', conversationKeys: ['dm:D0A'], fileRefs: ['FILE_DECK_0001'], askerKeys: ['u0persona'], sessionIds: ['S1'] };
const src = (o: Partial<TriggerSource>): TriggerSource => ({ id: 's1', connector: 'slack', kind: 'message', occurredAt: '2026-11-10T11:00:00.000Z', fromMe: false, authorKeys: ['u0persona'], addressedToMe: true, conversationKey: 'dm:D0A', fileRefs: [], text: 'hi', ...o });

describe('triggersFor', () => {
  it('a new line in the conversation, a revision or share of the file, notes and sessions naming it, my line to the asker', () => {
    expect(triggersFor([it0], [src({})], NOW)[0]).toMatchObject({ itemId: 'w1', trigger: 'conversation_line' });
    expect(triggersFor([it0], [src({ connector: 'drive', kind: 'file_revision', conversationKey: null, fileRefs: ['FILE_DECK_0001'] })], NOW)[0]?.trigger).toBe('drive_revision');
    expect(triggersFor([it0], [src({ connector: 'drive', kind: 'file_share', conversationKey: null, fileRefs: ['FILE_DECK_0001'] })], NOW)[0]?.trigger).toBe('drive_share');
    expect(triggersFor([it0], [src({ connector: 'gemini_notes', conversationKey: null, authorKeys: [], text: 'Action: send the ACME pricing deck' })], NOW)[0]?.trigger).toBe('notes');
    expect(triggersFor([it0], [src({ connector: 'claude_sessions', conversationKey: null, sessionId: 'S1', text: 'x' })], NOW)[0]?.trigger).toBe('session');
    expect(triggersFor([it0], [src({ conversationKey: 'gmail-thread:T9', fromMe: true, authorKeys: [], recipientKeys: ['u0persona'] })], NOW)[0]?.trigger).toBe('conversation_line');
  });

  it('nothing for unrelated lines, lines before the ask, or items not live', () => {
    expect(triggersFor([it0], [src({ conversationKey: 'dm:OTHER' })], NOW)).toEqual([]);
    expect(triggersFor([it0], [src({ occurredAt: '2026-11-08T00:00:00.000Z' })], NOW)).toEqual([]);
    expect(triggersFor([{ ...it0, status: 'suggested' }], [src({})], NOW)).toEqual([]);
    expect(triggersFor([{ ...it0, status: 'dismissed' }], [src({})], NOW)).toEqual([]);
  });

  it('W0-2: a closed item — chatter in its DM does not select it; the asker writing to me, or a line naming it, does (once a day)', () => {
    const closed: TriggerItem = { ...it0, status: 'done', doneBy: 'engine', doneAt: '2026-11-10T09:00:00.000Z' };
    // someone else chatting in the conversation, not naming the deliverable
    expect(triggersFor([closed], [src({ authorKeys: ['u0personb'], text: 'lunch at noon?' })], NOW)).toEqual([]);
    expect(closedItemLineCounts(closed, src({ authorKeys: ['u0personb'], addressedToMe: false, text: 'see you there' }))).toBe(false);
    // the asker, to me
    const hit = triggersFor([closed], [src({ text: 'one more thing' })], NOW)[0]!;
    expect(hit.trigger).toBe('conversation_line');
    expect(hit.dedupeKey).toMatch(/:d\d+$/); // the per-day bucket
    // anyone naming the deliverable
    expect(triggersFor([closed], [src({ authorKeys: ['u0personb'], addressedToMe: false, text: 'is the pricing deck final?' })], NOW)).toHaveLength(1);
    // never mine, never older than the close, never a user close, never outside the window
    expect(triggersFor([closed], [src({ fromMe: true })], NOW)).toEqual([]);
    expect(triggersFor([closed], [src({ occurredAt: '2026-11-10T08:00:00.000Z' })], NOW)).toEqual([]);
    expect(triggersFor([{ ...closed, doneBy: 'user' }], [src({})], NOW)).toEqual([]);
    expect(triggersFor([{ ...closed, doneAt: '2026-10-01T00:00:00.000Z' }], [src({})], NOW)).toEqual([]);
    expect(triggersFor([closed], [src({})], NOW, { reopenOnFollowUp: false })).toEqual([]);
    // a closed item's drive revision never re-judges it
    expect(triggersFor([closed], [src({ connector: 'drive', conversationKey: null, fileRefs: ['FILE_DECK_0001'] })], NOW)).toEqual([]);
  });

  it('one hit per item, whatever the number of new lines', () => {
    expect(triggersFor([it0], [src({ id: 'a' }), src({ id: 'b' }), src({ id: 'c', connector: 'drive', conversationKey: null, fileRefs: ['FILE_DECK_0001'] })], NOW)).toHaveLength(1);
  });
});

describe('dedupe: one check per item per 10 minutes (per day when closed)', () => {
  it('the same bucket within 10 minutes, a new one after', () => {
    const t = new Date('2026-11-10T12:00:00.000Z');
    expect(triggerDedupeKey('w1', t)).toBe(triggerDedupeKey('w1', new Date(t.getTime() + 9 * 60_000)));
    expect(triggerDedupeKey('w1', t)).not.toBe(triggerDedupeKey('w1', new Date(t.getTime() + 10 * 60_000)));
    expect(triggerDedupeKey('w1', t)).not.toBe(triggerDedupeKey('w2', t));
    expect(triggerDedupeKey('w1', t, true)).toBe(triggerDedupeKey('w1', new Date(t.getTime() + 11 * 3600_000), true));
  });
});

describe('the quiet detector and the nightly sweep', () => {
  it('quiet: past the window (or due) with nobody writing since', () => {
    expect(isQuiet({ kind: 'ask', askAt: '2026-11-01T00:00:00.000Z', lastLineAt: '2026-11-02T00:00:00.000Z' }, NOW)).toBe(true);
    expect(isQuiet({ kind: 'ask', askAt: '2026-11-01T00:00:00.000Z', lastLineAt: '2026-11-09T00:00:00.000Z' }, NOW)).toBe(false);
    expect(isQuiet({ kind: 'ask', askAt: '2026-11-08T00:00:00.000Z' }, NOW)).toBe(false);
    expect(isQuiet({ kind: 'task', askAt: '2026-11-08T00:00:00.000Z', dueAt: '2026-11-09T00:00:00.000Z' }, NOW)).toBe(true);
  });
  it('sweep: never checked, or not in 7 days', () => {
    expect(sweepDue(null, NOW)).toBe(true);
    expect(sweepDue('2026-11-09T00:00:00.000Z', NOW)).toBe(false);
    expect(sweepDue('2026-11-02T00:00:00.000Z', NOW)).toBe(true);
  });
});
