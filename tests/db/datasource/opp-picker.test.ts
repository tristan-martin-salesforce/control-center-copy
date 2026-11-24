/**
 * The Time row's opportunity picker on Postgres (placeholders only; run with `npm run test:be1b`).
 *
 * Parity: GET /time/opps ranks the same on the mock and on db (several rows, and with no row); after the same Org62
 * pick on both, the row and the ranked list agree. db only: the WhatId fix (a PATCHed opp writes what_org62_id, so a
 * logging batch logs to the new opp; clearing it clears the WhatId), the Org62 search through the one read-only
 * lookup (a fake runner: the scan allowlist's soqlQuery, the word query, the spend row), the pick that re-reads the
 * record by id and adds the opp + account the way the Org62 projection does, one undoable change set, and the
 * "not available here" answer when live lookups are off.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OppOptions, Org62OppSearch } from '../../../src/contract';
import { actors, withChangeSet } from '../../../src/db/changeset';
import type { DbHandle } from '../../../src/db/client';
import { MOCK_ORG62_OPPS, searchMockOrg62Opps, soqlAnswer } from '../../../src/mock/org62-opps';
import { DbDataSource } from '../../../src/server/datasource/db';
import { uuidFor } from '../../../src/server/datasource/db/ids';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { buildLogBatch } from '../../../src/server/datasource/db/store/log-batch';
import type { OneLookupResult } from '../../../src/server/onboarding/identity';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';
import { both, dropKeys } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;
let off: DbDataSource;
const reads: Array<{ connector: string; tool: string; q: string }> = [];
/** What the Account SELECT answers (D-103 (c)): none unless a test sets it. */
let accountAnswer: Array<Record<string, unknown>> = [];

/** What Org62 answers in this suite: the placeholder records, for the word search or one Id. */
async function fakeRead(look: { connector: 'slack' | 'org62'; tool: string; args: Record<string, unknown> }): Promise<OneLookupResult> {
  const q = String(look.args.q);
  reads.push({ connector: look.connector, tool: look.tool, q });
  if (/FROM Account /.test(q)) return { text: JSON.stringify({ totalSize: accountAnswer.length, done: true, records: accountAnswer }), code: 'ok', message: '', costUsd: 0.001, inputTokens: 900, outputTokens: 40, model: 'claude-haiku-4-5', started: true };
  const byId = /WHERE Id = '(\w+)'/.exec(q)?.[1];
  const words = [...q.matchAll(/\(Name LIKE '%([^%]+)%'/g)].map((m) => m[1]!);
  const records = byId ? MOCK_ORG62_OPPS.filter((r) => r.Id === byId) : searchMockOrg62Opps(words.join(' '));
  return { text: soqlAnswer(records), code: 'ok', message: '', costUsd: 0.0123, inputTokens: 900, outputTokens: 40, model: 'claude-haiku-4-5', started: true };
}

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker, org62Read: fakeRead });
  // live lookups off whatever the shell says: this suite never calls Org62
  const llm = process.env.CC_CHAT_LLM;
  process.env.CC_CHAT_LLM = '0';
  off = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
  if (llm === undefined) delete process.env.CC_CHAT_LLM;
  else process.env.CC_CHAT_LLM = llm;
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await off?.dispose();
  await handle?.close();
});

const T = (id: string) => L.idMap.get(id) ?? id;
/** Test setup on audited tables goes through a change set, like every write. */
const setup = (q: ReturnType<typeof sql>) => withChangeSet({ db: handle.db, userId: L.userId, actor: actors.user('test'), reason: 'test setup', undoable: false }, (tx) => tx.execute(q));
/** A seed row as db reads it now (the seed is shifted to this week). */
const rowOf = async (seedId: string) => (await db.getActivityLog({ query: {} })).entries.find((e) => e.id === T(seedId))!;
const what = async (id: string) =>
  (await handle.db.execute<{ what_kind: string; what_org62_id: string | null; what_name: string | null }>(sql`select what_kind::text, what_org62_id, what_name from activity_entries where id = ${id}::uuid`)).rows[0];
const batchLine = async (subject: string) => {
  const b = await buildLogBatch(handle.db, L.userId, { now: L.now, timezone: 'America/Denver', approveComplete: false, recordTypeId: '012XX0000000MOCKAA', held: { rows: new Map(), updates: new Set() } });
  return { line: b.canvases.flatMap((c) => c.markdown.split('\n')).find((l) => l.includes(subject)) ?? null, skipped: b.skipped };
};
const STARK = MOCK_ORG62_OPPS[2]!; // Stark Labs · Data 360 Foundations (an account the app does not have)

