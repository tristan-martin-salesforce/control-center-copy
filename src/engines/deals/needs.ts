/**
 * Deals ▸ "what needs you on a deal", computed once on the server (both DataSources call `dealsNeeds` with what they
 * already read; getDeals returns the rows, getAccount the account's, and the Assistant reads the same rows through
 * `chat_app_read getDeals`). Pure: the same input gives the same rows.
 *
 *   Log & fix     a DC gap (`dcGapOf`): an account with ≥ 1 OPEN opp that has no DC of mine (no `myDc`, Org62 shows
 *                 none) and no DC request in flight (DC-12: a live one: not withdrawn, not confirmed, not "not
 *                 created"), where at least one of these holds:
 *                   - I'm on its opp team;
 *                   - I logged ≥ 1 h on it this quarter;
 *                   - the missed-opp sweep has a Claim finding on it (status new);
 *                   - a VDP I'm on (AE, TA, collaborator, creator) links it (DC-32, the VDP mirror).
 *                 An opp with amount 0 or none counts ONLY when I'm on its team: a $0 renewal I logged a couple of
 *                 hours to is not a DC to claim (strong evidence only). `dcStatus: 'partial'` on its own is never a
 *                 gap. The row names exactly those opps and why ("1 opp with your hours and no DC: <opp>"); Claim DC
 *                 opens the claim form on the first one, in place on the account page.
 *   Think ahead   an account whose next close (my open opps) is within 45 days, or has passed.
 *   Chase         a DC request handed to Slackbot on a canvas and not in Org62 yet (DC-06: from the requests, the
 *                 same on both DataSources; Postgres never wrote the old account status "requested").
 *
 * Every row says how it can be set aside (`resolve`, src/contract/needs.ts): a DC gap is Not needed per opp ("Not my
 * deal", "Already covered by a teammate", "Too small", "Other"); Think ahead and Chase rows Snooze 1 week or Not
 * needed. A set-aside DC gap comes back only when something material changes: I join the opp team, I log ≥ 2 h more
 * on it after the decision, or once, a call on its account after it (D-103 (d): the one dismissal rule,
 * src/engines/attribution/resurface.ts; its reason leads the opp's evidence); the baseline names its fiscal quarter
 * (DC-30), so in a new quarter 2 h of that quarter's work bring it back.
 *
 * Personas (D-55): without deal contributions there are no DC-gap or Chase rows and no DC words; without the
 * missed-opp sweep its findings are not evidence here.
 */
import { DC_GAP_REASONS, DEALS_ROW_REASONS, type AccountRow, type DcGapOpp, type DcGapReason, type DealsNeed, type MissedOpp, type NeedBaseline, type NeedDecision, type Opportunity } from '@/contract';
import { sfrQuarterOfDay } from '@/engines/forecast/time';
import { daysUntil, fmtAmount, fmtDate, fmtHours } from '@/lib/deals-format';
import { dcGapResurfaced, decisionIndex, isSetAside, needKey } from '@/lib/need-decisions';
import { featureActive } from '@/personas/gates';
import type { ResolvedPersona } from '@/personas/types';

/** The Deals features active for the persona: deal contributions, VDP, the missed-opp sweep. */
export interface DealsFeatures {
  dc: boolean;
  vdp: boolean;
  missed: boolean;
}

/** Everything on: the SE preset, and what every caller got before personas. */
export const ALL_DEALS_FEATURES: Readonly<DealsFeatures> = { dc: true, vdp: true, missed: true };

/** The Deals features of a resolved persona (all off while it loads: gated words stay hidden until settings arrive). */
export function dealsFeaturesOf(p: ResolvedPersona | null | undefined): DealsFeatures {
  return { dc: featureActive(p, 'dealContributions'), vdp: featureActive(p, 'vdp'), missed: featureActive(p, 'missedOpps') };
}

export const CLOSE_SOON_DAYS = 45;
/** Hours this quarter on an opp that count as evidence it is mine. */
export const DC_GAP_MIN_HOURS = 1;

export type GapOpp = Pick<Opportunity, 'id' | 'accountId' | 'name' | 'amount' | 'isOpen' | 'isMine' | 'dcAssigned' | 'myDc' | 'hoursQtd'>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The facts a DC gap's Not needed is compared against later: on the team, hours this quarter, and which fiscal quarter
 * those hours are of ("FY27 Q4", DC-30: hours QTD start again at 0 each quarter). `today`: the user's day.
 */
