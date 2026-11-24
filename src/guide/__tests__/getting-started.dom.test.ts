// @vitest-environment jsdom
/**
 * The Getting started card and popover in a DOM: the card counts the five outcomes ("0/5", never the steps), the
 * popover lists the outcomes still to do first, each with its steps as the detail, done outcomes fold into
 * "Done · N", every button names where it goes, and a button asks CoachMarks for that item's guidance (an action's tip,
 * or a page's whole tour). All done: "You're set up · Done", and the popover offers to hide the checklist.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuidePayload } from '@/contract';
import { $, $$, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';
import { DC_STEP, guidePayload, itemDoneKey, PERSONA_REVIEWED_KEY, type GuideInputs } from '@/guide/checklist';
import { exploreFor, tourDoneKey } from '@/guide/pages';
import { GUIDE_EVENT, type GuideRequest } from '@/guide/request';
import { personaOf } from '@/personas';

const se = personaOf({ profile: { role: 'se_ic' } });
const state: { g: GuidePayload | null } = { g: null };
const markSeen = vi.fn();
const dismissChecklist = vi.fn();
const openFeedback = vi.fn();
vi.mock('@/client/hooks', () => ({ useApi: () => ({ data: state.g, refetch: () => Promise.resolve() }) }));
vi.mock('@/guide/useGuide', () => ({ useGuideSettings: () => ({ guide: { version: 1, checklistDismissed: false, seen: {} }, ready: true, markSeen, dismissChecklist, resetGuide: () => {}, pending: false }) }));
vi.mock('@/components/shell/FeedbackButton', () => ({ useOpenFeedback: () => openFeedback }));
const onboarding: { data: { firstScan: { lookbackDays: number } | null; draft: { history: { lookbackDays?: number } } } | undefined } = { data: undefined };
vi.mock('@/components/onboarding/OnboardingGate', () => ({ useOnboardingState: () => onboarding }));

const { GettingStarted } = await import('@/guide/GettingStarted');
const { GettingStartedPage, firstScanEstimateLine } = await import('@/guide/GettingStartedPage');

const at = '2026-11-11T09:00:00Z';
function payload(over: Partial<GuideInputs> = {}): GuidePayload {
  return guidePayload({
    connectors: se.connectors.map((c) => ({ id: c, label: c, state: 'ok' as const, lastSuccessAt: at })),
    drafts: [],
    assistantMessages: 0,
    firstScan: null,
    persona: se,
    personaVersion: 1,
    guide: { seen: {}, checklistDismissed: false },
    ...over,
  });
}

async function open(g: GuidePayload) {
  state.g = g;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(h(QueryClientProvider, { client: qc }, h(GettingStarted, {})));
  await click($('[data-testid="getting-started"]'));
  return waitFor(() => $('[data-testid="getting-started-list"]'));
}

afterEach(async () => {
  await cleanup();
  state.g = null;
  onboarding.data = undefined;
  for (const f of [markSeen, dismissChecklist, openFeedback]) f.mockReset();
});

describe('Getting started popover', () => {
  it('the card counts the outcomes, and the popover lists the open ones first with their steps', async () => {
    const g = payload({ assistantMessages: 2, guide: { seen: { [tourDoneKey('home')]: at }, checklistDismissed: false } });
    state.g = g;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(h(QueryClientProvider, { client: qc }, h(GettingStarted, {})));
    // sources and its first scan are done: 1 of the 5 outcomes, never "4/18"
    const card = $('[data-testid="getting-started"]')!;
    // content names the card (no aria-label, axe label-content-name-mismatch): the title as shown, the short "1/5"
    // hidden from screen readers and a visually hidden line in its place
    expect(card.hasAttribute('aria-label')).toBe(false);
    const shown = card.querySelector('[aria-hidden]')!;
    expect(shown.textContent).toBe('1/5');
    expect(card.querySelector('.sr-only')!.textContent).toBe(': 1 of 5 done. Next: Check your role and thresholds');
    expect(card.textContent).toBe('Getting started1/5: 1 of 5 done. Next: Check your role and thresholds');
    await click($('[data-testid="getting-started"]'));
    await waitFor(() => $('[data-testid="getting-started-list"]'));
    expect($('[data-testid="getting-started-list"]')!.textContent).toContain('1 of 5 done');
    const left = $$('[data-testid="gs-open"] > li').map((li) => li.getAttribute('data-testid'));
    expect(left).toEqual(['gs-outcome-role', 'gs-outcome-draft', 'gs-outcome-week', 'gs-outcome-dc']);
    // an outcome's steps are its detail, in the path's order: the tours and the Assistant under the draft
    expect($$('[data-testid="gs-steps-draft"] > li').map((li) => li.getAttribute('data-testid'))).toEqual(['gs-item-tour.triage', 'gs-item-tour.outbox', 'gs-item-draft', 'gs-item-assistant', 'gs-item-tour.briefs', 'gs-item-tour.agents']);
    expect($('[data-testid="gs-outcome-draft"]')!.textContent).toContain('1 of 6 steps');
    const toggle = $('[data-testid="gs-done-toggle"]')!;
    expect(toggle.textContent).toBe('Done · 1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect($('[data-testid="gs-done"]')).toBeNull();
    await click(toggle);
    expect($$('[data-testid="gs-done"] > li').map((li) => li.getAttribute('data-testid'))).toEqual(['gs-outcome-sources']);
    // a done tour can be taken again; a done action has no button
    expect($('[data-testid="gs-go-tour.home"]')!.textContent).toBe('Take it again');
    expect($('[data-testid="gs-go-assistant"]')).toBeNull();
  });

  it('the page counts the same five outcomes as the card, one slot each', async () => {
    state.g = payload({ assistantMessages: 2 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(h(QueryClientProvider, { client: qc }, h(GettingStartedPage)));
    expect($('[data-testid="gs-page-count"]')!.textContent).toBe('1 of 5 done.');
    expect($$('li[data-outcome]').map((li) => [li.getAttribute('data-outcome'), li.getAttribute('data-state')])).toEqual([
      ['sources', 'done'],
      ['role', 'todo'],
      ['draft', 'todo'],
      ['week', 'todo'],
      ['dc', 'todo'],
    ]);
  });

  it('until the first scan is done, Connect your sources says what it costs for the lookback chosen in setup', async () => {
    onboarding.data = { firstScan: { lookbackDays: 14 }, draft: { history: {} } };
    state.g = payload({ firstScan: { status: 'active' } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(h(QueryClientProvider, { client: qc }, h(GettingStartedPage)));
    const line = $('li[data-outcome="sources"] [data-testid="gs-first-scan-estimate"]')!;
    expect(line.textContent).toBe(`${firstScanEstimateLine(14)}. Past that it asks before it goes on.`);
    expect(line.textContent).toMatch(/^First scan: usually about \$\d+\.\d\d, up to \$\d+\.\d\d, about 2 h\./);
    expect(line.textContent).not.toMatch(/p50|p90/);
    expect($$('[data-testid="gs-first-scan-estimate"]')).toHaveLength(1);
    await cleanup();
    // done: no estimate
    state.g = payload();
    await render(h(QueryClientProvider, { client: new QueryClient() }, h(GettingStartedPage)));
    expect($('[data-testid="gs-first-scan-estimate"]')).toBeNull();
  });

  it('the DC step confirms in place ("I’ve claimed one")', async () => {
    await open(payload());
    const btn = $('[data-testid="gs-confirm-dc"]')!;
    expect(btn.textContent).toBe('I’ve claimed one');
    await click(btn);
    expect(markSeen).toHaveBeenCalledWith([itemDoneKey(DC_STEP)]);
  });

  it('every button names where it goes, and asks for that item’s guidance', async () => {
    const asked: GuideRequest[] = [];
    const on = (e: Event) => asked.push((e as CustomEvent<GuideRequest>).detail);
    window.addEventListener(GUIDE_EVENT, on);
    try {
      await open(payload());
      expect($('[data-testid="gs-go-persona"]')!.textContent).toBe('Open Role & rules');
      expect($('[data-testid="gs-go-persona"]')!.getAttribute('href')).toBe('/settings?section=role');
      expect($('[data-testid="gs-go-tour.triage"]')!.textContent).toBe('Take the tour');
      expect($('[data-testid="gs-go-draft"]')!.textContent).toBe('Show me in the Outbox');
      expect($$('[data-testid^="gs-go-"]').map((b) => b.textContent)).not.toContain('Open');
      // Feedback plays where you are: no navigation, the tip spotlights the top-bar button
      await click($('[data-testid="gs-go-feedback"]'));
      expect(asked).toEqual([{ page: null, item: 'feedback' }]);
      await waitFor(() => !$('[data-testid="getting-started-list"]'));
    } finally {
      window.removeEventListener(GUIDE_EVENT, on);
    }
  });

  it('the role row confirms in place, and Feedback can still be reported in one click', async () => {
    await open(payload());
    await click($('[data-testid="gs-confirm-persona"]'));
    expect(markSeen).toHaveBeenCalledWith([PERSONA_REVIEWED_KEY]);
    await click($('[data-testid="gs-feedback"]'));
    expect(openFeedback).toHaveBeenCalledTimes(1);
  });

  it('all done: "You’re set up · Done", and the popover offers to hide the checklist', async () => {
    const seen: Record<string, string> = { [PERSONA_REVIEWED_KEY]: at, [itemDoneKey(DC_STEP)]: at };
    for (const e of exploreFor(se)) seen[tourDoneKey(e.page)] = at;
    const g = payload({
      drafts: [
        { status: 'sent', destination: { kind: 'slack', target: 'thread', channelId: 'C0PLACE', channelName: 'x', threadTs: null } },
        { status: 'sent', destination: { kind: 'action', action: 'slack_canvas.create' } },
        { status: 'sent', destination: { kind: 'action', action: 'feedback.post' } },
      ] as never,
      assistantMessages: 1,
      guide: { seen, checklistDismissed: false },
    });
    expect(g.done).toBe(g.total);
    state.g = g;
    const qc = new QueryClient();
    await render(h(QueryClientProvider, { client: qc }, h(GettingStarted, {})));
    const card = $('[data-testid="getting-started"]')!;
    expect(card.textContent).toContain('You’re set up');
    expect(card.textContent).toContain('Done');
    expect(card.hasAttribute('aria-label')).toBe(false);
    expect(card.querySelector('.sr-only')!.textContent).toBe(`: all ${g.total} done`);
    await click(card);
    await waitFor(() => $('[data-testid="getting-started-list"]'));
    expect($('[data-testid="gs-open"]')).toBeNull();
    const hide = $('[data-testid="gs-dismiss"]')!;
    expect(hide.textContent).toBe('Hide the checklist');
    await act(async () => hide.click());
    expect(dismissChecklist).toHaveBeenCalledWith(true);
  });
});