describe.runIf(BE1B)('opp picker parity: mock ↔ db', () => {
  for (const entryId of ['ac_wed_hooli', 'ac_tue_globex', 'ac_mon_acme', 'ac_wed_internal', undefined]) {
    it(`GET /time/opps ranks the same · ${entryId ?? 'no row'}`, async () => {
      const r = await both(L, db, 'getOppOptions', { query: entryId ? { entryId } : {} });
      expect(r.diffs, r.diffs.join('\n')).toEqual([]);
      expect(OppOptions.parse(r.raw.db).opps.length).toBeGreaterThan(3);
    });
  }

  it('the same Org62 pick on both: the row and the ranked list agree, and both undo', async () => {
    const reads0 = reads.length;
    // runtime ids differ by design (the mock's opp_o62_… vs the projection's uuid); a source's externalId is only
    // id-translated on the mock side, and the pick never touches sources
    const ignoreNewIds = (v: unknown) => dropKeys(v, ['oppId', 'auditId', 'updatedAt', 'version', 'sources']);
    const r = await both(L, db, 'pickOrg62Opp', { params: { id: 'ac_wed_hooli' }, body: { org62Id: STARK.Id } }, { times: true, shape: ignoreNewIds });
    expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    const m = r.raw.mock as { entity: { oppId: string }; auditId: string };
    const d = r.raw.db as { entity: { oppId: string }; auditId: string };
    expect(d.entity.oppId).toBe(uuidFor(`proj:opportunity:${L.userId}:${STARK.Id}`)); // the row id the Org62 projection gives it
    expect(reads.slice(reads0)).toEqual([{ connector: 'org62', tool: 'soqlQuery', q: expect.stringMatching(new RegExp(`FROM Opportunity WHERE Id = '${STARK.Id}' LIMIT 1$`)) }]);

    const list = await both(L, db, 'getOppOptions', { query: { entryId: 'ac_wed_hooli' } }, { shape: (v) => dropKeys(v, ['id', 'accountId']) });
    expect(list.diffs, list.diffs.join('\n')).toEqual([]);
    expect(OppOptions.parse(list.raw.db).opps[0]).toMatchObject({ id: d.entity.oppId, name: STARK.Name, accountName: 'Stark Labs' });

    await L.mock.undoAudit({ params: { id: m.auditId }, body: {} });
    await db.undoAudit({ params: { id: d.auditId }, body: {} });
    const back = await both(L, db, 'getOppOptions', { query: { entryId: 'ac_wed_hooli' } });
    expect(back.diffs, back.diffs.join('\n')).toEqual([]);
  });
});

