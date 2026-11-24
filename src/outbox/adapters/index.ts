/**
 * Delivery adapters, one per channel. An adapter is pure mapping plus read-back logic:
 * - `toolCall(payload, mode)`: the exact MCP call for a `payloadFor()` payload (deterministic);
 * - `parseWrite(result, mode)`: the external id / link from the write tool's text result;
 * - `readback(read, ctx)`: verify through read tools only (it gets a read function, never the gateway's write).
 * Adapters never call a transport themselves; the gateway does, behind the allowlist and the confirm proof.
 */
import type { DispatchMode } from '@/contract';

import type { OutboxChannel, ReadbackOutcome, ToolCall, ToolResult, WriteOutcome } from '../types';
import { canvasAdapter } from './canvas';
import { feedbackAdapter } from './feedback';
import { gmailAdapter } from './gmail';
import { releaseAdapter } from './release';
import { slackAdapter } from './slack';
import { vdpAdapter } from './vdp';

export type ReadFn = (call: ToolCall) => Promise<ToolResult>;

export interface ReadbackContext {
  payload: Record<string, unknown>;
  mode: DispatchMode;
  write: WriteOutcome;
}

/** D-69 (VD-21): the live check right before a write: go, or refuse (nothing is sent) with why. */
export type PreflightOutcome = { ok: true } | { ok: false; code: string; detail: string; retryable?: boolean };

export interface OutboxAdapter {
  channel: OutboxChannel;
  /**
   * D-69 (VD-21, VDP): read the destination right before a live write and refuse when it no longer matches what the
   * item was built from (a person changed it), or already holds what it would set. Read tools only; never in a dry run.
   */
  preflight?(read: ReadFn, ctx: { payload: Record<string, unknown>; mode: DispatchMode }): Promise<PreflightOutcome>;
  toolCall(payload: Record<string, unknown>, mode: DispatchMode): ToolCall;
  /**
   * The call a DRY RUN records (D-63, VDP only): like `toolCall`, but a payload that waits for a parent's new id is
   * recorded with its placeholder instead of refused. Never used for a live write: the gateway derives that with
   * `toolCall`, which refuses it.
   */
  dryRunCall?(payload: Record<string, unknown>, mode: DispatchMode): ToolCall;
  parseWrite(result: ToolResult, mode: DispatchMode): WriteOutcome;
  readback(read: ReadFn, ctx: ReadbackContext): Promise<ReadbackOutcome>;
}

const ADAPTERS: Record<OutboxChannel, OutboxAdapter> = { slack: slackAdapter, gmail: gmailAdapter, vdp: vdpAdapter, slack_canvas: canvasAdapter, feedback: feedbackAdapter, release: releaseAdapter };

export function adapterFor(channel: OutboxChannel): OutboxAdapter {
  return ADAPTERS[channel];
}

export { slackAdapter, gmailAdapter, vdpAdapter };
export { mrkdwnToMarkdown } from './slack';
