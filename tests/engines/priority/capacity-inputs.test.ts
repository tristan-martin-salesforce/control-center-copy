/**
 * Capacity inputs from the read model (src/server/datasource/db/capacity.ts) and GET /today's capacity on
 * the mock DataSource: the same engine numbers the db DataSource shows (example seed only).
 */
import { describe, expect, it } from 'vitest';
import { TodayHeader, type AgentRun, type Connector, type Draft, type WorkItemRecord } from '@/contract';
import { rankWork } from '@/engines/priority/rank';
import { agentStartedFor, capacityInputs, localDay, toContractCapacity, type CapacitySource } from '@/server/datasource/db/capacity';
import { priorityInputs, todayCapacity } from '@/server/datasource/db/rank';
import { MockDataSource } from '@/server/datasource/mock';
import { mockCapacity } from '@/server/datasource/mock/views';

const NOW = new Date('2026-11-05T16:00:00.000Z'); // 09:00 MT
const MT = -420;

function rec(id: string, over: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id,
    kind: 'task',
    state: 'open',
    title: id,
    effort: { youMin: 10, agentMin: 0 },
    startBy: null,
    due: null,
    createdAt: '2026-11-04T16:00:00.000Z',
    updatedAt: '2026-11-05T15:00:00.000Z',
    userLockedFields: [],
    runIds: [],
    ...over,
  } as WorkItemRecord;
}

function source(data: { workItems?: WorkItemRecord[]; drafts?: Partial<Draft>[]; connectors?: Partial<Connector>[]; agentRuns?: Partial<AgentRun>[] }): CapacitySource {
  const cols: Record<string, { id: string }[]> = {
    workItems: data.workItems ?? [],
    drafts: (data.drafts ?? []) as { id: string }[],
    connectors: (data.connectors ?? []) as { id: string }[],
    agentRuns: (data.agentRuns ?? []) as { id: string }[],
  };
  return {
    all: (col: string) => cols[col] ?? [],
    get: (col: string, id: string) => (cols[col] ?? []).find((x) => x.id === id),
    settings: () => ({}) as never,
  } as unknown as CapacitySource;
}

