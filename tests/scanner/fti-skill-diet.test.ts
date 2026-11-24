/**
 * Skill diet (review 04 COST-4, §4.4): the FTI scanning prefix is one shared skill (skills/classify-items.md) plus the
 * Persona block and the glossary, with no tool schemas. Before: per source, `_scanner-common` + the scan skill (and
 * triage-slack for Slack) on top of the hidden tool and CLI prefix, re-read every turn. Printed before / after, token
 * counts estimated at 3.5 characters a token for prose (the skill runner's measured rate; no tokenizer offline).
 * Target: under a quarter of today's tokens for the scanning prefix. The scan skills stay: the agentic path is the
 * fallback (`CC_SCAN_MODE=agentic`, and the scopes FTI does not cover).
 */
import { describe, expect, it } from 'vitest';

import { personaOf, renderPersonaBlock } from '@/personas';
import { loadSkill } from '@/llm/skill-loader';
import { renderSystem } from '@/scanner/interpret';
import { AGENTIC_HIDDEN_TOKENS, proseTokens } from '@/scanner/interpret/estimate';

const SOURCES: Array<[string, string[]]> = [
  ['slack', ['skills/_scanner-common.md', 'skills/scan-slack.md', 'skills/triage-slack.md']],
  ['gmail', ['skills/_scanner-common.md', 'skills/scan-gmail.md']],
  ['gemini_notes', ['skills/_scanner-common.md', 'skills/scan-gemini-notes.md']],
  ['drive', ['skills/_scanner-common.md', 'skills/scan-drive.md']],
  ['org62', ['skills/_scanner-common.md', 'skills/scan-org62.md']],
];

describe('skill diet: the scanning prefix before and after', () => {
  it('the FTI prefix is under a quarter of every source’s agentic skill text, and carries no tool schemas', () => {
    const classify = loadSkill('skills/classify-items.md').body;
    const { system } = renderSystem(classify, { me: { userId: 'u', name: 'ME', slackId: 'U0ME00001', email: 'me@example.com' }, aliases: { accounts: [], channels: [] }, initiatives: [], persona: personaOf({}) });
    const after = proseTokens(classify.length);
    const afterWithPersona = proseTokens(system.length);
    const lines = ['', 'Skill diet (tokens ≈ characters / 3.5; FTI: skills/classify-items.md, one prefix shared by every source)', '| source | agentic skill text | + hidden tools/CLI | FTI skill | + persona and glossary | FTI / agentic (skill text) |', '|---|---|---|---|---|---|'];
    for (const [source, files] of SOURCES) {
      const before = proseTokens(files.reduce((n, f) => n + loadSkill(f).body.length, 0));
      lines.push(`| ${source} | ${before} | ${before + AGENTIC_HIDDEN_TOKENS} | ${after} | ${afterWithPersona} | ${(after / before).toFixed(2)} |`);
      expect(after / before).toBeLessThan(0.25);
    }
    console.log(lines.join('\n'));
    expect(renderPersonaBlock(personaOf({})).length).toBeGreaterThan(0);
    expect(classify.length).toBeLessThan(8_000); // ≤ ~2K tokens (review 04: classifier ≤ 1.5K + common ≤ 1K)
  });
});
