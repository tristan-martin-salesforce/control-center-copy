/**
 * 11 R7: one state machine per dependency (missing → installed → signed_out → expired → ok, offline, unknown) on the
 * re-auth handlers, additively (the old `state` still reads), and CONN-5: devbar missing is not "daemon down", and
 * Restart reports failure when the program is absent (spawnDetached waits for spawn/error).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecFn, ExecResult } from '../../src/ops/exec';
import { devbarHandler, slackHandler, vdpHandler } from '../../src/reauth/handlers';
import { spawnDetached } from '../../src/reauth/terminal';
import { legacyState, setupStateOf, type ReauthDeps } from '../../src/reauth/types';
import { diagnoseDevbar, probeFromDiagnosis } from '../../src/connectors/google/client';

let dir: string;
const NOW = 1_800_000_000_000;
const res = (o: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });
const deps = (over: Partial<ReauthDeps> = {}): ReauthDeps => ({ exec: async () => res(), openTerminal: vi.fn(async () => ({ ok: true })), spawnDetached: vi.fn(async () => ({ ok: true })), now: () => NOW, home: dir, claudeJson: join(dir, 'claude.json'), exists: () => true, ...over });

beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-setup-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the state machine', () => {
  it('maps old auth_needed to signed_out / expired, and back', () => {
    expect(setupStateOf({ state: 'auth_needed' })).toBe('signed_out');
    expect(setupStateOf({ state: 'auth_needed', code: 'AUTH.VDP.COOKIE_EXPIRED' })).toBe('expired');
    expect(setupStateOf({ state: 'offline', setupState: 'missing' })).toBe('missing');
    expect(legacyState('expired')).toBe('auth_needed');
    expect(legacyState('unknown')).toBe('unknown');
    expect(legacyState('ok')).toBe('ok');
  });
});

describe('devbar (CONN-5)', () => {
  const enoent: ExecFn = async () => res({ code: null, spawnError: 'ENOENT' });

  it('not installed is `missing` with DEP.DEVBAR.MISSING and says what devbar is (onboarding still reads "not installed")', async () => {
    const s = await devbarHandler(deps({ exec: enoent })).status();
    expect(s).toMatchObject({ state: 'offline', setupState: 'missing', code: 'DEP.DEVBAR.MISSING' });
    expect(s.message).toMatch(/not installed/);
    expect(s.message).toMatch(/Google/);
  });

  it('installed with its gateway down is `installed` + DEP.DEVBAR.DAEMON_DOWN; signed out and connector missing are signed_out', async () => {
    const exec = (auth: object, gw: object): ExecFn => async (_c, args) => res({ stdout: JSON.stringify(args[0] === 'auth' ? auth : gw) });
    expect(await devbarHandler(deps({ exec: exec({ authenticated: true }, { listener_ok: false }) })).status()).toMatchObject({ setupState: 'installed', code: 'DEP.DEVBAR.DAEMON_DOWN' });
    expect(await devbarHandler(deps({ exec: exec({ authenticated: false }, {}) })).status()).toMatchObject({ setupState: 'signed_out', code: 'AUTH.GOOGLE.DEVBAR_SIGNED_OUT' });
    expect(await devbarHandler(deps({ exec: exec({ authenticated: true }, { listener_ok: true, upstream_ok: false }) })).status()).toMatchObject({ setupState: 'signed_out', code: 'AUTH.GOOGLE.CONNECTOR_MISSING' });
    expect(await devbarHandler(deps({ exec: exec({ authenticated: true }, { listener_ok: true, upstream_ok: true }) })).status()).toMatchObject({ state: 'ok', setupState: 'ok' });
  });

  it('Restart devbar with no devbar installed reports that, never "started"', async () => {
    const r = await devbarHandler(deps({ spawnDetached: async () => ({ ok: false, error: 'ENOENT' }) }), 'devbar_restart').act({ confirm: true });
    expect(r.status).toBe('unavailable');
    expect(r.message).toMatch(/not installed/);
    expect(r.message).not.toMatch(/started/);
  });

  it('spawnDetached waits for spawn or error: a missing program resolves ok:false ENOENT', async () => {
    expect(await spawnDetached('/nonexistent/cc-test-no-such-binary', [])).toEqual({ ok: false, error: 'ENOENT' });
  });

  it('the Google probe separates "not installed" from "daemon not listening"', async () => {
    const missing = await diagnoseDevbar(async () => {
      throw Object.assign(new Error('spawn devbar ENOENT'), { code: 'ENOENT' });
    });
    expect(missing.installed).toBe(false);
    const p = probeFromDiagnosis(missing, new Date(NOW));
    expect(p.detail).toBe("devbar isn't installed (Google needs it)");
    expect(p.reauth?.command).toBeUndefined();
    expect(probeFromDiagnosis({ installed: true, daemonUp: false, devbarAuthenticated: null, connectorState: null }, new Date(NOW))).toMatchObject({ state: 'down', reauth: { command: 'devbar daemon start' } });
  });
});

describe('Slack / Org62 (CONN-8)', () => {
  it('a server not declared is `missing` with MCP.SERVER_NOT_DECLARED, and Re-auth offers claude mcp add, not login', async () => {
    const list = res({ stdout: 'Org62-Sobject-Read: https://x (HTTP) - ✔ Connected\n' });
    const s = await slackHandler(deps({ exec: async () => list })).status();
    expect(s).toMatchObject({ state: 'auth_needed', setupState: 'missing', code: 'MCP.SERVER_NOT_DECLARED' });
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ mcpServers: { 'Org62-Sobject-Read': { type: 'http', url: 'https://x' } } }));
    const d = deps();
    const r = await slackHandler(d).act({ confirm: true });
    expect(r.status).toBe('unavailable');
    expect(r.command).toMatch(/^claude mcp add --transport http slack /);
    expect(d.openTerminal).not.toHaveBeenCalled();
  });

  it('Claude Code itself missing is DEP.CLAUDE.MISSING, not "could not list"', async () => {
    const s = await slackHandler(deps({ exec: async () => res({ code: null, spawnError: 'ENOENT' }) })).status();
    expect(s).toMatchObject({ setupState: 'missing', code: 'DEP.CLAUDE.MISSING' });
  });
});

describe('VDP', () => {
  it('no entry and no PAT are `missing`; an expired cookie is `expired`', async () => {
    expect(await vdpHandler(deps()).status()).toMatchObject({ setupState: 'missing', code: 'AUTH.VDP.NOT_CONFIGURED' });
    const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ mcpServers: { 'vdp-app-fir': { headers: { Authorization: 'Bearer placeholder-pat-0000', Cookie: `central_proxy_session=${jwt(NOW / 1000 - 60)}` } } } }));
    expect(await vdpHandler(deps()).status()).toMatchObject({ state: 'auth_needed', setupState: 'expired', code: 'AUTH.VDP.COOKIE_EXPIRED' });
  });
});
