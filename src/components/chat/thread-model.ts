/**
 * Pure derivations for the v2 assistant (panel and page): the one-line tool summary, scan rows, the
 * morning-brief summary, and "In this thread" (everything a thread touched). No React, no fetching.
 */
import type { ChatResource, Proposal, Receipt } from '@/contract';
import { auditIdsForUndoAll, proposalStateOf, undoStateOf, type ChatActionsState, type ChatMessageView, type ChatToolView } from '@/client/chat';

// ── Tool activity ────────────────────────────────────────────────────────────────────────────

const VERB: Record<string, string> = {
  search: 'Searched',
  read: 'Read',
  read_thread: 'Read a thread in',
  events: 'Read',
  list: 'Listed',
  explain: 'Explained the rank',
  move: 'Moved',
  match: 'Matched',
  link: 'Linked',
  scan: 'Scanned',
  patch: 'Updated',
  capture: 'Captured',
  preview: 'Previewed',
  apply: 'Applied',
  find: 'Found',
};

const SOURCE: Record<string, string> = {
  slack: 'Slack',
  gmail: 'Gmail',
  calendar: 'Calendar',
  drive: 'Drive',
  gemini: 'Gemini notes',
  org62: 'Org62',
  vdp: 'VDP',
  claude: 'Claude sessions',
  research: 'everywhere',
  work: 'work',
  items: 'items',
  priority: '',
  policy: 'policy',
  linker: '',
};

const sentence = (s: string) => s.replace(/[_.]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** "slack.search" → "Searched Slack"; unknown tools read as their name in sentence case. */
export function toolVerb(name: string): string {
  const [ns, op] = name.includes('.') ? (name.split('.', 2) as [string, string]) : ['', name];
  const verb = VERB[op];
  const src = ns in SOURCE ? SOURCE[ns] : sentence(ns);
  if (!verb) return sentence(name);
  return src ? `${verb} ${src}` : verb;
}

/** One phrase for a finished tool: "Searched Slack · 3 threads". */
export function toolPhrase(t: ChatToolView): string {
  if (t.ok === null) return `${clip(t.startSummary ?? t.summary, 56)}…`;
  const verb = toolVerb(t.name);
  if (t.ok === false) return `${verb} · failed`;
  const result = t.summary && t.summary !== t.startSummary ? clip(t.summary, 44) : '';
  // A one-word result ("Linked", "ok") says less than what the tool set out to do.
  if (/^[\w-]+\.?$/.test(result) && t.startSummary) return clip(t.startSummary, 56);
  return result ? `${verb} · ${result}` : verb;
}

export function isScanTool(t: Pick<ChatToolView, 'name'>): boolean {
  return /(^|\.)scan$/.test(t.name);
}

const sourceOf = (name: string) => {
  const ns = name.includes('.') ? name.split('.')[0] : '';
  return ns in SOURCE ? SOURCE[ns] : sentence(ns);
};

/**
 * The folded line: up to two phrases, then "· n more tools" (mockup: "Searched Slack · 3 threads · read
 * 2 messages · 2 more tools"). A second phrase on the same source drops the source and reads lower-case.
 * Scan tools are shown as scan rows instead.
 */
/**
 * A guard that held something for you, not a failure (SEC-8 `remember`, SEC-9 `run reauth`): the tool result's `held`
 * flag says so. Rows written before the flag fall back to the summary's ending, what you can say instead ("Not kept
 * (say it in your words)", "Sign-in not started (say which connector)"). The row is neutral and the line does not count
 * it as failed (UX.md "Raise a hand, never a red stop").
 */
export const isHeldForYou = (t: Pick<ChatToolView, 'ok' | 'summary' | 'held'>) =>
  t.ok === false && (t.held === true || (t.held === undefined && /\(say [^)]+\)$/.test(t.summary.trim())));

export function toolSummaryLine(tools: ChatToolView[]): { line: string; more: number; failed: number } {
  const shown = tools.filter((t) => !isScanTool(t));
  const failed = shown.filter((t) => t.ok === false && !isHeldForYou(t)).length;
  const head = shown.slice(0, 2);
  const parts = head.map((t, i) => {
    if (i === 0 || t.ok === null) return toolPhrase(t);
    const op = t.name.includes('.') ? t.name.split('.').slice(1).join('.') : t.name;
    const verb = (VERB[op] ?? sentence(op)).split(' ')[0].toLowerCase();
    const src = sourceOf(t.name);
    const sameSource = src === sourceOf(head[0].name);
    const result = t.summary && t.summary !== t.startSummary ? clip(t.summary, 36) : '';
    return [verb, sameSource ? '' : src, result].filter(Boolean).join(' ');
  });
  return { line: parts.join(' · '), more: Math.max(0, shown.length - head.length), failed };
}

