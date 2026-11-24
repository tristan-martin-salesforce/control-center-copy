/**
 * The read-in agent's in-process tools (server `cc_readin`), all read-only:
 *
 *   readin_ledger_search   the internal ledger: my earlier messages, prior work items, what I said or promised
 *   readin_gmail_search    Gmail search      → devbar google_workspace_readonly `search_gmail_messages`
 *   readin_gmail_thread    one Gmail thread  → `get_gmail_thread_content`
 *   readin_drive_search    Drive search      → `search_drive_files` (metadata)
 *   readin_drive_read      one Drive file    → `get_drive_file_content` (paged)
 *   readin_finish          the structured result (zod-validated); the run ends after it
 *
 * Google calls go through `GoogleWorkspaceClient`, whose code-level read allowlist refuses anything else; the four
 * names below are a subset of it (never widened). Every result is redacted (credential-like text masked) and paged
 * (`offset`; searches also take the source's `page_token`), never cut (ASSIST-5, 2026-11-20); a thread or file is
 * fetched once per run and its later pages read from that copy. Every URL in it is remembered so the output may only
 * cite links it was shown.
 * Slack and Org62 are not here: the agent reaches them through their own restricted MCP servers (agent.ts).
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@/llm/provider';
import { z } from 'zod';

import { assertReadTool, type GoogleTools } from '@/connectors/google/client';
import { redactText } from '@/llm/redact';

import { READIN_OUTPUT_SHAPE, ReadInOutput } from './types';

export const READIN_SERVER = 'cc_readin';
export const readinToolName = (bare: string) => `mcp__${READIN_SERVER}__${bare}`;

export const READIN_TOOL_NAMES = ['readin_ledger_search', 'readin_gmail_search', 'readin_gmail_thread', 'readin_drive_search', 'readin_drive_read', 'readin_finish'] as const;
export type ReadInToolName = (typeof READIN_TOOL_NAMES)[number];
export const READIN_ALLOWED_TOOLS = READIN_TOOL_NAMES.map(readinToolName);

/** The Google read tools a read-in may use: a subset of GOOGLE_READ_TOOLS (src/connectors/google/client.ts). */
export const READIN_GOOGLE_TOOLS = ['search_gmail_messages', 'get_gmail_thread_content', 'search_drive_files', 'get_drive_file_content'] as const;
for (const t of READIN_GOOGLE_TOOLS) assertReadTool(t); // throws at import if the allowlist ever drops one

export interface LedgerHit {
  kind: 'message' | 'work_item';
  at: string;
  label: string;
  text: string;
  fromMe: boolean;
  permalink?: string;
  workItemId?: string;
}

/** Internal ledger search (Postgres FTS over my source items and work items in the db implementation). */
export interface LedgerSearch {
  search(q: { text: string; limit: number; signal?: AbortSignal }): Promise<LedgerHit[]>;
}

export interface ReadInToolDeps {
  google?: GoogleTools | null;
  ledger?: LedgerSearch | null;
  signal?: AbortSignal;
  /** Characters per page of a Drive file read (default LIMITS.file). */
  filePage?: number;
  /** Characters per page of a Gmail thread read (the Assistant's, A6: 60,000; default PAGES.thread). */
  threadPage?: number;
}

export interface ReadInToolState {
  output: ReadInOutput | null;
  finishCalls: number;
  /** Every URL the agent was shown (context pack + tool results); cited links must be in here. */
  seenUrls: Set<string>;
  calls: string[];
  /** Fetched texts by call (a thread, a file, a calendar range): the next page of one reads from here, not Google. */
  fetched?: Map<string, string>;
}

export function createToolState(seed: Iterable<string> = []): ReadInToolState {
  return { output: null, finishCalls: 0, seenUrls: new Set(seed), calls: [], fetched: new Map() };
}

export type ToolResult = { text: string; isError?: boolean };
export type ToolHandler = (args: unknown) => Promise<ToolResult>;
/** Keyed by bare tool name (`readin_finish`). */
export type ToolHandlerMap = Record<ReadInToolName, ToolHandler>;

/**
 * Characters per page (2026-11-20, ASSIST-5): a long result is read a page at a time by `offset`, never cut. The page
 * size keeps one result small in a read-in's context; every character is reachable. Searches also take the source's
 * own `page_token` for the next page of hits.
 */
export const PAGES = { search: 4000, thread: 8000, file: 6000, ledger: 4000 } as const;
/** Results per search call (the Google read client's page size; its own limit). */
export const SEARCH_PAGE_MAX = 50;

