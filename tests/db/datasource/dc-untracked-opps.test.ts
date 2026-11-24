/**
 * DC claims on opps the app doesn't track (D-58), on the db DataSource: the app tracks the opps on my teams and the
 * ones I hold a DC on, so a teammate's deal isn't in it. A claim by its Org62 id reads the record from Org62 (the one
 * read-only lookup) and adds the opp and its account with the request, one change set; a card of several claims reads
 * Org62 once (addOrg62Opps), and a failed Apply undoes the opps it added. Org62 is a fake read here.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ChatChange } from '../../../src/contract';
import type { DbHandle } from '../../../src/db/client';
import { MOCK_ORG62_OPPS, soqlAnswer } from '../../../src/mock/org62-opps';
import { createChatHost } from '../../../src/server/chat/host';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import type { OneLookupResult } from '../../../src/server/onboarding/identity';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;
let off: DbDataSource;
const reads: string[] = [];

const STARK = MOCK_ORG62_OPPS[2]!; // Stark Labs · Data 360 Foundations (an account the app does not have)
const WAYNE = MOCK_ORG62_OPPS[4]!; // Wayne Logistics · Tableau Next Pilot (likewise)
const NOPE = '006XX0000NOPE99AAA';

/** Org62 in this suite: the placeholder records, by one Id or an Id IN (…) list. */
async function fakeRead(look: { connector: 'slack' | 'org62'; tool: string; args: Record<string, unknown> }): Promise<OneLookupResult> {
  const q = String(look.args.q);
  reads.push(q);
  const one = /WHERE Id = '(\w+)'/.exec(q)?.[1];
  const list = /WHERE Id IN \(([^)]*)\)/.exec(q)?.[1];
  const ids = one ? [one] : [...(list ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]!);
  const records = MOCK_ORG62_OPPS.filter((r) => ids.some((i) => r.Id.slice(0, 15) === i.slice(0, 15)));
  return { text: soqlAnswer(records), code: 'ok', message: '', costUsd: 0.0123, inputTokens: 900, outputTokens: 40, model: 'claude-haiku-4-5', started: true };
}

const count = async (q: ReturnType<typeof sql>) => Number((await handle.db.execute<{ n: number }>(q)).rows[0]!.n);
const oppRows = () => count(sql`select count(*)::int as n from opportunities where owner_user_id = ${L.userId} and left(org62_opportunity_id, 15) in (${STARK.Id.slice(0, 15)}, ${WAYNE.Id.slice(0, 15)})`);
const acctRows = () => count(sql`select count(*)::int as n from accounts where owner_user_id = ${L.userId} and name in (${STARK.Account.Name}, ${WAYNE.Account.Name})`);
const requests = async () => (await db.listDcRequests({} as never)).requests;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker, org62Read: fakeRead });
  // live lookups off whatever the shell says: this one never reaches Org62
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
beforeEach(() => {
  reads.length = 0;
});

