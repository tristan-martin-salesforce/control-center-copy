/**
 * GET /drafts/:id/source, the shared pure builder (src/server/datasource/draft-source.ts): which thread, which
 * message, which link, purge fallback, email headers, new messages ("source"), dedupe and redaction. Placeholders only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draft, Evidence } from '@/contract';
import { baseCandidates, buildDraftSource, draftSourceLink, evidenceCandidates, selectSource, slackLabels, type SourceCandidate } from '@/server/datasource/draft-source';
import { createMockDataSource } from '@/server/datasource/mock';

const ME = { name: 'Jordan Lee' };
const T = (hhmm: string, day = '05') => `2026-11-${day}T${hhmm}:00.000Z`;

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 'dr_1',
  version: 1,
  workItemId: 'w_1',
  nbaId: null,
  destination: { kind: 'slack', target: 'thread', channelId: 'C0ACME', channelName: '#acme-ext', threadTs: '1700000000.000100' },
  mode: 'draft',
  doc: { type: 'doc', content: [] },
  plainText: '',
  rendered: {},
  userTouched: false,
  userLockedFields: [],
  status: 'ready',
  threadContext: [],
  createdAt: T('12:00'),
  updatedAt: T('12:00'),
  savedAt: null,
  scheduledFor: null,
  attempts: [],
  verification: null,
  rejectedReason: null,
  resultUrl: null,
  ...over,
});

/** A stored source item (the db side's thread rows): rank 2. */
const row = (id: string, over: Partial<SourceCandidate>): SourceCandidate => ({
  id,
  kind: 'slack',
  externalId: null,
  thread: null,
  at: T('09:00'),
  author: 'Dana Reyes',
  isMe: false,
  body: 'hello',
  format: 'plain',
  purged: false,
  url: null,
  summary: null,
  label: '#acme-ext',
  evidence: false,
  role: null,
  inThread: false,
  rank: 2,
  ...over,
});

const ev = (id: string, over: Partial<Evidence>): Evidence => ({
  id,
  workItemId: 'w_1',
  role: 'origin',
  source: { kind: 'slack', label: '#acme-ext · thread', url: 'https://example.slack.com/archives/C0ACME/p1700000000000100', externalId: 'C0ACME:1700000000.000100' },
  at: T('09:00'),
  summary: 'Dana asked about the demo',
  snippet: null,
  author: 'Dana Reyes',
  isNew: false,
  confidence: null,
  ...over,
});

const KEY = 'slack:C0ACME:1700000000.000100';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a Slack thread reply', () => {
  const rows = [
    row('m1', { externalId: 'C0ACME:1700000000.000100', thread: KEY, at: T('08:00'), body: 'Kick-off: *Phase 2* scope', url: 'https://example.slack.com/archives/C0ACME/p1700000000000100' }),
    row('m2', { externalId: 'C0ACME:1700000100.000100', thread: KEY, at: T('08:10'), author: 'Jordan Lee', isMe: true, body: 'On it' }),
    row('m3', { externalId: 'C0ACME:1700000200.000100', thread: KEY, at: T('08:20'), author: 'Raj Mehta', body: 'Pricing next week' }),
    row('m4', { externalId: 'C0ACME:1700000300.000100', thread: KEY, at: T('08:30'), body: 'Also the agenda' }),
    row('m5', { externalId: 'C0ACME:1700000400.000100', thread: KEY, at: T('08:40'), author: 'Jordan Lee', isMe: true, body: 'Sure' }),
    row('m6', { externalId: 'C0ACME:1700000500.000100', thread: KEY, at: T('08:50'), body: 'One more: <@U0RAJ> joins' }),
    row('m7', { externalId: 'C0ACME:1700000600.000100', thread: KEY, at: T('09:00'), body: 'Are we still on for *today*? <https://example.com/plan|the plan>', url: 'https://example.slack.com/archives/C0ACME/p1700000600000100?thread_ts=1700000000.000100' }),
    row('m8', { externalId: 'C0ACME:1700000700.000100', thread: KEY, at: T('09:05'), author: 'Jordan Lee', isMe: true, body: 'Checking' }),
    // the same channel, another thread: never part of this one
    row('x1', { externalId: 'C0ACME:1700009999.000100', thread: 'slack:C0ACME:1700009999.000100', at: T('09:30'), body: 'Unrelated' }),
    // another channel
    row('x2', { externalId: 'C0OTHER:1700000600.000100', thread: 'slack:C0OTHER:1700000000.000100', at: T('09:40'), body: 'Elsewhere' }),
  ];
  const s = buildDraftSource({ draft: draft(), candidates: rows, itemSources: [], labels: { U0RAJ: 'Raj Mehta' } });

  it('answers the latest message from someone else, rendered rich, with its permalink', () => {
    expect(s).toMatchObject({ kind: 'slack', relation: 'reply', where: '#acme-ext', url: 'https://example.slack.com/archives/C0ACME/p1700000600000100?thread_ts=1700000000.000100' });
    expect(s.message).toMatchObject({ id: 'm7', author: 'Dana Reyes', isMe: false, at: T('09:00'), body: 'full' });
    expect(s.message!.html).toContain('<strong>today</strong>');
    expect(s.message!.html).toContain('href="https://example.com/plan"');
    expect(s.message!.text).toBe('Are we still on for today? the plan (https://example.com/plan)');
  });

  it('lists the 5 messages before it, oldest first, and how many there are in all', () => {
    expect(s.earlier.map((m) => m.id)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']);
    expect(s.earlierTotal).toBe(6);
    expect(s.earlier[1]).toMatchObject({ author: 'Raj Mehta', isMe: false });
    expect(s.earlier[4]!.html).toContain('@Raj Mehta');
    expect(JSON.stringify(s)).not.toContain('Unrelated');
    expect(JSON.stringify(s)).not.toContain('Elsewhere');
  });

  it('the Outbox row link is the same permalink', () => {
    expect(draftSourceLink({ draft: draft(), candidates: rows, itemSources: [] })).toEqual({ kind: 'slack', label: '#acme-ext', url: s.url });
  });
});

