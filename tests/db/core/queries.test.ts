/**
 * DATA-MODEL §6: every home-screen read (Q1-Q16) runs on seeded rows and returns what the UI needs,
 * and EXPLAIN shows the supporting indexes. Plans are checked with enable_seqscan = off (the seed
 * is small, so the planner would otherwise pick seq scans for most tables); Q1 is also checked
 * with the planner's natural choice after ANALYZE.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '../../../src/db/changeset';
import { Q, runStatement, type StatementId } from '../../../src/db/queries';
import { createExtractor, createUser, openTestDb } from './helpers';

const h = openTestDb();
const db = h.db;

const ids = {
  user: '',
  noise: [] as string[],
  pack: randomUUID(),
  fiscal: randomUUID(),
  taskType: randomUUID(),
  slack: randomUUID(),
  gmail: randomUUID(),
  account: randomUUID(),
  opp: randomUUID(),
  initiative: randomUUID(),
  person: randomUUID(),
  event: randomUUID(),
  noteItem: randomUUID(),
  policy: randomUUID(),
  session: randomUUID(),
  adapter: randomUUID(),
  asset: randomUUID(),
  snap0: randomUUID(),
  snap1: randomUUID(),
  diff: randomUUID(),
  deliverable: randomUUID(),
  judgment: randomUUID(),
  subscription: randomUUID(),
  brief: randomUUID(),
  budget: randomUUID(),
  extractor: '',
  anchorItem: '',
  runId: 0,
};
let today = '';
let dayStart = '';

async function seed(): Promise<void> {
  ids.user = await createUser(db, 'home');
  for (let i = 0; i < 4; i++) ids.noise.push(await createUser(db, `noise${i}`));
  ids.extractor = await createExtractor(db, 'seed');
  const u = ids.user;

  const tz = (await db.execute<{ d: string; s: string }>(sql`
    select (now() at time zone 'America/Denver')::date::text as d,
           ((now() at time zone 'America/Denver')::date::timestamp at time zone 'America/Denver')::text as s`)).rows[0]!;
  today = tz.d;
  dayStart = tz.s;

  // Team pack + fiscal period around today (not audited).
  await db.execute(sql`
    insert into team_packs (id, slug, version, name, source_path, content_hash)
    values (${ids.pack}, 'se-team', '1', 'SE team', 'team-packs/se-team', 'sha256:x')`);
  await db.execute(sql`
    insert into fiscal_periods (id, team_pack_id, name, fiscal_year, fiscal_quarter, starts_on, ends_on, logging_deadline_at, hours_target)
    values (${ids.fiscal}, ${ids.pack}, 'FY27 Q4', 2027, 4, (${today}::date - 30), (${today}::date + 60), now() + interval '20 days', 120)`);
  await db.execute(sql`
    insert into se_task_types (id, team_pack_id, name, counts_customer_related, counts_customer_facing, bucket)
    values (${ids.taskType}, ${ids.pack}, 'Demo', true, true, 'pre_sale')`);
  await db.execute(sql`update users set team_pack_id = ${ids.pack} where id = ${u}`);

  await withChangeSet({ db, userId: u, actor: actors.system('seed'), reason: 'seed home screen' }, async (tx) => {
    const x = (q: ReturnType<typeof sql>) => tx.execute(q);
    await x(sql`insert into connectors (id, owner_user_id, kind, name, transport, status, last_success_at)
                values (${ids.slack}, ${u}, 'slack', 'Slack', 'mcp_http', 'healthy', now()),
                       (${ids.gmail}, ${u}, 'gmail', 'Gmail', 'local_api', 'auth_required', now() - interval '2 hours')`);
    await x(sql`update connectors set status_reason = 'token expired' where id = ${ids.gmail}`);
    await x(sql`insert into accounts (id, owner_user_id, name) values (${ids.account}, ${u}, 'ACME')`);
    await x(sql`insert into opportunities (id, owner_user_id, account_id, org62_opportunity_id, name)
                values (${ids.opp}, ${u}, ${ids.account}, '006PLACEHOLDER', 'ACME Data Cloud')`);
    await x(sql`insert into people (id, owner_user_id, display_name) values (${ids.person}, ${u}, 'Sam Placeholder')`);
    await x(sql`insert into initiatives (id, owner_user_id, title, purpose, background_summary, created_by)
                values (${ids.initiative}, ${u}, 'ACME Headless Phase 2 demo', 'Win the technical decision', 'Two demos so far.', 'user')`);
    await x(sql`insert into calendar_events (id, owner_user_id, connector_id, calendar_id, external_event_id, title, starts_at, ends_at,
                                             local_day, my_response, opportunity_id, has_external_attendees)
                values (${ids.event}, ${u}, null, 'primary', 'evt-1', 'ACME demo', now() + interval '2 hours',
                        now() + interval '3 hours', ${today}, 'accepted', ${ids.opp}, true)`);
    // Realistic volume for the user (60 days of meetings), so plans reflect real use.
    await x(sql`insert into calendar_events (owner_user_id, calendar_id, external_event_id, title, starts_at, ends_at, local_day, my_response)
                select ${u}, 'primary', 'mine-' || g, 'Meeting ' || g, now() + (g - 150) * interval '5 hours',
                       now() + (g - 150) * interval '5 hours' + interval '30 minutes', ${today}::date + ((g - 150) / 5), 'accepted'
                  from generate_series(1, 300) g where (g - 150) / 5 <> 0`);
    // Noise calendars: other users, other days.
    for (const n of ids.noise) {
      await x(sql`insert into calendar_events (owner_user_id, calendar_id, external_event_id, title, starts_at, ends_at, local_day, my_response)
                  select ${n}, 'primary', 'evt-' || g, 'Meeting ' || g, now() + g * interval '1 hour', now() + g * interval '1 hour',
                         ${today}::date + (g % 30), 'accepted'
                    from generate_series(1, 300) g`);
    }

    // Source items: a Slack thread (not audited), plus noise.
    await x(sql`insert into source_items (owner_user_id, connector_id, source, kind, external_id, external_parent_id, dedupe_key,
                                          content_hash, occurred_at, from_me, url, title)
                select ${u}, ${ids.slack}, 'slack', 'slack_message', 'ts-' || g, 'thread-' || (g % 20), 'slack:T:C:ts-' || g,
                       'h' || g, now() - g * interval '10 minutes', g % 3 = 0, 'https://example.slack.com/archives/C/p' || g, 'msg ' || g
                  from generate_series(1, 400) g`);
    for (const n of ids.noise) {
      await x(sql`insert into source_items (owner_user_id, source, kind, external_id, external_parent_id, dedupe_key, content_hash, occurred_at, from_me)
                  select ${n}, 'slack', 'slack_message', 'ts-' || g, 'thread-' || (g % 50), 'slack:T:C:ts-' || g, 'h' || g,
                         now() - g * interval '1 minute', g % 2 = 0
                    from generate_series(1, 1000) g`);
    }
    await x(sql`insert into source_items (id, owner_user_id, source, kind, external_id, dedupe_key, content_hash, occurred_at, title)
                values (${ids.noteItem}, ${u}, 'gemini_notes', 'gemini_note', 'doc-1', 'gdoc:doc-1', 'h-note', now(), 'Notes: ACME demo')`);
    await x(sql`insert into meeting_notes (owner_user_id, source_item_id, kind, arrived_at, calendar_event_id)
                values (${u}, ${ids.noteItem}, 'gemini_notes', now(), ${ids.event})`);

    // Work items: the user's lanes and statuses, plus bulk noise (mostly done) for selectivity.
    const lanes = sql`(array['top3','now','next','later','background'])[1 + g % 5]::priority_lane`;
    await x(sql`
      insert into work_items (owner_user_id, kind, origin, status, title, priority_lane, priority_rank, done_at, done_by,
                              waiting_reason, initiative_id, opportunity_id, deadline_event_id, last_new_info_at, confidence)
      select ${u}, 'task', 'manual', s.st, 'Task ' || g, ${lanes}, g,
             case when s.st = 'done' then now() end, case when s.st = 'done' then 'engine'::actor_kind end,
             case when s.st = 'waiting_on_me' then 'session needs input' end,
             case when g % 4 = 0 then ${ids.initiative}::uuid end, case when g % 3 = 0 then ${ids.opp}::uuid end,
             case when g % 10 = 0 then ${ids.event}::uuid end, case when g % 6 = 0 then now() end, 0.8
        from generate_series(1, 210) g,
             lateral (select (array['open','in_progress','waiting_on_me','likely_done','done','suggested','waiting_on_others'])[1 + g % 7]::work_item_status as st) s`);
    for (const n of ids.noise) {
      await x(sql`
        insert into work_items (owner_user_id, kind, origin, status, title, priority_lane, priority_rank, done_at, done_by)
        select ${n}, 'task', 'manual', case when g % 20 = 0 then 'open' else 'done' end::work_item_status, 'Noise ' || g,
               ${lanes}, g, case when g % 20 <> 0 then now() end, case when g % 20 <> 0 then 'user'::actor_kind end
          from generate_series(1, 1500) g`);
    }
    ids.anchorItem = (await x(sql`select id from work_items where owner_user_id = ${u} and initiative_id is not null
                                   and status = 'open' order by priority_rank limit 1`)).rows[0]!.id as string;

    // Origin evidence for the user's items.
    await x(sql`
      insert into work_item_evidence (work_item_id, source_item_id, role, confidence, extractor_id, rationale)
      select w.id, si.id, 'origin', 0.9, ${ids.extractor}, 'asked in thread'
        from (select id, row_number() over (order by priority_rank) rn from work_items where owner_user_id = ${u}) w
        join (select id, row_number() over (order by occurred_at) rn from source_items where owner_user_id = ${u} and source = 'slack') si
          on si.rn = w.rn`);

    // Priority policy, run, scores, plan steps; NBAs for the top items.
    await x(sql`insert into priority_policies (id, owner_user_id, version, status, change_summary, source, activated_at)
                values (${ids.policy}, ${u}, 1, 'active', 'Role template default', 'role_template', now())`);
    const run = await x(sql`insert into priority_runs (owner_user_id, trigger, engine_version, policy_id, finished_at)
                            values (${u}, 'schedule', 'priority@1', ${ids.policy}, now()) returning id`);
    ids.runId = Number(run.rows[0]!.id);
    await x(sql`insert into priority_runs (owner_user_id, trigger, engine_version, policy_id, finished_at)
                select ${u}, 'schedule', 'priority@1', ${ids.policy}, now() - g * interval '1 hour' from generate_series(1, 50) g`);
    await x(sql`
      insert into priority_scores (run_id, work_item_id, policy_id, total, lane, rank, inputs_hash, explanation, latest_start_at)
      select ${ids.runId}, id, ${ids.policy}, 100 - priority_rank, priority_lane, priority_rank, 'in-' || id,
             'Ranked up: customer-facing, due before the ACME demo', now() + interval '1 hour'
        from work_items where owner_user_id = ${u} and priority_lane is not null`);
    await x(sql`update work_items w set priority_score_id = ps.id from priority_scores ps
                 where ps.work_item_id = w.id and ps.run_id = ${ids.runId}`);
    await x(sql`
      insert into priority_plan_steps (run_id, ordinal, mode, work_item_id, reason)
      select ${ids.runId}, g, (array['kickoff_background','meeting_prep','focus','quick_win'])[1 + g % 4]::plan_step_mode, w.id,
             'kick off the long build first'
        from generate_series(1, 6) g
        join lateral (select id from work_items where owner_user_id = ${u} and status = 'open' order by priority_rank offset g limit 1) w on true`);
    await x(sql`insert into priority_plan_steps (run_id, ordinal, mode, calendar_event_id, reason)
                values (${ids.runId}, 7, 'meeting', ${ids.event}, 'the ACME demo')`);
    await x(sql`
      insert into next_best_actions (owner_user_id, work_item_id, nba_version, type, title, inputs_hash, status, completeness)
      select ${u}, id, 1, 'reply', 'Reply in thread with the deck', 'nba-' || id, 'ready', 80
        from work_items where owner_user_id = ${u} and status in ('open', 'in_progress') and priority_rank < 60`);
    await x(sql`update work_items w set current_nba_id = n.id from next_best_actions n where n.work_item_id = w.id`);

    // Waiting on me: a Claude session and a tool run.
    await x(sql`insert into claude_sessions (id, owner_user_id, status, waiting_reason, waiting_since, cwd, title)
                values (${ids.session}, ${u}, 'waiting_on_me', 'permission_prompt', now() - interval '5 minutes', '~/Projects/demo', 'Build demo org')`);
    await x(sql`insert into claude_sessions (owner_user_id, status, title) select ${u}, 'completed', 'old ' || g from generate_series(1, 100) g`);
    await x(sql`insert into work_item_links (work_item_id, claude_session_id, role, confidence, extractor_id)
                values (${ids.anchorItem}, ${ids.session}, 'working_session', 0.9, ${ids.extractor})`);
    await x(sql`insert into tool_adapters (id, owner_user_id, key, name, kind) values (${ids.adapter}, ${u}, 'talk-track', 'Talk track', 'http_local')`);
    await x(sql`insert into tool_runs (owner_user_id, adapter_id, capability, input, status, started_at, work_item_id)
                values (${u}, ${ids.adapter}, 'generate_talk_track', '{}', 'waiting_on_me', now(), ${ids.anchorItem})`);
    await x(sql`insert into tool_runs (owner_user_id, adapter_id, capability, input, status)
                select ${u}, ${ids.adapter}, 'generate_talk_track', '{}', 'succeeded' from generate_series(1, 100) g`);

    // "Closed for you today": engine auto-closes with evidence.
    await x(sql`
      insert into work_item_transitions (work_item_id, from_status, to_status, actor_kind, reason, evidence_id, change_set_id, occurred_at)
      select w.id, 'open', 'done', 'engine', 'you replied in the thread', e.id, current_setting('cc.change_set_id')::uuid, now()
        from work_items w join work_item_evidence e on e.work_item_id = w.id
       where w.owner_user_id = ${u} and w.status = 'done'`);
    await x(sql`
      insert into work_item_transitions (work_item_id, from_status, to_status, actor_kind, occurred_at)
      select id, 'open', 'done', 'user', now() - interval '3 days' from work_items where owner_user_id = any(${sql.param(ids.noise)}::uuid[]) and status = 'done'`);

    // Attention: notifications + reauth.
    await x(sql`insert into notifications (owner_user_id, kind, severity, title, dedupe_key, action_route, action_kind)
                values (${u}, 'connector_auth_required', 'error', 'Gmail needs re-auth', 'connector:gmail:auth', '/settings/health#gmail', 'reauth'),
                       (${u}, 'auto_closed', 'info', 'Closed 3 items for you', 'auto_closed:today', '/work', 'undo')`);
    await x(sql`insert into notifications (owner_user_id, kind, severity, title, dedupe_key, status, resolved_at)
                select ${u}, 'app_error', 'warn', 'old ' || g, 'old:' || g, 'resolved', now() from generate_series(1, 300) g`);
    await x(sql`insert into reauth_attempts (connector_id, method, requested_by, status)
                values (${ids.gmail}, 'devbar_login', 'system', 'needs_user')`);

    // Deadline banner: Org62 read-back + pending entries.
    await x(sql`insert into org62_events (owner_user_id, org62_event_id, record_type_name, starts_at, ends_at, se_task_type_name)
                select ${u}, '00U' || g, 'Solutions Event', now() - g * interval '1 day', now() - g * interval '1 day' + interval '90 minutes', 'Demo'
                  from generate_series(1, 20) g`);
    await x(sql`insert into activity_entries (owner_user_id, dedupe_key, origin, subject, starts_at, ends_at, duration_hours, status, fiscal_period_id)
                select ${u}, 'cal|primary|evt-' || g, 'calendar', 'Demo ' || g, now() + g * interval '1 day',
                       now() + g * interval '1 day' + interval '1 hour', 1, 'proposed', ${ids.fiscal}
                  from generate_series(1, 5) g`);
    await x(sql`insert into activity_entries (owner_user_id, dedupe_key, origin, subject, starts_at, ends_at, duration_hours, status, fiscal_period_id, logged_at)
                select ${u}, 'cal|primary|past-' || g, 'calendar', 'Past ' || g, now() - g * interval '6 hours',
                       now() - g * interval '6 hours' + interval '1 hour', 1, 'logged', case when g % 2 = 0 then ${ids.fiscal}::uuid end, now()
                  from generate_series(1, 300) g`);

    // Triage: candidates, low-confidence mapping questions, a pending proposal.
    await x(sql`insert into extraction_candidates (owner_user_id, source_item_id, extractor_id, ordinal, proposed_kind, proposed_title, confidence, decision)
                select ${u}, si.id, ${ids.extractor}, 0, 'ask', 'Maybe an ask: ' || si.title, 0.4, case when si.rn % 4 = 0 then 'needs_triage' else 'created' end::candidate_decision
                  from (select id, title, row_number() over () rn from source_items where owner_user_id = ${u} and source = 'slack' limit 80) si`);
    await x(sql`insert into source_item_links (source_item_id, account_id, method, confidence)
                select id, ${ids.account}, case when rn % 5 = 0 then 'llm' else 'rule' end::link_method, case when rn % 5 = 0 then 0.5 else 0.95 end
                  from (select id, row_number() over () rn from source_items where owner_user_id = ${u} and source = 'slack' limit 100) s`);
    await x(sql`insert into change_proposals (owner_user_id, entity_type, entity_id, field, group_id, current_value, proposed_value, reason, base_version)
                values (${u}, 'work_items', ${ids.anchorItem}, 'due_at', ${randomUUID()}, 'null', '"2026-11-12T17:00:00Z"', 'Sam asked for Thursday', 1)`);

    await x(sql`insert into change_proposals (owner_user_id, entity_type, entity_id, field, group_id, current_value, proposed_value, reason, base_version)
                select ${u}, 'work_items', id, 'title', ${randomUUID()}, '"a"', '"b"', 'new info', 1
                  from work_items where owner_user_id = ${u} and priority_lane = 'top3'
                   and status in ('open', 'in_progress', 'waiting_on_me', 'likely_done') order by priority_rank limit 1`);

    for (const n of ids.noise) {
      await x(sql`insert into change_proposals (owner_user_id, entity_type, entity_id, field, group_id, proposed_value, reason, base_version, status)
                  select ${n}, 'work_items', id, 'title', gen_random_uuid(), '"x"', 'new info', 1,
                         case when priority_rank % 3 = 0 then 'pending' else 'rejected' end::proposal_status
                    from work_items where owner_user_id = ${n}`);
    }

    // Drive deliverable: baseline -> latest diff + judgment.
    await x(sql`insert into assets (id, owner_user_id, system, external_id, kind, title, url, last_modified_at, last_modifying_person_id)
                values (${ids.asset}, ${u}, 'drive', 'file-1', 'deck', 'ACME demo deck', 'https://docs.google.com/presentation/d/placeholder', now(), ${ids.person})`);
    const revs = await x(sql`insert into source_items (owner_user_id, source, kind, external_id, dedupe_key, content_hash, occurred_at)
                             select ${u}, 'drive', 'drive_file_revision', 'file-1', 'drive:file-1@' || g, 'rev' || g, now() - g * interval '1 day'
                               from generate_series(0, 1) g returning id`);
    await x(sql`insert into asset_snapshots (id, asset_id, source_item_id, sampled_at, modified_time, content_hash, extractor)
                values (${ids.snap0}, ${ids.asset}, ${revs.rows[1]!.id as string}, now() - interval '2 days', now() - interval '2 days', 's0', 'slides@1'),
                       (${ids.snap1}, ${ids.asset}, ${revs.rows[0]!.id as string}, now(), now(), 's1', 'slides@1')`);
    await x(sql`update assets set latest_snapshot_id = ${ids.snap1} where id = ${ids.asset}`);
    await x(sql`insert into asset_snapshot_diffs (id, asset_id, from_snapshot_id, to_snapshot_id, kind, summary, sections_added, sections_modified,
                                                  changed_section_keys, modified_by_me_only)
                values (${ids.diff}, ${ids.asset}, ${ids.snap0}, ${ids.snap1}, 'since_baseline', 'Pricing slide updated', 1, 2,
                        '{slide:7,slide:9}', true)`);
    await x(sql`insert into work_item_deliverables (id, work_item_id, asset_id, kind, baseline_snapshot_id, baseline_at, status)
                values (${ids.deliverable}, ${ids.anchorItem}, ${ids.asset}, 'slides', ${ids.snap0}, now() - interval '2 days', 'in_progress')`);
    await x(sql`insert into deliverable_judgments (id, deliverable_id, diff_id, verdict, confidence, requirement_verdicts)
                values (${ids.judgment}, ${ids.deliverable}, ${ids.diff}, 'partial', 0.7, '[]')`);
    await x(sql`update work_item_deliverables set latest_judgment_id = ${ids.judgment} where id = ${ids.deliverable}`);

    // LLM budget.
    await x(sql`insert into llm_budgets (id, owner_user_id, scope, daily_limit_usd, hard_stop, effective_from)
                values (${ids.budget}, ${u}, 'total', 15, true, ${today}::date - 10)`);
    await x(sql`insert into llm_budgets (owner_user_id, scope, scope_value, daily_limit_usd, effective_from)
                select ${u}, 'purpose', p, 2, ${today}::date - 10 from unnest(array['nba_generate', 'draft_generate', 'chat']) p`);
    for (const n of ids.noise) {
      await x(sql`insert into llm_budgets (owner_user_id, scope, scope_value, daily_limit_usd, effective_from)
                  select ${n}, 'purpose', p::text, 2, ${today}::date - 10 from unnest(enum_range(null::llm_purpose)) p`);
    }
    await x(sql`insert into llm_budget_days (budget_id, day, spent_usd, reserved_usd, call_count)
                values (${ids.budget}, ${today}, 0.42, 0.05, 37)`);

    // Briefs.
    await x(sql`insert into watch_subscriptions (id, owner_user_id, scope_kind, opportunity_id, label)
                values (${ids.subscription}, ${u}, 'opportunity', ${ids.opp}, 'ACME Data Cloud')`);
    await x(sql`insert into briefs (id, owner_user_id, subscription_id, period_start, period_end, status, highlight_count, generated_at, coverage_complete)
                values (${ids.brief}, ${u}, ${ids.subscription}, now() - interval '1 day', now(), 'ready', 4, now(), true)`);
    await x(sql`insert into briefs (owner_user_id, subscription_id, period_start, period_end, status, generated_at, seen_at)
                select ${u}, ${ids.subscription}, now() - (g + 1) * interval '1 day', now() - g * interval '1 day', 'ready', now(), now()
                  from generate_series(1, 60) g`);
    await x(sql`insert into brief_highlights (owner_user_id, brief_id, ordinal, title, relevance_score, level, topic_key)
                select ${u}, ${ids.brief}, g, 'Stage moved to Negotiation ' || g, 0.9 - g * 0.1, 'worth_a_look', 'topic-' || g
                  from generate_series(1, 4) g`);
    await x(sql`insert into brief_highlight_reasons (highlight_id, kind, feature_key, weight, explanation)
                select h.id, 'my_opportunity', 'opp:' || h.ordinal, 0.8, 'your opportunity' from brief_highlights h where h.brief_id = ${ids.brief}`);
  });

  // A few user change sets for ⌘Z / history.
  for (let i = 0; i < 3; i++) {
    await withChangeSet({ db, userId: u, actor: 'user', reason: `rename ${i}`, entity: { type: 'work_items', id: ids.anchorItem } }, (tx) =>
      tx.execute(sql`update work_items set title = ${`Prep ACME demo v${i}`} where id = ${ids.anchorItem}`),
    );
  }
  await db.execute(sql`analyze`);
}

const params: Record<StatementId, () => unknown[]> = {
  Q1: () => [ids.user],
  Q2: () => [ids.user],
  Q3: () => [ids.user, today],
  Q4: () => [ids.user],
  Q5: () => [ids.user],
  Q6: () => [ids.user, dayStart],
  Q7: () => [ids.user],
  Q8: () => [ids.user],
  Q9: () => [ids.user],
  Q10: () => [ids.anchorItem],
  Q11: () => [ids.anchorItem],
  Q12: () => [ids.user, 'thread-3', new Date(Date.now() - 86_400_000)],
  Q13: () => ['work_items', ids.anchorItem],
  Q14: () => [ids.user],
  Q15: () => [ids.user, today],
  Q16: () => [ids.user],
} as Record<StatementId, () => unknown[]>;

const READS = Object.keys(Q).filter((k) => k.startsWith('Q')) as StatementId[];

type PlanNode = { 'Index Name'?: string; Plans?: PlanNode[]; [k: string]: unknown };
function indexNames(node: PlanNode, acc = new Set<string>()): Set<string> {
  if (node['Index Name']) acc.add(node['Index Name']);
  for (const p of node.Plans ?? []) indexNames(p, acc);
  return acc;
}

async function explain(client: PoolClient, id: StatementId, opts: { forceIndexes: boolean }): Promise<Set<string>> {
  await client.query('begin');
  try {
    if (opts.forceIndexes) await client.query('set local enable_seqscan = off');
    const res = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`explain (format json) ${Q[id].text}`, params[id]());
    return indexNames(res.rows[0]!['QUERY PLAN'][0]!.Plan);
  } finally {
    await client.query('rollback');
  }
}

/**
 * Where the planner serves a §6 query with a different index than the one §6 lists, the
 * replacement must be in the plan instead (recorded in docs/reference/DB-NOTES.md). Every other listed
 * index must appear as-is.
 */
