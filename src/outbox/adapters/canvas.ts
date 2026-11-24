/**
 * Slack canvas delivery adapter (approved 2026-11-10, D-47): Apply on a logging batch creates ONE new private canvas
 * holding the Slackbot work order. Slackbot then runs it in Org62 when the user says "Execute this canvas"; the app
 * never writes Org62.
 *
 *   send / draft (Apply) → slack_create_canvas { title, content }    (both modes: the canvas is private either way)
 *   read-back            → slack_read_canvas { canvas_id }: the canvas exists and holds the batch's title
 *
 * The adapter re-derives the call from the payload and refuses it when the arguments differ from the payload's own
 * title and content, or when the work order is too big for one canvas.
 */
import type { DispatchMode } from '@/contract';
import { canvasRowsOf } from '@/lib/canvas/preflight';

import { classifyDeliveryError } from '../errors';
import { canonicalJson } from '../hash';
import { OUTBOX_SERVER } from '../mcp-config';
import type { ReadbackOutcome, ToolCall, ToolResult, WriteOutcome } from '../types';
import type { OutboxAdapter, ReadbackContext, ReadFn } from './index';
import { str } from './text';

const SERVER = OUTBOX_SERVER.slack_canvas;

function toolCall(payload: Record<string, unknown>, _mode: DispatchMode): ToolCall {
  if (str(payload.tool) !== 'slack_create_canvas') throw new Error('invalid_request: a canvas item only creates a canvas');
  if (typeof payload.invalid === 'string') throw new Error(`invalid_request: ${payload.invalid}`);
  const args = payload.args as { title?: unknown; content?: unknown } | undefined;
  const title = str(args?.title);
  const content = typeof args?.content === 'string' ? args.content : null;
  if (!title || !content) throw new Error('invalid_request: a canvas needs a title and content');
  if (title !== str(payload.title)) throw new Error('invalid_request: canvas arguments do not match the item');
  return { server: SERVER, tool: 'slack_create_canvas', args: JSON.parse(canonicalJson({ title, content })) as Record<string, unknown> };
}

const CANVAS_ID = /\b(F[A-Z0-9]{8,})\b/;
const CANVAS_URL = /https:\/\/[^\s"')]+\/docs\/[A-Z0-9]+\/(F[A-Z0-9]{8,})/;

/** The new canvas's id and link, from the tool's JSON or text answer. */
export function parseCanvasWrite(text: string): WriteOutcome {
  let j: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(text) as unknown;
    j = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    j = null;
  }
  const url = (typeof j?.canvas_url === 'string' && j.canvas_url) || (typeof j?.url === 'string' && j.url) || CANVAS_URL.exec(text)?.[0] || null;
  const id = (typeof j?.canvas_id === 'string' && j.canvas_id) || (typeof j?.id === 'string' && CANVAS_ID.test(j.id) ? j.id : null) || (url ? CANVAS_URL.exec(url)?.[1] : null) || CANVAS_ID.exec(text)?.[1] || null;
  return { externalId: id, link: url };
}

function parseWrite(result: ToolResult): WriteOutcome {
  return parseCanvasWrite(result.text);
}

async function readback(read: ReadFn, ctx: ReadbackContext): Promise<ReadbackOutcome> {
  const id = ctx.write.externalId;
  if (!id) return { readback: 'unconfirmed', detail: 'Slack did not return the canvas id, so it could not be read back', matchedExternalId: null };
  let text: string;
  try {
    text = (await read({ server: SERVER, tool: 'slack_read_canvas', args: { canvas_id: id } })).text;
  } catch (err) {
    return { readback: 'unconfirmed', detail: `Read-back failed (${classifyDeliveryError(err).code})`, matchedExternalId: null };
  }
  // the first Event row: in WO-1's EVENTS TO CREATE table its CC# key (no Object cell to look for), in a legacy canvas `|1|Event|`
  const content = String((ctx.payload.args as { content?: string } | undefined)?.content ?? '');
  const firstEvent = canvasRowsOf(content).find((r) => r.kind === 'event');
  const marker = firstEvent ? (firstEvent.table ? (firstEvent.ref ? `CC#${firstEvent.ref}` : firstEvent.text) : '|1|Event|') : null;
  if (/Slackbot: this canvas is a complete work order/.test(text) && (!marker || text.includes(marker))) return { readback: 'confirmed', detail: 'Canvas created ✓ (open it in Slack and tell Slackbot "Execute this canvas")', matchedExternalId: id };
  return { readback: 'unconfirmed', detail: 'Read-back found the canvas but not the work order in it', matchedExternalId: id };
}

export const canvasAdapter: OutboxAdapter = { channel: 'slack_canvas', toolCall, parseWrite, readback };
