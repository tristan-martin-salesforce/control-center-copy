/**
 * Signal-driven cadence (FTI): activity tightens a scope below its base interval (to a floor), quiet runs relax it,
 * working hours still apply; the snapshot gives Health "next check in N min" and a restart its backoff back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CADENCE, intervalMs, nextQuietLevel, SIGNAL_CADENCE, type CadenceConfig } from '@/scanner/runtime/cadence';
import { cadenceSeedFrom, defaultCadenceFile, nextCheckBySource, readCadenceSnapshot, snapshotOf, writeCadenceSnapshot } from '@/scanner/runtime/cadence-state';
import { mockCadenceSnapshot, withNextChecks } from '@/server/datasource/db/scan-cadence';
import type { Connector } from '@/contract';

const MIN = 60_000;
const WORK = new Date('2026-11-04T17:00:00.000Z'); // Wed 10:00 in Denver
const NIGHT = new Date('2026-11-05T06:00:00.000Z'); // Wed 23:00 in Denver
const fti: CadenceConfig = { ...DEFAULT_CADENCE, ...SIGNAL_CADENCE };

describe('signal-driven intervals', () => {
  it('activity halves the Slack inbox poll (2 → 1 min), quiet runs double it to ×8 (16 min)', () => {
    expect(intervalMs(fti, 'slack', 'inbox', WORK, -1)).toBe(1 * MIN);
    expect(intervalMs(fti, 'slack', 'inbox', WORK, 0)).toBe(2 * MIN);
    expect(intervalMs(fti, 'slack', 'inbox', WORK, 3)).toBe(16 * MIN);
    expect(intervalMs(fti, 'slack', 'inbox', WORK, 9)).toBe(16 * MIN); // capped at maxQuietLevel
    expect(intervalMs(fti, 'slack', 'channel:C1', WORK, -1)).toBe(5 * MIN); // channels ×5
  });
  it('never polls faster than the floor, and off hours still slow it down', () => {
    expect(intervalMs({ ...fti, baseMs: { ...fti.baseMs, slack: 90_000 } }, 'slack', 'inbox', WORK, -1)).toBe(MIN);
    expect(intervalMs(fti, 'slack', 'inbox', NIGHT, -1)).toBe(6 * MIN); // ×6 off hours, then halved
    expect(intervalMs(fti, 'gmail', 'inbox', NIGHT, 3)).toBe(3 * 6 * 8 * MIN); // 3 min ×6 off hours ×8 quiet
    expect(intervalMs(fti, 'drive', 'tracked', NIGHT, 3)).toBe(4 * 60 * MIN); // 10 min ×48 is past the 4 h slowdown cap
  });
  it('without an active level (agentic mode) activity resets to the base interval, as before', () => {
    expect(nextQuietLevel(DEFAULT_CADENCE, 3, true)).toBe(0);
    expect(nextQuietLevel(fti, 3, true)).toBe(-1);
    expect(nextQuietLevel(fti, -1, false)).toBe(0);
    expect(nextQuietLevel(fti, 3, false)).toBe(3);
    expect(intervalMs(DEFAULT_CADENCE, 'slack', 'inbox', WORK, -1)).toBe(2 * MIN); // a stray negative level is ignored
  });
});

describe('the cadence snapshot', () => {
  const status = [
    { connector: 'slack' as const, scope: 'inbox', nextDueAt: '2026-11-04T17:04:00.000Z', quietLevel: 1, failures: 0, catchingUp: false, intervalMs: 4 * MIN },
    { connector: 'slack' as const, scope: 'channel:C1', nextDueAt: '2026-11-04T17:02:00.000Z', quietLevel: 0, failures: 0, catchingUp: false },
    { connector: 'org62' as const, scope: 'opps', nextDueAt: '2026-11-04T17:30:00.000Z', quietLevel: 2, failures: 0, catchingUp: false, paused: 'auth' },
    { connector: 'slack' as const, scope: 'thread:C1:1.0', nextDueAt: '2026-11-04T17:00:00.000Z', quietLevel: 0, failures: 0, catchingUp: false },
  ];
  it('says per source when it is checked next (its earliest unpaused scope), in whole minutes', () => {
    const snap = snapshotOf(status, WORK);
    expect(snap.scopes.map((s) => s.scope)).toEqual(['opps', 'channel:C1', 'inbox']); // ad-hoc thread scopes are not polled
    expect(nextCheckBySource(snap, WORK)).toEqual({ org62: { nextCheckAt: null, inMinutes: null, scope: null }, slack: { nextCheckAt: '2026-11-04T17:02:00.000Z', inMinutes: 2, scope: 'channel:C1' } });
  });
  it('round-trips through the state file and seeds a restart’s backoff (not a stale one)', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cadence-')), 'scan-cadence.json');
    writeCadenceSnapshot(snapshotOf(status, WORK), file);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const back = readCadenceSnapshot(file);
    expect(cadenceSeedFrom(back, new Date(WORK.getTime() + 60 * MIN))('slack:inbox')).toBe(1);
    expect(cadenceSeedFrom(back, new Date(WORK.getTime() + 7 * 60 * MIN))('slack:inbox')).toBeUndefined();
    expect(readCadenceSnapshot(path.join(path.dirname(file), 'missing.json'))).toBeNull();
  });
  it('tests never touch the real state folder', () => {
    expect(defaultCadenceFile({ VITEST: 'true' })).toBeNull();
    expect(defaultCadenceFile({ VITEST: 'true', CC_STATE_DIR: '/tmp/x' })).toBe('/tmp/x/scan-cadence.json');
  });
});

describe('Health data (db and mock parity)', () => {
  const conn = (id: string, o: Partial<Connector> = {}) => ({ id, label: id, source: id, state: 'ok', since: WORK.toISOString(), lastSuccessAt: '2026-11-04T16:59:00.000Z', cursor: { label: '', at: null }, backlog: 0, itemsToday: 0, catchUpPct: null, lastError: null, impact: null, reauth: null, affects: [], ...o }) as Connector;
  it('joins the next check onto each connector; nothing planned stays null', () => {
    const snap = snapshotOf([{ connector: 'slack', scope: 'inbox', nextDueAt: '2026-11-04T17:04:00.000Z', quietLevel: 0, failures: 0, catchingUp: false }], WORK);
    const out = withNextChecks([conn('slack'), conn('gmail')], snap, WORK);
    expect(out.map((c) => [c.id, c.nextCheckInMin])).toEqual([['slack', 4], ['gmail', null]]);
  });
  it('the mock gives each healthy source one base interval after its last success', () => {
    const out = withNextChecks([conn('slack'), conn('gmail', { lastSuccessAt: '2026-11-04T10:00:00.000Z' }), conn('org62', { state: 'auth_needed' })], mockCadenceSnapshot([conn('slack'), conn('gmail', { lastSuccessAt: '2026-11-04T10:00:00.000Z' }), conn('org62', { state: 'auth_needed' })], WORK), WORK);
    // slack: 16:59 + 2 min; gmail: 7 h after its last success is a whole number of 3-minute steps, so it is due now
    expect(out.map((c) => c.nextCheckInMin)).toEqual([1, 0, null]);
  });
});
