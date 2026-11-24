/** The decision ladder: rules first (no call), cheap batches by conversation, narrow data-gated escalation. */
import { describe, expect, it } from 'vitest';

import { batchesOf, certaintyOf, runLadder, type LadderEntry } from '@/engines/resolution/ladder';
import { buildResolutionPack } from '@/engines/resolution/pack';
import { escalationGate, shouldEscalate, worthEscalating } from '@/engines/resolution/escalation';
import { parseBatchReply, renderBatchPrompt } from '@/engines/resolution/prompt';
import type { ResolutionRaw } from '@/engines/resolution/types';

import { NOW, item, mine, line, raw, scripted, SKILL } from './fixtures';

const entry = (r: ResolutionRaw, o: Parameters<typeof item>[0] = {}): LadderEntry => ({ item: item({ id: r.item.id, ...o }), pack: buildResolutionPack(r, { now: NOW, timezone: 'UTC', me: 'Pat Example' }), raw: r });

describe('rules decide before any model (D1–D6 wired)', () => {
  it('D1: my reply carrying the deck closes it Sure with no model call', async () => {
    const { model, calls } = scripted(() => ({ verdict: 'not_done', confidence: 0 }));
    const r = raw({ after: [mine(5, 'here it is https://docs.google.com/presentation/d/FILE_PLACEHOLDER_01/edit')] });
    const [d] = await runLadder([entry(r)], { model, skill: SKILL, now: NOW, me: 'Pat Example' });
    expect(calls).toHaveLength(0);
    expect(d).toMatchObject({ decidedBy: 'rule', ruleHit: 'D1', verdict: 'done', certainty: 'sure' });
    expect(d!.cite?.fromMe).toBe(true);
  });

  it('D6: nothing new since the last check → skip, no call', async () => {
    const { model, calls } = scripted(() => ({ verdict: 'not_done', confidence: 0 }));
    const r = raw({ after: [line(5, 'hm, not sure yet')], extra: { lastCheck: { at: NOW.toISOString(), verdict: 'not_done', outcome: 'left' }, latestInputAt: line(5, '').at } });
    const [d] = await runLadder([entry(r)], { model, skill: SKILL, now: NOW, me: 'Pat Example' });
    expect(calls).toHaveLength(0);
    expect(d).toMatchObject({ decidedBy: 'skip', ruleHit: 'D6' });
  });

  it('a chase after my delivery vetoes D1 and goes to the model', async () => {
    const { model, calls } = scripted(() => ({ verdict: 'not_done', basis: 'none', confidence: 0.2 }));
    const r = raw({ after: [mine(5, 'here https://docs.google.com/presentation/d/FILE_PLACEHOLDER_01/edit'), line(60, "that link doesn't open, can you re-share?")] });
    const [d] = await runLadder([entry(r)], { model, skill: SKILL, now: NOW, me: 'Pat Example' });
    expect(calls).toHaveLength(1);
    expect(d).toMatchObject({ decidedBy: 'model', verdict: 'not_done' });
  });
});

