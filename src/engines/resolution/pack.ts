/**
 * The resolution check's context pack (lane 03 §4.1, R4): ONE builder, over the Settle pack (buildSettleContext), so
 * the completion pass's narrow window and Settle's Slack/Gmail-only view become one complete, small, ordered pack.
 *
 *   ask        the origin line (full stored text)
 *   before     lines just before it, same conversation
 *   after      every line after it in the same conversation, mine included; the asker's acknowledgements after my line
 *              tagged `ack`, their chases tagged `chase`
 *   elsewhere  my lines to the asker elsewhere, the asker's to me, and lines naming the deliverable noun
 *   files      revisions and shares of the item's file
 *   notes      meeting notes naming it · sessions: Claude sessions touching it
 *   events, siblings, hints (Settle's and the rules'), history (the last check)
 *
 * Capped by tokens: when the rendered pack is over the cap, the least deciding blocks go first (siblings, events, lines
 * before the ask, unrelated elsewhere lines, older notes and files, then the middle of a long conversation that is
 * neither mine nor the asker's). The ask, my lines after it, the asker's lines after it and the item's own evidence are
 * never dropped: the
 * deciding line is always in the pack (tests/evals/scanner/deterministic.eval.ts, pack completeness). Pure.
 */
import { h16 } from '@/connectors/util';
import { buildSettleContext, type BuildOptions, type RawSource } from '@/engines/settle/context';
import type { SettleLine } from '@/engines/settle/types';
import { redactText } from '@/lib/redact';
import { cutHead } from '@/engines/prompt-cut';
import { evaluateRules, isAcknowledgement, isChase, type RuleInput, type RuleLine } from '@/scanner/resolution/rules';

import type { PackLine, ResolutionPack, ResolutionRaw } from './types';

/** About 1.2–2.5 K tokens (lane 03 §4.1); a pack never grows past this. */
export const PACK_TOKEN_CAP = 2500;
/** Rough tokens of a JSON text (≈ 4 characters a token for English and JSON). */
export const approxTokens = (s: string) => Math.ceil(s.length / 4);

