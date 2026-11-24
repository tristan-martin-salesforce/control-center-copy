/**
 * Shared by the mock and db DataSources: `getVdpCoverage` (the mirror + my book → gaps → open items → one status per
 * VDP → the Changes tree, D-63) and `draftVdpUpdate` (one item's Apply, or one legacy field change → a `vdp.*` action
 * draft on Time). Pure: callers load the mirror rows, the entities, the drafts and the server info, and persist the
 * draft. Nothing here calls VDP (*tenet: Draft, don't send*).
 */
import type { JudgmentRequest } from '@/engines/vdp/identity';
import { DEFAULT_AUTOPILOT_ASSET_HOSTS, DEFAULT_VDP_AUTOPILOT_STATE, VdpActionInput, vdpKeyOfAccount, type Account, type VdpGap, type ActionDestination, type Draft, type DraftVdpUpdateRequest, type Opportunity, type VdpApply, type VdpAssetItem, type VdpCoveragePayload, type VdpCoverageRow, type VdpFieldChange, type VdpNotInVdpRow, type VdpRowSummary, type VdpStep } from '@/contract';
import { actionDoc, actionSummary } from '@/lib/actions';
import { matchLookup } from '@/engines/vdp/assets';
import { assetPolicy, decorateCoverage, EMPTY_LEDGER, type AutopilotItem, type AutopilotLedger, type AutopilotSettings } from '@/engines/vdp/autopilot';
import { explainOwnerRefusals, ownersCallOf, vdpPeople, type OwnersCall } from '@/engines/vdp/owners';
import { computeVdpGaps, GENERATE_INPUTS, DEFAULT_REQUIRED_FIELDS, vdpLabel, type GapAccount, type GapOpp, type GapVdpRow, type SpecialistAe } from '@/engines/vdp/gaps';
import type { IdentityJudgment, IdentityOverride } from '@/engines/vdp/identity';
import type { AccountHierarchy } from '@/lib/accounts/hierarchy';
import { vdpDraftRefs, vdpItemKeyOf, vdpStatusOf, vdpSummary, nextReadAt } from '@/engines/vdp/status';
import { idSources, itemKey, newVdpSlug, vdpSteps, type DraftRef, type IdSources } from '@/engines/vdp/steps';
import { suggestionFor } from '@/engines/vdp/suggest';
import { buildVdpTree } from '@/engines/vdp/tree';
import { unsupportedReason, vdpCapabilities, type VdpCapabilities } from '@/lib/vdp/capabilities';
import { isHttpUrl, VDP_CREATE_USE_CASE_FIELDS, VDP_FIELD_LABEL, VDP_HEADER_FIELDS, VDP_UPDATE_USE_CASE_FIELDS, coerceVdpValue, showVdpValue, type VdpOp } from '@/lib/vdp/payload';
import type { VdpServerInfo, VdpSnapshot, VdpUseCase } from '@/lib/vdp/types';
import { AppError, invalid, notFound } from '@/server/errors';
import { assetsSummary, assetTargets, candidateApply, candidateKey, newVdpUrlOf, slugByAccount, type CandidateRecord } from './detail';
import { DEFAULT_RUN_USD } from './find';

/** VDP autopilot's inputs for the coverage pass (D-60): the setting, the ledger, VDP's sign-in and today. */
export interface CoverageAutopilot {
  settings: AutopilotSettings;
  ledger: AutopilotLedger;
  auth: 'ok' | 'stale' | null;
  today: string;
  dayOf: (iso: string) => string;
}

/** A use case's five human inputs are all in (its detail read): Generate may run (D-60). */
export function inputsComplete(u: VdpUseCase): boolean {
  if (!u.detailLoaded) return false;
  const v: Record<string, unknown> = { title: u.title, priority: u.priority, division: u.division, persona: u.persona, details_input: u.detailsInput };
  return GENERATE_INPUTS.every((f) => typeof v[f] === 'string' && (v[f] as string).trim() !== '');
}

/** My VDPs' summary of one VDP: who is on it (as VDP records it), its use cases and the assets it links. */
export function rowSummary(s: VdpSnapshot): VdpRowSummary {
  const p = (x: { name: string | null; email: string | null }) => ({ name: x.name, email: x.email });
  const missingOf = (u: VdpUseCase) => {
    const v: Record<string, unknown> = { title: u.title, priority: u.priority, division: u.division, persona: u.persona, details_input: u.detailsInput, execution_phase: u.executionPhase, execution_target_date: u.executionTargetDate };
    return DEFAULT_REQUIRED_FIELDS.filter((f) => !(f === 'details_input' && !u.detailLoaded)).filter((f) => !(typeof v[f] === 'string' && (v[f] as string).trim() !== '')).map((f) => VDP_FIELD_LABEL[f] ?? f);
  };
  return {
    people: { aes: s.aes.map(p), tas: s.tas.map(p), collaborators: s.collaborators.map(p), stakeholders: s.stakeholders.map((x) => ({ name: x.name, title: x.title, role: x.role })) },
    useCases: [...s.useCases].sort((a, b) => a.displayOrder - b.displayOrder).map((u) => ({ id: u.id, title: u.title?.trim() || `Untitled ${u.track === 'agentforce' ? 'Agentforce' : 'D360'} use case`, track: u.track, inputsComplete: inputsComplete(u), hasAi: u.hasAi, missing: missingOf(u) })),
    assets: s.assets.map((a) => ({ title: a.title, url: a.url, type: a.type, deliverableType: a.deliverableType ?? null })),
  };
}

export interface MirrorRecord {
  snapshot: VdpSnapshot | null;
  goneAt: string | null;
  lastSeenAt: string;
}

/** The Org62 id inside a record link (`…/Opportunity/006…/view`), else null. */
export function org62IdFromUrl(url: string | null | undefined, prefix: '001' | '006'): string | null {
  const m = new RegExp(`\\b(${prefix}[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)\\b`).exec(url ?? '');
  return m?.[1] ?? null;
}

const originOf = (url: string | null | undefined) => /^(https?:\/\/[^/]+)/i.exec(url ?? '')?.[1] ?? null;

