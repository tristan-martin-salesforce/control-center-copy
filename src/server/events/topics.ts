/**
 * Which LiveEvent topics a database change invalidates: THE one table → topic map (2026-11-13 audit C1). Both buses
 * read it: the db DataSource's LISTEN bus (src/server/datasource/db/events.ts: the cc_audit trigger's `cc_change`
 * notices and the DataSource's own `publishTables` for unaudited writes) and the change-set publisher / pg-bus here.
 * Before, the db bus kept a second copy with no entry for deal_contribution_requests, meeting_notes, canvases,
 * job_schedules, channels or work_item_deliverables, so a claimed DC refreshed nothing until a reload.
 *
 * Keys are table names. The audit trigger's root entity types (0002_extras.sql `entity_type`, e.g. `work_items` for a
 * work_item_evidence row) are table names too, so a row resolves by its own table first, then by its root.
 * tests/events/topics.test.ts checks that every table the migrations attach cc_audit / cc_audit_kv to, and every
 * table the db DataSource passes to `publishTables`, resolves to at least one topic.
 */
import type { EntityType, LiveTopic } from '@/contract';

export interface TableTopics {
  topics: LiveTopic[];
  entityType?: EntityType;
  noun: string;
}

const t = (topics: LiveTopic[], noun: string, entityType?: EntityType): TableTopics => (entityType ? { topics, entityType, noun } : { topics, noun });

