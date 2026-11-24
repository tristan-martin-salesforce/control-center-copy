/**
 * Golden scanner cases (tests/fixtures/scanner-golden/<case>.json): the schema, the loader and its cross-checks.
 *
 * A case is a small world: `sources[]` (placeholder Slack / Gmail / Calendar / Drive / Gemini rows, field names as
 * sample-data/tables/source_items.json: `source`, `kind`, `occurred_at`, `from_me`, `title`, `body`, `url`, `meta`),
 * plus three golden-only fields per source:
 *   - `seen_at`   when a scan saw it (sources with the same `seen_at` are one scan);
 *   - `thread_of` the golden id of the thread root (Slack thread / Gmail thread);
 *   - `agent`     what the scanner agent did with it, scripted (the fake-CLI pattern): propose an expected item,
 *                 propose something new (a follow-up), or link evidence to an item. The agent only acts on what the
 *                 deterministic pipeline actually recorded and on text it can actually see (the "oracle" proposer).
 * `items_expected[]` say which asks must become items (title keywords, kind, origin source id, the phrase the ask
 * hinges on); `closures_expected[]` say how each item must end (closed / likely / open, the citation, and whether
 * the case is `settled` or `still_owed`). `knownGap: "SCN-n"` marks an expectation today's code is known to fail:
 * the harness records it without failing CI, and the chunk that fixes SCN-n flips it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

export const GOLDEN_DIR = fileURLToPath(new URL('../../fixtures/scanner-golden/', import.meta.url));
export const CASSETTE_DIR = path.join(GOLDEN_DIR, 'cassettes');

const Iso = z.string().refine((s) => Number.isFinite(Date.parse(s)) && /T.*Z$/.test(s), 'ISO timestamp in UTC');
const Gap = z.string().regex(/^SCN-\d+$/);
const Person = z.object({ name: z.string(), email: z.string().optional(), externalId: z.string().optional() });

const Agent = z.union([
  z.object({ propose: z.string() }).strict(),
  z.object({ propose_new: z.object({ kind: z.enum(['ask', 'commitment', 'task', 'follow_up']), title: z.string() }) }).strict(),
  z
    .object({
      link: z.string(),
      role: z.enum(['origin', 'context', 'progress', 'completion', 'contradiction']),
      confidence: z.enum(['sure', 'likely', 'guess']),
      reason: z.string(),
    })
    .strict(),
]);
export type AgentAction = z.infer<typeof Agent>;

export const GoldenSource = z
  .object({
    id: z.string(),
    source: z.enum(['slack', 'gmail', 'calendar', 'drive', 'gemini_notes', 'claude_sessions']),
    kind: z.enum(['slack_message', 'email_message', 'calendar_event', 'drive_file_revision', 'gemini_note', 'claude_session']),
    occurred_at: Iso,
    seen_at: Iso,
    from_me: z.boolean(),
    title: z.string().nullish(),
    body: z.string(),
    url: z.string().nullish(),
    thread_of: z.string().optional(),
    meta: z
      .object({
        channelId: z.string().optional(),
        channelType: z.enum(['im', 'mpim', 'channel']).optional(),
        channelName: z.string().optional(),
        author: Person.optional(),
        participants: z.array(Person).optional(),
        to: z.array(Person).optional(),
        files: z.array(z.object({ name: z.string(), mimetype: z.string().optional() })).optional(),
        fileRefs: z.array(z.string()).optional(),
        threadId: z.string().optional(),
        fileId: z.string().optional(),
        eventId: z.string().optional(),
        /** Claude sessions: the session id and its status (done, waiting, running …). */
        sessionId: z.string().optional(),
        status: z.string().optional(),
      })
      .strict()
      .default({}),
    agent: z.array(Agent).default([]),
  })
  .strict();
export type GoldenSource = z.infer<typeof GoldenSource>;

export const GoldenItem = z
  .object({
    id: z.string(),
    kind: z.enum(['ask', 'commitment', 'task', 'follow_up']),
    title: z.string(),
    purpose: z.string().optional(),
    due: z.string().optional(),
    /** Words the item's title must carry (recall matching is by origin; these keep a case honest when titles drift). */
    keywords: z.array(z.string()).min(1),
    origin: z.string(),
    /** The phrase the ask hinges on: the oracle proposer acts only when the stored text shows it. */
    ask_quote: z.string().min(4),
    knownGap: Gap.optional(),
    note: z.string().optional(),
  })
  .strict();