/**
 * Contract accounts/opps → the gap engine's view. `org62` overrides the ids parsed from the record links (the db path
 * reads them from the tables). D-63: the DC split is my DC's (`myDc.split`, the deal_contributions mirror).
 */
export function gapEntities(accounts: Account[], opps: Opportunity[], org62?: { accounts: Map<string, string | null>; opps: Map<string, string | null> }): { accounts: GapAccount[]; opps: GapOpp[] } {
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, org62AccountId: org62?.accounts.has(a.id) ? org62.accounts.get(a.id)! : org62IdFromUrl(a.org62Url, '001'), industry: a.industry ?? null })),
    opps: opps.map((o) => ({
      id: o.id,
      accountId: o.accountId || null,
      name: o.name,
      org62OpportunityId: org62?.opps.has(o.id) ? org62.opps.get(o.id)! : org62IdFromUrl(o.org62Url, '006'),
      isOpen: o.isOpen,
      // closed won / lost from the stage name (a linked closed-lost opp looks wrong, D-60)
      isWon: o.isOpen ? null : o.isWon ? true : /\bwon\b/i.test(o.stage) ? true : /\b(lost|dead)\b/i.test(o.stage) ? false : null,
      dcSplit: o.myDc?.split ?? null,
      closeDate: o.closeDate,
      owner: o.owner ? { name: o.owner.name, email: null } : null,
    })),
  };
}

/** The coverage page and the details panel read the same rows: this is where items and statuses are made. */
export function vdpCoverageFrom(input: {
  records: MirrorRecord[];
  accounts: Account[];
  opps: Opportunity[];
  /** The db path passes the tables' own Org62 ids (the same ones the mirror sink links with). */
  entities?: { accounts: GapAccount[]; opps: GapOpp[] };
  me: { name: string; email: string | null };
  /** Every email of mine in VDP (seed VDPs I am on are writable, D-63). */
  myEmails?: readonly string[];
  /** Today (ISO): the current fiscal period (scope). */
  now: string;
  vdpBaseUrl?: string | null;
  /** Asset candidates and the research budget, for the page's "assets to add" counts and "Find assets for all". */
  assets?: { candidates: readonly CandidateRecord[]; perRunUsd: number; runUsd?: number; dayLeftUsd: number; running: number };
  /** Every draft (only `vdp.*` ones count): staged → the item shows staged; applied → waiting for the next read. */
  drafts?: readonly Draft[];
  /** What VDP's server lists (feature detection, D-59); null = not read yet. */
  server?: VdpServerInfo | null;
  /** D-60: VDP autopilot (off when absent). */
  autopilot?: CoverageAutopilot | null;
  /** D-63: the Specialist Forecast AEs per local opp id. */
  aesByOpp?: ReadonlyMap<string, readonly SpecialistAe[]>;
  /** D-63: the latest push. */
  push?: VdpCoveragePayload['push'];
  /** The recent pushes, newest first (settled against their jobs, staging lists stripped). */
  pushes?: VdpCoveragePayload['pushes'];
  /** D-69: the Org62 account hierarchy, the judgment cache and your mappings (Change…). */
  hierarchy?: AccountHierarchy | null;
  judgments?: Readonly<Record<string, IdentityJudgment>>;
  overrides?: readonly IdentityOverride[];
  /** D-69 (VD-28): VDP's sign-in as the connector last saw it. */
  signIn?: 'ok' | 'stale' | null;
  /** D-69 (VD-13): Org62 opp ids DC-22 tombstoned (deleted in Org62). */
  deletedOrg62OppIds?: readonly string[];
  /** D-67: the use-case round trip's VDP-side gaps per VDP slug (Org62 → VDP; src/engines/activity/use-cases.ts). */
  useCaseGaps?: ReadonlyMap<string, readonly VdpGap[]>;
}): VdpCoveragePayload {
  return vdpCoverageAndQueue(input).coverage;
}

/** An asset candidate as its own change: its Apply (disabled until VDP lists add_vdp_asset), who adds it. */
function assetItemOf(c: CandidateRecord, o: { slug: string; server: VdpServerInfo | null | undefined; caps: VdpCapabilities; drafts: ReadonlyMap<string, DraftRef>; read: string | null; requires: string[]; assetHosts: readonly string[] }): VdpAssetItem {
  // the Apply exists whether or not VDP lists the tool, so the same row turns pushable once it does (D-63)
  const apply = candidateApply(c, { slug: o.slug, server: o.server, addAsset: true });
  const d = o.drafts.get(itemKey.asset(c.id));
  const state: VdpAssetItem['state'] = d?.state === 'staged' ? 'staged' : d?.state === 'applied' && (!o.read || d.at > o.read) ? 'waiting' : 'todo';
  const http = isHttpUrl(c.url);
  // VDP takes http(s) links only: anything else is flagged (candidateApply gives it no Apply)
  const p = http ? assetPolicy(c, !!apply, o.assetHosts) : { policy: 'you' as const, reason: 'Not an http(s) link: VDP takes http(s) links only' };
  const disabled = !http ? 'Not an http(s) link: VDP takes http(s) links only' : !o.caps.addAsset ? unsupportedReason('add_vdp_asset') : null;
  return { candidateId: c.id, title: c.title, url: c.url, why: c.why, confidence: c.confidence, state, apply, draftId: d?.id ?? null, policy: p.policy, policyReason: p.reason, autopilot: null, requires: o.requires, disabled };
}

