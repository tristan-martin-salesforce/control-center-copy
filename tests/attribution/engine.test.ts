/**
 * The attribution engine's scoring and learning (src/engines/attribution score.ts, rules.ts) on sample-data fixtures:
 * the CAST storylines name the opps (Saltmere's POC and its weekly sync, the Yarrowdale family, Elderglen Outdoors'
 * channel, Harrowgate's maintenance agent I'm not on). Pure: no database.
 */
import { describe, expect, it } from 'vitest';

import { applyRuleChanges, planLearning, ruleKeysOf } from '@/engines/attribution/rules';
import { attribute } from '@/engines/attribution/score';
import { combine } from '@/engines/attribution/weights';
import { worldOfContract } from '@/engines/attribution/row';
import type { LearnedRule, Signal, World } from '@/engines/attribution/types';

import { loadSample, table } from './sample';

const s = loadSample();
const opp = (name: string) => s.opps.find((o) => o.name.startsWith(name))!;
const acct = (name: string) => s.accounts.find((a) => a.name === name)!;
const aliasDomains: Record<string, string[]> = {};
for (const a of table('account_aliases')) if (a.kind === 'domain') (aliasDomains[a.account_id] ??= []).push(a.normalized_value);

function world(rules: LearnedRule[] = [], extra: Partial<World> = {}): World {
  const w = worldOfContract({ opps: s.opps, accounts: s.accounts, people: s.people, activity: [], today: '2026-11-18', attribution: { rules, accountDomains: aliasDomains, internalDomains: ['example.com'] } });
  return { ...w, partnerDomains: ['juniper-quay-partners.example'], ...extra };
}

const POC = 'Saltmere Health Plan - Data 360 + Agentforce Member Services POC';

