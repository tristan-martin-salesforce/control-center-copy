/**
 * The scanner eval harness: replays one golden case through the real deterministic pipeline, in memory, in
 * milliseconds, with a scripted traversal agent and a pluggable completion model (the cassette in CI).
 *
 *   per scan (sources with the same `seen_at`):
 *     fetch    Slack: the inbox searches S1–S4 of skills/scan-slack.md §2 (a message no search returns is never
 *              recorded: SCN-1), rendered in the recorded tool-output format and parsed by REC-1
 *              (SlackAutoRecorder → parseSlackSearch → normalizeItem: the 1,000-character excerpt cap applies, SCN-9).
 *              Gmail / Drive / Calendar: the deterministic fetchers' item shape. Gemini: the real notes parser
 *              (parseGeminiNotes, SCN-11).
 *     agent    the scripted actions of the case (`propose` / `propose_new` / `link`) through the store's writer, so
 *              S4 keys and DUP-1 apply (SCN-4, SCN-14). An expected item is proposed only when its `ask_quote` is
 *              visible in what was stored (the oracle proposer: a perfect model, so recall measures the code's losses).
 *     reeval   every new evidence row → signalFromEvidence → the closure machine (applySignal) → item state.
 *     complete two minutes later: runCompletionPass with the model (cassette), then reeval again.
 *
 * Nothing here calls a network or a real model. Placeholder data only.
 */
import { applySignal } from '@/engines/closure/machine';
import { signalFromEvidence, type EvidenceLink } from '@/engines/closure/signals';
import type { ClosureItem, SignalSource } from '@/engines/types';
import { parseGeminiNotes } from '@/connectors/google/gemini-notes';
import { redactExcerpt } from '@/connectors/redact';
import { h16 } from '@/connectors/util';
import { createRunState, type CcRunState } from '@/llm/cc-tools';
import { SlackAutoRecorder } from '@/llm/slack-rec';
import { runCompletionPass, type CompletionModel, type CompletionModelRequest, type CompletionPassResult, type CompletionWatermark } from '@/scanner/completion';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import type { ConnectorId, NormalizedSourceItem, PersonRef, ScanContext, ScannerStore, TimeWindow } from '@/scanner/types';
import { runResolutionChecks, type CheckResult } from '@/engines/resolution/check';
import { loadResolutionSkill } from '@/scanner/resolution/skill';
import type { CheckRecord } from '@/engines/resolution/types';
import { SLACK_THREAD_TOOL, renderThreadRead, threadsToFollow, type ThreadRow } from '@/scanner/resolution/recall';
import { triggersFor } from '@/scanner/resolution/triggers';

import type { AgentAction, GoldenCase, GoldenSource } from './golden';
import { HARNESS_CLOSING, isCheckEvidence, memoryResolutionStore, triggerItemsOf, triggerSourceOf } from './resolution';

const SLACK_TOOL = 'mcp__slack__slack_search_public_and_private';
const MIN = 60_000;
/** The resolution skill, loaded once (the engine receives it; it never reads the file). */
const RESOLUTION_SKILL_DOC = loadResolutionSkill();

export type FinalState = 'closed' | 'likely' | 'open' | 'missing';

export interface CaseRun {
  case: GoldenCase;
  store: InMemoryScannerStore;
  /** Golden source id → source item id (recorded sources only). */
  sourceIds: Map<string, string>;
  /** Golden item id → work item id (items that exist on their own). */
  itemIds: Map<string, string>;
  /** Work item id → its states in order (from the first). */
  history: Map<string, string[]>;
  /** Items proposed that the case does not expect (each one is a dismiss click). */
  extraItems: string[];
  /** Why an expected item or a source went missing, per golden id. */
  why: Map<string, string>;
  passes: CompletionPassResult[];
  calls: number;
  /** When each scan ran (ISO), in order. */
  scans: string[];
  end: string;
  /** closer `resolution`: every check the resolution check recorded, and its results. */
  checks: CheckRecord[];
  checkResults: CheckResult[];
  /** Slack threads re-read by the recall sweep (SCN-1). */
  threadReads: number;
}

