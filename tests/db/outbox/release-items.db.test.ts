/**
 * D-90 (W12-7) on Postgres 17: the two release items through the db DataSource, and parity with the mock.
 *
 *   POST /outbox/releases   two ready items, the same shapes as the mock's; a second publish never duplicates
 *   announcement            Approve in dry run (the default) renders only: no outbox.dispatch job, status ready
 *   upload hand-off         "Mark uploaded": status sent, no job, and one record_landings row of kind `release`
 *                           (destination drive, record = the version) with its one write; a second mark refuses
 *
 * Own database: control_center_relout_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholders only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { routes, type Draft, type StageReleaseRequest } from '../../../src/contract';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { createMockDataSource, type MockDataSource } from '../../../src/server/datasource/mock';
import { dbUrl, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';

const NAME = `control_center_relout_${testDbSuffix}`;
const FOLDER = '1AbCdEfGhIjKlMnOpQ';
const CHANNEL = 'C0ANNOUNCE01';

const body = (o: Partial<StageReleaseRequest> = {}): StageReleaseRequest =>
  routes.stageRelease.body!.parse({
    version: '2.1.0',
    artifactName: 'command-center-2.1.0-arm64.tgz',
    artifactPath: '/repo/dist/releases/command-center-2.1.0-arm64.tgz',
    feedPath: '/repo/dist/releases/manifest.json',
    installShPath: '/repo/dist/releases/install.sh',
    sha256: 'c'.repeat(64),
    bytes: 150_000_000,
    notes: '### Added\n- a thing',
    ...o,
  }) as StageReleaseRequest;

let handle: DbHandle;
let ds: DbDataSource;
let mock: MockDataSource;
let userId: string;
const env = { folder: process.env.CC_DISTRIBUTION_FOLDER_ID, channel: process.env.CC_DISTRIBUTION_CHANNEL, team: process.env.CC_TEAM_CONFIG };
const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));

beforeAll(async () => {
  if (!pgAvailable) return;
  process.env.CC_TEAM_CONFIG = '/nonexistent/team.json';
  process.env.CC_DISTRIBUTION_FOLDER_ID = FOLDER;
  process.env.CC_DISTRIBUTION_CHANNEL = CHANNEL;
  const url = await freshDb(NAME);
  await runMigrations({ url, log: () => {} });
  handle = createDb({ url: dbUrl(NAME), max: 5, applicationName: 'release-items-test' });
  mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  const now = mock.now();
  const s = seedFromMock(mock);
  const res = await loadSeedIntoDb(s.seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  userId = res.userId;
  ds = new DbDataSource({ handle, url, userId, clock: { now: () => now }, ranker: interimRanker });
}, 600_000);

afterAll(async () => {
  restore('CC_DISTRIBUTION_FOLDER_ID', env.folder);
  restore('CC_DISTRIBUTION_CHANNEL', env.channel);
  restore('CC_TEAM_CONFIG', env.team);
  mock?.dispose();
  await ds?.dispose();
  await handle?.close();
});

const shape = (d: Draft) => ({ status: d.status, mode: d.mode, destination: d.destination, plainText: d.plainText });
const count = async (q: ReturnType<typeof sql>) => Number((await handle.db.execute<{ n: number }>(q)).rows[0]?.n ?? 0);
const dispatch = async (src: DbDataSource | MockDataSource, d: Draft) => {
  const p = await src.previewDraft({ params: { id: d.id }, body: { mode: 'send' } } as never);
  return src.dispatchDraft({ params: { id: d.id }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } } as never);
};

describe.skipIf(!pgAvailable)('release items on Postgres (mock ≡ db)', { timeout: 60_000 }, () => {
  it('stage: two ready items with the mock’s shapes; a second publish never duplicates', async () => {
    const [m, d] = [await mock.stageRelease({ body: body() } as never), await ds.stageRelease({ body: body() } as never)];
    expect(routes.stageRelease.response.safeParse(d).success).toBe(true);
    expect(d.entity.outcomes).toEqual(['created', 'created']);
    expect(d.entity.dryRun).toBe(m.entity.dryRun);
    expect(d.entity.drafts.map(shape)).toEqual(m.entity.drafts.map(shape));
    const again = await ds.stageRelease({ body: body({ notes: '### Fixed\n- a bug' }) } as never);
    expect(again.entity.outcomes).toEqual(['updated', 'updated']);
    expect(again.entity.drafts.map((x) => x.id)).toEqual(d.entity.drafts.map((x) => x.id));
    const out = await ds.getOutbox({} as never);
    expect(out.groups.flatMap((g) => g.items).filter((i) => i.draft.destination.kind === 'action' && i.draft.destination.action.startsWith('release.'))).toHaveLength(2);
    expect(out.groups.find((g) => g.group === 'pending_approval')!.items.filter((i) => i.draft.destination.kind === 'action' && i.draft.destination.action.startsWith('release.'))).toHaveLength(2);
    expect(out.admin.items.some((i) => i.draft.destination.kind === 'action' && i.draft.destination.action.startsWith('release.'))).toBe(false);
  });

  it('the announcement in dry run: rendered only, no delivery job, still pending', async () => {
    const [, announce] = (await ds.stageRelease({ body: body({ notes: '### Fixed\n- a bug' }) } as never)).entity.drafts;
    const r = await dispatch(ds, announce!);
    expect(r.dryRun).toBe(true);
    expect(r.payload).toMatchObject({ tool: 'slack_send_message', channel: CHANNEL });
    expect(r.draft.status).toBe('ready');
    expect(await count(sql`select count(*)::int as n from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${announce!.id}`)).toBe(0);
  });

  it('Mark uploaded: handed off, no job, one release landing; the mock agrees on the item', async () => {
    const [upload] = (await ds.stageRelease({ body: body({ notes: '### Fixed\n- a bug' }) } as never)).entity.drafts;
    const r = await dispatch(ds, upload!);
    expect(r.draft.status).toBe('sent');
    expect(r.attempt).toMatchObject({ outcome: 'sent', dryRun: false });
    expect(await count(sql`select count(*)::int as n from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${upload!.id}`)).toBe(0);
    const l = await handle.db.execute<{ record_kind: string; record_id: string; destination: string; external_id: string; state: string; n: number }>(
      sql`select l.record_kind, l.record_id, l.destination, l.external_id, l.state, (select count(*)::int from landing_writes w where w.landing_id = l.id) as n from record_landings l where l.owner_user_id = ${userId} and l.record_kind = 'release'`,
    );
    expect(l.rows).toEqual([{ record_kind: 'release', record_id: '2.1.0', destination: 'drive', external_id: FOLDER, state: 'sent', n: 1 }]);
    await expect(dispatch(ds, (await ds.getDraft({ params: { id: upload!.id } } as never)) as Draft)).rejects.toThrow(/already handed off/);
    // the mock: the same item after the same verb
    const [mu] = (await mock.stageRelease({ body: body({ notes: '### Fixed\n- a bug' }) } as never)).entity.drafts;
    const mr = await dispatch(mock, mu!);
    expect({ status: mr.draft.status, outcome: mr.attempt.outcome, detail: mr.attempt.detail }).toEqual({ status: r.draft.status, outcome: r.attempt.outcome, detail: r.attempt.detail });
    // a publish after the hand-off keeps it
    expect((await ds.stageRelease({ body: body({ notes: '### Fixed\n- later' }) } as never)).entity.outcomes).toEqual(['kept', 'updated']);
  });
});
