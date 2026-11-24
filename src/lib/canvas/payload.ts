/**
 * The `slack_canvas.create` action: one logging batch → one new private Slack canvas holding the Slackbot work order
 * (src/engines/activity/slackbot.ts). Pure, shared by both DataSources, the UI and the Outbox adapter.
 *
 *   input   { title, markdown, eventIds, hours, updates, updateIds, part, parts }
 *   payload { tool: 'slack_create_canvas', args: { title, content }, … }   (what the preview, the dry run and Apply use)
 */
import type { ActionDestination, Draft, DraftStatus } from '@/contract';

import { legacyShape } from './tables';

export interface CanvasActionInput {
  title: string;
  markdown: string;
  /** The app's activity rows in this canvas (marked handed off once the canvas exists). */
  eventIds: string[];
  hours: number;
  updates: number;
  /** The Org62 Events whose Duration fix is in this canvas (so a second batch does not repeat them). */
  updateIds?: string[];
  part: number;
  parts: number;
}

/**
 * The most markdown one canvas write carries, in UTF-8 bytes (not characters: an accent or an emoji is 2–4 bytes).
 * Slack's documented limit is 1 MiB (1,048,576 bytes) of markdown per `document_content`
 * (https://docs.slack.dev/surfaces/canvases/); 900,000 leaves a margin for the title and the request around it.
 * Slack also documents 300 cells per table, but a 600-cell table (59 rows × 10 columns) was created and read back
 * complete on 2026-11-13, so tables are never split for it. WO-1 (2026-11-23): one table per object and verb, with
 * fewer columns each (src/lib/canvas/tables.ts: Events to create 9, Deal Contributions to create 6, use cases to create
 * 12, every update table 6, Specialist Forecasts 4), so more rows fit under the documented 300 cells (33 Event rows,
 * 50 DC or update rows, 25 use-case rows) and the bytes per row fall (no Object cell, no empty cells of another type). The old 12,000-character cap came from the autopilot's
 * split size, not from Slack, and split one batch into 8 canvases.
 */
export const CANVAS_MAX_BYTES = 900_000;

/** A string's size in UTF-8 bytes (what Slack's canvas limit counts), without allocating it. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Whether a work order fits one canvas write (`limit` in UTF-8 bytes). */
export const fitsOneCanvas = (markdown: string, limit: number = CANVAS_MAX_BYTES) => utf8Bytes(markdown) <= limit;

/** D-67: Use_Case__c rows in a work order: creates (USE CASES table) and Stage / Go-Live fixes (UPDATE table). */
export function ucRowCount(markdown: string): number {
  return legacyShape(markdown).split('\n').filter((l) => /^\|[^|]*\|Use_Case__c\|/.test(l)).length;
}

export function canvasActionFor(i: CanvasActionInput): ActionDestination {
  const rows = i.eventIds.length;
  const ucs = ucRowCount(i.markdown);
  return {
    kind: 'action',
    action: 'slack_canvas.create',
    target: { label: i.title, url: null },
    input: { ...i },
    changes: [
      { label: 'Org62 Events to create', before: null, after: `${rows} row${rows === 1 ? '' : 's'} · ${i.hours} h` },
      ...(i.updates ? [{ label: 'Duration fixes', before: null, after: `${i.updates}` }] : []),
      ...(ucs ? [{ label: 'VDP use cases (Use_Case__c)', before: null, after: `${ucs} to create or update` }] : []),
      { label: 'Then', before: null, after: 'Open the canvas in Slack and tell Slackbot "Execute this canvas"' },
    ],
    text: i.markdown,
  };
}

export function canvasInputOf(dest: Pick<ActionDestination, 'input'>): CanvasActionInput {
  const i = dest.input as Partial<CanvasActionInput>;
  return {
    title: String(i.title ?? 'Activity log'),
    markdown: String(i.markdown ?? ''),
    eventIds: Array.isArray(i.eventIds) ? i.eventIds.map(String) : [],
    hours: Number(i.hours ?? 0),
    updates: Number(i.updates ?? 0),
    updateIds: Array.isArray(i.updateIds) ? i.updateIds.map(String) : [],
    part: Number(i.part ?? 1),
    parts: Number(i.parts ?? 1),
  };
}

/** The exact request: the canvas title and its markdown, nothing else. */
export function canvasActionPayload(dest: ActionDestination): Record<string, unknown> {
  const i = canvasInputOf(dest);
  return {
    tool: 'slack_create_canvas',
    args: { title: i.title, content: i.markdown },
    title: i.title,
    rows: i.eventIds.length,
    hours: i.hours,
    ...(fitsOneCanvas(i.markdown) ? {} : { invalid: `the work order is ${utf8Bytes(i.markdown)} bytes; one canvas takes at most ${CANVAS_MAX_BYTES}` }),
  };
}

