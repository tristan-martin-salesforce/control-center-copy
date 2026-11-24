/**
 * Lane 07 R7: a Home card's why is the ranking's why (why it matters + why now) with the extractor's sentence kept as
 * the detail; R1: a late row says how late and what to do, never "start by Mon". Placeholder seed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HomePayload } from '@/contract';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';

let ds: MockDataSource;
beforeAll(() => {
  ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
});
afterAll(() => ds.dispose());

describe('home: the two-part why', () => {
  it('every item card carries why-now / why-it-matters from the ranking and keeps the extractor sentence as why', async () => {
    const h = HomePayload.parse(await ds.getHome({ query: { wide: true } }));
    const items = h.doNow.cards.filter((c) => c.kind === 'item');
    expect(items.length).toBeGreaterThan(0);
    for (const c of items) {
      expect(c.whyMatters || c.whyNow).toBeTruthy();
      // the detail line is the extractor's (or the NBA's) sentence, untouched
      expect(c.why).toBe(c.now!.nba?.why ?? c.now!.item.why);
      if (c.whyNow) expect(c.whyNow).not.toMatch(/start by (Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b.*late|late unless/);
    }
    for (const c of h.doNow.cards.filter((x) => x.kind === 'outbox')) expect([c.whyMatters, c.whyNow]).toEqual([null, null]);
  });

  it('late rows in Think ahead say "N d late" and the verb, never "Was due"', async () => {
    const h = HomePayload.parse(await ds.getHome({ query: { wide: true } }));
    const ahead = h.sections.find((s) => s.id === 'ahead')!;
    for (const r of ahead.rows.filter((x) => x.state === 'overdue' && x.kind === 'item')) {
      expect(r.why).toMatch(/^\d+ d late · (do it now|late: do now or re-date|re-date or drop)/);
    }
  });
});
