/**
 * Home speaks plain words (01 R12, H-10b): no internal ids, engine names or schema words in what Home says. Two checks:
 * the words the Home engine writes (labels, sentences, chips, the Admin row, "what to move") over the placeholder world
 * and an overbooked variant, and the literal JSX text of the briefing components. Item titles and people's words are
 * data and are left out. The internal-ids lint (src/components/kit/__tests__/internal-ids.test.ts) also covers these
 * files for decision ids and Salesforce API names.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HomePayload } from '@/contract';
import { buildHome } from '@/engines/home/build';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { homeInputFromStore } from '@/server/datasource/mock/home';

/** Words a user should never read on Home. */
const DENY: Array<[RegExp, string]> = [
  [/\bD-\d+\b/, 'decision id'],
  [/__c\b/, 'Salesforce API name'],
  [/priority@\d/i, 'engine version'],
  [/\bv[12]\b/, 'engine version'],
  [/\bshadow\b/i, 'engine mode'],
  [/\bNBA\b/, 'internal name'],
  [/\bpayload\b/i, 'schema word'],
  [/\bmakeRoom\b|\bgroupKey\b|\bwork_item\b|\bneeds_?queue\b/, 'code name'],
  [/\bLLM\b|\bmodel call\b/i, 'internal name'],
  [/\b(null|undefined|NaN)\b/, 'empty value leaked'],
  [/\[object Object\]/, 'object leaked'],
];

const offending = (text: string) => DENY.filter(([re]) => re.test(text)).map(([, why]) => why);

/** Every string Home's engine writes (not titles or people's words). */
function engineWords(h: HomePayload): string[] {
  return [
    ...h.masthead.sentence.map((s) => s.text),
    ...h.masthead.ahead.map((s) => s.text),
    h.doNow.elsewhereNote,
    ...h.doNow.cards.flatMap((c) => [c.verb.label, c.stateLabel ?? '', c.aiLabel ?? '', c.foot ?? '', c.whyNow ?? '', c.whyMatters ?? '']),
    ...h.sections.flatMap((s) => [s.title, s.seeAllLabel, s.empty, s.sub ?? '', s.batch?.label ?? '', ...s.rows.flatMap((r) => [r.verb.label, r.stateLabel ?? '', r.dateLabel ?? ''])]),
    ...h.respond.chips.map((c) => c.verb),
    h.respond.review?.label ?? '',
    ...h.builds.flatMap((b) => [b.etaLabel, b.progressLabel ?? '']),
    h.admin?.label ?? '',
    ...(h.admin?.rows ?? []).flatMap((r) => [r.kind, r.dueLabel ?? '']),
    h.moveIt?.label ?? '',
    h.moveIt?.sentence.replace(/“[^”]*”/g, '') ?? '',
    ...h.closedNow.map((c) => c.badge),
  ].filter(Boolean);
}

let ds: MockDataSource;
beforeAll(() => {
  ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
});
afterAll(() => ds.dispose());

describe('Home speaks plain words', () => {
  it('the engine’s words, on a normal and an overbooked day, under both rankings', () => {
    const input = homeInputFromStore(ds, false);
    const days = [
      buildHome(input),
      buildHome({ ...input, priorityEngine: 'v2' }),
      buildHome({ ...input, capacity: { ...input.capacity, day: 'today', fits: false, youMinToday: input.capacity.freeMin + 200, openMin: -200 } }),
    ];
    for (const h of days) for (const w of engineWords(h)) expect(offending(w), w).toEqual([]);
  });

  it('the briefing components’ own text', () => {
    for (const f of ['Briefing.tsx', 'HomeNeeds.tsx', 'HomePlan.tsx', 'DoNow.tsx']) {
      const src = readFileSync(`src/components/home/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      // JSX text between tags, and string props a user reads
      const texts = [...src.matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g), ...src.matchAll(/\b(?:title|label|aria-label)="([^"]+)"/g)].map((m) => m[1]!.trim()).filter(Boolean);
      for (const t of texts) expect(offending(t), `${f}: ${t}`).toEqual([]);
    }
  });
});
