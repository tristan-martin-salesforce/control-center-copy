/**
 * Needs you, one mechanism (src/contract/needs.ts): getDeals and getAccount carry the server's Deals needs (each DC
 * gap names its opps), every row can be set aside (decideNeed: audited, Undo), a Not needed DC gap comes back only on
 * a material change, Home ▸ Log & fix rows use the same decisions, account opps carry my DC, and the Assistant reads
 * the same rows. Mock DataSource; the Postgres side is tests/db/datasource/parity-mutations.test.ts. Placeholders only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, type RouteDef, type RouteKey, type RouteOutput } from '@/contract';
import { personaOf } from '@/personas';
import { appRead, appRouteInput } from '@/server/chat/app-routes';
import type { MockDataSource } from '@/server/datasource/mock';
import { mockWith } from './helpers';

const SE = personaOf({});
let ds: MockDataSource;
beforeEach(() => {
  ds = mockWith();
});
afterEach(() => ds.dispose());

async function call<K extends RouteKey>(key: K, input: unknown): Promise<RouteOutput<K>> {
  const def = routes[key] as RouteDef;
  const parsed: Record<string, unknown> = {};
  const i = (input ?? {}) as Record<string, unknown>;
  if (def.params) parsed.params = def.params.parse(i.params ?? {});
  if (def.query) parsed.query = def.query.parse(i.query ?? {});
  if (def.body) parsed.body = def.body.parse(i.body);
  const out = await (ds[key as keyof MockDataSource] as (x: unknown) => Promise<unknown>).call(ds, parsed);
  const r = def.response.safeParse(out);
  if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return out as RouteOutput<K>;
}

const fixFor = async (accountId: string) => (await call('getDeals', {})).needs.find((n) => n.section === 'fix' && n.accountId === accountId);

describe('Deals needs on the server', () => {
  it('getDeals names each DC-gap opp and why; getAccount has the same rows for the account', async () => {
    const deals = await call('getDeals', {});
    const fix = deals.needs.filter((n) => n.section === 'fix');
    // the seed: Umbrella's Agentforce opp (on my team, my hours, no DC), Globex's renewal and Hooli's add-on (the sweep's Claim findings)
    expect(fix.map((n) => n.accountId).sort()).toEqual(['acc_globex', 'acc_hooli', 'acc_umbrella']);
    const umbrella = fix.find((n) => n.accountId === 'acc_umbrella')!;
    expect(umbrella).toMatchObject({ why: "1 opp you're on with no DC: Umbrella · Agentforce Care · 4.3h QTD", claimOppId: 'opp_umbrella_af', verb: { label: 'Claim DC', href: '/deals/acc_umbrella?claim=opp_umbrella_af' } });
    expect(umbrella.opps).toEqual([expect.objectContaining({ oppId: 'opp_umbrella_af', oppName: 'Umbrella · Agentforce Care', onTeam: true, reasons: ['team', 'hours'] })]);
    const acc = await call('getAccount', { params: { accountId: 'acc_umbrella' } });
    expect(acc.needs.find((n) => n.section === 'fix')).toEqual(umbrella);
  });

  it('a DC request in flight makes the opp handled, not a gap', async () => {
    await call('createDcRequest', { body: { opp: 'opp_umbrella_af', split: 100, comment: 'Built the Agentforce demo for it' } });
    expect(await fixFor('acc_umbrella')).toBeUndefined();
  });
});

describe('Not needed: per opp, audited, Undo, resurfacing', () => {
  it('records the decision, the opp leaves the gap list, Undo brings it back', async () => {
    const row = (await fixFor('acc_umbrella'))!;
    const r = await call('decideNeed', { body: { rule: row.resolve!.rule, subjectIds: row.resolve!.subjectIds, kind: 'not_needed', reason: 'Not my deal' } });
    expect(r.auditId).toBeTruthy();
    // the server reads the baseline from the opp: on the team, 4.25 h this quarter (DC-30: and which quarter), the last call
    expect(r.entity.decisions).toEqual([expect.objectContaining({ rule: 'dc_gap', subjectId: 'opp_umbrella_af', kind: 'not_needed', reason: 'Not my deal', label: 'Umbrella · Agentforce Care', baseline: expect.objectContaining({ onTeam: true, hoursQtd: 4.25, quarter: 'FY27 Q4', at: expect.any(String) }) })]); // D-103 (d): and the last call, when
    expect(await fixFor('acc_umbrella')).toBeUndefined();
    expect((await call('getAccount', { params: { accountId: 'acc_umbrella' } })).needs.filter((n) => n.section === 'fix')).toEqual([]);
    expect((await call('listNeedDecisions', {})).decisions.map((d) => d.subjectId)).toEqual(['opp_umbrella_af']);
    await call('undoAudit', { params: { id: r.auditId! }, body: {} });
    expect((await call('listNeedDecisions', {})).decisions).toEqual([]);
    expect((await fixFor('acc_umbrella'))?.claimOppId).toBe('opp_umbrella_af');
  });

  it('comes back after 2 h more on the opp (not 1 h), and clearNeedDecision brings it back too', async () => {
    await call('decideNeed', { body: { rule: 'dc_gap', subjectIds: ['opp_hooli_data'], kind: 'not_needed', reason: 'Already covered by a teammate' } });
    expect(await fixFor('acc_hooli')).toBeUndefined();
    const o = ds.store.get('opps', 'opp_hooli_data')!;
    ds.store._set('opps', { ...o, hoursQtd: 1 });
    expect(await fixFor('acc_hooli')).toBeUndefined();
    ds.store._set('opps', { ...o, hoursQtd: 2 });
    expect((await fixFor('acc_hooli'))?.opps.map((g) => g.oppId)).toEqual(['opp_hooli_data']);
    ds.store._set('opps', o);
    expect(await fixFor('acc_hooli')).toBeUndefined();
    const c = await call('clearNeedDecision', { body: { rule: 'dc_gap', subjectIds: ['opp_hooli_data'] } });
    expect(c.entity.decisions.map((d) => d.subjectId)).toEqual(['opp_hooli_data']);
    expect(await fixFor('acc_hooli')).toBeDefined();
  });

  it('Think ahead and Chase rows snooze for a week; a DC gap subject must be an opp the app has', async () => {
    const ahead = (await call('getDeals', {})).needs.find((n) => n.section === 'ahead')!;
    expect(ahead.resolve).toMatchObject({ rule: 'deals_ahead', snooze: true });
    const r = await call('decideNeed', { body: { rule: 'deals_ahead', subjectIds: ahead.resolve!.subjectIds, kind: 'snooze' } });
    expect(Math.abs(Date.parse(r.entity.decisions[0]!.until!) - ds.now().getTime() - 7 * 24 * 3_600_000)).toBeLessThan(60_000);
    expect((await call('getDeals', {})).needs.find((n) => n.id === ahead.id)).toBeUndefined();
    await expect(call('decideNeed', { body: { rule: 'dc_gap', subjectIds: ['opp_nope'], kind: 'not_needed', reason: 'Other' } })).rejects.toThrow(/No opportunity "opp_nope"/);
    expect(() => routes.decideNeed.body!.parse({ rule: 'dc_gap', subjectIds: ['x'], kind: 'not_needed' })).toThrow(/reason/);
  });
});

describe('Home ▸ Log & fix: every row can be set aside', () => {
  it('gives each gap row a resolve; Not now hides it until the date; Not needed is offered only where the rule allows', async () => {
    const fix = (await call('getHome', { query: {} })).sections.find((s) => s.id === 'fix')!;
    expect(fix.rows.length).toBeGreaterThan(0);
    for (const r of fix.rows) expect(r.resolve).toMatchObject({ rule: expect.stringMatching(/^home:/), subjectIds: [r.id], snooze: true });
    const missed = fix.rows.find((r) => r.id === 'gap:missed_dc')!;
    expect(missed.resolve!.reasons.length).toBeGreaterThan(0);
    // DC-31: the row stands for the Deals DC gaps (opps), the same list Deals shows
    const gaps = (await call('getDeals', {})).needs.filter((n) => n.section === 'fix').flatMap((n) => n.opps.map((g) => g.oppId));
    expect(missed.resolve!.baseline.subjects).toBe([...new Set(gaps)].sort().join(','));
    // a row that is real outstanding work: Snooze only
    for (const r of fix.rows.filter((x) => /^gap:(quarter_log|org62_unlogged|needs_input|connector)/.test(x.id))) expect(r.resolve!.reasons).toEqual([]);
    const r = await call('decideNeed', { body: { rule: missed.resolve!.rule, subjectIds: missed.resolve!.subjectIds, kind: 'not_needed', reason: 'Not mine', baseline: missed.resolve!.baseline } });
    const after = (await call('getHome', { query: {} })).sections.find((s) => s.id === 'fix')!;
    expect(after.rows.find((x) => x.id === 'gap:missed_dc')).toBeUndefined();
    await call('undoAudit', { params: { id: r.auditId! }, body: {} });
    expect((await call('getHome', { query: {} })).sections.find((s) => s.id === 'fix')!.rows.find((x) => x.id === 'gap:missed_dc')).toBeDefined();
  });
});

describe('my DC on account opps', () => {
  it('getAccount fills myDc (split, role) and dcAssigned from my DCs', async () => {
    ds.recordMyDcs([{ oppId: 'opp_umbrella_c360', split: 100, role: 'AI + Data Architect', org62DcId: 'a0XXX0000000DC9AAA' }]);
    const o = (await call('getAccount', { params: { accountId: 'acc_umbrella' } })).opps.find((x) => x.id === 'opp_umbrella_c360')!;
    expect(o).toMatchObject({ dcAssigned: true, myDc: { split: 100, role: 'AI + Data Architect' } });
    // a myDc never shows without the flag
    const plain = ds.store.get('opps', 'opp_umbrella_af')!;
    ds.store._set('opps', { ...plain, dcAssigned: false, myDc: { split: 50, role: 'AI + Data Architect', org62DcId: 'a0XXX0000000DC8AAA', lastSeenAt: null } });
    expect((await call('getAccount', { params: { accountId: 'acc_umbrella' } })).opps.find((x) => x.id === 'opp_umbrella_af')).toMatchObject({ dcAssigned: true, myDc: { split: 50 } });
  });
});

describe('the Assistant reads the same rows', () => {
  it('read getDeals carries needs with the opp names, and decideNeed is a stage route', async () => {
    const r = await appRead(ds, 'getDeals', SE, {});
    const data = r.data as { needs: Array<{ section: string; accountName: string; opps: Array<{ oppName: string; reasons: string[] }> }> };
    const umbrella = data.needs.find((n) => n.section === 'fix' && n.accountName === 'Umbrella Health')!;
    expect(umbrella.opps[0]).toMatchObject({ oppName: 'Umbrella · Agentforce Care', reasons: ['team', 'hours'] });
    expect(routes.decideNeed.assistant).toBe('stage');
    expect(routes.clearNeedDecision.assistant).toBe('stage');
    expect(routes.listNeedDecisions.assistant).toBe('read');
    expect(() => appRouteInput('decideNeed', 'stage', SE, { body: { rule: 'dc_gap', subjectIds: ['opp_umbrella_af'], kind: 'not_needed', reason: 'Not my deal' } })).not.toThrow();
  });
});
