import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catchUpFraction, planResume } from '../../../src/scanner/runtime/resume-planner';
import { loadSkill, parseFrontmatter, renderContextPack, renderRunBlock } from '../../../src/llm/skill-loader';
import { assertReadOnly, restrictedTools, SLACK_SCAN_TOOLS } from '../../../src/llm/mcp-config';
import { classifyError, probeFromError } from '../../../src/llm/errors';
import { org62AccountIds, org62PersonaVars } from '../../../src/scanner/runtime/connectors';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { FIXTURES, loadFixture, parseSlackSearch } from './helpers/slack-sim';
import { PROFILE } from './helpers/world';

const H = 3_600_000;

describe('resume planner', () => {
  it('small gap → one incremental window', () => {
    const now = new Date('2026-11-05T15:00:00Z');
    expect(planResume({ now, gaps: [{ from: '2026-11-05T14:20:00Z', to: '2026-11-05T15:00:00Z' }] })).toEqual([{ mode: 'incremental', order: 0, window: { from: '2026-11-05T14:20:00.000Z', to: '2026-11-05T15:00:00.000Z' } }]);
  });

  it('large gap → head first, then 6 h chunks oldest → newest that tile the rest exactly', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    const plan = planResume({ now, gaps: [{ from: '2026-10-30T23:00:00Z', to: now.toISOString() }] });
    expect(plan[0]).toMatchObject({ mode: 'head', window: { from: '2026-11-02T14:00:00.000Z', to: '2026-11-02T15:00:00.000Z' } });
    const back = plan.slice(1);
    expect(back.every((p) => p.mode === 'backfill')).toBe(true);
    for (let i = 1; i < back.length; i++) expect(back[i]!.window.from).toBe(back[i - 1]!.window.to);
    expect(back[0]!.window.from).toBe('2026-10-30T23:00:00.000Z');
    expect(back.at(-1)!.window.to).toBe('2026-11-02T14:00:00.000Z');
    expect(catchUpFraction(plan.map((p) => p.window), [])).toBe(1);
    expect(catchUpFraction(plan.map((p) => p.window), back.map((p) => p.window))).toBeCloseTo(1 / 64, 3);
  });

  it('never backfills beyond the floor and skips tiny holes', () => {
    const now = new Date('2026-11-30T00:00:00Z');
    const plan = planResume({ now, gaps: [{ from: '2026-10-01T00:00:00Z', to: now.toISOString() }, { from: '2026-11-29T00:00:00.000Z', to: '2026-11-29T00:00:00.500Z' }], maxBackfillMs: 2 * 24 * H });
    expect(Date.parse(plan.filter((p) => p.mode === 'backfill')[0]!.window.from)).toBe(now.getTime() - 2 * 24 * H);
  });
});

