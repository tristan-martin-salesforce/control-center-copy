/**
 * sample-data (the synthetic copy of the Command Center database, sample-data/tables/*.json) as the attribution
 * engine's inputs: the projection matcher and the activity engine's mappings, contract records for Time rows, learned
 * rules (mapping_rules), the confirmed channel map (channel_account_maps) and the labels the parity test scores
 * against. Placeholder data only (SMPL ids, *.example domains).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Account, ActivityEntry, CalendarEvent, Opportunity, Person } from '@/contract';
import type { ActivityMappings } from '@/engines/activity/types';
import { RULE_KIND_OF_DB } from '@/engines/attribution/rules';
import type { LearnedMappings } from '@/engines/attribution/activity';
import type { LearnedRule } from '@/engines/attribution/types';
import { Matcher, type MatchAccount, type MatchOpp } from '@/projections/matching';

const DIR = path.resolve(__dirname, '../../sample-data/tables');
type Row = Record<string, any>;
export const table = (t: string): Row[] => JSON.parse(readFileSync(path.join(DIR, `${t}.json`), 'utf8')) as Row[];

export interface Sample {
  matcher: Matcher;
  /** The activity engine's mappings as the projection builds them, before the engine (no learned rules, no channel map). */
  baseMappings: ActivityMappings;
  /** The same with the learned rules and the confirmed channel map the engine now reads. */
  learnedMappings: ActivityMappings;
  rules: LearnedRule[];
  /** channel id → confirmed account id (channel_account_maps, not rejected). */
  channelMap: Record<string, string>;
  channels: Row[];
  events: Row[];
  /** Calendar event id → external attendee domains. */
  domainsOf: Map<string, string[]>;
  accounts: Account[];
  opps: Opportunity[];
  people: Person[];
  contractEvents: CalendarEvent[];
  activity: Row[];
  timeBlocks: Row[];
  sourceItems: Map<string, Row>;
}

let cached: Sample | null = null;

