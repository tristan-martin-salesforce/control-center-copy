/**
 * The attribution engine's types (R1, holistic review 2026-11-20 lane 06 §4a). One engine answers "which opportunity
 * or account is this about?" for every time and activity path, with a ranked list and the reasons for each candidate,
 * and learns from every correction (`mapping_rules`, tenet: Suggest, then learn).
 *
 * Pure: no database, no clock, no network. The callers (the activity engine, Time rows, DC suggestions, the use-case
 * pre-fill, the opp rundown) hand it a Signal and the World they already read.
 */

/** Where a signal comes from. */
export type SignalKind = 'calendar' | 'slack' | 'gmail' | 'drive' | 'gemini' | 'claude' | 'manual';

/**
 * One piece of evidence to attribute: a calendar event, a Slack burst (conversation, participants, channel), a Gmail
 * thread, a Drive doc, a Gemini note, a Claude session or a manual entry.
 */
export interface Signal {
  kind: SignalKind;
  /** Title, subject, doc title, session title, the note's summary or the row's description. */
  text: string;
  /** When it happened (ISO). */
  at?: string | null;
  /** Participant email domains (attendees, recipients, channel members). Internal ones are dropped by the World. */
  domains?: readonly string[];
  /** Participant emails (lower case). Never logged. */
  emails?: readonly string[];
  /** Participants the app knows (people ids). */
  personIds?: readonly string[];
  /** The Slack channel. */
  channel?: { id: string; name?: string | null } | null;
  /** The calendar series (recurring event id). */
  seriesId?: string | null;
  /** The repo or project key (Claude sessions, commits). */
  repo?: string | null;
  /** An explicit opp or account the evidence is linked to (the meeting's own opp, the session's task, a mention). */
  explicit?: { oppIds?: readonly string[]; accountIds?: readonly string[]; via?: string } | null;
  /** Accounts the evidence names indirectly (the attendees' accounts, the Drive file's account). */
  related?: { accountIds: readonly string[]; via: string } | null;
}

export interface WorldAccount {
  id: string;
  name: string;
  /** Learned or seeded domains (account_aliases kind domain). */
  domains?: readonly string[];
}

export interface WorldOpp {
  id: string;
  accountId: string | null;
  name: string;
  isOpen: boolean;
  /** On my team (or mine). */
  isMine: boolean;
  /** A DC of mine is on it. */
  myDc: boolean;
  closeDate?: string | null;
  amount?: number | null;
  stage?: string | null;
  isWon?: boolean;
  /** The opp's AE (owner): name and, when known, the person id, the Org62 user id and the email. */
  owner?: { name?: string | null; personId?: string | null; org62UserId?: string | null; email?: string | null } | null;
  /** Products on the opp (line items or the opp's own words). */
  products?: readonly string[];
  /** Opportunity team members other than the owner (D-103 (a): a covered AE matches as a team member too). */
  team?: ReadonlyArray<{ name?: string | null; personId?: string | null; org62UserId?: string | null; email?: string | null }>;
  /** Org62 user ids of the opp's Specialist Forecast owners (D-103 (b) fills it; a covered AE matches as one). */
  specialistForecastOwnerIds?: readonly string[];
  /** How the app knows it: the book (default), Org62 discovery, or a covered AE's book. */
  via?: 'book' | 'discovered' | 'covered_ae';
}

export interface WorldPerson {
  id: string;
  email: string | null;
  accountId: string | null;
  name?: string | null;
}

/** Learned rule kinds (`mapping_rules.kind` in the database: see rules.ts DB_KIND). */
export type RuleKind = 'domain' | 'channel' | 'person' | 'keyword' | 'series' | 'repo';

/** One learned rule (a `mapping_rules` row the engine reads first, tenet: Suggest, then learn). */
export interface LearnedRule {
  id: string;
  kind: RuleKind;
  /** The key: a domain, a channel id, an email, a word, a series id, a repo. Lower case. */
  pattern: string;
  accountId: string | null;
  oppId: string | null;
  /** The rule says "internal work". */
  internal?: boolean;
  /** Corrections and accepts that agreed with it. */
  hits: number;
  /** Corrections that disagreed with it (conflicting rules decay: see rules.ts). */
  misses: number;
  lastUsedAt: string | null;
  enabled: boolean;
  source?: 'user_correction' | 'seed' | 'accept';
}

