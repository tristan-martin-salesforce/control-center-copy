/** Each provider: a fixture → its rows (kind, id, primary verb, the route it runs, what is left out). */
import { describe, expect, it } from 'vitest';
import { NeedKind, NeedRow } from '@/contract';
import { NEED_PROVIDERS } from '@/engines/needs/registry';
import type { NeedsContext } from '@/engines/needs/types';
import { dcSuggestionProvider } from '@/engines/needs/providers/dc';
import { outboxDraftProvider } from '@/engines/needs/providers/outbox';
import { reopenReviewProvider } from '@/engines/needs/providers/reopen';
import { setupStepProvider } from '@/engines/needs/providers/setup';
import { spendAskProvider } from '@/engines/needs/providers/spend';
import { timeNeedCount, timeReadyProvider } from '@/engines/needs/providers/time';
import { lanesOf } from '@/components/time/lanes-derive';
import { NOT_IN_ORG62_FLAG } from '@/engines/activity/org62-check';
import { mappingQuestionProvider, resolutionConfirmProvider, triageGuessProvider } from '@/engines/needs/providers/triage';
import { useCaseCandidateProvider } from '@/engines/needs/providers/use-cases';
import { vdpChangeProvider } from '@/engines/needs/providers/vdp';
import { ctxOf, draft, entry, outbox, triage, triageItem, workItem } from './fixtures';

const primary = (r: NeedRow) => r.verbs.find((v) => v.primary)!;
const valid = (rows: NeedRow[]) => rows.forEach((r) => NeedRow.parse(r));

describe('the registry', () => {
  it('has exactly one provider per kind', () => {
    expect(NEED_PROVIDERS.map((p) => p.kind).sort()).toEqual([...NeedKind.options].sort());
  });
  it('every provider returns nothing on an empty context', () => {
    for (const p of NEED_PROVIDERS) expect(p.run(ctxOf()), p.kind).toEqual([]);
  });
});