describe('scoring (one pass over every evidence source)', () => {
  it('combines independent evidence as 1 − Π(1 − w) and never passes 1', () => {
    expect(combine([0.5, 0.5])).toBe(0.75);
    expect(combine([0.9, 0.9, 0.9])).toBeLessThanOrEqual(1);
    expect(combine([])).toBe(0);
  });

  it('a meeting naming an account with three open opps ranks the account first and asks (never a guess)', () => {
    const r = attribute({ kind: 'calendar', text: 'Saltmere weekly sync', domains: ['saltmere-health.example', 'juniper-quay-partners.example'] }, world());
    expect(r.top?.kind).toBe('account');
    expect(r.top?.accountId).toBe(acct('Saltmere Health Plan').id);
    expect(r.needsAsk).toBe(true);
    // the opps of that account follow, mine first, each with why
    const opps = r.candidates.filter((c) => c.kind === 'opp');
    expect(opps[0]!.oppId).toBe(opp(POC).id);
    expect(opps[0]!.why.map((w) => w.code)).toContain('account');
  });

  it('the seeded series rule (meeting_to_opportunity "Saltmere weekly sync") settles the opp and is cited in why', () => {
    const r = attribute({ kind: 'calendar', text: 'Saltmere weekly sync', domains: ['saltmere-health.example'] }, world(s.rules));
    expect(r.top?.oppId).toBe(opp(POC).id);
    expect(r.top?.why.find((w) => w.code === 'rule')?.text).toMatch(/Saltmere weekly sync|recurring meeting|meeting series/);
    expect(r.needsAsk).toBe(false);
  });

  it('a distinctive word of one opp picks it among its account’s opps (keyword)', () => {
    const r = attribute({ kind: 'calendar', text: 'Saltmere claims intake copilot review', domains: ['saltmere-health.example'] }, world());
    expect(r.top?.oppId).toBe(opp('Saltmere Health Plan - Claims Intake').id);
    expect(r.top?.why.map((w) => w.code)).toEqual(expect.arrayContaining(['keyword', 'account']));
  });

  it('an attendee domain alone names the account (domain) and its only open opp', () => {
    const r = attribute({ kind: 'gmail', text: 'Re: next steps', domains: ['ferrowpay.example'] }, world());
    expect(r.candidates[0]!.accountId).toBe(acct('Ferrowpay Financial').id);
    expect(r.candidates.some((c) => c.why.some((w) => w.code === 'domain'))).toBe(true);
  });

  it('a domain two accounts claim says nothing (never a coin flip)', () => {
    const w = world();
    const both = { ...w, accounts: w.accounts.map((a, i) => (i < 2 ? { ...a, domains: ['shared.example'] } : a)) };
    const r = attribute({ kind: 'calendar', text: 'catch up', domains: ['shared.example'] }, both);
    expect(r.top).toBeNull();
    expect(r.needsAsk).toBe(true);
  });

  it('the Yarrowdale family: a title with the shared head ranks the parent, the subsidiaries’ own names win', () => {
    const r = attribute({ kind: 'calendar', text: 'Yarrowdale Medical Group patient engagement agent demo' }, world());
    expect(r.top?.oppId).toBe(opp('Yarrowdale Medical Group - Patient Engagement').id);
  });

  it('Harrowgate (storyline 5): the opp I am not on still ranks from the title, the domain and its own words', () => {
    const r = attribute({ kind: 'calendar', text: 'Harrowgate predictive maintenance agent demo', domains: ['harrowgate-mfg.example'] }, world());
    expect(r.top?.oppId).toBe(opp('Harrowgate Manufacturing - Predictive Maintenance').id);
    expect(r.top!.confidence).toBeGreaterThan(0.75);
  });

  it('the opp’s AE in the room and a covered AE’s deal add reasons; covered AEs need account evidence', () => {
    const o = opp('Harrowgate Manufacturing - Predictive Maintenance');
    const w = world([], {});
    const ownerName = 'Ines Calloway';
    const opps = w.opps.map((x) => (x.id === o.id ? { ...x, owner: { name: ownerName, email: 'ines.calloway@example.com' } } : x));
    const r = attribute({ kind: 'calendar', text: 'Harrowgate plant walk', emails: ['ines.calloway@example.com'], domains: ['harrowgate-mfg.example'] }, { ...w, opps, coveredAes: [{ name: ownerName }] });
    const c = r.candidates.find((x) => x.oppId === o.id)!;
    expect(c.why.map((x) => x.code)).toEqual(expect.arrayContaining(['team_overlap', 'covered_ae']));
    // no account evidence: the covered AE alone never makes a candidate
    const none = attribute({ kind: 'calendar', text: 'lunch' }, { ...w, opps, coveredAes: [{ name: ownerName }] });
    expect(none.candidates.find((x) => x.oppId === o.id)).toBeUndefined();
  });

  it('closed opps are penalized below open ones', () => {
    const closed = s.opps.find((o) => !o.isOpen && o.accountId === acct('Saltmere Health Plan').id);
    if (!closed) return;
    const r = attribute({ kind: 'manual', text: 'x', explicit: { oppIds: [closed.id, opp(POC).id] } }, world());
    expect(r.top?.oppId).toBe(opp(POC).id);
    expect(r.candidates.find((c) => c.oppId === closed.id)?.why.some((w) => w.code === 'closed')).toBe(true);
  });
});