describe('capacityInputs (read model → engine)', () => {
  it('pins items whose start-by you set to today (a "Pull in"), in your timezone', () => {
    const today = localDay(NOW, MT);
    expect(new Date(today.startMs).toISOString()).toBe('2026-11-05T07:00:00.000Z');
    const m = source({
      workItems: [
        rec('pulled', { startBy: '2026-11-05T22:00:00.000Z', userLockedFields: ['startBy'] }),
        rec('engine-start', { startBy: '2026-11-05T22:00:00.000Z' }), // the engine's start-by, not yours
        rec('tomorrow', { startBy: '2026-11-06T16:00:00.000Z', userLockedFields: ['startBy'] }),
        rec('late-evening', { startBy: '2026-11-06T06:30:00.000Z', userLockedFields: ['startBy'] }), // 23:30 MT Thu
        rec('done', { state: 'done', startBy: '2026-11-05T22:00:00.000Z', userLockedFields: ['startBy'] }),
      ],
    });
    expect(capacityInputs(m, NOW, MT).pinnedToday).toEqual(['late-evening', 'pulled']);
  });

  it('turns Outbox approvals and re-auths into chores', () => {
    const m = source({
      drafts: [
        { id: 'd1', status: 'ready', workItemId: 'w1' },
        { id: 'd2', status: 'drafting', workItemId: 'w2' },
        { id: 'd3', status: 'ready', workItemId: null },
      ],
      connectors: [
        { id: 'vdp', label: 'VDP', state: 'auth_needed' },
        { id: 'slack', label: 'Slack', state: 'ok' },
        { id: 'org62', label: 'Org62', state: 'degraded' },
      ],
    });
    expect(capacityInputs(m, NOW, MT).chores).toEqual([
      { id: 'd1', kind: 'approve', title: 'Approve draft', workItemId: 'w1' },
      { id: 'd3', kind: 'approve', title: 'Approve draft', workItemId: null },
      { id: 'reauth:vdp', kind: 'reauth', title: 'Re-auth VDP', workItemId: null },
    ]);
  });

  it('reports runs in flight on live items as background agents', () => {
    const m = source({
      workItems: [rec('w1', { effort: { youMin: 10, agentMin: 90 } }), rec('w2', { state: 'done' })],
      agentRuns: [
        { id: 'r1', state: 'running', workItemId: 'w1', updatedAt: NOW.toISOString() },
        { id: 'r2', state: 'running', workItemId: null, updatedAt: NOW.toISOString() },
        { id: 'r3', state: 'queued', workItemId: 'w2', updatedAt: NOW.toISOString() },
        { id: 'r4', state: 'done', workItemId: 'w1', updatedAt: NOW.toISOString() },
      ],
    });
    expect(capacityInputs(m, NOW, MT).runningAgents).toEqual([{ id: 'r1', workItemId: 'w1', agentMinLeft: 90 }]);
  });

  it('collects recorded hands-on minutes (effort you set) as calibration actuals', () => {
    const m = source({
      workItems: [
        rec('a', { title: 'Reply to Dana', kind: 'ask', state: 'done', effort: { youMin: 4, agentMin: 0 }, userLockedFields: ['effort'] }),
        rec('b', { title: 'Review the deck', effort: { youMin: 12, agentMin: 0 }, userLockedFields: ['effort'] }),
        rec('c', { title: 'Reply to Sam', effort: { youMin: 30, agentMin: 0 } }), // an estimate, not an actual
        rec('d', { title: 'Reply to Ana', userLockedFields: ['effort'], updatedAt: '2026-08-01T00:00:00.000Z' }), // too old
      ],
    });
    expect(capacityInputs(m, NOW, MT).estimates?.actuals).toEqual([
      { estimateKind: 'reply', youMin: 4, source: 'completed', at: '2026-11-05T15:00:00.000Z' },
      { estimateKind: 'review', youMin: 12, source: 'correction', at: '2026-11-05T15:00:00.000Z' },
    ]);
  });

  it("counts an item's agent part as started only when a linked run was active after the item existed", () => {
    const started = new Set(['running', 'waiting_on_you', 'done_review', 'done']);
    const m = source({
      agentRuns: [
        { id: 'old', state: 'done_review', updatedAt: '2026-11-04T15:00:00.000Z' },
        { id: 'new', state: 'done_review', updatedAt: '2026-11-04T17:00:00.000Z' },
        { id: 'stale', state: 'stale', updatedAt: '2026-11-05T15:00:00.000Z' },
      ],
    });
    const w = (runIds: string[]) => rec('w', { createdAt: '2026-11-04T16:00:00.000Z', runIds });
    expect(agentStartedFor(w(['old']), m, started)).toBe(false); // the session went quiet before this next step existed
    expect(agentStartedFor(w(['new']), m, started)).toBe(true);
    expect(agentStartedFor(w(['stale']), m, started)).toBe(false);
    expect(agentStartedFor(w([]), m, started)).toBe(false);
  });
});

describe('GET /today capacity (mock DataSource, example seed)', () => {
  it('is the engine capacity in the contract shape, with the legacy fields filled consistently', async () => {
    const ds = new MockDataSource({ autoplay: false });
    try {
      const now = ds.now();
      ds.clock.freeze(now);
      const today = await ds.getToday({} as never);
      const c = today.header.capacity;
      expect(TodayHeader.shape.capacity.parse(c)).toEqual(c);
      expect(c.plannedMin).toBe(c.youMinToday);
      expect(c.focusMinLeft).toBe(c.freeMin);
      expect(c.overByMin).toBe(c.youMinToday - c.freeMin);
      expect(c.openMin).toBe(c.freeMin - c.youMinToday);
      expect(c.fits).toBe(c.youMinToday <= c.freeMin);
      // the same numbers as the engine on the same inputs (what the db DataSource shows)
      expect(c).toEqual(mockCapacity(ds.store, now));
      const model = { all: (k: string) => ds.store.all(k as never), get: (k: string, id: string) => ds.store.get(k as never, id), settings: () => ds.store.settings(), extra: { policyRowId: null, policyEngine: { obligation: 1.5, top3Size: 3 } } } as never;
      expect(c).toEqual(todayCapacity(model, now));
      expect(c).toEqual(toContractCapacity(rankWork(priorityInputs(model, ds.store.settings().policy, now)).capacity));
      // and it is not the old "sum every open item" number
      const allOpen = ds.store.all('workItems').filter((w) => ['open', 'in_progress', 'waiting_on_me'].includes(w.state)).reduce((s, w) => s + w.effort.youMin, 0);
      expect(c.youMinToday).toBeLessThan(allOpen);
    } finally {
      ds.dispose();
    }
  }, 30_000);
});
