/**
 * Delivery error classification. Codes and messages are body-free (*tenet: Local data, privacy-safe logs*):
 * they name the failure, never the message, recipients or tool arguments.
 */
import { entryOf } from '@/errors/catalog';
import type { DeliveryError } from './types';

interface Sig {
  code: string;
  re: RegExp;
  retryable: boolean;
  /** The error catalog's code: the message the Outbox shows is its text (src/errors/render.ts, 11 R5). */
  catalog: string;
}

/** Delivery code → catalog code (also the alias table's entries for these codes). */
export const DELIVERY_CATALOG: Readonly<Record<string, string>> = {
  not_sent: 'SEND.NOT_SENT',
  not_confirmed: 'SEND.NOT_CONFIRMED',
  tool_refused: 'SEND.TOOL_REFUSED',
  live_disabled: 'SEND.LIVE_DISABLED',
  auth: 'AUTH.SEND.SIGNED_OUT',
  channel_not_found: 'SEND.CHANNEL_NOT_FOUND',
  not_in_channel: 'SEND.NOT_IN_CHANNEL',
  is_archived: 'SEND.ARCHIVED',
  attached_draft_exists: 'SEND.DRAFT_EXISTS',
  msg_too_long: 'SEND.TOO_LONG',
  not_found: 'SEND.TARGET_GONE',
  rate_limited: 'RATE.SEND',
  invalid_request: 'SEND.REJECTED',
  transient: 'NET.DESTINATION_DOWN',
  failed_to_create_draft: 'SEND.DRAFT_FAILED',
  preflight_failed: 'SEND.PREFLIGHT',
  unknown: 'SEND.UNKNOWN',
};

/** Ordered: first match wins. */
const SIGS: Sig[] = [
  // 2026-11-16: the relay ended before it called the tool (RelayNotSentError): nothing reached the destination, so it is
  // safe to send again (a canvas too: never "check Slack first")
  { code: 'not_sent', re: /RelayNotSentError/, retryable: true, catalog: DELIVERY_CATALOG.not_sent! },
  { code: 'not_confirmed', re: /NotConfirmedError|not_confirmed|no confirm/i, retryable: false, catalog: DELIVERY_CATALOG.not_confirmed! },
  { code: 'tool_refused', re: /OutboxToolRefusedError|VdpToolRefusedError|not on the outbox/i, retryable: false, catalog: DELIVERY_CATALOG.tool_refused! },
  { code: 'live_disabled', re: /OutboxLiveDisabledError|live outbox transport is not enabled/i, retryable: false, catalog: DELIVERY_CATALOG.live_disabled! },
  { code: 'auth', re: /invalid_auth|not_authed|token_revoked|token_expired|needs[- ]auth|requires re-?auth|unauthori[sz]ed|\b401\b|invalid_grant|re-?authenticat/i, retryable: false, catalog: DELIVERY_CATALOG.auth! },
  { code: 'channel_not_found', re: /channel_not_found/i, retryable: false, catalog: DELIVERY_CATALOG.channel_not_found! },
  { code: 'not_in_channel', re: /not_in_channel/i, retryable: false, catalog: DELIVERY_CATALOG.not_in_channel! },
  { code: 'is_archived', re: /is_archived/i, retryable: false, catalog: DELIVERY_CATALOG.is_archived! },
  { code: 'attached_draft_exists', re: /attached_draft_exists/i, retryable: false, catalog: DELIVERY_CATALOG.attached_draft_exists! },
  { code: 'msg_too_long', re: /msg_too_long|too long|5000 chars/i, retryable: false, catalog: DELIVERY_CATALOG.msg_too_long! },
  // D-69 (VD-06): VDP says the record is gone (a company merged into another, an archived VDP): not sent, and not retried
  { code: 'not_found', re: /\b(?:company|vdp|use[ _]case|asset)s?\b.{0,80}\bnot found\b|no active (?:company|industry)/i, retryable: false, catalog: DELIVERY_CATALOG.not_found! },
  { code: 'rate_limited', re: /ratelimited|rate[_ ]limit|rateLimitExceeded|too many requests|\b429\b|quota/i, retryable: true, catalog: DELIVERY_CATALOG.rate_limited! },
  { code: 'invalid_request', re: /invalid_request|invalid_arguments|invalid (?:params|arguments)|validation error|invalid_blocks|invalid to|bad request|\b400\b/i, retryable: false, catalog: DELIVERY_CATALOG.invalid_request! },
  { code: 'transient', re: /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|time(?:d)?[ -]?out|\b5\d\d\b|service unavailable|internal error|overloaded/i, retryable: true, catalog: DELIVERY_CATALOG.transient! },
  { code: 'failed_to_create_draft', re: /failed_to_create_draft/i, retryable: true, catalog: DELIVERY_CATALOG.failed_to_create_draft! },
];

export function classifyDeliveryError(err: unknown): DeliveryError {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  for (const s of SIGS) if (s.re.test(text)) return { code: s.code, message: entryOf(s.catalog).userText, retryable: s.retryable };
  return { code: 'unknown', message: entryOf(DELIVERY_CATALOG.unknown).userText, retryable: true };
}

/**
 * A relayed call (src/llm/one-call.ts) that ended before the tool was called: the destination never saw it. Body-free,
 * like ToolCallError.
 */
export class RelayNotSentError extends Error {
  override name = 'RelayNotSentError';
  constructor(
    readonly tool: string,
    detail: string,
  ) {
    super(`${tool} was not called: ${detail.slice(0, 200)}`);
  }
}

/** A relayed call's failure: not sent when the tool was never called, else the tool's own error (it may have landed). */
export function relayFailure(tool: string, r: { code: string; message: string; called?: boolean }): Error {
  const why = r.code === 'timeout' ? 'timed out' : r.message || r.code;
  return r.called === false && r.code !== 'disallowed_tool' ? new RelayNotSentError(tool, why) : new ToolCallError(tool, why);
}

/** A tool result with the MCP error flag, raised as an error so one classifier handles both paths. */
export class ToolCallError extends Error {
  override name = 'ToolCallError';
  constructor(
    readonly tool: string,
    detail: string,
  ) {
    // Detail comes from the destination's error text: keep it short; it is classified, not stored.
    super(`${tool} returned an error: ${detail.slice(0, 200)}`);
  }
}
