/** Cassette model: replay by ledger hash, strict misses, offline rekey, recording. Placeholder data only. */
import { describe, expect, it } from 'vitest';

import { ledgerHash } from '@/db/ledger';

import { CassetteMissError, cassetteHash, cassetteModel, recordingModel, type CassetteEntry } from './cassette';
import type { CompletionModelRequest } from './types';

const req = (user: string): CompletionModelRequest => ({ system: 'SKILL BODY', user, model: 'claude-haiku-5-5', maxBudgetUsd: 0.05 });
const SKILL = 'check-completion@9.9.9';
const labelOf = (r: CompletionModelRequest) => (JSON.parse(r.user) as { label: string }).label;

describe('cassetteModel', () => {
  it('keys calls by the completion pass ledger hash and replays at zero cost', async () => {
    const r = req('{"label":"a"}');
    expect(cassetteHash(r, SKILL)).toBe(ledgerHash('claude-haiku-5-5', SKILL, 'SKILL BODY', '{"label":"a"}'));
    const c = cassetteModel({ skill: SKILL, entries: [{ hash: cassetteHash(r, SKILL), label: 'a', text: '{"verdicts":[]}', origin: 'hand' }] });
    const out = await c.model(r);
    expect(out).toMatchObject({ ok: true, text: '{"verdicts":[]}', costUsd: 0, inputTokens: 0, outputTokens: 0 });
    expect(c.used.size).toBe(1);
  });

  it('a missing key fails with the prompt hash (strict)', async () => {
    const c = cassetteModel({ skill: SKILL, entries: [], labelOf });
    const r = req('{"label":"new prompt"}');
    await expect(c.model(r)).rejects.toThrow(CassetteMissError);
    await expect(c.model(r)).rejects.toThrow(cassetteHash(r, SKILL));
    expect(c.misses[0]).toEqual({ hash: cassetteHash(r, SKILL), label: 'new prompt' });
  });

  it('the skill version is part of the key: a skill bump is a miss', async () => {
    const r = req('{"label":"a"}');
    const c = cassetteModel({ skill: 'check-completion@9.9.10', entries: [{ hash: cassetteHash(r, SKILL), label: 'a', text: 'x', origin: 'hand' }] });
    await expect(c.model(r)).rejects.toThrow(CassetteMissError);
  });

  it('rekey mode finds an entry by label, re-keys it and reports the change', async () => {
    const entries: CassetteEntry[] = [{ hash: null, label: 'a', text: '{"verdicts":[]}', origin: 'hand' }];
    const c = cassetteModel({ skill: SKILL, entries, labelOf, mode: 'rekey' });
    const r = req('{"label":"a"}');
    expect((await c.model(r)).text).toBe('{"verdicts":[]}');
    expect(entries[0]!.hash).toBe(cassetteHash(r, SKILL));
    expect(c.rekeyed).toEqual([{ label: 'a', from: null, to: cassetteHash(r, SKILL) }]);
    await expect(c.model(req('{"label":"b"}'))).rejects.toThrow(CassetteMissError);
  });

  it('a recorded failure replays as a failed call', async () => {
    const r = req('{"label":"a"}');
    const c = cassetteModel({ skill: SKILL, entries: [{ hash: cassetteHash(r, SKILL), label: 'a', text: '', ok: false, origin: 'live' }] });
    expect(await c.model(r)).toMatchObject({ ok: false, error: { errorClass: 'transient' } });
  });
});

describe('recordingModel', () => {
  it('captures each live call as an entry with its hash, label and cost', async () => {
    const live = async () => ({ ok: true, text: '{"verdicts":[]}', costUsd: 0.001, inputTokens: 100, outputTokens: 10 });
    const rec = recordingModel(live, { skill: SKILL, labelOf, now: () => new Date('2026-11-20T00:00:00.000Z') });
    const r = req('{"label":"a"}');
    await rec.model(r);
    expect(rec.entries).toEqual([{ hash: cassetteHash(r, SKILL), label: 'a', text: '{"verdicts":[]}', origin: 'live', model: 'claude-haiku-5-5', skill: SKILL, recordedAt: '2026-11-20T00:00:00.000Z', costUsd: 0.001 }]);
    expect(rec.costUsd()).toBe(0.001);
    // Replaying what was recorded gives the same text.
    expect((await cassetteModel({ skill: SKILL, entries: rec.entries }).model(r)).text).toBe('{"verdicts":[]}');
  });
});
