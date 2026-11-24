/** Drafts and the Outbox. */
import type { In, Out } from './route';

export interface DraftsSource {
  getDraft(i: In<'getDraft'>): Out<'getDraft'>;
  /** The message a draft replies to, with up to 5 earlier thread messages (read-only; bodies stay local and redacted). */
  getDraftSource(i: In<'getDraftSource'>): Out<'getDraftSource'>;
  patchDraft(i: In<'patchDraft'>): Out<'patchDraft'>;
  /** Add to Outbox (BE-CHAT): drafting → ready, audited + undoable; idempotent on ready; any other status 409 with the current draft. */
  queueDraft(i: In<'queueDraft'>): Out<'queueDraft'>;
  /** REJECT-1: drafting/ready/scheduled/failed → rejected, audited + undoable; idempotent on rejected; sending or sent 409. Never calls out. */
  rejectDraft(i: In<'rejectDraft'>): Out<'rejectDraft'>;
  previewDraft(i: In<'previewDraft'>): Out<'previewDraft'>;
  /** MUST honor dry-run. MUST NOT call any external system unless dry-run is off AND the user confirmed. */
  dispatchDraft(i: In<'dispatchDraft'>): Out<'dispatchDraft'>;
  getOutbox(i: In<'getOutbox'>): Out<'getOutbox'>;
  /** D-90 (W12-7): a built release → its two pending Outbox items (src/outbox/release.ts); nothing is sent. */
  stageRelease(i: In<'stageRelease'>): Out<'stageRelease'>;
}
