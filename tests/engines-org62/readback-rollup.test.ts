import { describe, expect, it } from 'vitest';
import { applyReadback, verifyReadback, normSubject } from '@/engines/activity/readback';
import { quarterProgress, readyToSubmit, weeklyRollup } from '@/engines/activity/rollup';
import type { ActivityEntry } from '@/engines/activity/types';
import { CFG, OPP_ACME, entry, ev62 } from '../fixtures/org62/activity';

const NOW = '2026-11-05T18:00:00Z';

const e = (k: string, start: string, end: string, h: number, p: Partial<ActivityEntry> = {}) =>
  entry({ dedupeKey: k, subject: `Subject ${k}`, startsAt: start, endsAt: end, durationHours: h, seTaskType: 'Solution Creation', status: 'synced_to_canvas', ...p });

describe('read-back statuses', () => {
  const entries = [
    e('ok', '2026-10-20T16:00:00Z', '2026-10-20T17:00:00Z', 1),
    e('bad', '2026-10-20T18:00:00Z', '2026-10-20T19:00:00Z', 1),
    e('blank', '2026-10-21T16:00:00Z', '2026-10-21T17:00:00Z', 1),
    e('miss', '2026-10-21T18:00:00Z', '2026-10-21T19:00:00Z', 1),
    e('future', '2026-11-09T18:00:00Z', '2026-11-09T19:00:00Z', 1, { status: 'approved' }),
    e('unapproved', '2026-10-20T20:00:00Z', '2026-10-20T21:00:00Z', 1, { status: 'proposed' }),
  ];
  const org62 = [
    ev62({ org62EventId: 'A1', subject: 'Subject ok', startsAt: '2026-10-20T16:00:00Z', endsAt: '2026-10-20T17:00:00Z', durationField: 1, seTaskTypeName: 'Solution Creation' }),
    ev62({ org62EventId: 'A2', subject: 'Subject bad', startsAt: '2026-10-20T18:00:00Z', endsAt: '2026-10-20T19:00:00Z', durationField: 2, seTaskTypeName: 'Dry Run', whatOrg62Id: '006DIFFERENT0001' }),
    ev62({ org62EventId: 'A3', subject: 'Subject blank', startsAt: '2026-10-21T16:00:00Z', endsAt: '2026-10-21T17:00:00Z', durationField: null }),
    // A later Solutions Event exists, so "miss" is missing, not merely unconfirmed.
    ev62({ org62EventId: 'A4', subject: 'Something else entirely', startsAt: '2026-10-22T16:00:00Z', endsAt: '2026-10-22T17:00:00Z' }),
  ];

  it('produces logged / verified / verify_failed / missing / pending', () => {
    const r = verifyReadback(entries, org62, { now: NOW, ownerId: '005PLACEHOLDER0001' });
    const s = Object.fromEntries(r.items.map((i) => [i.dedupeKey, i]));
    expect(s.ok).toMatchObject({ status: 'verified', org62EventId: 'A1', matchedBy: 'subject_start' });
    expect(s.bad!.status).toBe('verify_failed');
    expect(s.bad!.issues.join(' ')).toMatch(/SE_Task_Type__c.*Duration__c.*WhatId: expected 006PLACEHOLDER0001, Org62 has 006DIFFERENT0001/);
    expect(s.blank).toMatchObject({ status: 'logged', org62EventId: 'A3' });
    expect(s.miss!.status).toBe('missing');
    expect(s.future!.status).toBe('pending');
    expect(s.unapproved!.status).toBe('pending');
    expect(r.gap).toBeNull();
  });

  it('matches through the canvas "|" -> "/" normalization and 15/18-char ids', () => {
    const x = e('p', '2026-10-20T16:00:00Z', '2026-10-20T17:00:00Z', 1, { subject: 'ACME | design', whatOrg62Id: OPP_ACME + 'XYZ' });
    const row = ev62({ org62EventId: 'P1', subject: 'ACME / design', startsAt: '2026-10-20T16:00:00Z', endsAt: '2026-10-20T17:00:00Z', whatOrg62Id: OPP_ACME });
    expect(normSubject('ACME | design')).toBe(normSubject('ACME / design'));
    expect(verifyReadback([x], [row], { now: NOW }).items[0]!.status).toBe('verified');
  });

  it('a legacy-record-type Event does not count as logged (locked; needs re-create)', () => {
    const x = e('l', '2026-10-20T16:00:00Z', '2026-10-20T17:00:00Z', 1);
    const row = ev62({ org62EventId: 'L1', recordTypeName: 'Sales Engineer Events', subject: 'Subject l', startsAt: '2026-10-20T16:00:00Z', endsAt: '2026-10-20T17:00:00Z' });
    const r = verifyReadback([x], [row], { now: NOW });
    expect(r.items[0]!.status).not.toBe('verified');
    expect(r.items[0]!.issues[0]).toMatch(/locked/);
  });

  it('re-creates ignore the legacy original as a match target', () => {
    const re = e('re', '2026-10-20T16:00:00Z', '2026-10-20T17:00:00Z', 1, { origin: 'legacy_recreate', targetOrg62EventId: 'L1' });
    const legacy = ev62({ org62EventId: 'L1', recordTypeName: 'Sales Engineer Events', subject: 'Subject re', startsAt: '2026-10-20T16:00:00Z', endsAt: '2026-10-20T17:00:00Z' });
    expect(verifyReadback([re], [legacy], { now: NOW }).items[0]!.status).toBe('unconfirmed');
  });

  it('applyReadback moves statuses and flags the rest', () => {
    const r = verifyReadback(entries, org62, { now: NOW });
    const out = Object.fromEntries(applyReadback(entries, r).map((x) => [x.dedupeKey, x]));
    expect(out.ok!.status).toBe('verified');
    expect(out.ok!.org62EventId).toBe('A1');
    expect(out.miss!.status).toBe('synced_to_canvas');
    expect(out.miss!.flags.join(' ')).toMatch(/read-back missing/);
  });
});