export interface RunCaseOptions {
  /** Which closer runs after each scan: the legacy completion pass (default) or the resolution check, live. */
  closer?: 'completion' | 'resolution';
  /** Replace the scripted agent with this interpreter (the FTI A/B). */
  interpret?: InterpretHook;
}

const iso = (ms: number) => new Date(ms).toISOString();
const slackTs = (at: string) => (Date.parse(at) / 1000).toFixed(6);
const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/** The completion check's cassette label: the pass time and the item titles (no message text). */
export function completionLabel(req: CompletionModelRequest): string {
  try {
    const u = JSON.parse(req.user) as { now?: string; items?: Array<{ title?: string }> };
    return `${u.now ?? '?'} | ${(u.items ?? []).map((i) => i.title ?? '?').join(' | ')}`;
  } catch {
    return '';
  }
}

/** Which inbox searches (skills/scan-slack.md §2) return a Slack message. Empty: no search ever sees it. */
export function inboxQueries(s: GoldenSource, meSlackId: string): Array<{ step: 'S1' | 'S2' | 'S3' | 'S4'; args: Record<string, unknown> }> {
  const me = `<@${meSlackId}>`;
  const out: Array<{ step: 'S1' | 'S2' | 'S3' | 'S4'; args: Record<string, unknown> }> = [];
  const type = s.meta.channelType;
  if (!s.from_me && (type === 'im' || type === 'mpim')) out.push({ step: 'S1', args: { filters: `-from:${me}`, channel_types: 'im,mpim' } });
  if (!s.from_me && type === 'channel' && s.body.includes(me)) out.push({ step: 'S2', args: { keywords: [me], channel_types: 'public_channel,private_channel' } });
  if (s.from_me) out.push({ step: 'S3', args: { filters: `from:${me}`, channel_types: 'public_channel,private_channel,mpim,im' } });
  if (s.from_me && s.meta.files?.length) out.push({ step: 'S4', args: { filters: `from:${me} has:file`, channel_types: 'public_channel,private_channel,mpim,im' } });
  return out;
}

/** One message as the Slack MCP search returns it (detailed format, as recorded in tests/fixtures/scanner/slack). */
export function renderSlackHit(s: GoldenSource, c: GoldenCase, root: GoldenSource | undefined): string {
  const ch = s.meta.channelId!;
  const ts = slackTs(s.occurred_at);
  const label = s.meta.channelType === 'im' ? 'DM' : s.meta.channelType === 'mpim' ? 'Group DM' : `#${s.meta.channelName ?? 'channel'}`;
  const author = s.from_me ? { name: c.me.name, email: c.me.email, externalId: c.me.slackId } : s.meta.author!;
  const parts = s.meta.channelType === 'channel' ? [] : [{ name: c.me.name, externalId: c.me.slackId }, ...(s.meta.participants ?? [])];
  const thread = root ? `?thread_ts=${slackTs(root.occurred_at)}&cid=${ch}` : '';
  return [
    '# Search Results for: golden',
    '',
    '## Messages (1 results)',
    '### Result 1 of 1',
    `Channel: ${label} (ID: ${ch})`,
    ...(parts.length ? [`Participants: ${parts.map((p) => `${p.name} (ID: ${p.externalId ?? 'U0UNKNOWN'})`).join(', ')}`] : []),
    `From: ${author.name} <${author.email ?? ''}> (ID: ${author.externalId ?? 'U0UNKNOWN'}) `,
    `Time: ${s.occurred_at}`,
    `Message_ts: ${ts}`,
    `Permalink: [link](https:\\/\\/example.slack.com\\/archives\\/${ch}\\/p${ts.replace('.', '')}${thread})`,
    'Text: ',
    s.body,
    '',
    '---',
    '',
  ].join('\n');
}

function person(p: { name: string; email?: string; externalId?: string } | undefined, isMe = false): PersonRef | undefined {
  return p ? { name: p.name, ...(p.email ? { email: p.email } : {}), ...(p.externalId ? { externalId: p.externalId } : {}), isMe } : undefined;
}

