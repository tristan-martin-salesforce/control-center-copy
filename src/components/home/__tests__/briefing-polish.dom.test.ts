// @vitest-environment jsdom
/**
 * Home polish (docs/reviews/2026-11-20-holistic/18-ui-polish.md): the Respond line says what it hides ("+N more", never
 * a count above fewer chips), the Do-now lead fits beside the meter ("Top 3 of 9."), a card's prep steps read as one
 * line ("2/3 done · Next: …") instead of three clipped chips, and the plan nudge is true on a weekend morning.
 * Placeholder data only.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeRespond, HomeRespondChip } from '@/contract';
import { $, cleanup, click, render } from '../../composer/__tests__/dom';

const nav = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/shell/router', async (orig) => ({ ...(await orig<typeof import('@/components/shell/router')>()), navigate: (href: string) => nav(href) }));
vi.mock('@/components/shell/panel', async (orig) => ({ ...(await orig<typeof import('@/components/shell/panel')>()), useRightPanel: () => ({ openDetails: vi.fn() }) }));

const { RespondStrip, respondMore } = await import('../Briefing');
const { draftMoreSpoken, draftSpoken, leadNote, prepSummary } = await import('../DoNow');

afterEach(async () => {
  await cleanup();
  nav.mockReset();
});

const chip = (i: number): HomeRespondChip => ({
  id: `c${i}`,
  kind: 'draft',
  who: `Person ${i}`,
  text: 'Placeholder reply',
  state: 'ready',
  verb: 'Send',
  href: `/outbox?draft=c${i}`,
  entity: { kind: 'draft', id: `c${i}`, label: `Draft to Person ${i}` },
});
const respond = (count: number, chips: number): HomeRespond => ({ count, ready: chips, failed: 0, chips: Array.from({ length: chips }, (_, i) => chip(i)), review: { label: `Review ${chips}`, href: '/outbox' } });

describe('Respond: what the line hides is said', () => {
  it('respondMore: first the chips that did not fit, then the replies the briefing did not send', () => {
    expect(respondMore(11, 5, 3, false)).toEqual({ n: 8, to: 'expand' });
    expect(respondMore(11, 5, 3, true)).toEqual({ n: 6, to: 'work' });
    expect(respondMore(11, 5, 5, false)).toEqual({ n: 6, to: 'work' });
    expect(respondMore(3, 3, 3, false)).toBeNull();
  });

  it('every chip fits but the count is larger: "+N more on Work" opens Work ▸ Asked of me', async () => {
    const { container } = await render(h(RespondStrip, { r: respond(11, 3) }));
    const more = $('[data-testid="home-respond-more"]', container)!;
    expect(more.textContent).toBe('+8 more on Work');
    await click(more);
    expect(nav).toHaveBeenCalledWith('/work?tab=asked_of_me');
  });

  it('nothing hidden: no "+N more"', async () => {
    const { container } = await render(h(RespondStrip, { r: respond(2, 2) }));
    expect($('[data-testid="home-respond-more"]', container)).toBeNull();
  });
});

describe('Do now: short lines that fit at 1440', () => {
  it('the lead names the top N of the total and nothing else', () => {
    const cards = [{ carried: null }, { carried: null }, { carried: null }] as never;
    expect(leadNote({ day: 'today', nextDay: null, doNow: { cards, total: 9 } } as never)).toBe('Top 3 of 9.');
  });

  it('prep steps read as one line: how far along, then the next step; every step in the tooltip', () => {
    const p = prepSummary([
      { label: 'Send Alice the agenda', done: true },
      { label: 'Answer the SSO question', done: true },
      { label: 'Kick off the build', done: false },
    ]);
    expect(p).toEqual({ count: '2/3 done', next: 'Kick off the build', title: '✓ Send Alice the agenda\n✓ Answer the SSO question\n○ Kick off the build' });
    expect(prepSummary([{ label: 'Only step', done: true }])).toMatchObject({ count: '✓ all 1 done', next: null });
    expect(prepSummary([]).count).toBeNull();
  });
});

describe('Do now ▸ draft rows name (axe label-content-name-mismatch)', () => {
  it('the shown words come first, the queue place is a hidden suffix', () => {
    expect(draftSpoken(1, 3)).toBe(' · draft 1 of 3, opens it');
    expect(`+2 more${draftMoreSpoken(2, 3)}`).toBe('+2 more to approve · opens draft 2 of 3');
  });
});
