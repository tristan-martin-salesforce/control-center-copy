/**
 * Cassette model: a `CompletionModel` that replays recorded replies, keyed by the same content hash the completion
 * pass books on every call (`ledgerHash(model, skill version, system, user)`, src/scanner/completion/pass.ts). It
 * makes the eval harness (tests/evals/scanner) deterministic, offline and free: no network, no tokens, no spend
 * (a replayed call reports cost 0, so the pass books nothing).
 *
 *  - strict (default): a prompt whose hash is not in the cassette throws `CassetteMissError` with the hash, so a
 *    prompt or skill change shows up as a failing eval naming the call, never as a silent live call.
 *  - rekey: on a miss, fall back to the entry with the same `label` (a caller-chosen stable description of the call,
 *    e.g. the pass time and the item titles) and report the new hash. `npm run eval:record -- --rekey` uses it to
 *    re-key hand-written cassettes after a prompt change, offline.
 *
 * `recordingModel` wraps a live model and captures entries in the same shape (`npm run eval:record -- --live`).
 * Never used in production code paths.
 */
import { ledgerHash } from '@/db/ledger';

import type { CompletionModel, CompletionModelRequest, CompletionModelResult } from './types';

export interface CassetteEntry {
  /** ledgerHash(model, skill, system, user); null until a hand-written entry is keyed (`eval:record -- --rekey`). */
  hash: string | null;
  /** Stable, human-readable description of the call (no message bodies): what rekeying matches on. */
  label: string;
  /** The reply text, exactly as the model returned it. */
  text: string;
  ok?: boolean;
  /** `hand` (written by a person, plausible) or `live` (recorded from the model). */
  origin: 'hand' | 'live';
  model?: string;
  skill?: string | null;
  recordedAt?: string;
  /** What the live call cost when it was recorded (informational; replays cost 0). */
  costUsd?: number;
}

export interface CassetteFile {
  version: 1;
  note?: string;
  entries: CassetteEntry[];
}

export class CassetteMissError extends Error {
  override name = 'CassetteMissError';
  constructor(
    readonly hash: string,
    readonly label: string,
  ) {
    super(`cassette miss: no recorded reply for prompt hash ${hash} (${label || 'no label'}). Re-key hand-written cassettes with \`npm run eval:record -- --rekey\`, or record live ones with \`npm run eval:record -- --live\` (costs money).`);
  }
}

/** The key a call is stored under: the completion pass's ledger content hash. */
export function cassetteHash(req: Pick<CompletionModelRequest, 'model' | 'system' | 'user'>, skill: string | null): string {
  return ledgerHash(req.model, skill, req.system, req.user);
}

export interface CassetteOptions {
  entries: CassetteEntry[];
  /** The skill version tag the caller books with (`check-completion@1.3.0`); part of the hash. */
  skill: string | null;
  labelOf?: (req: CompletionModelRequest) => string;
  mode?: 'strict' | 'rekey';
}

export interface Cassette {
  model: CompletionModel;
  /** Hashes replayed so far. */
  used: Set<string>;
  /** Rekey mode: entries found by label whose hash changed. */
  rekeyed: Array<{ label: string; from: string | null; to: string }>;
  /** Strict-mode misses (the error is also thrown). */
  misses: Array<{ hash: string; label: string }>;
}

const replay = (e: CassetteEntry): CompletionModelResult => ({
  ok: e.ok ?? true,
  text: e.text,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...(e.ok === false ? { error: { message: 'recorded failure', errorClass: 'transient' as const } } : {}),
});

export function cassetteModel(o: CassetteOptions): Cassette {
  const byHash = new Map(o.entries.filter((e) => e.hash).map((e) => [e.hash!, e]));
  const used = new Set<string>();
  const rekeyed: Cassette['rekeyed'] = [];
  const misses: Cassette['misses'] = [];
  const model: CompletionModel = async (req) => {
    const hash = cassetteHash(req, o.skill);
    const label = o.labelOf?.(req) ?? '';
    const hit = byHash.get(hash);
    if (hit) {
      used.add(hash);
      return replay(hit);
    }
    if (o.mode === 'rekey' && label) {
      const byLabel = o.entries.find((e) => e.label === label);
      if (byLabel) {
        rekeyed.push({ label, from: byLabel.hash, to: hash });
        byLabel.hash = hash;
        byHash.set(hash, byLabel);
        used.add(hash);
        return replay(byLabel);
      }
    }
    misses.push({ hash, label });
    throw new CassetteMissError(hash, label);
  };
  return { model, used, rekeyed, misses };
}

/** Wrap a live model and capture every call as a cassette entry (eval:record --live). */
export function recordingModel(live: CompletionModel, o: { skill: string | null; labelOf?: (req: CompletionModelRequest) => string; now?: () => Date }): { model: CompletionModel; entries: CassetteEntry[]; costUsd: () => number } {
  const entries: CassetteEntry[] = [];
  let spent = 0;
  const model: CompletionModel = async (req) => {
    const res = await live(req);
    spent += res.costUsd;
    entries.push({ hash: cassetteHash(req, o.skill), label: o.labelOf?.(req) ?? '', text: res.text, ...(res.ok ? {} : { ok: false }), origin: 'live', model: req.model, skill: o.skill, recordedAt: (o.now?.() ?? new Date()).toISOString(), costUsd: res.costUsd });
    return res;
  };
  return { model, entries, costUsd: () => spent };
}
