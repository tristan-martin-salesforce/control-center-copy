/** Job handler contract for the worker (docs/reference/WORKER.md). Handlers register by `jobs.kind`. */
import type { Db } from '@/db/client';
import type { EnqueueJobInput, EnqueueResult } from '@/db/queue';

/** `jobs.last_error_class` values (error_class enum). */
export type JobErrorClass = 'transient' | 'rate_limited' | 'auth' | 'validation' | 'not_found' | 'budget' | 'bug' | 'unknown';

/** Throw from a handler to choose the retry behaviour explicitly. */
export class JobError extends Error {
  override name = 'JobError';
  constructor(
    message: string,
    readonly errorClass: JobErrorClass,
    readonly opts: { retryAfterSeconds?: number; code?: string } = {},
  ) {
    super(message);
  }
}

/** A claimed `jobs` row, camel-cased. */
export interface JobRow {
  id: number;
  ownerUserId: string;
  kind: string;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  timeoutSeconds: number;
  generation: number | null;
  dedupeKey: string | null;
  correlationId: string | null;
  cancelRequestedAt: string | null;
}

export interface JobContext<S = unknown> {
  job: JobRow;
  /** Aborted on cancel (re-eval superseded, user cancel), timeout, lost lease or shutdown. `signal.reason` says which. */
  signal: AbortSignal;
  db: Db;
  userId: string;
  clock: () => Date;
  log: (msg: string, detail?: Record<string, unknown>) => void;
  /** Extend this job's lease now (long steps call it; the worker also beats every few seconds). */
  heartbeat: () => Promise<void>;
  enqueue: (input: Omit<EnqueueJobInput, 'ownerUserId'>) => Promise<EnqueueResult>;
  services: S;
}

/** The value is stored in `jobs.result` (ids, counts, codes; never source text). */
export type JobHandler<S = unknown> = (ctx: JobContext<S>) => Promise<Record<string, unknown> | void>;

export interface JobHandlerDef<S = unknown> {
  kind: string;
  queue: string;
  /** False for stubs that only log "not yet wired"; their schedules stay disabled. */
  wired: boolean;
  /**
   * The handler can call a model (directly, through a research agent, a relay lookup or a completion model). Such a
   * kind must be in `LLM_JOB_KINDS` (src/llm/spend/day-gate.ts), which prices it for the worker's start gate, and
   * every kind there must be one of these (tests/jobs/job-kinds.test.ts).
   */
  spends?: true;
  description: string;
  handler: JobHandler<S>;
}

export type AbortReason = 'cancel' | 'shutdown' | 'timeout' | 'lease_lost';

export class JobAbort extends Error {
  override name = 'AbortError';
  constructor(readonly reason: AbortReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

export const abortReasonOf = (signal: AbortSignal): AbortReason | undefined =>
  signal.aborted ? (signal.reason instanceof JobAbort ? signal.reason.reason : 'shutdown') : undefined;
