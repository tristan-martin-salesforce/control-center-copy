/**
 * R1 + R2 (holistic review 2026-11-20, lane 03): one correction rule for both closers, and a follow-up after a close
 * reopens. *Tenet: Suggest, then learn*: an item you reopened or kept is never closed again for you.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_CLOSING_SETTINGS } from '@/contract';
import { applySignal } from '@/engines/closure/machine';
import { signalFromEvidence } from '@/engines/closure/signals';
import { autoCloseBlock, mayAutoClose, type CorrectionFacts } from '@/engines/closure/correction';
import type { Signal } from '@/engines/types';
import { citem, DANA, daysBefore, SIGNALS, T0 } from './fixtures';

const S = SIGNALS as Record<keyof typeof SIGNALS, Signal>;
const facts = (o: Partial<CorrectionFacts> = {}): CorrectionFacts => ({ userReopened: false, userKept: false, externalCommitment: false, people: ['Dana'], channels: ['acme-ext'], ...o });

describe('the correction rule (pure)', () => {
  it('reopened, kept and ask-first lists block; accepting, snoozing or editing do not exist as facts at all', () => {
    expect(mayAutoClose(facts(), DEFAULT_CLOSING_SETTINGS)).toBe(true);
    expect(autoCloseBlock(facts({ userReopened: true }), DEFAULT_CLOSING_SETTINGS)).toBe('user_reopened');
    expect(autoCloseBlock(facts({ userKept: true }), DEFAULT_CLOSING_SETTINGS)).toBe('user_kept');
    expect(autoCloseBlock(facts({ externalCommitment: true }), DEFAULT_CLOSING_SETTINGS)).toBe('ask_first_external');
    expect(autoCloseBlock(facts({ externalCommitment: true }), { ...DEFAULT_CLOSING_SETTINGS, askFirstExternalCommitments: false })).toBeNull();
    expect(autoCloseBlock(facts(), { ...DEFAULT_CLOSING_SETTINGS, askFirstPeople: ['dana'] })).toBe('ask_first_person');
    expect(autoCloseBlock(facts(), { ...DEFAULT_CLOSING_SETTINGS, askFirstChannels: ['#acme-ext'] })).toBe('ask_first_channel');
  });
});

describe('the closure machine honours it', () => {
  it('a reopened item is never re-closed: a Sure completion only asks (Likely done · Confirm)', () => {
    const d = applySignal(citem({ status: 'in_progress', mayAutoClose: false, autoCloseBlock: 'user_reopened' }), S.done_sure!);
    expect(d.transition).toMatchObject({ from: 'in_progress', to: 'likely_done', autonomy: null });
    expect(d.labels[0]!.text).toContain('not closed for you: you reopened it');
  });

  it('an item accepted from Triage (no correction) still closes for you', () => {
    const d = applySignal(citem({ status: 'open', mayAutoClose: true, autoCloseBlock: null }), S.done_sure!);
    expect(d.transition).toMatchObject({ to: 'done', autonomy: 'L4_auto' });
  });
});

describe('R2: a follow-up after a close for you reopens it', () => {
  const doneForMe = (daysAgo: number) => citem({ status: 'done', doneAt: daysBefore(daysAgo), doneBy: 'engine', resolution: 'done_by_me' });
  const followUp = signalFromEvidence({ id: 'ev-f', role: 'contradiction', confidence: 'likely', reason: "follow_up: Dana wrote again: that link doesn't open", at: T0, linkedAt: T0, source: 'slack', actor: DANA });

  it('within the window: "Reopened: Dana wrote again · Undo"', () => {
    const d = applySignal(doneForMe(2), followUp);
    expect(d.transition).toMatchObject({ from: 'done', to: 'open' });
    expect(d.labels[0]).toEqual({ kind: 'reopened', text: 'Reopened: Dana wrote again · Undo' });
    expect(d.reopenDecision).toMatchObject({ outcome: 'reopened', ruleKey: 'same_deliverable_recent' });
  });

  it('outside the window it becomes a sibling; a message from before the close never reopens', () => {
    expect(applySignal(doneForMe(30), followUp).kind).toBe('sibling');
    const early = signalFromEvidence({ id: 'ev-e', role: 'contradiction', confidence: 'likely', reason: 'follow_up: Dana wrote again: ping', at: daysBefore(3), linkedAt: T0, source: 'slack', actor: DANA });
    expect(applySignal(doneForMe(2), early).reopenDecision).toMatchObject({ outcome: 'ignored', ruleKey: 'older_than_close' });
  });
});
