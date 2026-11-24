// @vitest-environment jsdom
/**
 * 24-visual-qa, surface 3 (Getting started):
 * - The sidebar card and the page follow what ticks each outcome: claiming a DC (deals) or logging a batch (time)
 *   moves the count at once. The card sat on 1/5 after a claim until the window lost focus.
 * - An outcome's button is one button that navigates, never a button inside a link (two tab stops).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuidePayload } from '@/contract';
import { queryKey } from '@/client/api';
import { _resetLiveFollowers, followersFor } from '@/client/live';
import { $$, cleanup, render, waitFor } from '@/components/composer/__tests__/dom';
import { guidePayload } from '@/guide/checklist';
import { personaOf } from '@/personas';

const se = personaOf({ profile: { role: 'se_ic' } });
const state: { g: GuidePayload | null } = { g: null };
vi.mock('@/client/hooks', () => ({ useApi: () => ({ data: state.g, refetch: () => Promise.resolve(), isLoading: false }) }));
vi.mock('@/guide/useGuide', () => ({ useGuideSettings: () => ({ guide: { version: 1, checklistDismissed: false, seen: {} }, ready: true, markSeen: () => {}, dismissChecklist: () => {}, resetGuide: () => {}, pending: false }) }));
vi.mock('@/components/shell/FeedbackButton', () => ({ useOpenFeedback: () => () => {} }));
vi.mock('@/components/onboarding/OnboardingGate', () => ({ useOnboardingState: () => ({ data: undefined }) }));

const { GettingStarted, GUIDE_TOPICS } = await import('@/guide/GettingStarted');
const { GettingStartedPage } = await import('@/guide/GettingStartedPage');

const at = '2026-11-11T09:00:00Z';
const payload = () =>
  guidePayload({
    connectors: se.connectors.map((c) => ({ id: c, label: c, state: 'ok' as const, lastSuccessAt: at })),
    drafts: [],
    assistantMessages: 0,
    firstScan: null,
    persona: se,
    personaVersion: 1,
    guide: { seen: {}, checklistDismissed: false },
  });

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(async () => {
  await cleanup();
  _resetLiveFollowers();
  state.g = null;
});

describe('Getting started follows what ticks its outcomes', () => {
  it('names every outcome’s topic', () => {
    for (const t of ['health', 'draft', 'deals', 'time', 'settings']) expect(GUIDE_TOPICS).toContain(t);
  });

  it('the card and the page refetch the guide on a DC claim (deals) and a logged batch (time)', async () => {
    state.g = payload();
    await render(h(QueryClientProvider, { client: qc() }, h('div', null, h(GettingStarted, {}), h(GettingStartedPage))));
    const key = JSON.stringify(queryKey('getGuide'));
    for (const topic of ['deals', 'time']) {
      const keys = followersFor([topic]).map((k) => JSON.stringify(k));
      expect(keys.filter((k) => k === key)).toHaveLength(2);
    }
  });

  it('an outcome’s button is not nested in a link', async () => {
    state.g = payload();
    await render(h(QueryClientProvider, { client: qc() }, h(GettingStartedPage)));
    await waitFor(() => ($$('[data-outcome-cta]').length ? true : null));
    for (const b of $$('[data-outcome] button')) expect(b.closest('a')).toBeNull();
  });
});
