/**
 * D-18 amended (2026-11-11), the default for every persona and new user (`ActivityConfig.overlaps`, Settings ▸ Time ▸
 * Overlapping meetings): an accepted meeting always logs, overlapping accepted meetings both log (flagged), an onsite
 * day logs in full with the meetings during it, a row that will not log never makes another lose, and estimates still
 * yield. No hour caps (2026-11-14). `count_once` keeps the original.
 * Placeholder data only (ACME, Globex, example domains).
 */
import { describe, expect, it } from 'vitest';

import { OVERLAP_INFO_RE } from '@/engines/activity/overlap-flags';
import { proposeActivity } from '@/engines/activity/propose';
import type { ActivityConfig, EvidenceBundle } from '@/engines/activity/types';
import { CFG, MAPPINGS, OPP_ACME, OPP_GLOBEX, cal } from '../fixtures/org62/activity';

const EMPTY: EvidenceBundle = { calendar: [], claude: [], drive: [], slack: [], git: [] };
const NOW = '2026-11-11T18:00:00Z';
const DAY = '2026-11-10';
/** Tue 2026-11-10, America/Denver (MST, UTC-7) wall clock → ISO. */
const mt = (hm: string, day = DAY) => new Date(Date.parse(`${day}T${hm}:00-07:00`)).toISOString().replace('.000', '');
const ONCE: ActivityConfig = { ...CFG, overlaps: 'count_once' };
const plan = (calendar: EvidenceBundle['calendar'], extra: Partial<Parameters<typeof proposeActivity>[0]> = {}) =>
  proposeActivity({ now: NOW, cfg: CFG, mappings: MAPPINGS, evidence: { ...EMPTY, calendar }, ...extra });
const byId = (p: ReturnType<typeof plan>) => Object.fromEntries(p.entries.map((e) => [e.dedupeKey.split('|')[1], e]));
const live = (p: ReturnType<typeof plan>) => p.entries.filter((e) => !['excluded', 'dismissed', 'dropped'].includes(e.status));

// The 11/10 shape: a 7 h onboarding block (Admin: Neither CF nor CR, so it never logs) and a 30-minute call inside it.
const onboarding = () => cal({ id: 'onb', summary: 'New hire onboarding', startsAt: mt('09:00'), endsAt: mt('16:00') });
const call = () => cal({ id: 'call', summary: 'Globex planning', startsAt: mt('12:30'), endsAt: mt('13:00') });

describe('(a) an accepted meeting inside a block that never logs', () => {
  it('logs: the Admin block is excluded for itself and never takes the call’s time', () => {
    const p = plan([onboarding(), call()]);
    const by = byId(p);
    expect(by.onb).toMatchObject({ status: 'excluded', excludedReason: 'neither_type', seTaskType: 'Admin' });
    expect(by.call).toMatchObject({ status: 'proposed', excludedReason: null, durationHours: 0.5, whatOrg62Id: OPP_GLOBEX });
    expect(by.call!.flags.some((f) => /double-booked|overlaps/.test(f))).toBe(false);
    // the call is counted on the wall clock; the Admin block fills only what is left around it
    const callBlock = p.blocks.find((b) => b.dedupeKey === `cal|call|${mt('12:30')}`)!;
    expect(callBlock).toMatchObject({ countsAsHumanHours: true, isOverlay: false });
    expect(p.blocks.filter((b) => b.dedupeKey.startsWith('cal|onb|') && b.isOverlay).map((b) => [b.startsAt, b.endsAt])).toEqual([[mt('12:30'), mt('13:00')]]);
  });

  it('also when the user dismissed the block (notLogging), and in count_once (rule 3 holds in both modes)', () => {
    const dismissedMeeting = cal({ id: 'onb', summary: 'ACME onboarding workshop', startsAt: mt('09:00'), endsAt: mt('16:00'), attendeeDomains: ['acme.example'] });
    const userDismissed = [`cal|onb|${mt('09:00')}`];
    for (const cfg of [CFG, ONCE]) {
      const by = byId(plan([dismissedMeeting, call()], { cfg, notLogging: userDismissed }));
      expect(by.call).toMatchObject({ status: 'proposed', excludedReason: null });
    }
    // without the dismissal, count_once still lets the customer workshop win (the original rule)
    expect(byId(plan([dismissedMeeting, call()], { cfg: ONCE })).call).toMatchObject({ status: 'excluded', excludedReason: 'overlap' });
  });

  it('a dismiss rule decides before the overlaps do', () => {
    const workshop = cal({ id: 'onb', summary: 'ACME onboarding workshop', startsAt: mt('09:00'), endsAt: mt('16:00'), attendeeDomains: ['acme.example'] });
    const p = plan([workshop, call()], { cfg: ONCE, rules: [{ match: 'onboarding workshop', action: 'dismiss', why: 'not mine' }] });
    expect(byId(p).onb).toMatchObject({ status: 'dismissed' });
    expect(byId(p).call).toMatchObject({ status: 'proposed', excludedReason: null });
  });
});

