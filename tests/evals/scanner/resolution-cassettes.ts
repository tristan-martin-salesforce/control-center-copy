/**
 * The resolution check's cassettes (tests/fixtures/scanner-golden/cassettes/resolution/<case>.json): the same cassette
 * model as the completion pass's (src/scanner/completion/cassette.ts), keyed by ledgerHash(model, resolve-item@version,
 * system, user), labelled by model, check time and item titles (no message text).
 *
 *   npx tsx tests/evals/scanner/record-resolution.ts                   re-key hand-written entries, list missing calls
 *   npx tsx tests/evals/scanner/record-resolution.ts --show-missing    also print each missing call's user prompt
 * (A live recording would go through the same booked path as `npm run eval:record -- --live`; not wired here.)
 */
import fs from 'node:fs';
import path from 'node:path';

import { RESOLUTION_SKILL_PATH } from '@/engines/resolution/types';
import { loadSkill } from '@/llm/skill-loader';
import type { CassetteFile } from '@/scanner/completion/cassette';
import type { CompletionModelRequest } from '@/scanner/completion/types';

import { CASSETTE_DIR } from './golden';

export const RESOLUTION_CASSETTE_DIR = path.join(CASSETTE_DIR, 'resolution');
export const resolutionSkillTag = () => loadSkill(RESOLUTION_SKILL_PATH).versionTag;

export function resolutionCassettePath(caseId: string): string {
  return path.join(RESOLUTION_CASSETTE_DIR, `${caseId}.json`);
}

export function readResolutionCassette(caseId: string): CassetteFile {
  const p = resolutionCassettePath(caseId);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as CassetteFile) : { version: 1, entries: [] };
}

export function writeResolutionCassette(caseId: string, c: CassetteFile): void {
  fs.mkdirSync(RESOLUTION_CASSETTE_DIR, { recursive: true });
  fs.writeFileSync(resolutionCassettePath(caseId), `${JSON.stringify(c, null, 2)}\n`);
}

/** `<model> | <now> | <title> | <title>`: what rekeying matches a hand-written entry on. */
export function resolutionLabel(req: CompletionModelRequest): string {
  try {
    const u = JSON.parse(req.user) as { now?: string; items?: Array<{ item?: { title?: string } }> };
    return `${req.model} | ${u.now ?? '?'} | ${(u.items ?? []).map((i) => i.item?.title ?? '?').join(' | ')}`;
  } catch {
    return '';
  }
}
