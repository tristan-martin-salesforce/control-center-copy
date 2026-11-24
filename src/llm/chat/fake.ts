/**
 * A deterministic stand-in for the model (BE-CHAT): a `ChatQueryFn` that plays the CLI. It reads the
 * message from the prompt, picks an intent by keywords, calls the REAL chat tools through the in-process
 * MCP server (InMemoryTransport) after asking the runner's PreToolUse hook like the CLI does, streams text
 * as partial messages, and ends with a result message. No network, no LLM, no cost (unless configured).
 *
 * Used by the mock DataSource, by the db DataSource when CC_CHAT_LLM is not 1, and by the tests.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Options, SDKMessage } from '@/llm/provider';
import type { ChatQueryFn } from './runner';
import { CHAT_SERVER_NAME, CHAT_TOOL_NAMES, chatToolFullName, withoutUntrustedHeader } from './tools';

export interface FakeChatOptions {
  /** Pause between steps (ms): lets tests stop a turn midway. */
  delayMs?: number;
  /** Usage reported on every assistant message (budget tests). Default: tiny. */
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
  /** Model id reported on assistant messages (default: options.model). */
  model?: string;
  /** Tool calls made before the intent's own (e.g. a non-allowlisted tool, to test the guard). */
  inject?: Array<{ tool: string; input: Record<string, unknown> }>;
  /** Cost the result reports (default 0). */
  resultCostUsd?: number;
  /** The session id the CLI reports (default: the resumed or requested one). */
  sessionId?: string;
}

type Call = { tool: string; input: Record<string, unknown> };

/** A step: a tool call, text, or a function that decides the next steps from earlier tool results. */
type Step = Call | { text: string } | ((r: ToolResults) => Step[]);
interface Plan {
  steps: Step[];
}

type ToolResults = Array<{ tool: string; ok: boolean; json: unknown; text: string }>;

const CONNECTORS = ['slack', 'gmail', 'calendar', 'drive', 'gemini', 'org62', 'vdp', 'claude'];

/** The last "## Message" section of the prompt. */
export function messageOf(prompt: string): string {
  const i = prompt.lastIndexOf('## Message\n');
  return (i >= 0 ? prompt.slice(i + 11) : prompt).trim();
}

/** "2026-11-05T09:12:00-08:00 (America/Los_Angeles)" from the system prompt's Now section. */
/** The system prompt and the user prompt together (v2: the per-turn header rides in the user prompt). */
const allText = (options: Options, prompt = ''): string => `${Array.isArray(options.systemPrompt) ? options.systemPrompt.join('\n') : String(options.systemPrompt ?? '')}\n${prompt}`;

function nowOf(options: Options, prompt = ''): { iso: string; date: string; offset: string } {
  const sp = allText(options, prompt);
  const m = /## Now\n(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})/.exec(sp);
  if (!m) {
    const iso = new Date().toISOString();
    return { iso, date: iso.slice(0, 10), offset: '+00:00' };
  }
  return { iso: `${m[1]}T${m[2]}${m[3]}`, date: m[1]!, offset: m[3]! };
}

