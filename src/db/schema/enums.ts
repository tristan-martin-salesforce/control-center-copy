/**
 * Engine-owned closed sets (DATA-MODEL §3.1). Adding a value = a new migration with
 * ALTER TYPE ... ADD VALUE; never reorder (priority_lane's order is its display order).
 * Leaf module: imports nothing from the other schema files.
 */
import {
  pgEnum,
} from 'drizzle-orm/pg-core';

export const sourceSystem = pgEnum('source_system', [
  'slack', 'gmail', 'calendar', 'drive', 'gemini_notes', 'org62', 'vdp', 'claude', 'git',
  'manual', 'chat', 'tool', 'app',
]);

export const sourceItemKind = pgEnum('source_item_kind', [
  'slack_message', 'slack_canvas_snapshot', 'email_message', 'calendar_event',
  'drive_file_revision', 'gemini_note', 'meeting_transcript', 'org62_record_snapshot',
  'vdp_record_snapshot', 'claude_session', 'git_commit', 'manual_note', 'tool_output',
]);

export const bodyFormat = pgEnum('body_format', ['plain', 'slack_mrkdwn', 'html', 'markdown']);

export const actorKind = pgEnum('actor_kind', [
  'user', 'engine', 'chat', 'connector', 'system', 'autonomy_policy',
]);

export const userVerdict = pgEnum('user_verdict', ['confirmed', 'rejected']);

export const linkMethod = pgEnum('link_method', ['connector', 'rule', 'llm', 'user', 'chat']);

export const modelTier = pgEnum('model_tier', ['none', 'haiku', 'sonnet', 'opus']);

// connectors
export const connectorTransport = pgEnum('connector_transport', [
  'mcp_http', 'mcp_stdio', 'claude_headless', 'agent_sdk', 'local_files', 'local_api', 'cli',
]);

export const connectorStatus = pgEnum('connector_status', [
  'healthy', 'degraded', 'stale', 'auth_required', 'paused', 'disabled', 'error',
]);

export const authEventKind = pgEnum('auth_event_kind', [
  'expiring_soon', 'expired', 'refreshed', 'revoked', 'mfa_required', 'reauth_requested',
  'reauth_succeeded', 'reauth_failed',
]);

export const reauthMethod = pgEnum('reauth_method', [
  'refresh_script', 'mcp_oauth', 'devbar_login', 'manual_instructions',
]);

export const reauthStatus = pgEnum('reauth_status', [
  'requested', 'running', 'needs_user', 'succeeded', 'failed', 'cancelled',
]);

// scanning
export const cursorKind = pgEnum('cursor_kind', [
  'timestamp', 'page_token', 'sync_token', 'history_id', 'byte_offset', 'record_modstamp', 'composite',
]);

export const cursorStatus = pgEnum('cursor_status', ['active', 'backfilling', 'paused', 'retired']);

export const scanTrigger = pgEnum('scan_trigger', [
  'schedule', 'startup_catchup', 'manual', 'chat', 'hook', 'reconcile',
]);

export const scanMode = pgEnum('scan_mode', ['incremental', 'backfill', 'reconcile', 'probe']);

export const runStatus = pgEnum('run_status', [
  'queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled',
]);

export const ledgerObjectKind = pgEnum('ledger_object_kind', [
  'channel_history', 'thread', 'dm', 'search_query', 'mailbox_page', 'calendar_range',
  'drive_query', 'file', 'transcript_file', 'soql_query', 'vdp_list', 'git_log', 'canvas',
]);

export const ledgerOutcome = pgEnum('ledger_outcome', ['complete', 'truncated', 'error', 'skipped']);

export const reconcileKind = pgEnum('reconcile_kind', [
  'coverage_gap', 'unlinked_item', 'missed_item', 'stale_cursor', 'count_mismatch',
  'deleted_upstream', 'duplicate_suspect', 'orphan_evidence',
]);

export const reconcileStatus = pgEnum('reconcile_status', ['open', 'rescan_queued', 'resolved', 'ignored']);

