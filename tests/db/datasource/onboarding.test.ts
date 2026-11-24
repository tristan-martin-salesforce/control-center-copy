/**
 * B-079 onboarding on Postgres: an empty database must onboard (every page's data needs a user), the draft resumes,
 * finishing runs the real bootstrap and the Settings writers, and a CLI-bootstrapped user never sees the flow.
 * Placeholder profile only; the Sources probe and the draft store are fakes (nothing runs, no file is written).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OnboardingCompleteResult, OnboardingState } from '../../../src/contract';
import { actors, withChangeSet } from '../../../src/db/changeset';
import type { DbHandle } from '../../../src/db/client';
import { DbDataSource } from '../../../src/server/datasource/db';
import { bootstrapUser } from '../../../src/server/datasource/db/bootstrap';
import { ONBOARDING_KEY } from '../../../src/server/datasource/db/onboarding';
import { starterPriorities, rolePacks } from '../../../src/server/onboarding/core';
import { MemoryFirstScanLedger } from '../../../src/scanner/runtime/first-scan';
import { firstScanFor, ONBOARDING_KEY as WORKER_ONBOARDING_KEY } from '../../../src/worker/first-scan-config';
import { personaOf } from '../../../src/personas';
import { MemoryDraftStore } from '../../../src/server/onboarding/drafts';
import type { IdentityDetector } from '../../../src/server/onboarding/identity';
import { simulatedSources, SourceProbe } from '../../../src/server/onboarding/sources';
import { BE1B, openTestDb } from './helpers';

const NOW = new Date('2026-11-06T15:00:00.000Z');
const YOU = {
  name: 'Ada Placeholder',
  email: 'Ada.Placeholder@Example.com',
  role: 'se_manager' as const,
  timezone: 'America/Denver',
  workingHours: { start: '07:30', end: '17:30', days: [1, 2, 3, 4, 5] },
  slackUserId: 'U0PLACE001',
  org62UserId: '005XX0000000PLAAAA',
};

let handle: DbHandle;
let probeRuns = 0;

async function truncateAll(h: DbHandle) {
  const res = await h.db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = res.rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await h.db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}
const one = async <T>(q: string) => (await handle.db.execute(sql.raw(q))).rows[0] as T;

function fresh(drafts = new MemoryDraftStore(), extra: { detector?: IdentityDetector | null; connected?: Array<'slack' | 'org62'> } = {}) {
  const probe = new SourceProbe(async () => {
    probeRuns++;
    const p = simulatedSources([], NOW);
    return { ...p, sources: p.sources.map((x) => ({ ...x, state: (extra.connected ?? []).includes(x.id as 'slack') ? ('ok' as const) : x.state })) };
  });
  // no real lookups in tests: a scripted detector or none
  return new DbDataSource({ handle, clock: { now: () => NOW }, onboarding: { drafts, probe, setupProfile: () => null, detector: extra.detector ?? null } });
}

/** Scripted lookups (placeholder ids): Slack finds you, Org62 is ambiguous. Counts calls. */
function scriptedDetector(calls: string[]): IdentityDetector {
  return {
    mode: 'live',
    async detect(kind, ctx) {
      calls.push(`${kind}:${ctx.email}`);
      const at = NOW.toISOString();
      const spend = { kind, model: 'claude-haiku-5-5', costUsd: 0.0012, inputTokens: 2400, outputTokens: 40, status: 'ok' as const, errorCode: null, startedAt: at, ms: 3000 };
      return kind === 'slack'
        ? { detection: { status: 'found', id: 'U0PLACE001', name: 'Ada Placeholder', message: 'Found in Slack.', at, costUsd: 0.0012, simulated: false }, spend }
        : { detection: { status: 'ambiguous', id: null, name: null, message: 'More than one Org62 user has your email.', at, costUsd: 0.0012, simulated: false }, spend };
    },
  };
}

beforeAll(() => {
  if (!BE1B) return;
  handle = openTestDb();
});
afterAll(async () => {
  if (!BE1B) return;
  await handle?.close();
});
beforeEach(async () => {
  if (!BE1B) return;
  await truncateAll(handle);
});