describe('skills (SCANNER.md §4)', () => {
  const sections = ['Scope', 'Exact', 'Traversal rules', 'Extraction rules', 'Linking rules', 'Redaction', 'Stop condition and coverage', 'Worked examples'];

  for (const name of ['scan-slack', 'scan-org62']) {
    it(`${name} is versioned and has every required section`, () => {
      const s = loadSkill(`skills/${name}.md`);
      expect(s.frontmatter.skill).toBe(name);
      // Skills are versioned (semver); fixes bump the version so evidence and runs record which one linked (SCANNER.md §4).
      expect(s.versionTag).toMatch(new RegExp(`^${name}@\\d+\\.\\d+\\.\\d+$`));
      for (const sec of sections) expect(s.body).toMatch(new RegExp(`^## \\d+\\. ${sec}`, 'm'));
      const examples = s.body.split(/^## \d+\. Worked examples/m)[1]!;
      expect((examples.match(/^\*\*[EO]\d+\./gm) ?? []).length).toBeGreaterThanOrEqual(3);
    });
  }

  it('scan-slack covers the background promise, "done → completion", and the R-UI-22 loop-back', () => {
    const body = loadSkill('skills/scan-slack.md').body;
    expect(body).toMatch(/I'm going to figure out how to distribute as a desktop app/);
    expect(body).toMatch(/Done, see deck/);
    expect(body).toMatch(/role: "completion"/);
    expect(body).toMatch(/loop_back:/);
    expect(body).toMatch(/after: "\{\{window\.afterUnix\}\}"/);
  });

  it('frontmatter allowlists match the runtime allowlist and are read-only', () => {
    const fm = loadSkill('skills/scan-slack.md').frontmatter;
    expect(fm.allowed_tools).toEqual(restrictedTools('slack').allowedTools);
    expect(loadSkill('skills/scan-org62.md').frontmatter.allowed_tools).toEqual(restrictedTools('org62').allowedTools);
    expect(() => assertReadOnly(fm.allowed_tools!)).not.toThrow();
    expect(() => assertReadOnly(['mcp__slack__slack_send_message'])).toThrow(/write-like/);
    expect(SLACK_SCAN_TOOLS).not.toContain('slack_mark_read');
  });

  it('_scanner-common carries the shared rules, confidence words and R-UI-22', () => {
    const c = loadSkill('skills/_scanner-common.md');
    expect(c.versionTag).toBe('scanner-common@1.3.0');
    for (const r of ['R1. Hard rules', 'R5. Linking procedure', 'R6. Redaction', 'R7. Commitment and ask patterns', 'R8. Confidence words', 'R9. Relink mode', 'R10. Coverage', 'R12. Briefs']) expect(c.body).toContain(r);
    expect(c.body).toMatch(/handed_off/);
  });

  it('every {{placeholder}} the skills use is provided by the Run block or the scope vars', async () => {
    const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
    const ctx = await store.getContext({ connector: 'slack', scope: 'inbox' });
    const run = renderRunBlock({ runId: 'r', mode: 'incremental', window: { from: '2026-11-05T00:00:00Z', to: '2026-11-05T01:00:00Z' }, ctx, vars: { 'channel.id': 'C', 'channel.kind': 'watched', 'channel.accountId': '', 'channel.label': 'x', 'thread.channelId': 'C', 'thread.ts': '1.1', 'org62.accountIds': "'001'", 'missed.productTokens': '', 'missed.nameTokens': '', ...org62PersonaVars(undefined) } });
    const provided = new Set([...run.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]));
    for (const f of ['skills/scan-slack.md', 'skills/scan-org62.md']) {
      const used = new Set([...fs.readFileSync(f, 'utf8').matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]));
      for (const u of used) expect(provided.has(u), `${f} uses {{${u}}}`).toBe(true);
    }
    expect(run).toContain('{{window.fromSoql}} = 2026-11-05T00:00:00Z');
    expect(renderContextPack(ctx)).not.toMatch(/\{\{/);
  });

  it('frontmatter parser handles inline and block lists', () => {
    const { data } = parseFrontmatter('---\nskill: x\nversion: 2\nlist: [a, "b:c"]\nblock:\n  - one\n  - two\n---\nbody');
    expect(data).toEqual({ skill: 'x', version: 2, list: ['a', 'b:c'], block: ['one', 'two'] });
  });
});

describe('fixtures and recorded shapes', () => {
  it('the parser reads the recorded Slack search shape (placeholders)', () => {
    const f = loadFixture<{ results: string }>('slack/search_to_me.detailed.v1.json');
    const hits = parseSlackSearch(f.results);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ channelId: 'D0DM00009', fromId: 'U0PERSONA', ts: '1793893334.322509', text: 'added you to the oppty', permalink: 'https://example.slack.com/archives/D0DM00009/p1793893334322509' });
    const t = parseSlackSearch(loadFixture<{ results: string }>('slack/search_thread_reply.detailed.v1.json').results);
    expect(t[0]!.threadTs).toBe('1793894585.289729');
  });

  it('fixtures and skills carry placeholders only (shape checks; optional private denylist outside the repo)', () => {
    const files = [...walk(FIXTURES), 'skills/scan-slack.md', 'skills/scan-org62.md', 'skills/_scanner-common.md'];
    // Placeholder shapes: Org62 ids carry "XX", Slack ids are U0ME/U0PERSON/D0DM/C0…, links and mail are example.*.
    const org62Id = /\b(00[0-9][A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?|a3y[A-Za-z0-9]{15})\b/g;
    const slackUser = /\bU0[A-Z0-9]{7,10}\b/g;
    const host = /https?:\\?\/\\?\/([a-z0-9.-]+)/gi;
    const email = /\b[\w.+-]+@([\w-]+\.[\w.]+)\b/g;
    // Optional: real names/ids to ban, kept OUT of the repo (never commit customer names, even as a denylist).
    const denyFile = process.env.CC_PRIVATE_DENYLIST ?? path.join(process.env.HOME ?? '', 'Library/Application Support/command-center/fixtures/denylist.txt');
    const deny = fs.existsSync(denyFile) ? fs.readFileSync(denyFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(org62Id)) expect(m[1]!.slice(3, 5), `${f}: ${m[1]} is not a placeholder id`).toBe('XX');
      for (const m of text.matchAll(slackUser)) expect(/^U0(ME|PERSON)/.test(m[0]), `${f}: ${m[0]}`).toBe(true);
      for (const m of text.matchAll(host)) expect(/(^|\.)(example\.(com|invalid)|example\.slack\.com|docs\.google\.com|drive\.google\.com|mail\.google\.com|meet\.google\.com|www\.google\.com|hooks\.slack\.com|trailhead\.salesforce\.com|readiness\.my\.site\.com)$/.test(m[1]!), `${f}: host ${m[1]}`).toBe(true);
      for (const m of text.matchAll(email)) expect(/(^|\.)example(\.(com|invalid|org))?$/.test(m[1]!), `${f}: email domain ${m[1]}`).toBe(true);
      for (const d of deny) expect(text.toLowerCase().includes(d.toLowerCase()), `${f} contains a denylisted term`).toBe(false);
    }
  });
});

