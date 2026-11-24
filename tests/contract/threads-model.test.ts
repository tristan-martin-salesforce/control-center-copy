/**
 * CONTRACT-1 tasks 2 + 3: POST /chat/threads, and the model choice (ChatRequest.model, settings.chat,
 * echoed in the `start` header event).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorEnvelope, ChatThread, ChatThreadDetail, DEFAULT_CHAT_SETTINGS, routes, Settings, type ChatSseEvent } from '@/contract';
import { parseSse } from '@/client/api';
import { resetDataSourceForTests } from '@/server/datasource';
import type { MockDataSource } from '@/server/datasource/mock';
import * as chatRoute from '../../app/api/v1/chat/route';
import * as threadsRoute from '../../app/api/v1/chat/threads/route';
import * as threadRoute from '../../app/api/v1/chat/threads/[id]/route';
import * as settingsRoute from '../../app/api/v1/settings/[section]/route';
import { ask, newDs, of, rawExampleSeed } from './helpers';

let ds: MockDataSource;
beforeEach(() => {
  ds = newDs();
});
afterEach(() => ds.dispose());

describe('POST /chat/threads (DataSource)', () => {
  it('creates an empty, titled thread with context; Today stays first in the list', async () => {
    const t = await ds.createChatThread({ body: { title: 'Globex estimate', context: [{ type: 'work_item', id: 'w_globex_estimate', label: 'Share the estimate' }] } });
    expect(ChatThread.parse(t)).toMatchObject({ title: 'Globex estimate', isDefault: false, messageCount: 0, lastMessagePreview: null });
    expect(t.context).toEqual([{ type: 'work_item', id: 'w_globex_estimate', label: 'Share the estimate', via: 'auto' }]);
    const { threads } = await ds.listChatThreads({} as never);
    expect(threads[0].isDefault).toBe(true);
    expect(threads.map((x) => x.id)).toContain(t.id);
    expect(ChatThreadDetail.parse(await ds.getChatThread({ params: { id: t.id } })).messages).toEqual([]);
  });

  it('an untitled thread takes its title from the first message, and turns stay in that thread', async () => {
    const t = await ds.createChatThread({ body: { context: [] } });
    expect(t.title).toBe('New thread');
    const evs = await ask(ds, 'what did I promise Ravi?', { threadId: t.id });
    expect(of(evs, 'done')[0].threadId).toBe(t.id);
    const d = await ds.getChatThread({ params: { id: t.id } });
    expect(d.thread.title).toBe('what did I promise Ravi?');
    expect(d.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((await ds.getChatThread({ params: { id: 'thread_today' } })).messages.some((m) => m.text === 'what did I promise Ravi?')).toBe(false);
  });

  it("the thread's context reaches every turn as an auto chip", async () => {
    const promise = ds.store.get('workItems', 'w_promise_beacon')!;
    const t = await ds.createChatThread({ body: { context: [{ type: 'work_item', id: promise.id, label: promise.title }] } });
    const evs = await ask(ds, '/why', { threadId: t.id });
    expect(of(evs, 'text-delta').map((e) => e.delta).join('')).toContain(promise.title);
  });

  it('drops unknown context types; a chat to an unknown thread is not_found', async () => {
    const t = await ds.createChatThread({ body: { context: [{ type: 'spaceship', id: 'x', label: 'x' }] } });
    expect(t.context).toEqual([]);
    const gen = ds.chat({ body: { text: 'hi', context: [], threadId: 'nope' }, signal: new AbortController().signal });
    await expect(gen.next()).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('model choice', () => {
  const startOf = (evs: ChatSseEvent[]) => {
    expect(evs[0].type).toBe('start');
    return of(evs, 'start')[0];
  };

  it('defaults to Auto routing (Assistant v2: small talk is a Haiku turn); the request can pick opus; both are echoed and stored', async () => {
    expect((await ds.getSettings({} as never)).chat).toEqual(DEFAULT_CHAT_SETTINGS);
    const a = await ask(ds, 'good morning');
    expect(startOf(a)).toMatchObject({ model: 'haiku', threadId: 'thread_today', route: { intent: 'chat', tier: 'fast', override: false } });
    const b = await ask(ds, 'good morning', { model: 'opus' });
    const s = startOf(b);
    const done = of(b, 'done')[0];
    expect(s).toMatchObject({ model: 'opus', messageId: done.messageId, userMessageId: done.userMessageId });
    const msgs = (await ds.getChatThread({ params: { id: 'thread_today' } })).messages;
    expect(msgs.find((m) => m.id === done.messageId)?.model).toBe('opus');
  });

  it('PATCH /settings/chat routing ("always Opus") changes the model (instant save, versioned)', async () => {
    const cur = (await ds.getSettings({} as never)).chat;
    const r = await ds.patchSettings({ params: { section: 'chat' }, body: { ifVersion: cur.version, value: { routing: 'opus' } } });
    expect(r.entity.chat).toMatchObject({ version: cur.version + 1, routing: 'opus' });
    expect(startOf(await ask(ds, 'good morning')).model).toBe('opus');
    await expect(ds.patchSettings({ params: { section: 'chat' }, body: { ifVersion: cur.version, value: { routing: 'sonnet' } } })).rejects.toMatchObject({ code: 'conflict' });
    await expect(ds.patchSettings({ params: { section: 'chat' }, body: { ifVersion: cur.version + 1, value: { routing: 'gpt' } } })).rejects.toMatchObject({ code: 'validation' });
  });

  it('seeds without a chat section still parse (defaulted)', () => {
    // the generated example seed writes every section, so drop chat to stand in for a seed written before it existed
    const { chat: _chat, ...settings } = (rawExampleSeed() as { settings: Record<string, unknown> }).settings;
    expect('chat' in settings).toBe(false);
    expect(Settings.parse(settings).chat).toEqual(DEFAULT_CHAT_SETTINGS);
  });
});

describe('generated routes', () => {
  afterEach(() => resetDataSourceForTests());
  const base = 'http://localhost/api/v1';
  const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
  const post = (body?: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  it('route table: POST /chat/threads → createChatThread', () => {
    expect(routes.createChatThread).toMatchObject({ method: 'POST', path: '/chat/threads', topic: 'chat' });
  });

  it('POST /chat/threads returns a ChatThread (body optional); bad input is a 400 envelope', async () => {
    const res = await threadsRoute.POST(new Request(`${base}/chat/threads`, post({ title: 'Prep', context: [{ type: 'account', id: 'acc_acme', label: 'ACME' }] })), ctx());
    expect(res.status).toBe(200);
    const t = ChatThread.parse(await res.json());
    expect(t.title).toBe('Prep');
    const got = await threadRoute.GET(new Request(`${base}/chat/threads/${t.id}`), ctx({ id: t.id }));
    expect(ChatThreadDetail.parse(await got.json()).thread.id).toBe(t.id);

    const bare = await threadsRoute.POST(new Request(`${base}/chat/threads`, post()), ctx());
    expect(ChatThread.parse(await bare.json()).title).toBe('New thread');

    const bad = await threadsRoute.POST(new Request(`${base}/chat/threads`, post({ title: 42 })), ctx());
    expect(bad.status).toBe(400);
    expect(ApiErrorEnvelope.parse(await bad.json()).error.code).toBe('validation');
  });

  it('POST /chat streams `start` first with the model; PATCH /settings/chat round-trips', async () => {
    const res = await chatRoute.POST(new Request(`${base}/chat`, post({ text: 'find the ACME deck', model: 'opus' })), ctx());
    const types: string[] = [];
    let model: string | undefined;
    for await (const ev of parseSse<{ type: string; model?: string }>(res.body!)) {
      types.push(ev.type);
      if (ev.type === 'start') model = ev.model;
    }
    expect(types[0]).toBe('start');
    expect(model).toBe('opus');
    expect(types.at(-1)).toBe('done');

    const patched = await settingsRoute.PATCH(new Request(`${base}/settings/chat`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ifVersion: 1, value: { defaultModel: 'opus' } }) }), ctx({ section: 'chat' }));
    expect(patched.status).toBe(200);
    expect(Settings.parse((await patched.json()).entity).chat.defaultModel).toBe('opus');
  });
});
