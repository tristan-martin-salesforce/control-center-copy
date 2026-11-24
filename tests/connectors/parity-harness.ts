/**
 * Parity harness (p1-connector-runtime): runs every connector's fetch over its recorded fixtures (`tests/fixtures/**`)
 * through a caller-chosen transport, so the same outputs can be compared before and after the `ConnectorRuntime`
 * seam. `tests/connectors/parity.test.ts` holds the snapshots.
 */
import { cp, mkdtemp, rm, utimes } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CalendarFetcher } from '@/connectors/google/calendar';
import { GeminiNotesFetcher } from '@/connectors/google/gemini-notes';
import { GmailFetcher } from '@/connectors/google/gmail';
import { TrainingsFetcher } from '@/connectors/google/trainings';
import { ClaudeSessionsFetcher, MemorySessionStateStore, type ClaudeSessionsOptions } from '@/connectors/claude/sessions';
import { VdpClient } from '@/connectors/vdp/client';
import { VdpFetcher } from '@/connectors/vdp/fetcher';
import { parseSlackChannel, parseSlackSearch } from '@/connectors/slack/parse';
import { org62RowToRaw, soqlRecords } from '@/llm/org62-rec';
import { DriveFetcher, MemoryDigestStore } from '@/scanner/drive-digest';
import type { VdpMirrorBatch, VdpMirrorSink, VdpSnapshot } from '@/lib/vdp/types';
import type { GoogleTools } from '@/connectors/google/client';

import { FakeGoogle, FIXTURES, fx, ME, signal, WINDOW } from './readers/helpers';
import { claudeJson, fixtureVdp, NOW as VDP_NOW } from '../vdp/helpers';

export const show = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const NOW = new Date('2026-03-10T18:00:00.000Z');
const clock = () => NOW;

export type GoogleConnector = 'gmail' | 'calendar' | 'drive' | 'gemini_notes' | 'trainings';
/** How a Google fetcher reaches its transport. Direct: the fixture fake is the transport. */
export type GoogleWrap = (fake: FakeGoogle, connector: GoogleConnector) => GoogleTools;
export const directGoogle: GoogleWrap = (fake) => fake;

export const gmailFake = () =>
  new FakeGoogle({
    search_gmail_messages: (a) => {
      const q = String(a.query);
      if (q.includes('has:attachment')) return fx('gmail', 'search_attachments.txt');
      return q.startsWith('in:sent') ? fx('gmail', 'search_sent.txt') : fx('gmail', 'search_inbox.txt');
    },
    get_gmail_messages_content_batch: (a) => ((a.message_ids as string[]).includes('18f0000000000004') ? fx('gmail', 'batch_sent.txt') : fx('gmail', 'batch_inbox.txt')),
    get_gmail_threads_content_batch: () => fx('gmail', 'threads_inbox.txt'),
  });
export const calendarFake = () => new FakeGoogle({ get_events: () => fx('calendar', 'events.txt') });
export const geminiFake = () =>
  new FakeGoogle({
    get_events: () => fx('calendar', 'events.txt'),
    get_doc_as_markdown: () => fx('gemini', 'notes.md'),
    search_drive_files: () => fx('gemini', 'drive_search_notes.txt'),
  });
export const trainingsFake = () =>
  new FakeGoogle({
    search_gmail_messages: () => fx('trainings', 'search_trainings.txt'),
    get_gmail_messages_content_batch: () => fx('trainings', 'batch_trainings.txt'),
    get_events: () => fx('calendar', 'events.txt').replace('"ACME_CORP workshop"', '"MANDATORY Partner Readiness Session"'),
  });
export const driveFake = () =>
  new FakeGoogle({
    search_drive_files: () => fx('drive', 'feed_deck_modified.txt'),
    get_presentation: () => fx('drive', 'presentation_v1.txt'),
    get_doc_as_markdown: () => fx('drive', 'doc_v1.md'),
    get_spreadsheet_info: () => fx('drive', 'sheet_info.txt'),
    read_sheet_values: (a) => (String(a.range_name).includes('Inputs') ? fx('drive', 'sheet_inputs_v1.txt') : fx('drive', 'sheet_outputs_v1.txt')),
  });

/** Every Google fetcher over its fixtures, through `wrap`: the result (items, coverage, cursor) of each scope. */
export async function googleOutputs(wrap: GoogleWrap): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const gmail = new GmailFetcher({ google: wrap(gmailFake(), 'gmail'), me: ME, clock });
  for (const scope of ['inbox', 'sent']) out[`gmail.${scope}`] = await gmail.fetch(scope, null, WINDOW, { signal });
  out['calendar.primary'] = await new CalendarFetcher({ google: wrap(calendarFake(), 'calendar'), me: ME, clock }).fetch('primary', null, WINDOW, { signal });
  const at = new Date('2026-03-10T15:50:00.000Z');
  out['gemini_notes.poll'] = await new GeminiNotesFetcher({ google: wrap(geminiFake(), 'gemini_notes'), me: ME, clock: () => at }).fetch('poll', null, { from: '2026-03-10T15:40:00.000Z', to: at.toISOString() }, { signal });
  out['trainings.gmail'] = await new TrainingsFetcher({ google: wrap(trainingsFake(), 'trainings'), me: ME, clock }).fetch('gmail', null, WINDOW, { signal });
  out['drive.tracked'] = await new DriveFetcher({ google: wrap(driveFake(), 'drive'), me: ME, store: new MemoryDigestStore(), linked: async () => [], clock: () => new Date('2026-03-10T17:30:00.000Z') }).fetch('tracked', null, WINDOW, { signal });
  return out;
}