describe('(b) two overlapping accepted meetings', () => {
  const two = () => [
    cal({ id: 'cf', summary: 'ACME workshop', startsAt: mt('09:00'), endsAt: mt('10:00'), attendeeDomains: ['acme.example'] }),
    cal({ id: 'int', summary: 'Globex planning', startsAt: mt('09:30'), endsAt: mt('10:30') }),
  ];

  it('both log, each with an informational flag naming the other and the overlap', () => {
    const by = byId(plan(two()));
    expect(by.cf).toMatchObject({ status: 'proposed', excludedReason: null, durationHours: 1, whatOrg62Id: OPP_ACME });
    expect(by.int).toMatchObject({ status: 'proposed', excludedReason: null, durationHours: 1, whatOrg62Id: OPP_GLOBEX });
    expect(by.cf!.flags).toContain("overlaps 'Globex planning' 09:30–10:00 (both log)");
    expect(by.int!.flags).toContain("overlaps 'ACME workshop' 09:30–10:00 (both log)");
    expect(by.int!.flags.every((f) => !f.includes('counted once'))).toBe(true);
  });

  it('the flag is information, never a reason to need input (even when the other title reads like a hold)', () => {
    // a meeting with Globex on it (a hold of my own with nobody else on it is no meeting at all: personalBlockOf)
    const hold = cal({ id: 'hold', summary: 'Globex calendar hold: placeholder OOO review', startsAt: mt('09:30'), endsAt: mt('10:30'), attendeeDomains: ['globex.example'] });
    const p = plan([two()[0]!, hold]);
    const cf = byId(p).cf!;
    expect(cf.flags.some((f) => OVERLAP_INFO_RE.test(f))).toBe(true);
    expect(cf.status).toBe('proposed');
  });

  it('the wall clock still counts the overlap once (blocks), while both rows log', () => {
    const p = plan(two());
    const counted = p.blocks.filter((b) => b.countsAsHumanHours).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 1; i < counted.length; i++) expect(counted[i]!.startsAt >= counted[i - 1]!.endsAt).toBe(true);
    expect(p.humanHours).toBeCloseTo(1.5, 5);
    expect(live(p).reduce((s, e) => s + e.durationHours, 0)).toBe(2);
  });
});

