// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Destination, DispatchResult, Draft, DraftPreview } from '@/contract';
import { Composer } from '../Composer';
import { ConfirmSendDialog } from '../ConfirmSendDialog';
import { RecipientPreview } from '../RecipientPreview';
import { SendCountdownToast } from '../SendCountdownToast';
import { $, $$, cleanup, click, render, waitFor } from './dom';

const SLACK: Destination = { kind: 'slack', target: 'thread', channelId: 'C0ACME', channelName: '#acme-ext', threadTs: '1.1' };
/** A structured action (placeholder VDP change): read-only, one generic preview. */
const ACTION: Destination = {
  kind: 'action',
  action: 'vdp.update_use_case',
  target: { label: 'Acme Placeholder FY27 Q4 · Deflection', url: 'https://vdp.example.test/vdp/acme?tab=agentforce' },
  input: { vdpSlug: 'acme', vdpId: 'v1', useCaseId: 'u1', useCaseTitle: 'Deflection', track: null, field: 'persona', before: null, value: 'Service operations lead' },
  changes: [{ label: 'Persona', before: null, after: 'Service operations lead' }],
  text: '<b>Long text</b> stays text',
};
const EMAIL: Destination = { kind: 'email', target: 'reply_all', to: [{ name: 'Marcus Webb', email: 'marcus@globex.example' }], cc: [{ name: 'Elena Cruz', email: 'elena@example.com' }], subject: 'Re: SOW', threadId: null, inReplyTo: null };

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 'dr_1',
  version: 1,
  workItemId: null,
  nbaId: null,
  destination: SLACK,
  mode: 'draft',
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi Dana, confirmed for 13:00.' }] }] },
  plainText: 'Hi Dana, confirmed for 13:00.',
  rendered: {},
  userTouched: false,
  userLockedFields: [],
  status: 'drafting',
  threadContext: [],
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
  savedAt: null,
  scheduledFor: null,
  attempts: [],
  verification: null,
  rejectedReason: null,
  resultUrl: null,
  ...over,
});

