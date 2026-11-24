/**
 * FTI Org62 fetch: the windowed queries of scan-org62 §2 issued by code (the same text the skill gives the agent),
 * paged by code (keyset filter, 2+ pages, overflow halving), recorded by REC-2 exactly as the agentic path records the
 * same results.
 */
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createRunState } from '@/llm/cc-tools';
import { Org62AutoRecorder } from '@/llm/org62-rec';
import { soqlDateTime } from '@/llm/skill-loader';
import { fetchOrg62Scope, org62Queries, soqlPage } from '@/scanner/fetch';
import { InMemoryScannerStore } from '@/scanner/store-memory';

import { fakeRelay } from './helpers';

const ME = '005XX0000000001AAA';
const WINDOW = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-06T00:00:00.000Z' };
const fixture = (name: string) => fs.readFileSync(`tests/fixtures/scanner/org62/${name}.soql.v1.json`, 'utf8');

function store() {
  return new InMemoryScannerStore({ clock: { now: () => new Date(WINDOW.to) }, profile: { me: { userId: 'u', name: 'ME', org62UserId: ME }, watchList: [], aliases: { accounts: [], channels: [] } } });
}

async function run(s: InMemoryScannerStore, scope: string, relay = fakeRelay('org62', () => fixture('event')), extra: { maxPages?: number; mode?: string } = {}) {
  const { runId } = await s.startRun({ scope: { connector: 'org62', scope }, trigger: 'schedule', window: WINDOW });
  const ctx = await s.getContext({ connector: 'org62', scope });
  const state = createRunState({ runId, connector: 'org62', window: WINDOW, context: ctx });
  const r = await fetchOrg62Scope({ scope, window: WINDOW, mode: extra.mode ?? 'incremental', ctx, vars: { 'org62.accountIds': "'001XX0000000001AAA'", 'org62.book': 'both' }, runtime: relay, store: s, state, signal: new AbortController().signal, ...(extra.maxPages ? { maxPages: extra.maxPages } : {}) });
  return { r, relay, state };
}

const rows = (s: InMemoryScannerStore) => [...(s as unknown as { sourceItems: Map<string, { dedupeKey: string; contentHash: string; excerpt?: string; payload?: unknown }> }).sourceItems.values()].map((x) => ({ k: x.dedupeKey, h: x.contentHash, e: x.excerpt, p: x.payload })).sort((a, b) => a.k.localeCompare(b.k));

describe('org62 queries (scan-org62 §2 verbatim)', () => {
  it('match the skill text after its placeholders are filled', () => {
    const skill = fs.readFileSync('skills/scan-org62.md', 'utf8');
    const blocks = [...skill.matchAll(/```\n(SELECT[\s\S]*?)\n```/g)].map((m) => m[1]!.trim());
    const fill = (q: string) => q.replace(/\{\{me\.org62UserId\}\}/g, ME).replace(/\{\{window\.fromSoql\}\}/g, soqlDateTime(WINDOW.from)).replace(/\{\{window\.toSoql\}\}/g, soqlDateTime(WINDOW.to)).replace(/\{\{org62\.accountIds\}\}/g, "'001XX0000000001AAA'");
    const ours = [...org62Queries('opps', WINDOW, { 'org62.accountIds': "'001XX0000000001AAA'", 'org62.book': 'both' }, ME)!, ...org62Queries('events', WINDOW, {}, ME)!, ...org62Queries('dcs', WINDOW, {}, ME)!].map((q) => soqlPage(q, q.limit));
    for (const q of ours) expect(blocks.map(fill)).toContain(q);
  });
  it('Q2 only with accounts, Q3 only for an owner book; book and missed_opps stay with the agent', () => {
    expect(org62Queries('opps', WINDOW, {}, ME)!.map((q) => q.ref)).toEqual(['soql:OpportunityTeamMember']);
    expect(org62Queries('opps', WINDOW, { 'org62.book': 'owner' }, ME)!.map((q) => q.ref)).toEqual(['soql:OpportunityTeamMember', 'soql:Opportunity:owned']);
    expect(org62Queries('book', WINDOW, {}, ME)).toBeNull();
    expect(org62Queries('missed_opps', WINDOW, {}, ME)).toBeNull();
    expect(org62Queries('events', WINDOW, {}, undefined)).toBeNull();
  });
  it('caps audit: a book of 450 accounts is three IN clauses of at most 200, never the first 200 only', () => {
    const ids = Array.from({ length: 450 }, (_, i) => `'001XX${String(i).padStart(10, '0')}AAA'`);
    const qs = org62Queries('opps', WINDOW, { 'org62.accountIds': ids.join(',') }, ME)!.filter((q) => q.ref.startsWith('soql:Opportunity:accounts'));
    expect(qs.map((q) => q.ref)).toEqual(['soql:Opportunity:accounts', 'soql:Opportunity:accounts:2', 'soql:Opportunity:accounts:3']);
    const inList = (q: { base: string }) => /AccountId IN \(([^)]*)\)/.exec(q.base)![1]!.split(',');
    expect(qs.map((q) => inList(q).length)).toEqual([200, 200, 50]);
    expect(qs.flatMap(inList)).toEqual(ids);
  });
  it('the paging filter uses the query ORDER BY fields (the team query pages by Opportunity.*)', () => {
    const [team] = org62Queries('opps', WINDOW, {}, ME)!;
    expect(soqlPage(team!, 50, { stamp: '2026-10-02T00:00:00.000+0000', id: '006A' })).toContain("AND (Opportunity.SystemModstamp > 2026-10-02T00:00:00.000+0000 OR (Opportunity.SystemModstamp = 2026-10-02T00:00:00.000+0000 AND OpportunityId > '006A')) ORDER BY Opportunity.SystemModstamp, OpportunityId LIMIT 50");
  });
});