export const dcGapBaseline = (o: Pick<Opportunity, 'isMine' | 'hoursQtd'>, today?: string, lastCallAt?: string | null): NeedBaseline => ({
  onTeam: o.isMine,
  hoursQtd: Math.round((o.hoursQtd ?? 0) * 100) / 100,
  ...(today ? { quarter: sfrQuarterOfDay(today) } : {}),
  // D-103 (d): the last call on its account then (a later call brings the gap back once)
  ...(lastCallAt !== undefined ? { lastCallAt } : {}),
});

/**
 * One opp as a DC gap, or null (the rule in the module comment). `claim`: the sweep's Claim finding on it, if any;
 * `requested`: a DC request in flight on it; `vdp`: a VDP I'm on links it (DC-32).
 */
export function dcGapOf(o: GapOpp, claim: Pick<MissedOpp, 'evidence'> | undefined, requested: boolean, vdp = false): DcGapOpp | null {
  if (!o.isOpen || o.myDc || o.dcAssigned || requested) return null;
  const hours = o.hoursQtd ?? 0;
  const reasons: DcGapReason[] = [];
  if (o.isMine) reasons.push('team');
  if (hours >= DC_GAP_MIN_HOURS) reasons.push('hours');
  if (claim) reasons.push('sweep');
  if (vdp) reasons.push('vdp');
  if (!reasons.length) return null;
  // amount 0 or none: only an opp I'm on the team of (a $0 renewal with my hours on it is no DC to claim)
  if (!(o.amount !== null && o.amount > 0) && !o.isMine) return null;
  return { oppId: o.id, oppName: o.name, amount: o.amount, hoursQtd: hours, onTeam: o.isMine, reasons, evidence: claim?.evidence ?? [] };
}

/** "you're on" / "with your hours" / "a VDP you're on links" / "that looks like yours" (the sweep): the strongest reason, in words. */
function reasonWords(g: DcGapOpp): string {
  if (g.reasons.includes('team')) return "you're on";
  if (g.reasons.includes('hours')) return 'with your hours';
  if (g.reasons.includes('vdp')) return "on a VDP you're on";
  return 'that looks like yours'; // the missed-opp sweep's claim, in a seller's words
}

/** The row's why: the count of exactly the gap opps and why, naming the opp when there is one. */
export function dcGapWhy(gaps: readonly DcGapOpp[]): string {
  const hours = gaps.reduce((s, g) => s + g.hoursQtd, 0);
  const tail = [hours > 0 ? `${fmtHours(Math.round(hours * 100) / 100)} QTD` : null].filter(Boolean);
  if (gaps.length === 1) {
    const g = gaps[0]!;
    const how = reasonWords(g);
    const lead = how === "you're on" ? `1 opp you're on with no DC: ${g.oppName}` : `1 opp ${how} and no DC: ${g.oppName}`;
    return [lead, ...tail].join(' · ');
  }
  const team = gaps.filter((g) => g.reasons.includes('team')).length;
  const withHours = gaps.filter((g) => !g.reasons.includes('team') && g.reasons.includes('hours')).length;
  const onVdp = gaps.filter((g) => !g.reasons.includes('team') && !g.reasons.includes('hours') && g.reasons.includes('vdp')).length;
  const sweep = gaps.length - team - withHours - onVdp;
  const parts = [team ? `${team} you're on` : null, withHours ? `${withHours} with your hours` : null, onVdp ? `${onVdp} on a VDP you're on` : null, sweep ? `${sweep} that look like yours` : null].filter(Boolean);
  return [`${plural(gaps.length, 'opp')} without your DC (${parts.join(', ')})`, ...tail].join(' · ');
}