const preview = (d: Destination, payload: Record<string, unknown>, over: Partial<DraftPreview> = {}): DraftPreview => ({
  draftId: 'dr_1',
  version: 2,
  destination: d,
  mode: 'send',
  rendition: { format: d.kind === 'slack' ? 'slack_mrkdwn' : 'email_html', body: String(payload.text ?? payload.html ?? ''), text: '', lossy: [] },
  payload,
  confirmToken: 'ct_dr_1_2_send_x',
  dryRun: true,
  ...over,
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

describe('RecipientPreview', () => {
  it('renders the server payload through DOMPurify: no script, handlers or javascript: links reach the DOM', async () => {
    const evil = '<p onclick="steal()">Hello Marcus</p><img src=x onerror="alert(1)"><script>window.__pwned=1</script><a href="javascript:alert(1)">click</a>';
    const { container } = await render(h(RecipientPreview, { preview: preview(EMAIL, { html: evil, text: 'Hello Marcus' }), destination: EMAIL, senderName: 'Jordan Lee' }));
    const fig = $('[data-testid="recipient-preview"]', container)!;
    expect(fig.dataset.channel).toBe('email');
    expect(fig.textContent).toContain('Hello Marcus');
    expect(fig.textContent).toContain('Re: SOW');
    expect(fig.querySelector('script, img, iframe, [onclick], [onerror]')).toBeNull();
    expect(fig.innerHTML).not.toContain('javascript:');
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('Slack mimic: renders from the payload, mention ids shown by name', async () => {
    const doc = { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ping ' }, { type: 'mention', attrs: { id: 'U0RAJ', label: 'Raj Mehta', kind: 'user' } }] }] };
    const { container } = await render(h(RecipientPreview, { doc, destination: SLACK, labels: { U0RAJ: 'Raj Mehta' }, senderName: 'Jordan Lee' }));
    expect($('[data-channel="slack"]', container)!.textContent).toContain('@Raj Mehta');
  });
});

describe('ActionPreview (every structured action)', () => {
  it('shows the target link, before → after per change and the long text, as text', async () => {
    const { container } = await render(h(RecipientPreview, { doc: { type: 'doc', content: [] }, destination: ACTION }));
    const fig = $('[data-testid="action-preview"]', container)!;
    expect(fig.dataset.action).toBe('vdp.update_use_case');
    expect(fig.textContent).toContain('VDP');
    expect($('a', fig)!.getAttribute('href')).toBe('https://vdp.example.test/vdp/acme?tab=agentforce');
    expect($('a', fig)!.getAttribute('rel')).toContain('noopener');
    expect($('[data-testid="action-changes"]', fig)!.textContent).toBe('Persona(empty)→Service operations lead');
    expect(fig.textContent).toContain('<b>Long text</b> stays text');
    expect(fig.querySelector('b')).toBeNull();
  });

  it('the confirm dialog says Apply, names the app, and lists the change', async () => {
    await render(h(ConfirmSendDialog, { open: true, mode: 'send', destination: ACTION, preview: preview(ACTION, { tool: 'update_use_case' }), dryRun: true, undoSec: 10, onConfirm: vi.fn(), onCancel: vi.fn() }));
    const dlg = await waitFor(() => $('[role="dialog"][aria-modal="true"]'));
    expect(dlg.textContent).toContain('Apply this change to VDP?');
    expect(dlg.textContent).toContain('Persona: (empty) → Service operations lead');
    expect($('[data-testid="confirm-send"]', dlg)!.textContent).toContain('Apply (dry run)');
  });
});

describe('ConfirmSendDialog', () => {
  it('shows destination, recipients, the dry-run note; Cancel has focus; Confirm is the only primary', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    await render(
      h(ConfirmSendDialog, {
        open: true,
        mode: 'send',
        destination: EMAIL,
        preview: preview(EMAIL, { html: '<p>Hi Marcus</p>', text: 'Hi Marcus' }),
        dryRun: true,
        undoSec: 10,
        onConfirm,
        onCancel,
      }),
    );
    const dlg = await waitFor(() => $('[role="dialog"][aria-modal="true"]'));
    expect(dlg.textContent).toContain('Send this email?');
    expect(dlg.textContent).toContain('Marcus Webb <marcus@globex.example>');
    expect(dlg.textContent).toContain('Elena Cruz <elena@example.com>');
    expect(dlg.textContent).toContain('Nothing leaves this machine');
    expect(dlg.textContent).toContain('10 s to undo');
    await waitFor(() => document.activeElement?.getAttribute('data-testid') === 'confirm-cancel');
    // One filled primary (@/ui Button marks its variant).
    expect($$('button[data-variant="primary"]', dlg)).toHaveLength(1);
    expect($('[data-testid="confirm-send"]', dlg)!.textContent).toContain('Send (dry run)');
    await click($('[data-testid="confirm-send"]', dlg));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('SendCountdownToast', () => {
  it('counts down and Undo calls back', async () => {
    const onUndo = vi.fn();
    vi.useFakeTimers({ toFake: ['Date'] }); // the seconds left are read off Date.now(): a frozen clock, so a slow render still says 7s
    try {
      const now = Date.now();
      const { container } = await render(h(SendCountdownToast, { deadline: now + 7_000, durationMs: 10_000, label: 'Sending to #acme-ext', onUndo, autoFocusUndo: false }));
      expect($('[data-testid="send-countdown"]', container)!.textContent).toMatch(/Sending to #acme-ext in 7s/);
      await click($('[data-testid="send-undo"]', container));
      expect(onUndo).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Composer send border (integration, mocked API)', () => {
  function mockApi(opts: { undoSec: number; draft?: Draft }) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    let current = opts.draft ?? draft();
    const settings = { sending: { version: 1, defaultMode: 'draft', dryRun: true, verifyReadback: true, undoWindowSec: opts.undoSec }, profile: { name: 'Jordan Lee', email: 'jordan@example.com', timezone: 'UTC' } };
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/v1/settings') return json(settings);
      if (url.pathname === '/api/v1/drafts/dr_1' && method === 'GET') return json(current);
      if (url.pathname === '/api/v1/drafts/dr_1' && method === 'PATCH') {
        current = { ...current, ...body, version: current.version + 1, userTouched: true, savedAt: new Date().toISOString() };
        delete (current as { ifVersion?: number }).ifVersion;
        return json({ entity: current, auditId: 'a1' });
      }
      if (url.pathname === '/api/v1/drafts/dr_1/preview') return json(preview(SLACK, { api: 'chat.postMessage', channel: 'C0ACME', thread_ts: '1.1', text: 'Hi Dana, confirmed for 13:00.' }, { version: current.version, mode: body.mode, confirmToken: `ct_dr_1_${current.version}_${body.mode}_x` }));
      if (url.pathname === '/api/v1/drafts/dr_1/dispatch') {
        const res: DispatchResult = {
          draft: { ...current, version: current.version + 1 },
          dryRun: true,
          payload: { text: 'Hi Dana' },
          rendition: { format: 'slack_mrkdwn', body: 'Hi Dana', text: 'Hi Dana', lossy: [] },
          attempt: { id: 'att', at: new Date().toISOString(), mode: body.mode, dryRun: true, outcome: 'rendered', detail: 'Dry run: payload rendered, nothing sent' },
          auditId: 'a2',
        };
        return json(res);
      }
      return json({ error: { code: 'not_found', message: url.pathname, retryable: false } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls };
  }

  const mount = (d: Draft = draft()) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(h(QueryClientProvider, { client: qc }, h(Composer, { draft: d })));
  };

  it('Send toggle → primary → confirm (server preview) → countdown → dispatch with the confirm token', async () => {
    const { calls } = mockApi({ undoSec: 1 });
    const { container } = await mount();
    const composer = await waitFor(() => $('[data-testid="composer"]', container));
    await waitFor(() => $('[data-testid="composer-editor"]', composer));
    await waitFor(() => !$('[data-testid="composer-primary"]', composer)!.hasAttribute('disabled'));

    // Draft ↔ Send toggle
    const sendRadio = $$('[role="radio"]', composer).find((b) => b.textContent === 'Send')!;
    await click(sendRadio);
    expect($('[data-testid="composer-primary"]', composer)!.textContent).toContain('Send');

    await click($('[data-testid="composer-primary"]', composer));
    const dlg = await waitFor(() => $('[role="dialog"][aria-modal="true"] [data-testid="confirm-dialog"]'));
    expect(dlg.textContent).toContain('Hi Dana, confirmed for 13:00.');
    // The mode change was saved before previewing, and the preview asked for "send".
    const order = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual(['PATCH /api/v1/drafts/dr_1', 'POST /api/v1/drafts/dr_1/preview']);
    expect(calls.find((c) => c.path.endsWith('/preview'))!.body).toEqual({ mode: 'send' });

    await click($('[data-testid="confirm-send"]'));
    const cd = await waitFor(() => $('[data-testid="send-countdown"]', composer));
    expect(cd.textContent).toContain('Sending to #acme-ext');
    expect(calls.some((c) => c.path.endsWith('/dispatch'))).toBe(false);

    await waitFor(() => $('[data-testid="send-status"][data-outcome="dry_run"]', composer), 4000);
    const dispatch = calls.filter((c) => c.path.endsWith('/dispatch'));
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]!.body).toEqual({ ifVersion: 2, mode: 'send', confirmToken: 'ct_dr_1_2_send_x' });
    expect($('[data-testid="send-status"]', composer)!.textContent).toContain('Dry run: payload rendered, nothing sent');
  });

  it('Undo during the countdown cancels the dispatch', async () => {
    const { calls } = mockApi({ undoSec: 1 });
    const { container } = await mount();
    const composer = await waitFor(() => $('[data-testid="composer"]', container));
    await waitFor(() => !$('[data-testid="composer-primary"]', composer)!.hasAttribute('disabled'));
    await click($('[data-testid="composer-primary"]', composer));
    await waitFor(() => $('[data-testid="confirm-send"]'));
    await click($('[data-testid="confirm-send"]'));
    await click(await waitFor(() => $('[data-testid="send-undo"]', composer)));
    await waitFor(() => $('[data-testid="send-status"][data-outcome="undone"]', composer));
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls.some((c) => c.path.endsWith('/dispatch'))).toBe(false);
    expect($('[data-testid="composer-primary"]', composer)).not.toBeNull();
  });

  it('a structured action (a VDP change, a logging canvas) is applied: the primary says Apply, not Send', async () => {
    const d = draft({ destination: ACTION, mode: 'send', status: 'ready' });
    mockApi({ undoSec: 0, draft: d });
    const { container } = await mount(d);
    const composer = await waitFor(() => $('[data-testid="composer"]', container));
    const primary = await waitFor(() => $('[data-testid="composer-primary"]', composer));
    expect(primary.textContent).toContain('Apply');
    expect(primary.textContent).not.toContain('Send');
  });

  it('Cancel on the confirm returns to editing without dispatching', async () => {
    const { calls } = mockApi({ undoSec: 0 });
    const { container } = await mount();
    const composer = await waitFor(() => $('[data-testid="composer"]', container));
    await waitFor(() => !$('[data-testid="composer-primary"]', composer)!.hasAttribute('disabled'));
    await click($('[data-testid="composer-primary"]', composer));
    await click(await waitFor(() => $('[data-testid="confirm-cancel"]')));
    await waitFor(() => !$('[role="dialog"][aria-modal="true"]'));
    expect(calls.some((c) => c.path.endsWith('/dispatch'))).toBe(false);
  });
});
