/**
 * Caps audit 26 F-12: a few prompts still keep a fixed number of rows of a list ahead of their own token trimmer (the
 * NBA prompt's assets and siblings, the resolution pack's Claude sessions, Settle's long-DM middle, its elsewhere,
 * events and siblings). Dropping the counts changes the cassette-keyed prompts, which needs a live re-record. Until
 * then each cut logs one `BUG.PROMPT_CUT` line with how many rows it dropped, so the next live run shows whether the
 * trimmer alone would do. Counts and a site name only, never the rows (*Local data, privacy-safe logs*).
 *
 * At most one line per site every 10 minutes, carrying what was dropped since the last line.
 */
import { logger } from '@/lib/log';

export const PROMPT_CUT_CODE = 'BUG.PROMPT_CUT';
const EVERY_MS = 10 * 60_000;

type Tally = { cuts: number; dropped: number; maxDropped: number; lastAt: number };
const tallies = new Map<string, Tally>();
let sink: ((line: { code: string; site: string; cuts: number; dropped: number; maxDropped: number; kept: number }) => void) | null = null;

/** Tests: see the lines instead of the log (null: back to the log). */
export function setPromptCutSink(s: typeof sink): void {
  sink = s;
  tallies.clear();
}

/** A list of `total` rows was cut to `kept` at `site`. A list that fit says nothing. Returns `kept`. */
export function notePromptCut(site: string, total: number, kept: number, now = Date.now()): number {
  const dropped = Math.max(0, total - kept);
  if (!dropped) return kept;
  const t = tallies.get(site) ?? { cuts: 0, dropped: 0, maxDropped: 0, lastAt: Number.NEGATIVE_INFINITY };
  t.cuts += 1;
  t.dropped += dropped;
  t.maxDropped = Math.max(t.maxDropped, dropped);
  tallies.set(site, t);
  if (now - t.lastAt < EVERY_MS) return kept;
  const line = { code: PROMPT_CUT_CODE, site, cuts: t.cuts, dropped: t.dropped, maxDropped: t.maxDropped, kept };
  tallies.set(site, { cuts: 0, dropped: 0, maxDropped: 0, lastAt: now });
  try {
    if (sink) sink(line);
    else logger('engines').warn(line, 'prompt list cut ahead of its token trimmer');
  } catch {
    /* a log line never fails a prompt */
  }
  return kept;
}

/** `xs.slice(0, n)` that notes the cut at `site`. */
export function cutHead<T>(site: string, xs: readonly T[], n: number): T[] {
  notePromptCut(site, xs.length, Math.min(xs.length, n));
  return xs.slice(0, n);
}
