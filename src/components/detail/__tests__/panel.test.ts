// @vitest-environment jsdom
/**
 * V2-DETAIL: <ItemDetail variant="panel"/> against the real mock DataSource (placeholder seed), with fetch
 * bridged in-process to the route handlers (same harness as tests/p2). Covers the v2 layout (section line,
 * one state badge, Why with evidence chips, Plan with the agent lane, collapsed groups), the ONE filled
 * primary living in the sticky footer (the composer's Send/Push included), quiet footer actions with
 * optimistic Done → Reopen, Later ▾ ▸ Not now, and the pure helpers in lib/panel-derive.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey, type WorkItem } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '../../composer/__tests__/dom';
import { noteLocalWrite, resetIntent } from '@/client/intent';
import { goneNote } from '@/components/lists/gone';
import { evidenceSources, planSteps, planSummary, readiness, sectionLine, siblingTone, stateBadge, whyHeading } from '../lib/panel-derive';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/work/test',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never),
}));

const { ItemDetail, renderItemPanel, renderDraftPanel, DraftPanel } = await import('@/components/detail');
const { publishDraftQueue, clearDraftQueue, queuePosition } = await import('@/components/detail/lib/draft-queue');
const { act } = await import('react');

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let qc: QueryClient;

function matchRoute(method: string, pathname: string): { key: RouteKey; params: Record<string, string> } | null {
  for (const [key, def] of Object.entries(routes)) {
    if (def.method !== method || (def as { stream?: boolean }).stream) continue;
    const names = [...def.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]!);
    const re = new RegExp(`^${API_BASE}${def.path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    const m = re.exec(pathname);
    if (m) return { key: key as RouteKey, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) };
  }
  return null;
}

beforeEach(() => {
  resetDataSourceForTests();
  ds = createMockDataSource({ delays: { enrichMs: 40, reevalMs: 10, stepMs: 20, verifyMs: 20 }, autoplay: false });
  (globalThis as { __ccDataSource?: unknown }).__ccDataSource = ds;
  localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const m = matchRoute(method, url.pathname);
    if (!m) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route', retryable: false } }), { status: 404 });
    return handle(m.key)(new Request(url, { method, headers: init?.headers, body: init?.body }), { params: Promise.resolve(m.params) });
  });
});

afterEach(async () => {
  clearDraftQueue('test');
  await cleanup();
  vi.unstubAllGlobals();
  resetDataSourceForTests();
});

const mount = (el: ReactElement) => render(h(QueryClientProvider, { client: qc }, el));
const item = async (id: string) => (await ds.getItem({ params: { id } } as never)).item;
/** Filled buttons: @/ui Button marks its variant. */
const filled = (root: ParentNode) => $$('button[data-variant="primary"]', root);

/** Open a footer/header menu (Done ▾, Later ▾) and pick the entry whose label starts with `label`. */
async function choose(scope: ParentNode, menu: 'done' | 'later', label: string) {
  await click(await waitFor(() => $(`[data-testid="menu-${menu}"]`, scope)));
  await click(await waitFor(() => $$('[role="menu"] [role^="menuitem"]').find((m) => m.textContent?.startsWith(label))));
}

