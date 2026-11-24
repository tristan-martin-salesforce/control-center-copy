/**
 * Chat research (`chat_research`): the in-process read-only tools of a question-scoped research run (server
 * `cc_research`). The ledger, Gmail and Drive tools are the read-in handlers (src/llm/readin/tools.ts) under research
 * names; Calendar search is new (any date range, over the devbar read client's `get_events`). Slack and Org62 come from
 * their own restricted MCP servers (src/server/chat/research.ts), exactly as for a read-in.
 *
 * `research_finish` validates the answer and refuses a link the run was never shown, so every finding is traceable.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@/llm/provider';
import { z } from 'zod';

import { listEvents } from '@/connectors/google/calendar';
import type { GoogleTools } from '@/connectors/google/client';
import { redactText } from '@/llm/redact';
import { READIN_SOURCE_KINDS } from '@/llm/readin/types';
import { createReadInTools, createToolState, fetchOnce, pageForModel, rememberUrls, SEARCH_PAGE_MAX, type LedgerSearch, type ReadInToolState, type ToolResult } from '@/llm/readin/tools';

/** Characters per page of a calendar result in a research run (the Assistant reads 60,000 a page). */
const CAL_TEXT_PAGE = 12_000;

export const RESEARCH_SERVER = 'cc_research';
export const researchToolName = (bare: string) => `mcp__${RESEARCH_SERVER}__${bare}`;

export const RESEARCH_TOOL_NAMES = ['research_ledger_search', 'research_gmail_search', 'research_gmail_thread', 'research_drive_search', 'research_drive_read', 'research_calendar_search', 'research_finish'] as const;
export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[number];
export const RESEARCH_ALLOWED_TOOLS = RESEARCH_TOOL_NAMES.map(researchToolName);