/** A non-Slack row as its deterministic fetcher would record it. */
export function normalizeGolden(s: GoldenSource, c: GoldenCase, byId: Map<string, GoldenSource>): NormalizedSourceItem {
  const me: PersonRef = { name: c.me.name, email: c.me.email, isMe: true };
  const author = s.from_me ? me : person(s.meta.author);
  const ex = redactExcerpt(s.body);
  const root = s.thread_of ? byId.get(s.thread_of) : undefined;
  const base = { occurredAt: s.occurred_at, ...(s.url ? { permalink: s.url } : {}), ...(s.title ? { title: s.title } : {}), redacted: ex.redacted };
  switch (s.source) {
    case 'gmail': {
      const thread = s.meta.threadId ?? root?.meta.threadId ?? `thr-${root?.id ?? s.id}`;
      const ext = `gm-${c.id}-${s.id}`;
      return {
        connector: 'gmail',
        kind: 'email',
        externalId: ext,
        dedupeKey: `gmail:${ext}`,
        contentHash: h16(s.title, s.body),
        ...base,
        ...(author ? { author } : {}),
        participants: (s.meta.to ?? []).map((p) => person(p)!).concat(s.from_me ? [] : [me]),
        excerpt: ex.text,
        threadRef: `gmail-thread:${thread}`,
        ...(s.meta.fileRefs?.length ? { fileRefs: s.meta.fileRefs } : {}),
        payload: { direction: s.from_me ? 'sent' : 'inbox', toMe: !s.from_me, subject: s.title ?? '' },
      };
    }
    case 'drive': {
      const fileId = s.meta.fileId ?? `file-${s.id}`;
      return {
        connector: 'drive',
        kind: 'file_revision',
        externalId: `${fileId}@${s.occurred_at}`,
        dedupeKey: `drive:${fileId}@${s.occurred_at}`,
        contentHash: h16(fileId, s.occurred_at, s.body),
        ...base,
        ...(author ? { author } : {}),
        excerpt: ex.text,
        fileRefs: [fileId],
        payload: { fileId, editedByMe: s.from_me, modifiedTime: s.occurred_at },
      };
    }
    case 'calendar': {
      const eventId = s.meta.eventId ?? `ev-${s.id}`;
      return {
        connector: 'calendar',
        kind: 'calendar_event',
        externalId: eventId,
        dedupeKey: `calendar:${eventId}`,
        contentHash: h16(eventId, s.title, s.body),
        ...base,
        ...(author ? { author } : {}),
        participants: [me, ...(s.meta.participants ?? []).map((p) => person(p)!)],
        excerpt: ex.text,
        threadRef: `calendar:${eventId}`,
        payload: { eventId },
      };
    }
    case 'gemini_notes': {
      const docId = s.meta.fileId ?? `doc-${s.id}`;
      const p = parseGeminiNotes(s.body, { email: c.me.email, name: c.me.name });
      const steps = p.nextSteps.map((x) => ({ assignees: x.assignees, title: x.title, description: x.description, done: x.done, isMine: x.isMine }));
      const nx = redactExcerpt(p.summary || steps.map((x) => x.title).join('; '));
      return {
        connector: 'gemini_notes',
        kind: 'meeting_notes',
        externalId: docId,
        dedupeKey: `gemini:${docId}`,
        contentHash: h16(p.summary, JSON.stringify(steps)),
        ...base,
        participants: [me, ...(s.meta.participants ?? []).map((x) => person(x)!)],
        excerpt: nx.text,
        threadRef: `calendar:${s.meta.eventId ?? `ev-${s.id}`}`,
        fileRefs: [docId],
        payload: { summary: p.summary, nextSteps: steps, myNextSteps: steps.filter((x) => x.isMine), othersNextSteps: steps.filter((x) => !x.isMine), hasNotes: p.hasNotes },
      };
    }
    case 'claude_sessions': {
      const sessionId = s.meta.sessionId ?? `sess-${s.id}`;
      return {
        connector: 'claude_sessions',
        kind: 'claude_session',
        externalId: sessionId,
        dedupeKey: `claude:${sessionId}@${s.occurred_at}`,
        contentHash: h16(sessionId, s.meta.status, s.body),
        ...base,
        ...(author ? { author } : {}),
        excerpt: ex.text,
        threadRef: `claude-session:${sessionId}`,
        payload: { sessionId, status: s.meta.status ?? 'unknown', title: s.title ?? '', summary: ex.text },
      };
    }
    default:
      throw new Error(`normalizeGolden: ${s.source} rows go through REC-1`);
  }
}

