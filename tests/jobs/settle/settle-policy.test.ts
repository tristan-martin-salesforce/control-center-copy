/**
 * Settle policy: verdict + confidence + Closing settings → close / ask / reopen / leave, and the guards that keep a
 * correction from being overridden. Placeholder data only.
 */
import { describe, expect, it } from 'vitest';

import { ClosingSettings, DEFAULT_CLOSING_SETTINGS } from '../../../src/contract';
import { decideSettle, type PolicyItem } from '../../../src/engines/settle/policy';
import type { SettleResult } from '../../../src/engines/settle/types';

const res = (o: Partial<SettleResult>): SettleResult => ({ workItemId: 'w-1', verdict: 'done_by_you', confidence: 0.9, reason: 'You sent it', valid: true, model: 'm', costUsd: 0, inputTokens: 0, outputTokens: 0, skill: 'settle-item@1', ...o });
const item = (o: Partial<PolicyItem> = {}): PolicyItem => ({ id: 'w-1', kind: 'ask', status: 'open', userTouched: false, userReopened: false, externalCommitment: false, people: ['PERSON_A'], channels: [], ...o });
const S = DEFAULT_CLOSING_SETTINGS;

describe('decideSettle', () => {
  it('closes a confident done_by_you with done_by_me, and asks below the threshold', () => {
    expect(decideSettle(res({}), item(), S)).toMatchObject({ action: 'close', reason: 'done_by_you', resolution: 'done_by_me' });
    expect(decideSettle(res({ confidence: 0.45 }), item(), S)).toMatchObject({ action: 'ask_looks_done', reason: 'done_by_you' });
    expect(decideSettle(res({ confidence: 0.3 }), item(), S)).toMatchObject({ action: 'leave' });
  });

  it('maps reasons to resolutions and the ask group', () => {
    expect(decideSettle(res({ verdict: 'moment_passed' }), item(), S)).toMatchObject({ action: 'close', resolution: 'not_needed' });
    expect(decideSettle(res({ verdict: 'resolved_by_other' }), item(), S)).toMatchObject({ action: 'close', resolution: 'done_by_other' });
    // every reason defaults to close (each measured ≥97% right on the answer key)
    expect(decideSettle(res({ verdict: 'not_yours' }), item(), S)).toMatchObject({ action: 'close', reason: 'not_yours', resolution: 'not_needed' });
    expect(decideSettle(res({ verdict: 'gone_quiet', confidence: 0.6 }), item(), S)).toMatchObject({ action: 'close', reason: 'gone_quiet', resolution: 'not_needed' });
    const askGq = ClosingSettings.parse({ ...S, reasons: { ...S.reasons, gone_quiet: 'ask' } });
    expect(decideSettle(res({ verdict: 'gone_quiet', confidence: 0.6 }), item(), askGq)).toMatchObject({ action: 'ask_still_needed', reason: 'gone_quiet' });
  });

  it('waiting_on_them moves a live item to Chase (even one the user reopened), never closes it', () => {
    expect(decideSettle(res({ verdict: 'waiting_on_them', confidence: 0.75 }), item(), S)).toMatchObject({ action: 'wait', reason: null });
    expect(decideSettle(res({ verdict: 'waiting_on_them', confidence: 0.75 }), item({ userReopened: true, userTouched: true }), S)).toMatchObject({ action: 'wait' });
    expect(decideSettle(res({ verdict: 'waiting_on_them', confidence: 0.75 }), item({ status: 'waiting_on_others' }), S)).toMatchObject({ action: 'leave' });
    expect(decideSettle(res({ verdict: 'waiting_on_them', confidence: 0.45 }), item(), S)).toMatchObject({ action: 'leave' });
    expect(decideSettle(res({ verdict: 'waiting_on_them', confidence: 0.75 }), item({ status: 'done' }), S)).toMatchObject({ action: 'leave' });
  });

  it('R1: never closes what the user reopened or kept; asks about one they reframed (title/kind edited)', () => {
    expect(decideSettle(res({}), item({ userReopened: true }), S)).toMatchObject({ action: 'leave' });
    expect(decideSettle(res({}), item({ userKept: true }), S)).toMatchObject({ action: 'leave' });
    expect(decideSettle(res({}), item({ userTouched: true }), S)).toMatchObject({ action: 'ask_looks_done' });
  });

  it('R1: an item accepted from Triage (or snoozed, or given an account) may still close: no correction facts', () => {
    // policyFacts no longer turns an accept/snooze/edit change set into userTouched (SCN-3).
    expect(decideSettle(res({}), item({ status: 'open', userTouched: false, userReopened: false, userKept: false }), S)).toMatchObject({ action: 'close' });
  });

  it('R2: an item closed for you that a follow-up shows is still yours reopens (Reopen on follow-up on)', () => {
    const still = res({ verdict: 'still_yours', confidence: 0.8 });
    expect(decideSettle(still, item({ status: 'done', doneByEngine: true }), S)).toMatchObject({ action: 'reopen' });
    expect(decideSettle(still, item({ status: 'done', doneByEngine: true }), ClosingSettings.parse({ ...S, reopenOnFollowUp: false }))).toMatchObject({ action: 'leave' });
    expect(decideSettle(still, item({ status: 'done', doneByEngine: false }), S)).toMatchObject({ action: 'leave' }); // you closed it
    expect(decideSettle(res({}), item({ status: 'done', doneByEngine: true }), S)).toMatchObject({ action: 'leave' }); // done stays done
  });

  it('asks first for external commitments and for people on the ask-first list', () => {
    expect(decideSettle(res({}), item({ kind: 'commitment', externalCommitment: true }), S)).toMatchObject({ action: 'ask_looks_done' });
    const s = ClosingSettings.parse({ ...S, askFirstPeople: ['person_a'] });
    expect(decideSettle(res({}), item(), s)).toMatchObject({ action: 'ask_looks_done' });
  });

  it('follows the per-reason setting and the master switch', () => {
    const leave = ClosingSettings.parse({ ...S, reasons: { ...S.reasons, done_by_you: 'leave' } });
    expect(decideSettle(res({}), item(), leave)).toMatchObject({ action: 'leave' });
    const off = ClosingSettings.parse({ ...S, enabled: false });
    expect(decideSettle(res({}), item(), off)).toMatchObject({ action: 'ask_looks_done' });
  });

  it('reopens a suggestion that is confidently still yours, and leaves invalid verdicts alone', () => {
    expect(decideSettle(res({ verdict: 'still_yours', confidence: 0.85 }), item({ status: 'suggested' }), S)).toMatchObject({ action: 'reopen' });
    expect(decideSettle(res({ verdict: 'still_yours', confidence: 0.85 }), item(), S)).toMatchObject({ action: 'leave' });
    expect(decideSettle(res({ valid: false, invalidWhy: 'x' }), item(), S)).toMatchObject({ action: 'leave' });
    expect(decideSettle(res({}), item({ status: 'done' }), S)).toMatchObject({ action: 'leave' });
  });

  it('never closes "not an ask", "moment passed" or "gone quiet" while a matching meeting is still ahead', () => {
    for (const verdict of ['not_an_ask', 'moment_passed', 'gone_quiet'] as const) expect(decideSettle(res({ verdict, upcomingEvent: true }), item(), S).action).toBe('ask_still_needed');
    expect(decideSettle(res({ verdict: 'done_by_you', upcomingEvent: true }), item(), S)).toMatchObject({ action: 'close' });
  });

  it('closes a training only on evidence it was done, and never while the asker wrote last this week', () => {
    expect(decideSettle(res({ verdict: 'gone_quiet', confidence: 0.8 }), item({ kind: 'training' }), S).action).toBe('ask_still_needed');
    expect(decideSettle(res({ verdict: 'done_by_you' }), item({ kind: 'training' }), S).action).toBe('close');
    expect(decideSettle(res({ verdict: 'not_an_ask', confidence: 0.8 }), item({ kind: 'task', originSource: 'org62' }), S).action).toBe('ask_still_needed');
    expect(decideSettle(res({ verdict: 'moment_passed', openLoop: true }), item(), S).action).toBe('ask_still_needed');
    expect(decideSettle(res({ verdict: 'done_by_you', openLoop: true }), item(), S).action).toBe('close');
  });

  it('closes a suggestion directly, and leaves an ask on a suggestion in Triage', () => {
    expect(decideSettle(res({}), item({ status: 'suggested' }), S)).toMatchObject({ action: 'close' });
    expect(decideSettle(res({ confidence: 0.45 }), item({ status: 'suggested' }), S)).toMatchObject({ action: 'leave' });
  });
});