const Link = z
  .string()
  .max(600)
  .regex(/^https?:\/\//, 'must be an http(s) link from a tool result');

export const RESEARCH_OUTPUT_SHAPE = {
  answer: z.string().min(3).max(4000).describe('The direct answer to the question, plain text, 1-6 sentences. Say plainly when nothing was found.'),
  findings: z
    .array(
      z.object({
        text: z.string().min(3).max(320),
        source: z.enum(READIN_SOURCE_KINDS).optional(),
        /** "#acme-ext · thread", "Gmail · Dana Lee", "Calendar · ACME QBR", "Org62 · Event" */
        label: z.string().max(120).optional(),
        at: z.string().max(40).optional(),
        permalink: Link.optional(),
      }),
    )
    .max(40)
    .describe('What you found, newest first, each with its link when the tool result had one'),
  searched: z
    .array(z.object({ source: z.enum(READIN_SOURCE_KINDS), query: z.string().max(200), hits: z.number().int().min(0) }))
    .max(60)
    .describe('Every search you ran: where, what, how many hits'),
  notFound: z.array(z.string().max(200)).max(20).describe('What you looked for and did not find'),
  confidence: z.enum(['sure', 'likely', 'guess']),
};
export const ResearchOutput = z.object(RESEARCH_OUTPUT_SHAPE);
export type ResearchOutput = z.infer<typeof ResearchOutput>;

export interface ResearchToolState extends Omit<ReadInToolState, 'output'> {
  output: ResearchOutput | null;
  /** The read-in handlers' state (shares seenUrls and calls with this one). */
  inner: ReadInToolState;
}

export function createResearchState(seed: Iterable<string> = []): ResearchToolState {
  const inner = createToolState(seed);
  return { output: null, finishCalls: 0, seenUrls: inner.seenUrls, calls: inner.calls, inner };
}

export interface ResearchToolDeps {
  google?: GoogleTools | null;
  ledger?: LedgerSearch | null;
  signal?: AbortSignal;
  now?: () => Date;
  /** Characters per page of a Drive file read (the readin default when absent). */
  filePage?: number;
  /** Characters per page of a Gmail thread or calendar read, paged by `offset` (the Assistant's; absent: the readin page). */
  threadPage?: number;
}

export type ResearchHandlerMap = Record<ResearchToolName, (args: unknown) => Promise<ToolResult>>;

const Offset = z.number().int().min(0).max(5_000_000).optional().describe('Where to start, in characters (a long result ends with the offset to read next)');
const PageToken = z.string().min(1).max(500).optional().describe("The source's next-page token from the last result, for more hits");

const calendarShape = {
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('First day to search (inclusive)'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('Last day to search (inclusive); at most five years (1830 days) after from'),
  words: z.string().max(120).optional().describe('Words that must appear in the title, attendees, location or description, e.g. an account or a person'),
  offset: Offset,
};

const SCHEMAS = {
  research_ledger_search: { text: z.string().min(2).max(200).describe('Words to look for: a person, account, topic or phrase'), limit: z.number().int().min(1).max(SEARCH_PAGE_MAX).optional(), offset: Offset },
  research_gmail_search: { query: z.string().min(2).max(300).describe('Gmail search syntax, e.g. globex OR "Globex Health" newer_than:2y'), max: z.number().int().min(1).max(SEARCH_PAGE_MAX).optional(), page_token: PageToken, offset: Offset },
  research_gmail_thread: { thread_id: z.string().min(4).max(80), offset: Offset },
  research_drive_search: { query: z.string().min(2).max(300).describe("Drive query, e.g. fullText contains 'Globex'"), max: z.number().int().min(1).max(SEARCH_PAGE_MAX).optional(), page_token: PageToken, offset: Offset },
  research_drive_read: { file_id: z.string().min(4).max(120), offset: Offset },
  research_calendar_search: calendarShape,
  research_finish: RESEARCH_OUTPUT_SHAPE,
} as const;

const PAGED = ' A long result comes a page at a time: it ends with "read again with offset=N"; call again with that offset for the rest.';
const DESCRIPTIONS: Record<ResearchToolName, string> = {
  research_ledger_search: `Search what the app already recorded (your messages, earlier work items, commitments). Read-only. Start here; it's free and fast.${PAGED}`,
  research_gmail_search: `Search Gmail live (read-only), any age. Returns message and thread ids and links; pass page_token from the result for more hits.${PAGED}`,
  research_gmail_thread: `Read one Gmail thread (read-only, redacted).${PAGED}`,
  research_drive_search: `Search Drive live by name or content (read-only). Returns metadata and links; pass the nextPageToken from the result as page_token for more.${PAGED}`,
  research_drive_read: `Read one Drive file (read-only, redacted).${PAGED}`,
  research_calendar_search: `Search your Calendar live over any date range (up to five years per call; every event in the range is read, and the result says if a very busy range was cut and where), optionally only events mentioning some words. Read-only.${PAGED}`,
  research_finish: 'Submit the answer. Call exactly once, last. Every link must be one a tool result showed you.',
};

/** A calendar range is read in chunks (get_events has no page token): at most this many days per call. */
const MAX_CAL_DAYS = 1830;
/** Events per `get_events` call (the read client's page). A chunk that comes back full is split, never cut. */
export const CAL_PAGE = 250;
/** Days per first-pass chunk of a range. */
const CAL_CHUNK_DAYS = 31;
const DAY_MS = 86_400_000;

/**
 * How many events one search reads at most: 40 per day of the range (a very busy calendar has under 15), at least 500,
 * at most 20,000. A sanity bound from the window's size, never a fixed page: the result says when it is reached.
 */
export function calendarEventCap(from: Date, to: Date): number {
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
  return Math.min(20_000, Math.max(500, days * 40));
}

/**
 * Every event in [from, to] (ASSIST-5, 2026-11-20: one `get_events` call of 250 then a filter silently missed the rest).
 * `get_events` takes a time range and `max_results` but no page token, so the range is read in month chunks and a
 * chunk that comes back full is split in halves until it isn't (or is an hour wide). Events are de-duplicated by id.
 * `truncated` says the event cap was reached or an hour held more than a page; `readTo` is how far the read got.
 */
export async function listEventsInRange(g: GoogleTools, from: Date, to: Date, o: { signal?: AbortSignal; cap?: number } = {}): Promise<{ events: Awaited<ReturnType<typeof listEvents>>; truncated: boolean; calls: number; readTo: Date }> {
  const cap = o.cap ?? calendarEventCap(from, to);
  const byId = new Map<string, Awaited<ReturnType<typeof listEvents>>[number]>();
  const todo: Array<[number, number]> = [];
  for (let a = from.getTime(); a < to.getTime(); a += CAL_CHUNK_DAYS * DAY_MS) todo.push([a, Math.min(to.getTime(), a + CAL_CHUNK_DAYS * DAY_MS)]);
  let truncated = false;
  let calls = 0;
  let readTo = from.getTime();
  while (todo.length) {
    if (byId.size >= cap) {
      truncated = true;
      break;
    }
    const [a, b] = todo.shift()!;
    const events = await listEvents(g, new Date(a), new Date(b), CAL_PAGE, o.signal);
    calls += 1;
    if (events.length >= CAL_PAGE && b - a > 3_600_000) {
      const mid = a + Math.floor((b - a) / 2);
      todo.unshift([a, mid], [mid, b]);
      continue;
    }
    if (events.length >= CAL_PAGE) truncated = true;
    for (const e of events) byId.set(e.id || `${e.start}|${e.title}`, e);
    readTo = b;
  }
  const events = [...byId.values()].sort((x, y) => x.start.localeCompare(y.start));
  return { events, truncated, calls, readTo: new Date(readTo) };
}

/** One line per event that mentions `words` (all of them, case-insensitive). */
export function calendarLines(events: Awaited<ReturnType<typeof listEvents>>, words?: string): string[] {
  const terms = (words ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  return events
    .filter((e) => {
      if (!terms.length) return true;
      const hay = `${e.title} ${e.location} ${e.description} ${e.attendeeEmails.join(' ')} ${e.organizerEmail ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .map((e) => {
      const domains = [...new Set(e.attendeeEmails.map((m) => m.split('@')[1] ?? '').filter(Boolean))].slice(0, 6).join(', ');
      return `- ${e.start.slice(0, 16)} · ${e.title}${domains ? ` · with ${domains}` : ''}${e.link ? ` (${e.link})` : ''}`;
    });
}

export function createResearchTools(deps: ResearchToolDeps, state: ResearchToolState): ResearchHandlerMap {
  const inner = createReadInTools({ google: deps.google ?? null, ledger: deps.ledger ?? null, signal: deps.signal, ...(deps.filePage ? { filePage: deps.filePage } : {}), ...(deps.threadPage ? { threadPage: deps.threadPage } : {}) }, state.inner);
  const parse = <T extends z.ZodRawShape>(shape: T, args: unknown): z.infer<z.ZodObject<T>> => z.object(shape).parse(args);
  return {
    research_ledger_search: (a) => inner.readin_ledger_search(a),
    research_gmail_search: (a) => inner.readin_gmail_search(a),
    research_gmail_thread: (a) => inner.readin_gmail_thread(a),
    research_drive_search: (a) => inner.readin_drive_search(a),
    research_drive_read: (a) => inner.readin_drive_read(a),
    research_calendar_search: async (args) => {
      const a = parse(calendarShape, args);
      if (!deps.google) return { text: 'Calendar is not available in this run; continue with the other sources.' };
      const from = new Date(`${a.from}T00:00:00Z`);
      const to = new Date(`${a.to}T23:59:59Z`);
      if (!(to > from)) return { text: 'error: to must be on or after from', isError: true };
      if ((to.getTime() - from.getTime()) / DAY_MS > MAX_CAL_DAYS) return { text: `error: search at most ${MAX_CAL_DAYS} days per call; split the range`, isError: true };
      try {
        const google = deps.google;
        const text = await fetchOnce(state.inner, `calendar:${a.from}:${a.to}:${a.words ?? ''}`, async () => {
          const r = await listEventsInRange(google, from, to, deps.signal ? { signal: deps.signal } : {});
          const lines = calendarLines(r.events, a.words);
          const cut = r.truncated ? `\nNot every event was read: the range holds more than ${r.events.length} events${r.readTo < to ? `; read up to ${r.readTo.toISOString().slice(0, 10)}, search from there for the rest` : ' (an hour with more than a page)'}; narrow the range or add words.` : '';
          if (!lines.length) return `No events${a.words ? ` mentioning "${a.words}"` : ''} between ${a.from} and ${a.to} (${r.events.length} event(s) read).${cut}`;
          return `${lines.length} event(s)${a.words ? ` mentioning "${a.words}"` : ''} of ${r.events.length} read between ${a.from} and ${a.to} (total=${lines.length}, truncated=${r.truncated}):${cut}\n${lines.join('\n')}`;
        });
        return { text: pageForModel(text, deps.threadPage ?? CAL_TEXT_PAGE, a.offset ?? 0, state.inner) };
      } catch (err) {
        return { text: `error: ${redactText(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, isError: true };
      }
    },
    research_finish: async (args) => {
      state.finishCalls += 1;
      const r = ResearchOutput.safeParse(args);
      if (!r.success) {
        const issues = r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        return { text: `Invalid answer; fix these and call research_finish again:\n${issues.join('\n')}`, isError: true };
      }
      const unseen = r.data.findings.map((f) => f.permalink).filter((u): u is string => !!u && !state.seenUrls.has(u));
      if (unseen.length) return { text: `These links never appeared in a tool result; use only links you were shown (or drop them):\n${unseen.slice(0, 5).join('\n')}`, isError: true };
      state.output = r.data;
      return { text: 'Recorded. You are done; stop now.' };
    },
  };
}

/** Dispatch one call by bare name (the SDK server and fake runners in tests). */
export async function callResearchTool(handlers: ResearchHandlerMap, state: ResearchToolState, name: string, args: unknown): Promise<ToolResult> {
  const h = handlers[name as ResearchToolName];
  if (!h) return { text: `unknown tool ${name}`, isError: true };
  state.calls.push(name);
  try {
    return await h(args);
  } catch (err) {
    if (err instanceof z.ZodError) return { text: `invalid arguments: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true };
    return { text: `error: ${redactText(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, isError: true };
  }
}

export function buildResearchServer(handlers: ResearchHandlerMap, state: ResearchToolState): McpSdkServerConfigWithInstance {
  const tools = RESEARCH_TOOL_NAMES.map((name) =>
    tool(name, DESCRIPTIONS[name], SCHEMAS[name], async (args: unknown) => {
      const r = await callResearchTool(handlers, state, name, args);
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    }),
  );
  return createSdkMcpServer({ name: RESEARCH_SERVER, version: '1.0.0', tools, alwaysLoad: true, timeout: 45_000 });
}

export { rememberUrls };
