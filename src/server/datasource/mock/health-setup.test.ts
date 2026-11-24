/**
 * Mock Health ▸ Setup: the seed's connectors decide by default; CC_MOCK_SETUP=demo shows a new teammate's Mac (Slack
 * signed out, devbar not installed) for screenshots.
 */
import { describe, expect, it } from 'vitest';
import type { Connector } from '@/contract';
import { setupDependencies } from '@/ops/doctor-service';
import { mockDoctorChecks } from './health-setup';

const conn = (source: string, state: string) => ({ id: source, label: source, source, state }) as unknown as Connector;
const connectors = [conn('slack', 'ok'), conn('gmail', 'ok'), conn('org62', 'ok')];
const rows = (env: Record<string, string | undefined>) => Object.fromEntries(setupDependencies({ checks: mockDoctorChecks(connectors, env), generated_at: '2026-11-20T12:00:00Z' }).map((d) => [d.id, d]));

describe('mock setup fixtures', () => {
  it('follow the seed by default', () => {
    const r = rows({});
    expect(r['slack-mcp']!.state).toBe('ok');
    expect(r.devbar!.state).toBe('ok');
  });
  it("CC_MOCK_SETUP=demo: Slack signed out, devbar missing, in the catalog's words", () => {
    const r = rows({ CC_MOCK_SETUP: 'demo' });
    expect(r['slack-mcp']).toMatchObject({ state: 'signed_out', code: 'AUTH.SLACK.SIGNED_OUT' });
    expect(r.devbar).toMatchObject({ state: 'missing', code: 'DEP.DEVBAR.MISSING' });
    expect(r['org62-mcp']!.state).toBe('ok');
  });
});