describe('ItemDetail variant="panel"', () => {
  it('renders the v2 head, Why with evidence chips, the Plan and collapsed groups; the one primary sits in the footer', async () => {
    const { container } = await mount(renderItemPanel('w_acme_build'));
    const root = await waitFor(() => $('[data-item-detail="panel"] [data-item-header="panel"]', container));
    expect($('[data-section-line]', root)?.textContent).toBeTruthy();
    expect($('textarea[data-field="title"]', root)).not.toBeNull(); // the title wraps in the panel
    await waitFor(() => $('[data-why-section] [data-evidence-chips]', container));
    const plan = await waitFor(() => $('[data-nba-section="start_in_claude"] [data-plan-steps]', container));
    expect($('[data-step="agent"]', plan)?.textContent).toContain("doesn't count against your day");
    expect($$('[data-collapsible]', container).map((c) => c.dataset.collapsible)).toEqual(expect.arrayContaining(['evidence', 'history', 'context', 'related']));
    const footer = await waitFor(() => $('[data-panel-footer]', container));
    await waitFor(() => $('[data-panel-primary]', footer)?.textContent?.includes('Claude'));
    // Exactly one filled button in the whole panel, and it's in the footer; the context pack draws none.
    expect(filled(container)).toHaveLength(1);
    expect(filled(footer)).toHaveLength(1);
    expect($('[data-claude-launch] [data-nba-primary]', container)).toBeNull();
    // The verbs are two menus (01-ui-audit R6): Later ▾ and Done ▾, beside the one primary.
    for (const m of ['menu-later', 'menu-done']) expect($(`[data-testid="${m}"]`, footer)).not.toBeNull();
    for (const a of ['snooze', 'not-now', 'resolve']) expect($(`[data-action="${a}"]`, footer)).toBeNull();
  });

  it('a draft item hands Send/Push to the footer (the composer draws no primary of its own)', async () => {
    const { container } = await mount(h(ItemDetail, { itemId: 'w_dana_reply', variant: 'panel' }));
    const composer = await waitFor(() => $('[data-item-detail="panel"] [data-testid="composer"]', container));
    await waitFor(() => $('[data-testid="composer-editor"]', composer));
    expect($('[data-testid="composer-primary"]', composer)).toBeNull();
    const primary = await waitFor(() => {
      const b = $('[data-panel-footer] [data-panel-primary]', container);
      return b && /Save as (Slack|Gmail) draft|Send/.test(b.textContent ?? '') ? b : null;
    });
    expect(filled(container)).toHaveLength(1);
    expect($('[data-trust-line]', composer)?.textContent).toContain('Nothing sends until you approve');
    await waitFor(() => !primary.hasAttribute('disabled'));
    await click(primary);
    const dlg = await waitFor(() => $('[role="dialog"] [data-testid="confirm-dialog"]'));
    expect(dlg.textContent).toContain('Where it goes');
    expect(dlg.textContent).toContain('Dry run is on');
    await click($('[data-testid="confirm-cancel"]'));
  });

  it('Done ▾ ▸ Done by me is optimistic; the footer primary turns into Reopen; Reopen restores it', async () => {
    const id = 'w_dana_reply';
    const { container } = await mount(h(ItemDetail, { itemId: id, variant: 'panel' }));
    const footer = await waitFor(() => $('[data-panel-footer]', container));
    await choose(footer, 'done', 'Done by me');
    await waitFor(() => $('[data-panel-footer] [data-panel-primary]', container)?.textContent === 'Reopen');
    await waitFor(async () => (await item(id)).state === 'done');
    await click($('[data-panel-footer] [data-panel-primary]', container));
    await waitFor(async () => (await item(id)).state !== 'done');
  });

  it('mounts the read-in first (BE-READIN), above Why', async () => {
    const { container } = await mount(renderItemPanel('w_dana_reply'));
    const readIn = await waitFor(() => $('[data-item-detail="panel"] [data-readin]', container));
    const why = await waitFor(() => $('[data-why-section]', container));
    expect(readIn.compareDocumentPosition(why) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renderDraftPanel: the draft in the composer with the footer primary, and a quiet way to its task', async () => {
    const dana = await ds.getItem({ params: { id: 'w_dana_reply' } } as never);
    const { container } = await mount(renderDraftPanel(dana.draft!.id));
    const root = await waitFor(() => $(`[data-draft-panel="${dana.draft!.id}"]`, container));
    await waitFor(() => $('[data-testid="composer-editor"]', root));
    expect($('[data-testid="composer-primary"]', root)).toBeNull();
    await waitFor(() => /Save as (Slack|Gmail) draft|Send/.test($('[data-panel-footer] [data-panel-primary]', root)?.textContent ?? ''));
    expect(filled(root)).toHaveLength(1);
    expect($$('[data-panel-footer] button', root).some((b) => b.textContent === 'Open the task')).toBe(true);
  });

  it("registers the 'draft' Details renderer (Today, Home and the read-in open drafts in the panel)", async () => {
    const { getDetailRenderer } = await import('@/components/shell/panel');
    const renderDraft = getDetailRenderer('draft');
    expect(renderDraft).toBeTypeOf('function');
    const dana = await ds.getItem({ params: { id: 'w_dana_reply' } } as never);
    const { container } = await mount(renderDraft!({ kind: 'draft', id: dana.draft!.id }) as ReactElement);
    await waitFor(() => $(`[data-draft-panel="${dana.draft!.id}"] [data-testid="composer"]`, container));
  });

  it('Later ▾ ▸ Not now snoozes until the next working day', async () => {
    const id = 'w_dana_reply';
    const { container } = await mount(h(ItemDetail, { itemId: id, variant: 'panel' }));
    await choose(await waitFor(() => $('[data-panel-footer]', container)), 'later', 'Not now');
    await waitFor(async () => (await item(id)).state === 'snoozed');
    expect((await item(id)).snoozedUntil).toBeTruthy();
  });

  it('Later ▾ ▸ Tomorrow snoozes; Done ▾ ▸ Not needed resolves; ⇧D and l open the menus', async () => {
    const id = 'w_dana_reply';
    const { container } = await mount(h(ItemDetail, { itemId: id, variant: 'panel' }));
    const panel = await waitFor(() => $('[data-detail-panel="work_item"]', container));
    await act(async () => void panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true })));
    await waitFor(() => $$('[role="menu"] [role^="menuitem"]').find((m) => m.textContent?.startsWith('Tomorrow')));
    await click($$('[role="menu"] [role^="menuitem"]').find((m) => m.textContent?.startsWith('Tomorrow')));
    await waitFor(async () => (await item(id)).state === 'snoozed');
    const other = 'w_globex_sow';
    const second = await mount(h(ItemDetail, { itemId: other, variant: 'panel' }));
    const panel2 = await waitFor(() => $(`[data-item-id="${other}"] [data-detail-panel="work_item"]`, second.container));
    await act(async () => void panel2.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', shiftKey: true, bubbles: true })));
    await click(await waitFor(() => $$('[role="menu"] [role^="menuitem"]').find((m) => m.textContent?.startsWith('Not needed'))));
    await waitFor(async () => (await item(other)).resolution === 'not_needed');
  });
});

