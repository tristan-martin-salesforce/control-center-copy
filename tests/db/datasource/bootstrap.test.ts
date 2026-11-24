/**
 * WIRE: an empty database, bootstrapped (no seed), serves every page; bootstrap is idempotent and never
 * overwrites; the scanner's connectors and a bootstrapped user never end up with two rows per source; spend is
 * read from the LLM ledger. Placeholder profile only (no real data).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { routes, type RouteDef, type RouteKey } from '../../../src/contract';
import type { DbHandle } from '../../../src/db/client';
import { CONNECTOR_META, DbScannerStore } from '../../../src/scanner/store-db';
import type { ConnectorId } from '../../../src/scanner/types';
import { DbDataSource } from '../../../src/server/datasource/db';
import { BootstrapError, bootstrapUser, defaultSections, fiscalQuarter, profileFromSetupFile, rolePolicy, BootstrapProfile } from '../../../src/server/datasource/db/bootstrap';
import { errorClassFromDb } from '../../../src/server/datasource/db/store/health';
import { SchemaGuard } from '../../../src/worker/schema-guard';
import { BE1B, openTestDb } from './helpers';

const PROFILE = {
  email: 'Ada.Placeholder@Example.com',
  name: 'Ada Placeholder',
  role: 'se_ic' as const,
  timezone: 'America/Denver',
  workingHours: { start: '07:30', end: '17:30', days: [1, 2, 3, 4, 5] },
  slackUserId: 'U0PLACE001',
  org62UserId: '005XX0000000PLAAAA',
};
const NOW = new Date('2026-11-06T15:00:00.000Z'); // Fri 08:00 MT

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;

async function truncateAll(h: DbHandle) {
  const res = await h.db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = res.rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await h.db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}
const count = async (table: string) => (await handle.db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`))).rows[0]!.n;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  await truncateAll(handle);
  const r = await bootstrapUser({ db: handle.db, profile: PROFILE, now: NOW });
  userId = r.userId;
  ds = new DbDataSource({ handle, userId, clock: { now: () => NOW } });
});
afterAll(async () => {
  if (!BE1B) return;
  await ds?.dispose();
  await handle?.close();
});

/** Every page's reads (Home, Today, Triage, Work, Outbox, Deals, Time, Health, Agents, Settings and the panels). */
const READS: [RouteKey, Record<string, unknown>][] = [
  ['getToday', {}],
  ['getHome', { query: {} }],
  ['getHome', { query: { wide: '1' } }],
  ...['', 'done', 'promises', 'snoozed', 'asked_of_me', 'all_open', 'said_by_me', 'trainings'].map((tab): [RouteKey, Record<string, unknown>] => ['listItems', { query: tab ? { tab } : {} }]),
  ['listItems', { query: { source: 'slack' } }],
  ['getOutbox', {}],
  ['getCalendar', { query: {} }],
  ['getAgents', {}],
  ['getTools', {}],
  ['getTime', { query: {} }],
  ['getTime', { query: { week: '2026-10-26' } }],
  ['getDeals', {}],
  ['getMissed', {}],
  ['getBriefs', {}],
  ['listWatches', {}],
  ['getTriage', {}],
  ['getHealth', {}],
  ['getScans', { query: {} }],
  ['getJobs', {}],
  ['getEventLog', {}],
  ['getSettings', {}],
  ['previewPolicy', { body: {} }],
  ['getPolicyVersions', {}],
  ['search', { query: { q: 'acme' } }],
  ['getSince', { query: {} }],
  ['listChatThreads', {}],
  ['getPeople', { query: {} }],
  ['getPeople', { query: { slack: 'true' } }],
];

