/**
 * The db DataSource's Outbox delivery bits (BE-OUTBOX).
 *
 * - `planDispatch()`: the confirm proof + delivery record for `POST /drafts/:id/dispatch`. Dry-run runs the
 *   engine's dry-run step right away (payload recorded, nothing external); live returns the record that the
 *   `outbox.dispatch` job will deliver.
 * - `recordDispatch()`: in the dispatch change set, stamps the attempt's request hash (payload sha256) and,
 *   live, the approval (`approved_content_hash = content_hash`) the job re-checks before delivering.
 * - `dbOutboxPort()`: the job's storage port. Each delivery state is saved in its own change set (actor
 *   system `outbox.deliver`): the attempt row (status, external id, error, finished_at), the draft status,
 *   a verification row for the read-back, and the attempt detail. Message bodies never enter the records.
 *   A delivered draft keeps where its result lives (`result_url`: the adapter's link, else one built from what the
 *   app knows), and a created canvas gets its `canvases` row (purpose `slackbot_work_order`).
 */
import { and, eq, sql } from 'drizzle-orm';
import { LOG_AGAIN_FLAG } from '@/engines/activity/org62-check';
import { canvasInputOf } from '@/lib/canvas/payload';
import { updateActivity } from './store/time';

import type { DispatchMode, Draft } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { canvases, drafts, draftSendAttempts } from '@/db/schema';
import {
  attemptDetail,
  attemptOf,
  autopilotRefusal,
  confirmDelivery,
  draftStatusOf,
  isOutcomeUnknown,
  isReleaseItem,
  NotConfirmedError,
  OutboxDelivery,
  payloadHash,
  resultUrlOf,
  sendingOf,
  verificationOf,
  type DeliveryConfirmation,
  type DeliveryRecord,
  type OutboxJobPayload,
  type OutboxJobPort,
} from '@/outbox';
import { invalid } from '@/server/errors';

import { payloadFor, renditionFor } from '../mock/render';
import { loadModel } from './model';
import { everything } from './reads/scope';
import type { WriteCtx } from './store/common';
import { updateDraft } from './store/nba';
import { recordMessageLanding } from './store/landings';
import { loadSettingsSections } from './store/settings';
import { dropCompanyLookups } from './store/vdp';

/** Already delivered (or delivering): never dispatched again, so nothing can go out twice. */
export const DELIVERED_STATUSES = new Set<Draft['status']>(['sending', 'sent', 'staged', 'verified', 'verify_failed']);

export interface DispatchPlan {
  payload: Record<string, unknown>;
  rendition: ReturnType<typeof renditionFor>;
  confirmation: DeliveryConfirmation;
  /** Final (dry_run_delivered) when dry-run; else the prepared record the job delivers. */
  rec: DeliveryRecord;
}

export async function planDispatch(d: Draft, i: { mode: DispatchMode; confirmToken: string; expectedToken: string; dryRun: boolean; now: Date }): Promise<DispatchPlan> {
  if (DELIVERED_STATUSES.has(d.status)) throw invalid(`Draft is ${d.status}: it was already delivered, so nothing was sent again`);
  const payload = payloadFor(d.destination, d.doc, i.mode);
  // D-90: a release announcement with no channel (or an empty post) says what to set; nothing is recorded or sent
  if (isReleaseItem(d.destination) && typeof payload.invalid === 'string') throw invalid(`Not sent: ${payload.invalid}`);
  const rendition = renditionFor(d.destination, d.doc);
  let confirmation: DeliveryConfirmation;
  try {
    confirmation = confirmDelivery({ draftId: d.id, draftVersion: d.version, mode: i.mode, payloadHash: payloadHash(payload), confirmToken: i.confirmToken, expectedToken: i.expectedToken, at: i.now.toISOString() });
  } catch (err) {
    if (err instanceof NotConfirmedError) throw invalid(err.message);
    throw err;
  }
  const engine = new OutboxDelivery({ gateway: null, now: () => i.now });
  const rec0 = engine.prepare({ draftId: d.id, draftVersion: d.version, destination: d.destination, mode: i.mode, payload, dryRun: i.dryRun, attemptNo: d.attempts.length + 1, confirmation });
  // Dry-run: the engine records the payload and would-be call; it never reaches a gateway (there is none here).
  const rec = rec0.dryRun ? await engine.execute(rec0, confirmation) : rec0;
  return { payload, rendition, confirmation, rec };
}

