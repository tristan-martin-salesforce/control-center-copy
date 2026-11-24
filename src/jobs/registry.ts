/**
 * Job handler registry: handlers register by `jobs.kind`, each on one queue. The worker builds one
 * concurrency pool per queue (docs/reference/WORKER.md "Pools").
 *
 * Kinds shipped by BE-1a:
 *   scan.<connector>, scan.reconcile    BE-2a ScannerRuntime.executeJob (deterministic + traversal scans, reconcile)
 *   retention.scrub                     90-day body retention + audit-image / revision scrub (implemented)
 *   backup.nightly                      pg_dump via scripts/ops/lib/backup.mjs when due (implemented)
 *   reevaluate                          BE-3 re-evaluation (stub: logs "not yet wired"; generation fence enforced by the worker)
 *   nba.generate, activity.sync, missed_opps.sweep  stubs for BE-4/BE-5 (the worker wires activity.sync)
 *   brief.generate                      BE-5 watched-channel briefs (src/jobs/handlers/brief.ts)
 */
import type { JobHandler, JobHandlerDef } from './types';

export const QUEUES = {
  scan: (connector: string) => `scan.${connector}`,
  reconcile: 'scan.reconcile',
  engine: 'engine',
  nba: 'nba',
  brief: 'brief',
  maintenance: 'maintenance',
} as const;

export class JobRegistry<S = unknown> {
  private readonly defs = new Map<string, JobHandlerDef<S>>();

  register(def: JobHandlerDef<S>): this {
    this.defs.set(def.kind, def);
    return this;
  }

  /** Replace a stub with a real handler (BE-3/BE-4/BE-5 plug in here). */
  wire(kind: string, handler: JobHandler<S>, description?: string): this {
    const cur = this.defs.get(kind);
    if (!cur) throw new Error(`no job kind ${kind} to wire`);
    this.defs.set(kind, { ...cur, handler, wired: true, description: description ?? cur.description });
    return this;
  }

  get(kind: string): JobHandlerDef<S> | undefined {
    return this.defs.get(kind);
  }

  isWired(kind: string): boolean {
    return this.defs.get(kind)?.wired === true;
  }

  kinds(): string[] {
    return [...this.defs.keys()].sort();
  }

  queues(): string[] {
    return [...new Set([...this.defs.values()].map((d) => d.queue))].sort();
  }

  all(): JobHandlerDef<S>[] {
    return [...this.defs.values()];
  }
}

/** Stub: logs once per run and succeeds, so the queue never retries or dead-letters it. */
export function notWired<S>(kind: string, owner: string): JobHandler<S> {
  return async (ctx) => {
    ctx.log(`${kind}: not yet wired (${owner})`, { jobId: ctx.job.id });
    return { notWired: true, owner };
  };
}
