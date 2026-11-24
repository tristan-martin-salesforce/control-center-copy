import { describe, expect, it } from 'vitest';
import { buildTimeBlocks, humanHours, leverageHours } from '@/engines/activity/blocks';
import { classifyMeeting } from '@/engines/activity/classify';
import { isCF, isCR, isNeither, roundQuarter } from '@/engines/activity/taxonomy';
import { proposeActivity } from '@/engines/activity/propose';
import { zonedToMs, localDay, weekStart } from '@/engines/activity/time';
import type { EvidenceBundle } from '@/engines/activity/types';
import { CFG, MAPPINGS, NOW, cal, OPP_ACME } from '../fixtures/org62/activity';

const EMPTY: EvidenceBundle = { calendar: [], claude: [], drive: [], slack: [], git: [] };
// Mon 2026-11-02 in America/Denver is MST (UTC-7): 09:00 local = 16:00Z.
const Z = (hm: string) => `2026-11-02T${hm}:00Z`;

describe('rounding (D-40)', () => {
  it('rounds Duration__c to 0.25 h, half rounds up', () => {
    expect(roundQuarter(0.1)).toBe(0);
    expect(roundQuarter(0.125)).toBe(0.25);
    expect(roundQuarter(0.37)).toBe(0.25);
    expect(roundQuarter(0.38)).toBe(0.5);
    expect(roundQuarter(1)).toBe(1);
    expect(roundQuarter(1.12)).toBe(1);
    expect(roundQuarter(1.13)).toBe(1.25);
    expect(roundQuarter(2.9)).toBe(3);
  });
  it('keeps exact Start/End and flags a >5 min difference', () => {
    const plan = proposeActivity({
      now: NOW,
      cfg: CFG,
      mappings: MAPPINGS,
      evidence: { ...EMPTY, calendar: [cal({ id: 'a', summary: 'ACME discovery', startsAt: Z('16:00'), endsAt: Z('16:38'), attendeeDomains: ['acme.example'] })] },
    });
    const e = plan.entries[0]!;
    expect(e.startsAt).toBe(Z('16:00'));
    expect(e.endsAt).toBe(Z('16:38'));
    expect(e.durationHours).toBe(0.75); // 38 min -> 0.63 -> 0.75 (7 min off)
    expect(e.flags.some((f) => f.includes('differs from End-Start'))).toBe(true);
  });
});

describe('CF vs CR', () => {
  it('taxonomy flags', () => {
    expect(isCR('Solution Creation') && !isCF('Solution Creation')).toBe(true);
    expect(isCF('Customer Discovery') && isCR('Customer Discovery')).toBe(true);
    expect(isNeither('Asset Creation')).toBe(true);
    expect(isNeither('Admin')).toBe(true);
  });
  it('an external attendee forces CF and swaps the type', () => {
    const ev = cal({ id: 'a', summary: 'ACME design session', startsAt: Z('16:00'), endsAt: Z('17:00'), attendeeDomains: ['corp.example', 'acme.example'] });
    const d = classifyMeeting(ev, MAPPINGS, '2026-11-02');
    expect(d.cf).toBe(true);
    expect(d.extDomains).toEqual(['acme.example']);
    expect(d.seTaskType).toBe('Workshop'); // Solution Creation -> Workshop under CF swap
    expect(d.meetingType).toBe('Data Cloud Workshop');
    expect(d.flags.some((f) => f.startsWith('CF forced'))).toBe(true);
  });
  it('internal-only meetings never get a CF type', () => {
    const ev = cal({ id: 'a', summary: 'ACME demo walkthrough', startsAt: Z('16:00'), endsAt: Z('17:00') });
    const d = classifyMeeting(ev, MAPPINGS, '2026-11-02');
    expect(d.cf).toBe(false);
    expect(d.seTaskType).toBe('Dry Run'); // Customer Presentation -> Dry Run
  });
  it('partner and ignored domains are not external', () => {
    const ev = cal({ id: 'a', summary: 'ACME sync', startsAt: Z('16:00'), endsAt: Z('16:30'), attendeeDomains: ['partner.example', 'calendar.example', 'corp.example'] });
    expect(classifyMeeting(ev, MAPPINGS, '2026-11-02').cf).toBe(false);
  });
  it('Neither types are excluded and not loggable', () => {
    const plan = proposeActivity({
      now: NOW,
      cfg: CFG,
      mappings: MAPPINGS,
      evidence: { ...EMPTY, calendar: [cal({ id: 'a', summary: 'Team meeting weekly', startsAt: Z('16:00'), endsAt: Z('16:30') })] },
    });
    expect(plan.entries[0]).toMatchObject({ status: 'excluded', excludedReason: 'neither_type', seTaskType: 'Admin' });
  });
  it('declined invites and non-attended meetings are rejected, never counted', () => {
    const plan = proposeActivity({
      now: NOW,
      cfg: CFG,
      mappings: MAPPINGS,
      evidence: {
        ...EMPTY,
        calendar: [
          cal({ id: 'd', summary: 'ACME discovery', startsAt: Z('16:00'), endsAt: Z('17:00'), selfResponse: 'declined' }),
          cal({ id: 'n', summary: 'ACME workshop', startsAt: Z('18:00'), endsAt: Z('19:00'), attended: false }),
        ],
      },
    });
    expect(plan.entries).toHaveLength(0);
    expect(plan.rejected.map((r) => r.reason).sort()).toEqual(['not_accepted', 'not_attended']);
  });
});

