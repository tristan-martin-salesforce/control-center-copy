/**
 * setup_step: what this Mac needs from you before the list can be right.
 *  - One row per Health ▸ Setup dependency in a state you act on (missing, needs setup, signed out, expired: the
 *    same set as the sidebar's health badge). Offline and "can't tell yet" are the app's to retry, never a need.
 *    The verb is "How to fix" on its Setup row: one diagnosis, one wording (the catalog), and re-auth stays there.
 *  - One row per Getting started step still to do (connect sources, pick a role, approve a draft, log a week), until
 *    the checklist is dismissed. "Connect your sources" is left out while a Setup row already says what to connect.
 */
import type { ChecklistItem, DependencyState, NeedRow, SetupDependency } from '@/contract';
import { isSnoozed, laterVerb, needRow, sinceOf, verb } from '../row';
import type { NeedProvider, NeedsContext } from '../types';
import { KIND_URGENCY } from '../urgency';

const ACT: ReadonlySet<DependencyState> = new Set(['missing', 'installed', 'signed_out', 'expired']);
const STATE_WORD: Partial<Record<DependencyState, string>> = { missing: 'not installed', installed: 'needs setup', signed_out: 'signed out', expired: 'expired' };
/** The Getting started steps that are a need (the tours and feedback are not). */
const GUIDE_STEPS = new Set(['sources', 'persona', 'draft', 'batch']);

function depRow(d: SetupDependency, ctx: NeedsContext): NeedRow {
  const sourceId = `dep:${d.id}`;
  return needRow({
    kind: 'setup_step',
    sourceId,
    title: `${d.label}: ${STATE_WORD[d.state] ?? d.state}`,
    why: d.nextStep ?? d.why,
    verbs: [verb({ id: 'open', label: 'How to fix', kbd: 'a', primary: true, href: `/health?tab=setup#setup-${d.id}` }), laterVerb('setup_step', sourceId, d.label, ctx)],
    groupKey: 'admin',
    urgency: KIND_URGENCY.setup_step,
    since: sinceOf([d.lastChecked], ctx.nowMs),
    estimateMin: 2,
  });
}

function guideRow(i: ChecklistItem, ctx: NeedsContext): NeedRow {
  const sourceId = `guide:${i.id}`;
  return needRow({
    kind: 'setup_step',
    sourceId,
    title: i.title,
    why: i.detail,
    verbs: [verb({ id: 'open', label: 'Open', kbd: 'a', primary: true, href: i.href ?? '/getting-started' }), laterVerb('setup_step', sourceId, i.title, ctx)],
    groupKey: 'admin',
    urgency: 0.35,
    since: sinceOf([], ctx.nowMs),
    estimateMin: 5,
  });
}

export const setupStepProvider: NeedProvider = {
  kind: 'setup_step',
  run(ctx) {
    const deps = (ctx.health?.setup?.dependencies ?? []).filter((d) => ACT.has(d.state) && !isSnoozed(ctx, 'setup_step', `dep:${d.id}`));
    const guide = ctx.guide && !ctx.guide.dismissed ? ctx.guide.items.filter((i) => i.kind === 'action' && i.state === 'todo' && GUIDE_STEPS.has(i.id) && !(i.id === 'sources' && deps.length) && !isSnoozed(ctx, 'setup_step', `guide:${i.id}`)) : [];
    return [...deps.map((d) => depRow(d, ctx)), ...guide.map((i) => guideRow(i, ctx))];
  },
};
