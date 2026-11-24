/**
 * The process crash-resume.test.ts kills: the drill worker (crash-drill.ts) runs the three-page scan and SIGKILLs
 * itself at DRILL_POINT on DRILL_PAGE. Run with `node --import tsx tests/db/worker/crash-child.ts`.
 * Env: DATABASE_URL (a control_center_* test database), DRILL_USER, DRILL_STANDING, DRILL_POINT, DRILL_PAGE, DRILL_WORKER_ID, DRILL_RUNNER (fti: the real FTI runner; agentic: the real Agent SDK runner over a fake SDK).
 */
import { createDb } from '@/db/client';
import { installDbTraceSink } from '@/scanner/trace';

import { drillWorker, killAt, type DrillPoint } from './crash-drill';

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (!/\/control_center_[a-z0-9_]+$/.test(url)) throw new Error('crash-child: DATABASE_URL must be a control_center_* test database');
  const h = createDb({ url, max: 4, applicationName: 'crash-drill-child' });
  installDbTraceSink(h.db, { flushMs: 50 });
  const d = drillWorker({
    db: h.db,
    userId: process.env.DRILL_USER!,
    standingItemId: process.env.DRILL_STANDING!,
    workerId: process.env.DRILL_WORKER_ID,
    fault: killAt(process.env.DRILL_POINT as DrillPoint, Number(process.env.DRILL_PAGE ?? 1)),
    ...(process.env.DRILL_RUNNER === 'fti' || process.env.DRILL_RUNNER === 'agentic' ? { runner: process.env.DRILL_RUNNER as 'fti' | 'agentic' } : {}),
  });
  await d.enqueueWindow();
  await d.drain();
  // not killed: the point was never reached (the test fails on exit code 0)
  await h.close();
}

main().catch((err: unknown) => {
  console.error(`crash-child: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  process.exit(2);
});
