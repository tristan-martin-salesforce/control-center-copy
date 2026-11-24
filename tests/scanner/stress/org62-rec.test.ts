/**
 * REC-2 / ORG-5 (placeholders only): the runner records every windowed Org62 row from the SOQL result, and an
 * incomplete finish resumes from the rows really read.
 *
 * Stage 1 attempt 6: both opps queries came back whole (50 rows each), and the agent recorded nothing, reported
 * zero-width coverage and finished incomplete at the window start, so the week never moved on.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { org62RowToRaw, Org62AutoRecorder, soqlRecords } from '../../../src/llm/org62-rec';
import { AgentSdkSkillRunner, type QueryFn } from '../../../src/llm/skill-runner';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { PROFILE } from '../runtime/helpers/world';

const W = { from: '2026-10-23T21:17:55.000Z', to: '2026-10-30T21:17:55.000Z' };
/** A SOQL timestamp `m` minutes into the window. */
const stamp = (m: number) => new Date(Date.parse(W.from) + m * 60_000).toISOString().replace('Z', '+0000');
const oppId = (i: number) => `006XX0000000${String(i).padStart(3, '0')}AAA`;

const teamRow = (i: number) => ({
  attributes: { type: 'OpportunityTeamMember' },
  Id: `00qXX0000000${String(i).padStart(3, '0')}AAA`,
  OpportunityId: oppId(i),
  TeamMemberRole: 'Solutions Engineer',
  SystemModstamp: stamp(i),
  Opportunity: { Name: `PLACEHOLDER – Opp ${i}`, AccountId: '001XX0000000001AAA', Account: { Name: 'ACME' }, StageName: '03 - Validation', CloseDate: '2026-12-15', Amount: 120000, ForecastCategoryName: 'Pipeline', NextStep: 'SE demo before 12/1', IsClosed: false, IsWon: false, SystemModstamp: stamp(i) },
});
const oppRow = (i: number) => ({
  attributes: { type: 'Opportunity' },
  Id: oppId(100 + i),
  Name: `PLACEHOLDER – Account opp ${i}`,
  AccountId: '001XX0000000002AAA',
  Account: { Name: 'GLOBEX' },
  StageName: '02 - Discovery',
  CloseDate: '2027-01-31',
  Amount: 50000,
  ForecastCategoryName: 'Pipeline',
  NextStep: 'n'.repeat(200),
  Type: 'Add-On',
  IsClosed: false,
  IsWon: false,
  Owner: { Name: 'Person A' },
  SystemModstamp: stamp(10 + i),
});
const page = (rows: unknown[]) => JSON.stringify({ totalSize: rows.length, done: true, records: rows });
const Q1 = 'SELECT Id, OpportunityId FROM OpportunityTeamMember WHERE UserId = ... ORDER BY Opportunity.SystemModstamp, OpportunityId LIMIT 50';
const Q2 = 'SELECT Id, Name FROM Opportunity WHERE AccountId IN (...) ORDER BY SystemModstamp, Id LIMIT 50';

