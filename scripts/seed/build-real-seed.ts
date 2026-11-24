/**
 * Builds the PRIVATE mock seed from the raw fixtures. Run: `npm run seed:real`.
 *
 *   in : ~/Library/Application Support/command-center/fixtures/raw/*.json  (+ overlay.mjs, voice/profile.json)
 *   out: ~/Library/Application Support/command-center/fixtures/seed.json   (chmod 600, NEVER committed)
 *
 * This file contains no data. Generic raw→seed mapping lives in ./mappers.ts; the curated narrative lives
 * in the private overlay (see ./overlay-contract.ts and ./README.md). The result is validated against the
 * Seed zod schema, so a bad overlay fails loudly with readable errors and nothing is written.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Destination, Seed, type SeedInput } from '../../src/contract';
import { estimateYouMin, makeEstimator } from '../../src/engines/priority/estimate';
import { docFromText, plainText, renderAll } from '../../src/server/datasource/mock/render';
import {
  APP_SUPPORT,
  OUT_PATH,
  SeedBuildError,
  TZ,
  VOICE_PATH,
  ageDaysOf,
  assertNoCredentials,
  day,
  die,
  iso,
  loadHostSessions,
  mtDay,
  mtHM,
  plusMin,
  readRaw,
  slug,
  t,
  x,
  type DraftIn,
  type EvidenceIn,
  type In,
  type NbaIn,
  type WorkItemIn,
} from './lib';
import { hoursBy, makeAcctOf, mapAccounts, mapActivity, mapConnectors, mapEvents, mapMissed, mapOpps, mapRuns, type Raw } from './mappers';
import type { OverlayModule, OverlayResult } from './overlay-contract';

const NOW = t(0, '08:20'); // the seed's "now": Thu 2026-11-05 08:20 MT, after the morning prep call starts
const ME_ID = 'p_me';

// ---------------------------------------------------------------------------
// generic, non-personal registries
// ---------------------------------------------------------------------------
const TOOL_ADAPTERS = (checkedAt: string): In['toolAdapters'] => [
  {
    manifest: {
      id: 'talk-track',
      name: 'Talk Track',
      description: 'Generate a talk track (slides + live demo) for an event',
      version: 1,
      kind: 'http',
      capabilities: ['generate-talk-track'],
      match: { taskTypes: ['demo-prep', 'presentation'], keywords: ['talk track', 'demo'] },
      input: {
        schema: { type: 'object', required: ['customer', 'name'], properties: { customer: { type: 'string', title: 'Customer' }, name: { type: 'string', title: 'Talk track name' }, eventId: { type: 'string', title: 'Event' } } },
        prefill: { customer: '{{task.account.name}}', name: '{{event.title}}' },
      },
      launch: { http: { baseUrl: 'http://localhost:4320', steps: [{ id: 'create', method: 'POST', path: '/api/talk-tracks', body: { name: '{{in.name}}', customer: '{{in.customer}}' }, save: { trackId: '$.id' } }, { id: 'gen', method: 'POST', path: '/api/talk-tracks/{{trackId}}/generate', save: { jobId: '$.jobId' } }] } },
      lifecycle: { start: { cwd: '~/Projects/talk-track', argv: ['npm', 'start'], env: { PORT: '4320' }, readyUrl: 'http://localhost:4320/api/talk-tracks', readyTimeoutSec: 30 }, stopAfterIdleMin: null },
      progress: { type: 'ndjson', http: { path: '/api/talk-tracks/{{trackId}}/jobs/{{jobId}}/stream' } },
      output: { kind: 'link', link: { url: 'http://localhost:4320/#/talk-tracks/{{trackId}}', label: 'Open talk track' } },
      health: { type: 'http', http: { url: 'http://localhost:4320/api/talk-tracks', expectStatus: 200, timeoutMs: 1500 }, intervalSec: 60, onFail: 'offer-start' },
      safety: { network: 'localhost-only', writes: ['~/Projects/talk-track/talk-tracks'], requiresApproval: true, dataClass: 'customer' },
    },
    health: { state: 'unknown', checkedAt, message: 'Not probed in mock mode' },
    recentRunIds: [],
  },
  {
    manifest: {
      id: 'pulse-footprint',
      name: 'Pulse Footprint',
      description: 'Org footprint and usage pulse for an account (slides export)',
      version: 1,
      kind: 'http',
      capabilities: ['org-footprint'],
      match: { taskTypes: ['account-review'], keywords: ['footprint', 'pulse', 'usage'] },
      input: { schema: { type: 'object', required: ['orgId'], properties: { orgId: { type: 'string', title: 'Org' }, format: { type: 'string', enum: ['pptx', 'link'] } } }, prefill: {} },
      launch: { http: { baseUrl: 'http://localhost:4318', steps: [{ id: 'run', method: 'POST', path: '/api/orgs/{{in.orgId}}/footprint' }] } },
      lifecycle: { start: { cwd: '~/Projects/greg-playground', argv: ['npm', 'run', 'dev'], env: { PORT: '4318' }, readyUrl: 'http://localhost:4318/api/orgs' } },
      progress: { type: 'sse', http: { path: '/api/orgs/{{in.orgId}}/footprint/stream' } },
      output: { kind: 'both', link: { url: 'http://localhost:4318/orgs/{{in.orgId}}', label: 'Open footprint' }, artifacts: [{ path: '/pptx?download=1', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'footprint.pptx' }] },
      health: { type: 'http', http: { url: 'http://localhost:4318/api/orgs', expectStatus: 200 }, intervalSec: 60, onFail: 'offer-start' },
      safety: { network: 'localhost-only', writes: [], requiresApproval: true, dataClass: 'customer' },
    },
    health: { state: 'down', checkedAt, message: 'Connection refused on :4318 (not running)' },
    recentRunIds: [],
  },
  {
    manifest: {
      id: 'afd360-estimator',
      name: 'D360/AF Estimator',
      description: 'Defensible Data 360 + Agentforce consumption estimate',
      version: 1,
      kind: 'cli',
      capabilities: ['consumption-estimate'],
      match: { taskTypes: ['pricing'], keywords: ['estimate', 'consumption', 'credits', 'sizing'] },
      input: { schema: { type: 'object', required: ['account'], properties: { account: { type: 'string', title: 'Account' }, scenario: { type: 'string', title: 'Scenario' }, format: { type: 'string', enum: ['xlsx', 'md'] } } }, prefill: { account: '{{task.account.name}}' } },
      launch: { cli: { cwd: '~/.claude/skills/afd360-estimator', argv: ['python3', 'scripts/cli.py', 'export', '{{in.estimatePath}}', '--format', '{{in.format}}'], timeoutSec: 300 } },
      progress: { type: 'exit-code' },
      output: { kind: 'artifact', artifacts: [{ path: '{{runDir}}/out.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'estimate.xlsx', revealable: true }] },
      health: { type: 'file', intervalSec: 300 },
      safety: { network: 'none', writes: ['~/Projects/afd360-estimates'], requiresApproval: false, dataClass: 'customer' },
    },
    health: { state: 'ok', checkedAt },
    recentRunIds: [],
  },
];

const POLICY_RULES: In['settings']['policy']['rules'] = [
  { id: 'r_customer', text: 'Customer-facing beats internal', enabled: true, when: { customerFacing: true }, boost: 1.5 },
  { id: 'r_manager', text: 'My manager’s asks within 24 h', enabled: true, when: { fromManager: true, dueWithinH: 24 }, boost: 2 },
  { id: 'r_training', text: 'Never rank trainings above customer prep', enabled: true, when: { kinds: ['training'] }, boost: -3 },
  { id: 'r_travel', text: 'Travel can wait unless it is this week', enabled: true, when: { kinds: ['travel'] }, boost: -1 },
  { id: 'r_drive', text: 'Deliverables with Drive activity get a nudge', enabled: false, when: { kinds: ['deliverable'], sources: ['drive'] }, boost: 1 },
];
const WEIGHTS = { customer_facing: 3, meeting_proximity: 3, due_urgency: 2.5, manager_ask: 2, deal_value: 1.5, lead_time: 2, age: 0.5, effort_fit: 1 };

// ---------------------------------------------------------------------------
// fill helpers
// ---------------------------------------------------------------------------
/** Hands-on defaults by kind (the engine's, err low) for overlay items that give no effort. */
const ESTIMATOR = makeEstimator();

