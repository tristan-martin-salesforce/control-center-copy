/**
 * What a first scan of N days of history costs, for the History step (B-079).
 *
 * ONE constant holds the figures. Today they are per-day numbers from the stress campaign; when the stress session
 * delivers measured estimates per lookback (scripts/stress/estimate-first-scan.ts on the B-080 branch prints
 * `estimateUsd {lo, hi}` for N days), put them in `measured` and the UI shows those instead of days × per-day.
 */
import { DEFAULT_BACKFILL_BUDGET_USD, DEFAULT_LOOKBACK_DAYS, firstScanMinutes, LOOKBACK_DAYS, type FirstScanEstimate, type LookbackDays, type OnboardingCost, type UsdRange } from '@/contract';

export interface FirstScanCostFigures {
  allScannersPerDayUsd: UsdRange;
  slackShare: number;
  slackTriageExtra: { low: number; high: number };
  measured: Partial<Record<LookbackDays, UsdRange>>;
  basis: string;
}

export const FIRST_SCAN_COST: FirstScanCostFigures = {
  /** docs/archive/2026-build/STRESS.md §4.4: daily catch-up, every scanner, after the fixes ($0.34 quiet to $0.86 busy weekday). */
  allScannersPerDayUsd: { lowUsd: 0.34, highUsd: 0.86 },
  /**
   * Slack's share of that day: cold-slack $0.22 of the $0.78 all-scanner cold start (STRESS.md §4.1, §4.4). The
   * new Slack triage pass (STRESS-2) adds about 30–60% on Slack only.
   */
  slackShare: 0.28,
  slackTriageExtra: { low: 0.3, high: 0.6 },
  /**
   * Measured one-time cost per lookback (empty = days × per-day). From the first-scan ramp on one SE's real data
   * (docs/archive/2026-build/FIRST-SCAN-RAMP.md), every scanner, fresh database:
   *  - 7 days, 2026-11-06: $4.42 in 54 min = scan $2.54 (Slack $1.61, Org62 $0.45, Gmail $0.16, Gemini notes $0.14,
   *    Claude sessions $0.13, Calendar $0.05) + read-ins $1.88 (Sonnet, asks from the last 48 h only, capped at $2/day).
   *  - 14 days, 2026-11-06: $7.18 in 114 min = scan $5.15 (Slack $3.66, Org62 $0.50, Gemini notes $0.46, Gmail $0.27,
   *    Claude sessions $0.20, Calendar $0.07) + read-ins $2.03.
   *  - 30 days, 2026-11-07 (run with the Slack and Gmail inboxes at 90 days): $28.89 raw in 470 min. Less $2.14 of
   *    MIN-25 cost-cap failures (fixed since: the shipped code doesn't spend it) and less the 31–90-day inbox part
   *    ($9.47 Slack, $1.11 Gmail; the 30-day option has no deeper inbox): $16.24 = scan $12.34 + read-ins $3.90 (two
   *    days, the run crossed midnight).
   * The range: a quieter history costs less; a busier Slack up to about 1.5× the scan part; read-ins stay under their cap.
   */
  measured: { 7: { lowUsd: 3.5, highUsd: 6 }, 14: { lowUsd: 6, highUsd: 10 }, 30: { lowUsd: 13, highUsd: 23 } },
  basis: 'Stress-test figures: every scanner on a busy weekday ($0.34–0.86), plus 30–60% on Slack for its triage pass. Quiet days and weekends cost less.',
};

const cents = (n: number) => Math.round(n * 100) / 100;

function perDayRaw(c: FirstScanCostFigures): UsdRange {
  return {
    lowUsd: c.allScannersPerDayUsd.lowUsd * (1 + c.slackShare * c.slackTriageExtra.low),
    highUsd: c.allScannersPerDayUsd.highUsd * (1 + c.slackShare * c.slackTriageExtra.high),
  };
}

/** One day of history, every scanner. */
export function perDayCost(c = FIRST_SCAN_COST): UsdRange {
  const d = perDayRaw(c);
  return { lowUsd: cents(d.lowUsd), highUsd: cents(d.highUsd) };
}

export function estimateFirstScan(days: LookbackDays, c = FIRST_SCAN_COST): FirstScanEstimate {
  const m = c.measured[days];
  const minutes = firstScanMinutes(days);
  if (m) return { days, lowUsd: cents(m.lowUsd), highUsd: cents(m.highUsd), basis: 'measured', minutes };
  const d = perDayRaw(c);
  return { days, lowUsd: cents(d.lowUsd * days), highUsd: cents(d.highUsd * days), basis: 'per_day', minutes };
}

export function onboardingCost(dailyHardUsd: number | null, c = FIRST_SCAN_COST): OnboardingCost {
  return {
    perDay: perDayCost(c),
    basis: c.basis,
    options: LOOKBACK_DAYS.map((d) => estimateFirstScan(d, c)),
    defaultDays: DEFAULT_LOOKBACK_DAYS,
    defaultBudgetUsd: DEFAULT_BACKFILL_BUDGET_USD,
    dailyHardUsd,
  };
}
