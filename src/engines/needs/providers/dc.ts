/**
 * dc_suggestion: one row per Deal Contribution the attribution engine suggests (GET /attribution/dc-suggestions,
 * state new), with Activity ▸ Needs you's verbs (src/components/time/DcSuggestions.tsx): Accept (drafts a DC request on
 * your next logging canvas; nothing goes to Org62 until you Apply it), Edit (the split, on Activity) and Reject. One
 * whose split another architect holds asks for the split first, so its primary verb is Edit. A persona without DCs
 * (an AE, D-55) gets none.
 */
import type { DcSuggestion, NeedRow } from '@/contract';
import { callVerb, isSnoozed, needRow, sinceOf, verb } from '../row';
import type { NeedProvider, NeedsContext } from '../types';
import { KIND_URGENCY } from '../urgency';

const HREF = '/activity?view=needs';
const money = (n: number | null) => (n === null ? null : n >= 1_000_000 ? `$${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);

function rowOf(s: DcSuggestion, ctx: NeedsContext): NeedRow {
  const p = { id: s.id };
  const split = s.splitPercent;
  const accept = callVerb({ id: 'accept', label: split ? `Claim ${split}%` : 'Claim', kbd: 'a', primary: split !== null, route: 'decideDcSuggestion', params: p, body: { decision: 'accept' }, undoable: true, feature: 'dealContributions' });
  const edit = verb({ id: 'edit', label: split ? 'Edit split' : 'Agree the split', kbd: 'e', primary: split === null, href: HREF, feature: 'dealContributions' });
  const reject = callVerb({ id: 'reject', label: 'Reject', kbd: 'x', route: 'decideDcSuggestion', params: p, body: { decision: 'reject' }, undoable: true, feature: 'dealContributions' });
  const ev = s.evidence.find((e) => !!e.url);
  return needRow({
    kind: 'dc_suggestion',
    sourceId: s.id,
    title: `Claim a DC on ${s.oppName}`,
    why: [s.reasons[0]?.text ?? null, money(s.amount), s.groupSize > 1 ? `${s.sharePercent}% of the work` : null, split === null ? 'another architect holds a DC: agree the split' : null].filter(Boolean).join(' · '),
    account: s.accountId || s.accountName ? { id: s.accountId, label: s.accountName ?? s.oppName, href: s.accountId ? `/deals/${s.accountId}` : null } : null,
    opp: { id: s.oppId, label: s.oppName, href: null },
    verbs: split === null ? [edit, reject] : [accept, edit, reject],
    groupKey: 'deal',
    urgency: KIND_URGENCY.dc_suggestion,
    since: sinceOf([...s.evidence.map((e) => e.at)], ctx.nowMs),
    source: ev?.url ? { label: ev.label, url: ev.url } : null,
    estimateMin: 1,
    confidence: s.preTicked ? 'sure' : 'likely',
    subject: `opp:${s.oppId}`,
  });
}

export const dcSuggestionProvider: NeedProvider = {
  kind: 'dc_suggestion',
  feature: 'dealContributions',
  run(ctx) {
    const d = ctx.dc;
    if (!d?.enabled) return [];
    return d.suggestions.filter((s) => s.state === 'new' && !isSnoozed(ctx, 'dc_suggestion', s.id)).map((s) => rowOf(s, ctx));
  },
};