/** The claim form's evidence line for an opp (strong evidence only): hours this quarter, the team, a VDP, the sweep. */
export function dcGapEvidence(g: Pick<DcGapOpp, 'hoursQtd' | 'onTeam' | 'evidence'> & Partial<Pick<DcGapOpp, 'reasons'>>): string {
  return [
    g.hoursQtd > 0 ? `You logged ${fmtHours(Math.round(g.hoursQtd * 100) / 100)} on it this quarter` : null,
    g.onTeam ? "You're on the opp team" : 'Not on the opp team',
    g.reasons?.includes('vdp') ? "A VDP you're on links it" : null,
    ...g.evidence.slice(0, 2),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A DC request a canvas handed to Slackbot that Org62 doesn't show yet (Chase, from the requests). */
export interface ChaseRequest {
  oppId: string;
  oppName: string;
  /** When it went to Slackbot (its last change). */
  since: string;
}

export interface DealsNeedsInput {
  /** The Deals list rows (my open opps per account: openOpps, nextCloseDate, pipeline). */
  accounts: readonly AccountRow[];
  /** Every opp the app has (the gap rule looks at all of an account's open opps). */
  opps: readonly GapOpp[];
  /** The missed-opp sweep's findings. */
  missed: readonly MissedOpp[];
  /** Opps with a DC request in flight (DC-12: requested, on a canvas, with Slackbot; never a confirmed one). */
  requestedOppIds: ReadonlySet<string>;
  /** DC-32: open opps a live VDP I'm on links (the VDP mirror). */
  vdpOppIds?: ReadonlySet<string>;
  /** DC-06: requests with Slackbot and not in Org62 yet: Chase. */
  chase?: readonly ChaseRequest[];
  /** Snooze / Not needed decisions (listNeedDecisions). */
  decisions: readonly NeedDecision[];
  /** D-103 (d): the last call on each account (`lastCallsByAccount`; absent: calls never bring a gap back). */
  calls?: ReadonlyMap<string, string>;
  /** The user's time zone (the call's date in a reason). */
  timezone?: string;
  /** Today, the user's calendar day (YYYY-MM-DD). */
  today: string;
  /** Now (ISO): snoozes end. */
  now: string;
  features?: DealsFeatures;
}

/** Every "needs you" row on Deals, set-aside rows left out, sorted inside their sections. */
export function dealsNeeds(input: DealsNeedsInput): DealsNeed[] {
  const f = input.features ?? ALL_DEALS_FEATURES;
  const decisions = decisionIndex(input.decisions as NeedDecision[]);
  const claims = new Map<string, MissedOpp>();
  if (f.missed) for (const m of input.missed) if (m.status === 'new' && m.verdict === 'claim' && m.oppId && !claims.has(m.oppId)) claims.set(m.oppId, m);
  const oppsOf = new Map<string, GapOpp[]>();
  for (const o of input.opps) if (o.accountId) oppsOf.set(o.accountId, [...(oppsOf.get(o.accountId) ?? []), o]);
  const oppAccount = new Map(input.opps.map((o) => [o.id, o.accountId] as const));
  const rows: DealsNeed[] = [];
  for (const a of input.accounts) {
    // Log & fix: exactly the opps that are DC gaps, minus the ones set aside (until something material changes)
    if (f.dc) {
      const gaps = (oppsOf.get(a.id) ?? [])
        .map((o) => ({ o, g: dcGapOf(o, claims.get(o.id), input.requestedOppIds.has(o.id), f.vdp && !!input.vdpOppIds?.has(o.id)) }))
        .map((x) => ({ ...x, now: { ...dcGapBaseline(x.o, input.today, input.calls?.get(a.id) ?? null), accountName: a.name, ...(input.timezone ? { timezone: input.timezone } : {}) } as NeedBaseline }))
        .filter((x): x is { o: GapOpp; g: DcGapOpp; now: NeedBaseline } => !!x.g && !isSetAside(decisions, 'dc_gap', x.o.id, input.now, x.now))
        .map((x) => withReturnReason(x.g, decisions.get(needKey('dc_gap', x.o.id)), x.now))
        .sort((x, y) => Number(y.onTeam) - Number(x.onTeam) || y.hoursQtd - x.hoursQtd || (y.amount ?? 0) - (x.amount ?? 0) || x.oppName.localeCompare(y.oppName));
      if (gaps.length) {
        const first = gaps[0]!;
        const amount = gaps.reduce((s, g) => s + (g.amount ?? 0), 0);
        rows.push({
          id: `fix:${a.id}`,
          section: 'fix',
          accountId: a.id,
          accountName: a.name,
          title: gaps.length === 1 ? `${a.name}: no DC on ${first.oppName}` : `${a.name}: no DC on ${gaps.length} opps`,
          why: dcGapWhy(gaps),
          badge: a.myDcs.length ? 'DC partial' : 'No DC',
          tone: 'warning',
          verb: { label: 'Claim DC', href: `/deals/${a.id}?claim=${encodeURIComponent(first.oppId)}` },
          rank: -(gaps.reduce((s, g) => s + g.hoursQtd, 0) * 1_000_000 + amount / 1000),
          claimOppId: first.oppId,
          opps: gaps,
          resolve: { rule: 'dc_gap', subjectIds: gaps.map((g) => g.oppId), snooze: false, reasons: [...DC_GAP_REASONS], baseline: {}, label: gaps.map((g) => g.oppName).join(', ').slice(0, 200) },
        });
      }
    }

    // Think ahead: closing soon, or the close date has passed on an open opp of mine.
    if (a.openOpps > 0 && a.nextCloseDate) {
      const n = daysUntil(a.nextCloseDate, input.today);
      const baseline = { nextCloseDate: a.nextCloseDate };
      if (n <= CLOSE_SOON_DAYS && !isSetAside(decisions, 'deals_ahead', a.id, input.now, baseline)) {
        const passed = n < 0;
        rows.push({
          id: `ahead:${a.id}`,
          section: 'ahead',
          accountId: a.id,
          accountName: a.name,
          title: passed ? `${a.name}: close date passed` : `${a.name} closes ${fmtDate(a.nextCloseDate)}`,
          why: [plural(a.openOpps, 'open opp'), fmtAmount(a.pipelineAmount), a.openTasks ? plural(a.openTasks, 'open task') : 'no open tasks'].join(' · '),
          badge: passed ? `${-n}d past close` : n <= 14 ? (n === 0 ? 'Closes today' : `In ${n}d`) : null,
          tone: passed ? 'danger' : n <= 14 ? 'warning' : 'none',
          verb: { label: 'Open account', href: `/deals/${a.id}` },
          rank: n,
          claimOppId: null,
          opps: [],
          resolve: { rule: 'deals_ahead', subjectIds: [a.id], snooze: true, reasons: [...DEALS_ROW_REASONS], baseline, label: a.name },
        });
      }
    }

    // Chase: a DC you asked for that went to Slackbot and hasn't landed in Org62 (DC-06: from the requests)
    const chase = f.dc ? (input.chase ?? []).filter((c) => oppAccount.get(c.oppId) === a.id).sort((x, y) => x.since.localeCompare(y.since)) : [];
    if (chase.length && !isSetAside(decisions, 'deals_chase', a.id, input.now)) {
      rows.push({
        id: `chase:${a.id}`,
        section: 'chase',
        accountId: a.id,
        accountName: a.name,
        title: chase.length === 1 ? `${a.name}: DC requested on ${chase[0]!.oppName}` : `${a.name}: ${chase.length} DCs requested`,
        why: `With Slackbot since ${fmtDate(chase[0]!.since.slice(0, 10))}, not in Org62 yet · ${plural(a.openOpps, 'open opp')}`,
        badge: null,
        tone: 'none',
        verb: { label: 'Open account', href: `/deals/${a.id}` },
        rank: 0,
        claimOppId: null,
        opps: [],
        resolve: { rule: 'deals_chase', subjectIds: [a.id], snooze: true, reasons: [...DEALS_ROW_REASONS], baseline: {}, label: a.name },
      });
    }
  }
  return rows.sort((x, y) => x.rank - y.rank || x.id.localeCompare(y.id));
}

/** The decision baseline for a DC gap subject (the server reads it from the opp; the client never sends one). */
export function dcGapBaselines(opps: readonly GapOpp[], ids: readonly string[], today?: string, calls?: ReadonlyMap<string, string>, at?: string): Map<string, NeedBaseline> {
  const by = new Map(opps.map((o) => [o.id, o] as const));
  const one = (o: GapOpp): NeedBaseline => ({ ...dcGapBaseline(o, today, calls ? (calls.get(o.accountId) ?? null) : undefined), ...(at ? { at } : {}) });
  return new Map(ids.map((id) => [id, by.get(id) ? one(by.get(id)!) : {}] as const));
}

/** A gap that came back after a Not needed says why first (D-103 (d): "You met Acme on Nov 24, after you set this aside"). */
function withReturnReason(g: DcGapOpp, d: NeedDecision | undefined, now: NeedBaseline): DcGapOpp {
  const back = d && d.kind === 'not_needed' ? dcGapResurfaced(d.baseline ?? {}, now, d.decidedAt) : null;
  return back ? { ...g, evidence: [back.text, ...g.evidence] } : g;
}