/** The text a scanner agent could see for a recorded source (what the oracle proposer reads). */
function visibleText(store: InMemoryScannerStore, sourceItemId: string): string {
  const row = store.getSourceItem(sourceItemId);
  if (!row) return '';
  if (row.connector === 'gemini_notes') {
    const mine = ((row.payload ?? {}) as { myNextSteps?: Array<{ title: string; description?: string }> }).myNextSteps ?? [];
    return mine.map((x) => `${x.title} ${x.description ?? ''}`).join('\n');
  }
  return [row.title, row.excerpt].filter(Boolean).join('\n');
}

const signalSource = (connector: string): SignalSource | undefined => (connector === 'gemini_notes' ? 'gemini' : connector === 'claude_sessions' ? 'claude' : (['slack', 'gmail', 'calendar', 'drive', 'org62', 'vdp', 'claude'] as const).find((x) => x === connector));

/**
 * FTI (fetch-then-interpret): instead of the scripted oracle agent, the real interpret step reads what each scan
 * recorded (rules, candidates, the batched classifier with its cassette, the cc handlers). `fresh` holds the source
 * item ids the scan recorded new or changed.
 */
export type InterpretHook = (a: { store: ScannerStore; state: CcRunState; ctx: ScanContext; window: TimeWindow; fresh: Set<string>; connector: ConnectorId }) => Promise<void>;