// sources, extraction, entities
export const refKind = pgEnum('ref_kind', [
  'person_mention', 'email_address', 'url', 'drive_file', 'slack_permalink', 'org62_id',
  'vdp_slug', 'repo_path', 'file_path', 'git_sha', 'calendar_event',
]);

export const entityLinkRole = pgEnum('entity_link_role', [
  'about', 'from', 'to', 'mentions', 'attachment', 'container',
]);

export const extractorKind = pgEnum('extractor_kind', ['parser', 'rule', 'llm', 'user', 'chat']);

export const candidateDecision = pgEnum('candidate_decision', [
  'pending', 'created', 'merged', 'needs_triage', 'rejected',
]);

export const aliasKind = pgEnum('alias_kind', [
  'name', 'short_name', 'domain', 'title_token', 'channel_pattern', 'repo_path', 'regex',
]);

export const ruleSource = pgEnum('rule_source', ['seed', 'team_pack', 'user_correction', 'llm_suggested']);

export const personAffiliation = pgEnum('person_affiliation', ['internal', 'customer', 'partner', 'unknown']);

export const stakeholderTier = pgEnum('stakeholder_tier', [
  'leader', 'manager', 'ae', 'teammate', 'customer_exec', 'customer', 'partner', 'normal', 'low',
]);

export const identitySystem = pgEnum('identity_system', [
  'slack', 'email', 'org62_user', 'org62_contact', 'google', 'github', 'vdp',
]);

export const channelKind = pgEnum('channel_kind', ['public', 'private', 'dm', 'group_dm', 'shared_external']);

export const watchMode = pgEnum('watch_mode', ['items', 'digest', 'ignore']);

export const repoKind = pgEnum('repo_kind', ['customer', 'demo_shared', 'tool', 'internal', 'unknown']);

export const assetKind = pgEnum('asset_kind', [
  'deck', 'doc', 'sheet', 'pdf', 'demo_org', 'repo_artifact', 'recording', 'talk_track',
  'estimate', 'link', 'other',
]);

export const assetSystem = pgEnum('asset_system', ['drive', 'local_fs', 'slack_file', 'vdp', 'tool']);

export const mappingRuleKind = pgEnum('mapping_rule_kind', [
  'domain_to_account', 'channel_to_account', 'repo_path_to_account', 'title_token_to_account',
  'sender_to_person', 'keyword_to_task_type', 'meeting_to_opportunity', 'ignore_sender',
  'ignore_channel',
  // 0032 (attribution engine): a contact's email -> account, a distinctive word -> opportunity
  'person_to_account', 'keyword_to_opportunity',
]);

export const teamRuleKind = pgEnum('team_rule_kind', [
  'recurring_task', 'deadline_task', 'coverage_check', 'logging_rule', 'classification_rule',
]);

export const taskTypeBucket = pgEnum('task_type_bucket', ['pre_sale', 'post_sale', 'enablement', 'neither', 'pto']);

// calendar
export const calendarEventType = pgEnum('calendar_event_type', [
  'default', 'out_of_office', 'focus_time', 'working_location',
]);

export const calendarEventStatus = pgEnum('calendar_event_status', ['confirmed', 'tentative', 'cancelled']);

export const responseStatus = pgEnum('response_status', [
  'accepted', 'declined', 'tentative', 'needs_action', 'none',
]);

export const attendance = pgEnum('attendance', ['unknown', 'attended', 'missed', 'partial', 'not_applicable']);

export const attendanceSource = pgEnum('attendance_source', [
  'calendar_inference', 'transcript', 'notes_attendees', 'user',
]);

export const meetingNoteKind = pgEnum('meeting_note_kind', [
  'gemini_notes', 'transcript', 'zoom_summary', 'pasted_notes', 'manual',
]);

export const noteMatchMethod = pgEnum('note_match_method', [
  'calendar_attachment', 'title_and_date', 'email_subject', 'user',
]);

