/**
 * Per-turn spend of one Agent SDK query (holistic review ask #14, 28-crash-resume.md Remaining 4; EDGE-CASES WK-15).
 *
 * The query's own `pass` row (what `recordSpend` books at the end of the run) is traced only when the query ends, so
 * a worker killed mid-query used to leave that query's money in memory only. Each assistant message's usage block is
 * the SDK's report of one paid request, and it arrives before the next tool runs: every turn is traced here as a
 * `turn` row (model, tokens, cost from the usage block, the query's key `q`, the governor's hold) and flushed at once.
 *
 *  - A query that ends (any outcome) traces its `pass` row with the same `q`: that row books the whole query, its
 *    `turn` rows are never booked (they are the trace of a query in flight).
 *  - A query whose worker died has `turn` rows and no `pass` row with its `q`: the next start's recovery turns each into
 *    a `pass` row and books it once (`pass:<run>:<seq>`, src/worker/recovery.ts), and settles the hold with them.
 *  - The SDK repeats an assistant message once per content block with the same id and usage: only what grew is traced,
 *    so a message is one row.
 */
import { randomUUID } from 'node:crypto';

import type { CallMeasurement } from '../db/ledger';
import { flushTrace, trace } from '../scanner/trace';
import { estimateCallCostUsd } from './models';

type RawUsage = Record<string, number | null | undefined>;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface TurnTracerOptions {
  runId: string;
  pass: string;
  mode: string;
  /** The governor's hold the query reports to (recovery settles it from the rows). */
  holdId: string | null;
}

export class TurnTracer {
  /** The query's key: its `turn` rows and its end `pass` row carry it. */
  readonly q = randomUUID();
  private readonly seen = new Map<string, { usd: number; i: number; o: number; cr: number; cw: number }>();
  private turns = 0;
  /** What the traced turns cost so far (USD). */
  usd = 0;
  /** D0: the query's content hash, once its prompt is built. */
  contentHash: string | null = null;

  constructor(private readonly o: TurnTracerOptions) {}

  /** One assistant message's usage block: trace what it adds, and wait until the row is written. */
  async observe(msgId: string, model: string, u: RawUsage): Promise<void> {
    const cur = { usd: round6(estimateCallCostUsd(model, u)), i: n(u.input_tokens), o: n(u.output_tokens), cr: n(u.cache_read_input_tokens), cw: n(u.cache_creation_input_tokens) };
    const prev = this.seen.get(msgId);
    const usd = round6(cur.usd - (prev?.usd ?? 0));
    if (!(usd > 0)) return;
    this.seen.set(msgId, cur);
    if (!prev) this.turns += 1;
    this.usd = round6(this.usd + usd);
    const prompt = cur.i + cur.cr + cur.cw;
    const m: CallMeasurement = { turns: prev ? 0 : 1, ...(prompt && !prev ? { firstPromptTokens: prompt, maxPromptTokens: prompt } : {}) };
    trace(this.o.runId, 'turn', {
      pass: this.o.pass,
      mode: this.o.mode,
      model,
      q: this.q,
      hold: this.o.holdId,
      turn: this.turns,
      ok: true,
      errorClass: null,
      costUsd: usd,
      inputTokens: Math.max(0, cur.i - (prev?.i ?? 0)),
      outputTokens: Math.max(0, cur.o - (prev?.o ?? 0)),
      cacheReadTokens: Math.max(0, cur.cr - (prev?.cr ?? 0)),
      cacheWriteTokens: Math.max(0, cur.cw - (prev?.cw ?? 0)),
      contentHash: this.contentHash,
      turns: m.turns,
      m,
    });
    await flushTrace();
  }
}
