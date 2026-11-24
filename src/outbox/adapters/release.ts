/**
 * Release delivery adapter (D-90, W12-7): the `release` channel's two items.
 *
 *   release.announce      Send → slack_send_message { channel_id, message }   (both modes: an announcement has no Slack
 *                         draft); read-back slack_read_thread, as the feedback post (D-56) does
 *   release.drive_upload  NO tool call, in any mode: the payload is a hand-off (`mode: 'handoff'`), refused here like
 *                         every malformed payload. Its Apply never reaches an adapter: the DataSource marks it handed off.
 *
 * The adapter re-derives the call from the payload and refuses it when it is not an announcement, names no valid channel,
 * carries a thread (an announcement is top-level) or is marked invalid. The live relay (src/outbox/transport.ts) checks
 * the channel again against the configured one, and the confirm proof again.
 */
import type { DispatchMode } from '@/contract';

import { OUTBOX_SERVER, OUTBOX_TOOLS } from '../mcp-config';
import type { ToolCall, ToolResult, WriteOutcome } from '../types';
import type { OutboxAdapter, ReadbackContext, ReadFn } from './index';
import { RELEASE_CHANNEL_ID, releaseHandoffAdapter } from './release-handoff';
import { mrkdwnToMarkdown, slackAdapter } from './slack';
import { str } from './text';

function toolCall(payload: Record<string, unknown>, mode: DispatchMode): ToolCall {
  if (payload.mode === 'handoff') return releaseHandoffAdapter.toolCall(payload, mode);
  if (str(payload.tool) !== 'slack_send_message') throw new Error('invalid_request: a release item only posts one announcement');
  if (typeof payload.invalid === 'string') throw new Error(`invalid_request: ${payload.invalid}`);
  const channel = str(payload.channel);
  const text = str(payload.text);
  if (!channel || !RELEASE_CHANNEL_ID.test(channel)) throw new Error('invalid_request: an announcement needs the configured channel id');
  if (!text?.trim()) throw new Error('invalid_request: the announcement is empty');
  if (payload.thread_ts !== undefined) throw new Error('invalid_request: an announcement is top-level, never a thread reply');
  return { server: OUTBOX_SERVER.release, tool: OUTBOX_TOOLS.release.write.send, args: { channel_id: channel, message: mrkdwnToMarkdown(text) } };
}

function parseWrite(result: ToolResult): WriteOutcome {
  return slackAdapter.parseWrite(result, 'send');
}

function readback(read: ReadFn, ctx: ReadbackContext) {
  return slackAdapter.readback(read, { ...ctx, mode: 'send' });
}

export const releaseAdapter: OutboxAdapter = { channel: 'release', toolCall, parseWrite, readback };
