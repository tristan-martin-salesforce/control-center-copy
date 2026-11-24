// @vitest-environment jsdom
/**
 * Today ▸ the timeline's meeting note (29-persona-qa): a prep label that already says "prep: 20m ›" reads
 * "prep: 20m" once, never "prep: prep: 20m"; a bare label gets the prefix; a ready meeting's label shows as is.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarEvent } from '@/contract';
import { cleanup, render } from '@/components/composer/__tests__/dom';
import { eventSpokenSuffix } from '../DayTimeline';
import { useMeetingState } from '../TodayPage.meetings';

const now = '2026-11-21T09:00:00Z';
const ev = (id: string, prep: CalendarEvent['prep']): CalendarEvent =>
  ({ id, title: id, start: '2026-11-21T15:00:00Z', end: '2026-11-21T16:00:00Z', attendance: 'accepted', isCustomerFacing: true, prep }) as unknown as CalendarEvent;

function Notes({ events }: { events: CalendarEvent[] }) {
  // an earlier meeting is the next one, so no countdown joins the notes under test
  const state = useMeetingState([...events, { ...ev('next', null), start: '2026-11-21T10:00:00Z' }], new Map(), now);
  return h('ul', null, ...events.map((e) => h('li', { key: e.id, 'data-id': e.id }, state(e).note ?? '')));
}

afterEach(cleanup);

describe('meeting prep note', () => {
  it('says "prep:" once', async () => {
    const { container } = await render(
      h(Notes, {
        events: [
          ev('labelled', { ready: false, label: 'prep: 20m ›', workItemId: null }),
          ev('bare', { ready: false, label: '20m', workItemId: null }),
          ev('ready', { ready: true, label: 'demo org building', workItemId: null }),
        ] as CalendarEvent[],
      }),
    );
    const note = (id: string) => container.querySelector(`[data-id="${id}"]`)!.textContent;
    expect(note('labelled')).toBe('prep: 20m');
    expect(note('bare')).toBe('prep: 20m');
    expect(note('ready')).toBe('demo org building');
  });
});

describe('meeting block name (axe label-content-name-mismatch)', () => {
  it('adds only what the block leaves out', () => {
    // the meta line shows the time: nothing to add, the name is the shown text
    expect(eventSpokenSuffix('15:00–16:00', '15:00–16:00 · prep: 20m', '15:00–16:00 · prep: 20m', false)).toBe('');
    // live ("now · 12m left") hides the time
    expect(eventSpokenSuffix('15:00–16:00', 'now · 12m left', 'now · 12m left', false)).toBe(' · 15:00–16:00');
    // declined: the meta says "Declined", the time joins it
    expect(eventSpokenSuffix('15:00–16:00', 'Declined', 'Declined', true)).toBe(' · 15:00–16:00');
    // a badge in the meta's place on a short block: the declined line and the time are spoken
    expect(eventSpokenSuffix('15:00–16:00', 'Cancelled', null, true)).toBe(' · Cancelled · 15:00–16:00');
    expect(eventSpokenSuffix('15:00–16:00', '15:00–16:00 · Tentative · not blocking', null, true)).toBe(' · 15:00–16:00 · Tentative · not blocking');
    expect(eventSpokenSuffix('15:00–16:00', '15:00–16:00', null, false)).toBe(' · 15:00–16:00');
  });
});
