/** Coordinator addition to CONTRACT-1: GET /people?q for the composer's @-mentions and recipient pickers. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PeoplePayload, PeopleQuery, routes } from '@/contract';
import { resetDataSourceForTests } from '@/server/datasource';
import type { MockDataSource } from '@/server/datasource/mock';
import * as peopleRoute from '../../app/api/v1/people/route';
import { newDs } from './helpers';

let ds: MockDataSource;
beforeEach(() => {
  ds = newDs();
});
afterEach(() => ds.dispose());

const people = (q: Record<string, string> = {}) => ds.getPeople({ query: PeopleQuery.parse(q) });

describe('GET /people', () => {
  it('lists everyone A→Z with name, email, Slack id, role, account and isExternal', async () => {
    const r = PeoplePayload.parse(await people());
    expect(r.total).toBe(ds.store.all('people').length);
    expect(r.people.map((x) => x.name)).toEqual([...r.people.map((x) => x.name)].sort((a, b) => a.localeCompare(b)));
    const dana = r.people.find((x) => x.id === 'p_dana')!;
    expect(dana).toMatchObject({ slackId: 'U0DANA', isExternal: true, account: { type: 'account', id: 'acc_acme', label: 'ACME Corp' } });
    expect(dana.email).toMatch(/@/);
    const priya = r.people.find((x) => x.id === 'p_priya')!;
    expect(priya).toMatchObject({ isManager: true, isExternal: false, account: null, role: 'Manager' });
  });

  it('matches name prefix first, then words, then email / Slack id / role / account', async () => {
    expect((await people({ q: 'da' })).people[0].id).toBe('p_dana');
    expect((await people({ q: 'U0NORA' })).people.map((x) => x.id)).toEqual(['p_nora']);
    expect((await people({ q: 'globex' })).people.map((x) => x.id).sort()).toEqual(['p_elena', 'p_marcus']);
    expect((await people({ q: 'zzz' })).people).toEqual([]);
  });

  it('filters: account, Slack-only (for Slack mentions), limit', async () => {
    expect((await people({ account: 'acc_acme' })).people.map((x) => x.id)).toEqual(['p_dana']);
    const slackOnly = await people({ slack: 'true' });
    expect(slackOnly.people.length).toBeGreaterThan(0);
    expect(slackOnly.people.every((x) => x.slackId)).toBe(true);
    const limited = await people({ limit: '2' });
    expect(limited.people).toHaveLength(2);
    expect(limited.total).toBe(ds.store.all('people').length);
  });

  it('is a generated GET route that validates its query', async () => {
    expect(routes.getPeople).toMatchObject({ method: 'GET', path: '/people' });
    const ctx = { params: Promise.resolve({}) };
    try {
      const ok = await peopleRoute.GET(new Request('http://localhost/api/v1/people?q=kim&slack=1'), ctx);
      expect(ok.status).toBe(200);
      expect(PeoplePayload.parse(await ok.json()).people.map((x) => x.id)).toEqual(['p_kim']);
      const bad = await peopleRoute.GET(new Request('http://localhost/api/v1/people?limit=0'), ctx);
      expect(bad.status).toBe(400);
    } finally {
      resetDataSourceForTests();
    }
  });
});
