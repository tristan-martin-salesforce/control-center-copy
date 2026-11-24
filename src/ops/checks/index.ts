/**
 * Every doctor check, in report order (11 R6). One file each; the CLI, GET /api/v1/doctor and the worker's
 * `doctor.checks` job run this list (src/ops/doctor.ts `runDoctor`). Maintainer-only checks skip unless CC_DEV_CHECKS=1.
 */
import { checkAgentNode, checkAgents } from './agents';
import { checkAgentsCurrent } from './agents-current';
import { checkAssets } from './assets';
import { checkBackups } from './backups';
import { checkBudget } from './budget';
import { checkClaude } from './claude';
import { checkDatabase, checkMigrations, checkPostgres } from './database';
import { checkDbCluster, checkDbMajor, checkDbUrl, checkHomebrewLeftover } from './db-cluster';
import { checkDevbar } from './devbar';
import { checkDisk } from './disk';
import { checkHeartbeat } from './heartbeat';
import { checkMcp } from './mcp';
import { checkNode } from './node';
import { checkPortOwner, checkPortRegistry, checkPorts, devOnly } from './ports';
import { checkSettingsSources } from './settings-sources';
import { checkState, checkStateFolder } from './state';
import type { Check } from './types';
import { checkVdp } from './vdp';
import { checkRelease } from './release';
import { checkUpdate } from './update';
import { checkWorkerError } from './worker-error';

export * from './types';
export * from './agents';
export * from './agents-current';
export * from './assets';
export * from './backups';
export * from './budget';
export * from './claude';
export * from './database';
export * from './db-cluster';
export * from './devbar';
export * from './disk';
export * from './heartbeat';
export * from './mcp';
export * from './node';
export * from './ports';
export * from './settings-sources';
export * from './state';
export * from './vdp';
export * from './release';
export * from './update';
export * from './worker-error';

import { checkDbSize } from '../retention-check';

export const ALL_CHECKS: Array<[string, Check]> = [
  ['node', checkNode],
  ['postgres', checkPostgres],
  ['database', checkDatabase],
  ['migrations', checkMigrations],
  ['db-cluster', checkDbCluster], // D-98: the bundled cluster's data folder
  ['db-major', checkDbMajor], // D-98: files, engine and server are all Postgres 17
  ['db-homebrew', checkHomebrewLeftover], // D-98: the 1.x Homebrew copy (move pending, kept 14 days, then removable)
  ['db-url', checkDbUrl], // D-98: a DATABASE_URL you set (report only)
  ['assets', checkAssets],
  ['claude', checkClaude],
  ['mcp', checkMcp],
  ['devbar', checkDevbar],
  ['vdp', checkVdp],
  ['ports', devOnly('ports', 'Sibling apps', checkPorts)],
  ['port-registry', devOnly('port-registry', 'Port registry (PORTS.md)', (c) => checkPortRegistry(c))],
  ['port-owner', checkPortOwner],
  ['disk', checkDisk],
  ['state', checkState],
  ['setup:state-folder', checkStateFolder], // W34-5: the migration marker (the 1.x move), read only
  ['agents', checkAgents],
  ['agent-node', checkAgentNode],
  ['release', checkRelease], // D-90: releases/current valid, files match the manifest
  ['agents-current', checkAgentsCurrent], // D-90: the agents run releases/current
  ['update', checkUpdate], // D-90: the daily update check (last run, newer version)
  ['heartbeat', checkHeartbeat],
  ['worker-error', checkWorkerError], // the heartbeat's last_error_code → its Health catalog entry and fix
  ['backups', checkBackups],
  ['budget', checkBudget],
  ['settings-sources', checkSettingsSources],
  ['db:size', checkDbSize],
  ['data:kv-fallback', (c) => import('./data').then((m) => m.checkKvFallback(c))], // D-98: rows still read from the kv side-car (DATA.KV.FALLBACK)
  ['data:read-scopes', (c) => import('./data').then((m) => m.checkReadScopes(c))], // W34-4: scope-miss fallbacks (web process only)
];

/** The checks that need no database (GET /api/v1/doctor?only=db answers with these when Postgres is down). */
export const DB_FREE_CHECKS = ['node', 'postgres', 'db-cluster', 'db-homebrew', 'db-url', 'claude', 'devbar', 'disk', 'state', 'setup:state-folder', 'heartbeat', 'worker-error', 'release', 'agents-current', 'update'];
