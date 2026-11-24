/**
 * Health ▸ Setup and GET /doctor in mock mode (11 R6): plausible fixture states, nothing on this Mac is checked. The
 * source rows follow the seed's connectors (a Gmail the scenario signs out reads "signed out" here too), the machine
 * rows are healthy, and the Claude sign-in waits for Check again, as on a new install.
 */
import type { Connector, DoctorPayload, SetupSection } from '@/contract';
import { render } from '@/errors/render';
import type { CheckResult } from '@/ops/checks/types';
import { setupDependencies, toPayload } from '@/ops/doctor-service';
import type { DependencyState } from '@/reauth/types';

const GOOGLE = ['gmail', 'calendar', 'drive', 'gemini'];

function fromConnector(c: Connector | undefined, codes: { signedOut: string; down: string }): { state: DependencyState; code?: string } {
  if (!c) return { state: 'unknown' };
  if (c.state === 'auth_needed') return { state: 'signed_out', code: codes.signedOut };
  if (c.state === 'offline' || c.state === 'error') return { state: 'offline', code: codes.down };
  if (c.state === 'paused') return { state: 'unknown' };
  return { state: 'ok' };
}

/**
 * `CC_MOCK_SETUP=demo` (mock only, for screenshots and demos of Health ▸ Setup and Getting started): a new teammate's
 * Mac, with Slack signed out and devbar not installed, whatever the seed's connectors say. Unset: the seed decides.
 */
function demoOverlay(checks: CheckResult[], env: Record<string, string | undefined>): CheckResult[] {
  if (env.CC_MOCK_SETUP !== 'demo') return checks;
  return checks.map((c) => {
    if (c.id === 'mcp') {
      const slack = { state: 'signed_out' as const, code: 'AUTH.SLACK.SIGNED_OUT' };
      const setup = { ...((c.data?.setup as Record<string, unknown>) ?? {}), slack };
      return { ...c, status: 'warn' as const, state: 'signed_out' as const, code: slack.code, detail: `${render(slack.code).title} (mock)`, data: { ...c.data, setup } };
    }
    if (c.id === 'devbar') return { id: c.id, label: c.label, status: 'fail' as const, state: 'missing' as const, code: 'DEP.DEVBAR.MISSING', detail: `${render('DEP.DEVBAR.MISSING').title} (mock)` };
    return c;
  });
}

/** The fixture checks the rows (and the mock GET /doctor) are built from. */
export function mockDoctorChecks(connectors: Connector[], env: Record<string, string | undefined> = process.env): CheckResult[] {
  return demoOverlay(seedChecks(connectors), env);
}

function seedChecks(connectors: Connector[]): CheckResult[] {
  // by source kind, not id: a db DataSource's connector ids are uuids (parity)
  const by = new Map(connectors.map((c) => [c.source as string, c]));
  const slack = fromConnector(by.get('slack'), { signedOut: 'AUTH.SLACK.SIGNED_OUT', down: 'NET.SERVICE_DOWN' });
  const org62 = fromConnector(by.get('org62'), { signedOut: 'AUTH.ORG62.SIGNED_OUT', down: 'NET.SERVICE_DOWN' });
  const google = GOOGLE.map((id) => fromConnector(by.get(id), { signedOut: 'AUTH.GOOGLE.CONNECTOR_MISSING', down: 'NET.GATEWAY_DOWN' })).find((g) => g.state !== 'ok' && g.state !== 'unknown') ?? { state: 'ok' as const };
  const vdp = by.get('vdp') ? fromConnector(by.get('vdp'), { signedOut: 'AUTH.VDP.COOKIE_EXPIRED', down: 'NET.VPN_REQUIRED' }) : null;
  const okRow = (id: string, label: string, detail: string): CheckResult => ({ id, label, status: 'ok', detail, state: 'ok' });
  const fromState = (id: string, label: string, s: { state: DependencyState; code?: string }, data?: Record<string, unknown>): CheckResult =>
    s.state === 'ok' ? { ...okRow(id, label, 'ok (mock)'), ...(data ? { data } : {}) } : { id, label, status: 'warn', detail: `${s.code ? render(s.code).title : s.state} (mock)`, state: s.state, ...(s.code ? { code: s.code } : {}), ...(data ? { data } : {}) };
  return [
    okRow('node', 'Node.js', 'v22 (mock)'),
    okRow('postgres', 'Postgres 17', 'accepting connections (mock)'),
    okRow('database', 'Database command_center', 'exists (mock)'),
    okRow('migrations', 'Migrations', 'all applied (mock)'),
    okRow('claude', 'claude CLI', '2.1.329 (Claude Code) (mock)'),
    fromState('mcp', 'MCP servers (Slack, Org62)', slack.state !== 'ok' ? slack : org62, { setup: { slack, 'Org62-Sobject-Read': org62 } }),
    fromState('devbar', 'devbar + Google bridge', google),
    ...(vdp ? [fromState('vdp', 'VDP access', vdp)] : []),
    okRow('heartbeat', 'Worker heartbeat', 'running (mock)'),
  ];
}

export function mockHealthSetup(connectors: Connector[], now: Date): SetupSection {
  return { dependencies: setupDependencies({ checks: mockDoctorChecks(connectors), generated_at: now.toISOString() }, null) };
}

export function mockDoctorPayload(connectors: Connector[], now: Date): DoctorPayload {
  const checks = mockDoctorChecks(connectors);
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return toPayload({ generated_at: now.toISOString(), ok: summary.fail === 0, summary, checks }, { cached: false, simulated: true, smoke: null });
}