describe('the gap finding: unconfirmed / not logged', () => {
  // Org62 shows Solutions Events only through 10/23; approved rows for 10/26 to 11/3 are on the canvas.
  const org62 = [
    ev62({ org62EventId: 'S1', subject: 'old a', startsAt: '2026-10-21T16:00:00Z', endsAt: '2026-10-21T17:00:00Z' }),
    ev62({ org62EventId: 'S2', subject: 'old b', startsAt: '2026-10-23T15:00:00Z', endsAt: '2026-10-23T16:00:00Z' }),
  ];
  const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03'];
  const rows = days.flatMap((d, i) => [e(`g${i}a`, `${d}T15:00:00Z`, `${d}T20:00:00Z`, 5), e(`g${i}b`, `${d}T21:00:00Z`, `${d}T22:00:00Z`, 1)]);

  it('marks every approved-but-unseen row unconfirmed and reports the gap', () => {
    const r = verifyReadback(rows, org62, { now: NOW });
    expect(r.byStatus.unconfirmed).toBe(14);
    expect(r.byStatus.missing).toBe(0);
    expect(r.gap).toMatchObject({ hours: 42, daysSilent: 13, firstUnconfirmedStart: '2026-10-26T15:00:00.000Z' });
    expect(r.gap!.lastSolutionsEventAt).toBe('2026-10-23T15:00:00.000Z');
    expect(r.gap!.entryKeys).toHaveLength(14);
    expect(r.gap!.message).toMatch(/not confirmed in Org62.*2026-10-23/);
  });

  it('no Solutions Events at all is still unconfirmed, not verified', () => {
    const r = verifyReadback(rows.slice(0, 2), [], { now: NOW });
    expect(r.byStatus.unconfirmed).toBe(2);
    expect(r.gap!.lastSolutionsEventAt).toBeNull();
  });

  it('an explicit read-back cursor that stops short keeps rows unconfirmed even if Org62 has later events', () => {
    const later = [...org62, ev62({ org62EventId: 'S3', subject: 'later', startsAt: '2026-11-04T16:00:00Z', endsAt: '2026-11-04T17:00:00Z' })];
    expect(verifyReadback(rows, later, { now: NOW }).byStatus.missing).toBeGreaterThan(0); // later event exists: missing
    const cursor = verifyReadback(rows, org62, { now: NOW, observedThrough: '2026-10-24T00:00:00Z' });
    expect(cursor.byStatus.unconfirmed).toBe(14);
  });

  it('blocks "ready to submit"', () => {
    const r = verifyReadback(rows, org62, { now: NOW });
    const ready = readyToSubmit({ entries: rows, org62, readback: r, cfg: CFG, nowIso: '2026-10-29T18:00:00Z' });
    expect(ready.ready).toBe(false);
    expect(ready.blockers.map((b) => b.code)).toContain('unconfirmed');
  });
});