// ── Scan rows ────────────────────────────────────────────────────────────────────────────────

export interface ScanView {
  id: string;
  source: string;
  window: string | null;
  status: 'running' | 'done' | 'failed';
  title: string;
  detail: string | null;
  /** Tool ids the row already tells (the scan and what it found): left out of the tool line. */
  consumed: string[];
}

/** "slack.scan" + "Re-reading Slack since Wed 08:00 (2d)" → Slack · 2 days. Later tools in the turn explain what it found. */
export function scanViews(tools: ChatToolView[]): ScanView[] {
  return tools.flatMap((t, i) => {
    if (!isScanTool(t)) return [];
    const ns = t.name.split('.')[0];
    const source = SOURCE[ns] || sentence(ns);
    const w = /\((\d+)\s*([dh])\)/i.exec(t.startSummary ?? '') ?? /\b(\d+)\s*([dh])\b/i.exec(t.startSummary ?? '');
    const window = w ? `${w[1]} ${w[2].toLowerCase() === 'd' ? (w[1] === '1' ? 'day' : 'days') : w[1] === '1' ? 'hour' : 'hours'}` : null;
    const after = tools.slice(i + 1).filter((x) => !isScanTool(x) && x.ok !== null);
    const status: ScanView['status'] = t.ok === null ? 'running' : t.ok ? 'done' : 'failed';
    const found = after.find((x) => /match|link|find|triage/i.test(x.name));
    return [
      {
        id: t.id,
        source,
        window,
        status,
        title: status === 'running' ? `Scanning ${source}${window ? ` · ${window}` : ''}` : status === 'failed' ? `${source} couldn't be re-read` : clip(found?.summary ?? t.summary, 80),
        detail: status === 'failed' ? clip(t.summary, 120) : found ? clip(t.summary, 120) : null,
        consumed: [t.id, ...(found ? [found.id] : [])],
      },
    ];
  });
}

// ── Diff grouping ────────────────────────────────────────────────────────────────────────────

/** Consecutive lines on the same item become one diff row: the item once, then each field change. */
export function groupByEntity<T extends { what: string | null }>(lines: T[]): Array<{ what: string | null; rows: T[] }> {
  const out: Array<{ what: string | null; rows: T[] }> = [];
  for (const l of lines) {
    const last = out.at(-1);
    if (last && (l.what === null || l.what === last.what)) last.rows.push(l);
    else out.push({ what: l.what, rows: [l] });
  }
  return out;
}

// ── Morning brief ────────────────────────────────────────────────────────────────────────────

