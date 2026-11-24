// @vitest-environment jsdom
/**
 * The spotlight tour in a DOM: the card is a labelled modal dialog that takes focus and keeps it (Tab wraps, focus
 * that wanders comes back), → / ← / Esc move it, page shortcuts stay silent underneath, and the first-visit run
 * records seen per Next and the page's whole set on Esc, then hands focus back to where it was.
 */
import { act, createElement as h, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyboardProvider, useKeyBinding } from '@/client/keyboard/KeyboardProvider';
import { $, $$, advance, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';
import { personaOf } from '@/personas';
import type { TourMove } from '@/guide/tour';

const markSeen = vi.fn();
/** settings.guide.seen as the tour reads it (tests set what was seen before). */
const guideState: { seen: Record<string, string> } = { seen: {} };
vi.mock('@/guide/useGuide', () => ({
  useGuideSettings: () => ({ guide: { version: 1, checklistDismissed: false, seen: guideState.seen }, ready: true, markSeen, dismissChecklist: () => {}, resetGuide: () => {}, pending: false }),
}));
/** Health's first scan as the tour reads it (null: none running). */
const health: { firstScan: unknown } = { firstScan: null };
vi.mock('@/client/hooks', () => ({
  useApi: () => ({ data: { firstScan: health.firstScan }, isSuccess: true, isError: false }),
}));

const { SpotlightTour } = await import('@/guide/SpotlightTour');
const { CoachMarks, replayCoachMarks } = await import('@/guide/CoachMarks');
const { requestGuide } = await import('@/guide/request');
const { PERSONA_REVIEWED_KEY } = await import('@/guide/checklist');

/** An element the tour can point at: jsdom has no layout, so give it a box. */
function anchor(html: string, box = { top: 120, left: 200, width: 300, height: 60 }): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const el = wrap.firstElementChild as HTMLElement;
  el.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function key(k: string, opts: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  });
}

const STEPS = [
  { id: 't.one', selector: '#one', title: 'First thing', text: 'What the first thing is.', side: 'bottom' as const },
  { id: 't.two', selector: '#two', title: 'Second thing', text: 'What the second thing is.', side: 'bottom' as const },
];

function PageKeys({ onJ }: { onJ: () => void }) {
  useKeyBinding('j', onJ);
  return null;
}

/** The tour with its index driven by the moves, like CoachMarks does. */
function Harness({ onMove, onJ }: { onMove: (m: TourMove) => void; onJ: () => void }) {
  const [index, setIndex] = useState(0);
  return h(
    KeyboardProvider,
    null,
    h(PageKeys, { onJ }),
    h('button', { id: 'outside', type: 'button' }, 'Outside'),
    h(SpotlightTour, {
      steps: STEPS,
      index,
      onMove: (m: TourMove) => {
        onMove(m);
        if (m === 'next') setIndex((i) => Math.min(i + 1, STEPS.length - 1));
        if (m === 'back') setIndex((i) => Math.max(0, i - 1));
      },
    }),
  );
}

// Fake timers for every test (the tour's settle, poll and auto-advance delays, rAF focus): `waitFor` advances the fake
// clock per poll and `advance(ms)` stands in for a pause, so the file never waits on the wall clock.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  markSeen.mockReset();
  health.firstScan = null;
  guideState.seen = {};
  window.sessionStorage.clear();
});

describe('SpotlightTour whose element cannot be placed', () => {
  it('never holds the page: no scrim, clicks and keys pass through, and the step moves on', async () => {
    // a zero-sized target (a collapsed table in a narrow pane): findAnchor rejects it, so nothing is placed
    anchor('<section id="one">One</section>', { top: 120, left: 200, width: 0, height: 586 });
    const moves: TourMove[] = [];
    const onJ = vi.fn();
    await render(h(Harness, { onMove: (m) => moves.push(m), onJ }));
    const root = $('[data-testid="coach-tour"]')!;
    expect(root.className).toContain('pointer-events-none');
    expect($('[data-testid="coach-scrim"]')).toBeNull();
    // page shortcuts still work and focus is not pulled into an invisible card
    key('j', {}, document.body);
    expect(onJ).toHaveBeenCalledTimes(1);
    await advance(2600);
    expect(moves).toContain('next');
  });
});