// ---------------------------------------------------------------------------
// Rows held by a canvas item that has not been Applied yet
// ---------------------------------------------------------------------------

/**
 * Canvas items still in the Outbox: waiting for Apply, on their way, or failed and retryable. Their rows stay
 * `approved` until the canvas exists (then `synced_to_canvas`), so these are the rows a new batch must not take
 * again. A rejected or discarded item lets its rows go; a dry run leaves the item ready, so its rows stay held.
 */
export const CANVAS_HOLDING: ReadonlySet<DraftStatus> = new Set<DraftStatus>(['ready', 'scheduled', 'sending', 'failed', 'verify_failed']);

/** Canvas items whose canvas exists: Slackbot has their rows (an unverified read-back still created it). */
export const CANVAS_SENT: ReadonlySet<DraftStatus> = new Set<DraftStatus>(['sent', 'staged', 'verified', 'verify_failed']);

export interface CanvasHolds {
  /** Activity row id → the Outbox canvas item holding it. */
  rows: ReadonlyMap<string, string>;
  /** Org62 Event ids whose Duration fix is already in a held canvas. */
  updates: ReadonlySet<string>;
  /**
   * Activity row id → the canvas item that was sent with it: the row is handed off, so no later batch takes it again,
   * even when its own status did not move (a row whose `status` a user lock held at `approved`).
   */
  sent?: ReadonlyMap<string, string>;
}

export const NO_HOLDS: CanvasHolds = { rows: new Map(), updates: new Set(), sent: new Map() };

/** Which rows and Duration fixes the pending canvas items hold (newest item wins a row, which never happens twice), and which rows a sent one handed off. */
export function canvasHolds(drafts: ReadonlyArray<Pick<Draft, 'id' | 'status' | 'destination'>>): CanvasHolds {
  const rows = new Map<string, string>();
  const updates = new Set<string>();
  const sent = new Map<string, string>();
  for (const d of drafts) {
    if (d.destination.kind !== 'action' || d.destination.action !== 'slack_canvas.create') continue;
    const i = canvasInputOf(d.destination);
    if (CANVAS_SENT.has(d.status)) for (const id of i.eventIds) sent.set(id, d.id);
    if (!CANVAS_HOLDING.has(d.status)) continue;
    for (const id of i.eventIds) rows.set(id, d.id);
    for (const id of i.updateIds ?? []) updates.add(id);
  }
  return { rows, updates, sent };
}

// ---------------------------------------------------------------------------
// The canvas's link
// ---------------------------------------------------------------------------

/** `https://<workspace>.slack.com/docs/<team id>/` of a canvas link the app knows (the canvas id cut off). */
const CANVAS_BASE = /^(https:\/\/[^/\s]+\/docs\/[A-Z0-9]+\/)F[A-Z0-9]{6,}/;

/**
 * A canvas's link when Slack returned only its file id: the same workspace and team as a canvas link the app already
 * knows (another canvas's, or Settings ▸ Time ▸ Work-order canvas link). Null without such a link or a canvas id.
 */
export function canvasUrlFor(canvasId: string | null | undefined, known: ReadonlyArray<string | null | undefined>): string | null {
  if (!canvasId || !/^F[A-Z0-9]{6,}$/.test(canvasId)) return null;
  for (const u of known) {
    const m = u ? CANVAS_BASE.exec(u.trim()) : null;
    if (m) return `${m[1]}${canvasId}`;
  }
  return null;
}

/**
 * 2026-11-13 audit B3: an item whose last live Apply may have landed (no answer in time, or the app stopped mid-way):
 * failed, with its last live attempt `unconfirmed`. Check the destination before you Apply again.
 */
export function maybeDelivered(d: Pick<Draft, 'status' | 'attempts'>): boolean {
  if (d.status !== 'failed') return false;
  const last = [...d.attempts].reverse().find((a) => !a.dryRun);
  return last?.outcome === 'unconfirmed';
}

/** The Time rows with `canvasDraftId` set on the ones a pending canvas item holds (others unchanged). */
export function markCanvasHolds<T extends { id: string; canvasDraftId?: string | undefined }>(entries: readonly T[], holds: CanvasHolds): T[] {
  if (!holds.rows.size) return [...entries];
  return entries.map((e) => {
    const d = holds.rows.get(e.id);
    return d ? { ...e, canvasDraftId: d } : e;
  });
}
