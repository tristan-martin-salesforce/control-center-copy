/** Which downstream steps re-run for what changed (status, priority, NBA, draft, brief). */
import { describe, expect, it } from 'vitest';
import { planReeval, pruneAfterStatus, REEVAL_STEPS, type PlannerItem } from '@/engines/reeval/planner';
import { CHANGE_KINDS, WORK_ITEM_STATUSES } from '@/engines/types';
import { int, pick, rng } from '../priority/fixtures';

const owned: PlannerItem = { status: 'in_progress', involvement: 'owner', hasDraft: true, draftUserLocked: false };
const handedOff: PlannerItem = { status: 'done', resolution: 'handed_off', involvement: 'watcher', hasDraft: true, draftUserLocked: false };
const steps = (p: ReturnType<typeof planReeval>) => p.steps.map((s) => s.step);

describe('planReeval', () => {
  it('context-only evidence on a handed-off item recomputes only the brief, never the NBA', () => {
    const p = planReeval(['evidence_context'], handedOff);
    expect(steps(p)).toEqual(['brief']);
    expect(p.skipped).toContainEqual({ step: 'nba', reason: 'Handed off / not involved: context only' });
    expect(steps(planReeval(['evidence_completion', 'requirements_change'], handedOff))).toEqual(['brief']);
  });

  it('a direct ask (loop-back) on a handed-off item re-runs everything', () => {
    expect(steps(planReeval(['loop_back'], { ...handedOff, status: 'in_progress' }))).toEqual(['status', 'priority', 'nba', 'draft']);
  });

  it('status-moving evidence on an owned item re-runs status, priority, NBA and the draft', () => {
    const p = planReeval(['evidence_completion'], owned);
    expect(p.steps).toEqual([
      { step: 'status', mode: 'write', because: ['evidence_completion'] },
      { step: 'priority', mode: 'write', because: ['evidence_completion'] },
      { step: 'nba', mode: 'write', because: ['evidence_completion'] },
      { step: 'draft', mode: 'write', because: ['evidence_completion'] },
    ]);
  });

  it('a draft the user touched is proposed, never rewritten', () => {
    expect(planReeval(['evidence_context'], { ...owned, draftUserLocked: true }).steps.find((s) => s.step === 'draft')).toEqual({ step: 'draft', mode: 'propose', because: ['evidence_context'] });
  });

  it('skips the draft step when there is no draft', () => {
    const p = planReeval(['reply'], { ...owned, hasDraft: false });
    expect(steps(p)).toEqual(['status', 'priority', 'nba']);
    expect(p.skipped.map((s) => s.step)).toEqual(['draft']);
  });

  it.each([
    [['policy_changed'], ['priority']],
    [['calendar_changed'], ['priority', 'nba', 'draft']],
    [['user_edit_schedule'], ['priority']],
    [['user_edit_content'], ['nba', 'draft']],
    [['draft_edited'], []],
    [['evidence_context'], ['nba', 'draft', 'brief']],
    [['policy_changed', 'evidence_context'], ['priority', 'nba', 'draft', 'brief']],
  ] as const)('%o → %o', (changes, expected) => {
    expect(steps(planReeval([...changes], owned))).toEqual(expected);
  });

  it('a Triage suggestion only re-checks status', () => {
    expect(steps(planReeval(['evidence_progress', 'calendar_changed'], { ...owned, status: 'suggested' }))).toEqual(['status']);
  });

  it('a closed item of mine re-checks status (reopen / sibling) and priority, NBA only if it comes back', () => {
    const done: PlannerItem = { status: 'done', resolution: 'done_by_me', involvement: 'owner', hasDraft: true, draftUserLocked: false };
    const p = planReeval(['requirements_change'], done);
    expect(steps(p)).toEqual(['status', 'priority']);
    expect(steps(pruneAfterStatus(p, 'done', 'done', done))).toEqual(['status', 'priority']);
    expect(steps(pruneAfterStatus(p, 'done', 'open', done))).toEqual(['status', 'priority', 'nba', 'draft']);
  });

  it('drops NBA and draft once the status step closes the item', () => {
    const p = planReeval(['email_sent'], owned);
    const pruned = pruneAfterStatus(p, 'in_progress', 'done', owned);
    expect(steps(pruned)).toEqual(['status', 'priority']);
    expect(pruned.skipped).toContainEqual({ step: 'nba', reason: 'Now done: NBA completed or superseded' });
  });

  it('properties: canonical order, no duplicates, and handed-off items never get an NBA without a direct ask', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const changes = Array.from({ length: int(r, 0, 5) }, () => pick(r, CHANGE_KINDS));
      const item: PlannerItem = {
        status: pick(r, WORK_ITEM_STATUSES),
        resolution: pick(r, [null, 'done_by_me', 'handed_off', 'done_by_other', 'declined'] as const),
        involvement: pick(r, ['owner', 'contributor', 'watcher', 'not_involved'] as const),
        hasDraft: r() < 0.5,
        draftUserLocked: r() < 0.3,
      };
      const p = planReeval(changes, item);
      const s = steps(p);
      expect(s).toEqual(REEVAL_STEPS.filter((x) => s.includes(x)));
      expect(new Set(s).size).toBe(s.length);
      const notMine = item.resolution === 'handed_off' || item.resolution === 'done_by_other' || item.resolution === 'declined' || item.involvement === 'watcher' || item.involvement === 'not_involved';
      if (notMine && !changes.includes('loop_back')) expect(s.filter((x) => x !== 'brief')).toEqual([]);
      if (!item.hasDraft) expect(s).not.toContain('draft');
      for (const st of p.steps) if (st.step === 'draft') expect(st.mode).toBe(item.draftUserLocked ? 'propose' : 'write');
      if (changes.length === 0) expect(s).toEqual([]);
    }
  });
});
