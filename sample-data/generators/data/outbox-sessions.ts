/** Claude sessions, segments, tool adapters, tool runs and outputs (storyline 11): the owner builds demos with Claude. */
import { OWNER, readTable, rng, uid } from '../../lib/kit';
import type { Row } from '../../lib/kit';
import { T, plusMin, sha } from './outbox-lib';

const R = rng('outbox-sessions');
const PLAN_ADJ = ['quiet', 'brisk', 'lucid', 'amber', 'mellow', 'steady', 'crisp', 'nimble', 'tidy', 'bright'];
const PLAN_NOUN = ['otter', 'harbor', 'lantern', 'meadow', 'compass', 'anvil', 'kestrel', 'ledger', 'orchard', 'quarry'];
const planSlug = (k: string) => { const r = rng(`plan-${k}`); return `${r.pick(PLAN_ADJ)}-${r.pick(PLAN_NOUN)}-${r.pick(PLAN_NOUN)}`; };

type Turn = [string, string];
type Extra = {
  key: string; title: string; repo: string; branch: string; entry: 'cli' | 'desktop' | 'vscode' | 'scheduled_task'; start: string; mins: number; prompts: number; status: string;
  opp?: string; acct?: string; summary: string; files?: number; bg?: number; method?: 'rule' | 'llm' | 'user'; conf?: number; gap?: [number, number]; waiting?: string; src?: 'ai' | 'first_prompt' | 'custom' | 'app'; launched?: boolean; cost?: number; model?: string;
};

/** cs-01..cs-11 come from the claude source items (domain 02); the key and the work items they close are fixed by domain 04 */
const FROM_SOURCE: Array<{ key: string; si: string; opp?: string; acct?: string; method?: 'rule' | 'llm' | 'user'; conf?: number; locked?: boolean; src?: 'ai' | 'first_prompt' | 'custom' | 'app'; launched?: { wi: number; nba?: string; mode: 'cli_headless' | 'desktop_session' | 'agent_sdk'; at: string } }> = [
  { key: 'cs-01', si: 'si-162', opp: 'harrowgate-maintenance-agent', acct: 'harrowgate', method: 'llm', conf: 0.78, src: 'ai' },
  { key: 'cs-02', si: 'si-457', opp: 'harrowgate-maintenance-agent', acct: 'harrowgate', method: 'user', conf: 1, locked: true, src: 'ai' },
  { key: 'cs-03', si: 'si-500', opp: 'saltmere-data360-poc', acct: 'saltmere', method: 'rule', conf: 0.95, src: 'ai' },
  { key: 'cs-04', si: 'si-509', opp: 'saltmere-data360-poc', acct: 'saltmere', method: 'rule', conf: 0.95, src: 'first_prompt' },
  { key: 'cs-05', si: 'si-330', acct: 'ferrowpay', method: 'rule', conf: 0.9, src: 'ai' },
  { key: 'cs-06', si: 'si-586', opp: 'ferrowpay-fraud-agent', acct: 'ferrowpay', method: 'rule', conf: 0.93, src: 'ai' },
  { key: 'cs-07', si: 'si-689', opp: 'elderglen-outdoors-renewal-expansion', acct: 'elderglen-outdoors', method: 'llm', conf: 0.86, src: 'ai', launched: { wi: 32, nba: 'wi-032:v1', mode: 'cli_headless', at: '11-17 14:28' } },
  { key: 'cs-08', si: 'si-718', opp: 'saltmere-data360-poc', acct: 'saltmere', method: 'rule', conf: 0.95, src: 'ai' },
  { key: 'cs-09', si: 'si-202', src: 'first_prompt' },
  { key: 'cs-10', si: 'si-259', src: 'first_prompt' },
  { key: 'cs-11', si: 'si-599', opp: 'saltmere-data360-poc', acct: 'saltmere', method: 'rule', conf: 0.95, src: 'ai', launched: { wi: 20, nba: 'wi-020:v1', mode: 'cli_headless', at: '11-14 09:50' } },
];

