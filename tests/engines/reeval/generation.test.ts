/** Re-eval orchestration: coalescing, generation bump + cancel, the commit fence, and races. */
import { describe, expect, it } from 'vitest';
import { coalesce, nextGeneration, reevalDedupeKey, shouldCommit, type JobState } from '@/engines/reeval/generation';
import { CHANGE_KINDS, type ChangeKind, type ReevalEvent } from '@/engines/types';
import { int, pick, rng } from '../priority/fixtures';

const T0 = Date.parse('2026-11-05T15:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe('coalesce: bursts become one job per item', () => {
  it('merges a burst inside the debounce into one job that runs after the last event', () => {
    const events: ReevalEvent[] = [
      { workItemId: 'w1', at: at(0), change: 'evidence_context', evidenceId: 'e1' },
      { workItemId: 'w1', at: at(500), change: 'evidence_progress', evidenceId: 'e2' },
      { workItemId: 'w1', at: at(1200), change: 'evidence_context', evidenceId: 'e3' },
    ];
    expect(coalesce(events, 2000, { baseGenerations: { w1: 4 } })).toEqual([
      {
        dedupeKey: 'reeval:work_item:w1',
        workItemId: 'w1',
        runAt: at(3200),
        generation: 7,
        changes: ['evidence_progress', 'evidence_context'],
        eventCount: 3,
        firstEventAt: at(0),
        lastEventAt: at(1200),
        evidenceIds: ['e1', 'e2', 'e3'],
      },
    ]);
  });

  it('splits on a quiet gap longer than the debounce, and per item', () => {
    const jobs = coalesce(
      [
        { workItemId: 'w2', at: at(100), change: 'reply' },
        { workItemId: 'w1', at: at(0), change: 'reply' },
        { workItemId: 'w1', at: at(5000), change: 'email_sent' },
      ],
      2000,
    );
    expect(jobs.map((j) => [j.workItemId, j.eventCount, j.runAt, j.generation])).toEqual([
      ['w1', 1, at(2000), 1],
      ['w2', 1, at(2100), 1],
      ['w1', 1, at(7000), 2],
    ]);
  });

  it('caps a steady stream at maxWait so it cannot starve the item', () => {
    const events = Array.from({ length: 30 }, (_, i): ReevalEvent => ({ workItemId: 'w1', at: at(i * 1000), change: 'evidence_context' }));
    const jobs = coalesce(events, 2000, { maxWaitMs: 10_000 });
    expect(jobs.length).toBe(3);
    for (const j of jobs) expect(Date.parse(j.runAt) - Date.parse(j.firstEventAt)).toBeLessThanOrEqual(10_000);
  });

  it('uses the generation the save step recorded when events carry one', () => {
    const jobs = coalesce(
      [
        { workItemId: 'w1', at: at(0), change: 'reply', generation: 11 },
        { workItemId: 'w1', at: at(10), change: 'reply', generation: 12 },
      ],
      1000,
    );
    expect(jobs[0]!.generation).toBe(12);
  });

  it('properties: every event lands in exactly one job; jobs per item are ordered and non-overlapping', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const debounce = pick(r, [0, 250, 1000, 5000]);
      const events: ReevalEvent[] = Array.from({ length: int(r, 0, 40) }, (_, i) => ({
        workItemId: `w${int(r, 1, 4)}`,
        at: at(int(r, 0, 60_000)),
        change: pick(r, CHANGE_KINDS),
        evidenceId: `e${i}`,
      }));
      const jobs = coalesce(events, debounce);
      expect(jobs.reduce((s, j) => s + j.eventCount, 0)).toBe(events.length);
      expect(jobs.flatMap((j) => j.evidenceIds).sort()).toEqual(events.map((e) => e.evidenceId!).sort());
      const byItem = new Map<string, typeof jobs>();
      for (const j of jobs) byItem.set(j.workItemId, [...(byItem.get(j.workItemId) ?? []), j]);
      for (const list of byItem.values()) {
        list.sort((a, b) => a.generation - b.generation);
        for (let i = 0; i < list.length; i++) {
          const j = list[i]!;
          expect(j.dedupeKey).toBe(reevalDedupeKey(j.workItemId));
          expect(Date.parse(j.runAt)).toBeGreaterThanOrEqual(Date.parse(j.lastEventAt));
          expect(Date.parse(j.runAt) - Date.parse(j.lastEventAt)).toBeLessThanOrEqual(debounce);
          if (i > 0) {
            expect(Date.parse(j.firstEventAt)).toBeGreaterThan(Date.parse(list[i - 1]!.lastEventAt));
            expect(j.generation).toBeGreaterThan(list[i - 1]!.generation);
          }
        }
      }
    }
  }, 60_000); // hundreds of generated schedules; slow under a loaded full-suite run
});