describe('DraftPanel: the approval queue (Home\'s "Approve N drafts" card)', () => {
  // Two ready drafts in the placeholder seed, plus a drafting one (a queue can hold any ids; the pager only pages).
  const Q = ['dr_nudge_globex', 'dr_chat_initech', 'dr_dana'];
  const mountQueued = async (draftId: string) => {
    const opened: string[] = [];
    const r = await mount(h(DraftPanel, { draftId, onOpenDraft: (id: string) => opened.push(id) }));
    await waitFor(() => $(`[data-draft-panel="${draftId}"]`, r.container));
    return { ...r, opened };
  };

  it('shows "2 of 3" with prev/next that open the neighbours; none outside a queue', async () => {
    publishDraftQueue('test', Q);
    const { container, opened } = await mountQueued('dr_chat_initech');
    const pager = await waitFor(() => $('[data-draft-queue]', container));
    expect($('[data-queue-position]', pager)?.textContent).toBe('2 of 3');
    await click($('[data-queue="prev"]', pager));
    await click($('[data-queue="next"]', pager));
    expect(opened).toEqual(['dr_nudge_globex', 'dr_dana']);
    // Plain j/k stay the page's: the panel binds no pager keys.
    await act(async () => {
      $('[data-draft-panel]', container)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    });
    expect(opened).toHaveLength(2);
    // The page leaves (clears its queue): the pager goes with it.
    await act(async () => clearDraftQueue('test'));
    expect($('[data-draft-queue]', container)).toBeNull();
  });

  it('the first draft has no previous, and a draft outside the queue shows no pager', async () => {
    publishDraftQueue('test', Q);
    const first = await mountQueued('dr_nudge_globex');
    const prev = await waitFor(() => $('[data-draft-queue] [data-queue="prev"]', first.container));
    expect(prev.hasAttribute('disabled')).toBe(true);
    expect($('[data-queue-position]', first.container)?.textContent).toBe('1 of 3');
    await first.unmount();
    const other = await mountQueued('dr_priya');
    await waitFor(() => $('[data-testid="composer"]', other.container));
    expect($('[data-draft-queue]', other.container)).toBeNull();
  });

  it('Reject (nothing is sent) moves on to the next ready draft', async () => {
    publishDraftQueue('test', Q);
    const { container, opened } = await mountQueued('dr_nudge_globex');
    const reject = await waitFor(() => $('[data-panel-footer] [data-action="reject"]', container));
    await click(reject);
    await waitFor(() => opened.length === 1);
    expect(opened).toEqual(['dr_chat_initech']);
    expect((await ds.getDraft({ params: { id: 'dr_nudge_globex' } } as never)).status).toBe('rejected');
  });

  it('Push (through the real preview, confirm and dispatch; the mock never calls out) moves on to the next ready draft', async () => {
    const settings = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: settings.sending.version, value: { dryRun: false, undoWindowSec: 0 }, confirm: true } } as never);
    publishDraftQueue('test', Q);
    const { container, opened } = await mountQueued('dr_nudge_globex');
    const primary = await waitFor(() => {
      const b = $('[data-panel-footer] [data-panel-primary]', container);
      return b && !b.hasAttribute('disabled') ? b : null;
    });
    await click(primary);
    await click(await waitFor(() => {
      const b = $('[data-testid="confirm-send"]');
      return b && !b.hasAttribute('disabled') ? b : null;
    }));
    await waitFor(() => opened.length === 1);
    expect(opened).toEqual(['dr_chat_initech']);
    expect(['staged', 'sent', 'verified', 'sending']).toContain((await ds.getDraft({ params: { id: 'dr_nudge_globex' } } as never)).status);
  });

  it('once the open draft leaves the queue because you pushed or sent it (the page refetched), the panel follows to its neighbour', async () => {
    resetIntent();
    publishDraftQueue('test', Q);
    const { opened } = await mountQueued('dr_chat_initech');
    noteLocalWrite(['dr_chat_initech']); // the write this tab made for it (src/client/intent.ts)
    await act(async () => publishDraftQueue('test', ['dr_nudge_globex', 'dr_dana']));
    await waitFor(() => opened.length === 1);
    expect(opened).toEqual(['dr_dana']);
  });

  it('a draft that left the queue elsewhere keeps the panel on it, which says so, with Next (docs/UX.md "Live updates")', async () => {
    resetIntent();
    publishDraftQueue('test', Q);
    const { opened } = await mountQueued('dr_chat_initech');
    await act(async () => publishDraftQueue('test', ['dr_nudge_globex', 'dr_dana']));
    const note = await waitFor(() => goneNote('dr_chat_initech') ?? null);
    expect(opened).toEqual([]);
    expect(note.title).toBe('Sent or applied elsewhere');
    expect(note.nextLabel).toBe('Next draft');
    await act(async () => note.next!());
    expect(opened).toEqual(['dr_dana']);
  });

  it('a longer list from the page is not a removal; the last draft gone (yours) falls back to the one before it', async () => {
    resetIntent();
    publishDraftQueue('test', Q);
    const { opened } = await mountQueued('dr_dana');
    await act(async () => publishDraftQueue('test', [...Q, 'dr_new']));
    expect(opened).toEqual([]);
    noteLocalWrite(['dr_dana']);
    await act(async () => publishDraftQueue('test', ['dr_nudge_globex', 'dr_chat_initech']));
    await waitFor(() => opened.length === 1);
    expect(opened).toEqual(['dr_chat_initech']);
  });

  it('queuePosition: index, total and neighbours', () => {
    expect(queuePosition(Q, 'dr_chat_initech')).toEqual({ index: 1, total: 3, prev: 'dr_nudge_globex', next: 'dr_dana' });
    expect(queuePosition(Q, 'dr_dana')).toMatchObject({ next: null });
    expect(queuePosition(Q, 'dr_other')).toBeNull();
  });
});

