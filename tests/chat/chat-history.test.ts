/**
 * The thread a rebuilt turn sees (Assistant v2: no per-message caps; compaction bounds the thread) and the skill's
 * v2 behaviours. A list the user pasted once lasts the thread, whole; cards carry their lines; older turns are replaced
 * by their compaction summary only when the rebuilt thread passes the trigger (prompt.ts COMPACT_AT_TOKENS).
 */
import { describe, expect, it } from 'vitest';

import type { ChatMemoryEntry, ChatMessage } from '@/contract';
import { approxTokens, COMPACT_AT_TOKENS, compactedHistory, renderHistory } from '@/llm/chat/prompt';
import { CHAT_TOOL_NAMES, playbook } from '@/llm/chat/tools';
import { longPromptThresholdOf } from '@/llm/models';
import { loadSkill } from '@/llm/skill-loader';

const msg = (role: ChatMessage['role'], text: string, n: number): ChatMessage => ({ id: `m${n}`, threadId: 't1', role, at: `2026-11-13T10:${String(n).padStart(2, '0')}:00.000Z`, text, parts: [], context: [], isMorningBrief: false });

/** A pasted sheet: one tab-separated row per opp (placeholder names). */
const rows = (n: number) => Array.from({ length: n }, (_, i) => `SAF-0${5_000_000 + i}\tPlaceholder Account ${i}\tPlaceholder Account ${i} - Data Cloud Expansion`).join('\n');

describe('renderHistory', () => {
  it('keeps a pasted list whole on later turns', () => {
    const paste = rows(83);
    const h = renderHistory([msg('user', paste, 1), msg('assistant', 'I have the list, so I’ll check it against your DCs.', 2), msg('user', 'That DC comment is wrong. Only say SE support', 3)]);
    expect(h).toContain('Placeholder Account 82 - Data Cloud Expansion');
    expect(h.match(/SAF-0/g)).toHaveLength(83);
  });

  it('never cuts a message: a 200,000-character paste and a 30,000-character reply ride whole', () => {
    const big = rows(2_000);
    expect(big.length).toBeGreaterThan(150_000);
    const h = renderHistory([msg('user', big, 1), msg('assistant', 'y'.repeat(30_000), 2)]);
    expect(h.match(/SAF-0/g)).toHaveLength(2_000);
    expect(h).toContain('y'.repeat(30_000));
    expect(h).not.toContain('…');
  });

  it("carries a staged card's lines and an Apply's failed lines", () => {
    const card: ChatMessage = {
      ...msg('assistant', 'Staged the claims.', 2),
      parts: [
        { type: 'proposal', status: 'applied', summary: 'Claim DCs on 2 opportunities?', proposal: { id: 'p1', entity: { type: 'chat_thread', id: 't1', label: '2 changes' }, changes: [{ field: 'createDcRequest', label: 'DC claim · ACCOUNT_1 · Renewal', before: null, after: '100% · “SE support”' }, { field: 'createDcRequest', label: 'DC claim · ACCOUNT_2 · Pilot', before: null, after: '50%' }], reason: 'Claim DCs on 2 opportunities?', source: null, createdAt: '2026-11-13T10:02:00.000Z', status: 'applied', actor: 'chat', baseVersion: null, textDiff: null, resolvedAt: null } },
        { type: 'receipt', receipt: { id: 'r1', at: '2026-11-13T10:03:00.000Z', actor: 'chat', summary: 'Applied 1 of 2 · 1 failed: no such opp', changes: [], staged: false, total: 2, failed: [{ label: 'DC claim · ACCOUNT_2 · Pilot', reason: 'no such opp' }] } },
        { type: 'plan', plan: { id: 'plan_1', steps: [{ tool: 'run', run: 'research', what: 'Research Globex live' }], estimate: { p50: 0.1, p90: 0.3, basis: 'default' }, status: 'skipped' } },
      ] as ChatMessage['parts'],
    };
    const h = renderHistory([msg('user', 'claim these', 1), card]);
    expect(h).toContain('- DC claim · ACCOUNT_1 · Renewal: — → 100% · “SE support”');
    expect(h).toContain('- DC claim · ACCOUNT_2 · Pilot: — → 50%');
    expect(h).toContain('- failed: DC claim · ACCOUNT_2 · Pilot: no such opp');
    expect(h).toContain('[plan plan_1 skipped: Research Globex live]');
  });
});

