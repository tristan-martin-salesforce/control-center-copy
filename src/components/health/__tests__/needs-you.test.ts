// @vitest-environment jsdom
/**
 * Health's loud part (NeedsYou) draws what the header dot counts: a broken connector (with what it affects), the
 * dead worker, the hard cap, the soft budget alert; a catching-up source and a calm budget draw nothing. These rules
 * were pinned on a `healthBanners` derive no screen read (audit 2026-11-13 C9); they now pin the drawn component.
 * Placeholder data only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthPayload } from '@/contract';
import { $, cleanup, render } from '../../composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/health',
  useSearchParams: () => new URLSearchParams(),
}));

const { NeedsYou } = await import('../NeedsYou');

const conn = (id: string, state: string, extra: object = {}) => ({ id, label: id.toUpperCase(), state, impact: null, since: '2026-11-05T09:40:00Z', reauth: null, lastError: null, ...extra });
const health = (over: Record<string, unknown> = {}) =>
  ({
    connectors: [conn('slack', 'ok'), conn('gmail', 'auth_needed', { impact: 'Email items after 09:40 may be missing' })],
    summary: { ok: 1, total: 2, worst: 'auth_needed', broken: [{ id: 'gmail', label: 'GMAIL', state: 'auth_needed' }] },
    spend: { today: { usd: 4.2, softBudgetUsd: 5, hardCapUsd: 15, pct: 84 }, state: 'soft_alert', last7d: [], byScanner: [], byModel: [] },
    worker: { alive: true, lastHeartbeatAt: null, queueDepth: 0 },
    dryRun: true,
    ...over,
  }) as unknown as HealthPayload;

const actions = { reauthing: () => false, scanning: () => false, reauth: { mutate: vi.fn() }, scan: { mutate: vi.fn() } } as never;
const mount = (hp: HealthPayload) =>
  render(h(QueryClientProvider, { client: new QueryClient() }, h(NeedsYou, { h: hp, now: '2026-11-05T12:00:00Z', tz: 'UTC', actions, onOpen: vi.fn() })));

afterEach(cleanup);

describe('Health ▸ Needs you', () => {
  it('a broken connector says what it affects; the soft budget alert is an amber line', async () => {
    const { container } = await mount(health());
    const gmail = $('[data-broken="gmail"]', container)!;
    expect(gmail.textContent).toContain('GMAIL needs re-auth');
    expect(gmail.textContent).toContain('09:40 may be missing');
    expect($('[data-broken="slack"]', container)).toBeNull();
    expect($('[data-health-amber]', container)?.textContent).toContain('84% of today’s soft budget used');
    expect($('[data-health-system]', container)).toBeNull();
  });

  it('the dead worker and the hard cap are loud', async () => {
    const worker = await mount(health({ worker: { alive: false, lastHeartbeatAt: null, queueDepth: 0 } }));
    expect($('[data-health-system]', worker.container)?.textContent).toContain('The background worker stopped');
    await cleanup();
    const capped = await mount(health({ connectors: [conn('slack', 'ok')], spend: { ...health().spend, state: 'capped' } }));
    expect($('[data-health-system]', capped.container)?.textContent).toContain('hard spend cap is reached');
  });

  it('a catching-up source and a calm budget draw nothing', async () => {
    const { container } = await mount(health({ connectors: [conn('slack', 'catching_up')], spend: { ...health().spend, state: 'ok' } }));
    expect($('[data-health-loud]', container)).toBeNull();
  });
  it('a broken connector says the Setup row\'s words and links to it, never its raw error', async () => {
    const setup = { dependencies: [{ id: 'slack-mcp', label: 'Slack', why: 'w', state: 'signed_out', code: 'AUTH.SLACK.SIGNED_OUT', nextStep: 'n', lastChecked: null }] };
    const { container } = await mount(
      health({ setup, connectors: [conn('slack', 'auth_needed', { source: 'slack', lastError: { class: 'auth', message: 'invalid_auth: xoxp-secret', at: '2026-11-05T09:40:00Z', count: 1 } })] }),
    );
    const block = $('[data-broken="slack"]', container)!;
    expect($('[data-problem-code]', block)!.getAttribute('data-problem-code')).toBe('AUTH.SLACK.SIGNED_OUT');
    expect(block.textContent).toContain('Slack needs you to sign in');
    expect(block.textContent).not.toContain('xoxp');
    expect(($('[data-setup-link="slack-mcp"]', block) as HTMLAnchorElement).getAttribute('href')).toBe('/health?tab=setup#setup-slack-mcp');
  });
});