describe('merging thread context, evidence and stored rows', () => {
  it('one message seen as thread context and as evidence is shown once: the thread context text, the evidence link', () => {
    const d = draft({ threadContext: [{ id: 'tm1', author: { id: 'p_dana', name: 'Dana Reyes' }, at: T('09:00'), text: 'Are we on *today*?', isMe: false }] });
    const c = baseCandidates(d, [ev('ev_1', { snippet: 'Are we on today?' })], ME);
    const s = buildDraftSource({ draft: d, candidates: c, itemSources: [], labels: {} });
    expect(s.message!.html).toContain('<strong>today</strong>');
    expect(s.message!.url).toBe('https://example.slack.com/archives/C0ACME/p1700000000000100');
    expect(s.earlier).toEqual([]);
  });

  it('a stored source body wins over thread context', () => {
    const d = draft({ threadContext: [{ id: 'tm1', author: { id: 'p_dana', name: 'Dana Reyes' }, at: T('09:00'), text: 'short', isMe: false }] });
    const c = [...baseCandidates(d, [], ME), row('si_1', { externalId: 'C0ACME:1700000000.000100', thread: KEY, at: T('09:00'), body: 'the full stored text' })];
    expect(buildDraftSource({ draft: d, candidates: c, itemSources: [], labels: {} }).message!.text).toBe('the full stored text');
  });

  it("the item's evidence counts as the user's own message by name", () => {
    const [c] = evidenceCandidates([ev('ev_2', { author: 'jordan lee ' })], ME);
    expect(c!.isMe).toBe(true);
  });

  it('evidence of another thread (its permalink says so) is left out; evidence with no thread info stays in', () => {
    const other = ev('ev_x', { source: { kind: 'slack', label: '#acme-ext', url: 'https://example.slack.com/archives/C0ACME/p1700009999000100?thread_ts=1700009999.000100', externalId: 'C0ACME:1700009999.000100' }, snippet: 'other thread' });
    const same = ev('ev_y', { source: { kind: 'slack', label: '#acme-ext', externalId: 'C0ACME:1700000500.000100' }, snippet: 'reply, thread unknown', at: T('10:00') });
    const s = selectSource({ draft: draft(), candidates: evidenceCandidates([other, same], ME), itemSources: [] });
    expect(s.message?.id).toBe('ev_y');
    expect(s.earlier).toEqual([]);
  });
});

