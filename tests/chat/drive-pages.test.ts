/**
 * Drive reads page through a long file (the Assistant's chat_drive_read, the research and read-in runs): a sheet of 80
 * rows is about 40,000 characters, and a single capped excerpt showed its first 10 rows only. Each page ends at a line
 * break and says the offset to read next; pages are redacted like the excerpt was.
 */
import { describe, expect, it } from 'vitest';

import { createReadInTools, createToolState, pageForModel } from '@/llm/readin/tools';
import { CHAT_DRIVE_PAGE, CHAT_GMAIL_PAGE, createChatHost } from '@/server/chat/host';
import { MockDataSource } from '@/server/datasource/mock';

/** A placeholder sheet export: a header and one row per opp, about 480 characters a row. */
const sheet = (n: number) => ['SAF\tAccount\tOpportunity\tNotes', ...Array.from({ length: n }, (_, i) => `SAF-0${5_000_000 + i}\tPlaceholder Account ${i}\tPlaceholder Account ${i} - Data Cloud Expansion\t${'note '.repeat(80)}`)].join('\n');

const google = (text: string) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  return { calls, client: { call: async (tool: string, args: Record<string, unknown>) => (calls.push({ tool, args }), text), health: async () => ({ state: 'ok' as const, checkedAt: '2026-11-13T00:00:00.000Z' }) } };
};

/** Every page of a file, following "read again with offset=N" (at most 20 pages). */
async function readAll(read: (offset?: number) => Promise<string>): Promise<string[]> {
  const pages: string[] = [];
  let offset: number | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await read(offset);
    pages.push(page);
    const next = /read again with offset=(\d+)\]$/.exec(page)?.[1];
    if (!next) break;
    offset = Number(next);
  }
  return pages;
}

