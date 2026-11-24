/**
 * The mock DataSource's Outbox delivery (BE-OUTBOX). Dispatch runs the real delivery engine and adapters;
 * the transport is the in-memory `SimulatedOutboxTransport`, so CC_DATA=mock never calls any external system,
 * even with dry-run off (CONTRACT.md "Dispatch").
 *
 *   dry-run ON (default)  confirm proof → record the exact payload + would-be tool call → attempt "Dry-run
 *                         delivered" (outcome rendered); the draft status does not change.
 *   dry-run OFF           confirm proof → status sending → write (simulated) → staged | sent, or failed (Outbox
 *                         error; dispatch throws upstream_unavailable; retry = a fresh confirm) → read-back
 *                         after `verifyMs` → verified | verify_failed (or staged + unverified for a Slack draft).
 *
 * The client's SendFlow already ran the undo window before it calls dispatch, so there is no server hold here.
 * Every step is one audited `tx` (actor user for the confirm, system for delivery and read-back).
 */
import type { ActionDestination, AuditEntry, DispatchMode, DispatchResult, Draft, LiveNotify, RouteInput, SendingSettingsPatch, Settings, StageReleaseResult } from '@/contract';
import { LOG_AGAIN_FLAG } from '@/engines/activity/org62-check';
import { loggingProfile } from '@/engines/activity/persona';
import { canvasInputOf } from '@/lib/canvas/payload';
import { preflightSummary, type CanvasPreflightContext } from '@/lib/canvas/preflight';
import { personaOf } from '@/personas';
import { isPendingLogCanvas, preflightDraft } from '@/server/time/canvas-preflight';
import { feedbackHeld } from '@/lib/feedback/payload';
import { actionDoc, actionSummary } from '@/lib/actions';
import { resolveDistribution } from '@/ops/distribution';
import { actionDraftFor } from '@/server/vdp/coverage';
import {
  attemptDetail,
  handedOff,
  isReleaseHandoff,
  isReleaseItem,
  stageRelease,
  attemptOf,
  confirmDelivery,
  defaultModeFor,
  draftStatusOf,
  mergeSendingPatch,
  NotConfirmedError,
  OutboxDelivery,
  OutboxGateway,
  payloadHash,
  resultUrlOf,
  SimulatedOutboxTransport,
  verificationOf,
  type DeliveryRecord,
  type OutboxTransport,
} from '@/outbox';
import { AppError, invalid } from '../../errors';
import { payloadFor, renderAll, renditionFor } from './render';
import type { Store, Tx } from './store';
import { hrefFor } from './views';
import { actionApp } from '@/lib/actions';

interface MockTxMeta {
  actor: 'user' | 'system';
  action: string;
  summary: string;
  entity: { type: 'draft'; id: string; label: string };
  undoable?: boolean;
  notify?: LiveNotify;
}

export interface MockOutboxHost {
  store(): Store;
  /** D-65: what a logging canvas's Apply preflight reads besides the rows: my DCs and DC requests (D-68), the use cases (D-67). */
  preflightExtra?(): Pick<CanvasPreflightContext, 'dcLive' | 'useCase' | 'useCaseRecord'>;
  now(): Date;
  checkVersion(cur: { version: number }, ifVersion: number | undefined, what: string, current: unknown): void;
  confirmTokenFor(d: Draft, mode: DispatchMode): string;
  tx(meta: MockTxMeta, fn: (tx: Tx) => void): { entry: AuditEntry | null };
  bump<T extends { version: number; updatedAt?: string }>(v: T): T;
  later(ms: number, fn: () => void): void;
  verifyMs(): number;
  newId(prefix: string): string;
  /** A verified send closes its live work item ("Reply verified in Slack"). */
  onVerifiedSend(d: Draft): void;
}

/** Already delivered (or delivering): never dispatched again, so nothing can go out twice. */
const DELIVERED = new Set<Draft['status']>(['sending', 'sent', 'staged', 'verified', 'verify_failed']);

const where = (d: Draft) => (d.destination.kind === 'slack' ? d.destination.channelName : d.destination.kind === 'action' ? d.destination.target.label : d.destination.subject);
const destName = (d: Draft) => (d.destination.kind === 'slack' ? 'Slack' : d.destination.kind === 'action' ? actionApp(d.destination.action) : 'Gmail');

/**
 * D-65: the mock's state for a logging canvas preflight (src/lib/canvas/preflight.ts): its rows as the store has them.
 * The mock keeps no WhatId (not compared) and no Org62 Events (Duration fixes pass).
 */
