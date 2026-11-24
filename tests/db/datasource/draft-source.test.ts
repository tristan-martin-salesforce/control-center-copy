/**
 * GET /drafts/:id/source on Postgres, with the scanner's own source items (db only: the mock has none). The thread's
 * rows join the seeded thread context and evidence; bodies render from their format; mentions take the names the rows
 * carry; another thread never leaks in; after the purge the evidence line and the link stand in. Parity on the plain
 * seed is in parity-reads.test.ts. Placeholders only.
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
const KEY = 'slack:C0ACME:1730822100.0001';
const fresh = () => new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
/** The seed is rebased to today: place rows around its own thread messages (minutes after `base`). */
const at = (base: string, min: number) => new Date(Date.parse(base) + min * 60_000).toISOString();
const thread = () => L.seed.drafts.find((d) => d.id === 'dr_dana')!.threadContext;

async function slackRow(o: { ext: string; parent: string; at: string; author: Record<string, unknown>; body: string | null; fromMe?: boolean; url?: string; purged?: boolean; participants?: unknown[] }): Promise<string> {
  const meta = { author: o.author, ...(o.participants ? { participants: o.participants } : {}), channelName: 'acme-ext' };
  const r = await handle.db.execute<{ id: string }>(sql`
    insert into source_items (owner_user_id, source, kind, external_id, external_parent_id, external_container_id, dedupe_key, content_hash, occurred_at, from_me, body, body_format, body_purged_at, url, meta)
    values (${L.userId}::uuid, 'slack', 'slack_message', ${o.ext}, ${o.parent}, 'channel:#acme-ext', ${`slack:${o.ext}`}, ${`h:${o.ext}`}, ${o.at}::timestamptz, ${o.fromMe ?? false}, ${o.body}, 'plain', ${o.purged ? sql`now()` : null}, ${o.url ?? null}, ${JSON.stringify(meta)}::jsonb)
    returning id`);
  return r.rows[0]!.id;
}

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

