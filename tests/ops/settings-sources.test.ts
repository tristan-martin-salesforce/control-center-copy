/**
 * W0-1: a Slack/Org62 sign-in failure that follows the scanners' settingSources change (`[]`) reads as
 * DEP.CLAUDE.SETTINGS_SOURCES (next step: CC_SCANNER_SETTING_SOURCES=user, Report this), on the classifier path:
 * classify() → the recorded outcome → the suspect rule → the doctor check.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { entryOf } from '../../src/errors/catalog';
import { classify } from '../../src/errors/classify';
import { checkSettingsSources } from '../../src/ops/checks/settings-sources';
import type { DoctorContext } from '../../src/ops/checks/types';
import { emptyState, noteScanOutcome, readScannerAuth, settingsSourcesSuspect, withOutcome } from '../../src/ops/scanner-auth';

const T = Date.parse('2026-11-20T10:00:00Z');
const H = 3600_000;
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-w01-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('settings-sources suspect', () => {
  it('an auth failure under [] within 24 h of a success under [user] is the suspect', () => {
    const code = classify('slack', 'mcp server slack status needs-auth').code;
    expect(code).toBe('AUTH.SLACK.SIGNED_OUT');
    let s = withOutcome(emptyState(), { connector: 'slack', ok: true, sources: 'user', at: T - 2 * H });
    s = withOutcome(s, { connector: 'slack', ok: false, code, sources: '', at: T });
    expect(settingsSourcesSuspect(s, { CC_SCANNER_SETTING_SOURCES: 'project' })).toMatchObject({ connector: 'slack', why: 'after_user_success', code: 'AUTH.SLACK.SIGNED_OUT' });
    // more than a day apart: not this cause (with the switch set, so the first-run rule doesn't apply either)
    const old = withOutcome(withOutcome(emptyState(), { connector: 'slack', ok: true, sources: 'user', at: T - 30 * H }), { connector: 'slack', ok: false, code, sources: '', at: T });
    expect(settingsSourcesSuspect(old, { CC_SCANNER_SETTING_SOURCES: 'project' })).toBeNull();
  });

  it('the very first run under [] failing sign-in is the suspect while CC_SCANNER_SETTING_SOURCES is unset', () => {
    const code = classify('org62', 'INVALID_SESSION_ID: Session expired or invalid').code;
    const s = withOutcome(emptyState(), { connector: 'org62', ok: false, code, sources: '', at: T });
    expect(settingsSourcesSuspect(s, {})).toMatchObject({ connector: 'org62', why: 'first_run_under_none' });
    expect(settingsSourcesSuspect(s, { CC_SCANNER_SETTING_SOURCES: 'user' })).toBeNull();
    // it worked under [] before: an ordinary sign-in problem
    const worked = withOutcome(withOutcome(emptyState(), { connector: 'org62', ok: true, sources: '', at: T - H }), { connector: 'org62', ok: false, code, sources: '', at: T });
    expect(settingsSourcesSuspect(worked, {})).toBeNull();
  });

  it('a later success clears it; a server not declared counts; other failures and sources are ignored', () => {
    const s = withOutcome(emptyState(), { connector: 'slack', ok: false, code: 'MCP.SERVER_NOT_DECLARED', sources: '', at: T });
    expect(settingsSourcesSuspect(s, {})).not.toBeNull();
    expect(settingsSourcesSuspect(withOutcome(s, { connector: 'slack', ok: true, sources: '', at: T + 1 }), {})).toBeNull();
    expect(withOutcome(emptyState(), { connector: 'slack', ok: false, code: 'NET.GATEWAY_DOWN', sources: '', at: T })).toEqual(emptyState());
    expect(withOutcome(emptyState(), { connector: 'gmail', ok: false, code: 'AUTH.GOOGLE.EXPIRED', sources: '', at: T })).toEqual(emptyState());
  });

  it('noteScanOutcome keeps the record in the state folder; the doctor check names the switch with a Report this', async () => {
    const env = { CC_STATE_DIR: dir, HOME: dir };
    noteScanOutcome({ connector: 'slack', ok: false, code: 'AUTH.SLACK.EXPIRED' }, { env, now: T });
    expect(readScannerAuth(join(dir, 'scanner-auth.json')).byConnector.slack?.lastAuthFail).toMatchObject({ code: 'AUTH.SLACK.EXPIRED', sources: '' });
    const r = await checkSettingsSources({ env } as unknown as DoctorContext);
    expect(r).toMatchObject({ status: 'warn', code: 'DEP.CLAUDE.SETTINGS_SOURCES' });
    expect(r.fix).toMatch(/CC_SCANNER_SETTING_SOURCES=user/);
    const e = entryOf('DEP.CLAUDE.SETTINGS_SOURCES');
    expect(e.nextStep).toMatch(/CC_SCANNER_SETTING_SOURCES=user/);
    expect(e.action?.kind).toBe('report');
    noteScanOutcome({ connector: 'slack', ok: true }, { env, now: T + 60_000 });
    expect((await checkSettingsSources({ env } as unknown as DoctorContext)).status).toBe('ok');
  });
});
