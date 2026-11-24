import { describe, expect, it } from 'vitest';
import { docsAskOf, GmailFetcher, newTextOf } from '@/connectors/google/gmail';
import { parseGmailBatch, parseGmailSearch, parseGmailThread } from '@/connectors/google/parse';
import { clock, FakeGoogle, fx, keyOf, ME, signal, WINDOW } from './helpers';

function fake(opts: { sentOnly?: boolean } = {}) {
  return new FakeGoogle({
    search_gmail_messages: (a) => {
      const q = String(a.query);
      if (q.includes('has:attachment')) return fx('gmail', 'search_attachments.txt');
      return q.startsWith('in:sent') ? fx('gmail', 'search_sent.txt') : fx('gmail', 'search_inbox.txt');
    },
    get_gmail_messages_content_batch: (a) => {
      const ids = a.message_ids as string[];
      return ids.includes('18f0000000000004') && !opts.sentOnly ? fx('gmail', 'batch_sent.txt') : ids.includes('18f0000000000004') ? fx('gmail', 'batch_sent.txt') : fx('gmail', 'batch_inbox.txt');
    },
    get_gmail_threads_content_batch: () => fx('gmail', 'threads_inbox.txt'),
  });
}

describe('R15: Google Docs action items and comment mentions are asks of me', () => {
  const doc = 'https://docs.google.com/document/d/FILE_PLACEHOLDER_DOC01/edit?disco=AAA';
  it('reads the kind and the doc from a Docs notification; ordinary bulk mail is not one', () => {
    expect(docsAskOf('PERSON_A (Google Docs) <comments-noreply@docs.google.com>', 'ACME plan - PERSON_A assigned you an action item', `Open ${doc}`)).toEqual({ kind: 'action_item', fileId: 'FILE_PLACEHOLDER_DOC01' });
    expect(docsAskOf('PERSON_A (Google Slides) <comments-noreply@docs.google.com>', 'PERSON_A mentioned you in a comment', `in ${doc}`)).toMatchObject({ kind: 'mention' });
    expect(docsAskOf('Newsletter <no-reply@example.com>', 'PERSON_A assigned you an action item', doc)).toBeNull();
    expect(docsAskOf('PERSON_A <comments-noreply@docs.google.com>', 'PERSON_A shared a document', doc)).toBeNull();
  });
});

describe('gmail parsers', () => {
  it('parses search hits, threads and page token', () => {
    const p = parseGmailSearch(fx('gmail', 'search_inbox.txt') + "\n📄 PAGINATION: To get the next page, call search_gmail_messages again with page_token='tok123'");
    expect(p.hits.map((h) => h.id)).toEqual(['18f0000000000003', '18f0000000000002', '18f0000000000001']);
    expect(p.hits[1]!.threadId).toBe('18f00000000000a1');
    expect(p.nextPageToken).toBe('tok123');
  });

  it('parses batch messages with headers and bodies', () => {
    const ms = parseGmailBatch(fx('gmail', 'batch_inbox.txt'));
    expect(ms).toHaveLength(3);
    expect(ms[0]).toMatchObject({ id: '18f0000000000001', subject: 'Re: ACME_CORP data cloud workshop agenda', cc: 'SE_2 <se.two@example.com>' });
    expect(ms[0]!.dateIso).toBe('2026-03-10T16:05:00.000Z');
    expect(ms[0]!.body).toContain('Can you send the updated deck');
    expect(ms[2]!.body.startsWith('<!DOCTYPE')).toBe(true);
  });

  it('parses thread messages', () => {
    const t = parseGmailThread(fx('gmail', 'threads_inbox.txt').split('Thread ID: 18f00000000000a1')[0]!);
    expect(t.messages).toHaveLength(2);
    expect(t.messages[1]!.from).toContain('me@example.com');
  });

  it('strips quoted history', () => {
    const n = newTextOf('Hi\n\nDeck attached.\n\nOn Tue, Mar 10, 2026 at 4:05 PM AE <a@b.c> wrote:\n> old stuff\n');
    expect(n).toBe('Hi\n\nDeck attached.');
    expect(newTextOf('Reply\n\n________________________________\nFrom: x\nSent: y\nold')).toBe('Reply');
  });
});

