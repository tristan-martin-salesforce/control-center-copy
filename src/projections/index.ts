/**
 * Projections: what the scanner stored (source items) → the domain rows the pages read. See run.ts for the tick
 * and the per-source mappers (calendar.ts, org62.ts, sessions.ts, assets.ts, activity.ts) for the rules.
 */
import { runProjections } from './run';
import type { ProjectionStore } from './run.store';

export { runProjections, PROJECTIONS_VERSION, STATE_KEY, type ProjectionResult, type ProjectionStore } from './run';
export { projectCalendarEvent, resolveCalendarItems } from './calendar';
export { projectOrg62, oppsInBook } from './org62';
export { projectClaudeSession } from './sessions';
export { planWeek } from './activity';
export { Matcher } from './matching';

/**
 * The worker's tick hook (src/worker/index.ts): one projection pass per minute; a pass with nothing new is a read. The
 * worker passes the store (`projectionStore(db)`, src/server/datasource/db/store/projections.run.ts).
 */
export function projectionsHook(store: ProjectionStore, userId: string, log: (msg: string, detail?: Record<string, unknown>) => void, everyMs = 60_000) {
  return { name: 'projections', everyMs, run: async (now: Date) => void (await runProjections({ store, userId, now, log })) };
}