/** The attempt the dispatch change set appends (`id: '0'` = let the database number it). */
export function dispatchAttempt(plan: DispatchPlan, at: string): Draft['attempts'][number] {
  if (plan.rec.dryRun) return { ...attemptOf(plan.rec, '0'), at };
  const dest = plan.rec.channel === 'slack' || plan.rec.channel === 'slack_canvas' || plan.rec.channel === 'feedback' || plan.rec.channel === 'release' ? 'Slack' : plan.rec.channel === 'vdp' ? 'VDP' : 'Gmail';
  return { id: '0', at, mode: plan.rec.mode, dryRun: false, outcome: 'unconfirmed', detail: `Queued for delivery to ${dest}: nothing has left the machine yet` };
}

/** Inside the dispatch change set, after updateDraft appended the attempt. */
export async function recordDispatch(w: WriteCtx, draftId: string, attemptId: string, plan: DispatchPlan): Promise<void> {
  await w.tx.update(draftSendAttempts).set({ requestHash: plan.rec.payloadHash }).where(eq(draftSendAttempts.id, Number(attemptId)));
  if (!plan.rec.dryRun) await w.tx.update(drafts).set({ approvedContentHash: sql`${drafts.contentHash}` }).where(eq(drafts.id, draftId));
}

// ---------------------------------------------------------------------------
// Job storage port
// ---------------------------------------------------------------------------

export interface DbOutboxPortOptions {
  extractorId: () => Promise<string>;
  now?: () => Date;
}