const EXTRA: Extra[] = [
  { key: 'cs-12', title: 'Draft blueprint section 6: data model from the demo org', repo: 'saltmere-poc-demo', branch: 'feat/blueprint-s6', entry: 'desktop', start: '11-15 14:16', mins: 58, prompts: 9, status: 'completed', opp: 'saltmere-data360-poc', acct: 'saltmere', summary: 'Generated the data model section from the demo org metadata: unified profile, claims status and handoff objects, with a table of fields per object.', files: 3, method: 'rule', conf: 0.95, launched: true, cost: 2.4 },
  { key: 'cs-13', title: 'Outline the POC success criteria document', repo: 'saltmere-poc-demo', branch: 'main', entry: 'desktop', start: '10-20 09:10', mins: 36, prompts: 6, status: 'completed', opp: 'saltmere-data360-poc', acct: 'saltmere', summary: 'Outlined success criteria by scenario with measurable KPIs; left baseline values as placeholders for the customer to fill.', files: 1, method: 'rule', conf: 0.95 },
  { key: 'cs-14', title: 'Compare unified profile modeling options', repo: 'saltmere-poc-demo', branch: 'main', entry: 'desktop', start: '10-22 15:20', mins: 72, prompts: 8, status: 'abandoned', opp: 'saltmere-data360-poc', acct: 'saltmere', summary: 'Weighed three modeling options for the unified member profile; stopped before writing anything because the identity answer from the customer was still open.', files: 0, gap: [4, 40], method: 'rule', conf: 0.95 },
  { key: 'cs-15', title: 'Draft weekly time-log lines from the calendar', repo: 'se-notes', branch: 'main', entry: 'desktop', start: '10-23 08:05', mins: 24, prompts: 4, status: 'completed', summary: 'Turned the week of calendar events into one-line log entries for the weekly Org62 logging.', files: 1 },
  { key: 'cs-16', title: 'Continue the maintenance agent topics', repo: 'shared-demo-kit', branch: 'harrowgate-demo', entry: 'cli', start: '10-26 19:40', mins: 86, prompts: 10, status: 'completed', opp: 'harrowgate-maintenance-agent', acct: 'harrowgate', summary: 'Added the remaining-useful-life topic and a work order action; ran the scripted demo twice against the sample plant data.', files: 4, gap: [5, 35], method: 'llm', conf: 0.8 },
  { key: 'cs-17', title: 'Final checks before the Harrowgate demo', repo: 'shared-demo-kit', branch: 'harrowgate-demo', entry: 'desktop', start: '10-28 06:45', mins: 30, prompts: 5, status: 'completed', opp: 'harrowgate-maintenance-agent', acct: 'harrowgate', summary: 'Re-ran the demo path, fixed a topic fallback and exported the deck for the 10:00 session.', files: 2, method: 'llm', conf: 0.82 },
  { key: 'cs-18', title: 'Read the fraud case taxonomy and note the schema mapping', repo: 'ferrowpay-fraud-agent', branch: 'main', entry: 'desktop', start: '10-30 14:10', mins: 52, prompts: 7, status: 'abandoned', opp: 'ferrowpay-fraud-agent', acct: 'ferrowpay', summary: 'Read the analyst taxonomy and listed candidate mappings to DMOs; the sample schemas were not available yet.', files: 1, gap: [3, 45], method: 'rule', conf: 0.93 },
  { key: 'cs-19', title: 'Fix: Gmail scan shows zero new after a rate limit', repo: 'control-center', branch: 'fix/gmail-zero-new', entry: 'desktop', start: '11-14 09:30', mins: 41, prompts: 6, status: 'completed', summary: 'Traced the zero-new count to a window that advanced on a rate-limited scan; patched the cursor and added a test.', files: 3 },
  { key: 'cs-20', title: 'Brief grouping by account family: sketch', repo: 'control-center', branch: 'feat/brief-family', entry: 'desktop', start: '11-08 13:10', mins: 28, prompts: 4, status: 'abandoned', summary: 'Sketched grouping brief highlights by account family; no code written.', files: 0 },
  { key: 'cs-21', title: 'Morning digest: open asks and meetings', repo: 'se-notes', branch: 'main', entry: 'scheduled_task', start: '11-12 06:30', mins: 6, prompts: 1, status: 'completed', summary: 'Scheduled run: listed open asks due today and the meetings with external attendees.', files: 0, src: 'app', model: 'claude-haiku-5-5', cost: 0.12 },
  { key: 'cs-22', title: 'Morning digest: open asks and meetings', repo: 'se-notes', branch: 'main', entry: 'scheduled_task', start: '11-13 06:30', mins: 5, prompts: 1, status: 'completed', summary: 'Scheduled run: listed open asks due today and the meetings with external attendees.', files: 0, src: 'app', model: 'claude-haiku-5-5', cost: 0.11 },
  { key: 'cs-23', title: 'Morning digest: open asks and meetings', repo: 'se-notes', branch: 'main', entry: 'scheduled_task', start: '11-16 06:30', mins: 7, prompts: 1, status: 'completed', summary: 'Scheduled run: listed open asks due today and the meetings with external attendees.', files: 0, src: 'app', model: 'claude-haiku-5-5', cost: 0.13 },
  { key: 'cs-24', title: 'Morning digest: open asks and meetings', repo: 'se-notes', branch: 'main', entry: 'scheduled_task', start: '11-17 06:30', mins: 6, prompts: 1, status: 'completed', summary: 'Scheduled run: listed open asks due today and the meetings with external attendees.', files: 0, src: 'app', model: 'claude-haiku-5-5', cost: 0.12 },
  { key: 'cs-25', title: 'Morning digest: open asks and meetings', repo: 'se-notes', branch: 'main', entry: 'scheduled_task', start: '11-18 06:30', mins: 6, prompts: 1, status: 'completed', summary: 'Scheduled run: listed open asks due today and the meetings with external attendees.', files: 0, src: 'app', model: 'claude-haiku-5-5', cost: 0.12 },
  { key: 'cs-26', title: 'Prep claims status demo data', repo: 'saltmere-poc-demo', branch: 'main', entry: 'desktop', start: '11-09 08:20', mins: 41, prompts: 7, status: 'completed', opp: 'saltmere-data360-poc', acct: 'saltmere', summary: 'Checked the 40 synthetic members against the claims status topic and fixed two members with missing coverage dates.', files: 2, method: 'rule', conf: 0.95 },
  { key: 'cs-27', title: 'Order status agent: first sketch of topics', repo: 'shared-demo-kit', branch: 'to-order-status', entry: 'desktop', start: '11-12 17:30', mins: 46, prompts: 6, status: 'abandoned', opp: 'elderglen-outdoors-renewal-expansion', acct: 'elderglen-outdoors', summary: 'Sketched the order, shipment and return topics; paused because the OMS sandbox shape was not confirmed.', files: 1, gap: [3, 50], method: 'llm', conf: 0.84 },
  { key: 'cs-28', title: 'Blueprint section 6 skeleton', repo: 'saltmere-poc-demo', branch: 'feat/blueprint-s6', entry: 'vscode', start: '11-16 08:10', mins: 50, prompts: 8, status: 'completed', opp: 'saltmere-data360-poc', acct: 'saltmere', summary: 'Built the skeleton for sections 6 and 7 (data model and rollout plan) and pulled the object list from the org.', files: 2, method: 'rule', conf: 0.95 },
  { key: 'cs-29', title: 'Dry-run the scrubbed export load', repo: 'saltmere-poc-demo', branch: 'main', entry: 'desktop', start: '11-17 20:30', mins: 36, prompts: 5, status: 'abandoned', opp: 'saltmere-data360-poc', acct: 'saltmere', summary: 'Dry-ran the loader on a 200-row sample of the scrubbed export; two columns need a mapping decision.', files: 1, gap: [2, 40], method: 'rule', conf: 0.95 },
  { key: 'cs-31', title: 'Blueprint sections 6 and 7: evening pass', repo: 'saltmere-poc-demo', branch: 'feat/blueprint-s6', entry: 'desktop', start: '11-17 18:50', mins: 96, prompts: 11, status: 'completed', opp: 'saltmere-data360-poc', acct: 'saltmere', summary: 'Evening pass on sections 6 and 7: rollout plan phases and the data model tables, checked against the demo org objects.', files: 2, method: 'rule', conf: 0.95 },
  { key: 'cs-30', title: 'Review demo script wording', repo: 'saltmere-poc-demo', branch: 'feat/denied-claim', entry: 'desktop', start: '11-18 08:46', mins: 9, prompts: 2, status: 'running', opp: 'saltmere-data360-poc', acct: 'saltmere', summary: 'Reading the demo script for wording that sounds like a coverage decision.', files: 0, method: 'rule', conf: 0.95 },
];