export type GoldenItem = z.infer<typeof GoldenItem>;

export const GoldenClosure = z
  .object({
    item: z.string(),
    expect: z.enum(['closed', 'likely', 'open']),
    /** `settled`: nothing is owed any more (close rate). `still_owed`: closing it is wrong (close precision). */
    class: z.enum(['settled', 'still_owed']),
    cite: z.string().optional(),
    /** The item must have been closed and then reopened on the way. */
    reopened: z.boolean().optional(),
    /** What the deterministic rules (src/scanner/resolution/rules.ts) decide at the end: a rule id, or `none` (ask the model). */
    rule: z.enum(['D1', 'D2', 'D3', 'D4', 'D5', 'none']).optional(),
    knownGap: Gap.optional(),
    why: z.string(),
  })
  .strict();
export type GoldenClosure = z.infer<typeof GoldenClosure>;

export const GoldenCase = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string(),
    storyline: z.string(),
    me: z.object({ name: z.string(), slackId: z.string(), email: z.string() }).strict(),
    sources: z.array(GoldenSource).min(1),
    items_expected: z.array(GoldenItem),
    closures_expected: z.array(GoldenClosure),
    note: z.string().optional(),
  })
  .strict();
export type GoldenCase = z.infer<typeof GoldenCase>;

/** Cross-references a schema can't check. Returns problems (empty = fine). */
export function checkCase(c: GoldenCase): string[] {
  const out: string[] = [];
  const src = new Map(c.sources.map((s) => [s.id, s]));
  const items = new Set(c.items_expected.map((i) => i.id));
  if (src.size !== c.sources.length) out.push('duplicate source ids');
  if (items.size !== c.items_expected.length) out.push('duplicate item ids');
  for (const s of c.sources) {
    if (s.thread_of && !src.has(s.thread_of)) out.push(`${s.id}: thread_of ${s.thread_of} is not a source`);
    if (Date.parse(s.seen_at) < Date.parse(s.occurred_at)) out.push(`${s.id}: seen before it happened`);
    if (s.source === 'slack' && (!s.meta.channelId || !s.meta.channelType)) out.push(`${s.id}: Slack rows need meta.channelId and meta.channelType`);
    if (!s.from_me && !s.meta.author && s.source !== 'gemini_notes' && s.source !== 'calendar' && s.source !== 'claude_sessions') out.push(`${s.id}: meta.author is required when not from me`);
    for (const a of s.agent) {
      if ('propose' in a && !items.has(a.propose)) out.push(`${s.id}: proposes unknown item ${a.propose}`);
      if ('link' in a && !items.has(a.link)) out.push(`${s.id}: links unknown item ${a.link}`);
    }
  }
  for (const i of c.items_expected) {
    if (!src.has(i.origin)) out.push(`${i.id}: origin ${i.origin} is not a source`);
    else if (!src.get(i.origin)!.agent.some((a) => 'propose' in a && a.propose === i.id)) out.push(`${i.id}: its origin source never proposes it`);
    const t = i.title.toLowerCase();
    for (const k of i.keywords) if (!t.includes(k.toLowerCase())) out.push(`${i.id}: keyword "${k}" not in its title`);
  }
  for (const cl of c.closures_expected) {
    if (!items.has(cl.item)) out.push(`closure for unknown item ${cl.item}`);
    if (cl.cite && !src.has(cl.cite)) out.push(`closure ${cl.item}: cite ${cl.cite} is not a source`);
    if (cl.class === 'still_owed' && cl.expect === 'closed') out.push(`closure ${cl.item}: a still-owed item cannot expect closed`);
  }
  return out;
}

export function loadGoldenCases(dir = GOLDEN_DIR): GoldenCase[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown;
    const parsed = GoldenCase.safeParse(raw);
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    if (`${parsed.data.id}.json` !== f) throw new Error(`${f}: id ${parsed.data.id} does not match the file name`);
    const problems = checkCase(parsed.data);
    if (problems.length) throw new Error(`${f}: ${problems.join('; ')}`);
    return parsed.data;
  });
}

export function cassettePath(caseId: string, dir = CASSETTE_DIR): string {
  return path.join(dir, `${caseId}.json`);
}
