/** Job kinds, handlers and queue operations (docs/reference/WORKER.md). */
import type { ConnectorId } from '@/scanner/types';

import { backupHandler, type BackupLib } from './handlers/backup';
import { briefJobDef } from './handlers/brief';
import { completionJobDef } from './handlers/completion';
import { readInJobDef } from './handlers/readin';
import { retentionHandler } from './handlers/retention';
import { dataRetentionHandler, DATA_RETENTION_KIND } from './handlers/data-retention';
import { vdpAssetsJobDef } from './handlers/vdp-assets';
import { forecastJobDefs } from './handlers/forecast-sync';
import { vdpAesJobDef } from './handlers/vdp-specialist-aes';
import { hierarchyJobDef } from './handlers/account-hierarchy';
import { vdpIdentityJobDef } from './handlers/vdp-identity';
import { enrichJobDef } from './handlers/enrich';
import { activityNotesJobDef } from './handlers/activity-notes';
import { activitySuggestJobDef } from './handlers/activity-suggest';
import { org62DiscoverJobDef } from './handlers/org62-discover';
import { oppEngagementJobDef } from './handlers/opp-engagement';
import { dcSuggestJobDef } from './handlers/dc-suggest';
import { extractUseCasesJobDef } from './handlers/use-cases-extract';
import { hygieneJobDef } from './handlers/hygiene';
import { org62ReadbackJobDef } from './handlers/org62-readback';
import { toolRunJobDef } from './handlers/tool-run';
import { doctorJobDef } from './handlers/doctor';
import { updateCheckJobDef } from './handlers/update-check';
import { kvBackfillJobDef } from './handlers/kv-backfill';
import { JobRegistry, notWired, QUEUES } from './registry';
import { reauthHandler, scanHandler, type ReauthStarter, type ScanHandlerDeps } from './scan';

export * from './types';
export * from './registry';
export * from './queue-ops';
export * from './runtime-queue';
export * from './scan';
export { runRetentionScrub, retentionHandler, scrubImage, SCRUBBED, RETENTION_MARKER, type RetentionResult } from './handlers/retention';
export { compactLedger, RETENTION_HORIZONS, runTableRetention, type TableRetentionResult } from './handlers/retention-tables';
export { backupHandler, loadBackupLib, type BackupLib } from './handlers/backup';

export const SCAN_CONNECTORS: ConnectorId[] = ['slack', 'org62', 'gmail', 'calendar', 'drive', 'gemini_notes', 'claude_sessions', 'trainings', 'watch', 'vdp'];

export interface DefaultRegistryDeps {
  /** The ScannerRuntime wiring. Without it, scan kinds are "not yet wired" stubs. */
  scan?: ScanHandlerDeps;
  backup?: { lib?: () => Promise<BackupLib>; dbName?: string };
  /** Health ▸ re-auth: start the connector's sign-in before re-probing (the worker passes src/reauth/run.ts). */
  reauth?: ReauthStarter;
}