const clip = (s: string | null | undefined, n: number) => {
  const t = redactText((s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const STOP = new Set('send share with from that this have your about into what when will just they them their there were been need confirm review reply answer update follow check help find give make take today tomorrow before after call meeting the and for you can our out get set please could would link'.split(' '));

/** The words that name what was asked for ("deck", "pricing", "sizing"…): title words, minus verbs and filler. */
export function deliverableWords(title: string): string[] {
  return [...new Set((title.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w) && !/^person_?\w*$/.test(w)))].slice(0, 8);
}

function conversationKeyOf(ask: RawSource | undefined, itemId: string): string {
  if (!ask) return `item:${itemId}`;
  if (ask.source === 'slack' && ask.channelId) return ask.threadTs ? `slack:${ask.channelId}:${ask.threadTs}` : ask.channelType === 'im' || ask.channelType === 'mpim' ? `slack:${ask.channelId}` : `slack:${ask.channelId}:${ask.ts ?? ask.externalId}`;
  if (ask.source === 'gmail' && ask.parent) return `gmail:${ask.parent}`;
  return `item:${itemId}`;
}

function render(p: Omit<ResolutionPack, 'tokens' | 'digest'>): string {
  return renderPack(p as ResolutionPack, 'w1');
}

/** One item of a model call: the pack as JSON with its line aliases (what the model cites). */
export function renderPack(p: ResolutionPack, alias: string): string {
  const v = (l: PackLine) => ({ id: l.id, at: l.at ? l.at.slice(0, 16).replace('T', ' ') + 'Z' : null, by: l.by, ...(l.where ? { where: l.where } : {}), ...(l.tag ? { tag: l.tag } : {}), text: l.text, ...(l.passed !== undefined ? { passed: l.passed } : {}) });
  return JSON.stringify({
    id: alias,
    item: (({ id: _id, ...rest }) => rest)(p.item),
    ask: p.ask ? v(p.ask as PackLine) : null,
    ...(p.before.length ? { before: p.before.map((l) => v(l as PackLine)) } : {}),
    after: p.after.map(v),
    ...(p.elsewhere.length ? { elsewhere: p.elsewhere.map(v) } : {}),
    ...(p.files.length ? { files: p.files.map(v) } : {}),
    ...(p.notes.length ? { notes: p.notes.map(v) } : {}),
    ...(p.sessions.length ? { sessions: p.sessions.map(v) } : {}),
    ...(p.events.length ? { events: p.events.map((l) => v(l as PackLine)) } : {}),
    ...(p.siblings.length ? { siblings: p.siblings.map((l) => v(l as PackLine)) } : {}),
    hints: { ...p.hints, ...p.ruleHints },
    ...(p.history ? { history: p.history } : {}),
    ...(p.corrections.length ? { corrections: p.corrections } : {}),
  });
}

/** Every line of a pack, by alias. */
export function packLines(p: ResolutionPack): Map<string, PackLine> {
  const m = new Map<string, PackLine>();
  for (const l of [...(p.ask ? [p.ask as PackLine] : []), ...(p.before as PackLine[]), ...p.after, ...p.elsewhere, ...p.files, ...p.notes, ...p.sessions, ...(p.events as PackLine[]), ...(p.siblings as PackLine[])]) m.set(l.id, l);
  return m;
}

/** The rules' view of a pack (D1–D6). */
export function ruleInputOfPack(p: ResolutionPack, raw: Pick<ResolutionRaw, 'record' | 'sessions' | 'lastCheck' | 'latestInputAt'>): RuleInput {
  const line = (l: PackLine): RuleLine => ({ id: l.id, at: l.at ?? '', fromMe: l.fromMe, byAsker: !!l.byAsker, text: l.text, ...(l.files?.length ? { files: l.files } : {}), ...(l.hasFile ? { hasFile: true } : {}) });
  const s = raw.sessions?.[0];
  const sessLine = p.sessions[0];
  return {
    item: { kind: p.item.kind, title: p.item.title, purpose: p.item.purpose ?? null },
    askAt: p.ask?.at ?? p.item.firstSeen,
    after: p.after.map(line),
    ...(raw.record ? { record: raw.record } : {}),
    ...(s ? { session: { status: s.status, lastMessage: s.lastMessage, ...(sessLine ? { cite: sessLine.id } : {}) } } : {}),
    lastVerdictAt: raw.lastCheck?.at ?? null,
    latestInputAt: raw.latestInputAt ?? null,
  };
}

export function buildResolutionPack(raw: ResolutionRaw, o: BuildOptions & { tokenCap?: number }): ResolutionPack {
  const ctx = buildSettleContext(raw, o);
  const rawById = new Map<string, ResolutionRaw['conversation'][number]>();
  for (const r of [...raw.evidence, ...raw.conversation, ...raw.elsewhere]) rawById.set(r.id, r);
  const askRow = raw.evidence.find((e) => e.id === ctx.ask?.sourceItemId);
  const asker = lc(ctx.ask && !ctx.ask.fromMe ? ctx.ask.by : (raw.item.counterparty ?? ''));
  const evidenceIds = new Set(raw.evidence.map((e) => e.id));
  const enrich = (l: SettleLine): PackLine => {
    const r = l.sourceItemId ? rawById.get(l.sourceItemId) : undefined;
    return { ...l, ...(l.sourceItemId && evidenceIds.has(l.sourceItemId) ? { linked: true } : {}), ...(r?.files?.length ? { files: r.files } : {}), ...(r?.hasFile ? { hasFile: true } : {}), ...(asker && !l.fromMe && lc(l.by) === asker ? { byAsker: true } : {}) };
  };
  let mineSeen = false;
  const after: PackLine[] = ctx.after.map((l0) => {
    const l = enrich(l0);
    if (l.fromMe) mineSeen = true;
    else if (l.byAsker && mineSeen) {
      if (isAcknowledgement(l.text)) l.tag = 'ack';
      else if (isChase(l.text)) l.tag = 'chase';
    }
    return l;
  });
  const noun = deliverableWords(raw.item.title);
  const names = (t: string) => {
    const ws = new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
    return noun.some((w) => ws.has(w));
  };
  const elsewhere = ctx.elsewhere.map(enrich).filter((l) => l.fromMe || l.byAsker || names(l.text) || /linked as/.test(l.where ?? ''));
  const files: PackLine[] = (raw.files ?? [])
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-4)
    .map((f, i) => ({ id: `f${i + 1}`, kind: 'file', at: f.at, by: f.byMe ? 'me' : f.editor?.trim() || 'someone', fromMe: f.byMe, where: f.share ? 'file share' : 'file revision', text: clip(`${f.share ? 'shared' : 'edited'} "${f.title ?? 'the file'}"${f.changes ? `: ${f.changes}` : ''}`, 300), sourceItemId: f.sourceItemId, ...(f.url ? { url: f.url } : {}) }));
  const inElsewhere = new Set(elsewhere.map((l) => l.sourceItemId));
  const notes: PackLine[] = (raw.notes ?? []).filter((n) => !inElsewhere.has(n.id)).slice(-2).map((n, i) => ({ id: `n${i + 1}`, kind: 'notes', at: n.at, by: 'meeting notes', fromMe: false, where: 'meeting notes', text: clip(`${n.title ?? ''}: ${n.text ?? ''}`, 500), sourceItemId: n.id }));
  const sessions: PackLine[] = cutHead('resolution.sessions', raw.sessions ?? [], 2).map((s, i) => ({ id: `s${i + 1}`, kind: 'session', at: s.at, by: 'me', fromMe: true, where: 'Claude session', text: clip(`Claude session "${s.title ?? ''}" · ${s.status}${s.lastMessage ? ` · last: ${s.lastMessage}` : ''}`, 400), ...(s.sourceItemId ? { sourceItemId: s.sourceItemId } : {}) }));

  const base = {
    ...ctx,
    after,
    elsewhere,
    files,
    notes,
    sessions,
    history: raw.lastCheck ?? null,
    trimmed: 0,
    conversationKey: conversationKeyOf(askRow, raw.item.id),
    ruleHints: { myReplyAfterAskMin: null, replyHasLinkOrFile: false, askerAckAfterMine: false, askerChasedAfterMine: false, lastWriter: null },
  } as Omit<ResolutionPack, 'tokens' | 'digest'>;
  base.ruleHints = evaluateRules(ruleInputOfPack(base as ResolutionPack, raw)).hints;

  // ---- token cap: drop the least deciding lines first; never the ask, mine after it, or the asker's after it
  const cap = o.tokenCap ?? PACK_TOKEN_CAP;
  const p = base;
  const over = () => approxTokens(render(p)) > cap;
  const drop = <T>(arr: T[], keep: number, fromEnd = true): boolean => {
    if (arr.length <= keep) return false;
    if (fromEnd) arr.pop();
    else arr.shift();
    p.trimmed += 1;
    return true;
  };
  const protectedLine = (l: PackLine) => l.fromMe || !!l.byAsker || !!l.tag || !!l.linked;
  const steps: Array<() => boolean> = [
    () => drop(p.siblings, 0),
    () => drop(p.events, 2),
    () => drop(p.before, 0, false),
    () => {
      const i = p.elsewhere.findIndex((l) => !protectedLine(l));
      if (i < 0) return false;
      p.elsewhere.splice(i, 1);
      p.trimmed += 1;
      return true;
    },
    () => drop(p.notes, 1, false),
    () => drop(p.files, 2, false),
    () => drop(p.events, 0),
    () => {
      // the middle of a long conversation: lines neither mine nor the asker's, nearest the middle first
      const cands = p.after.map((l, i) => ({ l, i })).filter((x) => !protectedLine(x.l));
      if (!cands.length) return false;
      const mid = p.after.length / 2;
      const pick = cands.sort((a, b) => Math.abs(a.i - mid) - Math.abs(b.i - mid))[0]!;
      p.after.splice(pick.i, 1);
      p.trimmed += 1;
      return true;
    },
    () => {
      const i = p.elsewhere.findIndex((l) => l.text.length > 160);
      if (i < 0) return false;
      p.elsewhere[i] = { ...p.elsewhere[i]!, text: `${p.elsewhere[i]!.text.slice(0, 159)}…` };
      return true;
    },
    () => {
      const i = p.after.findIndex((l) => l.text.length > 240);
      if (i < 0) return false;
      p.after[i] = { ...p.after[i]!, text: `${p.after[i]!.text.slice(0, 239)}…` };
      return true;
    },
  ];
  for (const step of steps) while (over() && step()) {
    /* keep trimming this block */
  }
  const text = render(p);
  // the digest is of the evidence, not of the check history: "changed since the last check" means new lines
  return { ...p, tokens: approxTokens(text), digest: h16(render({ ...p, history: null })) };
}

/** How many lines a pack carries (closure_checks.pack_lines). */
export const packLineCount = (p: ResolutionPack) => packLines(p).size;
