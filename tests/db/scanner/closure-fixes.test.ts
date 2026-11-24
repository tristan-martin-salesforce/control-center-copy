/**
 * Holistic review 2026-11-20 (lane 03), the scanner-store half of the closure fixes, on both stores: R2 (a chase after a
 * close for you is a `follow_up:` contradiction, not context), SCN-14 (two deliverables in one DM stay two), R6 (long
 * excerpts kept), R15 oldAskDays; and on the db store R13 (Drive refs in one form) and R11's Health counter.
 * Placeholder data only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NOTES_NO_STEPS } from '../../../src/connectors/google/gemini-notes';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { sameDeliverable } from '../../../src/scanner/propose-rules';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { DbScannerStore } from '../../../src/scanner/store-db';
import { InMemoryScannerStore, normDriveRef } from '../../../src/scanner/store-memory';
import type { NormalizedSourceItem, ScannerStore } from '../../../src/scanner/types';
import { PROFILE } from '../../scanner/runtime/helpers/world';
import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';


const NOW = '2026-11-09T16:00:00.000Z';
const W = { from: '2026-11-09T14:00:00.000Z', to: NOW };
const ME = 'U0PLACEME';

let n = 0;
const msg = (o: { dm?: string; who?: string; me?: boolean; text?: string; at?: string; parts?: string[] }): NormalizedSourceItem => {
  n += 1;
  const ch = o.dm ?? 'D0TEST001';
  const ts = `17938${String(20_000 + n).padStart(5, '0')}.000100`;
  return {
    connector: 'slack',
    kind: 'message',
    externalId: `${ch}:${ts}`,
    dedupeKey: `slack:${ch}:${ts}`,
    contentHash: `fx${n}`,
    occurredAt: o.at ?? new Date(Date.parse(NOW) - (200 - n) * 60_000).toISOString(),
    excerpt: o.text ?? 'can you send the ACME pricing deck?',
    author: o.me ? { name: 'ME Person', externalId: ME, isMe: true } : { name: o.who ?? 'PERSON_B', externalId: `U0${(o.who ?? 'PERSON_B').replace(/[^A-Z0-9]/g, '')}`, isMe: false },
    ...(o.parts ? { participants: o.parts.map((p) => ({ name: p, externalId: `U0${p.replace(/[^A-Z0-9]/g, '')}`, isMe: false })) } : {}),
    threadRef: `slack:${ch}:${ts}`,
    redacted: false,
    payload: { channelId: ch, channelType: 'im', ts, ...(o.me ? {} : { toMe: true }) },
  };
};

async function propose(store: ScannerStore, it: NormalizedSourceItem, p: { kind?: 'ask' | 'commitment'; title: string }) {
  const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
  const [r] = await store.recordSourceItems(runId, [it]);
  const out = await store.proposeItem(runId, { kind: p.kind ?? 'ask', title: p.title, evidence: [{ sourceItemId: r!.sourceItemId, role: 'origin', reason: 'asked in a DM' }], confidence: 'sure' });
  return { ...out, sourceItemId: r!.sourceItemId };
}

interface Harness {
  store: ScannerStore;
  closeForMe(id: string, at: string, by?: 'engine' | 'user'): Promise<void>;
  roles(id: string): Promise<Array<{ role: string; reason: string }>>;
  status(id: string): Promise<{ status: string; reason: string | null }>;
  excerpt(sourceItemId: string): Promise<string>;
}

describe('SCN-14: sameDeliverable', () => {
  it('different deliverable nouns or kinds of verb are two items; the counterpart name never makes them one', () => {
    expect(sameDeliverable('Share ACME deck with Bob', 'Review ACME deck for Bob', new Set(['bob']))).toBe(false); // share vs review
    expect(sameDeliverable('Send the ACME pricing deck', 'Send the ACME pricing sheet')).toBe(false); // deck vs sheet
    expect(sameDeliverable('Send PERSON_B the ACME pricing deck', 'Share the ACME pricing deck with PERSON_B')).toBe(true);
  });
  it('R13: Drive refs normalize to the bare id', () => {
    expect(normDriveRef('drive:FILE_PLACEHOLDER01')).toBe('FILE_PLACEHOLDER01');
    expect(normDriveRef('https://docs.google.com/presentation/d/FILE_PLACEHOLDER01/edit#slide=2')).toBe('FILE_PLACEHOLDER01');
    expect(normDriveRef('https://example.com/page')).toBe('https://example.com/page');
  });
});

function suite(name: string, make: (closing?: { reopenOnFollowUp?: boolean; oldAskDays?: number }) => Promise<Harness>) {
  describe(`${name}: closure fixes`, () => {
    it('R2: the asker chasing after a close for you is a follow_up: contradiction; before the fix (and when off) context', async () => {
      const h = await make();
      const a = await propose(h.store, msg({ dm: 'D0TESTR21', text: 'can you send the ACME pricing deck?' }), { title: 'Send PERSON_B the ACME pricing deck' });
      await h.closeForMe(a.workItemId, new Date(Date.parse(NOW) - 2 * 86_400_000).toISOString());
      const chase = await propose(h.store, msg({ dm: 'D0TESTR21', text: "that link doesn't open, can you resend the pricing deck?", at: NOW }), { title: 'Resend PERSON_B the ACME pricing deck' });
      expect(chase.workItemId).toBe(a.workItemId);
      const ev = (await h.roles(a.workItemId)).find((e) => e.reason.startsWith('follow_up:'));
      expect(ev).toMatchObject({ role: 'contradiction', reason: expect.stringContaining('PERSON_B wrote again') });

      // Closed by the user: a repeat stays context (the user's own close is never reopened by a chase).
      const b = await propose(h.store, msg({ dm: 'D0TESTR22' }), { title: 'Send PERSON_B the ACME pricing deck' });
      await h.closeForMe(b.workItemId, new Date(Date.parse(NOW) - 2 * 86_400_000).toISOString(), 'user');
      await propose(h.store, msg({ dm: 'D0TESTR22', text: 'any news on the pricing deck?', at: NOW }), { title: 'Send PERSON_B the ACME pricing deck' });
      expect((await h.roles(b.workItemId)).filter((e) => e.role === 'context')).toHaveLength(1);
    });

    it('R2: Reopen on follow-up off keeps the old behaviour (context only)', async () => {
      const h = await make({ reopenOnFollowUp: false });
      const a = await propose(h.store, msg({ dm: 'D0TESTR23' }), { title: 'Send PERSON_B the ACME pricing deck' });
      await h.closeForMe(a.workItemId, new Date(Date.parse(NOW) - 2 * 86_400_000).toISOString());
      await propose(h.store, msg({ dm: 'D0TESTR23', text: 'resend the pricing deck?', at: NOW }), { title: 'Send PERSON_B the ACME pricing deck' });
      const roles = await h.roles(a.workItemId);
      expect(roles.some((e) => e.role === 'contradiction')).toBe(false);
      expect(roles.some((e) => e.role === 'context')).toBe(true);
    });

    it('SCN-14: two of my commitments to the same person in one DM stay two items', async () => {
      const h = await make();
      const a = await propose(h.store, msg({ dm: 'D0TESTS14', me: true, text: "I'll share the ACME deck with Bob", parts: ['Bob'] }), { kind: 'commitment', title: 'Share ACME deck with Bob' });
      const b = await propose(h.store, msg({ dm: 'D0TESTS14', me: true, text: "and I'll review the ACME deck for Bob", parts: ['Bob'] }), { kind: 'commitment', title: 'Review ACME deck for Bob' });
      expect(b.workItemId).not.toBe(a.workItemId);
    });

    it('R6: an excerpt keeps up to 4,000 chars (the ask past character 1,000 is not lost)', async () => {
      const h = await make();
      const text = `${'context '.repeat(150)}can you send the INITECH quote by Friday?`;
      expect(text.length).toBeGreaterThan(1000);
      const r = await propose(h.store, msg({ dm: 'D0TESTR06', text }), { title: 'Send the INITECH quote' });
      expect(await h.excerpt(r.sourceItemId)).toContain('INITECH quote by Friday');
    });

    it('R15: Settings ▸ Closing ▸ Old asks sets when an old ask waits as Still needed?', async () => {
      const old = new Date(Date.parse(NOW) - 10 * 86_400_000).toISOString();
      const strict = await make({ oldAskDays: 7 });
      const s = await propose(strict.store, msg({ dm: 'D0TESTOLD', at: old }), { title: 'Send the GLOBEX sizing' });
      expect((await strict.status(s.workItemId)).status).toBe('suggested');
      const loose = await make({ oldAskDays: 30 });
      const l = await propose(loose.store, msg({ dm: 'D0TESTOL2', at: old }), { title: 'Send the GLOBEX sizing' });
      expect((await loose.status(l.workItemId)).status).toBe('open');
    });
  });
}

suite('memory store', async (closing) => {
  const clock = new FakeClock(NOW);
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE), ...(closing ? { closing } : {}) });
  return {
    store,
    closeForMe: async (id, at, by = 'engine') => {
      store.setWorkItemState(id, 'done', { doneBy: by, doneAt: at });
    },
    roles: async (id) => store.evidenceFor(id).map((e) => ({ role: e.role, reason: e.reason })),
    status: async (id) => {
      const w = store.getWorkItem(id) as unknown as { state: string; statusReason?: string };
      return { status: w.state, reason: w.statusReason ?? null };
    },
    excerpt: async (sid) => store.getSourceItem(sid)?.excerpt ?? '',
  };
});

describe.skipIf(!pgAvailable())('db store (scratch database)', () => {
  let t: TestDb;
  let userId = '';
  beforeAll(async () => {
    t = await provisionTestDb('closefix');
    const u = await t.handle.db.execute<{ id: string }>(sql`insert into users (email, display_name, timezone) values ('placeholder@example.com', 'ME Person', 'UTC') returning id`);
    userId = u.rows[0]!.id;
  });
  afterAll(async () => t?.drop());
  const kv = (q: ReturnType<typeof sql>) => withChangeSet({ db: t.handle.db, userId, actor: actors.system('test'), reason: 'test: closing settings' }, (tx) => tx.execute(q));

  suite('db store', async (closing) => {
    await kv(sql`delete from user_settings where owner_user_id = ${userId} and key = 'settings.closing'`);
    if (closing) await kv(sql`insert into user_settings (owner_user_id, key, value) values (${userId}, 'settings.closing', ${JSON.stringify({ version: 1, ...closing })}::jsonb)`);
    const clock = new FakeClock(NOW);
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => clock.now() });
    return {
      store,
      closeForMe: async (id, at, by = 'engine') => {
        await withChangeSet({ db: t.handle.db, userId, actor: by === 'engine' ? actors.engine('test') : actors.user('test'), reason: 'test close', entity: { type: 'work_item', id } }, (tx) =>
          tx.execute(sql`update work_items set status = 'done', done_at = ${at}::timestamptz, done_by = ${by}, resolution = 'done_by_me' where id = ${id}`),
        );
      },
      roles: async (id) => (await t.handle.db.execute<{ role: string; reason: string }>(sql`select role::text as role, rationale as reason from work_item_evidence where work_item_id = ${id} order by created_at`)).rows,
      status: async (id) => (await t.handle.db.execute<{ status: string; reason: string | null }>(sql`select status::text as status, status_reason as reason from work_items where id = ${id}`)).rows[0]!,
      excerpt: async (sid) => (await t.handle.db.execute<{ body: string }>(sql`select body from source_items where id = ${sid}`)).rows[0]!.body,
    };
  });

  it('R13: drive:<ID> and Docs URLs land as drive_file with the bare id; migration 0029 is idempotent and dupe-safe', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => new Date(NOW) });
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
    const it = { ...msg({ dm: 'D0TESTR13' }), fileRefs: ['drive:FILE_PLACEHOLDER13', 'https://docs.google.com/document/d/FILE_PLACEHOLDER14/edit', 'https://example.com/x'] };
    const [r] = await store.recordSourceItems(runId, [it]);
    const refs = await t.handle.db.execute<{ kind: string; value: string }>(sql`select kind::text as kind, value from source_item_refs where source_item_id = ${r!.sourceItemId} order by value`);
    expect(refs.rows).toEqual([
      { kind: 'drive_file', value: 'FILE_PLACEHOLDER13' },
      { kind: 'drive_file', value: 'FILE_PLACEHOLDER14' },
      { kind: 'url', value: 'https://example.com/x' },
    ]);
    // An old row in the drive: form, plus one already twinned: the fix moves the first and drops the duplicate.
    await t.handle.db.execute(sql`insert into source_item_refs (source_item_id, kind, value) values (${r!.sourceItemId}, 'url', 'drive:FILE_PLACEHOLDER15'), (${r!.sourceItemId}, 'url', 'drive:FILE_PLACEHOLDER13')`);
    const { readFileSync } = await import('node:fs');
    const fix = readFileSync('src/db/migrations/0029_normalize_drive_refs.sql', 'utf8').split('--> statement-breakpoint');
    for (let i = 0; i < 2; i++) for (const stmt of fix) await t.handle.db.execute(sql.raw(stmt));
    const after = await t.handle.db.execute<{ kind: string; value: string }>(sql`select kind::text as kind, value from source_item_refs where source_item_id = ${r!.sourceItemId} order by value`);
    expect(after.rows.map((x) => `${x.kind}:${x.value}`)).toEqual(['drive_file:FILE_PLACEHOLDER13', 'drive_file:FILE_PLACEHOLDER14', 'drive_file:FILE_PLACEHOLDER15', 'url:https://example.com/x']);
  });

  it('R11: notes with 0 parsed steps are one Health event whose count goes up per doc', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => new Date(NOW) });
    for (const doc of ['DOC_PLACEHOLDER_1', 'DOC_PLACEHOLDER_2']) await store.recordDecision({ skill: 'scan-gemini-notes', kind: 'skip', reason: NOTES_NO_STEPS, trigger: 'schedule', subject: doc });
    const ev = await t.handle.db.execute<{ n: number; code: string }>(sql`select occurrence_count::int as n, code from app_events where owner_user_id = ${userId} and code = ${NOTES_NO_STEPS} and resolved_at is null`);
    expect(ev.rows).toEqual([{ n: 2, code: NOTES_NO_STEPS }]);
  });
});
