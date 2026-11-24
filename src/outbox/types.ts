/**
 * Outbox delivery types (BE-OUTBOX). A delivery is one confirmed attempt to put a draft into Slack or Gmail,
 * either as a native draft (`draft`) or as a real post/send (`send`), or to apply one VDP change (`send` only). Dry-run (the default) records the exact
 * payload and tool call it would make and touches nothing external (*tenet: Nothing leaves without approval*).
 */
import type { DispatchMode } from '@/contract';

/** Outbound channels with a delivery adapter. Contract destination `email` maps to `gmail`, `vdp` to `vdp`. */
export type OutboxChannel = 'slack' | 'gmail' | 'vdp' | 'slack_canvas' | 'feedback' | 'release';

/**
 * Read-back after a real action:
 * - confirmed: the read tool found the posted message / draft and its text matches;
 * - unconfirmed: it could not be checked (no read tool for this kind, the read failed, or the text differs);
 * - missing: the read succeeded and the message / draft is not there.
 */
export type Readback = 'confirmed' | 'unconfirmed' | 'missing';

/**
 * countdown → delivering → delivered (readback set after the read tool runs)
 *     │            └──────→ failed (retryable or not)
 *     └─ cancel() → cancelled          dry run → dry_run_delivered (nothing external touched)
 */
export type DeliveryState = 'countdown' | 'delivering' | 'delivered' | 'dry_run_delivered' | 'cancelled' | 'failed';

/** One MCP tool call: the exact request the adapter makes (or, in dry-run, would make). */
export interface ToolCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

/** What a transport returns: the tool's text content plus the MCP error flag. */
export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface DeliveryError {
  /** Short, body-free signature: channel_not_found, rate_limited, transport, not_confirmed, … */
  code: string;
  message: string;
  retryable: boolean;
}

export interface WriteOutcome {
  /** Slack message ts / Gmail message or draft id, parsed from the tool result. */
  externalId: string | null;
  /** Permalink or channel link when the tool returns one. */
  link: string | null;
  /**
   * What the tool said instead of doing it, when it refused politely (D-60: `create_company` found a likely duplicate
   * and created nothing). Read-back then reports the item as not done, so it returns to you with this line.
   */
  note?: string | null;
  /** D-69 (VD-05): VDP refused a duplicate create and returned the one existing record: its id, nothing created. */
  reused?: boolean;
  /** D-69 (VD-12): what the destination warned about while it saved (create_vdp: an opp on another VDP, an account id). */
  warnings?: string[];
}

export interface ReadbackOutcome {
  readback: Readback;
  detail: string;
  matchedExternalId: string | null;
}

/** The audit record of one delivery attempt (persisted by the DataSource in a change set). */
export interface DeliveryRecord {
  id: string;
  draftId: string;
  /** Draft version the user confirmed. */
  draftVersion: number;
  attemptNo: number;
  channel: OutboxChannel;
  mode: DispatchMode;
  dryRun: boolean;
  /** `payloadFor()` output: the transport fields plus the compose payload, byte-identical to the preview. */
  payload: Record<string, unknown>;
  /** sha256 over the canonical payload JSON. */
  payloadHash: string;
  /** The tool call derived from the payload (made, or in dry-run only recorded). */
  toolCall: ToolCall;
  /** Stable per draft + attempt, so a retried job can never double-send. */
  idempotencyKey: string;
  state: DeliveryState;
  result: WriteOutcome | null;
  error: DeliveryError | null;
  readback: Readback | null;
  readbackDetail: string | null;
  /** Who confirmed and when: the explicit Outbox confirm, or VDP autopilot's autonomy policy (D-60). */
  confirmedBy: 'user' | 'autopilot';
  confirmedAt: string;
  /** When the countdown ends (= confirmedAt when there is no server-side hold). */
  deliverAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  readbackAt: string | null;
  cancelledAt: string | null;
}

export const isFinal = (s: DeliveryState) => s === 'delivered' || s === 'dry_run_delivered' || s === 'cancelled' || s === 'failed';
