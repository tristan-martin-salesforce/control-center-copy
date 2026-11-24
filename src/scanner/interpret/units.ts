/**
 * From a run's recorded items to classifier units (FTI): rules first, then deterministic candidates (≤ 5 per item,
 * COST-5: no open-items pack), conversation context, and the second pass's wider context.
 *
 *   Slack   the triage selection (src/scanner/triage/slack-triage.ts): only messages to me, from me, or in a DM, group
 *           DM or thread I'm in; addressing read over the whole conversation (TRI-2, TRI-3); earlier lines of the same
 *           conversation from the store (TRI-CTX); earlier noise verdicts carried forward (TRI-NOISE). A message that
 *           is not for me but sits in the thread of an open item is linked as context by rule (a thread join).
 *   Gmail   bulk and calendar mail settle by rule; mail I sent goes on only with a cue or a candidate.
 *   Notes   one unit per open next step of mine; none → settled.
 *   Drive   a revision with no candidate deliverable (same file or matching words) has nothing to judge.
 *   Org62   src/scanner/interpret/org62-rules.ts.
 * Every unit and every rule decision is a source item of this run; nothing recorded is dropped without a reason.
 */
import type { CcRunState } from '@/llm/cc-tools';

import { conversationRefs, selectSlackTriage, TRIAGE_CONTEXT, triageConversationKey, type LineAddress, type PriorVerdict, type TriageLine, type TriageSelection } from '../triage/slack-triage';
import { tokenize } from '../store-memory';
import { DEFAULT_SCANNING_PREFS, type NormalizedSourceItem, type ScanContext, type ScannerStore, type TimeWindow } from '../types';
import type { Action } from './apply';
import { planOrg62 } from './org62-rules';
import { mailRule, messageRule, myOpenSteps } from './rules';
import type { ContextLine, InterpretItem, ItemCandidate, RuleDecision } from './types';

/** Connectors whose items this module interprets (the rest stay on their agentic skill). */
export const FTI_INTERPRETED = new Set(['slack', 'gmail', 'gemini_notes', 'drive', 'org62']);

export interface UnitsResult {
  units: InterpretItem[];
  decided: RuleDecision[];
  /** Writes rules decided (thread joins, Org62 rules). */
  actions: Action[];
}

const SELECT_ALL = { batchSize: 100_000, maxBatches: 100_000 };
/** The store's own floor: anything it ranks is a hint; the model decides whether it is the same deliverable. */
const MIN_CANDIDATE_SCORE = 0.15;

function addrText(a: LineAddress | undefined, mine: boolean, toMe: boolean): string {
  if (mine) return a?.to === 'others' ? ` → ${a.names.slice(0, 3).join(', ')}` : '';
  if (!a) return toMe ? ' → me' : '';
  switch (a.to) {
    case 'me':
      return a.via === 'continues' ? ' → me (replies to my message)' : ' → me';
    case 'others':
      return ` → ${a.names.slice(0, 3).join(', ')} (not me${a.via === 'continues' ? ': continues their exchange' : ''})`;
    case 'channel':
      return ' → everyone (@channel/@here)';
    case 'list':
      return ` → me and ${a.others} others (a list)`;
  }
}

const authorOf = (it: NormalizedSourceItem) => (it.author?.isMe ? 'me' : it.author?.name || it.author?.externalId || 'someone');
const lineOf = (l: TriageLine): ContextLine => ({ at: l.item.occurredAt, author: authorOf(l.item), text: l.item.excerpt ?? '', to: addrText(l.addr, !!l.item.author?.isMe, !!(l.item.payload as { toMe?: boolean } | undefined)?.toMe), ...(l.earlier ? { earlier: true } : {}) });

/** The people an item is with (its author, or my counterparts when it is mine), names and ids, for the candidate join. */
function peopleOf(it: NormalizedSourceItem): string[] {
  const xs = it.author?.isMe ? (it.participants ?? []).filter((p) => !p.isMe) : [it.author, ...(it.participants ?? []).filter((p) => !p.isMe)];
  return [...new Set(xs.flatMap((p) => [p?.name, p?.externalId, p?.email]).filter((s): s is string => !!s))].slice(0, 8);
}

/**
 * ≤ 5 candidate homes (the store's ranked join), aliased w1…w5. Two asks, merged by best score, the way R5 tells an
 * agent to ask: (1) thread, file, people and account with the distinctive words (the subject or title, then the body's
 * longer words: the store's keyword score falls as a query grows, so a long query hides a real match), (2) the body's
 * distinctive words in chunks of four (≤ 4 chunks), and (3) the subject or title alone (an email reply's subject names
 * the deliverable). Joins are local store reads, no model.
 */