export async function runCase(c: GoldenCase, model: CompletionModel, opts: RunCaseOptions = {}): Promise<CaseRun> {
  const closer = opts.closer ?? 'completion';
  const byId = new Map(c.sources.map((s) => [s.id, s]));
  let now = Date.parse([...c.sources].sort((a, b) => a.seen_at.localeCompare(b.seen_at))[0]!.seen_at) - 10 * MIN;
  const store = new InMemoryScannerStore({
    clock: { now: () => new Date(now) },
    profile: { me: { userId: 'u-golden', name: c.me.name, email: c.me.email, slackId: c.me.slackId }, watchList: [], aliases: { accounts: [], channels: [] } },
  });
  const run: CaseRun = { case: c, store, sourceIds: new Map(), itemIds: new Map(), history: new Map(), extraItems: [], why: new Map(), passes: [], calls: 0, scans: [], end: '', checks: [], checkResults: [], threadReads: 0 };
  const applied = new Set<string>();
  const version = new Map<string, number>();
  /** When the engine closed an item (the completion message's own time, as the data layer stores `done_at`). */
  const doneAt = new Map<string, string>();
  const reopened = new Map<string, number>();
  const reopenedAt = new Map<string, string>();
  const note = (id: string, s: string) => {
    if (!run.why.has(id)) run.why.set(id, s);
  };
  const track = (workItemId: string) => {
    const st = store.getWorkItem(workItemId)?.state;
    if (!st) return;
    const h = run.history.get(workItemId) ?? [];
    if (h[h.length - 1] !== st) h.push(st);
    run.history.set(workItemId, h);
  };

  /** New evidence → the closure machine → state (the `reevaluate` job, in memory). */
  const reeval = () => {
    for (const w of store.listWorkItems()) {
      const wid = w.workItemId;
      track(wid);
      const rows = store
        .evidenceFor(wid)
        .filter((e) => !applied.has(e.id))
        .map((e) => ({ e, s: store.getSourceItem(e.sourceItemId)! }))
        .sort((a, b) => a.s.occurredAt.localeCompare(b.s.occurredAt));
      for (const { e, s } of rows) {
        applied.add(e.id);
        const cur = store.getWorkItem(wid)!;
        const link: EvidenceLink = {
          id: e.id,
          role: e.role,
          confidence: e.confidence,
          reason: e.reason,
          at: s.occurredAt,
          linkedAt: iso(now),
          ...(signalSource(s.connector) ? { source: signalSource(s.connector)! } : {}),
          ...(s.author?.name ? { actor: { name: s.author.name, ...(s.author.isMe ? { isMe: true } : {}) } } : {}),
          ...(s.connector === 'drive' ? { fileRef: s.externalId.replace(/@.*$/, '') } : {}),
        };
        const item: ClosureItem = { id: wid, version: version.get(wid) ?? 1, kind: w.kind as ClosureItem['kind'], status: cur.state as ClosureItem['status'], title: w.title, resolution: null, involvement: 'owner', ...(doneAt.has(wid) ? { doneAt: doneAt.get(wid)! } : {}), reopenedCount: reopened.get(wid) ?? 0 };
        const d = applySignal(item, signalFromEvidence(link));
        if (d.transition && d.transition.to !== cur.state) {
          if (d.transition.to === 'done') doneAt.set(wid, s.occurredAt);
          else if (cur.state === 'done') {
            doneAt.delete(wid);
            reopened.set(wid, (reopened.get(wid) ?? 0) + 1);
            reopenedAt.set(wid, s.occurredAt);
          }
          store.setWorkItemState(wid, d.transition.to, d.transition.to === 'done' ? { doneBy: 'engine', doneAt: s.occurredAt } : {});
          version.set(wid, (version.get(wid) ?? 1) + 1);
          track(wid);
        }
        if (d.sibling) run.extraItems.push(`sibling of ${wid}: ${d.sibling.title ?? 'new requirement'}`);
      }
    }
  };

  const act = async (runId: string, s: GoldenSource, a: AgentAction) => {
    const sid = run.sourceIds.get(s.id);
    if (!sid) return; // the agent never saw it
    if ('propose' in a) {
      const it = c.items_expected.find((x) => x.id === a.propose)!;
      if (!norm(visibleText(store, sid)).includes(norm(it.ask_quote))) {
        note(it.id, s.source === 'gemini_notes' ? 'the notes parser found no next step of mine with the ask' : 'the ask is not in the stored text (cut at 1,000 characters?)');
        return;
      }
      const res = await store.proposeItem(runId, { kind: it.kind, title: it.title, ...(it.purpose ? { purpose: it.purpose } : {}), ...(it.due ? { due: it.due } : {}), evidence: [{ sourceItemId: sid, role: 'origin', reason: 'golden: the ask' }], confidence: 'sure' });
      const owner = [...run.itemIds.entries()].find(([, w]) => w === res.workItemId)?.[0];
      if (owner && owner !== it.id) {
        note(it.id, `merged into ${owner} by DUP-1`);
        return;
      }
      run.itemIds.set(it.id, res.workItemId);
      track(res.workItemId);
    } else if ('propose_new' in a) {
      const res = await store.proposeItem(runId, { kind: a.propose_new.kind, title: a.propose_new.title, evidence: [{ sourceItemId: sid, role: 'origin', reason: 'golden: a follow-up' }], confidence: 'sure' });
      if (![...run.itemIds.values()].includes(res.workItemId) && !run.extraItems.includes(res.workItemId)) run.extraItems.push(res.workItemId);
    } else {
      const wid = run.itemIds.get(a.link);
      if (!wid) return;
      await store.linkEvidence(runId, { workItemId: wid, sourceItemId: sid, role: a.role, confidence: a.confidence, reason: a.reason });
    }
  };

  /** The recall sweep over what the store holds: my channel threads, re-read through slack_read_thread → REC-1. */
  const followMyThreads = async (rec: SlackAutoRecorder, recorded: Map<string, string>, at: number): Promise<number> => {
    const rootOf = (s: GoldenSource) => (s.thread_of ? byId.get(s.thread_of)! : s);
    const known = c.sources.filter((s) => s.source === 'slack' && run.sourceIds.has(s.id));
    const rows = new Map<string, ThreadRow>();
    for (const s of known.filter((x) => x.meta.channelType === 'channel' && (x.from_me || x.body.includes(`<@${c.me.slackId}>`)))) {
      const root = rootOf(s);
      const inThread = known.filter((x) => rootOf(x).id === root.id).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
      const last = inThread[inThread.length - 1]!;
      const prev = rows.get(root.id);
      if (!prev || prev.lastMineAt < s.occurred_at) rows.set(root.id, { channelId: root.meta.channelId!, channelType: 'channel', threadTs: slackTs(root.occurred_at), lastMineAt: s.occurred_at, lastRecordedAt: last.occurred_at, lastRecordedTs: slackTs(last.occurred_at) });
    }
    let reads = 0;
    for (const t of threadsToFollow([...rows.values()], new Date(at))) {
      const root = c.sources.find((x) => x.source === 'slack' && x.meta.channelId === t.channelId && slackTs(x.occurred_at) === t.threadTs)!;
      const replies = c.sources.filter((x) => x.thread_of === root.id && Date.parse(x.seen_at) <= at && Number(slackTs(x.occurred_at)) > Number(t.oldest)).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
      const who = (x: GoldenSource) => (x.from_me ? { author: c.me.name, email: c.me.email, id: c.me.slackId } : { author: x.meta.author!.name, ...(x.meta.author!.email ? { email: x.meta.author!.email } : {}), id: x.meta.author!.externalId ?? 'U0UNKNOWN' });
      const text = renderThreadRead({ ...who(root), ts: t.threadTs, text: root.body }, replies.map((x) => ({ ...who(x), ts: slackTs(x.occurred_at), text: x.body, at: x.occurred_at })), root.occurred_at);
      reads += 1;
      await rec.onToolResult(SLACK_THREAD_TOOL, { channel_id: t.channelId, message_ts: t.threadTs, oldest: t.oldest, response_format: 'detailed' }, { results: text }, `recall:${t.channelId}:${t.threadTs}:${t.oldest}`);
      for (const x of replies) {
        const sid = recorded.get(`slack:${x.meta.channelId}:${slackTs(x.occurred_at)}`);
        if (sid) run.sourceIds.set(x.id, sid);
      }
    }
    return reads;
  };

  // closer `resolution`: the resolution check, live, over the in-memory store
  const itemState = { version, doneAt, reopened, reopenedAt };
  const rstore = memoryResolutionStore(store, () => run.sourceIds.values(), itemState, run.checks);
  const evidenceSeen = new Set<string>();
  const resolutionPass = async (newSourceIds: string[]) => {
    const items = triggerItemsOf(store, run.sourceIds.values(), itemState);
    const sources = newSourceIds.map((id) => store.getSourceItem(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => triggerSourceOf(r as NormalizedSourceItem & { id: string }));
    const hits = new Map(triggersFor(items, sources, new Date(now)).map((h) => [h.itemId, h.trigger] as const));
    // new non-check evidence (the scanner agent linked it) on a live item
    for (const e of store.allEvidence()) {
      if (evidenceSeen.has(e.id)) continue;
      evidenceSeen.add(e.id);
      const w = store.getWorkItem(e.workItemId);
      if (!w || isCheckEvidence(e.reason) || e.role === 'origin' || e.role === 'context' || ['done', 'dismissed', 'merged', 'suggested'].includes(w.state)) continue;
      if (!hits.has(e.workItemId)) hits.set(e.workItemId, 'evidence');
    }
    if (!hits.size) return;
    const out = await runResolutionChecks({
      items: [...hits].map(([id, trigger]) => ({ id, trigger })),
      mode: 'live',
      store: rstore,
      model,
      skill: RESOLUTION_SKILL_DOC,
      settings: HARNESS_CLOSING,
      now: new Date(now),
      me: c.me.name,
      apply: async (results) => {
        for (const r of results) {
          if (r.plan.evidence) {
            const src = store.getSourceItem(r.plan.evidence.sourceItemId)!;
            const { runId } = await store.startRun({ scope: { connector: src.connector as ConnectorId, scope: 'resolution:check' }, trigger: 'reconcile', window: { from: iso(now), to: iso(now) } });
            await store.linkEvidence(runId, { workItemId: r.itemId, sourceItemId: src.id, role: r.plan.evidence.role, confidence: r.plan.evidence.confidence, reason: r.plan.evidence.reason });
            await store.reportCoverage(runId, [{ kind: 'query_window', ref: 'resolution', from: iso(now), to: iso(now) }]);
            await store.finishRun(runId, { cursor: { value: 'resolution', at: iso(now) }, stats: { fetched: 0, new: 0, changed: 0, linked: 1, proposed: 0, unlinked: 0, costUsd: 0 } });
          } else if (r.plan.settle) {
            const a = r.plan.settle.action;
            const to = a === 'close' ? 'done' : a === 'ask_looks_done' ? 'likely_done' : a === 'reopen' ? 'open' : a === 'wait' ? 'waiting_on_others' : null;
            if (!to) continue;
            const cur = store.getWorkItem(r.itemId)!.state;
            if (to === 'done') doneAt.set(r.itemId, iso(now));
            if (cur === 'done' && to !== 'done') {
              doneAt.delete(r.itemId);
              reopened.set(r.itemId, (reopened.get(r.itemId) ?? 0) + 1);
              reopenedAt.set(r.itemId, iso(now));
            }
            store.setWorkItemState(r.itemId, to, to === 'done' ? { doneBy: 'engine', doneAt: iso(now) } : {});
            version.set(r.itemId, (version.get(r.itemId) ?? 1) + 1);
            track(r.itemId);
          }
        }
      },
    });
    run.calls += out.calls;
    run.checkResults.push(...out.results);
  };

  const scanTimes = [...new Set(c.sources.map((s) => s.seen_at))].sort();
  const seenIds = new Set<string>();
  let watermark: CompletionWatermark | null = null;
  for (const at of scanTimes) {
    now = Date.parse(at);
    run.scans.push(at);
    const batch = c.sources.filter((s) => s.seen_at === at);
    const window = { from: iso(now - MIN), to: iso(now) };
    for (const connector of [...new Set(batch.map((s) => s.source))] as ConnectorId[]) {
      const rows = batch.filter((s) => s.source === connector);
      const { runId } = await store.startRun({ scope: { connector, scope: 'golden' }, trigger: 'schedule', window });
      const ctx = await store.getContext({ connector, scope: 'golden' });
      const state = createRunState({ runId, connector, window, context: ctx });
      const fresh = new Set<string>();
      if (connector === 'slack') {
        const rec = new SlackAutoRecorder(trackFresh(store, fresh), state, ctx);
        for (const s of rows) {
          const queries = inboxQueries(s, c.me.slackId);
          for (const q of queries) await rec.onToolResult(SLACK_TOOL, q.args, { results: renderSlackHit(s, c, s.thread_of ? byId.get(s.thread_of) : undefined) }, `${s.id}:${q.step}`);
          const sid = state.recorded.get(`slack:${s.meta.channelId}:${slackTs(s.occurred_at)}`);
          if (sid) run.sourceIds.set(s.id, sid);
        }
        // SCN-1 / R5: the recall sweep re-reads channel threads I am in (src/scanner/resolution/recall.ts)
        run.threadReads += await followMyThreads(rec, state.recorded, now);
        for (const s of rows) if (!run.sourceIds.has(s.id)) note(s.id, 'no inbox search or thread re-read returns it');
      } else {
        const items = rows.map((s) => normalizeGolden(s, c, byId));
        const recd = await store.recordSourceItems(runId, items);
        rows.forEach((s, i) => run.sourceIds.set(s.id, recd[i]!.sourceItemId));
        recd.forEach((r, i) => {
          state.recorded.set(r.dedupeKey, r.sourceItemId);
          state.items.set(r.dedupeKey, items[i]!);
          if (r.isNew || r.changed) fresh.add(r.sourceItemId);
        });
      }
      if (opts.interpret) {
        await opts.interpret({ store, state, ctx, window, fresh, connector });
        adoptItems(run, c);
      } else for (const s of rows) for (const a of s.agent) await act(runId, s, a);
      await store.reportCoverage(runId, [{ kind: 'query_window', ref: 'golden', from: window.from, to: window.to }]);
      await store.finishRun(runId, { cursor: { value: String(now), at: window.to }, stats: { fetched: rows.length, new: rows.length, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
    }
    reeval();
    now += 2 * MIN;
    if (closer === 'resolution') {
      const fresh = c.sources.filter((s) => run.sourceIds.has(s.id) && !seenIds.has(s.id)).map((s) => run.sourceIds.get(s.id)!);
      for (const s of c.sources) if (run.sourceIds.has(s.id)) seenIds.add(s.id);
      await resolutionPass(fresh);
    } else {
      const pass = await runCompletionPass({ store, model, now: new Date(now), watermark, meName: c.me.name, limits: { settleMs: 0 }, trigger: 'eval' });
      run.passes.push(pass);
      run.calls += pass.calls;
      watermark = pass.watermark;
    }
    reeval();
  }
  run.end = iso(now);
  if (opts.interpret) {
    const owned = new Set(run.itemIds.values());
    for (const w of store.listWorkItems()) if (!owned.has(w.workItemId) && !run.extraItems.includes(w.workItemId)) run.extraItems.push(w.workItemId);
  }
  for (const it of c.items_expected) if (!run.itemIds.has(it.id)) note(it.id, run.why.get(it.origin) ?? 'never proposed');
  return run;
}

/** How an expected item ended. */
export function finalState(run: CaseRun, goldenItemId: string): FinalState {
  const wid = run.itemIds.get(goldenItemId);
  if (!wid) return 'missing';
  const st = run.store.getWorkItem(wid)?.state;
  return st === 'done' ? 'closed' : st === 'likely_done' ? 'likely' : 'open';
}

/** Golden source ids cited by the item's completion evidence. */
export function citedSources(run: CaseRun, goldenItemId: string): string[] {
  const wid = run.itemIds.get(goldenItemId);
  if (!wid) return [];
  const back = new Map([...run.sourceIds.entries()].map(([g, s]) => [s, g]));
  return run.store
    .evidenceFor(wid)
    .filter((e) => e.role === 'completion')
    .map((e) => back.get(e.sourceItemId))
    .filter((x): x is string => !!x);
}

export function wasReopened(run: CaseRun, goldenItemId: string): boolean {
  const wid = run.itemIds.get(goldenItemId);
  const h = wid ? (run.history.get(wid) ?? []) : [];
  const i = h.indexOf('done');
  return i >= 0 && h.slice(i + 1).some((s) => s !== 'done');
}

/** A store whose recordSourceItems also notes the ids recorded new or changed (FTI `fresh`). */
export function trackFresh(store: InMemoryScannerStore, fresh: Set<string>): ScannerStore {
  return new Proxy(store, {
    get(t, p, r) {
      if (p === 'recordSourceItems') {
        return async (runId: string, items: NormalizedSourceItem[]) => {
          const res = await t.recordSourceItems(runId, items);
          for (const x of res) if (x.isNew || x.changed) fresh.add(x.sourceItemId);
          return res;
        };
      }
      const v = Reflect.get(t, p, r) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ScannerStore;
}

/** FTI: an expected item is found when a work item has its origin source as origin evidence (the same rule as the oracle). */
export function adoptItems(run: CaseRun, c: GoldenCase): void {
  for (const it of c.items_expected) {
    if (run.itemIds.has(it.id)) continue;
    const sid = run.sourceIds.get(it.origin);
    if (!sid) continue;
    const w = run.store.listWorkItems().find((x) => ![...run.itemIds.values()].includes(x.workItemId) && run.store.evidenceFor(x.workItemId).some((e) => e.role === 'origin' && e.sourceItemId === sid));
    if (w) run.itemIds.set(it.id, w.workItemId);
  }
}