export function mockPreflightContext(store: Store, unstage?: ReadonlySet<string>): CanvasPreflightContext {
  return {
    activity: (id) => {
      const a = store.get('activity', id);
      return a ? { status: a.status, startsAt: a.start, endsAt: a.end, durationH: a.durationH, taskType: a.taskType, flags: a.issues } : null;
    },
    taskTypeRequired: loggingProfile(personaOf(store.settings())).taskTypeRequired,
    ...(unstage ? { unstage } : {}),
  };
}

export class MockOutbox {
  private transport: OutboxTransport;
  private readonly records = new Map<string, DeliveryRecord[]>();

  constructor(private readonly host: MockOutboxHost) {
    this.transport = new SimulatedOutboxTransport(() => host.now());
  }

  /** Tests swap in their own fake MCP transport. */
  useTransport(t: OutboxTransport): void {
    this.transport = t;
  }

  /** Every delivery record for a draft, oldest first (the audit's delivery detail). */
  deliveries(draftId: string): DeliveryRecord[] {
    return [...(this.records.get(draftId) ?? [])];
  }

  private remember(rec: DeliveryRecord): void {
    const list = this.records.get(rec.draftId) ?? [];
    const i = list.findIndex((r) => r.id === rec.id);
    if (i >= 0) list[i] = rec;
    else list.push(rec);
    this.records.set(rec.draftId, list);
  }

  private engine(): OutboxDelivery {
    return new OutboxDelivery({
      gateway: new OutboxGateway(this.transport),
      now: () => this.host.now(),
      newId: () => this.host.newId('dlv'),
      isDryRun: () => this.host.store().settings().sending.dryRun !== false,
      onChange: (rec) => this.remember(rec),
    });
  }

  /** The mode a preview without an explicit mode uses (user's choice, else Settings → Sending per channel). */
  defaultMode(d: Draft): DispatchMode {
    return defaultModeFor(d, this.host.store().settings().sending);
  }

  /** PATCH /settings/sending merge (channels merge per channel). */
  mergeSending(cur: Settings['sending'], value: Record<string, unknown>): Settings['sending'] {
    return mergeSendingPatch(cur, value as SendingSettingsPatch);
  }

