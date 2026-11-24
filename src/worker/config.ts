/**
 * Worker configuration from the environment (values are never logged).
 *
 *   DATABASE_URL         Postgres (default postgres://localhost:5432/command_center)
 *   CC_LIVE              1 = real read-only fetchers (devbar Google, Claude sessions + file watch). Default: on when
 *                        NODE_ENV=production (launchd), off otherwise, so `npm run dev` in a lane never scans.
 *   CC_SCAN_LLM          1 = Haiku skill linking + Slack/Org62 traversal. Default like CC_LIVE. Off: deterministic
 *                        scans still record items/coverage/cursors and flag new items `deferred:` for reconcile.
 *   CC_NOTIFY            0 = no macOS notifications (default on).
 *   CC_WORKER_SOURCES    comma list to limit connectors (gmail,calendar,drive,gemini_notes,trainings,claude_sessions).
 *   CC_USER_EMAIL / CC_ME_EMAIL, CC_ME_NAME, CC_ME_ALIASES   who "me" is (default: the first active users row).
 *   CC_WORKER_RUN_FOR    seconds; stop gracefully after this long (live checks).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveDatabaseUrl } from '@/db/client';
import type { ConnectorId } from '@/scanner/types';

export interface WorkerConfig {
  databaseUrl: string;
  live: boolean;
  llm: boolean;
  notify: boolean;
  sources?: Set<ConnectorId>;
  userEmail?: string;
  userName?: string;
  meAliases: string[];
  appVersion: string;
  runForMs?: number;
}

const flag = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'on');

export function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const prod = env.NODE_ENV === 'production';
  const sources = env.CC_WORKER_SOURCES?.split(',').map((s) => s.trim()).filter(Boolean) as ConnectorId[] | undefined;
  const runFor = Number(env.CC_WORKER_RUN_FOR);
  return {
    databaseUrl: resolveDatabaseUrl(env.DATABASE_URL),
    live: flag(env.CC_LIVE, prod),
    llm: flag(env.CC_SCAN_LLM, prod),
    notify: flag(env.CC_NOTIFY, true),
    sources: sources?.length ? new Set(sources) : undefined,
    userEmail: (env.CC_USER_EMAIL ?? env.CC_ME_EMAIL)?.trim() || undefined,
    userName: env.CC_ME_NAME?.trim() || undefined,
    meAliases: (env.CC_ME_ALIASES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    appVersion: appVersion(),
    runForMs: Number.isFinite(runFor) && runFor > 0 ? runFor * 1000 : undefined,
  };
}