/** One fetch per call key per run: paging a thread or a file reads the text fetched for page 1 (no re-download). */
export async function fetchOnce(state: ReadInToolState, key: string, load: () => Promise<string>): Promise<string> {
  const hit = state.fetched?.get(key);
  if (hit !== undefined) return hit;
  const text = await load();
  state.fetched ??= new Map();
  if (state.fetched.size > 50) state.fetched.delete(state.fetched.keys().next().value!);
  state.fetched.set(key, text);
  return text;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Remember every URL in a tool result: the output may only cite links the agent was shown. */
export function rememberUrls(text: string, state: ReadInToolState): void {
  for (const m of text.matchAll(URL_RE)) state.seenUrls.add(m[0].replace(/[.,;:]+$/, ''));
}

/**
 * One page of a long text (a Drive file): `offset` on, at most `max` characters, ending at a line break when one is in
 * the page's second half (a sheet's rows stay whole). Says where it is and the offset to read next, so a reader can
 * page through a 40,000-character sheet instead of stopping at its first rows. Redacted before paging.
 */
export function pageForModel(text: string, max: number, offset: number, state: ReadInToolState): string {
  const red = redactText(text).replace(/\n{3,}/g, '\n\n');
  if (offset >= red.length && offset > 0) return `(offset ${offset} is past the end: the file has ${red.length} characters)`;
  let end = Math.min(red.length, offset + max);
  if (end < red.length) {
    const nl = red.lastIndexOf('\n', end);
    if (nl > offset + max / 2) end = nl + 1;
  }
  const page = red.slice(offset, end);
  rememberUrls(page, state);
  const head = offset > 0 ? `[characters ${offset}–${end} of ${red.length}]\n` : '';
  const more = end < red.length ? `\n… [${red.length - end} more characters: read again with offset=${end}]` : '';
  return `${head}${page}${more}`;
}

/** Redact, collapse blank runs, and remember URLs; never cut (a long text is paged with `pageForModel`). */
export function sanitizeForModel(text: string, state: ReadInToolState): string {
  const red = redactText(text).replace(/\n{3,}/g, '\n\n');
  rememberUrls(red, state);
  return red;
}

const Offset = z.number().int().min(0).max(5_000_000).optional().describe('Where to start, in characters (a long result ends with the offset to read next)');
const PageToken = z.string().min(1).max(500).optional().describe("The source's next-page token from the last result (page_token / nextPageToken), for more hits");

const schemas = {
  readin_ledger_search: { text: z.string().min(2).max(200).describe('Words to look for: a person, account, topic or phrase'), limit: z.number().int().min(1).max(SEARCH_PAGE_MAX).optional(), offset: Offset },
  readin_gmail_search: { query: z.string().min(2).max(300).describe('Gmail search syntax, e.g. from:dana@example.com newer_than:30d'), max: z.number().int().min(1).max(SEARCH_PAGE_MAX).optional(), page_token: PageToken, offset: Offset },
  readin_gmail_thread: { thread_id: z.string().min(4).max(80), offset: Offset },
  readin_drive_search: { query: z.string().min(2).max(300).describe("Drive query, e.g. name contains 'ACME' and modifiedTime > '2026-10-01'"), max: z.number().int().min(1).max(SEARCH_PAGE_MAX).optional(), page_token: PageToken, offset: Offset },
  readin_drive_read: { file_id: z.string().min(4).max(120), offset: Offset },
  readin_finish: READIN_OUTPUT_SHAPE,
} as const;

const PAGED = ' A long result comes a page at a time: it ends with "read again with offset=N"; call again with that offset for the rest.';
const descriptions: Record<ReadInToolName, string> = {
  readin_ledger_search: `Search the internal ledger (your earlier messages, prior work items, commitments). Read-only.${PAGED}`,
  readin_gmail_search: `Search Gmail (read-only). Returns message ids, thread ids and web links; pass page_token from the result for more hits.${PAGED}`,
  readin_gmail_thread: `Read one Gmail thread (read-only, redacted).${PAGED}`,
  readin_drive_search: `Search Drive files by name/content (read-only). Returns metadata and links; pass the nextPageToken from the result as page_token for more.${PAGED}`,
  readin_drive_read: `Read one Drive file (read-only, redacted).${PAGED}`,
  readin_finish: 'Submit the read-in. Call exactly once, last. Every bullet cites a permalink you were shown or a workItemId from the context pack.',
};

const unavailable = (what: string): ToolResult => ({ text: `${what} is not available in this run; continue with the other sources.` });
const failed = (err: unknown): ToolResult => ({ text: `error: ${redactText(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, isError: true });

export function createReadInTools(deps: ReadInToolDeps, state: ReadInToolState): ToolHandlerMap {
  const g = deps.google ?? null;
  /** One Google read, fetched once per run (`key`) and returned a page at a time from `offset`. */
  const paged = async (tool: (typeof READIN_GOOGLE_TOOLS)[number], args: Record<string, unknown>, page: number, offset: number): Promise<ToolResult> => {
    if (!g) return unavailable('Google (Gmail/Drive)');
    try {
      const text = await fetchOnce(state, `${tool}:${JSON.stringify(args)}`, () => g.call(tool, args, { signal: deps.signal, timeoutMs: 30_000 }));
      return { text: pageForModel(text || '(no results)', page, offset, state) };
    } catch (err) {
      // Error text never carries the arguments (GoogleCallError), and is redacted again here.
      return failed(err);
    }
  };
  const parse = <T extends z.ZodRawShape>(shape: T, args: unknown): z.infer<z.ZodObject<T>> => z.object(shape).parse(args);
  return {
    readin_ledger_search: async (args) => {
      const a = parse(schemas.readin_ledger_search, args);
      if (!deps.ledger) return unavailable('The ledger search');
      const hits = await deps.ledger.search({ text: a.text, limit: a.limit ?? 8, signal: deps.signal });
      if (!hits.length) return { text: 'No ledger matches.' };
      const lines = hits.map((h) => `- [${h.kind}${h.workItemId ? ` workItemId=${h.workItemId}` : ''}] ${h.at.slice(0, 16)} · ${h.label}${h.fromMe ? ' · YOU' : ''}: ${h.text}${h.permalink ? ` (${h.permalink})` : ''}`);
      return { text: pageForModel(lines.join('\n'), PAGES.ledger, a.offset ?? 0, state) };
    },
    readin_gmail_search: async (args) => {
      const a = parse(schemas.readin_gmail_search, args);
      return paged('search_gmail_messages', { query: a.query, page_size: a.max ?? 8, ...(a.page_token ? { page_token: a.page_token } : {}) }, PAGES.search, a.offset ?? 0);
    },
    readin_gmail_thread: async (args) => {
      const a = parse(schemas.readin_gmail_thread, args);
      return paged('get_gmail_thread_content', { thread_id: a.thread_id }, deps.threadPage ?? PAGES.thread, a.offset ?? 0);
    },
    readin_drive_search: async (args) => {
      const a = parse(schemas.readin_drive_search, args);
      return paged('search_drive_files', { query: a.query, page_size: a.max ?? 8, ...(a.page_token ? { page_token: a.page_token } : {}) }, PAGES.search, a.offset ?? 0);
    },
    readin_drive_read: async (args) => {
      const a = parse(schemas.readin_drive_read, args);
      return paged('get_drive_file_content', { file_id: a.file_id }, deps.filePage ?? PAGES.file, a.offset ?? 0);
    },
    readin_finish: async (args) => {
      state.finishCalls += 1;
      const r = ReadInOutput.safeParse(args);
      if (!r.success) {
        const issues = r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        return { text: `Invalid read-in; fix these and call readin_finish again:\n${issues.join('\n')}`, isError: true };
      }
      state.output = r.data;
      return { text: 'Recorded. You are done; stop now.' };
    },
  };
}

/** Dispatch one call by bare name (used by the SDK server and the fake runners in tests). */
export async function callReadInTool(handlers: ToolHandlerMap, state: ReadInToolState, name: string, args: unknown): Promise<ToolResult> {
  const h = handlers[name as ReadInToolName];
  if (!h) return { text: `unknown tool ${name}`, isError: true };
  state.calls.push(name);
  try {
    return await h(args);
  } catch (err) {
    if (err instanceof z.ZodError) return { text: `invalid arguments: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true };
    return { text: `error: ${redactText(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, isError: true };
  }
}

export function buildReadInServer(handlers: ToolHandlerMap, state: ReadInToolState): McpSdkServerConfigWithInstance {
  const tools = READIN_TOOL_NAMES.map((name) =>
    tool(name, descriptions[name], schemas[name], async (args: unknown) => {
      const r = await callReadInTool(handlers, state, name, args);
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    }),
  );
  return createSdkMcpServer({ name: READIN_SERVER, version: '1.0.0', tools, alwaysLoad: true, timeout: 45_000 });
}
