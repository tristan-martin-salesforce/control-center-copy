/**
 * A VDP push in the background (2026-11-16, owner: "I clicked push to VDP and it's stuck loading"): staging 133 items
 * held the confirm dialog 4½ minutes before the worker started. The worker now stages each item right before it
 * pushes it, under a fixed id (a push resumed after a restart never stages one twice), counts what it applied before
 * a restart as applied (never sent again), saves its progress as items land, and a push whose job ended reads as
 * stopped. VDP takes one push at a time (the route refuses a second while one runs: tests/db/vdp/push-db.test.ts).
 */
import { describe, expect, it } from 'vitest';

import type { ActionDestination, Draft, VdpPushRun } from '../../src/contract';
import { activePushOf, PUSH_PROGRESS_SAVE_MS, publicPushRun, runVdpPush, settlePushRuns, stageIdFor, type VdpPushPort } from '../../src/server/vdp/push';
import { pushRunView } from '../../src/components/time/vdp-push-derive';

const T0 = Date.parse('2026-11-16T16:38:00.000Z');
const dest = (n: number) => ({ kind: 'action', action: 'vdp.add_asset', target: { label: `Asset ${n}` }, input: {} }) as unknown as ActionDestination;
const node = (n: number, o: Partial<VdpPushRun['nodes'][number]> = {}) => ({ key: `k${n}`, title: `Item ${n}`, companyName: 'Placeholder Co', op: 'add_vdp_asset', requires: [], draftId: null, state: 'queued' as const, detail: null, externalId: null, slug: null, at: null, ...o });

function fake(o: { drafts?: Array<Partial<Draft> & { id: string }>; stepMs?: number } = {}) {
  let t = 0;
  const drafts = new Map<string, Draft>((o.drafts ?? []).map((d) => [d.id, { status: 'ready', externalId: null, resultUrl: null, ...d } as unknown as Draft]));
  const staged: string[] = [];
  const delivered: string[] = [];
  const saves: VdpPushRun[] = [];
  const port: VdpPushPort = {
    now: () => new Date(T0 + t),
    state: async () => ({ coverage: {} as never, snapshots: [], drafts: new Map(), duplicateOf: null }) as never,
    draft: async (id) => drafts.get(id) ?? null,
    stage: async (d, so) => {
      const id = so?.id ?? `random-${drafts.size}`;
      if (drafts.has(id)) return drafts.get(id)!;
      const draft = { id, status: 'ready', destination: d, externalId: null, resultUrl: null } as unknown as Draft;
      drafts.set(id, draft);
      staged.push(id);
      return draft;
    },
    discard: async () => {},
    deliver: async (draft) => {
      t += o.stepMs ?? 7_000;
      delivered.push(draft.id);
      drafts.set(draft.id, { ...draft, status: 'verified' } as Draft);
      return { outcome: 'applied', externalId: null, link: null, detail: null };
    },
    progress: async (run) => {
      saves.push(JSON.parse(JSON.stringify(run)) as VdpPushRun);
    },
  };
  return { port, drafts, staged, delivered, saves };
}

const run = (nodes: VdpPushRun['nodes'], stage: VdpPushRun['stage'] = []): VdpPushRun => ({ id: 'push-1', at: new Date(T0).toISOString(), dryRun: false, state: 'queued', nodes, finishedAt: null, stage });

describe('the worker stages a push as it goes', () => {
  it('stages each item right before it pushes it, under a fixed id per push and item, and clears the list when done', async () => {
    const f = fake();
    const r0 = run([node(1), node(2)], [{ key: 'k1', dest: dest(1), replaces: null }, { key: 'k2', dest: dest(2), replaces: null }]);
    const out = await runVdpPush(f.port, r0);
    expect(f.staged).toEqual([stageIdFor('push-1', 'k1'), stageIdFor('push-1', 'k2')]);
    expect(f.delivered).toEqual(f.staged);
    expect(out.nodes.map((n) => [n.state, n.draftId])).toEqual([
      ['applied', stageIdFor('push-1', 'k1')],
      ['applied', stageIdFor('push-1', 'k2')],
    ]);
    expect(out.state).toBe('done');
    expect(out.stage).toBeUndefined(); // the 133 destinations never stay in the kv
  });

  it('a push resumed after a restart: what it staged is found (not staged twice), what it applied is applied (not sent again)', async () => {
    // before the restart: item 1 staged and applied, item 2 staged, not sent; the kv still says both queued
    const f = fake({ drafts: [{ id: stageIdFor('push-1', 'k1'), status: 'verified', destination: dest(1) }, { id: stageIdFor('push-1', 'k2'), status: 'ready', destination: dest(2) }] });
    const out = await runVdpPush(f.port, run([node(1), node(2)], [{ key: 'k1', dest: dest(1), replaces: null }, { key: 'k2', dest: dest(2), replaces: null }]));
    expect(f.staged).toEqual([]);
    expect(f.delivered).toEqual([stageIdFor('push-1', 'k2')]);
    expect(out.nodes.map((n) => n.state)).toEqual(['applied', 'applied']);
    expect(out.nodes[0]!.detail).toMatch(/before the worker restarted/);
  });

  it('saves its progress as items land, at most every 20 s (Push runs shows it moving; History stays small)', async () => {
    const f = fake({ stepMs: 7_000 });
    const nodes = Array.from({ length: 12 }, (_, i) => node(i + 1));
    await runVdpPush(f.port, run(nodes, nodes.map((n, i) => ({ key: n.key, dest: dest(i + 1), replaces: null }))));
    // the start, a save about every 20 s of items (7 s each), the end
    const mid = f.saves.slice(1, -1);
    expect(mid.length).toBeGreaterThanOrEqual(3);
    expect(mid.length).toBeLessThanOrEqual(12 / Math.floor(PUSH_PROGRESS_SAVE_MS / 7_000));
    expect(mid.map((s) => s.nodes.filter((n) => n.state === 'applied').length)).toEqual([...mid.map((s) => s.nodes.filter((n) => n.state === 'applied').length)].sort((a, b) => a - b));
  });
});