describe('learning (a correction changes the next guess)', () => {
  const now = '2026-11-18T16:00:00.000Z';
  let n = 0;
  const id = () => `rule-${++n}`;

  it('a pick on an unmapped Slack channel writes a channel rule; the next burst there gets that opp, citing the rule', () => {
    const sig: Signal = { kind: 'slack', text: 'can you share the deck', channel: { id: 'C0SMPL099', name: 'project-quartz' } };
    const before = attribute(sig, world());
    expect(before.top).toBeNull();
    const target = opp('Halvergate Freight Lines - Route Exceptions');
    const changes = planLearning({ signal: sig, chosen: { oppId: target.id, accountId: target.accountId }, outcome: 'edit', world: world() }, [], now, id);
    expect(changes.map((c) => [c.effect, c.after.kind])).toContainEqual(['new', 'channel']);
    const rules = applyRuleChanges([], changes);
    const after = attribute(sig, world(rules));
    expect(after.top?.oppId).toBe(target.id);
    expect(after.top?.why[0]?.code).toBe('rule');
    expect(after.top?.why[0]?.text).toMatch(/Learned .* channel C0SMPL099 → Halvergate/);
  });

  it('accept strengthens the rule; a conflicting correction decays it, and a second one replaces it', () => {
    const sig: Signal = { kind: 'calendar', text: 'Quarterly business review', domains: ['oakhallowmutual.example'], seriesId: 'smplqbr' };
    const a = opp('Oakhallow Mutual Insurance - Claims Triage');
    const b = opp('Oakhallow Mutual Insurance - Underwriting');
    let rules = applyRuleChanges([], planLearning({ signal: sig, chosen: { oppId: a.id, accountId: a.accountId }, outcome: 'edit', world: world() }, [], now, id));
    const series = () => rules.find((r) => r.kind === 'series')!;
    expect(series().oppId).toBe(a.id);
    rules = applyRuleChanges(rules, planLearning({ signal: sig, chosen: { oppId: a.id, accountId: a.accountId }, outcome: 'accept', world: world(rules) }, rules, now, id));
    expect(series().hits).toBe(2);
    rules = applyRuleChanges(rules, planLearning({ signal: sig, chosen: { oppId: b.id, accountId: b.accountId }, outcome: 'edit', world: world(rules) }, rules, now, id));
    expect(series().misses).toBe(1);
    expect(series().oppId).toBe(a.id);
    rules = applyRuleChanges(rules, planLearning({ signal: sig, chosen: { oppId: b.id, accountId: b.accountId }, outcome: 'edit', world: world(rules) }, rules, now, id));
    expect(series().oppId).toBe(b.id);
    expect([series().hits, series().misses]).toEqual([1, 0]);
    expect(attribute(sig, world(rules)).top?.oppId).toBe(b.id);
  });

  it('a channel rule that sees a second opp of the same account generalizes to the account', () => {
    const sig: Signal = { kind: 'slack', text: '', channel: { id: 'C0SMPL098', name: 'quartz-room' } };
    const a = opp('Ferrowpay Financial - Fraud');
    const b = opp('Ferrowpay Financial - Data 360');
    let rules = applyRuleChanges([], planLearning({ signal: sig, chosen: { oppId: a.id, accountId: a.accountId }, outcome: 'edit', world: world() }, [], now, id));
    rules = applyRuleChanges(rules, planLearning({ signal: sig, chosen: { oppId: b.id, accountId: b.accountId }, outcome: 'edit', world: world(rules) }, rules, now, id));
    const ch = rules.find((r) => r.kind === 'channel')!;
    expect(ch.oppId).toBeNull();
    expect(ch.accountId).toBe(a.accountId);
  });

  it('Internal is learned from a series too; a reject decays only the rules that pointed at what was shown', () => {
    const sig: Signal = { kind: 'calendar', text: 'Team planning', seriesId: 'smplteam' };
    let rules = applyRuleChanges([], planLearning({ signal: sig, chosen: { oppId: null, accountId: null, internal: true }, outcome: 'edit', world: world() }, [], now, id));
    expect(attribute(sig, world(rules)).top?.kind).toBe('internal');
    rules = applyRuleChanges(rules, planLearning({ signal: sig, chosen: { oppId: null, accountId: null }, outcome: 'reject', shown: { oppId: null, accountId: null, internal: true }, world: world(rules) }, rules, now, id));
    expect(rules[0]!.misses).toBe(1);
  });

  it('a disabled rule is never read', () => {
    const sig: Signal = { kind: 'slack', text: '', channel: { id: 'C0SMPL097' } };
    const t = opp('Cascadia County Services - Citizen');
    const rules = applyRuleChanges([], planLearning({ signal: sig, chosen: { oppId: t.id, accountId: t.accountId }, outcome: 'edit', world: world() }, [], now, id)).map((r) => ({ ...r, enabled: false }));
    expect(attribute(sig, world(rules)).top).toBeNull();
  });

  it('the keys a signal carries: series, channel, repo, external domains and contacts, distinctive words', () => {
    const keys = ruleKeysOf({ kind: 'calendar', text: 'Saltmere blueprint review', seriesId: 's1', domains: ['saltmere-health.example', 'example.com'], emails: ['mari.q@saltmere-health.example', 'me@example.com'] }, world());
    expect(keys.map((k) => `${k.kind}:${k.pattern}`)).toEqual(['series:s1', 'domain:saltmere-health.example', 'person:mari.q@saltmere-health.example', 'keyword:saltmere', 'keyword:blueprint']);
  });
});