export async function candidatesFor(store: ScannerStore, it: NormalizedSourceItem, extraText = ''): Promise<ItemCandidate[]> {
  const files = [...new Set((it.fileRefs ?? []).flatMap((f) => (f.startsWith('drive:') ? [f, f.slice(6)] : /^[A-Za-z0-9_-]{15,}$/.test(f) ? [f, `drive:${f}`] : [f])))].slice(0, 10);
  const subject = tokenize(it.title ?? '');
  const body = tokenize(`${extraText} ${it.excerpt ?? ''}`).filter((w) => w.length >= 5);
  const best = new Map<string, Awaited<ReturnType<ScannerStore['findCandidates']>>[number]>();
  const ask = async (q: Parameters<ScannerStore['findCandidates']>[0]) => {
    try {
      for (const c of await store.findCandidates(q)) if (c.workItemId && (!best.has(c.workItemId) || best.get(c.workItemId)!.score < c.score)) best.set(c.workItemId, c);
    } catch {
      /* a failed join only costs the candidates */
    }
  };
  await ask({ ...(it.threadRef ? { threadRefs: [it.threadRef] } : {}), ...(files.length ? { fileRefs: files } : {}), people: peopleOf(it), accounts: (it.accountHints ?? []).slice(0, 5), text: [...new Set([...subject, ...body])].slice(0, 8).join(' '), limit: 5 });
  // R5 step 2's "5–12 distinctive words", asked the way the store scores best: a few short chunks, not one long query
  const words = [...new Set(body)].slice(0, 16);
  for (let i = 0; i < words.length; i += 4) await ask({ text: words.slice(i, i + 4).join(' '), limit: 5 });
  if (subject.length >= 2) await ask({ text: subject.slice(0, 6).join(' '), limit: 5 });
  return [...best.values()]
    .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score || a.workItemId!.localeCompare(b.workItemId!))
    .slice(0, 5)
    .map((c, i) => ({ alias: `w${i + 1}`, workItemId: c.workItemId!, title: c.title, why: c.why, score: c.score, ...(c.state ? { state: c.state } : {}), ...(c.resolution ? { resolution: c.resolution } : {}), ...(c.involvement ? { involvement: c.involvement } : {}) }));
}

/** The triage selection with earlier verdicts carried forward and earlier conversation lines added (skill-runner's selectWithContext). */
async function selectSlack(store: ScannerStore, state: CcRunState, ctx: ScanContext, prior: Map<string, PriorVerdict> | undefined): Promise<TriageSelection> {
  const first = selectSlackTriage(state.items, state.recorded, state.outcomes, ctx, SELECT_ALL, { ...(prior ? { prior } : {}) });
  if (!store.conversationLines || !first.batches.length) return first;
  const extra = new Map<string, TriageLine[]>();
  for (const c of conversationRefs(first)) {
    try {
      const rows = await store.conversationLines({ channelId: c.channelId, threadRef: c.threadRef, before: { at: c.firstAt, limit: TRIAGE_CONTEXT.before }, after: { at: c.lastAt, limit: TRIAGE_CONTEXT.after } });
      const lines = rows.filter((r) => triageConversationKey(r.item) === c.key).map((r): TriageLine => ({ ref: r.item.externalId, sourceItemId: r.sourceItemId, item: r.item, needs: false, earlier: true }));
      if (lines.length) extra.set(c.key, lines);
    } catch {
      /* context is best effort */
    }
  }
  return extra.size ? selectSlackTriage(state.items, state.recorded, state.outcomes, ctx, SELECT_ALL, { ...(prior ? { prior } : {}), extra }) : first;
}

export interface BuildUnitsInput {
  store: ScannerStore;
  state: CcRunState;
  ctx: ScanContext;
  window: TimeWindow;
  /** Source item ids recorded new or changed in this run. */
  fresh: ReadonlySet<string>;
}

