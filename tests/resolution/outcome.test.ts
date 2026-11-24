/** Outcomes onto the closure machine / Settle policy, mayAutoClose, and the W0-4 reopen brakes. */
import { describe, expect, it } from 'vitest';

import { applySignal } from '@/engines/closure/machine';
import { signalFromEvidence } from '@/engines/closure/signals';
import { reopenBrake } from '@/engines/closure/correction';
import { runLadder } from '@/engines/resolution/ladder';
import { planOutcome } from '@/engines/resolution/outcome';
import { buildResolutionPack } from '@/engines/resolution/pack';

import { NOW, at, item, line, mine, raw, scripted, settings, SKILL } from './fixtures';

const DECK = 'here it is https://docs.google.com/presentation/d/FILE_PLACEHOLDER_01/edit';

async function decide(r: ReturnType<typeof raw>, i: ReturnType<typeof item>, answer: Record<string, unknown> = { verdict: 'not_done', basis: 'none', confidence: 0.2 }) {
  const { model } = scripted(() => answer);
  const pack = buildResolutionPack(r, { now: NOW, timezone: 'UTC', me: 'me' });
  const [d] = await runLadder([{ item: i, pack, raw: r }], { model, skill: SKILL, now: NOW, me: 'me' });
  return planOutcome(i, d!, pack, settings(), NOW);
}

describe('done → the closure machine', () => {
  it('a Sure delivery closes for me, with completion evidence citing my line', async () => {
    const r = raw({ after: [mine(5, DECK)] });
    const p = await decide(r, item());
    expect(p.outcome).toBe('closed');
    expect(p.evidence).toMatchObject({ role: 'completion', confidence: 'sure', sourceItemId: r.conversation[0]!.id });
    expect(p.evidence!.reason).toMatch(/^resolution: D1/);
  });

  it('R1: an item the user corrected only asks (Likely done), and says why', async () => {
    const p = await decide(raw({ after: [mine(5, DECK)] }), item({ mayAutoClose: false }));
    expect(p.outcome).toBe('likely');
    expect(p.blockedBy).toBe('user_reopened');
  });

  it('a partial is progress, the item stays open', async () => {
    const r = raw({ after: [mine(5, 'Attached the first half of the deck notes; the pricing appendix follows once finance signs off on the numbers.')] });
    const p = await decide(r, item(), { verdict: 'partial', basis: 'none', cite: 'c1', confidence: 0.7, needs: 'the pricing appendix' });
    expect(p).toMatchObject({ outcome: 'left', evidence: { role: 'progress' } });
  });
});

describe('everything else → Settle’s policy (no new status vocabulary)', () => {
  it('still yours → left; done by someone else → closed; not needed with a low confidence → asks or leaves', async () => {
    expect((await decide(raw(), item())).outcome).toBe('left');
    const other = raw({ after: [line(30, 'PERSON_B already sent the pricing deck to the team', { author: 'PERSON_B' })] });
    expect((await decide(other, item(), { verdict: 'done_by_other', basis: 'done_by_other', cite: 'c1', confidence: 0.9 })).outcome).toBe('closed');
    const weak = await decide(raw(), item(), { verdict: 'not_needed', basis: 'resolved', confidence: 0.45 });
    expect(['asked', 'left']).toContain(weak.outcome);
  });
});

describe('W0-4: no reopen → re-close flip-flop', () => {
  it('a reopened item is not re-closed on the evidence the reopen overruled', async () => {
    const r = raw({ after: [mine(5, DECK)] });
    const p = await decide(r, item({ reopenedCount: 1, lastReopenAt: at(60) }));
    expect(p).toMatchObject({ outcome: 'left', blockedBy: 'evidence_before_reopen' });
    // new evidence after the reopen may close it again
    const r2 = raw({ after: [mine(5, DECK), mine(90, 'here is the working link https://docs.google.com/presentation/d/FILE_PLACEHOLDER_02/edit')] });
    expect((await decide(r2, item({ reopenedCount: 1, lastReopenAt: at(60) }))).outcome).toBe('closed');
  });

  it('after two reopens the item is ask-only: the third close asks instead, and says so', async () => {
    const r = raw({ after: [mine(90, DECK)] });
    const p = await decide(r, item({ reopenedCount: 2, lastReopenAt: at(60) }));
    expect(p.outcome).toBe('likely');
    expect(p.blockedBy).toBe('reopened_twice');
    expect(p.evidence?.confidence).toBe('likely');
    const s = await decide(raw(), item({ reopenedCount: 2 }), { verdict: 'done_by_other', basis: 'done_by_other', cite: 'a1', confidence: 0.95 });
    expect(s.outcome).not.toBe('closed');
  });

  it('the closure machine itself brakes the same way (the legacy closers, while shadow keeps them running)', () => {
    expect(reopenBrake({ reopenedCount: 2 }, at(100))).toBe('reopened_twice');
    expect(reopenBrake({ reopenedCount: 1, lastReopenedAt: at(60) }, at(30))).toBe('evidence_before_reopen');
    expect(reopenBrake({ reopenedCount: 1, lastReopenedAt: at(60) }, at(90))).toBeNull();
    const base = { id: 'w1', version: 1, kind: 'ask' as const, status: 'open' as const, title: 'Send the deck', resolution: null, involvement: 'owner' as const };
    const sig = signalFromEvidence({ id: 'e1', role: 'completion', confidence: 'sure', reason: 'done_check: sent it', at: at(30), linkedAt: at(31), source: 'slack', actor: { name: 'me', isMe: true } });
    expect(applySignal({ ...base }, sig).transition?.to).toBe('done');
    expect(applySignal({ ...base, reopenedCount: 1, lastReopenedAt: at(60) }, sig).transition?.to).toBe('likely_done');
    expect(applySignal({ ...base, reopenedCount: 2 }, sig).transition?.to).toBe('likely_done');
  });
});

describe('a chase after a close for me reopens it (R2), through the machine', () => {
  it('done + the asker chasing after the close → reopened', async () => {
    const r = raw({ status: 'done', after: [mine(5, DECK), line(600, "that link doesn't open, can you re-share it?")] });
    const p = await decide(r, item({ status: 'done', doneAt: at(5) }));
    expect(p.outcome).toBe('reopened');
    expect(p.evidence).toMatchObject({ role: 'contradiction' });
    expect(p.evidence!.reason).toMatch(/^follow_up: /);
  });
  it('done + chatter (no chase) → left closed', async () => {
    const r = raw({ status: 'done', after: [mine(5, DECK), line(600, 'perfect, thanks!')] });
    expect((await decide(r, item({ status: 'done', doneAt: at(5) }))).outcome).toBe('left');
  });
});
