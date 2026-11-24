/**
 * Home aggregation (src/engines/home): contract shape, capacity rules, Do now, gap rules, no duplicates,
 * caps. Uses the committed placeholder seed (src/mock/seed.example.json) plus one synthetic day that
 * mirrors the design-v2 "corrected capacity" scenario with placeholder names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CalendarEvent, Connector, Draft, HomePayload, Initiative, NbaCard, WorkItem, type HomeRow } from '@/contract';
import { approveMin, handsOnMin } from '@/engines/home/estimate';
import { buildHome } from '@/engines/home/build';
import type { HomeInput } from '@/engines/home/types';
import { ribbonLayout, ribbonMaxLanes } from '@/components/home/model';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { homeInputFromStore } from '@/server/datasource/mock/home';

let ds: MockDataSource;
beforeAll(() => {
  ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
});
afterAll(() => ds.dispose());

const itemIdsIn = (rows: HomeRow[]) => rows.map((r) => r.item?.id ?? (r.entity.kind === 'work_item' ? r.entity.id : null)).filter((x): x is string => !!x);

describe('home: on the example seed', () => {
  it('matches the contract (narrow and wide) and caps rows server-side', async () => {
    const narrow = await ds.getHome({ query: { wide: false } });
    const wide = await ds.getHome({ query: { wide: true } });
    expect(HomePayload.safeParse(narrow).success).toBe(true);
    expect(HomePayload.safeParse(wide).success).toBe(true);
    for (const s of narrow.sections.filter((x) => x.id !== 'initiatives')) expect(s.rows.length).toBeLessThanOrEqual(3);
    for (const s of wide.sections.filter((x) => x.id !== 'initiatives')) expect(s.rows.length).toBeLessThanOrEqual(5);
    const reply = wide.sections.find((s) => s.id === 'reply')!;
    expect(reply.count).toBeGreaterThanOrEqual(reply.rows.length);
    expect(narrow.sections.map((s) => s.id)).toEqual(['reply', 'ahead', 'fix', 'chase', 'initiatives']);
  });

  it('works without a query (the route-wide contract sweep calls it with {})', async () => {
    const h = await (ds.getHome as (i: unknown) => Promise<HomePayload>)({});
    expect(h.wide).toBe(false);
  });

  it("shows Today's capacity (the CAPACITY engine's numbers, not its own)", async () => {
    const h = await ds.getHome({ query: { wide: false } });
    const today = await ds.getToday({} as never);
    const c = today.header.capacity;
    expect(h.capacity).toEqual({
      day: c.day,
      dayLabel: c.dayLabel,
      youMinToday: c.youMinToday,
      freeMin: c.freeMin,
      openMin: c.openMin,
      fits: c.fits,
      agentMinBackground: c.agentMinBackground,
      agentRunsBackground: c.agentRunsBackground,
      pullForward: c.pullForward,
    });
    expect(h.capacity.fits).toBe(h.capacity.youMinToday <= h.capacity.freeMin);
  });

  it('Do now: ≤ 3 cards, rank 1 first, Outbox approvals in the third slot, nothing blocked', async () => {
    const h = await ds.getHome({ query: { wide: false } });
    const cards = h.doNow.cards;
    expect(cards.length).toBe(3);
    expect(cards.map((c) => c.rank)).toEqual([1, 2, 3]);
    expect(cards[0]!.kind).toBe('item');
    expect(cards[0]!.id).toBe('w_acme_build');
    expect(cards[0]!.now?.item.id).toBe('w_acme_build');
    expect(cards[0]!.verb.action).toBe('open_in_claude');
    expect(cards[2]!.kind).toBe('outbox');
    expect(cards[2]!.verb.href).toBe('/outbox');
    expect(cards[2]!.drafts.length).toBeGreaterThan(0);
    expect(h.doNow.total).toBeGreaterThanOrEqual(cards.length);
    for (const c of cards) expect(c.state).not.toBe('blocked');
  });

  it("the Outbox card's queue is every ready draft in the Outbox's pending-approval order; it shows at most 3", async () => {
    const h = await ds.getHome({ query: { wide: false } });
    const outbox = await ds.getOutbox({} as never);
    const pending = outbox.groups.find((g) => g.group === 'pending_approval')!.items.map((i) => i.draft.id);
    const card = h.doNow.cards.find((c) => c.kind === 'outbox')!;
    expect(pending.length).toBeGreaterThan(0);
    expect(card.draftIds).toEqual(pending);
    expect(card.drafts.length).toBeLessThanOrEqual(3);
    expect(card.drafts.map((d) => d.draftId)).toEqual(card.draftIds.slice(0, card.drafts.length));
    expect(card.entity).toMatchObject({ kind: 'draft', id: card.draftIds[0] });
    for (const c of h.doNow.cards.filter((x) => x.kind === 'item')) expect(c.draftIds).toEqual([]);
  });

  it('nothing is listed twice across Do now and the four verb sections', () => {
    const h = buildHome({ ...homeInputFromStore(ds, true), wide: true });
    const all = [
      ...h.doNow.cards.filter((c) => c.kind === 'item').map((c) => c.id),
      ...h.sections.filter((s) => s.id !== 'initiatives').flatMap((s) => itemIdsIn(s.rows)),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('Log & fix names its gaps: a connector to re-auth, the quarter log vs target with its deadline', async () => {
    const h = await ds.getHome({ query: { wide: true } });
    const fix = h.sections.find((s) => s.id === 'fix')!;
    const reauth = fix.rows.find((r) => r.verb.action === 'reauth')!;
    expect(reauth.entity.kind).toBe('connector');
    expect(reauth.state).toBe('overdue');
    expect(reauth.verb.href).toMatch(/^\/health\?connector=/);
    const q = fix.rows.find((r) => r.id === 'gap:quarter_log')!;
    expect(q.progress?.total).toBe(60);
    expect(q.progress!.done).toBeLessThan(60);
    expect(q.stateLabel).toMatch(/^Due /);
    // Time ▸ Week, never bare /time (that opens Forecast for an AE)
    expect(q.verb.href).toBe('/activity?view=week');
    expect(q.href).toBe('/activity?view=week');
    // (the VDP row names its own view, Time ▸ VDP)
    for (const r of fix.rows.filter((x) => x.id.startsWith('gap:') && x.id !== 'gap:quarter_log' && /^\/activity/.test(x.href ?? ''))) expect(r.href).toBe(r.id === 'gap:vdp_open' ? '/activity?view=vdp' : '/activity?view=week');
    expect(fix.seeAllHref).toBe('/activity?view=week');
    // Broken first.
    expect(fix.rows[0]!.state).toBe('overdue');
  });

  it('the quarter log and the Org62 handed-off rows are one Log & fix row, with both details', async () => {
    const h = await ds.getHome({ query: { wide: true } });
    const fix = h.sections.find((s) => s.id === 'fix')!;
    const q = fix.rows.find((r) => r.id === 'gap:quarter_log')!;
    expect(fix.rows.some((r) => r.id === 'gap:org62_unlogged')).toBe(false);
    // the quarter's progress and deadline …
    expect(q.progress?.total).toBe(60);
    expect(q.stateLabel).toMatch(/^Due /);
    // … and the Org62 detail: how many handed-off rows, their hours on the canvas, the last day logged in Org62
    expect(q.why).toMatch(/to confirm \d+ handed-off rows? \(~[\d.]+ h on the [^)]+\) · (none in Org62 after \d+\/\d+|nothing in Org62 yet)/);
    expect(q.verb.label).toMatch(/^Confirm \d+$/);
  });

  it('Chase lists waiting-on-others first, then promises oldest first', async () => {
    const h = await ds.getHome({ query: { wide: true } });
    const chase = h.sections.find((s) => s.id === 'chase')!;
    const kinds = chase.rows.map((r) => r.kind);
    expect(kinds.indexOf('promise')).toBeGreaterThan(kinds.lastIndexOf('waiting'));
    const ages = chase.rows.filter((r) => r.kind === 'promise' && r.dateLabel).map((r) => Number.parseInt(r.dateLabel!, 10));
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
    expect(h.footer.chase.count).toBe(chase.count);
  });

  it('the 14-day strip starts tomorrow and runs on consecutive days', async () => {
    const h = await ds.getHome({ query: { wide: false } });
    expect(h.aheadStrip).toHaveLength(14);
    const days = h.aheadStrip.map((d) => Date.parse(`${d.date}T12:00:00Z`));
    for (let i = 1; i < days.length; i++) expect(days[i]! - days[i - 1]!).toBe(86_400_000);
    expect(h.aheadStrip.every((d) => d.risk <= d.count)).toBe(true);
  });

  it('refreshes from the store: marking the #1 card done moves it out of Do now', async () => {
    const local = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
    try {
      const before = await local.getHome({ query: { wide: false } });
      const first = before.doNow.cards[0]!;
      await local.itemAction({ params: { id: first.id, verb: 'done' }, body: { ifVersion: first.now!.item.version } } as never);
      const after = await local.getHome({ query: { wide: false } });
      expect(after.doNow.cards.map((c) => c.id)).not.toContain(first.id);
    } finally {
      local.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Hands-on estimates
// ---------------------------------------------------------------------------

describe('home: per-item hands-on labels come from the priority estimator', () => {
  it("uses the item's own (calibrated) estimate, never adds agent time, and waiting costs nothing", () => {
    expect(handsOnMin({ kind: 'task', state: 'open', title: 'Smoke-test both demos', effort: { youMin: 20, agentMin: 20 } })).toBe(20);
    expect(handsOnMin({ kind: 'ask', state: 'open', title: 'Answer Pat', effort: { youMin: 5, agentMin: 0 } })).toBe(5);
    expect(handsOnMin({ kind: 'task', state: 'waiting_on_others', title: 'Get Sam’s answer', effort: { youMin: 10, agentMin: 0 } })).toBe(0);
    expect(approveMin(3)).toBeGreaterThanOrEqual(3);
    expect(approveMin(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A synthetic day (placeholder names) mirroring the corrected-capacity mockup
// ---------------------------------------------------------------------------

const TZ = 'America/Denver';
const NOW = '2026-11-05T15:22:00.000Z'; // Thu 08:22 MT
const at = (hhmm: string, dayOffset = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  // MT in November is UTC−7.
  return new Date(Date.UTC(2026, 10, 5 + dayOffset, h! + 7, m!)).toISOString();
};

function item(p: Partial<WorkItem> & Pick<WorkItem, 'id' | 'title'>): WorkItem {
  return WorkItem.parse({
    version: 1,
    kind: 'task',
    state: 'open',
    purpose: null,
    initiativeId: null,
    accountId: null,
    oppId: null,
    confidence: 'likely',
    why: 'Because',
    sources: [],
    effort: { youMin: 15, agentMin: 0 },
    startBy: null,
    due: null,
    createdAt: at('07:00', -1),
    updatedAt: at('07:00'),
    ageDays: 1,
    rank: null,
    rankReasons: [],
    refs: { initiative: null, account: null, opp: null, meeting: null },
    ...p,
  });
}
const ev = (p: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'title' | 'start' | 'end'>) => CalendarEvent.parse({ attendance: 'upcoming', source: { kind: 'calendar', label: 'Calendar' }, ...p });
const nbaCard = (p: Partial<NbaCard> & Pick<NbaCard, 'id' | 'workItemId' | 'verb'>) =>
  NbaCard.parse({ version: 1, primaryLabel: 'Go', confidence: 'likely', title: 'Do it', why: 'Why', sources: [], status: 'ready', generatedAt: at('07:00'), ...p });
const dr = (id: string, workItemId: string | null, status: Draft['status'], who: string) =>
  Draft.parse({
    id,
    version: 1,
    workItemId,
    nbaId: null,
    destination: { kind: 'slack', target: 'dm', channelId: `D_${id}`, channelName: `@${who} Example` },
    mode: 'draft',
    doc: { type: 'doc', content: [] },
    plainText: `Hi ${who}, a quick note`,
    rendered: {},
    userTouched: false,
    status,
    createdAt: at('08:04'),
    updatedAt: at('08:04'),
  });

function syntheticDay(): HomeInput {
  const review = ev({ id: 'ev_review', title: 'ACME Data Program - Review', start: at('13:30'), end: at('14:30'), isCustomerFacing: true, accountId: 'acc_acme', prep: { ready: false, label: 'smoke-test demos ›', workItemId: 'w_smoke' } });
  const ini = Initiative.parse({ id: 'ini_acme', version: 1, title: 'ACME review', purpose: 'Land the review', summary: '', status: 'active', accountId: 'acc_acme', oppId: null, targetEventId: 'ev_review', createdAt: at('07:00', -5), updatedAt: at('07:00') });
  const acmeRef = { type: 'account' as const, id: 'acc_acme', label: 'ACME Corporation' };
  const items = [
    item({ id: 'w_smoke', title: 'Smoke-test both ACME demos before the 13:30 review', kind: 'task', rank: 1, effort: { youMin: 20, agentMin: 20 }, startBy: at('08:35'), due: at('13:00'), servesEventId: 'ev_review', initiativeId: 'ini_acme', accountId: 'acc_acme', nbaId: 'n_smoke', refs: { initiative: null, account: acmeRef, opp: null, meeting: null } }),
    item({ id: 'w_sizing', title: 'Back-work the Globex numbers against the use cases', kind: 'commitment', rank: 2, effort: { youMin: 50, agentMin: 0 }, startBy: at('09:05'), due: at('17:00'), nbaId: 'n_sizing', readInState: 'ready', refs: { initiative: null, account: { type: 'account', id: 'acc_globex', label: 'Globex Inc.' }, opp: null, meeting: null } }),
    item({ id: 'w_answer', title: 'Answer Pat: same demo or a new use case?', kind: 'ask', rank: 3, effort: { youMin: 5, agentMin: 0 }, due: at('14:30'), nbaId: 'n_answer', readInState: 'stale', people: [{ id: 'p_sam', name: 'Sam Example' }], counterparty: { id: 'p_pat', name: 'Pat Example' } }),
    item({ id: 'w_sam', title: 'Get Sam’s answer on the onsite', kind: 'task', state: 'waiting_on_others', effort: { youMin: 10, agentMin: 0 }, due: at('14:30'), nbaId: 'n_sam', readInState: 'researching', waiting: { on: 'others', reason: 'Waiting on Sam', who: { id: 'p_sam', name: 'Sam Example' }, since: at('07:34') } }),
    item({ id: 'w_log', title: 'Submit the Q4 activity log', kind: 'deliverable', rank: 6, effort: { youMin: 30, agentMin: 20 }, due: at('12:00', 1) }),
    item({ id: 'w_prepcall', title: 'Huddle with the team before the review', kind: 'task', state: 'in_progress', rank: 7, effort: { youMin: 30, agentMin: 0 }, due: at('09:00') }),
    item({ id: 'w_old', title: 'Package the demo app for Kim', kind: 'commitment', isBackground: true, ageDays: 69, effort: { youMin: 60, agentMin: 30 } }),
  ];
  const events = [
    review,
    ev({ id: 'ev_prep', title: 'ACME Presentation Prep', start: at('08:00'), end: at('08:30'), attendance: 'in_progress', prep: { ready: true, label: 'huddle ›', workItemId: 'w_prepcall' } }),
    ev({ id: 'ev_team', title: 'Team planning', start: at('09:00'), end: at('10:00') }),
    ev({ id: 'ev_check', title: 'Partner check-in', start: at('09:30'), end: at('10:00') }),
    ev({ id: 'ev_tap', title: 'Tableau on Tap', start: at('09:30'), end: at('10:30'), attendance: 'declined' }),
    ev({ id: 'ev_sync', title: 'Practice sync', start: at('10:00'), end: at('11:00') }),
    ev({ id: 'ev_weekly', title: 'Weekly', start: at('11:30'), end: at('12:00'), attendance: 'declined' }),
    ev({ id: 'ev_int', title: '[Internal] Use Case Prep', start: at('14:30'), end: at('15:00') }),
  ];
  const nbas = [
    nbaCard({ id: 'n_smoke', workItemId: 'w_smoke', verb: 'start_in_claude', primaryLabel: 'Open in Claude' }),
    nbaCard({ id: 'n_sizing', workItemId: 'w_sizing', verb: 'send', primaryLabel: 'Send', draftId: 'd_sizing' }),
    nbaCard({ id: 'n_answer', workItemId: 'w_answer', verb: 'send', primaryLabel: 'Send', draftId: 'd_answer', alternatives: [{ verb: 'nudge', label: 'Nudge Sam first', reason: 'His answer decides' }] }),
    nbaCard({ id: 'n_sam', workItemId: 'w_sam', verb: 'nudge', primaryLabel: 'Approve nudge', draftId: 'd_nudge' }),
  ];
  const drafts = [dr('d_sizing', 'w_sizing', 'drafting', 'Lee'), dr('d_answer', 'w_answer', 'drafting', 'Pat'), dr('d_nudge', 'w_sam', 'ready', 'Sam'), dr('d_mia', null, 'ready', 'Mia'), dr('d_list', null, 'ready', 'Ana')];
  const connectors = [
    Connector.parse({ id: 'slack', label: 'Slack', source: 'slack', state: 'ok', since: at('07:00'), lastSuccessAt: at('08:00'), cursor: { label: 'now', at: at('08:00') } }),
    Connector.parse({ id: 'vdp', label: 'VDP', source: 'vdp', state: 'auth_needed', since: at('09:00', -10), lastSuccessAt: null, cursor: { label: '', at: null }, impact: 'Links unverified since 10/26; updates cannot be checked', reauth: { kind: 'refresh_script', label: 'Re-auth VDP' } }),
  ];
  return {
    now: NOW,
    timezone: TZ,
    workingHours: { start: '07:30', end: '17:30', days: [1, 2, 3, 4, 5] },
    wide: false,
    items,
    nbas,
    drafts,
    proposals: [],
    events,
    slots: [],
    initiatives: [ini],
    accounts: [{ id: 'acc_acme', name: 'ACME Corporation', industry: null, dcStatus: 'assigned', vdpStatus: 'linked', hoursQtd: 0, team: [], org62Url: null, notes: '' }],
    opps: [],
    missedOpps: [],
    activity: [],
    connectors,
    agentRuns: [],
    briefs: [],
    quarter: { label: 'Q4 FY27', targetH: 60, due: at('12:00', 1), loggedH: 18.5 },
    canvasLabel: 'Work-order canvas',
    since: { changed: 1, closed: 4, new: 10, show: true },
    spend: { usd: 0.64, softBudgetUsd: 5 },
    dryRun: true,
    capacity: { day: 'today', dayLabel: 'today', youMinToday: 92, freeMin: 390, openMin: 298, fits: true, agentMinBackground: 20, agentRunsBackground: 1, pullForward: [{ itemId: 'w_log', title: 'Submit the Q4 activity log', youMin: 30, due: at('12:00', 1) }] },
  };
}

describe('HOME-1: a fresh first scan ranks nothing yet', () => {
  it('Do now still fills with live work by its due date, never "nothing needs you" over open work', () => {
    const day = syntheticDay();
    // nothing ranked, nothing due today (the stage-4 shape: replies overdue from earlier days)
    const items = day.items.map((w) => ({ ...w, rank: null, due: w.due && w.due >= day.now ? '2026-11-01T17:00:00.000Z' : w.due, startBy: null }));
    const h = buildHome({ ...day, items, drafts: [], slots: [] });
    const ids = h.doNow.cards.filter((c) => c.kind === 'item').map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(2); // the rest are blocked, waiting, background or held by a meeting
    for (const id of ids) {
      const w = items.find((x) => x.id === id)!;
      expect(w.state === 'waiting_on_others' || w.isBackground).toBe(false);
    }
  });
});

describe('home: a synthetic day (the corrected-capacity scenario)', () => {
  const h = buildHome(syntheticDay());

  it('is a valid payload', () => {
    expect(HomePayload.safeParse(h).success).toBe(true);
  });

  it('passes the CAPACITY numbers through (~1h 32m of you, ~5h open, fits) and pulls the Q4 log forward', () => {
    expect(h.capacity).toEqual(syntheticDay().capacity);
    expect(h.capacity.pullForward[0]!.itemId).toBe('w_log');
  });

  it('read-ins ride on their items: violet note data on the card, the blocked row and the chase row', () => {
    expect(h.doNow.cards.find((c) => c.id === 'w_sizing')!.readInState).toBe('ready');
    const answer = h.sections.find((s) => s.id === 'reply')!.rows.find((r) => r.id === 'w_answer')!;
    expect(answer.readInState).toBe('stale');
    expect(h.sections.find((s) => s.id === 'chase')!.rows.find((r) => r.id === 'w_sam')!.readInState).toBe('researching');
    expect(h.doNow.cards.find((c) => c.id === 'w_smoke')!.readInState).toBeUndefined();
  });

  it('Do now is the smoke test, the sizing and the Outbox; the blocked answer is #4 in Respond', () => {
    expect(h.doNow.cards.map((c) => c.id)).toEqual(['w_smoke', 'w_sizing', 'outbox']);
    expect(h.doNow.cards[0]!.stateLabel).toBe('Start by 08:35');
    expect(h.doNow.cards[2]!.title).toBe('Approve 3 drafts');
    expect(h.doNow.total).toBe(5);
    expect(h.doNow.elsewhereNote).toBe('#4 is in Respond, #5 in Log & fix.');
    const answer = h.sections.find((s) => s.id === 'reply')!.rows.find((r) => r.id === 'w_answer')!;
    expect(answer.state).toBe('blocked');
    expect(answer.why).toBe('~5m once Sam answers');
  });

  it('the masthead names the focal meeting and the day in one sentence', () => {
    const text = h.masthead.sentence.map((s) => s.text).join('');
    expect(text).toBe('Today turns on the 13:30 ACME review: smoke-test both demos by 08:35, back-work the Globex numbers by 17:00, and approve 3 drafts.');
    expect(h.masthead.sentence.filter((s) => s.em).map((s) => s.text)).toEqual(['13:30', 'ACME', '08:35', 'Globex', '17:00']);
    expect(h.masthead.ahead.map((s) => s.text).join('')).toMatch(/^Tomorrow: Q4 log due 12:00, 18.5 of 60 h in\./);
    expect(h.masthead.tzLabel).toBe('MT');
  });

  it('the ribbon draws meetings on real time, declined ghosts, now, and one open block with the pull-forward', () => {
    const r = h.ribbon;
    expect(r.start).toBe(at('08:00'));
    expect(r.end).toBe(at('17:30'));
    const kinds = r.blocks.map((b) => `${b.kind}:${b.title}`);
    expect(kinds.filter((k) => k.startsWith('declined'))).toHaveLength(2);
    expect(r.blocks.find((b) => b.eventId === 'ev_prep')!.state).toBe('now');
    expect(r.blocks.find((b) => b.eventId === 'ev_review')!.state).toBe('risk');
    const open = r.blocks.filter((b) => b.kind === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toBe('15:00–17:30 open');
    expect(open[0]!.note).toMatch(/^Pull forward: Submit the Q4 activity log/);
  });

  it('the ribbon keeps the 09:00/09:30 overlap as two blocks; ribbonLayout stacks them and bands the declined ghost', () => {
    const blocks = h.ribbon.blocks;
    const team = blocks.findIndex((b) => b.eventId === 'ev_team');
    const check = blocks.findIndex((b) => b.eventId === 'ev_check');
    const tap = blocks.findIndex((b) => b.eventId === 'ev_tap');
    const sync = blocks.findIndex((b) => b.eventId === 'ev_sync');
    expect(Math.min(team, check, tap, sync)).toBeGreaterThanOrEqual(0);
    const places = ribbonLayout(blocks, Date.parse(h.ribbon.end));
    expect([places[team]!.lane, places[check]!.lane].sort()).toEqual([0, 1]);
    expect(places[team]!.lanes).toBe(2);
    expect(places[check]!.lanes).toBe(2);
    expect(places[check]!.spill).toBe(false);
    // 10:00 practice sync is back to back with the pair: full height, but over the declined 09:30–10:30 band.
    expect(places[sync]).toMatchObject({ lanes: 1, overBand: true });
    expect(places[tap]).toMatchObject({ band: true });
    expect(ribbonMaxLanes(places)).toBe(2);
  });

  it("the Outbox card's queue holds every ready draft, most recently updated first; the card lists 3 and +N more", () => {
    const base = syntheticDay();
    const ready = ['d_r1', 'd_r2', 'd_r3', 'd_r4', 'd_r5', 'd_r6'].map((id, i) => ({ ...dr(id, null, 'ready', `Who${i + 1}`), updatedAt: at(`08:0${i}`) }));
    const out = buildHome({ ...base, drafts: [...base.drafts.filter((d) => d.status !== 'ready'), ...ready] });
    const card = out.doNow.cards.find((c) => c.kind === 'outbox')!;
    expect(card.title).toBe('Approve 6 drafts');
    expect(card.draftIds).toEqual(['d_r6', 'd_r5', 'd_r4', 'd_r3', 'd_r2', 'd_r1']);
    expect(card.drafts).toHaveLength(3);
    expect(card.drafts.map((d) => d.draftId)).toEqual(['d_r6', 'd_r5', 'd_r4']);
    expect(card.entity).toMatchObject({ kind: 'draft', id: 'd_r6' });
    expect(HomePayload.safeParse(out).success).toBe(true);
  });

  it('D-52: a logging canvas or a VDP change is applied on Time, so the card approves messages only', () => {
    const base = syntheticDay();
    const msg = { ...dr('d_msg', null, 'ready', 'Dana'), updatedAt: at('08:01') };
    const canvas = { ...dr('d_canvas', null, 'ready', 'Slackbot'), updatedAt: at('08:05'), destination: { kind: 'action' as const, action: 'slack_canvas.create' as const, target: { label: 'Activity log · 2 rows', url: null }, input: {}, changes: [], text: '' } };
    const out = buildHome({ ...base, drafts: [...base.drafts.filter((d) => d.status !== 'ready'), msg, canvas] });
    const card = out.doNow.cards.find((c) => c.kind === 'outbox')!;
    expect(card.draftIds).toEqual(['d_msg']);
    expect(card.title).toBe('Approve 1 draft');
  });

  it('Log & fix leads with the broken connector; Chase holds the waiting answer and the stale promise', () => {
    const fix = h.sections.find((s) => s.id === 'fix')!;
    expect(fix.rows[0]!.title).toBe('Re-auth VDP');
    expect(fix.rows[0]!.stateLabel).toBe('Expired 10/26');
    const chase = h.sections.find((s) => s.id === 'chase')!;
    expect(chase.rows.map((r) => r.id)).toEqual(['w_sam', 'w_old']);
    expect(chase.rows[0]!.why).toBe('Asked 07:34 · blocks your Pat answer');
    expect(chase.rows[1]!.stateLabel).toBe('69 d');
    expect(h.footer.chase.names).toEqual(['Sam']);
  });

});
