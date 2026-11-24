/**
 * Every badge points at what it counts (D-60, pure; tested in ./badges.test.ts). The sidebar's Time count is the sum of
 * the main tabs' counts (Time, VDP), each main tab's is the sum of its sub-tabs', and the sidebar's link lands on the
 * tab that holds the count, so a click never opens a screen with nothing to do.
 *
 *   loud (approvals waiting)   logging canvases → Time ▸ Log it · forecast canvases → Time ▸ Forecast ·
 *                              VDP changes → VDP ▸ Changes
 *   quiet (nothing waits)      the VDPs that need you → VDP ▸ Changes
 *                              DC requests and VDP use cases waiting for a canvas → Time ▸ Log it (2026-11-13 audit
 *                              C2: they are work, so the badge never reads 0 while they wait; never loud)
 *
 * Both waiting: the link goes to the larger count of approvals (a quiet count never pulls it off them), and both tabs
 * show their own count. Needs you (rows that can't log yet)
 * keeps its own count on its sub-tab: it is a different signal, not part of the sidebar's approvals. C10: when the
 * payload carries `toLog` (To log's one count: fix rows + sending failures), the To log part is that count, so the
 * sidebar never says 1 while the To log tab says 38.
 */
import type { TodayPayload } from '@/contract';

export interface TimeBadges {
  /** The sidebar's Time count: approvals waiting, else the VDPs that need you. */
  sidebar: number;
  /** Loud (approvals waiting), else quiet. */
  attn: boolean;
  /** Where the sidebar's Time link lands: the tab that holds the count. */
  href: string;
  /** The main tabs' counts (they sum to `sidebar`). */
  time: number;
  vdp: number;
  /** The sub-tabs' counts: Log it and Forecast sum to `time`; Changes is `vdp`. */
  log: number;
  forecast: number;
  changes: number;
}

type NavCounts = Pick<TodayPayload['navCounts'], 'adminWaiting' | 'vdpOpen'> & Partial<Pick<TodayPayload['navCounts'], 'adminBySurface' | 'waitingForCanvas' | 'toLog'>>;

export function timeBadges(n: NavCounts | null | undefined): TimeBadges {
  if (!n) return { sidebar: 0, attn: false, href: '/activity', time: 0, vdp: 0, log: 0, forecast: 0, changes: 0 };
  // an older payload without the split: every waiting item is a logging one
  const by = n.adminBySurface ?? { log: n.adminWaiting, forecast: 0, vdp: 0 };
  const waiting = by.log + by.forecast + by.vdp;
  // DCs and use cases waiting for a canvas live on Log it: a quiet count, like the VDPs that need you, so it shows while
  // no approval waits (a red number is approvals only: "3 waiting for approval" never counts them)
  const queued = waiting ? 0 : (n.waitingForCanvas?.dcs ?? 0) + (n.waitingForCanvas?.useCases ?? 0);
  // C10: To log's count is its tab's one count (fix rows + sending failures: src/engines/activity/to-log-count.ts),
  // so the sidebar and the tab say the same number; an older payload without it keeps the approvals count
  const log = n.toLog !== undefined ? n.toLog : by.log + queued;
  const time = log + by.forecast;
  const vdp = waiting ? by.vdp : (n.vdpOpen ?? 0);
  // the link lands where the approvals are while any wait (loud first); else on the larger quiet count
  const loudTime = by.log + by.forecast;
  const href = waiting
    ? by.vdp > loudTime
      ? '/activity?view=vdp'
      : by.forecast > by.log
        ? '/activity?view=forecast'
        : '/activity?view=week'
    : vdp > time
      ? '/activity?view=vdp'
      : time
        ? by.forecast > log
          ? '/activity?view=forecast'
          : '/activity?view=week'
        : '/activity';
  return { sidebar: time + vdp, attn: waiting > 0, href, time, vdp, log, forecast: by.forecast, changes: vdp };
}