const mkTurns = (key: string, startIso: string, mins: number, prompts: number, gap?: [number, number]): Turn[] => {
  const r = rng(`turns-${key}`);
  const out: Turn[] = []; let cur = startIso; const per = Math.max(2, Math.floor(mins / prompts) - 1);
  for (let i = 0; i < prompts; i++) {
    const len = Math.max(2, r.int(Math.max(2, per - 2), per + 2));
    const end = plusMin(cur, len);
    out.push([cur, end]);
    cur = plusMin(end, gap && i === gap[0] ? gap[1] + 31 : r.int(1, 3));
  }
  return out;
};

type Seg = { turns: Turn[]; startedAt: string; endedAt: string; humanMs: number; activeMs: number; backgroundMs: number };
const segment = (turns: Turn[], bgAgents: number, key: string): Seg[] => {
  const segs: Turn[][] = []; let cur: Turn[] = [];
  for (const t of turns) {
    if (cur.length && new Date(t[0]).getTime() - new Date(cur[cur.length - 1]![1]).getTime() > 30 * 60_000) { segs.push(cur); cur = []; }
    cur.push(t);
  }
  if (cur.length) segs.push(cur);
  const r = rng(`seg-${key}`);
  return segs.map((s) => {
    const human = s.reduce((a, t) => a + (new Date(t[1]).getTime() - new Date(t[0]).getTime()), 0);
    const active = Math.round(human * (1.25 + r.next() * 0.5));
    const bg = bgAgents > 0 ? Math.round(human * 0.15 * bgAgents) : 0;
    return { turns: s, startedAt: s[0]![0], endedAt: s[s.length - 1]![1], humanMs: human, activeMs: active, backgroundMs: bg };
  });
};