// work items
export const workItemKind = pgEnum('work_item_kind', [
  'task', 'commitment', 'ask', 'training', 'background_promise', 'travel', 'missed_meeting_followup',
]);

export const workItemOrigin = pgEnum('work_item_origin', [
  'manual', 'said_by_me', 'asked_of_me', 'meeting_next_step', 'system_rule', 'chat',
  'missed_opp_scan', 'reconcile', 'tool',
]);

export const workItemStatus = pgEnum('work_item_status', [
  'suggested', 'open', 'in_progress', 'waiting_on_others', 'waiting_on_me', 'likely_done',
  'done', 'snoozed', 'dismissed', 'merged',
]);

/**
 * R-UI-22 (BE-0 addition, migration 0003): how a terminal item ended. Set only while status is
 * done / dismissed / merged; a reopen clears it (history stays in audit + transitions).
 */
export const workItemResolution = pgEnum('work_item_resolution', [
  'done_by_me', 'handed_off', 'done_by_other', 'not_needed', 'duplicate', 'declined', 'superseded',
]);

/** R-UI-22: my involvement in an item. A hand-off moves me to watcher / not_involved. */
export const workItemInvolvement = pgEnum('work_item_involvement', [
  'owner', 'contributor', 'watcher', 'not_involved',
]);

export const dueKind = pgEnum('due_kind', ['hard', 'soft', 'inferred']);

export const effortSource = pgEnum('effort_source', ['default', 'llm', 'history', 'user']);

export const importanceLevel = pgEnum('importance_level', ['critical', 'high', 'normal', 'low']);

export const closureKind = pgEnum('closure_kind', [
  'manual_only', 'reply_in_thread', 'email_sent', 'claude_session_completed', 'asset_delivered',
  'deliverable_judged', 'org62_readback', 'vdp_readback', 'tool_run_succeeded', 'training_completed',
  'llm_match',
]);

export const evidenceRole = pgEnum('evidence_role', [
  'origin', 'progress', 'completion', 'context', 'contradiction',
]);

export const workItemLinkRole = pgEnum('work_item_link_role', [
  'stakeholder', 'deliverable', 'working_session', 'missed_meeting', 'prep_for', 'related',
]);

export const workItemRelationKind = pgEnum('work_item_relation_kind', [
  'blocks', 'related', 'duplicate_of', 'follow_up_of',
]);

export const trainingProvider = pgEnum('training_provider', [
  'trailhead', 'workday_learning', 'internal_lms', 'slack', 'email', 'other',
]);

export const travelStepStatus = pgEnum('travel_step_status', [
  'not_started', 'submitted', 'approved', 'rejected', 'done', 'not_applicable',
]);

// Drive deliverables (R-UI-15)
export const assetTrackingTier = pgEnum('asset_tracking_tier', ['none', 'inventory', 'watched']);

export const snapshotStatus = pgEnum('snapshot_status', [
  'ok', 'unreadable', 'permission_denied', 'too_large', 'unsupported',
]);

export const sectionKind = pgEnum('section_kind', [
  'slide', 'heading_section', 'doc_tab', 'sheet_tab', 'page', 'whole_file',
]);

export const diffKind = pgEnum('diff_kind', ['consecutive', 'since_baseline', 'ad_hoc']);

export const deliverableKind = pgEnum('deliverable_kind', ['slides', 'doc', 'whitepaper', 'sheet', 'other']);

export const deliverableStatus = pgEnum('deliverable_status', [
  'file_unresolved', 'not_started', 'in_progress', 'likely_complete', 'complete', 'abandoned',
]);

export const requirementStatus = pgEnum('requirement_status', [
  'pending', 'addressed', 'partially_addressed', 'not_addressed', 'unclear', 'waived',
]);

export const judgmentVerdict = pgEnum('judgment_verdict', ['complete', 'partial', 'no_change', 'regressed', 'unclear']);

// Initiatives, proposals, reopen (R-UI-20)
export const initiativeStatus = pgEnum('initiative_status', ['proposed', 'active', 'paused', 'completed', 'abandoned']);

