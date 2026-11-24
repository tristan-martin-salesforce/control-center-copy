/**
 * Getting started's sentence (18-ui-polish.md): it names the outcomes this role has, the same number the sidebar card
 * counts ("2 of 5"), never the 17 steps.
 */
import { describe, expect, it } from 'vitest';
import { startedSentence } from '@/components/onboarding/started-sentence';

describe('startedSentence', () => {
  it('five outcomes for an SE', () => {
    expect(startedSentence(5)).toBe('Five things and Command Center runs your day. Each one ticks itself from what you actually did.');
  });
  it('four for a role without deal contributions', () => {
    expect(startedSentence(4)).toBe('Four things and Command Center runs your day. Each one ticks itself from what you actually did.');
  });
});