describe('triage providers', () => {
  const t = triage([
    triageItem('g1', 'asks_promises'),
    triageItem('m1', 'mappings', { kind: 'mapping', workItem: null, mapping: { id: 'm1', question: 'ACME or Globex?', choices: [{ id: 'c1', label: 'ACME', ref: null }, { id: 'c2', label: 'Globex', ref: null }] } }),
    triageItem('ld', 'looks_done'),
    triageItem('sn', 'still_needed'),
    triageItem('mo', 'missed_opps', { kind: 'missed_opp', workItem: null, missedOpp: { id: 'mo', verdict: 'claim', oppId: 'o9', oppName: 'Renewal', accountName: 'Globex' } }),
    triageItem('cl', 'closed_for_you'),
  ]);
  const ctx = ctxOf({ triage: t });

  it.each([
    ['triage_guess', triageGuessProvider, ['triage_guess:g1', 'triage_guess:mo']],
    ['mapping_question', mappingQuestionProvider, ['mapping_question:m1']],
    ['resolution_confirm', resolutionConfirmProvider, ['resolution_confirm:ld', 'resolution_confirm:sn']],
  ] as const)('%s', (_k, p, ids) => {
    const rows = p.run(ctx);
    valid(rows);
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('runs Triage’s own routes with Triage’s payloads', () => {
    const g = triageGuessProvider.run(ctx).find((r) => r.id === 'triage_guess:g1')!;
    expect(primary(g).call).toEqual({ route: 'acceptTriage', params: { id: 'g1' }, body: {} });
    expect(g.verbs.find((v) => v.id === 'dismiss')!.call!.body).toEqual({ reason: 'not_mine' });
    expect(g.verbs.find((v) => v.id === 'snooze')!.call!.body).toEqual({ reason: 'later' });
    expect(g.subject).toBe('item:g1');
    const claim = triageGuessProvider.run(ctx).find((r) => r.id === 'triage_guess:mo')!;
    expect(primary(claim)).toMatchObject({ id: 'claim', feature: 'missedOpps' });
    const ld = resolutionConfirmProvider.run(ctx).find((r) => r.id === 'resolution_confirm:ld')!;
    expect(primary(ld).call).toEqual({ route: 'itemAction', params: { id: 'ld', verb: 'confirm-done' }, body: { ifVersion: 3 } });
    const sn = resolutionConfirmProvider.run(ctx).find((r) => r.id === 'resolution_confirm:sn')!;
    expect(sn.verbs.find((v) => v.id === 'close')!.call!.body).toEqual({ ifVersion: 3, resolution: 'not_needed' });
    const m = mappingQuestionProvider.run(ctx)[0]!;
    expect(primary(m)).toMatchObject({ id: 'answer', choices: [{ id: 'c1', label: 'ACME' }, { id: 'c2', label: 'Globex' }] });
  });

  it('a dated guess takes priority@2’s urgency, an undated one the kind’s', () => {
    const dated = triageGuessProvider.run(ctxOf({ triage: triage([triageItem('d', 'asks_promises', { workItem: workItem('d', { due: '2026-11-18T16:00:00.000Z' }) })]) }))[0]!;
    const undated = triageGuessProvider.run(ctx).find((r) => r.id === 'triage_guess:g1')!;
    expect(dated.urgency).toBeGreaterThanOrEqual(0.6);
    expect(dated.groupKey).toBe('today');
    expect(undated.urgency).toBe(0.5);
  });

  it('a Later on the row (a needs:<kind> snooze) hides it until it ends', () => {
    const snoozed = ctxOf({ triage: t, decisions: [{ rule: 'needs:triage_guess', subjectId: 'g1', kind: 'snooze', until: '2026-11-19T17:00:00.000Z', reason: null, label: null, baseline: {}, decidedAt: '2026-11-18T10:00:00.000Z' }] });
    expect(triageGuessProvider.run(snoozed).map((r) => r.id)).toEqual(['triage_guess:mo']);
    const over = ctxOf({ ...snoozed, nowMs: Date.parse('2026-11-20T00:00:00.000Z') });
    expect(triageGuessProvider.run(over)).toHaveLength(2);
  });
});

describe('outbox_draft', () => {
  it('pending and failed messages; Review links to the Outbox, Reject is its reject; sent ones are not needs', () => {
    const rows = outboxDraftProvider.run(ctxOf({ outbox: outbox([draft('d1', 'pending_approval'), draft('d2', 'failed'), draft('d3', 'sent'), draft('d4', 'scheduled')]) }));
    valid(rows);
    expect(rows.map((r) => r.id)).toEqual(['outbox_draft:d1', 'outbox_draft:d2']);
    expect(primary(rows[0]!)).toMatchObject({ id: 'review', call: null, href: '/outbox?draft=d1' });
    expect(rows[0]!.verbs.find((v) => v.id === 'reject')!.call).toEqual({ route: 'rejectDraft', params: { id: 'd1' }, body: { ifVersion: 2 } });
    expect(rows[1]!.urgency).toBeGreaterThan(rows[0]!.urgency);
  });
});

describe('time_ready_to_log', () => {
  it('unlogged time is one row: what needs a fix, what is ready, canvases waiting', () => {
    const activity = { entries: [entry('e1'), entry('e2', { oppId: null }), entry('e3', { status: 'needs_input' }), entry('e4', { canvasDraftId: 'dr' }), entry('e5', { status: 'logged' }), entry('e6', { internal: true, oppId: null, status: 'proposed' })] } as unknown as NeedsContext['activity'];
    const rows = timeReadyProvider.run(ctxOf({ activity }));
    valid(rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'time_ready_to_log:activity', groupKey: 'admin', why: '2 rows need a fix · 1 ready' });
    expect(primary(rows[0]!)).toMatchObject({ href: '/activity?view=needs', call: null });
  });
  it('C1: the same lanes as Activity: an Internal row is never a fix, a row Org62 lacks is said apart', () => {
    const activity = { entries: [entry('e1'), entry('e2', { oppId: null }), entry('e7', { internal: true, oppId: null, status: 'needs_input' }), entry('e8', { status: 'synced_to_canvas', canvasDraftId: 'b2', issues: [NOT_IN_ORG62_FLAG] })] } as unknown as NeedsContext['activity'];
    const rows = timeReadyProvider.run(ctxOf({ activity }));
    expect(rows[0]!.why).toBe('1 row need a fix · 1 not found in Org62 · 1 ready');
  });
  it('R3-8: ready is lane 2 (Settings ▸ approve complete takes complete proposed rows); nothing says "to approve"', () => {
    const activity = { entries: [entry('e1'), entry('e1b', { status: 'proposed' })] } as unknown as NeedsContext['activity'];
    expect(timeReadyProvider.run(ctxOf({ activity }))[0]!.why).toBe('2 ready');
    expect(timeReadyProvider.run(ctxOf({ activity, approveComplete: false }))[0]!.why).toBe('1 ready');
  });
  it('C6 / R3-8: lane 3 batches from the needs context: "N not found in Org62" and the open batches "in Sending", never "canvas"', () => {
    const activity = { entries: [entry('e1'), entry('e8', { status: 'synced_to_canvas', issues: [NOT_IN_ORG62_FLAG] }), entry('e9', { status: 'synced_to_canvas', issues: [NOT_IN_ORG62_FLAG] })] } as unknown as NeedsContext['activity'];
    const canvases = [
      { draftId: 'b1', state: 'pending', createdAt: '2026-11-05T10:00:00.000Z', maybeCreated: false },
      { draftId: 'b2', state: 'retry', createdAt: '2026-11-04T10:00:00.000Z', maybeCreated: false },
      { draftId: 'b3', state: 'applied', createdAt: '2026-11-03T10:00:00.000Z', maybeCreated: false },
    ] as NeedsContext['canvases'];
    const [row] = timeReadyProvider.run(ctxOf({ activity, canvases }));
    expect(row!.why).toBe('2 not found in Org62 · 1 ready · 3 batches in Sending · 1 batch failed');
    expect(row!.why).not.toMatch(/canvas/i);
    expect(primary(row!)).toMatchObject({ label: 'Fix rows', href: '/activity#time-runs' });
    // only a batch waiting: the row says Apply and lands on lane 3
    const [only] = timeReadyProvider.run(ctxOf({ activity: { entries: [] } as unknown as NeedsContext['activity'], canvases: [canvases![0]!] }));
    expect(only!.title).toBe('Apply the logging batch');
    expect(primary(only!)).toMatchObject({ label: 'Apply', href: '/activity#time-runs' });
  });
  it('C7: the row counts what Activity badges, lanesOf: fix rows + not found + failed batches (never ready, suggested or internal)', () => {
    const entries = [entry('e1'), entry('e1b', { status: 'proposed' }), entry('e2', { oppId: null }), entry('e3', { status: 'needs_input' }), entry('e7', { internal: true, oppId: null, status: 'needs_input' }), entry('e8', { status: 'synced_to_canvas', canvasDraftId: 'b2', issues: [NOT_IN_ORG62_FLAG] })].map((e) => ({ start: '2026-11-17T17:00:00.000Z', userLockedFields: [], issues: [] as string[], sources: [], ...e }));
    const canvases = [{ draftId: 'b2', state: 'retry', createdAt: '2026-11-04T10:00:00.000Z', maybeCreated: false }] as NeedsContext['canvases'];
    const [row] = timeReadyProvider.run(ctxOf({ activity: { entries } as unknown as NeedsContext['activity'], canvases }));
    // Activity's Needs you groups for these rows (path-derive needsYou, by hand: no hub import here, ENG-5)
    const needsOf = (es: typeof entries) => ({ groups: [{ kind: 'opp', rows: [es[2]] }, { kind: 'check', rows: [es[3], es[4]] }, { kind: 'org62', rows: [es[5]] }] }) as never;
    const lanes = lanesOf({ path: { needs: needsOf(entries), readyIds: [], internal: { rows: [], ids: [], hours: 0 } }, rows: entries as never, canvases: canvases as never });
    expect(lanes.badge).toBe(4);
    expect(row!.title).toBe(`${lanes.badge} to fix in Activity (3 h)`);
    expect(timeNeedCount({ fix: lanes.fix.rows, notFound: lanes.sending.notFound, failedBatches: lanes.sending.failedBatches })).toBe(lanes.badge);
  });
  it('nothing live and no canvas: no row', () => {
    expect(timeReadyProvider.run(ctxOf({ activity: { entries: [] } }))).toEqual([]);
  });
});

describe('dc_suggestion', () => {
  const s = (id: string, over: Record<string, unknown> = {}) => ({ id, oppId: `o-${id}`, oppName: `Opp ${id}`, accountId: 'a1', accountName: 'ACME', amount: 250000, groupSize: 1, sharePercent: 100, splitPercent: 100, preTicked: true, state: 'new', reasons: [{ code: 'team', text: 'On the opp team' }], evidence: [{ label: 'Meeting', url: null, at: '2026-11-10T10:00:00.000Z' }], ...over });
  it('new suggestions only; Claim is the existing decide; a split question asks for the split first', () => {
    const dc = { enabled: true, suggestions: [s('a'), s('b', { splitPercent: null }), s('c', { state: 'accepted' })] } as unknown as NeedsContext['dc'];
    const rows = dcSuggestionProvider.run(ctxOf({ dc }));
    valid(rows);
    expect(rows.map((r) => r.id)).toEqual(['dc_suggestion:a', 'dc_suggestion:b']);
    expect(primary(rows[0]!).call).toEqual({ route: 'decideDcSuggestion', params: { id: 'a' }, body: { decision: 'accept' } });
    expect(primary(rows[1]!)).toMatchObject({ id: 'edit', call: null });
  });
  it('a persona that does not claim DCs gets none', () => {
    expect(dcSuggestionProvider.run(ctxOf({ dc: { enabled: false, suggestions: [s('a')] } as unknown as NeedsContext['dc'] }))).toEqual([]);
  });
});

describe('spend_ask', () => {
  it('one row per raised hand, with Health’s three answers', () => {
    const rows = spendAskProvider.run(ctxOf({ health: { spendAsks: [{ holdId: 'h1', scope: 'scan_run', question: 'This scan has used $0.05 of its $0.04 estimate; allow $0.02 more?', spentUsd: 0.05, heldUsd: 0.04, moreUsd: 0.02, askedAt: '2026-11-18T16:50:00.000Z' }] } }));
    valid(rows);
    expect(rows[0]!.verbs.map((v) => [v.id, v.call?.body])).toEqual([
      ['allow', { answer: 'approve', usd: 0.02 }],
      ['allow_today', { answer: 'today' }],
      ['stop', { answer: 'deny' }],
    ]);
    expect(rows[0]!.urgency).toBe(0.9);
  });
});

describe('setup_step', () => {
  it('dependencies you act on, never offline or unknown; Getting started steps to do', () => {
    const dep = (id: string, state: string) => ({ id, label: id, why: 'w', state, nextStep: 'Sign in', lastChecked: null });
    const rows = setupStepProvider.run(
      ctxOf({
        health: { setup: { dependencies: [dep('vdp', 'signed_out'), dep('slack', 'offline'), dep('org62', 'unknown'), dep('db', 'ok')] } } as unknown as NeedsContext['health'],
        guide: { dismissed: false, items: [{ id: 'sources', kind: 'action', title: 'Connect', detail: 'd', state: 'todo', href: '/health' }, { id: 'draft', kind: 'action', title: 'Approve a draft', detail: 'd', state: 'todo', href: '/outbox' }, { id: 'batch', kind: 'action', title: 'Log', detail: 'd', state: 'done', href: '/activity' }] } as unknown as NeedsContext['guide'],
      }),
    );
    valid(rows);
    expect(rows.map((r) => r.id)).toEqual(['setup_step:dep:vdp', 'setup_step:guide:draft']);
    expect(primary(rows[0]!).href).toBe('/health?tab=setup#setup-vdp');
  });
});

describe('reopen_review', () => {
  it('reopened after you last looked; seen or closed ones are not', () => {
    const items = {
      items: [
        workItem('r1', { reopened: { reason: 'Dana replied', at: '2026-11-18T12:00:00.000Z' } }),
        workItem('r2', { reopened: { reason: 'x', at: '2026-11-18T12:00:00.000Z' }, seenAt: '2026-11-18T13:00:00.000Z' }),
        workItem('r3', { reopened: { reason: 'x', at: '2026-11-18T12:00:00.000Z' }, state: 'done' }),
        workItem('r4'),
      ],
    } as unknown as NeedsContext['items'];
    const rows = reopenReviewProvider.run(ctxOf({ items }));
    valid(rows);
    expect(rows.map((r) => r.id)).toEqual(['reopen_review:r1']);
    expect(rows[0]!.verbs.map((v) => v.call?.route ?? v.href)).toEqual(['/work/r1', 'markItemSeen', 'itemAction']);
  });
});

describe('vdp_change', () => {
  it('open VDPs and open not-in-VDP rows (the set vdpNeedYouCount counts); Review opens Activity ▸ VDP', () => {
    const vdp = {
      vdps: [
        { vdpSlug: 'acme', companyName: 'ACME', accountId: 'a1', opportunityId: null, opportunityName: null, url: null, lastActivityAt: null, steps: [{ title: 'Add the AE', state: 'todo' }], status: { state: 'open', open: 2, appCanFix: 1 } },
        { vdpSlug: 'done', companyName: 'Done Co', accountId: null, opportunityId: null, url: null, lastActivityAt: null, steps: [], status: { state: 'done', open: 0, appCanFix: 0 } },
      ],
      notInVdp: [{ key: 'account:a2', accountId: 'a2', title: 'Globex has no VDP', step: { title: 'Create the VDP' }, children: [], status: { state: 'open' } }],
    } as unknown as NeedsContext['vdp'];
    const rows = vdpChangeProvider.run(ctxOf({ vdp }));
    valid(rows);
    expect(rows.map((r) => r.id)).toEqual(['vdp_change:vdp:acme', 'vdp_change:new:account:a2']);
    expect(primary(rows[0]!)).toMatchObject({ href: '/activity?view=vdp', call: null, feature: 'vdp' });
  });
});

describe('use_case_candidate', () => {
  const c = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `UC ${id}`, problem: 'Slow service', status: 'suggested', accountId: 'a1', accountName: 'ACME', oppId: 'o1', oppName: 'Expansion', confidence: 0.9, needsPick: false, evidence: [{ label: 'Gemini notes', url: 'https://docs.example/n', at: '2026-11-15T10:00:00.000Z' }], ...over });
  it('waiting candidates; Add is the existing decide; an unsure opp asks for the pick first', () => {
    const useCases = { enabled: true, candidates: [c('a'), c('b', { needsPick: true }), c('c', { status: 'landed' })] } as unknown as NeedsContext['useCases'];
    const rows = useCaseCandidateProvider.run(ctxOf({ useCases }));
    valid(rows);
    expect(rows.map((r) => r.id)).toEqual(['use_case_candidate:a', 'use_case_candidate:b']);
    expect(primary(rows[0]!).call).toEqual({ route: 'decideUseCaseCandidate', params: { id: 'a' }, body: { decision: 'accept' } });
    expect(primary(rows[1]!)).toMatchObject({ id: 'edit', call: null });
  });
});