  async dispatch({ params, body }: RouteInput<'dispatchDraft'>): Promise<DispatchResult> {
    const store = this.host.store();
    const d = store.must('drafts', params.id, 'Draft');
    this.host.checkVersion(d, body.ifVersion, 'Draft', d);
    if (DELIVERED.has(d.status)) throw invalid(`Draft is ${d.status}: it was already delivered, so nothing was sent again`);
    // D-65 (TL-06, TL-24): a logging canvas is re-checked before anything leaves (the db's rule): re-rendered or refused
    if (isPendingLogCanvas(d)) {
      const out = preflightDraft(d, { ...mockPreflightContext(store), ...(this.host.preflightExtra?.() ?? {}) });
      if (out.next) {
        const next = this.host.bump(out.next);
        this.host.tx({ actor: 'system', action: out.result.empty ? 'time.canvas.empty' : 'time.canvas.preflight', summary: `${out.result.empty ? 'Canvas discarded' : 'Canvas re-rendered'} at Apply: ${preflightSummary(out.result)}`.slice(0, 200), entity: { type: 'draft', id: d.id, label: where(d) }, undoable: false }, (tx) => tx.put('drafts', next));
        throw invalid(out.message!, { draftId: d.id, dropped: out.result.dropped, discarded: out.result.empty });
      }
    }
    const mode = body.mode;
    const payload = payloadFor(d.destination, d.doc, mode);
    if (isReleaseHandoff(d.destination)) return this.markHandedOff(d, mode, payload, body.confirmToken); // D-90: never delivers
    // D-90: a release announcement with no channel (or an empty post) says what to set; nothing is recorded or sent
    if (isReleaseItem(d.destination) && typeof payload.invalid === 'string') throw invalid(`Not sent: ${payload.invalid}`);
    const rendition = renditionFor(d.destination, d.doc);
    const nowIso = this.host.now().toISOString();
    let confirmation;
    try {
      confirmation = confirmDelivery({ draftId: d.id, draftVersion: d.version, mode, payloadHash: payloadHash(payload), confirmToken: body.confirmToken, expectedToken: this.host.confirmTokenFor(d, mode), at: nowIso });
    } catch (err) {
      if (err instanceof NotConfirmedError) throw invalid(err.message);
      throw err;
    }
    const sending = store.settings().sending;
    const engine = this.engine();
    // Global dry run, and Settings ▸ Feedback "Post live" off for a feedback report (D-56).
    const dryRun = sending.dryRun !== false || feedbackHeld(d.destination, store.settings().feedback);
    const rec0 = engine.prepare({ draftId: d.id, draftVersion: d.version, destination: d.destination, mode, payload, dryRun, attemptNo: d.attempts.length + 1, confirmation });
    const entity = { type: 'draft' as const, id: d.id, label: where(d) };

    if (rec0.dryRun) {
      const rec = await engine.execute(rec0, confirmation);
      const attempt = attemptOf(rec, this.host.newId('att'));
      const next: Draft = this.host.bump({ ...d, mode, attempts: [...d.attempts, attempt] });
      const { entry } = this.host.tx({ actor: 'user', action: 'draft.dispatch.dry_run', summary: `Dry run: ${where(d)}`, entity, undoable: false }, (tx) => tx.put('drafts', next));
      return { draft: next, dryRun: true, payload, rendition, attempt, auditId: entry!.id };
    }

    // Live (simulated): the confirm approves and locks the draft, then the adapter runs.
    const attemptId = this.host.newId('att');
    const started: Draft = this.host.bump({
      ...d,
      mode,
      status: 'sending',
      attempts: [...d.attempts, { id: attemptId, at: nowIso, mode, dryRun: false, outcome: 'unconfirmed', detail: attemptDetail(rec0) }],
      verification: { state: 'pending', at: null, detail: `Delivering to ${destName(d)}…` },
    });
    const { entry } = this.host.tx({ actor: 'user', action: `draft.dispatch.${mode}`, summary: `${mode === 'send' ? 'Sending' : 'Pushing draft'}: ${where(d)}`, entity, undoable: false }, (tx) => tx.put('drafts', started));

    const rec = await engine.execute(rec0, confirmation);
    const cur = store.get('drafts', d.id) ?? started;
    const attempt = attemptOf(rec, attemptId);
    const failed = rec.state === 'failed';
    // where the result lives (the canvas, the permalink, the VDP record): the db's rule (resultUrlOf)
    const known = [store.settings().time.logging?.workOrderCanvasUrl, ...store.all('drafts').map((x) => x.resultUrl)];
    const after: Draft = this.host.bump({
      ...cur,
      status: draftStatusOf(rec, cur.status),
      verification: verificationOf(rec, cur.verification),
      attempts: cur.attempts.map((a) => (a.id === attemptId ? attempt : a)),
      ...(!failed && rec.result ? { resultUrl: resultUrlOf(cur, rec, known), ...(rec.result.externalId ? { externalId: rec.result.externalId } : {}) } : {}),
    });
    this.host.tx(
      {
        actor: 'system',
        action: failed ? 'draft.delivery_failed' : `draft.delivered.${mode}`,
        summary: failed ? `Couldn't deliver: ${where(d)}` : `${mode === 'send' ? 'Sent' : 'Draft pushed'}: ${where(d)}`,
        entity,
        undoable: false,
        // A failure persists inline on the Outbox row (UI-SPEC §9), so no toast here.
      },
      (tx) => {
        tx.put('drafts', after);
        // A created logging canvas hands its rows to Slackbot (the Org62 check watches them from here).
        if (!failed && after.destination.kind === 'action' && after.destination.action === 'slack_canvas.create') {
          for (const rid of canvasInputOf(after.destination).eventIds) {
            const row = store.get('activity', rid);
            // D-65: a row put back by Log again is on a canvas now: its flag goes
            if (row && (row.status === 'approved' || row.status === 'proposed')) tx.put('activity', this.host.bump({ ...row, status: 'synced_to_canvas', issues: row.issues.filter((f) => f !== LOG_AGAIN_FLAG) }));
          }
        }
      },
    );
    if (failed) {
      // Persisted as an Outbox error above. Retrying is a fresh confirm (the Outbox row's Retry), never a re-post.
      throw new AppError('upstream_unavailable', attempt.detail ?? 'Delivery failed', { draftId: d.id, attemptId, code: rec.error?.code, retry: 'reconfirm', retryable: rec.error?.retryable ?? false }, false);
    }
    if (sending.verifyReadback !== false) {
      this.host.later(this.host.verifyMs(), () => {
        void this.readback(rec, attemptId).catch((err: unknown) => console.error('[mock] outbox read-back failed:', (err as Error).message));
      });
    }
    return { draft: after, dryRun: false, payload, rendition, attempt, auditId: entry!.id };
  }