describe('time helpers', () => {
  it('zoned conversion handles the DST switch', () => {
    expect(new Date(zonedToMs('2026-10-30', '09:00', 'America/Denver')).toISOString()).toBe('2026-10-30T15:00:00.000Z'); // MDT
    expect(new Date(zonedToMs('2026-11-02', '09:00', 'America/Denver')).toISOString()).toBe('2026-11-02T16:00:00.000Z'); // MST
    expect(localDay(Date.parse('2026-11-03T03:50:00Z'), 'America/Denver')).toBe('2026-11-02');
    expect(weekStart('2026-11-05')).toBe('2026-11-02');
  });
});

describe('overlap resolution (D-17, D-18)', () => {
  it('meetings win over engaged time; solo work counts once (no two counted blocks overlap)', () => {
    const blocks = buildTimeBlocks(
      {
        calendar: [cal({ id: 'm', summary: 'ACME call', startsAt: Z('16:00'), endsAt: Z('17:00') })],
        // prompts 16:30 (inside the meeting) and 17:30: separate stretches (60 min apart); the first is the meeting's
        claude: [{ sessionId: 's1', repoKey: 'Projects-acme-demo', promptTimes: [Z('16:30'), Z('17:30')] }],
        drive: [],
        slack: [],
        // two messages in a channel no account names, 10 and 20 min after the prompt: one stretch with it, 17:26–17:51
        slackMessages: [
          { id: 'C0OTHER|1', channelId: 'C0OTHER', at: Z('17:40') },
          { id: 'C0OTHER|2', channelId: 'C0OTHER', at: Z('17:50') },
        ],
        git: [],
      },
      MAPPINGS,
      CFG,
    );
    const counted = blocks.filter((b) => b.countsAsHumanHours);
    const sorted = [...counted].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.startsAt >= sorted[i - 1]!.endsAt).toBe(true);
    // Meeting 1 h; the 16:30 prompt's 5 minutes are the meeting's (an overlay); 17:26–17:51 = 25 min of solo work
    expect(humanHours(blocks)).toBeCloseTo(1 + 25 / 60, 5);
    const overlay = blocks.find((b) => b.source === 'claude_hands_on' && b.isOverlay);
    expect(overlay).toMatchObject({ countsAsHumanHours: false });
    // the messages name no account: they ride with the prompt's work (ACME's repo), they claim no time of their own
    const solo = counted.filter((b) => b.source !== 'calendar');
    expect(solo).toHaveLength(1);
    expect(solo[0]).toMatchObject({ source: 'claude_hands_on', accountKey: 'acme', startsAt: '2026-11-02T17:26:00Z', endsAt: '2026-11-02T17:51:00Z' });
    expect(solo[0]!.evidenceIds).toEqual(['C0OTHER|1', 'C0OTHER|2', 's1']);
  });

  it('parallel Claude sessions are unioned, not summed', () => {
    const blocks = buildTimeBlocks(
      {
        ...EMPTY,
        claude: [
          { sessionId: 's1', repoKey: 'Projects-acme-demo', promptTimes: [Z('18:00')] },
          { sessionId: 's2', repoKey: 'Projects-globex-poc', promptTimes: [Z('18:00')] },
        ],
      },
      MAPPINGS,
      CFG,
    );
    expect(humanHours(blocks)).toBeCloseTo(5 / 60, 5); // one 5-minute window (4 before, 1 after), not two
  });

  it('agent time is leverage; only a quarter of the run after the last prompt counts, at most 15 min (D-17)', () => {
    const blocks = buildTimeBlocks(
      {
        ...EMPTY,
        claude: [
          {
            sessionId: 's1',
            repoKey: 'Projects-acme-demo',
            // the turn after the 18:00 prompt runs 40 min: (18:40 − 18:01) / 4 ≈ 9.75 min of it counts
            turns: [{ at: Z('18:00'), runEndsAt: Z('18:40') }],
            backgroundSegments: [{ startsAt: Z('18:10'), endsAt: Z('20:10') }],
          },
        ],
      },
      MAPPINGS,
      CFG,
    );
    expect(humanHours(blocks)).toBeCloseTo((5 + 39 / 4) / 60, 3);
    expect(leverageHours(blocks)).toBeCloseTo(2, 5);
    expect(blocks.filter((b) => b.attention === 'background').every((b) => !b.countsAsHumanHours)).toBe(true);
    // a 3 h run still counts at most 15 min of it
    const long = buildTimeBlocks({ ...EMPTY, claude: [{ sessionId: 's1', repoKey: 'Projects-acme-demo', turns: [{ at: Z('18:00'), runEndsAt: Z('21:00') }] }] }, MAPPINGS, CFG);
    expect(humanHours(long)).toBeCloseTo((5 + 15) / 60, 5);
  });

  it('count once (the original D-18): double-booked meetings are counted once; the lower-ranked one becomes an excluded overlap', () => {
    const plan = proposeActivity({
      now: NOW,
      cfg: { ...CFG, overlaps: 'count_once' },
      mappings: MAPPINGS,
      evidence: {
        ...EMPTY,
        calendar: [
          cal({ id: 'cf', summary: 'ACME workshop', startsAt: Z('16:00'), endsAt: Z('17:00'), attendeeDomains: ['acme.example'] }),
          cal({ id: 'int', summary: 'Globex planning', startsAt: Z('16:30'), endsAt: Z('17:30') }),
        ],
      },
    });
    const by = Object.fromEntries(plan.entries.map((e) => [e.dedupeKey.split('|')[1], e]));
    expect(by.cf!.status).not.toBe('excluded');
    expect(by.int).toMatchObject({ status: 'excluded', excludedReason: 'overlap' });
  });

  it('Drive edits are own actions: 10 min before each edit, edits within 15 min one stretch (no per-doc guess)', () => {
    // nine docs saved at the same minute: one 10-minute stretch, not 2 h
    const same = Array.from({ length: 9 }, (_, i) => ({ fileId: `f${i}`, title: `ACME doc ${i}`, editedAt: '2026-11-02T22:00:00Z' }));
    expect(humanHours(buildTimeBlocks({ ...EMPTY, drive: same }, MAPPINGS, CFG))).toBeCloseTo(10 / 60, 5);
    // edits every 10 min from 22:00 to 23:00: one stretch 21:50–23:00
    const run = Array.from({ length: 7 }, (_, i) => ({ fileId: 'f1', title: 'ACME plan', editedAt: new Date(Date.parse('2026-11-02T22:00:00Z') + i * 600_000).toISOString() }));
    expect(humanHours(buildTimeBlocks({ ...EMPTY, drive: run }, MAPPINGS, CFG))).toBeCloseTo(70 / 60, 5);
  });
});

