/**
 * Time rows through the attribution engine: what pre-fills a row's opportunity on Time ▸ Needs you and on the
 * logging canvas (the "canvas pre-fill", the third of the three guessers in activity.ts's comment). Pure over contract
 * records, so the mock and the db DataSource attach the same suggestion to the same row.
 *
 * Two layers:
 *   legacy   the old deterministic rules (moved here from src/lib/time-suggest.ts `ruleSuggestion`, unchanged): the
 *            meeting's own opp; the row's account (its only open opp, else the one you logged to last); an account its
 *            evidence names; an attendee's domain or a Slack channel's name. Fixed confidences (RULE_CONFIDENCE), so a
 *            row with nothing learned reads exactly as before.
 *   engine   `attribute()` over the row's signal with the legacy pick as one reason, plus what the old rules never
 *            read: learned rules (mapping_rules), the confirmed channel map, my engagement, covered AEs. A learned rule
 *            or the channel map that points elsewhere, and is surer, wins; one that agrees raises the confidence and
 *            says so. The ranked alternates (`suggestions`, top 3) come from the engine either way.
 */
import type { Account, ActivityEntry, ActivitySuggestion, AgentRun, Asset, CalendarEvent, OppOption, Opportunity, Person } from '@/contract';
import { buildOppOptions, evidenceTies } from '@/lib/opp-options';
import { attribute, type AttributeExtra } from './score';
import { domainOfEmail } from './text';
import type { Attribution, Candidate, CoveredAeRef, EngagementSummary, LearnedRule, Signal, World, WorldOpp } from './types';

/** The fixed confidence of each legacy rule (Legible: the same row always reads the same). */
export const RULE_CONFIDENCE = {
  meetingOpp: 0.92,
  accountOnly: 0.88,
  relatedOnly: 0.78,
  domainOnly: 0.76,
  channelOnly: 0.76,
  accountRecent: 0.72,
  meetingOppOfMany: 0.7,
  related: 0.55,
  account: 0.5,
  named: 0.5,
} as const;

/** What the engine reads besides the contract records (the db and the mock fill it; absent: the legacy rules alone). */
export interface RowExtras {
  rules?: LearnedRule[];
  /** Slack channel name (lower case, no #) → its id and the confirmed account / opp, when mapped. */
  channels?: Record<string, { id: string; accountId?: string | null; oppId?: string | null }>;
  /** Calendar event id → its recurring series id. */
  seriesOf?: Record<string, string>;
  engagement?: Record<string, EngagementSummary>;
  coveredAes?: CoveredAeRef[];
  internalDomains?: string[];
  /** opp id → how the app knows it (book, discovered, covered AE). */
  oppVia?: Record<string, 'book' | 'discovered' | 'covered_ae'>;
  /** account id → the domains it claims (account_aliases of kind domain). */
  accountDomains?: Record<string, string[]>;
  /** opp id → its team members besides me (opportunity_team_members; D-103 (a) coverage matches them). */
  oppTeams?: Record<string, Array<{ name?: string | null; personId?: string | null; org62UserId?: string | null; email?: string | null }>>;
  /** opp id → its Specialist Forecast owners' Org62 user ids (D-103 (b) fills it). */
  oppSfrOwners?: Record<string, string[]>;
}

export interface RowContext {
  opps: Opportunity[];
  accounts: Account[];
  events: CalendarEvent[];
  people: Person[];
  assets: Asset[];
  runs: AgentRun[];
  workItems: Array<{ id: string; accountId: string | null; oppId: string | null }>;
  activity: ActivityEntry[];
  today: string;
  attribution?: RowExtras;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Words too generic to name an account in a channel or a domain. */
const GENERIC = new Set(['the', 'inc', 'corp', 'corporation', 'company', 'group', 'health', 'bank', 'global', 'services', 'systems', 'solutions', 'international', 'holdings', 'technologies', 'tech', 'data', 'cloud', 'team', 'ext', 'external', 'shared', 'internal', 'project', 'deal', 'sales', 'support', 'general', 'example', 'com', 'net', 'org', 'io']);

/** The words an account is known by in a channel or a domain: the first one or two words of its name. */
function handlesOf(name: string): string[] {
  const words = norm(name)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));
  return words.slice(0, 1);
}

/** Accounts a set of tokens names; when several share the handle, the one whose whole name is the token wins. */
function accountsNamed(tokens: readonly string[], accounts: readonly Account[]): Account[] {
  const t = new Set(tokens.map(norm).filter((x) => x.length >= 3 && !GENERIC.has(x)));
  if (!t.size) return [];
  const hits = accounts.filter((a) => handlesOf(a.name).some((h) => t.has(h)));
  const whole = hits.filter((a) => t.has(norm(a.name).replace(/[^\p{L}\p{N}]+/gu, '')));
  return whole.length ? whole : hits;
}

