/**
 * FTI pre-filters (what never reaches a model) and the apply step (verdicts → the same cc tool writes as an agent).
 */
import { describe, expect, it } from 'vitest';

import { createCcHandlers, createRunState } from '@/llm/cc-tools';
import { actionsFor, buildUnits, mailRule, messageRule, myOpenSteps, planOrg62, runActions, unsureAction, type InterpretItem, type Verdict } from '@/scanner/interpret';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import type { NormalizedSourceItem } from '@/scanner/types';

const msg = (text: string, o: Partial<NormalizedSourceItem> & { isMe?: boolean; authorId?: string } = {}): NormalizedSourceItem => ({
  connector: 'slack',
  kind: 'message',
  externalId: o.externalId ?? 'D0DM00001:1793808300.000100',
  dedupeKey: `slack:${o.externalId ?? 'D0DM00001:1793808300.000100'}`,
  contentHash: 'h',
  occurredAt: '2026-11-04T15:00:00.000Z',
  excerpt: text,
  author: { name: o.isMe ? 'ME' : 'PERSON_B', externalId: o.authorId ?? (o.isMe ? 'U0ME00001' : 'U0PERSONB'), isMe: !!o.isMe },
  payload: { channelId: 'D0DM00001', channelType: 'im', ts: '1793808300.000100', ...(o.isMe ? {} : { toMe: true }) },
  ...o,
});

describe('pre-filter rules', () => {
  it('bots, joins and acknowledgements never reach the model', () => {
    expect(messageRule(msg('deploy finished', { authorId: 'B0BOT00001' }), { hasCandidate: false })).toBe('bot');
    expect(messageRule(msg('<@U0PERSONB> has joined the channel'), { hasCandidate: false })).toBe('join');
    expect(messageRule(msg('thanks!! 🙌'), { hasCandidate: false })).toBe('trivial');
    expect(messageRule(msg(':+1:'), { hasCandidate: false })).toBe('trivial');
    expect(messageRule(msg('can you send the deck?'), { hasCandidate: false })).toBeNull();
  });
  it('my own message goes on only with a promise, a delivery, a file or a home', () => {
    expect(messageRule(msg('<@U0PERSONC> could you review this?', { isMe: true }), { hasCandidate: false })).toBe('own_no_cue');
    expect(messageRule(msg("I'm going to figure out how to distribute it", { isMe: true }), { hasCandidate: false })).toBeNull();
    expect(messageRule(msg('Here it is: https://docs.google.com/presentation/d/X/edit', { isMe: true }), { hasCandidate: false })).toBeNull();
    expect(messageRule(msg('Rough volumes: 1.8M members', { isMe: true }), { hasCandidate: true })).toBeNull();
  });
  it('mail: bulk and calendar notices by the fetcher’s own flags; a Docs action item for me always goes on', () => {
    const mail = (payload: Record<string, unknown>, isMe = false): NormalizedSourceItem => ({ ...msg('Weekly digest', { isMe }), connector: 'gmail', kind: 'email', payload });
    expect(mailRule(mail({ bulk: true }), { hasCandidate: false })).toBe('bulk_mail');
    expect(mailRule(mail({ bulk: true, docsAsk: { kind: 'action_item' } }), { hasCandidate: false })).toBeNull();
    expect(mailRule(mail({ calendarNotice: 'invite' }), { hasCandidate: false })).toBe('calendar_notice');
    expect(mailRule(mail({ direction: 'sent' }, true), { hasCandidate: false })).toBe('own_no_cue');
  });
  it('notes: one unit per open next step of mine', () => {
    const notes: NormalizedSourceItem = { ...msg('summary'), connector: 'gemini_notes', kind: 'meeting_notes', payload: { myNextSteps: [{ title: 'Send the deck' }, { title: 'Book the room', done: true }, { title: '  ' }] } };
    expect(myOpenSteps(notes)).toEqual([{ index: 1, title: 'Send the deck' }]);
  });
});