describe('(c) an onsite day and a meeting during it', () => {
  const trip = { days: [], trips: [{ id: 't', from: DAY, to: DAY, accountKey: 'acme', at: NOW }] };
  const meeting = () => cal({ id: 'exec', summary: 'ACME exec sync', startsAt: mt('12:30'), endsAt: mt('13:00'), attendeeDomains: ['acme.example'] });

  it('the frame keeps its 9 h (08:00–17:00) and the meeting logs 0.5 h on the trip', () => {
    const p = plan([meeting()], { onsiteDays: [DAY], onsiteOverrides: trip });
    const frames = live(p).filter((e) => e.dedupeKey.startsWith('onsite|'));
    expect(frames.map((e) => [e.dedupeKey, e.startsAt, e.endsAt, e.durationHours])).toEqual([[`onsite|${DAY}`, mt('08:00'), mt('17:00'), 9]]);
    expect(frames[0]!.reason).toMatch(/whole day/);
    expect(byId(p).exec).toMatchObject({ status: 'proposed', durationHours: 0.5, accountKey: 'acme', whatOrg62Id: OPP_ACME, remote: false, tripKey: expect.any(String) });
    expect(live(p).reduce((s, e) => s + e.durationHours, 0)).toBe(9.5);
  });

  it('caps audit: the frame carries every signal\'s evidence, not the first 12', () => {
    const mtgs = Array.from({ length: 14 }, (_, i) => cal({ id: `m${i}`, summary: `ACME session ${i}`, startsAt: mt(`${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`), endsAt: mt(`${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '45' : '15'}`), attendeeDomains: ['acme.example'], location: '1600 Main St, Denver, CO 80202' }));
    const p = plan(mtgs, { onsiteDays: [DAY], onsiteOverrides: trip });
    const frame = live(p).find((e) => e.dedupeKey.startsWith('onsite|'))!;
    expect(frame.evidenceIds.length).toBeGreaterThan(12);
  });

  it('estimates inside the onsite day still yield to it', () => {
    const slack = [{ id: 'b1', channelId: 'C0PLACEHOLDER1', startsAt: mt('14:00'), endsAt: mt('15:00') }];
    const p = proposeActivity({ now: NOW, cfg: CFG, mappings: MAPPINGS, evidence: { ...EMPTY, calendar: [meeting()], slack }, onsiteDays: [DAY], onsiteOverrides: trip });
    expect(p.entries.filter((e) => e.origin === 'evidence')).toEqual([]);
    expect(p.blocks.find((b) => b.source === 'slack_burst')).toMatchObject({ isOverlay: true, countsAsHumanHours: false });
  });

  it('an onsite day you dismissed never makes an estimate lose (rule 3)', () => {
    const slack = [{ id: 'b1', channelId: 'C0PLACEHOLDER1', startsAt: mt('14:00'), endsAt: mt('15:00') }];
    const p = proposeActivity({ now: NOW, cfg: CFG, mappings: MAPPINGS, evidence: { ...EMPTY, calendar: [meeting()], slack }, onsiteDays: [DAY], onsiteOverrides: trip, notLogging: [`onsite|${DAY}`] });
    expect(p.blocks.find((b) => b.source === 'slack_burst')).toMatchObject({ isOverlay: false, countsAsHumanHours: true });
    // the burst 14:00–15:00 plus 2 min before its first message and 1 after: 13:58–15:01 → 1 h
    expect(p.entries.filter((e) => e.origin === 'evidence').map((e) => [e.durationHours, e.startsAt])).toEqual([[1, mt('13:58')]]);
  });

  it('an approved meeting row of the user does not carve the frame either; a non-meeting row of theirs still does', () => {
    const asMeeting = plan([meeting()], { onsiteDays: [DAY], onsiteOverrides: trip, reserved: [{ startsAt: mt('12:30'), endsAt: mt('13:00'), meeting: true }] });
    expect(live(asMeeting).filter((e) => e.dedupeKey.startsWith('onsite|')).map((e) => e.durationHours)).toEqual([9]);
    const asEstimate = plan([meeting()], { onsiteDays: [DAY], onsiteOverrides: trip, reserved: [{ startsAt: mt('15:00'), endsAt: mt('17:00') }] });
    expect(live(asEstimate).filter((e) => e.dedupeKey.startsWith('onsite|')).map((e) => [e.startsAt, e.endsAt])).toEqual([[mt('08:00'), mt('15:00')]]);
  });
});

describe('(d) a Slack burst overlapping a meeting', () => {
  it('still yields: only the part outside the meeting counts, and its estimate is placed off the meeting', () => {
    const p = proposeActivity({
      now: NOW,
      cfg: CFG,
      mappings: MAPPINGS,
      evidence: { ...EMPTY, calendar: [cal({ id: 'm', summary: 'ACME call', startsAt: mt('10:00'), endsAt: mt('11:00'), attendeeDomains: ['acme.example'] })], slack: [{ id: 'b1', channelId: 'C0PLACEHOLDER1', startsAt: mt('10:30'), endsAt: mt('11:30') }] },
    });
    const slack = p.blocks.filter((b) => b.source === 'slack_burst');
    // engaged time 10:28–11:31 (2 min before, 1 after): the meeting keeps 10:28–11:00
    expect(slack.map((b) => [b.startsAt, b.endsAt, b.countsAsHumanHours])).toEqual([
      [mt('10:28'), mt('11:00'), false],
      [mt('11:00'), mt('11:31'), true],
    ]);
    const est = p.entries.find((e) => e.origin === 'evidence')!;
    expect(est.durationHours).toBe(0.5);
    expect(Date.parse(est.startsAt) >= Date.parse(mt('11:00')) || Date.parse(est.endsAt) <= Date.parse(mt('10:00'))).toBe(true);
  });
});