function packOf(options: Options, prompt = ''): Record<string, unknown> | null {
  const sp = allText(options, prompt);
  const i = sp.indexOf('## Context pack (JSON)\n');
  if (i < 0) return null;
  try {
    return JSON.parse(sp.slice(i + 23).split('\n')[0]!) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** "until 14:00" / "till 2pm" → an ISO instant today (tomorrow when it has passed) in the prompt's offset. */
export function untilOf(text: string, now: { iso: string; date: string; offset: string }): string | null {
  const m = /\b(?:until|till|til|to|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!m) return /\btomorrow\b/i.test(text) ? isoAt(now, 9, 0, 1) : null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
  if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const today = isoAt(now, h, min, 0);
  return Date.parse(today) > Date.parse(now.iso) ? today : isoAt(now, h, min, 1);
}

function isoAt(now: { date: string; offset: string }, h: number, m: number, plusDays: number): string {
  const d = new Date(`${now.date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return `${d.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${now.offset}`;
}

const hhmm = (iso: string) => iso.slice(11, 16);

/** What the item phrase is: the words between the verb and "until/till/as/…". */
function phraseAfter(text: string, verb: RegExp): string {
  const m = verb.exec(text);
  const rest = m ? text.slice(m.index + m[0].length) : text;
  return rest.split(/\b(?:until|till|til|to|at|as|because|for now|please)\b/i)[0]!.replace(/[?.!,]/g, ' ').trim();
}

function firstHit(r: ToolResults): { id: string; title: string } | null {
  const last = [...r].reverse().find((x) => x.tool === 'read' && (x.json as { page?: string } | undefined)?.page === 'find_items');
  const hits = (last?.json as { data?: { hits?: Array<{ id: string; title: string }> } } | undefined)?.data?.hits ?? [];
  return hits[0] ?? null;
}

function brokenConnector(pack: Record<string, unknown> | null, text: string): { id: string; label: string } | null {
  const broken = (pack?.broken as Array<{ id: string; label: string }> | undefined) ?? (pack?.health as { broken?: Array<{ id: string; label: string }> } | undefined)?.broken ?? [];
  const t = text.toLowerCase();
  return broken.find((c) => t.includes(c.id.toLowerCase()) || t.includes(c.label.toLowerCase())) ?? null;
}

/** The VDP the user has open ("Looking at: vdp <key>: …"), from the system prompt. */
export function lookingAtVdp(options: Options, prompt = ''): { key: string; label: string } | null {
  const sp = allText(options, prompt);
  const m = /^- vdp (\S+): (.+?)(?: \(looking at\))?$/m.exec(sp);
  return m ? { key: m[1]!, label: m[2]! } : null;
}

type VdpDetailView = {
  company: string;
  href: string;
  vdp: { useCases: Array<{ title: string; persona?: string; missing?: string[]; aiFields?: string[] | string }>; assets: Array<{ title?: string; url: string }> } | null;
  steps: Array<{ n: number; title: string; state: string; why?: string }>;
  assetsToAdd: Array<{ title: string; url: string; status: string; why: string }>;
};

/** "What use cases / assets does X have, what's missing": one vdp_detail read, answered from it. */
function vdpAnswer(d: VdpDetailView, tl: string): string {
  const lines: string[] = [];
  const uc = d.vdp?.useCases ?? [];
  const assets = d.vdp?.assets ?? [];
  const wantAssets = /\bassets?\b|\bdecks?\b|\bcontent\b/.test(tl);
  const wantUc = /\buse cases?\b/.test(tl);
  if (!d.vdp) lines.push(`${d.company} has no VDP yet: create it first, then the rest can go in.`);
  if (d.vdp && (wantUc || !wantAssets)) lines.push(uc.length ? `**Use cases (${uc.length}):** ${uc.map((u) => `${u.title}${u.missing?.length ? ` (missing ${u.missing.join(', ')})` : ''}${typeof u.aiFields === 'string' ? ', AI fields not generated' : ''}`).join('; ')}.` : '**Use cases:** none yet.');
  if (d.vdp && (wantAssets || !wantUc)) lines.push(assets.length ? `**Assets in VDP (${assets.length}):** ${assets.map((a) => `[${a.title ?? a.url}](${a.url})`).join(', ')}.` : '**Assets in VDP:** none yet.');
  if (d.assetsToAdd.length) lines.push(`**Assets to add (${d.assetsToAdd.length}):**\n${d.assetsToAdd.map((a) => `- [${a.title}](${a.url})${a.status === 'unsure' ? ' (confirm it first)' : a.status === 'added' ? ' (marked added, waiting for the next VDP read)' : ''}: ${a.why}`).join('\n')}`);
  const todo = d.steps.filter((s) => s.state !== 'waiting');
  if (todo.length) lines.push(`**Steps, in order:**\n${todo.map((s) => `${s.n}. ${s.title}${s.state === 'blocked' ? ` (waits: ${s.why ?? 'an earlier step'})` : ''}`).join('\n')}`);
  lines.push(`Open it on [Activity ▸ VDP](${d.href}). Nothing is written to VDP from here.`);
  return lines.join('\n\n');
}

/** The text after an `act`: done (a receipt came back) or staged (a card waits for Apply). */
function actText(r: ToolResults, done: string, staged: string): string {
  const j = r.at(-1)?.json as { done?: boolean; staged?: boolean } | null | undefined;
  if (j?.done) return `${done} Undo is on the receipt.`;
  if (j?.staged) return `${staged} Nothing changes until you do.`;
  return `I couldn't do that: ${r.at(-1)?.text.slice(0, 200) ?? 'no result'}`;
}

/** Did the user say Run to the last plan? */
const planRan = (r: ToolResults) => (r.filter((x) => x.tool === 'plan').at(-1)?.json as { answer?: string } | null | undefined)?.answer === 'run';

/**
 * One item action: `act` (it runs; Undo on the receipt), or, when the user asked to propose / suggest it, ONE card
 * through `propose` (the old summary line), the way the skill says to stage when unsure.
 */
function doOrStage(staging: boolean, change: Record<string, unknown>, summary: string, done: string, staged: string): Step[] {
  if (staging) return [{ tool: 'propose', input: { kind: 'changes', changes: [change], summary } }, { text: `${staged} Nothing changes until you do.` }];
  const { op, ...rest } = change;
  const act: Record<string, unknown> = { op, ...('itemId' in rest ? { itemId: rest.itemId } : {}), ...('until' in rest ? { until: rest.until } : {}) };
  return [{ tool: 'act', input: act }, (r2: ToolResults) => [{ text: actText(r2, done, staged) }]];
}

/** Keyword intents → a plan of tool calls and text. */
export function planFor(text: string, options: Options, prompt = ''): Plan {
  const now = nowOf(options, prompt);
  const pack = packOf(options, prompt);
  const t = text.trim();
  const tl = t.toLowerCase();
  const staging = /\b(propose|suggest|stage)\b/.test(tl);

  if (/^remember\b|\bremember that\b/.test(tl)) {
    const note = t.replace(/^.*?\bremember( that)?\b[:,]?\s*/i, '');
    const pref = /\b(always|never|i prefer|i like|from now on)\b/i.test(note);
    return { steps: [{ tool: 'remember', input: { text: note || t, scope: pref ? 'preference' : 'thread' } }, { text: pref ? "Got it: I'll keep that for every thread." : "Noted for this thread." }] };
  }
  if (/\bwhy\b/.test(tl) && !/\btop (3|three)\b/.test(tl)) {
    return {
      steps: [
        { tool: 'query', input: { view: 'work_items', limit: 1 } },
        (r) => {
          const row = (r.at(-1)?.json as { rows?: unknown[][]; fields?: string[] } | null)?.rows?.[0];
          const id = typeof row?.[0] === 'string' ? row[0] : null;
          return id ? [{ tool: 'explain', input: { id, what: 'rank' } }] : [{ text: 'Nothing is ranked yet.' }];
        },
        (r) => {
          const j = r.at(-1)?.json as { title?: string; rank?: { why?: string; rank?: number } } | null;
          if (r.at(-1)?.tool !== 'explain') return [];
          return [{ text: j?.title ? `**${j.title}** is #${j.rank?.rank ?? '?'}: ${j.rank?.why ?? 'no reason recorded'}.` : "I couldn't explain that." }];
        },
      ],
    };
  }
  if (/\bsnooze\b/.test(tl)) {
    const until = untilOf(t, now) ?? isoAt(now, 9, 0, 1);
    const phrase = phraseAfter(t, /\bsnooze\b/i) || t;
    return {
      steps: [
        { tool: 'read', input: { route: 'find_items', query: { q: phrase, limit: 5 } } },
        (r) => {
          const hit = firstHit(r);
          const conn = brokenConnector(pack, phrase);
          const reauth = /\bre-?auth\b/i.test(phrase);
          if (conn && (reauth || !hit)) {
            return [
              { text: `${conn.label} re-auth is a connector alert, not a task, so there is nothing to snooze directly. I can track it as a task that stays snoozed until ${hhmm(until)}.` },
              { tool: 'propose', input: { kind: 'changes', changes: [{ op: 'create_item', title: `Re-auth ${conn.label}`, snoozeUntil: until }], summary: `Track the ${conn.label} re-auth, snoozed until ${hhmm(until)}?` } },
              { text: `\n\nApply to add it; nothing changes until you do.` },
            ];
          }
          if (!hit) return [{ text: `I couldn't find an item matching "${phrase}".` }];
          return doOrStage(staging, { op: 'snooze', itemId: hit.id, until }, `Snooze "${hit.title}" until ${hhmm(until)}?`, `Snoozed **${hit.title}** until ${hhmm(until)}.`, `Apply to snooze **${hit.title}** until ${hhmm(until)}.`);
        },
      ],
    };
  }
  if (/\breopen\b/.test(tl)) {
    const phrase = phraseAfter(t, /\breopen\b/i);
    return {
      steps: [
        { tool: 'read', input: { route: 'find_items', query: { q: phrase, tab: 'done', limit: 5 } } },
        (r) => {
          const hit = firstHit(r);
          return hit ? doOrStage(staging, { op: 'reopen', itemId: hit.id, reason: 'Asked in chat' }, `Reopen "${hit.title}"?`, `Reopened **${hit.title}**.`, `Apply to reopen **${hit.title}**.`) : [{ text: `No closed item matches "${phrase}".` }];
        },
      ],
    };
  }
  if (/\b(mark|set)\b.*\bdone\b|\bis done\b|\bi did\b|\bdone with\b/.test(tl)) {
    const phrase = phraseAfter(t, /\b(?:mark|set|done with|i did)\b/i).replace(/\b(as )?done\b/i, '').trim();
    return {
      steps: [
        { tool: 'read', input: { route: 'find_items', query: { q: phrase, limit: 5 } } },
        (r) => {
          const hit = firstHit(r);
          return hit ? doOrStage(staging, { op: 'done', itemId: hit.id }, `Mark "${hit.title}" done?`, `Closed **${hit.title}** as done by you.`, `Apply to close **${hit.title}** as done by you.`) : [{ text: `I couldn't find "${phrase}".` }];
        },
      ],
    };
  }
  if (/\bpin\b|\bmove .+ to the top\b|\bto #?1\b/.test(tl)) {
    const phrase = phraseAfter(t, /\b(?:pin|move)\b/i).replace(/\bto the top\b|\bto #?1\b/i, '').trim();
    return {
      steps: [
        { tool: 'read', input: { route: 'find_items', query: { q: phrase, limit: 5 } } },
        (r) => {
          const hit = firstHit(r);
          return hit ? doOrStage(staging, { op: 'pin', itemId: hit.id, reason: 'Asked in chat' }, `Move "${hit.title}" to #1?`, `Moved **${hit.title}** to #1 and re-ranked the rest.`, `Apply to move **${hit.title}** to #1 and re-rank the rest.`) : [{ text: `I couldn't find "${phrase}".` }];
        },
      ],
    };
  }
  if (/\b(re-?scan|scan)\b/.test(tl)) {
    const connector = CONNECTORS.find((c) => new RegExp(`\\b${c}\\b`).test(tl)) ?? 'slack';
    const w = /(\d+)\s*(h|hrs?|hours?|d|days?)\b/.exec(tl);
    const hours = w ? Number(w[1]) * (w[2]!.startsWith('d') ? 24 : 1) : 24;
    return { steps: [{ tool: 'run', input: { kind: 'rescan', connector, windowHours: Math.max(1, Math.min(720, hours)) } }, { text: `Queued a ${connector} scan over the last ${hours} h; the card shows its progress.` }] };
  }
  if (/\bdraft\b/.test(tl)) {
    const email = /\b(e-?mail|mail)\b/.test(tl) || /[\w.+-]+@[\w-]+\.[\w.]+/.test(t);
    const to = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(t)?.[0] ?? /([#@][\w.-]+)/.exec(t)?.[1] ?? (/\bto\s+([A-Z][\w-]+)/.exec(t)?.[1] ? `@${/\bto\s+([A-Z][\w-]+)/.exec(t)![1]}` : '@me');
    const intent = t.replace(/^.*?\b(?:about|saying|that)\b/i, '').trim() || t;
    const body = `Hi${to.startsWith('@') ? ` ${to.slice(1)}` : ''}, ${intent.replace(/^\w/, (c) => c.toLowerCase())}`;
    return {
      steps: [
        { tool: 'propose', input: { kind: 'draft', draft: { channel: email ? 'email' : 'slack', to, intent: intent.slice(0, 280), body, ...(email ? { subject: intent.slice(0, 60) } : {}) } } },
        { text: `Here's a draft for ${to}. Edit it or add it to the Outbox; nothing was sent.` },
      ],
    };
  }
  if (/\b(session|claude code)\b/.test(tl)) {
    const repo = /\bin\s+(~?[\w./-]+)/.exec(t)?.[1] ?? 'command-center';
    const prompt = /:\s*(.+)$/.exec(t)?.[1] ?? (/\bto\s+(.+)$/.exec(t)?.[1] ?? t);
    return { steps: [{ tool: 'propose', input: { kind: 'session', session: { repo, prompt } } }, { text: `A session is ready in ${repo}. Open it from the card when you want to start; nothing has been opened.` }] };
  }
  // VDP: the open VDP's use cases, assets, steps; "go back and find everything" starts Find assets.
  const vdpOpen = lookingAtVdp(options, prompt);
  const vdpFind = !!vdpOpen && /\b(find|look (back|through)|go back|backfill|search|dig)\b/.test(tl) && /\b(vdp|assets?|decks?|demos?|recordings?|everything|content|history|historically)\b/.test(tl);
  if (vdpFind || (/\bvdp\b|\buse cases?\b|\bassets?\b|\bmissing\b|\bsteps?\b/.test(tl) && vdpOpen)) {
    if (vdpFind && vdpOpen) {
      return {
        steps: [
          { tool: 'plan', input: { steps: [{ tool: 'run', run: 'vdp_find_assets', what: `Look back through Drive, Slack, Gmail and Calendar for ${vdpOpen.label}'s assets` }] } },
          (r) => (planRan(r) ? [{ tool: 'run', input: { kind: 'vdp_find_assets', key: vdpOpen.key } }] : [{ text: 'Not started: say Run on the plan when you want it.' }]),
          (r) => {
            if (r.at(-1)?.tool !== 'run') return [];
            const j = r.at(-1)?.json as { started?: boolean; estimateUsd?: number; note?: string | null; skipped?: Array<{ why: string }> } | undefined;
            if (!j?.started) return [{ text: `I couldn't start it: ${j?.note ?? j?.skipped?.[0]?.why ?? 'nothing to run'}.` }];
            return [{ text: `I'm looking back through Drive, Slack, Gmail and Calendar for ${vdpOpen.label}'s assets (up to $${(j.estimateUsd ?? 0).toFixed(2)}). The finds show under Assets to add on the VDP, each with where it was shared and the text to paste in VDP. Nothing is written to VDP.` }];
          },
        ],
      };
    }
    if (vdpOpen) {
      return {
        steps: [
          { tool: 'read', input: { route: 'vdp_detail', query: { key: vdpOpen.key } } },
          (r) => {
            const d = (r.at(-1)?.json as { data?: VdpDetailView } | undefined)?.data;
            return [{ text: d ? vdpAnswer(d, tl) : `I couldn't read ${vdpOpen.label}.` }];
          },
        ],
      };
    }
  }
  if (/\bhave i (ever )?(done|worked|met)\b|\b(dig|research|look back)\b|\bin the past\b/.test(tl)) {
    const name = /\bfor\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*)/.exec(t)?.[1];
    return {
      steps: [
        { tool: 'plan', input: { steps: [{ tool: 'query', what: 'Check what the app already has' }, { tool: 'run', run: 'research', what: `Research live: ${t.slice(0, 120)}` }] } },
        (r) => (planRan(r) ? [{ tool: 'run', input: { kind: 'research', question: t, ...(name ? { names: [name] } : {}) } }] : [{ text: "I didn't run the research: say Run on the plan card when you want it, and I'll look live." }]),
        (r) => {
          const res = r.at(-1);
          if (res?.tool !== 'run') return [];
          const j = res?.json as { answer?: string; findings?: Array<{ text: string; permalink?: string }>; note?: string } | undefined;
          if (!res?.ok || !j?.answer) return [{ text: `I couldn't research that live here. ${j?.note ?? ''}`.trim() }];
          return [{ text: `${j.answer}${j.findings?.length ? `\n\n${j.findings.map((f) => `- ${f.permalink ? `[${f.text}](${f.permalink})` : f.text}`).join('\n')}` : ''}` }];
        },
      ],
    };
  }
  if (/\b(log|logged|logging|timesheet)\b/.test(tl)) {
    return {
      steps: [
        { tool: 'read', input: { route: 'time' } },
        (r) => {
          type Since = { lastLogged: { date: string } | null; searchedBackTo: string | null; notLogged: { count: number; hours: number; from: string | null; to: string | null } };
          const s = (r.at(-1)?.json as { data?: { sinceLastLogged?: Since } } | undefined)?.data?.sinceLastLogged;
          if (!s) return [{ text: "I couldn't read the Activity page." }];
          const n = s.notLogged;
          const head = s.lastLogged ? `You last logged activity on ${s.lastLogged.date}.` : `Nothing is logged back to ${s.searchedBackTo}.`;
          return [{ text: n.count ? `${head} Since then, ${n.count} entries (${n.hours} h) from ${n.from} to ${n.to} aren't logged yet.` : `${head} Nothing is waiting to be logged since then.` }];
        },
      ],
    };
  }
  if (/\b(find|look ?up|where is|where's|search)\b/.test(tl)) {
    const query = t.replace(/^.*?\b(?:find|look ?up|where is|where's|search(?: for)?)\b/i, '').replace(/[?]/g, '').trim() || t;
    return {
      steps: [
        { tool: 'search', input: { source: 'ledger', query, limit: 5 } },
        (r) => {
          const hits = ((r.at(-1)?.json as { hits?: Array<{ title: string; url: string | null }> } | undefined)?.hits ?? []);
          return [{ text: hits.length ? `Found ${hits.length}: ${hits.slice(0, 3).map((h) => (h.url ? `[${h.title}](${h.url})` : h.title)).join(', ')}.` : `Nothing in the ledger matches "${query}".` }];
        },
      ],
    };
  }
  // Default: the day. "What are my top 3 today and why?"
  return {
    steps: [
      { tool: 'read', input: { route: 'today' } },
      (r) => {
        const p = (r.at(-1)?.json as { data?: { today?: { top3?: Array<{ title: string; topReasons: string[]; rank: number | null }> } } } | undefined)?.data ?? pack;
        const top = (p as { today?: { top3?: Array<{ title: string; topReasons: string[] }> } } | null)?.today?.top3 ?? [];
        if (!top.length) return [{ text: 'Nothing is ranked for today yet.' }];
        return [{ text: `Your top ${top.length} today:\n\n${top.map((x, i) => `${i + 1}. **${x.title}**${x.topReasons.length ? ` (${x.topReasons.join(', ')})` : ''}`).join('\n')}` }];
      },
    ],
  };
}

/** The fake `query()`. */
export function createFakeChatQuery(fo: FakeChatOptions = {}): ChatQueryFn {
  return ({ prompt, options }) => {
    const gen = async function* (): AsyncGenerator<SDKMessage> {
      const signal = options.abortController!.signal;
      const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      const server = (options.mcpServers as Record<string, { instance: { connect: (t: unknown) => Promise<void>; close?: () => Promise<void> } }>)[CHAT_SERVER_NAME]!.instance;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: 'fake-chat-cli', version: '1' });
      await client.connect(ct);
      const model = fo.model ?? String(options.model);
      const usage = fo.usage ?? { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 0 };
      let n = 0;
      let turns = 0;
      const results: ToolResults = [];
      const wait = async () => {
        if (fo.delayMs) await new Promise((r) => setTimeout(r, fo.delayMs));
        if (signal.aborted) throw aborted();
      };
      try {
        const sessionId = fo.sessionId ?? options.resume ?? options.sessionId ?? 'fake-session';
        yield { type: 'system', subtype: 'init', session_id: sessionId, mcp_servers: [{ name: CHAT_SERVER_NAME, status: 'connected' }], tools: [...(options.allowedTools ?? [])] } as unknown as SDKMessage;
        const text = messageOf(prompt);
        const plan = planFor(text, options, prompt);
        const queue: Plan['steps'] = [...(fo.inject ?? []), ...plan.steps];
        while (queue.length) {
          const step = queue.shift()!;
          if (typeof step === 'function') {
            queue.unshift(...step(results));
            continue;
          }
          await wait();
          n += 1;
          const id = `msg_fake_${n}`;
          if ('text' in step) {
            yield { type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: null } as unknown as SDKMessage;
            for (const chunk of step.text.match(/\S+\s*|\s+/g) ?? []) {
              yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }, parent_tool_use_id: null } as unknown as SDKMessage;
            }
            yield { type: 'assistant', message: { id, model, content: [{ type: 'text', text: step.text }], usage }, parent_tool_use_id: null } as unknown as SDKMessage;
            continue;
          }
          turns += 1;
          const full = (CHAT_TOOL_NAMES as string[]).includes(step.tool) ? chatToolFullName(step.tool) : step.tool;
          yield { type: 'assistant', message: { id, model, content: [{ type: 'tool_use', id: `tu_${n}`, name: full, input: step.input }], usage }, parent_tool_use_id: null } as unknown as SDKMessage;
          if (signal.aborted) throw aborted();
          const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
          if (hook) {
            const out = (await hook({ hook_event_name: 'PreToolUse', tool_name: full, tool_input: step.input, tool_use_id: `tu_${n}`, session_id: 'fake', transcript_path: '', cwd: '' } as never, `tu_${n}`, { signal })) as { hookSpecificOutput?: { permissionDecision?: string }; continue?: boolean };
            if (out?.continue === false) throw aborted();
            if (out?.hookSpecificOutput?.permissionDecision === 'deny') continue;
          }
          if (!full.startsWith(`mcp__${CHAT_SERVER_NAME}__`)) continue;
          const r = (await client.callTool({ name: full.slice(`mcp__${CHAT_SERVER_NAME}__`.length), arguments: step.input })) as { content?: Array<{ text?: string }>; isError?: boolean };
          const out = r.content?.[0]?.text ?? '';
          let json: unknown = null;
          try {
            json = JSON.parse(withoutUntrustedHeader(out));
          } catch {
            /* plain text */
          }
          results.push({ tool: full.slice(`mcp__${CHAT_SERVER_NAME}__`.length), ok: !r.isError, json, text: out });
        }
        const inTok = usage.input_tokens * Math.max(1, n);
        const outTok = usage.output_tokens * Math.max(1, n);
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: turns + 1,
          result: 'done',
          total_cost_usd: fo.resultCostUsd ?? 0,
          usage: { input_tokens: inTok, output_tokens: outTok },
          modelUsage: { [model]: { inputTokens: inTok, outputTokens: outTok, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: fo.resultCostUsd ?? 0, contextWindow: 1, maxOutputTokens: 1 } },
          permission_denials: [],
        } as unknown as SDKMessage;
      } finally {
        await client.close().catch(() => undefined);
      }
    };
    return gen();
  };
}
