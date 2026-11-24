/**
 * Scores of a golden run: per-expectation results and the four numbers the build gates on or tracks.
 *
 *   item recall      expected asks that became their own item, over expected asks (knownGap excluded)    gate ≥ 0.9
 *   wrong closes     still-owed items that ended closed (knownGap excluded)                               gate = 0
 *   close rate       settled items that ended closed, over settled items (knownGap excluded)             tracked
 *   clicks left      user actions still needed to make the list right, over every expectation (gaps
 *                    included: they are real clicks): add a missed ask, confirm a Likely or close a
 *                    settled item by hand, undo a wrong close, dismiss an extra item                    tracked
 *
 * An expectation marked `knownGap` that now passes is reported as "flip": the chunk that fixed it removes the mark.
 */
import type { GoldenClosure, GoldenItem } from './golden';
import { citedSources, finalState, wasReopened, type CaseRun, type FinalState } from './harness';

export const RECALL_GATE = 0.9;
export const WRONG_CLOSE_GATE = 0;

export interface ItemResult {
  caseId: string;
  item: GoldenItem;
  found: boolean;
  why?: string;
}

export interface ClosureResult {
  caseId: string;
  closure: GoldenClosure;
  state: FinalState;
  pass: boolean;
  problems: string[];
}

export interface Scores {
  items: ItemResult[];
  closures: ClosureResult[];
  recall: { found: number; expected: number; value: number };
  wrongCloses: string[];
  closeRate: { closed: number; likely: number; settled: number; value: number };
  clicksLeft: number;
  extraItems: number;
  calls: number;
  knownGaps: Array<{ caseId: string; what: string; gap: string; status: 'still failing' | 'flip: now passes' }>;
}

export function judgeClosure(run: CaseRun, cl: GoldenClosure): ClosureResult {
  const state = finalState(run, cl.item);
  const problems: string[] = [];
  if (state === 'missing') problems.push(`item ${cl.item} never became an item (${run.why.get(cl.item) ?? 'unknown'})`);
  else if (state !== cl.expect) problems.push(`ended ${state}, expected ${cl.expect}`);
  if (cl.cite && (cl.expect === 'closed' || cl.expect === 'likely') && state !== 'missing' && !citedSources(run, cl.item).includes(cl.cite)) problems.push(`completion evidence does not cite ${cl.cite} (cites ${citedSources(run, cl.item).join(', ') || 'nothing'})`);
  if (cl.reopened && !wasReopened(run, cl.item)) problems.push('never closed then reopened');
  return { caseId: run.case.id, closure: cl, state, pass: problems.length === 0, problems };
}

export function score(runs: CaseRun[]): Scores {
  const items: ItemResult[] = [];
  const closures: ClosureResult[] = [];
  for (const run of runs) {
    for (const it of run.case.items_expected) items.push({ caseId: run.case.id, item: it, found: run.itemIds.has(it.id), ...(run.itemIds.has(it.id) ? {} : { why: run.why.get(it.id) }) });
    for (const cl of run.case.closures_expected) closures.push(judgeClosure(run, cl));
  }
  const gated = items.filter((i) => !i.item.knownGap);
  const found = gated.filter((i) => i.found).length;
  const wrongCloses = closures.filter((c) => !c.closure.knownGap && c.closure.class === 'still_owed' && c.state === 'closed').map((c) => `${c.caseId}/${c.closure.item}`);
  const settled = closures.filter((c) => !c.closure.knownGap && c.closure.class === 'settled');
  const closed = settled.filter((c) => c.state === 'closed').length;
  const extraItems = runs.reduce((n, r) => n + r.extraItems.length, 0);
  let clicks = extraItems + items.filter((i) => !i.found).length;
  for (const c of closures) {
    if (c.state === 'missing') continue; // the missed item was already counted
    if (c.closure.class === 'settled' && c.state !== 'closed') clicks += 1;
    if (c.closure.class === 'still_owed' && c.state === 'closed') clicks += 1;
  }
  const knownGaps: Scores['knownGaps'] = [
    ...items.filter((i) => i.item.knownGap).map((i) => ({ caseId: i.caseId, what: `item ${i.item.id}`, gap: i.item.knownGap!, status: i.found ? ('flip: now passes' as const) : ('still failing' as const) })),
    ...closures.filter((c) => c.closure.knownGap).map((c) => ({ caseId: c.caseId, what: `closure ${c.closure.item}`, gap: c.closure.knownGap!, status: c.pass ? ('flip: now passes' as const) : ('still failing' as const) })),
  ];
  return {
    items,
    closures,
    recall: { found, expected: gated.length, value: gated.length ? found / gated.length : 1 },
    wrongCloses,
    closeRate: { closed, likely: settled.filter((c) => c.state === 'likely').length, settled: settled.length, value: settled.length ? closed / settled.length : 1 },
    clicksLeft: clicks,
    extraItems,
    calls: runs.reduce((n, r) => n + r.calls, 0),
    knownGaps,
  };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** The table printed at the end of the eval run. */
export function renderTable(s: Scores, o: { title?: string; extra?: Array<[string, string, string, string]> } = {}): string {
  const rows: Array<[string, string, string, string]> = [
    ['item recall (golden asks)', `${s.recall.found}/${s.recall.expected} = ${s.recall.value.toFixed(2)}`, `>= ${RECALL_GATE}`, s.recall.value >= RECALL_GATE ? 'PASS' : 'FAIL'],
    ['wrong closes (still owed)', String(s.wrongCloses.length), `= ${WRONG_CLOSE_GATE}`, s.wrongCloses.length <= WRONG_CLOSE_GATE ? 'PASS' : 'FAIL'],
    ['close rate (settled)', `${s.closeRate.closed}/${s.closeRate.settled} = ${pct(s.closeRate.value)} (+${s.closeRate.likely} likely)`, 'tracked', '-'],
    ['clicks left', String(s.clicksLeft), 'tracked', '-'],
    ['extra items', String(s.extraItems), 'tracked', '-'],
    ['model calls (cassette)', String(s.calls), 'tracked', '-'],
    ...(o.extra ?? []),
  ];
  const w = [27, 34, 9, 5];
  const line = (r: string[]) => `| ${r.map((c, i) => pad(c, w[i]!)).join(' | ')} |`;
  const sep = `|${w.map((n) => '-'.repeat(n + 2)).join('|')}|`;
  const out = ['', o.title ?? 'Scanner evals (golden cases, cassette model)', line(['score', 'value', 'gate', '']), sep, ...rows.map(line)];
  const gaps = s.knownGaps;
  if (gaps.length) {
    out.push('', 'Known gaps (recorded, not gated):');
    for (const g of gaps) out.push(`  ${pad(g.gap, 7)} ${pad(`${g.caseId} ${g.what}`, 44)} ${g.status}`);
  }
  const fails = [...s.items.filter((i) => !i.found && !i.item.knownGap).map((i) => `${i.caseId} item ${i.item.id}: missing (${i.why ?? '?'})`), ...s.closures.filter((c) => !c.pass && !c.closure.knownGap).map((c) => `${c.caseId} closure ${c.closure.item}: ${c.problems.join('; ')}`)];
  if (fails.length) out.push('', 'Failing expectations:', ...fails.map((f) => `  ${f}`));
  return out.join('\n');
}
