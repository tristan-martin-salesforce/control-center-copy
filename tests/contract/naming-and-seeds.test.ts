/**
 * CONTRACT-1 tasks 5, 7, 8 + seed compatibility: scanner contract fold-in, compose ↔ rendition names,
 * the review_deliverable verb, and both seeds (committed example + the private fixture, if present).
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERB_CHIP, VERB_LABEL } from '@/components/domain/vocab';
import { NbaVerb, RenditionFormat, Seed } from '@/contract';
import { nbaType, renditionFormat } from '@/db/schema/enums';
import { fromRenditionFormat, PROFILES, toRenditionFormat, type ProfileId, type RenditionFormatName } from '@/lib/compose';
import * as ext from '@/scanner/runtime/contract-ext';
import * as scannerTypes from '@/scanner/types';
import type { OpenItemDigest, SkillRunInput, SkillRunResult, UnlinkedSourceItemDetail } from '@/scanner/types';
import { parseSeed, shiftDates } from '@/server/datasource/mock/seed-loader';
import { rawExampleSeed } from './helpers';

describe('compose profile ↔ rendition format names', () => {
  it('plain ↔ plain_text; the others are identical; round-trips for every profile', () => {
    expect(toRenditionFormat('plain')).toBe('plain_text');
    expect(fromRenditionFormat('plain_text')).toBe('plain');
    for (const id of Object.keys(PROFILES) as ProfileId[]) expect(fromRenditionFormat(toRenditionFormat(id))).toBe(id);
  });

  it('the names match the contract enum exactly and are all DB rendition_format values', () => {
    const names = (Object.keys(PROFILES) as ProfileId[]).map(toRenditionFormat).sort();
    expect(names).toEqual([...RenditionFormat.options].sort());
    const typed: RenditionFormatName[] = RenditionFormat.options; // compile-time: contract ⊆ compose names
    expect(typed.every((n) => (renditionFormat.enumValues as readonly string[]).includes(n))).toBe(true);
  });

  it('DB-only formats: email_text renders as plain, canvas_markdown and unknowns have no profile', () => {
    expect(fromRenditionFormat('email_text')).toBe('plain');
    expect(fromRenditionFormat('canvas_markdown')).toBeNull();
    expect(fromRenditionFormat('rtf')).toBeNull();
  });
});

describe('NBA verb review_deliverable', () => {
  it('is in the DB nba_type enum (migration 0004) and the contract NbaVerb, with both UI verb maps (INTEGRATE-1)', () => {
    expect(nbaType.enumValues).toContain('review_deliverable');
    expect(NbaVerb.options).toContain('review_deliverable');
    expect(NbaVerb.options).toContain('review');
    expect(VERB_LABEL.review_deliverable).toBe('Review');
    expect(VERB_CHIP.review_deliverable).toBe('Review');
    expect(readFileSync(path.resolve(__dirname, '../../src/db/migrations/0004_nba_type_review_deliverable.sql'), 'utf8')).toMatch(/ALTER TYPE "public"\."nba_type" ADD VALUE IF NOT EXISTS 'review_deliverable'/);
  });
});

describe('scanner contract fold-in', () => {
  it('contract-ext re-exports the contract values (same functions, same constants)', () => {
    expect(ext.isContextOnly).toBe(scannerTypes.isContextOnly);
    expect(ext.LOOP_BACK_PREFIX).toBe(scannerTypes.LOOP_BACK_PREFIX);
    expect(scannerTypes.isContextOnly({ resolution: 'handed_off' })).toBe(true);
    expect(scannerTypes.isContextOnly({ involvement: 'owner' })).toBe(false);
  });

  it('the optional extensions are contract fields now (compile-time)', () => {
    const input: Pick<SkillRunInput, 'window' | 'mode' | 'vars' | 'instruction' | 'preReportedCoverage'> = {
      window: { from: '2026-11-05T00:00:00Z', to: '2026-11-05T01:00:00Z' },
      mode: 'continuation',
      vars: { channelId: 'C1', limit: 5, deep: true },
      instruction: 'relink',
      preReportedCoverage: [{ kind: 'file', ref: 'f1' }],
    };
    const result: Pick<SkillRunResult, 'complete' | 'counts'> = { complete: false, counts: { recorded: 1, new: 1, changed: 0, linked: 0, proposed: 0, unlinked: 1, coverage: 1 } };
    const row: UnlinkedSourceItemDetail = { sourceItemId: 's1', attempts: 1, reason: 'no match', hints: ['acme'], excerpt: 'x', title: 't', threadRef: 'slack:C1:1' };
    const digest: Pick<OpenItemDigest, 'handedOffTo' | 'expected'> = { handedOffTo: 'Kim', expected: { fileId: 'f1' } };
    const reason: Parameters<scannerTypes.ReevaluateEnqueuer>[1] = { runId: 'r', connector: 'slack', catchingUp: true, trigger: 'catch_up' };
    const sameAsExt: ext.ScanSkillRunResult = { ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, ...result };
    expect([input.mode, result.complete, row.hints, digest.handedOffTo, reason.trigger, sameAsExt.ok]).toEqual(['continuation', false, ['acme'], 'Kim', 'catch_up', true]);
  });
});

describe('seeds validate (backward compatible contract)', () => {
  it('the committed example seed parses, shifts and re-parses', () => {
    const seed = parseSeed(rawExampleSeed(), 'example');
    expect(() => parseSeed(shiftDates(seed, 3), 'example+3')).not.toThrow();
  });

  const privateSeed = path.join(os.homedir(), 'Library/Application Support/command-center/fixtures/seed.json');
  it.skipIf(!existsSync(privateSeed))('the private seed (if present) parses, shifts and re-parses; only issue paths are reported', () => {
    const raw = JSON.parse(readFileSync(privateSeed, 'utf8'));
    const r = Seed.safeParse(raw);
    // Never print values from the private fixture: paths and codes only.
    const issues = r.success ? [] : r.error.issues.slice(0, 20).map((i) => `${i.path.join('.')} (${i.code})`);
    expect(issues).toEqual([]);
    if (!r.success) return;
    const again = Seed.safeParse(JSON.parse(JSON.stringify(shiftDates(r.data, 1))));
    expect(again.success ? [] : again.error.issues.slice(0, 20).map((i) => `${i.path.join('.')} (${i.code})`)).toEqual([]);
  });
});