/** What I did on an opp lately (from `opp_engagement`): powers recency and the rundown. */
export interface EngagementSummary {
  lastTouchAt: string | null;
  /** Meetings, Slack lines, mail threads and docs in the last 4 weeks. */
  touches4w: number;
  /** Hours logged (approved or later) in the last 4 weeks. */
  hours4w: number;
}

/** An AE I cover (Settings ▸ Time ▸ AEs I cover), toggled on. */
export interface CoveredAeRef {
  name: string;
  org62UserId?: string | null;
  email?: string | null;
  /** D-103 (a): `ae` (default), `ooo` or `sme`. */
  kind?: 'ae' | 'ooo' | 'sme';
  /** When the coverage holds (ISO dates, `to` inclusive). */
  window?: { from: string; to?: string } | null;
  /** The default DC split through this row (absent: the kind's default). */
  creditShare?: 100 | 50 | 25;
  note?: string | null;
}

/** The weights each evidence source starts at (config, not code: `World.weights` overrides any of them). */
export interface AttributionWeights {
  explicitOpp: number;
  explicitAccount: number;
  ruleOpp: number;
  ruleAccount: number;
  /** A user-confirmed channel ↔ account map (channel_account_maps). */
  channelMapOpp: number;
  channelMapAccount: number;
  channelName: number;
  titleName: number;
  titleAlias: number;
  personAccount: number;
  domainAccount: number;
  relatedAccount: number;
  keywordOpp: number;
  /** Two or more distinctive words of one opp's name. */
  keywordOppStrong: number;
  teamOverlap: number;
  coveredAe: number;
  engagementRecent: number;
  recentUse: number;
  mine: number;
  /** Multiplier on an opp closed for over 90 days (amount 0 counts as closed for this). */
  closedPenalty: number;
  /** Below this the top is "unsure": the rundown shows and the row asks. */
  settle: number;
  /** The top must beat the second by this much to settle. */
  margin: number;
}

export interface World {
  accounts: readonly WorldAccount[];
  opps: readonly WorldOpp[];
  people?: readonly WorldPerson[];
  /** channel id → the user-confirmed account (and opp) (channel_account_maps). */
  channels?: Readonly<Record<string, { accountId: string; oppId?: string | null }>>;
  rules?: readonly LearnedRule[];
  /** opp id → what I did on it lately. */
  engagement?: Readonly<Record<string, EngagementSummary>>;
  /** opp id → the last day I logged to it (approved or later, or my pick), last 30 days. */
  recentUse?: Readonly<Record<string, string>>;
  /** AEs I cover, toggled on. */
  coveredAes?: readonly CoveredAeRef[];
  internalDomains?: readonly string[];
  partnerDomains?: readonly string[];
  ignoreDomains?: readonly string[];
  /** Today, local (YYYY-MM-DD): closed-opp penalties and recency. */
  today: string;
  weights?: Partial<AttributionWeights>;
  /**
   * The account-name matcher (text → accounts it names). The activity engine passes its own (the projection's
   * patterns, ActivityMappings.accounts, so a title maps exactly as before); absent: a whole-word name match.
   */
  matchText?: (text: string) => Array<{ accountId: string; via: 'name' | 'alias' }>;
}

/** Why a candidate scored: one evidence source, its weight and a sentence (tenet: Legible). */
export interface Reason {
  code:
    | 'legacy'
    | 'explicit'
    | 'rule'
    | 'channel_map'
    | 'channel_name'
    | 'title'
    | 'person'
    | 'domain'
    | 'related'
    | 'keyword'
    | 'team_overlap'
    | 'covered_ae'
    | 'engagement'
    | 'recent'
    | 'mine'
    | 'account'
    | 'closed';
  weight: number;
  text: string;
  /** The learned rule a `rule` reason cites. */
  ruleId?: string;
}

export interface Candidate {
  kind: 'opp' | 'account' | 'internal';
  oppId: string | null;
  accountId: string | null;
  /** 0–1: the evidence combined as 1 − Π(1 − wᵢ), closed penalties applied. */
  confidence: number;
  why: Reason[];
}

export interface Attribution {
  /** Ranked, best first (opps and accounts; at most `limit`). */
  candidates: Candidate[];
  top: Candidate | null;
  /** The top is under the settle line, or the second is within the margin: ask (show the rundown). */
  needsAsk: boolean;
}