export const TABLE_TOPICS: Record<string, TableTopics> = {
  // ── work ──────────────────────────────────────────────────────────────────────────────────
  work_items: t(['today', 'items', 'item', 'triage', 'initiative', 'deals', 'since'], 'item', 'work_item'),
  work_item_evidence: t(['item'], 'evidence', 'work_item'),
  work_item_links: t(['item'], 'link', 'work_item'),
  work_item_relations: t(['item'], 'relation', 'work_item'),
  work_item_deliverables: t(['item'], 'deliverable'),
  deliverable_requirements: t(['item'], 'requirement'),
  work_item_training_details: t(['item', 'items'], 'training', 'work_item'),
  work_item_travel_details: t(['item', 'items'], 'travel', 'work_item'),
  work_item_transitions: t(['today', 'item'], 'transition', 'work_item'),
  next_best_actions: t(['nba', 'today', 'item'], 'nba', 'nba'),
  initiatives: t(['initiative', 'item', 'today'], 'initiative', 'initiative'),
  initiative_links: t(['initiative'], 'initiative_link', 'initiative'),
  change_proposals: t(['item', 'nba', 'today', 'draft', 'chat'], 'proposal', 'proposal'),
  source_items: t(['item'], 'note'),
  extraction_candidates: t(['item', 'triage'], 'candidate'),
  source_item_links: t(['item'], 'source_link'),
  assets: t(['item', 'initiative'], 'asset', 'asset'),
  // ── outbox and time ───────────────────────────────────────────────────────────────────────
  // 'time': a pending logging-canvas item holds its rows (ActivityEntry.canvasDraftId is derived from drafts); 'deals':
  // a DC request's and a use case's stage (waiting → on a canvas → handed off) is derived from the canvas drafts too
  drafts: t(['draft', 'nba', 'outbox', 'today', 'item', 'time', 'deals'], 'draft', 'draft'),
  draft_recipients: t(['draft', 'outbox'], 'recipient', 'draft'),
  activity_entries: t(['time'], 'activity', 'activity_entry'),
  activity_entry_time_blocks: t(['time'], 'time_block', 'activity_entry'),
  canvases: t(['time', 'draft'], 'canvas'),
  canvas_row_overrides: t(['time', 'draft'], 'canvas'), // D-98: your canvas row edits before Apply (was kv canvas.row_overrides)
  // DC requests: Deals ▸ DCs, Time ▸ Log it (Ready), the sidebar Time badge (today) and Home ▸ Log & fix
  deal_contribution_requests: t(['deals', 'time', 'today', 'home'], 'dc_request'),
  specialist_forecasts: t(['time', 'home'], 'forecast'), // lane A: Time ▸ Forecast, Home ▸ Log & fix
  // D-70 landings: Activity ▸ Org62 (a run's writes, Log it's Event updates, Use cases) and the details panel
  record_landings: t(['time', 'deals'], 'landing'),
  landing_writes: t(['time', 'deals'], 'landing_write'),
  use_cases: t(['deals', 'time'], 'use_case'),
  // the Org62 use-case mirror (an Org62 read): Activity ▸ Use cases and Log it, Deals
  org62_use_cases: t(['time', 'deals'], 'org62_use_case'),
  // ── deals ─────────────────────────────────────────────────────────────────────────────────
  missed_opp_findings: t(['deals', 'triage', 'today'], 'missed_opp', 'missed_opp'),
  accounts: t(['deals'], 'account', 'account'),
  account_aliases: t(['deals'], 'account_alias', 'account'),
  opportunities: t(['deals'], 'opportunity', 'opportunity'),
  // Time ▸ VDP: asset candidates and the VDP mirror (D-59: the Time badge counts VDPs that need you)
  vdp_asset_candidates: t(['deals', 'today'], 'vdp_asset'),
  vdp_records: t(['deals', 'today', 'time'], 'vdp'),
  // needs-you decisions (D-98: the need_decisions table, was user_settings cc.need/…): Deals needs, the account page, Home ▸ Log & fix
  need_decisions: t(['deals', 'home', 'today'], 'need'),
  // ── people, channels, calendar ────────────────────────────────────────────────────────────
  people: t(['search'], 'person', 'person'),
  person_identities: t(['search'], 'identity', 'person'),
  channels: t(['watches', 'settings'], 'channel'),
  channel_account_maps: t(['watches', 'settings', 'deals'], 'channel_map'),
  calendar_events: t(['calendar', 'today'], 'calendar_event', 'calendar_event'),
  meeting_notes: t(['calendar', 'item', 'time'], 'meeting_notes'),
  // ── agents and tools ──────────────────────────────────────────────────────────────────────
  claude_sessions: t(['agents', 'today', 'item'], 'agent_run', 'agent_run'),
  repos: t(['agents'], 'repo'),
  tool_runs: t(['tools', 'tool_run', 'agents'], 'tool_run', 'tool_run'),
  tool_adapters: t(['tools'], 'tool', 'tool_adapter'),
  // ── settings and policy ───────────────────────────────────────────────────────────────────
  users: t(['settings', 'today'], 'settings', 'settings'),
  user_settings: t(['settings', 'today', 'time', 'outbox', 'health'], 'settings', 'settings'),
  autonomy_policies: t(['settings', 'outbox'], 'autonomy', 'settings'),
  task_capture_rules: t(['settings', 'triage'], 'capture_rule', 'settings'),
  llm_budgets: t(['settings', 'health', 'today'], 'budget', 'settings'),
  user_interests: t(['settings'], 'interest', 'settings'),
  mapping_rules: t(['settings', 'triage', 'today', 'time'], 'mapping_rule'),
  // the attribution engine (0032): DC suggestions (audited) and the engagement rollup (statement-level notices)
  dc_suggestions: t(['time', 'deals', 'home'], 'dc_suggestion'),
  opp_engagement: t(['time', 'deals'], 'opp_engagement'),
  // use-case candidates (0034, src/engines/use-cases): Activity ▸ Needs you ▸ Use cases to add (audited)
  use_case_candidates: t(['time', 'deals'], 'use_case_candidate'),
  priority_policies: t(['policy', 'settings', 'today'], 'policy', 'policy'),
  priority_policy_rules: t(['policy'], 'policy_rule', 'policy'),
  voice_profiles: t(['settings'], 'voice'),
  // ── health, jobs, briefs, chat ────────────────────────────────────────────────────────────
  connectors: t(['health', 'today', 'item', 'items'], 'connector', 'connector'),
  job_schedules: t(['jobs', 'health'], 'schedule'),
  // jobs, scan runs, app events and worker instances are unaudited: 0026_live_notify's trigger notifies their
  // transitions (an insert, a status change, a resolve), so Health and the progress views follow them without polling
  jobs: t(['jobs', 'health'], 'job', 'job'),
  scan_runs: t(['scans', 'health'], 'scan'),
  app_events: t(['event_log', 'health'], 'event', 'event_log'),
  worker_instances: t(['health'], 'worker'),
  watch_subscriptions: t(['watches', 'briefs'], 'watch', 'watch'),
  briefs: t(['briefs', 'today'], 'brief', 'brief'),
  brief_highlights: t(['briefs', 'today'], 'brief_highlight', 'brief_highlight'),
  chat_threads: t(['chat'], 'chat_thread', 'chat_thread'),
};