export const initiativeLinkRole = pgEnum('initiative_link_role', [
  'stakeholder', 'asset', 'working_session', 'milestone_meeting', 'channel', 'related_opportunity', 'repo',
]);

export const proposalStatus = pgEnum('proposal_status', ['pending', 'accepted', 'rejected', 'superseded', 'expired']);

export const reopenOutcome = pgEnum('reopen_outcome', ['reopened', 'new_sibling', 'attached_as_context', 'ignored']);

// Watch subscriptions + briefs (R-UI-21)
export const watchScopeKind = pgEnum('watch_scope_kind', [
  'channel', 'opportunity', 'account', 'person', 'initiative', 'search_query',
]);

export const briefCadence = pgEnum('brief_cadence', ['since_last', 'daily', 'weekly', 'on_demand']);

export const briefStyle = pgEnum('brief_style', ['digest', 'narrative', 'changes_only']);

export const briefStatus = pgEnum('brief_status', ['generating', 'ready', 'failed', 'superseded']);

export const highlightLevel = pgEnum('highlight_level', ['must_read', 'worth_a_look', 'fyi']);

export const highlightStatus = pgEnum('highlight_status', ['new', 'seen', 'promoted', 'dismissed']);

export const highlightReasonKind = pgEnum('highlight_reason_kind', [
  'my_account', 'my_opportunity', 'my_initiative', 'mentions_me', 'my_interest', 'policy_rule',
  'stakeholder', 'keyword', 'similar_to_promoted', 'org62_change',
]);

export const relevanceFeedbackKind = pgEnum('relevance_feedback_kind', [
  'promoted_to_triage', 'promoted_to_work_item', 'dismissed_not_relevant', 'marked_useful', 'opened',
]);

export const interestKind = pgEnum('interest_kind', ['skill', 'product', 'topic', 'keyword']);

// Per-user policy + agent behavior (R-UI-16)
export const configSource = pgEnum('config_source', ['role_template', 'team_pack', 'user', 'chat', 'learned']);

export const policyStatus = pgEnum('policy_status', ['draft', 'active', 'retired']);

export const policyRuleKind = pgEnum('policy_rule_kind', [
  'boost', 'penalty', 'sla', 'lane_floor', 'lane_cap', 'never_above', 'exclude',
]);

export const captureAction = pgEnum('capture_action', ['auto_accept', 'triage', 'ignore']);

// priority
export const priorityTrigger = pgEnum('priority_trigger', [
  'schedule', 'new_info', 'calendar_change', 'user_reprioritize', 'chat', 'startup',
]);

/** Declaration order is display order (ORDER BY priority_lane works). */
export const priorityLane = pgEnum('priority_lane', ['top3', 'now', 'next', 'later', 'background', 'hidden']);

export const planStepMode = pgEnum('plan_step_mode', [
  'kickoff_background', 'meeting_prep', 'focus', 'quick_win', 'meeting', 'buffer',
]);

// NBA
export const nbaType = pgEnum('nba_type', [
  'reply', 'send_email', 'draft_doc', 'start_claude_session', 'run_tool', 'log_activity',
  'update_vdp', 'schedule', 'nudge', 'confirm_done',
  // CONTRACT-1 (migration 0004): NBA verb for a Drive deliverable judged ready to review.
  'review_deliverable',
]);

export const nbaStatus = pgEnum('nba_status', [
  'generating', 'ready', 'needs_input', 'stale', 'accepted', 'executing', 'completed', 'failed',
  'superseded', 'dismissed',
]);

export const supersedeReason = pgEnum('supersede_reason', [
  'new_source_item', 'work_item_changed', 'entity_changed', 'calendar_changed', 'user_feedback',
  'model_or_prompt_upgrade', 'manual_refresh', 'expired',
]);

export const provenanceRole = pgEnum('provenance_role', ['trigger', 'context', 'quoted', 'basis']);

