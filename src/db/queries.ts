/**
 * DATA-MODEL §6: the home-screen reads (Q1-Q16) and the write paths (W1-W7), verbatim, as
 * positional-parameter SQL for node-postgres: `pool.query(Q.Q1.text, [ownerUserId])`, or via
 * runStatement(); inside a drizzle transaction use `tx.execute(statementSql('Q1', [ownerUserId]))`.
 * Extracted from docs/reference/DATA-MODEL.md; tests/be0/queries.test.ts runs every statement and EXPLAINs
 * every read. One fix: W1 casts `$9::timestamptz + interval '90 days'` (uncast, Postgres deduces
 * $9 as interval there and timestamptz in the VALUES list, and rejects the statement).
 *
 * Helpers implement some write paths with guards: W2 = recordNewInfo() (queue.ts), W3/W4 =
 * engineUpdate()/updateVersioned() (changeset.ts), W6 = closeIdleBursts() (changeset.ts).
 * Writes to curated tables (W2, W3, W4) must run inside withChangeSet().
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export interface Statement {
  id: string;
  title: string;
  /** "$1 owner_user_id, $2 local day" */
  params: string;
  /** Supporting indexes as listed in §6 (prose). */
  indexes: string[];
  /** Index names extracted from `indexes`. */
  indexNames: string[];
  text: string;
}

