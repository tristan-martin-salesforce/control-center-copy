/**
 * SCANNER.md §8 correctness cases for the BE-2a lane, end to end through ScannerRuntime with the
 * in-memory store, real cc handlers, and skill-following scripted agents over placeholder fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { DeterministicFetcher, NormalizedSourceItem, TimeWindow } from '../../../src/scanner/types';
import { deterministicSpec, org62Spec, slackSpec } from '../../../src/scanner/runtime/connectors';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { AgentSdkSkillRunner } from '../../../src/llm/skill-runner';
import { intervalMs, DEFAULT_CADENCE } from '../../../src/scanner/runtime/cadence';
import { mailAgent, org62Agent, slackAgent, stubbornRelinkAgent, type SlackAgentOptions } from './helpers/agents';
import { fakeQuery } from './helpers/fake-query';
import { loadFixture } from './helpers/slack-sim';
import type { Script } from './helpers/scripted-runner';
import { INBOX, makeWorld } from './helpers/world';

const W1: TimeWindow = { from: '2026-11-04T16:00:00.000Z', to: '2026-11-04T21:00:00.000Z' };
const W2: TimeWindow = { from: '2026-11-04T21:00:00.000Z', to: '2026-11-05T16:00:00.000Z' };
const NOW = '2026-11-05T16:00:00.000Z';

function sentMailFetcher(items: NormalizedSourceItem[]): DeterministicFetcher {
  return {
    connector: 'gmail',
    scopes: async () => ['sent'],
    async fetch(_scope, _cursor, window) {
      const inWin = items.filter((i) => i.occurredAt >= window.from && i.occurredAt < window.to);
      return { items: inWin, coverage: [{ kind: 'mailbox_range', ref: 'gmail:sent', from: window.from, to: window.to }], nextCursor: { value: window.to, at: window.to }, complete: true };
    },
    health: async () => ({ state: 'ok', checkedAt: NOW }),
  };
}

const deckEmail: NormalizedSourceItem = {
  connector: 'gmail',
  kind: 'email',
  externalId: 'msg-0001',
  dedupeKey: 'gmail:msg-0001',
  contentHash: 'h-mail-1',
  occurredAt: '2026-11-05T03:00:00.000Z',
  author: { name: 'ME', email: 'me@example.com', isMe: true },
  participants: [{ name: 'PERSON_D', email: 'person_d@example.com' }],
  title: 'ACME demo deck',
  excerpt: 'Hi PERSON_D, attached is the ACME demo deck as promised.',
  fileRefs: ['drive:FILE_ACME_DEMO'],
  threadRef: 'gmail-thread:t-0001',
  payload: { direction: 'sent', hasAttachment: true },
};

/** Routes each run to the right scripted agent by connector/mode. */
function router(opts: { slack?: SlackAgentOptions; relink?: Script } = {}): Script {
  const slack = slackAgent(opts.slack);
  const mail = mailAgent();
  return async (api) => {
    if (api.input.mode?.startsWith('relink')) return (opts.relink ?? slack)(api);
    if (api.input.context.scope.connector === 'gmail') return mail(api);
    return slack(api);
  };
}

const titleOf = (store: any, id: string) => store.getWorkItem(id)?.title;