/** "#acme-ext · thread", "Slack · #acme-ext, #hooli-ext" → their channel names' words. */
export function channelTokens(e: Pick<ActivityEntry, 'sources'>): { channel: string; tokens: string[] }[] {
  const out: { channel: string; tokens: string[] }[] = [];
  for (const s of e.sources) {
    if (s.kind !== 'slack') continue;
    for (const m of s.label.matchAll(/#([\p{L}\p{N}_-]{2,80})/gu)) out.push({ channel: `#${m[1]}`, tokens: m[1]!.split(/[-_]+/) });
  }
  return out;
}

/** External attendee domains the engine noted ("CF forced: external attendee (a.example, b.example); …"). */
export function attendeeDomains(e: Pick<ActivityEntry, 'issues'>): string[] {
  for (const f of e.issues) {
    const m = /external attendees? \(([^)]+)\)/i.exec(f);
    if (m) return m[1]!.split(/\s*,\s*/).filter(Boolean);
  }
  return [];
}

type Pick1 = { opp: OppOption; confidence: number; reason: string };
const asSuggestion = (p: Pick1): ActivitySuggestion => ({ kind: 'opp', oppId: p.opp.id, oppName: p.opp.name, accountName: p.opp.accountName, taskType: null, confidence: p.confidence, reason: p.reason, basis: 'rules', at: null });

function bestOf(list: readonly OppOption[]): { top: OppOption; recent: boolean } {
  const top = list[0]!;
  const second = list[1];
  return { top, recent: !!top.lastUsed && (!second?.lastUsed || top.lastUsed > second.lastUsed) };
}

const optionsFor = (e: ActivityEntry, ctx: RowContext) => buildOppOptions({ entry: e, opps: ctx.opps, accounts: ctx.accounts, events: ctx.events, people: ctx.people, assets: ctx.assets, runs: ctx.runs, workItems: ctx.workItems, activity: ctx.activity, today: ctx.today }).opps;

/** The legacy rules: the most specific thing the app knows, or null when nothing points anywhere. */
export function legacyRowRule(e: ActivityEntry, ctx: RowContext, opts?: OppOption[]): ActivitySuggestion | null {
  const ranked = opts ?? optionsFor(e, ctx);
  const open = ranked.filter((o) => o.isOpen);
  const meeting = e.sources.some((s) => s.kind === 'calendar');

  const evidence = open.filter((o) => o.why.includes('evidence'));
  if (evidence.length === 1) return asSuggestion({ opp: evidence[0]!, confidence: RULE_CONFIDENCE.meetingOpp, reason: meeting ? 'The meeting is on this opportunity' : 'Its session’s task is on this opportunity' });

  const onAccount = open.filter((o) => o.why.includes('account'));
  const acct = e.accountName ?? onAccount[0]?.accountName ?? null;
  if (onAccount.length === 1) return asSuggestion({ opp: onAccount[0]!, confidence: RULE_CONFIDENCE.accountOnly, reason: `The only open opportunity on ${acct}` });
  if (evidence.length > 1) return asSuggestion({ opp: evidence[0]!, confidence: RULE_CONFIDENCE.meetingOppOfMany, reason: `The meeting points at ${evidence.length} opportunities: this one ranks first` });
  if (onAccount.length > 1) {
    const { top, recent } = bestOf(onAccount);
    return recent
      ? asSuggestion({ opp: top, confidence: RULE_CONFIDENCE.accountRecent, reason: `${acct}’s opportunity you logged to last (${fmtDay(top.lastUsed!)})` })
      : asSuggestion({ opp: top, confidence: RULE_CONFIDENCE.account, reason: `${acct} has ${onAccount.length} open opportunities: ${top.closeDate ? `this one closes first (${fmtDay(top.closeDate)})` : 'check it is this one'}` });
  }

  const related = open.filter((o) => o.why.includes('related'));
  if (related.length) {
    const accounts = new Set(related.map((o) => o.accountId));
    const { top } = bestOf(related);
    if (related.length === 1) return asSuggestion({ opp: top, confidence: RULE_CONFIDENCE.relatedOnly, reason: `${top.accountName ?? 'Its account'} is in its evidence (${meeting ? 'the attendees' : 'its file'}): its only open opportunity` });
    return asSuggestion({ opp: top, confidence: RULE_CONFIDENCE.related, reason: `${accounts.size === 1 ? (top.accountName ?? 'An account') : `${accounts.size} accounts`} in its evidence: this opportunity ranks first` });
  }

  const byAccount = (a: Account) => open.filter((o) => o.accountId === a.id);
  const named = (accounts: Account[], why: (a: Account) => string, only: number): ActivitySuggestion | null => {
    const withOpps = accounts.filter((a) => byAccount(a).length);
    if (withOpps.length !== 1) return null;
    const a = withOpps[0]!;
    const list = byAccount(a);
    const { top, recent } = bestOf(list);
    if (list.length === 1) return asSuggestion({ opp: top, confidence: only, reason: `${why(a)}: its only open opportunity` });
    return asSuggestion({ opp: top, confidence: RULE_CONFIDENCE.named, reason: `${why(a)}: ${recent ? `the one you logged to last (${fmtDay(top.lastUsed!)})` : `${list.length} open opportunities, this one ranks first`}` });
  };
  const domains = attendeeDomains(e);
  if (domains.length) {
    const viaPeople = new Set(ctx.people.filter((p) => p.accountId && p.email && domains.includes(norm(p.email.split('@')[1]))).map((p) => p.accountId!));
    const accounts = viaPeople.size ? ctx.accounts.filter((a) => viaPeople.has(a.id)) : accountsNamed(domains.flatMap((d) => d.split('.')), ctx.accounts);
    const s = named(accounts, (a) => `Someone from ${domains[0]} was there (${a.name})`, RULE_CONFIDENCE.domainOnly);
    if (s) return s;
  }
  for (const c of channelTokens(e)) {
    const s = named(accountsNamed(c.tokens, ctx.accounts), (a) => `${c.channel} reads as ${a.name}’s channel`, RULE_CONFIDENCE.channelOnly);
    if (s) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** The contract records as the engine's World (my opps, the accounts, the people). */
export function worldOfContract(ctx: Pick<RowContext, 'opps' | 'accounts' | 'people' | 'activity' | 'today' | 'attribution'>): World {
  const x = ctx.attribution ?? {};
  const people = ctx.people.map((p) => ({ id: p.id, email: p.email ?? null, accountId: p.accountId ?? null, name: p.name }));
  const personById = new Map(ctx.people.map((p) => [p.id, p] as const));
  const opps: WorldOpp[] = ctx.opps.map((o) => ({
    id: o.id,
    accountId: o.accountId || null,
    name: o.name,
    isOpen: o.isOpen,
    isMine: o.isMine,
    myDc: o.dcAssigned || !!o.myDc,
    closeDate: o.closeDate,
    amount: o.amount,
    stage: o.stage,
    isWon: o.isWon,
    owner: o.owner ? { name: o.owner.name, personId: o.owner.id, email: personById.get(o.owner.id)?.email ?? null } : null,
    products: o.products,
    team: x.oppTeams?.[o.id] ?? (o.team ?? []).map((m) => ({ name: m.name, personId: m.id, org62UserId: m.org62UserId ?? null, email: personById.get(m.id)?.email ?? null })),
    specialistForecastOwnerIds: x.oppSfrOwners?.[o.id] ?? [],
    via: x.oppVia?.[o.id] ?? 'book',
  }));
  // what I logged to in the last 30 days (the picker's "recent")
  const since = new Date(Date.parse(`${ctx.today}T12:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  const recentUse: Record<string, string> = {};
  for (const a of ctx.activity) {
    if (!a.oppId || a.date < since || a.date > ctx.today) continue;
    if (!['approved', 'synced_to_canvas', 'logged', 'verified', 'verify_failed'].includes(a.status) && !a.userLockedFields.includes('oppId')) continue;
    if ((recentUse[a.oppId] ?? '') < a.date) recentUse[a.oppId] = a.date;
  }
  const channels: Record<string, { accountId: string; oppId?: string | null }> = {};
  for (const c of Object.values(x.channels ?? {})) if (c.accountId) channels[c.id] = { accountId: c.accountId, oppId: c.oppId ?? null };
  return {
    accounts: ctx.accounts.map((a) => ({ id: a.id, name: a.name, domains: x.accountDomains?.[a.id] ?? [] })),
    opps,
    people,
    channels,
    rules: x.rules ?? [],
    engagement: x.engagement ?? {},
    recentUse,
    coveredAes: x.coveredAes ?? [],
    internalDomains: x.internalDomains ?? [],
    today: ctx.today,
  };
}

/** A Time row as a signal: its description, its meeting's attendees and series, its channel, its evidence's ties. */
export function rowSignal(e: ActivityEntry, ctx: RowContext): Signal {
  const x = ctx.attribution ?? {};
  const ties = evidenceTies(e, ctx);
  const emails = new Set<string>();
  const personIds = new Set<string>();
  let seriesId: string | null = null;
  let at: string | null = e.start;
  const people = new Map(ctx.people.map((p) => [p.id, p] as const));
  for (const s of e.sources) {
    if (s.kind !== 'calendar' || !s.externalId) continue;
    for (const ev of ctx.events) {
      if (ev.id !== s.externalId && ev.source.externalId !== s.externalId) continue;
      seriesId = seriesId ?? x.seriesOf?.[ev.id] ?? null;
      at = ev.start ?? at;
      for (const a of ev.attendees) {
        personIds.add(a.id);
        const p = people.get(a.id);
        if (p?.email) emails.add(p.email.toLowerCase());
      }
    }
  }
  const ch = channelTokens(e)[0];
  const chName = ch ? ch.channel.slice(1).toLowerCase() : null;
  const known = chName ? x.channels?.[chName] : undefined;
  const domains = attendeeDomains(e);
  for (const em of emails) {
    const d = domainOfEmail(em);
    if (d && !domains.includes(d)) domains.push(d);
  }
  return {
    kind: e.sources.some((s) => s.kind === 'calendar') ? 'calendar' : e.sources.some((s) => s.kind === 'slack') ? 'slack' : e.sources.some((s) => s.kind === 'claude') ? 'claude' : e.sources.some((s) => s.kind === 'drive') ? 'drive' : 'manual',
    text: e.description,
    at,
    domains,
    emails: [...emails],
    personIds: [...personIds],
    channel: chName ? { id: known?.id ?? `name:${chName}`, name: chName } : null,
    seriesId,
    explicit: ties.oppIds.size ? { oppIds: [...ties.oppIds], via: 'The meeting' } : null,
    related: ties.accountIds.size ? { accountIds: [...ties.accountIds], via: 'its attendees or file' } : null,
  };
}

/** Reasons only the engine reads (the legacy rules never did). */
const NEW_SOURCES = new Set(['rule', 'channel_map']);
const hasNew = (c: Candidate) => c.why.some((r) => NEW_SOURCES.has(r.code));

function fromCandidate(c: Candidate, ctx: RowContext, internalOk: boolean): ActivitySuggestion | null {
  const lead = c.why.find((r) => r.code !== 'mine' && r.code !== 'recent' && r.code !== 'engagement') ?? c.why[0];
  if (c.kind === 'internal') return internalOk ? { kind: 'internal', oppId: null, oppName: null, accountName: null, taskType: null, confidence: c.confidence, reason: lead?.text ?? 'A learned rule says internal', basis: 'rules', at: null } : null;
  if (c.kind !== 'opp' || !c.oppId) return null;
  const o = ctx.opps.find((x) => x.id === c.oppId);
  if (!o) return null;
  return { kind: 'opp', oppId: o.id, oppName: o.name, accountName: ctx.accounts.find((a) => a.id === o.accountId)?.name ?? null, taskType: null, confidence: c.confidence, reason: lead?.text ?? 'Ranked first', basis: 'rules', at: null };
}

export interface RowAttribution {
  /** The one suggestion the row shows (the legacy pick unless something learned says otherwise). */
  suggestion: ActivitySuggestion | null;
  /** The top 3, the suggestion first: Accept takes #1 or any alternate in one click. */
  suggestions: ActivitySuggestion[];
  attribution: Attribution;
  signal: Signal;
}

/** A Time row through the engine (see the module comment). `internalOk`: the persona logs internal-only work (D-64). */
export function rowAttribution(e: ActivityEntry, ctx: RowContext, o: { options?: OppOption[]; internalOk?: boolean } = {}): RowAttribution {
  const legacy = legacyRowRule(e, ctx, o.options);
  const signal = rowSignal(e, ctx);
  const extra: AttributeExtra[] = legacy?.oppId ? [{ oppId: legacy.oppId, reason: { code: 'legacy', weight: legacy.confidence, text: legacy.reason } }] : [];
  const attribution = attribute(signal, worldOfContract(ctx), { extra, oppsOnly: true, limit: 5 });
  const top = attribution.top;
  let suggestion: ActivitySuggestion | null = legacy;
  if (top && hasNew(top)) {
    const learned = top.why.find((r) => NEW_SOURCES.has(r.code))!;
    if (legacy && top.kind === 'opp' && top.oppId === legacy.oppId) suggestion = { ...legacy, confidence: Math.max(legacy.confidence, top.confidence), reason: `${legacy.reason} · ${learned.text}` };
    else if (!legacy || top.confidence > legacy.confidence) suggestion = fromCandidate(top, ctx, !!o.internalOk) ?? legacy;
  }
  const suggestions: ActivitySuggestion[] = suggestion ? [suggestion] : [];
  for (const c of attribution.candidates) {
    if (suggestions.length >= 3) break;
    if (c.kind === 'opp' && suggestions.some((s) => s.oppId === c.oppId)) continue;
    if (c.kind === 'internal' && suggestions.some((s) => s.kind === 'internal')) continue;
    const s = fromCandidate(c, ctx, !!o.internalOk);
    if (s && s.confidence >= 0.2) suggestions.push(s);
  }
  return { suggestion, suggestions, attribution, signal };
}
