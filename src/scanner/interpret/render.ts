/**
 * The classifier prompt (skills/classify-items.md). Layout for the cache (review 04 §4.1 #5, COST-9):
 *
 *   system = skill body                              ← static: identical for every connector, user and call
 *            ─ cacheBoundary ─
 *            Persona block + glossary (me, accounts,  ← per user, byte-stable from call to call (sorted, capped)
 *            channels, initiatives)
 *   user   = the batch: one compact entry per item    ← the only part that changes per call
 *
 * No open-items pack (COST-5): each item carries its own ≤ 5 deterministic candidates instead. Nothing here reads a
 * clock or a random id, so the same batch renders the same bytes (the cassette key, the D0 content hash).
 */
import { personaOf, renderPersonaBlock } from '../../personas';
import type { NormalizedSourceItem, ScanContext } from '../types';
import type { ContextLine, InterpretItem } from './types';

const clip = (s: string | undefined | null, n: number) => {
  const t = (s ?? '').replace(/\s+\n/g, '\n').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const oneLine = (s: string | undefined | null, n: number) => clip((s ?? '').replace(/\s+/g, ' '), n);
const hhmm = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/**
 * The per-user part after the cache boundary: persona and a glossary of names the items refer to. Every account,
 * channel and initiative (caps audit 2026-11-21: the lists were sorted by id and cut at 40 / 40 / 25, so the
 * accounts past them were never named to the classifier). This part is cached: written once, then read at the
 * cache-read price on every call, so a long glossary costs little; four aliases per account keep each entry short.
 */
export function renderGlossary(ctx: Pick<ScanContext, 'me' | 'aliases' | 'initiatives' | 'persona'>): string {
  const me = ctx.me;
  const accounts = [...ctx.aliases.accounts].map((a) => `${a.accountId}: ${[...a.names].filter((n) => !n.startsWith('org62:')).slice(0, 4).join(' / ')}`).sort();
  const channels = [...ctx.aliases.channels].map((c) => `${c.channelId}${c.label ? ` ${c.label}` : ''}${c.accountId ? ` → account ${c.accountId}` : ''}`).sort();
  const initiatives = [...ctx.initiatives].map((i) => oneLine(i.title, 80)).sort();
  const lines = [
    renderPersonaBlock(ctx.persona ?? personaOf({})),
    '',
    '## Glossary',
    `Me: ${me.name}${me.slackId ? ` (Slack ${me.slackId})` : ''}${me.email ? ` <${me.email}>` : ''}`,
  ];
  if (accounts.length) lines.push(`Accounts: ${accounts.join('; ')}`);
  if (channels.length) lines.push(`Channels: ${channels.join('; ')}`);
  if (initiatives.length) lines.push(`Initiatives: ${initiatives.join('; ')}`);
  return lines.join('\n');
}

/** system + where its cacheable prefix ends. */
export function renderSystem(skillBody: string, ctx: Pick<ScanContext, 'me' | 'aliases' | 'initiatives' | 'persona'>): { system: string; cacheBoundary: number } {
  const head = `${skillBody.trim()}\n\n`;
  return { system: `${head}${renderGlossary(ctx)}`, cacheBoundary: head.length };
}

type P = Record<string, unknown>;
const payload = (it: NormalizedSourceItem) => (it.payload ?? {}) as P;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function header(x: InterpretItem): string {
  const it = x.item;
  const p = payload(it);
  const author = it.author?.isMe ? 'me' : it.author?.name || it.author?.email || it.author?.externalId || 'someone';
  switch (x.connector) {
    case 'slack': {
      const type = str(p.channelType);
      const where = type === 'im' ? `DM ${str(p.channelId) ?? ''}` : type === 'mpim' ? `Group DM ${str(p.channelId) ?? ''}` : `#${str(p.channelName) ?? 'channel'} ${str(p.channelId) ?? ''}`;
      const reply = p.isReply ? ' (thread reply)' : '';
      return `Slack ${where.trim()} · ${hhmm(it.occurredAt)} · ${author === 'me' ? 'from me' : author}${x.to ?? ''}${reply}`;
    }
    case 'gmail': {
      const to = (it.participants ?? []).filter((q) => !q.isMe).slice(0, 4).map((q) => q.name || q.email).filter(Boolean).join(', ');
      const dir = p.direction === 'sent' ? 'Email sent by me' : `Email from ${author}${p.toMe ? ' → me' : ''}`;
      return `${dir}${to && p.direction === 'sent' ? ` → ${to}` : ''} · ${hhmm(it.occurredAt)} · subject: ${oneLine(str(p.subject) ?? it.title, 120)}`;
    }
    case 'gemini_notes':
      return `Meeting notes "${oneLine(it.title, 80)}" · ${hhmm(it.occurredAt)} · a next step assigned to me`;
    case 'drive':
      return `Drive edit of "${oneLine(it.title ?? str(p.fileId), 80)}" by ${author} · ${hhmm(it.occurredAt)}`;
    case 'org62':
      return `Org62 ${it.externalId.split(':')[0]} "${oneLine(it.title, 80)}" · ${hhmm(it.occurredAt)}`;
    default:
      return `${x.connector} ${it.kind} · ${hhmm(it.occurredAt)} · ${author}`;
  }
}

function body(x: InterpretItem, max: number): string {
  const it = x.item;
  const p = payload(it);
  if (x.step) return clip(`${x.step.title}${x.step.description ? `\n${x.step.description}` : ''}`, max);
  if (x.connector === 'gmail') return clip(str(p.bodyNew) ?? it.excerpt, max);
  if (x.connector === 'drive') return clip(it.excerpt ?? str(p.summary), max);
  return clip(it.excerpt ?? it.title, max);
}

function contextLine(c: ContextLine): string {
  return `- ${hhmm(c.at)} ${c.author}${c.to ?? ''}${c.earlier ? ' (earlier)' : ''}: ${oneLine(c.text, 280)}`;
}

/** One item's entry. `wide` (the second pass) shows more of the body and of the conversation. */
export function renderItem(x: InterpretItem, o: { wide?: boolean } = {}): string {
  const out = [`### [${x.ref}] ${header(x)}`];
  const ctx = o.wide ? x.context.slice(-18) : x.context.slice(0, 8);
  if (ctx.length) out.push('context:', ...ctx.map(contextLine));
  out.push(`text: ${body(x, o.wide ? 2400 : 1500).replace(/\n+/g, '\n  ')}`);
  const files = [...new Set(x.item.fileRefs ?? [])].slice(0, 3);
  if (files.length) out.push(`files: ${files.join(' ')}`);
  if (x.candidates.length) out.push(`candidates: ${x.candidates.map((c) => `${c.alias} "${oneLine(c.title, 90)}" (${oneLine(c.why, 60)}${c.state ? `, ${c.state}` : ''}${c.resolution ? `, ${c.resolution}` : ''})`).join(' | ')}`);
  else out.push('candidates: none');
  return out.join('\n');
}

/** The user message of one call. */
export function renderBatch(items: InterpretItem[], o: { index: number; total: number; wide?: boolean }): string {
  return [`## Items (${o.wide ? 'second look, more context' : 'batch'} ${o.index}/${o.total}). Times are UTC. Give every [ref] one verdict.`, ...items.map((x) => renderItem(x, { wide: o.wide }))].join('\n\n');
}
