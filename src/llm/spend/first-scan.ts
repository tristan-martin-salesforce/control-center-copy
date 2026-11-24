/**
 * COST-9 (holistic review 2026-11-20): the first scan's estimate before it starts. Per source: the measured $/day
 * median (and p90) of its daily scanning from llm_calls when there are enough days, else the static per-source table;
 * × the days of history each source reads; plus read-ins on their own line. Shown on Getting started as
 * "First scan: usually about $A, up to $B, about N h" (`usualCost`) and recorded as the first scan's hold: the scan asks past it, never
 * stops on its own.
 */
import { firstScanMinutes } from '@/contract';

import { FIRST_SCAN_READINS_USD, FIRST_SCAN_SOURCE_DAY_USD } from './defaults';

/** At least this many measured days and a source's own median answers. */
export const MIN_SOURCE_DAYS = 5;

export interface SourceDayCost {
  p50: number;
  p90: number;
  /** Days measured (0 for the table). */
  n: number;
}

export interface FirstScanSpendEstimate {
  p50: number;
  p90: number;
  minutes: number;
  /** history when every source with a cost had its own measurement, default when none did, else mixed. */
  basis: 'history' | 'default' | 'mixed';
  bySource: Array<{ source: string; days: number; p50: number; p90: number; basis: 'history' | 'default' }>;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * `windows`: days of history per source (a source left out reads `days`). `measured`: per-source $/day from the
 * user's own scanning, when the app has some (a reinstall, a teammate's machine); usually empty before a first scan.
 */
export function estimateFirstScan(sources: readonly string[], windows: { days: number; perSource?: Record<string, number> }, measured: Record<string, SourceDayCost> = {}): FirstScanSpendEstimate {
  const bySource = sources.map((source) => {
    const days = Math.max(0, windows.perSource?.[source] ?? windows.days);
    const m = measured[source];
    const own = m && m.n >= MIN_SOURCE_DAYS;
    const c = own ? m : (FIRST_SCAN_SOURCE_DAY_USD[source] ?? { p50: 0.02, p90: 0.04 });
    return { source, days, p50: cents(c.p50 * days), p90: cents(Math.max(c.p50, c.p90) * days), basis: (own ? 'history' : 'default') as 'history' | 'default' };
  });
  const p50 = bySource.reduce((a, s) => a + s.p50, 0) + FIRST_SCAN_READINS_USD.p50;
  const p90 = bySource.reduce((a, s) => a + s.p90, 0) + FIRST_SCAN_READINS_USD.p90;
  const costed = bySource.filter((s) => s.p90 > 0);
  const own = costed.filter((s) => s.basis === 'history').length;
  return { p50: cents(p50), p90: cents(Math.max(p50, p90)), minutes: firstScanMinutes(windows.days), basis: own === 0 ? 'default' : own === costed.length ? 'history' : 'mixed', bySource };
}

/**
 * An estimate's median and p90 in plain words, the one wording on Getting started, onboarding and Health ▸ Spend
 * (24-visual-qa: no percentile words in the UI): "usually about $3.10, up to $5.40", or "about $3.10" when both read
 * the same.
 */
export function usualCost(p50: number, p90: number, fmt: (usd: number) => string = (n) => `$${n.toFixed(2)}`): string {
  const usual = fmt(p50);
  const most = fmt(Math.max(p50, p90));
  return usual === most ? `about ${usual}` : `usually about ${usual}, up to ${most}`;
}

/** "First scan: usually about $3.10, up to $5.40, about 4 h" (Getting started, onboarding). */
export function firstScanLine(e: Pick<FirstScanSpendEstimate, 'p50' | 'p90' | 'minutes'>, duration: (minutes: number) => string): string {
  return `First scan: ${usualCost(e.p50, e.p90)}, ${duration(e.minutes)}`;
}
