/**
 * Health ▸ Setup on the client: each dependency state → its chip, text and buttons; the badge selector; codes from
 * connectors and API errors; the app-down view; the update banner. Every string comes from the catalog renderer.
 */
import { describe, expect, it } from 'vitest';
import type { DependencyState, SetupDependency } from '@/contract';
import { VersionPayload } from '@/contract';
import { allCodes, render } from '@/errors/render';
import { SMOKE_ESTIMATE_USD as SERVER_SMOKE } from '@/ops/smoke';
import {
  appDownView,
  checkedAgo,
  connectorCode,
  connectorForDependency,
  connectorProblem,
  dependencyIdForCode,
  dependencyIdForSource,
  depIdFromHash,
  errorCode,
  problemOf,
  problemToast,
  selectSetupNeedsYou,
  setupBadgeCount,
  setupHref,
  setupRowView,
  setupSummary,
  SMOKE_ESTIMATE_USD,
  sortSetup,
  STATE_CHIP,
  updateBanner,
} from './health-setup';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const dep = (id: string, state: DependencyState, extra: Partial<SetupDependency> = {}): SetupDependency => ({ id, label: id, why: `Why ${id}.`, state, lastChecked: '2026-11-20T11:58:00Z', ...extra });
const withCode = (id: string, state: DependencyState, code: string) => {
  const r = render(code);
  return dep(id, state, { code, nextStep: r.nextStep, ...(r.action ? { action: r.action } : {}) });
};

describe('setupRowView: state → text and buttons', () => {
  it('ok: Ready, no problem, no buttons', () => {
    const v = setupRowView(dep('database', 'ok'), NOW);
    expect(v).toMatchObject({ chip: { label: 'Ready', tone: 'ok' }, needsYou: false, problem: null, nextStep: null, buttons: [], code: null, checked: 'checked 2 min ago' });
  });

  it('signed_out with a reauth action: the catalog title/text/next step, the re-auth button, then Check again', () => {
    const v = setupRowView(withCode('slack-mcp', 'signed_out', 'AUTH.SLACK.SIGNED_OUT'), NOW);
    const r = render('AUTH.SLACK.SIGNED_OUT');
    expect(v.chip).toEqual({ label: 'Signed out', tone: 'danger' });
    expect(v.needsYou).toBe(true);
    expect(v.problem).toEqual({ title: r.title, text: r.text });
    expect(v.nextStep).toBe(r.nextStep);
    expect(v.buttons.map((b) => b.kind)).toEqual(['reauth', 'check']);
    expect(v.buttons[0]).toMatchObject({ kind: 'reauth', ref: 'slack' });
    expect(v.code).toBe('AUTH.SLACK.SIGNED_OUT');
  });

  it('missing with a run action: the command goes in the copy box, the only button is Check again', () => {
    const v = setupRowView(withCode('worker', 'missing', 'DEP.WORKER.DOWN'), NOW);
    expect(v.chip.label).toBe('Not installed');
    expect(v.command).toBe(render('DEP.WORKER.DOWN').action!.ref);
    expect(v.buttons.map((b) => b.kind)).toEqual(['check']);
  });

  it('missing with a link action, expired with a report action, installed (amber)', () => {
    expect(setupRowView(withCode('devbar', 'missing', 'DEP.DEVBAR.MISSING'), NOW).buttons.map((b) => b.kind)).toEqual(['link', 'check']);
    const expired = setupRowView(withCode('claude-cli', 'expired', 'BUG.WORKER_CRASH_LOOP'), NOW);
    expect(expired.chip).toEqual({ label: 'Expired', tone: 'danger' });
    expect(expired.buttons.map((b) => b.kind)).toEqual(['report', 'check']);
    expect(setupRowView(withCode('vdp-access', 'installed', 'DEP.PYTHON.NO_PLAYWRIGHT'), NOW).chip).toEqual({ label: 'Needs setup', tone: 'warning' });
  });

  it('unknown and offline never read as broken: no red, not counted, "can\'t tell right now; retrying"', () => {
    const u = setupRowView(dep('slack-mcp', 'unknown', { lastChecked: null }), NOW);
    expect(u.chip.tone).toBe('neutral');
    expect(u.needsYou).toBe(false);
    expect(u.problem!.text).toBe("Can't tell right now; retrying.");
    expect(u.checked).toBe('not checked yet');
    expect(u.buttons.map((b) => b.kind)).toEqual(['check']);
    const o = setupRowView(withCode('org62-mcp', 'offline', 'NET.VPN_REQUIRED'), NOW);
    expect(o.chip).toEqual({ label: 'Offline', tone: 'neutral' });
    expect(o.needsYou).toBe(false);
    expect(o.problem!.title).toBe(render('NET.VPN_REQUIRED').title);
    const plain = setupRowView(dep('org62-mcp', 'offline'), NOW);
    expect(plain.problem!.text).toContain("retries by itself");
  });

  it('the Claude sign-in row tests Claude with its price on the button, never automatically', () => {
    const v = setupRowView(dep('claude-signin', 'unknown', { nextStep: 'Click Check again to test Claude (about $0.001).', lastChecked: null }), NOW);
    expect(v.buttons).toEqual([{ kind: 'smoke', label: 'Test Claude (about $0.001)', ref: 'claude-smoke' }]);
    expect(v.nextStep).toContain('$0.001');
    expect(SMOKE_ESTIMATE_USD).toBe(SERVER_SMOKE);
  });

  it('every state has a chip', () => {
    for (const s of ['missing', 'installed', 'signed_out', 'expired', 'ok', 'offline', 'unknown'] as const) expect(STATE_CHIP[s].label).toBeTruthy();
  });

  it('walks the catalog: every code renders on a row without throwing, and no code text leaks into the words', () => {
    for (const code of allCodes()) {
      for (const state of ['missing', 'signed_out', 'offline'] as const) {
        const v = setupRowView(withCode('x', state, code), NOW);
        const words = [v.problem?.title, v.problem?.text, v.nextStep].join(' ');
        expect(words, code).not.toContain(code);
        expect(v.code, code).toBe(code);
      }
    }
  });
});