describe.skipIf(!BE1B)('onboarding (db)', () => {
  it('an empty database must onboard; the draft resumes; finishing bootstraps with your choices', async () => {
    const drafts = new MemoryDraftStore();
    const ds = fresh(drafts);
    const s0 = OnboardingState.parse(await ds.getOnboarding({} as never));
    expect(s0).toMatchObject({ mode: 'db', required: true, status: 'not_started', reason: 'no_user', step: 'role', locked: [] });
    // the pages' reads fail without a user: exactly what the gate keeps the browser from asking
    await expect(ds.getSettings({} as never)).rejects.toMatchObject({ code: 'internal' });

    // the role first: nothing is picked for you
    await expect(ds.saveOnboardingStep({ body: { step: 'you', value: { name: 'Ada' }, goTo: 'priorities' } })).rejects.toMatchObject({ code: 'validation', details: { step: 'role' } });
    await ds.saveOnboardingStep({ body: { step: 'role', value: { id: 'se', level: 'manager' }, goTo: 'you' } });
    await expect(ds.saveOnboardingStep({ body: { step: 'you', value: { name: 'Ada' }, goTo: 'priorities' } })).rejects.toMatchObject({ code: 'validation', details: { step: 'you' } });
    await ds.saveOnboardingStep({ body: { step: 'you', value: YOU, goTo: 'priorities' } });
    const packs = rolePacks(NOW);
    const pri = { ...starterPriorities('se_manager', packs), weights: { ...packs.se_manager.weights, lead_time: 6 } };
    await ds.saveOnboardingStep({ body: { step: 'priorities', value: pri, goTo: 'sources' } });

    // a reload (a new DataSource on the same draft) resumes where you were
    const again = fresh(drafts);
    const s1 = await again.getOnboarding({} as never);
    expect([s1.status, s1.step, s1.reached, s1.draft.you.name, s1.draft.priorities?.weights.lead_time]).toEqual(['in_progress', 'sources', 'sources', 'Ada Placeholder', 6]);
    expect((await again.getOnboardingSources({ query: { refresh: false } })).sources).toHaveLength(7);
    await again.saveOnboardingStep({ body: { step: 'sources', value: {}, goTo: 'history' } });
    await again.saveOnboardingStep({ body: { step: 'history', value: { lookbackDays: 14, budgetUsd: 60 }, goTo: 'review' } });
    // Back always works
    expect((await again.saveOnboardingStep({ body: { step: 'review', value: {}, goTo: 'priorities' } })).step).toBe('priorities');

    const r = OnboardingCompleteResult.parse(await again.completeOnboarding({ body: {} }));
    expect(r).toMatchObject({ bootstrap: 'created', policyVersion: 2, redirect: '/', firstScan: { lookbackDays: 14, budgetUsd: 60, status: 'started' } });
    expect(r.state).toMatchObject({ required: false, status: 'complete', reason: 'onboarded' });
    expect(r.wrote).toEqual(expect.arrayContaining(['user', 'policy.se_manager@v1', 'policy@v2', ONBOARDING_KEY]));
    expect(drafts.load()).toBeNull();

    // what Settings now shows: your profile, the edited policy as v2 on top of the role pack's v1
    const s = await again.getSettings({} as never);
    expect(s.profile).toMatchObject({ name: 'Ada Placeholder', email: 'ada.placeholder@example.com', role: 'se_manager', workingHours: { start: '07:30', end: '17:30' } });
    expect(s.policy).toMatchObject({ version: 2, note: 'Set during onboarding' });
    expect(s.policy.weights.lead_time).toBe(6);
    expect(s.sending.dryRun).toBe(true);
    const v = await again.getPolicyVersions({} as never);
    expect(v.versions.map((x) => [x.version, x.by])).toEqual([
      [2, 'user'],
      [1, 'system'],
    ]);
    expect(await one<{ n: number }>(`select count(*)::int as n from person_identities where system in ('slack', 'org62_user')`)).toEqual({ n: 2 });
    expect(await one<{ v: { firstScan: { lookbackDays: number } } }>(`select value as v from user_settings where key = '${ONBOARDING_KEY}'`)).toMatchObject({ v: { status: 'complete', firstScan: { lookbackDays: 14 } } });

    // every page renders empty but valid
    for (const k of ['getHome', 'getToday', 'getDeals', 'getTime', 'getSettings'] as const) {
      await expect((again[k] as (i: unknown) => Promise<unknown>).call(again, { query: {} })).resolves.toBeTruthy();
    }
    // finishing twice changes nothing; saving a step afterwards is refused
    expect((await again.completeOnboarding({ body: {} })).bootstrap).toBe('up_to_date');
    await expect(again.saveOnboardingStep({ body: { step: 'you', value: {}, goTo: 'you' } })).rejects.toMatchObject({ code: 'validation' });
    await again.dispose();
    await ds.dispose();
  });

  it('ids are detected only for a connected source; a found id fills the field, an ambiguous one does not; the spend lands in the ledger', async () => {
    const calls: string[] = [];
    const drafts = new MemoryDraftStore();
    const ds = fresh(drafts, { detector: scriptedDetector(calls), connected: ['slack', 'org62'] });
    await ds.saveOnboardingStep({ body: { step: 'you', value: { ...YOU, slackUserId: '', org62UserId: '' }, goTo: 'priorities' } });
    await ds.saveOnboardingStep({ body: { step: 'priorities', value: starterPriorities('se_manager', rolePacks(NOW)), goTo: 'sources' } });
    const s = await ds.saveOnboardingStep({ body: { step: 'sources', value: { detect: ['slack', 'org62'] } } });
    expect(calls.sort()).toEqual(['org62:ada.placeholder@example.com', 'slack:ada.placeholder@example.com']);
    expect(s.step).toBe('sources');
    expect(s.detection).toBe('live');
    expect(s.draft.you).toMatchObject({ slackUserId: 'U0PLACE001', org62UserId: '' });
    expect(s.draft.identities).toMatchObject({ slack: { status: 'found', name: 'Ada Placeholder' }, org62: { status: 'ambiguous', id: null } });
    expect(s.draft.spend).toHaveLength(2);
    // Next works with the detected Slack id; Org62 stays optional
    await ds.saveOnboardingStep({ body: { step: 'sources', value: { slackUserId: 'U0PLACE001', org62UserId: '' }, goTo: 'history' } });
    await ds.saveOnboardingStep({ body: { step: 'history', value: {}, goTo: 'review' } });
    const r = await ds.completeOnboarding({ body: {} });
    expect(r.wrote).toContain('llm_calls×2');
    const ledger = await one<{ n: number; usd: string; purpose: string; skill: string }>(`select count(*)::int as n, sum(cost_usd)::text as usd, min(purpose::text) as purpose, min(skill_key) as skill from llm_calls`);
    expect(ledger).toMatchObject({ n: 2, purpose: 'resolve_entity', skill: 'detect-identity' });
    expect(Number(ledger.usd)).toBeCloseTo(0.0024, 6);
    expect(await one<{ n: number }>(`select count(*)::int as n from person_identities where system = 'slack' and external_id = 'U0PLACE001'`)).toEqual({ n: 1 });
    await ds.dispose();
  });

  it('a source that is not signed in is never looked up', async () => {
    const calls: string[] = [];
    const ds = fresh(new MemoryDraftStore(), { detector: scriptedDetector(calls), connected: [] });
    await ds.saveOnboardingStep({ body: { step: 'you', value: YOU, goTo: 'you' } });
    const s = await ds.saveOnboardingStep({ body: { step: 'sources', value: { detect: ['slack'] } } });
    expect(calls).toEqual([]);
    expect(s.draft.identities.slack).toMatchObject({ status: 'not_connected', id: null });
    expect(s.draft.you.slackUserId).toBe(YOU.slackUserId);
    await ds.dispose();
  });

  it('a CLI-bootstrapped user counts as onboarded and never sees the flow', async () => {
    await bootstrapUser({ db: handle.db, profile: { ...YOU, role: 'se_ic' }, now: NOW });
    const ds = fresh();
    const s = await ds.getOnboarding({} as never);
    expect(s).toMatchObject({ required: false, status: 'complete', reason: 'cli', firstScan: null });
    await expect(ds.completeOnboarding({ body: {} })).rejects.toMatchObject({ code: 'validation' });
    // the state check never starts the slow Sources probe for a set-up database
    const before = probeRuns;
    await ds.getOnboarding({} as never);
    expect(probeRuns).toBe(before);
    await ds.dispose();
  });

  it('a running server follows the database to its new user (onboarding again after a reset)', async () => {
    await bootstrapUser({ db: handle.db, profile: { ...YOU, name: 'First Placeholder' }, now: NOW });
    const ds = fresh();
    expect((await ds.getSettings({} as never)).profile.name).toBe('First Placeholder');
    await truncateAll(handle);
    await bootstrapUser({ db: handle.db, profile: { ...YOU, name: 'Second Placeholder' }, now: NOW });
    expect((await ds.getSettings({} as never)).profile.name).toBe('Second Placeholder');
    await ds.dispose();
  });

  it('an unfinished user (half a bootstrap) must onboard, keeps its email, and finishing completes it', async () => {
    await handle.db.execute(sql`insert into users (email, display_name, timezone) values ('ada.placeholder@example.com', 'Ada', 'Europe/Paris')`);
    const ds = fresh();
    const s = await ds.getOnboarding({} as never);
    expect(s).toMatchObject({ required: true, reason: 'incomplete_user', locked: ['email'], draft: { you: { email: 'ada.placeholder@example.com', name: 'Ada', timezone: 'Europe/Paris' } } });
    await ds.saveOnboardingStep({ body: { step: 'you', value: { ...YOU, email: 'someone.else@example.com' }, goTo: 'review' } });
    const r = await ds.completeOnboarding({ body: {} });
    expect(r.bootstrap).toBe('completed');
    expect(await one<{ n: number }>(`select count(*)::int as n from users`)).toEqual({ n: 1 });
    expect((await ds.getSettings({} as never)).profile).toMatchObject({ email: 'ada.placeholder@example.com', name: 'Ada Placeholder', timezone: 'America/Denver' });
    await ds.dispose();
  });

  it('as a Specialist AE: finishing writes persona ae, the VDP activation and the AE starter policy; the worker reads the lookback and budget', async () => {
    const ds = fresh();
    const s0 = await ds.getOnboarding({} as never);
    expect(s0.rolePacks.ae.role).toBe('ae');
    await expect(ds.saveOnboardingStep({ body: { step: 'role', value: {}, goTo: 'you' } })).rejects.toMatchObject({ code: 'validation', details: { step: 'role' } });
    await ds.saveOnboardingStep({ body: { step: 'role', value: { id: 'ae' }, goTo: 'you' } });
    await ds.saveOnboardingStep({ body: { step: 'you', value: { ...YOU, role: undefined }, goTo: 'priorities' } });
    await ds.saveOnboardingStep({ body: { step: 'priorities', value: starterPriorities('ae', rolePacks(NOW)), goTo: 'sources' } });
    await ds.saveOnboardingStep({ body: { step: 'sources', value: { features: { vdp: true } }, goTo: 'history' } });
    await ds.saveOnboardingStep({ body: { step: 'history', value: { lookbackDays: 7, budgetUsd: 25 }, goTo: 'review' } });
    const r = await ds.completeOnboarding({ body: {} });
    expect(r).toMatchObject({ bootstrap: 'created', policyVersion: 1, firstScan: { lookbackDays: 7, budgetUsd: 25, status: 'started' } });
    expect(r.wrote).toEqual(expect.arrayContaining(['policy.ae@v1', 'settings.persona', ONBOARDING_KEY]));
    const s = await ds.getSettings({} as never);
    expect(s.persona).toMatchObject({ id: 'ae', level: 'ic', features: { vdp: true } });
    expect(s.profile.role).toBe('se_ic');
    expect(s.policy).toMatchObject({ version: 1, role: 'ae', weights: rolePacks(NOW).ae.weights });
    expect(personaOf(s).connectors).toContain('vdp');

    // the worker's first-scan config: the onboarding choice, env over it
    expect(WORKER_ONBOARDING_KEY).toBe(ONBOARDING_KEY);
    const [u] = (await handle.db.execute<{ id: string }>(sql`select id from users limit 1`)).rows;
    const fs = await firstScanFor(handle.db, u!.id, { env: {}, argv: [], ledger: new MemoryFirstScanLedger(), pending: () => false });
    expect(fs?.config).toMatchObject({ lookbackDays: 7, budgetUsd: 25 });
    const env = await firstScanFor(handle.db, u!.id, { env: { CC_FIRST_SCAN_LOOKBACK_DAYS: '14' }, argv: [], ledger: new MemoryFirstScanLedger(), pending: () => false });
    expect(env?.config).toMatchObject({ lookbackDays: 14, budgetUsd: 25 });
    const off = await firstScanFor(handle.db, u!.id, { env: { CC_FIRST_SCAN_LOOKBACK_DAYS: '0' }, argv: [], ledger: new MemoryFirstScanLedger(), pending: () => false });
    expect(off).toBeNull();
    await ds.dispose();
  });

  it('the worker waits for a bare user row (CC_USER_EMAIL) to be onboarded, then a CLI user gets the defaults', async () => {
    await handle.db.execute(sql`insert into users (email, display_name, timezone) values ('ada.placeholder@example.com', 'Ada', 'Europe/Paris')`);
    const [u] = (await handle.db.execute<{ id: string }>(sql`select id from users limit 1`)).rows;
    let polls = 0;
    const logs: string[] = [];
    const stopped = await firstScanFor(handle.db, u!.id, { env: {}, argv: [], ledger: new MemoryFirstScanLedger(), sleep: async () => void polls++, stopping: () => polls >= 3, log: (m) => logs.push(m) });
    expect(polls).toBe(3);
    expect(logs[0]).toMatch(/waiting for onboarding/);
    expect(stopped?.config?.lookbackDays).toBe(30); // shut down while waiting: the defaults (nothing is planned anyway)
    await bootstrapUser({ db: handle.db, profile: { ...YOU, role: 'se_ic' }, now: NOW });
    polls = 0;
    const cli = await firstScanFor(handle.db, u!.id, { env: {}, argv: [], ledger: new MemoryFirstScanLedger(), sleep: async () => void polls++, pending: () => false });
    expect(polls).toBe(0);
    expect(cli?.config).toMatchObject({ lookbackDays: 30, budgetUsd: 25 });
  });

  it('an unfinished SE user who picks Specialist AE: the persona switch reseeds the AE policy, and finishing never trips on its version', async () => {
    await bootstrapUser({ db: handle.db, profile: { ...YOU, role: 'se_ic' }, now: NOW });
    // half a bootstrap (its last write missing): must onboard
    const [u0] = (await handle.db.execute<{ id: string }>(sql`select id from users limit 1`)).rows;
    await withChangeSet({ db: handle.db, userId: u0!.id, actor: actors.system('test'), kind: 'system', reason: 'test: drop cc.meta', undoable: false }, async (tx) => {
      await tx.execute(sql`delete from user_settings where key = 'cc.meta'`);
    });
    const ds = fresh();
    expect(await ds.getOnboarding({} as never)).toMatchObject({ required: true, reason: 'incomplete_user' });
    await ds.saveOnboardingStep({ body: { step: 'role', value: { id: 'ae' }, goTo: 'you' } });
    await ds.saveOnboardingStep({ body: { step: 'you', value: { ...YOU, role: undefined }, goTo: 'review' } });
    const r = await ds.completeOnboarding({ body: {} });
    expect(r.bootstrap).toBe('completed');
    expect(r.wrote).toContain('settings.persona');
    const s = await ds.getSettings({} as never);
    expect(s.persona.id).toBe('ae');
    expect(s.policy.weights).toEqual(rolePacks(NOW).ae.weights);
    await ds.dispose();
  });
});