// drafts / outbox
export const draftActionType = pgEnum('draft_action_type', [
  'slack_message', 'slack_reply', 'email_message', 'email_reply', 'vdp_update',
  'org62_activity_batch', 'org62_deal_contribution', 'calendar_hold', 'canvas_rewrite', 'handoff',
]);

export const outboundChannel = pgEnum('outbound_channel', [
  'slack', 'email', 'vdp', 'org62', 'calendar', 'slack_canvas',
]);

export const deliveryMode = pgEnum('delivery_mode', ['send', 'stage', 'handoff']);

export const autonomyLevel = pgEnum('autonomy_level', [
  'L0_suggest', 'L1_draft', 'L2_stage', 'L3_one_click', 'L4_auto',
]);

export const draftStatus = pgEnum('draft_status', [
  'drafting', 'ready', 'approved', 'scheduled', 'sending', 'unconfirmed', 'sent', 'staged',
  'handed_off', 'verified', 'verify_failed', 'failed', 'rejected', 'discarded', 'superseded',
]);

export const approvalMethod = pgEnum('approval_method', ['click', 'keyboard', 'chat_confirm', 'autonomy_policy']);

export const recipientRole = pgEnum('recipient_role', ['to', 'cc', 'bcc', 'channel', 'mention']);

export const renditionFormat = pgEnum('rendition_format', [
  'slack_mrkdwn', 'slack_blocks', 'email_html', 'email_text', 'canvas_markdown', 'plain_text',
]);

export const sendAttemptStatus = pgEnum('send_attempt_status', ['started', 'succeeded', 'failed', 'unknown']);

export const verificationMethod = pgEnum('verification_method', [
  'slack_read', 'gmail_read', 'org62_soql', 'vdp_read', 'canvas_read', 'calendar_read', 'user_confirmed',
]);

export const verificationStatus = pgEnum('verification_status', [
  'pending', 'matched', 'mismatch', 'not_found', 'error',
]);

// Claude sessions
export const claudeEntrypoint = pgEnum('claude_entrypoint', [
  'cli', 'desktop', 'vscode', 'cowork', 'agent_sdk', 'scheduled_task', 'unknown',
]);

export const claudeSessionStatus = pgEnum('claude_session_status', [
  'launching', 'launch_failed', 'running', 'idle', 'waiting_on_me', 'completed', 'errored', 'abandoned',
]);

export const waitingOnMeReason = pgEnum('waiting_on_me_reason', [
  'permission_prompt', 'question', 'plan_approval', 'error', 'review_output', 'input_needed',
]);

export const titleSource = pgEnum('title_source', ['custom', 'ai', 'first_prompt', 'app']);

export const launchMode = pgEnum('launch_mode', ['desktop_session', 'agent_sdk', 'cli_headless']);

// time + activity logging
export const timeBlockSource = pgEnum('time_block_source', [
  'calendar', 'claude_hands_on', 'claude_background', 'doc_edit', 'slack_burst', 'git', 'manual',
  'estimate', 'travel', 'onsite',
]);

export const attentionKind = pgEnum('attention_kind', ['meeting', 'focused', 'background', 'ambient']);

export const activityOrigin = pgEnum('activity_origin', [
  'calendar', 'evidence', 'build_estimate', 'manual', 'chat', 'legacy_recreate', 'duration_backfill',
]);

export const org62Operation = pgEnum('org62_operation', ['create', 'update', 'delete']);

export const whatKind = pgEnum('what_kind', ['opportunity', 'account', 'dsr', 'strategic_initiative', 'none']);

export const activityStatus = pgEnum('activity_status', [
  'upcoming', 'needs_input', 'proposed', 'approved', 'synced_to_canvas', 'logged', 'verified',
  'verify_failed', 'excluded', 'dismissed', 'dropped',
]);

export const excludedReason = pgEnum('excluded_reason', [
  'neither_type', 'overlap', 'ooo', 'placeholder', 'cap_trimmed', 'duplicate',
]);

export const canvasPurpose = pgEnum('canvas_purpose', ['review_dashboard', 'slackbot_work_order']);

