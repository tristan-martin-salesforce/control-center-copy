/**
 * Use-case candidates in mock mode (the db's twin: src/server/datasource/db/use-cases.ts). Candidates live in the
 * store (collection `useCaseCandidates`), so Accept / Edit / Reject undo with the change that made them, together with
 * the VDP Outbox item and the learned rules written in it. The sources are the seed's customer meetings (title and
 * agenda) plus a few placeholder notes and threads below (the seed carries no Gemini notes); the extraction runs on
 * the first read and on Refresh, rules only (the mock has no model: unsure statements are dropped). Nothing is read
 * from or sent to any external system.
 */
import { randomUUID } from 'node:crypto';

import { attributionSettingsOf, type AddUseCaseCandidateRequest, type AddUseCaseCandidateResult, type DecideUseCaseCandidateRequest, type DecideUseCaseCandidateResult, type RefreshUseCaseCandidatesResult, type UseCaseCandidatesPayload } from '@/contract';
import type { UseCaseCreate, UseCasePlanInput } from '@/engines/activity/use-cases';
import { planLearning } from '@/engines/attribution/rules';
import { totalsByOpp, type EngagementRow } from '@/engines/attribution/engagement';
import { worldOfContract } from '@/engines/attribution/row';
import type { LearnedRule, World } from '@/engines/attribution/types';
import { DecideError, decideCandidate, landingOf, pendingCandidateCreates, stagePlanOf, withoutCandidateDuplicates, type CanvasOpp } from '@/engines/use-cases/stage';
import { attributeMention, findMatch, planCandidates, signalOf } from '@/engines/use-cases/plan';
import { candidatesPayload, candidateView } from '@/engines/use-cases/view';
import { dedupeKeyOf } from '@/engines/use-cases/similar';
import { mentionsOf } from '@/engines/use-cases/mentions';
import { productVocabulary } from '@/engines/use-cases/vocab';
import type { UcCandidateRow, UcExisting, UcMention, UcSource } from '@/engines/use-cases/types';
import type { SuggestContext } from '@/lib/time-suggest';
import { oppIdsOf } from '@/lib/vdp/types';
import { featureActive, personaOf } from '@/personas';
import { AppError, invalid, notFound } from '@/server/errors';

import type { Store, Tx } from './store';

export interface MockUseCasesHost {
  now(): Date;
  store(): Store;
  /** The attribution engine's context (records + extras) and its engagement rollup. */
  context(): SuggestContext;
  engagement(): EngagementRow[];
  /** D-67's plan input: the VDPs, my opps with their Org62 ids, the Org62 records, the canvas holds. */
  ucInput(): UseCasePlanInput;
  /** One audited change (Undo reverts every put in it). */
  tx<R>(meta: { action: string; summary: string; id: string }, fn: (tx: Tx) => R): { result: R; auditId: string | null };
  /** The VDP create_use_case Outbox item, in the change (the D-49 path: vdpActionFor with the D-67 duplicate check). */
  vdpDraft(tx: Tx, req: { vdpSlug: string; title: string; track: 'd360' | 'agentforce' }): string;
  publish(ids: string[], reason: string): void;
}