describe('units from a run (Slack selection, thread joins, earlier verdicts)', () => {
  it('settles what is not for me, links a reply in an open item’s thread as context, skips what an earlier run decided', async () => {
    const store = new InMemoryScannerStore({ clock: { now: () => new Date('2026-11-04T16:00:00.000Z') }, profile: { me: { userId: 'u', name: 'ME', slackId: 'U0ME00001' }, watchList: [], aliases: { accounts: [], channels: [] } } });
    const wi = store.seedWorkItem({ kind: 'ask', title: 'Update the pricing slide', threadRefs: ['slack:C0ACME001:1.000100'] });
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'channel:C0ACME001' }, trigger: 'schedule', window: { from: '2026-11-04T00:00:00.000Z', to: '2026-11-04T16:00:00.000Z' } });
    const ctx = await store.getContext({ connector: 'slack', scope: 'channel:C0ACME001' });
    const state = createRunState({ runId, connector: 'slack', window: { from: '2026-11-04T00:00:00.000Z', to: '2026-11-04T16:00:00.000Z' }, context: ctx });
    const items: NormalizedSourceItem[] = [
      { ...msg('kickoff notes for the team', { externalId: 'C0ACME001:2.000100' }), threadRef: 'slack:C0ACME001:2.000100', payload: { channelId: 'C0ACME001', channelType: 'channel', ts: '2.000100' } },
      { ...msg('the customer liked the new tiers', { externalId: 'C0ACME001:3.000100' }), threadRef: 'slack:C0ACME001:1.000100', payload: { channelId: 'C0ACME001', channelType: 'channel', ts: '3.000100', threadTs: '1.000100', isReply: true } },
      { ...msg('<@U0ME00001> can you also add a residency slide?', { externalId: 'C0ACME001:4.000100' }), threadRef: 'slack:C0ACME001:4.000100', payload: { channelId: 'C0ACME001', channelType: 'channel', ts: '4.000100', toMe: true } },
      { ...msg('<@U0ME00001> one more question?', { externalId: 'C0ACME001:5.000100' }), threadRef: 'slack:C0ACME001:5.000100', payload: { channelId: 'C0ACME001', channelType: 'channel', ts: '5.000100', toMe: true } },
    ];
    const res = await store.recordSourceItems(runId, items);
    res.forEach((r, i) => {
      state.recorded.set(r.dedupeKey, r.sourceItemId);
      state.items.set(r.dedupeKey, items[i]!);
    });
    // an earlier run already gave the last one a verdict, and it is unchanged now
    await store.recordTriageVerdicts([{ sourceItemId: res[3]!.sourceItemId, v: 'act', why: 'fti:ask' }]);
    const fresh = new Set(res.slice(0, 3).map((r) => r.sourceItemId));
    const out = await buildUnits({ store, state, ctx, window: state.window, fresh });
    expect(out.units.map((u) => u.ref)).toEqual(['C0ACME001:4.000100']);
    expect(out.decided).toEqual(expect.arrayContaining([{ sourceItemId: res[0]!.sourceItemId, reason: 'not_addressed' }, { sourceItemId: res[1]!.sourceItemId, reason: 'thread_join' }, { sourceItemId: res[3]!.sourceItemId, reason: 'seen_decided' }]));
    expect(out.actions).toEqual([{ tool: 'cc_link_evidence', args: expect.objectContaining({ workItemId: wi, sourceItemId: res[1]!.sourceItemId, role: 'context', confidence: 'likely' }) }]);
  });
});

