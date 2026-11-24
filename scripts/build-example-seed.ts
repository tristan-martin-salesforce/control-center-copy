/**
 * Generates src/mock/seed.example.json: committed PLACEHOLDER data only (ACME, Globex, Initech, Umbrella,
 * Hooli; Dana, Marcus, …). No real customers. Run: `npm run seed:example`.
 *
 * The seed's "now" is Thu 2026-11-05 09:02 MT (America/Denver); the mock rebases every date onto today on load.
 * The real fixture lives outside the repo (SEED lane): ~/Library/Application Support/command-center/fixtures/seed.json
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TIME_SETTINGS, Seed } from '../src/contract';
import {
  type In, t, day, me, P, NOW, people, accounts, opps, missedOpps, initiatives, assets, events, slots,
} from './build-example-seed.world';
import {
  workItems, evidence, nbas, drafts, proposals, agentRuns, toolAdapters, toolRuns, activity,
} from './build-example-seed.work';

const timeBlocks: In['timeBlocks'] = [
  { id: 'tb_c1', lane: 'claude', start: t(-3, '13:00'), end: t(-3, '15:00'), label: 'Claude · ACME data model' },
  { id: 'tb_c2', lane: 'claude', start: t(-1, '18:00'), end: t(-1, '18:40'), label: 'Claude · Hooli research' },
  { id: 'tb_c3', lane: 'claude', start: t(0, '08:52'), end: t(0, '09:02'), label: 'Claude · ACME build (running)' },
  { id: 'tb_d1', lane: 'drive', start: t(-2, '15:30'), end: t(-2, '16:20'), label: 'Globex SOW v3' },
  { id: 'tb_d2', lane: 'drive', start: t(-1, '17:30'), end: t(-1, '18:20'), label: 'Hooli NCE evaluation plan' },
  { id: 'tb_d3', lane: 'drive', start: t(0, '08:35'), end: t(0, '08:40'), label: 'Hooli NCE evaluation plan' },
  { id: 'tb_s1', lane: 'slack', start: t(-2, '16:30'), end: t(-2, '16:45'), label: '#acme-ext' },
  { id: 'tb_s2', lane: 'slack', start: t(0, '08:10'), end: t(0, '08:20'), label: '#acme-ext, #hooli-ext' },
  { id: 'tb_f1', lane: 'focus', start: t(-2, '09:00'), end: t(-2, '11:00'), label: 'Focus: Umbrella deck' },
];

// ---------------------------------------------------------------------------
// briefs / watches
// ---------------------------------------------------------------------------
const briefs: In['briefs'] = [
  {
    id: 'brief_team',
    kind: 'channel',
    title: '#team-updates',
    subscriptionId: 'watch_team',
    period: { from: t(-1, '07:30'), to: t(0, '07:30') },
    through: t(0, '07:30'),
    sources: [{ kind: 'slack', label: '#team-updates' }],
    summary: 'Busy day in #team-updates: the FY27 D360 rate card landed, two SEs compared zero-copy patterns for Snowflake, and product confirmed NCE GA timing. Most of it is reference material; two items touch your deals.',
    unread: true,
    status: 'ready',
    highlights: [
      { id: 'hl_ratecard', version: 1, briefId: 'brief_team', title: 'FY27 D360 rate card published', summary: 'New consumption tiers; affects the Globex estimate you owe Friday.', relevance: 'high', reasons: ['Globex D360 expansion (Negotiation, $1.2M)', 'Open task: share the consumption estimate'], sources: [{ kind: 'slack', label: '#team-updates · pinned' }], status: 'new', at: t(-1, '15:10') },
      { id: 'hl_nce_ga', version: 1, briefId: 'brief_team', title: 'NCE GA moved to February', summary: 'Product confirmed the GA date; Hooli’s evaluation timeline may need a note.', relevance: 'high', reasons: ['Hooli Nimbus Context Engine evaluation', 'Policy: customer-facing first'], sources: [{ kind: 'slack', label: '#team-updates · thread' }], status: 'new', at: t(-1, '11:40') },
      { id: 'hl_zerocopy', version: 1, briefId: 'brief_team', title: 'Zero-copy Snowflake pattern write-up', summary: 'Kim shared a pattern doc that matches Initech’s stack.', relevance: 'medium', reasons: ['Initech D360 pilot (Snowflake)'], sources: [{ kind: 'slack', label: '#team-updates · Kim Tran' }], status: 'seen', at: t(-1, '10:05') },
    ],
    everythingElse: [
      { thread: 'Office hours schedule', items: [{ at: t(-1, '09:00'), author: 'Kim Tran', text: 'Office hours move to Thursdays.' }] },
      { thread: 'Demo org quotas', items: [{ at: t(-1, '13:20'), author: 'SE Ops', text: 'Quotas reset Monday.' }, { at: t(-1, '13:30'), author: 'Kim Tran', text: 'Thanks!' }] },
    ],
    generatedAt: t(0, '07:31'),
  },
  {
    id: 'brief_opp_globex',
    kind: 'opp',
    title: 'Globex · Data 360 Expansion',
    oppId: 'opp_globex_d360',
    accountId: 'acc_globex',
    period: { from: t(-1, '07:30'), to: t(0, '07:30') },
    through: t(0, '07:30'),
    sources: [{ kind: 'org62', label: 'Org62 · opportunity' }, { kind: 'gmail', label: 'Gmail · 3 threads' }, { kind: 'slack', label: '#globex-deal' }],
    summary: 'Stage moved to **Negotiation** and the close date held at month end. Marcus asked for revised pricing; legal still has the DPA. Elena flagged an 18% discount that needs approval.',
    unread: true,
    status: 'ready',
    highlights: [
      { id: 'hl_globex_discount', version: 1, briefId: 'brief_opp_globex', title: '18% discount needs approval', summary: 'Elena raised it in #globex-deal; it blocks the SOW.', relevance: 'high', reasons: ['Your SOW reply is due today', 'Deal value $1.2M'], sources: [{ kind: 'slack', label: '#globex-deal' }], status: 'new', at: t(-1, '16:45') },
      { id: 'hl_globex_stage', version: 1, briefId: 'brief_opp_globex', title: 'Stage → Negotiation', summary: 'Org62 stage change by Elena.', relevance: 'medium', reasons: ['Your VDP should reflect the stage'], sources: [{ kind: 'org62', label: 'Org62 · field history' }], status: 'new', at: t(-1, '17:00') },
    ],
    everythingElse: [],
    generatedAt: t(0, '07:32'),
  },
  {
    id: 'brief_opp_acme',
    kind: 'opp',
    title: 'ACME · Headless Phase 2',
    oppId: 'opp_acme_p2',
    accountId: 'acc_acme',
    period: { from: t(-1, '07:30'), to: t(0, '07:30') },
    through: t(0, '07:30'),
    sources: [{ kind: 'slack', label: '#acme-ext' }, { kind: 'org62', label: 'Org62 · opportunity' }],
    summary: 'Quiet day. Dana asked about SSO (answered) and the demo scope (open). No Org62 changes.',
    unread: false,
    status: 'ready',
    highlights: [{ id: 'hl_acme_sso', version: 2, briefId: 'brief_opp_acme', title: 'Dana asked about SSO', summary: 'You answered in-thread.', relevance: 'medium', reasons: ['ACME Phase 2 demo today'], sources: [{ kind: 'slack', label: '#acme-ext' }], status: 'promoted', promotedWorkItemId: 'w_acme_sso', at: t(-1, '09:30') }],
    everythingElse: [{ thread: '#acme-ext general', items: [{ at: t(-1, '12:00'), author: 'Raj Mehta', text: 'Pricing goes out after the demo.' }] }],
    generatedAt: t(0, '07:33'),
  },
];

const watches: In['watches'] = [
  { id: 'watch_team', version: 1, targetKind: 'channel', target: 'C0TEAMUPD', label: '#team-updates', cadence: 'daily_0730', style: 'brief', enabled: true, createdAt: t(-40, '09:00'), updatedAt: t(-40, '09:00') },
  { id: 'watch_nce', version: 2, targetKind: 'search', target: '"nimbus context engine" OR NCE', label: 'Search: Nimbus Context Engine', cadence: 'every_4h', style: 'detailed', enabled: true, createdAt: t(-12, '09:00'), updatedAt: t(-5, '09:00') },
];

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------
const conn = (c: Partial<In['connectors'][number]> & Pick<In['connectors'][number], 'id' | 'label' | 'source' | 'state'>): In['connectors'][number] => ({ since: t(0, '06:00'), lastSuccessAt: t(0, '09:01'), cursor: { label: `${c.label} through 09:01`, at: t(0, '09:01') }, ...c });
const google = { kind: 'in_app' as const, label: 'Reconnect Google', command: 'devbar mcpgw connectors connect google-workspace-readonly' };
const connectors: In['connectors'] = [
  conn({ id: 'slack', label: 'Slack', source: 'slack', state: 'ok', itemsToday: 42, reauth: { kind: 'terminal_command', label: 'Re-auth Slack', command: 'claude mcp login slack', instructions: 'Or in any Claude session: /mcp → slack → Authenticate' }, affects: ['today', 'items', 'briefs'] }),
  conn({ id: 'gmail', label: 'Gmail', source: 'gmail', state: 'ok', itemsToday: 18, reauth: google, affects: ['today', 'items', 'outbox'] }),
  conn({ id: 'calendar', label: 'Calendar', source: 'calendar', state: 'ok', itemsToday: 9, reauth: google, affects: ['today', 'calendar', 'time'] }),
  conn({ id: 'drive', label: 'Drive', source: 'drive', state: 'catching_up', catchUpPct: 60, lastSuccessAt: t(0, '08:30'), cursor: { label: 'Drive through 08:30', at: t(0, '08:30') }, backlog: 14, itemsToday: 6, reauth: google, affects: ['items'] }),
  conn({ id: 'gemini', label: 'Gemini notes', source: 'gemini', state: 'ok', itemsToday: 2, reauth: google }),
  conn({ id: 'org62', label: 'Org62', source: 'org62', state: 'degraded', since: t(0, '08:40'), lastSuccessAt: t(0, '08:10'), cursor: { label: 'Org62 through 08:10', at: t(0, '08:10') }, lastError: { class: 'rate_limited', message: 'REQUEST_LIMIT_EXCEEDED (retrying with backoff)', at: t(0, '08:58'), count: 3 }, reauth: { kind: 'terminal_command', label: 'Re-auth Org62', command: 'claude mcp login Org62-Sobject-Read' }, affects: ['deals'] }),
  conn({ id: 'vdp', label: 'VDP', source: 'vdp', state: 'auth_needed', since: t(0, '07:12'), lastSuccessAt: t(-1, '18:00'), cursor: { label: 'VDP through yesterday 18:00', at: t(-1, '18:00') }, lastError: { class: 'auth', message: 'Okta needs MFA; silent refresh skipped', at: t(0, '07:12'), count: 1 }, impact: 'Value plans may be out of date', reauth: { kind: 'refresh_script', label: 'Re-auth VDP', command: 'python3 ~/.claude/scripts/refresh_vdp_fir_cookie.py', instructions: 'Opens a browser for Okta MFA (up to 5 minutes)' }, affects: ['deals', 'items'] }),
  conn({ id: 'claude', label: 'Claude sessions', source: 'claude', state: 'ok', itemsToday: 7, reauth: null }),
];

const scan = (s: Partial<In['scanRuns'][number]> & Pick<In['scanRuns'][number], 'id' | 'connectorId' | 'scope' | 'status' | 'startedAt'>): In['scanRuns'][number] => ({ kind: 'poll', windowStart: s.startedAt, windowEnd: s.startedAt, endedAt: s.startedAt, itemsSeen: 0, itemsNew: 0, itemsChanged: 0, costUsd: 0, model: null, ...s });
const scanRuns: In['scanRuns'] = [
  scan({ id: 'scan_1', connectorId: 'slack', scope: 'dms_to_me', status: 'ok', startedAt: t(0, '09:01'), itemsSeen: 4, itemsNew: 1, costUsd: 0.003, model: 'haiku' }),
  scan({ id: 'scan_2', connectorId: 'slack', scope: 'mentions', status: 'ok', startedAt: t(0, '09:01'), itemsSeen: 2, costUsd: 0.002, model: 'haiku' }),
  scan({ id: 'scan_3', connectorId: 'gmail', scope: 'inbox', status: 'ok', startedAt: t(0, '09:00'), itemsSeen: 11, itemsNew: 2, itemsChanged: 1 }),
  scan({ id: 'scan_4', connectorId: 'calendar', scope: 'primary', status: 'ok', startedAt: t(0, '09:00'), itemsSeen: 9 }),
  scan({ id: 'scan_5', connectorId: 'drive', scope: 'tracked files', kind: 'backfill', status: 'running', startedAt: t(0, '08:30'), endedAt: null, itemsSeen: 21 }),
  scan({ id: 'scan_6', connectorId: 'org62', scope: 'my opps', status: 'transient_failed', startedAt: t(0, '08:58'), error: 'REQUEST_LIMIT_EXCEEDED', model: 'haiku', costUsd: 0.001 }),
  scan({ id: 'scan_7', connectorId: 'org62', scope: 'my opps', status: 'partial', startedAt: t(0, '08:10'), itemsSeen: 9, itemsChanged: 1, model: 'haiku', costUsd: 0.004 }),
  scan({ id: 'scan_8', connectorId: 'vdp', scope: 'my VDPs', status: 'auth_failed', startedAt: t(0, '07:12'), error: 'Unexpected content type: text/html' }),
  scan({ id: 'scan_9', connectorId: 'gemini', scope: 'meeting notes', status: 'ok', startedAt: t(0, '09:00'), itemsSeen: 1, itemsNew: 1 }),
  scan({ id: 'scan_10', connectorId: 'slack', scope: '#team-updates', kind: 'head', status: 'ok', startedAt: t(0, '07:30'), windowStart: t(-1, '07:30'), windowEnd: t(0, '07:30'), itemsSeen: 63, itemsNew: 63, costUsd: 0.02, model: 'haiku' }),
];

const job = (j: Partial<In['jobs'][number]> & Pick<In['jobs'][number], 'id' | 'type' | 'status'>): In['jobs'][number] => ({ attempts: 1, maxAttempts: 5, runAt: t(0, '09:00'), ...j });
const jobs: In['jobs'] = [
  job({ id: 'job_1', type: 'reevaluate', status: 'running', dedupeKey: 'reeval:work_item:w_dana_reply', generation: 3, startedAt: t(0, '09:01'), entity: { type: 'work_item', id: 'w_dana_reply', label: 'Reply to Dana' } }),
  job({ id: 'job_2', type: 'scan.slack', status: 'queued', runAt: t(0, '09:02'), attempts: 0 }),
  job({ id: 'job_3', type: 'scan.org62', status: 'retrying', attempts: 3, runAt: t(0, '09:04'), error: 'REQUEST_LIMIT_EXCEEDED' }),
  job({ id: 'job_4', type: 'nba.generate', status: 'dead', attempts: 5, runAt: t(0, '06:30'), finishedAt: t(0, '06:45'), error: 'LLM output failed schema validation (missing destination)', entity: { type: 'work_item', id: 'w_travel_globex', label: 'Book travel for the Globex onsite' } }),
  job({ id: 'job_5', type: 'brief.generate', status: 'succeeded', runAt: t(0, '07:30'), startedAt: t(0, '07:30'), finishedAt: t(0, '07:33') }),
  job({ id: 'job_6', type: 'reevaluate', status: 'cancelled', dedupeKey: 'reeval:work_item:w_globex_sow', generation: 1, runAt: t(0, '08:46'), error: 'Superseded by generation 2' }),
  job({ id: 'job_7', type: 'scan.drive', status: 'running', startedAt: t(0, '08:30') }),
];

const eventLog: In['eventLog'] = [
  { id: 'evt_1', at: t(0, '07:12'), level: 'error', source: 'vdp', code: 'auth_needed', message: 'VDP cookie lapsed; Okta needs MFA', count: 1, lastSeenAt: t(0, '07:12'), suggestedAction: 'Re-auth VDP' },
  { id: 'evt_2', at: t(0, '08:40'), level: 'warn', source: 'org62', code: 'rate_limited', message: 'REQUEST_LIMIT_EXCEEDED; backing off', count: 3, lastSeenAt: t(0, '08:58') },
  { id: 'evt_3', at: t(0, '06:45'), level: 'error', source: 'worker', code: 'job_dead_lettered', message: 'nba.generate dead after 5 attempts (schema validation)', count: 1, lastSeenAt: t(0, '06:45'), suggestedAction: 'Retry from Jobs' },
  { id: 'evt_4', at: t(-1, '22:10'), level: 'warn', source: 'claude', code: 'parse_drift', message: 'Transcript parse error rate 1.4% (> 1%)', count: 12, lastSeenAt: t(0, '08:00') },
  { id: 'evt_5', at: t(0, '07:33'), level: 'info', source: 'briefs', code: 'brief_ready', message: '3 briefs generated', count: 1, lastSeenAt: t(0, '07:33'), acknowledged: true, acknowledgedAt: t(0, '07:40') },
  { id: 'evt_6', at: t(-1, '17:21'), level: 'error', source: 'gmail', code: 'send_failed', message: 'Draft push failed: Gmail API 503 backendError', count: 1, lastSeenAt: t(-1, '17:21'), suggestedAction: 'Retry from Outbox' },
];

const spend: In['spend'] = {
  today: { usd: 1.12, softBudgetUsd: 5, hardCapUsd: 15, pct: 22 },
  state: 'ok',
  last7d: [-6, -5, -4, -3, -2, -1, 0].map((o, i) => ({ day: day(o), usd: [0.4, 0.2, 1.6, 1.4, 1.9, 1.3, 1.12][i] })),
  byScanner: [{ name: 'slack', usd: 0.21 }, { name: 'org62', usd: 0.08 }, { name: 'briefs', usd: 0.18 }, { name: 'nba', usd: 0.52 }, { name: 'chat', usd: 0.13 }],
  byModel: [{ model: 'haiku', usd: 0.34 }, { model: 'sonnet', usd: 0.78 }],
};

// ---------------------------------------------------------------------------
// settings / policy
// ---------------------------------------------------------------------------
const rules: In['settings']['policy']['rules'] = [
  { id: 'r_customer', text: 'Customer-facing beats internal', enabled: true, when: { customerFacing: true }, boost: 1.5 },
  { id: 'r_manager', text: 'My manager’s asks within 24 h', enabled: true, when: { fromManager: true, dueWithinH: 24 }, boost: 2 },
  { id: 'r_training', text: 'Never rank trainings above customer prep', enabled: true, when: { kinds: ['training'] }, boost: -3 },
  { id: 'r_travel', text: 'Travel can wait unless it is this week', enabled: true, when: { kinds: ['travel'] }, boost: -1 },
  { id: 'r_drive', text: 'Deliverables with Drive activity get a nudge', enabled: false, when: { kinds: ['deliverable'], sources: ['drive'] }, boost: 1 },
];
const weightsV3 = { customer_facing: 3, meeting_proximity: 3, due_urgency: 2.5, manager_ask: 2, deal_value: 1.5, lead_time: 2, age: 0.5, effort_fit: 1 };
const policy = { id: 'pol_jordan', version: 3, name: 'SE IC (tuned)', role: 'se_ic' as const, weights: weightsV3, rules, updatedAt: t(-7, '10:00'), note: 'Lead time weighted up after the ACME build was late' };
const policyVersions: In['policyVersions'] = [
  { version: 1, at: t(-30, '09:00'), by: 'system', note: 'SE IC starter pack', policy: { ...policy, version: 1, weights: { ...weightsV3, lead_time: 1, manager_ask: 1.5 }, rules: rules.slice(0, 3), updatedAt: t(-30, '09:00'), note: 'SE IC starter pack' } },
  { version: 2, at: t(-14, '09:00'), by: 'user', note: 'Manager asks matter more', policy: { ...policy, version: 2, weights: { ...weightsV3, lead_time: 1 }, rules: rules.slice(0, 4), updatedAt: t(-14, '09:00'), note: 'Manager asks matter more' } },
  { version: 3, at: t(-7, '10:00'), by: 'chat', note: policy.note, policy },
];

const settings: In['settings'] = {
  profile: { version: 1, name: me.name, email: me.email, role: 'se_ic', timezone: 'America/Denver', workingHours: { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] }, managerName: P.priya.name },
  policy,
  agentBehavior: {
    version: 2,
    voice: { samples: ['Hi Dana, confirmed for Thursday. Scope below.', 'Quick one: can you send the inventory before our call?'], style: 'Crisp, friendly, no filler; bullets for scope' },
    autonomy: { slack_reply: 'L1', email_reply: 'L1', canvas_rewrite: 'L4', tool_launch: 'L2', claude_session: 'L2', activity_log: 'L3' },
    taskCapture: ['Anything I say I will do', 'Direct asks from customers or my manager', 'Action items assigned to me in meeting notes'],
    watchedSources: ['#team-updates', '#acme-ext', '#globex-deal', '#hooli-ext'],
    drafting: { tone: 'crisp', length: 'short', signoff: 'Jordan' },
  },
  sending: { version: 1, defaultMode: 'draft', dryRun: true, verifyReadback: true, undoWindowSec: 10 },
  budgets: { version: 1, softUsd: 5, hardUsd: 15, alertPct: 80 },
  // D-103 (a): a specialist AE I support (on Hooli's Data Cloud team, not its owner), an OOO cover and an SME assist
  time: {
    ...DEFAULT_TIME_SETTINGS,
    coveredAes: [
      { name: P.morgan.name, org62UserId: '005XX0000SEEDMHAAA', email: 'morgan.hale@example.com', enabled: true, kind: 'ae' },
      { name: P.elena.name, email: 'elena.cruz@example.com', enabled: true, kind: 'ooo', window: { from: day(-7), to: day(7) }, creditShare: 50, note: `covering for ${P.elena.name} OOO` },
      { name: P.raj.name, email: 'raj.mehta@example.com', enabled: true, kind: 'sme', window: { from: day(-14) }, creditShare: 25, note: 'SME on Agentforce call' },
    ],
  },
  display: { version: 1, density: 'comfortable', theme: 'lightning', shortcutsEnabled: true, scheme: 'dark', textSize: 16 },
};

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------
const chatThreads: In['chatThreads'] = [
  {
    thread: { id: 'thread_today', title: 'Today', isDefault: true, createdAt: t(0, '07:00'), updatedAt: t(0, '08:59'), messageCount: 3, lastMessagePreview: 'Moved the Globex SOW reply up.' },
    messages: [
      {
        id: 'msg_brief',
        threadId: 'thread_today',
        role: 'assistant',
        at: t(0, '07:00'),
        isMorningBrief: true,
        text: '**Good morning.** Seven meetings today; the big one is the **ACME Phase 2 demo at 13:00**.\n\n1. **Kick off the ACME demo-org build** first: it needs ~1h40m of agent time.\n2. **Reply to Dana** about demo scope (5 min, before 11:00).\n3. **Send Marcus the revised SOW pricing**: you missed the 08:30 pricing sync; I turned its 2 takeaways into tasks.\n\nOvernight I closed 2 items for you and VDP needs re-auth. Briefs: #team-updates has 2 items worth a look.',
        parts: [
          { type: 'resource', resource: { kind: 'brief', id: 'brief_team', label: '#team-updates brief', href: '/briefs?id=brief_team' } },
          { type: 'resource', resource: { kind: 'brief', id: 'brief_opp_globex', label: 'Globex opp brief', href: '/briefs?id=brief_opp_globex' } },
        ],
      },
      { id: 'msg_u1', threadId: 'thread_today', role: 'user', at: t(0, '08:58'), text: 'Globex pricing is more urgent than the one-pager.' },
      { id: 'msg_a1', threadId: 'thread_today', role: 'assistant', at: t(0, '08:59'), text: 'Moved the Globex SOW reply up. The one-pager stays due by 17:00.', parts: [{ type: 'tool', id: 'tool_seed_1', name: 'priority.move', summary: 'Moved "Send Marcus the revised SOW pricing" to #3', ok: true }] },
    ],
  },
  {
    thread: { id: 'thread_hooli', title: 'Hooli NCE scoping', isDefault: false, createdAt: t(-1, '17:50'), updatedAt: t(-1, '18:00'), messageCount: 2, lastMessagePreview: 'Started a research session.' },
    messages: [
      { id: 'msg_h1', threadId: 'thread_hooli', role: 'user', at: t(-1, '17:50'), text: 'Find what we know about Hooli’s retrieval layer.' },
      { id: 'msg_h2', threadId: 'thread_hooli', role: 'assistant', at: t(-1, '18:00'), text: 'Started a research session; it will compare their retrieval layer with NCE.', parts: [{ type: 'resource', resource: { kind: 'agent_run', id: 'run_hooli_research', label: 'Hooli NCE competitive research', href: '/agents?run=run_hooli_research' } }] },
    ],
  },
];

const mappings: In['mappings'] = [
  { id: 'map_falcon', question: 'Is #proj-falcon ACME or Globex?', subject: { type: 'triage_mapping', id: 'C0FALCON', label: '#proj-falcon' }, choices: [{ id: 'c_acme', label: 'ACME Corp', ref: { type: 'account', id: 'acc_acme', label: 'ACME Corp' } }, { id: 'c_globex', label: 'Globex', ref: { type: 'account', id: 'acc_globex', label: 'Globex' } }, { id: 'c_neither', label: 'Neither (internal)', ref: null }], source: { kind: 'slack', label: '#proj-falcon' }, createdAt: t(0, '07:20'), status: 'open' },
  { id: 'map_phase2', question: 'Which opp does "Phase 2 sync" belong to?', subject: { type: 'calendar_event', id: 'ev_phase2_sync', label: 'Phase 2 sync (Fri)' }, choices: [{ id: 'c_p2', label: 'ACME · Headless Phase 2', ref: { type: 'opportunity', id: 'opp_acme_p2', label: 'ACME · Headless Phase 2' } }, { id: 'c_af', label: 'ACME · Agentforce Service', ref: { type: 'opportunity', id: 'opp_acme_af', label: 'ACME · Agentforce Service' } }], source: { kind: 'calendar', label: 'Calendar · Phase 2 sync' }, createdAt: t(0, '06:10'), status: 'open' },
];

// Display-only overnight history (feeds "Since you left").
const audit: In['audit'] = [
  { id: 'aud_hist_1', at: t(0, '07:12'), actor: 'connector', action: 'connector.fail', summary: 'VDP needs re-auth', entity: { type: 'connector', id: 'vdp', label: 'VDP' }, changes: [{ field: 'state', before: 'ok', after: 'auth_needed' }], undoable: false },
  { id: 'aud_hist_2', at: t(0, '07:33'), actor: 'engine', action: 'brief.generate', summary: '3 briefs ready (2 worth a look)', entity: { type: 'brief', id: 'brief_team', label: '#team-updates' }, changes: [], undoable: false },
  { id: 'aud_hist_3', at: t(0, '06:50'), actor: 'engine', action: 'item.reopen', summary: 'Reopened: Fix the ACME demo-data refresh job', entity: { type: 'work_item', id: 'w_acme_refresh', label: 'Fix the ACME demo-data refresh job' }, changes: [{ field: 'state', before: 'done', after: 'reopened' }], undoable: false },
  { id: 'aud_hist_4', at: t(0, '09:00'), actor: 'engine', action: 'nba.revise', summary: 'Globex SOW reply updated from Gemini notes', entity: { type: 'nba', id: 'nba_globex_sow', label: 'Reply-all to Marcus' }, changes: [], undoable: false },
  { id: 'aud_hist_5', at: t(0, '08:20'), actor: 'engine', action: 'run.waiting_on_you', summary: 'Umbrella dataset run needs you', entity: { type: 'agent_run', id: 'run_umbrella_data', label: 'Umbrella demo dataset' }, changes: [], undoable: false },
];

// ---------------------------------------------------------------------------
// scenario (UI-SPEC §15)
// ---------------------------------------------------------------------------
const scenario: In['scenario'] = [
  { id: 'slack-reply-updates-draft', at: 20, label: 'A Slack reply updates NBA #2’s draft', exercises: 'Update strip', actions: [{ op: 'nba_update', nbaId: 'nba_dana', reason: 'Dana replied: "please include pricing next steps"', appendText: 'Raj will share pricing next steps right after the demo.', source: { kind: 'slack', label: '#acme-ext · Dana Reyes' } }] },
  { id: 'session-goes-waiting', at: 40, label: 'The Claude session for card #1 goes waiting', exercises: 'Rail lane + promotion', actions: [{ op: 'run_state', runId: 'run_acme_build', state: 'waiting_on_you', lastEvent: 'Asked: which org alias?', waiting: { reason: 'input needed', question: 'Deploy to acme-phase2 or acme-phase2-backup?' } }] },
  { id: 'email-closes-commitment', at: 60, label: 'An email you sent auto-closes a commitment', exercises: 'Closed for you', actions: [{ op: 'close_item', itemId: 'w_acme_onepager', reason: 'You emailed Dana the one-pager at 09:03', evidence: { kind: 'gmail', label: 'Gmail · sent to Dana Reyes' } }] },
  { id: 'deck-edit-moves-deliverable', at: 80, label: 'A deck edit moves a deliverable to in progress', exercises: 'Drive signal', actions: [{ op: 'engine_patch', itemId: 'w_umbrella_deck', patch: {}, state: 'in_progress', reason: 'You added the FHIR ingestion slide', evidence: { kind: 'drive', label: 'Drive · Umbrella deck edited by you' } }] },
  { id: 'gmail-breaks', at: 100, label: 'The Gmail connector breaks', exercises: 'Banner, stale marks, health dot', actions: [{ op: 'connector_state', connectorId: 'gmail', state: 'auth_needed', error: 'invalid_grant: token expired', impact: 'Email items after 09:04 may be missing' }] },
  { id: 'requirements-reopen-task', at: 120, label: 'New requirements reopen a done task', exercises: 'Reopened', actions: [{ op: 'reopen', itemId: 'w_acme_recap', reason: 'Raj: add the Phase 1 adoption numbers', source: { kind: 'slack', label: 'DM · Raj Mehta' } }] },
  { id: 'rerank-available', at: 140, label: 'A re-rank becomes available', exercises: 'Pill', actions: [{ op: 'rerank_ready', itemId: 'w_initech_prep', boost: 12, reason: 'Peter moved the Initech call to 10:00' }] },
  { id: 'looped-back-in', at: 160, label: 'A handed-off item gets a direct ask', exercises: 'Looped back in (R-UI-22)', actions: [{ op: 'loop_back', itemId: 'w_initech_security', byPersonName: 'Peter Gibbons', reason: 'Peter: "Jordan, can you answer Q14 on data residency yourself?"', source: { kind: 'gmail', label: 'Gmail · Peter Gibbons' } }] },
];

// ---------------------------------------------------------------------------
const seedInput: In = {
  meta: {
    schemaVersion: 1,
    label: 'placeholder example (ACME, Globex, Initech, Umbrella, Hooli)',
    asOf: NOW,
    lastActiveAt: t(-1, '18:40'),
    timezone: 'America/Denver',
    user: me,
    quarter: { label: 'Q4 FY27', targetH: 60, due: t(1, '12:00'), loggedH: 9.5 },
    canvas: { label: 'Work-order canvas', lastSyncedAt: t(-1, '17:30'), rowsChangedSince: 0 },
  },
  people,
  accounts,
  opps,
  missedOpps,
  initiatives,
  workItems,
  evidence,
  nbas,
  drafts,
  proposals,
  assets,
  calendar: { events, slots },
  agentRuns,
  toolAdapters,
  toolRuns,
  activity,
  timeBlocks,
  briefs,
  watches,
  connectors,
  scanRuns,
  jobs,
  eventLog,
  spend,
  settings,
  policyVersions,
  chatThreads,
  mappings,
  audit,
  scenario,
};

const parsed = Seed.safeParse(seedInput);
if (!parsed.success) {
  console.error(parsed.error.issues.slice(0, 20));
  process.exit(1);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mock/seed.example.json');
writeFileSync(out, JSON.stringify(parsed.data, null, 2) + '\n');
console.log(`wrote ${out} (${parsed.data.workItems.length} work items, ${parsed.data.calendar.events.length} events, ${parsed.data.agentRuns.length} runs)`);
