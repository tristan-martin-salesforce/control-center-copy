/**
 * CMP-1 completion pass over the in-memory scanner store with a fake model: candidates → one call per batch →
 * gate → `completion` / `progress` evidence through `linkEvidence` (reason `done_check:`), watermark, budget,
 * and what the closure machine then does with the signal. Placeholder data only.
 */
import { describe, expect, it } from 'vitest';

import { applySignal } from '../../src/engines/closure/machine';
import type { ClosureItem } from '../../src/engines/types';
import { DONE_CHECK_PREFIX, gateVerdict, parseVerdicts, renderBatch, runCompletionPass, type CompletionModel, type CompletionModelRequest } from '../../src/scanner/completion';
import { InMemoryScannerStore } from '../../src/scanner/store-memory';
import type { NormalizedSourceItem } from '../../src/scanner/types';

const T0 = Date.parse('2026-11-02T16:00:00.000Z');
const ts = (min: number) => ((T0 + min * 60_000) / 1000).toFixed(6);
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ASKER = { name: 'PERSON_A', externalId: 'U0PERSONA' };
const ME = { name: 'ME', externalId: 'U0ME00001', isMe: true };
const OTHER = { name: 'PERSON_B', externalId: 'U0PERSONB' };

function world() {
  let now = T0;
  const clock = { now: () => new Date(now) };
  const store = new InMemoryScannerStore({ clock, profile: { me: { userId: 'u1', name: 'ME', slackId: 'U0ME00001' }, watchList: [], aliases: { accounts: [], channels: [] } } });
  const msg = (min: number, o: Partial<NormalizedSourceItem> & { text: string; ch?: string; thread?: number }): NormalizedSourceItem => {
    const ch = o.ch ?? 'D0DM00001';
    return {
      connector: 'slack',
      kind: 'message',
      externalId: `${ch}:${ts(min)}`,
      dedupeKey: `slack:${ch}:${ts(min)}`,
      contentHash: `h-${ch}-${min}`,
      occurredAt: iso(min),
      threadRef: `slack:${ch}:${ts(o.thread ?? min)}`,
      excerpt: o.text,
      author: o.author ?? ASKER,
      participants: ch.startsWith('D') ? [ASKER, ME] : undefined,
      ...o,
    };
  };
  /** One scan run at `atMin` that records `items` (time moves to atMin first). */
  const scan = async (atMin: number, items: NormalizedSourceItem[], propose?: { kind: 'ask' | 'commitment'; title: string; originIdx: number }) => {
    now = T0 + atMin * 60_000;
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: { from: iso(atMin - 5), to: iso(atMin) } });
    const rec = await store.recordSourceItems(runId, items);
    let workItemId: string | undefined;
    if (propose) workItemId = (await store.proposeItem(runId, { kind: propose.kind, title: propose.title, evidence: [{ sourceItemId: rec[propose.originIdx]!.sourceItemId, role: 'origin', reason: 'direct ask' }], confidence: 'sure' })).workItemId;
    await store.reportCoverage(runId, [{ kind: 'query_window', ref: 'search:dm', from: iso(atMin - 5), to: iso(atMin) }]);
    await store.finishRun(runId, { cursor: { value: ts(atMin), at: iso(atMin) }, stats: { fetched: items.length, new: items.length, changed: 0, linked: 0, proposed: propose ? 1 : 0, unlinked: 0, costUsd: 0 } });
    return { ids: rec.map((r) => r.sourceItemId), workItemId };
  };
  return { store, scan, msg, setNow: (min: number) => (now = T0 + min * 60_000), now: () => new Date(now) };
}

/** A fake model that answers from a function of the parsed request, and records every call. */
function fakeModel(answer: (req: { items: Array<{ id: string; title: string; candidates: Array<{ id: string; by: string; text: string }> }> }) => unknown) {
  const calls: CompletionModelRequest[] = [];
  const model: CompletionModel = async (req) => {
    calls.push(req);
    return { ok: true, text: JSON.stringify(answer(JSON.parse(req.user))), costUsd: 0.0007, inputTokens: 4000, outputTokens: 120 };
  };
  return { model, calls };
}

const doneIfMine = fakeModel((r) => ({
  verdicts: r.items.map((it) => {
    const mine = it.candidates.filter((c) => c.by === 'me' && /here is|confirmed/i.test(c.text)).pop();
    return mine ? { item: it.id, verdict: 'done', source: mine.id, basis: 'delivered', confidence: 0.95, reason: 'sent it in the DM' } : { item: it.id, verdict: 'not_done', basis: 'none', confidence: 0.2, reason: 'only a promise' };
  }),
}));