describe('off-calendar evidence entries', () => {
  it('maps repo -> account -> opp, estimates hours and marks them a guess', () => {
    const plan = proposeActivity({
      now: NOW,
      cfg: CFG,
      mappings: MAPPINGS,
      evidence: { ...EMPTY, claude: [{ sessionId: 's1', repoKey: 'Projects-acme-demo', promptTimes: Array.from({ length: 10 }, (_, k) => `2026-11-02T18:${String(6 * k).padStart(2, '0')}:00Z`) }] },
    });
    const e = plan.entries[0]!;
    expect(e).toMatchObject({ origin: 'evidence', whatOrg62Id: OPP_ACME, seTaskType: 'Solution Creation', confidence: 'Low' });
    // prompts every 6 min, 18:00–18:54: one stretch 17:56..18:55 = 59 min -> 1 h
    expect(e.durationHours).toBe(1);
    expect(e.flags[0]).toMatch(/^GUESS/);
    expect(e.evidence).toMatch(/^engaged 1 h \(10 prompts; claude_hands_on\)/);
  });
  it('demo-org/tooling repos are Neither: excluded, no WhatId', () => {
    const plan = proposeActivity({
      now: NOW,
      cfg: CFG,
      mappings: MAPPINGS,
      evidence: { ...EMPTY, claude: [{ sessionId: 's1', repoKey: 'Projects-demo-org', promptTimes: [Z('18:00'), Z('18:30')] }] },
    });
    expect(plan.entries[0]).toMatchObject({ status: 'excluded', excludedReason: 'neither_type', seTaskType: 'Asset Creation', whatOrg62Id: null, whatKind: 'none' });
  });
  it('unmapped evidence needs input', () => {
    const plan = proposeActivity({
      now: NOW,
      cfg: CFG,
      mappings: MAPPINGS,
      evidence: { ...EMPTY, drive: [{ fileId: 'f1', title: 'Some random doc', editedAt: '2026-11-02T22:00:00Z' }] },
    });
    expect(plan.entries[0]).toMatchObject({ status: 'needs_input', whatOrg62Id: null });
  });
  it('commits are own actions: 10 min before each, 2 after; a gap over 15 min ends the stretch', () => {
    const plan = proposeActivity({
      now: NOW,
      cfg: CFG,
      mappings: MAPPINGS,
      evidence: { ...EMPTY, git: ['18:00', '18:10', '18:50'].map((t, i) => ({ sha: `abc${i}`, repoKey: 'Projects-globex-poc', at: Z(t) })) },
    });
    // 17:50–18:12 (22 min) and 18:40–18:52 (12 min) = 34 min -> 0.5 h
    expect(plan.entries[0]).toMatchObject({ durationHours: 0.5, accountKey: 'globex' });
    expect(plan.entries[0]!.evidenceIds.sort()).toEqual(['abc0', 'abc1', 'abc2']);
  });
});