describe('ScannerRuntime: SCANNER.md §8', () => {
  it('extracts asks, commitments, completions, and redacts secrets (scan-slack worked examples)', async () => {
    const { runtime, store, reevaluated } = makeWorld({ now: NOW, script: router() });
    const [out] = await runtime.runScope(INBOX, 'manual', W1);
    expect(out!.status).toBe('succeeded');
    const items = store.listWorkItems();
    expect(items.map((w) => w.title).sort()).toEqual(['Package APP_X as a desktop app for PERSON_B', 'Send ACME demo deck to PERSON_D', 'Update pricing slide in ACME POV deck']);
    const desktop = items.find((w) => w.title.startsWith('Package'))!;
    expect(desktop).toMatchObject({ kind: 'commitment', confidence: 'likely', newBadge: true }); // "I'm going to figure out how to…" = medium
    const pricing = items.find((w) => w.title.startsWith('Update pricing'))!;
    expect(store.evidenceFor(pricing.workItemId).map((e) => e.role)).toEqual(['origin', 'completion']); // "Done, see deck"
    expect(pricing.fileRefs).toContain('drive:FILE_ACME_POV');
    const secret = store.getSourceItemByDedupe('slack:D0DM00003:1793822400.000100')!;
    expect(secret.excerpt).toContain('[REDACTED]');
    expect(secret.excerpt).not.toContain('Hunter2');
    expect(store.unlinkedRow(store.getSourceItemByDedupe('slack:D0DM00001:1793808300.000100')!.id)).toMatchObject({ attempts: 1 });
    expect(reevaluated).toHaveLength(1);
    expect(reevaluated[0]!.ids.sort()).toEqual(items.map((w) => w.workItemId).sort());
    expect(store.listRuns(INBOX)[0]!.skillVersion).toMatch(/^scan-slack@\d+\.\d+\.\d+$/);
  });

  it('idempotency: running the same window twice creates zero new rows', async () => {
    const { runtime, store, reevaluated } = makeWorld({ now: NOW, script: router() });
    await runtime.runScope(INBOX, 'manual', W1);
    const before = { counts: store.counts(), digest: store.stateDigest() };
    const [again] = await runtime.runScope(INBOX, 'manual', W1);
    expect(again!.status).toBe('succeeded');
    const run = store.getRun(again!.runId!)!;
    expect(run.stats).toMatchObject({ new: 0, changed: 0 });
    const after = store.counts();
    expect({ ...after, runs: 0, ledger: 0 }).toEqual({ ...before.counts, runs: 0, ledger: 0 });
    expect(store.stateDigest()).toBe(before.digest);
    expect(reevaluated).toHaveLength(1); // nothing new → no second fan-out
  });

  it('a killed run leaves the cursor unmoved; re-running gives the same final state', async () => {
    const flags: SlackAgentOptions = { killAfterRecords: 2 };
    const killed = makeWorld({ now: NOW, script: router({ slack: flags }) });
    const [k] = await killed.runtime.runScope(INBOX, 'manual', W1);
    expect(k!.status).toBe('failed');
    expect(await killed.store.getCursor(INBOX)).toBeNull();
    expect(killed.store.getRun(k!.runId!)!.status).toBe('failed');
    expect(killed.reevaluated).toHaveLength(0); // finishRun (and fan-out) only on success
    flags.killAfterRecords = undefined;
    const [ok] = await killed.runtime.runScope(INBOX, 'manual', W1);
    expect(ok!.status).toBe('succeeded');

    const clean = makeWorld({ now: NOW, script: router() });
    await clean.runtime.runScope(INBOX, 'manual', W1);
    expect(killed.store.stateDigest()).toBe(clean.store.stateDigest());
    expect((await killed.store.getCursor(INBOX))!.at).toBe(W1.to);
    // Items first touched by the killed run are still fanned out by the successful re-run (S10).
    expect(killed.reevaluated[0]!.ids.map((id) => titleOf(killed.store, id))).toContain('Send ACME demo deck to PERSON_D');
  });

  it('weekend gap: newest hour first, then 6 h backfill oldest → newest, ending with full coverage and no holes', async () => {
    const fri = { from: '2026-10-30T17:00:00.000Z', to: '2026-10-30T23:00:00.000Z' };
    const first = makeWorld({ now: fri.to, script: router() });
    await first.runtime.runScope(INBOX, 'manual', fri);
    // Laptop closed all weekend; the worker restarts Monday 15:00Z with the same store.
    first.clock.set('2026-11-02T15:00:00.000Z');
    const runtime = new ScannerRuntime({ store: first.store, runner: first.runner, specs: [slackSpec({ mcpServers: () => ({}) })], clock: first.clock, reevaluate: async () => {} });
    const plan = await runtime.planJobs();
    const scans = plan.filter((j) => j.kind === 'scan') as any[];
    expect(scans[0]).toMatchObject({ mode: 'head', window: { from: '2026-11-02T14:00:00.000Z', to: '2026-11-02T15:00:00.000Z' } });
    const backfill = scans.filter((j) => j.mode === 'backfill');
    expect(backfill[0].window.from).toBe(fri.to);
    expect(backfill.map((j) => j.window.from)).toEqual([...backfill.map((j) => j.window.from)].sort());
    expect(backfill.every((j) => Date.parse(j.window.to) - Date.parse(j.window.from) <= 6 * 3600_000)).toBe(true);
    expect(runtime.isCatchingUp('slack')).toBe(true);
    expect((await runtime.catchUpProgress()).slack).toBe(0);

    const q = runtime.queue as any;
    await q.enqueue(plan);
    const order: string[] = [];
    const far = new Date(8.64e15);
    for (let job = q.dequeue(far); job; job = q.dequeue(far)) {
      if (job.kind === 'scan') order.push(`${job.mode}:${job.window.from}`);
      await q.enqueue((await runtime.executeJob(job)).followUps);
    }
    expect(order[0]).toBe('head:2026-11-02T14:00:00.000Z');
    const catchUp = order.filter((o) => o.startsWith('head:') || o.startsWith('backfill:'));
    expect(catchUp.slice(1)).toEqual(backfill.map((j) => `backfill:${j.window.from}`));
    // The resume reconcile (lowest priority) runs after catch-up: a stale-but-active thread rescan for Saturday's ask.
    expect(order.at(-1)).toMatch(/^targeted:/);
    expect((await first.store.getCursor(INBOX))!.at).toBe('2026-11-02T15:00:00.000Z'); // fast-forwarded past the head run
    expect(await first.store.coverageGaps(INBOX, { from: fri.from, to: '2026-11-02T15:00:00.000Z' })).toEqual([]);
    expect(first.store.ledger(INBOX).filter((l) => l.outcome === 'error')).toEqual([]);
    expect(runtime.isCatchingUp('slack')).toBe(false);
    expect(first.store.listWorkItems().map((w) => w.title)).toContain('Review GLOBEX sizing sheet for PERSON_G'); // Saturday's ask
  });

  it('"I\'ll send the deck" in Slack, then the email with the deck: same item, origin then completion', async () => {
    const { runtime, store, clock } = makeWorld({ now: W1.to, script: router(), specs: [slackSpec({ mcpServers: () => ({}) }), deterministicSpec(sentMailFetcher([deckEmail]))] });
    await runtime.runScope(INBOX, 'manual', W1);
    clock.set(NOW);
    const [mail] = await runtime.runScope({ connector: 'gmail', scope: 'sent' }, 'manual', W2);
    expect(mail!.status).toBe('succeeded');
    const deck = store.listWorkItems().find((w) => w.title === 'Send ACME demo deck to PERSON_D')!;
    const ev = store.evidenceFor(deck.workItemId).map((e) => ({ role: e.role, src: store.getSourceItem(e.sourceItemId)!.connector }));
    expect(ev).toEqual([
      { role: 'origin', src: 'slack' }, // PERSON_D's ask
      { role: 'origin', src: 'slack' }, // my "I'll send the ACME demo deck tonight"
      { role: 'completion', src: 'gmail' },
    ]);
    expect((await store.getCursor({ connector: 'gmail', scope: 'sent' }))!.at).toBe(W2.to);
  });

  it('new requirements after done → contradiction signal (the engine reopens or opens a sibling)', async () => {
    const { runtime, store, clock } = makeWorld({ now: W1.to, script: router() });
    await runtime.runScope(INBOX, 'manual', W1);
    const pricing = store.listWorkItems().find((w) => w.title.startsWith('Update pricing'))!;
    store.setWorkItemState(pricing.workItemId, 'done', { resolution: 'done_by_me' });
    clock.set(NOW);
    await runtime.runScope(INBOX, 'manual', W2);
    const roles = store.evidenceFor(pricing.workItemId).map((e) => e.role);
    expect(roles).toEqual(['origin', 'completion', 'contradiction']);
    expect(store.getWorkItem(pricing.workItemId)!.state).toBe('done'); // the scanner never sets state
  });

  it('R-UI-22: handed-off item takes context only; a direct DM ask loops me back in', async () => {
    const corpus = structuredClone((await import('./helpers/slack-sim')).loadCorpus());
    corpus.messages = [
      { id: 'handoff-fyi', channel: 'C0GLOBEX1', from: 'U0PERSONE', ts: '1793880000.000100', threadTs: '1793800000.000900', text: 'FYI customer moved the GLOBEX sizing review to Friday' },
      { id: 'handoff-ask', channel: 'D0DM00005', from: 'U0PERSONE', ts: '1793880600.000100', text: 'Can you join Friday’s GLOBEX sizing review to cover the architecture section?' },
    ];
    corpus.messages[0]!.text = `<@U0ME00001> ${corpus.messages[0]!.text}`; // a mention, but an FYI (not an ask)
    const { runtime, store } = makeWorld({ now: NOW, script: router({ slack: { corpus } }) });
    const w = store.seedWorkItem({ kind: 'deliverable', title: 'GLOBEX sizing review workbook', people: ['PERSON_E', 'U0PERSONE'], keywords: ['globex', 'sizing', 'review'], threadRefs: ['slack:C0GLOBEX1:1793800000.000900'], resolution: 'handed_off', involvement: 'watcher', handedOffTo: 'PERSON_E' });
    await runtime.runScope(INBOX, 'manual', W2);
    const ev = store.evidenceFor(w).map((e) => ({ role: e.role, reason: e.reason }));
    expect(ev).toHaveLength(2);
    expect(ev).toEqual(
      expect.arrayContaining([
        { role: 'context', reason: 'update on a handed-off item' },
        { role: 'origin', reason: expect.stringMatching(/^loop_back: PERSON_E asked me directly/) },
      ]),
    );
    expect(store.listWorkItems()).toHaveLength(1); // no new task proposed for the handed-off work
  });

  it('unlinked: retry (Haiku) → escalate once (Sonnet) → Triage mapping question', async () => {
    const { runtime, store, runner } = makeWorld({ now: NOW, script: router({ relink: stubbornRelinkAgent() }) });
    await runtime.runScope(INBOX, 'manual', W1);
    const src = store.getSourceItemByDedupe('slack:D0DM00001:1793808300.000100')!.id; // "APP_X install times out"
    expect(store.unlinkedRow(src)!.attempts).toBe(1);
    await runtime.runScope(INBOX, 'manual', W1); // a rescan never escalates
    expect(store.unlinkedRow(src)!.attempts).toBe(1);

    const r1 = await runtime.runReconcile(['unlinked']);
    expect(runner.calls.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', mode: 'relink', allowedTools: [] });
    expect(store.unlinkedRow(src)!.attempts).toBe(2);
    expect(r1.findings.some((f) => f.sourceItemId === src && f.kind === 'unlinked_item')).toBe(true);

    await runtime.runReconcile(['unlinked']);
    expect(runner.calls.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', mode: 'relink_escalated' });
    expect(store.unlinkedRow(src)!.attempts).toBe(3);

    const callsBefore = runner.calls.length;
    const r3 = await runtime.runReconcile(['unlinked']);
    expect(runner.calls.length).toBe(callsBefore); // no LLM for the Triage question
    expect(r3.triaged).toBe(1);
    const q = store.listWorkItems().find((w) => w.title.startsWith('Where does this belong?'))!;
    expect(q).toMatchObject({ landedAs: 'suggested', state: 'suggested', confidence: 'guess' });
    expect(store.evidenceFor(q.workItemId)[0]).toMatchObject({ sourceItemId: src, role: 'context' });
    expect((await store.unlinkedSourceItems({ connector: 'slack' })).map((u) => u.sourceItemId)).not.toContain(src);
  });

  it('R9: a relink proposes an unmatched ask of mine (origin evidence); a not-actionable one is recorded only and never asked', async () => {
    let n = 0;
    const relink: Script = async (api) => {
      const items = JSON.parse(api.input.instruction!.split('## Unlinked items\n')[1]!) as Array<{ sourceItemId: string; reason: string }>;
      for (const it of items) {
        n += 1;
        if (n === 1) await api.call('cc_propose_item', { kind: 'ask', title: 'Look into the APP_X install timeout', purpose: 'PERSON_A is blocked on the install', evidence: [{ sourceItemId: it.sourceItemId, role: 'origin', reason: 'asked me in a DM' }], confidence: 'likely' });
        else await api.call('cc_flag_unlinked', { sourceItemId: it.sourceItemId, reason: `not actionable: ${it.reason}` });
      }
      await api.call('cc_finish', { cursor: { value: 'relink', at: api.input.window!.to } });
    };
    const { runtime, store, runner } = makeWorld({ now: NOW, script: router({ relink }) });
    await runtime.runScope(INBOX, 'manual', W1);
    const before = (await store.unlinkedSourceItems({ connector: 'slack' })).map((u) => u.sourceItemId);
    expect(before.length).toBeGreaterThan(0);
    expect(runner.calls.find((c) => c.mode === 'relink')).toBeUndefined();

    await runtime.runReconcile(['unlinked']);
    expect(runner.calls.at(-1)!.instruction).toMatch(/cc_propose_item/);
    const proposed = store.listWorkItems().find((w) => w.title === 'Look into the APP_X install timeout')!;
    expect(store.evidenceFor(proposed.workItemId)[0]).toMatchObject({ sourceItemId: before[0], role: 'origin' });
    const left = await store.unlinkedSourceItems({ connector: 'slack' });
    expect(left.map((u) => u.sourceItemId)).not.toContain(before[0]);
    expect(left.every((u) => /^not actionable:/.test(u.reason ?? ''))).toBe(true);

    // The next pass stops retrying them: no LLM call, no "Where does this belong?" question.
    const calls = runner.calls.length;
    const r2 = await runtime.runReconcile(['unlinked']);
    expect(runner.calls.length).toBe(calls);
    expect(r2.triaged).toBe(0);
    expect(store.listWorkItems().some((w) => w.title.startsWith('Where does this belong?'))).toBe(false);
    expect(await store.unlinkedSourceItems({ connector: 'slack' })).toEqual([]);
  });

  it('a non-allowlisted tool call aborts the run: cursor unmoved, health recorded, scope paused', async () => {
    const world = makeWorld({ now: NOW, script: router() });
    const seen = { toolResults: [] as string[] };
    const runner = new AgentSdkSkillRunner({
      queryFn: fakeQuery({ steps: [{ tool: 'mcp__slack__slack_search_public_and_private', input: { query: 'x' } }, { tool: 'mcp__slack__slack_send_message', input: { channel_id: 'D0DM00002', text: 'sending the deck' } }, { tool: 'mcp__cc__cc_finish', input: { cursor: { value: '1', at: W1.to } } }] }, seen),
    });
    const runtime = new ScannerRuntime({ store: world.store, runner, specs: [slackSpec({ mcpServers: () => ({}) })], clock: world.clock, reevaluate: async () => {} });
    const [out] = await runtime.runScope(INBOX, 'manual', W1);
    expect(out).toMatchObject({ status: 'failed', errorClass: 'config' });
    expect(world.store.getRun(out!.runId!)!.status).toBe('failed');
    expect(await world.store.getCursor(INBOX)).toBeNull();
    // STAT-1: a plain reason that still names the blocked tool.
    expect(world.store.latestHealth('slack')).toMatchObject({ state: 'degraded', errorClass: 'config', detail: expect.stringMatching(/^Slack inbox: a tool call outside the read-only allowlist was blocked \(mcp__slack__/) });
    expect(runtime.status().find((s) => s.scope === 'inbox')!.paused).toBe('config');
    expect(seen.toolResults).toHaveLength(0);
  });

  it('over budget: traversal pauses at the hard cap; deterministic fetch keeps running with linking deferred', async () => {
    const { runtime, store, runner, clock } = makeWorld({ now: NOW, script: router(), specs: [slackSpec({ mcpServers: () => ({}) }), deterministicSpec(sentMailFetcher([deckEmail]))], hardCapUsd: 15 });
    await store.recordSpend({ connector: 'chat', model: 'claude-sonnet-5-5', costUsd: 15.2, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    const jobs = await runtime.planJobs();
    expect(jobs.filter((j) => j.kind === 'scan' && j.connector === 'slack')).toEqual([]);
    expect(store.latestHealth('slack')).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/hard cap/) });
    const mailJob = jobs.find((j) => j.kind === 'scan' && j.connector === 'gmail')!;
    expect(mailJob).toBeTruthy();
    const out = await runtime.executeJob({ ...(mailJob as any), window: W2 });
    expect(out.status).toBe('succeeded');
    expect(runner.calls).toHaveLength(0); // no LLM spend
    const email = store.getSourceItemByDedupe('gmail:msg-0001')!;
    expect(store.unlinkedRow(email.id)).toMatchObject({ attempts: 0, deferred: true });
    const blocked = await runtime.executeJob({ kind: 'scan', id: 'x', connector: 'slack', scope: 'inbox', window: W1, mode: 'incremental', trigger: 'schedule', priority: 60, runAt: NOW, dedupeKey: 'x' });
    expect(blocked).toMatchObject({ status: 'paused', detail: 'budget_hard_cap' });
    // Next day the cap resets and traversal resumes.
    clock.advance(24 * 3600_000);
    const next = await runtime.planJobs();
    expect(next.some((j) => j.kind === 'scan' && j.connector === 'slack')).toBe(true);
  });

  it('continuation: a paged-out run commits what it covered and schedules the rest', async () => {
    const { runtime, store, runner } = makeWorld({ now: NOW, script: router({ slack: { pageLimit: 1, maxPages: 2 } }) });
    const outs = await runtime.runScope(INBOX, 'manual', W1);
    expect(outs.length).toBeGreaterThan(1);
    expect(runner.calls.some((c) => c.window!.from !== W1.from)).toBe(true);
    expect(outs.every((o) => o.status === 'succeeded')).toBe(true);
    expect((await store.getCursor(INBOX))!.at).toBe(W1.to);
    expect(await store.coverageGaps(INBOX, W1)).toEqual([]);
    expect(store.listWorkItems()).toHaveLength(3);
  });

  it('auth failure pauses the connector and records re-auth; a manual rescan that succeeds resumes it', async () => {
    let fail = true;
    const base = router();
    const { runtime, store } = makeWorld({
      now: NOW,
      script: async (api) => {
        if (fail) throw new Error('mcp server slack status needs-auth');
        return base(api);
      },
    });
    await runtime.planJobs();
    const [out] = await runtime.runScope(INBOX, 'manual', W1);
    expect(out).toMatchObject({ status: 'failed', errorClass: 'auth' });
    expect(store.latestHealth('slack')).toMatchObject({ state: 'auth_required', reauth: { kind: 'terminal_command', command: 'claude mcp login slack' } });
    expect(runtime.status().find((s) => s.scope === 'inbox')!.paused).toBe('auth');
    expect((await runtime.planJobs(new Date(Date.parse(NOW) + 3600_000))).filter((j) => j.kind === 'scan')).toEqual([]);
    fail = false;
    const [ok] = await runtime.runScope(INBOX, 'manual', W1);
    expect(ok!.status).toBe('succeeded');
    expect(runtime.status().find((s) => s.scope === 'inbox')!.paused).toBeUndefined();
    expect(store.latestHealth('slack')).toMatchObject({ state: 'ok' });
  });

  it('Org62: new team membership → no "Get up to speed" item while Settings ▸ Scanning has it off (the default)', async () => {
    const team = loadFixture('org62/opp_team.soql.v1.json');
    const dcs = loadFixture('org62/dc.soql.v1.json');
    const { runtime, store } = makeWorld({ now: NOW, script: org62Agent({ team, dcs }), specs: [org62Spec({ mcpServers: () => ({}) })] });
    await runtime.runScope({ connector: 'org62', scope: 'opps' }, 'manual', { from: '2026-11-05T00:00:00.000Z', to: NOW });
    expect(store.listWorkItems().some((w) => w.title.startsWith('Get up to speed'))).toBe(false);
  });

  it('Org62: new team membership → Triage follow-up (when on); a new DC is a completion signal', async () => {
    const team = loadFixture('org62/opp_team.soql.v1.json');
    const dcs = loadFixture('org62/dc.soql.v1.json');
    const { runtime, store } = makeWorld({ now: NOW, script: org62Agent({ team, dcs }), specs: [org62Spec({ mcpServers: () => ({}) })] });
    store.profile.scanning = { channelAsks: 'ask', meetingCatchUps: false, oppTeamCatchUps: true, mappingQuestions: 'mine' };
    const claim = store.seedWorkItem({ kind: 'follow_up', title: 'Claim DC on INITECH – Data Cloud Phase 2', keywords: ['claim', 'initech'] });
    const win = { from: '2026-11-05T00:00:00.000Z', to: NOW };
    await runtime.runScope({ connector: 'org62', scope: 'opps' }, 'manual', win);
    await runtime.runScope({ connector: 'org62', scope: 'dcs' }, 'manual', win);
    const followUp = store.listWorkItems().find((w) => w.title === 'Get up to speed on GLOBEX – Agentforce Pilot');
    expect(followUp).toMatchObject({ landedAs: 'suggested' });
    expect(store.listWorkItems().some((w) => w.title.includes('ACME – Data 360 Expansion'))).toBe(false); // not new on the team
    expect(store.evidenceFor(claim).map((e) => e.role)).toEqual(['completion']);
    const snap = store.getSourceItemByDedupe('org62:Opportunity:006XX0000000001AAA@2026-11-05T14:00:00.000+0000');
    expect(snap).toMatchObject({ kind: 'record_snapshot', oppHints: ['006XX0000000001AAA'] });
  });

  it('cadence: off-hours ×6 and adaptive backoff when nothing changes', () => {
    const work = new Date('2026-11-04T17:00:00Z'); // Wed 10:00 Denver
    const night = new Date('2026-11-05T05:00:00Z'); // Wed 22:00 Denver
    expect(intervalMs(DEFAULT_CADENCE, 'slack', 'inbox', work, 0)).toBe(120_000);
    expect(intervalMs(DEFAULT_CADENCE, 'slack', 'inbox', night, 0)).toBe(720_000);
    expect(intervalMs(DEFAULT_CADENCE, 'slack', 'inbox', work, 2)).toBe(480_000);
    expect(intervalMs(DEFAULT_CADENCE, 'slack', 'inbox', work, 9)).toBe(960_000); // capped at 2^3
    expect(intervalMs(DEFAULT_CADENCE, 'org62', 'opps', work, 0)).toBe(1_800_000);
    expect(intervalMs(DEFAULT_CADENCE, 'slack', 'channel:C1', work, 0)).toBe(600_000);
  });

  it('planJobs: first start backfills the lookback; one active plan per scope; polls when due; nightly reconcile once a day', async () => {
    const { runtime, clock } = makeWorld({ now: '2026-11-04T17:00:00.000Z', script: router() });
    const first = await runtime.planJobs();
    const scans = first.filter((j) => j.kind === 'scan') as any[];
    expect(scans[0].mode).toBe('head'); // no cursor: 24 h lookback, newest hour first
    expect(scans.slice(1).every((j) => j.mode === 'backfill')).toBe(true);
    expect(first.some((j) => j.kind === 'reconcile' && j.id.includes('resume'))).toBe(true);
    expect(await runtime.planJobs()).toEqual([]); // still pending, not re-planned
    for (const j of first) await runtime.executeJob(j);
    expect((await runtime.planJobs()).filter((j) => j.kind === 'scan')).toEqual([]); // not due yet
    clock.advance(20 * 60_000); // quiet backfill runs raised the adaptive backoff (2 min × 2^3)
    const poll = (await runtime.planJobs()).filter((j) => j.kind === 'scan') as any[];
    expect(poll).toHaveLength(1);
    expect(poll[0].mode).toBe('incremental');
    clock.set('2026-11-05T09:30:00.000Z'); // 02:30 Denver
    const night = await runtime.planJobs();
    expect(night.filter((j) => j.kind === 'reconcile')).toHaveLength(1);
    expect((await runtime.planJobs()).filter((j) => j.kind === 'reconcile')).toHaveLength(0);
  });
});