function fillWork(p: OverlayResult['workItems'][number], me: { id: string; name: string }): WorkItemIn {
  const createdAt = p.createdAt ?? t(-1, '10:00');
  const youMin = estimateYouMin({ kind: p.kind, title: p.title, effort: {} }, ESTIMATOR).youMin;
  return {
    version: 1,
    purpose: null,
    initiativeId: null,
    accountId: null,
    oppId: null,
    confidence: 'likely',
    sources: [],
    effort: { youMin, agentMin: 0 },
    startBy: null,
    due: null,
    createdAt,
    updatedAt: t(0, '08:00'),
    ageDays: ageDaysOf(createdAt, NOW),
    rank: null,
    rankReasons: [],
    owner: { id: me.id, name: me.name },
    ...p,
  } as WorkItemIn;
}

function fillDraft(d: OverlayResult['drafts'][number]): DraftIn {
  const { text, ...rest } = d;
  const doc = docFromText(text);
  return {
    version: 1,
    mode: 'draft',
    userTouched: false,
    createdAt: t(0, '08:10'),
    updatedAt: t(0, '08:10'),
    ...rest,
    doc,
    plainText: plainText(doc),
    rendered: renderAll(Destination.parse(rest.destination), doc),
  } as DraftIn;
}

function fillNba(n: OverlayResult['nbas'][number]): NbaIn {
  return { version: 1, confidence: 'likely', sources: [], status: 'ready', generatedAt: t(0, '08:12'), model: 'sonnet', versions: [{ version: 1, at: t(0, '08:12'), reason: 'Generated', diffSummary: null }], ...n } as NbaIn;
}

