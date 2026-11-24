/**
 * vdp_change: one row per VDP that needs you, and per account or opp not in VDP yet (GET /deals/vdp: status `open`;
 * the same set `vdpNeedYouCount` counts for the Activity badge). Review opens Activity ▸ VDP ▸ Changes, where the
 * push and its confirm live: nothing is applied from the queue (*tenet: Nothing leaves without approval*, D-60).
 */
import type { NeedRow, VdpCoverageRow, VdpNotInVdpRow } from '@/contract';
import { isSnoozed, laterVerb, needRow, sinceOf, verb } from '../row';
import type { NeedProvider, NeedsContext } from '../types';
import { KIND_URGENCY } from '../urgency';

const HREF = '/activity?view=vdp';
const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

function vdpRow(v: VdpCoverageRow, ctx: NeedsContext): NeedRow {
  const first = v.steps.find((s) => s.state !== 'waiting') ?? v.steps[0];
  const sourceId = `vdp:${v.vdpSlug}`;
  return needRow({
    kind: 'vdp_change',
    sourceId,
    title: `Update the ${v.companyName} VDP`,
    why: [`${items(v.status.open)} open`, v.status.appCanFix ? `${v.status.appCanFix} the app can push` : null, first?.title ?? null].filter(Boolean).join(' · '),
    account: v.accountId ? { id: v.accountId, label: v.companyName, href: `/deals/${v.accountId}` } : null,
    opp: v.opportunityId ? { id: v.opportunityId, label: v.opportunityName ?? v.companyName, href: null } : null,
    verbs: [verb({ id: 'review', label: 'Review', kbd: 'a', primary: true, href: HREF, feature: 'vdp' }), laterVerb('vdp_change', sourceId, `VDP: ${v.companyName}`, ctx, 'vdp')],
    groupKey: 'admin',
    urgency: KIND_URGENCY.vdp_change,
    since: sinceOf([v.lastActivityAt], ctx.nowMs),
    source: v.url ? { label: 'Open in VDP', url: v.url } : null,
    estimateMin: Math.max(1, v.status.open * 2),
  });
}

function notInVdpRow(r: VdpNotInVdpRow, ctx: NeedsContext): NeedRow {
  const sourceId = `new:${r.key}`;
  return needRow({
    kind: 'vdp_change',
    sourceId,
    title: r.title,
    why: [r.step.title, r.children.length ? `then ${items(r.children.length)}` : null].filter(Boolean).join(' · '),
    account: r.accountId ? { id: r.accountId, label: r.title, href: `/deals/${r.accountId}` } : null,
    verbs: [verb({ id: 'review', label: 'Review', kbd: 'a', primary: true, href: HREF, feature: 'vdp' }), laterVerb('vdp_change', sourceId, `VDP: ${r.title}`, ctx, 'vdp')],
    groupKey: 'admin',
    urgency: KIND_URGENCY.vdp_change,
    since: sinceOf([], ctx.nowMs),
    estimateMin: 2 + r.children.length,
  });
}

export const vdpChangeProvider: NeedProvider = {
  kind: 'vdp_change',
  feature: 'vdp',
  run(ctx) {
    const c = ctx.vdp;
    if (!c) return [];
    return [
      ...c.vdps.filter((v) => v.status.state === 'open' && !isSnoozed(ctx, 'vdp_change', `vdp:${v.vdpSlug}`)).map((v) => vdpRow(v, ctx)),
      ...c.notInVdp.filter((r) => r.status.state === 'open' && !isSnoozed(ctx, 'vdp_change', `new:${r.key}`)).map((r) => notInVdpRow(r, ctx)),
    ];
  },
};
