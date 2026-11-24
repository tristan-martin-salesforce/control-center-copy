/**
 * DESIGN-V2 "Capacity and estimates" (binding): only today-scoped, hands-on minutes count; agent time is a
 * parallel background lane; "overbooked" only when it is true. Placeholder names; Thu 2026-11-05, UTC,
 * working hours 09:00–18:00.
 */
import { describe, expect, it } from 'vitest';
import { rankWork } from '@/engines/priority/rank';
import type { CapacityChore, PriorityInputs } from '@/engines/priority/types';
import type { PriorityItem } from '@/engines/types';
import { at, inputs, item, meeting } from './fixtures';

const FRI = '2026-11-06';
const SAT = '2026-11-07';

const meetings = [
  meeting('m-prep', at('09:00'), at('09:30'), { title: 'ACME prep call', myResponse: 'accepted' }),
  meeting('m-declined', at('10:00'), at('11:00'), { title: 'Tableau tips', myResponse: 'declined' }),
  meeting('m-tentative', at('11:00'), at('11:30'), { title: 'Maybe sync', myResponse: 'tentative' }),
  meeting('m-unanswered', at('11:30'), at('12:00'), { title: 'Optional office hours', myResponse: 'needs_action' }),
  meeting('m-cancelled', at('12:00'), at('13:00'), { title: 'Cancelled', status: 'cancelled' }),
  meeting('m-review', at('14:00'), at('15:00'), { title: 'ACME review', hasExternalAttendees: true, myResponse: 'accepted' }),
];

const day: PriorityItem[] = [
  item('smoke', { title: 'Smoke-test both ACME demos', due: at('13:30'), servesEventId: 'm-review', effort: { youMin: 20, agentMin: 20 }, stakeholders: [{ name: 'Dana', isExternal: true }] }),
  item('post', { title: 'Post a short status to the Globex sizing thread', kind: 'commitment', due: at('17:00'), effort: { youMin: 50, agentMin: 0 } }),
  item('dana', { title: 'Answer Dana: same demo or a new use case?', kind: 'ask', due: at('14:30'), effort: { youMin: 5, agentMin: 0 } }),
  item('sam', { title: 'Reply to Sam about the workshop', kind: 'ask', due: at('16:00'), effort: { youMin: 0, agentMin: 0 } }),
  item('log', { title: 'Confirm 21 rows for the Q4 log', due: at('12:00', FRI), effort: { youMin: 30, agentMin: 10 } }),
  item('mia', { title: 'Reply to Mia on the DSC review', kind: 'ask', due: at('17:00', FRI), effort: { youMin: 15, agentMin: 10 } }),
  item('badges', { title: '5 Trailhead maintenance badges', kind: 'training', effort: { youMin: 150, agentMin: 0 }, training: { mandatory: true, requiredBy: at('17:00', '2026-12-04') } }),
  item('overdue', { title: 'Report doc gaps from the workshop setup', due: at('17:00', '2026-11-03'), effort: { youMin: 45, agentMin: 0 } }),
  // a 25 h data load due Saturday morning: your 30 m must start today for the agent to finish in time
  item('load', { title: 'Kick off the Globex history load', due: at('10:00', SAT), effort: { youMin: 30, agentMin: 1500 } }),
  item('maybe-done', { title: 'Send the recap', due: at('12:00'), status: 'likely_done', effort: { youMin: 10, agentMin: 0 } }),
  item('pinned', { title: 'Start the Initech POV', due: at('17:00', '2026-11-12'), effort: { youMin: 15, agentMin: 0 } }),
];

const chores: CapacityChore[] = [
  { id: 'dr-1', kind: 'approve', title: 'Approve draft', workItemId: 'mia' },
  { id: 'dr-2', kind: 'approve', title: 'Approve draft', workItemId: null },
  { id: 'dr-3', kind: 'approve', title: 'Approve draft', workItemId: 'dana' }, // part of answering Dana: not counted twice
  { id: 'reauth:vdp', kind: 'reauth', title: 'Re-auth VDP' },
];

const base = (over: Partial<PriorityInputs> = {}): PriorityInputs =>
  inputs({ items: day, meetings, pinnedToday: ['pinned'], chores, runningAgents: [{ id: 'run-bg', workItemId: 'mia', agentMinLeft: 45 }], ...over });

