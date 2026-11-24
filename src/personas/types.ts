/**
 * A persona definition (D-55): what someone in that role has to do at work, as data. Scanners, the Assistant,
 * Home, Time, Settings and onboarding read it through `personaOf` (index.ts); adding a persona is one file here
 * plus one line in the registry.
 *
 * It PRECONFIGURES. `features` / `connectors` list what is active for the role; anything else stays available
 * ("not in your role's preconfiguration") and can be activated per person in Settings ▸ Role & rules.
 */
import type { PersonaFeature, PersonaId, PersonaLevel } from '@/contract';
import type { PriorityConfig, PriorityConfigInput } from '@/engines/priority/v2/config';
import type { ConnectorId } from '@/scanner/types';

export const ALL_CONNECTORS: readonly ConnectorId[] = ['slack', 'org62', 'gmail', 'calendar', 'drive', 'gemini_notes', 'claude_sessions', 'trainings', 'watch', 'vdp'];

/** The Org62 scanner's scopes (src/scanner/runtime/connectors.ts). */
export type Org62Scope = 'opps' | 'events' | 'dcs' | 'book' | 'missed_opps';
export const ALL_ORG62_SCOPES: readonly Org62Scope[] = ['opps', 'events', 'dcs', 'book', 'missed_opps'];

/** Home ▸ Log & fix rules (src/engines/home/build.ts gapRules + persona-gaps.ts). */
export type GapRuleId = 'connector_auth' | 'quarter_log' | 'org62_unlogged' | 'canvas_waiting' | 'missed_dc' | 'needs_input' | 'expenses' | 'forecast_notes' | 'deal_role' | 'missing_sfr' | 'vdp_open';

/** The starter priority policies (src/engines/priority/policy.ts ROLE_POLICIES). */
export type PriorityTemplate = 'se_ic' | 'se_manager' | 'ae';

export interface PersonaDuty {
  id: string;
  /** Plain English: what has to happen ("Every Monday, fresh forecast notes on in-quarter deals"). */
  text: string;
  cadence?: 'daily' | 'weekly' | 'quarterly' | 'as_needed';
  /** The feature the duty belongs to (inactive feature → the duty is listed as available, not active). */
  feature?: PersonaFeature;
}

export interface PersonaRule {
  id: string;
  /** Plain English, may name thresholds as {key} ("… notes older than {staleNotesDays} days …"). */
  text: string;
  enabled: boolean;
  feature?: PersonaFeature;
}

export interface PersonaThreshold {
  key: string;
  label: string;
  unit: 'usd' | 'days' | 'hours' | 'weekday' | 'hhmm' | 'text';
  default: number | string;
  min?: number;
  max?: number;
  feature?: PersonaFeature;
}

export interface PersonaLogging {
  /** The Org62 Event record type activity rows are logged with. */
  recordType: { field: 'Name' | 'DeveloperName'; value: string };
  /** Rows need an SE task type before they can be logged (Solutions Events). */
  taskTypeRequired: boolean;
  /** Hours target per fiscal quarter; null = no target. No hour caps (2026-11-14): the signals are the only bound. */
  hoursTargetH: number | null;
  /**
   * How overlapping meetings log (Settings ▸ Time ▸ Overlapping meetings; the user's choice wins). D-18 amended
   * 2026-11-11: `log_all_accepted` (every accepted meeting logs; an onsite day logs in full with its meetings) for every
   * persona; `count_once` is the original "meetings win, counted once".
   */
  overlaps: 'log_all_accepted' | 'count_once';
  /**
   * The task types a row can take (the type pickers), in the order they are offered; absent or empty: the persona logs
   * no task type (the AE's Sales Events). The SE's are the team's SE Task Type taxonomy (src/engines/activity/taxonomy.ts).
   */
  taskTypes?: readonly string[];
  /**
   * D-64: work for no customer (a repo or Drive docs no account matches, an internal meeting) is proposed as
   * internal-only activity: Related To empty and an internal task type. Absent: off.
   */
  internalActivity?: boolean;
}

export interface PersonaDefinition {
  id: PersonaId;
  label: string;
  /** One line under the persona's name in pickers. */
  summary: string;
  /** "one Salesforce Solutions Engineer": how the prompts' Persona block names the user. */
  preamble: string;
  /** preview: selectable, labelled Preview. */
  status: 'ready' | 'preview';
  levels: Partial<Record<PersonaLevel, { label: string; priorityTemplate: PriorityTemplate }>>;
  /** Active by default when true; absent or false = available, not preconfigured. */
  features: Partial<Record<PersonaFeature, boolean>>;
  /** Sources active by default (sources tied to a feature, like vdp, follow the feature). */
  connectors: readonly ConnectorId[];
  org62Scopes: readonly Org62Scope[];
  /** Whose opportunities are "my book": opp teams I'm on (SE), opps I own (AE), or both. */
  org62Book: 'team_member' | 'owner' | 'both';
  /** The Log & fix rules, in the order Home lists their rows (after the state: overdue, blocked, at risk). */
  gapRules: readonly GapRuleId[];
  logging: PersonaLogging;
  duties: readonly PersonaDuty[];
  rules: readonly PersonaRule[];
  thresholds: readonly PersonaThreshold[];
  /**
   * priority@2's weights and rules for this role (lane 07 §4.4): what "customer-facing" and "deal tier" mean, the
   * owed-reply SLAs, prep rules, the admin classes and what is pay-linked. The engine reads it; it holds no
   * persona-specific code (*Config over code*). Anything left out takes src/engines/priority/v2/config.ts's default.
   */
  priority: PriorityConfigInput;
}

export interface ResolvedRule {
  id: string;
  text: string;
  enabled: boolean;
  /** A rule of the user's own (not from the preset). */
  custom: boolean;
  /** Edited from the preset's wording or state. */
  edited: boolean;
  feature?: PersonaFeature;
}

/** A persona with the user's changes applied: what every gate and prompt reads. */
export interface ResolvedPersona {
  id: PersonaId;
  level: PersonaLevel;
  label: string;
  levelLabel: string;
  preamble: string;
  status: 'ready' | 'preview';
  priorityTemplate: PriorityTemplate;
  /** Every feature with whether it is active. */
  features: Record<PersonaFeature, boolean>;
  /** Active features outside the preset (activated), and preset features switched off. */
  changedFeatures: PersonaFeature[];
  /** Active sources, in ALL_CONNECTORS order. */
  connectors: ConnectorId[];
  /** Sources not active: available to activate. */
  availableConnectors: ConnectorId[];
  org62Scopes: Org62Scope[];
  org62Book: PersonaDefinition['org62Book'];
  gapRules: GapRuleId[];
  logging: PersonaLogging;
  duties: (PersonaDuty & { active: boolean })[];
  rules: ResolvedRule[];
  thresholds: Record<string, number | string>;
  /** priority@2's config for this role (the preset's block over the defaults). */
  priority: PriorityConfig;
}
