/**
 * The axe run's verdict, kept pure so a unit test can drive it with a fake results array (P35-1). A scan that did not
 * finish (timed out, errored, or had nothing to open) is a failure: it is printed under the summary and the run exits
 * 1, so a hang can never read as a clean pass. There is no deliberate skip list, so no skip is tolerated.
 */
export interface Found {
  rule: string;
  impact: string;
  help: string;
  nodes: string[];
}

export interface PageResult {
  id: string;
  theme: string;
  skipped?: string;
  violations: Found[];
}

export type Baseline = Record<string, Record<string, number>>;

export const resultKey = (r: Pick<PageResult, 'id' | 'theme'>): string => `${r.theme} ${r.id}`;

/** The row tag a result prints with. */
export function tagOf(r: PageResult): 'tout' | 'skip' | 'viol' | 'ok  ' {
  if (r.skipped) return r.skipped.startsWith('timed out') ? 'tout' : 'skip';
  return r.violations.some((v) => v.nodes.length) ? 'viol' : 'ok  ';
}

/** Rule → node count per finished scan; a scan that did not finish has no row. */
export function countsOf(results: PageResult[]): Baseline {
  const now: Baseline = {};
  for (const r of results) if (!r.skipped) now[resultKey(r)] = Object.fromEntries(r.violations.map((v) => [v.rule, v.nodes.length]));
  return now;
}

export interface Verdict {
  /** New violations over the baseline. */
  worse: string[];
  /** Scans that did not finish (timed out, error, nothing to open): each is a failure. */
  stalled: string[];
  total: number;
  summary: string;
  code: 0 | 1;
}

export function verdict(results: PageResult[], base: Baseline): Verdict {
  const now = countsOf(results);
  const worse: string[] = [];
  for (const [page, rules] of Object.entries(now)) {
    for (const [rule, n] of Object.entries(rules)) {
      const allowed = base[page]?.[rule] ?? 0;
      if (n > allowed) worse.push(`${page}: ${rule} ${n} (baseline ${allowed})`);
    }
  }
  const stalled = results.filter((r) => r.skipped).map((r) => `${resultKey(r)}: not scanned (${r.skipped})`);
  const total = Object.values(now).reduce((s, r) => s + Object.values(r).reduce((a, b) => a + b, 0), 0);
  const summary = `a11y: ${results.length} scans, ${total} violating nodes, ${worse.length} new, ${stalled.length} not scanned`;
  return { worse, stalled, total, summary, code: worse.length || stalled.length ? 1 : 0 };
}
