/**
 * The `use_cases.extract` job's model pass (src/jobs/handlers/use-cases-extract.ts confirmWith) under the spend
 * governor (H-5), with a cassette model and a memory spend store: one call per source, every call booked with its
 * cassette hash, one hold for the pass, a hand raised (SPEND.ASK) and a clean stop past the hold, no call on a day
 * with no room. And the routes: classified for the Assistant (read, stage, deny), generated, and on both DataSources.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { routes } from '../../src/contract';
import { confirmRequest, EXTRACT_USE_CASES_VERSION } from '../../src/engines/use-cases/confirm';
import type { UcMention } from '../../src/engines/use-cases/types';
import { confirmWith } from '../../src/jobs/handlers/use-cases-extract';
import type { JobContext } from '../../src/jobs/types';
import { SCANNER_MODEL } from '../../src/llm/models';
import { MemorySpendStore, SpendGovernor } from '../../src/llm/spend';
import { cassetteHash, cassetteModel } from '../../src/scanner/completion/cassette';
import type { CompletionModel } from '../../src/scanner/completion/types';
import { createMockDataSource } from '../../src/server/datasource/mock';

const mention = (key: string, statement: string): UcMention => ({ sourceKey: key, statement, title: statement.slice(0, 30), problem: statement, products: [], track: null, outcome: '', stageHint: null, cue: 'asked for', certainty: 'unsure' });

function fakeCtx() {
  const booked: unknown[][] = [];
  const db = { execute: async (q: { queryChunks?: unknown[] }) => (booked.push(q.queryChunks ?? []), { rows: [{ id: '1' }] }) };
  const ctx = { job: { id: 7, ownerUserId: 'u1', kind: 'use_cases.extract', queue: 'maintenance', payload: { trigger: 'test' } }, signal: new AbortController().signal, db, userId: 'u1', clock: () => new Date('2026-11-18T16:00:00Z'), heartbeat: async () => {} } as unknown as JobContext;
  return { ctx, booked };
}

const unsure = new Map([
  ['s1', [mention('s1', 'Customer asked for follow-up question support')]],
  ['s2', [mention('s2', 'Dana asked for a digest of unanswered questions')]],
]);
const PRODUCTS = ['Data 360', 'Agentforce'];
const entry = (ms: UcMention[], text: string) => {
  const r = confirmRequest(ms.map((m) => ({ statement: m.statement })), PRODUCTS);
  return { hash: cassetteHash({ model: SCANNER_MODEL, system: r.system, user: r.user }, EXTRACT_USE_CASES_VERSION), label: ms[0]!.sourceKey, text, origin: 'hand' as const };
};
const YES = '{"items":[{"i":1,"useCase":true,"title":"Follow-up questions","problem":"p","product":"Agentforce","outcome":""}]}';
const NO = '{"items":[{"i":1,"useCase":false,"title":""}]}';

describe('the model pass under the governor', () => {
  it('one call per source, replayed by hash, booked; the hold settles with what was spent', async () => {
    const tape = cassetteModel({ skill: EXTRACT_USE_CASES_VERSION, entries: [entry(unsure.get('s1')!, YES), entry(unsure.get('s2')!, NO)] });
    const store = new MemorySpendStore({ now: () => new Date('2026-11-18T16:00:00Z') });
    const gov = new SpendGovernor(store);
    const { ctx, booked } = fakeCtx();
    const r = await confirmWith(ctx, tape.model, gov, { day: '2026-11-18' })(unsure, PRODUCTS);
    expect(tape.misses).toEqual([]);
    expect(r.calls).toBe(2);
    expect([...r.confirmed.keys()]).toEqual(['s1']);
    expect(r.confirmed.get('s1')![0]).toMatchObject({ title: 'Follow-up questions', certainty: 'sure' });
    expect(booked.length).toBe(2); // one llm_calls insert per call
    const holds = [...store.holds.values()];
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ scope: 'job', state: 'settled' });
  });

  it('past the hold: raises a hand (SPEND.ASK) and stops at the next source; what was confirmed stays', async () => {
    const pricey: CompletionModel = async () => ({ ok: true, text: YES, costUsd: 1, inputTokens: 100, outputTokens: 10 });
    const store = new MemorySpendStore({ now: () => new Date('2026-11-18T16:00:00Z') });
    const r = await confirmWith(fakeCtx().ctx, pricey, new SpendGovernor(store), { day: '2026-11-18' })(unsure, PRODUCTS);
    expect(r.calls).toBe(1);
    expect(r.deferred).toBe('spend_ask');
    expect(r.confirmed.size).toBe(1);
    expect([...store.events.values()].some((e) => e.code === 'SPEND.ASK')).toBe(true);
  });

  it('a day with no room: no call at all (the rules’ candidates still land)', async () => {
    let called = 0;
    const model: CompletionModel = async () => ((called += 1), { ok: true, text: YES, costUsd: 0, inputTokens: 1, outputTokens: 1 });
    const store = new MemorySpendStore({ day: () => ({ spentUsd: 15, softUsd: 5, hardUsd: 15 }) });
    const r = await confirmWith(fakeCtx().ctx, model, new SpendGovernor(store), { day: '2026-11-18' })(unsure, PRODUCTS);
    expect(called).toBe(0);
    expect(r.deferred).toBe('day_budget');
  });
});

describe('the routes', () => {
  it('are classified for the Assistant, generated under app/api/v1/use-cases, and on the mock DataSource', () => {
    expect(routes.getUseCaseCandidates).toMatchObject({ method: 'GET', path: '/use-cases/candidates', assistant: 'read', topic: 'time' });
    expect(routes.decideUseCaseCandidate).toMatchObject({ method: 'POST', assistant: 'stage', undoable: true });
    expect(routes.addUseCaseCandidate).toMatchObject({ method: 'POST', assistant: 'stage', undoable: true });
    expect(routes.refreshUseCaseCandidates).toMatchObject({ method: 'POST', assistant: 'deny' });
    const root = path.resolve(__dirname, '../../app/api/v1/use-cases/candidates');
    for (const f of ['route.ts', '[id]/route.ts', 'refresh/route.ts']) expect(existsSync(path.join(root, f)), f).toBe(true);
    const ds = createMockDataSource({ autoplay: false });
    for (const k of ['getUseCaseCandidates', 'decideUseCaseCandidate', 'addUseCaseCandidate', 'refreshUseCaseCandidates'] as const) expect(typeof ds[k]).toBe('function');
    ds.dispose();
  });

  it('the request bodies: a reject must say why; a title has 3+ characters', () => {
    expect(routes.decideUseCaseCandidate.body.safeParse({ decision: 'reject' }).success).toBe(false);
    expect(routes.decideUseCaseCandidate.body.safeParse({ decision: 'reject', reason: 'duplicate' }).success).toBe(true);
    expect(routes.addUseCaseCandidate.body.safeParse({ title: 'ab' }).success).toBe(false);
  });
});
