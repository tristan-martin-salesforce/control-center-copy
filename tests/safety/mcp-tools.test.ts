/**
 * Static safety: MCP tool names (2026-11-20 review, 10 R10b; CLAUDE.md invariant 2, *tenet: Read-only ingest*).
 *
 *   1. Every MCP tool a connector (`src/connectors/**`) or a skill (`skills/*.md`) names is on the READ allowlist, or is
 *      the app's own in-process `cc_*` server. Skills the Outbox runs by design (WRITE_SKILLS) may also name the write
 *      tools of their own channel.
 *   2. A write-capable tool name (the Outbox's write tools, and every `slack_*` tool that is not a read) appears in
 *      `src/**` only in WRITE_PLACES: the Outbox, the VDP write client, and the lists that DENY or REFUSE them.
 *   3. A tool-looking name that is on no list at all fails: a new upstream tool has to be classified first.
 *
 * The lists themselves are the single source: `src/llm/mcp-config.ts` (Slack and Org62 scanner lists),
 * `src/connectors/google/client.ts`, `src/connectors/vdp/tools.ts`, `src/outbox/mcp-config.ts`. Their own unit tests
 * (tests/outbox/guard.test.ts) check that no list holds a write tool; this file checks who NAMES a tool.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GOOGLE_READ_TOOLS } from '../../src/connectors/google/client';
import { VDP_READ_TOOLS, VDP_WRITE_TOOLS } from '../../src/connectors/vdp/tools';
import { assertReadOnly, ORG62_ALL_TOOLS, SLACK_ALL_TOOLS, SLACK_SCAN_TOOLS } from '../../src/llm/mcp-config';
import { OUTBOX_READ_TOOLS, OUTBOX_WRITE_TOOLS } from '../../src/outbox/mcp-config';

const ROOT = path.resolve(__dirname, '../..');
const bare = (q: string) => q.replace(/^mcp__[^_]+(?:[-_][^_]+)*?__/, '');

/** Read tools: what a scanner, a read-back or a research run may call. */
const READ = new Set<string>([
  ...SLACK_SCAN_TOOLS,
  ...ORG62_ALL_TOOLS, // every Org62 tool is a read (find, schema, soqlQuery...); the scanners use only soqlQuery
  ...GOOGLE_READ_TOOLS,
  ...VDP_READ_TOOLS,
  ...[...OUTBOX_READ_TOOLS].map(bare),
]);
/** Write-capable tools: the Outbox's own, VDP's ops, and every Slack tool that is not a read. */
const WRITE = new Set<string>([...[...OUTBOX_WRITE_TOOLS].map(bare), ...VDP_WRITE_TOOLS, ...SLACK_ALL_TOOLS.filter((t) => !READ.has(t) && !/^slack_(read|search|list|get)_/.test(t))]);
/** Slack tools that read but no run uses: known, never named by a connector or skill (not on READ, not writes). */
const KNOWN_OTHER_READS = new Set<string>(SLACK_ALL_TOOLS.filter((t) => /^slack_(read|search|list|get)_/.test(t) && !READ.has(t)));

/** In-process server of the app itself (src/llm/cc-tools): records to the local database, nothing external. */
const IN_PROCESS_SERVER = 'cc';

/** Skills the Outbox runs after the user's Apply, and the tools they may name besides reads. */
const WRITE_SKILLS: Record<string, string> = {
  'skills/outbox-relay.md': 'the Outbox relay prompt: carries one confirmed write (the canvas, the feedback post) through the gateway',
};

/**
 * Connector files that name VDP write tools without being a scanner read: the VDP client is also the Outbox's VDP
 * transport (writes only through the Outbox after Apply), and these files refuse, rate-limit or probe-list them.
 */