describe('(e) a tentative or unanswered invite overlapping an accepted meeting', () => {
  it('follows the old rule: never proposed, never claims time, and the accepted one carries no overlap flag', () => {
    const p = plan([
      cal({ id: 'cf', summary: 'ACME workshop', startsAt: mt('09:00'), endsAt: mt('10:00'), attendeeDomains: ['acme.example'] }),
      cal({ id: 'tent', summary: 'Globex planning', startsAt: mt('09:30'), endsAt: mt('10:30'), selfResponse: 'tentative' }),
      cal({ id: 'open', summary: 'Globex review', startsAt: mt('09:45'), endsAt: mt('10:15'), selfResponse: 'needsAction' }),
    ]);
    expect(p.entries.map((e) => e.dedupeKey.split('|')[1])).toEqual(['cf']);
    expect(p.entries[0]!.flags.some((f) => OVERLAP_INFO_RE.test(f))).toBe(false);
    expect(p.rejected.filter((r) => r.reason === 'not_accepted').map((r) => r.dedupeKey.split('|')[1]).sort()).toEqual(['open', 'tent']);
    expect(p.blocks.filter((b) => b.source === 'calendar').map((b) => b.evidenceIds[0])).toEqual(['cf']);
  });
});

describe('(f) no hour caps (2026-11-14): a 12 h day of accepted meetings keeps every hour', () => {
  it('both overlapping meetings log in full and the evening’s solo work keeps its hours: nothing trimmed or flagged', () => {
    const p = plan(
      [
        cal({ id: 'm1', summary: 'ACME workshop', startsAt: mt('08:00'), endsAt: mt('14:00'), attendeeDomains: ['acme.example'] }),
        cal({ id: 'm2', summary: 'Globex workshop', startsAt: mt('13:00'), endsAt: mt('19:00'), attendeeDomains: ['globex.example'] }),
      ],
      { builds: [{ date: DAY, slug: 'b', subject: 'ACME: build', type: 'Solution Creation', hours: 2, start: '20:00', evidence: '', account: 'acme' }] },
    );
    const by = byId(p);
    expect([by.m1, by.m2].map((e) => [e!.status, e!.durationHours, e!.excludedReason])).toEqual([
      ['proposed', 6, null],
      ['proposed', 6, null],
    ]);
    const build = p.entries.find((e) => e.dedupeKey === `build|${DAY}|b`);
    expect(build).toMatchObject({ durationHours: 2 });
    expect(p.entries.flatMap((e) => e.flags).some((f) => /cap/.test(f))).toBe(false);
  });
});

describe('(g) count_once reproduces the original rule', () => {
  it('double-booked meetings count once: the lower-ranked one is excluded as an overlap', () => {
    const p = plan(
      [
        cal({ id: 'cf', summary: 'ACME workshop', startsAt: mt('09:00'), endsAt: mt('10:00'), attendeeDomains: ['acme.example'] }),
        cal({ id: 'int', summary: 'Globex planning', startsAt: mt('09:30'), endsAt: mt('10:30') }),
      ],
      { cfg: ONCE },
    );
    const by = byId(p);
    expect(by.cf).toMatchObject({ status: 'proposed', excludedReason: null });
    expect(by.cf!.flags.some((f) => OVERLAP_INFO_RE.test(f))).toBe(false);
    expect(by.int).toMatchObject({ status: 'excluded', excludedReason: 'overlap' });
    expect(by.int!.flags.some((f) => f.startsWith('double-booked'))).toBe(true);
  });

  it('the onsite frame fills only the gaps around the meeting', () => {
    const p = plan([cal({ id: 'exec', summary: 'ACME exec sync', startsAt: mt('12:30'), endsAt: mt('13:00'), attendeeDomains: ['acme.example'] })], {
      cfg: ONCE,
      onsiteDays: [DAY],
      onsiteOverrides: { days: [], trips: [{ id: 't', from: DAY, to: DAY, accountKey: 'acme', at: NOW }] },
    });
    expect(live(p).filter((e) => e.dedupeKey.startsWith('onsite|')).map((e) => [e.startsAt, e.endsAt, e.durationHours])).toEqual([
      [mt('08:00'), mt('12:30'), 4.5],
      [mt('13:00'), mt('17:00'), 4],
    ]);
    expect(live(p).find((e) => e.dedupeKey.startsWith('onsite|'))!.reason).toMatch(/fills the time between your sessions/);
    const rows = live(p).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.startsAt >= rows[i - 1]!.endsAt).toBe(true);
  });
});
