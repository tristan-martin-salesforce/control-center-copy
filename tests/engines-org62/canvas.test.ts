import { describe, expect, it } from 'vitest';
import { applyMarks, diffEntries, diffWorkOrder, markFor, parseMarks, parseWorkOrder, withMark } from '@/engines/activity/canvas-parse';
import { durationBackfillUpdates, legacyDeleteUpdates, renderWorkOrder, splitWorkOrderParts } from '@/engines/activity/canvas-workorder';
import { quarterProgress, weeklyRollup } from '@/engines/activity/rollup';
import { refOf } from '@/engines/activity/entry';
import { renderReviewCanvas, reviewLine } from '@/engines/activity/canvas-review';
import type { ActivityEntry } from '@/engines/activity/types';
import { CFG, NOW, OPP_ACME, OPP_GLOBEX, ev62, entry } from '../fixtures/org62/activity';

const ID = { ownerName: 'Test User' };

const rows = (): ActivityEntry[] => [
  entry({ dedupeKey: 'cal|a|1', ref: '101', subject: 'ACME | design session', startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T17:00:00Z', durationHours: 1, seTaskType: 'Customer Discovery', customerFacing: true, extDomains: ['acme.example'], status: 'approved' }),
  entry({ dedupeKey: 'cal|b|2', ref: '102', subject: 'Globex planning', startsAt: '2026-11-02T18:00:00Z', endsAt: '2026-11-02T18:45:00Z', durationHours: 0.75, seTaskType: 'Account Planning', whatOrg62Id: OPP_GLOBEX, whatName: 'Globex - Agent Rollout', status: 'synced_to_canvas' }),
  entry({ dedupeKey: 'build|2026-10-23|asset', ref: '103', origin: 'build_estimate', subject: 'Demo tooling build', startsAt: '2026-11-03T19:00:00Z', endsAt: '2026-11-03T22:30:00Z', durationHours: 3.5, seTaskType: 'Asset Creation', whatKind: 'none', whatOrg62Id: null, whatName: null, evidence: 'git 15 commits', status: 'approved' }),
  entry({ dedupeKey: 'legacy|E9', ref: '104', origin: 'legacy_recreate', targetOrg62EventId: 'E9', subject: 'Legacy re-create', startsAt: '2026-10-05T16:00:00Z', endsAt: '2026-10-05T16:30:00Z', durationHours: 0.5, seTaskType: 'Account Planning', status: 'approved' }),
  entry({ dedupeKey: 'cal|future|9', ref: '109', subject: 'Future meeting', startsAt: '2026-11-09T16:00:00Z', endsAt: '2026-11-09T17:00:00Z', durationHours: 1, status: 'approved' }),
];

const legacyEvents = [ev62({ org62EventId: 'E9', recordTypeName: 'Sales Engineer Events', startsAt: '2026-10-05T16:00:00Z', endsAt: '2026-10-05T16:30:00Z', seTaskTypeName: null, durationField: null })];
const blank = [ev62({ org62EventId: 'E7', subject: "Blank 'dur' | thing", startsAt: '2026-10-06T16:00:00Z', endsAt: '2026-10-06T17:30:00Z', durationField: null })];

const workOrder = () =>
  renderWorkOrder({
    entries: rows(),
    dcAdds: [{ oppId: OPP_ACME, oppName: 'ACME - Data 360 Expansion', split: 50, comment: 'Line one\nLine two | with pipe' }],
    updates: [...durationBackfillUpdates([...legacyEvents, ...blank], '2026-08-01'), ...legacyDeleteUpdates(rows(), legacyEvents)],
    nowIso: NOW,
    cfg: CFG,
    identity: ID,
  });

describe('work-order canvas render', () => {
  it('matches the autopilot format exactly', () => {
    const { markdown, stats } = workOrder();
    expect(stats).toEqual({ adds: 4, dcAdds: 1, addHours: 5.75, updates: 2 });
    expect(markdown).toMatchSnapshot();
  });

  it('table rows use the autopilot cell conventions', () => {
    const { markdown } = workOrder();
    const lines = markdown.split('\n');
    // WO-1: one table per object and verb, no Object column
    expect(lines).toContain('## EVENTS TO CREATE (4 rows · 5.75 h of activities)');
    expect(lines).toContain('|#|Subject|StartDateTime (UTC)|EndDateTime (UTC)|SE_Task_Type__c|Duration__c|WhatId|Meeting_Type__c|Description|');
    expect(lines).toContain('## DEAL CONTRIBUTIONS TO CREATE (1 row)');
    expect(lines).toContain('|#|Opportunity|Opportunity__c|Opportunity_Role__c|Split_Percentage__c|Comments__c|');
    const ev = lines.find((l) => l.includes('ACME / design session'))!; // "|" became "/"
    expect(ev).toBe('|2|ACME / design session|2026-11-02T16:00:00.000Z|2026-11-02T17:00:00.000Z|Customer Discovery|1.0|006PLACEHOLDER0001||CC#101 / calendar 2026-11-02 / CF: external attendees (acme.example)|');
    // Legacy re-create carries the REPLACES prefix; a Neither build has no WhatId; the future row is absent.
    expect(lines.find((l) => l.includes('Legacy re-create'))).toContain('REPLACES E9 (legacy record type) / CC#104');
    expect(lines.find((l) => l.includes('Demo tooling build'))).toMatch(/\|Asset Creation\|3\.5\|\|\|CC#103 \/ build 2026-11-03 \/ evidence: git 15 commits\|$/);
    expect(markdown).not.toContain('Future meeting');
    expect(lines.find((l) => l.includes('ACME - Data 360 Expansion'))).toBe('|1|ACME - Data 360 Expansion|006PLACEHOLDER0001|AI + Data Architect|50|Line one ⏎ Line two / with pipe|');
  });

  it('EVENTS TO UPDATE table: duration backfill and legacy delete', () => {
    const { markdown } = workOrder();
    expect(markdown).toContain('## EVENTS TO UPDATE (2 rows)');
    expect(markdown).toContain("|1|E7|Duration__c|1.5|(blank)|Time(Hrs) never filled: End − Start of 'Blank 'dur' / thing'|");
    expect(markdown).toContain('|2|E9|Delete|n/a|Sales Engineer Events record type, no SE Task Type|Replaced by the EVENTS TO CREATE row whose Description starts with REPLACES E9|');
  });

  it('splits into canvas-sized parts at row boundaries, repeating the table header', () => {
    const many = Array.from({ length: 120 }, (_, i) => entry({ dedupeKey: `k${i}`, ref: String(i), subject: `Row ${i} ${'x'.repeat(60)}`, startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T17:00:00Z', durationHours: 1 }));
    const { markdown } = renderWorkOrder({ entries: many, nowIso: NOW, cfg: CFG, identity: ID });
    const parts = splitWorkOrderParts(markdown, 4000);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[1]).toMatch(/^## EVENTS TO CREATE \(120 rows .*\) \(continued\)\n\n\|#\|Subject\|/);
    const total = parts.join('\n').split('\n').filter((l) => /^\|\d+\|Row /.test(l)).length;
    expect(total).toBe(120);
  });
});

describe('work-order parse and round trip', () => {
  it('parses the rendered canvas back into rows', () => {
    const parsed = parseWorkOrder(workOrder().markdown);
    expect(parsed.adds).toHaveLength(5);
    expect(parsed.updates).toHaveLength(2);
    const first = parsed.adds[0]!;
    expect(first).toMatchObject({ kind: 'event', ref: '104', replacesId: 'E9', durationHours: 0.5, seTaskType: 'Account Planning' });
    const dc = parsed.adds[4]!;
    expect(dc).toMatchObject({ kind: 'dc', oppId: OPP_ACME, split: 50, comment: 'Line one\nLine two / with pipe' });
  });

  it('accepts Slack-normalized tables (blank "#" header cell, padded separator)', () => {
    const md = workOrder().markdown.replace('|#|Object|', '||Object|').replace(/\|---\|/g, '|  ---  |');
    const parsed = parseWorkOrder(md);
    expect(parsed.adds).toHaveLength(5);
    expect(parsed.updates).toHaveLength(2);
  });

  it('render -> parse -> diff is empty, and an edit in the canvas is detected', () => {
    const rendered = parseWorkOrder(workOrder().markdown);
    expect(diffWorkOrder(rendered, parseWorkOrder(workOrder().markdown))).toEqual({ changed: [], removedRefs: [], addedRows: [] });

    // The user edits row 101 to 1.5 h and drops row 103 inside the canvas.
    const edited = workOrder()
      .markdown.replace('|Customer Discovery|1.0|', '|Customer Discovery|1.5|')
      .split('\n')
      .filter((l) => !l.includes('Demo tooling build'))
      .join('\n');
    const d = diffWorkOrder(rendered, parseWorkOrder(edited));
    expect(d.changed).toEqual([{ ref: '101', fields: { durationHours: { before: 1, after: 1.5 } } }]);
    expect(d.removedRefs).toEqual(['103']);
  });
});

describe('review-canvas marks and app edits', () => {
  const line = (e: ActivityEntry) => reviewLine(e, CFG);

  it('renders a review line in the autopilot grammar', () => {
    const e = rows()[0]!;
    expect(line(e)).toBe('- [ ] #101 · Mon 11/02 09:00 · 1h · ACME / design session · Customer Discovery · ACME - Data 360 Expansion · CF');
    const g = entry({ dedupeKey: 'wb|x', ref: '7', origin: 'evidence', subject: 'ACME: off-calendar build/prep', startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T17:00:00Z', durationHours: 1, evidence: 'hands-on 1 h', status: 'proposed' });
    expect(line(g)).toContain('· ~1h ·');
    expect(line(g)).toContain('_hands-on 1 h_');
  });

  it('parses ticks and => marks (skip, type, hours, WhatId, combined)', () => {
    const marks = parseMarks(
      [
        '- [x] #101 · whatever',
        '- [ ] #102 · whatever => skip',
        '- [ ] #103 · whatever => Customer Discovery',
        '- [ ] #104 · whatever => 1.5h',
        '- [x] #105 · whatever => 006PLACEHOLDER0002',
        '- [x] #106 · whatever => Workshop, 1h, 006PLACEHOLDER0001',
        '- [ ] #107 · opp #D360-HL in the subject but no mark',
        'not a line',
      ].join('\n'),
    );
    expect(marks.get('101')).toEqual({ approve: true, skip: false, type: null, whatId: null, hours: null });
    expect(marks.get('102')!.skip).toBe(true);
    expect(marks.get('103')!.type).toBe('Customer Discovery');
    expect(marks.get('104')!.hours).toBe(1.5);
    expect(marks.get('105')!.whatId).toBe('006PLACEHOLDER0002');
    expect(marks.get('106')).toMatchObject({ approve: true, type: 'Workshop', hours: 1, whatId: '006PLACEHOLDER0001' });
    expect(marks.get('107')).toMatchObject({ approve: false, skip: false });
    expect(marks.size).toBe(7);
  });

  it('applies marks: edits lock fields, a tick approves, Neither types never approve, frozen rows ignore ticks', () => {
    const base = (ref: string, p: Partial<ActivityEntry> = {}) => entry({ dedupeKey: `k${ref}`, ref, startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T17:00:00Z', durationHours: 1, status: 'proposed', ...p });
    const es = [base('1', { whatOrg62Id: null, status: 'needs_input' }), base('2'), base('3', { seTaskType: 'Admin' }), base('4', { status: 'logged' }), base('5')];
    const marks = parseMarks(['- [x] #1 · x => 006PLACEHOLDER0002, Workshop, 2h', '- [x] #2 · x', '- [x] #3 · x', '- [x] #4 · x => skip', '- [ ] #5 · x => skip'].join('\n'));
    const { entries, changes } = applyMarks(es, marks, NOW);
    const by = Object.fromEntries(entries.map((e) => [e.dedupeKey, e]));
    expect(by.k1).toMatchObject({ status: 'approved', whatOrg62Id: '006PLACEHOLDER0002', seTaskType: 'Workshop', durationHours: 2, approvalMethod: 'click' });
    expect(by.k1!.userLockedFields).toEqual(['seTaskType', 'whatOrg62Id', 'durationHours']);
    expect(by.k1!.endsAt).toBe('2026-11-02T18:00:00Z');
    expect(by.k2!.status).toBe('approved');
    expect(by.k3!.status).toBe('proposed'); // Neither: not approvable
    expect(by.k4!.status).toBe('logged'); // frozen
    expect(by.k5!.status).toBe('dismissed');
    expect(changes.map((c) => `${c.ref}:${c.action}`)).toEqual(['1:edited', '1:approved', '2:approved', '5:dismissed']);
  });

  it('app edit -> canvas diff -> mark -> parse round-trip', () => {
    const prev = rows().slice(0, 2);
    const next = prev.map((e) => (e.dedupeKey === 'cal|a|1' ? { ...e, durationHours: 1.5, seTaskType: 'Workshop', whatOrg62Id: OPP_GLOBEX } : e)).concat(entry({ dedupeKey: 'new', ref: '200', startsAt: '2026-11-04T16:00:00Z', endsAt: '2026-11-04T17:00:00Z', durationHours: 1 }));
    const d = diffEntries(prev, next.filter((e) => e.dedupeKey !== 'cal|b|2'));
    expect(d.added.map((e) => e.ref)).toEqual(['200']);
    expect(d.removed.map((e) => e.ref)).toEqual(['102']);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.mark).toBe('=> Workshop, 1.5h, 006PLACEHOLDER0002');
    expect(d.changed[0]!.before).toMatchObject({ durationHours: 1, seTaskType: 'Customer Discovery' });

    // Put the mark on the rendered line and parse it back: the same edit comes out.
    const l = withMark(reviewLine(prev[0]!, CFG), d.changed[0]!.mark);
    const parsed = parseMarks(l).get('101')!;
    expect(parsed).toMatchObject({ type: 'Workshop', hours: 1.5, whatId: OPP_GLOBEX, skip: false });
    const { entries } = applyMarks(prev, parseMarks(l), NOW);
    expect(entries[0]).toMatchObject({ seTaskType: 'Workshop', durationHours: 1.5, whatOrg62Id: OPP_GLOBEX });
  });

  it('dismissal in the app becomes `=> skip`; replacing an old mark keeps one', () => {
    const e = rows()[0]!;
    expect(markFor(e, { ...e, status: 'dismissed' })).toBe('=> skip');
    expect(markFor(e, e)).toBe('');
    expect(withMark('- [ ] #1 · a => 1h', '=> 2h')).toBe('- [ ] #1 · a => 2h');
    expect(refOf(e)).toBe('101');
  });
});

describe('review canvas render', () => {
  it('matches the autopilot sections and format', () => {
    const entries = [
      ...rows().filter((e) => e.dedupeKey !== 'legacy|E9'),
      entry({ dedupeKey: 'cal|p|1', ref: '201', subject: 'ACME readout', startsAt: '2026-11-03T16:00:00Z', endsAt: '2026-11-03T16:30:00Z', durationHours: 0.5, seTaskType: 'Customer Presentation', status: 'proposed' }),
      entry({ dedupeKey: 'cal|n|1', ref: '202', subject: 'Initech sync', startsAt: '2026-11-03T18:00:00Z', endsAt: '2026-11-03T18:30:00Z', durationHours: 0.5, seTaskType: 'Account Planning', whatOrg62Id: null, whatName: null, flags: ['NEEDS WhatId: pick an opp from candidates'], status: 'needs_input' }),
      entry({ dedupeKey: 'wb|2026-11-04|acct:acme', ref: '203', origin: 'evidence', subject: 'ACME: off-calendar build/prep', startsAt: '2026-11-04T16:00:00Z', endsAt: '2026-11-04T17:30:00Z', durationHours: 1.5, seTaskType: 'Solution Creation', evidence: 'hands-on 1.5 h (claude_hands_on)', status: 'proposed' }),
      entry({ dedupeKey: 'cal|u|1', ref: '204', subject: 'Upcoming workshop', startsAt: '2026-11-10T16:00:00Z', endsAt: '2026-11-10T17:00:00Z', durationHours: 1, seTaskType: 'Workshop', meetingType: 'Data Cloud Workshop', status: 'upcoming' }),
    ];
    const org62 = [ev62({ org62EventId: 'E1', startsAt: '2026-11-02T14:00:00Z', endsAt: '2026-11-02T16:00:00Z', durationField: 2, seTaskTypeName: 'Customer Discovery' })];
    const progress = quarterProgress(entries, org62, CFG, NOW);
    const md = renderReviewCanvas({
      entries,
      progress,
      weeks: weeklyRollup(entries, org62, CFG),
      recentlyConfirmed: [{ entry: rows()[0]!, org62EventId: 'E1' }],
      dcGaps: [{ oppName: 'ACME - Data 360 Expansion', closeDate: '2027-01-29', myDc: 'none', vdp: 'none', gaps: ['no DC'] }],
      dcSeenAt: '2026-11-05T12:00:00Z',
      nowIso: NOW,
      cfg: CFG,
    });
    expect(md).toMatchSnapshot();
  });
});