describe('REC-2: an Org62 row becomes its §4 record snapshot', () => {
  it('team rows and account rows share the opp key; Events and DCs keep their own', () => {
    const t = org62RowToRaw(teamRow(1))!;
    expect(t.externalId).toBe(`Opportunity:${oppId(1)}@${stamp(1)}`);
    expect(t.excerpt).toMatch(/^stage=03 - Validation; close=2026-12-15; amount=120000; forecast=Pipeline; closed=false; won=false; next=SE demo before 12\/1; team_role=Solutions Engineer$/);
    expect(t.payload).toMatchObject({ Id: oppId(1), AccountName: 'ACME', TeamMemberRole: 'Solutions Engineer', rec: 'auto' });
    expect(t.accountHints).toEqual(['001XX0000000001AAA', 'ACME']);
    const o = org62RowToRaw(oppRow(1))!;
    expect(o.externalId).toBe(`Opportunity:${oppId(101)}@${stamp(11)}`);
    expect(o.excerpt!.length).toBeLessThanOrEqual(300);
    expect(o.excerpt).toContain(`next=${'n'.repeat(120)}`);
    const e = org62RowToRaw({ attributes: { type: 'Event' }, Id: '00UXX0000000001AAA', Subject: 'PLACEHOLDER – POV readout', StartDateTime: '2026-11-05T16:00:00.000+0000', EndDateTime: '2026-11-05T17:30:00.000+0000', DurationInMinutes: 90, Duration__c: null, SE_Task_Type__c: 'Customer Presentation', Meeting_Type__c: 'Workshop', RecordType: { Name: 'Solutions Event' }, WhatId: oppId(1), What: { Name: 'PLACEHOLDER – Opp 1', Type: 'Opportunity' }, AccountId: null, CreatedDate: '2026-11-05T18:00:00.000+0000', SystemModstamp: stamp(3) })!;
    expect(e.externalId).toBe(`Event:00UXX0000000001AAA@${stamp(3)}`);
    expect(e.excerpt).toBe('type=Customer Presentation; meeting_type=Workshop; rt=Solutions Event; hrs=1.5; what=PLACEHOLDER – Opp 1');
    expect(e.payload).toMatchObject({ StartDateTime: '2026-11-05T16:00:00.000+0000', EndDateTime: '2026-11-05T17:30:00.000+0000', Duration__c: null, WhatId: oppId(1) });
    expect(e.oppHints).toEqual([oppId(1)]);
    const d = org62RowToRaw({ attributes: { type: 'Deal_Contribution__c' }, Id: 'a0XXX0000000001AAA', Opportunity__c: oppId(1), Opportunity__r: { Name: 'PLACEHOLDER – Opp 1', AccountId: '001XX0000000001AAA', StageName: '03 - Validation', CloseDate: '2026-12-15', IsClosed: false, IsWon: false }, Opportunity_Role__c: 'Primary', Split_Percentage__c: 100, SystemModstamp: stamp(4) })!;
    expect(d.title).toBe('DC on PLACEHOLDER – Opp 1');
    expect(d.excerpt).toBe('role=Primary; split=100; opp_stage=03 - Validation; close=2026-12-15');
    expect(org62RowToRaw({ attributes: { type: 'AggregateResult' }, n: 3 })).toBeNull();
    expect(soqlRecords('Error: result (77,016 characters) exceeds maximum allowed tokens.')).toBeNull();
  });

  it('records a page once, and the resume point is the earliest last row among full pages', async () => {
    const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
    const { runId } = await store.startRun({ scope: { connector: 'org62', scope: 'opps' }, trigger: 'catch_up', window: W });
    const state = { runId, connector: 'org62', recorded: new Map(), items: new Map(), auto: new Set(), counts: { recorded: 0, new: 0, changed: 0 } } as any;
    const rec = new Org62AutoRecorder(store, state);
    expect(await rec.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: Q1 }, [{ type: 'text', text: page([1, 2, 3].map(teamRow)) }], 'tu1')).toBe(3);
    expect(await rec.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: Q1 }, [{ type: 'text', text: page([1, 2, 3].map(teamRow)) }], 'tu1')).toBe(0); // same tool use
    expect(rec.resumePoint()).toBeNull(); // 3 of 50: read through the window end
    expect(await rec.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: Q2 }, page(Array.from({ length: 50 }, (_, i) => oppRow(i))), 'tu2')).toBe(50);
    expect(rec.resumePoint()).toEqual({ stamp: stamp(59), id: oppId(149) });
    expect(rec.queriedRefs().sort()).toEqual(['soql:Opportunity:accounts', 'soql:OpportunityTeamMember']);
    // REC-2b: Q2's next page comes back empty: Q2 read through the window end, nothing to resume.
    expect(await rec.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: Q2 }, page([]), 'tu3')).toBe(0);
    expect(rec.resumePoint()).toBeNull();
    // A page re-read from earlier (an agent retry of page 1) does not reopen it.
    expect(await rec.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: Q2 }, page(Array.from({ length: 50 }, (_, i) => oppRow(i))), 'tu4')).toBe(0);
    expect(rec.resumePoint()).toBeNull();
    expect(state.counts.recorded).toBe(53);
    expect(rec.stats).toMatchObject({ recorded: 53, errors: 0 });
  });
});

/** Plays the CLI: Q1 and Q2 come back (PostToolUse sees them), then the agent's coverage and finish. */
function scripted(o: { q2Rows: number; finish: { complete: boolean; at: string }; noQuery?: boolean; refs?: string[] }): QueryFn {
  return ({ options }: { options: Options }) =>
    (async function* (): AsyncGenerator<SDKMessage> {
      const cc = (options.mcpServers as any).cc.instance;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await cc.connect(st);
      const client = new Client({ name: 'fake-cli', version: '1' });
      await client.connect(ct);
      yield { type: 'system', subtype: 'init', mcp_servers: [{ name: 'Org62-Sobject-Read', status: 'connected' }, { name: 'cc', status: 'connected' }], tools: [] } as any;
      const post = options.hooks?.PostToolUse?.[0]?.hooks[0];
      const sig = { signal: options.abortController!.signal };
      if (!o.noQuery) await post?.({ hook_event_name: 'PostToolUse', tool_name: 'mcp__Org62-Sobject-Read__soqlQuery', tool_input: { q: Q1 }, tool_response: [{ type: 'text', text: page([1, 2, 3].map(teamRow)) }], tool_use_id: 'tu_q1', session_id: 's', transcript_path: '', cwd: '' } as any, 'tu_q1', sig);
      if (!o.noQuery) await post?.({ hook_event_name: 'PostToolUse', tool_name: 'mcp__Org62-Sobject-Read__soqlQuery', tool_input: { q: Q2 }, tool_response: [{ type: 'text', text: page(Array.from({ length: o.q2Rows }, (_, i) => oppRow(i))) }], tool_use_id: 'tu_q2', session_id: 's', transcript_path: '', cwd: '' } as any, 'tu_q2', sig);
      // Attempt 6's agent: it records nothing and reports both queries at zero width (or, here, whatever it claims).
      const refs = o.refs ?? ['soql:OpportunityTeamMember', 'soql:Opportunity:accounts'];
      await client.callTool({ name: 'cc_report_coverage', arguments: { windows: refs.map((ref) => ({ kind: 'query_window', ref, from: W.from, to: o.finish.at })) } });
      await client.callTool({ name: 'cc_finish', arguments: { cursor: { value: o.finish.at, at: o.finish.at }, complete: o.finish.complete } });
      yield { type: 'assistant', message: { id: 'm1', model: options.model, content: [{ type: 'text', text: '' }], usage: { input_tokens: 100, output_tokens: 10 } } } as any;
      yield { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'DONE', total_cost_usd: 0.003, usage: { input_tokens: 100, output_tokens: 10 }, modelUsage: {}, permission_denials: [] } as any;
    })() as any;
}