describe('the badge selector and the summary', () => {
  const setup = { dependencies: [dep('a', 'ok'), dep('b', 'signed_out'), dep('c', 'unknown'), dep('d', 'missing'), dep('e', 'offline')] };
  it('counts only what needs the user (unknown and offline are the app\'s to retry)', () => {
    expect(selectSetupNeedsYou({ setup }).map((d) => d.id)).toEqual(['b', 'd']);
    expect(setupBadgeCount({ setup })).toBe(2);
    expect(setupBadgeCount({})).toBe(0);
    expect(setupBadgeCount(undefined)).toBe(0);
  });
  it('summarises and sorts needs-you first', () => {
    expect(setupSummary(setup.dependencies)).toMatchObject({ needs: 2, unsure: 2, ok: 1, line: "2 need you · 2 can't tell yet" });
    expect(setupSummary([dep('a', 'ok')]).line).toBe('All set');
    expect(sortSetup(setup.dependencies).map((d) => d.id)).toEqual(['b', 'd', 'c', 'e', 'a']);
  });
  it('checked N ago', () => {
    expect(checkedAgo('2026-11-20T11:59:40Z', NOW)).toBe('checked just now');
    expect(checkedAgo('2026-11-20T09:00:00Z', NOW)).toBe('checked 3 h ago');
    expect(checkedAgo('2026-11-18T12:00:00Z', NOW)).toBe('checked 2 days ago');
  });
});