const CONNECTOR_WRITE_FILES: Record<string, string> = {
  'src/connectors/vdp/write.ts': 'the Outbox VDP write client: runs one confirmed op per Apply (src/outbox/adapters/vdp.ts builds the call)',
  'src/connectors/vdp/tools.ts': 'the VDP tool classification: the read list, the Outbox write ops, and the never-list (deletes, other generations)',
  'src/connectors/vdp/client.ts': 'the VDP client: refuses any tool outside VDP_READ_TOOLS; comments name create_vdp as the check it supports',
  'src/connectors/vdp/limiter.ts': 'the per-tool timeout (generate_use_case runs long); not a call',
  'src/connectors/vdp/fetcher.ts': 'the scanner: asks which tools the server LISTS (create_company, for the company-identity read); calls only reads',
};

/**
 * `src/**` files that may name a MESSAGING write tool (Slack send, draft, canvas, reaction...; Gmail send and draft),
 * with why (a directory ends with `/`). These names have no domain meaning, so any other file naming one is a smell.
 * VDP's write ops (`create_use_case`...) are different: they are also the vocabulary of a VDP change item, so the
 * engines, mocks and UI name them as data. For those the rule is who can CALL one (see the VDP test below).
 */
const MESSAGING_WRITE_PLACES: Record<string, string> = {
  'src/outbox/': 'the Outbox: adapters, gateway, transport, relay and its own allowlist are the only writers',
  'src/llm/mcp-config.ts': 'the scanner config: SLACK_ALL_TOOLS is the DISALLOW catalogue; assertReadOnly refuses every write-like name',
  'src/lib/canvas/payload.ts': 'builds the logging-canvas payload (its `tool` field) that the Outbox adapter re-derives and refuses if it differs',
  'src/lib/feedback/payload.ts': 'builds the feedback-report payload (its `tool` field) that the Outbox adapter re-derives and refuses if it differs',
};

const walk = (dir: string, re: RegExp, out: string[] = []): string[] => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, re, out);
    else if (re.test(e.name) && !/\.(test|spec)\.[a-z]+$/.test(e.name) && !/(^|\/)__tests__\//.test(rel)) out.push(rel);
  }
  return out;
};
const text = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Tool names a file names: `mcp__server__tool` (server, tool), and bare names that are on any list or look like Slack tools. */
function toolRefs(raw: string): Array<{ server: string | null; tool: string }> {
  const refs: Array<{ server: string | null; tool: string }> = [];
  for (const m of raw.matchAll(/mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)__([A-Za-z0-9_]+)/g)) refs.push({ server: m[1]!, tool: m[2]! });
  const universe = new Set([...READ, ...WRITE, ...KNOWN_OTHER_READS]);
  for (const m of raw.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\bsoqlQuery\b|\bgetObjectSchema\b|\bgetRelatedRecords\b|\bgetUserInfo\b|\blistRecentSobjectRecords\b/g)) {
    const t = m[0];
    if (universe.has(t)) refs.push({ server: null, tool: t });
  }
  return refs;
}

const connectorFiles = walk('src/connectors', /\.(ts|tsx)$/);
const skillFiles = walk('skills', /\.md$/);

describe('the detector', () => {
  it('finds qualified and bare names, and nothing in ordinary prose', () => {
    expect(toolRefs('use mcp__slack__slack_read_thread then slack_send_message')).toEqual([
      { server: 'slack', tool: 'slack_read_thread' },
      { server: null, tool: 'slack_send_message' },
    ]);
    expect(toolRefs('mcp__Org62-Sobject-Read__soqlQuery').map((r) => r.tool)).toContain('soqlQuery');
    expect(toolRefs('a plain sentence with snake_case words and no tools')).toEqual([]);
  });
  it('the lists are non-empty and disjoint (a tool is a read or a write, never both)', () => {
    expect(READ.size).toBeGreaterThan(30);
    expect(WRITE.size).toBeGreaterThan(10);
    expect([...READ].filter((t) => WRITE.has(t))).toEqual([]);
    expect(() => assertReadOnly([...SLACK_SCAN_TOOLS, ...ORG62_ALL_TOOLS])).not.toThrow();
  });
});

