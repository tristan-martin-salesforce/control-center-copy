/**
 * The private overlay contract. The overlay file itself (curated narrative: work items, drafts, briefs,
 * rank reasons, scenario targets) lives OUTSIDE the repo at
 *   ~/Library/Application Support/command-center/fixtures/overlay.mjs
 * and is never committed. This file only describes its shape (no data).
 */
import type { docFromText } from '../../src/server/datasource/mock/render';
import type { AccountRule, AcctOf, Raw } from './mappers';
import type { DraftIn, EventIn, EvidenceIn, In, NbaIn, SourceRefIn, WorkItemIn } from './lib';

/** Helpers the builder hands to the overlay (so the overlay needs no imports). */
export interface OverlayCtx {
  NOW: string;
  ME: { id: string; name: string; email: string };
  raw: Raw;
  t: (off: number, hhmm: string) => string;
  day: (off: number) => string;
  iso: (s: string) => string;
  x: (s: string | null | undefined, n?: number) => string;
  mtHM: (s: string) => string;
  mtDay: (s: string) => string;
  slug: (s: string) => string;
  acctOf: AcctOf;
  events: EventIn[];
  opps: In['opps'];
  runs: In['agentRuns'];
  /** Find a calendar event id by title regex (throws if none). */
  findEvent: (rx: RegExp) => string;
  /** Find an agent run id by session-id prefix (throws if none). */
  findRun: (sessionPrefix: string) => string;
  docFromText: typeof docFromText;
  hostSession: (sessionId: string) => string;
}

export interface DraftSpec extends Omit<DraftIn, 'doc' | 'plainText' | 'rendered' | 'createdAt' | 'updatedAt' | 'version' | 'mode' | 'userTouched'> {
  text: string;
  version?: number;
  mode?: 'draft' | 'send';
  userTouched?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type WorkSpec = Partial<WorkItemIn> & Pick<WorkItemIn, 'id' | 'kind' | 'state' | 'title' | 'why'>;
export type NbaSpec = Partial<NbaIn> & Pick<NbaIn, 'id' | 'workItemId' | 'verb' | 'primaryLabel' | 'title' | 'why'>;
/** [workItemId, role, source, at, summary, extra?] */
export type EvidenceSpec = [string, EvidenceIn['role'], SourceRefIn, string, string, Partial<EvidenceIn>?];

export interface OverlayResult {
  meta: { lastActiveAt: string; email: string; quarter: In['meta']['quarter']; canvas: In['meta']['canvas'] };
  people: In['people'];
  initiatives: In['initiatives'];
  assets: In['assets'];
  workItems: WorkSpec[];
  /** Ranked order of rankable work item ids (the Top 3 first). */
  order: string[];
  rankReasons: Record<string, { key: string; label: string; contribution: number }[]>;
  evidence: EvidenceSpec[];
  nbas: NbaSpec[];
  drafts: DraftSpec[];
  proposals: In['proposals'];
  /** Patches applied to calendar events, matched by title regex. */
  calendarPatches: { rx: RegExp; oppId?: string; accountId?: string; prep?: NonNullable<EventIn['prep']>; takeaways?: NonNullable<EventIn['takeaways']> }[];
  slots: In['calendar']['slots'];
  toolRuns: In['toolRuns'];
  toolRunAgentRuns: In['agentRuns'];
  timeBlocksExtra: In['timeBlocks'];
  briefs: In['briefs'];
  watches: In['watches'];
  chatThreads: In['chatThreads'];
  mappings: In['mappings'];
  audit: In['audit'];
  scenario: In['scenario'];
  settings: { voiceSamples: string[]; voiceStyle: string; taskCapture: string[]; watchedSources: string[]; workingHours: { start: string; end: string; days: number[] } };
}

export interface OverlayModule {
  accountRules: AccountRule[];
  oppNextSteps?: Record<string, string>;
  nameFixes?: Record<string, string>;
  /** Session-id prefix → work item id. */
  sessionLinks?: Record<string, string>;
  build: (ctx: OverlayCtx) => OverlayResult;
}
