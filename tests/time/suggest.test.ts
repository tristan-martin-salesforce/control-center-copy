/**
 * Time rows that need an opportunity: the plain-English issues (src/lib/time-issues.ts), the suggestion (src/lib/
 * time-suggest.ts: the rules first, the model's stored answer for what they can't settle), the cheap model's prompt and
 * its parse (src/engines/activity/suggest-prompt.ts), and both DataSources attaching the same suggestion on read
 * (placeholders only: the example seed's ACME, Globex, Initech, Hooli).
 */
import { describe, expect, it } from 'vitest';

import type { ActivityEntry, OppOption } from '../../src/contract';
import { parseSuggestAnswer, suggestCandidates, suggestRequest } from '../../src/engines/activity/suggest-prompt';
import { plainIssue, plainIssues } from '../../src/lib/time-issues';
import { RULES_SETTLE, rowsForModel, ruleSuggestion, storedSuggestion, storedSuggestionsOf, suggestionFor, suggestKey, wantsSuggestion, withSuggestions, type SuggestContext } from '../../src/lib/time-suggest';
import { accountTargetWhat, groundworkOf } from '../../src/engines/attribution/target';
import { classifyMeeting } from '../../src/engines/activity/classify';
import { eventCreateRule } from '../../src/engines/activity/slackbot';
import type { ActivityMappings } from '../../src/engines/activity/types';
import { hasTarget } from '../../src/lib/time-internal';
import { buildOrg62AccountSearch, org62AccountHit } from '../../src/server/chat/org62';
import { patchedEntry } from '../../src/server/time/dismiss';
import { createMockDataSource } from '../../src/server/datasource/mock';
import { compactHours, compactWhen, whereOf } from '../../src/components/time/compact-derive';

const row = (o: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'r1',
  version: 1,
  date: '2026-11-10',
  start: '2026-11-10T16:00:00.000Z',
  end: '2026-11-10T17:00:00.000Z',
  durationH: 1,
  taskType: 'Solution Design',
  oppId: null,
  oppName: null,
  accountName: null,
  meetingType: 'CR',
  description: 'Slack: data share thread',
  status: 'needs_input',
  confidence: 'guess',
  sources: [{ kind: 'slack', label: 'Slack · #initech-pilot' }],
  userLockedFields: [],
  issues: ['NEEDS WhatId: which account/opp was this for? write `=> 006…` or `=> skip`'],
  updatedAt: '2026-11-10T17:00:00.000Z',
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
  ...o,
});

const opp = (id: string, accountId: string, name: string, o: Record<string, unknown> = {}) => ({ id, accountId, name, stage: 'Discovery', amount: null, closeDate: '2026-12-15', isOpen: true, isMine: true, dcAssigned: false, vdpLinked: false, hoursQtd: 0, nextStep: null, nextStepRead: true, products: [], owner: null, org62Url: null, myDc: null, forecastCategory: null, isWon: false, updatedAt: '2026-11-01T00:00:00.000Z', ...o });
const acct = (id: string, name: string) => ({ id, name, industry: null, dcStatus: 'none' as const, vdpStatus: 'none' as const, hoursQtd: 0, team: [], org62Url: null, notes: '' });

function ctx(o: Partial<SuggestContext> = {}): SuggestContext {
  return {
    opps: [opp('o_ini', 'a_ini', 'Initech · D360 Pilot'), opp('o_glx', 'a_glx', 'Globex · Data 360 Expansion'), opp('o_glx2', 'a_glx', 'Globex · Renewal FY27', { closeDate: '2027-01-15' }), opp('o_glxmc', 'a_glxmc', 'Globex MC · Activation')],
    accounts: [acct('a_ini', 'Initech'), acct('a_glx', 'Globex'), acct('a_glxmc', 'Globex - Marketing Cloud')],
    events: [],
    people: [{ id: 'p1', name: 'Marcus', email: 'marcus@globex.example', accountId: 'a_glx' }],
    assets: [],
    runs: [],
    workItems: [],
    activity: [],
    today: '2026-11-12',
    stored: {},
    internalActivity: true,
    ...o,
  };
}

