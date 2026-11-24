/** Scan run trace types (see ./emit.ts). */
export type TraceKind =
  | 'plan'
  | 'prefetch'
  | 'tool_call'
  | 'rec'
  | 'prompt'
  | 'tripwire'
  | 'cost_cap'
  | 'pass'
  | 'triage_select'
  | 'triage_context'
  | 'verdict'
  | 'recorded'
  | 'proposal'
  | 'link'
  | 'unlinked'
  | 'coverage'
  | 'spend'
  | 'retry'
  | 'commit'
  | 'failed'
  | 'outcome'
  | 'error'
  /** FS-LATE: this run backfills a channel that joined the first scan after it had finished (why it got the lookback). */
  | 'first_scan_reopened'
  /** D3: items recorded without the model (status-only changes), and why. */
  | 'quiet'
  /** D5: the pre-check before a scheduled poll (empty or not, its calls and cost). */
  | 'precheck'
  /** COST-2 (0027): the prompt guard stopped a run before a request past the long-prompt tier. */
  | 'prompt_guard'
  /** Spend governor (H-5): the run passed its hold and stopped at a turn boundary to ask (paused, re-queued). */
  | 'spend_ask'
  /** 0027: what the context held at the first request (getContextUsage rows: ids and token counts only). */
  | 'context'
  /** Ask #14: one paid request of an Agent SDK query in flight (src/llm/skill-runner.turns.ts); booked only by recovery. */
  | 'turn';

export interface TraceEvent {
  runId: string;
  seq: number;
  ts: string;
  kind: TraceKind;
  payload: Record<string, unknown>;
  sourceItemId?: string;
  workItemId?: string;
}

export interface TraceSink {
  write(e: TraceEvent): void;
  flush(): Promise<void>;
}
