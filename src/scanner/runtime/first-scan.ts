/**
 * First-run history lookback and its one-time backfill budget (B-080).
 *
 * Before: a scope with no cursor started 24 h back (Slack, Gmail, Drive, Gemini notes) or 30 d (Org62), and the
 * resume planner never planned more than 14 d. A 90-day first scan would also have been throttled by the daily LLM
 * hard cap, stretching the backfill over weeks.
 *
 * Now, when a first-scan lookback is configured:
 *  - every listed connector's scope without a cursor plans `lookbackDays` back, from one fixed floor (the first plan's
 *    `now - lookback`), with the 14-day planner cap lifted to that floor;
 *  - the backfill runs OLDEST FIRST with no head hour (FS-ORDER), so an ask is recorded before the reply that settles it
 *    (newest first, my answer was recorded before its ask existed);
 *  - its jobs carry `budget: 'first_scan'` and spend a one-time budget instead of the daily cap: they run while the
 *    first-scan spend is under `budgetUsd`, and that spend does not count against the daily cap of regular scans;
 *  - the budget ends when every scope planned under it has no first-scan work left (`status: done`), or when it is
 *    spent (`exhausted`: the remaining chunks continue under the normal daily cap). It is never reopened.
 *
 * Configuration (env now; the onboarding screen, B-079, will write the same values). The worker defaults to a
 * 30-day first scan (DEFAULT_FIRST_SCAN_DAYS); 0 turns it off (per-connector lookback only):
 *   CC_FIRST_SCAN_LOOKBACK_DAYS=30   or worker flag --lookback-days=30
 *   CC_FIRST_SCAN_BUDGET_USD=25      or worker flag --backfill-budget=25    (a ceiling; default DEFAULT_BACKFILL_BUDGET_USD, $25)
 *   CC_FIRST_SCAN_CONNECTORS=slack,gmail,drive,gemini_notes,org62,calendar  (default: those six)
 *   CC_FIRST_SCAN_SCOPE_DAYS=slack:inbox=90,gmail:inbox=90   or --scope-days=…   (FS-DEEP: a deeper lookback for named
 *     scopes; never shorter than the lookback. The DMs, @mentions and own messages of the Slack inbox and the Gmail inbox
 *     hold the older open asks and promises, and the rest stays at the lookback. Default: none)
 * State: `<CC_STATE_DIR>/first-scan.json` (0600), so the budget survives worker restarts.
 */
import { DEFAULT_BACKFILL_BUDGET_USD } from '../../contract/onboarding';
import fs from 'node:fs';
import path from 'node:path';

import { stateDir } from '../../ops/paths';
import { stateWriteFailed } from './state-write';
import type { ConnectorId } from '../types';

const DAY = 24 * 3_600_000;

/** Calendar joined after the first live scan (FS-CAL-1): windows before its live 2-day range are record-only history. */
export const FIRST_SCAN_CONNECTORS: ConnectorId[] = ['slack', 'gmail', 'drive', 'gemini_notes', 'org62', 'calendar'];
/** The worker's first-scan lookback when nothing is configured (Tristan: "30 days … and maybe that's the default"). */
export const DEFAULT_FIRST_SCAN_DAYS = 30;
/** FS-LATE: the scopes that may join a first scan after it finished (a channel watch added later). */
const LATE_JOIN = /^slack:channel:/;

export interface FirstScanConfig {
  lookbackDays: number;
  budgetUsd: number;
  connectors: ConnectorId[];
  /** FS-DEEP: scope id (`connector:scope`) → its own lookback in days, when deeper than `lookbackDays`. */
  scopeDays?: Record<string, number>;
}

/** `slack:inbox=90,gmail:inbox=90` → `{ 'slack:inbox': 90, 'gmail:inbox': 90 }` (bad entries are dropped). */
export function parseScopeDays(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (raw ?? '').split(',')) {
    const m = /^\s*([a-z_]+:[A-Za-z0-9_:.-]+)\s*=\s*(\d+)\s*$/.exec(part);
    if (m && Number(m[2]) > 0) out[m[1]!] = Math.min(Number(m[2]), 366);
  }
  return out;
}

export interface FirstScanState {
  lookbackDays: number;
  budgetUsd: number;
  startedAt: string;
  /** Oldest instant the first scan covers (`startedAt - lookback`); fixed for the life of the first scan. */
  floorAt: string;
  /** FS-DEEP: scopes with a deeper lookback → their own floor (`startedAt - scope days`), fixed when first claimed. */
  floors?: Record<string, string>;
  spentUsd: number;
  /** Local day → first-scan spend that day (excluded from the daily cap of regular scans). */
  byDay: Record<string, number>;
  /** scope id (`connector:scope`) → pending | done. */
  scopes: Record<string, 'pending' | 'done'>;
  status: 'active' | 'done' | 'exhausted';
  /** scope id → hole re-plan rounds used (FS-2). */
  replans?: Record<string, number>;
  /** FS-LATE: channel scopes that joined after the first scan had finished → when they joined. */
  late?: Record<string, string>;
  doneAt?: string;
  exhaustedAt?: string;
  /** FTI first-scan progress per source (connector id): items read, asks and promises found, links, spend, runs. */
  sources?: Record<string, FirstScanSourceProgress>;
}

