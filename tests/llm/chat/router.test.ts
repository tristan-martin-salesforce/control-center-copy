/**
 * Auto routing (H-6): the deterministic reading of a turn and its tier, as a decision table. No model call.
 */
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/contract';
import { classifyIntent, continuationOf, CONTINUE_WORDS, listRows, plansFirst, routeTurn, STEP_LIMIT_CODE, stepLimitMessage, stoppedAtStepLimit, stoppedForBudget } from '@/llm/chat/router';

describe('the router (decision table)', () => {
  it.each([
    ['What are my top 3 today?', 'lookup', 'fast', 'haiku'],
    ['which opps close this quarter?', 'lookup', 'fast', 'haiku'],
    ['find the deck I made for Globex', 'lookup', 'fast', 'haiku'],
    ['snooze the Globex VDP update until 14:00', 'act', 'fast', 'haiku'],
    ['mark the ACME prep as done', 'act', 'fast', 'haiku'],
    ['pin the renewal call', 'act', 'fast', 'haiku'],
    ['remember that I log in 15-minute steps', 'lookup', 'fast', 'haiku'], // P31-2: the remember tool keeps it (its own guard), no act
    ['thanks!', 'chat', 'fast', 'haiku'],
    ['Why is the ACME build first?', 'explain', 'balanced', 'sonnet'],
    ['explain what changed since yesterday', 'explain', 'balanced', 'sonnet'],
    ['draft a reply to Dana about the pricing', 'draft', 'balanced', 'sonnet'],
    ['write an email to the Globex team', 'draft', 'balanced', 'sonnet'],
    ['Have I done anything for Fabrikam in the past?', 'research', 'strong', 'opus'],
    ['go back and find everything for this VDP', 'research', 'strong', 'opus'],
    ['plan my week around the two demos', 'research', 'strong', 'opus'],
    ['check the DCs and then claim the missing ones and then log my time', 'research', 'strong', 'opus'],
  ] as const)('%s → %s (%s, %s)', (text, intent, tier, model) => {
    const r = routeTurn({ text });
    expect(r).toMatchObject({ intent, tier, model, override: false });
    expect(r.why.length).toBeGreaterThan(3);
  });

  it('a pasted list of more than five rows is list mode: at least Sonnet', () => {
    const paste = ['claim any I don’t have a DC on:', ...Array.from({ length: 8 }, (_, i) => `- Placeholder ${i} · Renewal`)].join('\n');
    expect(listRows(paste)).toBe(8);
    expect(classifyIntent(paste).listMode).toBe(true);
    expect(routeTurn({ text: `snooze these:\n${paste}` })).toMatchObject({ intent: 'act', tier: 'balanced', model: 'sonnet', why: 'a list of changes (list mode)' });
    expect(routeTurn({ text: 'snooze these: a, b' }).tier).toBe('fast');
  });

  it("the user's choice wins: the message's model first, then Settings ▸ Budgets routing; auto means the router", () => {
    expect(routeTurn({ text: 'top 3 today', choice: 'opus' })).toMatchObject({ model: 'opus', tier: 'strong', override: true, why: 'you chose Opus' });
    expect(routeTurn({ text: 'top 3 today', setting: 'sonnet' })).toMatchObject({ model: 'sonnet', tier: 'balanced', override: true, why: 'Settings: always Sonnet' });
    expect(routeTurn({ text: 'top 3 today', choice: 'haiku', setting: 'opus' })).toMatchObject({ model: 'haiku', why: 'you chose Haiku' });
    expect(routeTurn({ text: 'top 3 today', choice: 'auto', setting: 'auto' })).toMatchObject({ model: 'haiku', override: false });
    expect(routeTurn({ text: 'research Globex', choice: 'auto', setting: 'haiku' })).toMatchObject({ model: 'haiku', intent: 'research', override: true });
  });

  it('P31-1: "continue", "go on", "keep going" after a stop keep the stopped turn\'s intent and tier', () => {
    for (const text of ['continue', 'go on', 'keep going', 'please continue', 'carry on']) {
      expect(routeTurn({ text, previous: { intent: 'research', tier: 'strong', failed: true } }), text).toMatchObject({ intent: 'research', model: 'opus', why: 'a follow-up to research' });
      expect(routeTurn({ text, previous: { intent: 'draft', tier: 'balanced', failed: true } }), text).toMatchObject({ intent: 'draft', model: 'sonnet' });
      // after a failed Haiku turn it still goes up to Sonnet (D-81 a retry)
      expect(routeTurn({ text, previous: { intent: 'lookup', tier: 'fast', failed: true } }).model, text).toBe('sonnet');
      expect(CONTINUE_WORDS.test(text)).toBe(true);
    }
    expect(routeTurn({ text: 'continue' }).model).toBe('haiku');
    expect(CONTINUE_WORDS.test('should I continue the Globex POC?')).toBe(false);
  });

  it('P31-1: a typed "continue" continues the last answer only when it stopped at Steps per message', () => {
    const stepStop = { type: 'error', error: { code: 'internal', message: stepLimitMessage(7), retryable: true, details: { catalogCode: STEP_LIMIT_CODE } } } as const;
    const legacy = { type: 'error', error: { code: 'internal', message: stepLimitMessage(200), retryable: true } } as const;
    const budget = { type: 'error', error: { code: 'budget_exceeded', message: 'Stopped at the cost limit', retryable: false } } as const;
    const m = (id: string, role: 'user' | 'assistant', parts: unknown[] = []) => ({ id, role, parts }) as never as Pick<ChatMessage, 'id' | 'role' | 'parts'>;
    const thread = [m('u1', 'user'), m('a1', 'assistant', [stepStop])];
    expect(continuationOf(thread, { text: 'continue' })?.id).toBe('a1');
    expect(continuationOf(thread, { text: 'Keep going' })?.id).toBe('a1');
    expect(continuationOf([m('a0', 'assistant', [legacy])], { text: 'go on' })?.id).toBe('a0'); // a row stored before the code
    expect(continuationOf(thread, { text: 'top 3 today' })).toBeNull();
    // a cost-limit stop needs the user's Allow more (its id), not a typed "continue"
    expect(continuationOf([m('a2', 'assistant', [budget])], { text: 'continue' })).toBeNull();
    expect(continuationOf([m('a2', 'assistant', [budget])], { text: 'Continue (allowed $5.00 more)', continueMessageId: 'a2' })?.id).toBe('a2');
    // an answer that finished is not continued, and a later stop only counts if it is the last answer
    expect(continuationOf([...thread, m('u2', 'user'), m('a3', 'assistant')], { text: 'continue' })).toBeNull();
    expect(stoppedAtStepLimit({ parts: [budget] } as never)).toBe(false);
    expect(stoppedForBudget({ parts: [stepStop] } as never)).toBe(true);
  });

  it('P31-2: "remember" is no act word: a question about memory is a lookup', () => {
    expect(routeTurn({ text: 'what did I decide to remember?' })).toMatchObject({ intent: 'lookup', model: 'haiku' });
    expect(routeTurn({ text: 'what did I decide to remember about the Globex renewal?' }).intent).toBe('lookup');
    expect(classifyIntent('remember that I log in 15-minute steps').intent).not.toBe('act');
    expect(classifyIntent('snooze the Globex one').intent).toBe('act');
  });

  it('research turns plan first', () => {
    expect(plansFirst(routeTurn({ text: 'have I ever met Initech?' }))).toBe(true);
    expect(plansFirst(routeTurn({ text: 'top 3 today' }))).toBe(false);
  });
});