describe('nextGeneration: new info during a run', () => {
  const item = { id: 'w1', reevalGeneration: 5, version: 9, unseenEvidenceCount: 1, lastNewInfoAt: at(-60_000) };

  it('bumps the generation, marks new info, and enqueues', () => {
    const n = nextGeneration(item, { jobs: [], now: at(0), debounceMs: 2000, change: 'evidence_context' });
    expect(n).toEqual({
      generation: 6,
      itemPatch: { reevalGeneration: 6, lastNewInfoAt: at(0), unseenEvidenceCount: 2 },
      cancel: [],
      supersede: [],
      enqueue: { mode: 'insert', jobId: null, dedupeKey: 'reeval:work_item:w1', generation: 6, runAt: at(2000), supersedesRunning: true, changes: ['evidence_context'] },
    });
  });

  it('requests cancel of the running job and supersedes it', () => {
    const running: JobState = { id: 'j1', workItemId: 'w1', status: 'running', generation: 5, runAt: at(-5000), baseVersion: 9 };
    const n = nextGeneration(item, { jobs: [running], now: at(0), debounceMs: 2000, change: 'reply' });
    expect(n.cancel).toEqual([{ jobId: 'j1', reason: 'superseded by generation 6' }]);
    expect(n.supersede).toEqual(['j1']);
    expect(n.enqueue.mode).toBe('insert');
    // The running job's result is now fenced out.
    expect(shouldCommit(running, { reevalGeneration: n.generation, version: 9 })).toMatchObject({ commit: false, reason: 'stale_generation' });
  });

  it('coalesces into the queued job and pushes its run out (debounce)', () => {
    const queued: JobState = { id: 'j2', workItemId: 'w1', status: 'queued', generation: 5, runAt: at(1500), changes: ['evidence_context'] };
    const n = nextGeneration(item, { jobs: [queued], now: at(1000), debounceMs: 2000, change: 'requirements_change' });
    expect(n.enqueue).toMatchObject({ mode: 'coalesce', jobId: 'j2', generation: 6, runAt: at(3000), changes: ['evidence_context', 'requirements_change'] });
    expect(n.cancel).toEqual([]);
  });

  it('does not count a policy or calendar change as new info on the item', () => {
    const n = nextGeneration(item, { jobs: [], now: at(0), debounceMs: 0, change: 'policy_changed' });
    expect(n.itemPatch).toEqual({ reevalGeneration: 6, lastNewInfoAt: at(-60_000), unseenEvidenceCount: 1 });
  });

  it("ignores other items' jobs and jobs already asked to cancel", () => {
    const jobs: JobState[] = [
      { id: 'x', workItemId: 'w2', status: 'running', generation: 1, runAt: at(0) },
      { id: 'y', workItemId: 'w1', status: 'running', generation: 4, runAt: at(0), cancelRequestedAt: at(-10) },
    ];
    expect(nextGeneration(item, { jobs, now: at(0), debounceMs: 0, change: 'reply' }).cancel).toEqual([]);
  });
});

describe('shouldCommit: the W3 fence', () => {
  const item = { reevalGeneration: 6, version: 10 };
  it.each([
    [{ generation: 6, baseVersion: 10 }, { commit: true, reason: 'ok', retry: false }],
    [{ generation: 6 }, { commit: true, reason: 'ok', retry: false }],
    [{ generation: 5, baseVersion: 10 }, { commit: false, reason: 'stale_generation', retry: false }],
    [{ generation: 7, baseVersion: 10 }, { commit: false, reason: 'future_generation', retry: false }],
    [{ generation: 6, baseVersion: 9 }, { commit: false, reason: 'version_conflict', retry: true }],
    [{ generation: 6, baseVersion: 10, cancelRequestedAt: at(0) }, { commit: false, reason: 'cancel_requested', retry: false }],
  ])('%o → %o', (job, verdict) => {
    expect(shouldCommit(job, item)).toEqual(verdict);
  });
});

