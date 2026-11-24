/**
 * A resolution check in plain words (*north star: Legible*): what decided, what it said, what happened, and what
 * kept it from closing. Used by "Why is this still open?" and `npm run scan:explain -- --item <id>`. Pure.
 */
import { AUTO_CLOSE_BLOCK_TEXT, REOPEN_BRAKE_TEXT } from '@/engines/closure/correction';

const RULE_TEXT: Record<string, string> = {
  D1: 'your reply after the ask carries what was asked',
  D2: 'your substantive answer to the question, no chase since',
  D3: 'the read-back shows the record fixed',
  D4: 'the linked Claude session finished with a PR or link',
  D5: 'the asker acknowledged your last reply',
  D6: 'nothing new since the last check',
};

const VERDICT_TEXT: Record<string, string> = {
  done: 'done',
  partial: 'partly done',
  not_done: 'still yours',
  not_mine: 'not yours',
  not_needed: 'no longer needed',
  duplicate: 'a duplicate',
  waiting_on_them: 'waiting on them',
  gone_quiet: 'gone quiet',
  done_by_other: 'done by someone else',
};

const OUTCOME_TEXT: Record<string, string> = {
  closed: 'closed it for you',
  likely: 'marked it Likely done (one confirm)',
  asked: 'asks you about it',
  left: 'left it open',
  reopened: 'reopened it',
};

const SHADOW_TEXT: Record<string, string> = {
  closed: 'would have closed it for you',
  likely: 'would have marked it Likely done',
  asked: 'would have asked you',
  left: 'would have left it open',
  reopened: 'would have reopened it',
};

const BLOCK_TEXT: Record<string, string> = {
  ...AUTO_CLOSE_BLOCK_TEXT,
  ...REOPEN_BRAKE_TEXT,
  user_corrected: 'you corrected it before',
  file_edit_alone: 'a file edit alone never closes it',
  below_threshold: 'it was not sure enough',
  upcoming_meeting: 'a matching meeting is still ahead',
  open_loop: 'the asker wrote last',
  check_failed: 'the check failed; it tries again on the next trigger',
};

export const TRIGGER_TEXT: Record<string, string> = {
  conversation_line: 'a new line in its conversation',
  drive_revision: 'a revision of its file',
  drive_share: 'a share of its file',
  notes: 'meeting notes naming it',
  session: 'a Claude session about it',
  quiet: 'the asker went quiet past its window',
  sweep: 'the nightly sweep',
  evidence: 'new evidence linked to it',
  manual: 'a manual check',
};

export function blockedText(b: string | null | undefined): string | null {
  if (!b) return null;
  return BLOCK_TEXT[b] ?? (b.startsWith('gated:') ? null : b);
}

export interface CheckLike {
  decidedBy: string;
  ruleHit: string | null;
  verdict: string | null;
  confidence: number | null;
  outcome: string;
  blockedBy: string | null;
  mode: string;
  escalated?: boolean;
  trigger?: string;
}

/** One line: "The cheap model said still yours (30%); left it open." */
export function checkWhy(c: CheckLike): string {
  const pct = c.confidence == null ? '' : ` (${Math.round(c.confidence * 100)}%)`;
  const who =
    c.decidedBy === 'rule'
      ? `Rule ${c.ruleHit}: ${RULE_TEXT[c.ruleHit ?? ''] ?? 'a rule decided'}`
      : c.decidedBy === 'skip'
        ? 'Nothing new since the last check'
        : c.decidedBy === 'failed'
          ? 'The check failed'
          : `${c.decidedBy === 'escalation' ? 'The stronger model' : 'The cheap model'} said ${VERDICT_TEXT[c.verdict ?? ''] ?? c.verdict ?? 'nothing'}${pct}`;
  const did = c.mode === 'shadow' ? SHADOW_TEXT[c.outcome] : OUTCOME_TEXT[c.outcome];
  const block = blockedText(c.blockedBy);
  return `${who}; ${did ?? c.outcome}${block ? `: not closed because ${block}` : ''}.`;
}