describe('apply: verdicts → the agentic path’s writes', () => {
  const x = (extra: Partial<InterpretItem> = {}): InterpretItem => ({ ref: 'D0DM00001:1793808300.000100', sourceItemId: 'sid-1', item: msg('Hey, can you send me the ACME demo deck before Friday?', { accountHints: ['acc-acme', 'ACME'], oppHints: ['006XX0000000001AAA'] }), connector: 'slack', to: ' → me', context: [], candidates: [], group: 'dm:D0DM00001', fresh: true, ...extra });
  const v = (o: Partial<Verdict>): Verdict => ({ ref: 'D0DM00001:1793808300.000100', v: 'ask', conf: 0.9, ...o }) as Verdict;
  const cand = (o: Partial<InterpretItem['candidates'][number]> = {}) => ({ alias: 'w1', workItemId: 'wi_1', title: 'Send ACME demo deck to PERSON_D', why: 'same thread', score: 0.9, state: 'open', ...o });
  const known = new Set(['acc-acme']);

  it('an ask with no home is proposed with kind, title, purpose, due, account, opp, origin evidence and the confidence word', () => {
    const [a] = actionsFor(x(), v({ title: 'Send ACME demo deck to PERSON_D', who: 'PERSON_D', cite: 'can you send me the ACME demo deck', due: '2026-11-06', why: 'direct ask in DM' }), { knownAccounts: known });
    expect(a).toEqual({ tool: 'cc_propose_item', args: { kind: 'ask', title: 'Send ACME demo deck to PERSON_D', purpose: 'PERSON_D asked: "can you send me the ACME demo deck"', due: '2026-11-06', accountId: 'acc-acme', oppId: '006XX0000000001AAA', evidence: [{ sourceItemId: 'sid-1', role: 'origin', reason: 'direct ask in DM' }], confidence: 'sure' } });
  });
  it('an ask with its candidate links as origin; on a handed-off item a direct ask loops me back in', () => {
    expect(actionsFor(x({ candidates: [cand()] }), v({ link: 'w1', why: 'asked again' }), { knownAccounts: known })[0]).toMatchObject({ tool: 'cc_link_evidence', args: { role: 'origin', workItemId: 'wi_1' } });
    const handed = actionsFor(x({ candidates: [cand({ resolution: 'handed_off' })] }), v({ link: 'w1', why: 'asked me directly to join the review' }), { knownAccounts: known })[0]!;
    expect(handed).toMatchObject({ args: { role: 'origin', reason: 'loop_back: asked me directly to join the review' } });
  });
  it('a completion links (sure); from Drive it is the drive judge’s, likely at most; on a done item it is context', () => {
    expect(actionsFor(x({ candidates: [cand()] }), v({ v: 'completion', link: 'w1', why: 'my reply delivers it', conf: 0.93 }), { knownAccounts: known })[0]).toMatchObject({ args: { role: 'completion', confidence: 'sure' } });
    const drive = actionsFor(x({ connector: 'drive', candidates: [cand()] }), v({ v: 'completion', link: 'w1', why: 'scene added', conf: 0.9 }), { knownAccounts: known })[0]!;
    expect(drive).toMatchObject({ args: { role: 'completion', confidence: 'likely', reason: 'drive_judge: verdict=done; confidence=0.90; scene added' } });
    expect(actionsFor(x({ candidates: [cand({ state: 'done' })] }), v({ v: 'completion', link: 'w1', why: 'sent again' }), { knownAccounts: known })[0]).toMatchObject({ args: { role: 'context' } });
  });
  it('a requirements change on a done item is a contradiction the closure engine reads; on an open one, context', () => {
    expect(actionsFor(x({ candidates: [cand({ state: 'done' })] }), v({ v: 'change', link: 'w1', why: 'also a residency slide' }), { knownAccounts: known })[0]).toMatchObject({ args: { role: 'contradiction', reason: 'requirements_change: also a residency slide' } });
    expect(actionsFor(x({ candidates: [cand()] }), v({ v: 'change', link: 'w1', why: 'also a residency slide' }), { knownAccounts: known })[0]).toMatchObject({ args: { role: 'context', reason: 'requirements_update: also a residency slide' } });
  });
  it('a link to a candidate the item does not have is ignored; noise writes nothing; unsure is flagged for Triage', () => {
    expect(actionsFor(x(), v({ v: 'completion', link: 'w9' }), { knownAccounts: known })).toEqual([]);
    expect(actionsFor(x(), v({ v: 'noise' }), { knownAccounts: known })).toEqual([]);
    expect(unsureAction(x(), 'ask at 0.40')).toMatchObject({ tool: 'cc_flag_unlinked', args: { sourceItemId: 'sid-1', reason: 'unsure: slack from PERSON_B: ask at 0.40' } });
  });
  it('writes go through the cc handlers: NOT-MINE drops my own ask of someone else, as for an agent', async () => {
    const store = new InMemoryScannerStore({ clock: { now: () => new Date('2026-11-04T16:00:00.000Z') }, profile: { me: { userId: 'u', name: 'ME', slackId: 'U0ME00001' }, watchList: [], aliases: { accounts: [], channels: [] } } });
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: { from: '2026-11-04T00:00:00.000Z', to: '2026-11-04T16:00:00.000Z' } });
    const ctx = await store.getContext({ connector: 'slack', scope: 'inbox' });
    const state = createRunState({ runId, connector: 'slack', window: { from: '2026-11-04T00:00:00.000Z', to: '2026-11-04T16:00:00.000Z' }, context: ctx });
    const mine = msg('<@U0PERSONC> could you send me the logs?', { isMe: true });
    const [r] = await store.recordSourceItems(runId, [mine]);
    state.recorded.set(r!.dedupeKey, r!.sourceItemId);
    state.items.set(r!.dedupeKey, mine);
    const out = await runActions(createCcHandlers(store, state), state, actionsFor({ ...x(), sourceItemId: r!.sourceItemId, item: mine }, v({ title: 'Send PERSON_C the logs' }), { knownAccounts: new Set() }));
    expect(out).toEqual({ ok: 0, failed: 0, skipped: 1 });
    expect(store.listWorkItems()).toHaveLength(0);
  });
});

