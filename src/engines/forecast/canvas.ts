/**
 * The Specialist Forecast work order: ONE Slackbot canvas of UPDATE rows on `SpecialistForecast__c` (Id,
 * ForecastNotes__c, Deal_Role__c), in the format of the activity work order (src/engines/activity/slackbot.ts) that
 * Slackbot already runs. Pure: the owner's Org62 user id comes in as input, never a constant in the repo.
 *
 * It rides on the existing `slack_canvas.create` Outbox action. Each field change is keyed `<record Id>:<field>` in
 * the input's `updateIds`, so `canvasHolds` (src/lib/canvas/payload.ts) holds it while the item waits for Apply and a
 * second "Stage N notes" never stages it again; `eventIds` stays empty (no activity rows ride on it). The exact
 * values sit in `input.forecast`, which the next sync compares with Org62 (landed / didn't land).
 */
import type { ActionDestination, Draft } from '@/contract';
import { cell, workOrderCallout } from '@/engines/activity/slackbot';
import { upsertTable } from '@/lib/canvas/tables';
import { CANVAS_HOLDING, CANVAS_MAX_BYTES, fitsOneCanvas } from '@/lib/canvas/payload';

export const FORECAST_CANVAS_KIND = 'specialist_forecast';
export const NOTES_FIELD = 'ForecastNotes__c';
export const ROLE_FIELD = 'Deal_Role__c';
export type ForecastField = typeof NOTES_FIELD | typeof ROLE_FIELD;

/** One field change on one record (what the canvas row carries and the read-back checks). */
export interface ForecastCanvasUpdate {
  /** The app's row id. */
  recordId: string;
  /** SpecialistForecast__c.Id */
  org62Id: string;
  field: ForecastField;
  value: string;
}

/** One canvas row: a record with its new note and / or Deal Role. */
export interface ForecastWorkOrderRow {
  recordId: string;
  org62Id: string;
  notes: string | null;
  dealRole: string | null;
}

export interface ForecastWorkOrderInput {
  ownerName: string;
  ownerOrg62Id: string;
  generatedAt: string;
  sourceLabel: string;
  rows: ForecastWorkOrderRow[];
}

export const updateKey = (org62Id: string, field: ForecastField) => `${org62Id}:${field}`;

/** A note as one canvas cell: line breaks become ` ⏎ ` (Slackbot turns them back), pipes become slashes. */
export function noteCell(text: string): string {
  return cell(text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n'));
}


/** The SPECIALIST FORECASTS TO UPDATE paragraph (WO-1: one table per object and verb, its rule under its heading). */
export function forecastUpdateRule(owner: string): string {
  return `**SPECIALIST FORECASTS TO UPDATE:** each row changes an existing SpecialistForecast__c: on the record whose Id is in Record Id, set ${NOTES_FIELD} and ${ROLE_FIELD} to the values in their columns. A cell with "—" means leave that field as it is. ${NOTES_FIELD} replaces the whole field with the cell's text, exactly as written; " ⏎ " in a cell is a line break. ${ROLE_FIELD} is a picklist value (Lead, Assist, Aware, Portfolio, Accelerate, Incremental or Originate). Only these two fields, only these records: never create or delete a record, and never change another field. Skip a row whose record OwnerId is not \`${owner}\` and report it.`;
}

export function renderForecastWorkOrder(i: ForecastWorkOrderInput): string {
  const { ownerName: who, ownerOrg62Id: owner } = i;
  const out: string[] = [...workOrderCallout(who, owner, 'updated / skipped / failed (with the error for each failure)')];
  out.push('');
  out.push(`_Generated ${i.generatedAt.slice(0, 16).replace('T', ' ')} UTC by ${cell(i.sourceLabel)}. Command Center reads these records again afterwards and flags any change that didn't land._`);
  const rows = i.rows.map((r, n) => [String(n + 1), 'SpecialistForecast__c', cell(r.org62Id), r.notes ? noteCell(r.notes) : '—', r.dealRole ? cell(r.dealRole) : '—']);
  return upsertTable(out.join('\n'), 'forecasts_update', forecastUpdateRule(owner), rows);
}

/**
 * The rows that fit ONE canvas (in order; `limit` in UTF-8 bytes, Slack's 1 MiB with a margin: CANVAS_MAX_BYTES); the
 * rest wait for the next one. Everything fits in practice: only past Slack's own limit does a row wait.
 */
export function packForecastRows(base: Omit<ForecastWorkOrderInput, 'rows'>, rows: ForecastWorkOrderRow[], limit = CANVAS_MAX_BYTES): { take: ForecastWorkOrderRow[]; deferred: ForecastWorkOrderRow[] } {
  if (fitsOneCanvas(renderForecastWorkOrder({ ...base, rows }), limit)) return { take: [...rows], deferred: [] };
  // in order: the longest prefix that fits (a binary search); it and everything after it wait for the next canvas
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fitsOneCanvas(renderForecastWorkOrder({ ...base, rows: rows.slice(0, mid) }), limit)) lo = mid;
    else hi = mid - 1;
  }
  return { take: rows.slice(0, lo), deferred: rows.slice(lo) };
}

