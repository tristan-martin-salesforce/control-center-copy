/**
 * Lane D (audit 2026-11-13), the pure parts: tokens split by cache and model (D0), the pass split's rounding fix and
 * the rest path's per-model tokens, the Claude-sessions model decision (D3), the Slack pre-check (D5), the read-in
 * model policy and evidence hash (D2), and the Spend & decisions aggregation, CSV and mock (D0). Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import { readInModelFor, READIN_MODELS, type SpendSummary } from '../../src/contract';
import { ATTENTION_STATUSES, MODEL_MIN_INTERVAL_MS, sessionModelDecision, type FileCursor } from '../../src/connectors/claude/sessions';
import { ledgerGaps, ledgerHash } from '../../src/db/ledger';
import { auditPeriod, buildSpendAudit, cacheHitPct, spendAuditCsv } from '../../src/engines/spend-audit/aggregate';
import { readInEvidenceHash } from '../../src/llm/readin/evidence';
import type { ReadInContext } from '../../src/llm/readin/types';
import { addUsage, usageFromBlock, usageFromModelUsage } from '../../src/llm/usage';
import { classifySearch, runSlackPrecheck, slackPrecheckQueries } from '../../src/scanner/precheck/slack';
import { runOutcome, skillKeyOf } from '../../src/scanner/runtime/scanner-runtime';
import { runSpend } from '../../src/scanner/runtime/spend';
import { restRows } from '../../src/scanner/store-db';
import { passSpendOf, splitByPasses } from '../../src/scanner/trace/queries';
import { mockSpendAudit, mockSpendAuditDetail } from '../../src/server/datasource/mock/spend-audit';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';

describe('D0 usage: cache reads and writes are not input', () => {
  it('splits the SDK modelUsage per model', () => {
    const u = usageFromModelUsage({
      [HAIKU]: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 4000, costUSD: 0.002 },
      [SONNET]: { inputTokens: 900, outputTokens: 800, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 0, costUSD: 0.04 },
    })!;
    expect(u).toMatchObject({ inputTokens: 2100, outputTokens: 1100, cacheReadTokens: 70_000, cacheWriteTokens: 4000 });
    expect(u.byModel.map((m) => m.model)).toEqual([SONNET, HAIKU]); // largest cost first
    expect(usageFromModelUsage({})).toBeNull();
  });
  it('a usage block keeps its parts, and usages add per model', () => {
    const a = usageFromBlock(HAIKU, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
    expect(a).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 });
    const b = addUsage(a, a, usageFromBlock(SONNET, { input_tokens: 1 }));
    expect(b.byModel.find((m) => m.model === HAIKU)).toMatchObject({ inputTokens: 20, cacheReadTokens: 200 });
    expect(b.inputTokens).toBe(21);
  });
  it('cache hit rate is cache reads over every prompt token', () => {
    expect(cacheHitPct({ inputTokens: 250, cacheReadTokens: 700, cacheWriteTokens: 50 })).toBe(70);
    expect(cacheHitPct({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
  it('the content hash is stable and changes with any part', () => {
    expect(ledgerHash(HAIKU, 'scan-slack@1', 'prompt')).toBe(ledgerHash(HAIKU, 'scan-slack@1', 'prompt'));
    expect(ledgerHash(HAIKU, 'scan-slack@1', 'prompt')).not.toBe(ledgerHash(SONNET, 'scan-slack@1', 'prompt'));
    expect(ledgerHash('a', 'bc')).not.toBe(ledgerHash('ab', 'c'));
    expect(ledgerHash('x')).toHaveLength(32);
  });
});

describe('D0 the pass split books every dollar with its tokens', () => {
  const pass = (seq: number, p: Record<string, unknown>) => passSpendOf(seq, p);
  it('a last pass one rounding step over what is left is still that pass (the Sonnet escalation booked as Haiku)', () => {
    const passes = [
      pass(15, { pass: 'traversal', model: HAIKU, costUsd: 0.009319, inputTokens: 1000, outputTokens: 100 }),
      pass(20, { pass: 'triage', model: HAIKU, costUsd: 0.006943, inputTokens: 900, outputTokens: 90 }),
      pass(24, { pass: 'escalate', model: SONNET, costUsd: 0.126972, inputTokens: 800, outputTokens: 80, cacheReadTokens: 5000, contentHash: 'h' }),
    ];
    const s = splitByPasses(0.143233, passes);
    expect(s.parts.map((p) => p.model)).toEqual([HAIKU, HAIKU, SONNET]);
    expect(s.restUsd).toBe(0);
    expect(s.parts.reduce((a, p) => a + p.costUsd, 0)).toBeCloseTo(0.143233, 9);
    expect(s.parts[2]).toMatchObject({ cacheReadTokens: 5000, contentHash: 'h' });
  });
  it('the rest is booked on the models the SDK says spent it, with their remaining tokens', () => {
    const parts = [pass(1, { pass: 'traversal', model: HAIKU, costUsd: 0.01, inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 })];
    const rows = restRows(0.05, parts, {
      connector: 'slack',
      model: HAIKU,
      costUsd: 0.06,
      inputTokens: 800,
      outputTokens: 80,
      modelReason: 'default',
      outcome: 'nothing_new',
      contentHash: 'h',
      usage: [
        { model: HAIKU, inputTokens: 300, outputTokens: 30, cacheReadTokens: 3000, cacheWriteTokens: 0, costUsd: 0.02 },
        { model: SONNET, inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 100, costUsd: 0.04 },
      ],
      trigger: 'schedule',
    }, 'scan-slack', null);
    expect(rows.map((r) => r.model).sort()).toEqual([HAIKU, SONNET]);
    expect(rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(0.05, 9);
    expect(rows.find((r) => r.model === HAIKU)).toMatchObject({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 2000 });
    expect(rows.find((r) => r.model === SONNET)).toMatchObject({ inputTokens: 500, cacheWriteTokens: 100 });
    expect(rows.every((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens > 0)).toBe(true);
  });
  it('without usage the rest keeps the caller model and tokens', () => {
    const rows = restRows(0.01, [], { connector: 'gmail', model: HAIKU, costUsd: 0.01, inputTokens: 40, outputTokens: 4, cacheReadTokens: 400, trigger: 'schedule', modelReason: 'default', outcome: 'ok', contentHash: 'h' }, 'scan-gmail', null);
    expect(rows).toEqual([expect.objectContaining({ model: HAIKU, usd: 0.01, inputTokens: 40, outputTokens: 4, cacheReadTokens: 400 })]);
  });
  it('a reconcile or skill-upgrade run is booked with its tokens, trigger, model reason, outcome and a hash (runSpend)', () => {
    const r = runSpend(
      { ok: true, costUsd: 0.011, inputTokens: 4064, outputTokens: 4771, cacheReadTokens: 30_000, cacheWriteTokens: 0, turns: 3, counts: { recorded: 0, new: 0, changed: 0, linked: 2, proposed: 0, unlinked: 0, coverage: 0 } },
      { connector: 'drive', model: HAIKU, runId: 'r1', trigger: 'reconcile', modelReason: 'default', hashOf: ['skills/scan-drive.md', 'relink', 'si-1'] },
    );
    expect(r).toMatchObject({ trigger: 'reconcile', modelReason: 'default', outcome: 'new:0,changed:0,linked:2,proposed:0', inputTokens: 4064, cacheReadTokens: 30_000 });
    expect(r.contentHash).toBe(ledgerHash(HAIKU, 'skills/scan-drive.md', 'relink', 'si-1')); // no prompt hash: what it was asked to do
    expect(runSpend({ ok: true, costUsd: 0.01, inputTokens: 1, outputTokens: 1, turns: 1, contentHash: 'p' }, { connector: 'drive', model: HAIKU, trigger: 'reconcile', modelReason: 'default', hashOf: [] }).contentHash).toBe('p');
    expect(ledgerGaps({ ...r, costUsd: r.costUsd })).toEqual([]);
  });
  it('run outcome codes and skill keys', () => {
    expect(runOutcome({ ok: true, counts: { recorded: 3, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, coverage: 1 } })).toBe('nothing_new');
    expect(runOutcome({ ok: true, counts: { recorded: 3, new: 2, changed: 0, linked: 1, proposed: 0, unlinked: 0, coverage: 1 } })).toBe('new:2,changed:0,linked:1,proposed:0');
    expect(runOutcome({ ok: false, error: { message: 'x', errorClass: 'auth' } })).toBe('error:auth');
    expect(skillKeyOf({ skillPath: 'skills/scan-claude-sessions.md' })).toBe('scan-claude-sessions');
  });
});

describe('D3 Claude sessions: the model sees meaningful changes only, at most once per 5 min', () => {
  const now = Date.parse('2026-11-13T17:00:00Z');
  const base = { contentHash: 'c1', meaning: 'm1', status: 'busy', linked: false, nowMs: now, minIntervalMs: MODEL_MIN_INTERVAL_MS };
  const seen: FileCursor = { o: 10, i: 1, eh: 'c1', mh: 'm1', ms: 'busy', m: now - 30 * 60_000 };
  it('a new session goes to the model', () => {
    expect(sessionModelDecision(base)).toMatchObject({ to: 'model', reason: 'new_session', next: { mh: 'm1', ms: 'busy', m: now } });
  });
  it('a busy ↔ idle flip is recorded without the model', () => {
    const v = sessionModelDecision({ ...base, prev: seen, contentHash: 'c2', status: 'idle' });
    expect(v).toMatchObject({ to: 'quiet', reason: 'status_only', next: { eh: 'c2', mh: 'm1', ms: 'busy' } });
    expect(sessionModelDecision({ ...base, prev: seen })).toMatchObject({ to: 'none' });
  });
  it('waiting, done or errored is worth a look', () => {
    for (const s of ATTENTION_STATUSES) expect(sessionModelDecision({ ...base, prev: seen, contentHash: 'c2', meaning: 'm2', status: s })).toMatchObject({ to: 'model', reason: 'status_attention' });
  });
  it('new content: the model when linked to an open item, recorded only otherwise', () => {
    expect(sessionModelDecision({ ...base, prev: seen, contentHash: 'c2', meaning: 'm2', linked: true })).toMatchObject({ to: 'model', reason: 'linked_content' });
    expect(sessionModelDecision({ ...base, prev: seen, contentHash: 'c2', meaning: 'm2' })).toMatchObject({ to: 'quiet', reason: 'unlinked_content', next: { mh: 'm2' } });
  });
  it('a second look within 5 min waits, and happens once the interval passed', () => {
    const recent: FileCursor = { ...seen, m: now - 60_000 };
    const wait = sessionModelDecision({ ...base, prev: recent, contentHash: 'c2', meaning: 'm2', status: 'waiting' });
    expect(wait).toMatchObject({ to: 'quiet', reason: 'min_interval', next: { p: 1, mh: 'm1', ms: 'busy' } });
    const later = sessionModelDecision({ ...base, prev: { o: 10, i: 1, ...wait.next }, contentHash: 'c2', meaning: 'm2', status: 'waiting', nowMs: now + 5 * 60_000 });
    expect(later).toMatchObject({ to: 'model', reason: 'status_attention' });
    expect(later.next.p).toBeUndefined();
  });
  it('a second waiting after resuming is a new question', () => {
    const waited: FileCursor = { ...seen, mh: 'mw', ms: 'waiting' };
    const resumed = sessionModelDecision({ ...base, prev: waited, contentHash: 'c2', meaning: 'm2', status: 'busy' });
    expect(resumed.next.ms).toBe('busy');
    expect(sessionModelDecision({ ...base, prev: { o: 1, i: 1, ...resumed.next }, contentHash: 'c3', meaning: 'm3', status: 'waiting' })).toMatchObject({ to: 'model' });
  });
  it('R15: an idle unlinked change waits while fresh, then reaches the model once quiet 30 min (once)', () => {
    const fresh = sessionModelDecision({ ...base, prev: seen, contentHash: 'c2', meaning: 'm2', status: 'idle', quietMs: 60_000 });
    expect(fresh).toMatchObject({ to: 'quiet', reason: 'unlinked_content', next: { mh: 'm1', p: 1 } });
    const quiet = sessionModelDecision({ ...base, prev: { o: 10, i: 1, ...fresh.next }, contentHash: 'c2', meaning: 'm2', status: 'idle', quietMs: 31 * 60_000 });
    expect(quiet).toMatchObject({ to: 'model', reason: 'idle_quiet', next: { mh: 'm2' } });
    expect(sessionModelDecision({ ...base, prev: { o: 10, i: 1, ...quiet.next }, contentHash: 'c2', meaning: 'm2', status: 'idle', quietMs: 90 * 60_000 }).to).toBe('none');
  });
  it('a cursor from before D3 starts accounting without a model call', () => {
    expect(sessionModelDecision({ ...base, prev: { o: 10, i: 1, eh: 'c1' } })).toMatchObject({ to: 'none', next: { mh: 'm1', ms: 'busy' } });
  });
});

describe('D5 Slack pre-check', () => {
  const ctx = { me: { slackId: 'U0ME00001' } } as never;
  const window = { from: '2026-11-13T16:00:00.000Z', to: '2026-11-13T16:02:00.000Z' };
  const EMPTY = JSON.stringify({ results: '# Search Results for: q\n\nNo results found.\n', pagination_info: 'End of results - No more pages available.\\n' });
  const FOUND = JSON.stringify({ results: '# Search Results for: q\n\n## Messages (1 results)\n### Result 1 of 1\nChannel: DM (ID: D0DM00009)\nFrom: PERSON_A (ID: U0PERSONA) \nTime: 2026-11-13 09:01:00 MST\nMessage_ts: 1794588060.000100\nPermalink: [link](https://example.slack.com/archives/D0DM00009/p1794588060000100)\nText: \nhello\n' });
  const look = (texts: Array<string | null>) => {
    const calls: Array<Record<string, unknown>> = [];
    let i = 0;
    const fn = async (l: { args: Record<string, unknown> }) => {
      calls.push(l.args);
      const text = texts[i++] ?? null;
      return { text, code: text === null ? 'timeout' : 'ok', message: '', costUsd: 0.0008, inputTokens: 400, outputTokens: 60, cacheReadTokens: 4000, cacheWriteTokens: 0, model: HAIKU, started: true };
    };
    return { calls, fn };
  };
  it('the inbox asks S1–S3 over the window, newest first, one result; a channel needs its name', () => {
    const q = slackPrecheckQueries({ scope: 'inbox', window, vars: {}, ctx })!;
    expect(q.map((x) => x.ref)).toEqual(['search:dm', 'search:mentions', 'search:mine']);
    expect(q[0]!.args).toMatchObject({ filters: '-from:<@U0ME00001>', channel_types: 'im,mpim', sort: 'timestamp', sort_dir: 'desc', limit: 1, after: String(Date.parse(window.from) / 1000 - 120), before: String(Date.parse(window.to) / 1000) });
    expect(slackPrecheckQueries({ scope: 'channel:C0PLACE01', window, vars: { 'channel.label': 'acme-ext' }, ctx })![0]!.args.filters).toBe('in:#acme-ext');
    expect(q[1]!.args).toMatchObject({ keywords: ['<@U0ME00001>'], channel_types: 'public_channel,private_channel' });
    expect(q[1]!.args).not.toHaveProperty('filters');
    expect(q.every((x) => !('query' in x.args))).toBe(true);
    expect(slackPrecheckQueries({ scope: 'channel:C0PLACE01', window, vars: { 'channel.label': '' }, ctx })).toBeNull();
    expect(slackPrecheckQueries({ scope: 'thread:C0:1.2', window, vars: {}, ctx })).toBeNull();
  });
  it('only "No results found." counts as empty', () => {
    expect(classifySearch(EMPTY)).toBe('empty');
    expect(classifySearch(FOUND)).toBe('found');
    expect(classifySearch('{"results":"# Search Results for: q\\n\\nsomething else"}')).toBe('unclear');
    expect(classifySearch('### Result 1 of 1 (unparseable)')).toBe('unclear');
  });
  it('all empty: coverage for every ref the skill reports (S4 included) and the cursor at the window end', async () => {
    const l = look([EMPTY, EMPTY, EMPTY]);
    const r = (await runSlackPrecheck({ scope: 'inbox', window, vars: {}, ctx, signal: new AbortController().signal }, l.fn as never))!;
    expect(r.empty).toBe(true);
    expect(r.coverage.map((c) => c.ref)).toEqual(['search:dm', 'search:mentions', 'search:mine', 'search:mine:files']);
    expect(r.coverage.every((c) => c.kind === 'query_window' && c.from === window.from && c.to === window.to)).toBe(true);
    expect(r.cursor).toEqual({ value: `${Date.parse(window.to) / 1000}.000000`, at: window.to });
    expect(r).toMatchObject({ calls: 3, cacheReadTokens: 12_000 });
    expect(r.costUsd).toBeCloseTo(0.0024, 9);
  });
  it('a message found or a failed lookup stops early and runs the traversal (fail open)', async () => {
    const found = look([EMPTY, FOUND, EMPTY]);
    expect(await runSlackPrecheck({ scope: 'inbox', window, vars: {}, ctx, signal: new AbortController().signal }, found.fn as never)).toMatchObject({ empty: false, why: 'found:search:mentions', calls: 2 });
    const failed = look([null]);
    expect(await runSlackPrecheck({ scope: 'inbox', window, vars: {}, ctx, signal: new AbortController().signal }, failed.fn as never)).toMatchObject({ empty: false, why: 'error:timeout', calls: 1 });
  });
});

describe('D2 read-ins: model per trigger, and the evidence hash', () => {
  it('the user asking gets the strong model; automatic triggers the light one', () => {
    expect(readInModelFor('on_demand')).toEqual({ model: READIN_MODELS.strong, reason: 'user_asked' });
    for (const t of ['top_rank', 'meeting_prep', 'new_evidence', 'direct_ask'] as const) expect(readInModelFor(t)).toEqual({ model: READIN_MODELS.light, reason: `policy:${t}` });
  });
  const ctx = (over: Partial<ReadInContext> = {}): ReadInContext =>
    ({
      entity: { type: 'work_item', id: 'wi_1' },
      skill: 'readin-ask',
      generation: 3,
      trigger: 'direct_ask',
      now: '2026-11-13T17:00:00.000Z',
      timezone: 'America/Denver',
      me: { name: 'Ada Example' },
      item: { id: 'wi_1', title: 'Send the deck to PERSON_A', purpose: null, kind: 'ask', state: 'open', due: null, createdAt: '2026-11-12T10:00:00.000Z', rank: 2, why: 'ranked 2: due soon', counterparty: null, people: [] },
      account: null,
      opp: null,
      initiative: null,
      evidence: [{ id: 'e1', role: 'origin', at: '2026-11-12T10:00:00.000Z', source: { kind: 'slack', label: 'DM' }, author: 'PERSON_A', fromMe: false, text: 'can you send the deck?' }],
      siblings: [],
      related: [],
      saidBefore: [],
      reply: null,
      voice: null,
      ...over,
    }) as ReadInContext;
  it('the clock, trigger, generation and ranking do not change it; evidence does', () => {
    const a = readInEvidenceHash(ctx());
    expect(readInEvidenceHash(ctx({ now: '2026-11-14T08:00:00.000Z', trigger: 'top_rank', generation: 9, item: { ...ctx().item!, rank: 1, why: 'ranked 1' } }))).toBe(a);
    expect(readInEvidenceHash(ctx({ evidence: [{ ...ctx().evidence[0]!, text: 'can you send the deck? and the pricing' }] }))).not.toBe(a);
    expect(readInEvidenceHash(ctx({ item: { ...ctx().item!, state: 'waiting_on_me' } }))).not.toBe(a);
  });
});

describe('D0 Spend & decisions: aggregation, CSV, mock parity', () => {
  const row = (o: Partial<Parameters<typeof buildSpendAudit>[0]['rows'][number]>) => ({ day: '2026-11-12', skill: 'scan-slack', model: HAIKU, trigger: 'schedule', modelReason: 'default', budget: 'daily' as const, usd: 1, calls: 100, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 7000, cacheWriteTokens: 2000, untokenizedUsd: 0, ...o });
  const p = buildSpendAudit({
    from: '2026-11-11',
    to: '2026-11-13',
    timezone: 'America/Denver',
    rows: [row({}), row({ day: '2026-11-13', skill: 'readin-ask', model: SONNET, trigger: 'direct_ask', modelReason: 'policy:direct_ask', usd: 2, calls: 20 }), row({ day: '2026-11-11', trigger: null, modelReason: null, usd: 0.5, calls: 5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, untokenizedUsd: 0.5 })],
    decisions: [
      { day: '2026-11-12', skill: 'scan-slack', kind: 'skip', reason: 'precheck_empty', trigger: 'schedule', count: 30, usd: 0 },
      { day: '2026-11-13', skill: 'settle-item', kind: 'escalate', reason: 'verdict_changed', trigger: 'interval', count: 1, usd: 0.02 },
      { day: '2026-11-13', skill: 'settle-item', kind: 'escalate', reason: 'verdict_same', trigger: 'interval', count: 3, usd: 0.06 },
    ],
    repeats: { calls: 4, usd: 0.04 },
  });
  it('totals, every day of the period, breakdowns and the untokenized dollars', () => {
    expect(p.totals).toMatchObject({ usd: 3.5, calls: 125, repeatCalls: 4, untokenizedUsd: 0.5, untokenizedCalls: 5, unattributedCalls: 5 });
    expect(p.byDay.map((d) => d.key)).toEqual(['2026-11-11', '2026-11-12', '2026-11-13']);
    expect(p.bySkill[0]).toMatchObject({ key: 'readin-ask', usd: 2 });
    expect(p.byTrigger.map((t) => t.key).sort()).toEqual(['direct_ask', 'schedule', 'unrecorded']);
    expect(p.byModel.find((m) => m.key === HAIKU)!.cacheHitPct).toBe(Math.round((14000 / 20000) * 1000) / 10);
  });
  it('a skip is estimated at the skill average; the settle escalation rate', () => {
    const skip = p.decisions.find((d) => d.reason === 'precheck_empty')!;
    expect(skip.estSavedUsd).toBeCloseTo(30 * (1.5 / 105), 6);
    expect(p.decisionTotals).toMatchObject({ skips: 30, blocks: 0, escalations: 4 });
    expect(p.settleEscalation).toMatchObject({ escalated: 4, changed: 1, same: 3, changedPct: 25, extraUsd: 0.08 });
  });
  it('the CSV has one line per call group and per decision group', () => {
    const lines = spendAuditCsv(p).trim().split('\n');
    expect(lines[0]).toMatch(/^record,day,skill,model,trigger,why_model,budget,kind,reason,calls_or_count,usd/);
    expect(lines.filter((l) => l.startsWith('spend,'))).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith('decision,'))).toHaveLength(3);
  });
  it('the period defaults to the last 7 days and is at most 92', () => {
    const now = new Date('2026-11-13T17:00:00Z');
    expect(auditPeriod({}, now, 'America/Denver')).toEqual({ from: '2026-11-07', to: '2026-11-13' });
    expect(auditPeriod({ from: '2026-01-01', to: '2026-11-13' }, now, 'UTC').from).toBe('2026-08-14');
  });
  it('mock mode: placeholder rows from the seed spend, deterministic, marked simulated', () => {
    const spend: SpendSummary = { today: { usd: 1, softBudgetUsd: 5, hardCapUsd: 15, pct: 20 }, state: 'ok', last7d: [{ day: '2026-11-12', usd: 1 }, { day: '2026-11-13', usd: 2 }], byScanner: [{ name: 'slack', usd: 0.6 }, { name: 'chat', usd: 0.4 }], byModel: [] };
    const a = mockSpendAudit(spend, { from: '2026-11-12', to: '2026-11-13' }, { now: new Date('2026-11-13T17:00:00Z'), timezone: 'UTC' });
    expect(a.simulated).toBe(true);
    expect(a.totals.usd).toBeCloseTo(3, 6);
    expect(a).toEqual(mockSpendAudit(spend, { from: '2026-11-12', to: '2026-11-13' }, { now: new Date('2026-11-13T17:00:00Z'), timezone: 'UTC' }));
    const d = mockSpendAuditDetail(spend, { day: '2026-11-13', skill: 'scan-slack', offset: 0, limit: 5 });
    expect(d.calls).toHaveLength(5);
    expect(d.totalCalls).toBeGreaterThan(5);
    expect(d.calls.every((c) => c.skill === 'scan-slack')).toBe(true);
  });
});