describe('rollups and ready-to-submit', () => {
  const org62 = [
    ev62({ org62EventId: 'L1', startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T18:00:00Z', durationField: 2, seTaskTypeName: 'Customer Discovery' }),
    ev62({ org62EventId: 'L2', startsAt: '2026-11-03T16:00:00Z', endsAt: '2026-11-03T17:00:00Z', durationField: 1, seTaskTypeName: 'Solution Creation' }),
    ev62({ org62EventId: 'L3', startsAt: '2026-10-28T16:00:00Z', endsAt: '2026-10-28T17:00:00Z', durationField: 1, seTaskTypeName: 'Workshop' }), // previous quarter
    ev62({ org62EventId: 'Z', startsAt: '2026-11-03T20:00:00Z', endsAt: '2026-11-03T21:00:00Z', durationField: 1, seTaskTypeName: 'Admin' }), // Neither
  ];
  const entries = [
    e('a', '2026-11-04T16:00:00Z', '2026-11-04T18:00:00Z', 2, { seTaskType: 'Workshop', status: 'approved' }),
    e('p', '2026-11-04T19:00:00Z', '2026-11-04T20:00:00Z', 1, { seTaskType: 'Customer Presentation', status: 'proposed' }),
    e('n', '2026-11-04T21:00:00Z', '2026-11-04T21:30:00Z', 0.5, { status: 'needs_input', whatOrg62Id: null }),
    e('u', '2026-11-10T16:00:00Z', '2026-11-10T17:00:00Z', 1, { seTaskType: 'Customer Discovery', status: 'upcoming' }),
  ];

  it('weekly rollup splits CR and CF by bucket', () => {
    const w = weeklyRollup(entries, org62, CFG);
    const wk = w.find((x) => x.week === '2026-11-02')!;
    expect(wk.logged).toEqual({ cr: 3, cf: 2 }); // Discovery 2 (CR+CF) + Solution Creation 1 (CR); Admin is Neither
    expect(wk.approved).toEqual({ cr: 2, cf: 2 });
    expect(wk.toReview).toEqual({ cr: 1.5, cf: 1 });
    expect(wk.totalHours).toBe(7.5); // 4 logged (incl. the Neither Admin hour: real time against the cap) + 2 + 1.5
    expect(w.find((x) => x.week === '2026-10-26')!.logged).toEqual({ cr: 1, cf: 1 });
  });

  it('quarter progress: CR, CF and CC, gap to target, deadline', () => {
    const q = quarterProgress(entries, org62, CFG, NOW);
    expect(q.quarter).toBe('FY27 Q4');
    expect(q.logged).toEqual({ cr: 3, cf: 2 }); // the 10/28 event belongs to Q3
    expect(q.loggedCC).toBe(3);
    expect(q.approved).toEqual({ cr: 2, cf: 2 });
    expect(q.toReview).toEqual({ cr: 1, cf: 1 });
    expect(q.needsInput).toEqual({ cr: 0.5, cf: 0 });
    expect(q.upcoming).toEqual({ cr: 1, cf: 1 });
    expect(q.gapToTarget).toBe(247);
    expect(q.daysToDeadline).toBe(85);
    expect(q.projectedPct).toBe(Math.round(((3 + 2 + 1) / 250) * 10000) / 100);
  });

  it('ready to submit: clean state passes; each blocker is named', () => {
    const clean = [e('c', '2026-11-02T16:00:00Z', '2026-11-02T18:00:00Z', 2, { subject: 'Subject c', seTaskType: 'Customer Discovery' })];
    const okOrg = [ev62({ org62EventId: 'C1', subject: 'Subject c', startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T18:00:00Z', durationField: 2, seTaskTypeName: 'Customer Discovery' })];
    const rb = verifyReadback(clean, okOrg, { now: NOW });
    expect(readyToSubmit({ entries: clean, org62: okOrg, readback: rb, cfg: CFG, nowIso: NOW })).toEqual({ ready: true, blockers: [] });

    const dirty = readyToSubmit({
      entries: [...clean, ...entries],
      org62: [...okOrg, ev62({ org62EventId: 'B', startsAt: '2026-11-03T16:00:00Z', endsAt: '2026-11-03T17:00:00Z', durationField: null }), ev62({ org62EventId: 'LG', recordTypeName: 'Sales Engineer Events', startsAt: '2026-11-03T18:00:00Z', endsAt: '2026-11-03T19:00:00Z' })],
      readback: rb,
      cfg: CFG,
      nowIso: NOW,
    });
    expect(dirty.ready).toBe(false);
    // no hour caps since 2026-11-14: no over_cap blocker
    expect(dirty.blockers.map((b) => b.code).sort()).toEqual(['blank_duration', 'legacy_events', 'needs_input', 'to_review']);
  });
});
