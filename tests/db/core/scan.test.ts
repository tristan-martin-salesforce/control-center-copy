import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '../../../src/db/changeset';
import { CursorError } from '../../../src/db/errors';
import { commitScanPage } from '../../../src/db/scan';
import { scanCursors, scanLedgerEntries, scanRuns, sourceItems } from '../../../src/db/schema';
import { createConnector, createUser, openTestDb } from './helpers';

const h = openTestDb();
const db = h.db;
let userId: string;
let connectorId: string;
const scope = 'slack:channel:C0PLACEHOLDER';
const t = (iso: string) => new Date(iso);

async function newRun(): Promise<string> {
  const [r] = await db
    .insert(scanRuns)
    .values({ ownerUserId: userId, connectorId, scope, trigger: 'schedule', mode: 'incremental', status: 'running' })
    .returning({ id: scanRuns.id });
  return r!.id;
}

async function cursor() {
  const [c] = await db
    .select()
    .from(scanCursors)
    .where(and(eq(scanCursors.connectorId, connectorId), eq(scanCursors.scope, scope)));
  return c;
}

beforeAll(async () => {
  userId = await createUser(db, 'scan');
  connectorId = await createConnector(db, userId, 'slack');
});
afterAll(() => h.close());

describe('cursor + coverage commit', () => {
  it('advances the cursor and writes the ledger in one transaction', async () => {
    const runId = await newRun();
    const res = await db.transaction((tx) =>
      commitScanPage(tx, {
        ownerUserId: userId,
        connectorId,
        scope,
        scanRunId: runId,
        cursorKind: 'timestamp',
        cursorValue: '1793865600.000100',
        highWatermarkAt: t('2026-11-02T12:00:00Z'),
        ledger: [
          {
            objectKind: 'channel_history',
            objectExternalId: 'C0PLACEHOLDER',
            coveredFrom: t('2026-11-02T08:00:00Z'),
            coveredTo: t('2026-11-02T12:00:00Z'),
            itemCount: 4,
            newItemCount: 4,
            outcome: 'complete',
          },
        ],
      }),
    );
    expect(res.previousHighWatermarkAt).toBeNull();
    const c = await cursor();
    expect(c).toMatchObject({ cursorValue: '1793865600.000100', lastRunId: runId });
    expect(c!.highWatermarkAt!.toISOString()).toBe('2026-11-02T12:00:00.000Z');
  });

  it('a rollback after the advance (crash mid-page) leaves the cursor, ledger and items unmoved', async () => {
    const before = await cursor();
    const ledgerBefore = await db.select().from(scanLedgerEntries).where(eq(scanLedgerEntries.connectorId, connectorId));
    const runId = await newRun();

    const crash = await withChangeSet({ db, userId, actor: actors.scanner('slack'), reason: 'scan slack page' }, async (tx) => {
      await tx.insert(sourceItems).values({
        ownerUserId: userId,
        connectorId,
        source: 'slack',
        kind: 'slack_message',
        externalId: '1793880000.000200',
        dedupeKey: 'slack:T0:C0PLACEHOLDER:1793880000.000200',
        contentHash: 'sha256:placeholder',
        occurredAt: t('2026-11-02T13:00:00Z'),
        body: 'I will send the deck by EOD',
      });
      await commitScanPage(tx, {
        ownerUserId: userId,
        connectorId,
        scope,
        scanRunId: runId,
        cursorKind: 'timestamp',
        cursorValue: '1793880000.000200',
        highWatermarkAt: t('2026-11-02T14:00:00Z'),
        ledger: [
          { objectKind: 'channel_history', coveredFrom: t('2026-11-02T12:00:00Z'), coveredTo: t('2026-11-02T14:00:00Z'), outcome: 'complete' },
        ],
      });
      throw new Error('worker killed mid-page');
    }).catch((e: unknown) => e);
    expect((crash as Error).message).toBe('worker killed mid-page');

    const after = await cursor();
    expect(after!.highWatermarkAt!.toISOString()).toBe(before!.highWatermarkAt!.toISOString());
    expect(after!.cursorValue).toBe(before!.cursorValue);
    expect(after!.lastRunId).toBe(before!.lastRunId);
    expect(await db.select().from(scanLedgerEntries).where(eq(scanLedgerEntries.connectorId, connectorId))).toHaveLength(
      ledgerBefore.length,
    );
    const { n } = (
      await db.execute<{ n: string }>(sql`select count(*) as n from source_items where external_id = '1793880000.000200'`)
    ).rows[0]!;
    expect(Number(n)).toBe(0);
  });

  it('refuses to move the cursor past a coverage hole, or backwards', async () => {
    const runId = await newRun();
    const gap = await db
      .transaction((tx) =>
        commitScanPage(tx, {
          ownerUserId: userId,
          connectorId,
          scope,
          scanRunId: runId,
          cursorKind: 'timestamp',
          highWatermarkAt: t('2026-11-02T18:00:00Z'),
          // 12:00-14:00 was never committed, so 12:00-15:00 is a hole
          ledger: [{ objectKind: 'channel_history', coveredFrom: t('2026-11-02T15:00:00Z'), coveredTo: t('2026-11-02T18:00:00Z'), outcome: 'complete' }],
        }),
      )
      .catch((e: unknown) => e);
    expect(gap).toBeInstanceOf(CursorError);
    expect(gap).toMatchObject({ reason: 'coverage_gap' });
    expect((gap as Error).message).toContain('2026-11-02 12:00:00+00');

    const back = await db
      .transaction((tx) =>
        commitScanPage(tx, {
          ownerUserId: userId,
          connectorId,
          scope,
          scanRunId: runId,
          cursorKind: 'timestamp',
          highWatermarkAt: t('2026-11-01T00:00:00Z'),
          ledger: [{ objectKind: 'channel_history', coveredFrom: t('2026-11-01T00:00:00Z'), coveredTo: t('2026-11-01T01:00:00Z'), outcome: 'complete' }],
        }),
      )
      .catch((e: unknown) => e);
    expect(back).toMatchObject({ reason: 'regression' });
    expect((await cursor())!.highWatermarkAt!.toISOString()).toBe('2026-11-02T12:00:00.000Z');
  });

  it('a weekend backfill (newest hour first, then older chunks) closes the gap with no holes', async () => {
    // Newest hour first lands in the ledger but cannot move the cursor yet (12:00 -> Mon 08:00 open).
    const r1 = await newRun();
    await db.insert(scanLedgerEntries).values({
      scanRunId: r1,
      connectorId,
      scope,
      objectKind: 'channel_history',
      coveredFrom: t('2026-11-09T07:00:00Z'),
      coveredTo: t('2026-11-09T08:00:00Z'),
      outcome: 'complete',
    });
    // Backfill oldest -> newest in 6 h chunks; the last chunk lets the cursor reach Monday 08:00.
    const chunks: [string, string][] = [];
    for (let s = t('2026-11-02T12:00:00Z').getTime(); s < t('2026-11-09T07:00:00Z').getTime(); s += 6 * 3600_000) {
      chunks.push([new Date(s).toISOString(), new Date(Math.min(s + 6 * 3600_000, t('2026-11-09T07:00:00Z').getTime())).toISOString()]);
    }
    for (const [from, to] of chunks.slice(0, -1)) {
      await db.insert(scanLedgerEntries).values({ scanRunId: r1, connectorId, scope, objectKind: 'channel_history', coveredFrom: t(from), coveredTo: t(to), outcome: 'complete' });
    }
    const [lastFrom, lastTo] = chunks.at(-1)!;
    await db.transaction((tx) =>
      commitScanPage(tx, {
        ownerUserId: userId,
        connectorId,
        scope,
        scanRunId: r1,
        cursorKind: 'timestamp',
        highWatermarkAt: t('2026-11-09T08:00:00Z'),
        ledger: [{ objectKind: 'channel_history', coveredFrom: t(lastFrom), coveredTo: t(lastTo), outcome: 'complete' }],
      }),
    );
    expect((await cursor())!.highWatermarkAt!.toISOString()).toBe('2026-11-09T08:00:00.000Z');
    // "What did we look at between X and Y?" is one multirange query; no holes remain.
    const holes = await db.execute<{ holes: string }>(sql`
      select (tstzmultirange(tstzrange('2026-11-02 08:00Z', '2026-11-09 08:00Z')) - range_agg(covered))::text as holes
        from scan_ledger_entries where connector_id = ${connectorId} and scope = ${scope} and outcome = 'complete'`);
    expect(holes.rows[0]!.holes).toBe('{}');
  });
});