describe('error classification (brief 09 signatures)', () => {
  it.each([
    ['mcp server slack status needs-auth', 'auth'],
    ['invalid_auth', 'auth'],
    ['INVALID_SESSION_ID: Session expired', 'auth'],
    ['Invalid API key · Fix external API key', 'auth'],
    ['ratelimited: retry after 30', 'rate_limited'],
    ['REQUEST_LIMIT_EXCEEDED', 'rate_limited'],
    ['fetch failed ECONNRESET', 'transient'],
    ['529 overloaded', 'transient'],
    ['MALFORMED_QUERY: unexpected token', 'config'],
    ['channel_not_found', 'config'],
    ['something odd', 'unknown'],
  ])('%s → %s', (msg, cls) => expect(classifyError(msg).errorClass).toBe(cls));

  it('auth probes carry the re-auth command; the gateway case says devbar (only with a gateway: CONN-6)', () => {
    expect(probeFromError('org62', 'INVALID_SESSION_ID', 'now')).toMatchObject({ state: 'auth_required', reauth: { command: 'claude mcp login Org62-Sobject-Read' } });
    process.env.CC_LLM_GATEWAY = '1';
    expect(probeFromError('slack', 'Invalid API key', 'now').reauth?.command).toBe('devbar auth login');
    process.env.CC_LLM_GATEWAY = '0';
    expect(probeFromError('slack', 'Invalid API key', 'now').reauth?.command).toBe('claude');
    delete process.env.CC_LLM_GATEWAY;
    expect(probeFromError('slack', 'ECONNRESET', 'now', 7).state).toBe('down');
  });

  it('org62 account ids come from the alias map (accountId or org62:<id> names)', async () => {
    const store = new InMemoryScannerStore({ profile: structuredClone(PROFILE) });
    const ctx = await store.getContext({ connector: 'org62', scope: 'opps' });
    expect(org62AccountIds(ctx)).toBe("'001XX0000000001AAA','001XX0000000002AAA'");
    // caps audit: every id, not the first 200
    const many = { ...ctx, aliases: { ...ctx.aliases, accounts: Array.from({ length: 250 }, (_, i) => ({ accountId: `001XX${String(i).padStart(10, '0')}AAA`, names: [] })) } };
    expect(org62AccountIds(many as never).split(',')).toHaveLength(250);
  });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
