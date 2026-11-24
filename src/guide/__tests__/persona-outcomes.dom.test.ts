// @vitest-environment jsdom
/**
 * Getting started in each persona's words (29-persona-qa, D-55, UX.md "Getting started = five outcomes"): an SE logs a
 * week of activity; a Specialist AE's fourth outcome is the week's forecast notes, the batch its step stages, and its
 * deal contribution outcome reads "Not part of your role" and is not counted (4 outcomes).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuidePayload, PersonaId } from '@/contract';
import { $, cleanup, render } from '@/components/composer/__tests__/dom';
import { guidePayload } from '@/guide/checklist';
import { personaOf } from '@/personas';

const state: { g: GuidePayload | null; persona: PersonaId } = { g: null, persona: 'se' };
vi.mock('@/client/hooks', () => ({
  useApi: (key: string) => ({ data: key === 'getSettings' ? { persona: { version: 1, id: state.persona }, profile: { role: 'se_ic' } } : state.g, refetch: () => Promise.resolve() }),
}));
vi.mock('@/guide/useGuide', () => ({ useGuideSettings: () => ({ guide: { version: 1, checklistDismissed: false, seen: {} }, ready: true, markSeen: vi.fn(), dismissChecklist: vi.fn(), resetGuide: () => {}, pending: false }) }));
vi.mock('@/components/shell/FeedbackButton', () => ({ useOpenFeedback: () => vi.fn() }));
vi.mock('@/components/onboarding/OnboardingGate', () => ({ useOnboardingState: () => ({ data: undefined }) }));

const { GettingStartedPage } = await import('@/guide/GettingStartedPage');

const at = '2026-11-11T09:00:00Z';
afterEach(async () => {
  await cleanup();
  state.g = null;
});

describe.each([
  { persona: 'se' as const, title: 'Log a week', why: 'activity log for Org62', total: 5, dc: 'Opps you work on get your DC' },
  { persona: 'ae' as const, title: 'Update your forecast notes', why: 'in-quarter Specialist Forecasts', total: 4, dc: 'Not part of your role.' },
])('Getting started as the $persona persona', ({ persona, title, why, total, dc }) => {
  it('names the week outcome for the role and counts only its outcomes', async () => {
    const p = personaOf({ persona: { id: persona } });
    state.persona = persona;
    state.g = guidePayload({ connectors: p.connectors.map((c) => ({ id: c, label: c, state: 'ok' as const, lastSuccessAt: at })), drafts: [], assistantMessages: 0, firstScan: null, persona: p, personaVersion: 1, guide: { seen: {}, checklistDismissed: false } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(h(QueryClientProvider, { client: qc }, h(GettingStartedPage)));
    const week = $('li[data-outcome="week"]')!;
    expect(week.querySelector('h2')!.textContent).toBe(title);
    expect(week.textContent).toContain(why);
    expect($('[data-testid="gs-page-count"]')!.textContent).toBe(`1 of ${total} done.`);
    expect($('li[data-outcome="dc"]')!.textContent).toContain(dc);
  });
});