describe('compaction (the old history caps, replaced)', () => {
  const thread = (n: number, size: number) => Array.from({ length: n }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `${i}:${'w'.repeat(size)}`, i));

  it('the trigger is a real price limit: half of Haiku 5.5’s long-prompt tier', () => {
    expect(COMPACT_AT_TOKENS * 2).toBe(longPromptThresholdOf('claude-haiku-5-5'));
  });

  it('under the trigger the whole thread rides; over it, the older turns are what to summarize and the recent ones stay', () => {
    const small = compactedHistory(thread(8, 1_000), []);
    expect(small.needs).toBeNull();
    expect(small.text).toContain('User: 0:');
    const big = thread(20, 20_000); // ~100K tokens
    const c = compactedHistory(big, []);
    expect(c.tokens).toBeGreaterThan(COMPACT_AT_TOKENS);
    expect(c.needs).toMatchObject({ from: 0, to: 13 });
    expect(c.needs!.messages).toHaveLength(14);
  });

  it('a stored summary replaces the turns it covers; pinned notes are never in the summary path', () => {
    const big = thread(20, 20_000);
    const memory: ChatMemoryEntry[] = [
      { id: 's1', threadId: 't1', kind: 'summary', text: 'The user claimed 3 DCs; Globex renewal pending.', pinned: false, coversThroughSeq: 13, createdAt: '2026-11-13T11:00:00.000Z' },
      { id: 'n1', threadId: 't1', kind: 'note', text: 'Log in 15-minute steps', pinned: true, coversThroughSeq: null, createdAt: '2026-11-13T09:00:00.000Z' },
    ];
    const c = compactedHistory(big, memory);
    expect(c.text.startsWith('Summary of the earlier conversation (messages 1-14):\nThe user claimed 3 DCs')).toBe(true);
    expect(c.text).not.toContain('User: 0:');
    expect(c.text).toContain('User: 14:');
    expect(c.text).toContain('Assistant: 19:');
    expect(c.text).not.toContain('15-minute steps'); // pinned notes ride in the header (## Remembered), every turn
    expect(c.summaryId).toBe('s1');
    expect(approxTokens(c.text)).toBeLessThan(c.tokens + 1);
  });
});

describe('the Assistant skill (chat-assistant@12): eleven tools, a data model map, playbooks on demand', () => {
  const skill = loadSkill('skills/chat-assistant.md');

  it('names exactly the eleven tools and states the v2 behaviours', () => {
    expect(skill.versionTag).toBe('chat-assistant@12');
    expect(skill.frontmatter.allowed_tools).toEqual(CHAT_TOOL_NAMES);
    expect(skill.body).toMatch(/Answer from `query` before searching live/);
    expect(skill.body).toMatch(/"Why\?" → `explain`/);
    expect(skill.body).toMatch(/Unsure → propose, not act/);
    expect(skill.body).toMatch(/Say the cost before research/);
    expect(skill.body).toMatch(/## The data model/);
    expect(skill.body).not.toMatch(/chat_[a-z_]+/);
  });

  it('is under a quarter of v11 (24.9 KB); the domain playbooks load through help', () => {
    expect(skill.body.length).toBeLessThan(6_500);
    for (const t of ['dc', 'vdp', 'logging', 'lists']) expect(playbook(t).length).toBeGreaterThan(200);
    expect(playbook('dc')).toMatch(/The DC comment is true, and it's theirs/);
    expect(playbook('dc')).toMatch(/Never invent work/);
    expect(playbook('dc')).toMatch(/ask once for the comment, offering a plain one \("SE support"\), and use their wording exactly/);
    expect(playbook('dc')).toMatch(/`addOrg62Opps \{org62Ids\}` adds opps without claiming/);
    expect(playbook('lists')).toMatch(/a list pasted earlier is in the thread, whole: never ask again/);
    expect(playbook('nope')).toMatch(/No playbook/);
  });
});