export interface FirstScanSourceProgress {
  read: number;
  found: number;
  linked: number;
  usd: number;
  runs: number;
}

const SOURCE_LABEL: Record<string, [string, string]> = {
  slack: ['Slack', 'messages'],
  gmail: ['Gmail', 'emails'],
  org62: ['Org62', 'records'],
  drive: ['Drive', 'file changes'],
  gemini_notes: ['Meeting notes', 'notes'],
  calendar: ['Calendar', 'events'],
};

/** "Slack: 1,240 messages read, 31 asks found, $0.42 so far" (data for Health; the surfaces chunk owns the copy). */
export function firstScanProgressLine(connector: string, p: FirstScanSourceProgress): string {
  const [label, noun] = SOURCE_LABEL[connector] ?? [connector, 'items'];
  const n = (x: number) => x.toLocaleString('en-US');
  return `${label}: ${n(p.read)} ${noun} read, ${n(p.found)} ask${p.found === 1 ? '' : 's'} found, $${p.usd.toFixed(2)} so far`;
}

export interface FirstScanLedger {
  load(): FirstScanState | undefined;
  save(s: FirstScanState): void;
}

function flag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

/**
 * The configured first-scan lookback, or undefined (off: per-connector `initialLookbackMs`, 14-day planner cap).
 * `defaultDays` applies when neither the flag nor the env sets one (the worker passes DEFAULT_FIRST_SCAN_DAYS; library
 * users and tests get none). `0` turns it off.
 */
export function firstScanFromEnv(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv, defaultDays?: number): FirstScanConfig | undefined {
  const days = Number(flag(argv, 'lookback-days') ?? env.CC_FIRST_SCAN_LOOKBACK_DAYS ?? defaultDays ?? '');
  if (!Number.isFinite(days) || days <= 0) return undefined;
  const budget = Number(flag(argv, 'backfill-budget') ?? env.CC_FIRST_SCAN_BUDGET_USD ?? DEFAULT_BACKFILL_BUDGET_USD);
  const list = (env.CC_FIRST_SCAN_CONNECTORS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ConnectorId[];
  const scopeDays = parseScopeDays(flag(argv, 'scope-days') ?? env.CC_FIRST_SCAN_SCOPE_DAYS);
  const lookbackDays = Math.min(days, 366);
  for (const [k, v] of Object.entries(scopeDays)) if (v <= lookbackDays) delete scopeDays[k];
  return { lookbackDays, budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 100, connectors: list.length ? list : FIRST_SCAN_CONNECTORS, ...(Object.keys(scopeDays).length ? { scopeDays } : {}) };
}

export class FileFirstScanLedger implements FirstScanLedger {
  constructor(readonly file = path.join(stateDir(), 'first-scan.json')) {}
  load(): FirstScanState | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as FirstScanState;
    } catch {
      return undefined;
    }
  }
  /** ask #14: a full disk (or a permissions change) skips the write; the state lives on in memory and the next save retries. */
  save(s: FirstScanState): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      stateWriteFailed('first-scan state', err);
    }
  }
}

export class MemoryFirstScanLedger implements FirstScanLedger {
  state?: FirstScanState;
  load() {
    return this.state ? structuredClone(this.state) : undefined;
  }
  save(s: FirstScanState) {
    this.state = structuredClone(s);
  }
}

/** The first scan's bookkeeping. Pure apart from the ledger; the runtime calls it. */
export class FirstScan {
  private s?: FirstScanState;
  constructor(
    readonly config: FirstScanConfig | undefined,
    private readonly ledger: FirstScanLedger,
  ) {
    this.s = ledger.load();
  }

  state(): FirstScanState | undefined {
    return this.s;
  }

  /** The oldest instant a scope's first scan covers: its own deeper floor (FS-DEEP), else the shared one. */
  floorFor(scopeId: string): string | undefined {
    return this.s?.floors?.[scopeId] ?? this.s?.floorAt;
  }