const RANKABLE = new Set(['open', 'in_progress', 'waiting_on_me', 'likely_done', 'reopened']);

function autoReasons(w: WorkItemIn, events: In['calendar']['events']): WorkItemIn['rankReasons'] {
  const out: WorkItemIn['rankReasons'] = [];
  const ev = w.servesEventId ? events.find((e) => e.id === w.servesEventId) : undefined;
  if (w.signals?.customerFacing) out.push({ key: 'customer_facing', label: 'Customer-facing', contribution: 3 });
  if (ev) out.push({ key: 'meeting_proximity', label: `${x(ev.title, 48)} ${mtDay(ev.start).slice(5)} ${mtHM(ev.start)} MT`, contribution: 2 });
  if (w.due) out.push({ key: 'due_urgency', label: `Due ${mtDay(w.due).slice(5)} ${mtHM(w.due)} MT`, contribution: 1.5 });
  if (w.signals?.fromManager) out.push({ key: 'manager_ask', label: 'Manager ask', contribution: 2 });
  if (!out.length) out.push({ key: 'age', label: `Open ${w.ageDays}d`, contribution: Math.min(1, w.ageDays / 30) });
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const raw: Raw = {
    calendar: readRaw('calendar.json'),
    org62: readRaw('org62.json'),
    activity: readRaw('activity.json'),
    sessions: readRaw('claude-sessions.json'),
    manifest: readRaw('manifest.json'),
    drive: readRaw('drive.json'),
    gemini: readRaw('gemini-notes.json'),
    slack: readRaw('slack-asks-promises.json'),
    watch: readRaw('slack-watch-data-jedais.json'),
    gmail: readRaw('gmail.json'),
    initiatives: readRaw('initiatives.json'),
  };
  const voice = existsSync(VOICE_PATH) ? (JSON.parse(readFileSync(VOICE_PATH, 'utf8')) as { tone?: string; styleGuide?: string; exemplars?: { audience: string; text: string }[]; greeting?: string; signoff?: string | null }) : null;

  const overlayPath = path.join(APP_SUPPORT, 'fixtures/overlay.mjs');
  if (!existsSync(overlayPath)) die(`missing private overlay: ${overlayPath}. See scripts/seed/README.md.`);
  const overlay = (await import(pathToFileURL(overlayPath).href)) as OverlayModule;
  if (!Array.isArray(overlay.accountRules) || typeof overlay.build !== 'function') die('overlay.mjs must export accountRules[] and build(ctx).');

  const readAt = raw.manifest.generated_at;
  const acctOf = makeAcctOf(overlay.accountRules);
  const { byAcct, byOpp } = hoursBy(raw, acctOf);
  const opps = mapOpps(raw, acctOf, overlay.oppNextSteps ?? {}, byOpp, readAt);
  const accounts = mapAccounts(overlay.accountRules, opps, byAcct);
  const missedOpps = mapMissed(raw, t(0, '05:30'));
  const meName = raw.org62.user.name;
  const events = mapEvents(raw, { asOf: NOW, acctOf, nameFixes: overlay.nameFixes ?? {}, meName });
  const oppIds = new Set(opps.map((o) => o.id));
  const activity = mapActivity(raw, oppIds, readAt);
  const host = loadHostSessions();
  const runs = mapRuns(raw, host, overlay.sessionLinks ?? {}, NOW);
  const conn = mapConnectors(raw, { asOf: NOW, vdpExpiredAt: t(-10, '09:00') });

  const findEvent = (rx: RegExp): string => events.find((e) => rx.test(e.title))?.id ?? die(`overlay: no calendar event matches ${rx}`);
  const findRun = (prefix: string): string => runs.find((r) => r.sessionId?.startsWith(prefix))?.id ?? die(`overlay: no session starts with ${prefix}`);
  const me = { id: ME_ID, name: meName, email: '' };

  const o = overlay.build({
    NOW,
    ME: me,
    raw,
    t,
    day,
    iso,
    x,
    mtHM,
    mtDay,
    slug,
    acctOf,
    events,
    opps,
    runs,
    findEvent,
    findRun,
    docFromText,
    hostSession: (id) => host.get(id) ?? id,
  });
  me.email = o.meta.email;

  // calendar patches (prep links, takeaways, opp mapping)
  for (const p of o.calendarPatches) {
    const hits = events.filter((e) => p.rx.test(e.title));
    if (!hits.length) die(`overlay: calendar patch ${p.rx} matched no event`);
    for (const e of hits) {
      if (p.oppId) e.oppId = p.oppId;
      if (p.accountId) e.accountId = p.accountId;
      if (p.prep) e.prep = p.prep;
      if (p.takeaways) e.takeaways = p.takeaways;
    }
  }

  // work items: fill, rank, reasons
  const items = o.workItems.map((w) => fillWork(w, me));
  const rankable = items.filter((w) => RANKABLE.has(w.state) && !w.isBackground);
  const ordered = new Set(o.order);
  const missing = rankable.filter((w) => !ordered.has(w.id)).map((w) => w.id);
  if (missing.length) die(`overlay.order is missing rankable items: ${missing.join(', ')}`);
  const byId = new Map(items.map((w) => [w.id, w]));
  o.order.forEach((id, i) => {
    const w = byId.get(id) ?? die(`overlay.order references unknown item ${id}`);
    if (!RANKABLE.has(w.state) || w.isBackground) die(`overlay.order lists non-rankable item ${id} (${w.state})`);
    w.rank = i + 1;
    w.priority = i < 5 ? 'high' : i < 15 ? 'medium' : 'low';
    w.rankReasons = o.rankReasons[id] ?? autoReasons(w, events);
    w.score = Math.round(w.rankReasons.reduce((s, r) => s + r.contribution, 0) * 100) / 100;
  });

  // evidence
  let evN = 0;
  const evidence: EvidenceIn[] = o.evidence.map(([workItemId, role, source, at, summary, extra]) => ({ id: `ev_${++evN}`, workItemId, role, source, at, summary: x(summary, 240), ...(extra ?? {}) }) as EvidenceIn);

  // assets back-links
  const assets = o.assets.map((a) => ({ ...a, workItemIds: items.filter((w) => (w.assetIds ?? []).includes(a.id)).map((w) => w.id) }));

  // tool runs + their agent-run mirrors, adapter recent runs
  const toolAdapters = TOOL_ADAPTERS(t(0, '08:15')).map((a) => ({ ...a, recentRunIds: o.toolRuns.filter((r) => r.adapterId === a.manifest.id).map((r) => r.id) }));
  const agentRuns = [...runs, ...o.toolRunAgentRuns];

  // time lanes: Drive edits + Claude sessions (generic), plus overlay extras (Slack bursts)
  const cutoff = Date.parse(NOW) - 6 * 86_400_000;
  const timeBlocks: In['timeBlocks'] = [];
  [...raw.drive.owned_by_tristan, ...raw.drive.owned_html_exports].forEach((f, i) => {
    if (f.lastModifyingUser !== meName || Date.parse(f.modifiedTime) < cutoff) return;
    timeBlocks.push({ id: `tb_d${i + 1}`, lane: 'drive', start: plusMin(iso(f.modifiedTime), -20), end: iso(f.modifiedTime), label: x(f.title, 60), activityId: null, hatched: false });
  });
  raw.sessions.sessions.forEach((s, i) => {
    if (Date.parse(s.last_ts) < cutoff || s.user_turns === 0 || s.tags.includes('autopilot')) return;
    timeBlocks.push({ id: `tb_c${i + 1}`, lane: 'claude', start: plusMin(iso(s.last_ts), -25), end: iso(s.last_ts), label: `Claude · ${x(s.title, 50)}`, activityId: null, hatched: true });
  });
  timeBlocks.push(...(o.timeBlocksExtra ?? []));

  // settings
  const policy = { id: 'pol_se_ic', version: 1, name: 'SE IC (starter pack)', role: 'se_ic' as const, weights: WEIGHTS, rules: POLICY_RULES, updatedAt: t(-14, '09:00'), note: 'Role pack: SE IC' };
  const voiceSamples = o.settings.voiceSamples.length ? o.settings.voiceSamples : (voice?.exemplars ?? []).slice(0, 4).map((e) => x(e.text, 160));
  const settings: In['settings'] = {
    profile: { version: 1, name: meName, email: o.meta.email, role: 'se_ic', timezone: TZ, workingHours: o.settings.workingHours, managerName: raw.org62.user.manager },
    policy,
    agentBehavior: {
      version: 1,
      voice: { samples: voiceSamples, style: x(voice?.tone ?? o.settings.voiceStyle, 260) },
      // Slack/email replies stay approval-gated (L1); canvas rewrites + activity logging are the pre-approved exceptions.
      autonomy: { slack_reply: 'L1', email_reply: 'L1', canvas_rewrite: 'L3', tool_launch: 'L2', claude_session: 'L2', activity_log: 'L3' },
      taskCapture: o.settings.taskCapture,
      watchedSources: o.settings.watchedSources,
      drafting: { tone: 'crisp', length: 'short', signoff: voice?.signoff ?? '' },
    },
    sending: { version: 1, defaultMode: 'draft', dryRun: true, verifyReadback: true, undoWindowSec: 10 },
    budgets: { version: 1, softUsd: 5, hardUsd: 15, alertPct: 80 },
    display: { version: 1, density: 'comfortable', theme: 'lightning', shortcutsEnabled: true, scheme: 'dark', textSize: 16 },
  };

  const spend: In['spend'] = {
    today: { usd: 0.64, softBudgetUsd: 5, hardCapUsd: 15, pct: 13 },
    state: 'ok',
    last7d: [-6, -5, -4, -3, -2, -1, 0].map((off, i) => ({ day: day(off), usd: [0.3, 0.8, 1.9, 1.2, 2.1, 1.4, 0.64][i] })),
    byScanner: [{ name: 'slack', usd: 0.18 }, { name: 'org62', usd: 0.06 }, { name: 'briefs', usd: 0.14 }, { name: 'nba', usd: 0.2 }, { name: 'chat', usd: 0.06 }],
    byModel: [{ model: 'haiku', usd: 0.26 }, { model: 'sonnet', usd: 0.38 }],
  };
  const job = (id: string, type: string, status: In['jobs'][number]['status'], at: string, extra: Partial<In['jobs'][number]> = {}): In['jobs'][number] => ({ id, type, status, attempts: status === 'queued' ? 0 : 1, maxAttempts: 5, runAt: at, ...extra });
  const jobs: In['jobs'] = [
    job('job_1', 'scan.slack', 'succeeded', t(0, '08:15'), { startedAt: t(0, '08:15'), finishedAt: t(0, '08:16') }),
    job('job_2', 'scan.vdp', 'dead', t(0, '08:16'), { attempts: 5, finishedAt: t(0, '08:19'), error: 'Unexpected content type: text/html (cookie expired)' }),
    job('job_3', 'brief.generate', 'succeeded', t(0, '07:30'), { startedAt: t(0, '07:30'), finishedAt: t(0, '07:33') }),
    job('job_4', 'reevaluate', 'queued', t(0, '08:21'), { dedupeKey: 'reeval:today', generation: 1 }),
    job('job_5', 'scan.org62', 'running', t(0, '08:19'), { startedAt: t(0, '08:19') }),
  ];

  const seedInput: SeedInput = {
    meta: {
      schemaVersion: 1,
      label: `real fixture ${day(0)} (local only, never commit)`,
      asOf: NOW,
      lastActiveAt: o.meta.lastActiveAt,
      timezone: TZ,
      user: me,
      quarter: o.meta.quarter,
      canvas: o.meta.canvas,
    },
    people: o.people,
    accounts,
    opps,
    missedOpps,
    initiatives: o.initiatives,
    workItems: items,
    evidence,
    nbas: o.nbas.map(fillNba),
    drafts: o.drafts.map(fillDraft),
    proposals: o.proposals,
    assets,
    calendar: { events, slots: o.slots },
    agentRuns,
    toolAdapters,
    toolRuns: o.toolRuns,
    activity,
    timeBlocks,
    briefs: o.briefs,
    watches: o.watches,
    connectors: conn.connectors,
    scanRuns: conn.scanRuns,
    jobs,
    eventLog: conn.eventLog,
    spend,
    settings,
    policyVersions: [{ version: 1, at: policy.updatedAt, by: 'system', note: 'Role pack: SE IC', policy }],
    chatThreads: o.chatThreads,
    mappings: o.mappings,
    audit: o.audit,
    scenario: o.scenario,
  };

  // ---- validate
  const parsed = Seed.safeParse(seedInput);
  if (!parsed.success) {
    const lines = parsed.error.issues.slice(0, 40).map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    die(`seed does not match the Seed schema (${parsed.error.issues.length} issues):\n${lines.join('\n')}`);
  }
  const seed = parsed.data;
  checkRefs(seed);

  const json = `${JSON.stringify(seed, null, 2)}\n`;
  assertNoCredentials(json);
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json, { mode: 0o600 });
  chmodSync(OUT_PATH, 0o600);

  const top3 = seed.workItems.filter((w) => w.rank !== null && w.rank <= 3).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  console.log(`wrote ${OUT_PATH} (chmod 600, ${(json.length / 1024).toFixed(0)} KB)`);
  console.log(
    `counts: ${JSON.stringify({
      initiatives: seed.initiatives.length,
      workItems: seed.workItems.length,
      ranked: seed.workItems.filter((w) => w.rank !== null).length,
      suggested: seed.workItems.filter((w) => w.state === 'suggested').length,
      background: seed.workItems.filter((w) => w.isBackground).length,
      evidence: seed.evidence.length,
      nbas: seed.nbas.length,
      drafts: seed.drafts.length,
      events: seed.calendar.events.length,
      agentRuns: seed.agentRuns.length,
      accounts: seed.accounts.length,
      opps: seed.opps.length,
      missedOpps: seed.missedOpps.length,
      activity: seed.activity.length,
      briefs: seed.briefs.length,
      scenario: seed.scenario?.length ?? 0,
    })}`,
  );
  console.log(`top3: ${top3.map((w) => `#${w.rank} ${w.id}`).join(' | ')}`);
}