describe('after the 90-day purge, and with nothing stored', () => {
  it('a purged body falls back to the evidence line and says so; the link stays', () => {
    const c = evidenceCandidates([ev('ev_1', { snippet: null })], ME).map((x) => ({ ...x, purged: true, rank: 2 as const }));
    const s = buildDraftSource({ draft: draft(), candidates: c, itemSources: [], labels: {} });
    expect(s.message).toMatchObject({ body: 'purged', text: 'Dana asked about the demo' });
    expect(s.url).toBe('https://example.slack.com/archives/C0ACME/p1700000000000100');
  });

  it("no message at all: the item's own source of that kind in the same channel is the link", () => {
    const s = buildDraftSource({
      draft: draft(),
      candidates: [],
      itemSources: [
        { kind: 'slack', label: 'other', url: 'https://example.slack.com/archives/C0OTHER/p1' },
        { kind: 'slack', label: '#acme-ext', url: 'https://example.slack.com/archives/C0ACME/p1' },
      ],
      labels: {},
    });
    expect(s).toMatchObject({ message: null, url: 'https://example.slack.com/archives/C0ACME/p1', earlier: [] });
  });

  it('else the archive link derived from the thread, when the workspace host is configured', () => {
    vi.stubEnv('CC_SLACK_HOST', 'https://example.slack.com');
    expect(buildDraftSource({ draft: draft(), candidates: [], itemSources: [], labels: {} }).url).toBe('https://example.slack.com/archives/C0ACME/p1700000000000100');
  });
});

describe('email', () => {
  const dest: Draft['destination'] = { kind: 'email', target: 'reply', to: [{ name: 'Marcus Webb', email: 'marcus@globex.example' }], cc: [], subject: 'Re: RE: DPA redlines', threadId: 'msg_2', inReplyTo: null };
  const mail = (id: string, over: Partial<SourceCandidate>) => row(id, { kind: 'gmail', format: 'plain', label: 'DPA redlines', ...over });

  it('answers the latest email from someone else in the thread; a thread id naming a message brings its thread', () => {
    const rows = [
      mail('g1', { externalId: 'msg_1', thread: 'gmail-thread:t1', at: T('08:00'), author: 'Jordan Lee', isMe: true, body: 'Redlines attached.', subject: 'DPA redlines', from: 'Jordan Lee <jordan@example.com>', to: 'Marcus Webb <marcus@globex.example>' }),
      mail('g2', { externalId: 'msg_2', thread: 'gmail-thread:t1', at: T('09:00'), author: 'Marcus Webb', body: 'Thanks Jordan,\n\nLegal has one question: https://example.com/q.\n\n> Redlines attached.', subject: 'Re: DPA redlines', from: 'Marcus Webb <marcus@globex.example>', to: 'Jordan Lee <jordan@example.com>', url: 'https://mail.example.com/#all/t1' }),
      mail('g9', { externalId: 'msg_9', thread: 'gmail-thread:t9', at: T('10:00'), author: 'Someone Else', body: 'Another thread' }),
    ];
    const s = buildDraftSource({ draft: draft({ destination: dest }), candidates: rows, itemSources: [], labels: {} });
    expect(s).toMatchObject({ kind: 'gmail', relation: 'reply', where: 'Re: RE: DPA redlines', url: 'https://mail.example.com/#all/t1' });
    expect(s.message).toMatchObject({ id: 'g2', subject: 'Re: DPA redlines', from: 'Marcus Webb <marcus@globex.example>', to: 'Jordan Lee <jordan@example.com>' });
    expect(s.message!.html).toContain('<a href="https://example.com/q"');
    expect(s.message!.html).toContain('<blockquote class="cc-quote">Redlines attached.</blockquote>');
    expect(s.earlier.map((m) => m.id)).toEqual(['g1']);
    expect(JSON.stringify(s)).not.toContain('Another thread');
  });

  it("an HTML body is sanitized; the subject falls back to the destination's without Re:", () => {
    const s = buildDraftSource({ draft: draft({ destination: dest }), candidates: [mail('g3', { externalId: 'msg_2', format: 'html', body: '<p>Hi</p><script>bad()</script><img src=x onerror=y()>' })], itemSources: [], labels: {} });
    expect(s.message!.html).toBe('<div class="cc-source cc-source-email"><p>Hi</p></div>');
    expect(s.message!.subject).toBe('DPA redlines');
  });
});