export async function buildUnits(i: BuildUnitsInput): Promise<UnitsResult> {
  const { store, state, ctx } = i;
  const out: UnitsResult = { units: [], decided: [], actions: [] };
  const idOf = (key: string) => state.recorded.get(key);
  const all = [...state.items.entries()].flatMap(([k, it]) => (idOf(k) ? [{ sid: idOf(k)!, it }] : []));
  let prior: Map<string, PriorVerdict> | undefined;
  try {
    prior = all.length && store.triageVerdicts ? await store.triageVerdicts(all.map((x) => x.sid)) : undefined;
  } catch {
    prior = undefined;
  }
  const seenDecided = (sid: string) => !i.fresh.has(sid) && !!prior?.get(sid);
  const decide = (sourceItemId: string, reason: RuleDecision['reason']) => out.decided.push({ sourceItemId, reason });

  // ---- Slack
  const slack = all.filter((x) => x.it.connector === 'slack' && x.it.kind === 'message');
  if (slack.length) {
    const sel = await selectSlack(store, state, ctx, prior);
    for (const sid of sel.decisions?.trivial ?? []) decide(sid, 'trivial');
    for (const sid of sel.decisions?.handled ?? []) decide(sid, 'seen_decided');
    const openThreads = new Map<string, string>();
    for (const o of ctx.openItems) for (const t of o.threadRefs) if (!openThreads.has(t)) openThreads.set(t, o.workItemId);
    const bySid = new Map(slack.map((x) => [x.sid, x.it]));
    for (const sid of sel.decisions?.skipped ?? []) {
      const it = bySid.get(sid);
      const home = it?.threadRef ? openThreads.get(it.threadRef) : undefined;
      if (it && home && i.fresh.has(sid) && !messageRule(it, { hasCandidate: true })) {
        out.actions.push({ tool: 'cc_link_evidence', args: { workItemId: home, sourceItemId: sid, role: 'context', confidence: 'likely', reason: 'same thread as the item (not addressed to me)' } });
        decide(sid, 'thread_join');
      } else decide(sid, 'not_addressed');
    }
    for (const b of sel.batches) {
      for (const conv of b.conversations) {
        conv.lines.forEach((l, idx) => {
          if (!l.needs) return;
          if (seenDecided(l.sourceItemId)) return decide(l.sourceItemId, 'seen_decided');
          const before = conv.lines.slice(0, idx).map(lineOf);
          const after = conv.lines.slice(idx + 1).map(lineOf);
          out.units.push({ ref: l.ref, sourceItemId: l.sourceItemId, item: l.item, connector: 'slack', to: addrText(l.addr, !!l.item.author?.isMe, !!(l.item.payload as { toMe?: boolean } | undefined)?.toMe), context: [...before.slice(-4), ...after.slice(0, 3)], candidates: [], group: conv.key, fresh: i.fresh.has(l.sourceItemId) });
        });
      }
    }
  }

  // ---- everything else, one by one
  const org62: InterpretItem[] = [];
  for (const { sid, it } of all) {
    if (it.connector === 'slack') continue;
    if (seenDecided(sid)) {
      decide(sid, 'seen_decided');
      continue;
    }
    const base = { sourceItemId: sid, item: it, connector: it.connector, context: [] as ContextLine[], candidates: [] as ItemCandidate[], group: it.threadRef ?? it.externalId, fresh: i.fresh.has(sid) };
    if (it.connector === 'gemini_notes') {
      const steps = myOpenSteps(it);
      if (!steps.length) decide(sid, 'no_my_steps');
      for (const s of steps) out.units.push({ ...base, ref: `${it.externalId}#${s.index}`, step: s, group: it.externalId });
      continue;
    }
    if (it.connector === 'gmail') out.units.push({ ...base, ref: it.externalId, to: (it.payload as { toMe?: boolean } | undefined)?.toMe ? ' → me' : '' });
    else if (it.connector === 'drive') out.units.push({ ...base, ref: it.externalId });
    else if (it.connector === 'org62') org62.push({ ...base, ref: it.externalId });
  }

  // ---- candidates (one ranked store join per unit), then the rules that need them
  for (const x of [...out.units, ...org62]) x.candidates = await candidatesFor(store, x.item, x.step ? `${x.step.title} ${x.step.description ?? ''}` : '');
  out.units = out.units.filter((x) => {
    const rule = x.connector === 'gmail' ? mailRule(x.item, { hasCandidate: x.candidates.length > 0 }) : x.connector === 'slack' ? messageRule(x.item, { hasCandidate: x.candidates.length > 0 }) : x.connector === 'drive' && !x.candidates.length ? ('no_deliverable' as const) : null;
    if (rule) decide(x.sourceItemId, rule);
    return !rule;
  });
  if (org62.length) {
    const plan = planOrg62(org62, { window: i.window, persona: ctx.persona, prefs: ctx.scanning ?? DEFAULT_SCANNING_PREFS, dcsOn: !ctx.persona || ctx.persona.features.dealContributions });
    out.actions.push(...plan.actions);
    out.units.push(...plan.units);
    for (const sid of plan.decided) decide(sid, 'org62_rule');
  }
  return out;
}

/** The second pass's context: the conversation around a Slack unit from the store (more lines, any run). */
export function widener(store: ScannerStore): (units: InterpretItem[]) => Promise<InterpretItem[]> {
  return async (units) => {
    const out: InterpretItem[] = [];
    for (const x of units) {
      if (x.connector !== 'slack' || !store.conversationLines) {
        out.push(x);
        continue;
      }
      const key = triageConversationKey(x.item);
      const channelId = key.startsWith('dm:') ? key.slice(3) : undefined;
      try {
        const rows = await store.conversationLines({ ...(channelId ? { channelId } : { threadRef: x.item.threadRef }), before: { at: x.item.occurredAt, limit: 12 }, after: { at: x.item.occurredAt, limit: 6 } });
        const have = new Set(x.context.map((c) => `${c.at}|${c.text}`));
        const more = rows.map((r) => ({ at: r.item.occurredAt, author: authorOf(r.item), text: r.item.excerpt ?? '', earlier: true })).filter((c) => !have.has(`${c.at}|${c.text}`));
        out.push({ ...x, context: [...x.context, ...more].sort((a, b) => a.at.localeCompare(b.at)) });
      } catch {
        out.push(x);
      }
    }
    return out;
  };
}
