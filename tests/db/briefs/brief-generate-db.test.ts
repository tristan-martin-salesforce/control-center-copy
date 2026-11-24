/**
 * BE-5 watched-channel briefs on the real path (Postgres). The bug: a channel watch added on the Briefs page
 * ("Daily 7:30") was scanned for items by scan-slack but never briefed, because `brief.generate` was a "not yet
 * wired" stub and its schedule stayed disabled (STRESS WATCH-1). Here: a watch stored as the Watches form stores
 * it (`#team-watch`), messages recorded by the Slack channel scope, then the job (fake model, real DbScannerStore)
 * writes a brief the Briefs read model returns; it is not repeated the same day, and the next day's brief starts
 * where this one ended. Placeholder data only.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '../../../src/db/changeset';
import { enqueueJob } from '../../../src/db/queue';
import { createDefaultRegistry } from '../../../src/jobs';
import { BRIEF_JOB_KIND, briefFollowUpKey, briefHandler } from '../../../src/jobs/handlers/brief';
import type { JobContext } from '../../../src/jobs/types';
import type { CompletionModel, CompletionModelRequest } from '../../../src/scanner/completion';
import { DbScannerStore } from '../../../src/scanner/store-db';
import type { NormalizedSourceItem } from '../../../src/scanner/types';
import { loadKv } from '../../../src/server/datasource/db/ext';
import { loadBriefs, loadWatches } from '../../../src/server/datasource/db/store/briefs';
import type { ReadCtx } from '../../../src/server/datasource/db/store/common';
import { DEFAULT_MAINTENANCE, ensureSchedules } from '../../../src/worker/schedules';
import { loadProfileIntoDb, PLACEHOLDER_PROFILE } from '../../../scripts/stress/lib/profile';

import { pgAvailable, provisionTestDb, type TestDb } from '../scanner/helpers/pg';

const H = 3_600_000;
const CH = 'C0WATCH01';
const REF = '#team-watch';
/** Wed 2026-11-11 07:31 in America/Denver (the placeholder profile's zone). */
const DAY1 = new Date('2026-11-11T14:31:00.000Z');
const DAY2 = new Date(DAY1.getTime() + 24 * H);

const ts = (ms: number) => (ms / 1000).toFixed(6);
const msg = (atMs: number, text: string, author = 'PERSON_A', reply?: number): NormalizedSourceItem => ({
  connector: 'slack',
  kind: 'message',
  externalId: `${CH}:${ts(atMs)}`,
  dedupeKey: `slack:${CH}:${ts(atMs)}`,
  contentHash: randomUUID(),
  occurredAt: new Date(atMs).toISOString(),
  threadRef: `slack:${CH}:${ts(reply ?? atMs)}`,
  permalink: `https://example.slack.com/archives/${CH}/p${String(atMs * 1000)}`,
  excerpt: text,
  author: { name: author, externalId: `U0${author}` },
  payload: { channelId: CH, channelName: 'team-watch', channelType: 'channel', isReply: reply !== undefined, ts: ts(atMs) },
});