describe('capacity: today-scoped, hands-on only', () => {
  const r = rankWork(base());
  const c = r.capacity;

  it('takes free time from accepted meetings and working hours only', () => {
    // 09:30–14:00 and 15:00–18:00: declined, tentative, unanswered and cancelled events don't block
    expect(r.gaps).toEqual([
      { start: at('09:30'), end: at('14:00'), minutes: 270 },
      { start: at('15:00'), end: at('18:00'), minutes: 180 },
    ]);
    expect(c.freeMin).toBe(450);
  });

  it('counts due today, start-by today for later work, and pinned items; nothing else', () => {
    expect([...c.todayItemIds].sort()).toEqual(['dana', 'load', 'pinned', 'post', 'sam', 'smoke']);
    expect(c.todayItemIds).not.toContain('log'); // due tomorrow 12:00: tomorrow's load
    expect(c.todayItemIds).not.toContain('mia');
    expect(c.todayItemIds).not.toContain('overdue'); // overdue from an earlier day: a pull-forward, not scheduled load
    expect(c.todayItemIds).not.toContain('maybe-done');
    expect(r.scores.load!.startBy).toBe(at('17:30')); // the agent needs 25 h: your part starts today
  });

  it('uses hands-on minutes only, with the default for an item that has no estimate', () => {
    expect(r.scores.sam!.effort.youMin).toBe(10); // reply: 5–15
    expect(r.scores.sam!.effortSource).toBe('default');
    expect(r.scores.smoke!.effortSource).toBe('item');
    // approvals batch: 2 drafts (Dana's is part of answering Dana) = 3 + 1; re-auth 2
    expect(c.chores.map((x) => [x.id, x.title, x.youMin, x.count])).toEqual([
      ['chore:approve', 'Approve 2 drafts', 4, 2],
      ['reauth:vdp', 'Re-auth VDP', 2, 1],
    ]);
    expect(c.youMinToday).toBe(20 + 50 + 5 + 10 + 30 + 15 + 4 + 2);
    expect(c).toMatchObject({ freeMin: 450, openMin: 450 - 136, fits: true, focusMinLeft: 450, plannedMin: 136, overByMin: 136 - 450 });
  });

  it('reports agent time as a parallel background lane that never counts', () => {
    // today's kick-offs (smoke 20, load 1500) plus the run already in flight (45)
    expect(c.agentRunsBackground).toBe(3);
    expect(c.agentMinBackground).toBe(20 + 1500 + 45);
    expect(c.agentMinQueued).toBe(1520);
    const noAgents = rankWork(base({ runningAgents: [], items: day.map((i) => (i.id === 'load' ? i : { ...i, effort: { ...i.effort, agentMin: 0 } })) }));
    expect(noAgents.capacity.youMinToday).toBe(c.youMinToday);
    expect(noAgents.capacity.fits).toBe(c.fits);
  });

  it('offers up to 5 not-today items to pull forward, in rank order', () => {
    const ids = c.pullForward.map((p) => p.itemId);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(5);
    expect(ids).toContain('log');
    for (const id of ids) expect(c.todayItemIds).not.toContain(id);
    const ranks = ids.map((id) => r.scores[id]!.rank!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(c.pullForward.find((p) => p.itemId === 'log')).toEqual({ itemId: 'log', title: 'Confirm 21 rows for the Q4 log', youMin: 30, due: at('12:00', FRI) });
  });

  it('plans today’s load (and the chores) into the gaps; fit-ins are never load', () => {
    const work = r.spine.filter((s) => s.kind === 'work' || s.kind === 'focus');
    const planned = new Set(work.map((s) => s.workItemId).filter(Boolean));
    for (const id of planned) expect(c.todayItemIds).toContain(id);
    expect(work.some((s) => s.workItemId === null && s.label.endsWith('Approve 2 drafts'))).toBe(true);
    for (const f of r.fitIns) expect(c.todayItemIds).not.toContain(f.workItemId);
    const step = r.planSteps.find((s) => s.workItemId === 'smoke')!;
    expect(step.mode).toBe('kickoff_background');
  });

  it('says overbooked only when today’s hands-on minutes exceed the free minutes', () => {
    const heavy = [...day, ...['a', 'b', 'c'].map((k) => item(`heavy-${k}`, { title: `Rebuild deck ${k}`, due: at('17:30'), effort: { youMin: 120, agentMin: 0 } }))];
    const h = rankWork(base({ items: heavy })).capacity;
    expect(h.youMinToday).toBe(136 + 360);
    expect(h.fits).toBe(false);
    expect(h.overByMin).toBe(h.youMinToday - 450);
    expect(h.openMin).toBe(-h.overByMin);
    expect(h.pullForward).toEqual([]);
    // exactly full still fits (3 approvals = 5, re-auth 2)
    const exact = rankWork(base({ items: [item('x', { due: at('17:00'), effort: { youMin: 450 - 7, agentMin: 0 } })], pinnedToday: [] })).capacity;
    expect(exact.youMinToday).toBe(450);
    expect(exact.fits).toBe(true);
    expect(exact.pullForward).toEqual([]);
  });

  it('Tristan’s bug: due Friday is not today, and agent time doesn’t overbook the day', () => {
    // Before the fix: every open item and the agent's hours counted, so the day read "10 h overbooked".
    const r2 = rankWork(inputs({ items: day, meetings }));
    expect(r2.capacity.todayItemIds).not.toContain('log');
    expect(r2.capacity.fits).toBe(true);
    const everything = day.reduce((s, i) => s + i.effort.youMin + i.effort.agentMin, 0);
    expect(everything).toBeGreaterThan(r2.capacity.freeMin + 600);
    expect(r2.capacity.youMinToday).toBeLessThan(r2.capacity.freeMin);
  });

  it('a pinned item and a start-by in the user’s timezone follow the local day', () => {
    // 23:30Z on Thu is 15:30 PT; an item due 07:00Z Fri is 23:00 PT Thu: due today in PT.
    const pt = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], utcOffsetMinutes: -480 };
    const late = item('late', { title: 'Reply to Dana', kind: 'ask', due: at('07:00', FRI), effort: { youMin: 5, agentMin: 0 } });
    const pr = rankWork(inputs({ now: at('23:30'), workingHours: pt, items: [late] }));
    expect(pr.capacity.todayItemIds).toEqual(['late']);
    const utc = rankWork(inputs({ now: at('15:30'), items: [late] }));
    // in UTC it is due tomorrow 07:00, before tomorrow's working hours start: its start-by is today, so it is
    // today's load (PRIO-3, lane 07: work that must start today counts today, whenever it is due)
    expect(utc.capacity.todayItemIds).toEqual(['late']);
    expect(utc.scores.late!.startByLabel).toBe('17:55'); // the last 5 minutes of today's 09:00–18:00
  });
});

