/**
 * Time's logging canvases (D-47, D-52): every `slack_canvas.create` logging item, as `TimeWeek.logCanvases`. Pure and
 * shared by both DataSources, so the mock and the db show the same list from the same drafts and rows.
 *
 *   pending / retry      waiting for your Apply (the Q4 card's Apply step)
 *   applying … verified  applied: Time's receipts (Applied canvases) and the Confirm step's canvases, with the link,
 *                        the rows and DCs, and the Org62 check over the rows
 *
 * Applied canvases stay listed for 14 days, and longer while any of their rows is not in Org62 yet (so the Confirm
 * step can always name the canvas a handed-off row is on).
 */
import type { ActivityEntry, DcRequest, Draft, DraftStatus, LogCanvas, UseCaseSyncItem } from '@/contract';
import { canvasProgressOf, type CanvasChecks, type Org62Reads } from '@/lib/canvas/checks';
import { adminSurfaceOf } from '@/contract';
import { canvasInputOf, maybeDelivered, ucRowCount } from '@/lib/canvas/payload';
import { dcRowCount } from '@/lib/canvas/prompt';
import { countsAsLogged, org62CheckOf } from '@/engines/activity/org62-check';
import { fiscalQuarterOfDay } from './activity-log';

export const RECEIPT_DAYS = 14;

const STATE: Partial<Record<DraftStatus, LogCanvas['state']>> = {
  ready: 'pending',
  scheduled: 'pending',
  failed: 'retry',
  sending: 'applying',
  sent: 'applied',
  staged: 'applied',
  verified: 'verified',
  verify_failed: 'unverified',
};

const APPLIED: ReadonlySet<LogCanvas['state']> = new Set(['applying', 'applied', 'verified', 'unverified']);
export const isAppliedCanvas = (c: Pick<LogCanvas, 'state'>) => APPLIED.has(c.state);

/** When it was applied: the newest live attempt that did not fail (a dry run never applies anything). */
export function appliedAtOf(d: Pick<Draft, 'attempts'>): string | null {
  for (let i = d.attempts.length - 1; i >= 0; i--) {
    const a = d.attempts[i]!;
    if (!a.dryRun && a.outcome !== 'failed' && a.outcome !== 'rendered') return a.at;
  }
  return null;
}

/** The Org62 check over a canvas's rows: in Org62, still waiting, missing after the write. */
function org62Of(ids: readonly string[], rows: ReadonlyMap<string, CanvasRow>): LogCanvas['org62'] {
  let logged = 0;
  let waiting = 0;
  let missing = 0;
  for (const id of ids) {
    const r = rows.get(id);
    if (!r) continue;
    // TL-45: the one count map. In Org62 (a row whose fields differ is in Org62 too); missing = not in Org62 after
    // all (deleted there, or the canvas ran without it); waiting = on its way
    const check = org62CheckOf(r);
    if (check === 'deleted' || check === 'not_in_org62') missing++;
    else if (countsAsLogged(r) || r.status === 'logged' || r.status === 'verified') logged++;
    else if (r.status === 'synced_to_canvas' || r.status === 'approved' || r.status === 'proposed') waiting++;
  }
  return { logged, waiting, missing };
}

/** The rows Time's canvases read: their status, and (for the quarter split) their local day and hours. */
type CanvasRow = Pick<ActivityEntry, 'id' | 'status'> & Partial<Pick<ActivityEntry, 'date' | 'durationH' | 'issues'>>;

/**
 * Where a canvas's hours land: its rows per fiscal quarter of their local day, newest quarter first. Rows the store
 * no longer has, or without a day, are left out (the canvas's own counts still carry them).
 */
export function quartersOf(ids: readonly string[], rows: ReadonlyMap<string, CanvasRow>): LogCanvas['quarters'] {
  const by = new Map<string, { label: string; start: string; rows: number; hours: number }>();
  for (const id of ids) {
    const r = rows.get(id);
    if (!r?.date) continue;
    const label = fiscalQuarterOfDay(r.date);
    const q = by.get(label) ?? { label, start: r.date.slice(0, 7), rows: 0, hours: 0 };
    q.rows += 1;
    q.hours += r.durationH ?? 0;
    if (r.date.slice(0, 7) < q.start) q.start = r.date.slice(0, 7);
    by.set(label, q);
  }
  return [...by.values()].sort((a, b) => b.start.localeCompare(a.start)).map(({ label, rows: n, hours }) => ({ label, rows: n, hours: Math.round(hours * 100) / 100 }));
}