describe('Drive file pages', () => {
  it('pageForModel: pages end at a line break, say where they are and the next offset, and cover the file once', () => {
    const text = sheet(80);
    const state = createToolState();
    const first = pageForModel(text, 12_000, 0, state);
    expect(first.startsWith('SAF\tAccount')).toBe(true);
    const next = Number(/offset=(\d+)\]$/.exec(first)![1]);
    expect(text[next - 1]).toBe('\n');
    const second = pageForModel(text, 12_000, next, state);
    expect(second.startsWith(`[characters ${next}–`)).toBe(true);
    expect(second.split('\n')[1]).toMatch(/^SAF-0\d+\tPlaceholder Account \d+\t/);
    expect(pageForModel(text, 12_000, text.length + 5, state)).toMatch(/past the end: the file has \d+ characters/);
    expect(pageForModel('short file', 12_000, 0, state)).toBe('short file');
  });

  it('pages are redacted like the excerpt was', () => {
    const page = pageForModel(`row 1\npassword: hunter2hunter2\nrow 3`, 12_000, 0, createToolState());
    expect(page).not.toContain('hunter2hunter2');
  });

  it('the read-in tool takes an offset (default page 6,000 characters)', async () => {
    const g = google(sheet(80));
    const tools = createReadInTools({ google: g.client }, createToolState());
    const pages = await readAll(async (offset) => (await tools.readin_drive_read({ file_id: 'file-1', ...(offset !== undefined ? { offset } : {}) })).text);
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.every((p) => p.length <= 6_000 + 120)).toBe(true);
    expect(pages.join('\n').match(/SAF-0\d+/g)).toHaveLength(80);
    expect(g.calls.every((c) => c.tool === 'get_drive_file_content' && c.args.file_id === 'file-1')).toBe(true);
  });

  it('the Assistant reads a 40,000-character sheet in a few pages and sees every row', async () => {
    const text = sheet(80);
    expect(text.length).toBeGreaterThan(38_000);
    const ds = new MockDataSource();
    try {
      const g = google(text);
      const backend = { ...ds.be6.backend(), google: async () => g.client };
      const host = createChatHost(ds, backend, () => ds.now());
      const pages = await readAll(async (offset) => (await host.googleRead('drive_read', { file_id: 'file-1', ...(offset !== undefined ? { offset } : {}) })).text);
      expect(pages.length).toBe(Math.ceil(text.length / CHAT_DRIVE_PAGE));
      const rows = new Set(pages.join('\n').match(/SAF-0\d+/g));
      expect(rows.size).toBe(80);
    } finally {
      ds.dispose();
    }
  });

  it('A6: the Assistant pages are 60,000 characters (a 40,000-character sheet is one read; 200 rows are two)', async () => {
    expect(CHAT_DRIVE_PAGE).toBe(60_000);
    const text = sheet(200);
    const ds = new MockDataSource();
    try {
      const g = google(text);
      const host = createChatHost(ds, { ...ds.be6.backend(), google: async () => g.client }, () => ds.now());
      const pages = await readAll(async (offset) => (await host.googleRead('drive_read', { file_id: 'file-1', ...(offset !== undefined ? { offset } : {}) })).text);
      expect(pages).toHaveLength(2);
      expect(new Set(pages.join('\n').match(/SAF-0\d+/g)).size).toBe(200);
    } finally {
      ds.dispose();
    }
  });

  it('A6: a long Gmail thread pages by offset in chat and in read-ins (never cut), fetched once per run', async () => {
    const body = sheet(200);
    const ds = new MockDataSource();
    try {
      const g = google(body);
      const host = createChatHost(ds, { ...ds.be6.backend(), google: async () => g.client }, () => ds.now());
      const pages = await readAll(async (offset) => (await host.googleRead('gmail_thread', { thread_id: 'thread-1', ...(offset !== undefined ? { offset } : {}) })).text);
      expect(pages.length).toBe(Math.ceil(body.length / CHAT_GMAIL_PAGE));
      expect(new Set(pages.join('\n').match(/SAF-0\d+/g)).size).toBe(200);
      expect(g.calls.every((c) => c.tool === 'get_gmail_thread_content' && c.args.thread_id === 'thread-1')).toBe(true);
      // the chat turn fetched the thread once and paged that copy
      expect(g.calls.length).toBe(1);
      // a read-in's thread read pages too (smaller pages), never cut
      const tools = createReadInTools({ google: g.client }, createToolState());
      const first = await tools.readin_gmail_thread({ thread_id: 'thread-1' });
      expect(first.text).not.toMatch(/truncated/);
      const next = /read again with offset=(\d+)/.exec(first.text)?.[1];
      expect(next).toBeDefined();
      const second = await tools.readin_gmail_thread({ thread_id: 'thread-1', offset: Number(next) });
      expect(second.text).toMatch(new RegExp(`^\\[characters ${next}–`));
    } finally {
      ds.dispose();
    }
  });
});

describe('search results page (ASSIST-5)', () => {
  it('a Gmail or Drive search passes the next-page token through and pages a long result instead of cutting it at 4,000', async () => {
    const hits = Array.from({ length: 60 }, (_, i) => `- Message ${i}: placeholder subject ${'x'.repeat(80)} (https://mail.example.com/m${i})`).join('\n');
    const g = google(`${hits}\npage_token='tok2'`);
    const tools = createReadInTools({ google: g.client }, createToolState());
    const pages = await readAll(async (offset) => (await tools.readin_gmail_search({ query: 'from:dana', max: 50, ...(offset !== undefined ? { offset } : {}) })).text);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('\n')).not.toMatch(/truncated/);
    expect(new Set(pages.join('\n').match(/Message \d+:/g)).size).toBe(60);
    expect(pages.at(-1)).toMatch(/page_token='tok2'/);
    expect(g.calls).toHaveLength(1); // the later pages read the first fetch
    expect(g.calls[0]!.args).toMatchObject({ query: 'from:dana', page_size: 50 });
    await tools.readin_drive_search({ query: "name contains 'deck'", page_token: 'tok2' });
    expect(g.calls[1]!.args).toMatchObject({ page_token: 'tok2' });
  });
});
