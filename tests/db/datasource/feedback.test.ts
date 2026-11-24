/**
 * D-56 · feedback parity: GET /feedback, POST /feedback/diagnose (the deterministic report; the Assistant's model is
 * off in tests) and POST /feedback/reports answer alike on the mock and on Postgres, placeholders included (they are
 * numbered by name, so the two sides' different ids do not matter). Then the staged item dispatches as a dry run on
 * both, and the db never enqueues a delivery for it.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../../../src/db/client';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';
import { both } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const CHANNEL = 'C0FEEDBACK01';
/** Ids and instants differ by side; the rest must not. */
const shapeStage = (v: unknown) => {
  const e = (v as { entity: Record<string, unknown> }).entity as { draft: Record<string, unknown>; preview: Record<string, unknown>; channel: unknown; scrubbed: number };
  return { draft: { status: e.draft.status, mode: e.draft.mode, destination: e.draft.destination, plainText: e.draft.plainText }, preview: { payload: e.preview.payload, dryRun: e.preview.dryRun, mode: e.preview.mode }, channel: e.channel, scrubbed: e.scrubbed };
};

describe.skipIf(!BE1B)('D-56 feedback parity (mock ≡ db)', () => {
  it('GET /feedback: no channel anywhere, then the one from Settings ▸ Feedback', async () => {
    expect((await both(L, db, 'getFeedback', {})).diffs).toEqual([]);
    expect((await both(L, db, 'patchSettings', { params: { section: 'feedback' }, body: { ifVersion: 1, value: { channelId: CHANNEL, channelName: '#cc-feedback' } } }, { times: true })).diffs).toEqual([]);
    const r = await both(L, db, 'getFeedback', {});
    expect(r.diffs).toEqual([]);
    expect((r.raw.db as { channel: { id: string } }).channel.id).toBe(CHANNEL);
  });

  it('POST /feedback/diagnose: the same scrubbed report and message', async () => {
    const acct = L.seed.accounts[0]!;
    const person = L.seed.people.find((p) => p.email) ?? L.seed.people[0]!;
    const text = `${person.name} sees an empty Time page for ${acct.name} but last week had meetings`;
    const r = await both(L, db, 'diagnoseFeedback', { body: { kind: 'bug', text, context: { page: 'Time', route: '/time', version: '0.1.0' } } });
    expect(r.diffs).toEqual([]);
    const out = r.raw.db as { report: { summary: string }; message: string };
    expect(out.report.summary).not.toContain(acct.name);
    expect(out.report.summary).not.toContain(person.name);
    expect(out.report.summary).toMatch(/PERSON_\d+ sees an empty Time page for CUSTOMER_\d+/);
  });

  it('POST /feedback/reports: one ready feedback.post item with the same payload; Send is a dry run on both', async () => {
    const d = (await both(L, db, 'diagnoseFeedback', { body: { kind: 'idea', text: 'Show the week total on Time' } })).raw.db as { report: unknown; message: string };
    const r = await both(L, db, 'stageFeedback', { body: { report: d.report, message: d.message } }, { times: true, shape: shapeStage });
    expect(r.diffs).toEqual([]);
    const st = r.raw.db as { entity: { draft: { id: string; version: number }; preview: { confirmToken: string; payload: { channel: string } } } };
    expect(st.entity.preview.payload.channel).toBe(CHANNEL);
    const sent = await db.dispatchDraft({ params: { id: st.entity.draft.id }, body: { ifVersion: st.entity.draft.version, mode: 'send', confirmToken: st.entity.preview.confirmToken } });
    expect(sent.dryRun).toBe(true);
    expect(sent.payload).toMatchObject({ tool: 'slack_send_message', channel: CHANNEL });
    const jobs = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${st.entity.draft.id}`);
    expect(Number(jobs.rows[0]?.n ?? 0)).toBe(0);
    // D-56: the post is a message, the Outbox's own item on both sides, never an admin item that waits on Time
    const mockOut = await L.mock.getOutbox({} as never);
    const dbOut = await db.getOutbox({} as never);
    for (const out of [mockOut, dbOut]) {
      expect(out.admin.items.filter((i) => i.draft.destination.kind === 'action' && i.draft.destination.action === 'feedback.post')).toEqual([]);
      expect(out.groups.find((g) => g.group === 'pending_approval')!.items.filter((i) => i.draft.destination.kind === 'action' && i.draft.destination.action === 'feedback.post').length).toBeGreaterThanOrEqual(1);
    }
    expect((await L.mock.getToday({} as never)).navCounts.adminWaiting).toBe((await db.getToday({} as never)).navCounts.adminWaiting);
  });
});
