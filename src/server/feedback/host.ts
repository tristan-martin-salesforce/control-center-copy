/**
 * What the feedback routes need from a DataSource (D-56). Both implement it (src/server/datasource/{mock,db}/index.ts,
 * one small adapter each); everything else is shared, so the mock and db answer alike (parity).
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ActionDestination, Draft } from '@/contract';
import type { DataSource } from '@/server/datasource/types';

import type { DiagnoseAgent } from './agent';
import type { TeamConfig } from './channel';
import type { ScrubTerms } from './scrub';
import type { SpendGovernor } from '@/llm/spend';

export interface FeedbackSpend {
  model: string;
  skill: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  ok: boolean;
  errorCode?: string;
  latencyMs: number;
  /** D0: hash of the model, skill and the run's prompt (never the prompt). */
  contentHash: string;
}

export interface FeedbackHost {
  /** The DataSource itself: every read (settings, event log, jobs, health, scans, trace, pages), preview and reject. */
  ds: DataSource;
  now(): Date;
  /** Every name and id the database knows (accounts, people, opps, identities). */
  terms(): Promise<ScrubTerms>;
  /** The user's display name (the reporter line keeps the first name only). */
  me(): Promise<string>;
  /** Save the action as one ready Outbox item (mode send) in an audited change set. */
  insertAction(dest: ActionDestination, audit: { action: string; summary: string }): Promise<{ draft: Draft; auditId: string | null }>;
  /** What the agent may spend now (the Assistant line, the global hard cap); null: no agent. */
  budget(): Promise<{ capUsd: number; note: string | null }>;
  recordSpend(s: FeedbackSpend): Promise<void>;
  /** The real diagnose agent, or null (mock, Assistant LLM off): the deterministic report runs instead. */
  agent: DiagnoseAgent | null;
  /** F-4: the spend governor (the run holds its estimate and asks past it). Absent: the per-report cap is the line. */
  spend?: () => Promise<SpendGovernor | null>;
  /** Tests: config/team.json. */
  team?: () => TeamConfig;
  /** The repo folder the agent reads (default: the server's working directory). */
  repoRoot?: string;
  /**
   * PKG-8: whether this is a live install, so the Diagnostics block carries the doctor's report and the log tail.
   * Default: the db DataSource is, the mock is not.
   */
  live?: () => Promise<boolean>;
}

let pkgVersion: string | null = null;

/** package.json's version (the server's build until lane E's version route exists). */
export function serverVersion(root = process.cwd()): { version: string; sha: string | null } {
  if (pkgVersion === null) {
    try {
      pkgVersion = String((JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown }).version ?? '');
    } catch {
      pkgVersion = '';
    }
  }
  const sha = process.env.CC_GIT_SHA ?? process.env.NEXT_PUBLIC_CC_GIT_SHA ?? null;
  return { version: pkgVersion, sha: sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null };
}
