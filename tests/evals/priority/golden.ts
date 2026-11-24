/**
 * Scores one golden day: agreement@3 against the ideal Top 3 and each expectation (pass / fail / known gap).
 * A failing expectation marked `knownGap` (e.g. "priority@2") is recorded, never fails CI; one that starts passing
 * says so, so the marker can be removed.
 */
import type { RankingResult } from '@/engines/priority/types';
import type { Expectation, GoldenDay } from './sample-day';

export interface CheckResult {
  expectation: Expectation;
  pass: boolean;
  detail: string;
}

export interface DayScore {
  name: string;
  agreement3: number;
  top3: string[];
  checks: CheckResult[];
  /** Failing checks without a knownGap: these fail the test. */
  failures: CheckResult[];
  /** Failing checks with a knownGap. */
  knownGaps: CheckResult[];
  /** Checks marked knownGap that pass now (remove the marker). */
  fixedGaps: CheckResult[];
}

export function scoreDay(day: GoldenDay, r: RankingResult, keyOf: (id: string) => string): DayScore {
  const top3 = r.top3.map(keyOf);
  const order = r.ranked.map((s) => keyOf(s.workItemId));
  const firstScreen = new Set([...top3, ...order.filter((k) => !top3.includes(k))].slice(0, day.firstScreen));
  const agreement3 = day.goldenTop3.filter((slot) => slot.some((k) => top3.includes(k))).length / day.goldenTop3.length;
  const scoreOf = (key: string) => Object.values(r.scores).find((s) => keyOf(s.workItemId) === key);
  const pos = (key: string) => {
    const i = order.indexOf(key);
    return i < 0 ? Infinity : i;
  };

  const checks: CheckResult[] = day.expectations.map((e): CheckResult => {
    switch (e.kind) {
      case 'inTop3': {
        const hit = e.anyOf.find((k) => top3.includes(k));
        return { expectation: e, pass: !!hit, detail: hit ? `${hit} is in the Top 3` : `none of ${e.anyOf.join(', ')} in the Top 3 [${top3.join(', ')}] (ranks ${e.anyOf.map((k) => `${k}#${pos(k) + 1}`).join(', ')})` };
      }
      case 'notFirstScreen': {
        const bad = e.ids.filter((k) => firstScreen.has(k));
        return { expectation: e, pass: bad.length === 0, detail: bad.length ? `on the first screen: ${bad.join(', ')}` : `none of ${e.ids.length} on the first ${day.firstScreen}` };
      }
      case 'order': {
        const a = pos(e.above);
        const b = pos(e.below);
        return { expectation: e, pass: a < b, detail: `${e.above}#${a + 1} vs ${e.below}#${b + 1}` };
      }
      case 'capacity': {
        const is = r.capacity.fits ? 'fits' : 'overbooked';
        return { expectation: e, pass: is === e.is, detail: `${is}: ${r.capacity.youMinToday} min of work, ${r.capacity.freeMin} free` };
      }
      case 'whyContains': {
        const s = scoreOf(e.id);
        const text = s ? `${s.why.now ?? ''} | ${s.why.matters ?? ''}` : '(not scored)';
        const missing = e.phrases.filter((p) => !text.toLowerCase().includes(p.toLowerCase()));
        return { expectation: e, pass: missing.length === 0, detail: missing.length ? `"${text}" lacks ${missing.map((m) => `"${m}"`).join(', ')}` : `"${text}"` };
      }
      case 'adminBatch': {
        const got = (r.adminBatch?.promotedIds ?? []).map(keyOf);
        const missing = e.promoted.filter((k) => !got.includes(k));
        const ok = !!r.adminBatch?.promoted && missing.length === 0 && !!r.adminBatch.slot && !r.top3.some((id) => r.adminBatch!.itemIds.includes(id));
        return { expectation: e, pass: ok, detail: r.adminBatch ? `${r.adminBatch.label}; promoted [${got.join(', ')}]${r.adminBatch.slot ? ` at ${r.adminBatch.slot.start}` : ', no slot'}` : 'no admin batch' };
      }
      case 'makeRoom': {
        const rows = (r.makeRoom?.rows ?? []).map((x) => keyOf(x.itemId));
        const bad = rows.filter((k) => e.never.includes(k));
        const ok = rows.length > 0 && e.first.includes(rows[0]!) && bad.length === 0;
        return { expectation: e, pass: ok, detail: r.makeRoom ? `${r.makeRoom.label}: [${rows.join(', ')}] frees ${r.makeRoom.freesMin} min` : 'no Make room list' };
      }
    }
  });
  return {
    name: day.name,
    agreement3,
    top3,
    checks,
    failures: checks.filter((c) => !c.pass && !c.expectation.knownGap),
    knownGaps: checks.filter((c) => !c.pass && !!c.expectation.knownGap),
    fixedGaps: checks.filter((c) => c.pass && !!c.expectation.knownGap),
  };
}

export function report(scores: DayScore[]): string {
  const lines: string[] = [];
  for (const s of scores) {
    lines.push(`golden day ${s.name}: agreement@3 = ${s.agreement3.toFixed(2)} · Top 3 [${s.top3.join(', ')}] · ${s.checks.filter((c) => c.pass).length}/${s.checks.length} checks`);
    for (const c of s.knownGaps) lines.push(`  known gap (${c.expectation.knownGap}): ${c.expectation.kind}: ${c.detail}`);
    for (const c of s.fixedGaps) lines.push(`  now passes, drop knownGap "${c.expectation.knownGap}": ${c.expectation.kind}: ${c.detail}`);
    for (const c of s.failures) lines.push(`  FAIL ${c.expectation.kind}: ${c.detail}`);
  }
  const mean = scores.reduce((a, s) => a + s.agreement3, 0) / Math.max(1, scores.length);
  lines.push(`golden days: mean agreement@3 = ${mean.toFixed(2)} over ${scores.length} days`);
  return lines.join('\n');
}

/** agreement@3 and checks passed per day, priority@1.1 next to priority@2. */
export function comparisonTable(v1: DayScore[], v2: DayScore[]): string {
  const pad = (s: string, n: number) => s.padEnd(n);
  const lines = [`${pad('golden day', 22)} ${pad('v1 agreement@3', 15)} ${pad('v2 agreement@3', 15)} ${pad('v1 checks', 10)} v2 checks`];
  for (const b of v2) {
    const a = v1.find((s) => s.name === b.name);
    const checks = (s: DayScore | undefined) => (s ? `${s.checks.filter((c) => c.pass).length}/${s.checks.length}` : '-');
    lines.push(`${pad(b.name, 22)} ${pad(a ? a.agreement3.toFixed(2) : '-', 15)} ${pad(b.agreement3.toFixed(2), 15)} ${pad(checks(a), 10)} ${checks(b)}`);
  }
  const mean = (xs: DayScore[]) => (xs.reduce((s, x) => s + x.agreement3, 0) / Math.max(1, xs.length)).toFixed(2);
  lines.push(`${pad('mean', 22)} ${pad(mean(v1), 15)} ${mean(v2)}`);
  return lines.join('\n');
}
