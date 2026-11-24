/**
 * Assemble the private report (<stress>/reports/REPORT.md) and print the sanitized tables for docs/archive/2026-build/STRESS.md:
 * per-scenario invariant results, spend, and accuracy (score-*.json). The sanitized part carries counts,
 * percentages and check names only, never content, names or ids.
 *   npx tsx scripts/stress/report.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { spendSummary } from './lib/ledger';
import { privDir, readJson, writePriv } from './lib/paths';

interface Inv {
  name: string;
  ok: boolean;
  info?: boolean;
  detail: string;
}

function scenarioRows() {
  const runs = privDir('runs');
  const out: Array<{ name: string; pass: number; fail: number; info: number; failed: string[]; costUsd: number; ms?: number }> = [];
  for (const d of fs.readdirSync(runs).sort()) {
    const f = path.join(runs, d, 'result.json');
    if (!fs.existsSync(f)) continue;
    const r = readJson<{ invariants: Inv[]; costUsd: number; ms?: number }>(f);
    out.push({
      name: d,
      pass: r.invariants.filter((i) => i.ok && !i.info).length,
      fail: r.invariants.filter((i) => !i.ok && !i.info).length,
      info: r.invariants.filter((i) => i.info).length,
      failed: r.invariants.filter((i) => !i.ok && !i.info).map((i) => i.name),
      costUsd: r.costUsd,
      ms: r.ms,
    });
  }
  return out;
}

function scores() {
  const dir = privDir('reports');
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('score-') && f.endsWith('.json'))
    .sort()
    .map((f) => readJson<Record<string, unknown>>(path.join(dir, f)));
}

function main() {
  const rows = scenarioRows();
  const spend = spendSummary();
  const sc = scores();
  const lines: string[] = ['# Stress campaign: private report', '', `Generated ${new Date().toISOString()}.`, '', '## Scenarios', '', '| Scenario | Pass | Fail | Info | Cost | Failed checks |', '|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.name} | ${r.pass} | ${r.fail} | ${r.info} | $${r.costUsd.toFixed(3)} | ${r.failed.join('; ')} |`);
  lines.push('', '## Spend', '', '```json', JSON.stringify(spend, null, 1), '```', '', '## Accuracy', '');
  for (const s of sc) {
    lines.push(`### ${String(s.label)}`, '', '```json', JSON.stringify({ ...s, falseNegatives: undefined, falsePositives: undefined }, null, 1), '```', '');
  }
  writePriv(path.join(privDir('reports'), 'REPORT.md'), lines.join('\n'));
  // Sanitized: numbers and check names only.
  console.log('SCENARIOS');
  for (const r of rows) console.log(`| ${r.name} | ${r.pass} | ${r.fail} | ${r.info} | $${r.costUsd.toFixed(2)} |`);
  console.log(`SPEND total=$${spend.totalUsd.toFixed(2)} ${JSON.stringify(Object.fromEntries(Object.entries(spend.byKind).map(([k, v]) => [k, Number(v.toFixed(2))])))}`);
  for (const s of sc) {
    const a = s as { label: string; recall: number; precision: number; adjudicated: { recall: number; precision: number }; crossSource: { accuracy: number; n: number }; recallBySource: Record<string, { n: number; recall: number }>; precisionByConnector: Record<string, { n: number; precision: number }>; recallByKind: Record<string, { n: number; recall: number }>; roles: Record<string, { correct: number; misassigned: number; missed: number }> };
    console.log(`SCORE ${a.label}: recall ${a.recall}% precision ${a.precision}% | adjudicated recall ${a.adjudicated.recall}% precision ${a.adjudicated.precision}% | cross-source ${a.crossSource.accuracy}% of ${a.crossSource.n}`);
    console.log(`  recallBySource ${JSON.stringify(a.recallBySource)}`);
    console.log(`  recallByKind ${JSON.stringify(a.recallByKind)}`);
    console.log(`  precisionByConnector ${JSON.stringify(a.precisionByConnector)}`);
    console.log(`  roles ${JSON.stringify(a.roles)}`);
  }
}

main();