describe.runIf(BE1B)('opp picker on db', () => {
  it('a PATCHed opp moves the WhatId: the logging batch logs to the new opp; clearing it clears the WhatId', async () => {
    // a placeholder Org62 id on the seed's Globex renewal (it has none); the row's own opp (Globex Data 360) carries one
    // in the seed since D-63, so it is cleared here: the row starts with no WhatId
    const renewOrg62 = '006XX0000PICK01AAA';
    await setup(sql`update opportunities set org62_opportunity_id = ${renewOrg62} where id = ${T('opp_globex_renew')}::uuid`);
    await setup(sql`update opportunities set org62_opportunity_id = 'cc:opp-picker-test' where id = ${T('opp_globex_d360')}::uuid`);
    await setup(sql`update activity_entries set what_org62_id = null where id = ${T('ac_tue_sow')}::uuid`);
    const id = T('ac_tue_sow');
    const cur = await rowOf('ac_tue_sow');
    expect(await what(id)).toMatchObject({ what_org62_id: null }); // its opp has no Org62 id: no WhatId yet
    const before = await batchLine(cur.description);
    expect(before.skipped.find((s) => s.id === id)?.why).toMatch(/WhatId/);

    const r = await db.patchActivity({ params: { id }, body: { ifVersion: cur.version, patch: { oppId: T('opp_globex_renew') } } });
    expect(r.entity).toMatchObject({ oppId: T('opp_globex_renew'), oppName: 'Globex · Renewal FY27', userLockedFields: expect.arrayContaining(['oppId']) });
    expect(await what(id)).toEqual({ what_kind: 'opportunity', what_org62_id: renewOrg62, what_name: 'Globex · Renewal FY27' });
    const after = await batchLine(cur.description);
    expect(after.line).toContain(`|${renewOrg62}|`);
    expect(after.skipped.some((s) => s.id === id)).toBe(false);

    // another field edit leaves the WhatId alone
    await db.patchActivity({ params: { id }, body: { ifVersion: r.entity.version, patch: { description: `${cur.description} (edited)` } } });
    expect((await what(id))!.what_org62_id).toBe(renewOrg62);

    const v = (await rowOf('ac_tue_sow')).version;
    await db.patchActivity({ params: { id }, body: { ifVersion: v, patch: { oppId: null } } });
    expect(await what(id)).toEqual({ what_kind: 'none', what_org62_id: null, what_name: null });
    expect((await batchLine(cur.description)).skipped.find((s) => s.id === id)?.why).toMatch(/WhatId/);
  });

  it('Search Org62: one read-only soqlQuery with the word query, hits marked, the spend recorded like the Assistant\'s', async () => {
    const reads0 = reads.length;
    const calls0 = Number((await handle.db.execute<{ n: string }>(sql`select count(*) as n from llm_calls where request_hash like 'time:opp-picker:%'`)).rows[0]!.n);
    const s = Org62OppSearch.parse(await db.searchOrg62Opps({ body: { q: 'stark' } }));
    expect(s.simulated).toBe(false);
    expect(s.hits.map((h) => h.name)).toEqual(['Stark Labs · Agentforce Field Service', 'Stark Labs · Data 360 Foundations']);
    expect(s.hits.every((h) => h.oppId === null && h.accountId === null)).toBe(true);
    // D-103 (c): one more fixed SELECT on Account, the same read-only tool
    expect(reads.slice(reads0)).toEqual([
      { connector: 'org62', tool: 'soqlQuery', q: expect.stringContaining("WHERE (Name LIKE '%stark%' OR Account.Name LIKE '%stark%') AND IsClosed = false") },
      { connector: 'org62', tool: 'soqlQuery', q: "SELECT Id, Name, Type, Owner.Name FROM Account WHERE Name LIKE '%stark%' ORDER BY Name LIMIT 5" },
    ]);
    const spend = (await handle.db.execute<{ n: string; skill: string; purpose: string; cost: string }>(sql`
      select count(*) as n, max(skill_key) as skill, max(purpose::text) as purpose, sum(cost_usd) as cost from llm_calls where request_hash like 'time:opp-picker:%'`)).rows[0]!;
    expect(Number(spend.n)).toBe(calls0 + 2);
    expect(spend).toMatchObject({ skill: 'read-lookup', purpose: 'chat' });
    // the mock lists the same placeholder records
    const m = Org62OppSearch.parse(await L.mock.searchOrg62Opps({ body: { q: 'stark' } }));
    expect(m.hits.map((h) => [h.org62Id, h.name, h.accountName, h.stage, h.closeDate, h.isOpen])).toEqual(s.hits.map((h) => [h.org62Id, h.name, h.accountName, h.stage, h.closeDate, h.isOpen]));
  });

  it('D-103 (c): an account hit the app has logs the row to the account: what_kind account, the Account WhatId on the batch', async () => {
    const acctOrg62 = '001XX0000PICKA1AAA';
    await setup(sql`update accounts set org62_account_id = ${acctOrg62}, org62_url = null where id = ${T('acc_globex')}::uuid`);
    accountAnswer = [{ Id: acctOrg62, Name: 'Globex', Type: 'Customer', Owner: { Name: 'Placeholder AE' } }];
    const s = Org62OppSearch.parse(await db.searchOrg62Opps({ body: { q: 'globex' } }));
    accountAnswer = [];
    const hit = s.hits.find((h) => h.kind === 'account');
    expect(hit).toMatchObject({ org62Id: acctOrg62, name: 'Globex', oppId: null, accountId: T('acc_globex') });
    const cur = await rowOf('ac_wed_roadmap');
    const r = await db.patchActivity({ params: { id: cur.id }, body: { ifVersion: cur.version, patch: { target: { kind: 'account', id: hit!.accountId! } } } });
    expect(r.entity).toMatchObject({ accountId: T('acc_globex'), oppId: null, suggestion: null });
    expect(r.entity.groundwork?.text).toMatch(/Globex/);
    expect(await what(cur.id)).toEqual({ what_kind: 'account', what_org62_id: acctOrg62, what_name: 'Globex' });
    // the mock reads the same row the same way
    const m0 = (await L.mock.getActivityLog({ query: {} })).entries.find((e) => e.id === 'ac_wed_roadmap')!;
    const m = await L.mock.patchActivity({ params: { id: m0.id }, body: { ifVersion: m0.version, patch: { target: { kind: 'account', id: 'acc_globex' } } } });
    expect([m.entity.accountId, m.entity.oppId, m.entity.groundwork?.code]).toEqual(['acc_globex', null, r.entity.groundwork?.code]);
  });

  it('a pick adds the opp and its account the Org62 way, sets the WhatId, and Undo removes them again', async () => {
    const id = T('ac_wed_hooli');
    const cur = await rowOf('ac_wed_hooli');
    const r = await db.pickOrg62Opp({ params: { id }, body: { ifVersion: cur.version, org62Id: STARK.Id } });
    const opp = (await handle.db.execute<{ id: string; account_id: string; on_my_team: boolean; stage: string }>(sql`select id, account_id, on_my_team, stage from opportunities where org62_opportunity_id = ${STARK.Id}`)).rows[0]!;
    const acct = (await handle.db.execute<{ id: string; name: string; is_my_book: boolean }>(sql`select id, name, is_my_book from accounts where org62_account_id = ${STARK.AccountId}`)).rows[0]!;
    expect(opp).toMatchObject({ id: uuidFor(`proj:opportunity:${L.userId}:${STARK.Id}`), account_id: acct.id, on_my_team: false, stage: 'Discovery' });
    expect(acct).toMatchObject({ id: uuidFor(`proj:account:${L.userId}:${STARK.AccountId}`), name: 'Stark Labs', is_my_book: true });
    expect(r.entity).toMatchObject({ oppId: opp.id, oppName: STARK.Name, accountName: 'Stark Labs' });
    expect(await what(id)).toEqual({ what_kind: 'opportunity', what_org62_id: STARK.Id, what_name: STARK.Name });
    const deal = (await db.getDeals({} as never)).accounts.find((a) => a.name === 'Stark Labs');
    expect(deal?.org62Url).toContain(STARK.AccountId);

    // picking the same record again reads nothing (the app has it now)
    const reads0 = reads.length;
    const again = await db.pickOrg62Opp({ params: { id }, body: { ifVersion: r.entity.version, org62Id: STARK.Id } });
    expect(again.entity.oppId).toBe(opp.id);
    expect(reads.length).toBe(reads0);

    // one undoable change set: Undo the first pick → opp, account and the row's WhatId are gone
    await db.undoAudit({ params: { id: r.auditId! }, body: {} });
    expect(Number((await handle.db.execute<{ n: string }>(sql`select count(*) as n from opportunities where org62_opportunity_id = ${STARK.Id}`)).rows[0]!.n)).toBe(0);
    expect(Number((await handle.db.execute<{ n: string }>(sql`select count(*) as n from accounts where org62_account_id = ${STARK.AccountId}`)).rows[0]!.n)).toBe(0);
    expect(await what(id)).toEqual({ what_kind: 'none', what_org62_id: null, what_name: null });
  });

  it('an account the app has keeps its record; a logged row and an unknown record are refused', async () => {
    // give the seed's Globex its Org62 id: a Globex record the app lacks lands on that account, untouched
    const globex = MOCK_ORG62_OPPS[0]!;
    await setup(sql`update accounts set org62_account_id = ${globex.AccountId} where id = ${T('acc_globex')}::uuid`);
    const before = (await db.getDeals({} as never)).accounts.find((a) => a.id === T('acc_globex'))!;
    const id = T('ac_wed_nce');
    const cur = await rowOf('ac_wed_nce');
    const r = await db.pickOrg62Opp({ params: { id }, body: { ifVersion: cur.version, org62Id: globex.Id } });
    expect(r.entity).toMatchObject({ oppName: globex.Name, accountName: 'Globex' });
    const after = (await db.getDeals({} as never)).accounts.find((a) => a.id === T('acc_globex'))!;
    expect({ dcStatus: after.dcStatus, hoursQtd: after.hoursQtd, name: after.name }).toEqual({ dcStatus: before.dcStatus, hoursQtd: before.hoursQtd, name: before.name });
    expect(Number((await handle.db.execute<{ n: string }>(sql`select count(*) as n from accounts where name = 'Globex'`)).rows[0]!.n)).toBe(1);
    await db.undoAudit({ params: { id: r.auditId! }, body: {} });

    await expect(db.pickOrg62Opp({ params: { id: T('ac_mon_prep') }, body: { org62Id: STARK.Id } })).rejects.toMatchObject({ code: 'validation' });
    await expect(db.pickOrg62Opp({ params: { id: T('ac_wed_hooli') }, body: { org62Id: '006XX0000NOPE99AAA' } })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('live lookups off (no CC_CHAT_LLM): the search says so and a pick of a record the app lacks is unavailable', async () => {
    const s = Org62OppSearch.parse(await off.searchOrg62Opps({ body: { q: 'stark' } }));
    expect(s).toMatchObject({ simulated: true, hits: [] });
    expect(s.notes[0]).toMatch(/not available here/);
    await expect(off.pickOrg62Opp({ params: { id: T('ac_wed_hooli') }, body: { org62Id: STARK.Id } })).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});