describe('GmailFetcher', () => {
  const mk = (g = fake()) => ({ g, f: new GmailFetcher({ google: g, me: ME, clock }) });

  it('emits one email item per message with the fields the skill needs', async () => {
    const { f } = mk();
    const r = await f.fetch('inbox', null, WINDOW, { signal });
    expect(r.items).toHaveLength(3);
    const ask = r.items.find((i) => i.externalId === '18f0000000000001')!;
    expect(ask).toMatchObject({ connector: 'gmail', kind: 'email', dedupeKey: 'gmail:18f0000000000001', threadRef: 'gmail-thread:18f00000000000b1' });
    expect(ask.author).toMatchObject({ email: 'ae.one@example.com', isMe: false, isExternal: false });
    expect(ask.participants?.map((p) => p.email)).toEqual(['me@example.com', 'se.two@example.com']);
    expect(ask.participants?.[0]!.isMe).toBe(true);
    expect(ask.fileRefs).toEqual(['1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789']);
    expect(ask.payload).toMatchObject({ direction: 'received', toMe: true, ccMe: false, repliedByMe: true, threadSize: 2, bulk: false });
    expect(String(ask.payload!.bodyNew)).not.toContain("I'll send the deck once"); // quoted history stripped
    expect(ask.excerpt!.length).toBeLessThanOrEqual(1000);
  });

  it('flags customers as external, attachments, bulk mail and calendar notices', async () => {
    const { f } = mk();
    const r = await f.fetch('inbox', null, WINDOW, { signal });
    const cust = r.items.find((i) => i.externalId === '18f0000000000002')!;
    expect(cust.author?.isExternal).toBe(true);
    expect(cust.payload).toMatchObject({ hasAttachment: true, mentionsAttachment: true, repliedByMe: false });
    const daily = r.items.find((i) => i.externalId === '18f0000000000003')!;
    expect(daily.payload).toMatchObject({ bulk: true });
    expect(String(daily.payload!.bodyNew)).toContain('Welcome to The Daily');
    expect(String(daily.payload!.bodyNew)).not.toContain('<td>'); // html converted
  });

  it('redacts credentials from excerpt, bodies and titles before they leave the connector', async () => {
    const { f } = mk();
    const r = await f.fetch('inbox', null, WINDOW, { signal });
    const ask = r.items.find((i) => i.externalId === '18f0000000000001')!;
    const blob = JSON.stringify(ask);
    expect(blob).not.toContain('Sup3rSecret');
    expect(blob).toContain('[REDACTED:login_pair]');
    expect(ask.redacted).toBe(true);
  });

  it('sent scope: direction sent, author is me', async () => {
    const { f } = mk();
    const r = await f.fetch('sent', null, WINDOW, { signal });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.author?.isMe).toBe(true);
    expect(r.items[0]!.payload).toMatchObject({ direction: 'sent' });
    expect(r.items[0]!.fileRefs).toEqual(['1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789']);
  });

  it('coverage lists the mailbox range and every message fetched', async () => {
    const { f } = mk();
    const r = await f.fetch('inbox', null, WINDOW, { signal });
    expect(r.complete).toBe(true);
    expect(r.coverage[0]).toMatchObject({ kind: 'mailbox_range', ref: 'gmail:inbox', from: WINDOW.from, to: WINDOW.to });
    const refs = r.coverage.filter((c) => c.kind === 'email').map((c) => c.ref).sort();
    expect(refs).toEqual(r.items.map((i) => i.externalId).sort());
    // Coverage reaches the cursor.
    expect(r.nextCursor.at).toBe(WINDOW.to);
  });

  it('cursor advances and a second run over the same window is idempotent (no new items)', async () => {
    const { f, g } = mk();
    const r1 = await f.fetch('inbox', null, WINDOW, { signal });
    const r2 = await f.fetch('inbox', r1.nextCursor, WINDOW, { signal });
    expect(r2.items).toHaveLength(0);
    expect(r2.complete).toBe(true);
    // Only listing calls, no bodies for already-seen messages.
    expect(g.count('get_gmail_messages_content_batch')).toBe(1);
    const state = JSON.parse(r2.nextCursor.value) as { lastEpoch: number; seen: Record<string, number> };
    expect(Object.keys(state.seen)).toHaveLength(3);
    expect(state.lastEpoch).toBeGreaterThan(0);
  });

  it('the same input always yields identical dedupeKeys and contentHashes', async () => {
    const a = await mk().f.fetch('inbox', null, WINDOW, { signal });
    const b = await mk().f.fetch('inbox', null, WINDOW, { signal });
    expect(a.items.map(keyOf)).toEqual(b.items.map(keyOf));
  });

  it('an edited message keeps its dedupeKey and changes its contentHash', async () => {
    const edited = fx('gmail', 'batch_inbox.txt').replace('by Thursday', 'by Friday');
    const g2 = fake();
    g2.routes.get_gmail_messages_content_batch = () => edited;
    const a = await mk().f.fetch('inbox', null, WINDOW, { signal });
    const b = await new GmailFetcher({ google: g2, me: ME, clock }).fetch('inbox', null, WINDOW, { signal });
    const ka = a.items.find((i) => i.externalId === '18f0000000000001')!;
    const kb = b.items.find((i) => i.externalId === '18f0000000000001')!;
    expect(kb.dedupeKey).toBe(ka.dedupeKey);
    expect(kb.contentHash).not.toBe(ka.contentHash);
  });

  it('respects the limit: oldest first, incomplete, cursor stays behind the unfetched', async () => {
    const { f } = mk();
    const r = await f.fetch('inbox', null, WINDOW, { signal, limit: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.complete).toBe(false);
    expect(r.items[0]!.externalId).toBe('18f0000000000001'); // oldest of the listing
    expect(Date.parse(r.nextCursor.at)).toBeLessThan(Date.parse(WINDOW.to));
    const r2 = await f.fetch('inbox', r.nextCursor, WINDOW, { signal });
    expect(r2.items.map((i) => i.externalId).sort()).toEqual(['18f0000000000002', '18f0000000000003']);
  });

  it('a message the batch tool did not return is not marked seen (retried next run)', async () => {
    const g = fake();
    g.routes.get_gmail_messages_content_batch = () => fx('gmail', 'batch_inbox.txt').split('Message ID: 18f0000000000003')[0]!;
    const f = new GmailFetcher({ google: g, me: ME, clock });
    const r = await f.fetch('inbox', null, WINDOW, { signal });
    expect(r.items).toHaveLength(2);
    expect(r.complete).toBe(false);
    expect(Object.keys(JSON.parse(r.nextCursor.value).seen)).not.toContain('18f0000000000003');
  });

  it('listForReconcile returns email coverage refs for the window', async () => {
    const { f } = mk();
    const l = await f.listForReconcile!('inbox', WINDOW, { signal });
    expect(l.map((c) => c.ref).sort()).toEqual(['18f0000000000001', '18f0000000000002', '18f0000000000003']);
    expect(l.every((c) => c.kind === 'email')).toBe(true);
  });

  it('caps audit: every chosen message\'s thread is looked up (was the first 20), so "did I reply" is known for all', async () => {
    const hits = Array.from({ length: 30 }, (_, i) => `  ${i + 1}. Message ID: 18f1${String(i).padStart(12, '0')}\n     Thread ID: 18f2${String(i).padStart(12, '0')}\n`).join('\n');
    const g = fake();
    g.routes.search_gmail_messages = (a) => (String(a.query).includes('has:attachment') ? fx('gmail', 'search_attachments.txt') : `Found 30 messages:\n\n📧 MESSAGES:\n${hits}`);
    await new GmailFetcher({ google: g, me: ME, clock }).fetch('inbox', null, WINDOW, { signal });
    const looked = g.calls.filter((c) => c.tool === 'get_gmail_threads_content_batch').flatMap((c) => c.args.thread_ids as string[]);
    expect(new Set(looked).size).toBe(30);
  });

  it('only calls read tools', async () => {
    const { f, g } = mk();
    await f.fetch('inbox', null, WINDOW, { signal });
    await f.fetch('sent', null, WINDOW, { signal });
    expect(new Set(g.calls.map((c) => c.tool))).toEqual(new Set(['search_gmail_messages', 'get_gmail_messages_content_batch', 'get_gmail_threads_content_batch']));
  });
});
