/**
 * The attribution engine in mock mode (src/server/datasource/mock/attribution.ts) through the routes: DC suggestions
 * with why and evidence, Accept drafting a DC request (nothing sent), Reject, learning from a pick (a correction
 * changes the next guess and is listed in Settings ▸ Time), turning a rule off and removing it, Undo reverting the
 * learning, the rundown, the covered-AE lookup and the settings round trip. Contract-validated on every call.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type ActivityEntry, type RouteKey, type RouteOutput } from '@/contract';
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

describe('DC suggestions (mock)', () => {
  it('coverage rows at scale 1 (D-103 a): a specialist AE on the opp team (not its owner) and an OOO cover at its 50% split', async () => {
    const p = await call('getDcSuggestions');
    const s = p.suggestions.find((x) => x.oppId === 'opp_hooli_data');
    expect(s).toMatchObject({ coveredAe: 'Morgan Hale', splitPercent: 100 });
    expect(s!.reasons[0]!.text).toBe("Morgan Hale's deal (AE you cover)");
    const ooo = p.suggestions.find((x) => x.oppId === 'opp_globex_renew');
    expect(ooo).toMatchObject({ coveredAe: 'Elena Cruz', splitPercent: 50 });
    expect(ooo!.reasons[0]!.text).toBe('covering for Elena Cruz (OOO) · 50%');
  });

  it('suggests DCs from what I did, each with why and its evidence share; Accept drafts a DC request, nothing is sent', async () => {
    const p = await call('getDcSuggestions');
    expect(p.enabled).toBe(true);
    expect(p.suggestions.length).toBeGreaterThan(0);
    const s = p.suggestions[0]!;
    expect(s.reasons.length).toBeGreaterThan(0);
    expect(s.state).toBe('new');
    // shares in a group add up to 100
    const groups = new Map<string, number>();
    for (const x of p.suggestions) groups.set(x.groupKey, (groups.get(x.groupKey) ?? 0) + x.sharePercent);
    for (const total of groups.values()) expect(total).toBe(100);
    const before = (await call('listDcRequests')).requests.length;
    const target = p.suggestions.find((x) => x.splitPercent !== null)!;
    const r = await call('decideDcSuggestion', { params: { id: target.id }, body: { decision: 'accept' } });
    expect(r.entity.suggestion.state).toBe('accepted');
    expect(r.entity.dcRequestId).toBeTruthy();
    const after = await call('listDcRequests');
    expect(after.requests.length).toBe(before + 1);
    expect(after.requests.find((x) => x.id === r.entity.dcRequestId)?.oppId).toBe(target.oppId);
    // the decided one leaves the waiting list and is listed as decided
    const p2 = await call('getDcSuggestions');
    expect(p2.suggestions.some((x) => x.id === target.id)).toBe(false);
    expect(p2.decided.some((x) => x.id === target.id)).toBe(true);
    // Undo restores the suggestion and removes the request
    await call('undoAudit', { params: { id: r.auditId! }, body: {} });
    expect((await call('getDcSuggestions')).suggestions.some((x) => x.id === target.id)).toBe(true);
    expect((await call('listDcRequests')).requests.length).toBe(before);
  });

  it('Reject keeps the history and the batch does not suggest it again without a material change', async () => {
    const p = await call('getDcSuggestions');
    const s = p.suggestions[0]!;
    await call('decideDcSuggestion', { params: { id: s.id }, body: { decision: 'reject' } });
    const again = await call('refreshDcSuggestions', { body: {} });
    expect(again.queued).toBe(false);
    const p2 = await call('getDcSuggestions');
    expect(p2.suggestions.some((x) => x.oppId === s.oppId)).toBe(false);
    expect(p2.decided.find((x) => x.oppId === s.oppId)?.state).toBe('rejected');
  });
});

describe('learning from corrections (mock)', () => {
  it('a pick writes a learned rule, listed in Settings; off and remove work; Undo of the pick reverts the rule', async () => {
    const t = await call('getTime', { query: {} });
    const row = t.entries.find((e: ActivityEntry) => !e.oppId && !e.internal && ['needs_input', 'proposed'].includes(e.status));
    expect(row, 'the seed has a row that needs an opp').toBeTruthy();
    const opp = seed.opps.find((o) => o.isOpen && o.id !== row!.suggestion?.oppId)!;
    const r = await call('patchActivity', { params: { id: row!.id }, body: { ifVersion: row!.version, patch: { oppId: opp.id } } });
    expect(r.entity.oppId).toBe(opp.id);
    const rules = (await call('getAttributionRules')).rules;
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((x) => x.source === 'user_correction')).toBe(true);
    const first = rules[0]!;
    const off = await call('patchAttributionRule', { params: { id: first.id }, body: { enabled: false } });
    expect(off.entity.enabled).toBe(false);
    expect(off.entity.active).toBe(false);
    const gone = await call('deleteAttributionRule', { params: { id: first.id }, body: {} });
    expect(gone.entity.rules.some((x) => x.id === first.id)).toBe(false);
    // Undo the pick: its rules go with it
    await call('undoAudit', { params: { id: r.auditId! }, body: {} });
    expect((await call('getAttributionRules')).rules.filter((x) => x.id !== first.id)).toHaveLength(0);
  });

  it('the rundown lists the likely opps with my recent work', async () => {
    const t = await call('getTime', { query: {} });
    const row = t.entries.find((e: ActivityEntry) => !e.oppId && !e.internal)!;
    const rd = await call('getOppRundown', { query: { entryId: row.id } });
    expect(rd.entryId).toBe(row.id);
    for (const o of rd.opps) expect(typeof o.hours4w).toBe('number');
  });
});

describe('AEs I cover (mock)', () => {
  it('the lookup finds the placeholder AEs; the setting saves and the DC rule reads it', async () => {
    const hits = await call('lookupCoveredAe', { body: { q: 'Raj' } });
    expect(hits.hits.map((h) => h.name)).toContain('Raj Mehta');
    expect(hits.live).toBe(false);
    const cur = await call('getSettings');
    const saved = await call('patchSettings', { params: { section: 'time' }, body: { ifVersion: cur.time.version, value: { coveredAes: [{ name: 'Raj Mehta', enabled: true }], dcProducts: ['Data 360', 'Agentforce'] } } });
    expect(saved).toBeTruthy();
    const s = await call('getSettings');
    expect(s.time.coveredAes).toEqual([{ name: 'Raj Mehta', enabled: true }]);
    expect((await call('getDcSuggestions')).dcProducts).toEqual(['Data 360', 'Agentforce']);
  });
});
