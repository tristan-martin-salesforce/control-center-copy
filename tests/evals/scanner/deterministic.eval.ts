/**
 * The deterministic layer of the scanner evals (no model at all): over the golden cases and the in-memory store, in
 * milliseconds, assert what code decides before a model is asked.
 *
 *   fetch       which inbox searches return each Slack message (SCN-1), the 4,000-character excerpt cap (SCN-9)
 *   candidates  the deciding line of every expected close is a completion candidate (collectCandidates)
 *   rules       D1–D6 (src/scanner/resolution/rules.ts) decide what each golden case says they decide
 *   DUP-1       the conversation dedupe keeps one item per deliverable and per person
 *   policy      decideSettle on the golden storylines
 *   pack        "the deciding line is in the pack": the idea of scripts/settle/context-check.ts, as a unit test over
 *               the real pack builder (buildSettleContext) with no private answer key and no database
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CLOSING_SETTINGS } from '@/contract';
import { buildSettleContext } from '@/engines/settle/context';
import { decideSettle, type PolicyItem } from '@/engines/settle/policy';
import type { SettleResult } from '@/engines/settle/types';
import { collectCandidates } from '@/scanner/completion/candidates';
import type { CompletionModel } from '@/scanner/completion/types';
import { evaluateRules } from '@/scanner/resolution/rules';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import type { NormalizedSourceItem } from '@/scanner/types';

import { checkCase, loadGoldenCases, type GoldenCase } from './golden';
import { inboxQueries, runCase, type CaseRun } from './harness';
import { settleRawOf } from './pack';
import { memoryResolutionStore } from './resolution';
import { buildResolutionPack, packLines, ruleInputOfPack } from '@/engines/resolution/pack';

const cases = loadGoldenCases();
const byId = (id: string) => cases.find((c) => c.id.startsWith(id))!;
/** The deterministic layer never reaches a model: every call answers "nothing done". */
const noModel: CompletionModel = async (req) => ({ ok: true, text: JSON.stringify({ verdicts: (JSON.parse(req.user) as { items: Array<{ id: string }> }).items.map((i) => ({ item: i.id, verdict: 'not_done', basis: 'none', confidence: 0 })) }), costUsd: 0, inputTokens: 0, outputTokens: 0 });

const runs = new Map<string, CaseRun>();
beforeAll(async () => {
  for (const c of cases) runs.set(c.id, await runCase(c, noModel));
});

/** The resolution check's own view of an item (the production pack path over the in-memory store). */
const resolutionLoad = (run: CaseRun, wid: string) => memoryResolutionStore(run.store, () => run.sourceIds.values(), { version: new Map(), doneAt: new Map(), reopened: new Map(), reopenedAt: new Map() }, []).loadForCheck(wid, new Date(run.end));
const golden = (run: CaseRun, sourceItemId: string) => [...run.sourceIds.entries()].find(([, s]) => s === sourceItemId)?.[0] ?? sourceItemId;
/** The lines that decide a closure: its cite, or the follow-up that must reopen it. */
function decidingLines(c: GoldenCase, item: string, cite?: string): string[] {
  if (cite) return [cite];
  return c.sources.filter((s) => s.agent.some((a) => ('link' in a && a.link === item && a.role === 'contradiction') || 'propose_new' in a)).map((s) => s.id);
}

describe('golden fixtures', () => {
  it('every case loads, validates and cross-checks', () => {
    expect(cases.length).toBeGreaterThanOrEqual(11);
  });
  it('the cross-checks catch broken references', () => {
    const c = structuredClone(byId('wi-002'));
    c.closures_expected.push({ item: 'nope', expect: 'closed', class: 'still_owed', cite: 'zz', why: 'broken on purpose' });
    c.items_expected[0]!.keywords.push('not-in-title');
    const problems = checkCase(c);
    expect(problems.join('\n')).toMatch(/unknown item nope/);
    expect(problems.join('\n')).toMatch(/cite zz/);
    expect(problems.join('\n')).toMatch(/still-owed item cannot expect closed/);
    expect(problems.join('\n')).toMatch(/keyword "not-in-title"/);
  });
});