describe('connectors and skills name only read tools', () => {
  it('finds files to scan', () => {
    expect(connectorFiles.length).toBeGreaterThan(5);
    expect(skillFiles.length).toBeGreaterThan(20);
  });

  for (const f of [...connectorFiles, ...skillFiles]) {
    const refs = toolRefs(text(f));
    if (!refs.length) continue;
    it(`${f}: every tool it names is on the read allowlist`, () => {
      const allowWrite = f in WRITE_SKILLS;
      const bad = refs
        .filter((r) => r.server !== IN_PROCESS_SERVER && !r.tool.startsWith('cc_'))
        .filter((r) => r.tool !== '' && !READ.has(r.tool))
        .filter((r) => !((allowWrite || f in CONNECTOR_WRITE_FILES) && WRITE.has(r.tool)))
        .map((r) => (r.server ? `mcp__${r.server}__${r.tool}` : r.tool));
      expect(bad, `${f} names a tool that is not on a read allowlist (classify it in src/llm/mcp-config.ts or the connector's own list, or remove it)`).toEqual([]);
    });
  }

  it('the write-skill exceptions still exist and still name a write (no stale entries)', () => {
    for (const f of Object.keys(WRITE_SKILLS)) {
      expect(skillFiles, f).toContain(f);
      expect(toolRefs(text(f)).some((r) => WRITE.has(r.tool)), `${f} names no write tool: remove it from WRITE_SKILLS`).toBe(true);
    }
  });
});

describe('write-capable tool names appear only where writes belong', () => {
  const srcFiles = walk('src', /\.(ts|tsx)$/);
  const placeOf = (f: string) => Object.keys(MESSAGING_WRITE_PLACES).find((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
  const VDP_OPS = new Set<string>(VDP_WRITE_TOOLS);
  // a quoted identifier: 'slack_send_message' (prose and comments do not count; calls, lists and payload fields do)
  const quoted = (raw: string) => [...raw.matchAll(/['"`]([a-z][a-z0-9_]+)['"`]/g)].map((m) => m[1]!);
  const namesMessagingWrite = (raw: string) => quoted(raw).filter((t) => WRITE.has(t) && !VDP_OPS.has(t));
  const namesVdpWrite = (raw: string) => quoted(raw).filter((t) => VDP_OPS.has(t));

  it('a messaging write tool (Slack, Gmail) is named only in MESSAGING_WRITE_PLACES', () => {
    const offenders = srcFiles.filter((f) => !placeOf(f) && namesMessagingWrite(text(f)).length > 0).map((f) => `${f}: ${[...new Set(namesMessagingWrite(text(f)))].join(', ')}`);
    expect(offenders, 'a messaging write tool named outside the Outbox: the Outbox is the only writer (add the place with why, or move the code)').toEqual([]);
  });

  it('every MESSAGING_WRITE_PLACES entry still names one (no stale entries)', () => {
    const stale = Object.keys(MESSAGING_WRITE_PLACES).filter((p) => !srcFiles.some((f) => (p.endsWith('/') ? f.startsWith(p) : f === p) && namesMessagingWrite(text(f)).length > 0));
    expect(stale, 'nothing under these names a messaging write tool any more: remove them').toEqual([]);
  });

  it('no connector names a messaging write tool at all', () => {
    expect(connectorFiles.filter((f) => namesMessagingWrite(text(f)).length > 0)).toEqual([]);
  });

  it('the VDP write transport is imported only by the Outbox (nothing else can call a VDP write)', () => {
    const importers = srcFiles.filter((f) => /from\s+['"]@\/connectors\/vdp\/write['"]|import\(\s*['"]@\/connectors\/vdp\/write['"]/.test(text(f)));
    expect(importers.filter((f) => !f.startsWith('src/outbox/')), 'only src/outbox/** may import the VDP write client').toEqual([]);
    expect(importers.length, 'the Outbox transport imports it').toBeGreaterThan(0);
  });

  it('a VDP write op is data outside the connector and the Outbox: no file there calls a tool with one', () => {
    // `callTool(` / `.callTool` anywhere in src is the transport interface; only these may call it
    const callers = srcFiles.filter((f) => /\bcallTool\s*\(/.test(text(f)) && namesVdpWrite(text(f)).length > 0);
    expect(callers.filter((f) => !f.startsWith('src/outbox/') && !f.startsWith('src/connectors/vdp/'))).toEqual([]);
  });
});