/** scan:report --yield: "resolution checks: 212, $0.0004/check, by rules 61, closed 40, likely 22, asked 9, reopened 2". */
export function resolutionYieldLine(y: { checks: number; byRules: number; costUsd: number; perCheckUsd: number; closed: number; likely: number; asked: number; reopened: number; escalated: number }): string {
  return `  resolution checks: ${y.checks}, $${y.perCheckUsd.toFixed(4)}/check ($${y.costUsd.toFixed(4)} in all), by rules ${y.byRules}, escalated ${y.escalated} · closed ${y.closed}, likely ${y.likely}, asked ${y.asked}, reopened ${y.reopened}`;
}

export interface ExplainPackLine {
  id: string;
  kind: string;
  at: string | null;
  by: string;
  where?: string;
  tag?: string;
  sourceItemId?: string;
  url?: string;
}

/**
 * `scan:explain --item`: the pack (which lines, by whom, where, never their text) and the decisions, in plain words.
 * `checks` newest first.
 */
export function renderItemExplain(x: {
  item: { id: string; kind: string; status: string; title: string };
  dbName?: string;
  mode: string;
  pack: { tokens: number; digest: string; trimmed: number; lines: ExplainPackLine[]; hints: Record<string, unknown>; rulesFired: string[] } | null;
  checks: Array<CheckLike & { at: string; trigger: string; packDigest: string; costUsd: number; citeAlias: string | null }>;
  next: string;
}): string[] {
  const out: string[] = [`explain item ${x.item.id}${x.dbName ? ` · ${x.dbName}` : ''}`, `  ${x.item.kind} · ${x.item.status} · resolution check ${x.mode}`];
  if (x.pack) {
    const changed = x.checks[0] && x.checks[0].packDigest !== x.pack.digest;
    out.push(`  pack now: ${x.pack.lines.length} lines, ~${x.pack.tokens} tokens${x.pack.trimmed ? `, ${x.pack.trimmed} trimmed to fit` : ''} · digest ${x.pack.digest}${x.checks[0] ? (changed ? ' (changed since the last check)' : ' (same as the last check)') : ''}`);
    for (const l of x.pack.lines) out.push(`    ${l.id.padEnd(4)} ${(l.at ?? '').slice(0, 16).replace('T', ' ').padEnd(16)} ${l.kind.padEnd(9)} ${l.by}${l.where ? ` · ${l.where}` : ''}${l.tag ? ` · ${l.tag}` : ''}${l.sourceItemId ? ` · si ${l.sourceItemId}` : ''}`);
    const h = x.pack.hints;
    out.push(`  hints: my first reply ${h.myReplyAfterAskMin == null ? 'none' : `${h.myReplyAfterAskMin} min after the ask`} · link or file ${h.replyHasLinkOrFile ? 'yes' : 'no'} · asker acked ${h.askerAckAfterMine ? 'yes' : 'no'} · asker chased ${h.askerChasedAfterMine ? 'yes' : 'no'} · last writer ${String(h.lastWriter ?? 'nobody')}`);
    out.push(`  rules that fire now: ${x.pack.rulesFired.length ? x.pack.rulesFired.join(', ') : 'none (a model decides)'}`);
  } else out.push('  pack: the item could not be loaded (gone, merged, or not yours)');
  if (!x.checks.length) out.push('  checks: none yet');
  else {
    out.push('  checks (newest first):');
    for (const c of x.checks) out.push(`    ${c.at.slice(0, 16).replace('T', ' ')} ${c.mode} · ${TRIGGER_TEXT[c.trigger] ?? c.trigger} · ${checkWhy(c)}${c.citeAlias ? ` Cited ${c.citeAlias}.` : ''}${c.costUsd ? ` $${c.costUsd.toFixed(5)}.` : ''}`);
  }
  out.push(`  next: ${x.next}`);
  return out;
}

/** What would run the next check, for an item in this status. */
export function nextCheckText(status: string, mode: string, lastCheckAt: string | null, now: Date): string {
  if (mode === 'legacy') return 'The resolution check is off (Settings ▸ Closing); the completion check and Settle decide.';
  if (status === 'done') return 'Closed. Only the asker writing to you again, or a line naming it, checks it again (within 14 days).';
  const days = lastCheckAt ? Math.max(0, 7 - Math.floor((now.getTime() - Date.parse(lastCheckAt)) / 86_400_000)) : 0;
  return `A new line in its conversation, a revision or share of its file, notes or a Claude session about it, or the nightly sweep${days ? ` (in ${days} day${days === 1 ? '' : 's'} at the latest)` : ' (tonight)'}.`;
}
