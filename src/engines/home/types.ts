import type {
  Account,
  ActivityEntry,
  AgentRun,
  HomeCapacity,
  Brief,
  CalendarEvent,
  Connector,
  DealsNeed,
  Draft,
  ForecastSyncState,
  Initiative,
  MissedOpp,
  NbaCard,
  NeedDecision,
  Opportunity,
  PriorityEngineSetting,
  Proposal,
  SpecialistForecast,
  SpineSlot,
  VdpCoveragePayload,
  WorkItem,
} from '@/contract';
import type { ResolvedPersona } from '@/personas';

/**
 * Everything Home needs, as plain entity lists (the mock store and the db read model both provide them).
 * Items are hydrated WorkItems (refs carry account / initiative / meeting labels); any state is fine,
 * the engine filters.
 */
export interface HomeInput {
  /** ISO instant. */
  now: string;
  /** The user's IANA zone (profile), used for every label and "today". */
  timezone: string;
  workingHours: { start: string; end: string; days: number[] };
  /** The ≥ 2,400 px layout: 5 rows per section, 10 initiatives. */
  wide: boolean;
  /** D-55: the user's resolved persona (absent = SE, as before personas). Gap rules and checks read it. */
  persona?: ResolvedPersona;
  /**
   * `next`: plan the next working day (`nextWorkingDay(now)`). `capacity` must then be that day's: the CAPACITY
   * engine run at its working-hours start (`homeCapacityAt`). Default today.
   */
  day?: 'today' | 'next';
  items: WorkItem[];
  nbas: NbaCard[];
  drafts: Draft[];
  proposals: Proposal[];
  events: CalendarEvent[];
  slots: SpineSlot[];
  initiatives: Initiative[];
  accounts: Account[];
  opps: Opportunity[];
  missedOpps: MissedOpp[];
  /**
   * DC-31: the Deals "Log & fix" rows (getDeals `needs`, section fix: the DC gaps, set-asides already applied), so Home
   * counts exactly what Deals does. Absent: the older count of new missed-opp findings.
   */
  dcNeeds?: DealsNeed[];
  /**
   * 2026-11-13 audit C2: DC requests and VDP use cases waiting for a logging canvas (src/lib/waiting-work.ts): a Log
   * & fix row while any wait, so the section never reads "Nothing missing" over them. Absent: none known.
   */
  waitingForCanvas?: { dcs: number; useCases: number };
  activity: ActivityEntry[];
  connectors: Connector[];
  agentRuns: AgentRun[];
  briefs: Brief[];
  /** The activity-log deadline (Org62 Solutions Events). `loggedH` = hours logged before the activity rows. */
  quarter: { label: string; targetH: number; due: string; loggedH: number };
  /** The work-order canvas label ("Slackbot work-order canvas"). */
  canvasLabel: string;
  since: { changed: number; closed: number; new: number; show: boolean };
  spend: { usd: number; softBudgetUsd: number };
  dryRun: boolean;
  /**
   * The day's capacity from the CAPACITY engine (mock: `mockCapacity(store, now)`; db: `todayCapacity(model, now)`),
   * so Home and Today always show the same numbers. Home never computes its own.
   */
  capacity: HomeCapacity;
  /**
   * SETTLE-1: when you left (`cc.meta.lastActiveAt`) while Settings ▸ Closing work ▸ "Tell me what closed" is on, so
   * Home counts the engine closes since then. Null or absent: no line.
   */
  closedSince?: string | null;
  /** Lane A: the Specialist Forecast mirror and its last read (Home ▸ Log & fix forecast rows); absent = none. */
  forecast?: { records: SpecialistForecast[]; sync: ForecastSyncState; mode: 'live' | 'mock' };
  /**
   * D-59: the VDP summary (the same one Time ▸ VDP's head reads: src/engines/vdp/status.ts) and the first VDP or
   * account that needs you, for Home ▸ Log & fix's "VDPs need you" row. Absent: VDP not active or not read.
   */
  vdp?: { summary: VdpCoveragePayload['summary']; first: { key: string; label: string } | null };
  /**
   * Needs-you decisions (src/contract/needs.ts): Log & fix rows set aside with Not now (until a date) or Not needed
   * (rule `home:<gap rule>`, subject = the row id). Absent: none.
   */
  decisions?: NeedDecision[];
  /**
   * The shown ranking (`settings.priority.engine`, priority@2's `engineOf`): `v2` draws the Admin row with priority@2's
   * batch math and keeps admin out of Do now; `v1` / `shadow` (priority@1.1 shown) list admin by the persona's rules.
   * Absent: shadow (the default).
   */
  priorityEngine?: PriorityEngineSetting;
}
