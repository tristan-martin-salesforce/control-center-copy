/**
 * Caps audit finding (26-caps-audit.md, "Findings for other lanes"): the team discovery query put me and every covered
 * AE in one `UserId IN (...)`. teamChunks packs ids under Salesforce's real limits (100,000-character statement,
 * 16,384-byte REST URI, both with margin); readTeam reads the chunks in sequence through the one-call read path, pages
 * by Id past a full page or `done: false`, and merges by opportunity id. Pure: a fake `read`, no Org62.
 */
import { describe, expect, it } from 'vitest';

import { DISCOVER_LIMIT, readTeam, teamChunks, teamPageSoql, teamSoql, teamSoqls, TEAM_SOQL_MAX_CHARS, TEAM_SOQL_MAX_URI_BYTES, type DiscoverRead } from '@/engines/attribution/discover';

const user = (i: number) => `005SMPL${String(i).padStart(8, '0')}AAA`;
const users = (n: number) => Array.from({ length: n }, (_, i) => user(i + 1));
const me = '005SMPL99999999AAA';

const fits = (soql: string) => soql.length <= TEAM_SOQL_MAX_CHARS && encodeURIComponent(soql).length <= TEAM_SOQL_MAX_URI_BYTES;
const idsIn = (soql: string) => [...(/UserId IN \(([^)]*)\)/.exec(soql)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);

const row = (teamId: string, opp: string, userId: string) => ({ attributes: { type: 'OpportunityTeamMember' }, Id: teamId, OpportunityId: opp, UserId: userId, TeamMemberRole: 'Account Executive', Opportunity: { Name: `Opp ${opp}`, AccountId: '001SMPL00000001AAA', IsClosed: false, IsWon: false, OwnerId: userId, Owner: { Name: 'AE' } } });
const answer = (records: unknown[], done = true) => JSON.stringify({ totalSize: records.length, done, records });

describe('teamChunks / teamSoqls: the covered-AE IN list stays under the statement limits', () => {
  it('1 AE (and me): one statement, unchanged shape', () => {
    const qs = teamSoqls([me, user(1)]);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toBe(teamSoql([me, user(1)]));
    expect(qs[0]).toMatch(/^SELECT Id, OpportunityId, .* FROM OpportunityTeamMember WHERE UserId IN \('005SMPL99999999AAA', '005SMPL00000001AAA'\) AND Opportunity.IsClosed = false ORDER BY Id LIMIT 200$/);
  });

  it('60 AEs: still one statement with every id', () => {
    const qs = teamSoqls([me, ...users(60)]);
    expect(qs).toHaveLength(1);
    expect(idsIn(qs[0]!)).toHaveLength(61);
    expect(fits(qs[0]!)).toBe(true);
  });

  it('2,000 AEs (18-character ids): several statements, each inside both limits, every id exactly once', () => {
    const ids = [me, ...users(2000)];
    const qs = teamSoqls(ids);
    expect(qs.length).toBeGreaterThan(1);
    for (const x of qs) expect(fits(x)).toBe(true);
    // the paged form (longest Id > '...' clause) fits too
    for (const c of teamChunks(ids)) expect(fits(teamPageSoql(c, '00QSMPL00000001AAA'))).toBe(true);
    const all = qs.flatMap(idsIn);
    expect(all).toHaveLength(ids.length);
    expect(new Set(all)).toEqual(new Set(ids));
    expect(() => teamSoql(ids)).toThrow(/use readTeam/);
  });

  it('a budget only the 100,000-character limit binds (no URI bound) packs ~4,000 ids per statement', () => {
    const ids = users(5000);
    const qs = teamSoqls(ids, { maxUriBytes: Number.POSITIVE_INFINITY });
    expect(qs).toHaveLength(2);
    for (const x of qs) expect(x.length).toBeLessThanOrEqual(TEAM_SOQL_MAX_CHARS);
  });

  it('drops non-ids and folds the 15- and 18-character forms of one user', () => {
    expect(teamChunks([user(1), user(1).slice(0, 15), "x' OR 1=1", user(2)])).toEqual([[user(1), user(2)]]);
    expect(() => teamSoqls(['nope'])).toThrow(/no user ids/);
  });
});

describe('readTeam: chunks in sequence, pages, merged and deduped', () => {
  it('reads every chunk in order and merges a record seen in two chunks once (team rows from both)', async () => {
    const ids = [me, ...users(2000)];
    const chunks = teamChunks(ids);
    const last = chunks.at(-1)!.at(-1)!;
    const seen: string[] = [];
    const read: DiscoverRead = async (soql) => {
      seen.push(soql);
      const inList = idsIn(soql);
      // the same opp has me (chunk 1) and the last AE (last chunk) on its team; each chunk also sees it
      const recs = [];
      if (inList.includes(me)) recs.push(row('00QSMPL00000001AAA', '006SMPL00000001AAA', me));
      if (inList.includes(last)) recs.push(row('00QSMPL00000002AAA', '006SMPL00000001AAA', last), row('00QSMPL00000003AAA', '006SMPL00000002AAA', last));
      return answer(recs);
    };
    const into = new Map();
    const r = await readTeam(ids, read, into);
    expect(r).toEqual({ statements: chunks.length, reads: chunks.length, partial: null });
    expect(seen).toEqual(teamSoqls(ids));
    expect(into.size).toBe(2);
    expect(into.get('006SMPL00000001').team.map((t: { userId: string }) => t.userId)).toEqual([me, last]);
  });

  it('pages by Id past a full page and past done:false (more than 2,000 rows), then stops', async () => {
    const limit = DISCOVER_LIMIT;
    const total = 2_450;
    const rows = Array.from({ length: total }, (_, i) => row(`00QSMPL${String(i + 1).padStart(8, '0')}AAA`, `006SMPL${String(i + 1).padStart(8, '0')}AAA`, user(1)));
    const calls: string[] = [];
    const read: DiscoverRead = async (soql) => {
      calls.push(soql);
      const after = /AND Id > '([^']+)'/.exec(soql)?.[1];
      const from = after ? rows.findIndex((x) => x.Id === after) + 1 : 0;
      const pageRows = rows.slice(from, from + limit);
      // one page comes back short of the limit but not done (a nextRecordsUrl the one-call path does not follow)
      if (from === limit * 3) return answer(pageRows.slice(0, 50), false);
      return answer(pageRows);
    };
    const into = new Map();
    const r = await readTeam([user(1)], read, into);
    expect(r.partial).toBeNull();
    expect(into.size).toBe(total);
    expect(calls.length).toBe(Math.ceil((total - 50) / limit) + 2);
    expect(calls[0]).not.toMatch(/Id >/);
    expect(calls[1]).toContain(`AND Id > '${rows[limit - 1]!.Id}'`);
  });

  it('stops at a refused or unfinished read and keeps what it read', async () => {
    const ids = [me, ...users(2000)];
    let n = 0;
    const capped = await readTeam(ids, async () => (n++ === 0 ? answer([row('00QSMPL00000001AAA', '006SMPL00000001AAA', me)]) : 'cap'));
    expect(capped).toMatchObject({ reads: 1, partial: 'cap' });
    const failed = await readTeam([me], async () => null);
    expect(failed).toMatchObject({ reads: 0, partial: 'lookup_failed' });
  });
});
