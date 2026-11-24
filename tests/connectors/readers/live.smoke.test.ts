/**
 * Live smoke test: runs every deterministic fetcher once against real data for a 1 h window.
 * Gated by CC_LIVE=1. Read-only, no LLM cost. Prints counts and timings only (no content).
 *   CC_LIVE=1 CC_ME_EMAIL=<you@example.com> CC_ME_NAME="First Last" npx vitest run tests/connectors/readers/live.smoke.test.ts
 */
import { describe, expect, it } from 'vitest';
import { ClaudeSessionsFetcher, MemorySessionStateStore } from '@/connectors/claude/sessions';
import { CalendarFetcher } from '@/connectors/google/calendar';
import { GoogleWorkspaceClient } from '@/connectors/google/client';
import { GeminiNotesFetcher } from '@/connectors/google/gemini-notes';
import { GmailFetcher } from '@/connectors/google/gmail';
import { TrainingsFetcher } from '@/connectors/google/trainings';
import { DriveFetcher, MemoryDigestStore } from '@/scanner/drive-digest';
import type { DeterministicFetcher } from '@/scanner/types';

const LIVE = process.env.CC_LIVE === '1';

describe.skipIf(!LIVE)('live smoke (CC_LIVE=1)', () => {
  const email = process.env.CC_ME_EMAIL ?? '';
  const name = process.env.CC_ME_NAME ?? '';
  const google = new GoogleWorkspaceClient();
  const me = { email, name };
  const to = new Date();
  const from = new Date(to.getTime() - 3600_000);
  const window = { from: from.toISOString(), to: to.toISOString() };
  const rows: Array<Record<string, unknown>> = [];

  const run = async (label: string, f: DeterministicFetcher, scope: string) => {
    const t0 = Date.now();
    const ac = new AbortController();
    const r = await f.fetch(scope, null, window, { signal: ac.signal, limit: 10 });
    const ms = Date.now() - t0;
    // Idempotency: a second run from the returned cursor must not re-emit the same dedupeKey+hash pairs.
    const again = await f.fetch(scope, r.nextCursor, { from: r.nextCursor.at, to: new Date().toISOString() }, { signal: ac.signal, limit: 10 });
    const first = new Set(r.items.map((i) => `${i.dedupeKey}|${i.contentHash}`));
    const dupes = again.items.filter((i) => first.has(`${i.dedupeKey}|${i.contentHash}`)).length;
    const kinds = r.items.reduce<Record<string, number>>((m, i) => ((m[i.kind] = (m[i.kind] ?? 0) + 1), m), {});
    rows.push({ fetcher: label, scope, items: r.items.length, kinds, coverage: r.coverage.length, complete: r.complete, ms, secondRunItems: again.items.length, secondRunDupes: dupes });
    expect(dupes).toBe(0);
    expect(r.coverage.length).toBeGreaterThan(0);
  };

  it('health', async () => {
    const t0 = Date.now();
    const h = await google.health();
    rows.push({ fetcher: 'google.health', state: h.state, ms: Date.now() - t0 });
    expect(h.state).toBe('ok');
    const unknown = await google.unknownServerTools();
    rows.push({ fetcher: 'google.tools', unknownServerTools: unknown });
  });
  it('gmail inbox + sent', async () => {
    const f = new GmailFetcher({ google, me });
    await run('gmail', f, 'inbox');
    await run('gmail', f, 'sent');
  });
  it('calendar', async () => run('calendar', new CalendarFetcher({ google, me }), 'primary'));
  it('gemini_notes', async () => run('gemini_notes', new GeminiNotesFetcher({ google, me }), 'poll'));
  it('drive', async () => run('drive', new DriveFetcher({ google, me, store: new MemoryDigestStore(), maxSamplesPerRun: 3, maxFeedPages: 1 }), 'tracked'));
  it('trainings', async () => {
    const f = new TrainingsFetcher({ google, me, initialLookbackDays: 1 });
    await run('trainings', f, 'gmail');
    await run('trainings', f, 'calendar');
  });
  it('claude_sessions', async () => run('claude_sessions', new ClaudeSessionsFetcher({ stateStore: new MemorySessionStateStore(), desktopDir: undefined, recentDays: 1 }), 'all'));

  it('report', () => {
    console.log('LIVE_SMOKE_RESULT ' + JSON.stringify(rows));
  });
});
