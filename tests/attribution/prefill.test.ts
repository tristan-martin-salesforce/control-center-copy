/**
 * The use-case canvas pre-fill (src/lib/canvas/prefill.ts): a VDP use case whose opp is not settled asks which opp it
 * goes on; the engine orders the choices (the use case's words against the opps' names, my engagement) and names one
 * only when it prefers it. Never applied for you (D-70).
 */
import { describe, expect, it } from 'vitest';

import type { UcOpp } from '@/engines/activity/use-cases';
import { rankUseCaseOpps } from '@/lib/canvas/prefill';

const o = (id: string, name: string): UcOpp => ({ id, org62Id: `006SMPL0000000${id}AAA`, name, accountId: 'acc-s', accountOrg62Id: '001SMPL00000001AAA', isOpen: true, dcSplit: 100, closeDate: '2026-12-31' });
const opps = [o('01', 'Saltmere Health Plan - Data 360 + Agentforce Member Services POC'), o('02', 'Saltmere Health Plan - Claims Intake Copilot Phase 2')];

describe('the use-case opp pre-fill', () => {
  it('a use case that names an opp’s own words puts that opp first and suggests it, with why', () => {
    const p = rankUseCaseOpps({ title: 'Claims intake triage copilot', companyName: 'Saltmere Health Plan', accountId: 'acc-s' }, opps);
    expect(p.ordered.map((x) => x.id)).toEqual(['02', '01']);
    expect(p.suggested?.org62Id).toBe(opps[1]!.org62Id);
    expect(p.suggested?.why).toMatch(/claims|intake|copilot/);
  });

  it('words that tell no opp apart: the VDP’s own order, no suggestion (never a guess)', () => {
    const p = rankUseCaseOpps({ title: 'Unified profile', companyName: 'Saltmere Health Plan', accountId: 'acc-s' }, opps);
    expect(p.ordered.map((x) => x.id)).toEqual(['01', '02']);
    expect(p.suggested).toBeNull();
  });

  it('my engagement breaks the tie when the words do not', () => {
    const p = rankUseCaseOpps({ title: 'Unified profile', accountId: 'acc-s' }, opps, { engagement: { '02': { lastTouchAt: '2026-11-17T16:00:00.000Z', touches4w: 6, hours4w: 4 } }, today: '2026-11-18' });
    expect(p.ordered[0]!.id).toBe('02');
    expect(p.suggested?.why).toMatch(/worked on it lately/);
  });
});