export type SessionBuild = { sessions: Row[]; segments: Row[]; byKey: Map<string, { id: string; row: Row; segs: Row[]; accountKey?: string; oppKey?: string; repo: string; startIso: string; endIso: string }> };

const nbaPrompt = (k: string): string | undefined => { const r = readTable('next_best_actions').find((x) => x.id === uid('next_best_actions', k)); return ((r?.payload as { plan?: { prompt?: string } } | undefined)?.plan?.prompt); };

export function buildSessions(): SessionBuild {
  const sis = readTable('source_items');
  const siById = new Map(sis.map((r) => [r.id as string, r]));
  const connector = uid('connectors', 'claude');
  const sessions: Row[] = []; const segments: Row[] = [];
  const byKey: SessionBuild['byKey'] = new Map();

  const push = (o: {
    key: string; ext: string; host: string; entry: string; status: string; cwd: string; repo: string; branch: string; title: string; titleSrc: string; summary: string; turns: Turn[]; bg: number; files: number;
    acct?: string; opp?: string; method?: string; conf?: number; locked?: boolean; si?: string; launched?: { wi: number; nba?: string; mode: string; at: string; job?: number | null }; cost?: number; model?: string; waiting?: [string, string, string]; compactions?: number; live?: boolean; scheduled?: boolean; lastAct?: string; prompt?: string;
  }) => {
    const id = uid('claude_sessions', o.key);
    const segs = segment(o.turns, o.bg, o.key);
    const startedAt = o.turns[0]![0]; const lastTurnEnd = o.turns[o.turns.length - 1]![1];
    const rr = rng(`sess-${o.key}`);
    const human = segs.reduce((a, s) => a + s.humanMs, 0); const active = segs.reduce((a, s) => a + s.activeMs, 0); const bgMs = segs.reduce((a, s) => a + s.backgroundMs, 0);
    const lastAct = o.lastAct ?? plusMin(lastTurnEnd, o.status === 'completed' || o.status === 'abandoned' ? rr.int(1, 4) : 0);
    const added = o.files ? rr.int(20, 90) * o.files : 0; const removed = o.files ? rr.int(2, 30) * o.files : 0;
    const row: Row = {
      id, owner_user_id: OWNER, connector_id: connector, session_external_id: o.ext, desktop_session_id: o.host, entrypoint: o.entry, status: o.status,
      waiting_reason: o.waiting ? o.waiting[0] : null, waiting_detail: o.waiting ? o.waiting[1] : null, waiting_since: o.waiting ? o.waiting[2] : null,
      transcript_path: `/Users/rafael/.claude/projects/${o.cwd.replace(/\//g, '-')}/${o.ext}.jsonl`, cwd: o.cwd, repo_id: uid('repos', o.repo), git_branch: o.branch, plan_slug: planSlug(o.key),
      title: o.title, title_source: o.titleSrc, summary: o.summary, summary_updated_at: lastAct, started_at: startedAt, last_activity_at: lastAct,
      ended_at: o.status === 'completed' || o.status === 'abandoned' ? lastAct : null, active_ms: active, human_ms: human, background_ms: bgMs, prompt_count: o.turns.length,
      files_changed_count: o.files, lines_added: added, lines_removed: removed, cost_usd: o.cost ?? Math.round((0.4 + (active / 60000) * 0.045 + rr.next() * 0.6) * 100) / 100,
      primary_model: o.model ?? 'claude-sonnet-5-5', account_id: o.acct ? uid('accounts', o.acct) : null, opportunity_id: o.opp ? uid('opportunities', o.opp) : null,
      mapping_method: o.method ?? null, mapping_confidence: o.conf ?? null, mapping_locked: o.locked ?? false, source_item_id: o.si ?? null,
      launched_by_app: !!o.launched, launch_mode: o.launched ? o.launched.mode : null, launch_work_item_id: o.launched ? uid('work_items', `wi-${String(o.launched.wi).padStart(3, '0')}`) : null,
      launch_nba_id: o.launched?.nba ? uid('next_best_actions', o.launched.nba) : null, launch_prompt: o.launched ? (o.prompt ?? `[cc:${uid('work_items', `wi-${String(o.launched.wi).padStart(3, '0')}`)}] ${o.title}. Work from the context pack; stop and ask when a success criterion cannot be met.`) : null,
      launch_job_id: o.launched?.job ?? null, launch_requested_at: o.launched ? T(o.launched.at) : null, live_pid: o.live ? 48213 : null, live_status_at: o.live ? lastAct : null,
      created_at: startedAt, updated_at: lastAct,
    };
    sessions.push(row);
    const segRows = segs.map((s, i) => {
      const seg: Row = {
        id: uid('claude_session_segments', `${o.key}:${i + 1}`), claude_session_id: id, ordinal: i + 1, started_at: s.startedAt, ended_at: s.endedAt, active_ms: s.activeMs, human_ms: s.humanMs, background_ms: s.backgroundMs,
        prompt_count: s.turns.length, account_id: row.account_id, opportunity_id: row.opportunity_id, mapping_method: o.method ?? null, mapping_confidence: o.conf ?? null,
      };
      segments.push(seg); return seg;
    });
    byKey.set(o.key, { id, row, segs: segRows, accountKey: o.acct, oppKey: o.opp, repo: o.repo, startIso: startedAt, endIso: lastAct });
  };

  for (const f of FROM_SOURCE) {
    const si = siById.get(uid('source_items', f.si))!; const m = si.meta as Record<string, unknown>;
    const turns = m.humanTurns as Turn[];
    const st = String(m.status); const status = st === 'done' ? 'completed' : st === 'waiting' ? 'waiting_on_me' : st === 'idle' ? 'idle' : 'running';
    push({
      key: f.key, ext: String(m.sessionId), host: String(m.hostSessionId), entry: String(m.entrypoint), status, cwd: String(m.cwd), repo: String(m.repo), branch: String(m.branch), title: String(m.title), titleSrc: f.src ?? 'ai',
      summary: String(si.body), turns, bg: Number(m.backgroundAgents ?? 0), files: Number(m.filesTouchedCount ?? 0), acct: f.acct, opp: f.opp, method: f.method, conf: f.conf, locked: f.locked, si: si.id as string,
      launched: f.launched ? { ...f.launched } : undefined, lastAct: String(m.lastActivityAt), prompt: f.launched?.nba ? ((nbaPrompt(f.launched.nba))) : undefined, waiting: status === 'waiting_on_me' ? ['question', 'Waiting for the approved wording list for the denied-claim explanation', String(m.lastActivityAt)] : undefined,
    });
  }
  for (const e of EXTRA) {
    const start = T(e.start);
    const turns = mkTurns(e.key, start, e.mins, e.prompts, e.gap);
    const ext = `${sha(e.key).slice(0, 8)}-smpl-${sha(e.key + 'a').slice(0, 4)}-${sha(e.key + 'b').slice(0, 12)}`;
    push({
      key: e.key, ext, host: `host-${sha(e.key + 'h').slice(0, 8)}`, entry: e.entry, status: e.status, cwd: `/Users/rafael/Projects/${e.repo}`, repo: e.repo, branch: e.branch, title: e.title, titleSrc: e.src ?? 'ai', summary: e.summary, turns, bg: e.bg ?? 0, files: e.files ?? 1,
      acct: e.acct, opp: e.opp, method: e.method, conf: e.conf, cost: e.cost, model: e.model, live: e.status === 'running',
      launched: e.launched ? { wi: 3, mode: 'desktop_session', at: e.start, job: 414 } : undefined,
    });
  }
  // cs-12: the session launched by the claude_demo_build tool run is requested 11-15 14:16 and started a minute later
  const cs12 = byKey.get('cs-12')!; cs12.row.launch_requested_at = T('11-15 14:16'); cs12.row.launch_job_id = 414;
  return { sessions, segments, byKey };
}