describe('plain-English issues', () => {
  it('never shows the canvas grammar: each known note is one sentence that says what to do', () => {
    const slack = row();
    expect(plainIssue(slack.issues[0]!, slack)).toBe('Slack work with no account: which opportunity, or internal?');
    expect(plainIssue('NEEDS WhatId: pick an opp from candidates', row({ sources: [{ kind: 'calendar', label: 'Calendar · x' }] }))).toBe('A meeting with no account: which opportunity, or internal?');
    expect(plainIssue('CF forced: external attendee (x.example); Neither type -> Customer Discovery, review')).toBe('Someone from x.example was there, so it counts as customer-facing (Customer Discovery). Check the type.');
    expect(plainIssue('CF forced: external attendee (a.example, b.example); Account Planning -> Customer Discovery')).toBe('Someone from a.example, b.example was there, so it counts as customer-facing: Account Planning became Customer Discovery.');
    expect(plainIssue('GUESS: hours estimated from evidence; adjust with `=> 1.5h`')).toBe('Hours estimated from the evidence: change them if they are off.');
    expect(plainIssue("overlaps OOO 'Dentist' (10:00); trim or drop")).toBe('Overlaps your time off “Dentist” (10:00): trim the hours or dismiss it.');
    expect(plainIssue('WhatId = account fallback (no single obvious opp)')).toMatch(/^Logs to the account for now/);
    expect(plainIssue('Org62 check: Deleted in Org62')).toBe('Deleted in Org62.');
    // an unknown note loses its canvas syntax
    const odd = plainIssue('NEEDS something odd; write `=> 006…` or `=> skip`')!;
    expect(odd).toBe('Needs something odd');
    for (const i of [...slack.issues, 'CF forced: external attendee (x.example); Neither type -> Customer Discovery, review', odd]) expect(plainIssue(i, slack)).not.toMatch(/=>|`|WhatId|NEEDS/);
  });

  it('a row’s issues read once each, in order', () => {
    expect(plainIssues(row({ issues: ['NEEDS WhatId: x', 'NEEDS WhatId: y', 'GUESS: hours'] }))).toEqual(['Slack work with no account: which opportunity, or internal?', 'Hours estimated from the evidence: change them if they are off.']);
  });
});

describe('suggestions: the rules', () => {
  it('a Slack channel that names one account: its only open opp, sure enough to settle the row', () => {
    const s = ruleSuggestion(row(), ctx())!;
    expect(s).toMatchObject({ kind: 'opp', oppId: 'o_ini', basis: 'rules', reason: '#initech-pilot reads as Initech’s channel: its only open opportunity' });
    expect(s.confidence).toBeGreaterThanOrEqual(RULES_SETTLE);
  });

  it('an attendee’s domain: the account the app’s people there are on (never the part that shares its name)', () => {
    const e = row({ sources: [{ kind: 'calendar', label: 'Calendar · Roadmap call' }], issues: ['CF forced: external attendee (globex.example); Neither type -> Customer Discovery, review'] });
    const s = ruleSuggestion(e, ctx())!;
    expect(s.accountName).toBe('Globex');
    expect(['o_glx', 'o_glx2']).toContain(s.oppId);
    // two open opps on it and none used lately: a low confidence, so the model may still weigh in
    expect(s.confidence).toBeLessThan(RULES_SETTLE);
    // no one known at the domain: the domain's own name, the whole-name account first
    const byName = ruleSuggestion(e, ctx({ people: [] }))!;
    expect(byName.accountName).toBe('Globex');
  });

  it('the row’s own account: its only open opp, or the one you logged to last', () => {
    const one = ruleSuggestion(row({ accountName: 'Initech', sources: [] }), ctx())!;
    expect(one).toMatchObject({ oppId: 'o_ini', reason: 'The only open opportunity on Initech' });
    const used = row({ id: 'used', oppId: 'o_glx2', status: 'approved', date: '2026-11-11' });
    const last = ruleSuggestion(row({ accountName: 'Globex', sources: [] }), ctx({ activity: [used] }))!;
    expect(last.oppId).toBe('o_glx2');
    expect(last.reason).toMatch(/you logged to last/);
  });

  it('nothing to go on: no rules suggestion, and the row is the model’s to ask', () => {
    const e = row({ sources: [{ kind: 'claude', label: 'Claude · Member data model draft' }] });
    expect(ruleSuggestion(e, ctx())).toBeNull();
    expect(rowsForModel([e], ctx()).map((x) => x.id)).toEqual(['r1']);
    // a settled row never costs a call
    expect(rowsForModel([row()], ctx())).toEqual([]);
  });

  it('only rows that need an opportunity', () => {
    expect(wantsSuggestion(row())).toBe(true);
    expect(wantsSuggestion(row({ oppId: 'o_ini' }))).toBe(false);
    expect(wantsSuggestion(row({ internal: true }))).toBe(false);
    expect(wantsSuggestion(row({ canvasDraftId: 'd1' }))).toBe(false);
    expect(wantsSuggestion(row({ status: 'logged' }))).toBe(false);
    expect(suggestionFor(row({ oppId: 'o_ini' }), ctx())).toBeNull();
  });
});

describe('suggestions: the model’s stored answer', () => {
  const e = row({ sources: [{ kind: 'claude', label: 'Claude · Member data model draft' }] });
  const at = '2026-11-12T10:00:00.000Z';
  it('is shown for the row as it was asked, its opp named as the app has it now', () => {
    const stored = storedSuggestionsOf({ rows: { r1: { key: suggestKey(e), kind: 'opp', oppId: 'o_glx', confidence: 0.7, reason: 'Member data is Globex’s pilot topic', model: 'claude-haiku-5-5', at } } });
    expect(suggestionFor(e, ctx({ stored }))).toMatchObject({ kind: 'opp', oppId: 'o_glx', oppName: 'Globex · Data 360 Expansion', accountName: 'Globex', basis: 'ai', confidence: 0.7 });
    // the row changed since: the answer no longer applies (and the row is asked again)
    const changed = { ...e, description: 'Claude: something else' };
    expect(storedSuggestion(changed, ctx({ stored }))).toBeNull();
    expect(rowsForModel([changed], ctx({ stored }))).toHaveLength(1);
    expect(rowsForModel([e], ctx({ stored }))).toHaveLength(0);
  });

  it('internal, only for a role that logs internal work; a none (unusable answer) shows nothing', () => {
    const stored = storedSuggestionsOf({ rows: { r1: { key: suggestKey(e), kind: 'internal', oppId: null, taskType: 'Asset Creation', confidence: 0.8, reason: 'A demo build, no customer named', model: 'm', at } } });
    expect(suggestionFor(e, ctx({ stored }))).toMatchObject({ kind: 'internal', taskType: 'Asset Creation', basis: 'ai' });
    expect(suggestionFor(e, ctx({ stored, internalActivity: false }))).toBeNull();
    const none = storedSuggestionsOf({ rows: { r1: { key: suggestKey(e), kind: 'opp', oppId: null, confidence: 0, reason: '', model: 'm', at } } });
    expect(suggestionFor(e, ctx({ stored: none }))).toBeNull();
    expect(rowsForModel([e], ctx({ stored: none }))).toHaveLength(0);
  });

  it('a rules answer that settles the row wins over the model', () => {
    const stored = storedSuggestionsOf({ rows: { r1: { key: suggestKey(row()), kind: 'internal', oppId: null, confidence: 0.99, reason: 'x', model: 'm', at } } });
    expect(suggestionFor(row(), ctx({ stored }))).toMatchObject({ basis: 'rules', oppId: 'o_ini' });
  });
});

describe('the model’s prompt and answer', () => {
  const candidates = [{ id: 'o1', name: 'Initech · D360 Pilot', accountName: 'Initech', stage: 'Discovery', closeDate: '2026-12-20', isOpen: true, lastUsed: null, why: ['related'] }] as unknown as OppOption[];
  const facts = { entry: row({ description: 'Slack: share with dana@x.example +1 303 555 0100' }), candidates, internalActivity: true };
  it('names the row, its sources, its issues in plain English and the numbered candidates; no emails or phone numbers', () => {
    const r = suggestRequest(facts);
    expect(r.user).toContain('Row: Slack: share with');
    expect(r.user).not.toMatch(/dana@|555 0100/);
    expect(r.user).toContain('1. Initech · D360 Pilot (account: Initech)');
    expect(r.user).toContain('Note: Slack work with no account: which opportunity, or internal?');
    expect(r.user).toMatch(/^internal\. Internal work/m);
    expect(r.system).toMatch(/ONE line of JSON/);
  });
  it('parses a pick or internal, clamps the confidence, and refuses anything else', () => {
    expect(parseSuggestAnswer('{"choice": 1, "confidence": 1.4, "reason": "The channel names Initech"}', facts)).toEqual({ kind: 'opp', oppId: 'o1', confidence: 1, reason: 'The channel names Initech' });
    expect(parseSuggestAnswer('```json\n{"choice": "internal", "confidence": 0.6, "reason": "Tooling"}\n```', facts)).toEqual({ kind: 'internal', oppId: null, confidence: 0.6, reason: 'Tooling' });
    expect(parseSuggestAnswer('{"choice": "internal", "confidence": 0.6}', { ...facts, internalActivity: false })).toBeNull();
    expect(parseSuggestAnswer('{"choice": 7, "confidence": 0.6}', facts)).toBeNull();
    expect(parseSuggestAnswer('I cannot tell', facts)).toBeNull();
  });
  it('lists open opportunities first, at most 15', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, name: `Opp ${i}`, accountName: null, stage: '', closeDate: null, isOpen: i % 2 === 0, lastUsed: null, why: i === 1 ? ['related'] : [] })) as unknown as OppOption[];
    const c = suggestCandidates(many);
    expect(c).toHaveLength(15);
    expect(c.every((o) => o.isOpen)).toBe(true);
  });
});

describe('both DataSources attach the suggestion on read', () => {
  it('the mock: the seed’s rows that need an opp carry the rules’ suggestion; a stored model answer shows for the rest', async () => {
    const ds = createMockDataSource({ autoplay: false });
    ds.resetStore();
    const log = await ds.getActivityLog({ query: {} } as never);
    const by = new Map(log.entries.map((e) => [e.id, e] as const));
    expect(by.get('ac_wed_hooli')?.suggestion).toMatchObject({ kind: 'opp', oppId: 'opp_hooli_nce', basis: 'rules' });
    expect(by.get('ac_tue_slack_initech')?.suggestion).toMatchObject({ kind: 'opp', oppId: 'opp_initech_pilot', basis: 'rules' });
    expect(by.get('ac_wed_roadmap')?.suggestion?.accountName).toBe('Globex');
    expect(by.get('ac_mon_claude_model')?.suggestion).toBeNull();
    // rows that have an opp, or are internal, never carry one
    expect(log.entries.filter((e) => e.oppId || e.internal).every((e) => e.suggestion === null)).toBe(true);
    const claude = by.get('ac_mon_claude_model')!;
    ds.putStoredSuggestions({ [claude.id]: { key: suggestKey(claude), kind: 'internal', oppId: null, taskType: 'Asset Creation', confidence: 0.8, reason: 'A data model draft with no customer named', model: 'claude-haiku-5-5', at: '2026-11-05T12:00:00.000Z' } });
    const again = await ds.getActivityLog({ query: {} } as never);
    expect(again.entries.find((e) => e.id === claude.id)?.suggestion).toMatchObject({ kind: 'internal', basis: 'ai', taskType: 'Asset Creation' });
    // accepting it (PATCH internal) takes the row out of Needs you; the answer reads null on it now
    const r = await ds.patchActivity({ params: { id: claude.id }, body: { ifVersion: claude.version, patch: { internal: true, status: 'approved' } } } as never);
    expect(r.entity.suggestion).toBeNull();
    ds.dispose();
  });

  it('the mock stages only the rows you ticked (POST /time/log/batches ids)', async () => {
    const ds = createMockDataSource({ autoplay: false });
    ds.resetStore();
    const r = await ds.stageLogBatch({ body: { ids: ['ac_tue_sow'] } } as never);
    expect(r.entity.events).toBe(1);
    expect(r.entity.approved).toBe(0);
    ds.dispose();
  });
});

describe('the compact row: where it goes', () => {
  const sug = (confidence: number, o: Record<string, unknown> = {}) => ({ kind: 'opp' as const, oppId: '006A', oppName: 'Data 360 Expansion', accountName: 'Globex', taskType: null, confidence, reason: 'the meeting names Globex', basis: 'rules' as const, at: null, ...o });

  it('a suggestion reads "87% likely" with its account · opp, ✓ at or over the settle line', () => {
    const w = whereOf(row({ suggestion: sug(0.87) }), 0.75);
    expect(w).toMatchObject({ kind: 'suggested', percent: '87%', target: 'Globex · Data 360 Expansion', sure: true, label: '87 percent likely Globex · Data 360 Expansion' });
    expect(whereOf(row({ suggestion: sug(0.6) }), 0.75).sure).toBe(false);
    // a close second keeps it unsure even over the line
    expect(whereOf(row({ suggestion: sug(0.8), suggestions: [sug(0.8), sug(0.78, { oppId: '006B', oppName: 'Renewal' })] }), 0.75).sure).toBe(false);
  });

  it('its own opp, Internal, or Pick an opp when there is nothing to go on', () => {
    expect(whereOf(row({ oppId: '006A', oppName: 'Data 360 Expansion', accountName: 'Globex', suggestion: sug(0.9) }), 0.75)).toMatchObject({ kind: 'set', target: 'Globex · Data 360 Expansion' });
    expect(whereOf(row({ internal: true }), 0.75)).toMatchObject({ kind: 'internal', target: 'Internal' });
    expect(whereOf(row(), 0.75)).toMatchObject({ kind: 'pick', target: 'Pick an opp', label: 'Pick an opp' });
  });

  it('when and hours are short', () => {
    expect(compactWhen(row(), 'UTC')).toBe('Tue 10 16:00');
    expect(compactHours(1.5)).toBe('1.5 h');
    expect(compactHours(0.25)).toBe('0.25 h');
    expect(compactHours(2)).toBe('2 h');
  });
});

describe('D-103 (c): the account target and the sentence that says why', () => {
  const C = (o: Partial<SuggestContext> = {}) => ctx({ opps: [...ctx().opps, opp('o_old', 'a_hooli', 'Hooli · Renewal FY25', { isOpen: false })], accounts: [...ctx().accounts, acct('a_hooli', 'Hooli')], ...o });

  it('every row says in one sentence why it logs there, from facts only (never split across opps)', () => {
    const rows = [
      row({ id: 'only', oppId: 'o_ini', oppName: 'Initech · D360 Pilot', accountName: 'Initech', status: 'proposed', issues: [] }),
      row({ id: 'acct', accountId: 'a_hooli', accountName: 'Hooli', status: 'proposed', issues: [] }),
      row({ id: 'pick', oppId: 'o_glx', oppName: 'Globex · Data 360 Expansion', accountName: 'Globex', date: '2026-11-11', status: 'proposed', issues: [] }),
      row({ id: 'int', internal: true, taskType: 'Asset Creation', meetingType: null, status: 'proposed', issues: [] }),
    ];
    const logged = [row({ id: 'l1', oppId: 'o_glx', status: 'logged', durationH: 3, date: '2026-11-03' }), row({ id: 'l2', oppId: 'o_glx', status: 'approved', durationH: 1, date: '2026-11-04' }), row({ id: 'l3', oppId: 'o_glx', status: 'logged', durationH: 5, date: '2026-10-30' })];
    const by = new Map(withSuggestions(rows, C({ activity: logged })).map((e) => [e.id, e.groundwork] as const));
    expect(by.get('only')).toEqual({ code: 'opp_single', text: 'Initech’s only open opportunity.' });
    expect(by.get('acct')).toEqual({ code: 'account_no_open_opp', text: 'No open opportunity on Hooli, so I tied it to the account.' });
    // this month's hours only (Oct's 5 h are not counted)
    expect(by.get('pick')).toEqual({ code: 'opp_pick', text: '2 open opps could take this; I think Globex · Data 360 Expansion (you logged 4 h there this month).' });
    expect(by.get('int')?.code).toBe('internal');
    expect(groundworkOf({ accountName: 'Acme', openOpps: [{ id: 'x', name: 'Acme · Data 360' }], learnedOn: '2026-11-18T10:00:00.000Z' })).toEqual({ code: 'rule', text: 'Learned Nov 18 from your pick.' });
    // plain words: none of the internal ones
    for (const g of by.values()) expect(g?.text ?? '').not.toMatch(/groundwork|WhatId|candidate|attribution/i);
  });

  it('an account target is settled: no opp question, no suggestion, and the patch sets it (oppId still works)', () => {
    const cur = row({ issues: ['WhatId = account fallback (no single obvious opp)'] });
    const { next, newLocks } = patchedEntry(cur, { target: { kind: 'account', id: 'a_hooli' } }, null, { id: 'a_hooli', name: 'Hooli' });
    expect(next).toMatchObject({ accountId: 'a_hooli', accountName: 'Hooli', oppId: null, issues: [] });
    expect(newLocks).toContain('oppId');
    expect(hasTarget(next)).toBe(true);
    expect(wantsSuggestion(next)).toBe(false);
    expect(whereOf(next, 0.75)).toMatchObject({ kind: 'set', target: 'Hooli (the account)' });
    // the opp target is oppId; an opp clears the account
    const onOpp = patchedEntry(next, { target: { kind: 'opp', id: 'o_ini' } }, { name: 'Initech · D360 Pilot', accountName: 'Initech' }).next;
    expect(onOpp).toMatchObject({ oppId: 'o_ini' });
    expect(onOpp).not.toHaveProperty('accountId'); // absent, as the db reads a row with no account target
    expect(() => patchedEntry(cur, { target: { kind: 'account', id: 'nope' } }, null, null)).toThrow(/not in the app/);
  });

  it('the account fallback flag asks only when the account has open opps; the WhatId is the Account (001…) through one function', () => {
    const m = (openOpps: number): ActivityMappings => ({ accounts: [{ key: 'a1', match: '(?<![a-z0-9])customer[\\s\\-_.&/]*1(?![a-z0-9])', domains: [], whatId: '001XX0000000001AAA', whatType: 'Account', whatName: 'CUSTOMER_1', openOpps }], repos: {}, channels: {}, neitherRepos: {}, internalDomains: ['corp.example'], partnerDomains: [], ignoreDomains: [], overrides: [] });
    const ev = { id: 'c|e1', summary: 'CUSTOMER_1 adoption review', startsAt: '2026-11-02T17:00:00.000Z', endsAt: '2026-11-02T18:00:00.000Z', allDay: false, kind: 'default', selfResponse: 'accepted', organizerSelf: false, recurring: false, attendeeDomains: [] } as never;
    expect(classifyMeeting(ev, m(0), '2026-11-02').flags.some((f) => /account fallback/.test(f))).toBe(false);
    expect(classifyMeeting(ev, m(2), '2026-11-02').flags.some((f) => /account fallback/.test(f))).toBe(true);
    expect(accountTargetWhat('001XX0000000001AAA')).toEqual({ whatType: 'Account', whatId: '001XX0000000001AAA' });
    expect(accountTargetWhat('006XX0000000001AAA')).toBeNull();
    expect(eventCreateRule({ ownerName: 'Me', ownerOrg62Id: '005XX', recordTypeId: '012XX' }, false)).toMatch(/Opportunity \(006…\) or an Account \(001…\)/);
  });

  it('Org62 search reads accounts with one more fixed SELECT (bound words, read only)', () => {
    expect(buildOrg62AccountSearch("o'hare acme")).toBe("SELECT Id, Name, Type, Owner.Name FROM Account WHERE Name LIKE '%o\\'hare%' AND Name LIKE '%acme%' ORDER BY Name LIMIT 5");
    expect(org62AccountHit({ org62Id: '001XX0000000001AAA', name: 'Acme', account: null, accountOrg62Id: '001XX0000000001AAA', owner: null, inApp: { accountId: 'a1' } })).toMatchObject({ kind: 'account', accountId: 'a1', oppId: null });
  });

  it('the mock: search lists accounts; picking one logs the row to the account', async () => {
    const ds = createMockDataSource({ autoplay: false });
    ds.resetStore();
    const s = await ds.searchOrg62Opps({ body: { q: 'globex' } } as never);
    const hit = s.hits.find((h) => h.kind === 'account' && h.name === 'Globex');
    expect(hit?.accountId).toBeTruthy();
    const log = await ds.getActivityLog({ query: {} } as never);
    const cur = log.entries.find((e) => e.id === 'ac_wed_roadmap')!;
    const r = await ds.patchActivity({ params: { id: cur.id }, body: { ifVersion: cur.version, patch: { target: { kind: 'account', id: hit!.accountId! } } } } as never);
    expect(r.entity).toMatchObject({ accountId: hit!.accountId, oppId: null, suggestion: null });
    expect(r.entity.groundwork?.code).toMatch(/account_no_open_opp|opp_single|opp_pick/);
    ds.dispose();
  });
});
