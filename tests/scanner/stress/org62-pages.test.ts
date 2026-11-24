/** ORG-3 (placeholders only): a quiet Org62 window the agent called incomplete is complete by the paging rule. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Org62PageObserver, soqlRowCount } from '../../../src/llm/org62-pages';
import { AgentSdkSkillRunner, type QueryFn } from '../../../src/llm/skill-runner';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { PROFILE } from '../runtime/helpers/world';

const W = { from: '2026-10-23T21:17:55.000Z', to: '2026-10-30T21:17:55.000Z' };
const SOQL = (limit: number) => `SELECT Id FROM Opportunity WHERE SystemModstamp >= 2026-10-23T21:17:55Z ORDER BY SystemModstamp, Id LIMIT ${limit}`;
const rows = (n: number) => JSON.stringify({ totalSize: n, done: true, records: Array.from({ length: n }, (_, i) => ({ attributes: { type: 'Opportunity' }, Id: `006XX00000000${String(i).padStart(2, '0')}AAA` })) });

describe('Org62PageObserver', () => {
  it('reads rows and LIMITs; a full page or an error means not whole', () => {
    expect(soqlRowCount(rows(3))).toBe(3);
    expect(soqlRowCount('{"totalSize":0,"done":true,"records":[]}')).toBe(0);
    const quiet = new Org62PageObserver();
    quiet.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: SOQL(100) }, [{ type: 'text', text: rows(6) }]);
    quiet.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: SOQL(100) }, rows(0));
    expect(quiet.readWhole()).toBe(true);
    const full = new Org62PageObserver();
    full.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: SOQL(5) }, rows(5));
    expect(full.readWhole()).toBe(false);
    const err = new Org62PageObserver();
    err.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: SOQL(100) }, '[{"message":"bad","errorCode":"MALFORMED_QUERY"}]');
    expect(err.readWhole()).toBe(false);
    expect(new Org62PageObserver().readWhole()).toBe(false); // no query ran
    // ORG-3b: an extra paging query without a LIMIT counts by the result's own done flag.
    const noLimit = new Org62PageObserver();
    noLimit.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: SOQL(100) }, rows(6));
    noLimit.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: 'SELECT Id FROM Opportunity WHERE SystemModstamp > 2026-10-24T00:00:00Z ORDER BY SystemModstamp, Id' }, rows(0));
    expect(noLimit.readWhole()).toBe(true);
    const more = new Org62PageObserver();
    more.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: 'SELECT Id FROM Opportunity' }, JSON.stringify({ totalSize: 2500, done: false, nextRecordsUrl: '/services/data/v60.0/query/01gXX-2000', records: [] }));
    expect(more.readWhole()).toBe(false);
    // ORG-4: a page over the tool's output cap comes back as an overflow notice with no rows: nothing was read.
    const over = new Org62PageObserver();
    over.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', { q: SOQL(100) }, [{ type: 'text', text: 'Error: result (77,016 characters) exceeds maximum allowed tokens. Output has been saved to /placeholder/tool-results/soql.txt.\nFormat: JSON with schema: {totalSize: number, done: boolean, records: [{...}]}' }]);
    expect(over.readWhole()).toBe(false);
  });
});

/**
 * ORG-4: a 100-row Opportunity page with NextStep text was 77K characters, over the tool's output cap. The agent got
 * only the overflow notice, recorded the other query's rows and reported this one at zero width, twice. scan-org62 1.2.0
 * pages opps by 50 and halves the LIMIT on an overflow, without moving coverage past unread rows.
 */