describe('Org62 rules', () => {
  const row = (externalId: string, payload: Record<string, unknown>, title: string, candidates: InterpretItem['candidates'] = [], excerpt = ''): InterpretItem => ({ ref: externalId, sourceItemId: `sid-${externalId}`, item: { connector: 'org62', kind: 'record_snapshot', externalId, dedupeKey: `org62:${externalId}`, contentHash: 'h', occurredAt: '2026-11-04T15:00:00.000Z', title, excerpt, oppHints: ['006XX0000000001AAA'], payload }, connector: 'org62', context: [], candidates, group: externalId, fresh: true });
  const c = (title: string, o: Partial<InterpretItem['candidates'][number]> = {}) => ({ alias: 'w1', workItemId: 'wi_1', title, why: 'opp', score: 0.6, state: 'open', ...o });
  const prefs = { channelAsks: 'ask' as const, meetingCatchUps: false, oppTeamCatchUps: false, mappingQuestions: 'mine' as const };
  const window = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-05T00:00:00.000Z' };
  it('an Event completes a "log activity" item; a DC completes a "DC" item; a stranded DC proposes a move', () => {
    const p = planOrg62([row('Event:00U1@x', {}, 'ACME POV readout', [c('Log activity for the ACME POV readout')]), row('Deal_Contribution__c:a1@x', { IsClosed: false }, 'DC on ACME', [c('Claim DC on ACME')]), row('Deal_Contribution__c:a2@x', { IsClosed: true, IsWon: false, Opportunity__c: '006XX0000000002AAA' }, 'DC on Globex')], { window, prefs, dcsOn: true });
    expect(p.actions.map((a) => [a.tool, a.tool === 'cc_link_evidence' ? a.args.role : a.tool === 'cc_propose_item' ? a.args.title : a.args.reason])).toEqual([
      ['cc_link_evidence', 'completion'],
      ['cc_link_evidence', 'completion'],
      ['cc_propose_item', 'Move stranded DC from Globex'],
    ]);
    expect(p.units).toEqual([]);
    expect(p.decided).toHaveLength(3);
  });
  it('closed lost contradicts the opp’s items; a next step naming my work with a date goes to the classifier', () => {
    const p = planOrg62([row('Opportunity:006A@x', { IsClosed: true, IsWon: false }, 'ACME renewal', [c('Prep the ACME demo')]), row('Opportunity:006B@x', { IsClosed: false }, 'Globex', [], 'stage=Discovery; next=SE to run the POC workshop by Friday')], { window, prefs, dcsOn: true });
    expect(p.actions).toEqual([{ tool: 'cc_link_evidence', args: expect.objectContaining({ role: 'contradiction', reason: 'opp_closed_lost: ACME renewal' }) }]);
    expect(p.units.map((u) => u.ref)).toEqual(['Opportunity:006B@x']);
  });
});
