/**
 * The FTI classifier: strict output validation (zod, per entry), confidence words in code, batching by token budget
 * (not a fixed count, conversations kept together), and the second pass below the confidence floor.
 */
import { describe, expect, it } from 'vitest';

import { classifierHash, classifyInBatches, confidenceWord, itemTokens, LIVE_BUDGET, packBatches, parseClassifierOutput, renderBatch, renderGlossary, renderSystem, replyTokensFor, type ClassifierModel, type InterpretItem } from '@/scanner/interpret';

const unit = (ref: string, group: string, text = 'can you send the deck?', extra: Partial<InterpretItem> = {}): InterpretItem => ({
  ref,
  sourceItemId: `sid-${ref}`,
  item: { connector: 'slack', kind: 'message', externalId: ref, dedupeKey: `slack:${ref}`, contentHash: 'h', occurredAt: '2026-11-04T15:00:00.000Z', excerpt: text, author: { name: 'PERSON_A', externalId: 'U0PERSONA' }, payload: { channelId: 'D0DM00001', channelType: 'im', ts: '1.0' } },
  connector: 'slack',
  to: ' → me',
  context: [],
  candidates: [],
  group,
  fresh: true,
  ...extra,
});

describe('glossary', () => {
  it('caps audit: names every account, channel and initiative (was the first 40 / 40 / 25 by id)', () => {
    const accounts = Array.from({ length: 60 }, (_, i) => ({ accountId: `acc_${String(i).padStart(3, '0')}`, names: [`Account ${i}`] }));
    const channels = Array.from({ length: 45 }, (_, i) => ({ channelId: `C${String(i).padStart(4, '0')}`, label: `#ch-${i}` }));
    const initiatives = Array.from({ length: 30 }, (_, i) => ({ title: `Initiative ${i}` }));
    const g = renderGlossary({ me: { userId: 'u', name: 'ME' }, aliases: { accounts, channels }, initiatives } as never);
    expect(g).toContain('acc_059: Account 59');
    expect(g).toContain('C0044 #ch-44');
    expect(g).toContain('Initiative 29');
  });
});

describe('output schema', () => {
  it('validates each verdict on its own; a bad entry costs only itself', () => {
    const out = parseClassifierOutput(JSON.stringify({ verdicts: [{ ref: 'a', v: 'ask', title: 'Send the deck', conf: 0.9 }, { ref: 'b', v: 'maybe', conf: 1 }, { v: 'noise' }, { ref: 'c', v: 'noise', conf: '0.4', due: 'tomorrow' }] }));
    expect(out.malformed).toBe(false);
    expect(out.verdicts.map((v) => v.ref)).toEqual(['a', 'c']);
    expect(out.verdicts[1]).toMatchObject({ conf: 0.4, due: null });
    expect(out.invalid.map((i) => i.index)).toEqual([1, 2]);
  });
  it('reads a fenced reply, and calls a reply with no verdicts object malformed', () => {
    expect(parseClassifierOutput('```json\n{"verdicts":[{"ref":"a","v":"fyi","conf":0.7}]}\n```').verdicts).toHaveLength(1);
    expect(parseClassifierOutput('I think it is an ask.').malformed).toBe(true);
    expect(parseClassifierOutput('{"items":[]}').malformed).toBe(true);
  });
  it('clips long text fields instead of failing them', () => {
    const v = parseClassifierOutput(JSON.stringify({ verdicts: [{ ref: 'a', v: 'ask', title: 'x'.repeat(400), why: 'y'.repeat(400), conf: 0.9 }] })).verdicts[0]!;
    expect(v.title!.length).toBe(160);
    expect(v.why!.length).toBe(120);
  });
  it('maps confidence to the R8 words in code', () => {
    expect([0.95, 0.85, 0.7, 0.6, 0.59, 0].map(confidenceWord)).toEqual(['sure', 'sure', 'likely', 'likely', 'guess', 'guess']);
  });
});

describe('batching by token budget', () => {
  it('fills a batch until the next entry would pass the input budget, never by a fixed count', () => {
    // bodies show at most 1,500 characters, so a long message is ~700 tokens of the 6K input budget
    const small = Array.from({ length: 25 }, (_, i) => unit(`D0:${i}.0`, `g${i}`, 'ok can you send it?'));
    const big = Array.from({ length: 12 }, (_, i) => unit(`D1:${i}.0`, `h${i}`, 'x '.repeat(2000)));
    const s = packBatches(small, LIVE_BUDGET);
    const b = packBatches(big, LIVE_BUDGET);
    expect(s.length).toBe(1); // 25 short messages fit one call
    expect(b.length).toBe(2); // twelve long ones do not, although they are fewer
    for (const batch of b) expect(batch.reduce((n, x) => n + itemTokens(x), 0) <= LIVE_BUDGET.inputTokens || batch.length === 1).toBe(true);
  });
  it('the reply budget bounds the items per call', () => {
    const many = Array.from({ length: 120 }, (_, i) => unit(`D0:${i}.0`, `g${i}`, 'k?'));
    const batches = packBatches(many, { inputTokens: 1_000_000, outputTokens: 900 });
    expect(Math.max(...batches.map((x) => x.length))).toBe(Math.floor((900 - 60) / 90));
    expect(replyTokensFor(9)).toBe(60 + 9 * 90);
  });
  it('keeps a conversation in one batch when it fits a fresh one', () => {
    const long = 'x '.repeat(2000);
    const items = [...Array.from({ length: 5 }, (_, i) => unit(`a:${i}`, 'c1', long)), ...Array.from({ length: 5 }, (_, i) => unit(`b:${i}`, 'c2', long))];
    const batches = packBatches(items, LIVE_BUDGET);
    // c2 does not fit what is left of the first call, but fits a fresh one: it moves whole instead of being cut
    expect(batches.map((b) => b.map((x) => x.group))).toEqual([Array(5).fill('c1'), Array(5).fill('c2')]);
  });
});

