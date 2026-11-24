/**
 * The Google family: devbar's `google_workspace_readonly` MCP server, called directly (`direct_mcp`; the gateway owns
 * auth, the app sees no token). One client serves all five; each manifest lists only the read tools its fetcher calls
 * (a subset of `GOOGLE_READ_TOOLS`, src/connectors/google/client.ts), and its runtime refuses any other.
 */
import { runtimeProbe } from '../runtime/probes';
import type { ConnectorManifest } from '../runtime/types';

import { parseDocSections, parseDriveSearch, parseEvents, parseGmailBatch, parseGmailSearch, parseGmailThread, parsePresentation, parseSpreadsheetSheets } from './parse';

const H = 3_600_000;
const MIN = 60_000;

/** devbar's gateway server name (the mcpgw proxy path). */
export const GOOGLE_SERVER = 'google_workspace_readonly';

/** Codes `classifyGoogleError` gives (src/connectors/google/client.ts). */
export const GOOGLE_FAILURE_CODES = ['auth', 'gateway_down', 'gateway_error', 'daemon_down', 'rate_limited', 'transient', 'not_found', 'no_access', 'bad_request', 'config', 'unknown'] as const;

const auth = (reauth: boolean): ConnectorManifest['auth'] => ({
  kind: 'devbar_gateway',
  check: 'devbar_status',
  // REAUTH_KIND_OF (src/reauth/run.ts) starts devbar's sign-in for these four; Trainings rides on Gmail's
  reauthHint: reauth ? { handler: 'google', kind: 'in_app', hint: 'Reconnect Google in devbar (Health ▸ Re-auth)' } : { handler: null, kind: null, hint: 'Signs in with Gmail' },
});

const base = {
  runtime: 'direct_mcp' as const,
  server: GOOGLE_SERVER,
  windows: { default: 24 * H, max: 14 * 24 * H },
  healthCheck: runtimeProbe,
  failureCodes: GOOGLE_FAILURE_CODES,
};

export const gmailManifest: ConnectorManifest = {
  ...base,
  id: 'gmail',
  label: 'Gmail',
  scopes: ['inbox', 'sent'],
  auth: auth(true),
  readTools: ['search_gmail_messages', 'get_gmail_messages_content_batch', 'get_gmail_threads_content_batch'],
  cadence: { baseMs: 3 * MIN },
  estimate: { usdPerDay: 0.3 },
  parse: { search: parseGmailSearch, batch: parseGmailBatch, thread: parseGmailThread },
  scan: { mode: 'deterministic', skill: 'scan-gmail', chunkMs: 12 * H, maxItemsPerRun: 25 },
};

export const calendarManifest: ConnectorManifest = {
  ...base,
  id: 'calendar',
  label: 'Calendar',
  scopes: ['primary'],
  auth: auth(true),
  readTools: ['get_events'],
  cadence: { baseMs: 5 * MIN },
  estimate: { usdPerDay: 0.1 },
  parse: { events: parseEvents },
  // first-scan history is one listing call per day chunk and no agent run (record-only, FS-CAL-1)
  scan: { mode: 'deterministic', skill: 'scan-calendar', chunkMs: 12 * H, firstScanChunkMs: 24 * H, maxItemsPerRun: 25 },
};

export const driveManifest: ConnectorManifest = {
  ...base,
  id: 'drive',
  label: 'Drive',
  scopes: ['tracked'],
  auth: auth(true),
  // get_drive_file_content: the release feed (a small JSON file in the shared folder; D-90, RELEASE_FEED_READ_TOOLS)
  readTools: ['search_drive_files', 'get_presentation', 'get_doc_as_markdown', 'get_spreadsheet_info', 'read_sheet_values', 'get_drive_file_content'],
  cadence: { baseMs: 10 * MIN },
  estimate: { usdPerDay: 0.2 },
  parse: { search: parseDriveSearch, presentation: parsePresentation, doc: parseDocSections, sheet: parseSpreadsheetSheets },
  scan: { mode: 'deterministic', skill: 'scan-drive', chunkMs: 24 * H, maxItemsPerRun: 25 },
};

export const geminiNotesManifest: ConnectorManifest = {
  ...base,
  id: 'gemini_notes',
  label: 'Gemini notes',
  scopes: ['poll'],
  auth: auth(true),
  readTools: ['get_events', 'search_drive_files', 'get_doc_as_markdown'],
  cadence: { baseMs: 10 * MIN },
  estimate: { usdPerDay: 0.2 },
  parse: { events: parseEvents, search: parseDriveSearch, doc: parseDocSections },
  scan: { mode: 'deterministic', skill: 'scan-gemini-notes', chunkMs: 12 * H, maxItemsPerRun: 25 },
};

export const trainingsManifest: ConnectorManifest = {
  ...base,
  id: 'trainings',
  label: 'Trainings',
  scopes: ['gmail', 'calendar'],
  auth: auth(false),
  readTools: ['search_gmail_messages', 'get_gmail_messages_content_batch', 'get_events'],
  cadence: { baseMs: 24 * 60 * MIN },
  estimate: { usdPerDay: 0.02 },
  parse: { search: parseGmailSearch, batch: parseGmailBatch, events: parseEvents },
  scan: { mode: 'deterministic', skill: 'scan-trainings', chunkMs: 12 * H, maxItemsPerRun: 25 },
};

/**
 * D-90: the update check's two reads of the shared release folder, through the Drive connector's runtime: find the
 * feed (`search_drive_files`, name = manifest.json in the folder) and read it (`get_drive_file_content`, its text).
 * Both are on GOOGLE_READ_TOOLS and on the Drive manifest; nothing here downloads or writes a file.
 */
export const RELEASE_FEED_READ_TOOLS = ['search_drive_files', 'get_drive_file_content'] as const;

export const GOOGLE_MANIFESTS = [gmailManifest, calendarManifest, driveManifest, geminiNotesManifest, trainingsManifest] as const;