/** @deprecated the old name of TABLE_TOPICS (it was keyed by audit root entity type, which are table names). */
export const ENTITY_TOPICS = TABLE_TOPICS;

/** The entry for a write: the row's own table first, then its audit root (`entity_type`). */
export function tableTopicsOf(table: string | undefined, entityType?: string): TableTopics | undefined {
  return (table ? TABLE_TOPICS[table] : undefined) ?? (entityType ? TABLE_TOPICS[entityType] : undefined);
}

/** The topics a write invalidates (empty when neither its table nor its root is known). */
export function topicsFor(table: string | undefined, entityType?: string): LiveTopic[] {
  return tableTopicsOf(table, entityType)?.topics ?? [];
}

const PAST = { insert: 'created', update: 'updated', delete: 'deleted' } as const;

export interface ChangeRow {
  /** The audit root entity type (a table name). */
  entityType: string;
  entityId: string;
  op: 'insert' | 'update' | 'delete';
  /** The row's own table, when known (the trigger's notice and audit_events carry it). */
  table?: string;
}

export interface TopicEvent {
  topic: LiveTopic;
  ids: string[];
  reason: string;
  entityType?: EntityType;
}

/** Max ids per event: payloads stay small (NOTIFY caps at 8000 bytes); views refetch by topic anyway. */
export const MAX_IDS = 50;

/** Groups changed rows into one event per topic. The reason is `<noun>.<created|updated|deleted>` of the dominant op. */
export function eventsForChanges(rows: ChangeRow[]): TopicEvent[] {
  const byTopic = new Map<LiveTopic, { ids: Set<string>; ops: Map<string, number>; nouns: Set<string>; entityType?: EntityType }>();
  for (const r of rows) {
    const m = tableTopicsOf(r.table, r.entityType);
    const topics: LiveTopic[] = m?.topics.length ? m.topics : ['audit'];
    for (const topic of topics) {
      const cur = byTopic.get(topic) ?? { ids: new Set<string>(), ops: new Map<string, number>(), nouns: new Set<string>(), entityType: m?.entityType };
      if (r.entityId) cur.ids.add(r.entityId);
      cur.ops.set(r.op, (cur.ops.get(r.op) ?? 0) + 1);
      cur.nouns.add(m?.noun ?? r.entityType);
      if (cur.entityType !== m?.entityType) cur.entityType = undefined;
      byTopic.set(topic, cur);
    }
  }
  const out: TopicEvent[] = [];
  for (const [topic, v] of byTopic) {
    const op = (['insert', 'delete', 'update'] as const).find((o) => v.ops.has(o) && v.ops.get(o)! >= Math.max(...v.ops.values())) ?? 'update';
    const noun = v.nouns.size === 1 ? [...v.nouns][0]! : 'entity';
    out.push({ topic, ids: [...v.ids].filter(Boolean).slice(0, MAX_IDS), reason: `${noun}.${PAST[op]}`, entityType: v.entityType });
  }
  return out;
}