/** Placeholder notes and threads (the seed has none): a customer note, an internal one (never a use case), a thread that names no opp. */
export const MOCK_UC_SOURCES = (now: Date): UcSource[] => {
  const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  return [
    {
      kind: 'gemini_note',
      key: 'mock-note-acme-discovery',
      sourceItemIds: ['mock-note-acme-discovery'],
      title: 'ACME discovery workshop',
      text: '## Summary\nDiscovery workshop with the ACME service team. Dana wants a working demo of order status tracking before the steering committee. Containment of 40% in the web channel is the target.\n## Decisions\n- Order status first',
      at: day(3),
      url: 'https://docs.example.com/document/d/mock-acme-notes',
      externalEmails: ['dana.reyes@acme.example'],
      externalDomains: ['acme.example'],
      explicit: { oppIds: ['opp_acme_p2'], accountIds: ['acc_acme'], via: 'The meeting' },
    },
    {
      kind: 'gemini_note',
      key: 'mock-note-initech',
      sourceItemIds: ['mock-note-initech'],
      title: 'Initech discovery call',
      text: '## Summary\nPeter walked through their data landscape: five systems hold customer data. Initech is looking to replace their legacy CDP with Data Cloud for one unified customer profile.\n## Decisions\n- Pilot scope next week',
      at: day(2),
      url: 'https://docs.example.com/document/d/mock-initech-notes',
      externalEmails: ['peter.gibbons@initech.example'],
      externalDomains: ['initech.example'],
      explicit: { oppIds: ['opp_initech_pilot'], accountIds: ['acc_initech'], via: 'The meeting' },
    },
    {
      kind: 'slack_burst',
      key: 'mock-slack-hooli',
      sourceItemIds: ['mock-slack-hooli'],
      title: '#hooli-shared',
      text: 'Nora: we want to build a loyalty agent on Agentforce that answers points questions in the app.\nNora: happy to share the data model.',
      at: day(1),
      url: null,
      externalEmails: ['nora.patel@hooli.example'],
      externalDomains: ['hooli.example'],
      customer: true,
    },
    {
      kind: 'gemini_note',
      key: 'mock-note-standup',
      sourceItemIds: ['mock-note-standup'],
      title: 'SE team stand-up',
      text: '## Summary\nWe want to build a demo kit for the team and plan to automate the weekly report.',
      at: day(1),
      url: null,
      externalEmails: [],
      externalDomains: [],
    },
  ];
};

const id15 = (s: string | null | undefined) => (s ?? '').slice(0, 15);

export class MockUseCases {
  private ranFor: Store | null = null;
  private generatedAt: string | null = null;

  constructor(private readonly host: MockUseCasesHost) {}

  private enabled(): boolean {
    return featureActive(personaOf(this.host.store().settings()), 'vdp');
  }

  private world(): { world: World; totals4w: ReturnType<typeof totalsByOpp> } {
    return { world: worldOfContract(this.host.context()), totals4w: totalsByOpp(this.host.engagement(), '0000-00-00') };
  }

  private rows(): UcCandidateRow[] {
    return this.host.store().all('useCaseCandidates');
  }

  /** The seed's customer meetings as sources (title + agenda), and the placeholders. */
  sources(): UcSource[] {
    const s = this.host.store();
    const out: UcSource[] = [];
    for (const e of s.all('events')) {
      if (!e.isCustomerFacing || !e.accountId || !e.agenda) continue;
      const people = (e.attendees ?? []).map((a) => (a as { email?: string | null }).email).filter((x): x is string => !!x && !x.endsWith('@example.com'));
      out.push({ kind: 'meeting', key: `mock-event-${e.id}`, sourceItemIds: [e.id], title: e.title, text: e.agenda, at: e.start, url: e.meetingUrl ?? null, externalEmails: people, externalDomains: [], customer: true, explicit: { oppIds: e.oppId ? [e.oppId] : [], accountIds: [e.accountId], via: 'The meeting' } });
    }
    return [...out, ...MOCK_UC_SOURCES(this.host.now())];
  }

  /** What exists: the VDP mirror's use cases and the Org62 records on my opps. */
  private existing(i: UseCasePlanInput = this.host.ucInput()): UcExisting[] {
    const byOrg62 = new Map(i.opps.map((o) => [id15(o.org62Id), o] as const));
    const out: UcExisting[] = [];
    for (const r of i.org62.records) {
      if (r.goneAt || !r.name) continue;
      const o = byOrg62.get(id15(r.opportunityId));
      out.push({ kind: 'org62', id: r.id, title: r.name, oppId: o?.id ?? null, accountId: o?.accountId ?? null, org62UseCaseId: r.id });
    }
    for (const v of i.vdps) {
      const o = oppIdsOf(v.snapshot).map((x) => byOrg62.get(id15(x))).find(Boolean);
      for (const u of v.snapshot.useCases) if (u.title?.trim()) out.push({ kind: 'vdp', id: u.id, title: u.title.trim(), oppId: o?.id ?? null, accountId: v.accountId ?? o?.accountId ?? null, vdpUseCaseId: u.id, vdpSlug: v.snapshot.slug });
    }
    return out;
  }