/**
 * 2026-11-13 audit C4: what each created canvas's own progress line reads (both DataSources pass the same): its DC
 * requests, the use cases on it, the per-canvas checks (when you told Slackbot, what is queued) and the last Org62 reads.
 */
export interface CanvasProgressSources {
  dcRequests?: readonly Pick<DcRequest, 'canvasDraftId' | 'stage' | 'outcome'>[];
  useCases?: readonly Pick<UseCaseSyncItem, 'canvasDraftId' | 'state'>[];
  checks?: CanvasChecks;
  reads?: Org62Reads;
}

const CREATED: ReadonlySet<LogCanvas['state']> = new Set(['applied', 'verified', 'unverified']);

export function logCanvasesOf(drafts: readonly Draft[], activity: readonly CanvasRow[], now: Date, progress?: CanvasProgressSources): LogCanvas[] {
  const rows = new Map(activity.map((a) => [a.id, a] as const));
  const since = now.getTime() - RECEIPT_DAYS * 86_400_000;
  const out: LogCanvas[] = [];
  for (const d of drafts) {
    if (d.destination.kind !== 'action' || adminSurfaceOf(d) !== 'log') continue;
    const state = STATE[d.status];
    if (!state) continue;
    const i = canvasInputOf(d.destination);
    const applied = APPLIED.has(state);
    const org62 = applied && i.eventIds.length ? org62Of(i.eventIds, rows) : null;
    const appliedAt = applied ? (appliedAtOf(d) ?? d.updatedAt) : null;
    if (appliedAt && Date.parse(appliedAt) < since && !(org62 && (org62.waiting || org62.missing))) continue;
    const counts = { rows: i.eventIds.length, dcs: dcRowCount(i.markdown), useCases: ucRowCount(i.markdown) };
    out.push({
      draftId: d.id,
      title: d.destination.target.label,
      state,
      url: applied ? d.resultUrl : null,
      createdAt: d.createdAt,
      appliedAt,
      rows: i.eventIds.length,
      hours: Math.round(i.hours * 100) / 100,
      dcs: dcRowCount(i.markdown),
      updates: i.updates,
      useCases: ucRowCount(i.markdown),
      rowIds: [...i.eventIds],
      org62,
      quarters: quartersOf(i.eventIds, rows),
      maybeCreated: state === 'retry' && maybeDelivered(d),
      progress: progress && CREATED.has(state) ? canvasProgressOf({ draftId: d.id, appliedAt, ...counts, org62 }, { dcRequests: progress.dcRequests, useCases: progress.useCases, check: progress.checks?.[d.id], reads: progress.reads, now }) : null,
    });
  }
  return out.sort((a, b) => (b.appliedAt ?? b.createdAt).localeCompare(a.appliedAt ?? a.createdAt) || a.draftId.localeCompare(b.draftId));
}

/** One page of the applied canvases (chat_log_batch `applied`), newest first, with the total and where the next page starts. */
export const APPLIED_PAGE = 10;
export function pageAppliedCanvases(canvases: readonly LogCanvas[], page: { offset?: number; limit?: number } = {}) {
  const all = canvases.filter(isAppliedCanvas);
  const offset = Math.max(0, Math.trunc(page.offset ?? 0));
  const limit = Math.max(1, Math.trunc(page.limit ?? APPLIED_PAGE));
  const next = offset + limit;
  return {
    applied: all.slice(offset, next).map((c) => ({ draftId: c.draftId, title: c.title, state: c.state, created: c.state !== 'applying', url: c.url, appliedAt: c.appliedAt, rows: c.rows, hours: c.hours, dcs: c.dcs, useCases: c.useCases, org62: c.org62 })),
    appliedTotal: all.length,
    appliedNextOffset: next < all.length ? next : null,
  };
}

/** The applied canvases as the Assistant reads them (chat_log_batch `applied`): what was created, its link and its rows; paged to the end by `appliedOffset`. */
export function appliedLogCanvases(drafts: readonly Draft[], activity: readonly CanvasRow[], now: Date, page: { offset?: number; limit?: number } = {}) {
  return pageAppliedCanvases(logCanvasesOf(drafts, activity, now), page);
}