async function run(o: Parameters<typeof scripted>[0], vars?: Record<string, string>) {
  const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
  const ctx = await store.getContext({ connector: 'org62', scope: 'opps' });
  const { runId } = await store.startRun({ scope: { connector: 'org62', scope: 'opps' }, trigger: 'catch_up', window: W });
  const r = await new AgentSdkSkillRunner({ queryFn: scripted(o) }).run(
    { skillPath: 'skills/scan-org62.md', model: 'claude-haiku-5-5', mcpServers: {}, allowedTools: [], runId, context: ctx, maxTurns: 10, costCapUsd: 0.05, signal: new AbortController().signal, window: W, mode: 'backfill', autoRecord: 'org62', ...(vars ? { vars } : {}) },
    store,
  );
  await store.finishRun(runId, { cursor: r.proposedCursor!, complete: r.complete, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } } as any);
  return { r, store, gaps: await store.coverageGaps({ connector: 'org62', scope: 'opps' }, W) };
}

describe('ORG-5: an incomplete Org62 finish resumes from the rows really read', () => {
  it('a full Q2 page and a cursor at the window start: every row is recorded and the cursor moves to its last row', async () => {
    const { r, gaps } = await run({ q2Rows: 50, finish: { complete: false, at: W.from } });
    expect(r.counts?.recorded).toBe(53);
    expect(r.complete).toBe(false);
    expect(r.proposedCursor).toEqual({ value: `${stamp(59)}|${oppId(149)}`, at: new Date(Date.parse(W.from) + 59 * 60_000).toISOString() });
    // covered up to the last row read; the rest of the week is the continuation's
    expect(gaps).toEqual([{ from: new Date(Date.parse(W.from) + 59 * 60_000).toISOString(), to: W.to }]);
  });

  it('"complete" with a full page left behind is not complete', async () => {
    const { r } = await run({ q2Rows: 50, finish: { complete: true, at: W.to } });
    expect(r.complete).toBe(false);
    expect(r.proposedCursor?.value).toBe(`${stamp(59)}|${oppId(149)}`);
  });

  it('ORG-6: a windowed run that made no query is not covered, whatever it reports', async () => {
    // Stage 1 attempt 7: the agent applied the unwindowed backfill skip to `opps` and finished complete.
    const { r, gaps } = await run({ q2Rows: 0, noQuery: true, refs: ['soql:org62:opps:skipped'], finish: { complete: true, at: W.to } });
    expect(r.counts?.recorded).toBe(0);
    expect(r.complete).toBe(false);
    expect(r.proposedCursor?.at).toBe(W.from);
    expect(gaps).toEqual([{ from: W.from, to: W.to }]);
  });

  it("ORG-7: Q2's coverage names the account count it read (agent and runner entries)", async () => {
    const { store } = await run({ q2Rows: 50, finish: { complete: false, at: W.from } }, { 'org62.accountIds': "'001XX0000000001AAA','001XX0000000002AAA','001XX0000000003AAA'" });
    const q2 = store.ledger({ connector: 'org62', scope: 'opps' }).filter((l) => l.object.ref === 'soql:Opportunity:accounts');
    expect(q2.length).toBeGreaterThan(0);
    for (const l of q2) expect(l.object.meta).toMatchObject({ accounts: 3 });
    const q1 = store.ledger({ connector: 'org62', scope: 'opps' }).filter((l) => l.object.ref === 'soql:OpportunityTeamMember');
    for (const l of q1) expect(l.object.meta?.accounts).toBeUndefined();
  });

  it('no full page: the rows are recorded and ORG-3 still completes the window', async () => {
    const { r, gaps } = await run({ q2Rows: 6, finish: { complete: false, at: W.from } });
    expect(r.counts?.recorded).toBe(9);
    expect(r.complete).toBe(true);
    expect(gaps).toEqual([]);
  });
});
