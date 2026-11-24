/** Resolution rules D1–D6 (pure). Placeholder data only. */
import { describe, expect, it } from 'vitest';

import { evaluateRules, isAcknowledgement, isChase, isPromiseOnly, isQuestionTitle, isSubstantive, type RuleLine } from './rules';

const ASK_AT = '2026-11-02T16:00:00.000Z';
const at = (min: number) => new Date(Date.parse(ASK_AT) + min * 60_000).toISOString();
const me = (id: string, min: number, text: string, extra: Partial<RuleLine> = {}): RuleLine => ({ id, at: at(min), fromMe: true, byAsker: false, text, ...extra });
const asker = (id: string, min: number, text: string): RuleLine => ({ id, at: at(min), fromMe: false, byAsker: true, text });

describe('text helpers', () => {
  it('promises are not substance; links, files and twelve real words are', () => {
    expect(isPromiseOnly("I'll send it over tomorrow")).toBe(true);
    expect(isPromiseOnly('Happy to help, let me check with the PM and get back to you')).toBe(true);
    expect(isSubstantive({ text: "I'll send it over tomorrow" })).toBe(false);
    expect(isSubstantive({ text: 'here: https://docs.example.com/document/d/FILE_PLACEHOLDER/edit' })).toBe(true);
    expect(isSubstantive({ text: 'here you go', files: [{ name: 'deck.pdf' }] })).toBe(true);
    expect(isSubstantive({ text: 'Test members are loaded as synthetic records for the POC, and your IdP is only used for staff users.' })).toBe(true);
  });
  it('acknowledgements close a loop; a thanks that asks for more does not', () => {
    expect(isAcknowledgement('got it, thanks!')).toBe(true);
    expect(isAcknowledgement('That works for us.')).toBe(true);
    expect(isAcknowledgement('Thanks. Please also state the residency assumption.')).toBe(false);
    expect(isAcknowledgement('thanks, but the link doesn’t open')).toBe(false);
    expect(isChase('that link doesn’t open, can you re-share?')).toBe(true);
    expect(isChase('perfect, thanks')).toBe(false);
  });
  it('question-type titles', () => {
    expect(isQuestionTitle('Answer PERSON_A: how do identities enter the org?')).toBe(true);
    expect(isQuestionTitle('Confirm which groups map to permission sets')).toBe(true);
    expect(isQuestionTitle('Send PERSON_A the deck')).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('D1: my reply carrying the asked deck → done, Sure, citing it; D5 with it → Sure', () => {
    const r = evaluateRules({ item: { kind: 'ask', title: 'Send PERSON_A the pricing deck' }, askAt: ASK_AT, after: [me('c1', 5, 'here it is https://docs.google.com/presentation/d/FILE_PLACEHOLDER_01/edit'), asker('c2', 9, 'perfect, thanks!')] });
    expect(r.fired.map((f) => f.rule)).toEqual(['D1', 'D5']);
    expect(r.decision).toMatchObject({ rule: 'D1', decides: 'done', confidence: 'sure', cite: 'c1' });
    expect(r.fired.find((f) => f.rule === 'D5')?.confidence).toBe('sure');
    expect(r.hints).toMatchObject({ myReplyAfterAskMin: 5, replyHasLinkOrFile: true, askerAckAfterMine: true, askerChasedAfterMine: false, lastWriter: 'asker' });
  });

  it('a chase after my delivery vetoes D1, D2 and D5 (SCN-4)', () => {
    const r = evaluateRules({ item: { kind: 'ask', title: 'Send PERSON_A the pricing deck' }, askAt: ASK_AT, after: [me('c1', 5, 'here it is https://docs.google.com/presentation/d/FILE_PLACEHOLDER_01/edit'), asker('c2', 30, 'that link doesn’t open, can you re-share?')] });
    expect(r.fired).toEqual([]);
    expect(r.decision).toBeNull();
    expect(r.hints.askerChasedAfterMine).toBe(true);
  });

  it('D2: a question answered with substance → Sure; a promise only → nothing', () => {
    const item = { kind: 'ask', title: 'Answer PERSON_A: how do member identities enter the POC org?' };
    const answered = evaluateRules({ item, askAt: ASK_AT, after: [me('c1', 35, 'Good question. Test members are loaded as synthetic records for the POC, and your IdP is only used for staff users via SAML.')] });
    expect(answered.decision).toMatchObject({ rule: 'D2', confidence: 'sure', cite: 'c1' });
    const promised = evaluateRules({ item, askAt: ASK_AT, after: [me('c1', 35, "I'll check with the PM and get back to you tomorrow")] });
    expect(promised.decision).toBeNull();
    // A reply before the ask is history, not an answer.
    expect(evaluateRules({ item, askAt: ASK_AT, after: [me('c0', -5, 'Test members are loaded as synthetic records for the POC, and your IdP is only for staff.')] }).decision).toBeNull();
  });

  it('D2 needs a question-type ask: a deliverable answered in words is the model’s call', () => {
    const r = evaluateRules({ item: { kind: 'ask', title: 'Send PERSON_A the expected volumes' }, askAt: ASK_AT, after: [me('c1', 35, 'Rough volumes: 1.8M members, about 420k monthly interactions, 35% about claim status, 1.2M active profiles.')] });
    expect(r.decision).toBeNull();
  });

  it('D3 read-back and D4 finished session', () => {
    expect(evaluateRules({ item: { kind: 'task', title: 'Fix the DC on the opp' }, askAt: ASK_AT, after: [], record: { fixed: true, cite: 'rb1' } }).decision).toMatchObject({ rule: 'D3', confidence: 'sure', cite: 'rb1' });
    const s = evaluateRules({ item: { kind: 'task', title: 'Build the demo flow' }, askAt: ASK_AT, after: [], session: { status: 'done', lastMessage: 'Opened PR #42 with the flow', cite: 'sess1' } });
    expect(s.decision).toMatchObject({ rule: 'D4', confidence: 'likely' });
    expect(evaluateRules({ item: { kind: 'task', title: 'Build the demo flow' }, askAt: ASK_AT, after: [], session: { status: 'waiting', lastMessage: 'PR #42?' } }).decision).toBeNull();
  });

  it('D5 alone: the asker acknowledged my last reply → Likely', () => {
    const r = evaluateRules({ item: { kind: 'commitment', title: 'Walk PERSON_A through the sizing' }, askAt: ASK_AT, after: [me('c1', 60, 'Walked through it on the call just now.'), asker('c2', 62, 'got it, thanks')] });
    expect(r.decision).toMatchObject({ rule: 'D5', confidence: 'likely', cite: 'c2' });
  });

  it('D6: nothing new since the last verdict → skip; something new → no skip', () => {
    expect(evaluateRules({ item: { kind: 'ask', title: 'Send the deck' }, askAt: ASK_AT, after: [], lastVerdictAt: at(60), latestInputAt: at(30) }).decision).toMatchObject({ rule: 'D6', decides: 'skip' });
    expect(evaluateRules({ item: { kind: 'ask', title: 'Send the deck' }, askAt: ASK_AT, after: [], lastVerdictAt: at(60), latestInputAt: at(90) }).decision).toBeNull();
  });
});