class MemorySink implements VdpMirrorSink {
  batches: VdpMirrorBatch[] = [];
  stored = new Map<string, { lastActivityAt: string | null; snapshot: VdpSnapshot | null }>();
  async known() {
    return new Map(this.stored);
  }
  async save(b: VdpMirrorBatch) {
    this.batches.push(b);
    for (const s of b.snapshots) this.stored.set(s.id, { lastActivityAt: s.lastActivityAt, snapshot: s });
    return { written: b.snapshots.length, removed: 0 };
  }
}

/** How the VDP fetcher's client is built from its HTTP options. Direct: `new VdpClient(o)`. */
export type VdpMake = (o: ConstructorParameters<typeof VdpClient>[0]) => VdpClient;
export const directVdp: VdpMake = (o) => new VdpClient(o);

export async function vdpOutputs(make: VdpMake): Promise<unknown> {
  const vdp = fixtureVdp();
  const sink = new MemorySink();
  const client = make({ claudeJson: claudeJson({ cookieExpSec: VDP_NOW / 1000 + 3600 }), fetch: vdp.fetch, now: () => VDP_NOW });
  const f = new VdpFetcher({ client, sink, myEmails: ['me@example.com'], clock: () => new Date(VDP_NOW) });
  const window = { from: new Date(VDP_NOW - 30 * 60_000).toISOString(), to: new Date(VDP_NOW).toISOString() };
  const r = await f.fetch('mine', null, window, { signal });
  return { result: r, calls: vdp.calls.map((c) => [c.tool, c.args]), batches: sink.batches.map((b) => b.snapshots.map((s) => s.id)) };
}

const dirs: string[] = [];
export async function cleanupParity(): Promise<void> {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
}

/** How the Claude sessions fetcher's options are completed. Direct: as they are (node:fs). */
export type SessionsWrap = (o: ClaudeSessionsOptions) => ClaudeSessionsOptions;
export async function sessionsOutputs(wrap: SessionsWrap): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'cc-parity-'));
  dirs.push(dir);
  await cp(join(FIXTURES, 'claude'), dir, { recursive: true });
  const old = new Date(NOW.getTime() - 3600_000);
  for (const s of ['s-busy', 's-waiting-dialog', 's-ask', 's-plan', 's-done', 's-question', 's-courtesy', 's-idle-live', 's-apierr', 's-interrupted', 's-cctag', 's-compact', 's-sidechain', 's-sdk', 's-scheduled', 's-custom-title']) {
    const t = s === 's-busy' ? new Date(NOW.getTime() - 10_000) : old;
    await utimes(join(dir, 'projects', '-work-acme', `${s}.jsonl`), t, t);
  }
  const procs = async () => new Map<number, string>([1001, 1002, 1003, 1006, 1009].map((p) => [p, `Tue Mar 10 08:00:0${p % 10} 2026`] as [number, string]));
  const f = new ClaudeSessionsFetcher(wrap({ sessionsDir: join(dir, 'sessions'), projectsDir: join(dir, 'projects'), desktopDir: null, stateStore: new MemorySessionStateStore(), clock, listProcesses: procs, recentDays: 3650 }));
  const r = await f.fetch('all', null, { from: '2026-03-10T17:00:00.000Z', to: NOW.toISOString() }, { signal });
  // the temp folder differs per run, and so do inodes (the cursor carries them)
  return JSON.parse(JSON.stringify(r).split(dir).join('<dir>').replace(/\\"i\\":\d+/g, '\\"i\\":0'));
}

/** How a relayed tool's output reaches the parser. Direct: the recorded fixture file's text. */
export type RelayRead = (connector: 'slack' | 'org62', tool: string, fixture: string) => Promise<string>;
export const directRelay: RelayRead = async (connector, _tool, fixture) => readFileSync(join(FIXTURES, connector, fixture), 'utf8');

/** Slack and Org62 are read through the Claude relay: their parity is the parse of the relayed tool output. */
export async function relayParses(read: RelayRead): Promise<Record<string, unknown>> {
  const slack = async (tool: string, name: string) => JSON.parse(await read('slack', tool, name)) as unknown;
  const org62 = (name: string) => read('org62', 'soqlQuery', name);
  return {
    'slack.search_to_me': parseSlackSearch(await slack('slack_search_public_and_private', 'search_to_me.detailed.v1.json')),
    'slack.search_thread_reply': parseSlackSearch(await slack('slack_search_public_and_private', 'search_thread_reply.detailed.v1.json')),
    'slack.read_channel': parseSlackChannel(await slack('slack_read_channel', 'read_channel.detailed.v1.json'), 'C0PLACEHOLDER'),
    'org62.event': (soqlRecords(await org62('event.soql.v1.json')) ?? []).map(org62RowToRaw),
    'org62.opp_team': (soqlRecords(await org62('opp_team.soql.v1.json')) ?? []).map(org62RowToRaw),
    'org62.dc': (soqlRecords(await org62('dc.soql.v1.json')) ?? []).map(org62RowToRaw),
  };
}