describe.skipIf(!BE1B)('DC claims on opps the app does not track (db)', () => {
  it('createDcRequest by an untracked Org62 id reads it once, adds the opp and its account with the request; Undo removes all three', async () => {
    expect(await oppRows()).toBe(0);
    const r = await db.createDcRequest({ body: { opp: STARK.Id, split: 100, comment: 'SE support' } });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(new RegExp(`WHERE Id IN \\('${STARK.Id}'\\)`));
    expect(r.entity).toMatchObject({ oppName: STARK.Name, accountName: STARK.Account.Name, org62OpportunityId: STARK.Id, splitPercent: 100, kind: 'add', comment: 'SE support', stage: 'waiting' });
    expect([await oppRows(), await acctRows()]).toEqual([1, 1]);
    // not on my team (the read can't say): the next Org62 scan turns membership on if I am
    const [o] = (await handle.db.execute<{ on_my_team: boolean }>(sql`select on_my_team from opportunities where owner_user_id = ${L.userId} and left(org62_opportunity_id, 15) = ${STARK.Id.slice(0, 15)}`)).rows;
    expect(o?.on_my_team).toBe(false);
    await db.undoAudit({ params: { id: r.auditId! }, body: {} } as never);
    expect([await oppRows(), await acctRows(), (await requests()).length]).toEqual([0, 0, 0]);
  });

  it('an id Org62 does not return is not_found; with Org62 off it is upstream_unavailable; nothing is written', async () => {
    await expect(db.createDcRequest({ body: { opp: NOPE, split: 100, comment: 'SE support' } })).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('Org62 has no Opportunity') });
    await expect(off.createDcRequest({ body: { opp: STARK.Id, split: 100, comment: 'SE support' } })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(db.createDcRequest({ body: { opp: 'not-an-id', split: 100, comment: 'SE support' } })).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('No opportunity') });
    expect([await oppRows(), (await requests()).length]).toEqual([0, 0]);
  });

  it('addOrg62Opps: one read for the untracked ones; tracked ones untouched; missing ones listed; undoable', async () => {
    const tracked = (await db.getOppOptions({ query: {} } as never)).opps.find((o) => o.org62Id)!;
    const r = await db.addOrg62Opps({ body: { org62Ids: [STARK.Id, WAYNE.Id.slice(0, 15), tracked.org62Id!, NOPE] } });
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toContain(tracked.org62Id!.slice(0, 15));
    expect(r.entity.added.map((a) => a.name).sort()).toEqual([STARK.Name, WAYNE.Name].sort());
    expect(r.entity.tracked.map((t) => t.oppId)).toEqual([tracked.id]);
    expect(r.entity.missing).toEqual([NOPE]);
    expect([await oppRows(), await acctRows()]).toEqual([2, 2]);
    const again = await db.addOrg62Opps({ body: { org62Ids: [STARK.Id] } });
    expect(again).toMatchObject({ entity: { added: [], missing: [] }, auditId: null });
    expect(reads).toHaveLength(1);
    await db.undoAudit({ params: { id: r.auditId! }, body: {} } as never);
    expect([await oppRows(), await acctRows()]).toEqual([0, 0]);
  });

  it('a card of claims reads Org62 once on Apply; a failed claim is listed and the rest land (A3), Undo all reverts them', async () => {
    const host = createChatHost(db, db.be6.backend(), () => L.now);
    const claim = (opp: string, label: string): ChatChange => ({ op: 'route_call', route: 'createDcRequest', body: { opp, split: 100, comment: 'SE support' }, label });
    const p = await host.previewChanges([claim(STARK.Id, STARK.Name), claim(WAYNE.Id, WAYNE.Name)], 'thread-untracked');
    expect(p.errors).toEqual([]);
    expect(p.lines.filter((l) => l.field === 'createDcRequest').map((l) => l.label)).toEqual([expect.stringMatching(/^DC claim · Stark Labs.* · added from Org62$/), expect.stringMatching(/^DC claim · Wayne Logistics.* · added from Org62$/)]);
    expect(reads).toHaveLength(0);
    const prop = await host.stageChanges({ threadId: 'thread-untracked', messageId: 'm-untracked', changes: p.changes, lines: p.lines, entity: p.entity, reason: 'Claim 2 DCs?' });
    const applied = await db.applyProposal({ params: { id: prop.id }, body: {} } as never);
    expect(reads).toHaveLength(1);
    expect(applied.receipt!.changes.map((c) => c.field)).toEqual(['addOrg62Opps', 'createDcRequest', 'createDcRequest']);
    expect((await requests()).map((x) => [x.oppName, x.org62OpportunityId]).sort()).toEqual([[STARK.Name, STARK.Id], [WAYNE.Name, WAYNE.Id]].sort());
    for (const c of [...applied.receipt!.changes].reverse()) await db.undoAudit({ params: { id: c.auditId }, body: {} } as never);
    expect([await oppRows(), await acctRows(), (await requests()).length]).toEqual([0, 0, 0]);

    reads.length = 0;
    const bad = await host.previewChanges([claim(STARK.Id, STARK.Name), claim(WAYNE.Id, WAYNE.Name), claim(NOPE, 'A typo')], 'thread-untracked');
    const prop2 = await host.stageChanges({ threadId: 'thread-untracked', messageId: 'm-untracked-2', changes: bad.changes, lines: bad.lines, entity: bad.entity, reason: 'Claim 3 DCs?' });
    const partly = await db.applyProposal({ params: { id: prop2.id }, body: {} } as never);
    expect(partly.receipt).toMatchObject({ total: 3, failed: [{ label: 'A typo', reason: expect.stringMatching(/Org62 has no Opportunity/) }] });
    expect(partly.receipt!.summary).toMatch(/^Applied 2 of 3 · 1 failed/);
    expect([await oppRows(), await acctRows(), (await requests()).length]).toEqual([2, 2, 2]);
    for (const id of [...new Set(partly.receipt!.changes.map((c) => c.auditId))].reverse()) await db.undoAudit({ params: { id }, body: {} } as never);
    expect([await oppRows(), await acctRows(), (await requests()).length]).toEqual([0, 0, 0]);
  });
});
