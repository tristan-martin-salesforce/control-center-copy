import { describe, expect, it } from 'vitest';
import { buildEstimateEntries, parseBuildEstimates, type BuildEstimate } from '@/engines/activity/estimates';
import { proposeActivity, applyRules, finalizeStatus } from '@/engines/activity/propose';
import type { EvidenceBundle } from '@/engines/activity/types';
import { CFG, MAPPINGS, NOW, OPP_ACME, cal, entry, ev62 } from '../fixtures/org62/activity';

const EMPTY: EvidenceBundle = { calendar: [], claude: [], drive: [], slack: [], git: [] };
const b = (p: Partial<BuildEstimate> & Pick<BuildEstimate, 'date' | 'slug' | 'hours'>): BuildEstimate => ({
  subject: `ACME: build ${p.slug}`,
  type: 'Solution Creation',
  evidence: 'git 12 commits',
  account: 'acme',
  ...p,
});

const plan = (builds: BuildEstimate[], extra: Partial<Parameters<typeof proposeActivity>[0]> = {}) =>
  proposeActivity({ now: NOW, cfg: CFG, mappings: MAPPINGS, evidence: EMPTY, builds, ...extra });

describe('build estimates', () => {
  it('parses the builds.json format', () => {
    const rows = parseBuildEstimates([{ date: '2026-10-20', slug: 'x', subject: 'S', type: 'Solution Creation', hours: 3.5, pref: 'morning', evidence: 'git' }]);
    expect(rows[0]!.hours).toBe(3.5);
    expect(() => parseBuildEstimates([{ date: 'bad', slug: 'x' }])).toThrow();
  });

  it('rejects estimates before go-live (mid-September) and keeps the rest', () => {
    const p = plan([b({ date: '2026-08-20', slug: 'old', hours: 4 }), b({ date: '2026-09-14', slug: 'edge', hours: 4 }), b({ date: '2026-09-15', slug: 'live', hours: 4 })]);
    expect(p.rejected.filter((r) => r.reason === 'before_go_live').map((r) => r.dedupeKey)).toEqual(['build|2026-08-20|old', 'build|2026-09-14|edge']);
    expect(p.entries.map((e) => e.dedupeKey)).toEqual(['build|2026-09-15|live']);
  });

  it('logs demo-asset / tooling builds as Asset Creation with NO WhatId', () => {
    const p = plan([b({ date: '2026-10-20', slug: 'asset', hours: 3, type: 'Asset Creation', subject: 'Demo org tooling', what_id: OPP_ACME })]);
    expect(p.entries[0]).toMatchObject({ seTaskType: 'Asset Creation', whatOrg62Id: null, whatKind: 'none', origin: 'build_estimate' });
  });

  it('hands-off approval approves Asset Creation builds without a WhatId, and customer builds with one', () => {
    const p = plan([b({ date: '2026-10-20', slug: 'asset', hours: 3, type: 'Asset Creation', subject: 'Demo tooling' }), b({ date: '2026-10-21', slug: 'cust', hours: 2 })], { handsOff: true });
    expect(p.entries.map((e) => [e.dedupeKey, e.status, e.approvalMethod])).toEqual([
      ['build|2026-10-20|asset', 'approved', 'autonomy_policy'],
      ['build|2026-10-21|cust', 'approved', 'autonomy_policy'],
    ]);
  });

  it('places builds in free gaps without double-booking Org62 events or each other', () => {
    // Local Tue 2026-10-20 (MDT, UTC-6). Org62 already has 12:30-15:30 local = 18:30Z-21:30Z.
    const org62Events = [ev62({ org62EventId: 'E1', startsAt: '2026-10-20T18:30:00Z', endsAt: '2026-10-20T21:30:00Z', durationField: 3 })];
    const p = plan([b({ date: '2026-10-20', slug: 'a', hours: 2, pref: 'afternoon' }), b({ date: '2026-10-20', slug: 'b', hours: 2, pref: 'afternoon' })], { org62Events });
    const [a, c] = p.entries;
    expect(a!.startsAt).toBe('2026-10-20T21:30:00Z'); // first free gap after the logged event
    expect(c!.startsAt).toBe(a!.endsAt);
  });
});

describe('no hour caps (2026-11-14: grounded in truth)', () => {
  it('a 55 h week of builds keeps every hour: nothing is trimmed, nothing flagged', () => {
    const builds = Array.from({ length: 5 }, (_, i) => b({ date: `2026-10-${20 + i}`, slug: `s${i}`, hours: 11 })); // 55 h in one week
    const p = plan(builds);
    const live = p.entries.filter((e) => e.status !== 'excluded');
    expect(live.reduce((s, e) => s + e.durationHours, 0)).toBe(55);
    expect(p.entries.some((e) => e.excludedReason === 'cap_trimmed' || e.flags.some((f) => /cap/.test(f)))).toBe(false);
    expect(p).not.toHaveProperty('capViolations');
    expect(p).not.toHaveProperty('trims');
  });

  it('a 14 h day next to 8 h already in Org62 keeps the build whole (it only avoids the logged slot)', () => {
    // 21 Oct local (MDT): Org62 has 08:00-16:00 local; the 6 h build lands after it, untrimmed
    const org62Events = [ev62({ org62EventId: 'L', startsAt: '2026-10-21T14:00:00Z', endsAt: '2026-10-21T22:00:00Z', durationField: 8 })];
    const p = plan([b({ date: '2026-10-21', slug: 'x', hours: 6, pref: 'morning' })], { org62Events });
    expect(p.entries[0]).toMatchObject({ durationHours: 6, status: expect.not.stringMatching(/excluded/) });
    expect(Date.parse(p.entries[0]!.startsAt)).toBeGreaterThanOrEqual(Date.parse('2026-10-21T22:00:00Z'));
  });
});

describe('autoplan rules and statuses', () => {
  it('rules resolve a missing WhatId and dismiss noise', () => {
    const p = plan([], {
      evidence: { ...EMPTY, calendar: [cal({ id: 'x', summary: 'Initech ??? placeholder hold', startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T17:00:00Z', attendeeDomains: ['corp.example'] })] },
    });
    const ruled = applyRules(p.entries, [{ match: 'placeholder hold', action: 'dismiss', why: 'calendar hold' }], CFG.timezone);
    expect(ruled[0]!.status).toBe('dismissed');
  });
  it('future meetings are upcoming; past ones with no WhatId need input', () => {
    const past = entry({ dedupeKey: 'a', startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T17:00:00Z', durationHours: 1, status: 'proposed', whatOrg62Id: null });
    const fut = entry({ dedupeKey: 'b', startsAt: '2026-11-09T16:00:00Z', endsAt: '2026-11-09T17:00:00Z', durationHours: 1, status: 'proposed' });
    const now = Date.parse(NOW);
    expect(finalizeStatus(past, now).status).toBe('needs_input');
    expect(finalizeStatus(fut, now).status).toBe('upcoming');
  });
  it('buildEstimateEntries is pure and deterministic', () => {
    const ctx = { cfg: CFG, mappings: MAPPINGS, busyByDay: new Map() };
    const x = buildEstimateEntries([b({ date: '2026-10-20', slug: 'a', hours: 2 })], ctx);
    const y = buildEstimateEntries([b({ date: '2026-10-20', slug: 'a', hours: 2 })], ctx);
    expect(x).toEqual(y);
  });
});
