/** SEC-8: which of your messages a memory entry came from (memory-source.ts). */
import { describe, expect, it } from 'vitest';
import { excerptOf, memorySource, type MemorySourceMessage } from './memory-source';

const msg = (id: string, threadId: string, at: string, text: string): MemorySourceMessage => ({ id, threadId, threadTitle: `T ${threadId}`, at, text });
const msgs = [
  msg('m1', 'a', '2026-11-21T09:00:00.000Z', 'From now on, log calls in 15-minute steps'),
  msg('m2', 'b', '2026-11-21T09:05:00.000Z', 'What is on my calendar?'),
  msg('m3', 'a', '2026-11-21T09:10:00.000Z', 'Draft the Globex reply'),
  msg('m4', 'b', '2026-11-21T10:00:00.000Z', 'Later message'),
];

describe('memorySource', () => {
  it('a preference: the latest message before it that asked to keep it, across threads', () => {
    const s = memorySource({ threadId: null, kind: 'preference', text: 'Log calls in 15-minute steps', createdAt: '2026-11-21T09:12:00.000Z' }, msgs);
    expect(s).toMatchObject({ messageId: 'm1', threadId: 'a', threadTitle: 'T a', at: '2026-11-21T09:00:00.000Z' });
  });
  it('a preference no message asked for: the latest message before it', () => {
    expect(memorySource({ threadId: null, kind: 'preference', text: 'Something else entirely', createdAt: '2026-11-21T09:12:00.000Z' }, msgs)?.messageId).toBe('m3');
  });
  it('a thread note: the latest message in its thread, never a later one (a few seconds of clock slack)', () => {
    expect(memorySource({ threadId: 'b', kind: 'note', text: 'x', createdAt: '2026-11-21T09:59:57.000Z' }, msgs)?.messageId).toBe('m4');
    expect(memorySource({ threadId: 'b', kind: 'note', text: 'x', createdAt: '2026-11-21T09:30:00.000Z' }, msgs)?.messageId).toBe('m2');
  });
  it('no message: null', () => {
    expect(memorySource({ threadId: 'c', kind: 'note', text: 'x', createdAt: '2026-11-21T09:30:00.000Z' }, msgs)).toBeNull();
    expect(memorySource({ threadId: null, kind: 'preference', text: 'x', createdAt: '2026-11-20T09:30:00.000Z' }, msgs)).toBeNull();
  });
  it('a stored source id is exact: that message, even when a later one in another thread sits within the slack', () => {
    const close = [...msgs, msg('m5', 'b', '2026-11-21T09:10:02.000Z', 'From now on, log calls in 15-minute steps')];
    const e = { threadId: null, kind: 'preference' as const, text: 'Log calls in 15-minute steps', createdAt: '2026-11-21T09:10:03.000Z' };
    expect(memorySource(e, close)?.messageId).toBe('m5'); // the time fallback picks the later thread
    expect(memorySource({ ...e, sourceMessageId: 'm3' }, close)).toMatchObject({ messageId: 'm3', threadId: 'a', threadTitle: 'T a', excerpt: 'Draft the Globex reply' });
  });
  it('a stored source id for a thread note wins over the latest message in that thread', () => {
    expect(memorySource({ threadId: 'b', kind: 'note', text: 'x', createdAt: '2026-11-21T10:00:01.000Z', sourceMessageId: 'm2' }, msgs)?.messageId).toBe('m2');
  });
  it('a stored source id whose message is gone: null, never the time guess', () => {
    expect(memorySource({ threadId: 'a', kind: 'note', text: 'x', createdAt: '2026-11-21T09:12:00.000Z', sourceMessageId: 'gone' }, msgs)).toBeNull();
  });
  it('the excerpt is one line, cut at a word', () => {
    expect(excerptOf('a\n b   c')).toBe('a b c');
    const long = excerptOf('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('word…')).toBe(true);
  });
});
