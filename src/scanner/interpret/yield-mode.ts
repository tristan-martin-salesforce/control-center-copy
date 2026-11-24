/**
 * `scan:report --yield`: what scanning bought in each mode (review 04 §4.5, holistic build p2-fetch-then-interpret).
 * A scan run is FTI when it booked a classifier call (`classify-items`) or a relay read (`relay:*`), agentic when it
 * booked a scan skill or the Slack triage pass and no FTI row. $ per item found = the mode's dollars over its runs'
 * proposals and links. Pure: the report reads the rows, this adds them up.
 */
import type { YieldCall, YieldRun } from '@/engines/spend-audit/yield';

import { CLASSIFY_SKILL_KEY } from './interpret';

export interface ModeYield {
  mode: 'fti' | 'agentic';
  runs: number;
  calls: number;
  usd: number;
  found: number;
  closed: number;
  usdPerItem: number | null;
}

const isFti = (skill: string) => skill === CLASSIFY_SKILL_KEY || skill.startsWith('relay:');
const isAgentic = (skill: string) => skill.startsWith('scan-') || skill === 'triage-slack';

export function yieldByMode(calls: YieldCall[], runs: YieldRun[]): ModeYield[] {
  const modeOf = new Map<string, 'fti' | 'agentic'>();
  for (const c of calls) {
    if (!c.runId) continue;
    if (isFti(c.skill)) modeOf.set(c.runId, 'fti');
    else if (isAgentic(c.skill) && !modeOf.has(c.runId)) modeOf.set(c.runId, 'agentic');
  }
  const runById = new Map(runs.map((r) => [r.id, r]));
  return (['fti', 'agentic'] as const).map((mode) => {
    const ids = [...modeOf].filter(([, m]) => m === mode).map(([id]) => id);
    const set = new Set(ids);
    const mine = calls.filter((c) => c.runId && set.has(c.runId));
    const usd = mine.reduce((s, c) => s + c.usd, 0);
    const found = ids.reduce((s, id) => s + (runById.get(id)?.found ?? 0), 0);
    const closed = ids.reduce((s, id) => s + (runById.get(id)?.closed ?? 0), 0);
    return { mode, runs: ids.length, calls: mine.length, usd, found, closed, usdPerItem: found ? usd / found : null };
  });
}

/** The report's line: `fti $0.12 · 340 runs · 51 found · $0.0024/item | agentic … | fti/agentic $/item 0.14×`. */
export function renderModeYield(rows: ModeYield[]): string {
  const part = (r: ModeYield) => `${r.mode} $${r.usd.toFixed(2)} · ${r.runs} run(s) · ${r.calls} call(s) · ${r.found} found · ${r.closed} closed · ${r.usdPerItem == null ? '-' : `$${r.usdPerItem.toFixed(4)}`}/item`;
  const [f, a] = [rows.find((r) => r.mode === 'fti'), rows.find((r) => r.mode === 'agentic')];
  const ratio = f?.usdPerItem != null && a?.usdPerItem ? ` | fti/agentic $/item ${(f.usdPerItem / a.usdPerItem).toFixed(2)}×` : '';
  return `  by scan mode: ${rows.map(part).join(' | ')}${ratio}`;
}
