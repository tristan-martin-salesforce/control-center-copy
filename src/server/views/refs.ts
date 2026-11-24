/**
 * The small presentation helpers every read view shares: entity links, the live-state test, time labels.
 */
import type { EntityRef, WorkItemRecord } from '@/contract';

/** HH:mm in the user's profile timezone (server-rendered labels must not depend on the host tz). */
export function fmtHM(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const LIVE_STATES = new Set(['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done', 'reopened']);

export function isLive(i: WorkItemRecord): boolean {
  return LIVE_STATES.has(i.state);
}

export function hrefFor(ref: { type: string; id: string }): string {
  switch (ref.type) {
    case 'work_item':
      return `/work/${ref.id}`;
    case 'initiative':
      return `/initiatives/${ref.id}`;
    case 'account':
      return `/deals/${ref.id}`;
    case 'opportunity':
      return `/deals?opp=${ref.id}`;
    case 'brief':
      return `/briefs?brief=${ref.id}`;
    case 'agent_run':
      return `/agents?run=${ref.id}`;
    case 'draft':
      return `/outbox?draft=${ref.id}`;
    case 'connector':
      return `/health?connector=${ref.id}`;
    case 'missed_opp':
      return `/deals/missed?id=${ref.id}`;
    default:
      return '/';
  }
}

export function itemRef(i: WorkItemRecord): EntityRef {
  return { type: 'work_item', id: i.id, label: i.title, href: hrefFor({ type: 'work_item', id: i.id }) };
}