  /** Does a scope (no cursor, or still pending) plan under the first scan? Starts the first scan on first use. */
  claim(connector: ConnectorId, scopeId: string, hasCursor: boolean, now: Date): { floorAt: string; startedAt: string; baseFloorAt: string } | undefined {
    const c = this.config;
    if (!c || !c.connectors.includes(connector)) return undefined;
    if (!this.s) {
      // Never start a first scan for a user who already has history: only a scope with no cursor starts it.
      if (hasCursor) return undefined;
      this.s = { lookbackDays: c.lookbackDays, budgetUsd: c.budgetUsd, startedAt: now.toISOString(), floorAt: new Date(now.getTime() - c.lookbackDays * DAY).toISOString(), spentUsd: 0, byDay: {}, scopes: {}, status: 'active' };
    }
    if (this.s.status === 'done') {
      // FS-LATE: a channel watch added after the first scan finished gets the same lookback, from the day it is added,
      // under what is left of the one-time budget (before, it planned Slack's own 24 h). Only a `channel:` scope with
      // no cursor joins; thread and other targeted scopes never reopen the first scan.
      if (!LATE_JOIN.test(scopeId) || hasCursor || this.s.scopes[scopeId] || !(this.s.spentUsd < this.s.budgetUsd - 1e-9)) return undefined;
      this.s.status = 'active';
      delete this.s.doneAt;
      this.s.late = { ...(this.s.late ?? {}), [scopeId]: now.toISOString() };
      this.s.floors = { ...(this.s.floors ?? {}), [scopeId]: new Date(now.getTime() - this.s.lookbackDays * DAY).toISOString() };
    }
    const known = this.s.scopes[scopeId];
    if (known === 'done') return undefined;
    // A scope added after the first scan started (new channel) joins only if it has no cursor yet.
    if (!known && hasCursor) return undefined;
    if (!known) {
      this.s.scopes[scopeId] = 'pending';
      const deep = c.scopeDays?.[scopeId];
      if (deep && deep > this.s.lookbackDays && !this.s.floors?.[scopeId]) {
        this.s.floors = { ...(this.s.floors ?? {}), [scopeId]: new Date(Date.parse(this.s.startedAt) - deep * DAY).toISOString() };
      }
      this.ledger.save(this.s);
    }
    const late = this.s.late?.[scopeId];
    if (late) return { floorAt: this.floorFor(scopeId)!, startedAt: late, baseFloorAt: this.floorFor(scopeId)! };
    return { floorAt: this.floorFor(scopeId)!, startedAt: this.s.startedAt, baseFloorAt: this.s.floorAt };
  }

  /** Would this scope plan (or keep planning) first-scan work that has budget left? Planning then ignores the daily cap. */
  eligible(connector: ConnectorId, scopeId: string): boolean {
    if (!this.config?.connectors.includes(connector)) return false;
    if (!this.s) return true;
    return this.s.status === 'active' && this.s.spentUsd < this.s.budgetUsd - 1e-9 && this.s.scopes[scopeId] !== 'done';
  }

  /** True while first-scan jobs may bypass the daily cap. */
  hasBudget(): boolean {
    return !!this.s && this.s.status === 'active' && this.s.spentUsd < this.s.budgetUsd - 1e-9;
  }

  spentOn(day: string): number {
    return this.s?.byDay[day] ?? 0;
  }

  charge(costUsd: number, day: string, now: Date): void {
    if (!this.s || !(costUsd > 0)) return;
    this.s.spentUsd += costUsd;
    this.s.byDay[day] = (this.s.byDay[day] ?? 0) + costUsd;
    if (this.s.status === 'active' && this.s.spentUsd >= this.s.budgetUsd - 1e-9) {
      this.s.status = 'exhausted';
      this.s.exhaustedAt = now.toISOString();
    }
    this.ledger.save(this.s);
  }

  /** Count one first-scan run of a source; returns its running totals and the progress line. */
  noteProgress(connector: ConnectorId, add: { read: number; found: number; linked: number; usd: number }): FirstScanSourceProgress & { line: string } {
    const cur = this.s?.sources?.[connector] ?? { read: 0, found: 0, linked: 0, usd: 0, runs: 0 };
    const next = { read: cur.read + Math.max(0, add.read), found: cur.found + Math.max(0, add.found), linked: cur.linked + Math.max(0, add.linked), usd: Math.round((cur.usd + Math.max(0, add.usd)) * 1e6) / 1e6, runs: cur.runs + 1 };
    if (this.s) {
      this.s.sources = { ...(this.s.sources ?? {}), [connector]: next };
      this.ledger.save(this.s);
    }
    return { ...next, line: firstScanProgressLine(connector, next) };
  }

  /** Hole re-plan rounds a scope has used (FS-2). */
  replans(scopeId: string): number {
    return this.s?.replans?.[scopeId] ?? 0;
  }

  noteReplan(scopeId: string): void {
    if (!this.s) return;
    this.s.replans = { ...(this.s.replans ?? {}), [scopeId]: (this.s.replans?.[scopeId] ?? 0) + 1 };
    this.ledger.save(this.s);
  }

  /** A scope has no first-scan work left. When every planned scope is done, the budget ends for good. */
  scopeDone(scopeId: string, now: Date): void {
    if (!this.s || this.s.scopes[scopeId] !== 'pending') return;
    this.s.scopes[scopeId] = 'done';
    if (Object.values(this.s.scopes).every((v) => v === 'done')) {
      this.s.status = 'done';
      this.s.doneAt = now.toISOString();
    }
    this.ledger.save(this.s);
  }
}