/** Referential integrity: ids the UI follows must exist. */
function checkRefs(seed: Seed): void {
  const ids = {
    work: new Set(seed.workItems.map((w) => w.id)),
    ini: new Set(seed.initiatives.map((i) => i.id)),
    acc: new Set(seed.accounts.map((a) => a.id)),
    opp: new Set(seed.opps.map((o) => o.id)),
    ev: new Set(seed.calendar.events.map((e) => e.id)),
    run: new Set(seed.agentRuns.map((r) => r.id)),
    nba: new Set(seed.nbas.map((n) => n.id)),
    draft: new Set(seed.drafts.map((d) => d.id)),
    asset: new Set(seed.assets.map((a) => a.id)),
    tool: new Set(seed.toolAdapters.map((a) => a.manifest.id)),
  };
  const bad: string[] = [];
  const need = (set: Set<string>, id: string | null | undefined, what: string) => {
    if (id && !set.has(id)) bad.push(`${what} -> ${id}`);
  };
  for (const w of seed.workItems) {
    need(ids.ini, w.initiativeId, `work ${w.id}.initiativeId`);
    need(ids.acc, w.accountId, `work ${w.id}.accountId`);
    need(ids.opp, w.oppId, `work ${w.id}.oppId`);
    need(ids.ev, w.servesEventId, `work ${w.id}.servesEventId`);
    need(ids.nba, w.nbaId, `work ${w.id}.nbaId`);
    for (const r of w.runIds) need(ids.run, r, `work ${w.id}.runIds`);
    for (const a of w.assetIds) need(ids.asset, a, `work ${w.id}.assetIds`);
  }
  for (const e of seed.evidence) need(ids.work, e.workItemId, `evidence ${e.id}`);
  for (const n of seed.nbas) {
    need(ids.work, n.workItemId, `nba ${n.id}.workItemId`);
    need(ids.draft, n.draftId, `nba ${n.id}.draftId`);
    need(ids.run, n.runId, `nba ${n.id}.runId`);
    need(ids.tool, n.toolAdapterId, `nba ${n.id}.toolAdapterId`);
  }
  for (const d of seed.drafts) {
    need(ids.work, d.workItemId, `draft ${d.id}.workItemId`);
    need(ids.nba, d.nbaId, `draft ${d.id}.nbaId`);
  }
  for (const r of seed.agentRuns) need(ids.work, r.workItemId, `run ${r.id}.workItemId`);
  for (const i of seed.initiatives) {
    need(ids.acc, i.accountId, `initiative ${i.id}.accountId`);
    need(ids.opp, i.oppId, `initiative ${i.id}.oppId`);
    need(ids.ev, i.targetEventId, `initiative ${i.id}.targetEventId`);
    for (const a of i.assetIds) need(ids.asset, a, `initiative ${i.id}.assetIds`);
  }
  for (const e of seed.calendar.events) {
    need(ids.acc, e.accountId, `event ${e.id}.accountId`);
    need(ids.opp, e.oppId, `event ${e.id}.oppId`);
    for (const w of e.takeaways?.workItemIds ?? []) need(ids.work, w, `event ${e.id}.takeaways`);
    need(ids.work, e.prep?.workItemId, `event ${e.id}.prep`);
  }
  for (const s of seed.calendar.slots) need(ids.work, s.workItemId, `slot ${s.id}`);
  for (const s of seed.scenario ?? []) {
    for (const a of s.actions) {
      if ('itemId' in a) need(ids.work, a.itemId, `scenario ${s.id}.itemId`);
      if ('nbaId' in a) need(ids.nba, a.nbaId, `scenario ${s.id}.nbaId`);
      if ('runId' in a) need(ids.run, a.runId, `scenario ${s.id}.runId`);
    }
  }
  if (bad.length) die(`dangling references (${bad.length}):\n${bad.slice(0, 40).map((b) => `  - ${b}`).join('\n')}`);
}

main().catch((err: unknown) => {
  if (err instanceof SeedBuildError) console.error(`\nseed build failed:\n${err.message}\n`);
  else console.error(err);
  process.exit(1);
});