export function createDefaultRegistry(deps: DefaultRegistryDeps = {}): JobRegistry {
  const r = new JobRegistry();
  const scan = deps.scan ? scanHandler(deps.scan) : undefined;
  for (const c of SCAN_CONNECTORS) {
    r.register({ kind: `scan.${c}`, queue: QUEUES.scan(c), wired: !!scan, description: `${c} scan (ScannerRuntime.executeJob)`, handler: scan ?? notWired(`scan.${c}`, 'BE-2a runtime') });
  }
  r.register({ kind: 'scan.reconcile', queue: QUEUES.reconcile, wired: !!scan, description: 'reconcile passes (coverage gaps, unlinked, stale, skill upgrades)', handler: scan ?? notWired('scan.reconcile', 'BE-2a runtime') });
  // Health "Re-auth" (DB DataSource enqueues it on the default queue; the maintenance pool drains `default`).
  r.register({ kind: 'connector.reauth', queue: QUEUES.maintenance, wired: !!deps.scan, description: 'resume a connector after re-auth', handler: deps.scan ? reauthHandler(deps.scan, deps.reauth) : notWired('connector.reauth', 'BE-2a runtime') });
  r.register({ kind: 'reevaluate', queue: QUEUES.engine, wired: false, description: 'work item re-evaluation (status, NBA, priority, draft)', handler: notWired('reevaluate', 'BE-3') });
  // B-058: a job whose work item is gone (an Undo removed the sibling) succeeds as skipped; the rest reach the BE-4
  // stub. The guard lives in src/jobs/handlers/nba.ts, loaded on first run.
  r.register({ kind: 'nba.generate', queue: QUEUES.nba, wired: false, description: 'next best action generation', handler: async (ctx) => (await import('./handlers/nba')).nbaGenerateHandler()(ctx) });
  // BE-5 watched-channel briefs (src/jobs/handlers/brief.ts): the 07:30 schedule and its own follow-ups enqueue it.
  r.register(briefJobDef());
  r.register({ kind: 'activity.sync', queue: QUEUES.maintenance, wired: false, description: 'activity logging + canvas sync', handler: notWired('activity.sync', 'BE-5') });
  r.register({ kind: 'missed_opps.sweep', queue: QUEUES.maintenance, wired: false, description: 'Org62 missed-opportunity sweep', handler: notWired('missed_opps.sweep', 'BE-5') });
  r.register({ kind: 'retention.scrub', queue: QUEUES.maintenance, wired: true, description: '90-day body retention + audit image scrub + table retention (jobs, scan runs, health checks, LLM rollups)', handler: retentionHandler });
  r.register({ kind: DATA_RETENTION_KIND, queue: QUEUES.maintenance, wired: true, description: 'retention policy: llm text, scan trace, resolved events, orphan source items, jobs, priority runs, backups', handler: dataRetentionHandler() });
  r.register({ kind: 'backup.nightly', queue: QUEUES.maintenance, wired: true, description: 'nightly pg_dump when due', handler: backupHandler(deps.backup) });
  r.register(readInJobDef()); // BE-READIN: queue `readin`, concurrency 1 (src/jobs/handlers/readin.ts)
  // CMP-1: completion pass, queue `completion`, concurrency 1; enqueued by the scan afterRun hook (src/worker/scanning.ts).
  r.register(completionJobDef());
  // Time ▸ VDP "Find assets": queue `vdp`, concurrency 1; enqueued by findVdpAssets (db DataSource) and the Assistant.
  r.register(vdpAssetsJobDef());
  for (const d of forecastJobDefs()) r.register(d); // lane A: forecast.sync + forecast.draft, queue `forecast` (skip when the persona feature is off)
  r.register(vdpAesJobDef()); // D-63: the VDP AEs from the Specialist Forecasts of my 100%-DC opps (fixed SOQL, read-only), queue `vdp`
  r.register(hierarchyJobDef()); // D-69: the Org62 account hierarchy up to five levels (fixed SOQL, read-only), queue `vdp`
  r.register(vdpIdentityJobDef()); // D-69: the company-identity judgment for the ambiguous ones (Haiku, capped), queue `vdp`
  // HYG-1: capture enrichment (deterministic), tool runs (ended clearly: no runner in this build), the Org62 read-back
  // reconcile (my logged Events and DCs by Id), and the daily dead-data sweep (it reads this registry's kinds at run time)
  r.register(enrichJobDef());
  r.register(toolRunJobDef());
  r.register(org62ReadbackJobDef());
  r.register(hygieneJobDef({ kinds: () => r.kinds() }));
  // D-66: the cheap model's Org62 Description note where meeting notes exist (queued by the worker's activity.notes hook)
  r.register(activityNotesJobDef());
  r.register(activitySuggestJobDef()); // Time: the model's opportunity suggestion for rows the rules can't place (handle: the worker's configureActivitySuggest)
  r.register(doctorJobDef()); // 11 R6: the setup checks every 15 min and after start (src/jobs/handlers/doctor.ts)
  // the attribution engine (src/engines/attribution): Org62 discovery (fixed SOQL, read-only), the engagement rollup, the DC suggestion batch
  r.register(org62DiscoverJobDef());
  r.register(oppEngagementJobDef());
  r.register(dcSuggestJobDef());
  r.register(updateCheckJobDef()); // D-90: the daily read of the release feed in the shared Drive folder (src/jobs/handlers/update-check.ts)
  r.register(extractUseCasesJobDef()); // use cases to add (src/engines/use-cases): notes, meetings, Slack, mail → candidates
  r.register(kvBackfillJobDef()); // D-98 / 0036: kv side-car → columns (idempotent, chunked, resumable)
  return r;
}
