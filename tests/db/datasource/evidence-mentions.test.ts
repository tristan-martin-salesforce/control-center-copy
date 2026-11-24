/**
 * Mention names for the Evidence tab and the Why line on Postgres (db only: the mock has no scanner rows). A Slack
 * snippet names its mentions from the people directory first, then from the authors and participants the item's own
 * scanner rows carry (the Outbox source block's rule), then from the texts themselves (`<@U…|Name>`, as Slack writes
 * most mentions); an id nothing names stays out ("@someone" in the UI). Snippets leave redacted. Parity on the plain seed is in parity-reads.test.ts. Placeholders only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../../../src/db/client';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';

let handle: DbHandle;
let L: Loaded;

const T = (id: string) => L.idMap.get(id) ?? id;
const fresh = () => new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
const BODY = 'Following up: <@U0QUINN> and <@U0NOBODY>, can you confirm the *demo* link? <https://example.com/demo|the demo> token xoxb-123-456-placeholder';

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await handle?.close();
});

describe.runIf(BE1B)('evidence and why mention names on Postgres', () => {
  it('the seeded mrkdwn snippet names its mention from the directory, like the mock', async () => {
    const [m, d] = await Promise.all([L.mock.getItemEvidence({ params: { id: 'w_dana_reply' } }), fresh().getItemEvidence({ params: { id: T('w_dana_reply') } })]);
    expect(m.mentions).toEqual({ U0RAJ: 'Raj Mehta' });
    expect(d.mentions).toEqual({ U0RAJ: 'Raj Mehta' });
    expect(d.evidence.find((e) => e.snippet?.includes('<@U0RAJ>'))).toBeTruthy();
  });

  it("a scanner row's author and participants name mentions the directory lacks; an unknown id stays out; snippets are redacted", async () => {
    const meta = { author: { name: 'Zed Placeholder', externalId: 'U0ZED', isMe: false }, participants: [{ externalId: 'U0QUINN', name: 'Quinn Placeholder', isMe: false }], channelName: 'acme-ext' };
    const ext = 'C0ACME:1730830000.0002';
    const row = await handle.db.execute<{ id: string }>(sql`
      insert into source_items (owner_user_id, source, kind, external_id, external_parent_id, external_container_id, dedupe_key, content_hash, occurred_at, from_me, body, body_format, url, meta)
      values (${L.userId}::uuid, 'slack', 'slack_message', ${ext}, 'slack:C0ACME:1730822100.0001', 'channel:#acme-ext', ${`slack:${ext}`}, ${`h:${ext}`}, ${L.now.toISOString()}::timestamptz, false, ${BODY}, 'plain', null, ${JSON.stringify(meta)}::jsonb)
      returning id`);
    const x = await handle.db.execute<{ id: string }>(sql`select id from extractors order by created_at limit 1`);
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test'), reason: 'placeholder evidence' }, async (tx) => {
      await tx.execute(sql`insert into work_item_evidence (work_item_id, source_item_id, role, confidence, extractor_id, rationale) values (${T('w_dana_reply')}::uuid, ${row.rows[0]!.id}::uuid, 'progress', 0.9, ${x.rows[0]!.id}::uuid, 'Zed asked <@U0ZED> to confirm')`);
    });

    const p = await fresh().getItemEvidence({ params: { id: T('w_dana_reply') } });
    expect(p.mentions).toEqual({ U0RAJ: 'Raj Mehta', U0QUINN: 'Quinn Placeholder', U0ZED: 'Zed Placeholder' });
    expect(p.mentions.U0NOBODY).toBeUndefined();
    const ev = p.evidence.find((e) => e.snippet?.startsWith('Following up'))!;
    expect(ev.snippet).toContain('<@U0QUINN>'); // the markup travels; the UI renders it
    expect(ev.snippet).not.toContain('xoxb-');
    expect(ev.snippet).toContain('[REDACTED:slack_token]');
  });

  it("the why line's mentions: the directory first, then the item's own rows; nothing when it mentions no one", async () => {
    const plain = await fresh().getItem({ params: { id: T('w_dana_reply') } });
    expect(plain.mentions).toEqual({});
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test'), reason: 'placeholder why' }, async (tx) => {
      await tx.execute(sql`update next_best_actions set rationale = ${'<@U0DANA> asked <@U0QUINN> and <@U0NOBODY> about the *demo*'} where work_item_id = ${T('w_dana_reply')}::uuid`);
    });
    const d = await fresh().getItem({ params: { id: T('w_dana_reply') } });
    expect(d.nba?.why).toContain('<@U0QUINN>');
    expect(d.mentions).toEqual({ U0DANA: 'Dana Reyes', U0QUINN: 'Quinn Placeholder' });
  });

  it('a mention Slack wrote with its name (`<@U…|Name>`) names the bare ones of the same id: snippets and the why line', async () => {
    // U0PAT is in neither the directory nor any row's author / participants: only the text itself names it
    const meta = { author: { name: 'Zed Placeholder', externalId: 'U0ZED', isMe: false }, channelName: 'acme-ext' };
    const rows: Array<[string, string]> = [
      ['C0ACME:1730830000.0003', '<@U0PAT|Pat Placeholder> asked for the *demo* link'],
      ['C0ACME:1730830000.0004', 'Following up on the demo, ping <@U0PAT'], // cut by the stored body's cap
    ];
    const x = await handle.db.execute<{ id: string }>(sql`select id from extractors order by created_at limit 1`);
    for (const [ext, body] of rows) {
      const r = await handle.db.execute<{ id: string }>(sql`
        insert into source_items (owner_user_id, source, kind, external_id, external_parent_id, external_container_id, dedupe_key, content_hash, occurred_at, from_me, body, body_format, url, meta)
        values (${L.userId}::uuid, 'slack', 'slack_message', ${ext}, 'slack:C0ACME:1730822100.0001', 'channel:#acme-ext', ${`slack:${ext}`}, ${`h:${ext}`}, ${L.now.toISOString()}::timestamptz, false, ${body}, 'plain', null, ${JSON.stringify(meta)}::jsonb)
        returning id`);
      await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test'), reason: 'placeholder evidence' }, async (tx) => {
        await tx.execute(sql`insert into work_item_evidence (work_item_id, source_item_id, role, confidence, extractor_id, rationale) values (${T('w_dana_reply')}::uuid, ${r.rows[0]!.id}::uuid, 'progress', 0.9, ${x.rows[0]!.id}::uuid, 'Pat asked for the demo link')`);
      });
    }
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test'), reason: 'placeholder why' }, async (tx) => {
      await tx.execute(sql`update next_best_actions set rationale = ${'<@U0PAT> asked for the demo link'} where work_item_id = ${T('w_dana_reply')}::uuid`);
    });
    const p = await fresh().getItemEvidence({ params: { id: T('w_dana_reply') } });
    expect(p.mentions.U0PAT).toBe('Pat Placeholder');
    expect(p.mentions.U0QUINN).toBe('Quinn Placeholder'); // the rows still name theirs
    expect(p.evidence.some((e) => e.snippet?.endsWith('ping <@U0PAT'))).toBe(true);
    const d = await fresh().getItem({ params: { id: T('w_dana_reply') } });
    expect(d.mentions).toEqual({ U0PAT: 'Pat Placeholder' });
  });
});