/** The coverage and, for the worker's `vdp.autopilot`, the items autopilot may apply now (in order, within the cap). */
export function vdpCoverageAndQueue(input: Parameters<typeof vdpCoverageFrom>[0]): { coverage: VdpCoveragePayload; queue: AutopilotItem[]; identityPending: JudgmentRequest[] } {
  const live = input.records.filter((r) => r.snapshot && !r.goneAt);
  const snaps = live.map((r) => r.snapshot!);
  // VD-14: archived in VDP, or no longer mine (a complete read stopped listing it): tombstones, never created again
  const gone = input.records.filter((r) => r.snapshot && (r.goneAt || r.snapshot.archivedAt)).map((r) => ({ snap: r.snapshot!, at: r.goneAt ?? r.snapshot!.archivedAt }));
  const seenAt = new Map(live.map((r) => [r.snapshot!.slug, r.lastSeenAt]));
  const vdpBaseUrl = input.vdpBaseUrl ?? snaps.map((s) => originOf(s.url)).find(Boolean) ?? null;
  const ents = input.entities ?? gapEntities(input.accounts, input.opps);
  // VD-06: a company VDP answered "not found" for (merged or archived there) is no match any more: the next read looks again
  const dead = deadCompanyIds(input.drafts ?? []);
  const server = input.server && dead.size ? { ...input.server, companies: input.server.companies.filter((c) => !c.matches.some((m) => dead.has(m.id))) } : (input.server ?? null);
  const caps = vdpCapabilities(server);
  // 2026-11-16: a refused AE / TA list says who VDP doesn't know yet and what to do (src/engines/vdp/owners.ts)
  const byDraft = new Map((input.drafts ?? []).map((d) => [d.id, d]));
  const people = vdpPeople({
    vdps: input.records.filter((r) => r.snapshot).map((r) => r.snapshot!),
    applied: (input.drafts ?? []).filter((d) => d.status === 'sent' || d.status === 'verified').map(ownersCallOf).filter((c): c is OwnersCall => !!c),
    names: [...(input.aesByOpp?.values() ?? [])].flat().map((a) => [a.email, a.name] as const),
  });
  const pushes = explainOwnerRefusals(input.pushes ?? (input.push ? [input.push] : []), (id) => {
    const d = byDraft.get(id);
    return d ? ownersCallOf(d) : null;
  }, people);
  const res = computeVdpGaps({
    vdps: snaps,
    accounts: ents.accounts,
    opps: ents.opps,
    me: input.me,
    ...(input.myEmails ? { myEmails: input.myEmails } : {}),
    vdpBaseUrl,
    now: input.now,
    capabilities: caps,
    server,
    ...(input.aesByOpp ? { aesByOpp: input.aesByOpp } : {}),
    hierarchy: input.hierarchy ?? null,
    ...(input.judgments ? { judgments: input.judgments } : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
    tombstones: gone.map((g) => g.snap).filter((t) => !snaps.some((x) => x.id === t.id)),
    ...(input.deletedOrg62OppIds ? { deletedOrg62OppIds: input.deletedOrg62OppIds } : {}),
  });
  const lastReadAt = input.records.map((r) => r.lastSeenAt).sort().at(-1) ?? null;
  const drafts = vdpDraftRefs(input.drafts ?? []);
  const a = input.assets ?? { candidates: [], perRunUsd: 0.5, dayLeftUsd: 0, running: 0 };
  const byAccount = slugByAccount(res.vdps);
  const openCands = a.candidates.filter((c) => c.status === 'suggested' || c.status === 'unsure' || c.status === 'added');
  const newVdpUrl = newVdpUrlOf(vdpBaseUrl);
  // SEC-6: the sites autopilot adds asset links from (autopilot off or absent: the default list, for the label only)
  const assetHosts = input.autopilot?.settings.assetHosts ?? DEFAULT_AUTOPILOT_ASSET_HOSTS;

  const oppsById = new Map(ents.opps.map((o) => [o.id, o]));
  const vdps: VdpCoverageRow[] = res.vdps.map((r) => {
    const snap = snaps.find((s) => s.slug === r.vdpSlug)!;
    const read = seenAt.get(r.vdpSlug) ?? lastReadAt;
    const summary = rowSummary(snap);
    if (r.scope !== 'current') return { ...r, steps: [], status: vdpStatusOf([], r.scope, read), summary, assetItems: [] };
    const mine = openCands.filter((c) => candidateKey(c, byAccount) === r.vdpSlug);
    const steps0 = vdpSteps({
      key: r.vdpSlug,
      companyName: r.companyName,
      vdpLabel: vdpLabel(snap),
      gaps: [...r.gaps, ...(input.useCaseGaps?.get(r.vdpSlug) ?? [])],
      candidates: mine,
      useCases: [...snap.useCases].sort((x, y) => x.displayOrder - y.displayOrder).map((u) => ({ id: u.id, title: u.title?.trim() || `Untitled ${u.track === 'agentforce' ? 'Agentforce' : 'D360'} use case` })),
      newVdpUrl,
      drafts,
      lastReadAt: read,
      addAsset: true,
    });
    // D-60: suggested values for the judgment items (never auto-applied), from what the app knows
    const linkedOpps = r.opportunityIds.map((id) => oppsById.get(id)).filter((o): o is GapOpp => !!o);
    const steps = steps0.map((s) => {
      const uc = s.gaps[0]?.useCaseId ? snap.useCases.find((u) => u.id === s.gaps[0]!.useCaseId) : null;
      const suggestion = s.state === 'todo' || s.state === 'staged' ? suggestionFor(s, { useCase: uc, stakeholders: snap.stakeholders, opps: linkedOpps, companyName: snap.company.name, now: input.now }) : null;
      return suggestion ? { ...s, suggestion } : s;
    });
    // each asset to add as its own change, with who adds it (autopilot only the strongest http(s) links); VD-31: one the
    // app added that VDP no longer shows was removed there by a person: never added again
    const removed = removedInVdp(snap, mine, drafts, read);
    const assetItems = mine.filter((c) => c.status === 'suggested' && !removed.has(c.id)).map((c) => assetItemOf(c, { slug: r.vdpSlug, server: input.server, caps, drafts, read, requires: [], assetHosts }));
    return { ...r, steps, status: vdpStatusOf(steps, 'current', read), summary, assetItems };
  });

  const identities = res.identity.groups.map((g) => g.identity);
  const names = new Map(res.identity.groups.map((g) => [g.primaryAccountId, g.identity.pick.name]));
  const notInVdp = notInVdpRows(res.unlinked, input.accounts, ents, { drafts, lastReadAt, newVdpUrl, caps, server: server ?? null, candidates: openCands, byAccount, now: input.now, names, assetHosts });
  // D-60: who applies each item, what autopilot did or will do, and the queue it works through
  const ap = input.autopilot;
  const useCases = new Map(snaps.flatMap((s) => s.useCases.map((u) => [u.id, u] as const)));
  const dec = decorateCoverage(
    { vdps, notInVdp },
    {
      settings: ap?.settings ?? { on: false, dryRun: true, cap: DEFAULT_VDP_AUTOPILOT_STATE.cap, assetHosts },
      ledger: ap?.ledger ?? EMPTY_LEDGER,
      auth: ap?.auth ?? null,
      today: ap?.today ?? input.now.slice(0, 10),
      dayOf: ap?.dayOf ?? ((iso) => iso.slice(0, 10)),
      policy: { inputsComplete: (id) => !!useCases.get(id) && inputsComplete(useCases.get(id)!) },
    },
  );
  const cov = { vdps: dec.cov.vdps, unlinked: res.unlinked, notInVdp: dec.cov.notInVdp };
  const summary = vdpSummary(cov);
  const assets = assetsSummary(cov, a.candidates, { targets: assetTargets(cov, snaps, input.accounts).length, perRunUsd: a.perRunUsd, runUsd: a.runUsd ?? Math.min(a.perRunUsd, DEFAULT_RUN_USD), dayLeftUsd: a.dayLeftUsd, running: a.running });
  const sorted = sortRows(cov.vdps);
  return {
    coverage: {
      vdps: sorted,
      unlinked: res.unlinked,
      notInVdp: cov.notInVdp,
      counts: res.counts,
      summary,
      lastReadAt,
      nextReadAt: nextReadAt(lastReadAt),
      vdpBaseUrl,
      assets,
      automation: { toolsKnown: caps.known, createVdp: caps.createVdp, addOpportunities: caps.addOpportunities, removeOpportunities: caps.removeOpportunities, createCompany: caps.createCompany, addAsset: caps.addAsset, setOwners: caps.setOwners, generateUseCase: caps.generateUseCase, entitlementHeader: caps.entitlementHeader, entitlementCreate: caps.entitlementCreate, salesSegment: caps.salesSegment },
      autopilot: dec.state,
      tree: buildVdpTree({ vdps: sorted, notInVdp: cov.notInVdp, identities }),
      push: pushes.find((r) => r.id === input.push?.id) ?? input.push ?? pushes[0] ?? null,
      pushes,
      identities,
      signIn: input.signIn ?? input.autopilot?.auth ?? null,
      tombstones: gone
        .filter((g) => !snaps.some((x) => x.id === g.snap.id))
        .map((g) => {
          const acc = gapAccountOf(g.snap, ents.accounts);
          return { vdpSlug: g.snap.slug, companyName: g.snap.company.name, accountId: (acc ? res.identity.groupOfAccount.get(acc)?.primaryAccountId : null) ?? acc, why: g.snap.archivedAt ? 'Archived in VDP' : 'You are no longer on it, or it was archived', at: g.at };
        }),
    },
    queue: dec.queue,
    // D-69: the ambiguous identities still waiting for a judgment, computed from exactly these inputs, so the job that
    // judges them and this view agree on every unit's key and hash
    identityPending: res.identity.pending,
  };
}

const STATE_ORDER = { open: 0, waiting: 1, waiting_dc: 2, done: 3, past: 4 } as const;

/** The account a tombstoned VDP was for (its account id on the header), for the quiet list. */
function gapAccountOf(v: VdpSnapshot, accounts: readonly GapAccount[]): string | null {
  const k = v.salesforceAccountId?.slice(0, 15);
  return k ? (accounts.find((a) => a.org62AccountId?.slice(0, 15) === k)?.id ?? null) : null;
}

/**
 * VD-06: the VDP company ids VDP answered "not found" for on a create_vdp (merged into another company, or archived):
 * a stored lookup naming one is stale, so it is dropped and the next read looks the name up again.
 */
export function deadCompanyIds(drafts: readonly Pick<Draft, 'status' | 'destination' | 'attempts'>[]): Set<string> {
  const out = new Set<string>();
  for (const d of drafts) {
    if (d.status !== 'failed' || d.destination.kind !== 'action' || d.destination.action !== 'vdp.create_vdp') continue;
    const last = [...(d.attempts ?? [])].reverse().find((a) => !a.dryRun);
    if (!last || !/\(not_found\)/.test(last.detail ?? '')) continue;
    const input = (d.destination.input ?? {}) as { changes?: Array<{ field?: unknown; value?: unknown }>; field?: unknown; value?: unknown };
    const id = (input.changes ?? []).find((c) => c.field === 'company_id')?.value ?? (input.field === 'company_id' ? input.value : null);
    if (typeof id === 'string' && id) out.add(id);
  }
  return out;
}

/**
 * VD-31: the asset candidates the app added to this VDP (an applied add_vdp_asset) that a read after the apply does not
 * show: a person removed them in VDP, so they are never added again.
 */
export function removedInVdp(snap: Pick<VdpSnapshot, 'assets'>, cands: readonly Pick<CandidateRecord, 'id' | 'url'>[], drafts: ReadonlyMap<string, DraftRef>, read: string | null): Set<string> {
  const out = new Set<string>();
  if (!read) return out;
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  const urls = new Set(snap.assets.map((a) => norm(a.url)));
  for (const c of cands) {
    const d = drafts.get(itemKey.asset(c.id));
    if (d?.state === 'applied' && d.at <= read && !urls.has(norm(c.url))) out.add(c.id);
  }
  return out;
}
const period = (v: Pick<GapVdpRow, 'fiscalYear' | 'fiscalQuarter'>) => (v.fiscalYear ?? 0) * 10 + (v.fiscalQuarter ?? 0);

/** Open first (the most the app can fix, then the most open), then waiting, done and past; newest period first. */
function sortRows(rows: VdpCoverageRow[]): VdpCoverageRow[] {
  return [...rows].sort((a, b) => STATE_ORDER[a.status.state] - STATE_ORDER[b.status.state] || b.status.appCanFix - a.status.appCanFix || b.status.open - a.status.open || period(b) - period(a) || a.companyName.localeCompare(b.companyName));
}

/**
 * "Not in VDP yet" (D-63): one row per account with an engaged opp and no current VDP. Its item is the company to
 * create (VDP lacks it) or the VDP to create; `children` are what comes under it (the VDP under a new company, the
 * VDP's people and its use case), `assetItems` the candidates that wait for the VDP; each `requires` what is above it.
 */
function notInVdpRows(
  unlinked: readonly VdpCoveragePayload['unlinked'][number][],
  accounts: readonly Account[],
  ents: { accounts: readonly GapAccount[]; opps: readonly GapOpp[] },
  o: { drafts: ReadonlyMap<string, DraftRef>; lastReadAt: string | null; newVdpUrl: string; caps: VdpCapabilities; server: VdpServerInfo | null; candidates: readonly CandidateRecord[]; byAccount: ReadonlyMap<string, string>; now: string; names?: ReadonlyMap<string, string>; assetHosts: readonly string[] },
): VdpNotInVdpRow[] {
  const rows: VdpNotInVdpRow[] = [];
  const accountIds = [...new Set(unlinked.map((g) => g.accountId).filter((x): x is string => !!x))];
  for (const accountId of accountIds) {
    const gaps = unlinked.filter((g) => g.accountId === accountId);
    // D-69: the node is the company (its group's), named as VDP has it or as it will be created
    const name = o.names?.get(accountId) ?? accounts.find((x) => x.id === accountId)?.name ?? ents.accounts.find((x) => x.id === accountId)?.name ?? 'Account';
    const key = vdpKeyOfAccount(accountId);
    const cands = o.candidates.filter((c) => candidateKey(c, o.byAccount) === key);
    const steps = vdpSteps({ key, companyName: name, vdpLabel: null, gaps, candidates: cands, useCases: [], newVdpUrl: o.newVdpUrl, drafts: o.drafts, lastReadAt: o.lastReadAt, addAsset: true, entitlementCreate: o.caps.entitlementCreate, salesSegments: o.caps.salesSegment ? (o.server?.salesSegments ?? []).map((s) => s.label) : null });
    const root = steps.find((s) => s.kind === 'create_company') ?? steps.find((s) => s.kind === 'create_vdp');
    if (!root) continue;
    const engaged = ents.opps.filter((x) => x.accountId === accountId && x.isOpen && x.dcSplit === 100);
    const above = [root, ...steps.filter((s) => s.kind === 'create_vdp' && s !== root)].map((s) => s.apply?.key).filter((x): x is string => !!x);
    const children = steps
      .filter((s) => s !== root)
      .map((s) => {
        // a new use case's title and priority, from the opp it is for (never auto-applied)
        const suggestion = s.kind === 'create_use_case' && s.state === 'todo' ? suggestionFor(s, { useCase: null, stakeholders: [], opps: engaged, companyName: name, now: o.now }) : null;
        return suggestion ? { ...s, suggestion } : s;
      });
    const assetItems = cands.filter((c) => c.status === 'suggested').map((c) => assetItemOf(c, { slug: newVdpSlug(accountId), server: o.server, caps: o.caps, drafts: o.drafts, read: o.lastReadAt, requires: above, assetHosts: o.assetHosts }));
    const company = gaps.some((g) => g.code === 'company_not_in_vdp');
    const title = root.kind === 'create_company' ? `${name} is not in VDP` : company ? `${name} has no VDP` : `${name} has no current VDP`;
    rows.push({ key, accountId, opportunityId: gaps[0]?.opportunityId ?? null, title, step: root, status: vdpStatusOf([root, ...children], 'current', o.lastReadAt), children, assetItems });
  }
  const order = { open: 0, waiting: 1, waiting_dc: 2, done: 3, past: 4 } as const;
  return rows.sort((a, b) => order[a.status.state] - order[b.status.state] || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Staging: one item's Apply → one Outbox action
// ---------------------------------------------------------------------------

const UC_KEY: Record<string, keyof VdpUseCase> = {
  title: 'title',
  priority: 'priority',
  division: 'division',
  persona: 'persona',
  details_input: 'detailsInput',
  execution_phase: 'executionPhase',
  execution_start_date: 'executionStartDate',
  execution_target_date: 'executionTargetDate',
  execution_duration_value: 'executionDurationValue',
  execution_duration_unit: 'executionDurationUnit',
};
const HEADER_KEY: Record<string, keyof VdpSnapshot> = {
  fiscal_year: 'fiscalYear',
  fiscal_quarter: 'fiscalQuarter',
  salesforce_account_id: 'salesforceAccountId',
  salesforce_opportunity_id: 'salesforceOpportunityId',
};

/** The VDP tab a change lands on (the target's deep link). */
function tabLink(snap: Pick<VdpSnapshot, 'url'> | null | undefined, tab: string): string | null {
  return snap?.url ? `${snap.url}${snap.url.includes('?') ? '&' : '?'}tab=${tab}` : null;
}

function destination(op: VdpOp, target: { label: string; url: string | null }, input: VdpActionInput): ActionDestination {
  const changes = (input.changes.length ? input.changes : [{ field: input.field, before: input.before, value: input.value }]).map((c) => ({ label: VDP_FIELD_LABEL[c.field] ?? c.field, before: showVdpValue(c.before), after: showVdpValue(c.value) }));
  return { kind: 'action', action: `vdp.${op}`, target, input, changes, text: null };
}

/** One open item, wherever it lives (a VDP's items and assets, a Not-in-VDP row and what comes under it). */
export interface FoundItem {
  /** The step (null for an asset to add). */
  step: VdpStep | null;
  apply: VdpApply;
  state: VdpStep['state'];
  draftId: string | null;
  requires: string[];
  disabled: string | null;
  suggestion: Record<string, string> | null;
  /** The VDP it targets (null: one that does not exist yet). */
  vdpSlug: string | null;
  companyName: string;
  title: string;
  /** add_vdp_asset: the candidate it adds. */
  candidateId: string | null;
}

/** Where an item lives: its step (a VDP's, or a Not-in-VDP row's or its children's) or its asset, and its VDP. */
export function findVdpItem(cov: Pick<VdpCoveragePayload, 'vdps' | 'notInVdp'>, key: string): FoundItem | null {
  const ofStep = (s: VdpStep, vdpSlug: string | null, companyName: string): FoundItem => ({ step: s, apply: s.apply!, state: s.state, draftId: s.draftId, requires: s.requires ?? [], disabled: s.disabled ?? null, suggestion: s.suggestion?.values ?? null, vdpSlug, companyName, title: s.title, candidateId: null });
  const ofAsset = (x: VdpAssetItem, vdpSlug: string | null, companyName: string): FoundItem => ({ step: null, apply: x.apply!, state: x.state, draftId: x.draftId, requires: x.requires ?? [], disabled: x.disabled ?? null, suggestion: null, vdpSlug, companyName, title: `Add ${x.title}`, candidateId: x.candidateId });
  for (const r of cov.vdps) {
    for (const s of r.steps) if (s.apply?.key === key) return ofStep(s, r.vdpSlug, r.companyName);
    for (const x of r.assetItems ?? []) if (x.apply?.key === key) return ofAsset(x, r.vdpSlug, r.companyName);
  }
  for (const r of cov.notInVdp) {
    const name = r.title.replace(/ (has no VDP|is not in VDP|has no current VDP)$/, '');
    for (const s of [r.step, ...(r.children ?? [])]) if (s.apply?.key === key) return ofStep(s, null, name);
    for (const x of r.assetItems ?? []) if (x.apply?.key === key) return ofAsset(x, null, name);
  }
  return null;
}

/** The asset an `asset:<id>` item adds (the candidate view carries its Apply). */
export interface ApplyableCandidate {
  id: string;
  vdpSlug: string | null;
  title: string;
  apply: VdpApply | null;
  draftId: string | null;
}

/** What a parent item made, for the items under it (D-63): the new id, and a new VDP's slug and link. */
export interface ResolvedParent {
  id: string | null;
  slug?: string | null;
  url?: string | null;
}

/** The ids an item takes from its parents: the real one once applied, else a placeholder the payload names (`pending`). */
export function resolveIds(src: IdSources, resolved: ReadonlyMap<string, ResolvedParent>): { ids: { companyId?: string; vdpId?: string; useCaseId?: string; vdpSlug?: string | null; vdpUrl?: string | null }; pending: VdpActionInput['pending'] } {
  const ids: { companyId?: string; vdpId?: string; useCaseId?: string; vdpSlug?: string | null; vdpUrl?: string | null } = {};
  const pending: NonNullable<VdpActionInput['pending']> = {};
  for (const k of ['companyId', 'vdpId', 'useCaseId'] as const) {
    const parent = src[k];
    if (!parent) continue;
    const r = resolved.get(parent);
    if (r?.id) {
      ids[k] = r.id;
      if (k === 'vdpId') {
        ids.vdpSlug = r.slug ?? null;
        ids.vdpUrl = r.url ?? null;
      }
    } else pending[k] = parent;
  }
  return { ids, pending: Object.keys(pending).length ? pending : null };
}

/** Fields whose values are VDP's lookups (`list_asset_types`): a typed value must be one of the item's options. */
const LOOKUP_FIELDS: ReadonlySet<string> = new Set(['asset_type', 'deliverable_type']);

/**
 * The Outbox action for one item's Apply (`itemKey` + what you typed): rebuilt from the mirror, never from the
 * client's ids, so the call is exactly the item the page shows. Each field takes your value, else the suggestion;
 * a fixed field (an id the app knows) always its suggestion. Refuses an item that is staged or applied already
 * (unless the push stages it again, `restage`), or one VDP's MCP can't take yet.
 *
 * D-63: an item under a parent (a VDP under a new company, anything under a new VDP, the Generate of a new use case)
 * takes the parent's new id from `resolved` once the parent is applied; until then its payload carries a placeholder
 * and names the parent in `pending` (a dry run records it, nothing sends it).
 */
/**
 * D-67: why a new use case would be a duplicate (it is already in VDP, in Org62 or on its way), or null. Built by the
 * DataSource from both systems (src/server/deals/use-cases.ts ucDuplicateGuard); absent: no check.
 */
export type UseCaseDuplicateCheck = (title: string, scope: { vdpSlug?: string | null; accountId?: string | null; excludeRecord?: string | null }) => string | null;

export function vdpActionForItem(cov: VdpCoveragePayload, snaps: readonly VdpSnapshot[], req: Pick<DraftVdpUpdateRequest, 'itemKey' | 'values'>, candidates: readonly ApplyableCandidate[] = [], o: { resolved?: ReadonlyMap<string, ResolvedParent>; restage?: boolean; duplicateOf?: UseCaseDuplicateCheck } = {}): ActionDestination {
  const key = req.itemKey!;
  const cand = key.startsWith('asset:') && !findVdpItem(cov, key) ? candidates.find((c) => itemKey.asset(c.id) === key) : undefined;
  const hit: FoundItem | null = cand?.apply ? { step: null, apply: cand.apply, state: cand.draftId ? 'staged' : 'todo', draftId: cand.draftId, requires: [], disabled: null, suggestion: null, vdpSlug: cand.vdpSlug, companyName: '', title: cand.title, candidateId: cand.id } : findVdpItem(cov, key);
  if (!hit) throw notFound('VDP item', key);
  if (!o.restage && hit.state === 'staged') throw invalid('Already staged: review and Apply it on Activity ▸ VDP');
  // VD-23: a create that may have reached VDP goes only through a push, which looks in VDP first
  if (!o.restage && hit.state === 'maybe_made') throw invalid('Maybe made already: push it, and the app looks in VDP before sending it again');
  if (hit.state === 'waiting') throw invalid('Applied: the next VDP read confirms it');
  if (hit.disabled) throw invalid(hit.disabled);
  const { apply } = hit;
  const typed = req.values ?? {};
  const changes: VdpFieldChange[] = [];
  let track: 'd360' | 'agentforce' | null = null;
  const src = idSources({ op: apply.op, requires: hit.requires });
  const { ids, pending } = resolveIds(src, o.resolved ?? new Map());
  for (const f of apply.fields) {
    if (f.field === 'company_id' && src.companyId) continue; // the new company's (below)
    const own = typed[f.field];
    const typedOrSuggested = f.fixed || own === undefined || own.trim() === '' ? f.suggested : own;
    if (typedOrSuggested === null || typedOrSuggested === undefined || (typeof typedOrSuggested === 'string' && typedOrSuggested.trim() === '') || (Array.isArray(typedOrSuggested) && !typedOrSuggested.length)) {
      if (f.required) throw invalid(`${f.label} is needed`);
      continue;
    }
    // an asset's Type and Deliverable are VDP's own lookups: one of its labels, as VDP spells it
    const lookup = LOOKUP_FIELDS.has(f.field) && f.options.length ? matchLookup(String(typedOrSuggested), f.options) : undefined;
    if (lookup === null) throw invalid(`${f.label} is one of VDP's: ${f.options.join(', ')}`);
    const raw = lookup ?? typedOrSuggested;
    if (f.field === 'track') {
      track = String(raw) === 'agentforce' ? 'agentforce' : 'd360';
      continue;
    }
    const c = coerceVdpValue(apply.op, f.field, raw);
    if (!c.ok) throw invalid(c.error);
    if (f.current !== null && String(f.current) === String(c.value)) continue;
    changes.push({ field: f.field, before: f.current ?? null, value: c.value });
  }
  if (src.companyId) changes.unshift({ field: 'company_id', before: null, value: ids.companyId ?? '' });
  if (apply.op === 'generate_use_case') changes.push({ field: 'ai_fields', before: null, value: 'generate' });
  if (!changes.length) throw invalid('Type at least one value: an item fills or changes a field, it never clears one');

  const snap = hit.vdpSlug ? snaps.find((s) => s.slug === hit.vdpSlug) : undefined;
  if (hit.vdpSlug && !snap) throw notFound('VDP', hit.vdpSlug);
  const gap = hit.step?.gaps[0];
  const uc = gap?.useCaseId && snap ? snap.useCases.find((u) => u.id === gap.useCaseId) : undefined;
  const ucTitle = uc ? uc.title?.trim() || 'Untitled use case' : null;
  const first = changes[0]!;
  const accountKey = key.startsWith('account:') ? key.replace(/:(create_(vdp|company)|new_vdp:.*)$/, '') : null;
  // D-67: a new use case is checked against both systems and what is on its way before it is staged
  if (apply.op === 'create_use_case' && o.duplicateOf) {
    const title = changes.find((c) => c.field === 'title')?.value;
    const fx = gap?.fix.kind === 'app' ? gap.fix : null;
    const dup = typeof title === 'string' ? o.duplicateOf(title, { vdpSlug: hit.vdpSlug, accountId: accountKey ? accountKey.replace(/^account:/, '') : null, excludeRecord: fx?.values?.org62_use_case_id ? String(fx.values.org62_use_case_id) : null }) : null;
    if (dup) throw new AppError('conflict', dup);
  }
  const input: VdpActionInput = {
    // a new VDP's own slug once the push knows it (its read-back reads it), else the account's details key
    vdpSlug: snap?.slug ?? ids.vdpSlug ?? accountKey ?? key,
    vdpId: snap?.id ?? ids.vdpId ?? '',
    useCaseId: apply.op === 'update_use_case' || apply.op === 'generate_use_case' ? (uc?.id ?? gap?.useCaseId ?? ids.useCaseId ?? null) : null,
    useCaseTitle: ucTitle,
    track: apply.op === 'create_use_case' ? (track ?? 'd360') : null,
    field: first.field,
    before: first.before,
    value: first.value,
    changes,
    itemKey: key,
    candidateId: hit.candidateId ?? cand?.id ?? null,
    pending,
  };
  const label = snap ? vdpLabel(snap) : hit.companyName || hit.title;
  const what: Record<VdpOp, string> = {
    update_use_case: ucTitle ?? 'use case',
    create_use_case: `new ${input.track === 'agentforce' ? 'Agentforce' : 'D360'} use case`,
    update_vdp_header: apply.fields.some((f) => f.field === 'add_opportunity_ids' || f.field === 'remove_opportunity_ids') ? 'opportunities' : apply.fields.some((f) => f.field === 'entitlement_leveraged') ? 'entitlement leveraged' : 'header',
    create_vdp: 'new VDP',
    create_company: 'new company in VDP',
    add_vdp_asset: `asset · ${hit.title.replace(/^Add /, '')}`.trim(),
    set_vdp_owners: apply.fields.some((f) => f.field === 'account_executives') ? 'AE' : 'TA',
    generate_use_case: `${ucTitle ?? 'use case'} · Generate`,
  };
  const tab = apply.op === 'add_vdp_asset' ? 'assets' : apply.op === 'update_use_case' || apply.op === 'create_use_case' || apply.op === 'generate_use_case' ? (uc?.track === 'agentforce' || input.track === 'agentforce' ? 'agentforce' : 'd360') : 'header';
  const url = snap ? tabLink(snap, tab) : ids.vdpUrl ? tabLink({ url: ids.vdpUrl }, tab) : null;
  return destination(apply.op, { label: `${label} · ${what[apply.op]}`, url }, input);
}

/**
 * D-63: a staged item that waited for its parents, with the ids they now have (the same call, the same values). Null
 * when nothing changed. `vdpSlug` becomes the new VDP's (its read-back reads it), the link its tab.
 */
export function rebaseVdpAction(dest: ActionDestination, resolved: ReadonlyMap<string, ResolvedParent>): ActionDestination | null {
  const parsed = VdpActionInput.safeParse(dest.input);
  if (!parsed.success || !parsed.data.pending) return null;
  const input = parsed.data;
  const pend = { ...input.pending! };
  let changes = input.changes.length ? [...input.changes] : [{ field: input.field, before: input.before, value: input.value }];
  let vdpId = input.vdpId;
  let vdpSlug = input.vdpSlug;
  let useCaseId = input.useCaseId;
  let url = dest.target.url;
  let changed = false;
  const c = pend.companyId ? resolved.get(pend.companyId) : undefined;
  if (pend.companyId && c?.id) {
    changes = changes.map((x) => (x.field === 'company_id' ? { ...x, value: c.id! } : x));
    delete pend.companyId;
    changed = true;
  }
  const v = pend.vdpId ? resolved.get(pend.vdpId) : undefined;
  if (pend.vdpId && v?.id) {
    vdpId = v.id;
    vdpSlug = v.slug ?? vdpSlug;
    url = v.url ? tabLink({ url: v.url }, dest.action === 'vdp.add_vdp_asset' ? 'assets' : dest.action.includes('use_case') ? (input.track === 'agentforce' ? 'agentforce' : 'd360') : 'header') : url;
    delete pend.vdpId;
    changed = true;
  }
  const u = pend.useCaseId ? resolved.get(pend.useCaseId) : undefined;
  if (pend.useCaseId && u?.id) {
    useCaseId = u.id;
    delete pend.useCaseId;
    changed = true;
  }
  if (!changed) return null;
  const first = changes[0]!;
  const next: VdpActionInput = { ...input, vdpId, vdpSlug, useCaseId, changes, field: first.field, before: first.before ?? null, value: first.value, pending: Object.keys(pend).length ? pend : null };
  return destination(dest.action.slice(4) as VdpOp, { label: dest.target.label, url }, next);
}


/**
 * The Outbox action for one legacy field change (the Assistant's `chat_vdp_update`), from the mirrored VDP (`before`
 * is what the mirror read). Validates the op/field pair and the value against the field's rules; a value VDP would
 * refuse is refused here first.
 */
export function vdpActionFor(snap: VdpSnapshot, req: DraftVdpUpdateRequest, o: { duplicateOf?: UseCaseDuplicateCheck } = {}): ActionDestination {
  if (!req.op || !req.field || req.value === undefined) throw invalid('Say which change: an item (itemKey) or op, field and value');
  const op = req.op;
  if (op !== 'update_use_case' && op !== 'create_use_case' && op !== 'update_vdp_header') throw invalid(`${op} is staged from its item (itemKey), not as one field`);
  const c = coerceVdpValue(op, req.field, req.value);
  if (!c.ok) throw invalid(c.error);
  const make = (target: string, tab: string, input: Omit<VdpActionInput, 'vdpSlug' | 'vdpId' | 'field' | 'value' | 'changes' | 'itemKey' | 'candidateId' | 'pending'>): ActionDestination => {
    const full: VdpActionInput = { vdpSlug: snap.slug, vdpId: snap.id, field: req.field!, value: c.value, changes: [], itemKey: null, candidateId: null, pending: null, ...input };
    return destination(op, { label: target, url: tabLink(snap, tab) }, { ...full, itemKey: vdpItemKeyOf(`vdp.${op}`, full) });
  };
  if (op === 'update_use_case') {
    if (!(VDP_UPDATE_USE_CASE_FIELDS as readonly string[]).includes(req.field)) throw invalid(`update_use_case has no field ${req.field}`);
    const u = snap.useCases.find((x) => x.id === req.useCaseId);
    if (!u) throw notFound('Use case', req.useCaseId ?? '(none)');
    const title = u.title?.trim() || 'Untitled use case';
    const before = (u[UC_KEY[req.field]!] as string | number | null) ?? null;
    if (before !== null && String(before) === String(c.value)) throw invalid(`${req.field} already is that value in VDP: nothing to change`);
    return make(`${vdpLabel(snap)} · ${title}`, u.track === 'agentforce' ? 'agentforce' : 'd360', { useCaseId: u.id, useCaseTitle: title, track: null, before });
  }
  if (op === 'create_use_case') {
    if (!(VDP_CREATE_USE_CASE_FIELDS as readonly string[]).includes(req.field) || req.field !== 'title') throw invalid('A new use case starts from its title');
    const track = req.track ?? 'd360';
    // D-67: never a use case either system (or a staged item) already has
    const dup = typeof c.value === 'string' ? o.duplicateOf?.(c.value, { vdpSlug: snap.slug }) : null;
    if (dup) throw new AppError('conflict', dup);
    return make(`${vdpLabel(snap)} · new ${track === 'agentforce' ? 'Agentforce' : 'D360'} use case`, track, { useCaseId: null, useCaseTitle: null, track, before: null });
  }
  if (!(VDP_HEADER_FIELDS as readonly string[]).includes(req.field)) throw invalid(`update_vdp_header has no field ${req.field}`);
  const before = HEADER_KEY[req.field] ? ((snap[HEADER_KEY[req.field]!] as string | number | null) ?? null) : null;
  if (before !== null && String(before) === String(c.value)) throw invalid(`${req.field} already is that value in VDP: nothing to change`);
  return make(vdpLabel(snap), 'header', { useCaseId: null, useCaseTitle: null, track: null, before });
}

/** Capabilities from the stored server info (for callers that only need the flags). */
export const capabilitiesOf = (server: VdpServerInfo | null | undefined): VdpCapabilities => vdpCapabilities(server);

/**
 * A pending-approval Outbox draft for one structured action: read-only (the doc is its summary), mode `send`
 * (Apply), destination and mode locked.
 */
export function actionDraftFor(dest: ActionDestination, o: { id: string; now: string; workItemId?: string | null; rendered: (doc: Draft['doc']) => Draft['rendered'] }): Draft {
  const doc = actionDoc(dest);
  return {
    id: o.id,
    version: 1,
    workItemId: o.workItemId ?? null,
    nbaId: null,
    destination: dest,
    mode: 'send',
    doc,
    plainText: actionSummary(dest),
    rendered: o.rendered(doc),
    userTouched: false,
    userLockedFields: ['doc', 'destination', 'mode'],
    status: 'ready',
    threadContext: [],
    createdAt: o.now,
    updatedAt: o.now,
    savedAt: null,
    scheduledFor: null,
    attempts: [],
    verification: null,
    rejectedReason: null,
    resultUrl: null,
  };
}