  private vdpSlugFor(r: Pick<UcCandidateRow, 'oppId' | 'accountId' | 'vdpSlug'>, i: UseCasePlanInput): string | null {
    if (r.vdpSlug) return r.vdpSlug;
    const live = i.vdps.filter((v) => !v.snapshot.archivedAt && !v.snapshot.isSeed);
    const o62 = r.oppId ? i.opps.find((o) => o.id === r.oppId)?.org62Id : null;
    const onOpp = o62 ? live.find((v) => oppIdsOf(v.snapshot).some((x) => id15(x) === id15(o62))) : undefined;
    if (onOpp) return onOpp.snapshot.slug;
    const onAccount = r.accountId ? live.filter((v) => v.accountId === r.accountId) : [];
    return onAccount.length === 1 ? onAccount[0]!.snapshot.slug : null;
  }

  private viewCtx(i: UseCasePlanInput = this.host.ucInput()) {
    const s = this.host.store();
    const opps = new Map(i.opps.map((o) => [o.id, o] as const));
    return {
      accountName: (id: string) => s.get('accounts', id)?.name ?? null,
      oppName: (id: string) => s.get('opps', id)?.name ?? null,
      org62OppId: (id: string) => opps.get(id)?.org62Id ?? null,
      vdpFor: (r: UcCandidateRow) => this.vdpSlugFor(r, i),
      holds: i.holds,
      vdpDraftStatus: (id: string) => s.get('drafts', id)?.status ?? null,
    };
  }

  /** The extraction pass (rules only) and the landing sweep, as one system change. */
  extract(): { created: number; attached: number; landed: number } {
    const store = this.host.store();
    this.ranFor = store;
    this.generatedAt = this.host.now().toISOString();
    if (!this.enabled()) return { created: 0, attached: 0, landed: 0 };
    const sources = this.sources();
    const { sure } = mentionsOf(sources, { vocab: productVocabulary(attributionSettingsOf(store.settings().time).dcProducts) });
    const { world, totals4w } = this.world();
    const i = this.host.ucInput();
    const rows = this.rows();
    const plan = planCandidates({ sources, mentions: sure, world, totals4w, existing: this.existing(i), candidates: rows, now: this.generatedAt, newId: () => randomUUID() });
    const landed: UcCandidateRow[] = [];
    for (const c of rows) {
      const l = landingOf(c, c.oppId ? (i.opps.find((o) => o.id === c.oppId)?.org62Id ?? null) : null, { org62: i.org62.records.filter((r) => !r.goneAt), vdp: i.vdps.flatMap((v) => v.snapshot.useCases.map((u) => ({ id: u.id, title: u.title, vdpSlug: v.snapshot.slug }))), sentCreate: (k) => i.holds.sentCreates.get(k) });
      if (l) landed.push({ ...c, ...l, updatedAt: this.generatedAt });
    }
    if (plan.creates.length || plan.updates.length || landed.length) {
      // the batch writes straight to the store (as the db's engine change set, not undoable)
      for (const c of [...plan.creates, ...plan.updates.map((u) => u.after), ...landed]) store.c.useCaseCandidates.set(c.id, c);
      this.host.publish([...plan.creates, ...landed].map((c) => c.id), 'use_cases.extract');
    }
    return { created: plan.counts.created, attached: plan.counts.attached, landed: landed.length };
  }

  private ensure(): void {
    if (this.ranFor !== this.host.store()) this.extract();
  }

  list(): UseCaseCandidatesPayload {
    this.ensure();
    return candidatesPayload(this.rows(), this.viewCtx(), { enabled: this.enabled(), now: this.host.now().toISOString(), generatedAt: this.generatedAt });
  }

