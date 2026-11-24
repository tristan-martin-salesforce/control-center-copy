/**
 * Read-in state (pure): one record per entity, derived from the last finished read-in (stored) and the newest job.
 *
 *   newest job queued                  → queued      (older content stays visible underneath)
 *   newest job running                 → researching (progress from the job's tool calls)
 *   newest job skipped (budget, off)   → the stored content with `error`, else failed
 *   newest job dead                    → failed (or the stored content with `error`)
 *   stored ready, entity moved on      → stale       ("2 new messages since 09:40")
 *   stored ready                       → ready
 */
import type { ReadIn, ReadInEntity, ReadInError, ReadInProgress, ReadInTrigger } from '@/contract';

export const READIN_KIND = 'readin.generate';
export const READIN_QUEUE = 'readin';
export const readinKey = (e: ReadInEntity) => `readin/${e.type}/${e.id}`;
export const readinDedupeKey = (e: ReadInEntity) => `readin:${e.type}:${e.id}`;
export const PLAN_STEPS = 6;

/** The kv value at `readin/<type>/<id>`: the last finished read-in. */
export interface StoredReadIn {
  v: 1;
  outcome: 'ready' | 'failed';
  readIn: ReadIn;
  jobId: number | null;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead' | 'cancelled';

export interface ReadInJobSnap {
  id: number;
  status: JobStatus;
  generation: number | null;
  trigger: ReadInTrigger;
  progress: ReadInProgress | null;
  cancelRequested: boolean;
  skipped: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
}

export interface EntityFreshness {
  generation: number;
  /** Newest evidence time on the entity (work_items.last_new_info_at; for meetings, the linked items'). */
  lastNewInfoAt: string | null;
  /** Evidence rows newer than the shown read-in, for the stale reason. */
  newSince?: number;
}

const SKIP_MESSAGE: Record<string, string> = {
  budget: "Today's read-in budget is spent. Read me in to run it anyway.",
  hard_cap: 'The daily LLM hard cap is reached; read-ins resume tomorrow.',
  disabled: 'Read-ins are off in this worker (CC_READIN=0).',
  gone: 'This item no longer exists.',
  // F-4: the read-in passed its spend estimate and asked (Health ▸ Spend)
  paused_for_spend: 'Paused at its spend estimate: allow more in Health ▸ Spend to finish it.',
  spend_ask_open: 'Waiting for your answer in Health ▸ Spend to finish it.',
  spend_stopped: 'Stopped from a spend ask. Read me in to run it again.',
};

const ERROR_MESSAGE: Record<string, string> = {
  disallowed_tool: 'Stopped: the research tried a tool outside the read-only allowlist.',
  needs_auth: 'A source needs re-auth (see Health). Refresh after reconnecting.',
  auth: 'A source needs re-auth (see Health). Refresh after reconnecting.',
  cost_cap: 'Stopped at the per-read-in cost cap.',
  max_turns: 'Ran out of research turns before finishing.',
  timeout: 'Research timed out.',
  invalid_output: 'The research did not produce a usable read-in.',
};

export function errorFor(code: string | null | undefined, fallback?: string): ReadInError {
  const c = code || 'unknown';
  return { code: c, message: SKIP_MESSAGE[c] ?? ERROR_MESSAGE[c] ?? fallback ?? 'Research failed. Try Refresh.', retryable: c !== 'disallowed_tool' && c !== 'gone' };
}

export function emptyReadIn(entity: ReadInEntity, at: string, trigger: ReadInTrigger = 'on_demand'): ReadIn {
  return {
    entity,
    state: 'queued',
    tldr: '',
    background: [],
    history: [],
    openQuestions: [],
    suggestedReply: null,
    confidence: null,
    generatedAt: null,
    generation: 0,
    costUsd: 0,
    sources: [],
    trigger,
    model: null,
    skillVersion: null,
    evidenceHash: null,
    progress: null,
    error: null,
    staleReason: null,
    updatedAt: at,
  };
}

function fmtTime(iso: string, tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function freshState(r: ReadIn, fresh: EntityFreshness | null, tz?: string): ReadIn {
  if (r.state !== 'ready' || !fresh || !r.generatedAt) return r;
  const newer = fresh.generation > r.generation || (!!fresh.lastNewInfoAt && Date.parse(fresh.lastNewInfoAt) > Date.parse(r.generatedAt));
  if (!newer) return r;
  const n = fresh.newSince ?? 0;
  const reason = n > 0 ? `${n} new ${n === 1 ? 'update' : 'updates'} since ${fmtTime(r.generatedAt, tz)}` : `New info since ${fmtTime(r.generatedAt, tz)}`;
  return { ...r, state: 'stale', staleReason: reason };
}

export function deriveReadIn(entity: ReadInEntity, stored: StoredReadIn | null, job: ReadInJobSnap | null, fresh: EntityFreshness | null, tz?: string): ReadIn | null {
  const base: ReadIn | null = stored ? { ...stored.readIn, entity } : null;
  const jobIsNewer = !!job && (!stored || stored.jobId === null || job.id > stored.jobId);
  if (job && jobIsNewer) {
    const content = base ?? emptyReadIn(entity, job.updatedAt, job.trigger);
    if (job.status === 'queued' || (job.status === 'running' && job.cancelRequested)) {
      return { ...content, state: 'queued', progress: { step: 'queued', label: 'Queued', done: 0, total: PLAN_STEPS }, error: null, staleReason: null, updatedAt: job.updatedAt };
    }
    if (job.status === 'running') {
      return { ...content, state: 'researching', progress: job.progress ?? { step: 'ledger', label: 'Starting', done: 0, total: PLAN_STEPS }, error: null, staleReason: null, updatedAt: job.updatedAt };
    }
    if (job.status === 'succeeded' && job.skipped) {
      const err = errorFor(job.skipped);
      if (base && base.state === 'ready') return { ...freshState(base, fresh, tz), error: err };
      return { ...content, state: 'failed', progress: null, error: err, updatedAt: job.updatedAt };
    }
    if (job.status === 'dead') {
      const err = errorFor(job.lastErrorCode);
      if (base && base.state === 'ready') return { ...freshState(base, fresh, tz), error: err };
      return { ...content, state: 'failed', progress: null, error: err, updatedAt: job.updatedAt };
    }
    // succeeded without a stored record yet (commit raced the read), or cancelled: fall through to the stored one.
  }
  if (!base) return null;
  if (stored!.outcome === 'failed') return { ...base, state: 'failed', progress: null };
  return freshState({ ...base, state: 'ready', progress: null }, fresh, tz);
}