export function dbOutboxPort(db: Db, userId: string, opts: DbOutboxPortOptions): OutboxJobPort {
  const now = opts.now ?? (() => new Date());
  return {
    async load(p: OutboxJobPayload) {
      const model = await loadModel(db, userId, now(), { scope: everything('outbox gateway') });
      const draft = model.get('drafts', p.draftId);
      if (!draft) return null;
      const [row] = await db
        .select({ approvedAt: drafts.approvedAt, approvalMethod: drafts.approvalMethod, approvedContentHash: drafts.approvedContentHash, contentHash: drafts.contentHash })
        .from(drafts)
        .where(eq(drafts.id, p.draftId));
      const [att] = await db.select({ attemptNo: draftSendAttempts.attemptNo, status: draftSendAttempts.status }).from(draftSendAttempts).where(eq(draftSendAttempts.id, Number(p.attemptId)));
      const sending = sendingOf(model.settings().sending);
      return {
        draft,
        attemptNo: att?.attemptNo ?? draft.attempts.length,
        approvedAt: row?.approvedAt ? new Date(row.approvedAt).toISOString() : null,
        approvalMethod: row?.approvalMethod ?? null,
        approvedContentHash: row?.approvedContentHash ?? null,
        currentContentHash: row?.contentHash ?? '',
        dryRun: sending.dryRun,
        verifyReadback: sending.verifyReadback,
        // B3: `started` is set only by markWriteStarted (a queued attempt is `unknown`; every outcome replaces it)
        writeStarted: att?.status === 'started',
        // D-60: an autopilot approval holds only while the stored settings still allow this very item
        ...(row?.approvalMethod === 'autonomy_policy' ? { policyRefusal: autopilotRefusal(draft.destination, sending) } : {}),
      };
    },

    /** B3: the attempt is `started` (committed) before the write leaves, so a crash after it is never re-sent. */
    async markWriteStarted(p: OutboxJobPayload) {
      await withChangeSet({ db, userId, actor: actors.system('outbox.deliver'), reason: 'Outbox write started', entity: { type: 'draft', id: p.draftId }, undoable: false }, async (tx) => {
        const r = await tx
          .update(draftSendAttempts)
          .set({ status: 'started', startedAt: now() })
          .where(and(eq(draftSendAttempts.id, Number(p.attemptId)), eq(draftSendAttempts.status, 'unknown')))
          .returning({ id: draftSendAttempts.id });
        if (!r.length) throw new Error('the attempt is no longer waiting to be delivered');
      });
    },

    async isDryRun() {
      const sections = await loadSettingsSections({ db, userId });
      return sendingOf(sections.sending).dryRun;
    },

    async save(p: OutboxJobPayload, rec: DeliveryRecord) {
      const extractorId = await opts.extractorId();
      const at = now();
      const reason = rec.state === 'failed' ? 'Outbox delivery failed' : rec.readback ? `Outbox read-back: ${rec.readback}` : rec.state === 'dry_run_delivered' ? 'Outbox dry-run delivered' : `Outbox delivered (${rec.mode})`;
      await withChangeSet({ db, userId, actor: actors.system('outbox.deliver'), reason, entity: { type: 'draft', id: p.draftId }, undoable: false }, async (tx, cs) => {
        const model = await loadModel(tx as unknown as Db, userId, at, { scope: everything('outbox gateway: in its transaction') });
        const cur = model.get('drafts', p.draftId);
        if (!cur) return;
        const w: WriteCtx = { tx, cs, userId, me: model.ctx.me, now: at, extractorId, timezone: model.settings().profile.timezone, kv: model.ctx.kv };
        const attempt = attemptOf(rec, p.attemptId);
        const delivered = rec.state === 'delivered' && !!rec.result;
        const next: Draft = {
          ...cur,
          status: draftStatusOf(rec, cur.status),
          verification: verificationOf(rec, cur.verification),
          attempts: cur.attempts.map((a) => (a.id === p.attemptId ? { ...attempt, at: a.at } : a)),
          ...(delivered ? { resultUrl: resultUrlOf(cur, rec, [model.settings().time.logging?.workOrderCanvasUrl, ...model.all('drafts').map((x) => x.resultUrl)]) } : {}),
        };
        await updateDraft(w, cur, next, { bump: true });
        await tx
          .update(draftSendAttempts)
          .set({
            // B3: a write that may have landed is `unknown` (it reads back as unconfirmed: "check before you try again")
            status: isOutcomeUnknown(rec) ? 'unknown' : rec.state === 'failed' ? 'failed' : rec.state === 'delivered' || rec.state === 'dry_run_delivered' ? 'succeeded' : 'unknown',
            dryRun: rec.dryRun,
            adapter: `${rec.channel}:${rec.mode}`,
            requestHash: rec.payloadHash,
            externalId: rec.result?.externalId ?? null,
            errorCode: rec.error?.code ?? null,
            errorMessage: rec.error ? attemptDetail(rec) : null,
            finishedAt: rec.finishedAt ? new Date(rec.finishedAt) : null,
          })
          .where(eq(draftSendAttempts.id, Number(p.attemptId)));
        if (delivered && cur.destination.kind === 'action' && cur.destination.action === 'slack_canvas.create') {
          // The canvas exists: its rows are handed off to Slackbot (the Org62 check watches them from here). A pipeline
          // move: a user lock on `status` never holds a row at approved (updateActivity drops it).
          for (const id of canvasInputOf(cur.destination).eventIds) {
            const row = model.get('activity', id);
            // D-65: a row put back by Log again is on a canvas now: its flag goes
            if (row && (row.status === 'approved' || row.status === 'proposed')) await updateActivity(w, model.extra.vocab, row, { ...row, status: 'synced_to_canvas', issues: row.issues.filter((f) => f !== LOG_AGAIN_FLAG) }, { bump: true }, row.accountName);
          }
          const externalId = rec.result!.externalId;
          if (externalId) {
            const ts = rec.finishedAt ? new Date(rec.finishedAt) : at;
            const readAt = rec.readback === 'confirmed' && rec.readbackAt ? new Date(rec.readbackAt) : null;
            const row = { title: cur.destination.target.label, url: next.resultUrl, lastWrittenAt: ts, ...(readAt ? { lastReadAt: readAt } : {}), syncStatus: 'in_sync' as const, updatedAt: at };
            await tx
              .insert(canvases)
              .values({ ownerUserId: userId, externalId, purpose: 'slackbot_work_order', writeApprovedAt: ts, writeApprovalNote: `Applied on Activity (Outbox item ${p.draftId})`, ...row })
              .onConflictDoUpdate({ target: [canvases.ownerUserId, canvases.externalId], set: row });
          }
        }
        // D-69 (VD-06): VDP says the company is gone (merged there): its cached match goes, the next read looks again
        if (rec.state === 'failed' && rec.channel === 'vdp' && rec.toolCall.tool === 'create_vdp' && rec.error?.code === 'not_found' && typeof rec.toolCall.args.company_id === 'string') {
          await dropCompanyLookups(tx, userId, rec.toolCall.args.company_id);
        }
        if (rec.state === 'delivered' && rec.result) {
          const ts = rec.finishedAt ? new Date(rec.finishedAt) : at;
          await tx
            .update(drafts)
            .set({
              sentExternalId: rec.result.externalId,
              ...(rec.mode === 'send' ? { sentAt: ts } : { stagedAt: ts }),
              ...(rec.readback === 'confirmed' && rec.readbackAt ? { verifiedAt: new Date(rec.readbackAt) } : {}),
            })
            .where(eq(drafts.id, p.draftId));
        }
        // D-98 (09 R5): an Applied Slack / Gmail item is recorded as a landing in this same change set (nothing new is sent)
        await recordMessageLanding(tx, userId, p.draftId, p.attemptId, rec);
      });
    },
  };
}
