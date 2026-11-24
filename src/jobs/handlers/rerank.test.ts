/** priority@2 R4/R8 jobs with fakes: the fingerprint hook, the re-rank job and the nightly feedback pass. */
import { describe, expect, it } from 'vitest';

import type { JobContext } from '../types';
import { priorityFeedbackJobDef } from './priority-feedback';
import { RERANK_JOB_KIND, rerankHook, rerankJobDef, type InputsFingerprint } from './rerank';

const ctx = (payload: Record<string, unknown> = {}) => ({ job: { payload }, userId: 'u1', db: {} as never, clock: () => new Date('2026-11-05T09:00:00Z'), log: () => undefined }) as unknown as JobContext;

describe('priority.rerank hook', () => {
  it('records a baseline first, then queues once per change (calendar changes tagged)', async () => {
    let fp: InputsFingerprint = { items: 'a', events: 'x' };
    const queued: string[] = [];
    const hook = rerankHook({} as never, 'u1', () => undefined, { fingerprint: async () => fp, enqueue: async (_db, _u, trigger) => (queued.push(trigger), { id: 1, inserted: true }) });
    await hook.run();
    expect(queued).toEqual([]);
    await hook.run();
    expect(queued).toEqual([]);
    fp = { items: 'b', events: 'x' };
    await hook.run();
    fp = { items: 'b', events: 'y' };
    await hook.run();
    await hook.run();
    expect(queued).toEqual(['new_info', 'calendar_change']);
  });

  it('a failing fingerprint is logged, never thrown', async () => {
    const logs: string[] = [];
    const hook = rerankHook({} as never, 'u1', (m) => logs.push(m), { fingerprint: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })) });
    await expect(hook.run()).resolves.toBeUndefined();
    expect(logs).toEqual(['priority re-rank hook failed']);
  });
});

describe('priority.rerank job', () => {
  it('ranks through the injected DataSource and stores counts only', async () => {
    const calls: string[] = [];
    const def = rerankJobDef({ rerank: async (u, t) => (calls.push(`${u}:${t}`), { top3: ['a', 'b', 'c'], changed: 4 }) });
    expect(def.kind).toBe(RERANK_JOB_KIND);
    expect(await def.handler(ctx({ trigger: 'calendar_change' }))).toEqual({ trigger: 'calendar_change', changed: 4, top3: 3 });
    expect(calls).toEqual(['u1:calendar_change']);
  });
});

describe('priority.feedback job', () => {
  it('runs the pass and stores counts only', async () => {
    const def = priorityFeedbackJobDef({ pass: async () => ({ rows: 12, suggested: 'deal:-1' }) });
    expect(await def.handler(ctx())).toEqual({ rows: 12, suggested: 1 });
  });
});