describe('SpotlightTour', () => {
  beforeEach(() => {
    anchor('<section id="one" style="border-top-left-radius: 16px">One</section>');
    anchor('<section id="two">Two</section>', { top: 400, left: 200, width: 300, height: 60 });
  });

  it('is a labelled modal dialog with a live step label, and takes focus', async () => {
    await render(h(Harness, { onMove: () => {}, onJ: () => {} }));
    const card = await waitFor(() => $('[data-testid="coach-mark"]'));
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(card.getAttribute('aria-labelledby')!)?.textContent).toBe('First thing');
    expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe('What the first thing is.');
    const label = $('[data-testid="coach-step"]')!;
    expect(label.getAttribute('aria-live')).toBe('polite');
    expect(label.textContent).toBe('Step 1 of 2');
    await waitFor(() => document.activeElement === $('[data-testid="coach-next"]'));
    // the cutout is there, with the element's corners plus the padding
    expect($('[data-testid="coach-cutout"]')!.style.borderRadius).toBe('24px');
    expect($('[data-testid="coach-back"]')).toBeNull();
  });

  it('traps Tab inside the card and pulls wandering focus back', async () => {
    await render(h(Harness, { onMove: () => {}, onJ: () => {} }));
    const next = await waitFor(() => (document.activeElement === $('[data-testid="coach-next"]') ? $('[data-testid="coach-next"]') : null));
    key('Tab');
    expect(document.activeElement).toBe($('[data-testid="coach-skip"]'));
    key('Tab');
    expect(document.activeElement).toBe(next);
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe($('[data-testid="coach-skip"]'));
    act(() => ($('#outside') as HTMLButtonElement).focus());
    expect(document.activeElement).toBe(next);
  });

  it('→ is Next, ← is Back (not on step 1), Esc skips; page shortcuts stay silent', async () => {
    const moves: TourMove[] = [];
    const onJ = vi.fn();
    await render(h(Harness, { onMove: (m) => moves.push(m), onJ }));
    await waitFor(() => $('[data-testid="coach-mark"]'));
    key('ArrowLeft');
    expect(moves).toEqual([]);
    key('ArrowRight');
    await waitFor(() => $('[data-testid="coach-step"]')?.textContent === 'Step 2 of 2');
    expect($('[data-testid="coach-next"]')!.textContent).toBe('Done');
    expect($('[data-mark]')!.getAttribute('data-mark')).toBe('t.two');
    key('ArrowLeft');
    await waitFor(() => $('[data-testid="coach-step"]')?.textContent === 'Step 1 of 2');
    key('j');
    expect(onJ).not.toHaveBeenCalled();
    key('Escape');
    expect(moves).toEqual(['next', 'back', 'skip']);
  });

  it('a click on the dimmed page does nothing but put focus back on the card', async () => {
    const moves: TourMove[] = [];
    await render(h(Harness, { onMove: (m) => moves.push(m), onJ: () => {} }));
    const scrim = await waitFor(() => $('[data-testid="coach-scrim"]'));
    await waitFor(() => document.activeElement === $('[data-testid="coach-next"]'));
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    act(() => {
      scrim.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(moves).toEqual([]);
    expect(document.activeElement).toBe($('[data-testid="coach-next"]'));
  });
});

describe('the first-visit tour (CoachMarks)', () => {
  it('records each step on Next, the page’s whole set on Esc, and gives focus back', async () => {
    const se = personaOf({ profile: { role: 'se_ic' } });
    anchor('<section class="hm-mast">Masthead</section>');
    anchor('<section class="hm-day">Day</section>', { top: 260, left: 200, width: 600, height: 80 });
    // home.donow and home.pagehelp have no element here: skipped, and the count says so
    const before = anchor('<button id="before" type="button">Before</button>', { top: 10, left: 10, width: 40, height: 20 });
    act(() => before.focus());
    await render(h(KeyboardProvider, null, h(CoachMarks, { routeKey: 'home', persona: se })));
    const card = await waitFor(() => $('[data-testid="coach-mark"]'), 6000);
    expect(card.getAttribute('data-mark')).toBe('home.masthead');
    expect($('[data-testid="coach-step"]')!.textContent).toBe('Step 1 of 2');
    expect($$('[data-testid="coach-dots"] > span')).toHaveLength(2);
    await click($('[data-testid="coach-next"]'));
    expect(markSeen).toHaveBeenLastCalledWith(['home.masthead']);
    await waitFor(() => $('[data-mark="home.dayline"]'));
    key('Escape');
    expect([...markSeen.mock.lastCall![0]].sort()).toEqual(['home.dayline', 'home.donow', 'home.masthead', 'home.pagehelp']);
    await waitFor(() => !$('[data-testid="coach-tour"]'));
    await waitFor(() => document.activeElement === before);
  });

  it('waits while the first scan fills in; "Show this page’s tips again" replays it anyway, from step 1', async () => {
    const se = personaOf({ profile: { role: 'se_ic' } });
    health.firstScan = { status: 'active', lookbackDays: 7, startedAt: new Date().toISOString(), floorAt: new Date().toISOString(), budgetUsd: 10, spentUsd: 1, doneAt: null, scopes: [{ connector: 'slack', status: 'active', coveredPct: 20 }] };
    anchor('<section class="hm-mast">Masthead</section>');
    await render(h(KeyboardProvider, null, h(CoachMarks, { routeKey: 'home', persona: se })));
    await advance(2200);
    expect($('[data-testid="coach-tour"]')).toBeNull();
    act(() => replayCoachMarks('home'));
    const card = await waitFor(() => $('[data-testid="coach-mark"]'));
    expect(card.getAttribute('data-mark')).toBe('home.masthead');
    expect($('[data-testid="coach-step"]')!.textContent).toBe('Tip');
  });
});

describe('Getting started guidance (a request)', () => {
  const se = personaOf({ profile: { role: 'se_ic' } });
  const ALL_HOME = { 'home.masthead': 't', 'home.dayline': 't', 'home.donow': 't', 'home.pagehelp': 't' };

  it('"Take the tour" on a page already seen, without navigating: plays from step 1, Done ticks the page, asking again plays again', async () => {
    guideState.seen = { ...ALL_HOME };
    anchor('<section class="hm-mast">Masthead</section>');
    anchor('<section class="hm-day">Day</section>', { top: 260, left: 200, width: 600, height: 80 });
    await render(h(KeyboardProvider, null, h(CoachMarks, { routeKey: 'home', persona: se })));
    // seen before: no first-visit tour
    await advance(1600);
    expect($('[data-testid="coach-tour"]')).toBeNull();
    act(() => requestGuide({ page: 'home', item: null }));
    const card = await waitFor(() => $('[data-testid="coach-mark"]'));
    expect(card.getAttribute('data-mark')).toBe('home.masthead');
    expect($('[data-testid="coach-step"]')!.textContent).toBe('Step 1 of 2');
    await click($('[data-testid="coach-next"]'));
    await waitFor(() => $('[data-mark="home.dayline"]'));
    await click($('[data-testid="coach-next"]'));
    // Done on the last step: the step, and the page as toured (its Getting started item ticks)
    expect(markSeen).toHaveBeenLastCalledWith(['home.dayline', 'tour.home']);
    await waitFor(() => !$('[data-testid="coach-tour"]'));
    act(() => requestGuide({ page: 'home', item: null }));
    await waitFor(() => $('[data-mark="home.masthead"]'));
  });

  it('"Show me" plays an item’s tip where you are (Feedback names no page), and Done ticks that item', async () => {
    guideState.seen = { ...ALL_HOME };
    anchor('<button type="button" data-feedback-entry>Feedback</button>', { top: 10, left: 900, width: 90, height: 28 });
    await render(h(KeyboardProvider, null, h(CoachMarks, { routeKey: 'home', persona: se })));
    act(() => requestGuide({ page: null, item: 'feedback' }));
    const card = await waitFor(() => $('[data-testid="coach-mark"]'));
    expect(card.getAttribute('data-mark')).toBe('guide.feedback');
    expect($('[data-testid="coach-step"]')!.textContent).toBe('Tip');
    expect(card.textContent).toContain('Report a bug or an idea');
    await click($('[data-testid="coach-next"]'));
    await waitFor(() => !$('[data-testid="coach-tour"]'));
    // Done on the tip ticks its Getting started item at once, nothing else
    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(markSeen).toHaveBeenLastCalledWith(['checklist.feedback']);
  });

  it('a request for another page waits for the navigation, then spotlights the element (a fallback when the first is missing)', async () => {
    guideState.seen = { ...ALL_HOME, 'outbox.dryrun': 't', 'outbox.row': 't' };
    // no ready draft: the tip falls back to the first row
    anchor('<div data-testid="outbox-row" data-group="sent">A sent draft</div>');
    const tree = (routeKey: 'home' | 'outbox') => h(KeyboardProvider, null, h(CoachMarks, { routeKey, persona: se }));
    const r = await render(tree('home'));
    act(() => requestGuide({ page: 'outbox', item: 'draft' }));
    await advance(700);
    expect($('[data-testid="coach-tour"]')).toBeNull();
    await act(async () => r.root.render(tree('outbox')));
    const card = await waitFor(() => $('[data-testid="coach-mark"]'));
    expect(card.getAttribute('data-mark')).toBe('guide.draft');
    expect(card.textContent).toContain('Your first draft');
  });

  it('the role tip’s "Looks right" confirms the role and ends the tip', async () => {
    guideState.seen = { 'settings.find': 't', 'settings.effect': 't' };
    anchor('<header data-guide="role-header">Role &amp; rules</header>');
    await render(h(KeyboardProvider, null, h(CoachMarks, { routeKey: 'settings', persona: se })));
    act(() => requestGuide({ page: 'settings', item: 'persona' }));
    await waitFor(() => $('[data-mark="guide.persona"]'));
    expect($('[data-testid="coach-confirm"]')!.textContent).toBe('Looks right');
    await click($('[data-testid="coach-confirm"]'));
    expect(markSeen).toHaveBeenLastCalledWith([PERSONA_REVIEWED_KEY]);
    await waitFor(() => !$('[data-testid="coach-tour"]'));
  });
});
