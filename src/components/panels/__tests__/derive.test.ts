import { describe, expect, it } from 'vitest';
import type { AgentRun, CalendarEvent, Connector, Job, ScanRun, WorkItem } from '@/contract';
import { agentsLayout, focalRunId, needLine, runNeed, runVerb, summaryParts } from '@/components/agents/needs';
import { calmLine, healthTier, needsYou } from '@/components/health/derive';
import { answersLine, connectorLine, connectorPrimary, coverage, eventPhase, eventPrimary, eventWhen, guestSummary, ledgerHref, prepChecks, scanJobs } from '../derive';

const NOW = '2026-11-05T15:00:00.000Z'; // 08:00 in America/Denver
const TZ = 'America/Denver';

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ev1',
    title: 'ACME review',
    start: '2026-11-05T20:30:00.000Z',
    end: '2026-11-05T21:30:00.000Z',
    attendance: 'upcoming',
    isCustomerFacing: true,
    accountId: null,
    oppId: null,
    attendees: [],
    location: null,
    meetingUrl: 'https://meet.example.com/abc',
    agenda: null,
    organizer: null,
    attachments: [],
    prep: { ready: false, label: 'smoke-test demos ›', workItemId: 'w1' },
    takeaways: null,
    source: { kind: 'calendar', label: 'Calendar · ACME review', url: 'https://calendar.example.com/e/1' },
    ...over,
  };
}

const item = (id: string, state: WorkItem['state'], servesEventId: string | null = null) => ({ id, title: `Task ${id}`, state, servesEventId });

function run(over: Partial<AgentRun>): AgentRun {
  return {
    id: 'r1',
    kind: 'claude_session',
    title: 'Run',
    workItemId: null,
    state: 'running',
    startedAt: '2026-11-05T14:00:00.000Z',
    updatedAt: '2026-11-05T14:30:00.000Z',
    finishedAt: null,
    lastEvent: 'Working',
    waiting: null,
    deepLink: 'claude://code/continue?session=local_1',
    sessionId: 'local_1',
    cwd: null,
    bgAgents: 0,
    toolRunId: null,
    progress: null,
    resultUrl: null,
    error: null,
    costUsd: null,
    scheduled: false,
    ...over,
  };
}

describe('meeting brief', () => {
  it('phases and the when line', () => {
    expect(eventPhase(ev(), NOW)).toBe('later');
    expect(eventPhase(ev({ start: '2026-11-05T15:05:00.000Z' }), NOW)).toBe('soon');
    expect(eventPhase(ev({ attendance: 'in_progress' }), NOW)).toBe('now');
    expect(eventPhase(ev({ start: '2026-11-05T13:00:00.000Z', end: '2026-11-05T14:00:00.000Z' }), NOW)).toBe('past');
    expect(eventPhase(ev({ attendance: 'declined' }), NOW)).toBe('off');
    expect(eventWhen(ev(), NOW, TZ)).toBe('Today 13:30–14:30 · in 5h 30m');
    expect(eventWhen(ev({ attendance: 'in_progress', start: '2026-11-05T14:30:00.000Z', end: '2026-11-05T15:45:00.000Z' }), NOW, TZ)).toBe('Now, until 08:45 · 45m left');
  });

  it('prep checks: the prep item first, then every item that serves the meeting; done counts as ready', () => {
    const items = [item('w1', 'open'), item('w2', 'done', 'ev1'), item('w3', 'open', 'other')];
    const checks = prepChecks(ev(), items, () => 20);
    expect(checks.map((c) => [c.id, c.ready, c.youMin])).toEqual([
      ['w1', false, 20],
      ['w2', true, 0],
    ]);
    expect(prepChecks(ev({ prep: null }), [], () => 5)).toEqual([]);
  });

  it('the ONE action: join when on, else start prep, else takeaways, else the calendar', () => {
    const checks = prepChecks(ev(), [item('w1', 'open')], () => 20);
    expect(eventPrimary(ev(), checks, NOW)).toMatchObject({ kind: 'prep', itemId: 'w1' });
    expect(eventPrimary(ev({ attendance: 'in_progress' }), checks, NOW)).toMatchObject({ kind: 'join', url: 'https://meet.example.com/abc' });
    const ready = prepChecks(ev(), [item('w1', 'done')], () => 20);
    expect(eventPrimary(ev(), ready, NOW)).toMatchObject({ kind: 'join' });
    expect(eventPrimary(ev({ meetingUrl: null }), ready, NOW)).toMatchObject({ kind: 'calendar' });
    const missed = ev({ attendance: 'missed', start: '2026-11-05T13:00:00.000Z', end: '2026-11-05T14:00:00.000Z', takeaways: { count: 2, workItemIds: ['t1', 't2'], notesUrl: null } });
    expect(eventPrimary(missed, ready, NOW)).toMatchObject({ kind: 'takeaways', label: 'Review 2 takeaways', itemId: 't1' });
  });

  it("the guests' answers: the ones that happened, in words; none known says nothing", () => {
    const g = (id: string, response?: 'accepted' | 'tentative' | 'declined' | 'needs_action') => ({ id, name: id, ...(response ? { response } : {}) });
    const s = guestSummary(ev({ attendees: [g('a', 'accepted'), g('b', 'accepted'), g('c', 'declined'), g('d', 'needs_action'), g('e', 'tentative'), g('f')] }));
    expect(s.answers).toEqual({ accepted: 2, tentative: 1, declined: 1, noAnswer: 1 });
    expect(answersLine(s.answers)).toBe('2 accepted · 1 maybe · 1 declined · 1 no answer');
    expect(answersLine({ accepted: 3, tentative: 0, declined: 0, noAnswer: 0 })).toBe('3 accepted');
    expect(answersLine(guestSummary(ev({ attendees: [g('a'), g('b')] })).answers)).toBeNull();
  });
});

