/**
 * Slack search simulator over a placeholder corpus. Renders results in the exact recorded
 * `response_format: "detailed"` shape (see tests/fixtures/scanner/slack/*.detailed.v1.json) so the
 * scripted agent parses real-shaped text, and a parser for that shape.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface CorpusMessage {
  id: string;
  channel: string;
  from: string;
  ts: string;
  threadTs?: string;
  text: string;
}
export interface Corpus {
  me: { name: string; slackId: string; email: string };
  people: Record<string, { name: string; email: string }>;
  channels: Record<string, { name: string; type: 'im' | 'mpim' | 'public_channel' | 'private_channel'; members?: string[] }>;
  messages: CorpusMessage[];
}

export const FIXTURES = path.join(HERE, '../../../fixtures/scanner');

export function loadCorpus(): Corpus {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'slack/corpus.v1.json'), 'utf8')) as Corpus;
}

export function loadFixture<T = unknown>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8')) as T;
}

const mst = (ts: string) => {
  // Render like the real tool: "2026-11-05 08:42:14 MST" (fixed UTC-7 for fixtures).
  const d = new Date(Math.round(Number(ts) * 1000) - 7 * 3600_000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} MST`;
};

export interface SearchArgs {
  query: string;
  channel_types?: string;
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
}

/** Filter the corpus like Slack would for the queries scan-slack uses, then render detailed text. */
export function slackSearch(corpus: Corpus, args: SearchArgs): { results: string; pagination_info: string } {
  const me = corpus.me.slackId;
  const types = new Set((args.channel_types ?? 'public_channel,private_channel,mpim,im').split(','));
  const after = args.after ? Number(args.after) : -Infinity;
  const before = args.before ? Number(args.before) : Infinity;
  const q = args.query.trim();
  let pred: (m: CorpusMessage) => boolean;
  if (q === `-from:<@${me}>`) pred = (m) => m.from !== me;
  else if (q === `from:<@${me}>`) pred = (m) => m.from === me;
  else if (q === `<@${me}>`) pred = (m) => m.text.includes(`<@${me}>`);
  else if (q.startsWith('in:<#')) {
    const id = q.slice(5, q.indexOf('>'));
    pred = (m) => m.channel === id;
  } else pred = () => false;
  const all = corpus.messages
    .filter((m) => types.has(corpus.channels[m.channel]!.type))
    .filter((m) => Number(m.ts) >= after && Number(m.ts) <= before)
    .filter(pred)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  const limit = args.limit ?? 20;
  const page = args.cursor ? Number(/PAGE:(\d+)/.exec(args.cursor)?.[1] ?? 1) : 1;
  const slice = all.slice((page - 1) * limit, page * limit);
  const blocks = slice.map((m, i) => {
    const ch = corpus.channels[m.channel]!;
    const from = corpus.people[m.from]!;
    const lines = [`### Result ${i + 1} of ${slice.length}`, `Channel: ${ch.name} (ID: ${m.channel})`];
    if (ch.members) lines.push(`Participants: ${ch.members.map((u) => `${corpus.people[u]!.name} (ID: ${u})`).join(', ')}`);
    const p = `https:\\/\\/example.slack.com\\/archives\\/${m.channel}\\/p${m.ts.replace('.', '')}${m.threadTs ? `?thread_ts=${m.threadTs}&cid=${m.channel}` : ''}`;
    lines.push(`From: ${from.name} <${from.email}> (ID: ${m.from}) `, `Time: ${mst(m.ts)}`, `Message_ts: ${m.ts}`, `Permalink: [link](${p})`, `Text: `, m.text, '', '---', '');
    return lines.join('\n');
  });
  const more = page * limit < all.length;
  return {
    results: `# Search Results for: ${q}\n\n## Messages (${slice.length} results)\n${blocks.join('\n')}`,
    pagination_info: more ? `For the next page of results use cursor \`PAGE:${page + 1}\`\n` : '',
  };
}

export interface ParsedHit {
  channelId: string;
  channelName: string;
  participants: Array<{ name: string; id: string }>;
  fromName: string;
  fromEmail?: string;
  fromId: string;
  time: string;
  ts: string;
  permalink: string;
  threadTs?: string;
  text: string;
}

/** Parser for the detailed search shape (same labels the real tool emits). */
export function parseSlackSearch(results: string): ParsedHit[] {
  const out: ParsedHit[] = [];
  for (const block of results.split(/^### Result \d+ of \d+\n/m).slice(1)) {
    const get = (label: string) => new RegExp(`^${label}: ?(.*)$`, 'm').exec(block)?.[1]?.trim() ?? '';
    const ch = /^(.*) \(ID: ([A-Z0-9]+)\)$/.exec(get('Channel'));
    const from = /^(.*?)\s*(?:<([^>]+)>)?\s*\(ID: ([A-Z0-9]+)\)/.exec(get('From'));
    const participants = [...get('Participants').matchAll(/([^,()]+?) \(ID: ([A-Z0-9]+)\)/g)].map((m) => ({ name: m[1]!.trim(), id: m[2]! }));
    const permalink = (/\((https?:[^)]+)\)/.exec(get('Permalink'))?.[1] ?? '').replace(/\\\//g, '/');
    const threadTs = /thread_ts=(\d+\.\d+)/.exec(permalink)?.[1];
    const textMatch = /^Text: ?\n([\s\S]*?)\n\n---/m.exec(block);
    out.push({
      channelId: ch?.[2] ?? '',
      channelName: ch?.[1] ?? '',
      participants,
      fromName: from?.[1]?.trim() ?? '',
      fromEmail: from?.[2],
      fromId: from?.[3] ?? '',
      time: get('Time'),
      ts: get('Message_ts'),
      permalink,
      threadTs,
      text: (textMatch?.[1] ?? '').trim(),
    });
  }
  return out;
}

/** The record the skill (§4) prescribes for one hit. */
export function slackRecordItem(h: ParsedHit, meId: string, extra: { accountHints?: string[]; query: string }) {
  const drive = [...h.text.matchAll(/docs\.google\.com\/[a-z]+\/d\/([A-Za-z0-9_-]+)/g)].map((m) => `drive:${m[1]}`);
  return {
    kind: 'message' as const,
    externalId: `${h.channelId}:${h.ts}`,
    occurredAt: h.ts,
    author: { name: h.fromName, email: h.fromEmail, externalId: h.fromId, isMe: h.fromId === meId },
    participants: h.participants.length ? h.participants.map((p) => ({ name: p.name, externalId: p.id, isMe: p.id === meId })) : undefined,
    permalink: h.permalink,
    excerpt: h.text,
    threadRef: `slack:${h.channelId}:${h.threadTs ?? h.ts}`,
    fileRefs: drive.length ? drive : undefined,
    accountHints: extra.accountHints,
    payload: { channelId: h.channelId, channelName: h.channelName, ts: h.ts, threadTs: h.threadTs, isReply: !!h.threadTs, query: extra.query },
  };
}