/** The field changes a set of rows carries. */
export function updatesOfRows(rows: ForecastWorkOrderRow[], recordIdOf: (r: ForecastWorkOrderRow) => string = (r) => r.recordId): ForecastCanvasUpdate[] {
  const out: ForecastCanvasUpdate[] = [];
  for (const r of rows) {
    if (r.notes) out.push({ recordId: recordIdOf(r), org62Id: r.org62Id, field: NOTES_FIELD, value: r.notes });
    if (r.dealRole) out.push({ recordId: recordIdOf(r), org62Id: r.org62Id, field: ROLE_FIELD, value: r.dealRole });
  }
  return out;
}

/** The Outbox item's destination: a new private canvas holding the work order (the `slack_canvas.create` action). */
export function forecastCanvasActionFor(i: { title: string; markdown: string; rows: ForecastWorkOrderRow[] }): ActionDestination {
  const updates = updatesOfRows(i.rows);
  const notes = updates.filter((u) => u.field === NOTES_FIELD).length;
  const roles = updates.length - notes;
  return {
    kind: 'action',
    action: 'slack_canvas.create',
    target: { label: i.title, url: null },
    input: {
      title: i.title,
      markdown: i.markdown,
      eventIds: [],
      hours: 0,
      updates: updates.length,
      updateIds: updates.map((u) => updateKey(u.org62Id, u.field)),
      part: 1,
      parts: 1,
      forecast: { kind: FORECAST_CANVAS_KIND, updates },
    },
    changes: [
      ...(notes ? [{ label: 'Forecast notes to update', before: null, after: `${notes} Specialist Forecast${notes === 1 ? '' : 's'}` }] : []),
      ...(roles ? [{ label: 'Deal Roles to set', before: null, after: `${roles}` }] : []),
      { label: 'Then', before: null, after: 'Open the canvas in Slack and tell Slackbot "Execute this canvas"' },
    ],
    text: i.markdown,
  };
}

/** The forecast updates an Outbox item carries (null: not a forecast canvas). */
export function forecastUpdatesOf(d: Pick<Draft, 'destination'>): ForecastCanvasUpdate[] | null {
  if (d.destination.kind !== 'action' || d.destination.action !== 'slack_canvas.create') return null;
  const f = (d.destination.input as { forecast?: { kind?: unknown; updates?: unknown } }).forecast;
  if (!f || f.kind !== FORECAST_CANVAS_KIND || !Array.isArray(f.updates)) return null;
  return (f.updates as Array<Record<string, unknown>>)
    .filter((u) => typeof u.org62Id === 'string' && (u.field === NOTES_FIELD || u.field === ROLE_FIELD) && typeof u.value === 'string')
    .map((u) => ({ recordId: String(u.recordId ?? ''), org62Id: u.org62Id as string, field: u.field as ForecastField, value: u.value as string }));
}

export const isForecastCanvas = (d: Pick<Draft, 'destination'>): boolean => forecastUpdatesOf(d) !== null;

/** When a canvas item was delivered (its latest live `sent` attempt), else its last update. */
export function deliveredAt(d: Pick<Draft, 'attempts' | 'updatedAt'>): string {
  const sent = [...d.attempts].reverse().find((a) => a.outcome === 'sent' && !a.dryRun);
  return sent?.at ?? d.updatedAt;
}

export interface CanvasMark {
  draftId: string;
  /** held = waiting for Apply (or failed, retryable) · sent = the canvas exists, handed to Slackbot */
  kind: 'held' | 'sent';
  /** Delivery time (sent), or the item's creation (held). */
  at: string;
  value: string;
}

const SENT = new Set(['sent', 'verified', 'staged']);

/**
 * Per `<record Id>:<field>`: the canvas item that holds it (wins), else the newest one that handed it off. Items that
 * were rejected or discarded let their updates go.
 */
export function forecastCanvasIndex(drafts: ReadonlyArray<Pick<Draft, 'id' | 'status' | 'destination' | 'attempts' | 'updatedAt' | 'createdAt'>>): Map<string, CanvasMark> {
  const out = new Map<string, CanvasMark>();
  for (const d of drafts) {
    const ups = forecastUpdatesOf(d);
    if (!ups) continue;
    const held = CANVAS_HOLDING.has(d.status);
    if (!held && !SENT.has(d.status)) continue;
    const mark: Omit<CanvasMark, 'value'> = held ? { draftId: d.id, kind: 'held', at: d.createdAt } : { draftId: d.id, kind: 'sent', at: deliveredAt(d) };
    for (const u of ups) {
      const k = updateKey(u.org62Id, u.field);
      const cur = out.get(k);
      if (cur && (cur.kind === 'held' || (!held && cur.at >= mark.at))) continue;
      out.set(k, { ...mark, value: u.value });
    }
  }
  return out;
}
