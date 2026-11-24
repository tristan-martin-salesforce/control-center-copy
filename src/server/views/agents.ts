/**
 * Agents and tools, read side (R7 step 3): the runs list with its counts, the tool adapters with recent runs.
 */
import type { AgentRun, RouteOutput } from '@/contract';

import type { ReadSource } from './source';

/** GET /agents: what needs you first, then running, failed, stale, to review, queued, done. */
export function agentsView(src: ReadSource): RouteOutput<'getAgents'> {
  const order = ['waiting_on_you', 'running', 'failed', 'stale', 'done_review', 'queued', 'done'];
  const runs = src.all('agentRuns').sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || b.updatedAt.localeCompare(a.updatedAt));
  const counts = { queued: 0, running: 0, waiting_on_you: 0, done_review: 0, done: 0, failed: 0, stale: 0 } as Record<AgentRun['state'], number>;
  for (const r of runs) counts[r.state]++;
  return { runs, counts, needsInputLink: 'claude://code/needs-input' };
}

/** GET /tools: every adapter, and the 20 latest tool runs. */
export function toolsView(src: ReadSource): RouteOutput<'getTools'> {
  return { adapters: src.all('toolAdapters'), recentRuns: src.all('toolRuns').sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, 20) };
}
