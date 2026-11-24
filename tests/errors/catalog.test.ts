/** 11 R5: the error catalog: every code has user text and one next step; old codes resolve; one renderer. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATALOG, CATALOG_CODES, entryOf, isCatalogCode, REQUIRED_CODES } from '../../src/errors/catalog';
import { codeFromStatusReason, toCatalogCode } from '../../src/errors/aliases';
import { reasonOf, render, renderLine, renderToast } from '../../src/errors/render';
import { DELIVERY_CATALOG } from '../../src/outbox/errors';
import { API_CATALOG } from '../../src/server/errors';
import { STEP_LIMIT_CODE, stepLimitMessage } from '../../src/llm/chat/runner';

describe('catalog entries', () => {
  it('has every code the review named, each unique, with a class, user text, one next step and a docs anchor', () => {
    for (const c of REQUIRED_CODES) expect(CATALOG[c], c).toBeDefined();
    expect(new Set(CATALOG_CODES).size).toBe(CATALOG_CODES.length);
    for (const e of Object.values(CATALOG)) {
      expect(e.code).toMatch(/^(DEP|AUTH|NET|RATE|DATA|MCP|BUG|SEND|WORKER)\.[A-Z0-9_.]+$/);
      expect(['dependency', 'auth', 'network', 'rate', 'data', 'bug']).toContain(e.class);
      expect(['none', 'backoff', 'pause_source']).toContain(e.retry);
      expect(e.userTitle.length, e.code).toBeGreaterThan(3);
      expect(e.userText.length, e.code).toBeGreaterThan(10);
      expect(e.nextStep.length, e.code).toBeGreaterThan(5);
      expect(e.docsAnchor, e.code).toMatch(/^troubleshooting-/);
      if (e.action) expect(['reauth', 'run', 'open', 'link', 'report']).toContain(e.action.kind);
      // never an id or a token in the copy
      expect(`${e.userText} ${e.nextStep}`).not.toMatch(/\b[UWC][A-Z0-9]{8,}\b|Bearer |sk-/);
    }
  });

  it('every docs anchor is a README heading', () => {
    const readme = readFileSync(join(__dirname, '../../README.md'), 'utf8');
    const anchors = new Set(
      readme
        .split('\n')
        .filter((l) => /^#{2,4} /.test(l))
        .map((l) => l.replace(/^#+ /, '').toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-')),
    );
    for (const e of Object.values(CATALOG)) expect(anchors.has(e.docsAnchor), `${e.code} → #${e.docsAnchor}`).toBe(true);
  });

  it('every code the worker writes to Health is catalogued (a renderer that maps codes never reads it as BUG.UNKNOWN)', () => {
    const dir = join(__dirname, '../../src/worker');
    const emitted = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/'((?:DEP|AUTH|NET|RATE|DATA|MCP|BUG|SEND|WORKER)\.[A-Z0-9_.]+)'/g)) emitted.add(m[1]!);
    }
    for (const c of ['WORKER.SCAN_INTERRUPTED', 'WORKER.JOBS_INTERRUPTED', 'WORKER.DB_WAITED', 'DEP.DISK.LOW', 'DEP.DB.DOWN']) expect(emitted.has(c), c).toBe(true);
    for (const c of emitted) expect(isCatalogCode(c), c).toBe(true);
    // the crash chunk's rows are info, nothing to do, and say so in plain words
    for (const c of ['WORKER.SCAN_INTERRUPTED', 'WORKER.JOBS_INTERRUPTED', 'WORKER.DB_WAITED']) expect(entryOf(c)).toMatchObject({ severity: 'info', retry: 'none', nextStep: expect.stringMatching(/^Nothing to do\./) });
    expect(isCatalogCode('BUG.PROMPT_CUT')).toBe(true);
  });

  it('every bug code offers Report this', () => {
    for (const c of ['BUG.UNHANDLED', 'BUG.CHECK_CRASHED', 'BUG.WORKER_CRASH_LOOP', 'BUG.UNKNOWN', 'BUG.UNKNOWN_STOPPED', 'DATA.PARSE_DRIFT']) expect(entryOf(c).action?.kind, c).toBe('report');
  });

  it('P31-1: the Assistant step-stop has its own code, in the plain words the runner uses', () => {
    const e = entryOf(STEP_LIMIT_CODE);
    expect(e.code).toBe('RATE.CHAT.STEP_LIMIT');
    expect(e.class).toBe('rate');
    expect(e.nextStep).toContain('Say "continue" to go on');
    expect(stepLimitMessage(200)).toContain('Settings ▸ Budgets ▸ Assistant limits');
    expect(e.nextStep).toContain('Settings ▸ Budgets ▸ Assistant limits');
  });

  it('an unknown code renders as BUG.UNKNOWN but keeps its own code', () => {
    const r = render('SOMETHING.NEW');
    expect(r).toMatchObject({ known: false, code: 'SOMETHING.NEW', title: entryOf('BUG.UNKNOWN').userTitle });
    expect(renderLine('DEP.CLAUDE.MISSING')).toMatch(/^Claude Code isn't installed\. Install Claude Code/);
    expect(renderToast('DEP.DB.DOWN')).toMatchObject({ title: "The database isn't running", action: { kind: 'run', ref: 'launchctl kickstart -k gui/$UID/com.commandcenter.db' } });
  });
});

describe('aliases (stored app_events.code and status reasons keep reading)', () => {
  it('maps every old scanner signature code', () => {
    const old = ['maintenance', 'gateway_invalid_api_key', 'needs_auth', 'invalid_auth', 'http_401', 'sso_redirect', 'gateway_error', 'rate_limited', 'disallowed_tool', 'slack_scope', 'soql_invalid', 'model_not_found', 'executable_missing', 'skill_missing', 'network', 'overloaded', 'timeout', 'mcp_failed', 'mcp_disabled', 'unknown', 'parse_drift'];
    for (const c of old) expect(toCatalogCode(c, 'slack'), c).toMatch(/^[A-Z]+\./);
    expect(toCatalogCode('invalid_auth', 'org62')).toBe('AUTH.ORG62.EXPIRED');
    expect(toCatalogCode('needs_auth', 'slack')).toBe('AUTH.SLACK.SIGNED_OUT');
    expect(toCatalogCode('http_401', 'gmail')).toBe('AUTH.GOOGLE.EXPIRED');
    expect(toCatalogCode('rate_limited', 'org62')).toBe('RATE.ORG62.REQUEST_LIMIT');
    expect(toCatalogCode('executable_missing')).toBe('DEP.CLAUDE.MISSING');
  });

  it('maps the outbox, API and app_events vocabularies', () => {
    for (const [legacy, code] of Object.entries(DELIVERY_CATALOG)) expect(CATALOG[code], legacy).toBeDefined();
    for (const [legacy, code] of Object.entries(API_CATALOG)) expect(CATALOG[code], legacy).toBeDefined();
    for (const c of ['schema_mismatch', 'scan_run_failed', 'job_dead_lettered', 'budget_hard_cap', 'not_sent', 'conflict', 'internal']) expect(toCatalogCode(c), c).not.toBeNull();
    expect(toCatalogCode('BUG.WORKER_CRASH_LOOP')).toBe('BUG.WORKER_CRASH_LOOP');
    expect(toCatalogCode('not_a_code')).toBeNull();
  });

  it('reads a status line back to its code: the catalog phrase exactly, old phrases by pattern', () => {
    expect(codeFromStatusReason(`VDP plans: ${reasonOf('NET.VPN_REQUIRED')}`, 'vdp')).toBe('NET.VPN_REQUIRED');
    expect(codeFromStatusReason(`Slack inbox: ${reasonOf('MCP.SERVER_NOT_DECLARED')}`, 'slack')).toBe('MCP.SERVER_NOT_DECLARED');
    expect(codeFromStatusReason('Org62 events: needs re-auth', 'org62')).toBe('AUTH.ORG62.EXPIRED');
    expect(codeFromStatusReason('Inbox: temporarily unavailable, retrying', 'gmail')).toBe('NET.SERVICE_DOWN');
    expect(codeFromStatusReason("Inbox: devbar's MCP gateway is down for maintenance (not your sign-in), retrying", 'gmail')).toBe('NET.GATEWAY_DOWN');
    expect(codeFromStatusReason('Org62 events: a run hit its cost cap', 'org62')).toBeNull();
  });
});