describe('connector', () => {
  const conn = (over: Partial<Connector>): Connector => ({
    id: 'vdp',
    label: 'VDP',
    source: 'vdp',
    state: 'ok',
    since: '2026-10-26T16:00:00.000Z',
    lastSuccessAt: '2026-10-26T16:00:00.000Z',
    cursor: { label: 'VDP through 10-26', at: null },
    backlog: 0,
    itemsToday: 0,
    catchUpPct: null,
    lastError: null,
    impact: null,
    reauth: { kind: 'refresh_script', label: 'Refresh VDP', command: '~/refresh.py', instructions: 'Approve MFA' },
    affects: [],
    ...over,
  });

  it('re-auth is the action only when broken and startable; otherwise Rescan', () => {
    expect(connectorPrimary(conn({ state: 'auth_needed' }))).toEqual({ kind: 'reauth', label: 'Refresh VDP' });
    expect(connectorPrimary(conn({ state: 'auth_needed', reauth: { kind: 'refresh_script', label: '', command: '~/refresh.py', instructions: null } }))).toEqual({ kind: 'reauth', label: 'Run refresh' });
    expect(connectorPrimary(conn({ state: 'error', reauth: { kind: 'terminal_command', label: 'Re-auth Slack', command: 'claude mcp login slack', instructions: null } }))).toEqual({ kind: 'reauth', label: 'Open Terminal' });
    expect(connectorPrimary(conn({ state: 'auth_needed', reauth: { kind: 'instructions', label: 'Ask IT', command: null, instructions: 'Ask IT' } }))).toEqual({ kind: 'rescan', label: 'Rescan' });
    expect(connectorPrimary(conn({ state: 'ok' }))).toEqual({ kind: 'rescan', label: 'Rescan' });
  });

  it('the state line', () => {
    expect(connectorLine(conn({ state: 'auth_needed' }), NOW, TZ)).toBe('Needs re-auth since Mon 26 Oct');
    expect(connectorLine(conn({ state: 'ok', cursor: { label: 'Slack through 08:21', at: null }, itemsToday: 46 }), NOW, TZ)).toBe('Slack through 08:21 · 46 items today');
  });

  it('coverage per scope (latest run wins, keeps the last good window) and the scan job', () => {
    const scan = (id: string, scope: string, status: ScanRun['status'], startedAt: string, error: string | null = null): ScanRun => ({ id, connectorId: 'vdp', scope, kind: 'poll', windowStart: startedAt, windowEnd: startedAt, status, startedAt, endedAt: startedAt, itemsSeen: 1, itemsNew: 0, itemsChanged: 0, costUsd: 0, model: null, error });
    const rows = coverage([scan('a', 'my VDPs', 'ok', '2026-11-04T10:00:00.000Z'), scan('b', 'my VDPs', 'auth_failed', '2026-11-05T10:00:00.000Z', 'VDP needs re-auth'), scan('c', 'other', 'ok', '2026-11-05T09:00:00.000Z')], 'vdp');
    expect(rows.map((r) => [r.scope, r.through, r.gap])).toEqual([
      ['my VDPs', '2026-11-04T10:00:00.000Z', 'VDP needs re-auth'],
      ['other', '2026-11-05T09:00:00.000Z', null],
    ]);
    const job = (id: string, type: string, status: Job['status']): Job => ({ id, type, status, attempts: 3, maxAttempts: 3, runAt: '2026-11-05T10:00:00.000Z', startedAt: null, finishedAt: null, dedupeKey: null, generation: null, entity: null, error: 'bad_payload' });
    expect(scanJobs([job('1', 'scan.slack', 'succeeded'), job('2', 'scan.vdp', 'dead')], { id: 'vdp', source: 'vdp' }).map((j) => j.id)).toEqual(['2']);
    // db mode: connector ids are uuids, jobs are still typed by source
    expect(scanJobs([job('1', 'scan.slack', 'succeeded'), job('2', 'scan.vdp', 'dead')], { id: '7d1c0f6e-0000-4000-8000-000000000001', source: 'vdp' }).map((j) => j.id)).toEqual(['2']);
  });
});

