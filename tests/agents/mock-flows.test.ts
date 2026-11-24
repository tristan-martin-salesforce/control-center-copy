/**
 * P4 flows against the mock DataSource (placeholder seed): claim + undo, Start in Claude, a tool run to
 * completion, and the scenario's waiting-session transition.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Seed } from '@/contract';
import { isClaudeUrl, parseNewLink } from '@/components/agents/claude';
import { MockDataSource } from '@/server/datasource/mock';
import { PREPARED_LAUNCH_EVENT } from '@/server/datasource/types/agents';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const fast = { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 };
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let ds: MockDataSource;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
});
afterEach(() => ds.dispose());

describe('P4 app runs', () => {
  it('an app run waiting on you can be answered inline, and a tool run can be cancelled', async () => {
    const runs = (await ds.getAgents({} as never)).runs;
    const app = runs.find((r) => r.kind === 'app_run' && r.state === 'waiting_on_you')!;
    const res = await ds.answerAgent({ params: { id: app.id }, body: { answer: 'yes' } } as never);
    expect(res.entity.state).toBe('running');
    const tools = await ds.getTools({} as never);
    const a = tools.adapters.find((x) => x.health.state === 'ok' && x.enabled)!;
    const required = (a.manifest.input.schema.required as string[] | undefined) ?? [];
    const started = await ds.startToolRun({ params: { id: a.manifest.id }, body: { inputs: Object.fromEntries(required.map((k) => [k, 'x'])) } } as never);
    const cancelled = await ds.cancelAgent({ params: { id: started.entity.agentRunId! }, body: {} } as never);
    expect(cancelled.entity.state).toBe('failed');
    expect(cancelled.entity.error).toBe('Cancelled by you');
  });
});

describe('P4 against the mock', () => {
  it('claims a missed opp (a DC request, one Claim verb), then undo restores it and removes the request', async () => {
    const before = await ds.getMissed({} as never);
    const target = before.missed.find((m) => m.status === 'new' && m.oppId)!;
    const res = await ds.claimMissed({ params: { id: target.id }, body: {} } as never);
    expect(res.entity.status).toBe('claimed');
    expect(res.entity.dcRequestId).toBeTruthy();
    expect(res.entity.claimedWorkItemId).toBeNull();
    expect(res.auditId).toBeTruthy();

    await ds.undoAudit({ params: { id: res.auditId! }, body: {} } as never);
    const after = await ds.getMissed({} as never);
    expect(after.missed.find((m) => m.id === target.id)?.status).toBe('new');
    expect((await ds.listDcRequests({} as never)).requests).toEqual([]);
  });

  it('dismiss needs a reason (contract) and records it', async () => {
    const target = (await ds.getMissed({} as never)).missed.find((m) => m.status === 'new')!;
    const res = await ds.dismissMissed({ params: { id: target.id }, body: { reason: 'Not my deal' } } as never);
    expect(res.entity.status).toBe('dismissed');
    expect(res.entity.dismissReason).toBe('Not my deal');
  });

  it('launch returns a claude://code/new URL carrying the folder and the [cc:<id>] tag', async () => {
    const item = (await ds.getToday({} as never)).nowStack.cards[0]!.item;
    const res = await ds.launchAgent({ body: { workItemId: item.id, folder: '/Users/example/Projects/demo' } } as never);
    expect(isClaudeUrl(res.url)).toBe(true);
    const parsed = parseNewLink(res.url)!;
    expect(parsed.folder).toBe('/Users/example/Projects/demo');
    expect(parsed.prompt).toContain(`[cc:${item.id}]`);
    expect(res.run.state).toBe('queued');
    expect(res.run.lastEvent).toBe(PREPARED_LAUNCH_EVENT); // nothing opens until Open in Claude (SEC-10)
  });

  it('a tool run goes queued → running → succeeded with a result link', async () => {
    const tools = await ds.getTools({} as never);
    const adapter = tools.adapters.find((a) => a.health.state === 'ok' && a.enabled)!;
    const required = (adapter.manifest.input.schema.required as string[] | undefined) ?? [];
    const inputs = Object.fromEntries(required.map((k) => [k, 'x']));
    const started = await ds.startToolRun({ params: { id: adapter.manifest.id }, body: { inputs } } as never);
    expect(['queued', 'starting', 'running']).toContain(started.entity.status);
    let run = started.entity;
    for (let i = 0; i < 40 && run.status !== 'succeeded'; i++) {
      await tick(20);
      run = await ds.getToolRun({ params: { id: started.entity.id } } as never);
    }
    expect(run.status).toBe('succeeded');
    expect(run.progress?.done).toBe(run.progress?.total);
  });

  it('the scenario turns the Claude session for card #1 waiting on you', async () => {
    const before = await ds.getAgents({} as never);
    const waitingBefore = before.runs.filter((r) => r.state === 'waiting_on_you').map((r) => r.id);
    await ds.controlScenario({ body: { action: 'seek', seconds: 45 } });
    const after = await ds.getAgents({} as never);
    const nowWaiting = after.runs.filter((r) => r.state === 'waiting_on_you' && r.kind === 'claude_session');
    expect(nowWaiting.length).toBeGreaterThan(0);
    expect(nowWaiting.some((r) => !waitingBefore.includes(r.id))).toBe(true);
    expect(after.runs.find((r) => r.id === 'run_acme_build')?.state).toBe('waiting_on_you');
    expect(after.needsInputLink).toBe('claude://code/needs-input');
  });
});
