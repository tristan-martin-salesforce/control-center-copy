/** Today ▸ the timeline's meeting badges: prep pending, blocked, missed, and the next meeting's countdown (split out of TodayPage.tsx). */
import { useCallback } from 'react';
import type { CalendarEvent, WorkItem } from '@/contract';
import type { MeetingState } from './DayTimeline';
import { isBlocked } from './rows';
import { hm, msOf } from './time';

export function useMeetingState(events: readonly CalendarEvent[] | undefined, items: ReadonlyMap<string, WorkItem>, now: string) {
  const nextMeeting = events
    ?.filter((e) => !['declined', 'cancelled'].includes(e.attendance) && msOf(e.start) > msOf(now))
    .sort((a, b) => msOf(a.start) - msOf(b.start))[0];
  return useCallback(
    (ev: CalendarEvent): MeetingState => {
      if (ev.attendance === 'declined' || ev.attendance === 'cancelled') return { star: false, tone: null, badge: null, note: null };
      const prepItem = ev.prep?.workItemId ? items.get(ev.prep.workItemId) : undefined;
      const needsPrep = !!ev.prep && !ev.prep.ready;
      const star = needsPrep || ev.isCustomerFacing;
      // the label may already say "prep: 20m ›": one "prep:" and no chevron in the note
      const prepLabel = ev.prep?.label.replace(/\s*›\s*$/, '') || null;
      const countdown = nextMeeting?.id === ev.id ? `in ${hm(Math.max(0, (msOf(ev.start) - msOf(now)) / 60_000))}` : null;
      const note = [countdown, prepLabel ? (needsPrep && !/^prep:/i.test(prepLabel) ? `prep: ${prepLabel}` : prepLabel) : null].filter(Boolean).join(' · ') || null;
      if (ev.attendance === 'missed') return { star, tone: null, badge: { tone: 'neutral', label: ev.takeaways?.count ? `✕ Missed · ${ev.takeaways.count} takeaways` : '✕ Missed' }, note: null };
      if (star && prepItem && isBlocked(prepItem)) return { star, tone: 'blocked', badge: { tone: 'danger', label: '⏸ Blocked' }, note };
      if (star && needsPrep) return { star, tone: 'risk', badge: { tone: 'warning', label: '◐ Prep pending' }, note };
      return { star, tone: null, badge: null, note };
    },
    [items, nextMeeting?.id, now],
  );
}