describe('agents', () => {
  it('hands-on minutes and verbs by state; running runs are background only', () => {
    expect(runNeed(run({ state: 'waiting_on_you' }))).toEqual({ youMin: 3, purpose: 'to answer' });
    expect(runNeed(run({ state: 'done_review' }))).toEqual({ youMin: 15, purpose: 'to review' });
    expect(runNeed(run({ state: 'running' })).youMin).toBe(0);
    expect(needLine(run({ state: 'running' }))).toEqual({ text: '✦ in the background', ai: true });
    expect(runVerb(run({ state: 'running' }))?.key).toBe('open_in_claude');
    expect(runVerb(run({ kind: 'app_run', state: 'waiting_on_you' }))?.key).toBe('answer');
    expect(runVerb(run({ kind: 'tool_run', state: 'failed', toolRunId: 't1' }))?.key).toBe('retry');
    expect(runVerb(run({ kind: 'app_run', state: 'queued' }))?.key).toBe('cancel');
    expect(runVerb(run({ state: 'queued', deepLink: 'claude://code/new?folder=%2Ftmp&q=hi' }))?.key).toBe('start_in_claude');
  });

  it('three verb sections in focus order, empty ones dropped; the focal row is the longest wait', () => {
    const runs = [
      run({ id: 'a', state: 'running' }),
      run({ id: 'b', state: 'waiting_on_you', waiting: { reason: 'q', question: 'Which org?', choices: [], since: '2026-11-05T14:10:00.000Z' } }),
      run({ id: 'c', state: 'done_review' }),
      run({ id: 'd', state: 'done' }),
      run({ id: 'e', state: 'running', scheduled: true }),
    ];
    const l = agentsLayout(runs);
    expect(l.sections.map((s) => [s.key, s.runs.map((r) => r.id)])).toEqual([
      ['running', ['b', 'a']],
      ['review', ['c']],
    ]);
    expect(l.done.map((r) => r.id)).toEqual(['d']);
    expect(l.scheduled.map((r) => r.id)).toEqual(['e']);
    expect(l.youMin).toBe(18);
    expect(focalRunId(l)).toBe('b');
    expect(summaryParts(l)).toEqual({ you: '18m', parts: ['answer 1', 'review 1'], background: '1 run in the background' });
  });
});

describe('health', () => {
  it('the calm line, what needs you, and the pane tiers', () => {
    expect(calmLine({ summary: { ok: 7, total: 8, worst: 'auth_needed', broken: [] }, dryRun: true })).toEqual({ text: '7/8 sources live · dry run', allLive: false });
    expect(calmLine({ summary: { ok: 8, total: 8, worst: 'ok', broken: [] }, dryRun: false })).toEqual({ text: '8/8 sources live · live send', allLive: true });
    const c = (id: string, state: Connector['state']) => ({ id, state }) as Connector;
    expect(needsYou([c('a', 'ok'), c('b', 'degraded'), c('c', 'auth_needed')]).map((x) => x.id)).toEqual(['c', 'b']);
    expect([800, 1200, 1700, 2300].map(healthTier)).toEqual(['stack', 'two', 'three', 'four']);
  });
});

describe('connector panel links (B-073b)', () => {
  it('"Scan ledger" keeps the open connector panel in the URL', () => {
    const u = new URL(ledgerHref('vdp'), 'http://localhost');
    expect(u.pathname).toBe('/health');
    expect(Object.fromEntries(u.searchParams)).toEqual({ tab: 'ledger', connector: 'vdp', panel: 'details', item: 'vdp', kind: 'connector' });
    expect(new URL(ledgerHref('a b&c'), 'http://localhost').searchParams.get('item')).toBe('a b&c');
  });
});