describe('new messages and admin items', () => {
  it("a channel post shows the work item's origin message as its source (a closing reply never counts)", () => {
    const d = draft({ destination: { kind: 'slack', target: 'channel', channelId: 'C0INITECH', channelName: '#initech-ext', threadTs: null } });
    const c = evidenceCandidates(
      [
        ev('ev_o', { role: 'origin', at: T('08:00'), snippet: 'Can you share the inventory?', author: 'Peter Gibbons', source: { kind: 'gmail', label: 'Gmail · Peter Gibbons', url: 'https://mail.example.com/#all/t2', externalId: 'msg_o' } }),
        ev('ev_c', { role: 'completion', at: T('11:00'), snippet: 'Done', author: 'Jordan Lee', source: { kind: 'gmail', label: 'Gmail · sent', externalId: 'msg_c' } }),
      ],
      ME,
    );
    const s = buildDraftSource({ draft: d, candidates: c, itemSources: [], labels: {} });
    expect(s).toMatchObject({ kind: 'gmail', relation: 'source', url: 'https://mail.example.com/#all/t2' });
    expect(s.message).toMatchObject({ id: 'ev_o', author: 'Peter Gibbons', text: 'Can you share the inventory?' });
  });

  it('a structured action answers nothing', () => {
    const d = draft({ destination: { kind: 'action', action: 'vdp.update_use_case', target: { label: 'Placeholder VDP', url: null }, input: {}, changes: [], text: null } });
    expect(buildDraftSource({ draft: d, candidates: [row('r', {})], itemSources: [], labels: {} })).toEqual({ draftId: 'dr_1', kind: null, relation: 'source', where: 'Placeholder VDP', url: null, message: null, earlier: [], earlierTotal: 0 });
    expect(draftSourceLink({ draft: d, candidates: [], itemSources: [] })).toBeNull();
  });
});

describe('bodies stay redacted', () => {
  it('credential-like text that reached a body is redacted again before it is rendered', () => {
    const s = buildDraftSource({ draft: draft(), candidates: [row('r1', { externalId: 'C0ACME:1700000000.000100', thread: KEY, body: 'demo org password: placeholder-only-123' })], itemSources: [], labels: {} });
    expect(s.message!.text).toContain('[REDACTED:password]');
    expect(JSON.stringify(s)).not.toContain('placeholder-only-123');
  });
});

describe('slackLabels', () => {
  it('maps Slack user ids to names (handles that are not ids are skipped)', () => {
    expect(slackLabels([{ name: 'Raj Mehta', slackHandle: 'U0RAJ' }, { name: 'No Id', slackHandle: 'raj' }, { name: 'None', slackHandle: null }])).toEqual({ U0RAJ: 'Raj Mehta' });
  });
});

describe('the mock route (placeholder seed)', () => {
  it("dr_dana answers Dana's latest message, rich, with the mention by name, the earlier messages and the link", async () => {
    const ds = createMockDataSource({ autoplay: false });
    const s = await ds.getDraftSource({ params: { id: 'dr_dana' } } as never);
    expect(s).toMatchObject({ kind: 'slack', relation: 'reply', where: '#acme-ext', url: 'https://example.slack.com/archives/C0ACME/p1', earlierTotal: 2 });
    expect(s.message).toMatchObject({ author: 'Dana Reyes', isMe: false, body: 'full' });
    expect(s.message!.html).toContain('<strong>service-agent handoff</strong>');
    expect(s.message!.html).toContain('@Raj Mehta');
    expect(s.message!.html).toContain('<code class="cc-code">demo-env</code>');
    expect(s.earlier.map((m) => [m.author, m.isMe])).toEqual([
      ['Dana Reyes', false],
      ['Jordan Lee', true],
    ]);
    const nudge = await ds.getDraftSource({ params: { id: 'dr_nudge_globex' } } as never);
    expect(nudge).toMatchObject({ kind: 'gmail', relation: 'reply', url: 'https://mail.example.com/#inbox/globex1' });
    expect(nudge.message).toMatchObject({ isMe: true, subject: 'DPA redlines', body: 'full' });
    const outbox = await ds.getOutbox({} as never);
    const rows = outbox.groups.flatMap((g) => g.items);
    expect(rows.find((i) => i.draft.id === 'dr_nudge_globex')!.source).toEqual({ kind: 'gmail', label: 'Re: DPA redlines', url: 'https://mail.example.com/#inbox/globex1' });
    expect(rows.find((i) => i.draft.id === 'dr_sent_sso')!.source).toMatchObject({ kind: 'slack', url: 'https://example.slack.com/archives/C0ACME/p1' });
  });
});
