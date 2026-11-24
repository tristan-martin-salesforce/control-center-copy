import { describe, expect, it } from 'vitest';
import { autonomyRaised, canPreview, changedKeys, conditionToWhen, DEFAULT_THRESHOLDS, isDirty, lastChangedLine, newRule, parseThresholds, same, setWeight, validateBudgets, validateHours } from '@/components/settings/derive';

const w = { customer_facing: 3, meeting_proximity: 3, due_urgency: 2.5, manager_ask: 2, deal_value: 1.5, lead_time: 2, age: 0.5, effort_fit: 1 };

describe('settings derive', () => {
  it('compares deeply and builds minimal patches', () => {
    expect(same({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(same({ a: [1] }, { a: [2] })).toBe(false);
    const server = { tone: 'crisp', length: 'short', signoff: '' };
    expect(changedKeys({ ...server, tone: 'warm' }, server, ['tone', 'length'])).toEqual({ tone: 'warm' });
    expect(isDirty(server, server, ['tone'])).toBe(false);
    // an unrelated key never makes a sub-section dirty
    expect(isDirty({ ...server, signoff: 'x' }, server, ['tone', 'length'])).toBe(false);
  });

  it('clamps and rounds weights to half steps', () => {
    expect(setWeight(w, 'age', 11).age).toBe(10);
    expect(setWeight(w, 'age', -1).age).toBe(0);
    expect(setWeight(w, 'age', 2.26).age).toBe(2.5);
  });

  it('builds plain-language rules', () => {
    const r = newRule('  Manager asks within 24 h  ', 'manager', 14, 'r1');
    expect(r).toMatchObject({ id: 'r1', text: 'Manager asks within 24 h', enabled: true, boost: 10, when: { fromManager: true } });
    expect(conditionToWhen('due24')).toEqual({ dueWithinH: 24 });
    expect(conditionToWhen('any')).toEqual({});
  });

  it('only previews when the draft differs from the saved policy', () => {
    expect(canPreview(w, [], w, [])).toBe(false);
    expect(canPreview(setWeight(w, 'age', 2), [], w, [])).toBe(true);
  });

  it('says who last changed the policy', () => {
    const v = (version: number, by: 'user' | 'chat' | 'system') => ({ version, by }) as never;
    expect(lastChangedLine([v(4, 'chat'), v(3, 'user')], 4)).toBe('Last changed by chat · v4');
    expect(lastChangedLine([v(1, 'system')], 1)).toBe('Last changed by the starter pack · v1');
  });

  it('flags autonomy raised to one-click or beyond', () => {
    expect(autonomyRaised({ slack_reply: 'L1', email_reply: 'L1' }, { slack_reply: 'L3', email_reply: 'L2' })).toEqual(['slack_reply']);
  });

  it('parses thresholds defensively', () => {
    expect(parseThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('{bad')).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds('{"reopenWindowDays":999,"mergeScore":0.1,"autoCloseMin":"likely","snoozeWakeOnNewInfo":true}')).toEqual({ autoCloseMin: 'likely', reopenWindowDays: 999, mergeScore: 0.5, snoozeWakeOnNewInfo: true });
  });

  it('validates hours and budgets', () => {
    expect(validateHours('07:30', '17:30')).toBeNull();
    expect(validateHours('18:00', '07:00')).toMatch(/before/);
    expect(validateHours('7:30', '17:30')).toMatch(/24-hour/);
    expect(validateBudgets(5, 15, 80)).toBeNull();
    expect(validateBudgets(20, 15, 80)).toMatch(/cannot/);
  });
});