describe('fetch parity with the agentic path (REC-2, same rows)', () => {
  for (const [scope, name] of [['events', 'event'], ['dcs', 'dc'], ['opps', 'opp_team']] as const) {
    it(`${scope}: the same record snapshots as REC-2 on the same results`, async () => {
      const a = store();
      const fti = await run(a, scope, fakeRelay('org62', (_t, args) => (String(args.q).includes(name === 'opp_team' ? 'FROM OpportunityTeamMember' : 'FROM') ? fixture(name) : JSON.stringify({ totalSize: 0, done: true, records: [] }))));
      const b = store();
      const { runId } = await b.startRun({ scope: { connector: 'org62', scope }, trigger: 'schedule', window: WINDOW });
      const ctx = await b.getContext({ connector: 'org62', scope });
      const rec = new Org62AutoRecorder(b, createRunState({ runId, connector: 'org62', window: WINDOW, context: ctx }));
      for (const [i, c] of fti.relay.calls.entries()) await rec.onToolResult('mcp__Org62-Sobject-Read__soqlQuery', c.args, [{ type: 'text', text: String(c.args.q).includes(name === 'opp_team' ? 'FROM OpportunityTeamMember' : 'FROM') ? fixture(name) : JSON.stringify({ totalSize: 0, done: true, records: [] }) }], `tu_${i}`);
      expect(rows(a).length).toBeGreaterThan(0);
      expect(rows(a)).toEqual(rows(b));
      expect(fti.r.complete).toBe(true);
    });
  }
});

describe('paging, overflow, refusal', () => {
  const page = (n: number, from: number) => JSON.stringify({ totalSize: n, done: true, records: Array.from({ length: n }, (_, i) => ({ attributes: { type: 'Event' }, Id: `00UXX${String(from + i).padStart(13, '0')}`, Subject: `E${from + i}`, StartDateTime: '2026-10-07T19:00:00.000+0000', EndDateTime: '2026-10-07T20:00:00.000+0000', SystemModstamp: `2026-10-${String(2 + Math.floor((from + i) / 40)).padStart(2, '0')}T00:00:${String((from + i) % 60).padStart(2, '0')}.000+0000` })) });

  it('a full page reads on with the keyset filter; past maxPages the run finishes at the last row read', async () => {
    let n = 0;
    const relay = fakeRelay('org62', () => page(40, 40 * n++));
    const { r } = await run(store(), 'events', relay, { maxPages: 2 });
    expect(relay.calls).toHaveLength(2);
    expect(String(relay.calls[1]!.args.q)).toMatch(/AND \(SystemModstamp > 2026-10-02T00:00:39\.000\+0000 OR \(SystemModstamp = .* AND Id > '00UXX0000000000039'\)\)/);
    expect(r.complete).toBe(false);
    expect(r.cursor.value).toBe('2026-10-03T00:00:19.000+0000|00UXX0000000000079');
    expect(r.cursor.at).toBe('2026-10-03T00:00:19.000Z');
    expect(r.coverage[0]!.to).toBe('2026-10-03T00:00:19.000Z');
  });

  it('a short page ends the query; the run is complete with the window-end cursor', async () => {
    const { r } = await run(store(), 'events', fakeRelay('org62', () => page(3, 0)));
    expect(r.complete).toBe(true);
    expect(r.cursor).toEqual({ value: soqlDateTime(WINDOW.to), at: WINDOW.to });
  });

  it('a continuation starts from its `<stamp>|<id>` cursor', async () => {
    const s = store();
    await s.startRun({ scope: { connector: 'org62', scope: 'events' }, trigger: 'schedule', window: WINDOW }).then(async ({ runId }) => {
      await s.reportCoverage(runId, [{ kind: 'query_window', ref: 'soql:Event', from: WINDOW.from, to: '2026-10-03T00:00:19.000Z' }]);
      await s.finishRun(runId, { cursor: { value: '2026-10-03T00:00:19.000+0000|00UXX0000000000079', at: '2026-10-03T00:00:19.000Z' }, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
    });
    const relay = fakeRelay('org62', () => page(1, 80));
    await run(s, 'events', relay, { mode: 'continuation' });
    expect(String(relay.calls[0]!.args.q)).toContain("Id > '00UXX0000000000079'");
  });

  it('a result over the output cap is read again at half the LIMIT (≥ 10)', async () => {
    const relay = fakeRelay('org62', (_t, args) => (/LIMIT 40$/.test(String(args.q)) ? 'Error: the tool output exceeds the maximum allowed tokens' : page(2, 0)));
    const { r } = await run(store(), 'events', relay);
    expect(relay.calls.map((c) => /LIMIT (\d+)$/.exec(String(c.args.q))![1])).toEqual(['40', '20']);
    expect(r.complete).toBe(true);
  });

  it('a refused query stops with soql_invalid (config), never improvised', async () => {
    const err = await run(store(), 'events', fakeRelay('org62', () => '[{"errorCode":"INVALID_FIELD","message":"No such column"}]')).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ScopeFetchError', errorClass: 'config', code: 'soql_invalid' });
  });
});
