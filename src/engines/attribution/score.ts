/**
 * `attribute(signal, world)`: one scoring pass over every evidence source (lane 06 §4a, R1). Each source adds a
 * reason with a weight to a candidate (an opp, an account, or internal work); a candidate's confidence is
 * 1 − Π(1 − wᵢ). Account-level evidence spreads to the account's open opps (its only open opp, my only one, else a
 * share), so an account with several open opps ranks the account itself first and asks (the rundown), never a guess.
 *
 * Sources, in the order they are read (weights: weights.ts, config):
 *   explicit       the evidence's own opp or account (the meeting's opp, the session's task, a mention)
 *   rule           learned `mapping_rules` (rules.ts): series, channel, repo, domain, contact, word
 *   channel_map    the user-confirmed channel ↔ account map (channel_account_maps)
 *   title          an account's name or alias in the text (the caller's matcher: the activity engine passes its own)
 *   channel_name   an account's name in the Slack channel's name
 *   person         a participant the app knows at an account (people ↔ accounts, Org62 contacts)
 *   domain         a participant's email domain an account claims (aliases, learned domains, its people)
 *   related        an account the evidence names indirectly (the attendees' accounts, the Drive file's)
 *   keyword        a distinctive word of one open opp's name in the text
 *   team_overlap   the opp's AE is a participant
 *   covered_ae     the opp is a covered AE's deal on an account the evidence names
 *   engagement / recent / mine   my engagement in the last 4 weeks, my logging in the last 30 days, my team or DC
 * Closed opps are penalized (×0.6; ×0.3 when closed for over 90 days or worth nothing).
 */

import { coverageOf } from './coverage';
import { dealWords, accountWords, domainOfEmail, nameMatcher, normDomain } from './text';
import { externalDomainsOf, matchingRules, ruleText, ruleWeight } from './rules';
import { combine, weightsOf } from './weights';
import type { Attribution, Candidate, Reason, Signal, World, WorldOpp } from './types';

/** A reason a caller already knows, on its target. */
export interface AttributeExtra {
  oppId?: string | null;
  accountId?: string | null;
  internal?: boolean;
  reason: Reason;
}

export interface AttributeOptions {
  /** At most this many candidates (default 5). */
  limit?: number;
  /** Reasons a caller already knows (Time rows keep the old rules' pick as a `legacy` reason, row.ts). */
  extra?: readonly AttributeExtra[];
  /** Only opps (Time rows log to an opp or internal; account candidates are left out). */
  oppsOnly?: boolean;
  /** Spread account evidence to the account's open opps (default true; the activity mapper, which knows only learned opps, turns it off). */
  spread?: boolean;
}

const DAY = 86_400_000;
/** Opp-level reasons that single one opp out among its account's open opps. */
const SINGLES = new Set<Reason['code']>(['keyword', 'explicit', 'rule', 'team_overlap', 'channel_map', 'legacy']);
const dayMs = (d: string) => Date.parse(`${d.slice(0, 10)}T12:00:00Z`);