describe('one surface: anchors and codes', () => {
  it('maps sources and codes to their Setup row', () => {
    expect(setupHref('slack-mcp')).toBe('/health?tab=setup#setup-slack-mcp');
    expect(depIdFromHash('#setup-slack-mcp')).toBe('slack-mcp');
    expect(depIdFromHash('#other')).toBeNull();
    expect(dependencyIdForSource('gmail')).toBe('devbar');
    expect(dependencyIdForSource('vdp')).toBe('vdp-access');
    expect(dependencyIdForCode('AUTH.SLACK.EXPIRED')).toBe('slack-mcp');
    expect(dependencyIdForCode('RATE.ORG62.REQUEST_LIMIT')).toBe('org62-mcp');
    expect(dependencyIdForCode('DEP.DEVBAR.MISSING')).toBe('devbar');
    expect(dependencyIdForCode('DEP.DB.DOWN')).toBe('database');
    expect(dependencyIdForCode('SEND.TOO_LONG')).toBeNull();
  });

  it('a connector\'s problem is a catalog code, never its raw message', () => {
    const base = { source: 'slack', label: 'Slack', impact: null } as const;
    expect(connectorCode({ ...base, state: 'ok', lastError: null })).toBeNull();
    expect(connectorCode({ ...base, state: 'auth_needed', lastError: null })).toBe('AUTH.SLACK.SIGNED_OUT');
    expect(connectorCode({ ...base, source: 'gmail', state: 'auth_needed', lastError: { class: 'auth', message: 'invalid_grant: token expired', at: '2026-11-20T10:00:00Z', count: 1 } })).toBe('AUTH.GOOGLE.EXPIRED');
    expect(connectorCode({ ...base, source: 'org62', state: 'degraded', lastError: { class: 'rate_limited', message: 'REQUEST_LIMIT_EXCEEDED', at: '2026-11-20T10:00:00Z', count: 1 } })).toBe('RATE.ORG62.REQUEST_LIMIT');
    expect(connectorCode({ ...base, state: 'offline', lastError: null })).toBe('NET.OFFLINE');
    const p = connectorProblem({ ...base, state: 'error', lastError: { class: 'bug', message: 'TypeError: x is undefined', at: '2026-11-20T10:00:00Z', count: 1 } });
    expect(JSON.stringify(p)).not.toContain('TypeError');
  });

  it('the Setup row\'s code wins when it needs the user (one diagnosis)', () => {
    const p = connectorProblem({ source: 'slack', label: 'Slack', impact: null, state: 'auth_needed', lastError: null }, [withCode('slack-mcp', 'expired', 'AUTH.SLACK.EXPIRED')]);
    expect(p).toMatchObject({ code: 'AUTH.SLACK.EXPIRED', depId: 'slack-mcp', href: '/health?tab=setup#setup-slack-mcp' });
  });

  it('API errors and toasts in the catalog\'s words, with How to fix', () => {
    expect(errorCode({ code: 'upstream_unavailable', details: { code: 'DEP.DB.DOWN' } })).toBe('DEP.DB.DOWN');
    expect(errorCode({ code: 'upstream_unavailable' })).toBe('NET.SERVICE_DOWN');
    expect(errorCode(new Error('boom'))).toBe('BUG.UNKNOWN');
    const t = problemToast({ code: 'upstream_unavailable', message: 'ECONNREFUSED 127.0.0.1:5432', details: { code: 'DEP.DB.DOWN' } }, { key: 'k', title: 'Couldn’t rescan Slack' });
    expect(t.title).toBe(`Couldn’t rescan Slack: ${render('DEP.DB.DOWN').title}`);
    expect(t.body).toBe(render('DEP.DB.DOWN').nextStep);
    expect(t.action).toEqual({ label: 'How to fix', href: '/health?tab=setup#setup-database' });
    expect(JSON.stringify(t)).not.toContain('ECONNREFUSED');
    expect(problemOf('SEND.TOO_LONG').href).toBeNull();
  });

  it('finds the connector a dependency re-auths on (by source; uuids in db mode)', () => {
    const cs = [
      { id: 'u1', source: 'calendar', state: 'ok' },
      { id: 'u2', source: 'gmail', state: 'ok' },
      { id: 'u3', source: 'drive', state: 'auth_needed' },
      { id: 'u4', source: 'slack', state: 'ok' },
    ] as const;
    expect(connectorForDependency('devbar', cs)?.id).toBe('u3');
    expect(connectorForDependency('slack-mcp', cs)?.id).toBe('u4');
    expect(connectorForDependency('vdp-access', cs)).toBeNull();
  });
});

