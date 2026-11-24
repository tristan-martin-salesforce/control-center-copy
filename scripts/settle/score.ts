/**
 * Score a Settle dry run against the private answer key.
 *
 *   npx tsx scripts/settle/score.ts --run <run.jsonl> [--key <dir>] [--wrong-out <ids.txt>] [--detail <file.md>]
 *
 * Prints counts and rates only (no titles). `--detail` writes a private per-item table for review, and `--wrong-out`
 * the ids to rerun. Items the key marks `unsure` are left out of the rates and listed apart.
 *
 * Buckets: `owed` (still_yours), `ask` (gone_quiet: can't tell), `settled` (every other verdict). A close is safe
 * when the key says settled; closing a gone_quiet item is a soft error; closing a still_yours item is a wrong close.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inStateDir } from '../../src/lib/state-folder';

import { ClosingSettings, DEFAULT_CLOSING_SETTINGS } from '../../src/contract';
import { decideSettle, SETTLE_THRESHOLDS } from '../../src/engines/settle/policy';
import type { SettleContext, SettleResult } from '../../src/engines/settle/types';
import { hasOpenLoop, hasUpcomingMatch } from '../../src/engines/settle/run';
import { salientWords } from '../../src/engines/settle/load-db';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const KEY_DIR = opt('key') ?? inStateDir('stress', 'settle-key', 'key');
const ITEMS = inStateDir('stress', 'settle-key', 'items.jsonl');

interface KeyRow {
  item_id: string;
  verdict: string;
  confidence: 'sure' | 'likely' | 'unsure';
  knowable_from_db?: boolean;
  status_now?: string;
}
interface RunRow {
  workItemId: string;
  verdict: string;
  confidence: number;
  valid: boolean;
  invalidWhy?: string;
  reason: string;
  costUsd: number;
  error?: string;
}

const readJsonl = <T>(f: string): T[] =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });

const bucket = (v: string) => (v === 'still_yours' || v === 'waiting_on_them' ? 'owed' : v === 'gone_quiet' ? 'ask' : 'settled');

const runFile = opt('run');
if (!runFile) throw new Error('--run <file> is required');
const key = new Map<string, KeyRow>();
for (const f of fs.readdirSync(KEY_DIR).filter((f) => f.endsWith('.jsonl'))) for (const r of readJsonl<KeyRow>(path.join(KEY_DIR, f))) key.set(r.item_id, r);
const runRows = readJsonl<RunRow & { upcomingEvent?: boolean }>(runFile);
// --contexts <file>: recompute the upcoming-meeting guard from saved packs (runs made before the guard was narrowed).
if (opt('contexts')) {
  const ctxs = new Map<string, SettleContext>();
  for (const f of opt('contexts')!.split(',')) for (const c of readJsonl<SettleContext>(f)) ctxs.set(c.item.id, c);
  for (const r of runRows) {
    const c = ctxs.get(r.workItemId);
    if (c) {
      r.upcomingEvent = hasUpcomingMatch(c, salientWords(c.item.title, [c.item.counterparty, c.item.account]));
      (r as { openLoop?: boolean }).openLoop = hasOpenLoop(c);
    }
  }
}
const titles = new Map(readJsonl<{ item_id: string; title: string; status: string; kind: string }>(ITEMS).map((r) => [r.item_id, r] as const));

const scored = runRows.filter((r) => key.has(r.workItemId));
const sure = scored.filter((r) => key.get(r.workItemId)!.confidence !== 'unsure');
const exact = sure.filter((r) => r.verdict === key.get(r.workItemId)!.verdict).length;
const bucketOk = sure.filter((r) => bucket(r.verdict) === bucket(key.get(r.workItemId)!.verdict)).length;

// Confusion by bucket.
const conf: Record<string, Record<string, number>> = {};
for (const r of sure) {
  const k = bucket(key.get(r.workItemId)!.verdict);
  const p = r.valid ? bucket(r.verdict) : 'invalid';
  conf[k] ??= {};
  conf[k][p] = (conf[k][p] ?? 0) + 1;
}

// Auto-close precision per predicted reason and confidence threshold.
const THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
const reasons = [...new Set(sure.filter((r) => bucket(r.verdict) === 'settled').map((r) => r.verdict))].sort();
const perReason: Record<string, Record<string, string>> = {};
for (const reason of reasons) {
  perReason[reason] = {};
  for (const t of THRESHOLDS) {
    const closes = sure.filter((r) => r.valid && r.verdict === reason && r.confidence >= t);
    const wrong = closes.filter((r) => bucket(key.get(r.workItemId)!.verdict) === 'owed').length;
    const soft = closes.filter((r) => bucket(key.get(r.workItemId)!.verdict) === 'ask').length;
    perReason[reason][`>=${t}`] = closes.length ? `${closes.length} closes, ${wrong} wrong, ${soft} soft (${(((closes.length - wrong) / closes.length) * 100).toFixed(1)}%)` : '0';
  }
}
const allSettledKey = sure.filter((r) => bucket(key.get(r.workItemId)!.verdict) === 'settled').length;
const overall = THRESHOLDS.map((t) => {
  const closes = sure.filter((r) => r.valid && bucket(r.verdict) === 'settled' && r.confidence >= t);
  const wrong = closes.filter((r) => bucket(key.get(r.workItemId)!.verdict) === 'owed').length;
  const right = closes.filter((r) => bucket(key.get(r.workItemId)!.verdict) === 'settled').length;
  return { threshold: t, closes: closes.length, wrong, precision: closes.length ? Number(((1 - wrong / closes.length) * 100).toFixed(1)) : null, recallOfSettled: allSettledKey ? Number(((right / allSettledKey) * 100).toFixed(1)) : null };
});

// Wrong items: a different bucket, or an invalid citation on a settled key item.
const wrong = sure.filter((r) => bucket(r.verdict) !== bucket(key.get(r.workItemId)!.verdict) || (!r.valid && bucket(key.get(r.workItemId)!.verdict) === 'settled'));
const classWrong = sure.filter((r) => r.verdict !== key.get(r.workItemId)!.verdict);
const unsure = scored.filter((r) => key.get(r.workItemId)!.confidence === 'unsure');

console.log(
  JSON.stringify(
    {
      run: path.basename(runFile),
      judged: runRows.length,
      inKey: scored.length,
      keyUnsure: unsure.length,
      errors: runRows.filter((r) => r.error).length,
      invalid: runRows.filter((r) => !r.valid).length,
      costUsd: Number(runRows.reduce((a, r) => a + r.costUsd, 0).toFixed(4)),
      exactClass: `${exact}/${sure.length} (${((exact / Math.max(1, sure.length)) * 100).toFixed(1)}%)`,
      bucket: `${bucketOk}/${sure.length} (${((bucketOk / Math.max(1, sure.length)) * 100).toFixed(1)}%)`,
      confusion_key_to_pred: conf,
      autoClose: overall,
      perReason,
      wrongBucket: wrong.length,
      wrongClass: classWrong.length,
    },
    null,
    2,
  ),
);

// Policy simulation: what the user would see with the real policy (src/engines/settle/policy.ts) under each
// strictness, with `--gone-quiet close|ask` and `--not-yours close|ask` overrides. Clicks = items left for the user
// although the key says nothing is owed (asks, plus settled items left open in their lists).
const sim: Record<string, unknown> = {};
for (const strictness of ['cautious', 'balanced', 'eager'] as const) {
  const reasons = { ...DEFAULT_CLOSING_SETTINGS.reasons, ...(opt('gone-quiet') ? { gone_quiet: opt('gone-quiet') as 'close' | 'ask' } : {}), ...(opt('not-yours') ? { not_yours: opt('not-yours') as 'close' | 'ask' } : {}), ...(opt('not-an-ask') ? { not_an_ask: opt('not-an-ask') as 'close' | 'ask' } : {}) };
  const s = ClosingSettings.parse({ ...DEFAULT_CLOSING_SETTINGS, strictness, reasons });
  const tally = { closesRight: 0, closesWrong: 0, closesSoft: 0, clicks: 0, owedKeptOpen: 0, owedAsked: 0, clicksBy: {} as Record<string, number>, wrongIds: [] as string[] };
  for (const r of sure) {
    const k = key.get(r.workItemId)!;
    const status = titles.get(r.workItemId)?.status ?? 'open';
    if (status === 'done') continue;
    const d = decideSettle({ ...r, model: '', skill: '', inputTokens: 0, outputTokens: 0, cite: undefined, upcomingEvent: (r as { upcomingEvent?: boolean }).upcomingEvent, openLoop: (r as { openLoop?: boolean }).openLoop, askCutOff: (r as { askCutOff?: boolean }).askCutOff } as unknown as SettleResult, { id: r.workItemId, kind: titles.get(r.workItemId)?.kind ?? 'ask', status, userTouched: false, userReopened: false, externalCommitment: false, people: [], channels: [] }, s);
    const kb = bucket(k.verdict);
    if (d.action === 'close') {
      if (kb === 'owed') {
        tally.closesWrong++;
        tally.wrongIds.push(`${r.workItemId.slice(0, 8)}:${r.verdict}:${r.confidence}`);
      }
      else if (kb === 'ask') tally.closesSoft++;
      else tally.closesRight++;
    } else if (kb === 'owed') {
      if (d.action === 'leave' || d.action === 'reopen') tally.owedKeptOpen++;
      else tally.owedAsked++;
    } else {
      tally.clicks++;
      const why = `${d.action}:${r.valid ? r.verdict : 'invalid'}${r.valid && r.confidence < SETTLE_THRESHOLDS[strictness] && bucket(r.verdict) === 'settled' ? '<thr' : ''}`;
      tally.clicksBy[why] = (tally.clicksBy[why] ?? 0) + 1;
    }
  }
  sim[strictness] = tally;
}
console.log(JSON.stringify({ policySimulation: sim }));

if (opt('wrong-out')) fs.writeFileSync(opt('wrong-out')!, wrong.map((r) => r.workItemId).join('\n') + '\n', { mode: 0o600 });
if (opt('detail')) {
  const line = (r: RunRow) => {
    const k = key.get(r.workItemId)!;
    const t = titles.get(r.workItemId);
    return `| ${r.workItemId.slice(0, 8)} | ${t?.status ?? ''} | ${(t?.title ?? '').slice(0, 70).replace(/\|/g, '/')} | **${k.verdict}** (${k.confidence}${k.knowable_from_db === false ? ', not in db' : ''}) | ${r.verdict} ${r.confidence.toFixed(2)}${r.valid ? '' : ' INVALID'} | ${(r.invalidWhy ?? r.reason ?? '').slice(0, 90).replace(/\|/g, '/')} |`;
  };
  const head = '| id | status | title | key | settle | reason |\n|---|---|---|---|---|---|';
  fs.writeFileSync(
    opt('detail')!,
    [`# ${path.basename(runFile)}`, '', `## Wrong bucket (${wrong.length})`, head, ...wrong.map(line), '', `## Right bucket, wrong class (${classWrong.length - wrong.filter((r) => r.verdict !== key.get(r.workItemId)!.verdict).length})`, head, ...classWrong.filter((r) => !wrong.includes(r)).map(line), '', `## Key unsure (${unsure.length})`, head, ...unsure.map(line)].join('\n'),
    { mode: 0o600 },
  );
}
