/**
 * A background job's spend envelope (src/llm/spend/job-spend.ts, caps audit 26 F-4): the hold a job runs under (the
 * start gate's, a resumed one or its own), the ask past it, the continuation carrying it, and the answers.
 */
import { describe, expect, it } from 'vitest';

import { answerHold, finishJobSpend, gateJobStart, MemorySpendStore, RUNAWAY_TURNS, SPEND_ASK_RECHECK_S, spendContinuation, spendHoldIdOf, SpendGovernor, startJobSpend } from '@/llm/spend';

const T0 = new Date('2026-11-20T15:00:00.000Z');
const mk = (o: ConstructorParameters<typeof MemorySpendStore>[0] = {}) => {
  const store = new MemorySpendStore({ now: () => T0, today: () => '2026-11-20', ...o });
  return { store, gov: new SpendGovernor(store) };
};

describe('startJobSpend', () => {
  it('without a governor the job runs as before', async () => {
    expect(await startJobSpend(null, { id: 1, kind: 'brief.generate' }, { scope: 'job' })).toEqual({ kind: 'none' });
  });

  it("uses the hold the worker's start gate took for the job, and leaves its settle to the gate", async () => {
    const { gov, store } = mk();
    const g = await gateJobStart(gov, { id: 7, kind: 'brief.generate', payload: {} });
    expect(g.start && g.hold).toBeTruthy();
    const s = await startJobSpend(gov, { id: 7, kind: 'brief.generate', payload: {} }, { scope: 'job', skill: 'brief-opportunity' });
    expect(s).toMatchObject({ kind: 'run', owned: false, resumed: false });
    expect(s.kind === 'run' && s.gate.hold.id).toBe(g.start ? g.hold!.id : null);
    await finishJobSpend(gov, s, 0.01);
    expect([...store.holds.values()].map((h) => h.state)).toEqual(['open']);
  });

  it('takes its own hold when no gate did, and settles it with what it spent', async () => {
    const { gov, store } = mk();
    const s = await startJobSpend(gov, { id: 8, kind: 'use_cases.extract', payload: {} }, { scope: 'job' });
    expect(s).toMatchObject({ kind: 'run', owned: true });
    if (s.kind !== 'run') return;
    expect(s.gate.observe(0.01)).toBe('continue');
    await finishJobSpend(gov, s);
    const [h] = [...store.holds.values()];
    expect(h).toMatchObject({ state: 'settled', spentUsd: 0.01, jobKey: 'use_cases.extract:8' });
  });

  it("the day with no room for the hold: day_budget (the user budget stays a line)", async () => {
    const { gov } = mk({ day: () => ({ spentUsd: 14.99, softUsd: 5, hardUsd: 15 }) });
    expect(await startJobSpend(gov, { id: 9, kind: 'brief.generate' }, { scope: 'job' })).toEqual({ kind: 'day_budget' });
  });

  it('past the hold: ask once, the hold waits as asked, the continuation carries it; Allow resumes it, Stop ends it', async () => {
    const { gov, store } = mk();
    const s = await startJobSpend(gov, { id: 10, kind: 'brief.generate', payload: { trigger: 'schedule' } }, { scope: 'job' });
    if (s.kind !== 'run') throw new Error('no hold');
    expect(s.gate.observe(s.gate.hold.heldUsd + 0.01)).toBe('ask');
    await s.gate.ask({ pctDone: 40 });
    expect(s.gate.hold.state).toBe('asked');
    await finishJobSpend(gov, s);
    expect(store.holds.get(s.gate.hold.id)!.state).toBe('asked');
    const ev = [...store.events.values()].find((e) => e.code === 'SPEND.ASK');
    expect(ev?.message).toMatch(/^This job has used \$0\.\d+ of its \$0\.08 estimate and is 40% done; allow \$\d\.\d+ more\?$/);

    const c = spendContinuation({ kind: 'brief.generate', queue: 'brief', payload: { trigger: 'schedule', vars: { a: 1 } }, maxAttempts: 3 }, s.gate.hold);
    expect(c).toMatchObject({ kind: 'brief.generate', queue: 'brief', payload: { trigger: 'schedule', vars: { a: 1, spendHoldId: s.gate.hold.id } }, dedupeKey: `brief.generate:spend:${s.gate.hold.id}`, delaySeconds: SPEND_ASK_RECHECK_S, maxAttempts: 3 });
    expect(spendHoldIdOf(c.payload)).toBe(s.gate.hold.id);
    // the start gate does not hold a second time for the continuation
    expect(await gateJobStart(gov, { id: 11, kind: 'brief.generate', payload: c.payload })).toEqual({ start: true, hold: null });

    // unanswered: it waits again
    expect(await startJobSpend(gov, { id: 11, kind: 'brief.generate', payload: c.payload }, { scope: 'job' })).toMatchObject({ kind: 'waiting' });
    // Allow $Z more: it resumes the same hold, larger, and settles it at the end
    const requeued: string[] = [];
    await answerHold(gov, s.gate.hold.id, { answer: 'approve', usd: 0.1 }, { requeue: async (h) => void requeued.push(h.id) });
    expect(requeued).toEqual([s.gate.hold.id]);
    const r = await startJobSpend(gov, { id: 11, kind: 'brief.generate', payload: c.payload }, { scope: 'job' });
    expect(r).toMatchObject({ kind: 'run', owned: true, resumed: true });
    if (r.kind !== 'run') return;
    expect(r.gate.observe(0.01)).toBe('continue');
    await finishJobSpend(gov, r);
    expect(store.holds.get(s.gate.hold.id)!.state).toBe('settled');

    // Stop: a continuation of a stopped hold does nothing
    const s2 = await startJobSpend(gov, { id: 12, kind: 'brief.generate', payload: {} }, { scope: 'job' });
    if (s2.kind !== 'run') throw new Error('no hold');
    s2.gate.observe(1);
    await s2.gate.ask({ pctDone: null });
    await gov.answer(s2.gate.hold.id, { kind: 'deny' });
    expect(await startJobSpend(gov, { id: 13, kind: 'brief.generate', payload: spendContinuation({ kind: 'brief.generate', queue: 'brief' }, s2.gate.hold).payload }, { scope: 'job' })).toMatchObject({ kind: 'stopped' });
  });

  it('turns are a runaway guard once the money is held', () => {
    expect(RUNAWAY_TURNS).toBeGreaterThanOrEqual(200);
  });
});
