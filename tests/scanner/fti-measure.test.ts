/**
 * Measurement for FTI: the report's per-mode yield ($ per item found, fti vs agentic), the first scan's per-source
 * progress (ledger counters, the progress line, Health's rows), and the pass rows' skill keys.
 */
import { describe, expect, it } from 'vitest';

import type { YieldCall } from '@/engines/spend-audit/yield';
import { renderModeYield, yieldByMode } from '@/scanner/interpret/yield-mode';
import { FirstScan, firstScanProgressLine, MemoryFirstScanLedger } from '@/scanner/runtime/first-scan';
import { passSkill } from '@/scanner/trace/queries';
import { firstScanSources } from '@/server/datasource/db/scan-cadence';

const call = (skill: string, runId: string, usd: number): YieldCall => ({ skill, connector: 'slack', usd, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outcome: null, runId, turns: 1, longTierRequests: 0, itemsOut: 0, itemsIn: 1, escalationChangedItems: null });

describe('scan:report --yield by scan mode', () => {
  it('splits runs by what they booked and prices an item found in each mode', () => {
    const calls = [call('relay:slack:slack_search_public_and_private', 'r1', 0.0002), call('classify-items', 'r1', 0.0008), call('scan-slack', 'r2', 0.008), call('triage-slack', 'r2', 0.002), call('scan-gmail', 'r3', 0.01)];
    const rows = yieldByMode(calls, [{ id: 'r1', changed: 3, found: 2, closed: 1 }, { id: 'r2', changed: 3, found: 2, closed: 0 }, { id: 'r3', changed: 1, found: 0, closed: 0 }]);
    expect(rows).toEqual([
      { mode: 'fti', runs: 1, calls: 2, usd: 0.001, found: 2, closed: 1, usdPerItem: 0.0005 },
      { mode: 'agentic', runs: 2, calls: 3, usd: 0.02, found: 2, closed: 0, usdPerItem: 0.01 },
    ]);
    expect(renderModeYield(rows)).toContain('fti/agentic $/item 0.05×');
  });
  it('an FTI pass row books on the skill its name carries; triage and the traversal as before', () => {
    expect(passSkill('classify:classify-items', 'scan-slack')).toBe('classify-items');
    expect(passSkill('reclassify:classify-items', 'scan-slack')).toBe('classify-items');
    expect(passSkill('fetch:relay:slack:slack_search_public_and_private', 'scan-slack')).toBe('relay:slack:slack_search_public_and_private');
    expect(passSkill('triage', 'scan-slack')).toBe('triage-slack');
    expect(passSkill('traversal', 'scan-slack')).toBe('scan-slack');
  });
});

describe('first-scan progress per source', () => {
  it('adds up each first-scan run of a source and says it in one line', () => {
    const fs = new FirstScan({ lookbackDays: 30, budgetUsd: 5, connectors: ['slack', 'gmail'] }, new MemoryFirstScanLedger());
    fs.claim('slack', 'slack:inbox', false, new Date('2026-11-06T00:00:00.000Z'));
    fs.noteProgress('slack', { read: 1_000, found: 20, linked: 4, usd: 0.3 });
    const p = fs.noteProgress('slack', { read: 240, found: 11, linked: 2, usd: 0.12 });
    expect(p).toMatchObject({ read: 1_240, found: 31, linked: 6, runs: 2 });
    expect(p.line).toBe('Slack: 1,240 messages read, 31 asks found, $0.42 so far');
    expect(firstScanProgressLine('gmail', { read: 1, found: 1, linked: 0, usd: 0, runs: 1 })).toBe('Gmail: 1 emails read, 1 ask found, $0.00 so far');
    expect(firstScanSources(fs.state()!.sources)).toEqual([{ connector: 'slack', itemsRead: 1_240, asksFound: 31, linked: 6, spentUsd: 0.42, runs: 2, line: 'Slack: 1,240 messages read, 31 asks found, $0.42 so far' }]);
    expect(firstScanSources(undefined)).toBeUndefined();
  });
});