export function attribute(sig: Signal, world: World, opts: AttributeOptions = {}): Attribution {
  const W = weightsOf(world.weights);
  const reasons = new Map<string, Reason[]>();
  const add = (key: string, r: Reason) => {
    const list = reasons.get(key) ?? [];
    // one reason per code and rule per candidate: the strongest
    const same = list.findIndex((x) => x.code === r.code && x.ruleId === r.ruleId);
    if (same >= 0) {
      if (list[same]!.weight < r.weight) list[same] = r;
    } else list.push(r);
    reasons.set(key, list);
  };
  const oppById = new Map(world.opps.map((o) => [o.id, o] as const));
  const acctById = new Map(world.accounts.map((a) => [a.id, a] as const));
  const acctName = (id: string | null | undefined) => (id ? (acctById.get(id)?.name ?? 'the account') : 'the account');
  const oppKey = (id: string) => `o:${id}`;
  const acctKey = (id: string) => `a:${id}`;

  for (const x of opts.extra ?? []) {
    if (x.internal) add('internal', x.reason);
    else if (x.oppId && oppById.has(x.oppId)) add(oppKey(x.oppId), x.reason);
    else if (x.accountId && acctById.has(x.accountId)) add(acctKey(x.accountId), x.reason);
  }

  // explicit links
  for (const id of sig.explicit?.oppIds ?? []) if (oppById.has(id)) add(oppKey(id), { code: 'explicit', weight: W.explicitOpp, text: `${sig.explicit?.via ?? 'The evidence'} is on this opportunity` });
  for (const id of sig.explicit?.accountIds ?? []) if (acctById.has(id)) add(acctKey(id), { code: 'explicit', weight: W.explicitAccount, text: `${sig.explicit?.via ?? 'The evidence'} is on ${acctName(id)}` });

  // learned rules
  for (const r of matchingRules(sig, world)) {
    const w = ruleWeight(r, W);
    if (r.internal) add('internal', { code: 'rule', weight: w, ruleId: r.id, text: ruleText(r, 'internal') });
    else if (r.oppId && oppById.has(r.oppId)) add(oppKey(r.oppId), { code: 'rule', weight: w, ruleId: r.id, text: ruleText(r, oppById.get(r.oppId)!.name) });
    else if (r.accountId && acctById.has(r.accountId)) add(acctKey(r.accountId), { code: 'rule', weight: w, ruleId: r.id, text: ruleText(r, acctName(r.accountId)) });
  }

  // the user-confirmed channel map
  const ch = sig.channel?.id ? world.channels?.[sig.channel.id] : undefined;
  const chLabel = sig.channel?.name ? `#${sig.channel.name}` : 'The channel';
  if (ch) {
    if (ch.oppId && oppById.has(ch.oppId)) add(oppKey(ch.oppId), { code: 'channel_map', weight: W.channelMapOpp, text: `${chLabel} is mapped to this opportunity` });
    if (acctById.has(ch.accountId)) add(acctKey(ch.accountId), { code: 'channel_map', weight: W.channelMapAccount, text: `${chLabel} is mapped to ${acctName(ch.accountId)}` });
  }

  // names in the text, then in the channel's name
  const match = world.matchText ?? nameMatcher(world.accounts);
  const named = sig.text ? match(sig.text) : [];
  named.forEach((m, i) => {
    if (!acctById.has(m.accountId)) return;
    const w = (m.via === 'alias' ? W.titleAlias : W.titleName) * (i === 0 ? 1 : 0.5);
    add(acctKey(m.accountId), { code: 'title', weight: w, text: i === 0 ? `It names ${acctName(m.accountId)}` : `It also names ${acctName(m.accountId)}` });
  });
  if (sig.channel?.name && !ch) {
    const hit = match(sig.channel.name.replace(/[-_]+/g, ' '))[0];
    if (hit && acctById.has(hit.accountId)) add(acctKey(hit.accountId), { code: 'channel_name', weight: W.channelName, text: `${chLabel} reads as ${acctName(hit.accountId)}’s channel` });
  }

  // people and their domains
  const people = world.people ?? [];
  const byEmail = new Map(people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p] as const));
  const seenPeople = new Set<string>();
  const personHit = (p: (typeof people)[number] | undefined) => {
    if (!p?.accountId || seenPeople.has(p.id) || !acctById.has(p.accountId)) return;
    seenPeople.add(p.id);
    add(acctKey(p.accountId), { code: 'person', weight: W.personAccount, text: `${p.name ?? 'Someone'} from ${acctName(p.accountId)} is in it` });
  };
  const byId = new Map(people.map((p) => [p.id, p] as const));
  for (const id of sig.personIds ?? []) personHit(byId.get(id));
  for (const e of sig.emails ?? []) personHit(byEmail.get(e.toLowerCase()));
  const domainAccounts = new Map<string, Set<string>>();
  for (const a of world.accounts) for (const d of a.domains ?? []) domainAccounts.set(normDomain(d), new Set([...(domainAccounts.get(normDomain(d)) ?? []), a.id]));
  for (const p of people) {
    const d = domainOfEmail(p.email);
    if (d && p.accountId) domainAccounts.set(d, new Set([...(domainAccounts.get(d) ?? []), p.accountId]));
  }
  for (const d of externalDomainsOf(sig, world)) {
    const accts = domainAccounts.get(d);
    if (!accts || accts.size !== 1) continue; // a domain two accounts claim says nothing
    const a = [...accts][0]!;
    if (acctById.has(a)) add(acctKey(a), { code: 'domain', weight: W.domainAccount, text: `Someone from ${d} is in it (${acctName(a)})` });
  }
  for (const a of sig.related?.accountIds ?? []) if (acctById.has(a)) add(acctKey(a), { code: 'related', weight: W.relatedAccount, text: `${acctName(a)} is in its evidence (${sig.related!.via})` });

  // accounts with evidence so far: keyword, team and covered-AE evidence counts only on them (or a strong keyword)
  const evidenced = new Set([...reasons.keys()].filter((k) => k.startsWith('a:')).map((k) => k.slice(2)));
  for (const k of reasons.keys()) if (k.startsWith('o:')) {
    const a = oppById.get(k.slice(2))?.accountId;
    if (a) evidenced.add(a);
  }
  const openByAccount = new Map<string, WorldOpp[]>();
  for (const o of world.opps) if (o.isOpen && o.accountId) openByAccount.set(o.accountId, [...(openByAccount.get(o.accountId) ?? []), o]);

  // distinctive opp words
  const textWords = new Set(dealWords([sig.text, sig.channel?.name ?? ''].join(' ')));
  if (textWords.size) {
    for (const [acct, list] of openByAccount) {
      const skip = accountWords(acctById.get(acct)?.name);
      const counts = new Map<string, number>();
      const tokens = new Map(list.map((o) => [o.id, dealWords(o.name, skip)] as const));
      for (const ws of tokens.values()) for (const w of ws) counts.set(w, (counts.get(w) ?? 0) + 1);
      for (const o of list) {
        const distinct = (tokens.get(o.id) ?? []).filter((w) => textWords.has(w) && counts.get(w) === 1);
        if (!distinct.length || (!evidenced.has(acct) && distinct.length < 2)) continue;
        add(oppKey(o.id), { code: 'keyword', weight: distinct.length >= 2 ? W.keywordOppStrong : W.keywordOpp, text: `It says “${distinct.slice(0, 2).join(' ')}”, ${distinct.length >= 2 ? 'words' : 'a word'} of this opportunity’s name` });
      }
    }
  }

  // the opp's AE in the room; a covered AE's deal on an account the evidence names
  const emails = new Set((sig.emails ?? []).map((e) => e.toLowerCase()));
  const pids = new Set(sig.personIds ?? []);
  const covered = world.coveredAes ?? [];
  // D-103 (a): owner, opp team or Specialist Forecast owner, within the row's window on the evidence's day
  const coveredOf = (o: WorldOpp) => coverageOf(o, covered, (sig.at ?? world.today)?.slice(0, 10))?.ae;
  for (const o of world.opps) {
    if (!o.isOpen) continue;
    if ((o.owner?.email && emails.has(o.owner.email.toLowerCase())) || (o.owner?.personId && pids.has(o.owner.personId))) add(oppKey(o.id), { code: 'team_overlap', weight: W.teamOverlap, text: `${o.owner?.name ?? 'Its AE'} (the opportunity’s AE) is in it` });
    const ae = o.accountId && evidenced.has(o.accountId) ? coveredOf(o) : undefined;
    if (ae) add(oppKey(o.id), { code: 'covered_ae', weight: W.coveredAe, text: `Covered AE ${ae.name}’s deal` });
  }

  // account evidence spreads to its open opps
  for (const [key, rs] of opts.spread === false ? [] : [...reasons]) {
    if (!key.startsWith('a:')) continue;
    const acct = key.slice(2);
    const sA = combine(rs.map((r) => r.weight));
    const open = openByAccount.get(acct) ?? [];
    const mine = open.filter((o) => o.isMine || o.myDc);
    // the one open opp the evidence itself singles out (its words, a link, a rule, its AE) takes the account's evidence in full
    const singled = open.filter((o) => (reasons.get(oppKey(o.id)) ?? []).some((r) => SINGLES.has(r.code)));
    for (const o of open) {
      const f = open.length === 1 || (singled.length === 1 && singled[0]!.id === o.id) ? 1 : mine.length === 1 && mine[0]!.id === o.id ? 0.85 : 0.5;
      const why = open.length === 1 ? 'its only open opportunity' : f === 1 ? `the one of ${open.length} open opportunities the evidence names` : f === 0.85 ? 'your only open opportunity there' : `one of ${open.length} open opportunities`;
      add(oppKey(o.id), { code: 'account', weight: Math.round(sA * f * 1000) / 1000, text: `On ${acctName(acct)}: ${why}` });
    }
  }

  // recency and mine, on opps that already have evidence
  const today = dayMs(world.today);
  for (const key of [...reasons.keys()]) {
    if (!key.startsWith('o:')) continue;
    const o = oppById.get(key.slice(2));
    if (!o) continue;
    const eng = world.engagement?.[o.id];
    if (eng?.lastTouchAt && today - Date.parse(eng.lastTouchAt) <= 28 * DAY) add(key, { code: 'engagement', weight: W.engagementRecent, text: `You worked on it lately (${eng.touches4w} touches, ${eng.hours4w} h in 4 weeks)` });
    const used = world.recentUse?.[o.id];
    if (used) add(key, { code: 'recent', weight: W.recentUse, text: `You logged to it ${new Date(dayMs(used)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` });
    if (o.isMine || o.myDc) add(key, { code: 'mine', weight: W.mine, text: o.myDc ? 'Your DC is on it' : 'You’re on its team' });
  }

  const cands: Candidate[] = [];
  for (const [key, rs] of reasons) {
    const why = [...rs].sort((a, b) => b.weight - a.weight);
    if (key === 'internal') {
      cands.push({ kind: 'internal', oppId: null, accountId: null, confidence: combine(why.map((r) => r.weight)), why });
      continue;
    }
    if (key.startsWith('a:')) {
      if (opts.oppsOnly) continue;
      cands.push({ kind: 'account', oppId: null, accountId: key.slice(2), confidence: combine(why.map((r) => r.weight)), why });
      continue;
    }
    const o = oppById.get(key.slice(2))!;
    let conf = combine(why.map((r) => r.weight));
    if (!o.isOpen) {
      const old = !!o.closeDate && today - dayMs(o.closeDate) > 90 * DAY;
      const f = old || !o.amount ? W.closedPenalty : 0.6;
      conf = Math.round(conf * f * 1000) / 1000;
      why.push({ code: 'closed', weight: 0, text: old ? 'Closed over 90 days ago' : 'Closed' });
    }
    cands.push({ kind: 'opp', oppId: o.id, accountId: o.accountId, confidence: conf, why });
  }
  cands.sort((a, b) => b.confidence - a.confidence || rank(a) - rank(b) || mineOf(b, oppById) - mineOf(a, oppById) || closeOf(a, oppById).localeCompare(closeOf(b, oppById)) || keyOf(a).localeCompare(keyOf(b)));
  const candidates = cands.slice(0, opts.limit ?? 5);
  const top = candidates[0] ?? null;
  return { candidates, top, needsAsk: needsAsk(top, candidates, W.settle, W.margin, openByAccount) };
}

const rank = (c: Candidate) => (c.kind === 'opp' ? 0 : c.kind === 'internal' ? 1 : 2);
const mineOf = (c: Candidate, m: Map<string, WorldOpp>) => {
  const o = c.oppId ? m.get(c.oppId) : undefined;
  return o && (o.isMine || o.myDc) ? 1 : 0;
};
const closeOf = (c: Candidate, m: Map<string, WorldOpp>) => (c.oppId ? (m.get(c.oppId)?.closeDate ?? '9999') : '9999');
const keyOf = (c: Candidate) => `${c.kind}:${c.oppId ?? c.accountId ?? ''}`;

function needsAsk(top: Candidate | null, list: readonly Candidate[], settle: number, margin: number, open: Map<string, WorldOpp[]>): boolean {
  if (!top || top.confidence < settle) return true;
  // an account with open opps is not an answer yet: which opp?
  if (top.kind === 'account' && (open.get(top.accountId ?? '')?.length ?? 0) > 0) return true;
  // a rival: another target (not the top opp's own account)
  const rival = list.find((c) => c !== top && !(c.kind === 'account' && c.accountId === top.accountId));
  return !!rival && top.confidence - rival.confidence < margin;
}
