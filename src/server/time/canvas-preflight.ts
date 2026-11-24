/**
 * D-65: the logging canvas's preflight, as both DataSources apply it (src/lib/canvas/preflight.ts holds the checks).
 *
 *   at Apply (dispatchDraft)   the canvas is re-checked: when a row must not go, the item is re-rendered without it and
 *                              Apply is refused ("review it and Apply again": what you approve is what goes); with
 *                              nothing left, the item is discarded and Apply refused (TL-06, TL-24)
 *   on an edit (patchActivity) a row a canvas item holds is unstaged from it (TL-25: an edit unstages a held row)
 *   the daily sweep            an item with nothing left, or never applied for 14 days, expires with a notice (TL-24)
 *
 * Pure: the callers persist the drafts this returns.
 */
import type { ActionDestination, Draft } from '@/contract';
import { adminSurfaceOf } from '@/contract';
import { actionDoc, actionSummary } from '@/lib/actions';
import { canvasActionFor, canvasInputOf, type CanvasActionInput } from '@/lib/canvas/payload';
import { preflightCanvas, preflightSummary, registerCanvasRowCheck, type CanvasPreflight, type CanvasPreflightContext, type CanvasRowCheck, type PreflightUseCase } from '@/lib/canvas/preflight';
import type { UseCaseItem } from '@/engines/activity/use-cases';
import { dcCanvasRows, dcRowStillNeeded, type DcLiveState } from '@/server/deals/dc-requests';
import { renderAll } from '@/server/datasource/mock/render';

// ---------------------------------------------------------------------------
// D-68's Deal Contribution rows (DC-05), in the same registry: an ADD whose DC landed in Org62 (any split) or whose
// request is no longer in flight drops out; an UPDATE whose DC is gone or already has the value drops out; one
// written against a split Org62 no longer shows is refused (`conflict`): never an overwrite.
// ---------------------------------------------------------------------------

const dcRowCheck: CanvasRowCheck = (r, ctx) => {
  const live = ctx.dcLive as DcLiveState | undefined;
  if (!live) return null;
  // the row in the legacy cell layout (canvasRowsOf gives every table that one, WO-1)
  const [row] = dcCanvasRows(`${r.section === 'update' ? '# UPDATE' : '# ADD'}\n|${r.cells.join('|')}|`);
  if (!row) return null;
  const v = dcRowStillNeeded(row, live);
  return v.keep ? null : v.conflict ? `refused, Org62 holds another value: ${v.reason}` : v.reason;
};
registerCanvasRowCheck('dc', dcRowCheck);
registerCanvasRowCheck('update:Deal_Contribution__c', dcRowCheck);

/** D-67: the use-case plan's items as the preflight reads them (by VDP use case id, and by Use_Case__c id). */
export function preflightUseCases(items: ReadonlyArray<Pick<UseCaseItem, 'vdpUseCaseId' | 'org62UseCaseId' | 'state' | 'updates'>>): Pick<CanvasPreflightContext, 'useCase' | 'useCaseRecord'> {
  const of = (i: Pick<UseCaseItem, 'state' | 'updates'>): PreflightUseCase => ({ state: i.state, fields: i.updates.map((u) => u.field) });
  const byUc = new Map(items.filter((i) => i.vdpUseCaseId).map((i) => [i.vdpUseCaseId!, of(i)] as const));
  const byRec = new Map(items.filter((i) => i.org62UseCaseId).map((i) => [i.org62UseCaseId!.slice(0, 15), of(i)] as const));
  return { useCase: (id: string) => byUc.get(id) ?? null, useCaseRecord: (id: string) => byRec.get(id.slice(0, 15)) ?? null };
}

/** Pending logging canvas items (not applied, not on their way): the ones a preflight may re-render or expire. */
export const PREFLIGHT_STATUSES: ReadonlySet<Draft['status']> = new Set(['ready', 'failed']);

/** A logging canvas item still waiting for Apply. */
export const isPendingLogCanvas = (d: Pick<Draft, 'destination' | 'status'>): boolean => adminSurfaceOf(d) === 'log' && PREFLIGHT_STATUSES.has(d.status);

/** The rejected reason of an item the preflight emptied, or the sweep expired. */
export const NOTHING_LEFT_PREFIX = 'Nothing left to log';
export const EXPIRED_CANVAS_REASON = 'Expired: staged 14+ days ago and never applied; its rows go on the next batch';
export const CANVAS_EXPIRY_DAYS = 14;

/** The item as it may go now: the new work order, its doc and rendering (the user previews this, then Applies). */
export function restagedCanvas(d: Draft, input: CanvasActionInput): Draft {
  const fresh = canvasActionFor(input);
  const prev = d.destination as ActionDestination;
  const dest: ActionDestination = { ...prev, target: { ...prev.target, label: input.title }, input: { ...prev.input, ...input }, changes: fresh.changes, text: input.markdown };
  const doc = actionDoc(dest);
  return { ...d, destination: dest, doc, plainText: actionSummary(dest), rendered: renderAll(dest, doc) };
}

/** An item with nothing left (or expired): discarded, so its rows (if any) are free for the next batch. */
export const discardedCanvas = (d: Draft, reason: string): Draft => ({ ...d, status: 'discarded', rejectedReason: reason.slice(0, 300) });

export interface PreflightOutcome {
  result: CanvasPreflight;
  /** The draft to store (re-rendered or discarded); null when nothing changed. */
  next: Draft | null;
  /** The refusal / notice sentence. */
  message: string | null;
}

/** Run the preflight on one pending logging canvas item. */
export function preflightDraft(d: Draft, ctx: CanvasPreflightContext): PreflightOutcome {
  if (d.destination.kind !== 'action') return { result: { changed: false, empty: false, dropped: [], input: canvasInputOf({ input: {} }) }, next: null, message: null };
  const result = preflightCanvas(canvasInputOf(d.destination), ctx);
  if (!result.changed) return { result, next: null, message: null };
  const why = preflightSummary(result);
  if (result.empty) return { result, next: discardedCanvas(d, `${NOTHING_LEFT_PREFIX}: ${why}`), message: `${NOTHING_LEFT_PREFIX} on this canvas: ${why}. The canvas item was discarded; nothing was sent.` };
  return { result, next: restagedCanvas(d, result.input), message: `The canvas changed since you staged it: ${why}. Review it and Apply again; nothing was sent.` };
}
