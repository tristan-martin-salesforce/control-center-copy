/**
 * A Time row on an opp I'm not on the team of (and hold no DC on) waits for the user: the scan holds it (needs_input,
 * Time ▸ Needs you "Check and approve"), and no logging batch, chat staging or hands-off approval takes it. The user's
 * own Approve still logs it. Pure engine parts and the mock DataSource's batch (the db's buildLogBatch has the same
 * check). Placeholders only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { routes, Seed, type RouteKey, type RouteOutput } from '@/contract';
import { autoApprove, finalizeStatus } from '@/engines/activity/propose';
import { classifyMeeting, heldNotOnTeam, NOT_ON_TEAM_FLAG, NOT_ON_TEAM_SKIP } from '@/engines/activity/classify';
import { newEntry } from '@/engines/activity/entry';
import type { ActivityMappings } from '@/engines/activity/types';
import { MockDataSource } from '@/server/datasource/mock';

const NOW = '2026-11-06T18:00:00.000Z';
const RENEWAL = '006XX0000000099AAA';
const past = (p: Parameters<typeof newEntry>[0] extends infer T ? Partial<T> : never = {}) =>
  newEntry({ dedupeKey: 'cal|primary|e1|2026-11-02T17:00:00.000Z', origin: 'calendar', subject: 'FY27 CUSTOMER_1 Account Team Call', startsAt: '2026-11-02T17:00:00.000Z', endsAt: '2026-11-02T18:00:00.000Z', durationHours: 1, seTaskType: 'Account Planning', whatKind: 'opportunity', whatOrg62Id: RENEWAL, ...p });

describe('the engine: flagged rows wait for the user', () => {
  it('classify flags an opp I am not on; the flag is the one marker every check reads', () => {
    const m: ActivityMappings = {
      accounts: [{ key: 'a-c1', match: '(?<![a-z0-9])customer[\\s\\-_.&/]*1(?![a-z0-9])', domains: [], whatId: RENEWAL, whatType: 'Opportunity', whatName: 'CUSTOMER_1 Renewal', team: false }],
      repos: {},
      channels: {},
      neitherRepos: {},
      internalDomains: ['corp.example'],
      partnerDomains: [],
      ignoreDomains: [],
      overrides: [],
    };
    const d = classifyMeeting({ id: 'c|e1', summary: 'FY27 CUSTOMER_1 Account Team Call', startsAt: '2026-11-02T17:00:00.000Z', endsAt: '2026-11-02T18:00:00.000Z', allDay: false, kind: 'default', selfResponse: 'accepted', organizerSelf: false, recurring: true, attendeeDomains: [] } as never, m, '2026-11-02');
    expect(d.flags).toContain(NOT_ON_TEAM_FLAG);
    expect(heldNotOnTeam(d.flags)).toBe(true);
    expect(heldNotOnTeam(['WhatId = account fallback (no single obvious opp)'])).toBe(false);
  });

  it('finalizeStatus holds the row (needs_input) even with every field filled', () => {
    expect(finalizeStatus(past({ flags: [NOT_ON_TEAM_FLAG] }), Date.parse(NOW)).status).toBe('needs_input');
    expect(finalizeStatus(past(), Date.parse(NOW)).status).toBe('proposed');
  });

  it('hands-off approval never approves it; a row on my opp still approves', () => {
    const [held, mine] = autoApprove([past({ flags: [NOT_ON_TEAM_FLAG], status: 'needs_input' }), past({ dedupeKey: 'cal|primary|e2|x', status: 'proposed' })], NOW);
    expect(held!.status).toBe('needs_input');
    expect(held!.approvedAt).toBeUndefined();
    expect(mine).toMatchObject({ status: 'approved', approvalMethod: 'autonomy_policy' });
  });
});

describe('the batch (mock): a proposed row on an opp I am not on is skipped, never approved', () => {
  const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
  const fast = { enrichMs: 1e8, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };
  const made: MockDataSource[] = [];
  const fresh = () => {
    const ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
    made.push(ds);
    return ds;
  };
  afterEach(() => {
    for (const d of made.splice(0)) d.dispose();
  });
  async function call<K extends RouteKey>(ds: MockDataSource, key: K, input: unknown): Promise<RouteOutput<K>> {
    const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, input);
    const r = routes[key].response.safeParse(out);
    if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
    return out as RouteOutput<K>;
  }
  const proposedRow = (ds: MockDataSource) => ds.store.all('activity').find((a) => a.status === 'proposed' && a.oppId && a.taskType)!;

  it('takes and approves the complete proposed row without the flag (the baseline)', async () => {
    const ds = fresh();
    const row = proposedRow(ds);
    expect(row).toBeTruthy();
    const b = await call(ds, 'stageLogBatch', { body: {} });
    expect(b.entity.skipped.map((s) => s.id)).not.toContain(row.id);
    expect(ds.store.get('activity', row.id)!.status).toBe('approved');
  });

  it('with the flag: skipped with why, still proposed; after the user approves it, the next batch takes it', async () => {
    const ds = fresh();
    const row = proposedRow(ds);
    ds.store.c.activity.set(row.id, { ...row, issues: [...row.issues, NOT_ON_TEAM_FLAG] });
    const b = await call(ds, 'stageLogBatch', { body: {} });
    expect(b.entity.skipped).toContainEqual(expect.objectContaining({ id: row.id, why: NOT_ON_TEAM_SKIP }));
    expect(ds.store.get('activity', row.id)!.status).toBe('proposed');
    // the user's own Approve (Time ▸ Needs you, "Check and approve")
    ds.store.c.activity.set(row.id, { ...ds.store.get('activity', row.id)!, status: 'approved' });
    const again = await call(ds, 'stageLogBatch', { body: {} });
    expect(again.entity.skipped.map((s) => s.id)).not.toContain(row.id);
    expect(again.entity.canvases.length).toBeGreaterThan(0);
  });
});
