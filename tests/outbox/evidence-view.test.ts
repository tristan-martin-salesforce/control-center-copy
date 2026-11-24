/**
 * GET /items/:id/evidence's shared builder and the mention names (src/server/datasource/evidence-view.ts): newest
 * first, redacted again, only the names the texts mention, the directory before the rows before the texts' own
 * inline names; the mock read-in quoting a Slack snippet as prose. Placeholders only.
 */
import { describe, expect, it } from 'vitest';
import type { Evidence } from '@/contract';
import { renderSourceBody } from '@/lib/compose';
import { buildReadInContext } from '@/llm/readin/context';
import { slackLabels } from '@/server/datasource/draft-source';
import { buildEvidencePayload, inlineNames, mentionNames, unnamedMentions, whyMentionNames, whyTexts } from '@/server/datasource/evidence-view';
import { createMockDataSource } from '@/server/datasource/mock';
import { mockRecords, synthesizeOutput } from '@/server/datasource/mock/readin';

/** The mock DataSource loads the whole placeholder seed: slow under a full parallel run, so these get headroom. */
const MOCK_MS = 20_000;

const ev = (id: string, at: string, snippet: string | null, summary = 'Dana asked'): Evidence => ({
  id,
  workItemId: 'w_x',
  role: 'origin',
  source: { kind: 'slack', label: '#acme-ext' },
  at,
  summary,
  snippet,
  author: 'Dana Reyes',
  isNew: id === 'e2',
  confidence: null,
});

describe('mention names', () => {
  it('only the ids the texts mention; the first source that knows an id wins', () => {
    const people = { U0DANA: 'Dana Reyes', U0RAJ: 'Raj Mehta' };
    const rows = { U0DANA: 'Dana (rows)', U0QUINN: 'Quinn Placeholder' };
    expect(mentionNames(['<@U0DANA> and <@U0QUINN|quinn> and <@U0NOBODY>', null, undefined], people, rows)).toEqual({ U0DANA: 'Dana Reyes', U0QUINN: 'Quinn Placeholder' });
    expect(unnamedMentions(['<@U0DANA> <@U0QUINN>'], people)).toEqual(['U0QUINN']);
    expect(unnamedMentions(['no mentions here'], people)).toEqual([]);
  });

  it('the why texts are the item and NBA lines and their full reasoning', () => {
    expect(whyTexts({ why: 'a', whyDetail: null }, { why: 'b', whyDetail: 'c' })).toEqual(['a', null, 'b', 'c']);
  });
});

describe('buildEvidencePayload', () => {
  it('newest first, the new count, snippets and summaries redacted again, names for their mentions', () => {
    const p = buildEvidencePayload('w_x', [ev('e1', '2026-11-05T09:00:00.000Z', '<@U0RAJ> token xoxb-123-456-placeholder'), ev('e2', '2026-11-05T10:00:00.000Z', null, 'Dana said Bearer abcdefghijklmnop')], { U0RAJ: 'Raj Mehta' });
    expect(p.evidence.map((e) => e.id)).toEqual(['e2', 'e1']);
    expect(p.newCount).toBe(1);
    expect(p.evidence[1]!.snippet).toBe('<@U0RAJ> token [REDACTED:slack_token]');
    expect(p.evidence[0]!.snippet).toBeNull();
    expect(p.evidence[0]!.summary).not.toContain('abcdefghijklmnop');
    expect(p.mentions).toEqual({ U0RAJ: 'Raj Mehta' });
  });
});

describe('the mock read-in quotes Slack text as prose', () => {
  it("w_dana_reply's TL;DR names Raj and drops the mrkdwn markers", () => {
    const ds = createMockDataSource({ autoplay: false });
    try {
      const ctx = buildReadInContext(mockRecords(ds.store, new Date()), { type: 'work_item', id: 'w_dana_reply' }, { trigger: 'on_demand' })!;
      expect(ctx.evidence.some((e) => e.text.includes('<@U0RAJ>'))).toBe(true); // the context pack keeps the source text
      const out = synthesizeOutput(ctx, slackLabels(ds.store.all('people')));
      expect(out.tldr).toContain('@Raj Mehta');
      expect(out.tldr).not.toMatch(/<@U|<https?:|\*service-agent/);
    } finally {
      ds.dispose();
    }
  }, MOCK_MS);
});

describe('names the texts carry themselves (`<@U…|Name>`, as Slack writes most mentions)', () => {
  const labelled = ev('e1', '2026-11-05T09:00:00.000Z', '<@U0PAT|Pat Placeholder> asked for the *demo* link');
  // the same person, bare: a body cut inside the mention, and a summary quoting it
  const cut = ev('e2', '2026-11-05T10:00:00.000Z', 'Following up on the demo, ping <@U0PAT', '<@U0PAT> asked again');

  it('name a bare mention of the same id elsewhere in the payload (it rendered "@someone" before)', () => {
    const p = buildEvidencePayload('w_x', [labelled, cut], { U0RAJ: 'Raj Mehta' });
    expect(p.mentions).toEqual({ U0PAT: 'Pat Placeholder' });
    const html = renderSourceBody(p.evidence[0]!.snippet, 'slack_mrkdwn', { labels: p.mentions }).html;
    expect(html).toContain('<span class="cc-mention">@Pat Placeholder</span>…');
    expect(html).not.toContain('@someone');
    expect(renderSourceBody(p.evidence[0]!.summary, 'slack_mrkdwn', { labels: p.mentions }).html).toContain('@Pat Placeholder');
  });

  it('come last: the directory (and the rows) win; a cut label, an "@" prefix or the id itself is no name', () => {
    expect(buildEvidencePayload('w_x', [labelled], { U0PAT: 'Pat Directory' }).mentions).toEqual({ U0PAT: 'Pat Directory' });
    expect(inlineNames(['<@U0A|@Ann Placeholder>', '<@U0B|U0B>', '<@U0C|Cut Plac', '<@U0D|  >', null])).toEqual({ U0A: 'Ann Placeholder' });
    expect(unnamedMentions(['<@U0PAT> hi'], { }, inlineNames(['<@U0PAT|Pat Placeholder>']))).toEqual([]);
  });

  it("name the why line's bare mention from the item's evidence", () => {
    expect(whyMentionNames(['<@U0PAT> asked for the demo', null], [labelled], { U0RAJ: 'Raj Mehta' })).toEqual({ U0PAT: 'Pat Placeholder' });
    expect(whyMentionNames(['<@U0PAT> asked'], [labelled], { U0PAT: 'Pat Directory' })).toEqual({ U0PAT: 'Pat Directory' });
  });

  it('both mock routes send them (GET /items/:id/evidence and the item detail)', async () => {
    const ds = createMockDataSource({ autoplay: false });
    try {
      const at = '2026-11-05T15:00:00.000Z';
      ds.store._set('evidence', { ...labelled, id: 'ev_inline', workItemId: 'w_dana_reply', at });
      const nba = ds.store.all('nbas').find((n) => n.workItemId === 'w_dana_reply')!;
      ds.store._set('nbas', { ...nba, why: '<@U0PAT> asked whether the handoff is still in' });
      expect((await ds.getItemEvidence({ params: { id: 'w_dana_reply' } })).mentions).toEqual({ U0RAJ: 'Raj Mehta', U0PAT: 'Pat Placeholder' });
      expect((await ds.getItem({ params: { id: 'w_dana_reply' } })).mentions).toEqual({ U0PAT: 'Pat Placeholder' });
    } finally {
      ds.dispose();
    }
  }, MOCK_MS);
});