describe('fetch and record (REC-1, excerpt cap)', () => {
  it('inbox searches: DMs not from me (S1), @-mentions (S2), mine (S3, S4 with a file); a thread reply without a mention, none (SCN-1)', () => {
    const scn1 = byId('scn-1-');
    const me = scn1.me.slackId;
    expect(inboxQueries(scn1.sources.find((s) => s.id === 's1')!, me).map((q) => q.step)).toEqual(['S3']);
    expect(inboxQueries(scn1.sources.find((s) => s.id === 's2')!, me)).toEqual([]);
    expect(inboxQueries(byId('scn-4-').sources[0]!, me).map((q) => q.step)).toEqual(['S1']);
    expect(inboxQueries(byId('wi-004').sources[0]!, me).map((q) => q.step)).toEqual(['S2']);
  });

  it('every golden source is recorded; the SCN-1 thread reply through the recall sweep (R5), not a search', () => {
    for (const c of cases) {
      const run = runs.get(c.id)!;
      expect(c.sources.filter((s) => !run.sourceIds.has(s.id)).map((s) => `${c.id}/${s.id}`)).toEqual([]);
    }
    expect(runs.get(byId('scn-1-').id)!.threadReads).toBeGreaterThan(0);
  });

  it('stored excerpts keep up to 4,000 characters, so an ask past character 1,000 is visible (SCN-9, fixed by R6)', () => {
    const run = runs.get(byId('scn-9-').id)!;
    const row = run.store.getSourceItem(run.sourceIds.get('s1')!)!;
    expect(row.excerpt!.length).toBeGreaterThan(1000);
    expect(row.excerpt!.length).toBeLessThanOrEqual(4000);
    expect(row.excerpt).toContain('security whitepaper');
    expect(run.why.get('i1')).toBeUndefined();
  });
});

describe('candidate selection (collectCandidates)', () => {
  for (const c of cases) {
    for (const cl of c.closures_expected.filter((x) => x.cite && x.expect !== 'open' && !x.knownGap)) {
      // A cite the scanner agent linked itself (the Drive judge) never goes through the completion check.
      const linkedByAgent = c.sources.find((s) => s.id === cl.cite)!.agent.some((a) => 'link' in a && a.link === cl.item);
      if (linkedByAgent) continue;
      it(`${c.id}: ${cl.cite} is a strong candidate for ${cl.item}`, async () => {
        const run = runs.get(c.id)!;
        const wid = run.itemIds.get(cl.item)!;
        const item = (await run.store.completionItems({ statuses: ['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done', 'done', 'suggested'] })).find((x) => x.workItemId === wid)!;
        const sources = await run.store.completionSources({ seenAfter: '2000-01-01T00:00:00.000Z', seenUntil: run.end });
        const asked = { ...item, evidence: item.evidence.filter((e) => e.role !== 'completion') };
        const cands = collectCandidates(asked, sources, { seenAfter: 0, seenUntil: Date.parse(run.end) });
        const hit = cands.find((x) => x.source.sourceItemId === run.sourceIds.get(cl.cite!));
        expect(hit, `candidates: ${cands.map((x) => golden(run, x.source.sourceItemId)).join(', ')}`).toBeDefined();
        // a file revision or a session is its own relation and never strong (an edit alone never closes): Likely at most
        if (cl.expect === 'closed') expect(hit!.strong).toBe(true);
      });
    }
  }

  it('the ask itself and lines before it are never candidates', async () => {
    const run = runs.get(byId('wi-004').id)!;
    const item = (await run.store.completionItems({ statuses: ['done', 'open'] })).find((x) => x.workItemId === run.itemIds.get('i1'))!;
    const sources = await run.store.completionSources({ seenAfter: '2000-01-01T00:00:00.000Z', seenUntil: run.end });
    const ids = collectCandidates(item, sources, { seenAfter: 0, seenUntil: Date.parse(run.end) }).map((x) => golden(run, x.source.sourceItemId));
    expect(ids).not.toContain('s1');
  });
});

describe('resolution rules D1–D6 on the golden cases', () => {
  for (const c of cases) {
    for (const cl of c.closures_expected.filter((x) => x.rule)) {
      it(`${c.id}: ${cl.item} → ${cl.rule}`, async () => {
        const run = runs.get(c.id)!;
        const wid = run.itemIds.get(cl.item);
        expect(wid).toBeDefined();
        const loaded = (await resolutionLoad(run, wid!))!;
        const pack = buildResolutionPack(loaded.raw, { now: new Date(run.end), timezone: 'UTC', me: c.me.name });
        const r = evaluateRules({ ...ruleInputOfPack(pack, loaded.raw), lastVerdictAt: null });
        expect(r.decision?.rule ?? 'none').toBe(cl.rule);
        if (r.decision?.decides === 'done' && cl.cite) expect(golden(run, packLines(pack).get(r.decision.cite!)?.sourceItemId ?? '')).toBe(cl.cite);
      });
    }
  }
});