// ── tool adapters, runs, outputs ───────────────────────────────────────────────────────────────────
export function buildTools(sb: SessionBuild) {
  const adapters: Row[] = [];
  const AD: Array<[string, string, string, string[], string | null, string | null, string | null, Record<string, unknown>, string, boolean | null]> = [
    ['blueprint_outline', 'Blueprint outline', 'skill', ['blueprint.outline', 'blueprint.open'], null, null, null, { 'blueprint.outline': { type: 'object', required: ['workItemId'], properties: { workItemId: { type: 'string' }, template: { type: 'string', enum: ['se-blueprint-v3'] } } } }, '1.4.0', true],
    ['repo_status', 'Repo status', 'cli', ['repo.status'], null, null, 'node tools/repo-status.mjs --json', { 'repo.status': { type: 'object', properties: { repos: { type: 'array', items: { type: 'string' } } } } }, '0.9.2', true],
    ['claude_demo_build', 'Claude demo build', 'claude_session', ['session.launch'], null, null, 'claude --print --permission-mode plan', { 'session.launch': { type: 'object', required: ['folder', 'prompt'], properties: { folder: { type: 'string' }, prompt: { type: 'string' }, mode: { type: 'string', enum: ['cli_headless', 'desktop_session'] } } } }, '1.1.0', true],
    ['afd360_estimator', 'Data 360 and Agentforce estimator', 'skill', ['estimate.consumption', 'estimate.compare'], null, null, null, { 'estimate.consumption': { type: 'object', required: ['opportunityId'], properties: { opportunityId: { type: 'string' }, model: { type: 'string', enum: ['flex', 'dsc', 'per_seat'] } } } }, '2.0.3', true],
    ['oms-sandbox-check', 'OMS sandbox check', 'http_local', ['oms.check'], 'https://oms-check.example/sandbox', '/health', null, { 'oms.check': { type: 'object', required: ['baseUrl', 'readToken'], properties: { baseUrl: { type: 'string' }, readToken: { type: 'string' }, endpoints: { type: 'string' }, readOnly: { type: 'boolean' } } } }, '0.3.0', false],
    ['demo-org-loader', 'Demo org loader', 'cli', ['org.load', 'org.dry_run'], null, null, 'npx tsx scripts/load-demo-org.ts', { 'org.load': { type: 'object', required: ['org', 'file'], properties: { org: { type: 'string' }, file: { type: 'string' }, dryRun: { type: 'boolean' }, refuseTypedIdentifiers: { type: 'boolean' } } } }, '1.2.0', true],
    ['talk_track', 'Talk track generator', 'skill', ['talk_track.generate', 'talk_track.open'], null, null, null, { 'talk_track.generate': { type: 'object', required: ['audience'], properties: { audience: { type: 'string' }, minutes: { type: 'integer' } } } }, '1.0.5', true],
    ['pulse_footprint', 'Pulse footprint', 'mcp', ['footprint.read'], null, null, null, { 'footprint.read': { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string' } } } }, '0.2.1', null],
  ];
  const adapterId = new Map<string, string>();
  for (const [key, name, kind, caps, base, health, launch, schema, ver, ok] of AD) {
    const id = uid('tool_adapters', key); adapterId.set(key, id);
    adapters.push({ id, owner_user_id: OWNER, key: key.replace(/_/g, '-'), name, kind, base_url: base, health_path: health, launch_command: launch, capabilities: caps, input_schema: schema, version: String(Math.max(1, parseInt(ver, 10))), enabled: key !== 'pulse_footprint', last_health_at: ok === null ? null : T('11-18 08:30'), last_health_ok: ok, created_at: T('10-19 09:30'), updated_at: T('11-18 08:30') });
  }
  const runs: Row[] = []; const outputs: Row[] = [];
  const mk = (key: string, adapter: string, cap: string, wi: number | null, nba: string | null, status: string, input: Record<string, unknown>, o: { ext?: string; job?: number | null; session?: string; summary?: string; started?: string; finished?: string; code?: string; msg?: string; created: string }) => {
    runs.push({
      id: uid('tool_runs', key), owner_user_id: OWNER, adapter_id: adapterId.get(adapter), capability: cap, work_item_id: wi ? uid('work_items', `wi-${String(wi).padStart(3, '0')}`) : null, nba_id: nba ? uid('next_best_actions', nba) : null, status, input,
      external_run_id: o.ext ?? null, job_id: o.job ?? null, claude_session_id: o.session ? sb.byKey.get(o.session)!.id : null, output_summary: o.summary ?? null, started_at: o.started ? T(o.started) : null, finished_at: o.finished ? T(o.finished) : null,
      error_code: o.code ?? null, error_message: o.msg ?? null, created_at: T(o.created), updated_at: T(o.finished ?? o.started ?? o.created),
    });
  };
  const out = (run: string, kind: string, label: string, p: { url?: string; local?: string; asset?: string; at: string }, i: number) => outputs.push({ id: uid('tool_run_outputs', `${run}:${i}`), tool_run_id: uid('tool_runs', run), kind, label, url: p.url ?? null, asset_id: p.asset ? uid('assets', p.asset) : null, local_path: p.local ?? null, created_at: T(p.at) });

  mk('tr-blueprint-outline-1110', 'blueprint_outline', 'blueprint.outline', 3, null, 'succeeded', { workItemId: 'wi-003', template: 'se-blueprint-v3' }, { ext: 'bp-run-smpl-0007', job: 319, summary: 'Nine-section outline from the template, sections 1 to 5 prefilled from the architecture overview.', started: '11-10 16:09:20', finished: '11-10 16:10:05', created: '11-10 16:09' });
  out('tr-blueprint-outline-1110', 'asset', 'Blueprint outline (Drive doc)', { asset: 'hv-blueprint', at: '11-10 16:10:05' }, 1); out('tr-blueprint-outline-1110', 'text', 'Outline summary: 9 sections, 3 open questions', { local: '.cc/runs/bp-run-smpl-0007/summary.md', at: '11-10 16:10:05' }, 2);
  mk('tr-blueprint-outline-1112', 'blueprint_outline', 'blueprint.outline', 3, null, 'succeeded', { workItemId: 'wi-003', template: 'se-blueprint-v3' }, { ext: 'bp-run-smpl-0009', job: 348, summary: 'Refreshed the outline after the 11-12 demo: added the denied-claim scenario to section 3.', started: '11-12 09:01:10', finished: '11-12 09:01:48', created: '11-12 09:01' });
  out('tr-blueprint-outline-1112', 'url', 'Outline diff vs 11-10', { url: 'https://docs.example.com/document/d/1smplhvblueprint/edit?tab=outline-diff', at: '11-12 09:01:48' }, 1);
  mk('tr-repo-status-1113', 'repo_status', 'repo.status', null, null, 'succeeded', { repos: ['saltmere-poc-demo', 'ferrowpay-fraud-agent', 'shared-demo-kit'] }, { ext: 'rs-run-smpl-0004', job: 372, summary: '3 repos: 1 branch ahead of origin (shared-demo-kit/harrowgate-demo), 2 clean.', started: '11-13 08:43:15', finished: '11-13 08:43:22', created: '11-13 08:43' });
  out('tr-repo-status-1113', 'text', 'Repo status table', { local: '.cc/runs/rs-run-smpl-0004/status.txt', at: '11-13 08:43:22' }, 1);
  mk('tr-demo-build-1115', 'claude_demo_build', 'session.launch', 3, null, 'succeeded', { folder: '/Users/rafael/Projects/saltmere-poc-demo', prompt: 'Draft blueprint section 6 (data model) from the demo org metadata.', mode: 'desktop_session' }, { ext: 'launch-smpl-0011', job: 414, session: 'cs-12', summary: 'Session started and finished in 58 minutes; section 6 drafted.', started: '11-15 14:16:30', finished: '11-15 15:15', created: '11-15 14:16' });
  out('tr-demo-build-1115', 'file', 'Section 6 draft', { local: 'docs/blueprint/section-6-data-model.md', at: '11-15 15:15' }, 1);
  mk('tr-estimate-qp-1110', 'afd360_estimator', 'estimate.consumption', null, null, 'succeeded', { opportunityId: 'ferrowpay-data360-foundation', model: 'flex' }, { ext: 'est-run-smpl-0002', job: null, summary: 'Flex Credits estimate: year 1 base, 5% uplift in year 3, trace attached.', started: '11-10 13:40:05', finished: '11-10 13:41:30', created: '11-10 13:40' });
  out('tr-estimate-qp-1110', 'asset', 'Ferrowpay consumption estimate (sheet)', { asset: 'qp-estimate', at: '11-10 13:41:30' }, 1);
  mk('tr-talk-track-1117', 'talk_track', 'talk_track.generate', 22, null, 'failed', { audience: 'Gareth Llewellyn (CIO)', minutes: 30 }, { ext: 'tt-run-smpl-0003', job: null, summary: null as unknown as string, started: '11-17 10:20:10', finished: '11-17 10:20:34', code: 'input_incomplete', msg: 'No board date on the opportunity or in the thread; the talk track needs a length and a date.', created: '11-17 10:20' });
  mk('tr-oms-check', 'oms-sandbox-check', 'oms.check', 105, 'wi-105:v1', 'waiting_on_me', { endpoints: 'orders,shipments,returns', readOnly: true, baseUrl: null, readToken: null }, { created: '11-18 08:31' });
  mk('tr-hv-export-load', 'demo-org-loader', 'org.load', 20, 'wi-020:v2', 'running', { org: 'saltmere-poc-sandbox', file: 'contact-center-export-90d-scrubbed.csv', dryRun: false, refuseTypedIdentifiers: true }, { ext: 'load-run-smpl-0014', job: null, summary: 'Batch 7 of 18 loaded (35,000 of 90,000 rows); 212 rows refused so far for a typed identifier pattern.', started: '11-18 08:41:05', created: '11-18 08:41' });
  out('tr-hv-export-load', 'file', 'Rejected rows (running tally)', { local: '.cc/runs/load-run-smpl-0014/rejected.csv', at: '11-18 08:52' }, 1);
  return { adapters, runs, outputs };
}
