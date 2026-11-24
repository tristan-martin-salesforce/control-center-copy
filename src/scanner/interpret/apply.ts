/**
 * Apply verdicts through the cc tool handlers (src/llm/cc-tools): the same zod validation, redaction, Settings ▸
 * Scanning gates (NOT-MINE, TRI-3, catch-ups), R-UI-22 coercion and store writes as an agent's tool calls, so an FTI
 * proposal is indistinguishable from an agentic one (kind, title, purpose, due, account/opp, evidence role, reason
 * prefix, confidence word). Pure mapping first (`actionsFor`), then `runActions` writes.
 *
 * Reasons carry only the prefixes the closure engine reads (`requirements_change:`, `drive_judge:`, `loop_back:`);
 * everything else is a plain line (src/engines/closure/signals.ts).
 */
import { callCcTool, type CcHandlers, type CcInput, type CcRunState } from '@/llm/cc-tools';

import { isContextOnly, LOOP_BACK_PREFIX } from '../types';
import { confidenceWord, type Verdict } from './schema';
import type { InterpretItem, ItemCandidate } from './types';

export type Action =
  | { tool: 'cc_propose_item'; args: CcInput<'cc_propose_item'> }
  | { tool: 'cc_link_evidence'; args: CcInput<'cc_link_evidence'> }
  | { tool: 'cc_flag_unlinked'; args: CcInput<'cc_flag_unlinked'> };

const ORG62_ACCOUNT = /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const ORG62_OPP = /^006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** The item's account: a hint that is a known account id (channel map, Org62 id), else none. */
export function accountOf(x: InterpretItem, knownAccounts: ReadonlySet<string>): string | undefined {
  return (x.item.accountHints ?? []).find((h) => knownAccounts.has(h) || ORG62_ACCOUNT.test(h));
}

const quote = (s: string | null | undefined) => (s ? `"${s.replace(/"/g, "'")}"` : '');
const directToMe = (x: InterpretItem) => !!x.to?.startsWith(' → me') || (x.item.payload as { toMe?: boolean } | undefined)?.toMe === true;

function candidateOf(x: InterpretItem, v: Verdict): ItemCandidate | undefined {
  return v.link ? x.candidates.find((c) => c.alias === v.link) : undefined;
}

/** The writes one verdict makes (empty: record only). */
export function actionsFor(x: InterpretItem, v: Verdict, o: { knownAccounts: ReadonlySet<string> }): Action[] {
  const sid = x.sourceItemId;
  const cand = candidateOf(x, v);
  const word = confidenceWord(v.conf);
  const said = (v.why || v.cite || '').trim();
  const why = (said.length >= 3 ? said : `${v.v} verdict`).slice(0, 200);
  const drive = x.connector === 'drive';
  const link = (role: CcInput<'cc_link_evidence'>['role'], reason: string, confidence = word): Action[] =>
    cand ? [{ tool: 'cc_link_evidence', args: { workItemId: cand.workItemId, sourceItemId: sid, role, confidence, reason: reason.slice(0, 400) } }] : [];
  switch (v.v) {
    case 'ask':
    case 'commitment': {
      if (cand) {
        // R-UI-22: a direct ask of me on a handed-off item loops me back in; anything else on it is context only
        if (isContextOnly(cand)) return directToMe(x) && v.v === 'ask' ? link('origin', `${LOOP_BACK_PREFIX} ${why}`) : link('context', why);
        // R5 step 4: the same deliverable for the same person is linked, not proposed again
        return link('origin', why);
      }
      if (!v.title) return [{ tool: 'cc_flag_unlinked', args: { sourceItemId: sid, reason: `unsure: ${v.v} without a title (${why})`.slice(0, 400) } }];
      const kind = v.kind ?? (x.step ? 'follow_up' : v.v);
      const account = accountOf(x, o.knownAccounts);
      const opp = (x.item.oppHints ?? []).find((h) => ORG62_OPP.test(h));
      const purpose = v.v === 'ask' ? `${v.who ?? x.item.author?.name ?? 'Someone'} asked: ${quote(v.cite) || why}` : `Promised${v.who ? ` to ${v.who}` : ''}: ${quote(v.cite) || why}`;
      const drives = (x.item.fileRefs ?? []).map((f) => f.replace(/^drive:/, '')).filter((f) => /^[A-Za-z0-9_-]{15,}$/.test(f));
      return [
        {
          tool: 'cc_propose_item',
          args: {
            kind,
            title: v.title,
            purpose: purpose.slice(0, 300),
            ...(v.due ? { due: v.due } : {}),
            ...(account ? { accountId: account } : {}),
            ...(opp ? { oppId: opp } : {}),
            ...(kind === 'deliverable' ? { expected: { ...(drives[0] ? { fileId: drives[0] } : {}), changes: [v.title] } } : {}),
            evidence: [{ sourceItemId: sid, role: 'origin', reason: why }],
            confidence: word,
          } as CcInput<'cc_propose_item'>,
        },
      ];
    }
    case 'completion':
      // R5 "Done items": a completion-like message on a done item is context
      if (cand?.state === 'done') return link('context', why);
      // Drive alone never closes (`likely` at most); its reason is the drive judge's, which the closure engine reads
      if (drive) return link('completion', `drive_judge: verdict=done; confidence=${v.conf.toFixed(2)}; ${why}`, word === 'sure' ? 'likely' : word);
      return link('completion', why);
    case 'progress':
      if (cand?.state === 'done') return link('context', why);
      if (drive) return link('progress', `drive_judge: verdict=partial; confidence=${v.conf.toFixed(2)}; ${why}`, word === 'sure' ? 'likely' : word);
      return link('progress', why);
    case 'change':
      return cand?.state === 'done' ? link('contradiction', `requirements_change: ${why}`) : link('context', `requirements_update: ${why}`);
    case 'fyi':
      return link('context', why);
    case 'noise':
      return [];
  }
}

/** A unit still unsure after the second pass: flagged for Triage with one self-contained line (never dropped). */
export function unsureAction(x: InterpretItem, why: string): Action {
  const who = x.item.author?.isMe ? 'my message' : `from ${x.item.author?.name ?? 'someone'}`;
  return { tool: 'cc_flag_unlinked', args: { sourceItemId: x.sourceItemId, reason: `unsure: ${x.connector} ${who}: ${why}`.slice(0, 400), hints: [...(x.item.accountHints ?? []), ...(x.item.threadRef ? [x.item.threadRef] : [])].map((h) => h.slice(0, 160)).slice(0, 10) } };
}

/**
 * Write the actions through the handlers. Returns how many failed validation or the store (codes, no bodies), and the
 * work item a proposal landed on (a later verdict of the same batch may link to it).
 */
export async function runActions(handlers: CcHandlers, state: CcRunState, actions: Action[]): Promise<{ ok: number; failed: number; skipped: number; proposed?: string }> {
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let proposed: string | undefined;
  for (const a of actions) {
    const r = await callCcTool(handlers, state, a.tool, a.args);
    if (r.isError) failed += 1;
    else if (/"skipped"/.test(r.text)) skipped += 1;
    else {
      ok += 1;
      if (a.tool === 'cc_propose_item') {
        const w = (JSON.parse(r.text) as { w?: unknown }).w;
        if (typeof w === 'string') proposed = w;
      }
    }
  }
  return { ok, failed, skipped, ...(proposed ? { proposed } : {}) };
}