async function call<K extends RouteKey>(key: K, input: Record<string, unknown>): Promise<unknown> {
  const def: RouteDef = routes[key];
  const inp: Record<string, unknown> = {};
  if (def.params) inp.params = def.params.parse(input.params ?? {});
  if (def.query) inp.query = def.query.parse(input.query ?? {});
  if (def.body) inp.body = def.body.parse(input.body);
  const out = await (ds[key] as unknown as (i: unknown) => Promise<unknown>).call(ds, inp);
  const r = def.response.safeParse(out);
  if (!r.success) throw new Error(`${key} failed contract validation: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return r.data;
}

describe('bootstrap defaults (pure)', () => {
  it('names the Salesforce fiscal quarter (FY starts 1 Feb) and its last working day', () => {
    expect(fiscalQuarter(NOW, 'America/Denver', '17:30')).toEqual({ label: 'Q4 FY27', due: '2027-02-01T00:30:00.000Z' }); // Sun 31 Jan 17:30 MST
    expect(fiscalQuarter(new Date('2026-08-01T12:00:00Z'), 'America/Denver').label).toBe('Q3 FY27');
    expect(fiscalQuarter(new Date('2027-01-31T12:00:00Z'), 'America/Denver').label).toBe('Q4 FY27');
    expect(fiscalQuarter(new Date('2027-02-01T12:00:00Z'), 'America/Denver')).toEqual({ label: 'Q1 FY28', due: '2027-05-01T00:00:00.000Z' }); // 30 Apr 18:00 MDT
  });
  it('is safe by default: dry-run on, drafts only, every autonomy level L1', () => {
    const s = defaultSections(BootstrapProfile.parse(PROFILE)) as Record<string, Record<string, unknown>>;
    expect(s.sending).toMatchObject({ dryRun: true, defaultMode: 'draft', channels: { slack: { mode: 'draft' }, gmail: { mode: 'draft' } } });
    expect(new Set(Object.values((s.agentBehavior as { autonomy: Record<string, string> }).autonomy))).toEqual(new Set(['L1']));
    expect(s.budgets).toMatchObject({ softUsd: 5, hardUsd: 15 });
  });
  it('starts each role from the engine role template weights', () => {
    const ic = rolePolicy('se_ic', NOW.toISOString(), 'p1');
    expect(ic.policy.weights).toMatchObject({ due_urgency: 3, meeting_proximity: 3, lead_time: 2, customer_facing: 1.5 });
    expect(ic.obligation).toBe(1.5);
    expect(rolePolicy('se_manager', NOW.toISOString(), 'p1').policy.weights.customer_facing).toBe(2.5);
  });
  it('reads the profile.json that npm run setup writes', () => {
    const p = profileFromSetupFile({ name: 'A', email: 'a@example.com', role_pack: 'se_manager', working_hours: { start: '08:00', end: '17:00' }, timezone: 'Europe/Paris', slack_user_id: '', org62_user_id: '' });
    expect(BootstrapProfile.parse(p)).toMatchObject({ role: 'se_manager', workingHours: { start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] }, slackUserId: null, org62UserId: null });
  });
  it('maps the scanner error classes onto the contract', () => {
    expect(errorClassFromDb('auth')).toBe('auth');
    expect(errorClassFromDb('config')).toBe('bug');
    expect(errorClassFromDb('unknown')).toBe('transient');
  });
});

describe.runIf(BE1B)('a bootstrapped empty database', () => {
  it('holds the user, me, settings, a policy and meta, and no mock data', async () => {
    const [u] = (await handle.db.execute<{ email: string; display_name: string; timezone: string; me: boolean }>(sql`select u.email, u.display_name, u.timezone, p.is_me as me from users u join people p on p.id = u.person_id`)).rows;
    expect(u).toEqual({ email: 'ada.placeholder@example.com', display_name: 'Ada Placeholder', timezone: 'America/Denver', me: true });
    const ids = (await handle.db.execute<{ system: string }>(sql`select system::text from person_identities order by 1`)).rows.map((r) => r.system);
    expect(ids).toEqual(['email', 'org62_user', 'slack']);
    for (const t of ['accounts', 'opportunities', 'work_items', 'source_items', 'jobs', 'scan_runs', 'connectors', 'drafts', 'calendar_events', 'activity_entries']) expect(await count(t), t).toBe(0);
    expect(await count('people')).toBe(1);
    expect(await count('priority_policies')).toBe(1);
    expect(await count('llm_budgets')).toBe(1);
    expect(await count('se_task_types')).toBeGreaterThan(20);
  });

  it('every page renders: each read answers contract-valid with empty states', async () => {
    for (const [key, input] of READS) await call(key, input);
    const today = (await call('getToday', {})) as { header: { nearestDeadline: { label: string; progress: { total: number } } } };
    expect(today.header.nearestDeadline).toMatchObject({ label: 'Q4 FY27 log', progress: { total: 250 } });
    const settings = (await call('getSettings', {})) as { profile: { name: string; workingHours: { start: string } }; policy: { name: string; version: number }; sending: { dryRun: boolean } };
    expect(settings).toMatchObject({ profile: { name: 'Ada Placeholder', workingHours: { start: '07:30' } }, policy: { name: 'SE IC', version: 1 }, sending: { dryRun: true } });
    const since = (await call('getSince', {})) as { entries: unknown[] };
    expect(since.entries).toEqual([]); // the bootstrap itself is not news
  });

  it('is idempotent and never overwrites a value', async () => {
    await ds.patchSettings({ params: { section: 'profile' }, body: { ifVersion: 1, value: { name: 'Ada Edited' } } });
    const again = await bootstrapUser({ db: handle.db, profile: { ...PROFILE, name: 'Someone Else', slackUserId: 'U0OTHER01', role: 'se_manager' }, now: NOW });
    expect(again).toEqual({ userId, status: 'up_to_date', wrote: [] });
    const s = (await call('getSettings', {})) as { profile: { name: string }; policy: { role: string } };
    expect(s.profile.name).toBe('Ada Edited');
    expect(s.policy.role).toBe('se_ic');
    const slack = (await handle.db.execute<{ external_id: string }>(sql`select external_id from person_identities where system = 'slack'`)).rows;
    expect(slack).toEqual([{ external_id: 'U0PLACE001' }]);
  });

  it('refuses a second, different user (the web serves one user per database)', async () => {
    await expect(bootstrapUser({ db: handle.db, profile: { ...PROFILE, email: 'other@example.com' }, now: NOW })).rejects.toBeInstanceOf(BootstrapError);
  });

  it('the scanner registers one connector row per source, labelled, and a re-bootstrap adds none', async () => {
    const ids = Object.keys(CONNECTOR_META) as ConnectorId[];
    for (const c of ids) await new DbScannerStore({ db: handle.db, userId }).connectorId(c);
    for (const c of ids) await new DbScannerStore({ db: handle.db, userId }).connectorId(c); // a second worker instance
    await bootstrapUser({ db: handle.db, profile: PROFILE, now: NOW });
    const dup = (await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from (select kind, name from connectors group by 1, 2 having count(*) > 1) d`)).rows[0]!.n;
    expect(dup).toBe(0);
    expect(await count('connectors')).toBe(ids.length);
    const health = (await call('getHealth', {})) as { connectors: { label: string; source: string; reauth: { label: string } | null }[] };
    expect(health.connectors.map((c) => c.label).sort()).toEqual(ids.map((c) => CONNECTOR_META[c].label).sort());
    expect(health.connectors.find((c) => c.source === 'slack' && c.label === 'Slack')?.reauth?.label).toBe('Re-auth Slack');
  });

  it('Health shows a worker waiting for the database schema, and clears it once they match (lane E, E1)', async () => {
    let applied: number[] = [1];
    const guard = new SchemaGuard({ db: handle.db, journal: [{ idx: 0, when: 1, tag: '0000_a' }, { idx: 1, when: 2, tag: '0001_b' }], readApplied: async () => applied, log: () => {}, ownerUserId: async () => userId });
    expect((await guard.check())?.state).toBe('behind');
    const blocked = (await call('getHealth', {})) as { worker: { blocked?: { message: string; fix: string | null; since: string } | null } };
    expect(blocked.worker.blocked).toMatchObject({ message: expect.stringContaining('The worker is waiting: the database is 1 migration behind this build'), fix: expect.stringContaining('npm run update') });
    // the event is in Health's event log too, once
    const events = (await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from app_events where fingerprint = 'worker|schema_mismatch' and resolved_at is null and owner_user_id = ${userId}`)).rows[0]!.n;
    expect(events).toBe(1);
    applied = [1, 2];
    expect((await guard.check())?.state).toBe('match');
    expect(((await call('getHealth', {})) as { worker: { blocked?: unknown } }).worker.blocked).toBeNull();
  });

  it('Health shows a connector the scanner marked broken, with a contract error class and its re-auth', async () => {
    const store = new DbScannerStore({ db: handle.db, userId, clock: () => NOW });
    await store.recordHealth('gmail', { state: 'down', errorClass: 'config', detail: 'tool not allowed', checkedAt: NOW.toISOString() });
    const health = (await call('getHealth', {})) as { connectors: { label: string; state: string; lastError: { class: string } | null; reauth: { kind: string } | null }[] };
    const gmail = health.connectors.find((c) => c.label === 'Gmail')!;
    expect(gmail).toMatchObject({ state: 'error', lastError: { class: 'bug' }, reauth: { kind: 'in_app' } });
    await store.recordHealth('gmail', { state: 'ok', checkedAt: NOW.toISOString() });
  });

  it('spend comes from the LLM ledger against the Settings budgets', async () => {
    const store = new DbScannerStore({ db: handle.db, userId, clock: () => NOW });
    await store.recordSpend({ connector: 'slack', model: 'claude-haiku-4-5', costUsd: 0.25, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    await store.recordSpend({ connector: 'gmail', model: 'claude-haiku-4-5', costUsd: 0.05, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    const { spend } = (await call('getHealth', {})) as { spend: { today: { usd: number; softBudgetUsd: number; hardCapUsd: number; pct: number }; last7d: { usd: number }[]; byScanner: { name: string; usd: number }[] } };
    expect(spend.today).toEqual({ usd: 0.3, softBudgetUsd: 5, hardCapUsd: 15, pct: 6 });
    expect(spend.last7d).toHaveLength(7);
    expect(spend.last7d[6]!.usd).toBe(0.3);
    expect(spend.byScanner).toEqual([
      { name: 'slack', usd: 0.25 },
      { name: 'gmail', usd: 0.05 },
    ]);
    const day = (await handle.db.execute<{ usd: number }>(sql`select spent_usd::float8 as usd from llm_budget_days`)).rows[0]!.usd;
    expect(day).toBeCloseTo(0.3, 6); // the total budget row rolls spend up per day (doctor's budget check)
  });

  it('completes a user the worker created first (CC_USER_EMAIL) without a second row', async () => {
    await truncateAll(handle);
    await handle.db.execute(sql`insert into users (email, timezone) values ('ada.placeholder@example.com', 'America/Denver')`);
    const r = await bootstrapUser({ db: handle.db, profile: PROFILE, now: NOW });
    expect(r.status).toBe('completed');
    expect(r.wrote).toEqual(expect.arrayContaining(['user.display_name', 'me', 'settings.profile', 'policy.se_ic@v1', 'cc.meta']));
    expect(await count('users')).toBe(1);
    const fresh = new DbDataSource({ handle, userId: r.userId, clock: { now: () => NOW } });
    try {
      const s = await fresh.getSettings({});
      expect(s.profile.name).toBe('Ada Placeholder');
    } finally {
      await fresh.dispose();
    }
  });
});
