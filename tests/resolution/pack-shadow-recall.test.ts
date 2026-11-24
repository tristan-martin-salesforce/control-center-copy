/** The pack (tags, files, sessions, token cap), the shadow comparison math, the recall sweep and the plain words. */
import { describe, expect, it } from 'vitest';

import { parseSlackThread } from '@/connectors/slack/parse';
import { checkWhy, nextCheckText, renderItemExplain, resolutionYieldLine } from '@/engines/resolution/explain';
import { approxTokens, buildResolutionPack, deliverableWords, packLines, renderPack } from '@/engines/resolution/pack';
import { compareShadow, shadowLine } from '@/engines/resolution/shadow';
import { followThreads, renderThreadRead, threadReadArgs, threadsToFollow, type ThreadRow } from '@/scanner/resolution/recall';

import { NOW, at, line, mine, raw } from './fixtures';

describe('the pack', () => {
  it('tags the asker’s ack and chase after my line; carries file revisions and sessions', () => {
    const r = raw({
      after: [mine(5, 'here https://docs.google.com/presentation/d/FILE_PLACEHOLDER_01/edit'), line(9, 'got it, thanks!'), line(60, "the link doesn't open, can you re-share?")],
      extra: { files: [{ sourceItemId: 'f-1', fileId: 'FILE_PLACEHOLDER_01', title: 'ACME pricing', at: at(30), byMe: true, changes: 'added the EMEA tab' }], sessions: [{ sourceItemId: 's-1', sessionId: 'S1', status: 'done', title: 'deck build', at: at(40), lastMessage: 'opened PR #7' }] },
    });
    const p = buildResolutionPack(r, { now: NOW, timezone: 'UTC', me: 'me' });
    expect(p.after.map((l) => l.tag ?? null)).toEqual([null, 'ack', 'chase']);
    expect(p.files[0]).toMatchObject({ id: 'f1', kind: 'file', fromMe: true, sourceItemId: 'f-1' });
    expect(p.sessions[0]).toMatchObject({ id: 's1', kind: 'session', sourceItemId: 's-1' });
    expect(p.ruleHints.askerChasedAfterMine).toBe(true);
    expect(p.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(p.conversationKey).toBe('slack:D0DM00001');
  });

  it('caps by tokens, dropping chatter but never the ask, my lines or the asker’s', () => {
    const chatter = Array.from({ length: 60 }, (_, i) => line(10 + i, `unrelated chatter line number ${i} about lunch plans and the offsite agenda for next quarter`, { author: `PERSON_${i % 5 === 0 ? 'Z' : 'Y'}` }));
    const r = raw({ after: [mine(5, 'here https://docs.google.com/presentation/d/FILE_PLACEHOLDER_01/edit'), ...chatter, line(200, 'perfect, thanks')] });
    const p = buildResolutionPack(r, { now: NOW, timezone: 'UTC', me: 'me', tokenCap: 600 });
    expect(p.tokens).toBeLessThanOrEqual(600);
    expect(p.trimmed).toBeGreaterThan(0);
    const ids = [...packLines(p).values()].map((l) => l.sourceItemId);
    expect(ids).toContain(r.evidence[0]!.id);
    expect(ids).toContain(r.conversation[0]!.id);
    expect(ids).toContain(r.conversation.at(-1)!.id);
    expect(approxTokens(renderPack(p, 'w1'))).toBeLessThanOrEqual(600);
  });

  it('deliverable words leave verbs and placeholders out', () => {
    expect(deliverableWords('Send PERSON_A the ACME pricing deck')).toEqual(['acme', 'pricing', 'deck']);
  });
});

describe('shadow comparison math', () => {
  it('agreed, would close more, reopened — over the latest check per item', () => {
    const c = compareShadow(['a', 'b', 'c', 'd'], [
      { workItemId: 'a', at: '2026-11-10T10:00:00Z', outcome: 'left' },
      { workItemId: 'a', at: '2026-11-10T11:00:00Z', outcome: 'closed' }, // the latest wins
      { workItemId: 'b', at: '2026-11-10T10:00:00Z', outcome: 'closed' },
      { workItemId: 'c', at: '2026-11-10T10:00:00Z', outcome: 'likely' },
      { workItemId: 'x', at: '2026-11-10T10:00:00Z', outcome: 'closed' },
      { workItemId: 'y', at: '2026-11-10T10:00:00Z', outcome: 'reopened' },
    ]);
    expect(c).toMatchObject({ legacyCloses: 4, checked: 3, agreed: 2, wouldCloseMore: 1, wouldReopen: 1, checks: 6 });
    expect(c.agreeRate).toBeCloseTo(2 / 3);
    expect(c.line).toBe('Resolution check agreed on 67% of 3 closes this week (1 not checked); would have closed 1 more, reopened 1');
  });
  it('the line with no checks, or none on a close', () => {
    expect(shadowLine({ legacyCloses: 0, checked: 0, agreeRate: null, wouldCloseMore: 0, wouldReopen: 0, checks: 0 })).toMatch(/no checks/);
    expect(compareShadow([], [{ workItemId: 'x', at: '2026-11-10T10:00:00Z', outcome: 'closed' }]).line).toMatch(/none on a close; would have closed 1 more/);
    expect(compareShadow(Array.from({ length: 212 }, (_, i) => `l${i}`), Array.from({ length: 212 }, (_, i) => ({ workItemId: `l${i}`, at: '2026-11-10T10:00:00Z', outcome: i < 199 ? ('closed' as const) : ('likely' as const) }))).line).toMatch(/^Resolution check agreed on 94% of 212 closes this week; would have closed 0 more, reopened 0$/);
  });
});

describe('the recall sweep (SCN-1)', () => {
  const now = new Date('2026-11-10T12:00:00.000Z');
  const row = (o: Partial<ThreadRow>): ThreadRow => ({ channelId: 'C1', channelType: 'channel', threadTs: '1.0', lastMineAt: '2026-11-09T12:00:00.000Z', lastRecordedAt: '2026-11-10T10:00:00.000Z', lastRecordedTs: '2.0', ...o });
  it('channel threads I am in, quiet past the poll window, newest of mine first, capped', () => {
    const t = threadsToFollow([row({}), row({ channelId: 'D1', channelType: 'im' }), row({ channelId: 'C2', lastRecordedAt: '2026-11-10T11:50:00.000Z' }), row({ channelId: 'C3', lastMineAt: '2026-10-01T00:00:00.000Z' })], now);
    expect(t).toEqual([{ channelId: 'C1', threadTs: '1.0', oldest: '2.0' }]);
    expect(threadsToFollow(Array.from({ length: 40 }, (_, i) => row({ channelId: `C${i}` })), now)).toHaveLength(25);
    expect(threadReadArgs(t[0]!)).toMatchObject({ channel_id: 'C1', message_ts: '1.0', oldest: '2.0', response_format: 'detailed' });
  });
  it('reads each thread once (read-only tool), records through REC-1, stops on auth', async () => {
    const recorded: string[] = [];
    const r = await followThreads([{ channelId: 'C1', threadTs: '1.0', oldest: '1.0' }, { channelId: 'C2', threadTs: '1.0', oldest: '1.0' }, { channelId: 'C3', threadTs: '1.0', oldest: '1.0' }], {
      read: async (a) => (a.channel_id === 'C2' ? { text: null, code: 'auth' } : { text: 'x', costUsd: 0.001 }),
      record: async (tool, args) => {
        recorded.push(`${tool}:${String(args.channel_id)}`);
        return 1;
      },
    });
    expect(recorded).toEqual(['mcp__slack__slack_read_thread:C1']);
    expect(r).toMatchObject({ read: 1, recorded: 1, failed: 1, errors: ['auth'] });
  });
  it('the rendered thread read parses back with the replies under the root', () => {
    const text = renderThreadRead({ author: 'Pat', id: 'U0ME', ts: '100.000001', text: 'v1 is here' }, [{ author: 'PERSON_B', id: 'U0B', ts: '200.000001', text: 'can you send the v2?', at: '2026-11-10T10:00:00.000Z' }], '2026-11-10T09:00:00.000Z');
    const m = parseSlackThread({ results: text }, 'C1', '100.000001').messages;
    expect(m.map((x) => [x.ts, x.threadTs ?? null, x.authorId])).toEqual([
      ['100.000001', null, 'U0ME'],
      ['200.000001', '100.000001', 'U0B'],
    ]);
  });
});

describe('plain words (Why still open, scan:explain --item, scan:report --yield)', () => {
  it('checkWhy says who decided, what, and why it did not close', () => {
    expect(checkWhy({ decidedBy: 'rule', ruleHit: 'D1', verdict: 'done', confidence: 1, outcome: 'closed', blockedBy: null, mode: 'live' })).toBe('Rule D1: your reply after the ask carries what was asked; closed it for you.');
    expect(checkWhy({ decidedBy: 'model', ruleHit: null, verdict: 'not_done', confidence: 0.3, outcome: 'left', blockedBy: null, mode: 'shadow' })).toBe('The cheap model said still yours (30%); would have left it open.');
    expect(checkWhy({ decidedBy: 'model', ruleHit: null, verdict: 'done', confidence: 0.9, outcome: 'likely', blockedBy: 'reopened_twice', mode: 'live' })).toMatch(/not closed because it was reopened twice/);
  });
  it('the next check and the yield line', () => {
    expect(nextCheckText('open', 'legacy', null, NOW)).toMatch(/off/);
    expect(nextCheckText('open', 'shadow', null, NOW)).toMatch(/tonight/);
    expect(nextCheckText('done', 'live', null, NOW)).toMatch(/asker writing to you again/);
    expect(resolutionYieldLine({ checks: 10, byRules: 3, costUsd: 0.004, perCheckUsd: 0.0004, closed: 2, likely: 1, asked: 1, reopened: 0, escalated: 1 })).toBe('  resolution checks: 10, $0.0004/check ($0.0040 in all), by rules 3, escalated 1 · closed 2, likely 1, asked 1, reopened 0');
  });
  it('renderItemExplain lists the pack lines without text and every check', () => {
    const lines = renderItemExplain({
      item: { id: 'w1', kind: 'ask', status: 'open', title: 'secret title' },
      mode: 'shadow',
      pack: { tokens: 300, digest: 'abc', trimmed: 0, lines: [{ id: 'a1', kind: 'ask', at: at(0), by: 'PERSON_A', where: 'DM', sourceItemId: 'si-1' }], hints: { myReplyAfterAskMin: null, lastWriter: 'asker' }, rulesFired: [] },
      checks: [{ at: at(60), trigger: 'conversation_line', mode: 'shadow', decidedBy: 'model', ruleHit: null, verdict: 'not_done', confidence: 0.2, outcome: 'left', blockedBy: null, packDigest: 'abc', costUsd: 0.0002, citeAlias: null }],
      next: 'x',
    }).join('\n');
    expect(lines).toMatch(/pack now: 1 lines, ~300 tokens · digest abc \(same as the last check\)/);
    expect(lines).toMatch(/a new line in its conversation · The cheap model said still yours \(20%\); would have left it open\./);
    expect(lines).not.toMatch(/secret title/);
  });
});
