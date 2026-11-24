/** Settings ▸ Data on the mock: GET/PATCH /retention and "Run retention now" (dry counts, then the run) over the event log. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MockDataSource } from '@/server/datasource/mock';
import { newDs } from '../contract/helpers';

let ds: MockDataSource;
beforeEach(() => {
  ds = newDs();
});
afterEach(() => ds.dispose());

type Ev = { id: string; acknowledged: boolean; at: string; lastSeenAt: string };

describe('retention routes (mock)', () => {
  it('reads the defaults and saves a patch over them', async () => {
    expect(await ds.getRetention({} as never)).toMatchObject({ enabled: true, eventsDays: 30 });
    expect(await ds.patchRetention({ body: { enabled: false, eventsDays: 7 } } as never)).toMatchObject({ enabled: false, eventsDays: 7, traceDays: 14 });
    expect(await ds.getRetention({} as never)).toMatchObject({ enabled: false, eventsDays: 7 });
  });

  it('a dry run counts acknowledged old events and changes nothing; the run removes them', async () => {
    const store = (ds as unknown as { store: { all(t: 'eventLog'): Ev[]; c: { eventLog: Map<string, Ev> } } }).store;
    const first = store.all('eventLog')[0]!;
    store.c.eventLog.set(first.id, { ...first, acknowledged: true, at: '2020-01-01T00:00:00Z', lastSeenAt: '2020-01-01T00:00:00Z' });
    const n = store.all('eventLog').length;
    const dry = await ds.runRetention({ body: { dry: true } } as never);
    expect(dry.dry).toBe(true);
    expect(dry.tables.find((t) => t.rule === 'events_resolved')!.rows).toBe(1);
    expect(store.all('eventLog').length).toBe(n);
    const real = await ds.runRetention({ body: { dry: false } } as never);
    expect(real.tables.find((t) => t.rule === 'events_resolved')!.rows).toBe(1);
    expect(store.all('eventLog').length).toBe(n - 1);
    expect(real.estimatedReclaimBytes).toBeGreaterThan(0);
  });
});
