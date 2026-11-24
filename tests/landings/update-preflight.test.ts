/**
 * D-70 Event updates through the canvas preflight (2026-11-16, owner: "it says 8 updates go in and nothing to show,
 * then when I refresh it shows the updates above again"). The preflight's Duration rule was written for backfills
 * (Time (Hrs) never filled: go only while Org62's is blank). An update changes a Duration Org62 has already
 * (0.25 h → 3 h), so the rule dropped every update ~20 s after its canvas was staged: "# UPDATE (0 rows)", the writes
 * taken off, re-proposed, back in Log it, and never in Org62. Now an update goes while Org62 lacks the new value.
 * Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import { renderWorkOrder } from '@/engines/activity/slackbot';
import { canvasActionFor, canvasInputOf } from '@/lib/canvas/payload';
import { preflightCanvas } from '@/lib/canvas/preflight';

const BACKFILL = '00UXX0000000001AAA';
const UPDATE = '00UXX0000000002AAA';

function canvas() {
  const markdown = renderWorkOrder({
    ownerName: 'Placeholder SE',
    ownerOrg62Id: '005XX0000000001AAA',
    recordTypeId: '012XX0000000001AAA',
    generatedAt: '2026-11-16T16:57:51.000Z',
    sourceLabel: 'Command Center · Duration fixes',
    events: [],
    updates: [
      { recordId: BACKFILL, field: 'Duration__c', newValue: '1', currentValue: '(blank)', why: "Time (Hrs) never filled: End − Start of 'Placeholder call'" },
      { recordId: UPDATE, field: 'Duration__c', newValue: '3', currentValue: '0.25', why: 're-derived: engaged 3 h (38 prompts, 16 Slack messages; claude_hands_on)' },
    ],
  } as never);
  return canvasInputOf(canvasActionFor({ title: 'Activity log · Duration fixes · 2 updates', markdown, eventIds: [], hours: 0, updates: 2, updateIds: [BACKFILL, UPDATE], part: 1, parts: 1 }));
}

const org62 = (m: Record<string, number | null>) => ({ org62Event: (id: string) => (id in m ? { durationField: m[id]!, deleted: false } : null) });

describe('Event updates survive the canvas preflight', () => {
  it('an update from 0.25 h to 3 h stays while Org62 still has 0.25 h (it used to be dropped as "filled already")', () => {
    const pf = preflightCanvas(canvas(), org62({ [BACKFILL]: null, [UPDATE]: 0.25 }));
    expect(pf.changed).toBe(false);
    expect(pf.input.markdown).toContain('## EVENTS TO UPDATE (2 rows)');
  });

  it('it goes once Org62 has 3 h already; a backfill still goes once Org62’s Duration is filled', () => {
    const pf = preflightCanvas(canvas(), org62({ [BACKFILL]: 1.5, [UPDATE]: 3 }));
    expect(pf.dropped.map((d) => [d.ref, d.reason])).toEqual([
      [BACKFILL, 'Duration__c is filled in Org62 already'],
      [UPDATE, 'Org62 has this Duration already'],
    ]);
    expect(pf.empty).toBe(true);
  });

  it('Org62 changed it to something else meanwhile: the update still goes (your approved value wins)', () => {
    const pf = preflightCanvas(canvas(), org62({ [BACKFILL]: null, [UPDATE]: 1 }));
    expect(pf.changed).toBe(false);
  });
});