const PLANNER_USES_INSTEAD: Partial<Record<StatementId, Record<string, string>>> = {
  Q1: {
    // The origin lateral probes work_item_evidence_item_role_idx: same leading (work_item_id, role), narrower.
    work_item_evidence_target_uq: 'work_item_evidence_item_role_idx',
  },
  Q2: {
    // Partial on status NOT IN (done, dismissed, merged), implied by Q2's own predicate, so the
    // owner's done rows are never read.
    work_items_owner_status_idx: 'work_items_open_due_idx',
  },
  Q7: {
    // `status <> 'healthy' OR last_success_at < ...` can't be proven from the partial predicate;
    // an owner has a handful of connectors, so the owner-leading uidx is the right access path.
    connectors_owner_unhealthy_idx: 'connectors_owner_kind_name_uidx',
  },
};

beforeAll(seed);
afterAll(() => h.close());

describe('home-screen queries (DATA-MODEL §6)', () => {
  it('Q1 home list: top3/now/next/later with why, NBA, origin link and flags', async () => {
    const rows = await runStatement(h.pool, 'Q1', params.Q1());
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThanOrEqual(40);
    const lanes = rows.map((r) => r.priority_lane as string);
    expect(lanes).toEqual([...lanes].sort((a, b) => ['top3', 'now', 'next', 'later'].indexOf(a) - ['top3', 'now', 'next', 'later'].indexOf(b)));
    const r = rows[0]!;
    expect(r.why).toMatch(/Ranked up/);
    expect(r.origin_source).toBe('slack');
    expect(typeof r.degraded).toBe('boolean');
    expect(rows.some((x) => x.has_proposal === true)).toBe(true);
    expect(rows.some((x) => x.nba_type === 'reply')).toBe(true);
    expect(rows.some((x) => x.degraded === true)).toBe(false); // slack connector is healthy
  });

  it('Q2-Q16 return the expected shapes', async () => {
    const q2 = (await runStatement(h.pool, 'Q2', params.Q2()))[0]!;
    expect(Number(q2.in_triage)).toBe(30);
    expect(Number(q2.waiting_on_me)).toBe(30);
    const q3 = await runStatement(h.pool, 'Q3', params.Q3());
    expect(q3).toHaveLength(1);
    expect(q3[0]).toMatchObject({ title: 'ACME demo', opportunity: 'ACME Data Cloud', has_notes: true });
    expect(Number(q3[0]!.open_prep)).toBeGreaterThan(0);
    const q4 = await runStatement(h.pool, 'Q4', params.Q4());
    expect(q4.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(q4.at(-1)!.meeting).toBe('ACME demo');
    const q5 = await runStatement(h.pool, 'Q5', params.Q5());
    expect(q5.map((s) => s.source).sort()).toEqual(['claude_session', 'tool_run']);
    expect(q5.find((s) => s.source === 'claude_session')!.work_item_ids).toEqual([ids.anchorItem]);
    const q6 = await runStatement(h.pool, 'Q6', params.Q6());
    expect(q6).toHaveLength(30);
    expect(q6[0]!.undo_change_set_id).toBeTruthy();
    const q7 = await runStatement(h.pool, 'Q7', params.Q7());
    expect(q7.map((x) => x.source).sort()).toEqual(['connector', 'notification', 'notification']);
    expect(q7.find((x) => x.source === 'connector')).toMatchObject({ kind: 'gmail', severity: 'error', action_kind: 'needs_user' });
    const q8 = (await runStatement(h.pool, 'Q8', params.Q8()))[0]!;
    expect(q8.name).toBe('FY27 Q4');
    expect(Number(q8.cf_h)).toBeCloseTo(Number(q8.logged_h));
    expect(Number(q8.pending_h)).toBe(5);
    const q9 = await runStatement(h.pool, 'Q9', params.Q9());
    expect(new Set(q9.map((x) => x.kind))).toEqual(new Set(['suggested_item', 'candidate', 'mapping_question', 'proposal']));
    const q10 = await runStatement(h.pool, 'Q10', params.Q10());
    expect(q10[0]).toMatchObject({ initiative: 'ACME Headless Phase 2 demo', background_summary: 'Two demos so far.' });
    expect(q10.length).toBeGreaterThan(5);
    const q11 = await runStatement(h.pool, 'Q11', params.Q11());
    expect(q11[0]).toMatchObject({
      title: 'ACME demo deck',
      last_modified_by: 'Sam Placeholder',
      changed_since_created: 'Pricing slide updated',
      verdict: 'partial',
    });
    const q12 = await runStatement(h.pool, 'Q12', params.Q12());
    expect(q12).toHaveLength(1);
    const q13 = await runStatement(h.pool, 'Q13', params.Q13());
    expect(q13.map((x) => x.summary)).toEqual(expect.arrayContaining(['rename 2', 'rename 1', 'rename 0', 'seed home screen']));
    const q14 = await runStatement(h.pool, 'Q14', params.Q14());
    expect(q14[0]!.summary).toBe('rename 2');
    const q15 = await runStatement(h.pool, 'Q15', params.Q15());
    expect(q15).toHaveLength(4);
    expect(q15.find((b) => b.scope === 'total')).toMatchObject({ hard_stop: true, spent_usd: '0.420000' });
    const q16 = await runStatement(h.pool, 'Q16', params.Q16());
    expect(q16).toHaveLength(3);
    expect(q16[0]).toMatchObject({ label: 'ACME Data Cloud', reasons: 'your opportunity' });
  });

  it('Q1 uses work_items_home_lane_rank_idx with the planner left alone', async () => {
    const client = await h.pool.connect();
    try {
      expect([...(await explain(client, 'Q1', { forceIndexes: false }))]).toContain('work_items_home_lane_rank_idx');
    } finally {
      client.release();
    }
  });

  it.each(READS)('%s: EXPLAIN uses its supporting indexes', async (id) => {
    const client = await h.pool.connect();
    try {
      const used = await explain(client, id, { forceIndexes: true });
      const swaps = PLANNER_USES_INSTEAD[id] ?? {};
      const expected = Q[id].indexNames.map((n) => swaps[n] ?? n);
      expect(expected.length).toBeGreaterThan(0);
      for (const name of expected) expect([...used], `${id} should use ${name}`).toContain(name);
    } finally {
      client.release();
    }
  });
});

describe('write paths (DATA-MODEL §6.2) run verbatim', () => {
  it('W1 re-ingest is idempotent: same content = no-op, changed content = revision + 1', async () => {
    const args = (hash: string, body: string) => [
      ids.user, ids.slack, 'slack', 'slack_message', 'w1-ts', 'w1-thread', 'slack:T:C:w1-ts', hash, new Date(),
      'title', 'https://example.slack.com/w1', body, true, false, null,
    ];
    const a = await runStatement(h.pool, 'W1', args('h1', 'I will send the deck'));
    expect(a[0]).toMatchObject({ inserted: true, revision: 1 });
    expect(await runStatement(h.pool, 'W1', args('h1', 'I will send the deck'))).toHaveLength(0);
    const c = await runStatement(h.pool, 'W1', args('h2', 'I will send the deck and the SOW'));
    expect(c[0]).toMatchObject({ id: a[0]!.id, inserted: false, revision: 2 });
  });

  it('W5 autosave coalesces into one revision per editor burst; W6 closes it; W7 purges expired bodies', async () => {
    const draftId = randomUUID();
    const save = (doc: object) =>
      runStatement(h.pool, 'W5', [ids.user, draftId, JSON.stringify(doc), `h${JSON.stringify(doc).length}`, 'tab-9', null]);
    const r1 = await save({ type: 'doc', content: [] });
    const r2 = await save({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(r2[0]).toMatchObject({ id: r1[0]!.id, revision: 1, save_count: 2 });
    await h.pool.query(`update content_revisions set last_saved_at = now() - interval '1 minute' where entity_id = $1`, [draftId]);
    const w6 = await runStatement(h.pool, 'W6', [30]);
    expect(w6.length).toBeGreaterThanOrEqual(0);
    const r3 = await save({ type: 'doc', content: [{ type: 'heading' }] });
    expect(r3[0]).toMatchObject({ revision: 2, save_count: 1 });

    await h.pool.query(`update source_items set body = 'old', body_expires_at = now() - interval '1 day' where dedupe_key = 'slack:T:C:w1-ts'`);
    const w7 = (await runStatement(h.pool, 'W7'))[0]!;
    expect(Number(w7.bodies_purged)).toBeGreaterThanOrEqual(1);
    const { rows } = await h.pool.query(`select body, body_purged_at from source_items where dedupe_key = 'slack:T:C:w1-ts'`);
    expect(rows[0]).toMatchObject({ body: null });
    expect(rows[0].body_purged_at).not.toBeNull();
  });
});