describe('ORG-4: scan-org62 keeps every windowed page under the output cap', () => {
  it('opps and Events page by at most 50, DCs by 100, and an overflow halves the LIMIT', () => {
    const skill = readFileSync('skills/scan-org62.md', 'utf8');
    const section = (name: string) => skill.slice(skill.indexOf(`### \`${name}\``), skill.indexOf('###', skill.indexOf(`### \`${name}\``) + 4));
    const limits = (text: string) => [...text.matchAll(/\bLIMIT (\d+)/g)].map((m) => Number(m[1]));
    expect(limits(section('opps'))).toEqual([50, 50, 50]); // Q1, Q2 and (D-55, opps I own) Q3
    expect(limits(section('events'))).toEqual([40]); // D-65: the Event row carries Description (its CC# key) now
    expect(Math.max(...limits(section('dcs')))).toBeLessThanOrEqual(100);
    expect(skill).toMatch(/exceeds the maximum allowed tokens[^.]*you have read none of its rows: run the same query again with half the LIMIT/);
    expect(skill).toMatch(/Never report coverage, or move the cursor, past rows you have not read/);
  });
});

/** Plays the CLI for one run: a SOQL read (PostToolUse sees its result), then the agent's coverage and finish. */
function scripted(o: { limit: number; rows: number }): QueryFn {
  return ({ options }: { options: Options }) =>
    (async function* (): AsyncGenerator<SDKMessage> {
      const cc = (options.mcpServers as any).cc.instance;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await cc.connect(st);
      const client = new Client({ name: 'fake-cli', version: '1' });
      await client.connect(ct);
      yield { type: 'system', subtype: 'init', mcp_servers: [{ name: 'Org62-Sobject-Read', status: 'connected' }, { name: 'cc', status: 'connected' }], tools: [] } as any;
      const post = options.hooks?.PostToolUse?.[0]?.hooks[0];
      await post?.({ hook_event_name: 'PostToolUse', tool_name: 'mcp__Org62-Sobject-Read__soqlQuery', tool_input: { q: SOQL(o.limit) }, tool_response: [{ type: 'text', text: rows(o.rows) }], tool_use_id: 'tu_q', session_id: 's', transcript_path: '', cwd: '' } as any, 'tu_q', { signal: options.abortController!.signal });
      // The agent's mistake: it thinks it paged out at the window start.
      await client.callTool({ name: 'cc_report_coverage', arguments: { windows: [{ kind: 'query_window', ref: 'soql:Opportunity:accounts', from: W.from, to: W.from }] } });
      await client.callTool({ name: 'cc_finish', arguments: { cursor: { value: '2026-10-23T21:17:55.000Z|', at: W.from }, complete: false } });
      yield { type: 'assistant', message: { id: 'm1', model: options.model, content: [{ type: 'text', text: '' }], usage: { input_tokens: 100, output_tokens: 10 } } } as any;
      yield { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'DONE', total_cost_usd: 0.003, usage: { input_tokens: 100, output_tokens: 10 }, modelUsage: {}, permission_denials: [] } as any;
    })() as any;
}

async function run(o: { limit: number; rows: number }) {
  const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
  const ctx = await store.getContext({ connector: 'org62', scope: 'opps' });
  const { runId } = await store.startRun({ scope: { connector: 'org62', scope: 'opps' }, trigger: 'catch_up', window: W });
  const r = await new AgentSdkSkillRunner({ queryFn: scripted(o) }).run({ skillPath: 'skills/scan-org62.md', model: 'claude-haiku-5-5', mcpServers: {}, allowedTools: [], runId, context: ctx, maxTurns: 10, costCapUsd: 0.05, signal: new AbortController().signal, window: W, mode: 'backfill' }, store);
  return { r, store, runId };
}

describe('a quiet Org62 window finished as incomplete (ORG-3)', () => {
  it('no query reached its LIMIT: the runner records it complete through the window end, with whole-window coverage', async () => {
    const { r, store, runId } = await run({ limit: 100, rows: 6 });
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.proposedCursor?.at).toBe(W.to);
    await store.finishRun(runId, { cursor: r.proposedCursor!, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
    expect(await store.coverageGaps({ connector: 'org62', scope: 'opps' }, W)).toEqual([]);
  });

  it("a query that returned its LIMIT keeps the agent's incomplete finish (it really paged out)", async () => {
    const { r } = await run({ limit: 6, rows: 6 });
    expect(r.complete).toBe(false);
    expect(r.proposedCursor?.at).toBe(W.from);
  });
});