export const canvasSyncStatus = pgEnum('canvas_sync_status', ['in_sync', 'dirty', 'syncing', 'error']);

export const canvasSection = pgEnum('canvas_section', [
  'add_events', 'add_deal_contributions', 'update_fields', 'delete_events', 'needs_input',
  'ready_to_load', 'upcoming', 'recently_logged',
]);

export const dcRequestStatus = pgEnum('dc_request_status', [
  'proposed', 'approved', 'synced_to_canvas', 'logged', 'verified', 'dismissed',
]);

// Org62 missed-opportunity scan (R-UI-14)
export const missedOppTier = pgEnum('missed_opp_tier', [
  'won_no_dc', 'strong_evidence_no_dc', 'core_account_no_dc', 'core_account_flex_only', 'renewal',
  'light_touch', 'light_touch_flex_only', 'stranded_dc', 'already_covered',
]);

export const missedOppVerdict = pgEnum('missed_opp_verdict', ['claim', 'check', 'skip']);

export const evidenceStrength = pgEnum('evidence_strength', ['strong', 'some', 'none']);

export const oppFindingStatus = pgEnum('opp_finding_status', [
  'new', 'reviewing', 'actioned', 'dismissed', 'resolved',
]);

// jobs, LLM, chat, audit, tools
/** 'queued' includes retry-waiting (run_at in the future); 'dead' is the dead-letter state. */
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'succeeded', 'dead', 'cancelled']);

export const errorClass = pgEnum('error_class', [
  'transient', 'rate_limited', 'auth', 'validation', 'not_found', 'budget', 'bug', 'unknown',
]);

export const severity = pgEnum('severity', ['debug', 'info', 'warn', 'error', 'critical']);

export const notificationKind = pgEnum('notification_kind', [
  'connector_auth_required', 'connector_degraded', 'job_dead_lettered', 'send_failed', 'verify_failed',
  'deadline_approaching', 'budget_alert', 'budget_blocked', 'claude_waiting_on_me', 'likely_done_review',
  'auto_closed', 'missed_meeting_followup', 'reconcile_gap', 'app_error',
]);

export const notificationStatus = pgEnum('notification_status', [
  'open', 'seen', 'snoozed', 'acknowledged', 'resolved', 'expired',
]);

export const changeSetKind = pgEnum('change_set_kind', [
  'user_edit', 'autosave_burst', 'engine_pass', 'chat_tool_call', 'connector_sync', 'undo', 'redo',
  'rollback', 'system',
]);

export const catchUpPolicy = pgEnum('catch_up_policy', ['run_once', 'backfill_window', 'skip_missed']);

export const llmPurpose = pgEnum('llm_purpose', [
  'scan_extract', 'classify', 'commitment_extract', 'merge_check', 'done_match', 'resolve_entity',
  'enrich', 'priority_explain', 'nba_generate', 'draft_generate', 'summarize', 'chat', 'other',
]);

export const llmCallStatus = pgEnum('llm_call_status', ['ok', 'error', 'refused', 'timeout', 'budget_blocked']);

export const budgetScope = pgEnum('budget_scope', ['total', 'purpose', 'model_tier']);

export const chatScope = pgEnum('chat_scope', ['global', 'day', 'work_item', 'account', 'opportunity']);

export const chatRole = pgEnum('chat_role', ['user', 'assistant', 'system', 'tool']);

export const toolCallStatus = pgEnum('tool_call_status', [
  'proposed', 'awaiting_confirmation', 'running', 'succeeded', 'failed', 'rejected',
]);

export const auditOp = pgEnum('audit_op', ['insert', 'update', 'delete']);

export const toolAdapterKind = pgEnum('tool_adapter_kind', ['http_local', 'cli', 'skill', 'claude_session', 'mcp']);

export const toolRunStatus = pgEnum('tool_run_status', [
  'queued', 'running', 'waiting_on_me', 'succeeded', 'failed', 'cancelled',
]);

export const toolOutputKind = pgEnum('tool_output_kind', ['url', 'asset', 'file', 'text']);