describe('the cheap model: batched by conversation, cached prefix, pack only', () => {
  it('items sharing a conversation share one call (≤ 8); others get their own', async () => {
    const { model, calls } = scripted(() => ({ verdict: 'not_done', basis: 'none', confidence: 0.2 }));
    const same = Array.from({ length: 9 }, (_, i) => raw({ id: `s${i}`, title: `Send PERSON_A the deck number ${i}`, ask: `deck ${i}?` }));
    const other = raw({ id: 'o1', ask: 'other?', extra: {} });
    other.evidence[0] = { ...other.evidence[0]!, channelId: 'D0OTHER01' };
    const out = await runLadder([...same.map((r) => entry(r)), entry(other)], { model, skill: SKILL, now: NOW, me: 'Pat Example' });
    expect(out.every((d) => d.decidedBy === 'model')).toBe(true);
    expect(calls.map((c) => (JSON.parse(c.user) as { items: unknown[] }).items.length).sort()).toEqual([1, 1, 8]);
    // the system prompt is the skill body only (byte-stable: the cached prefix); the user prompt is the packs
    expect(new Set(calls.map((c) => c.system)).size).toBe(1);
    expect(calls[0]!.system).toMatch(/^# resolve-item/m);
    expect(calls[0]!.user).not.toMatch(/"id":"s\d"/); // internal ids stay out of the prompt
  });

  it('batchesOf groups by conversation key', () => {
    const e = (k: string) => ({ pack: { conversationKey: k } as never });
    expect(batchesOf([e('a'), e('b'), e('a')], 8).map((b) => b.length).sort()).toEqual([1, 2]);
  });

  it('a done must cite a line of that item: another item’s alias or a promise-less nothing is invalid', () => {
    const p = buildResolutionPack(raw({ after: [mine(5, 'Rough numbers: 1.8M members and 420k interactions a month.')] }), { now: NOW, timezone: 'UTC', me: 'me' });
    const { aliases } = renderBatchPrompt([p], { now: NOW, me: 'me' });
    const ok = parseBatchReply('{"verdicts":[{"item":"w1","verdict":"done","basis":"delivered","cite":"c1","confidence":0.9}]}', [p], aliases).verdicts.get('w1')!;
    expect(ok.valid).toBe(true);
    const bad = parseBatchReply('{"verdicts":[{"item":"w1","verdict":"done","basis":"delivered","cite":"zz9","confidence":0.9}]}', [p], aliases).verdicts.get('w1')!;
    expect(bad).toMatchObject({ valid: false });
    const asker = parseBatchReply('{"verdicts":[{"item":"w1","verdict":"done","basis":"delivered","cite":"a1","confidence":0.9}]}', [p], aliases).verdicts.get('w1')!;
    expect(asker.valid).toBe(false);
  });

  it('Sure needs my own line in the conversation, delivered or answered, at the skill’s bar', () => {
    const mineLine = { id: 'c1', kind: 'after', fromMe: true } as never;
    const fileLine = { id: 'f1', kind: 'file', fromMe: true } as never;
    const t = { sure: 0.85, likely: 0.65 };
    expect(certaintyOf({ verdict: 'done', basis: 'delivered', confidence: 0.9, cite: mineLine, needs: null, valid: true }, t)).toBe('sure');
    expect(certaintyOf({ verdict: 'done', basis: 'delivered', confidence: 0.9, cite: fileLine, needs: null, valid: true }, t)).toBe('likely');
    expect(certaintyOf({ verdict: 'done', basis: 'delivered', confidence: 0.7, cite: mineLine, needs: null, valid: true }, t)).toBe('likely');
    expect(certaintyOf({ verdict: 'done', basis: 'delivered', confidence: 0.5, cite: mineLine, needs: null, valid: true }, t)).toBeNull();
  });

  it('a failed call leaves the item for the next trigger', async () => {
    const out = await runLadder([entry(raw())], { model: async () => ({ ok: false, text: '', costUsd: 0, inputTokens: 0, outputTokens: 0, error: { message: 'x', errorClass: 'transient' } }), skill: SKILL, now: NOW, me: 'me' });
    expect(out[0]).toMatchObject({ decidedBy: 'failed' });
  });
});

describe('the narrow escalation (data-gated)', () => {
  const unsure = { verdict: 'done' as const, basis: 'delivered' as const, confidence: 0.6, cite: null, needs: null, valid: true };
  const hints = { myReplyAfterAskMin: 5, replyHasLinkOrFile: false, askerAckAfterMine: false, askerChasedAfterMine: false, lastWriter: 'me' as const };

  it('only state-changing, unsure verdicts on items worth it', () => {
    expect(shouldEscalate(unsure, hints, { dealUsd: 120_000 }, []).escalate).toBe(true);
    expect(shouldEscalate(unsure, hints, { personTier: 'customer_exec' }, []).escalate).toBe(true);
    expect(shouldEscalate(unsure, hints, { dealUsd: 5_000, personTier: 'normal' }, [])).toMatchObject({ escalate: false, why: 'gated:not_worth' });
    // still yours at good confidence never escalates; a sure done neither
    expect(shouldEscalate({ ...unsure, verdict: 'not_done', confidence: 0.3 }, hints, { dealUsd: 1e6 }, []).escalate).toBe(false);
    expect(shouldEscalate({ ...unsure, confidence: 0.92 }, hints, { dealUsd: 1e6 }, []).escalate).toBe(false);
    // a done that contradicts a chase escalates even when confident
    expect(shouldEscalate({ ...unsure, confidence: 0.95 }, { ...hints, askerChasedAfterMine: true }, { dealUsd: 1e6 }, []).reason).toBe('hint_conflict');
    expect(shouldEscalate(unsure, hints, { dealUsd: 1e6 }, [], false)).toMatchObject({ escalate: false, why: 'gated:off' });
  });

  it('stops escalating a reason when under 20 % of 14 days of escalations changed the verdict', () => {
    expect(escalationGate('uncertain', [{ reason: 'uncertain', escalations: 50, changed: 5 }])).toMatchObject({ allowed: false, rate: 0.1 });
    expect(escalationGate('uncertain', [{ reason: 'uncertain', escalations: 50, changed: 10 }]).allowed).toBe(true);
    // too few samples: keep learning
    expect(escalationGate('uncertain', [{ reason: 'uncertain', escalations: 4, changed: 0 }]).allowed).toBe(true);
    expect(shouldEscalate(unsure, hints, { dealUsd: 1e6 }, [{ reason: 'uncertain', escalations: 30, changed: 2 }]).why).toBe('gated:rate_7pct');
  });

  it('worthEscalating: deal size or the asker’s tier', () => {
    expect(worthEscalating(undefined)).toBe(false);
    expect(worthEscalating({ dealUsd: 50_000 })).toBe(true);
    expect(worthEscalating({ personTier: 'leader' })).toBe(true);
  });

  it('end to end: an unsure cheap done on a big deal goes to the strong model, which wins and is booked as changed', async () => {
    const booked: Array<{ tier: string; changed?: boolean; reason?: string }> = [];
    const { model, calls } = scripted((req) => (req.model.includes('sonnet') ? { verdict: 'not_done', basis: 'none', confidence: 0.7 } : { verdict: 'done', basis: 'delivered', cite: 'c1', confidence: 0.6 }));
    const r = raw({ after: [mine(5, 'Sent over the numbers you wanted in the deal summary, see the thread above for the context and the full assumptions.')] });
    const [d] = await runLadder([entry(r, { worth: { dealUsd: 200_000 } })], { model, skill: SKILL, now: NOW, me: 'me', onCall: (c) => void booked.push({ tier: c.tier, changed: c.changed, reason: c.escalationReason }) });
    expect(calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(d).toMatchObject({ decidedBy: 'escalation', verdict: 'not_done', escalated: true, escalationChanged: true });
    expect(booked).toEqual([{ tier: 'cheap', changed: undefined, reason: undefined }, { tier: 'strong', changed: true, reason: 'uncertain' }]);
  });
});
