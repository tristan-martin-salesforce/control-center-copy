/**
 * One-off check on a DB copy (never the live DB): a Settle close through settleApply shows in Triage's Closed for you
 * group with its reason and message link, its evidence is linked, and Undo restores the item. Prints counts only.
 */
import { sql } from 'drizzle-orm';
import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';
import { DbDataSource } from '../../src/server/datasource/db';
const url = resolveDatabaseUrl();
if (['command_center', 'control_center'].includes(databaseName(url))) throw new Error('refusing to run on the live database');
const handle = createDb({ url, max: 2, applicationName: 'settle-verify' });
const u = (await handle.db.execute<{ id: string }>(sql`select id from users where is_active limit 1`)).rows[0]!;
const ds = new DbDataSource({ handle, userId: u.id });
const it = (await handle.db.execute<{ id: string; status: string; src: string; url: string | null }>(sql`
  select w.id::text as id, w.status::text as status, s.id::text as src, s.url from work_items w
    join work_item_evidence e on e.work_item_id = w.id and e.role = 'origin' join source_items s on s.id = e.source_item_id
   where w.status = 'open' and s.url is not null limit 1`)).rows[0]!;
const r = await ds.settleApply([{ itemId: it.id, expectedState: it.status, action: 'close', reasonClass: 'done_by_you', resolution: 'done_by_me', reason: 'You sent it 2 h after the ask', verdict: 'done_by_you', confidence: 0.9, check: 'settle-item@verify', cite: { sourceItemId: it.src, url: it.url ?? undefined, fromMe: true } }]);
const t = await ds.getTriage({} as never);
const row = t.groups.find((g) => g.group === 'closed_for_you')?.items.find((i) => i.id === it.id);
const ev = (await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from work_item_evidence where work_item_id = ${it.id}::uuid and rationale like 'settle:%'`)).rows[0]?.n;
console.log(JSON.stringify({ applied: r.applied, inClosedGroup: !!row, reason: row?.workItem?.resolutionDetail?.settle?.reason ?? null, hasLink: !!row?.workItem?.resolutionDetail?.settle?.sourceUrl, why: row?.why ?? null, undoId: !!row?.undoAuditId, settleEvidence: ev }));
await ds.undoAudit({ params: { id: row!.undoAuditId! }, body: {} } as never);
const after = (await handle.db.execute<{ status: string }>(sql`select status::text from work_items where id = ${it.id}::uuid`)).rows[0]?.status;
const ev2 = (await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from work_item_evidence where work_item_id = ${it.id}::uuid and rationale like 'settle:%'`)).rows[0]?.n;
console.log(JSON.stringify({ afterUndo: after, settleEvidenceAfterUndo: ev2 }));
await ds.dispose();
await handle.close();
