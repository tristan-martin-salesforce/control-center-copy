/** Agents and tools. */
import type { In, Out } from './route';

export interface AgentsSource {
  getAgents(i: In<'getAgents'>): Out<'getAgents'>;
  launchAgent(i: In<'launchAgent'>): Out<'launchAgent'>;
  answerAgent(i: In<'answerAgent'>): Out<'answerAgent'>;
  cancelAgent(i: In<'cancelAgent'>): Out<'cancelAgent'>;
  getTools(i: In<'getTools'>): Out<'getTools'>;
  startToolRun(i: In<'startToolRun'>): Out<'startToolRun'>;
  getToolRun(i: In<'getToolRun'>): Out<'getToolRun'>;
}

/**
 * A just-prepared Claude session's `lastEvent`, on both DataSources: nothing opens until the user clicks Open in
 * Claude in the review (SEC-10), so the run says what it waits for, never "Opening…".
 */
export const PREPARED_LAUNCH_EVENT = 'Prepared: review the prompt, then click Open in Claude';
