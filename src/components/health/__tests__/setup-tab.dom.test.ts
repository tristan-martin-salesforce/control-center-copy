// @vitest-environment jsdom
/**
 * Health ▸ Setup as drawn: each state's chip, words and buttons; the anchor per row; the catalog walk (every code renders
 * on a row without throwing, and its raw code shows only inside the muted "code" chip). Placeholder data only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DependencyState, HealthPayload, PersonaId, SetupDependency } from '@/contract';
import { healthForPersona, personaOf, type ResolvedPersona } from '@/personas';
import { allCodes, render as renderCode } from '@/errors/render';
import { $, $$, cleanup, render } from '../../composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/health',
  useSearchParams: () => new URLSearchParams(),
}));

const who: { p: ResolvedPersona | null } = { p: null };
vi.mock('@/client/persona', () => ({ usePersona: () => who.p }));
vi.mock('../report', () => ({ useReportProblem: () => vi.fn() }));

const { SetupList, SetupTab, pickDeps } = await import('../SetupTab');

const NOW = Date.parse('2026-11-20T12:00:00Z');
const dep = (id: string, state: DependencyState, code?: string, extra: Partial<SetupDependency> = {}): SetupDependency => {
  const r = code ? renderCode(code) : null;
  return { id, label: `Dep ${id}`, why: `Why ${id}.`, state, lastChecked: '2026-11-20T11:58:00Z', ...(code ? { code, nextStep: r!.nextStep, ...(r!.action ? { action: r!.action } : {}) } : {}), ...extra };
};

const mount = (deps: SetupDependency[], onButton = vi.fn(), onCheckAll = vi.fn()) => render(h(SetupList, { deps, nowMs: NOW, onButton, onCheckAll }));

afterEach(cleanup);

describe('Health ▸ Setup', () => {
  it('draws one row per dependency, needs-you first, each at #setup-<id>, with the summary and the stamp', async () => {
    const { container } = await mount([dep('database', 'ok'), dep('slack-mcp', 'signed_out', 'AUTH.SLACK.SIGNED_OUT'), dep('claude-signin', 'unknown')]);
    const rows = $$('[data-setup-row]', container);
    expect(rows.map((r) => r.getAttribute('data-setup-row'))).toEqual(['slack-mcp', 'claude-signin', 'database']);
    expect(rows[0]!.id).toBe('setup-slack-mcp');
    expect($('[data-setup-summary]', container)!.textContent).toBe("1 needs you · 1 can't tell yet");
    expect($('[data-setup-checked]', container)!.textContent).toBe('checked 2 min ago');
  });

  it('signed out: chip, the catalog problem and next step, Re-auth then Check again, the code only in its chip', async () => {
    const onButton = vi.fn();
    const { container } = await mount([dep('slack-mcp', 'signed_out', 'AUTH.SLACK.SIGNED_OUT')], onButton);
    const row = $('[data-setup-row="slack-mcp"]', container)!;
    const r = renderCode('AUTH.SLACK.SIGNED_OUT');
    expect(row.textContent).toContain('Signed out');
    expect(row.textContent).toContain(r.title);
    expect($('[data-setup-next]', row)!.textContent).toBe(`Next step: ${r.nextStep}`);
    expect($('[data-code-chip]', row)!.textContent).toContain('AUTH.SLACK.SIGNED_OUT');
    const reauth = $('[data-testid="setup-reauth-slack-mcp"]', row) as HTMLButtonElement;
    expect(reauth.textContent).toContain('Re-auth Slack');
    reauth.click();
    expect(onButton).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reauth', ref: 'slack' }), expect.objectContaining({ id: 'slack-mcp' }));
    expect($('[data-testid="setup-check-slack-mcp"]', row)).not.toBeNull();
  });

  it('a run action shows the command in a copy box; Check again verifies it', async () => {
    const { container } = await mount([dep('worker', 'missing', 'DEP.WORKER.DOWN')]);
    const row = $('[data-setup-row="worker"]', container)!;
    expect($('[data-command-text]', row)!.textContent).toBe(renderCode('DEP.WORKER.DOWN').action!.ref);
    expect($('[data-testid="setup-check-worker"]', row)).not.toBeNull();
    expect($('[data-testid^="setup-run-"]', row)).toBeNull();
  });

  it('unknown and offline never read as broken', async () => {
    const { container } = await mount([dep('slack-mcp', 'unknown'), dep('org62-mcp', 'offline', 'NET.VPN_REQUIRED')]);
    for (const id of ['slack-mcp', 'org62-mcp']) {
      const row = $(`[data-setup-row="${id}"]`, container)!;
      expect($('[data-edge]', row)!.getAttribute('data-edge')).not.toBe('danger');
      expect($('[data-tone]', row)!.getAttribute('data-tone')).toBe('neutral');
    }
    expect($('[data-setup-row="slack-mcp"]', container)!.textContent).toContain("Can't tell right now; retrying.");
    expect($('[data-setup-summary]', container)!.textContent).toContain("can't tell yet");
    expect(container.querySelector('[data-setup]')!.getAttribute('data-setup-needs')).toBe('0');
  });

  it('the Claude test shows its price before the click', async () => {
    const onButton = vi.fn();
    const { container } = await mount([dep('claude-signin', 'unknown', undefined, { nextStep: 'Click Check again to test Claude (about $0.001).', lastChecked: null })], onButton);
    const b = $('[data-testid="setup-smoke-claude-signin"]', container) as HTMLButtonElement;
    expect(b.textContent).toContain('Test Claude (about $0.001)');
    b.click();
    expect(onButton).toHaveBeenCalledWith(expect.objectContaining({ kind: 'smoke' }), expect.anything());
  });

  it('Check again in the header re-runs every check', async () => {
    const onCheckAll = vi.fn();
    const { container } = await mount([dep('database', 'ok')], vi.fn(), onCheckAll);
    ($('[data-testid="setup-check-all"]', container) as HTMLButtonElement).click();
    expect(onCheckAll).toHaveBeenCalledOnce();
    expect($('[data-setup-summary]', container)!.textContent).toBe('Everything is ready');
  });

  it('walks the catalog: each code renders without throwing, and shows raw only in the muted code chip', async () => {
    for (const code of allCodes()) {
      const { container } = await mount([dep('x', 'signed_out', code), dep('y', 'offline', code)]);
      for (const row of $$('[data-setup-row]', container)) {
        const chip = $('[data-code-chip]', row);
        expect(chip?.textContent, code).toContain(code);
        const outside = (row.textContent ?? '').replace(chip?.textContent ?? '', '');
        expect(outside, code).not.toContain(code);
      }
      await cleanup();
    }
  });

  it('prefers a Check again run newer than the payload', () => {
    const old = [dep('a', 'signed_out', 'AUTH.SLACK.SIGNED_OUT')];
    const fresh = { generatedAt: '2026-11-20T11:59:00Z', dependencies: [dep('a', 'ok')] };
    expect(pickDeps(old, fresh)[0]!.state).toBe('ok');
    expect(pickDeps(old, { ...fresh, generatedAt: '2026-11-20T11:00:00Z' })[0]!.state).toBe('signed_out');
    expect(pickDeps(undefined, null)).toEqual([]);
  });
});

// 29-persona-qa (D-55): the VDP row (and its "needs you") shows only for a persona with the VDP source; Claude sign-in and
// the app's own rows always show. The server filters the payload (healthForPersona); the tab filters a Check again run.
const pdep = (id: string, state: SetupDependency['state']): SetupDependency => ({ id, label: id, why: `Why ${id}.`, state, lastChecked: '2026-11-20T11:58:00Z' });
const DEPS = [pdep('vdp-access', 'signed_out'), pdep('claude-signin', 'unknown'), pdep('slack-mcp', 'ok'), pdep('database', 'ok')];
const health = { connectors: [], summary: { ok: 0, total: 0, worst: 'ok', broken: [] }, setup: { dependencies: DEPS } } as unknown as HealthPayload;

describe.each([
  { persona: 'se' as PersonaId, rows: ['vdp-access', 'claude-signin', 'slack-mcp', 'database'] },
  { persona: 'ae' as PersonaId, rows: ['claude-signin', 'slack-mcp', 'database'] },
])('Health ▸ Setup as the $persona persona', ({ persona, rows }) => {
  it('lists only the dependencies of its sources, on the server and in the tab', async () => {
    who.p = personaOf({ persona: { id: persona } });
    const served = healthForPersona(health, who.p);
    expect(served.setup!.dependencies.map((d) => d.id)).toEqual(rows);
    // the tab, given the unfiltered rows (as a Check again run returns them), draws the same set
    const qc = new QueryClient();
    const { container } = await render(h(QueryClientProvider, { client: qc }, h(SetupTab, { h: health, connectors: [], actions: { reauth: { mutate: vi.fn() }, reauthing: () => false } as never })));
    expect($$('[data-setup-row]', container).map((r) => r.getAttribute('data-setup-row')).sort()).toEqual([...rows].sort());
  });
});