export const Q = {
  Q1: {
    id: 'Q1',
    title: "Top 3 + Now / Next / Later (the home list)",
    params: "$1 owner_user_id",
    indexes: ["work_items_home_lane_rank_idx (partial: active statuses)","PK lookups for score/NBA/opp/initiative","work_item_evidence_target_uq (leading work_item_id, role) for the origin link","work_item_evidence_item_role_idx + connectors PK inside the degradation view (the per-item predicate is pushed into every UNION branch)","change_proposals_pending_field_uidx."],
    indexNames: ["work_items_home_lane_rank_idx","work_item_evidence_target_uq","work_item_evidence_item_role_idx","change_proposals_pending_field_uidx"],
    text: `SELECT wi.id, wi.title, wi.purpose, wi.kind, wi.status, wi.priority_lane, wi.priority_rank, wi.due_at,
       ps.explanation                AS why,
       nba.type                      AS nba_type,
       nba.title                     AS nba_title,
       nba.status                    AS nba_status,
       nba.completeness              AS nba_completeness,
       o.name                        AS opportunity,
       ini.title                     AS initiative,
       origin.url                    AS origin_url,
       origin.source                 AS origin_source,
       coalesce(wi.last_new_info_at > coalesce(wi.seen_by_user_at, '-infinity'), false) AS has_new_info,
       EXISTS (SELECT 1 FROM work_item_degradations d WHERE d.work_item_id = wi.id)      AS degraded,
       EXISTS (SELECT 1 FROM change_proposals cp
                WHERE cp.entity_type = 'work_items' AND cp.entity_id = wi.id
                  AND cp.status = 'pending')                                           AS has_proposal
  FROM work_items wi
  LEFT JOIN priority_scores ps    ON ps.id = wi.priority_score_id
  LEFT JOIN next_best_actions nba ON nba.id = wi.current_nba_id
  LEFT JOIN opportunities o       ON o.id = wi.opportunity_id
  LEFT JOIN initiatives ini       ON ini.id = wi.initiative_id
  LEFT JOIN LATERAL (
        SELECT si.url, si.source
          FROM work_item_evidence e
          JOIN source_items si ON si.id = e.source_item_id
         WHERE e.work_item_id = wi.id AND e.role = 'origin'
           AND e.user_verdict IS DISTINCT FROM 'rejected'
         ORDER BY e.created_at
         LIMIT 1) origin ON true
 WHERE wi.owner_user_id = $1
   AND wi.status IN ('open', 'in_progress', 'waiting_on_me', 'likely_done')
   AND wi.priority_lane IN ('top3', 'now', 'next', 'later')
 ORDER BY wi.priority_lane, wi.priority_rank
 LIMIT 40;`,
  },
  Q2: {
    id: 'Q2',
    title: "Count strip (\"12 more today · 4 waiting on others · 9 in triage\")",
    params: "$1 owner_user_id",
    indexes: ["work_items_owner_status_idx (index scan over the owner's live rows)."],
    indexNames: ["work_items_owner_status_idx"],
    text: `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress')
                          AND priority_lane IN ('now', 'next', 'later'))            AS more_today,
       count(*) FILTER (WHERE status = 'waiting_on_others')                          AS waiting_on_others,
       count(*) FILTER (WHERE status = 'waiting_on_me')                              AS waiting_on_me,
       count(*) FILTER (WHERE status = 'suggested')                                  AS in_triage,
       count(*) FILTER (WHERE status = 'likely_done')                                AS likely_done,
       count(*) FILTER (WHERE priority_lane = 'background'
                          AND status IN ('open', 'in_progress'))                     AS background,
       count(*) FILTER (WHERE last_new_info_at > coalesce(seen_by_user_at, '-infinity')) AS with_new_info
  FROM work_items
 WHERE owner_user_id = $1
   AND status NOT IN ('done', 'dismissed', 'merged', 'snoozed');`,
  },
  Q3: {
    id: 'Q3',
    title: "Today's meetings strip, with prep and notes state",
    params: "$1 owner_user_id, $2 local day",
    indexes: ["calendar_events_owner_day_idx","work_items_deadline_event_idx (partial)","meeting_notes_event_idx."],
    indexNames: ["calendar_events_owner_day_idx","work_items_deadline_event_idx","meeting_notes_event_idx"],
    text: `SELECT ce.id, ce.title, ce.starts_at, ce.ends_at, ce.my_response, ce.attendance,
       ce.has_external_attendees, o.name AS opportunity,
       prep.open_prep, prep.prep_must_start_by,
       EXISTS (SELECT 1 FROM meeting_notes mn WHERE mn.calendar_event_id = ce.id) AS has_notes
  FROM calendar_events ce
  LEFT JOIN opportunities o ON o.id = ce.opportunity_id
  LEFT JOIN LATERAL (
        SELECT count(*) AS open_prep, min(ps.latest_start_at) AS prep_must_start_by
          FROM work_items w
          LEFT JOIN priority_scores ps ON ps.id = w.priority_score_id
         WHERE w.deadline_event_id = ce.id
           AND w.status NOT IN ('done', 'dismissed', 'merged')) prep ON true
 WHERE ce.owner_user_id = $1 AND ce.local_day = $2
   AND ce.status <> 'cancelled' AND ce.event_type = 'default'
   AND ce.my_response IN ('accepted', 'tentative', 'needs_action', 'none')
 ORDER BY ce.starts_at;`,
  },
  Q4: {
    id: 'Q4',
    title: "Today's sequence (\"kick off the long build first\", R-UI-4)",
    params: "$1 owner_user_id",
    indexes: ["priority_runs_owner_finished_idx","priority_plan_steps_run_ordinal_uidx."],
    indexNames: ["priority_runs_owner_finished_idx","priority_plan_steps_run_ordinal_uidx"],
    text: `WITH run AS (
  SELECT id
    FROM priority_runs
   WHERE owner_user_id = $1 AND finished_at IS NOT NULL
   ORDER BY finished_at DESC
   LIMIT 1
)
SELECT s.ordinal, s.mode, s.planned_start_at, s.planned_end_at, s.reason,
       wi.id AS work_item_id, wi.title, wi.effort_minutes, wi.lead_time_minutes, ce.title AS meeting
  FROM run
  JOIN priority_plan_steps s ON s.run_id = run.id
  LEFT JOIN work_items wi    ON wi.id = s.work_item_id
  LEFT JOIN calendar_events ce ON ce.id = s.calendar_event_id
 ORDER BY s.ordinal;`,
  },
  Q5: {
    id: 'Q5',
    title: "Waiting on me (Claude sessions and tool runs paused for my input)",
    params: "$1 owner_user_id",
    indexes: ["claude_sessions_owner_status_idx","work_item_links_claude_session_idx","tool_runs_owner_status_idx."],
    indexNames: ["claude_sessions_owner_status_idx","work_item_links_claude_session_idx","tool_runs_owner_status_idx"],
    text: `SELECT 'claude_session' AS source, cs.id, cs.title AS label, cs.waiting_reason::text AS reason,
       cs.waiting_since AS since, cs.cwd AS context,
       array_remove(array_agg(DISTINCT wil.work_item_id), NULL) AS work_item_ids
  FROM claude_sessions cs
  LEFT JOIN work_item_links wil ON wil.claude_session_id = cs.id
 WHERE cs.owner_user_id = $1 AND cs.status = 'waiting_on_me'
 GROUP BY cs.id
UNION ALL
SELECT 'tool_run', tr.id, ta.name, tr.capability, tr.started_at, NULL,
       array_remove(ARRAY[tr.work_item_id], NULL)
  FROM tool_runs tr
  JOIN tool_adapters ta ON ta.id = tr.adapter_id
 WHERE tr.owner_user_id = $1 AND tr.status = 'waiting_on_me'
 ORDER BY since NULLS LAST;`,
  },
  Q6: {
    id: 'Q6',
    title: "\"Closed for you today\", each with its evidence and Undo",
    params: "$1 owner_user_id, $2 start of local day",
    indexes: ["work_item_transitions_auto_done_idx (partial: to_status = done AND actor = engine)."],
    indexNames: ["work_item_transitions_auto_done_idx"],
    text: `SELECT t.id AS transition_id, wi.id AS work_item_id, wi.title, t.occurred_at, t.reason,
       t.change_set_id AS undo_change_set_id, e.rationale, e.confidence,
       coalesce(si.url, a.url) AS evidence_url
  FROM work_item_transitions t
  JOIN work_items wi ON wi.id = t.work_item_id
  LEFT JOIN work_item_evidence e    ON e.id = t.evidence_id
  LEFT JOIN source_items si         ON si.id = e.source_item_id
  LEFT JOIN asset_snapshot_diffs d  ON d.id = e.asset_diff_id
  LEFT JOIN assets a                ON a.id = d.asset_id
 WHERE wi.owner_user_id = $1
   AND t.to_status = 'done' AND t.actor_kind = 'engine'
   AND t.occurred_at >= $2 AND t.undone_at IS NULL
 ORDER BY t.occurred_at DESC;`,
  },
  Q7: {
    id: 'Q7',
    title: "Persistent attention: notifications plus unhealthy connectors (R-UI-12, R-UI-19)",
    params: "$1 owner_user_id",
    indexes: ["notifications_owner_live_idx (partial)","connectors_owner_unhealthy_idx","reauth_attempts_connector_requested_idx."],
    indexNames: ["notifications_owner_live_idx","connectors_owner_unhealthy_idx","reauth_attempts_connector_requested_idx"],
    text: `SELECT 'notification' AS source, n.id::text AS id, n.kind::text AS kind, n.severity, n.title,
       n.action_route, n.action_kind, n.created_at AS since
  FROM notifications n
 WHERE n.owner_user_id = $1
   AND (n.status IN ('open', 'seen') OR (n.status = 'snoozed' AND n.snoozed_until <= now()))
UNION ALL
SELECT 'connector', c.id::text, c.kind::text,
       CASE WHEN c.status IN ('auth_required', 'error') THEN 'error' ELSE 'warn' END::severity,
       c.name || ': ' || coalesce(c.status_reason, c.status::text),
       '/settings/health#' || c.kind, coalesce(ra.status::text, 'reauth'), c.status_changed_at
  FROM connectors c
  LEFT JOIN LATERAL (
        SELECT r.status FROM reauth_attempts r
         WHERE r.connector_id = c.id ORDER BY r.requested_at DESC LIMIT 1) ra ON true
 WHERE c.owner_user_id = $1 AND c.enabled
   AND (c.status <> 'healthy'
        OR c.last_success_at < now() - make_interval(secs => c.stale_after_seconds))
 ORDER BY severity DESC, since DESC
 LIMIT 20;`,
  },
  Q8: {
    id: 'Q8',
    title: "Deadline banner: quarter-to-date hours (Org62 read-back is truth; app rows are pending)",
    params: "$1 owner_user_id",
    indexes: ["fiscal_periods_pack_fy_q_uidx","org62_events_owner_starts_idx (sargable range)","activity_entries_owner_period_idx."],
    indexNames: ["fiscal_periods_pack_fy_q_uidx","org62_events_owner_starts_idx","activity_entries_owner_period_idx"],
    text: `WITH fp AS (
  SELECT f.*, u.timezone AS tz
    FROM users u
    JOIN fiscal_periods f ON f.team_pack_id = u.team_pack_id
   WHERE u.id = $1
     AND (now() AT TIME ZONE u.timezone)::date BETWEEN f.starts_on AND f.ends_on
),
logged AS (
  SELECT sum(coalesce(e.duration_field, extract(epoch FROM e.ends_at - e.starts_at) / 3600)) AS h,
         sum(coalesce(e.duration_field, extract(epoch FROM e.ends_at - e.starts_at) / 3600))
           FILTER (WHERE st.counts_customer_facing)                                         AS cf_h,
         sum(coalesce(e.duration_field, extract(epoch FROM e.ends_at - e.starts_at) / 3600))
           FILTER (WHERE st.counts_customer_related)                                        AS cr_h
    FROM fp
    JOIN org62_events e
      ON e.owner_user_id = $1 AND e.record_type_name = 'Solutions Event'
     AND e.deleted_upstream_at IS NULL
     AND e.starts_at >= (fp.starts_on::timestamp AT TIME ZONE fp.tz)
     AND e.starts_at <  ((fp.ends_on + 1)::timestamp AT TIME ZONE fp.tz)
    LEFT JOIN se_task_types st ON st.team_pack_id = fp.team_pack_id AND st.name = e.se_task_type_name
),
pending AS (
  SELECT sum(a.duration_hours) AS h
    FROM fp
    JOIN activity_entries a ON a.owner_user_id = $1 AND a.fiscal_period_id = fp.id
   WHERE a.operation = 'create'
     AND a.status IN ('proposed', 'needs_input', 'approved', 'synced_to_canvas')
)
SELECT fp.name, fp.logging_deadline_at, fp.deadline_assumed, fp.hours_target,
       logged.h AS logged_h, logged.cf_h, logged.cr_h, pending.h AS pending_h
  FROM fp, logged, pending;`,
  },
  Q9: {
    id: 'Q9',
    title: "Triage queue: suggestions, ambiguous extractions, mapping questions, \"New info → update?\"",
    params: "$1 owner_user_id",
    indexes: ["work_items_triage_idx","extraction_candidates_open_idx","source_item_links_unconfirmed_idx","change_proposals_owner_pending_idx."],
    indexNames: ["work_items_triage_idx","extraction_candidates_open_idx","source_item_links_unconfirmed_idx","change_proposals_owner_pending_idx"],
    text: `SELECT 'suggested_item' AS kind, wi.id, wi.title AS label, wi.confidence, wi.created_at
  FROM work_items wi
 WHERE wi.owner_user_id = $1 AND wi.status = 'suggested'
UNION ALL
SELECT 'candidate', ec.id, ec.proposed_title, ec.confidence, ec.created_at
  FROM extraction_candidates ec
 WHERE ec.owner_user_id = $1 AND ec.decision = 'needs_triage'
UNION ALL
SELECT 'mapping_question', l.id, coalesce(si.title, si.dedupe_key), l.confidence, l.created_at
  FROM source_item_links l
  JOIN source_items si ON si.id = l.source_item_id
 WHERE si.owner_user_id = $1 AND l.user_verdict IS NULL AND l.method = 'llm' AND l.confidence < 0.7
UNION ALL
SELECT 'proposal', cp.id, cp.field || ': ' || cp.reason, cp.confidence, cp.created_at
  FROM change_proposals cp
 WHERE cp.owner_user_id = $1 AND cp.status = 'pending'
 ORDER BY created_at DESC
 LIMIT 100;`,
  },
  Q10: {
    id: 'Q10',
    title: "Item drill-down: purpose, initiative brief and sibling tasks (R-UI-20)",
    params: "$1 work_item_id",
    indexes: ["work_items PK","work_items_initiative_idx."],
    indexNames: ["work_items_initiative_idx"],
    text: `SELECT wi.purpose, ini.title AS initiative, ini.purpose AS initiative_purpose, ini.background_summary,
       sib.id AS sibling_id, sib.title AS sibling_title, sib.status AS sibling_status, sib.priority_lane
  FROM work_items wi
  JOIN initiatives ini ON ini.id = wi.initiative_id
  LEFT JOIN work_items sib
    ON sib.initiative_id = ini.id AND sib.id <> wi.id AND sib.status <> 'merged'
 WHERE wi.id = $1
 ORDER BY sib.status, sib.priority_rank NULLS LAST;`,
  },
  Q11: {
    id: 'Q11',
    title: "Drive deliverable: file state, what changed since the item was created, judge verdict (R-UI-15)",
    params: "$1 work_item_id",
    indexes: ["work_item_deliverables (work_item_id, asset_id) uidx","asset_snapshot_diffs_from_to_uidx."],
    indexNames: ["asset_snapshot_diffs_from_to_uidx"],
    text: `SELECT d.id AS deliverable_id, d.status, a.title, a.url, a.last_modified_at,
       p.display_name AS last_modified_by,
       diff.summary AS changed_since_created, diff.changed_section_keys,
       diff.sections_added, diff.sections_modified, diff.modified_by_me_only,
       j.verdict, j.confidence AS verdict_confidence
  FROM work_item_deliverables d
  JOIN assets a ON a.id = d.asset_id
  LEFT JOIN people p ON p.id = a.last_modifying_person_id
  LEFT JOIN asset_snapshot_diffs diff
         ON diff.from_snapshot_id = d.baseline_snapshot_id AND diff.to_snapshot_id = a.latest_snapshot_id
  LEFT JOIN deliverable_judgments j ON j.id = d.latest_judgment_id
 WHERE d.work_item_id = $1;`,
  },
  Q12: {
    id: 'Q12',
    title: "Engine: did I reply in the thread after the ask? (deterministic closure test, R-UI-1)",
    params: "$1 owner_user_id, $2 thread key, $3 ask time",
    indexes: ["source_items_my_thread_replies_idx (partial: from_me)."],
    indexNames: ["source_items_my_thread_replies_idx"],
    text: `SELECT r.id, r.occurred_at, r.url
  FROM source_items r
 WHERE r.owner_user_id = $1 AND r.external_parent_id = $2
   AND r.from_me AND r.occurred_at > $3
 ORDER BY r.occurred_at
 LIMIT 1;`,
  },
  Q13: {
    id: 'Q13',
    title: "Per-item history with rollback points (R-UI-18)",
    params: "$1 entity_type, $2 entity_id",
    indexes: ["audit_events_entity_idx","change_sets PK."],
    indexNames: ["audit_events_entity_idx"],
    text: `SELECT cs.id AS change_set_id, cs.kind, cs.actor_kind, cs.summary, cs.created_at, cs.undone_at,
       ae.table_name, ae.row_id, ae.op, ae.changed_fields, ae.coalesced_count
  FROM audit_events ae
  JOIN change_sets cs ON cs.id = ae.change_set_id
 WHERE ae.entity_type = $1 AND ae.entity_id = $2
 ORDER BY ae.created_at DESC, ae.id DESC
 LIMIT 100;`,
  },
  Q14: {
    id: 'Q14',
    title: "⌘Z: the newest undoable change by this user",
    params: "$1 owner_user_id",
    indexes: ["change_sets_undo_stack_idx (partial: undoable AND not undone)."],
    indexNames: ["change_sets_undo_stack_idx"],
    text: `SELECT id, kind, summary, entity_type, entity_id, created_at
  FROM change_sets
 WHERE owner_user_id = $1 AND actor_kind = 'user'
   AND undoable AND undone_at IS NULL AND kind NOT IN ('undo', 'redo')
 ORDER BY created_at DESC
 LIMIT 1;`,
  },
  Q15: {
    id: 'Q15',
    title: "LLM budget meter (today)",
    params: "$1 owner_user_id, $2 local day",
    indexes: ["llm_budgets_owner_scope_uq","llm_budget_days PK."],
    indexNames: ["llm_budgets_owner_scope_uq"],
    text: `SELECT b.scope, b.scope_value, b.daily_limit_usd, b.alert_at_pct, b.hard_stop,
       coalesce(d.spent_usd, 0) AS spent_usd, coalesce(d.reserved_usd, 0) AS reserved_usd
  FROM llm_budgets b
  LEFT JOIN llm_budget_days d ON d.budget_id = b.id AND d.day = $2
 WHERE b.owner_user_id = $1 AND b.effective_from <= $2;`,
  },
  Q16: {
    id: 'Q16',
    title: "Briefs shelf: unread briefs and their top \"worth a closer look\" highlights (R-UI-21)",
    params: "$1 owner_user_id",
    indexes: ["briefs_owner_unseen_idx (partial)","brief_highlights_brief_ordinal_uidx","brief_highlight_reasons_highlight_feature_uidx."],
    indexNames: ["briefs_owner_unseen_idx","brief_highlights_brief_ordinal_uidx","brief_highlight_reasons_highlight_feature_uidx"],
    text: `SELECT b.id AS brief_id, ws.label, ws.scope_kind, b.period_start, b.period_end, b.nothing_new,
       b.coverage_complete, b.coverage_note, b.highlight_count,
       h.id AS highlight_id, h.title AS highlight, h.level, h.relevance_score,
       (SELECT string_agg(r.explanation, '; ' ORDER BY r.weight DESC)
          FROM brief_highlight_reasons r WHERE r.highlight_id = h.id) AS reasons
  FROM briefs b
  JOIN watch_subscriptions ws ON ws.id = b.subscription_id
  LEFT JOIN LATERAL (
        SELECT * FROM brief_highlights h
         WHERE h.brief_id = b.id AND h.status IN ('new', 'seen')
         ORDER BY h.relevance_score DESC
         LIMIT 3) h ON true
 WHERE b.owner_user_id = $1 AND b.status = 'ready' AND b.seen_at IS NULL
 ORDER BY b.generated_at DESC, h.relevance_score DESC NULLS LAST;`,
  },
  W1: {
    id: 'W1',
    title: "Idempotent ingest: re-pulling never duplicates, unchanged content is a no-op",
    params: "$1 owner, $2 connector, $3 source, $4 kind, $5 external_id, $6 parent, $7 dedupe_key, $8 content_hash, $9 occurred_at, $10 title, $11 url, $12 body, $13 from_me, $14 addressed_to_me, $15 scan_run_id",
    indexes: [],
    indexNames: [],
    text: `INSERT INTO source_items AS s
       (owner_user_id, connector_id, source, kind, external_id, external_parent_id, dedupe_key,
        content_hash, occurred_at, title, url, body, body_expires_at, from_me, addressed_to_me,
        first_scan_run_id, last_scan_run_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $9::timestamptz + interval '90 days', $13, $14, $15, $15)
ON CONFLICT (owner_user_id, dedupe_key) DO UPDATE SET
       content_hash       = EXCLUDED.content_hash,
       title              = EXCLUDED.title,
       url                = EXCLUDED.url,
       -- never resurrect a purged body (retention)
       body               = CASE WHEN s.body_purged_at IS NULL THEN EXCLUDED.body END,
       revision           = s.revision + 1,
       content_changed_at = now(),
       last_seen_at       = now(),
       last_scan_run_id   = EXCLUDED.last_scan_run_id
 WHERE s.content_hash IS DISTINCT FROM EXCLUDED.content_hash
RETURNING s.id, (s.xmax = 0) AS inserted, s.revision;`,
  },
  W2: {
    id: 'W2',
    title: "New info: save first, bump the generation, cancel a running re-eval, coalesce the next one (R-UI-20)",
    params: "$1 work_item_id, $2 debounce seconds",
    indexes: [],
    indexNames: [],
    text: `WITH bumped AS (
  UPDATE work_items
     SET reeval_generation     = reeval_generation + 1,
         last_new_info_at      = now(),
         unseen_evidence_count = unseen_evidence_count + 1
   WHERE id = $1
  RETURNING id, owner_user_id, reeval_generation
),
cancelled AS (
  UPDATE jobs j
     SET cancel_requested_at = now(),
         cancel_reason       = 'superseded by generation ' || b.reeval_generation
    FROM bumped b
   WHERE j.dedupe_key = 'reeval:work_item:' || b.id
     AND j.status = 'running' AND j.cancel_requested_at IS NULL
  RETURNING j.id
)
INSERT INTO jobs (owner_user_id, queue, kind, payload, dedupe_key, generation, supersedes_running, run_at)
SELECT b.owner_user_id, 'engine', 'reevaluate', jsonb_build_object('work_item_id', b.id),
       'reeval:work_item:' || b.id, b.reeval_generation, true, now() + make_interval(secs => $2)
  FROM bumped b
ON CONFLICT (dedupe_key) WHERE status = 'queued'
DO UPDATE SET generation = EXCLUDED.generation,
              run_at     = EXCLUDED.run_at,      -- debounce: each burst pushes the run out
              updated_at = now()
RETURNING id, generation, (SELECT count(*) FROM cancelled) AS cancelled_running;`,
  },
  W3: {
    id: 'W3',
    title: "Re-eval result write, fenced on generation and row version (a superseded job writes nothing)",
    params: "$1 work_item_id, $2 job generation, $3 expected version, $4 new status",
    indexes: [],
    indexNames: [],
    text: `UPDATE work_items
   SET status = $4, status_changed_at = now(), likely_done_at = now(), version = version + 1
 WHERE id = $1 AND reeval_generation = $2 AND version = $3
   AND NOT ('status' = ANY (user_locked_fields))
RETURNING id, version;`,
  },
  W4: {
    id: 'W4',
    title: "User edit with optimistic concurrency + field lock (0 rows = 409, client rebases)",
    params: "$1 work_item_id, $2 expected version, $3 new title",
    indexes: [],
    indexNames: [],
    text: `UPDATE work_items
   SET title              = $3,
       version            = version + 1,
       user_locked_fields = ARRAY(SELECT DISTINCT f FROM unnest(user_locked_fields || '{title}'::text[]) AS f)
 WHERE id = $1 AND version = $2
RETURNING id, version, user_locked_fields;`,
  },
  W5: {
    id: 'W5',
    title: "Autosave: coalesce keystroke saves into one revision per editor burst (R-UI-18)",
    params: "$1 owner, $2 draft_id, $3 doc_json, $4 content_hash, $5 editor_session_id, $6 change_set_id",
    indexes: [],
    indexNames: [],
    text: `INSERT INTO content_revisions AS r
       (owner_user_id, entity_type, entity_id, field, revision, doc_json, content_hash,
        actor_kind, editor_session_id, change_set_id)
SELECT $1, 'drafts', $2, 'doc_json', coalesce(max(revision), 0) + 1, $3, $4, 'user', $5, $6
  FROM content_revisions
 WHERE entity_type = 'drafts' AND entity_id = $2 AND field = 'doc_json'
ON CONFLICT (entity_type, entity_id, field, editor_session_id) WHERE closed_at IS NULL
DO UPDATE SET doc_json      = EXCLUDED.doc_json,
              content_hash  = EXCLUDED.content_hash,
              last_saved_at = now(),
              save_count    = r.save_count + 1
RETURNING id, revision, save_count;`,
  },
  W6: {
    id: 'W6',
    title: "Sweeper: close idle autosave bursts (revisions and change sets) after 30 s",
    params: "$1 idle seconds",
    indexes: [],
    indexNames: [],
    text: `WITH closed_revisions AS (
  UPDATE content_revisions SET closed_at = now()
   WHERE closed_at IS NULL AND last_saved_at < now() - make_interval(secs => $1)
  RETURNING id
)
UPDATE change_sets SET closed_at = now()
 WHERE kind = 'autosave_burst' AND closed_at IS NULL
   AND coalesce(coalesce_until, created_at) < now() - make_interval(secs => $1)
RETURNING id, (SELECT count(*) FROM closed_revisions) AS revisions_closed;`,
  },
  W7: {
    id: 'W7',
    title: "Retention: drop bodies after 90 days, keep hashes, metadata and links",
    params: "(none)",
    indexes: [],
    indexNames: [],
    text: `WITH s AS (
  UPDATE source_items SET body = NULL, body_purged_at = now()
   WHERE body IS NOT NULL AND body_expires_at < now()
  RETURNING id
), sec AS (
  UPDATE asset_snapshot_sections SET text = NULL
   WHERE text IS NOT NULL AND text_expires_at < now()
  RETURNING id
)
SELECT (SELECT count(*) FROM s) AS bodies_purged, (SELECT count(*) FROM sec) AS section_texts_purged;`,
  },
} as const satisfies Record<string, Statement>;

export type StatementId = keyof typeof Q;

export async function runStatement<R extends QueryResultRow = QueryResultRow>(
  client: Pool | PoolClient,
  id: StatementId,
  params: unknown[] = [],
): Promise<R[]> {
  return (await client.query<R>(Q[id].text, params)).rows;
}

/**
 * A statement as a drizzle SQL object for use inside a transaction (`tx.execute(...)`). Each $n
 * occurrence becomes its own bound param, so a placeholder whose type Postgres can only infer from
 * an earlier occurrence needs runStatement() on a client instead.
 */
export function statementSql(id: StatementId, params: unknown[] = []): SQL {
  const parts = Q[id].text.split(/\$(\d+)/);
  const chunks: SQL[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) chunks.push(sql.raw(parts[i]!));
    else {
      const n = Number(parts[i]);
      if (n < 1 || n > params.length) throw new Error(`${id}: missing parameter $${n}`);
      chunks.push(sql`${params[n - 1]}`);
    }
  }
  return sql.join(chunks, sql.raw(''));
}