  // ---- D-90 (W12-7): the release items (src/outbox/release.ts; the db's twin: db/index.ts + db/outbox-release.ts) ----

  /** POST /outbox/releases: the two items, idempotent per version (the db's rule, over the store). */
  async stageRelease(body: RouteInput<'stageRelease'>['body']): Promise<StageReleaseResult> {
    const store = () => this.host.store();
    const save = (dest: ActionDestination, audit: { action: string; summary: string }, cur?: Draft): Draft => {
      const doc = actionDoc(dest);
      const draft = cur
        ? this.host.bump({ ...cur, destination: dest, doc, plainText: actionSummary(dest), rendered: renderAll(dest, doc), status: 'ready' as const })
        : actionDraftFor(dest, { id: this.host.newId('d'), now: this.host.now().toISOString(), workItemId: null, rendered: (x) => renderAll(dest, x) });
      this.host.tx({ actor: 'user', action: audit.action, summary: audit.summary.slice(0, 200), entity: { type: 'draft', id: draft.id, label: dest.target.label }, undoable: false }, (tx) => tx.put('drafts', draft));
      return draft;
    };
    return stageRelease(
      {
        drafts: async () => store().all('drafts'),
        distribution: async () => {
          const d = resolveDistribution((store().settings() as { distribution?: unknown }).distribution ?? null);
          return { driveFolderId: d.driveFolderId, announceChannel: d.announceChannel, announceChannelName: d.announceChannelName };
        },
        dryRun: async () => store().settings().sending.dryRun !== false,
        insert: async (dest, audit) => save(dest, audit),
        replace: async (cur, dest, audit) => save(dest, audit, cur),
      },
      body,
    );
  }

  /** "Mark uploaded": the confirm is spent like any Apply, then the item is handed off. No delivery, no tool call. */
  private markHandedOff(d: Draft, mode: DispatchMode, payload: Record<string, unknown>, confirmToken: string): DispatchResult {
    if (typeof payload.invalid === 'string') throw invalid(`Not handed off: ${payload.invalid}`);
    const nowIso = this.host.now().toISOString();
    try {
      confirmDelivery({ draftId: d.id, draftVersion: d.version, mode, payloadHash: payloadHash(payload), confirmToken, expectedToken: this.host.confirmTokenFor(d, mode), at: nowIso });
    } catch (err) {
      if (err instanceof NotConfirmedError) throw invalid(err.message);
      throw err;
    }
    const next = this.host.bump(handedOff(d, nowIso, this.host.newId('att')));
    const { entry } = this.host.tx({ actor: 'user', action: 'release.handed_off', summary: `Marked uploaded: ${where(d)}`.slice(0, 200), entity: { type: 'draft', id: d.id, label: where(d) }, undoable: false }, (tx) => tx.put('drafts', next));
    return { draft: next, dryRun: false, payload, rendition: renditionFor(d.destination, d.doc), attempt: next.attempts[next.attempts.length - 1]!, auditId: entry!.id };
  }

  /** Read-back after a (simulated) write; updates status + verification, closes the item on a verified send. */
  async readback(rec: DeliveryRecord, attemptId: string): Promise<DeliveryRecord> {
    const v = await this.engine().verify(rec);
    const cur = this.host.store().get('drafts', rec.draftId);
    if (!cur) return v;
    const attempt = attemptOf(v, attemptId);
    const next: Draft = { ...cur, status: draftStatusOf(v, cur.status), verification: verificationOf(v, cur.verification), attempts: cur.attempts.map((a) => (a.id === attemptId ? attempt : a)) };
    const ok = v.readback === 'confirmed';
    const dest = destName(cur);
    this.host.tx(
      {
        actor: 'system',
        action: ok ? 'draft.verified' : 'draft.verify_unconfirmed',
        summary: ok ? `Verified in ${dest}` : `Not verified in ${dest}`,
        entity: { type: 'draft', id: cur.id, label: where(cur) },
        undoable: false,
        notify: ok ? { channel: 'toast', title: `Verified in ${dest} ✓`, tone: 'ok', href: hrefFor({ type: 'draft', id: cur.id }) } : undefined,
      },
      (tx) => tx.put('drafts', next),
    );
    if (ok && v.mode === 'send') this.host.onVerifiedSend(cur);
    return v;
  }
}
