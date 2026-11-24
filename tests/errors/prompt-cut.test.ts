/**
 * Caps audit 26 F-12: a prompt list cut at a fixed count ahead of its token trimmer logs one BUG.PROMPT_CUT line with
 * how many rows it dropped (counts and a site only), at most once per site every 10 minutes; the kept rows are exactly
 * what the slice kept (the cassette-keyed prompts do not change); a list that fits says nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cutHead, notePromptCut, PROMPT_CUT_CODE, setPromptCutSink } from '../../src/engines/prompt-cut';
import { isCatalogCode } from '../../src/errors/catalog';

type Line = Parameters<NonNullable<Parameters<typeof setPromptCutSink>[0]>>[0];

afterEach(() => setPromptCutSink(null));

describe('BUG.PROMPT_CUT markers (F-12)', () => {
  it('keeps what the slice kept, and logs the dropped count once per site per 10 minutes', () => {
    const lines: Line[] = [];
    setPromptCutSink((l) => lines.push(l));
    const xs = Array.from({ length: 15 }, (_, i) => i);
    expect(cutHead('nba.assets', xs, 12)).toEqual(xs.slice(0, 12));
    expect(lines).toEqual([{ code: PROMPT_CUT_CODE, site: 'nba.assets', cuts: 1, dropped: 3, maxDropped: 3, kept: 12 }]);
    // within 10 minutes: counted, not logged; then one line carries the tally
    const t = Date.now();
    notePromptCut('nba.assets', 20, 12, t + 1000);
    notePromptCut('nba.assets', 13, 12, t + 2000);
    expect(lines).toHaveLength(1);
    notePromptCut('nba.assets', 14, 12, t + 11 * 60_000);
    expect(lines[1]).toMatchObject({ site: 'nba.assets', cuts: 3, dropped: 8 + 1 + 2, maxDropped: 8 });
  });

  it('a list that fits logs nothing', () => {
    const lines: Line[] = [];
    setPromptCutSink((l) => lines.push(l));
    expect(cutHead('resolution.sessions', [1, 2], 2)).toEqual([1, 2]);
    expect(cutHead('resolution.sessions', [], 2)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('the code is catalogued, and every F-12 site carries a marker', () => {
    expect(isCatalogCode(PROMPT_CUT_CODE)).toBe(true);
    const src = (f: string) => readFileSync(join(__dirname, '../../src/engines', f), 'utf8');
    expect(src('nba/prompt/build.ts')).toMatch(/cutHead\('nba\.assets'[\s\S]*cutHead\('nba\.siblings'/);
    expect(src('resolution/pack.ts')).toContain("cutHead('resolution.sessions'");
    for (const s of ['settle.dm_middle', 'settle.elsewhere', 'settle.events', 'settle.siblings']) expect(src('settle/context.ts')).toContain(`'${s}'`);
    for (const s of ['settle.load.elsewhere', 'settle.load.events']) expect(src('settle/load-db.ts')).toContain(`'${s}'`);
  });
});