  private learn(tx: Tx, world: World, row: UcCandidateRow, l: NonNullable<ReturnType<typeof decideCandidate>['learning']>): void {
    if (!row.signal) return;
    const rules: LearnedRule[] = this.host.store().all('learnedRules');
    for (const c of planLearning({ signal: row.signal, chosen: l.chosen, outcome: l.outcome, shown: l.shown, world }, rules, this.host.now().toISOString(), () => `rule_${randomUUID()}`)) tx.put('learnedRules', c.after);
  }

  decide(id: string, body: DecideUseCaseCandidateRequest): { entity: DecideUseCaseCandidateResult; auditId: string | null } {
    this.ensure();
    if (!this.enabled()) throw invalid('Use cases are off for this persona');
    const cur = this.host.store().get('useCaseCandidates', id);
    if (!cur) throw notFound('Use case candidate', id);
    const opps = this.host.store().all('opps').map((o) => ({ id: o.id, accountId: o.accountId || null, isOpen: o.isOpen }));
    let d: ReturnType<typeof decideCandidate>;
    try {
      d = decideCandidate(cur, body, opps, this.host.now().toISOString());
    } catch (e) {
      throw e instanceof DecideError ? invalid(e.message) : e;
    }
    const i = this.host.ucInput();
    const { world } = this.world();
    const r = this.host.tx({ action: `use_case.candidate.${body.decision}`, summary: `Use case to add: ${body.decision} ${cur.title}`.slice(0, 200), id }, (tx) => {
      let next = d.next;
      let vdpDraftId: string | null = null;
      let org62Staged = false;
      if (d.stage) {
        const o = i.opps.find((x) => x.id === next.oppId);
        const twin = findMatch(world, { oppId: next.oppId, accountId: next.accountId, title: next.title, dedupeKey: next.dedupeKey }, this.existing(i), []);
        let plan;
        try {
          plan = stagePlanOf(next, { org62OppId: o?.org62Id ?? null, oppOpen: o?.isOpen ?? false, vdpSlug: this.vdpSlugFor(next, i), inOrg62: twin?.kind === 'org62', inVdp: twin?.kind === 'vdp' });
        } catch (e) {
          throw e instanceof DecideError ? invalid(e.message) : e;
        }
        if (plan.vdp) vdpDraftId = this.host.vdpDraft(tx, plan.vdp);
        org62Staged = plan.org62;
        next = { ...next, status: plan.status, vdpSlug: plan.vdp?.vdpSlug ?? next.vdpSlug, vdpDraftId };
      }
      tx.put('useCaseCandidates', next);
      if (d.learning) this.learn(tx, world, cur, d.learning);
      return { next, vdpDraftId, org62Staged };
    });
    this.host.publish([id], `use_case.candidate.${body.decision}`);
    return { entity: { candidate: candidateView(r.result.next, this.viewCtx()), vdpDraftId: r.result.vdpDraftId, org62Staged: r.result.org62Staged }, auditId: r.auditId };
  }

