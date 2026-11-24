/**
 * The db DataSource's release items (D-90, W12-7): where they go, what "Mark uploaded" leaves, and the worker's
 * announcement channel.
 *
 * - `releaseDistributionFor()`: the `distribution` settings key (`user_settings` key `settings.distribution`), else
 *   config/team.json, else the env (src/ops/distribution.ts): the server's folder and channel, never the client's.
 * - `checkHandoffConfirm()`: "Mark uploaded" spends a confirm token like any Apply (it binds this version's payload),
 *   but nothing is delivered: no delivery record, no job, no tool call.
 * - `recordReleaseLanding()`: the hand-off as a landing (`record_landings` kind `release`, record = the version,
 *   destination `drive`; one `landing_writes` row per draft), in the same change set. Ids, the folder, the build's name
 *   and sha256 only.
 * - `releaseChannelFor()`: the live release relay's channel (the worker wires it; src/outbox/transport.ts).
 */
import { sql } from 'drizzle-orm';

import type { DispatchMode, Draft } from '@/contract';
import type { DbOrTx } from '@/db/client';
import { landingWrites, recordLandings } from '@/db/schema';
import { resolveDistribution } from '@/ops/distribution';
import { confirmDelivery, NotConfirmedError, payloadHash, releaseLanding, type ReleaseDistribution } from '@/outbox';
import { invalid } from '@/server/errors';

import { payloadFor } from '../mock/render';
import { DELIVERED_STATUSES } from './outbox';

export const RELEASE_RECORD_KIND = 'release';

async function rawDistribution(db: DbOrTx, userId: string): Promise<unknown> {
  const r = await db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = 'settings.distribution'`);
  return r.rows[0]?.value ?? null;
}

export async function releaseDistributionFor(db: DbOrTx, userId: string): Promise<ReleaseDistribution> {
  const d = resolveDistribution(await rawDistribution(db, userId));
  return { driveFolderId: d.driveFolderId, announceChannel: d.announceChannel, announceChannelName: d.announceChannelName };
}

/** The announcement channel the live release relay may post to (null: none configured, so the post fails closed). */
export async function releaseChannelFor(db: DbOrTx, userId: string): Promise<string | null> {
  return (await releaseDistributionFor(db, userId)).announceChannel || null;
}

/** "Mark uploaded": the item must still be pending, and the confirm token must be this version's. */
export function checkHandoffConfirm(d: Draft, i: { mode: DispatchMode; confirmToken: string; expectedToken: string; now: Date }): void {
  if (DELIVERED_STATUSES.has(d.status)) throw invalid(`Draft is ${d.status}: it was already handed off`);
  const payload = payloadFor(d.destination, d.doc, i.mode);
  if (typeof payload.invalid === 'string') throw invalid(`Not handed off: ${payload.invalid}`);
  try {
    confirmDelivery({ draftId: d.id, draftVersion: d.version, mode: i.mode, payloadHash: payloadHash(payload), confirmToken: i.confirmToken, expectedToken: i.expectedToken, at: i.now.toISOString() });
  } catch (err) {
    if (err instanceof NotConfirmedError) throw invalid(err.message);
    throw err;
  }
}

/** The hand-off's landing and its one write (idempotent per draft). */
export async function recordReleaseLanding(tx: DbOrTx, userId: string, d: Draft, at: Date): Promise<void> {
  if (d.destination.kind !== 'action') return;
  const l = releaseLanding(d.destination);
  const [row] = await tx
    .insert(recordLandings)
    .values({ ownerUserId: userId, recordKind: RELEASE_RECORD_KIND, recordId: l.recordId, destination: l.destination, externalId: l.externalId, state: 'sent' })
    .onConflictDoUpdate({
      target: [recordLandings.ownerUserId, recordLandings.recordKind, recordLandings.recordId, recordLandings.destination],
      set: { externalId: sql`coalesce(excluded.external_id, ${recordLandings.externalId})`, state: 'sent', updatedAt: new Date() },
    })
    .returning({ id: recordLandings.id });
  await tx
    .insert(landingWrites)
    .values({ ownerUserId: userId, landingId: row!.id, draftId: d.id, rowKey: 'handoff', op: 'create', after: l.values, state: 'sent', origin: 'outbox', reason: 'Marked uploaded in the Outbox (a hand-off: the app sent nothing)', sentAt: at })
    .onConflictDoUpdate({
      target: [landingWrites.ownerUserId, landingWrites.draftId, landingWrites.rowKey],
      targetWhere: sql`${landingWrites.draftId} is not null`,
      set: { after: l.values, state: 'sent', sentAt: at, updatedAt: new Date() },
    });
}
