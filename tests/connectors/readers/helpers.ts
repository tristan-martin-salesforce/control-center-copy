import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectorHealthProbe } from '@/scanner/types';
import { assertReadTool, type GoogleTools } from '@/connectors/google/client';

export const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'scanner');
export const fx = (...p: string[]): string => readFileSync(join(FIXTURES, ...p), 'utf8');

export const ME = { email: 'me@example.com', name: 'Pat Example' };
/** 2026-03-10 11:00 PDT. */
export const NOW = new Date('2026-03-10T18:00:00.000Z');
export const clock = () => NOW;
export const signal = new AbortController().signal;
export const WINDOW = { from: '2026-03-10T17:00:00.000Z', to: '2026-03-10T18:00:00.000Z' };

export type Handler = (args: Record<string, unknown>) => string;

/** Fixture-backed stand-in for devbar's google_workspace_readonly. Enforces the same read allowlist as the real client. */
export class FakeGoogle implements GoogleTools {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  constructor(public routes: Record<string, Handler>) {}
  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    assertReadTool(tool);
    this.calls.push({ tool, args });
    const h = this.routes[tool];
    if (!h) throw new Error(`FakeGoogle: no route for ${tool}`);
    return h(args);
  }
  async health(): Promise<ConnectorHealthProbe> {
    return { state: 'ok', checkedAt: NOW.toISOString() };
  }
  count(tool: string) {
    return this.calls.filter((c) => c.tool === tool).length;
  }
}

export const keyOf = (i: { dedupeKey: string; contentHash: string }) => `${i.dedupeKey}|${i.contentHash}`;