export function loadSample(): Sample {
  if (cached) return cached;
  const accounts = table('accounts');
  const aliases = table('account_aliases');
  const opps = table('opportunities');
  const dcs = table('deal_contributions');
  const otm = table('opportunity_team_members');
  const people = table('people');
  const myDc = new Set(dcs.filter((d) => d.is_mine && !d.deleted_upstream_at).map((d) => d.opportunity_id));
  const matchAccounts: MatchAccount[] = accounts.map((a) => ({ id: a.id, name: a.name, org62AccountId: a.org62_account_id, aliases: aliases.filter((x) => x.account_id === a.id && x.kind !== 'regex' && x.kind !== 'channel_pattern' && x.kind !== 'repo_path').map((x) => ({ kind: x.kind, value: x.value })) }));
  const matchOpps: MatchOpp[] = opps.map((o) => ({ id: o.id, accountId: o.account_id, org62OpportunityId: o.org62_opportunity_id, name: o.name, isClosed: o.is_closed, onMyTeam: o.on_my_team, myDc: myDc.has(o.id) }));
  const rules = { internal: ['example.com'], partner: ['juniper-quay-partners.example'], ignore: [] };
  const matcher = new Matcher(matchAccounts, matchOpps, rules);
  const baseMappings = matcher.mappings({ internalDomains: rules.internal, partnerDomains: rules.partner, ignoreDomains: rules.ignore });
  const channels = table('channels');
  const chanById = new Map(channels.map((c) => [c.id, c] as const));
  const channelMap: Record<string, string> = {};
  for (const m of table('channel_account_maps')) if (m.user_verdict !== 'rejected' && chanById.get(m.channel_id)) channelMap[chanById.get(m.channel_id)!.external_id] = m.account_id;
  const learned: LearnedRule[] = table('mapping_rules')
    .filter((r) => !r.is_regex && RULE_KIND_OF_DB[r.kind])
    .map((r) => ({ id: r.id, kind: RULE_KIND_OF_DB[r.kind]!, pattern: r.pattern, accountId: r.account_id, oppId: r.opportunity_id, internal: r.target_value === 'internal', hits: Math.max(1, r.hit_count ?? 0), misses: 0, lastUsedAt: r.last_hit_at, enabled: r.enabled, source: r.source === 'user_correction' ? 'user_correction' : 'seed' }));
  const ruleOpps: LearnedMappings['opps'] = {};
  for (const r of learned) {
    const o = r.oppId ? opps.find((x) => x.id === r.oppId) : undefined;
    if (o) ruleOpps[o.id] = { accountKey: o.account_id, whatId: o.org62_opportunity_id, whatName: o.name, team: o.on_my_team || myDc.has(o.id), isOpen: !o.is_closed };
  }
  const learnedMappings: ActivityMappings = { ...baseMappings, channels: channelMap, learned: { rules: learned, opps: ruleOpps } };
  const events = table('calendar_events');
  const att = table('calendar_event_attendees');
  const domainsOf = new Map<string, string[]>();
  for (const e of events) domainsOf.set(e.id, (e.external_domains as string[] | null) ?? [...new Set(att.filter((a) => a.calendar_event_id === e.id && a.is_external).map((a) => a.domain as string))]);
  const contractAccounts: Account[] = accounts.map((a) => ({ id: a.id, name: a.name }) as unknown as Account);
  const owners = new Map(otm.filter((t) => t.team_role === 'Account Executive' && t.person_id).map((t) => [t.opportunity_id, t.person_id] as const));
  const personName = new Map(people.map((p) => [p.id, p.display_name] as const));
  const contractOpps: Opportunity[] = opps.map(
    (o) =>
      ({
        id: o.id,
        accountId: o.account_id ?? '',
        name: o.name,
        stage: o.stage ?? '',
        amount: o.amount === null ? null : Number(o.amount),
        closeDate: o.close_date,
        isOpen: !o.is_closed,
        isMine: o.on_my_team,
        dcAssigned: myDc.has(o.id),
        vdpLinked: false,
        hoursQtd: 0,
        nextStep: null,
        nextStepRead: true,
        products: [],
        owner: owners.has(o.id) ? { id: owners.get(o.id)!, name: personName.get(owners.get(o.id)!) ?? 'AE' } : null,
        org62Url: null,
        myDc: null,
        forecastCategory: o.forecast_category,
        isWon: o.is_won,
        updatedAt: o.updated_at,
      }) as Opportunity,
  );
  const contractPeople: Person[] = people.map((p) => ({ id: p.id, name: p.display_name, email: p.primary_email, accountId: p.account_id }) as unknown as Person);
  const contractEvents: CalendarEvent[] = events.map(
    (e) =>
      ({
        id: e.id,
        title: e.title,
        start: e.starts_at,
        end: e.ends_at,
        attendance: 'attended',
        isCustomerFacing: e.has_external_attendees,
        accountId: e.account_id,
        oppId: e.opportunity_id,
        attendees: att.filter((a) => a.calendar_event_id === e.id && a.person_id && !a.is_self).map((a) => ({ id: a.person_id, name: a.display_name })),
        source: { kind: 'calendar', label: 'Google Calendar', externalId: e.external_event_id },
      }) as unknown as CalendarEvent,
  );
  cached = {
    matcher,
    baseMappings,
    learnedMappings,
    rules: learned,
    channelMap,
    channels,
    events,
    domainsOf,
    accounts: contractAccounts,
    opps: contractOpps,
    people: contractPeople,
    contractEvents,
    activity: table('activity_entries'),
    timeBlocks: table('time_blocks'),
    sourceItems: new Map(table('source_items').map((s) => [s.id, s] as const)),
  };
  return cached;
}

/** One sample activity_entries row as the contract's ActivityEntry (the fields the suggestion reads). */
export function entryOf(r: Row, s: Sample, o: { blankOpp?: boolean } = {}): ActivityEntry {
  const acct = r.account_id ? s.accounts.find((a) => a.id === r.account_id) : undefined;
  const opp = r.opportunity_id && !o.blankOpp ? s.opps.find((x) => x.id === r.opportunity_id) : undefined;
  const sources: ActivityEntry['sources'] = [];
  if (String(r.dedupe_key).startsWith('cal|')) {
    const ext = String(r.dedupe_key).split('|')[2];
    const ev = s.events.find((e) => e.external_event_id === ext);
    if (ev) sources.push({ kind: 'calendar', label: `Calendar · ${ev.title}`, externalId: ev.id });
  }
  const day = String(r.starts_at).slice(0, 10);
  return {
    id: r.id,
    version: r.version ?? 1,
    date: day,
    start: r.starts_at,
    end: r.ends_at,
    durationH: Number(r.duration_hours),
    taskType: null,
    oppId: opp?.id ?? null,
    oppName: opp?.name ?? null,
    accountName: acct?.name ?? null,
    meetingType: r.customer_facing ? 'CF' : r.customer_related ? 'CR' : null,
    description: r.subject ?? r.description ?? '',
    status: o.blankOpp ? 'needs_input' : (r.status === 'excluded' ? 'dismissed' : r.status),
    confidence: 'likely',
    sources,
    userLockedFields: [],
    issues: (r.flags as string[] | null) ?? [],
    updatedAt: r.updated_at,
    fromOrg62: false,
    excludedReason: null,
    loggedAt: null,
    verifiedAt: null,
    internal: false,
    dismissSource: null,
    logNote: null,
    logNoteBasis: null,
    why: null,
    suggestion: null,
  } as ActivityEntry;
}
