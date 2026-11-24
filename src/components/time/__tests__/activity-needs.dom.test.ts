// @vitest-environment jsdom
/**
 * Activity's "Needs you here" (D-86, 18-ui-polish.md): under the page's sentence and tabs, as a section inside the
 * view (and so inside its scroll), never a fixed block above the header. ActivityHead draws whatever the page puts
 * in ActivityNeedsSlot under the tabs; no slot, nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@/contract';
import { $, $$, cleanup, click, render } from '../../composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/activity',
  useSearchParams: () => new URLSearchParams(),
}));

const { ActivityHead, ActivityNeedsSlot } = await import('../ActivityHead');
const { CompactActivityRow, CompactGroupHeader } = await import('../CompactActivityRow');

const entry = (o: Partial<ActivityEntry> = {}): ActivityEntry =>
  ({
    id: 'r1', version: 1, date: '2026-11-10', start: '2026-11-10T16:00:00.000Z', end: '2026-11-10T17:30:00.000Z', durationH: 1.5, taskType: 'Demo', oppId: null, oppName: null, accountName: null,
    meetingType: 'CF', description: 'Roadmap call with Globex', status: 'needs_input', confidence: 'guess', sources: [], userLockedFields: [], issues: [], updatedAt: '2026-11-10T17:30:00.000Z',
    fromOrg62: false, excludedReason: null, loggedAt: null, verifiedAt: null, internal: false, dismissSource: null, logNote: null, logNoteBasis: null, why: null, suggestion: null, ...o,
  }) as ActivityEntry;

afterEach(() => cleanup());

describe('Activity: Needs you here', () => {
  it('sits under the tabs, after the sentence, inside the head the scroll container holds', async () => {
    await render(h(ActivityNeedsSlot, { value: h('div', { 'data-testid': 'queue' }, 'Needs you here') }, h(ActivityHead, { sentence: 'Q4 · 3 rows ready', tabs: h('nav', { 'data-testid': 'tabs' }, 'To log') })));
    const head = $('[data-activity-head]')!;
    const kids = [...head.children];
    const tabs = kids.findIndex((k) => k.matches('[data-testid="tabs"]'));
    const needs = kids.findIndex((k) => k.matches('[data-testid="activity-needs"]'));
    expect(tabs).toBeGreaterThan(0);
    expect(needs).toBe(tabs + 1);
    expect(head.textContent!.indexOf('Q4 · 3 rows ready')).toBeLessThan(head.textContent!.indexOf('Needs you here'));
    // a plain wrapper: the queue is the "Needs you here" section, so the landmark is not named twice (30-a11y)
    expect($('[data-testid="activity-needs"]')!.tagName).toBe('DIV');
    expect($('[data-testid="activity-needs"]')!.hasAttribute('aria-label')).toBe(false);
  });

  it('draws nothing without a slot (History, VDP, the Review page)', async () => {
    await render(h(ActivityHead, { sentence: 'History', tabs: h('nav', null, 'History') }));
    expect($('[data-testid="activity-needs"]')).toBeNull();
  });

  it('the compact row: "87% likely" in the AI colour, ✓ at the settle line, the name read out in full', async () => {
    const s = { kind: 'opp' as const, oppId: '006A', oppName: 'Data 360 Expansion', accountName: 'Globex', taskType: null, confidence: 0.87, reason: 'the meeting names Globex', basis: 'rules' as const, at: null };
    const onOpen = vi.fn();
    await render(h(CompactActivityRow, { e: entry({ suggestion: s }), editor: () => h('select', { 'aria-label': 'Task type' }), settle: 0.75, tz: 'UTC', verb: { label: 'Accept', onClick: vi.fn() }, onOpen }));
    const pctEl = $('[data-testid="where-percent"]')!;
    expect(pctEl.textContent).toBe('87% likely');
    expect(pctEl.className).toContain('text-ai-700');
    expect($('[data-testid="where-sure"]')).not.toBeNull();
    expect($('[data-slot="where"]')!.getAttribute('aria-label')).toBe('87 percent likely Globex · Data 360 Expansion');
    expect($('[data-row]')!.getAttribute('aria-label')).toBe('Roadmap call with Globex');
    expect($('[data-slot="lead"]')!.textContent).toBe('Tue 10 16:00');
    expect($('[data-slot="amount"]')!.textContent).toBe('1.5 h');
    // no picker until the row is edited
    expect($('[aria-label="Task type"]')).toBeNull();
    expect($('[aria-label="Hours"]')).toBeNull();
    await click($('[data-testid="row-chevron"]'));
    expect(onOpen).toHaveBeenCalledWith('r1');
  });

  it('the compact row: under the line there is no ✓; with nothing to go on it says Pick an opp; a failure takes the cell', async () => {
    const s = { kind: 'opp' as const, oppId: '006A', oppName: 'Data 360 Expansion', accountName: 'Globex', taskType: null, confidence: 0.6, reason: 'r', basis: 'ai' as const, at: null };
    await render(h(CompactActivityRow, { e: entry({ suggestion: s }), editor: () => h('select', { 'aria-label': 'Task type' }), settle: 0.75, onOpen: vi.fn() }));
    expect($('[data-testid="where-percent"]')!.textContent).toBe('60% likely');
    expect($('[data-testid="where-sure"]')).toBeNull();
    await cleanup();
    await render(h(CompactActivityRow, { e: entry(), editor: () => h('select', { 'aria-label': 'Task type' }), settle: 0.75, onOpen: vi.fn() }));
    expect($('[data-where="pick"]')!.textContent).toBe('Pick an opp');
    expect($('[data-where="pick"]')!.className).toContain('text-warning-700');
    await cleanup();
    await render(h(CompactActivityRow, { e: entry(), editor: () => h('select', { 'aria-label': 'Task type' }), settle: 0.75, failure: 'Not found in Org62 after the batch ran', onOpen: vi.fn() }));
    // R2-10: the short reason in the row, the whole sentence as its title
    expect($('[data-slot="where"]')!.textContent).toBe('▲Not found in Org62');
    expect($('[data-slot="where"]')!.getAttribute('title')).toBe('Not found in Org62 after the batch ran');
  });

  it('the compact group header: tick, label with count, one verb', async () => {
    await render(h(CompactGroupHeader, { id: 'g1', label: 'Suggested: Globex · Data 360 Expansion', count: 9, check: { checked: false, onChange: vi.fn(), label: 'Tick the group' }, verb: { label: 'Accept 9', onClick: vi.fn() } }));
    const row = $('[data-row]')!;
    expect(row.getAttribute('aria-label')).toBe('Suggested: Globex · Data 360 Expansion, 9');
    expect(row.textContent).toContain('Accept 9');
  });

  it('the page mounts the queue into the slot, not above the view', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../../app/activity/_activity/ActivityPage.tsx'), 'utf8');
    expect(src).toMatch(/<ActivityNeedsSlot value=\{showNeeds \? <NeedsQueue/);
    expect(src).not.toMatch(/data-testid="activity-needs"/);
  });
});

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { FixLane } = await import('../FixLane');
const { needsYou } = await import('../path-derive');

describe('To log ▸ lane 1, Fix or approve (C4)', () => {
  const s = { kind: 'opp' as const, oppId: '006A', oppName: 'Data 360 Expansion', accountName: 'Globex', taskType: null, confidence: 0.87, reason: 'r', basis: 'rules' as const, at: null };
  const day = (i: number) => `2026-11-${String(10 + i).padStart(2, '0')}`;
  const rows = Array.from({ length: 10 }, (_, i) => entry({ id: `g${i}`, date: day(i), start: `${day(i)}T16:00:00.000Z`, suggestion: s }));
  const internal = [entry({ id: 'i1', internal: true, status: 'proposed', taskType: 'Asset Creation' }), entry({ id: 'i2', internal: true, status: 'proposed', taskType: 'Travel' })];
  const mountLane = () =>
    render(h(QueryClientProvider, { client: new QueryClient() }, h(FixLane, { needs: needsYou(rows), internal: { rows: internal }, settle: 0.75, taskTypeRequired: true, taskTypes: ['Demo'], internalActivity: true, onOpen: vi.fn(), tz: 'UTC' })));

  it('a group shows 8 rows, then "Show 2 more in this group"; its rows do not repeat the opp the label names', async () => {
    await mountLane();
    const g = $('[data-fix-group="sugg:006A"]')!;
    expect($('[data-row]', g)!.getAttribute('aria-label')).toBe('Suggested: Globex · Data 360 Expansion, 10');
    expect($('[data-testid="group-accept"]', g)!.textContent).toBe('Accept 10');
    expect($$('[data-fix-row]', g)).toHaveLength(8);
    expect($('[data-fix-row="g0"] [data-slot="where"]', g)!.textContent).toBe('87%✓');
    const more = $('[data-testid="group-more"]', g)!;
    expect(more.textContent).toBe('Show 2 more in this group');
    await click($('button', more));
    expect($$('[data-fix-row]', g)).toHaveLength(10);
    expect($('[data-testid="group-more"]', g)).toBeNull();
  });

  it('C11 bands: Accept (sure suggestions, Internal) then Review (a guess, none): grayed, "47% · review" / "Pick an opp", no group Accept, outside Accept N', async () => {
    const guess = { ...s, oppId: '006B', oppName: 'Pilot', accountName: 'Initech', confidence: 0.47 };
    const mixed = [...rows, entry({ id: 'q1', date: day(1), start: `${day(1)}T18:00:00.000Z`, suggestion: guess }), entry({ id: 'n1', date: day(2), start: `${day(2)}T18:00:00.000Z` })];
    await render(h(QueryClientProvider, { client: new QueryClient() }, h(FixLane, { needs: needsYou(mixed), internal: { rows: internal }, settle: 0.75, taskTypeRequired: true, taskTypes: ['Demo'], internalActivity: true, onOpen: vi.fn(), tz: 'UTC' })));
    // the band headers, with counts, Accept first
    expect($('[data-testid="fix-band-accept"]')!.textContent).toMatch(/^Accept 10 · Internal 2/); // R3-4: counted rows, Internal apart
    expect($('[data-testid="fix-band-review"]')!.textContent).toMatch(/^Review 2/);
    expect($('[data-testid="fix-band-accept"]')!.compareDocumentPosition($('[data-testid="fix-band-review"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the Review groups: grayed rows, the where cell in plain words, never ticked, no group Accept; each row still has its Accept
    const review = $$('[data-fix-group][data-band="review"]');
    expect(review.length).toBe(2);
    for (const g of review) {
      expect(g.className).toContain('text-muted');
      expect($('[data-testid="group-accept"]', g)).toBeNull();
      for (const b of $$('[data-fix-row] input[type="checkbox"]', g)) expect((b as HTMLInputElement).checked).toBe(false);
    }
    expect($('[data-fix-row="q1"] [data-slot="where"]')!.textContent).toBe('47% · review');
    expect($('[data-fix-row="q1"] [data-testid="where-sure"]')).toBeNull();
    expect($('[data-fix-row="q1"] [data-testid="row-accept"]')).not.toBeNull();
    expect($('[data-fix-row="n1"] [data-where="pick"]')!.textContent).toBe('Pick an opp');
    // accept-all never takes a guess: the 10 sure ones only
    expect($('[data-testid="fix-accept-all"]')!.textContent).toBe('Accept 10 suggestions');
  });

  it('Internal never counts on the header; its group keeps the #time-internal anchor; the header accepts every suggestion', async () => {
    await mountLane();
    expect($('#time-needs')).not.toBeNull();
    expect($('[data-testid="fix-count"]')!.textContent).toBe('10');
    expect($('[data-fix-group="internal"]')!.dataset.counted).toBe('false');
    expect($('#time-internal [data-row]')!.getAttribute('aria-label')).toBe('Suggested: Internal, 2');
    expect($('[data-testid="fix-accept-all"]')!.textContent).toBe('Accept 10 suggestions');
  });

  it('R2-8: j / k move focus across rows and onto the next group header (the kit RowGrid), Space ticks', async () => {
    await mountLane();
    expect($('[data-testid="fix-groups"] [role="grid"]')!.getAttribute('aria-label')).toBe('Fix or approve');
    const key = (el: HTMLElement, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
    const header = $('[data-fix-group="sugg:006A"] [data-group-id]')!;
    const first = $('[data-fix-row="g0"] [data-row]')!;
    header.focus();
    await key(header, 'j');
    expect(document.activeElement).toBe(first);
    await key(first, 'j');
    expect(document.activeElement).toBe($('[data-fix-row="g1"] [data-row]'));
    // the last shown row of the first group: j goes onto the Internal group's header
    const last = $('[data-fix-row="g7"] [data-row]')!;
    last.focus();
    await key(last, 'j');
    const internalHead = $('#time-internal [data-row]')!;
    expect(document.activeElement).toBe(internalHead);
    await key(internalHead, 'k');
    expect(document.activeElement).toBe(last);
    await key(last, ' ');
    expect($('[data-testid="needs-selected"]')!.textContent).toBe('1 ticked · 1.5 h');
  });

  it('R2-13: a row that changes group mid-edit keeps its place and its editor until the editor closes', async () => {
    const lane = (rs: ActivityEntry[]) => h(QueryClientProvider, { client }, h(FixLane, { needs: needsYou(rs), internal: { rows: internal }, settle: 0.75, taskTypeRequired: true, taskTypes: ['Demo'], internalActivity: true, onOpen: vi.fn(), tz: 'UTC' }));
    const client = new QueryClient();
    const r = await render(lane(rows));
    await click($('[data-fix-row="g0"] [data-slot="where"]'));
    expect($('[data-fix-group="sugg:006A"] [data-fix-row="g0"] [data-slot="editor"]')).not.toBeNull();
    // the opp is set (elsewhere or by this editor) and the row now lacks only its type: another group, same row
    const set = rows.map((e) => (e.id === 'g0' ? { ...e, oppId: '006A', oppName: 'Data 360 Expansion', accountName: 'Globex', suggestion: null, taskType: null, version: 2 } : e));
    await act(async () => r.root.render(lane(set)));
    expect($('[data-fix-group="sugg:006A"] [data-fix-row="g0"] [data-slot="editor"]')).not.toBeNull();
    expect($$('[data-fix-row="g0"]')).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/more rows? ·|1 more row/);
    // the editor closes: the row goes to the group it now belongs to
    await click($('[data-testid="fix-groups"]'));
    await act(async () => void $('[data-fix-row="g0"] [data-slot="editor"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect($('[data-fix-row="g0"] [data-slot="editor"]')).toBeNull();
    expect($('[data-fix-group="sugg:006A"] [data-fix-row="g0"]')).toBeNull();
    expect($('[data-fix-row="g0"]')).not.toBeNull();
  });

  it('a group box ticks the group (mixed when part of it is ticked); the bar has the lane’s verbs', async () => {
    await mountLane();
    await click($('[data-fix-row="g0"] [data-testid="row-check"]'));
    const box = $('[data-fix-group="sugg:006A"] [data-group-id] [data-testid="row-check"]') as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect($('[data-testid="needs-selected"]')!.textContent).toBe('1 ticked · 1.5 h');
    await click(box);
    expect($('[data-testid="needs-selected"]')!.textContent).toBe('10 ticked · 15 h');
    expect($('[data-testid="bulk-accept"]')!.textContent).toBe('Accept 10 suggestions');
    expect($('[data-testid="bulk-internal"]')!.textContent).toBe('Internal');
    expect($('[data-testid="bulk-leave"]')!.textContent).toBe('Leave out');
  });
});