describe('DUP-1 (conversation dedupe)', () => {
  const ME = { name: 'Pat Example', externalId: 'U0ME00001', isMe: true };
  const A = { name: 'PERSON_A', externalId: 'U0PERSONA' };
  const B = { name: 'PERSON_B', externalId: 'U0PERSONB' };
  const T0 = Date.parse('2026-11-02T16:00:00.000Z');
  const world = () => {
    let now = T0;
    const store = new InMemoryScannerStore({ clock: { now: () => new Date(now) }, profile: { me: { userId: 'u', name: 'Pat Example', slackId: 'U0ME00001' }, watchList: [], aliases: { accounts: [], channels: [] } } });
    const msg = (min: number, text: string, author: typeof A, ch = 'D0DUP00001'): NormalizedSourceItem => {
      const ts = ((T0 + min * 60_000) / 1000).toFixed(6);
      return { connector: 'slack', kind: 'message', externalId: `${ch}:${ts}`, dedupeKey: `slack:${ch}:${ts}`, contentHash: `h${min}${ch}`, occurredAt: new Date(T0 + min * 60_000).toISOString(), author, participants: [author, ME], excerpt: text, threadRef: `slack:${ch}:${ts}`, payload: { channelId: ch, channelType: 'im', ts } };
    };
    const ask = async (min: number, title: string, m: NormalizedSourceItem) => {
      now = T0 + min * 60_000;
      const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: { from: new Date(now - 60_000).toISOString(), to: new Date(now).toISOString() } });
      const [r] = await store.recordSourceItems(runId, [m]);
      const p = await store.proposeItem(runId, { kind: 'ask', title, evidence: [{ sourceItemId: r!.sourceItemId, role: 'origin', reason: 'ask' }], confidence: 'sure' });
      await store.reportCoverage(runId, [{ kind: 'query_window', ref: 'x', from: new Date(now - 60_000).toISOString(), to: new Date(now).toISOString() }]);
      await store.finishRun(runId, { cursor: { value: 'x', at: new Date(now).toISOString() }, stats: { fetched: 1, new: 1, changed: 0, linked: 0, proposed: 1, unlinked: 0, costUsd: 0 } });
      return p.workItemId;
    };
    return { store, msg, ask };
  };

  it('the asker repeating the same ask in the same DM is one item', async () => {
    const w = world();
    const a = await w.ask(0, 'Send PERSON_A the ACME pricing deck', w.msg(0, 'can you send me the ACME pricing deck?', A));
    const b = await w.ask(30, 'Send the ACME pricing deck to PERSON_A', w.msg(30, 'any chance you can send the ACME pricing deck today?', A));
    expect(b).toBe(a);
  });

  it('the same words from another person, or in another conversation, are two items', async () => {
    const w = world();
    const a = await w.ask(0, 'Send the ACME pricing deck', w.msg(0, 'can you send me the ACME pricing deck?', A, 'D0DUP00001'));
    const b = await w.ask(5, 'Send the ACME pricing deck', w.msg(5, 'can you send me the ACME pricing deck?', B, 'D0DUP00002'));
    const c = await w.ask(9, 'Send the ACME pricing deck', w.msg(9, 'can you send me the ACME pricing deck too?', A, 'D0DUP00003'));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('a closed item more than 14 days back is not a duplicate target', async () => {
    const w = world();
    const a = await w.ask(0, 'Send the ACME pricing deck', w.msg(0, 'can you send me the ACME pricing deck?', A));
    w.store.setWorkItemState(a, 'done');
    const b = await w.ask(15 * 24 * 60, 'Send the ACME pricing deck', w.msg(15 * 24 * 60, 'can you send me the ACME pricing deck again?', A));
    expect(b).not.toBe(a);
  });
});

