/**
 * priority@2 capacity honesty on Home (build.ts `makeRoom` data): when today is overbooked, what to move, lowest value
 * first, never a pinned item or a hard deadline later today; null when the day fits. Data only (the Home briefing chunk
 * draws the card). Also the mock's priority@2 surfaces: the preview, the Health line and the feedback rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthPayload, PriorityPreview } from '@/contract';
import { buildHome } from '@/engines/home/build';
import type { HomeInput } from '@/engines/home/types';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { homeInputFromStore } from '@/server/datasource/mock/home';

let ds: MockDataSource;
beforeAll(() => {
  ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
});
afterAll(() => ds.dispose());

const inputOf = (): HomeInput => homeInputFromStore(ds, false);

describe('home: Make room (priority@2)', () => {
  it('is null when the day fits', () => {
    const input = inputOf();
    const fits = buildHome({ ...input, capacity: { ...input.capacity, fits: true, youMinToday: 60, freeMin: 300, openMin: 240 } });
    expect(fits.makeRoom).toBeNull();
  });

  it('when overbooked: "Overbooked by N min" and the lowest-value work first, never a hard deadline later today', () => {
    const input = inputOf();
    const over = buildHome({ ...input, capacity: { ...input.capacity, day: 'today', fits: false, youMinToday: 600, freeMin: 120, openMin: -480 } });
    expect(over.makeRoom).not.toBeNull();
    expect(over.makeRoom!.label).toBe('Overbooked by 480 min');
    const rows = over.makeRoom!.rows;
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.value).toBeGreaterThanOrEqual(rows[i - 1]!.value);
    const byId = new Map(input.items.map((w) => [w.id, w]));
    const endOfToday = new Date(input.now);
    endOfToday.setUTCHours(23, 59, 59, 999);
    for (const r of rows) {
      const w = byId.get(r.itemId)!;
      const hardToday = !!w.due && (w.dueKind ?? 'hard') === 'hard' && new Date(w.due).toDateString() === new Date(input.now).toDateString();
      expect(hardToday, r.title).toBe(false);
    }
  });
});

describe('mock priority@2 surfaces (db parity)', () => {
  it('the preview is priority@2 and writes nothing', async () => {
    const before = JSON.stringify(ds.store.all('workItems').map((w) => [w.id, w.rank]));
    const p = PriorityPreview.parse(await ds.getPriorityPreview({} as never));
    expect(p.engineVersion).toBe('priority@2');
    expect(p.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(ds.store.all('workItems').map((w) => [w.id, w.rank]))).toBe(before);
  });

  it('Health carries the Ranking line: no runs on a fresh seed, one after a re-rank', async () => {
    const h0 = HealthPayload.parse(await ds.getHealth({} as never));
    expect(h0.priority).toMatchObject({ engine: 'shadow', runs: 0, agreement3: null });
    expect(h0.priority!.line).toBe('Ranking: priority@2 in shadow · no runs yet');
    await ds.rerankToday({ body: {} } as never);
    const h1 = HealthPayload.parse(await ds.getHealth({} as never));
    expect(h1.priority!.runs).toBe(1);
    expect(h1.priority!.line).toMatch(/agrees \d\.\d\d on the Top 3 over 7 days \(1 run\)/);
  });

  it('a snooze of ranked work is a feedback row; the nightly pass then suggests a rule', async () => {
    const n0 = ds.priority.feedbackCount();
    const w = ds.store.all('workItems').find((x) => x.rank !== null && ['open', 'in_progress'].includes(x.state))!;
    await ds.itemAction({ params: { id: w.id, verb: 'snooze' }, body: { ifVersion: w.version, until: new Date(ds.now().getTime() + 86_400_000).toISOString() } } as never);
    expect(ds.priority.feedbackCount()).toBe(n0 + 1);
    expect(ds.priority.runFeedbackPass(ds.now())).toBeNull(); // one move is not a pattern
  });
});
