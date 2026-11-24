/**
 * SETTLE-1 (UI side): what the app closed for you is shown in one place, Triage's "Closed for you" group, newest first
 * over the last 14 days, each with its reason badge, its why, its message and Undo. It is a record, not a guess: it never
 * counts toward Triage's count or the nav badge. Home says "Closed N for you since you left" when the setting is on.
 * Placeholder seed (src/mock/seed.example.json) and placeholder names only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HomePayload, TodayPayload, TriagePayload, type Evidence, type TriageItem } from '@/contract';
import { closedBadge, closedForYouSince, closedReasonClass, closedWhy } from '@/engines/home/closed';
import { buildHome } from '@/engines/home/build';
import { homeInputFromStore } from '@/server/datasource/mock/home';
import { withoutTriageItem } from '@/components/lists/cache-patches';
import { closedDayLabel } from '../../app/triage/_triage/TriageRows';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';

const CLOSED = ['w_acme_ssodoc', 'w_acme_sso', 'w_umbrella_hipaa']; // the seed's engine closes, newest first

const group = (t: TriagePayload, g: string) => t.groups.find((x) => x.group === g);

describe('SETTLE-1: the reason badge and the why line', () => {
  const base = { id: 'w_x', closedReason: 'You sent the deck', sources: [] as Array<{ at?: string }> };

  it('names the reason class, else the nearest one for the resolution', () => {
    expect(closedBadge({ resolution: 'done_by_me', resolutionDetail: { inferred: true, settle: { reason: 'done_by_you', confidence: 0.9, check: 'c' } } })).toEqual({ label: 'Done by you', tone: 'success' });
    expect(closedBadge({ resolution: 'done_by_other', resolutionDetail: { inferred: true, personName: 'PERSON_A', settle: { reason: 'resolved_by_other', confidence: 0.9, check: 'c' } } })).toEqual({ label: 'Resolved by PERSON_A', tone: 'success' });
    expect(closedBadge({ resolution: 'not_needed', resolutionDetail: { inferred: true, settle: { reason: 'moment_passed', confidence: 0.8, check: 'c' } } })).toEqual({ label: 'Moment passed', tone: 'neutral' });
    expect(closedBadge({ resolution: 'not_needed', resolutionDetail: { inferred: true, settle: { reason: 'gone_quiet', confidence: 0.8, check: 'c' } } })).toEqual({ label: 'Gone quiet', tone: 'neutral' });
    // older engine closes carry only a resolution
    expect(closedReasonClass({ resolution: 'done_by_me', resolutionDetail: { inferred: true } })).toBe('done_by_you');
    expect(closedBadge({ resolution: 'done_by_other', resolutionDetail: { inferred: true, personName: 'PERSON_B' } }).label).toBe('Resolved by PERSON_B');
    expect(closedBadge({ resolution: null, resolutionDetail: null })).toEqual({ label: 'Closed', tone: 'neutral' });
  });

  it('adds how long after the ask when the ask and the settling message both carry a time', () => {
    const ev = (id: string, role: Evidence['role'], at: string) => ({ id, workItemId: 'w_x', role, at });
    const detail = { resolution: 'done_by_me' as const, resolutionDetail: { inferred: true, evidenceIds: ['ev_done'] } };
    expect(closedWhy({ ...base, ...detail }, [ev('ev_ask', 'origin', '2026-11-05T10:00:00.000Z'), ev('ev_done', 'completion', '2026-11-05T12:00:00.000Z')])).toBe('You sent the deck · 2 h after the ask');
    // the ask time can come from the item's sources
    expect(closedWhy({ ...base, ...detail, sources: [{ at: '2026-11-05T11:30:00.000Z' }] }, [ev('ev_done', 'completion', '2026-11-05T12:00:00.000Z')])).toBe('You sent the deck · 30 min after the ask');
    // one time only, or the reason already says it: the plain reason
    expect(closedWhy({ ...base, ...detail }, [ev('ev_done', 'completion', '2026-11-05T12:00:00.000Z')])).toBe('You sent the deck');
    expect(closedWhy({ ...base, ...detail, closedReason: 'You sent the deck 2 h after the ask' }, [ev('ev_ask', 'origin', '2026-11-05T10:00:00.000Z'), ev('ev_done', 'completion', '2026-11-05T12:00:00.000Z')])).toBe('You sent the deck 2 h after the ask');
    // the db's evidence `at` is when it was linked; the message's own time (source.at) wins
    expect(closedWhy({ ...base, ...detail }, [{ ...ev('ev_ask', 'origin', '2026-11-06T09:00:00.000Z'), source: { at: '2026-11-05T10:00:00.000Z' } }, { ...ev('ev_done', 'completion', '2026-11-06T09:00:00.000Z'), source: { at: '2026-11-05T13:00:00.000Z' } }])).toBe('You sent the deck · 3 h after the ask');
    // the badge names the class, so the why drops a repeated prefix
    expect(closedWhy({ ...base, ...detail, closedReason: 'Done by you: your reply shares the doc' }, [])).toBe('Your reply shares the doc');
    expect(closedWhy({ ...base, ...detail, closedReason: 'Resolved by PERSON_A: asker cancelled the session' }, [])).toBe('Asker cancelled the session');
    // another item's evidence never counts
    expect(closedWhy({ ...base, ...detail }, [{ ...ev('ev_ask', 'origin', '2026-11-05T10:00:00.000Z'), workItemId: 'w_other' }, ev('ev_done', 'completion', '2026-11-05T12:00:00.000Z')])).toBe('You sent the deck');
  });

  it('day headers read Today, Yesterday, then the weekday and date', () => {
    const now = '2026-11-05T16:00:00.000Z';
    expect(closedDayLabel('2026-11-05T15:00:00.000Z', now, 'UTC')).toBe('Today');
    expect(closedDayLabel('2026-11-04T09:00:00.000Z', now, 'UTC')).toBe('Yesterday');
    expect(closedDayLabel('2026-11-03T09:00:00.000Z', now, 'UTC')).toBe('Tue Nov 3');
  });

  it('only engine closes in the window count', () => {
    const at = (d: string) => `2026-11-${d}T12:00:00.000Z`;
    const items = [
      { id: 'a', state: 'done', doneBy: 'engine', doneAt: at('05') },
      { id: 'b', state: 'done', doneBy: 'user', doneAt: at('05') },
      { id: 'c', state: 'open', doneBy: null, doneAt: null },
      { id: 'd', state: 'done', doneBy: 'engine', doneAt: at('01') },
    ];
    expect(closedForYouSince(items, Date.parse(at('03'))).map((w) => w.id)).toEqual(['a']);
  });
});

describe('SETTLE-1: Triage ▸ Closed for you on the mock DataSource', () => {
  let ds: MockDataSource;
  beforeAll(() => {
    ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
  });
  afterAll(() => ds.dispose());

  it('is the last group: engine closes, newest first, each with its reason, its message and Undo', async () => {
    const t = TriagePayload.parse(await ds.getTriage({} as never));
    expect(t.groups.at(-1)!.group).toBe('closed_for_you');
    const g = group(t, 'closed_for_you')!;
    expect(g.label).toBe('Closed for you');
    expect(g.items.map((i) => i.id)).toEqual(CLOSED);
    for (const it of g.items) {
      expect(it.workItem).toMatchObject({ state: 'done', doneBy: 'engine' });
      expect(it.undoAuditId).toBe(`aud_seed_${it.id}`);
      expect(it.why.length).toBeGreaterThan(0);
    }
    const dates = g.items.map((i) => i.createdAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(closedBadge(g.items[0]!.workItem!).label).toMatch(/^Resolved by /);
  });

  it('never counts toward Triage or the nav badge', async () => {
    const t = TriagePayload.parse(await ds.getTriage({} as never));
    const closed = group(t, 'closed_for_you')!.items.length;
    expect(closed).toBeGreaterThan(0);
    const guesses = t.groups.filter((g) => g.group !== 'closed_for_you').reduce((n, g) => n + g.items.length, 0);
    expect(t.count).toBe(guesses);
    const today = TodayPayload.parse(await ds.getToday({} as never));
    expect(today.triageCount).toBe(guesses);
    expect(today.navCounts.triage).toBe(guesses);
    // the optimistic patch: taking a closed row out leaves the count alone
    const after = withoutTriageItem(t, CLOSED[0]!);
    expect(after.count).toBe(t.count);
    expect(group(after, 'closed_for_you')!.items.length).toBe(closed - 1);
  });

  it('a closed row cannot be accepted or dismissed as a guess', async () => {
    await expect(ds.acceptTriage({ params: { id: CLOSED[0]! }, body: {} } as never)).rejects.toThrow(/not found/i);
    await expect(ds.dismissTriage({ params: { id: CLOSED[0]! }, body: { reason: 'other' } } as never)).rejects.toThrow(/not found/i);
  });

  it('Undo puts it back and it leaves the group; Reopen does the same without an audit id', async () => {
    const before = TriagePayload.parse(await ds.getTriage({} as never));
    const row = group(before, 'closed_for_you')!.items.find((i) => i.id === CLOSED[1]) as TriageItem;
    await ds.undoAudit({ params: { id: row.undoAuditId! }, body: {} } as never);
    const item = (await ds.getItem({ params: { id: CLOSED[1]! } })).item;
    expect(item.state).not.toBe('done');
    let t = TriagePayload.parse(await ds.getTriage({} as never));
    expect(group(t, 'closed_for_you')!.items.map((i) => i.id)).not.toContain(CLOSED[1]);

    const other = group(t, 'closed_for_you')!.items.find((i) => i.id === CLOSED[2])!;
    const r = await ds.itemAction({ params: { id: other.id, verb: 'reopen' }, body: { ifVersion: other.workItem!.version, note: 'Reopened from Closed for you' } } as never);
    expect(r.entity.state).toBe('reopened');
    t = TriagePayload.parse(await ds.getTriage({} as never));
    expect(group(t, 'closed_for_you')!.items.map((i) => i.id)).toEqual([CLOSED[0]]);
  });
});

describe('SETTLE-1: Home says what closed since you left', () => {
  let ds: MockDataSource;
  beforeAll(() => {
    ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
  });
  afterAll(() => ds.dispose());

  it('counts engine closes since lastActiveAt and links to the group', async () => {
    const h = HomePayload.parse(await ds.getHome({ query: { wide: false } }));
    expect(h.closedForYou).toMatchObject({ count: CLOSED.length, href: '/triage#closed_for_you' });
  });

  it('is off with "Tell me what closed" off, and absent when nothing closed since you left', () => {
    const src = ds as unknown as Parameters<typeof homeInputFromStore>[0];
    const input = homeInputFromStore(src, false);
    expect(buildHome({ ...input, closedSince: null }).closedForYou).toBeNull();
    expect(buildHome({ ...input, closedSince: input.now }).closedForYou).toBeNull();
  });

  it('the setting turns it off through PATCH /settings/closing', async () => {
    const s = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'closing' }, body: { ifVersion: s.closing.version, value: { tellMeWhatClosed: false } } } as never);
    const h = HomePayload.parse(await ds.getHome({ query: { wide: false } }));
    expect(h.closedForYou).toBeNull();
    const after = await ds.getSettings({} as never);
    expect(after.closing).toMatchObject({ tellMeWhatClosed: false, enabled: true, strictness: 'balanced' });
    expect(after.closing.reasons.done_by_you).toBe('close');
  });
});
