/**
 * Gmail delivery adapter (devbar's mcp-adaptor, server `mcp-adaptor`).
 *
 *   draft → draft_gmail_message {to?, cc?, subject, body: html, body_format: 'html', thread_id?, in_reply_to?, references?, include_signature: false}
 *   send  → send_gmail_message  {to,  cc?, subject, body: html, body_format: 'html', thread_id?, in_reply_to?, references?}
 *
 * The payload is `payloadFor()`'s email request (`to[]`, `cc[]`, `subject`, `threadId?`, `inReplyTo?`, `html`,
 * `text`). The body is the compose HTML unchanged, so what was previewed is what is sent; the Gmail signature
 * is not appended to drafts for the same reason.
 *
 * Read-back: a sent message is read by id (get_gmail_message_content); a draft is found with an
 * `in:drafts subject:"…"` search, then read by id.
 */
import type { DispatchMode } from '@/contract';

import { classifyDeliveryError } from '../errors';
import { OUTBOX_SERVER, OUTBOX_TOOLS } from '../mcp-config';
import type { ReadbackOutcome, ToolCall, ToolResult, WriteOutcome } from '../types';
import type { OutboxAdapter, ReadbackContext, ReadFn } from './index';
import type { MessageLanding } from './slack';
import { containsLead, str, strList } from './text';

const SERVER = OUTBOX_SERVER.gmail;

function toolCall(payload: Record<string, unknown>, mode: DispatchMode): ToolCall {
  const to = strList(payload.to);
  const cc = strList(payload.cc);
  const subject = str(payload.subject) ?? '';
  const html = str(payload.html);
  if (html === null) throw new Error('invalid_request: email payload has no html body');
  if (mode === 'send' && !to.length) throw new Error('invalid_request: email payload has no recipient');
  const threadId = str(payload.threadId);
  const inReplyTo = str(payload.inReplyTo);
  const args: Record<string, unknown> = {
    ...(to.length ? { to: to.join(', ') } : {}),
    ...(cc.length ? { cc: cc.join(', ') } : {}),
    subject,
    body: html,
    body_format: 'html',
    ...(threadId ? { thread_id: threadId } : {}),
    ...(inReplyTo ? { in_reply_to: inReplyTo, references: inReplyTo } : {}),
    ...(mode === 'draft' ? { include_signature: false } : {}),
  };
  return { server: SERVER, tool: OUTBOX_TOOLS.gmail.write[mode], args };
}

const idAfter = (label: string, text: string) => new RegExp(`${label}\\s*id\\s*[:=]?\\s*"?([A-Za-z0-9_-]{4,})`, 'i').exec(text)?.[1] ?? null;

function parseWrite(result: ToolResult, mode: DispatchMode): WriteOutcome {
  const link = /https:\/\/mail\.google\.com\/[^\s"')>\]]+/.exec(result.text)?.[0] ?? null;
  return { externalId: mode === 'draft' ? (idAfter('draft', result.text) ?? idAfter('message', result.text)) : idAfter('message', result.text), link };
}

function matches(text: string, payload: Record<string, unknown>): boolean {
  const subject = str(payload.subject);
  const subjectOk = !subject || text.toLowerCase().includes(subject.toLowerCase());
  return subjectOk && containsLead(text, String(payload.text ?? ''));
}

async function readMessage(read: ReadFn, id: string): Promise<{ text: string } | { missing: true } | { error: string }> {
  try {
    return { text: (await read({ server: SERVER, tool: 'get_gmail_message_content', args: { message_id: id } })).text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not[_ ]?found|\b404\b|requested entity was not found/i.test(msg)) return { missing: true };
    return { error: classifyDeliveryError(err).code };
  }
}

async function readback(read: ReadFn, ctx: ReadbackContext): Promise<ReadbackOutcome> {
  if (ctx.mode === 'send') {
    const id = ctx.write.externalId;
    if (!id) return { readback: 'unconfirmed', detail: 'Gmail did not return the message id, so it could not be read back', matchedExternalId: null };
    const r = await readMessage(read, id);
    if ('missing' in r) return { readback: 'missing', detail: 'Read-back: the message is not in Gmail', matchedExternalId: null };
    if ('error' in r) return { readback: 'unconfirmed', detail: `Read-back failed (${r.error})`, matchedExternalId: null };
    return matches(r.text, ctx.payload)
      ? { readback: 'confirmed', detail: 'Verified in Gmail ✓', matchedExternalId: id }
      : { readback: 'unconfirmed', detail: 'Read-back found the message but its text differs', matchedExternalId: id };
  }
  const subject = (str(ctx.payload.subject) ?? '').replace(/["\\]/g, ' ').trim();
  let found: string[];
  try {
    const res = await read({ server: SERVER, tool: 'search_gmail_messages', args: { query: subject ? `in:drafts subject:"${subject}"` : 'in:drafts', page_size: 5 } });
    found = [...res.text.matchAll(/message\s*id\s*[:=]?\s*"?([A-Za-z0-9_-]{4,})/gi)].map((m) => m[1]!);
  } catch (err) {
    return { readback: 'unconfirmed', detail: `Read-back failed (${classifyDeliveryError(err).code})`, matchedExternalId: null };
  }
  if (!found.length) return { readback: 'missing', detail: 'Read-back: the draft is not in Gmail Drafts', matchedExternalId: null };
  for (const id of found) {
    const r = await readMessage(read, id);
    if ('text' in r && matches(r.text, ctx.payload)) return { readback: 'confirmed', detail: 'Verified in Gmail Drafts ✓', matchedExternalId: id };
  }
  return { readback: 'unconfirmed', detail: 'Read-back found a draft with this subject but its text differs', matchedExternalId: null };
}

export const gmailAdapter: OutboxAdapter = { channel: 'gmail', toolCall, parseWrite, readback };

/** D-98 (09 R5): a delivered Gmail message or draft for its landing row: the thread, how many recipients, the mode, the tool, the link (never the subject, body or an address). */
export function gmailLanding(payload: Record<string, unknown>, mode: DispatchMode, write: WriteOutcome): MessageLanding {
  const recipients = strList(payload.to).length + strList(payload.cc).length;
  return { destination: 'gmail', externalId: write.externalId, values: { thread_id: str(payload.threadId), recipients: String(recipients), mode, tool: OUTBOX_TOOLS.gmail.write[mode], link: write.link } };
}