describe('MIN-22: after working hours the capacity counts the next working day', () => {
  it('Thursday 22:42: tomorrow\'s load against tomorrow\'s free time, never "over" for a day that is done', () => {
    const c = rankWork(base({ now: at('22:42') })).capacity;
    expect(c.day).toBe('next');
    expect(c.dayLabel).toBe('tomorrow');
    expect(c.freeMin).toBe(540); // Friday 09:00–18:00, no meetings
    // due Friday (log, mia), pinned, the badges' start-by (now Friday), and the Saturday load whose start-by has
    // passed (PRIO-3: must start by then, so it is that day's load); Thursday's unfinished work is overdue from an
    // earlier day, so it is a pull-forward, not load
    expect([...c.todayItemIds].sort()).toEqual(['badges', 'load', 'log', 'mia', 'pinned']);
    expect(c.todayItemIds).not.toContain('post');
    // the approval for Mia's draft is part of answering Mia; the other two still wait, and so does the re-auth
    expect(c.chores.map((x) => [x.id, x.count])).toEqual([
      ['chore:approve', 2],
      ['reauth:vdp', 1],
    ]);
    expect(c.youMinToday).toBe(30 + 15 + 15 + 150 + 30 + 4 + 2);
    expect(c.fits).toBe(true);
    expect(c.openMin).toBe(540 - c.youMinToday);
  });

  it('Friday evening counts Monday', () => {
    const c = rankWork(base({ now: at('19:00', FRI) })).capacity;
    expect(c).toMatchObject({ day: 'next', dayLabel: 'Monday', freeMin: 540, fits: true });
  });

  it('before and during working hours it is today, as before', () => {
    expect(rankWork(base({ now: at('07:00') })).capacity).toMatchObject({ day: 'today', dayLabel: 'today' });
    expect(rankWork(base()).capacity).toMatchObject({ day: 'today', dayLabel: 'today', freeMin: 450 });
  });

  it('a busy meeting tomorrow takes from tomorrow\'s free time', () => {
    const c = rankWork(base({ now: at('20:00'), meetings: [...meetings, meeting('m-fri', at('10:00', FRI), at('12:00', FRI), { myResponse: 'accepted' })] })).capacity;
    expect(c.freeMin).toBe(540 - 120);
  });
});