describe('Settle policy (decideSettle) on the golden storylines', () => {
  const S = DEFAULT_CLOSING_SETTINGS;
  const result = (verdict: SettleResult['verdict'], confidence: number, extra: Partial<SettleResult> = {}): SettleResult => ({ workItemId: 'w', verdict, confidence, reason: 'r', valid: true, model: 'claude-haiku-5-5', costUsd: 0, inputTokens: 0, outputTokens: 0, skill: 'settle-item@test', ...extra });
  const item = (extra: Partial<PolicyItem> = {}): PolicyItem => ({ id: 'w', kind: 'ask', status: 'open', userTouched: false, userReopened: false, externalCommitment: false, people: [], channels: [], originSource: 'slack', ...extra });

  it('wi-004: answered and agreed → closed for you (done by me)', () => {
    expect(decideSettle(result('done_by_you', 0.8), item(), S)).toMatchObject({ action: 'close', resolution: 'done_by_me' });
  });
  it('wi-006: still yours → left open', () => {
    expect(decideSettle(result('still_yours', 0.8), item(), S).action).toBe('leave');
  });
  it('wi-008: gone quiet on a commitment to a customer asks first; internal, it closes', () => {
    expect(decideSettle(result('gone_quiet', 0.6), item({ kind: 'commitment', status: 'in_progress', externalCommitment: true }), S).action).toBe('ask_still_needed');
    expect(decideSettle(result('gone_quiet', 0.6), item({ kind: 'commitment', status: 'in_progress' }), S)).toMatchObject({ action: 'close', resolution: 'not_needed' });
  });
  it('wi-060: an item the user reopened is never closed again by the check', () => {
    expect(decideSettle(result('done_by_you', 0.95), item({ userReopened: true }), S).action).toBe('leave');
  });
  it('wi-016: a weak done asks (Looks done) instead of closing', () => {
    expect(decideSettle(result('done_by_you', 0.45), item(), S).action).toBe('ask_looks_done');
  });
  it('SCN-9: a message cut before the part the item is about never closes as not-an-ask', () => {
    expect(decideSettle(result('not_an_ask', 0.9, { askCutOff: true }), item(), S).action).toBe('ask_still_needed');
  });
  it('an invalid or failed verdict leaves the item alone', () => {
    expect(decideSettle(result('done_by_you', 0.9, { valid: false, invalidWhy: 'cite' }), item(), S).action).toBe('leave');
  });
});

describe('pack completeness: the deciding line is in the Settle pack', () => {
  for (const c of cases) {
    // The Settle pack never carried files or sessions (SCN-8): those cites are checked on the resolution pack below.
    for (const cl of c.closures_expected.filter((x) => (!x.knownGap || x.knownGap === 'SCN-4') && !['drive', 'claude_sessions'].includes(c.sources.find((s) => s.id === x.cite)?.source ?? ''))) {
      const lines = decidingLines(c, cl.item, cl.cite);
      if (!lines.length) continue;
      it(`${c.id}: ${lines.join(', ')} in ${cl.item}'s pack`, () => {
        const run = runs.get(c.id)!;
        const wid = run.itemIds.get(cl.item)!;
        const raw = settleRawOf(run.store, wid, run.sourceIds.values())!;
        const ctx = buildSettleContext(raw, { now: new Date(run.end), timezone: 'UTC', me: c.me.name });
        const inPack = new Set([ctx.ask?.sourceItemId, ...[...ctx.before, ...ctx.after, ...ctx.elsewhere].map((l) => l.sourceItemId)].filter(Boolean));
        for (const g of lines) expect(inPack.has(run.sourceIds.get(g)), `${g} not in the pack (after=${ctx.after.length}, elsewhere=${ctx.elsewhere.length})`).toBe(true);
      });
    }
  }
});

describe('pack completeness: the deciding line is in the resolution pack, even under a tight token cap', () => {
  for (const c of cases) {
    for (const cl of c.closures_expected.filter((x) => !x.knownGap)) {
      const lines = decidingLines(c, cl.item, cl.cite);
      if (!lines.length) continue;
      for (const cap of [2500, 300]) {
        it(`${c.id}: ${lines.join(', ')} in ${cl.item}'s pack at ${cap} tokens`, async () => {
          const run = runs.get(c.id)!;
          const loaded = (await resolutionLoad(run, run.itemIds.get(cl.item)!))!;
          const pack = buildResolutionPack(loaded.raw, { now: new Date(run.end), timezone: 'UTC', me: c.me.name, tokenCap: cap });
          const inPack = new Set([...packLines(pack).values()].map((l) => l.sourceItemId).filter(Boolean));
          for (const g of lines) expect(inPack.has(run.sourceIds.get(g)), `${g} not in the pack (tokens=${pack.tokens}, trimmed=${pack.trimmed})`).toBe(true);
          if (cap === 2500) expect(pack.tokens).toBeLessThanOrEqual(2500);
        });
      }
    }
  }
});