describe('completion pass (in-memory store, fake model)', () => {
  it('caps audit: every live item is read (was the newest 400)', async () => {
    const w = world();
    for (let i = 0; i < 405; i += 1) await w.scan(i, [w.msg(i, { text: `Can you send deck ${i}?`, ch: `D0DM${String(i).padStart(5, '0')}` })], { kind: 'ask', title: `Send deck ${i}`, originIdx: 0 });
    expect(await w.store.completionItems({})).toHaveLength(405);
    expect(await w.store.completionItems({ limit: 3 })).toHaveLength(3);
  });

  it('a promise kept two days later → one Sure completion with the done_check: prefix; the promise itself is not done', async () => {
    const w = world();
    const { model, calls } = doneIfMine;
    calls.length = 0;
    const s1 = await w.scan(0, [w.msg(0, { text: 'Can you send me the HIPAA answer for ACME?' }), w.msg(2, { text: "I'll check with the PM and get back to you", author: ME })], { kind: 'ask', title: 'Send PERSON_A the HIPAA answer', originIdx: 0 });
    w.setNow(10);
    const p1 = await runCompletionPass({ store: w.store, model, now: w.now(), watermark: null, limits: { settleMs: 0 } });
    expect(p1.calls).toBe(1);
    expect(p1.signals).toEqual([]);
    expect(p1.verdicts.not_done).toBe(1);
    // Day 3: my answer in the same DM.
    await w.scan(60 * 48, [w.msg(60 * 48 - 2, { text: 'Confirmed with the PM: here is the answer, eligible since October', author: ME })]);
    w.setNow(60 * 48 + 5);
    const p2 = await runCompletionPass({ store: w.store, model, now: w.now(), watermark: p1.watermark, limits: { settleMs: 0 } });
    expect(p2.calls).toBe(1);
    expect(p2.signals).toHaveLength(1);
    expect(p2.signals[0]).toMatchObject({ workItemId: s1.workItemId, role: 'completion', confidence: 'sure', gate: 'strong_mine' });
    const ev = w.store.evidenceFor(s1.workItemId!).filter((e) => e.role === 'completion');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.reason.startsWith(DONE_CHECK_PREFIX)).toBe(true);
    expect(ev[0]!.confidence).toBe('sure');
    // The pass ran inside a completion run of the cited source's connector; the item state is untouched (signal only).
    expect(w.store.listRuns({ connector: 'slack', scope: 'completion:check' }).every((r) => r.status === 'succeeded')).toBe(true);
    expect(w.store.getWorkItem(s1.workItemId!)!.state).toBe('open');
    // Spend recorded like the scanner's.
    expect(w.store.spendToday()).toBeGreaterThan(0);
  });

  it('R1: an item the user reopened gets at most Likely (user_corrected); one accepted from Triage may still close', async () => {
    const w = world();
    const { model } = doneIfMine;
    const reopened = await w.scan(0, [w.msg(0, { text: 'Can you send me the HIPAA answer for ACME?' })], { kind: 'ask', title: 'Send PERSON_A the HIPAA answer', originIdx: 0 });
    const accepted = await w.scan(1, [w.msg(1, { ch: 'D0DM00002', text: 'Can you send me the INITECH sizing?', author: OTHER, participants: [OTHER, ME] })], { kind: 'ask', title: 'Send PERSON_A the INITECH sizing', originIdx: 0 });
    w.store.setWorkItemState(reopened.workItemId!, 'open', { correction: 'reopened' });
    w.store.setWorkItemState(accepted.workItemId!, 'open'); // accepting from Triage is not a correction
    await w.scan(30, [w.msg(28, { text: 'Confirmed: here is the answer', author: ME }), w.msg(29, { ch: 'D0DM00002', text: 'Confirmed: here is the sizing', author: ME, participants: [OTHER, ME] })]);
    w.setNow(35);
    const p = await runCompletionPass({ store: w.store, model, now: w.now(), watermark: null, limits: { settleMs: 0 } });
    expect(p.signals.find((s) => s.workItemId === reopened.workItemId)).toMatchObject({ confidence: 'likely', gate: 'user_corrected' });
    expect(p.signals.find((s) => s.workItemId === accepted.workItemId)).toMatchObject({ confidence: 'sure', gate: 'strong_mine' });
  });

  it('nothing related → no model call; a second pass with nothing new → no call either', async () => {
    const w = world();
    const { model, calls } = fakeModel(() => ({ verdicts: [] }));
    await w.scan(0, [w.msg(0, { text: 'Can you review the ACME SOW?' })], { kind: 'ask', title: 'Review the ACME SOW', originIdx: 0 });
    await w.scan(30, [w.msg(29, { ch: 'C0OTHER001', text: 'unrelated channel chatter', author: { name: 'PERSON_Z', externalId: 'U0PERSONZ' } })]);
    w.setNow(40);
    const p1 = await runCompletionPass({ store: w.store, model, now: w.now(), watermark: null, limits: { settleMs: 0 } });
    expect(p1).toMatchObject({ status: 'nothing_new', calls: 0, withCandidates: 0, items: 1 });
    const p2 = await runCompletionPass({ store: w.store, model, now: w.now(), watermark: p1.watermark, limits: { settleMs: 0 } });
    expect(p2.calls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('at the daily hard cap nothing is called and the item stays pending; the next budget day checks it', async () => {
    const w = world();
    const { model, calls } = doneIfMine;
    calls.length = 0;
    const s = await w.scan(0, [w.msg(0, { text: 'Can you send the deck?' })], { kind: 'ask', title: 'Send the deck', originIdx: 0 });
    await w.scan(20, [w.msg(19, { text: 'Here is the deck: https://docs.google.com/presentation/d/FILE_DECK_00000001/edit', author: ME })]);
    w.setNow(25);
    w.store.hardCapUsd = 0.0001;
    await w.store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 0.001, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    const p1 = await runCompletionPass({ store: w.store, model, now: w.now(), watermark: null, limits: { settleMs: 0 } });
    expect(p1.status).toBe('deferred_budget');
    expect(calls).toHaveLength(0);
    expect(Object.keys(p1.watermark.pending)).toEqual([s.workItemId]);
    w.store.hardCapUsd = 15;
    w.setNow(60 * 24 + 25);
    const p2 = await runCompletionPass({ store: w.store, model, now: w.now(), watermark: p1.watermark, limits: { settleMs: 0 } });
    expect(p2.signals.map((x) => x.workItemId)).toEqual([s.workItemId]);
    expect(p2.watermark.pending).toEqual({});
  });

  it('a failed call keeps the batch pending; a reply citing another item’s source is invalid', async () => {
    const w = world();
    const a = await w.scan(0, [w.msg(0, { text: 'Can you send the deck?' }), w.msg(1, { ch: 'D0DM00002', text: 'Can you send the SOW?', author: { name: 'PERSON_B', externalId: 'U0PERSONB' }, participants: [{ name: 'PERSON_B', externalId: 'U0PERSONB' }, ME] })], { kind: 'ask', title: 'Send the deck', originIdx: 0 });
    await w.scan(20, [w.msg(19, { text: 'Here is the deck', author: ME })]);
    w.setNow(25);
    const failing: CompletionModel = async () => ({ ok: false, text: '', costUsd: 0, inputTokens: 0, outputTokens: 0, error: { message: 'overloaded', errorClass: 'transient' } });
    const p1 = await runCompletionPass({ store: w.store, model: failing, now: w.now(), watermark: null, limits: { settleMs: 0 } });
    expect(p1.status).toBe('partial');
    expect(p1.watermark.pending[a.workItemId!]).toBeDefined();
    // Model cites a source alias that does not exist for this item.
    const wrong = fakeModel((r) => ({ verdicts: r.items.map((it) => ({ item: it.id, verdict: 'done', source: 's99', confidence: 0.99, reason: 'x' })) }));
    const p2 = await runCompletionPass({ store: w.store, model: wrong.model, now: w.now(), watermark: p1.watermark, limits: { settleMs: 0 } });
    expect(p2.calls).toBe(1);
    expect(p2.verdicts.invalid).toBe(1);
    expect(p2.signals).toEqual([]);
  });

  it('one message judged to finish two asks of the same person never auto-closes either (Likely, shared_citation)', async () => {
    const w = world();
    const a = await w.scan(0, [w.msg(0, { text: 'Can you send the deck?' })], { kind: 'ask', title: 'Send the deck', originIdx: 0 });
    const b = await w.scan(2, [w.msg(2, { text: 'And the SOW too?' })], { kind: 'ask', title: 'Send the SOW', originIdx: 0 });
    await w.scan(20, [w.msg(19, { text: 'Here is the deck', author: ME })]);
    w.setNow(25);
    const greedy = fakeModel((r) => ({ verdicts: r.items.map((it) => ({ item: it.id, verdict: 'done', source: it.candidates.at(-1)!.id, basis: 'delivered', confidence: 0.97, reason: 'sent it' })) }));
    const p = await runCompletionPass({ store: w.store, model: greedy.model, now: w.now(), watermark: null, limits: { settleMs: 0 } });
    expect(p.signals.map((s) => [s.workItemId, s.confidence, s.gate]).sort()).toEqual(
      [
        [a.workItemId, 'likely', 'shared_citation'],
        [b.workItemId, 'likely', 'shared_citation'],
      ].sort(),
    );
  });

  it('dry run returns the signals and writes nothing', async () => {
    const w = world();
    const s = await w.scan(0, [w.msg(0, { text: 'Can you send the deck?' })], { kind: 'ask', title: 'Send the deck', originIdx: 0 });
    await w.scan(20, [w.msg(19, { text: 'Here is the deck', author: ME })]);
    w.setNow(25);
    const p = await runCompletionPass({ store: w.store, model: doneIfMine.model, now: w.now(), watermark: null, dryRun: true, limits: { settleMs: 0 } });
    expect(p.signals).toHaveLength(1);
    expect(p.runIds).toEqual([]);
    expect(w.store.evidenceFor(s.workItemId!).filter((e) => e.role === 'completion')).toEqual([]);
  });
});

describe('the precision gate and the closure machine', () => {
  const cand = (o: { fromMe: boolean; strong: boolean; connector?: 'slack' | 'drive' }) => ({
    source: { sourceItemId: 'src-1', connector: o.connector ?? 'slack', kind: 'message', externalId: 'D0DM00001:1', occurredAt: iso(5), seenAt: iso(5), fromMe: o.fromMe, fileRefs: [], accountHints: [] },
    relations: o.strong ? (['same_dm'] as const) : (['same_channel'] as const),
    strong: o.strong,
  });
  const v = (verdict: 'done' | 'partial' | 'not_done', confidence: number, c = cand({ fromMe: true, strong: true })) => ({ workItemId: 'wi-1', verdict, sourceItemId: 'src-1', confidence, reason: 'sent it', candidate: { ...c, relations: [...c.relations] } });

  it('Sure only for my own message, strongly tied, at ≥ 0.9; otherwise Likely; partial → progress; below the floors → nothing', () => {
    expect(gateVerdict(v('done', 0.95))).toMatchObject({ role: 'completion', confidence: 'sure', gate: 'strong_mine' });
    expect(gateVerdict(v('done', 0.85))).toMatchObject({ role: 'completion', confidence: 'likely' });
    expect(gateVerdict(v('done', 0.97, cand({ fromMe: false, strong: true })))).toMatchObject({ confidence: 'likely' });
    expect(gateVerdict(v('done', 0.97, cand({ fromMe: true, strong: false })))).toMatchObject({ confidence: 'likely' });
    expect(gateVerdict(v('done', 0.6))).toBeNull();
    expect(gateVerdict(v('partial', 0.8))).toMatchObject({ role: 'progress', reason: expect.stringMatching(/^done_check: partial: /) });
    expect(gateVerdict(v('partial', 0.5))).toBeNull();
    expect(gateVerdict(v('not_done', 0.99))).toBeNull();
  });

  it('RES-1: the asker settling it (resolved / done_by_other, their message, from_asker) is Sure and names them; others stay Likely', () => {
    const L = { sureMinConfidence: 0.8, likelyMinConfidence: 0.7, partialMinConfidence: 0.6, sureBasis: ['delivered'], sureResolvedBasis: ['resolved', 'done_by_other'] };
    const asker = { ...cand({ fromMe: false, strong: false }), relations: ['same_dm', 'from_asker'] as const, source: { ...cand({ fromMe: false, strong: false }).source, author: { name: 'PERSON_A' } } };
    const groupOther = { ...cand({ fromMe: false, strong: false }), relations: ['same_dm'] as const, source: { ...cand({ fromMe: false, strong: false }).source, author: { name: 'PERSON_B' } } };
    expect(gateVerdict({ ...v('done', 0.85, asker as never), basis: 'resolved', reason: 'asker cancelled the prep session' }, L)).toMatchObject({ confidence: 'sure', gate: 'asker_resolved', reason: 'done_check: Resolved by PERSON_A: asker cancelled the prep session' });
    expect(gateVerdict({ ...v('done', 0.85, groupOther as never), basis: 'done_by_other' }, L)).toMatchObject({ confidence: 'likely' }); // not the asker
    expect(gateVerdict({ ...v('done', 0.75, asker as never), basis: 'resolved' }, L)).toMatchObject({ confidence: 'likely' }); // below the Sure floor
    expect(gateVerdict({ ...v('not_done', 0.9, asker as never), basis: 'none', reason: 'asker has not decided yet' }, L)).toBeNull(); // a maybe
  });

  it('with a skill that declares sure_basis, Sure also needs that basis; a done whose basis is none/partial is dropped', () => {
    const L = { sureMinConfidence: 0.8, likelyMinConfidence: 0.7, partialMinConfidence: 0.6, sureBasis: ['delivered'] };
    expect(gateVerdict({ ...v('done', 0.8), basis: 'delivered' }, L)).toMatchObject({ confidence: 'sure', basis: 'delivered' });
    expect(gateVerdict({ ...v('done', 0.95), basis: 'pointer' }, L)).toMatchObject({ confidence: 'likely' });
    expect(gateVerdict({ ...v('done', 0.95), basis: 'done_by_other' }, L)).toMatchObject({ confidence: 'likely' });
    expect(gateVerdict({ ...v('done', 0.95) }, L)).toMatchObject({ confidence: 'likely' });
    expect(gateVerdict({ ...v('done', 0.95), basis: 'none' }, L)).toBeNull();
    expect(gateVerdict({ ...v('done', 0.79), basis: 'delivered' }, L)).toMatchObject({ confidence: 'likely' });
  });

  it('closure: Sure completion auto-closes (Closed for you), Likely asks to confirm, progress moves to in progress', () => {
    const item: ClosureItem = { id: 'wi-1', version: 1, kind: 'ask', status: 'open', title: 'Send the deck', resolution: null, involvement: 'owner' };
    const sig = (role: 'completion' | 'progress', confidence: 'sure' | 'likely') => ({ type: 'evidence' as const, role, confidence, evidenceId: 'ev-1', at: iso(20), actor: { name: 'ME', isMe: true }, source: 'slack' as const, reason: `${DONE_CHECK_PREFIX} sent it` });
    const sure = applySignal(item, sig('completion', 'sure'));
    expect(sure.transition?.to).toBe('done');
    expect(sure.labels.some((l) => l.kind === 'auto_closed')).toBe(true);
    expect(sure.resolution?.resolution).toBe('done_by_me');
    expect(applySignal(item, sig('completion', 'likely')).transition?.to).toBe('likely_done');
    expect(applySignal(item, sig('progress', 'likely')).transition?.to).toBe('in_progress');
  });
});

describe('prompt', () => {
  it('aliases ids, clips text, and parses verdicts back (tolerating a code fence)', async () => {
    const w = world();
    const s = await w.scan(0, [w.msg(0, { text: 'Can you send the deck?' })], { kind: 'ask', title: 'Send the deck', originIdx: 0 });
    await w.scan(20, [w.msg(19, { text: `Here is the deck ${'x'.repeat(2000)}`, author: ME })]);
    const items = await w.store.completionItems({});
    const sources = await w.store.completionSources({ seenAfter: iso(10), seenUntil: iso(30) });
    const { itemFacts, collectCandidates } = await import('../../src/scanner/completion/candidates');
    const facts = itemFacts(items[0]!);
    const candidates = collectCandidates(items[0]!, sources, { seenAfter: Date.parse(iso(10)), seenUntil: Date.parse(iso(30)) }, facts);
    const { user, ids } = renderBatch([{ item: items[0]!, facts, candidates }], { now: iso(30), meName: 'ME' });
    expect(user).not.toContain(s.workItemId!);
    expect(user).toContain('"id":"w1"');
    expect(user.length).toBeLessThan(2000);
    const parsed = parseVerdicts('```json\n{"verdicts":[{"item":"w1","verdict":"done","source":"s1","basis":"delivered","confidence":"0.9","reason":"sent it"}]}\n```', ids);
    expect(parsed.verdicts[0]).toMatchObject({ workItemId: s.workItemId, verdict: 'done', confidence: 0.9, basis: 'delivered' });
    // An unknown basis is dropped, not fatal.
    expect(parseVerdicts('{"verdicts":[{"item":"w1","verdict":"done","source":"s1","basis":"vibes","confidence":0.9}]}', ids).verdicts[0]!.basis).toBeUndefined();
    expect(parseVerdicts('no json here', ids).error).toBeDefined();
  });
});