describe('panel-derive', () => {
  const now = '2026-11-05T15:00:00.000Z';
  const base = async () => item('w_dana_reply');

  it('one state badge: overdue/expired are red, start-by and due-soon amber, done green', async () => {
    const w = await base();
    expect(stateBadge({ ...w, state: 'done' }, now)?.tone).toBe('ok');
    expect(stateBadge({ ...w, state: 'open', due: '2026-11-05T14:00:00.000Z' }, now)).toMatchObject({ tone: 'risk', glyph: '✕' });
    expect(stateBadge({ ...w, state: 'open', due: null, startBy: '2026-11-05T14:00:00.000Z' }, now)?.label).toMatch(/^Expired/);
    expect(stateBadge({ ...w, state: 'open', due: null, startBy: '2026-11-05T16:00:00.000Z' }, now)).toMatchObject({ tone: 'warn', glyph: '◷' });
    expect(stateBadge({ ...w, state: 'open', due: null, startBy: null }, now)).toBeNull();
  });

  it('section line and why heading follow the NOW stack, then the verb', async () => {
    const w = await base();
    expect(sectionLine(w, null, ['x', w.id, 'y'])).toBe('Do now · 2 of 3');
    expect(whyHeading('Do now · 1 of 3')).toBe("Why it's first");
    expect(whyHeading('Do now · 2 of 3')).toBe("Why it's here");
    expect(sectionLine({ ...w, rank: null, state: 'waiting_on_others' }, null)).toBe('Chase');
    expect(sectionLine({ ...w, rank: null }, { verb: 'send' })).toBe('Reply and approve');
  });

  it('plan keeps agent time in its own lane and never sums it with yours', async () => {
    const w: WorkItem = { ...(await base()), effort: { youMin: 20, agentMin: 20 } };
    const steps = planSteps(w, null, []);
    expect(steps.map((s) => s.who)).toEqual(['agent', 'you']);
    expect(planSummary(w, true)).toBe('you ~20m, agent ~20m in background');
    expect(planSummary({ effort: { youMin: 5, agentMin: 0 } }, false)).toBe('you ~5m');
  });

  it('evidence sources dedupe; readiness lists the meeting prep with this item last among the open ones', async () => {
    const w = await base();
    const s = { kind: 'slack' as const, label: '#acme · thread', url: 'https://example.com/a' };
    expect(evidenceSources({ sources: [s, s] }, { sources: [s] })).toHaveLength(1);
    const meeting = { id: 'ev_1', type: 'calendar_event' as const, label: 'Demo', start: '2026-11-05T20:00:00.000Z' };
    const sib = { ...w, id: 'w_sib', title: 'Slides', state: 'done' as const, refs: { ...w.refs, meeting } };
    const r = readiness({ item: { ...w, deliverable: null, refs: { ...w.refs, meeting } }, siblings: [sib], meeting: null });
    expect(r?.checks.map((c) => [c.ready, c.self ?? false])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(siblingTone(sib, now)).toBe('ok');
  });
});
