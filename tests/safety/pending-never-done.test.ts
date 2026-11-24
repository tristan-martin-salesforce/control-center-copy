/**
 * 2026-11-13 audit C9: a pending count above 0 never yields a done or empty state. On 2026-11-13 the Ready stop read a
 * muted "done", Home read "Nothing missing" and the sidebar's Time badge read 0 while 55 DC requests and 31 VDP use
 * cases waited for a canvas. Table-driven over the three surfaces: Time ▸ Log it's Ready stop (path-derive logPath),
 * Home ▸ Log & fix (engines/home buildHome) and the sidebar badge (time/badges timeBadges). Placeholder data only.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { ActivityEntry, TimeWeek } from '@/contract';
import { timeBadges } from '@/components/time/badges';
import { logPath, type PathInput } from '@/components/time/path-derive';
import { buildHome } from '@/engines/home/build';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { homeInputFromStore } from '@/server/datasource/mock/home';

const NOW = '2026-11-11T22:00:00.000Z';
let n = 0;
const ready = (): ActivityEntry =>
  ({
    id: `r${++n}`,
    version: 1,
    date: '2026-11-10',
    start: '2026-11-10T17:00:00.000Z',
    end: '2026-11-10T18:00:00.000Z',
    durationH: 1,
    taskType: 'Demo',
    oppId: 'o1',
    oppName: 'OPP_1',
    accountName: 'CUSTOMER_1',
    meetingType: 'CF',
    description: 'Placeholder meeting',
    status: 'approved',
    confidence: 'likely',
    sources: [{ kind: 'calendar', label: 'calendar' }],
    userLockedFields: [],
    issues: [],
    updatedAt: '2026-11-10T18:00:00.000Z',
    fromOrg62: false,
    excludedReason: null,
    loggedAt: null,
    verifiedAt: null,
  }) as unknown as ActivityEntry;

const week = (): PathInput['week'] =>
  ({
    entries: [],
    canvas: { lastSyncedAt: null, rowsChangedSince: 0, confirmRequired: false, label: 'Work-order canvas' },
    quarter: { label: 'Q4 FY27', loggedH: 12.5, targetH: 250, due: '2027-01-31T02:00:00.000Z' },
    logCanvases: [],
  }) as Pick<TimeWeek, 'entries' | 'canvas' | 'quarter'> & { logCanvases: [] };

const CASES = [
  { dcs: 0, ucs: 0, rows: 0 },
  { dcs: 1, ucs: 0, rows: 0 },
  { dcs: 55, ucs: 0, rows: 0 },
  { dcs: 0, ucs: 31, rows: 0 },
  { dcs: 55, ucs: 31, rows: 0 },
  { dcs: 0, ucs: 0, rows: 2 },
  { dcs: 55, ucs: 31, rows: 2 },
  { dcs: 3, ucs: 0, rows: 2 },
];

describe('Time ▸ Log it: the Ready stop never reads done while anything waits', () => {
  it.each(CASES)('$dcs DCs, $ucs use cases, $rows rows ready', ({ dcs, ucs, rows }) => {
    const p = logPath({ rows: Array.from({ length: rows }, ready), week: week(), nowIso: NOW, dcPending: dcs, ucPending: ucs });
    const st = p.stages.find((s) => s.id === 'ready')!;
    const pending = dcs + ucs + rows;
    if (pending === 0) {
      expect(st.state).toBe('done');
      expect(st.count).toBe('Nothing ready');
      return;
    }
    expect(st.state).not.toBe('done');
    expect(st.count).not.toBe('Nothing ready');
    if (dcs) expect(st.count).toContain(`${dcs} DC`);
    if (ucs) expect(st.count).toContain(`${ucs} VDP use case`);
    // with no rows ready, its button is Log DCs now: shown (a step), the page's default only when nothing else waits
    if (!rows && dcs) {
      expect(st.step?.id).toBe('dcs');
      expect(st.step?.verb).toBe('Log DCs now');
      expect(p.current?.id).toBe('ready');
    }
    // use cases alone wait for rows: no button, still not done, never the filled default
    if (!rows && !dcs && ucs) {
      expect(st.step).toBeNull();
      expect(p.current).toBeNull();
    }
    if (rows) expect(st.step?.id).toBe('submit');
  });

  it('Log DCs now is not the filled default while a canvas waits for your Apply', () => {
    const w = { ...week(), logCanvases: [{ draftId: 'd1', title: 'Activity log · 1 row', state: 'pending', url: null, createdAt: NOW, appliedAt: null, rows: 0, hours: 0, dcs: 2, updates: 0, useCases: 0, rowIds: [], org62: null, quarters: [], maybeCreated: false, progress: null }] } as unknown as PathInput['week'];
    const p = logPath({ rows: [], week: w, nowIso: NOW, dcPending: 4 });
    expect(p.stages.find((s) => s.id === 'ready')!.step?.id).toBe('dcs');
    expect(p.current?.id).toBe('apply');
  });
});

describe('the sidebar Time badge counts what waits for a canvas', () => {
  it.each(CASES.filter((c) => !c.rows))('$dcs DCs, $ucs use cases', ({ dcs, ucs }) => {
    const b = timeBadges({ adminWaiting: 0, vdpOpen: 0, adminBySurface: { log: 0, forecast: 0, vdp: 0 }, waitingForCanvas: { dcs, useCases: ucs } });
    expect(b.sidebar).toBe(dcs + ucs);
    expect(b.log).toBe(dcs + ucs);
    // quiet: they are not approvals
    expect(b.attn).toBe(false);
    if (dcs + ucs) expect(b.href).toBe('/activity?view=week');
  });
});

describe('Home ▸ Log & fix never says "Nothing missing" while DCs or use cases wait', () => {
  let ds: MockDataSource;
  beforeEach(() => {
    ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
  });

  it.each(CASES.filter((c) => !c.rows))('$dcs DCs, $ucs use cases', ({ dcs, ucs }) => {
    const input = homeInputFromStore(ds, false);
    // on the seed: one more Log & fix row than without them (the section shows its first rows, "See all N" the rest)
    const base = buildHome({ ...input, waitingForCanvas: { dcs: 0, useCases: 0 } }).sections.find((s) => s.id === 'fix')!.count;
    const seeded = buildHome({ ...input, waitingForCanvas: { dcs, useCases: ucs } }).sections.find((s) => s.id === 'fix')!;
    expect(seeded.count).toBe(base + (dcs + ucs ? 1 : 0));
    // with nothing else to fix, it is the row shown, never "Nothing missing"
    const quiet = { ...input, connectors: [], activity: [], dcNeeds: [], missedOpps: [], vdp: undefined, forecast: undefined, items: [], waitingForCanvas: { dcs, useCases: ucs } };
    const fix = buildHome(quiet).sections.find((s) => s.id === 'fix')!;
    const row = fix.rows.find((r) => r.id === 'gap:canvas_waiting');
    if (dcs + ucs === 0) {
      expect(row).toBeUndefined();
      return;
    }
    expect(fix.rows.length).toBeGreaterThan(0);
    expect(row?.title).toMatch(dcs ? /DC request/ : /VDP use case/);
    expect(row?.href).toBe('/activity?view=week');
  });

  it('a row set aside never leaves the empty line saying "Nothing missing"', () => {
    const input = homeInputFromStore(ds, false);
    const h = buildHome({ ...input, connectors: [], activity: [], dcNeeds: [], missedOpps: [], items: input.items.filter((w) => !/log|org62|dc|expense|concur/i.test(w.title)), waitingForCanvas: { dcs: 2, useCases: 0 }, decisions: [{ rule: 'home:canvas_waiting', subjectId: 'gap:canvas_waiting', kind: 'snooze', until: '2099-01-01T00:00:00.000Z', reason: null, label: 'x', baseline: {}, decidedAt: NOW } as never] });
    const fix = h.sections.find((s) => s.id === 'fix')!;
    if (!fix.rows.length) expect(fix.empty).not.toMatch(/Nothing missing/);
  });
});