  add(body: AddUseCaseCandidateRequest): { entity: AddUseCaseCandidateResult; auditId: string | null } {
    this.ensure();
    if (!this.enabled()) throw invalid('Use cases are off for this persona');
    const s = this.host.store();
    const opp = body.oppId ? s.get('opps', body.oppId) : undefined;
    if (body.oppId && !opp) throw notFound('Opportunity', body.oppId);
    const accountId = opp?.accountId || body.accountId || null;
    if (!opp && !accountId) throw invalid('Say which opportunity or account it is on');
    const now = this.host.now().toISOString();
    const src: UcSource = { kind: 'manual', key: `manual:${randomUUID()}`, sourceItemIds: [], title: 'Added by you', text: body.problem ?? body.title, at: now, url: null, externalEmails: [], externalDomains: [], explicit: { oppIds: opp ? [opp.id] : [], accountIds: accountId ? [accountId] : [], via: 'You' } };
    const m: UcMention = { sourceKey: src.key, statement: (body.problem ?? body.title).slice(0, 300), title: body.title.trim(), problem: body.problem ?? '', products: body.products ?? [], track: body.track ?? null, outcome: body.outcome ?? '', stageHint: null, cue: 'manual', certainty: 'sure' };
    const { world, totals4w } = this.world();
    const at = opp ? { oppId: opp.id, accountId, confidence: 1, why: [{ code: 'explicit' as const, weight: 1, text: 'You picked this opportunity' }], needsPick: false, alternates: [] } : attributeMention(signalOf(src, m), world, totals4w);
    const key = dedupeKeyOf({ oppId: at.needsPick ? null : at.oppId, accountId: at.accountId ?? accountId, product: m.products[0] ?? null, title: m.title });
    const plan = planCandidates({ sources: [src], mentions: new Map([[src.key, [m]]]), world, totals4w, existing: this.existing(), candidates: this.rows(), now, newId: () => randomUUID() });
    const created = plan.creates[0];
    if (opp && created && created.status === 'suggested') Object.assign(created, { oppId: opp.id, accountId, confidence: 1, why: at.why, needsPick: false, alternates: [], dedupeKey: key });
    const row = created ?? plan.updates[0]?.after ?? this.rows().find((x) => x.dedupeKey === key);
    if (!row) throw new AppError('conflict', 'That use case is one the app already has');
    const r = this.host.tx({ action: 'use_case.candidate.add', summary: `Use case to add: ${body.title}`.slice(0, 200), id: row.id }, (tx) => {
      for (const c of plan.creates) tx.put('useCaseCandidates', c);
      for (const u of plan.updates) tx.put('useCaseCandidates', u.after);
    });
    this.host.publish([row.id], 'use_case.candidate.add');
    const matched = created && created.status === 'suggested' ? null : created ? created.matchedKind : 'candidate';
    return { entity: { candidate: candidateView(row, this.viewCtx()), matched }, auditId: r.auditId };
  }

  refresh(): RefreshUseCaseCandidatesResult {
    const r = this.extract();
    const n = this.rows().filter((x) => x.matchedKind === null && (x.status === 'suggested' || x.status === 'edited')).length;
    return { queued: false, candidates: n, note: r.created ? `${r.created} new use ${r.created === 1 ? 'case' : 'cases'} to add` : 'Nothing new in your notes, meetings, Slack or mail' };
  }

  /** The Org62 rows accepted candidates put on the next logging canvas, with the plan's creates minus their twins. */
  canvasRows(planCreates: readonly UseCaseCreate[], i: UseCasePlanInput = this.host.ucInput()): UseCaseCreate[] {
    const rows = this.rows();
    if (!rows.length) return [...planCreates];
    const opps = new Map(i.opps.map((o) => [o.id, o] as const));
    const oppOf = (id: string): CanvasOpp | null => {
      const o = opps.get(id);
      return o && o.isOpen && o.accountOrg62Id ? { org62Id: o.org62Id, name: o.name, accountOrg62Id: o.accountOrg62Id, closeDate: o.closeDate } : null;
    };
    return [...withoutCandidateDuplicates(planCreates, rows, (id) => opps.get(id)?.org62Id ?? null), ...pendingCandidateCreates(rows, i.holds, oppOf)];
  }

  /** Accepted candidates for the canvas question's `suggested` marker. */
  suggested(i: UseCasePlanInput = this.host.ucInput()): Array<{ id: string; title: string; accountId: string | null; oppOrg62Id: string | null; from: string | null }> {
    return this.rows()
      .filter((r) => r.matchedKind === null && r.status !== 'rejected' && r.status !== 'suggested' && r.status !== 'edited')
      .map((r) => ({ id: r.id, title: r.title, accountId: r.accountId, oppOrg62Id: r.oppId ? (i.opps.find((o) => o.id === r.oppId)?.org62Id ?? null) : null, from: r.evidence[0]?.label ?? null }));
  }
}
