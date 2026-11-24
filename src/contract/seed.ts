/**
 * The mock seed file: the full store contents plus an optional scenario.
 *
 * Loaded from ~/Library/Application Support/command-center/fixtures/seed.json (real data, outside the repo,
 * owned by the SEED lane) or the committed placeholder src/mock/seed.example.json.
 *
 * Time handling: every timestamp is authored relative to `meta.asOf` (the seed's "now"). On load the mock
 * shifts all instants and dates by whole days so `asOf` lands on today, keeping times of day. The mock
 * clock then starts at asOf's time of day (override with CC_MOCK_NOW=real|<ISO>|HH:MM).
 */
import { z } from 'zod';
import { AgentRun, ToolRun } from './agents';
import { Brief, WatchSubscription } from './briefs';
import { CalendarEvent, SpineSlot } from './calendar';
import { ChatThreadDetail } from './chat';
import { Id, IsoDateTime } from './common';
import { Account, MissedOpp, Opportunity } from './deals';
import { ScenarioEvent } from './dev';
import { AuditEntry } from './envelope';
import { Connector, EventLogEntry, Job, ScanRun, SpendSummary } from './health';
import { Draft, NbaCard } from './nba';
import { PolicyVersion, Settings } from './settings';
import { ActivityEntry, TimelineBlock } from './time';
import { ToolAdapterSeedRow } from './tools-view';
import { MappingQuestion } from './views';
import { Asset, Evidence, Initiative, Person, Proposal, WorkItemRecord } from './work';

export const SeedMeta = z.object({
  schemaVersion: z.literal(1),
  label: z.string(), // "placeholder example" / "real fixture 2026-11-05"
  /** The seed's "now". */
  asOf: IsoDateTime,
  /** When the user was last active (drives "Since you left"). */
  lastActiveAt: IsoDateTime,
  timezone: z.string(),
  user: z.object({ id: Id, name: z.string(), email: z.string() }),
  /** loggedH = hours already logged this quarter BEFORE the seeded week's activity entries. */
  quarter: z.object({ label: z.string(), targetH: z.number(), due: IsoDateTime, loggedH: z.number().default(0) }),
  canvas: z.object({ label: z.string(), lastSyncedAt: IsoDateTime.nullable(), rowsChangedSince: z.number().int() }),
  /** Absolute repo folder used in claude://code/new links (defaults to process.cwd()). */
  repoFolder: z.string().optional(),
});
export type SeedMeta = z.infer<typeof SeedMeta>;

export const Seed = z.object({
  meta: SeedMeta,
  people: z.array(Person),
  accounts: z.array(Account),
  opps: z.array(Opportunity),
  missedOpps: z.array(MissedOpp),
  initiatives: z.array(Initiative),
  workItems: z.array(WorkItemRecord),
  evidence: z.array(Evidence),
  nbas: z.array(NbaCard),
  drafts: z.array(Draft),
  proposals: z.array(Proposal).default([]),
  assets: z.array(Asset),
  calendar: z.object({ events: z.array(CalendarEvent), slots: z.array(SpineSlot) }),
  agentRuns: z.array(AgentRun),
  /** Legacy manifest rows in the file; the ToolAdapter view after parsing (tools-view.ts). */
  toolAdapters: z.array(ToolAdapterSeedRow),
  toolRuns: z.array(ToolRun),
  activity: z.array(ActivityEntry),
  /** Extra Time-page lanes (Claude sessions, Drive edits, Slack bursts). Meetings come from calendar + activity. */
  timeBlocks: z.array(TimelineBlock.extend({ lane: z.enum(['focus', 'claude', 'drive', 'slack']) })).default([]),
  briefs: z.array(Brief),
  watches: z.array(WatchSubscription),
  connectors: z.array(Connector),
  scanRuns: z.array(ScanRun),
  jobs: z.array(Job),
  eventLog: z.array(EventLogEntry),
  spend: SpendSummary,
  settings: Settings,
  policyVersions: z.array(PolicyVersion),
  chatThreads: z.array(ChatThreadDetail),
  mappings: z.array(MappingQuestion).default([]),
  /** Historical audit entries (overnight engine closes etc.). Seeded entries are display-only unless the mock can derive an inverse. */
  audit: z.array(AuditEntry).default([]),
  scenario: z.array(ScenarioEvent).optional(),
});
export type Seed = z.infer<typeof Seed>;
export type SeedInput = z.input<typeof Seed>;