const stripMd = (s: string) => s.replace(/\*\*|__|`|\[([^\]]*)\]\([^)]*\)/g, (_, l) => l ?? '').replace(/\s+/g, ' ').trim();

/** One line for the collapsed brief: the first sentence after the greeting, plus how many priorities it lists. */
export function briefSummary(markdown: string): string {
  const paras = markdown.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const first = stripMd(paras.find((p) => !/^(\d+\.|[-*])\s/.test(p)) ?? '');
  const sentences = first.split(/(?<=[.!?])\s+/).filter(Boolean);
  const greeting = sentences[0] && /^(good (morning|afternoon|evening)|hi|hello)\b/i.test(sentences[0]) ? 1 : 0;
  const lead = clip(sentences[greeting] ?? sentences[0] ?? '', 120);
  const items = markdown.split('\n').filter((l) => /^\s*\d+\.\s/.test(l)).length;
  const tail = items ? `${items} ${items === 1 ? 'priority' : 'priorities'}.` : '';
  return [lead, tail].filter(Boolean).join(' ');
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────

export function lastUserMessage(messages: ChatMessageView[]): ChatMessageView | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i];
  return null;
}

/** Drafts and Claude sessions get their own cards; every other resource is an evidence chip. */
export function splitResources(resources: ChatResource[]): { drafts: ChatResource[]; sessions: ChatResource[]; evidence: ChatResource[] } {
  return {
    drafts: resources.filter((r) => r.kind === 'draft'),
    sessions: resources.filter((r) => r.kind === 'agent_run'),
    evidence: resources.filter((r) => r.kind !== 'draft' && r.kind !== 'agent_run'),
  };
}

/** The proposal ⌘↵ applies: the newest one still pending in the thread. */
export function latestPendingProposal(messages: ChatMessageView[], actions: ChatActionsState): Proposal | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ps = messages[i].proposals;
    for (let j = ps.length - 1; j >= 0; j--) {
      const s = proposalStateOf(actions, ps[j].proposal).status;
      if (s === 'pending' || s === 'error') return ps[j].proposal;
    }
  }
  return null;
}

/** What `z` undoes: the newest change in the thread that is still live (a receipt or an applied proposal). */
export function latestUndoable(messages: ChatMessageView[], actions: ChatActionsState): string[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    for (let j = m.proposals.length - 1; j >= 0; j--) {
      const st = proposalStateOf(actions, m.proposals[j].proposal);
      if (st.status === 'applied' && st.auditId && undoStateOf(actions, st.auditId).status !== 'undone') return [st.auditId];
    }
    for (let j = m.receipts.length - 1; j >= 0; j--) {
      const ids = auditIdsForUndoAll(m.receipts[j], withPersistedUndo(m.receipts[j], actions));
      if (ids.length) return ids;
    }
  }
  return null;
}

/** Persisted receipts carry `undoneAt` per line (CONTRACT-1): treat those as undone unless this session knows better. */
export function withPersistedUndo(receipt: Receipt, actions: ChatActionsState): ChatActionsState {
  const extra: ChatActionsState['undo'] = {};
  for (const c of receipt.changes) if (c.undoneAt && !actions.undo[c.auditId]) extra[c.auditId] = { status: 'undone' };
  return Object.keys(extra).length ? { ...actions, undo: { ...extra, ...actions.undo } } : actions;
}

// ── In this thread ───────────────────────────────────────────────────────────────────────────

export interface TouchedChange {
  key: string;
  messageId: string;
  title: string;
  at: string;
  count: number;
  auditIds: string[];
  kind: 'receipt' | 'proposal';
  proposal?: Proposal;
  /** The receipt behind it (a streamed receipt, or what applying the proposal returned). */
  receipt?: Receipt | null;
}

export interface ThreadTouched {
  changes: TouchedChange[];
  pending: Array<{ messageId: string; proposal: Proposal; summary: string | null }>;
  itemIds: Array<{ id: string; label: string }>;
  drafts: ChatResource[];
  sessions: ChatResource[];
  scans: Array<ScanView & { messageId: string; at: string }>;
  sources: ChatResource[];
}

const pushUnique = <T>(xs: T[], x: T, key: (v: T) => string) => {
  if (!xs.some((y) => key(y) === key(x))) xs.push(x);
};

/** Everything a thread touched, newest first within each group. */
export function threadTouched(messages: ChatMessageView[], actions: ChatActionsState): ThreadTouched {
  const out: ThreadTouched = { changes: [], pending: [], itemIds: [], drafts: [], sessions: [], scans: [], sources: [] };
  const item = (id: string, label: string) => pushUnique(out.itemIds, { id, label }, (x) => x.id);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    for (const r of [...m.receipts].reverse()) {
      out.changes.push({ key: r.id, messageId: m.id, title: r.summary, at: r.at, count: r.changes.length, auditIds: [...new Set(r.changes.map((c) => c.auditId))], kind: 'receipt', receipt: r });
      for (const c of r.changes) if (c.entity.type === 'work_item') item(c.entity.id, c.entity.label);
    }
    for (const p of [...m.proposals].reverse()) {
      const st = proposalStateOf(actions, p.proposal);
      if (st.status === 'applied') {
        out.changes.push({
          key: p.proposal.id,
          messageId: m.id,
          title: p.summary ?? p.proposal.reason,
          at: st.receipt?.at ?? p.proposal.resolvedAt ?? p.proposal.createdAt,
          count: st.receipt?.changes.length || p.proposal.changes.length,
          auditIds: st.auditId ? [st.auditId] : [],
          kind: 'proposal',
          proposal: p.proposal,
          receipt: st.receipt ?? null,
        });
        for (const c of st.receipt?.changes ?? []) if (c.entity.type === 'work_item') item(c.entity.id, c.entity.label);
      } else if (st.status === 'pending' || st.status === 'error' || st.status === 'applying') {
        out.pending.push({ messageId: m.id, proposal: p.proposal, summary: p.summary });
      }
      if (p.proposal.entity.type === 'work_item') item(p.proposal.entity.id, p.proposal.entity.label);
    }
    for (const s of scanViews(m.tools)) out.scans.push({ ...s, messageId: m.id, at: m.at });
    for (const r of [...m.resources].reverse()) {
      if (r.kind === 'draft') pushUnique(out.drafts, r, (x) => x.id);
      else if (r.kind === 'agent_run') pushUnique(out.sessions, r, (x) => x.id);
      else if (r.kind === 'work_item') item(r.id, r.label);
      else pushUnique(out.sources, r, (x) => `${x.kind}:${x.id}`);
    }
  }
  return out;
}

export function touchedCount(t: ThreadTouched): number {
  return t.changes.length + t.pending.length + t.itemIds.length + t.drafts.length + t.sessions.length + t.scans.length + t.sources.length;
}

/** "1h 30m", "20m", "3d" (past a day, hours stop mattering). */
export function fmtMin(n: number): string {
  if (n >= 24 * 60) return `${Math.round(n / (24 * 60))}d`;
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