describe.skipIf(!pgAvailable())('brief.generate: a watched channel gets its daily brief (db)', () => {
  let t: TestDb;
  let userId: string;
  let watchId: string;
  const requests: CompletionModelRequest[] = [];
  /** Cites the first message of the period as one medium highlight; everything else goes to everythingElse. */
  const model: CompletionModel = async (req) => {
    requests.push(req);
    const ids = [...req.user.matchAll(/\[(s_\d+)\]/g)].map((m) => m[1]!);
    const reply = {
      summary: 'The channel shared the new rate card and planned the offsite.',
      nothingNew: false,
      highlights: [
        {
          title: 'New rate card shared in the channel',
          body: 'A teammate shared the updated rate card; worth a read before your next estimate.',
          level: 'medium',
          reasons: [{ kind: 'my_interest', featureKey: 'interest:pricing', explanation: 'You follow pricing changes' }],
          evidenceIds: [ids[0]],
          suggestedAction: 'ignore',
          topicKey: `slack:${CH}:rate-card`,
          entity: { accountId: null, opportunityId: null, initiativeId: null },
        },
      ],
      everythingElse: ids.slice(1).map((id) => ({ threadRef: `slack:${CH}:x`, gist: 'Offsite logistics', evidenceIds: [id] })),
      coverageNote: null,
    };
    return { ok: true, text: JSON.stringify(reply), costUsd: 0.004, inputTokens: 2500, outputTokens: 300 };
  };

  async function scanChannel(store: DbScannerStore, from: Date, to: Date, items: NormalizedSourceItem[]) {
    const window = { from: from.toISOString(), to: to.toISOString() };
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: `channel:${REF}` }, trigger: 'schedule', window });
    await store.recordSourceItems(runId, items);
    await store.reportCoverage(runId, [{ kind: 'channel_range', ref: CH, from: window.from, to: window.to }]);
    await store.finishRun(runId, { cursor: { value: ts(to.getTime()), at: window.to }, stats: { fetched: items.length, new: items.length, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
  }

  async function runJob(now: Date, payload: Record<string, unknown> = {}) {
    const job = await enqueueJob(t.handle.db, { ownerUserId: userId, kind: BRIEF_JOB_KIND, queue: 'brief', payload });
    const ctx: JobContext = {
      job: { id: job.id, ownerUserId: userId, kind: BRIEF_JOB_KIND, queue: 'brief', payload, attempts: 1, maxAttempts: 5, timeoutSeconds: 600, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null },
      signal: new AbortController().signal,
      db: t.handle.db,
      userId,
      clock: () => now,
      log: () => undefined,
      heartbeat: async () => undefined,
      enqueue: async () => ({ id: 0, inserted: false }),
      services: undefined,
    };
    return (await briefHandler({ model })(ctx)) as { status: string; counts: Record<string, number>; briefs: Array<{ briefId: string; status: string; messages: number; highlights: number }>; followUpAt: string | null };
  }

  async function readBriefs() {
    const kv = await loadKv(t.handle.db, userId);
    const rc = { db: t.handle.db, userId, kv } as unknown as ReadCtx;
    const watches = await loadWatches(rc);
    return loadBriefs(rc, new Map(watches.map((w) => [w.id, { targetKind: w.targetKind, label: w.label, accountId: null, oppId: null }])));
  }

  beforeAll(async () => {
    t = await provisionTestDb('briefs');
    userId = await loadProfileIntoDb(t.handle.db, PLACEHOLDER_PROFILE, { channels: [] });
    // As the Watches form stores a channel watch: the channel's external id is the typed "#name", cadence Daily 7:30.
    const { result } = await withChangeSet({ db: t.handle.db, userId, actor: actors.user('watch.create'), reason: `Watching ${REF}` }, async (tx) => {
      const ch = await tx.execute<{ id: string }>(sql`
        insert into channels (owner_user_id, system, external_id, name, kind, watch_mode) values (${userId}, 'slack', ${REF}, ${REF}, 'public', 'digest') returning id`);
      const w = await tx.execute<{ id: string }>(sql`
        insert into watch_subscriptions (owner_user_id, scope_kind, channel_id, label, cadence, style)
        values (${userId}, 'channel', ${ch.rows[0]!.id}, ${REF}, 'daily', 'digest') returning id`);
      return w.rows[0]!.id;
    });
    watchId = result;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('brief.generate is a wired job whose 07:30 schedule is enabled (it was a stub with a disabled schedule)', async () => {
    const registry = createDefaultRegistry();
    expect(registry.isWired('brief.generate')).toBe(true);
    expect(DEFAULT_MAINTENANCE.find((s) => s.key === 'brief.generate')).toMatchObject({ atLocal: '07:30', catchUp: 'run_once' });
    await ensureSchedules(t.handle.db, userId, registry, 'America/Denver', DAY1);
    const s = await t.handle.db.execute<{ enabled: boolean; paused_reason: string | null; cron_expr: string }>(sql`
      select enabled, paused_reason, cron_expr from job_schedules where owner_user_id = ${userId} and key = 'brief.generate'`);
    expect(s.rows[0]).toEqual({ enabled: true, paused_reason: null, cron_expr: '30 7 * * *' });
  });

  it('writes the day’s brief from the messages scan-slack stored for the channel, once', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => DAY1 });
    const start = DAY1.getTime() - 24 * H;
    await scanChannel(store, new Date(start), new Date(DAY1.getTime() - 5 * 60_000), [
      msg(start + 2 * H, 'Updated rate card is in the pinned doc'),
      msg(start + 3 * H, 'Offsite hotel block closes Friday', 'PERSON_B'),
      msg(start + 3 * H + 60_000, 'Booked, thanks', 'PERSON_C', start + 3 * H),
    ]);

    const r = await runJob(DAY1);
    expect(r.counts.ready).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe('claude-haiku-5-5');
    expect(requests[0]!.system).toContain('brief-channel');
    expect(r.briefs[0]).toMatchObject({ status: 'ready', messages: 3, highlights: 1 });

    const briefs = await readBriefs();
    expect(briefs).toHaveLength(1);
    const b = briefs[0]!;
    expect(b).toMatchObject({ kind: 'channel', title: REF, subscriptionId: watchId, status: 'ready', unread: true });
    expect(b.summary).toContain('rate card');
    expect(b.highlights[0]).toMatchObject({ title: 'New rate card shared in the channel', relevance: 'medium', reasons: ['You follow pricing changes'] });
    expect(b.highlights[0]!.sources[0]!.url).toContain(`/archives/${CH}/`);
    expect(b.everythingElse.map((e) => e.thread)).toContain('Offsite logistics');
    // The period ends at the channel scan's cursor, not at "now": nothing unread by the scanner is claimed.
    expect(b.period.to).toBe(new Date(DAY1.getTime() - 5 * 60_000).toISOString());

    const w = await t.handle.db.execute<{ last_period_end: string; last_brief_id: string }>(sql`select last_period_end, last_brief_id from watch_subscriptions where id = ${watchId}`);
    expect(new Date(w.rows[0]!.last_period_end).toISOString()).toBe(b.period.to);
    expect(w.rows[0]!.last_brief_id).toBe(b.id);
    const links = await t.handle.db.execute<{ n: number; basis: number }>(sql`
      select count(*) filter (where brief_id = ${b.id})::int as n, count(*) filter (where brief_highlight_id is not null)::int as basis from provenance_links`);
    expect(links.rows[0]).toEqual({ n: 3, basis: 1 });
    const spend = await t.handle.db.execute<{ purpose: string; cost: string }>(sql`select purpose::text, cost_usd::text as cost from llm_calls where owner_user_id = ${userId}`);
    expect(spend.rows).toEqual([{ purpose: 'summarize', cost: '0.004000' }]);

    // Later the same day (a catch-up after a restart): not due again, no model call.
    const again = await runJob(new Date(DAY1.getTime() + 3 * H));
    expect(again.counts.not_due).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it('the next morning’s brief starts where the last one ended; a quiet day is said without a model call', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => DAY2 });
    const prevEnd = DAY1.getTime() - 5 * 60_000;
    // The message just after the last brief's end (posted while that scan was behind) is in the next brief.
    await scanChannel(store, new Date(prevEnd), new Date(DAY2.getTime() - 60_000), [msg(prevEnd + 60_000, 'Rate card FAQ added', 'PERSON_B')]);
    const r = await runJob(DAY2);
    expect(r.counts.ready).toBe(1);
    expect(requests).toHaveLength(2);
    const briefs = await readBriefs();
    const latest = briefs.find((b) => b.id === r.briefs[0]!.briefId)!;
    expect(latest.period.from).toBe(new Date(prevEnd).toISOString());

    const day3 = new Date(DAY2.getTime() + 24 * H);
    const quietStore = new DbScannerStore({ db: t.handle.db, userId, clock: () => day3 });
    await scanChannel(quietStore, new Date(DAY2.getTime() - 60_000), new Date(day3.getTime() - 60_000), []);
    const q = await runJob(day3);
    expect(q.counts.quiet).toBe(1);
    expect(requests).toHaveLength(2);
    const quiet = (await readBriefs()).find((b) => b.id === q.briefs[0]!.briefId)!;
    expect(quiet).toMatchObject({ unread: false, highlights: [] });
    expect(quiet.summary).toMatch(/^No new messages in #team-watch since /);
  });

  it('waits for a channel scan that is behind, with a follow-up job, instead of skipping the day', async () => {
    const day4 = new Date(DAY2.getTime() + 48 * H);
    // The last scan ended right where the last brief ended: nothing new has been read yet.
    const r = await runJob(day4);
    expect(r.counts.waiting_for_scan).toBe(1);
    expect(requests).toHaveLength(2);
    expect(r.followUpAt).not.toBeNull();
    const f = await t.handle.db.execute<{ n: number; retry: number }>(sql`
      select count(*)::int as n, max((payload->>'retry')::int) as retry from jobs where dedupe_key = ${briefFollowUpKey(userId)} and status = 'queued'`);
    expect(f.rows[0]).toEqual({ n: 1, retry: 1 });
  });
});
