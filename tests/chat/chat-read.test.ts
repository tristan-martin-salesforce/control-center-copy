/**
 * The Assistant's read pages (`chat_app_read` page names): the page catalog (GET routes only, none with a side
 * effect), arg checking against the route's own schemas, the model's view (cleaned, dropped keys, version kept,
 * embedded work items, redaction) and its paging (A1: every row reachable, total and nextOffset, valid JSON, never
 * cut), "not logged since the last logged activity" across weeks, every page on the mock DataSource, and the time
 * question end to end through the chat runner. Placeholder data only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, type ActivityEntry, type TimeWeek } from '@/contract';
import { callChatTool, CHAT_ALLOWED_TOOLS, newToolState, untrustedHeader, withoutUntrustedHeader, type ChatToolCtx } from '@/llm/chat/tools';
import { personaOf, renderPersonaBlock } from '@/personas';
import { createChatHost } from '@/server/chat/host';
import { CHAT_READ_PAGES, CHAT_READ_PAGE_NAMES, ChatReadArgsError, cleanForModel, pageForModel, readPage, READ_PAGE_CHARS, sinceLastLogged } from '@/server/chat/read';
import { toolJson } from '@/server/chat/compact';
import type { MockDataSource } from '@/server/datasource/mock';
import { collect, mockWith, of, seed, textOf } from './helpers';

type G = { __ccDataSource?: unknown };
let ds: MockDataSource;

beforeEach(() => {
  ds = mockWith();
  (globalThis as G).__ccDataSource = ds;
});
afterEach(() => {
  delete (globalThis as G).__ccDataSource;
  ds.dispose();
});

const NOW = new Date('2026-11-10T20:00:00.000Z');

let n = 0;
const entry = (start: string, status: ActivityEntry['status'], durationH = 1): ActivityEntry => ({
  id: `a-${++n}`,
  version: 1,
  date: start.slice(0, 10),
  start,
  end: new Date(Date.parse(start) + durationH * 3_600_000).toISOString(),
  durationH,
  taskType: null,
  oppId: null,
  oppName: null,
  accountName: 'ACCOUNT_1',
  meetingType: null,
  description: 'placeholder',
  status,
  confidence: 'likely',
  sources: [],
  userLockedFields: [],
  issues: [],
  updatedAt: start,
  fromOrg62: false,
  excludedReason: null,
  loggedAt: null,
  verifiedAt: null,
  internal: false,
  dismissSource: null,
  logNote: null,
  logNoteBasis: null,
  why: null,
  suggestion: null,
});

const week = (weekStart: string, entries: ActivityEntry[]): TimeWeek =>
  ({
    weekStart,
    weekEnd: weekStart,
    timeline: [],
    entries,
    onsite: [],
    totals: { proposedH: 0, approvedH: 0, loggedH: 0, needsReview: 0 },
    quarter: { label: 'Q', loggedH: 0, targetH: 250, due: null },
    canvas: { lastSyncedAt: null, rowsChangedSince: 0, confirmRequired: false, label: 'Work-order canvas' },
    org62: { lastReadbackAt: null, verified: 0, pending: 0 },
    logCanvases: [],
  }) as TimeWeek;

describe('the read pages', () => {
  it('are GET routes without a side effect, read through read (on the allowlist)', () => {
    expect(CHAT_ALLOWED_TOOLS).toContain('mcp__chat__read');
    // A9: one generic read; the duplicate catalog and the one-to-one bespoke reads are gone
    for (const gone of ['chat_read', 'chat_get_context', 'chat_search_items', 'chat_get_item', 'chat_get_calendar', 'chat_get_outbox', 'chat_get_health']) expect(CHAT_ALLOWED_TOOLS).not.toContain(`mcp__chat__${gone}`);
    for (const p of CHAT_READ_PAGE_NAMES) {
      const r = routes[CHAT_READ_PAGES[p].route] as { method: string; dev?: boolean; stream?: boolean; path: string };
      expect(r.method, p).toBe('GET');
      expect(r.dev, p).toBeFalsy();
      expect(r.stream, p).toBeFalsy();
      // chat and onboarding are not the assistant's pages
      expect(['getChatThread', 'listChatThreads', 'getOnboarding', 'getOnboardingSources'], p).not.toContain(CHAT_READ_PAGES[p].route);
    }
  });

  it("checks args with the route's own schemas and names unknown ones", async () => {
    await expect(readPage(ds, 'history', { week: '2026-11-02' }, { now: NOW })).rejects.toThrow(ChatReadArgsError);
    await expect(readPage(ds, 'history_day', { day: 'tuesday' }, { now: NOW })).rejects.toThrow(/day/);
    await expect(readPage(ds, 'time', { week: '2026-11-02' }, { now: NOW })).resolves.toMatchObject({ page: 'time' });
  });
});

describe('the model view: cleaned, then paged (A1)', () => {
  const rows = (n: number, pad = 30) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `row ${i} `.repeat(pad), version: 3, userLockedFields: ['x'] }));

  it('pages a long list instead of cutting it: every row reachable, total and nextOffset, valid JSON', () => {
    const big = { tab: 'all', rows: rows(500) };
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const p = pageForModel(big, { offset }, 6_000);
      const s = JSON.stringify(p.value);
      expect(s.length).toBeLessThanOrEqual(6_000);
      expect(p.paging).toMatchObject({ list: 'rows', offset, total: 500 });
      // A4: version stays (a PATCH's ifVersion); UI-only keys go
      expect(s).toContain('"version":3');
      expect(s).not.toContain('userLockedFields');
      seen.push(...(p.value as { rows: Array<{ id: string }> }).rows.map((r) => r.id));
      // the first page has the other fields; later pages only their rows
      if (offset === 0) expect(p.value).toHaveProperty('tab', 'all');
      else expect(p.value).not.toHaveProperty('tab');
      offset = p.paging!.nextOffset;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(5);
    expect(seen).toEqual(big.rows.map((r) => r.id));
  });

  it('keeps everything whole when it fits, and pages on request (limit, list)', () => {
    const small = { a: 1, rows: rows(10, 1), other: rows(3, 1) };
    expect(pageForModel(small).paging).toBeNull();
    expect((pageForModel(small).value as { rows: unknown[] }).rows).toHaveLength(10);
    const p = pageForModel(small, { limit: 4 });
    expect(p.paging).toEqual({ list: 'rows', offset: 0, count: 4, total: 10, nextOffset: 4 });
    const o = pageForModel(small, { list: 'other', offset: 1 });
    expect(o.paging).toEqual({ list: 'other', offset: 1, count: 2, total: 3, nextOffset: null });
    expect(() => pageForModel(small, { list: 'nope' })).toThrow(/no list "nope".*rows/);
  });

  it('a first page with two big lists starts the second and says how to read the rest (more)', () => {
    const two = { needs: rows(5, 2), accounts: rows(300), people: rows(200) };
    const p = pageForModel(two, {}, 20_000);
    expect(p.paging?.list).toBe('accounts');
    expect(JSON.stringify(p.value).length).toBeLessThanOrEqual(20_000);
    // the "needs you" rows stay whole; the other list starts and continues with list=people
    expect((p.value as { needs: unknown[] }).needs).toHaveLength(5);
    expect(p.more?.people).toMatchObject({ total: 200 });
    const rest = pageForModel(two, { list: 'people', offset: p.more!.people!.nextOffset }, 20_000);
    expect(rest.paging).toMatchObject({ list: 'people', offset: p.more!.people!.nextOffset, total: 200 });
  });

  it('pages a list one level down, and a bare array', () => {
    const nested = { pipeline: { rows: rows(400) }, meta: 1 };
    const p = pageForModel(nested, {}, 8_000);
    expect(p.paging).toMatchObject({ list: 'pipeline.rows', total: 400 });
    const arr = pageForModel(rows(400), { offset: 10 }, 8_000);
    expect(arr.paging).toMatchObject({ list: null, offset: 10, total: 400 });
  });

  it('drops nulls, redacts credentials, keeps links, and reads an embedded work item as its hit (with version)', () => {
    expect(cleanForModel({ a: 1, b: null, c: '', d: [], note: 'password: hunter2placeholder', url: 'https://example.com/x' })).toEqual({ a: 1, d: [], note: expect.stringContaining('[REDACTED'), url: 'https://example.com/x' });
    const w = seed.workItems[0]!;
    const hit = (cleanForModel({ rows: [{ workItem: w }] }) as { rows: Array<{ workItem: Record<string, unknown> }> }).rows[0]!.workItem;
    expect(hit).toMatchObject({ id: w.id, title: w.title, state: w.state, version: w.version });
    expect(hit).not.toHaveProperty('rankReasons');
  });

  it('ASSIST-5: a long string is never cut silently: it shows its start and the field that reads all of it, a page at a time', () => {
    const body = Array.from({ length: 900 }, (_, i) => `line ${i};`).join(' '); // ~8,000 characters
    const raw = { item: { id: 'w1', notes: body }, hits: [{ id: 'a', body: 'short' }, null, { id: 'b', body }] };
    const v = cleanForModel(raw) as { item: { notes: string }; hits: Array<{ body: string }> };
    expect(v.item.notes).toMatch(new RegExp(`^line 0;[\\s\\S]* … \\[${body.length} characters; read the rest with field="item.notes"\\]$`));
    // the index is the row's place in the cleaned list (the null row is gone)
    expect(v.hits[1]!.body).toMatch(/read the rest with field="hits\.1\.body"/);
    // the field read returns the whole text in pages, with total and nextOffset
    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const p = pageForModel(raw, { field: 'hits.1.body', offset, limit: 3000 });
      const f = p.value as { field: string; text: string; total: number; nextOffset: number | null };
      expect(f.field).toBe('hits.1.body');
      expect(f.total).toBe(body.length);
      expect(p.paging).toMatchObject({ list: 'field:hits.1.body', offset, total: body.length });
      text += f.text;
      offset = f.nextOffset;
    }
    expect(text).toBe(body);
    expect(() => pageForModel(raw, { field: 'item.nope' })).toThrow(ChatReadArgsError);
    expect(() => pageForModel(raw, { field: 'item' })).toThrow(/not a text field/);
    // a display preview (path null) clips without a pointer
    expect(cleanForModel({ s: body }, 0, 60, null)).toEqual({ s: expect.stringMatching(/^line 0;.{50,60}…$/) });
  });

  it('toolJson never cuts mid-JSON and keeps lists longer than 200', () => {
    const long = toolJson({ rows: Array.from({ length: 900 }, (_, i) => i) });
    expect((JSON.parse(long) as { rows: number[] }).rows).toHaveLength(900);
    const huge = toolJson({ s: 'x'.repeat(5_000), rows: Array.from({ length: 5_000 }, (_, i) => ({ i, t: 'y'.repeat(30) })) }, 10_000);
    expect(() => JSON.parse(huge)).not.toThrow();
    expect(JSON.parse(huge)).toMatchObject({ tooLarge: true });
    // the result's own top-level facts survive the stub
    expect(JSON.parse(toolJson({ staged: true, proposalId: 'p1', rows: Array.from({ length: 5_000 }, (_, i) => ({ i, t: 'y'.repeat(30) })) }, 10_000))).toMatchObject({ staged: true, proposalId: 'p1', tooLarge: true });
  });
});

describe('sinceLastLogged', () => {
  it('walks back to the newest logged entry and counts only what is unlogged after it, up to now', async () => {
    const w0 = week('2026-11-09', [entry('2026-11-09T16:00:00.000Z', 'proposed', 2), entry('2026-11-10T16:00:00.000Z', 'needs_input', 0.5), entry('2026-11-12T16:00:00.000Z', 'upcoming'), { ...entry('2026-11-09T18:00:00.000Z', 'dismissed'), issues: ["'Admin' is Neither CF nor CR (canvas): not loggable"] }]);
    const w1 = week('2026-11-02', [entry('2026-11-03T16:00:00.000Z', 'approved', 1.5)]);
    const w2 = week('2026-10-26', [entry('2026-10-27T15:00:00.000Z', 'needs_input'), entry('2026-10-28T20:00:00.000Z', 'logged'), entry('2026-10-29T16:00:00.000Z', 'proposed', 1.25)]);
    const weeks: Record<string, TimeWeek> = { '2026-11-02': w1, '2026-10-26': w2 };
    const asked: string[] = [];
    const s = await sinceLastLogged(async (wk) => (asked.push(wk), weeks[wk]!), w0, NOW);
    expect(asked).toEqual(['2026-11-02', '2026-10-26']);
    expect(s.lastLogged).toMatchObject({ date: '2026-10-28', status: 'logged' });
    expect(s.notLogged).toMatchObject({ count: 4, hours: 5.25, from: '2026-10-29', to: '2026-11-10' });
    // the fixture rows carry no opp, so all four unlogged rows after the last logged one need one
    expect(s.missingOpp).toMatchObject({ count: 4, noOpp: 4 });
    expect(s.excluded).toEqual({ count: 1, hours: 1, byReason: [{ reason: "'Admin' is Neither CF nor CR (canvas): not loggable", count: 1, hours: 1 }] });
    expect(s.notLogged.byStatus).toEqual({ proposed: { count: 2, hours: 3.25 }, approved: { count: 1, hours: 1.5 }, needs_input: { count: 1, hours: 0.5 } });
    expect(s.notLogged.byWeek).toEqual([
      { weekStart: '2026-10-26', count: 1, hours: 1.25 },
      { weekStart: '2026-11-02', count: 1, hours: 1.5 },
      { weekStart: '2026-11-09', count: 2, hours: 2.5 },
    ]);
  });

  it('says which unlogged rows already wait in a canvas for Apply on Activity, and only when some do', async () => {
    const held = { ...entry('2026-11-09T16:00:00.000Z', 'approved', 2), canvasDraftId: 'd1' };
    const w0 = week('2026-11-09', [held, entry('2026-11-10T16:00:00.000Z', 'approved', 1), entry('2026-11-02T16:00:00.000Z', 'logged')]);
    const s = await sinceLastLogged(async (wk) => week(wk, []), w0, NOW);
    expect(s.waitingForApply).toEqual({ count: 1, hours: 2, items: [{ draftId: 'd1', href: '/activity?view=week&draft=d1' }] });
    const none = await sinceLastLogged(async (wk) => week(wk, []), week('2026-11-09', [entry('2026-11-10T16:00:00.000Z', 'approved', 1), entry('2026-11-02T16:00:00.000Z', 'logged')]), NOW);
    expect(none).not.toHaveProperty('waitingForApply');
  });

  it('says how far back it looked when nothing was ever logged', async () => {
    const empty = (wk: string) => week(wk, []);
    const s = await sinceLastLogged(async (wk) => empty(wk), week('2026-11-09', [entry('2026-11-09T16:00:00.000Z', 'proposed')]), NOW, 3);
    expect(s.lastLogged).toBeNull();
    expect(s.searchedBackTo).toBe('2026-10-26');
    expect(s.notLogged.count).toBe(1);
  });
});

describe('chat_read on the mock DataSource', () => {
  const idArgs = (): Record<string, Record<string, unknown>> => ({
    item: { id: seed.workItems[0]!.id },
    find_items: { q: seed.workItems[0]!.title.split(' ')[0]! },
    item_evidence: { id: seed.workItems[0]!.id },
    item_trace: { id: seed.workItems[0]!.id },
    item_history: { id: seed.workItems[0]!.id },
    item_nba: { id: seed.workItems[0]!.id },
    initiative: { id: seed.initiatives[0]!.id },
    draft: { id: seed.drafts[0]!.id },
    account: { accountId: seed.accounts[0]!.id },
    readin: { type: 'work_item', id: seed.workItems[0]!.id },
    tool_run: { id: seed.toolRuns[0]!.id },
    history_day: { day: '2026-11-05' },
    search: { q: 'demo' },
  });

  it('reads every page, each page within one page of characters', async () => {
    const cov = await ds.getVdpCoverage({} as never);
    const args: Record<string, Record<string, unknown>> = { ...idArgs(), vdp_detail: { key: cov.vdps[0]!.vdpSlug } };
    for (const p of CHAT_READ_PAGE_NAMES) {
      const r = await readPage(ds, p, args[p] ?? {}, { now: NOW });
      expect(JSON.stringify(r.data).length, p).toBeLessThanOrEqual(READ_PAGE_CHARS);
      expect(r.summary, p).toBeTruthy();
    }
  });

  it('the folded reads (A9): today, find_items, item, calendar, outbox and health are pages', async () => {
    const w = seed.workItems[0]!;
    const today = await readPage(ds, 'today', {}, { now: NOW });
    expect(today.data).toHaveProperty('today.top3');
    const found = await readPage(ds, 'find_items', { q: w.title }, { now: NOW });
    expect((found.data as { hits: Array<{ id: string }> }).hits.map((h) => h.id)).toContain(w.id);
    await expect(readPage(ds, 'find_items', {}, { now: NOW })).rejects.toThrow(ChatReadArgsError);
    const item = await readPage(ds, 'item', { id: w.id }, { now: NOW });
    expect(item.data).toMatchObject({ item: { id: w.id, version: w.version } });
    for (const p of ['calendar', 'outbox', 'health'] as const) expect((await readPage(ds, p, {}, { now: NOW })).summary, p).toBeTruthy();
  });

  it('read pages through the tool: page.total, nextOffset and the note to read on (A1)', async () => {
    const ctx: ChatToolCtx = { host: createChatHost(ds, ds.be6.backend(), () => ds.now()), input: { threadId: 't', messageId: 'm', userMessageId: 'u', text: '', context: [], model: 'sonnet', signal: new AbortController().signal }, emit: () => undefined, state: newToolState(), signal: new AbortController().signal };
    const first = await callChatTool(ctx, 'read', { route: 'getDeals', limit: 1 });
    expect(first.ok).toBe(true);
    expect(first.text.split('\n')[0]).toBe(untrustedHeader('app')); // P25-5: the app's copy of other people's text
    const j = JSON.parse(withoutUntrustedHeader(first.text)) as { route: string; page: { list: string; offset: number; count: number; total: number; nextOffset: number | null }; note?: string; data: unknown };
    expect(j.route).toBe('getDeals');
    expect(j.page).toMatchObject({ offset: 0, count: 1 });
    expect(j.page.total).toBeGreaterThan(1);
    expect(j.note).toMatch(/read again with offset=1[\s\S]*until nextOffset is null/);
    // read on to the end: every row comes back exactly once (the list may sit one level down: "pipeline.rows")
    const at = (d: unknown, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], d) as unknown[];
    const rows: unknown[] = [...at(j.data, j.page.list)];
    let next = j.page.nextOffset;
    while (next !== null) {
      const r = JSON.parse(withoutUntrustedHeader((await callChatTool(ctx, 'read', { route: 'getDeals', offset: next, limit: 2, list: j.page.list })).text)) as typeof j;
      rows.push(...at(r.data, j.page.list));
      next = r.page.nextOffset;
    }
    expect(rows).toHaveLength(j.page.total);
    // a page name works as the route (an alias), with its args in query
    const item = JSON.parse(withoutUntrustedHeader((await callChatTool(ctx, 'read', { route: 'item', query: { id: seed.workItems[0]!.id } })).text)) as { page: string; data: { item: { id: string } } };
    expect(item).toMatchObject({ page: 'item', data: { item: { id: seed.workItems[0]!.id } } });
    expect(await callChatTool(ctx, 'read', { route: 'getDeals', list: 'nope' })).toMatchObject({ ok: false, summary: 'Invalid read' });
  });

  it('ASSIST-5: an item note longer than 2,000 characters reads whole through read field paging', async () => {
    const ctx: ChatToolCtx = { host: createChatHost(ds, ds.be6.backend(), () => ds.now()), input: { threadId: 't', messageId: 'm', userMessageId: 'u', text: '', context: [], model: 'sonnet', signal: new AbortController().signal }, emit: () => undefined, state: newToolState(), signal: new AbortController().signal };
    const w = seed.workItems[0]!;
    const notes = Array.from({ length: 700 }, (_, i) => `step ${i} done.`).join(' ');
    const d = await ds.getItem({ params: { id: w.id } } as never);
    await ds.patchItem({ params: { id: w.id }, body: { ifVersion: d.item.version, patch: { notes } } } as never);
    const first = JSON.parse(withoutUntrustedHeader((await callChatTool(ctx, 'read', { route: 'item', query: { id: w.id } })).text)) as { data: { item: { notes: string } } };
    const m = /read the rest with field="([^"]+)"\]$/.exec(first.data.item.notes);
    expect(m?.[1]).toBe('item.notes');
    let text = '';
    let offset: number | null = 0;
    let note = '';
    while (offset !== null) {
      const r = JSON.parse(withoutUntrustedHeader((await callChatTool(ctx, 'read', { route: 'item', query: { id: w.id }, field: m![1]!, offset, limit: 4000 })).text)) as { page: { nextOffset: number | null }; note?: string; data: { text: string } };
      text += r.data.text;
      note ||= r.note ?? '';
      offset = r.page.nextOffset;
    }
    expect(text).toBe(notes);
    expect(note).toMatch(/read again with field="item\.notes" and offset=4000/);
  });

  it('the Persona block names the features available but not active for the role (A9)', () => {
    const ae = renderPersonaBlock(personaOf({ persona: { id: 'ae' } as never }));
    expect(ae).toMatch(/^Available, not active for this role \(Settings ▸ Role & rules turns them on\): .*vdp/m);
    const se = renderPersonaBlock(personaOf({ persona: { id: 'se' } as never }));
    expect(se).not.toMatch(/^Available, not active.*\bvdp\b/m);
  });

  it('answers the time-logging question end to end with the time page', async () => {
    const evs = await collect(ds.chat({ body: { text: 'How much activity logging do I have open since I last logged it?', context: [] }, signal: new AbortController().signal } as never));
    const start = of(evs, 'tool-start').find((e) => e.name === 'time.read');
    expect(start).toBeTruthy();
    expect(of(evs, 'tool-result').find((e) => e.id === start!.id)).toMatchObject({ ok: true });
    expect(textOf(evs)).toMatch(/last logged activity on \d{4}-\d{2}-\d{2}|Nothing is logged back to/);
  });
});
