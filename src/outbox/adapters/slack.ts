/**
 * Slack delivery adapter (Slack's hosted MCP, server `slack`).
 *
 *   draft → slack_send_message_draft {channel_id, message, thread_ts?}   (Slack "Drafts & Sent")
 *   send  → slack_send_message       {channel_id, message, thread_ts?}
 *
 * The payload is `payloadFor()`'s Slack request (`channel`, `thread_ts?`, `text` in Slack mrkdwn, `blocks?`).
 * The MCP tools take standard markdown, so `text` is mapped mrkdwn → markdown here (bold, strike, links,
 * bullets, entities); code spans and fences pass through. `blocks` are not accepted by the tool; the `text`
 * fallback carries the same content.
 *
 * Read-back: a sent message is read with slack_read_thread (its own ts, or its thread). Slack drafts have no
 * read tool, so a pushed draft reads back as `unconfirmed` with a pointer to Drafts & Sent.
 */
import type { DispatchMode } from '@/contract';

import { classifyDeliveryError } from '../errors';
import { OUTBOX_SERVER, OUTBOX_TOOLS } from '../mcp-config';
import type { ReadbackOutcome, ToolCall, ToolResult, WriteOutcome } from '../types';
import type { OutboxAdapter, ReadbackContext, ReadFn } from './index';
import { containsLead, str } from './text';

const SERVER = OUTBOX_SERVER.slack;

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function convertProse(s: string): string {
  return unescape(
    s
      // links: <url|label> → [label](url), <url> → url (mentions <@U…>, <#C…|name>, <!here> stay)
      .replace(/<((?:https?:\/\/|mailto:)[^|>\s]+)\|([^>]+)>/g, '[$2]($1)')
      .replace(/<((?:https?:\/\/|mailto:)[^|>\s]+)>/g, '$1')
      // *bold* → **bold**, ~strike~ → ~~strike~~ (Slack single delimiters; _italic_ is the same in both)
      .replace(/(^|[\s([{"'_~])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s)\]}.,;:!?"'_~])/gm, '$1**$2**')
      .replace(/(^|[\s([{"'_*])~(?=\S)([^~\n]*?\S)~(?=$|[\s)\]}.,;:!?"'_*])/gm, '$1~~$2~~')
      // bullets: "• item" / nested "◦ item" → markdown list items, indentation kept
      .replace(/^(\s*)[•◦▪‣] /gm, '$1- '),
  );
}

/** Slack mrkdwn (the compose serializer's output) → the standard markdown the Slack MCP tools expect. */
export function mrkdwnToMarkdown(text: string): string {
  // Split out fenced blocks and inline code first; they pass through (entities unescaped only).
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts.map((p, i) => (i % 2 === 1 ? unescape(p) : convertProse(p))).join('');
}

function toolCall(payload: Record<string, unknown>, mode: DispatchMode): ToolCall {
  const channel = str(payload.channel);
  const text = str(payload.text);
  if (!channel) throw new Error('invalid_request: Slack payload has no channel');
  if (text === null) throw new Error('invalid_request: Slack payload has no text');
  const threadTs = str(payload.thread_ts);
  return {
    server: SERVER,
    tool: OUTBOX_TOOLS.slack.write[mode],
    args: { channel_id: channel, message: mrkdwnToMarkdown(text), ...(threadTs ? { thread_ts: threadTs } : {}) },
  };
}

/** ts from `"ts": "…"` / `message_ts: …`, else from a permalink `/archives/C…/p1730812345123456`. */
export function slackTsFrom(text: string): string | null {
  const direct = /(?:"|\b)(?:message_)?ts"?\s*[:=]\s*"?(\d{9,11}\.\d{1,6})/i.exec(text);
  if (direct) return direct[1]!;
  const link = /\/archives\/[A-Z0-9]+\/p(\d{10})(\d{6})/.exec(text);
  return link ? `${link[1]}.${link[2]}` : null;
}

function parseWrite(result: ToolResult, mode: DispatchMode): WriteOutcome {
  const link = /https:\/\/[^\s"')>\]]*slack\.com[^\s"')>\]]*/.exec(result.text)?.[0] ?? null;
  if (mode === 'draft') {
    const draftId = /draft_id"?\s*[:=]\s*"?([A-Za-z0-9_.-]+)/i.exec(result.text)?.[1] ?? null;
    return { externalId: draftId, link };
  }
  return { externalId: slackTsFrom(result.text), link };
}

async function readback(read: ReadFn, ctx: ReadbackContext): Promise<ReadbackOutcome> {
  if (ctx.mode === 'draft') {
    return { readback: 'unconfirmed', detail: 'Slack drafts have no read tool: check Drafts & Sent in Slack', matchedExternalId: ctx.write.externalId };
  }
  const channel = str(ctx.payload.channel)!;
  const threadTs = str(ctx.payload.thread_ts);
  const ts = ctx.write.externalId;
  if (!ts) return { readback: 'unconfirmed', detail: 'Slack did not return the message ts, so it could not be read back', matchedExternalId: null };
  const call: ToolCall = {
    server: SERVER,
    tool: 'slack_read_thread',
    args: threadTs ? { channel_id: channel, message_ts: threadTs, oldest: ts, limit: 20, response_format: 'concise' } : { channel_id: channel, message_ts: ts, limit: 1, response_format: 'concise' },
  };
  let text: string;
  try {
    text = (await read(call)).text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/thread_not_found|message_not_found|not[_ ]found/i.test(msg)) return { readback: 'missing', detail: 'Read-back: the message is not in Slack', matchedExternalId: null };
    return { readback: 'unconfirmed', detail: `Read-back failed (${classifyDeliveryError(err).code})`, matchedExternalId: null };
  }
  const expected = String(ctx.payload.text ?? '');
  if (containsLead(text, expected)) return { readback: 'confirmed', detail: 'Verified in Slack ✓', matchedExternalId: ts };
  if (text.includes(ts)) return { readback: 'unconfirmed', detail: 'Read-back found the message but its text differs', matchedExternalId: ts };
  return { readback: 'missing', detail: 'Read-back: the message is not in Slack', matchedExternalId: null };
}

export const slackAdapter: OutboxAdapter = { channel: 'slack', toolCall, parseWrite, readback };

/**
 * D-98 (09 R5): what an Applied Slack or Gmail item left as, for its landing row (`record_landings` destination `slack`
 * / `gmail`, one `landing_writes` row per delivered attempt). Ids, targets and the mode only: never the message text,
 * the subject or a recipient address (*tenet: Local data, privacy-safe logs*). Pure; the DataSource writes it in the
 * same change set as the delivery record.
 */
export interface MessageLanding {
  destination: 'slack' | 'gmail';
  externalId: string | null;
  values: Record<string, string | null>;
}

/** A delivered Slack post or Slack draft: the channel, the thread it answers, the mode, the tool, the link. */
export function slackLanding(payload: Record<string, unknown>, mode: DispatchMode, write: WriteOutcome): MessageLanding {
  return { destination: 'slack', externalId: write.externalId, values: { channel: str(payload.channel), thread_ts: str(payload.thread_ts), mode, tool: OUTBOX_TOOLS.slack.write[mode], link: write.link } };
}