describe('app down and the update banner', () => {
  it('names the database first, then a stale worker heartbeat; else null', () => {
    const db = { code: 'DEP.DB.DOWN', title: 't', text: 'x', nextStep: 'n', command: 'brew services start postgresql@17' };
    expect(appDownView({ database: db, checks: [] })).toBe(db);
    const w = appDownView({ database: null, checks: [{ id: 'heartbeat', status: 'fail', code: 'DEP.WORKER.DOWN' }] });
    expect(w).toMatchObject({ code: 'DEP.WORKER.DOWN', title: render('DEP.WORKER.DOWN').title, command: render('DEP.WORKER.DOWN').action!.ref });
    expect(appDownView({ database: null, checks: [{ id: 'heartbeat', status: 'ok' }] })).toBeNull();
    expect(appDownView(null)).toBeNull();
  });

  it('shows only when version.update names a newer version; the prompt is exact', () => {
    expect(updateBanner({ version: '1.3.0' })).toBeNull();
    expect(updateBanner({ version: '2.0.1', update: { available: true, version: '2.0.1', channel: 'stable' } })).toBeNull();
    const b = updateBanner({ version: '2.0.0', update: { available: true, version: '2.0.1', channel: 'stable', notes: ' Fixes. ' } })!;
    expect(b.text).toBe('Command Center 2.0.1 is available');
    expect(b.prompt).toContain('npm run update');
    expect(b.notes).toBe('Fixes.');
  });

  it('a source checkout (no release) asks for npm run update in the folder', () => {
    const b = updateBanner({ version: '2.0.0', update: { available: true, version: '2.0.1', channel: 'stable', prompt: 'ignored for a checkout' } })!;
    expect(b.source).toBe('checkout');
    expect(b.how).toMatch(/Source checkout/);
    expect(b.prompt).toBe('Update Command Center to 2.0.1: in the Command Center folder run npm run update, and tell me what it printed.');
  });

  it('an installed copy (release present) copies the server prompt: Drive download, then update -- --from the build', () => {
    const serverPrompt =
      'Update Command Center to v2.0.1: from the Command Center Drive folder download command-center-2.0.1-arm64.tgz and manifest.json into ~/Downloads/command-center-2.0.1/, check the sha256 ... then run npm --prefix "$HOME/Library/Application Support/<state folder>/releases/current" run update -- --from ~/Downloads/command-center-2.0.1/command-center-2.0.1-arm64.tgz and show me its output. Do not change anything else.';
    const release = { version: '2.0.0', channel: 'stable', arch: 'arm64', builtAt: null };
    const b = updateBanner({ version: '2.0.0', update: { available: true, version: '2.0.1', channel: 'stable', prompt: serverPrompt }, release })!;
    expect(b.source).toBe('installed');
    expect(b.how).toMatch(/Installed copy/);
    expect(b.prompt).toBe(serverPrompt);
    expect(b.prompt).not.toContain('in the Command Center folder run npm run update');
    // a reply without `prompt` still never sends an installed copy to a plain npm run update
    const f = updateBanner({ version: '2.0.0', update: { available: true, version: '2.0.1', channel: 'stable' }, release })!;
    expect(f.source).toBe('installed');
    expect(f.prompt).toContain('update -- --from');
    expect(f.prompt).not.toMatch(/folder run npm run update/);
  });

  it('VersionPayload.update is additive: absent, null and present all parse', () => {
    const base = { version: '1.3.0', sha: null, builtAt: null, dirty: 0, channel: 'dev', migration: null, bundledMigration: null, persona: { id: 'se', level: 'ic', label: 'SE' }, workerVersion: null, mismatch: false, migrationPending: false, dataSource: 'mock' };
    expect(VersionPayload.safeParse(base).success).toBe(true);
    expect(VersionPayload.safeParse({ ...base, update: null }).success).toBe(true);
    expect(VersionPayload.parse({ ...base, update: { available: true, version: '2.0.1', channel: 'stable', publishedAt: null } }).update).toMatchObject({ available: true, version: '2.0.1', channel: 'stable' });
    expect(VersionPayload.safeParse({ ...base, update: { available: '2.0.1' } }).success).toBe(false);
  });
});