describe('generation / cancel races (simulated worker, 400 random schedules)', () => {
  type Op = 'new_info' | 'user_edit' | 'dequeue' | 'finish' | 'tick';
  const OPS: Op[] = ['new_info', 'new_info', 'user_edit', 'dequeue', 'dequeue', 'finish', 'finish', 'tick'];

  it('only the latest generation ever commits, once, and the final state is always evaluated', () => {
    const seen: Record<string, number> = {};
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const debounce = pick(r, [0, 1000, 3000]);
      let clock = 0;
      let nextId = 1;
      const item = { id: 'w1', reevalGeneration: 0, version: 1, unseenEvidenceCount: 0, lastNewInfoAt: null as string | null };
      const jobs: JobState[] = [];
      const commits: Array<{ generation: number; itemGeneration: number }> = [];

      const newInfo = (change: ChangeKind) => {
        const n = nextGeneration(item, { jobs, now: at(clock), debounceMs: debounce, change });
        Object.assign(item, n.itemPatch);
        for (const c of n.cancel) jobs.find((j) => j.id === c.jobId)!.cancelRequestedAt = at(clock);
        if (n.enqueue.mode === 'coalesce') Object.assign(jobs.find((j) => j.id === n.enqueue.jobId)!, { generation: n.enqueue.generation, runAt: n.enqueue.runAt, changes: n.enqueue.changes });
        else jobs.push({ id: `j${nextId++}`, workItemId: 'w1', status: 'queued', generation: n.enqueue.generation, runAt: n.enqueue.runAt, changes: n.enqueue.changes });
      };
      const dequeue = () => {
        if (jobs.some((j) => j.status === 'running')) return; // a key never runs twice at once
        const q = jobs.find((j) => j.status === 'queued' && Date.parse(j.runAt) <= T0 + clock);
        if (q) Object.assign(q, { status: 'running', baseVersion: item.version });
      };
      const finish = () => {
        const j = jobs.find((x) => x.status === 'running');
        if (!j) return;
        const v = shouldCommit(j, item);
        seen[v.reason] = (seen[v.reason] ?? 0) + 1;
        if (v.commit) {
          commits.push({ generation: j.generation, itemGeneration: item.reevalGeneration });
          item.version++; // the engine's write bumps the row version
          j.status = 'succeeded';
        } else if (v.retry && !jobs.some((x) => x.status === 'queued')) {
          Object.assign(j, { status: 'queued', runAt: at(clock), cancelRequestedAt: null }); // re-read and re-run
        } else j.status = 'cancelled';
      };

      for (let step = 0; step < 60; step++) {
        const op = pick(r, OPS);
        if (op === 'new_info') newInfo(pick(r, CHANGE_KINDS));
        else if (op === 'user_edit') item.version++;
        else if (op === 'dequeue') dequeue();
        else if (op === 'finish') finish();
        else clock += int(r, 100, 4000);
        // At most one queued and one running job for the key at any time.
        expect(jobs.filter((j) => j.status === 'queued').length).toBeLessThanOrEqual(1);
        expect(jobs.filter((j) => j.status === 'running').length).toBeLessThanOrEqual(1);
      }
      // Drain: no more new info.
      for (let guard = 0; guard < 50 && jobs.some((j) => j.status === 'queued' || j.status === 'running'); guard++) {
        clock += debounce + 1;
        dequeue();
        finish();
      }
      for (const c of commits) expect(c.generation).toBe(c.itemGeneration);
      expect(new Set(commits.map((c) => c.generation)).size).toBe(commits.length);
      if (item.reevalGeneration > 0) expect(commits.at(-1)?.generation).toBe(item.reevalGeneration);
    }
    // Every race outcome was exercised.
    for (const reason of ['ok', 'cancel_requested', 'version_conflict']) expect(seen[reason] ?? 0, reason).toBeGreaterThan(0);
  }, 60_000); // hundreds of generated schedules; slow under a loaded full-suite run
});