describe.runIf(BE1B)('draft source on Postgres (scanner rows)', () => {
  let newest: string;
  it('Slack: the thread rows join the thread context; the reply answers the latest message from someone else', async () => {
    await slackRow({ ext: 'C0ACME:1730822100.0001', parent: KEY, at: at(thread()[0]!.at, -30), author: { name: 'Dana Reyes', externalId: 'U0DANA', isMe: false }, body: 'Kick-off thread for *Phase 2*', url: 'https://example.slack.com/archives/C0ACME/p1730822100000100' });
    await slackRow({ ext: 'C0ACME:1730822200.0001', parent: KEY, at: at(thread()[0]!.at, -20), author: { name: 'Zed Placeholder', externalId: 'U0ZED', isMe: false }, body: null, purged: true });
    newest = await slackRow({
      ext: 'C0ACME:1730830000.0001',
      parent: KEY,
      at: at(thread()[2]!.at, 35),
      author: { name: 'Zed Placeholder', externalId: 'U0ZED', isMe: false },
      participants: [{ externalId: 'U0QUINN', name: 'Quinn Placeholder', isMe: false }],
      body: 'Following up: <@U0QUINN> can you confirm the *demo* link? <https://example.com/demo|the demo>',
      url: 'https://example.slack.com/archives/C0ACME/p1730830000000100?thread_ts=1730822100.0001',
    });
    await slackRow({ ext: 'C0ACME:1730830600.0001', parent: KEY, at: at(thread()[2]!.at, 45), author: { name: 'Jordan Lee', isMe: true }, body: 'Checking now', fromMe: true });
    await slackRow({ ext: 'C0ACME:1730999999.0001', parent: 'slack:C0ACME:1730999999.0001', at: at(thread()[2]!.at, 60), author: { name: 'Dana Reyes', isMe: false }, body: 'Another thread entirely' });
    // the newest one is also the item's evidence (the evidence line stands in after the purge)
    const x = await handle.db.execute<{ id: string }>(sql`select id from extractors order by created_at limit 1`);
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test'), reason: 'placeholder evidence' }, async (tx) => {
      await tx.execute(sql`insert into work_item_evidence (work_item_id, source_item_id, role, confidence, extractor_id, rationale) values (${T('w_dana_reply')}::uuid, ${newest}::uuid, 'progress', 0.9, ${x.rows[0]!.id}::uuid, 'Zed asked Quinn to confirm the demo link')`);
    });

    const s = await fresh().getDraftSource({ params: { id: T('dr_dana') } });
    expect(s).toMatchObject({ kind: 'slack', relation: 'reply', where: '#acme-ext', url: 'https://example.slack.com/archives/C0ACME/p1730830000000100?thread_ts=1730822100.0001', earlierTotal: 5 });
    expect(s.message).toMatchObject({ author: 'Zed Placeholder', isMe: false, body: 'full', at: at(thread()[2]!.at, 35) });
    expect(s.message!.html).toContain('<span class="cc-mention">@Quinn Placeholder</span>'); // a name from the rows' participants
    expect(s.message!.html).toContain('<strong>demo</strong>');
    expect(s.earlier.map((m) => [m.author, m.body])).toEqual([
      ['Dana Reyes', 'full'], // the thread parent (a stored row)
      ['Zed Placeholder', 'purged'], // its text was cleared: author, time and the note remain
      ['Dana Reyes', 'full'], // thread context
      ['Jordan Lee', 'full'],
      ['Dana Reyes', 'full'], // thread context and seeded evidence, merged into one
    ]);
    expect(s.earlier[0]!.html).toContain('<strong>Phase 2</strong>');
    expect(s.earlier[4]!.html).toContain('@Raj Mehta'); // a name from the directory
    expect(JSON.stringify(s)).not.toContain('Another thread entirely');
  });

  it('after the purge: the evidence line and the link stand in for the body', async () => {
    await handle.db.execute(sql`update source_items set body = null, body_purged_at = now() where id = ${newest}::uuid`);
    const s = await fresh().getDraftSource({ params: { id: T('dr_dana') } });
    expect(s.message).toMatchObject({ author: 'Zed Placeholder', body: 'purged', text: 'Zed asked Quinn to confirm the demo link' });
    expect(s.url).toBe('https://example.slack.com/archives/C0ACME/p1730830000000100?thread_ts=1730822100.0001');
  });

  it('email: the reply answers the thread’s latest email from someone else, HTML sanitized, headers from the row', async () => {
    const meta = { subject: 'Re: DPA redlines', from: 'Marcus Webb <marcus.webb@globex.example>', to: 'Jordan Lee <jordan.lee@example.com>', author: { name: 'Marcus Webb', email: 'marcus.webb@globex.example', isMe: false } };
    await handle.db.execute(sql`
      insert into source_items (owner_user_id, source, kind, external_id, external_parent_id, dedupe_key, content_hash, occurred_at, body, body_format, url, title, meta)
      values (${L.userId}::uuid, 'gmail', 'email_message', 'gm_placeholder_1', 'gmail-thread:thr_example', 'gmail:gm_placeholder_1', 'h:gm1', ${at(L.seed.evidence.find((e) => e.workItemId === 'w_globex_legal')!.at, 24 * 60)}::timestamptz,
              '<p>Hi Jordan,</p><p>Legal has <b>one</b> question.</p><script>steal()</script><img src=x onerror=y()>', 'html', 'https://mail.example.com/#all/thr_example', 'Re: DPA redlines', ${JSON.stringify(meta)}::jsonb)`);
    const s = await fresh().getDraftSource({ params: { id: T('dr_nudge_globex') } });
    expect(s).toMatchObject({ kind: 'gmail', relation: 'reply', url: 'https://mail.example.com/#all/thr_example' });
    expect(s.message).toMatchObject({ author: 'Marcus Webb', isMe: false, subject: 'Re: DPA redlines', from: 'Marcus Webb <marcus.webb@globex.example>', to: 'Jordan Lee <jordan.lee@example.com>' });
    expect(s.message!.html).toBe('<div class="cc-source cc-source-email"><p>Hi Jordan,</p><p>Legal has <b>one</b> question.</p></div>');
    expect(s.earlier.map((m) => m.isMe)).toEqual([true]); // the seeded evidence: my own redlines email, before it
  });
});