describe('a push whose job ended is stopped', () => {
  const r = run([node(1, { state: 'applied' }), node(2, { state: 'running' }), node(3)]);
  const now = T0 + 60 * 60_000;

  it('its job dead or cancelled: stopped, what it had not done reads as not pushed, and it no longer holds new pushes', () => {
    for (const status of ['dead', 'cancelled', 'succeeded']) {
      const [s] = settlePushRuns([r], new Map([['push-1', status]]), now);
      expect(s!.state).toBe('stopped');
      expect(s!.nodes.map((n) => n.state)).toEqual(['applied', 'skipped', 'skipped']);
      expect(s!.nodes[2]!.detail).toMatch(/push stopped/);
      expect(activePushOf([s!])).toBeNull();
      expect(pushRunView(s!).status).toBe('Stopped · 1 of 3 done');
    }
  });

  it('its job queued or running (a long push, or one handed back at shutdown and resumed): still going, and it holds new pushes', () => {
    for (const status of ['queued', 'running']) {
      const [s] = settlePushRuns([r], new Map([['push-1', status]]), now);
      expect(s!.state).toBe('queued');
      expect(activePushOf([s!])?.id).toBe('push-1');
    }
  });

  it('no job row: stopped after 2 minutes (never queued), still going before that', () => {
    expect(settlePushRuns([r], new Map(), T0 + 60_000)[0]!.state).toBe('queued');
    expect(settlePushRuns([r], new Map(), T0 + 3 * 60_000)[0]!.state).toBe('stopped');
  });

  it('the pages never carry the worker’s staging list', () => {
    expect(publicPushRun(run([node(1)], [{ key: 'k1', dest: dest(1), replaces: null }])).stage).toBeUndefined();
  });
});

describe('Push runs: each push as an item', () => {
  it('says where it stands, and how it ended', () => {
    expect(pushRunView(run([node(1), node(2)])).status).toBe('Starting · 2 items');
    expect(pushRunView({ ...run([node(1, { state: 'applied' }), node(2, { state: 'running' })]), state: 'running' })).toMatchObject({ status: 'Pushing · 1 of 2 done', tone: 'now', active: true });
    const done = { ...run([node(1, { state: 'applied' }), node(2, { state: 'failed', detail: 'Delivery failed' }), node(3, { state: 'skipped' })]), state: 'done' as const };
    expect(pushRunView(done)).toMatchObject({ status: 'Done · 1 in VDP · 1 failed · 1 not pushed', tone: 'danger', active: false });
    expect(pushRunView(done).problems.map((n) => n.key)).toEqual(['k2', 'k3']);
    expect(pushRunView({ ...run([node(1, { state: 'applied' })]), state: 'done' })).toMatchObject({ status: 'Done · all 1 in VDP', tone: 'success' });
    expect(pushRunView({ ...run([node(1, { state: 'dry_run' })]), state: 'done', dryRun: true })).toMatchObject({ status: 'Dry run · 1 recorded, nothing sent', tone: 'neutral' });
  });

  it('a fixed staging id is a UUID, the same for the same push and item', () => {
    expect(stageIdFor('push-1', 'k1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stageIdFor('push-1', 'k1')).toBe(stageIdFor('push-1', 'k1'));
    expect(stageIdFor('push-1', 'k1')).not.toBe(stageIdFor('push-2', 'k1'));
  });
});
