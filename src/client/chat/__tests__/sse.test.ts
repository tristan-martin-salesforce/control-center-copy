import { describe, expect, it } from 'vitest';
import type { ChatSseEvent } from '@/contract';
import { createSseParser, isAbortError, parseChatFrame, readSseStream, type SseFrame } from '../sse';

const enc = new TextEncoder();

function collect(chunks: string[]): SseFrame[] {
  const frames: SseFrame[] = [];
  const p = createSseParser((f) => frames.push(f));
  for (const c of chunks) p.push(c);
  p.end();
  return frames;
}

function streamOf(parts: Uint8Array[], opts: { hang?: boolean } = {}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      if (!opts.hang) controller.close();
    },
  });
}

const frame = (ev: ChatSseEvent) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;

describe('SSE parser', () => {
  it('parses a whole stream in one chunk', () => {
    const text = frame({ type: 'text-delta', messageId: 'm1', delta: 'Hi ' }) + frame({ type: 'done', threadId: 't', messageId: 'm1', userMessageId: 'u1' });
    const frames = collect([text]);
    expect(frames.map((f) => f.event)).toEqual(['text-delta', 'done']);
    expect(JSON.parse(frames[0].data).delta).toBe('Hi ');
  });

  it('is independent of chunk boundaries (every split point gives the same frames)', () => {
    const text =
      ': ping 1\n\n' +
      frame({ type: 'tool-start', id: 'tool_1', name: 'drive.search', summary: 'Searching Drive for "deck"' }) +
      'id: 7\nevent: text-delta\ndata: {"type":"text-delta","messageId":"m","delta":"a\\nb"}\n\n' +
      frame({ type: 'done', threadId: 't', messageId: 'm', userMessageId: 'u' });
    const whole = collect([text]);
    expect(whole).toHaveLength(3);
    for (let i = 1; i < text.length; i++) {
      expect(collect([text.slice(0, i), text.slice(i)])).toEqual(whole);
    }
    // one character at a time
    expect(collect(text.split(''))).toEqual(whole);
    expect(whole[1].id).toBe('7');
  });

  it('joins multi-line data with \\n and strips one leading space', () => {
    const frames = collect(['event: note\ndata: line one\ndata:  two (indented)\ndata:three\n\n']);
    expect(frames[0].data).toBe('line one\n two (indented)\nthree');
  });

  it('accepts CRLF and bare CR line endings, including a CR split from its LF', () => {
    const frames = collect(['event: a\r', '\ndata: 1\r\n\r', '\nevent: b\rdata: 2\r\r']);
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('skips comments and frames without data; drops an unterminated final frame', () => {
    const frames = collect([': heartbeat\n\nevent: empty\n\nretry: 3000\ndata: x\n\n', 'event: partial\ndata: never dispatched']);
    expect(frames).toEqual([{ event: 'message', data: 'x', retry: 3000 }]);
  });

  it('decodes multi-byte UTF-8 split across network chunks', async () => {
    const bytes = enc.encode(frame({ type: 'text-delta', messageId: 'm', delta: 'Café → déjà vu ✓' }));
    const cut = bytes.indexOf(0xc3) + 1; // inside "é"
    const parts = [bytes.slice(0, cut), bytes.slice(cut, cut + 3), bytes.slice(cut + 3)];
    const frames: SseFrame[] = [];
    await readSseStream(streamOf(parts), (f) => frames.push(f));
    expect(JSON.parse(frames[0].data).delta).toBe('Café → déjà vu ✓');
  });

  it('abort stops a hanging stream with an AbortError and no further frames', async () => {
    const ac = new AbortController();
    const frames: SseFrame[] = [];
    const p = readSseStream(streamOf([enc.encode(frame({ type: 'text-delta', messageId: 'm', delta: 'one' }))], { hang: true }), (f) => frames.push(f), ac.signal);
    // abort once the first frame is in (the stream then hangs), not after a fixed sleep the reader may not have used
    for (let i = 0; i < 500 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(frames).toHaveLength(1);
    ac.abort();
    const err = await p.catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect(frames).toHaveLength(1);
  });

  it('an already-aborted signal rejects before reading', async () => {
    const ac = new AbortController();
    ac.abort();
    const frames: SseFrame[] = [];
    const err = await readSseStream(streamOf([enc.encode(frame({ type: 'text-delta', messageId: 'm', delta: 'x' }))]), (f) => frames.push(f), ac.signal).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect(frames).toHaveLength(0);
  });
});

describe('parseChatFrame', () => {
  it('returns contract events and ignores hello, junk and unknown types', () => {
    expect(parseChatFrame({ event: 'done', data: JSON.stringify({ type: 'done', threadId: 't', messageId: 'm', userMessageId: 'u' }) })?.type).toBe('done');
    expect(parseChatFrame({ event: 'hello', data: '{"at":"x"}' })).toBeNull();
    expect(parseChatFrame({ event: 'text-delta', data: '{not json' })).toBeNull();
    expect(parseChatFrame({ event: 'future', data: '{"type":"future-thing"}' })).toBeNull();
  });

  it('parses the error event envelope', () => {
    const ev = parseChatFrame({ event: 'error', data: JSON.stringify({ type: 'error', error: { code: 'upstream_unavailable', message: 'Slack is down', retryable: true } }) });
    expect(ev).toEqual({ type: 'error', error: { code: 'upstream_unavailable', message: 'Slack is down', retryable: true } });
  });
});
