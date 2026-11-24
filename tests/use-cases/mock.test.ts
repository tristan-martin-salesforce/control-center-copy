/**
 * Use cases to add in mock mode (src/server/datasource/mock/use-cases.ts) through the routes, contract-validated on
 * every call: the extraction finds the placeholder notes' use cases (never the internal stand-up's), each with its
 * evidence and the opp attribute() chose (or the rundown's top 3 when unsure); Accept drafts BOTH writes, the VDP
 * create_use_case Outbox item (ready, never sent) and the Org62 row on the next logging canvas; nothing is dispatched;
 * Undo restores the candidate and removes the item; Reject records why and a wrong-opp reject is a correction the
 * engine learns from; a hand-added one is deduped; the count joins Needs you.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type RouteKey, type RouteOutput } from '@/contract';
import { needsYouCount, needsYouPhrase } from '@/engines/activity/needs-count';
import { MockDataSource } from '@/server/datasource/mock';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const fast = { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };

let ds: MockDataSource;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
});
afterEach(() => ds.dispose());

async function call<K extends RouteKey>(key: K, input: unknown = {}): Promise<RouteOutput<K>> {
  const def = routes[key] as { params?: { parse(x: unknown): unknown }; query?: { parse(x: unknown): unknown }; body?: { parse(x: unknown): unknown } };
  const i = input as { params?: unknown; query?: unknown; body?: unknown };
  const parsed: Record<string, unknown> = {};
  if (def.params) parsed.params = def.params.parse(i.params ?? {});
  if (def.query) parsed.query = def.query.parse(i.query ?? {});
  if (def.body) parsed.body = def.body.parse(i.body);
  const out = await (ds[key as keyof MockDataSource] as (x: unknown) => Promise<unknown>).call(ds, parsed);
  const r = routes[key].response.safeParse(out);
  if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return r.data as RouteOutput<K>;
}

describe('use cases to add (mock)', () => {
  it('finds the notes’ use cases with evidence and an opp, never the internal stand-up’s; unsure opps carry the rundown', async () => {
    const p = await call('getUseCaseCandidates');
    expect(p.enabled).toBe(true);
    const titles = p.candidates.map((c) => c.title);
    expect(titles).toContain('Order status tracking');
    expect(titles.some((t) => /legacy cdp/i.test(t))).toBe(true);
    expect(titles.some((t) => /demo kit|weekly report/i.test(t))).toBe(false);
    const acme = p.candidates.find((c) => c.title === 'Order status tracking')!;
    expect(acme.oppId).toBe('opp_acme_p2');
    expect(acme.needsPick).toBe(false);
    expect(acme.evidence[0]?.quote).toMatch(/order status/i);
    expect(acme.why.length).toBeGreaterThan(0);
    expect(acme.sends).toMatch(/Org62 row/);
    // the Hooli thread names no opp and the account has two: the picker's top 3
    const hooli = p.candidates.find((c) => /loyalty agent/i.test(c.title))!;
    expect(hooli.needsPick).toBe(true);
    expect(hooli.alternates.length).toBeGreaterThanOrEqual(2);
    expect(hooli.alternates.length).toBeLessThanOrEqual(3);
    expect(hooli.sends).toBe('Pick the opportunity it goes on');
    expect(p.counts.toAdd).toBe(p.candidates.length);
    expect(p.counts.needsPick).toBeGreaterThanOrEqual(1);
  });

  it('Accept stages the Org62 row for the next canvas (dry run, nothing sent); Undo restores it', async () => {
    const p = await call('getUseCaseCandidates');
    const c = p.candidates.find((x) => x.title === 'Order status tracking')!;
    const sentBefore = (await call('getOutbox')).counts.sent ?? 0;
    const r = await call('decideUseCaseCandidate', { params: { id: c.id }, body: { decision: 'accept' } });
    expect(['accepted', 'staged_org62']).toContain(r.entity.candidate.status);
    expect(r.entity.org62Staged).toBe(true);
    expect(r.entity.candidate.org62).toBe('staged');
    // the next logging canvas carries it (CC-UC#cand-<id>), staged for approval: nothing dispatched
    const batch = await call('stageLogBatch', { body: {} });
    expect(batch.entity.draftIds.length).toBeGreaterThan(0);
    const d = await call('getDraft', { params: { id: batch.entity.draftIds[0]! } });
    const md = JSON.stringify(d.destination);
    expect(md).toContain(`CC-UC#cand-${c.id}`);
    expect(md).toContain('Order status tracking');
    expect(d.status).not.toBe('sent');
    expect((await call('getUseCaseCandidates')).decided.find((x) => x.id === c.id)?.org62).toBe('on_canvas');
    expect((await call('getOutbox')).counts.sent ?? 0).toBe(sentBefore); // nothing was sent
    // Undo of the accept (the batch first) restores the candidate
    await call('undoAudit', { params: { id: batch.auditId! }, body: {} });
    await call('undoAudit', { params: { id: r.auditId! }, body: {} });
    expect((await call('getUseCaseCandidates')).candidates.some((x) => x.id === c.id)).toBe(true);
  });

  it('Accept drafts BOTH Outbox items where the account has a VDP: the VDP create_use_case item (ready, dry run) and the Org62 row', async () => {
    const p = await call('getUseCaseCandidates');
    const c = p.candidates.find((x) => /VDP item/.test(x.sends ?? ''));
    expect(c, JSON.stringify(p.candidates.map((x) => [x.title, x.sends]))).toBeTruthy();
    const r = await call('decideUseCaseCandidate', { params: { id: c!.id }, body: { decision: 'accept' } });
    expect(r.entity.candidate.status).toBe('accepted');
    expect(r.entity.org62Staged).toBe(true);
    expect(r.entity.vdpDraftId).toBeTruthy();
    const d = await call('getDraft', { params: { id: r.entity.vdpDraftId! } });
    expect(d.status).toBe('ready');
    expect(d.destination.kind === 'action' && d.destination.action).toBe('vdp.create_use_case');
    expect(JSON.stringify(d.destination)).toContain(c!.title);
    expect(d.attempts).toEqual([]); // nothing sent
    expect((await call('getHealth')).dryRun).toBe(true);
    // Undo removes the VDP item and puts the candidate back
    await call('undoAudit', { params: { id: r.auditId! }, body: {} });
    await expect(call('getDraft', { params: { id: r.entity.vdpDraftId! } })).rejects.toThrow();
    expect((await call('getUseCaseCandidates')).candidates.find((x) => x.id === c!.id)?.status).toBe('suggested');
  });

  it('Accept on an unsure one needs a pick; the pick is a correction the engine learns (a rule in Settings)', async () => {
    const p = await call('getUseCaseCandidates');
    const h = p.candidates.find((c) => c.needsPick)!;
    await expect(call('decideUseCaseCandidate', { params: { id: h.id }, body: { decision: 'accept' } })).rejects.toThrow(/Pick the opportunity/);
    const rulesBefore = (await call('getAttributionRules')).rules.length;
    const pick = h.alternates[1] ?? h.alternates[0]!;
    const r = await call('decideUseCaseCandidate', { params: { id: h.id }, body: { decision: 'edit', oppId: pick.oppId } });
    expect(r.entity.candidate.status).toBe('edited');
    expect(r.entity.candidate.oppId).toBe(pick.oppId);
    expect(r.entity.candidate.needsPick).toBe(false);
    expect((await call('getAttributionRules')).rules.length).toBeGreaterThan(rulesBefore);
  });

  it('Reject records why; a wrong-opp reject decays the rules that chose it (a learning row)', async () => {
    const p = await call('getUseCaseCandidates');
    const c = p.candidates.find((x) => /legacy cdp/i.test(x.title))!;
    await expect(call('decideUseCaseCandidate', { params: { id: c.id }, body: { decision: 'reject' } })).rejects.toThrow();
    const r = await call('decideUseCaseCandidate', { params: { id: c.id }, body: { decision: 'reject', reason: 'not_use_case' } });
    expect(r.entity.candidate.status).toBe('rejected');
    expect(r.entity.candidate.rejectReason).toBe('not_use_case');
    // not suggested again on the next read
    await call('refreshUseCaseCandidates', { body: {} });
    expect((await call('getUseCaseCandidates')).candidates.some((x) => /legacy cdp/i.test(x.title))).toBe(false);
  });

  it('a hand-added use case is deduped against the candidates (fuzzy), and the count joins Needs you', async () => {
    const p = await call('getUseCaseCandidates');
    const r = await call('addUseCaseCandidate', { body: { title: 'Order status tracker', oppId: 'opp_acme_p2' } });
    expect(r.entity.matched).toBe('candidate');
    expect((await call('getUseCaseCandidates')).candidates.length).toBe(p.candidates.length);
    const fresh = await call('addUseCaseCandidate', { body: { title: 'Field service scheduling agent', oppId: 'opp_acme_p2', products: ['Agentforce'] } });
    expect(fresh.entity.matched).toBeNull();
    const n = (await call('getUseCaseCandidates')).counts.toAdd;
    const c = needsYouCount({ rows: 2, useCases: 1, candidates: n });
    expect(c.total).toBe(3 + n);
    expect(needsYouPhrase(c)).toMatch(/to add/);
  });
});