describe('prompt and second pass', () => {
  const system = renderSystem('# classify-items\nrules…', { me: { userId: 'u', name: 'ME', slackId: 'U0ME00001' }, aliases: { accounts: [{ accountId: 'acc-1', names: ['ACME'] }], channels: [] }, initiatives: [] });
  it('the cacheable prefix is the skill alone; the per-user glossary follows it; the batch carries no ids or clock', () => {
    expect(system.system.slice(0, system.cacheBoundary)).toBe('# classify-items\nrules…\n\n');
    expect(system.system.slice(system.cacheBoundary)).toContain('acc-1: ACME');
    const user = renderBatch([unit('D0:1.0', 'g', 'can you send the deck?', { candidates: [{ alias: 'w1', workItemId: 'wi_secret_id', title: 'Send the deck', why: 'same thread', score: 0.9, state: 'open' }] })], { index: 1, total: 1 });
    expect(user).toContain('candidates: w1 "Send the deck" (same thread, open)');
    expect(user).not.toContain('wi_secret_id');
  });
  it('a verdict below the floor (or a missing ref) gets a second, wider call; still unsure is returned as unsure', async () => {
    const seen: string[] = [];
    const model: ClassifierModel = async (req) => {
      const second = req.user.includes('second look');
      seen.push(second ? 'reclassify' : 'classify');
      const text = second ? JSON.stringify({ verdicts: [{ ref: 'D0:1.0', v: 'ask', title: 'Send the deck', conf: 0.9 }] }) : JSON.stringify({ verdicts: [{ ref: 'D0:1.0', v: 'ask', title: 'Send the deck', conf: 0.4 }, { ref: 'D0:3.0', v: 'noise', conf: 0.9 }] });
      return { ok: true, text, costUsd: 0.0005, inputTokens: 400, outputTokens: 80, cacheReadTokens: 2000, cacheWriteTokens: 0 };
    };
    const calls: string[] = [];
    let out: Awaited<Parameters<Parameters<typeof classifyInBatches>[2]>[1]> | undefined;
    await classifyInBatches([unit('D0:1.0', 'g'), unit('D0:2.0', 'g'), unit('D0:3.0', 'g')], { model, modelId: 'claude-haiku-5-5', skillVersion: 'classify-items@1.0.0', system: system.system, cacheBoundary: system.cacheBoundary, budget: LIVE_BUDGET, maxBudgetUsd: 0.02, onCall: (c) => calls.push(`${c.pass}:${c.itemsIn}:${c.contentHash}`) }, async (_b, o) => {
      out = o;
    });
    expect(seen).toEqual(['classify', 'reclassify']);
    expect(out!.verdicts.get('D0:1.0')).toMatchObject({ v: 'ask', conf: 0.9 });
    expect(out!.verdicts.get('D0:3.0')).toMatchObject({ v: 'noise' });
    expect(out!.unsure.get('D0:2.0')).toMatchObject({ why: 'no usable verdict from the classifier' });
    expect(calls.map((c) => c.split(':').slice(0, 2).join(':'))).toEqual(['classify:3', 'reclassify:2']);
  });
  it('keys each call like the completion pass (the cassette key and the D0 content hash)', () => {
    expect(classifierHash('m', 'classify-items@1.0.0', 'sys', 'user')).toBe(classifierHash('m', 'classify-items@1.0.0', 'sys', 'user'));
    expect(classifierHash('m', 'classify-items@1.0.0', 'sys', 'user')).not.toBe(classifierHash('m', 'classify-items@1.0.1', 'sys', 'user'));
  });
  it('a failed call fails the run with its error class (the runtime retries)', async () => {
    const model: ClassifierModel = async () => ({ ok: false, text: '', costUsd: 0, inputTokens: 0, outputTokens: 0, error: { message: 'rate limited', errorClass: 'rate_limited' } });
    const err = await classifyInBatches([unit('D0:1.0', 'g')], { model, modelId: 'm', skillVersion: 's', system: 's', cacheBoundary: 1, budget: LIVE_BUDGET, maxBudgetUsd: 0.02 }, async () => undefined).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ClassifierCallError', errorClass: 'rate_limited' });
  });
});
