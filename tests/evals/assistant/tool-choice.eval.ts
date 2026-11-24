/**
 * Tool-choice goldens: the first tool for each ask, picked by the fake model (picker.ts) from the real served catalog
 * (`chatToolsFor`, the descriptions the model sees). They guard the descriptions: a description that stops telling
 * two tools apart fails a case. The agreement prints at the end.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { personaOf } from '@/personas';
import { chatAllowedToolsFor, chatToolsFor } from '@/llm/chat/server';
import { callChatTool, CHAT_TOOL_NAMES, CHAT_TOOLS, untrustedHeader, withoutUntrustedHeader } from '@/llm/chat/tools';
import type { ChatHost } from '@/llm/chat/types';
import type { MockDataSource } from '@/server/datasource/mock';
import { MockChatMemory } from '@/server/datasource/mock/chat-memory';

import { mockWith } from '../../chat/helpers';
import { stepsOf, turn, watchedHost } from './harness';
import { pickFirstTool, redirects } from './picker';
import { TOOL_CHOICE_CASES } from './tool-choice.cases';

const tools = chatToolsFor(null);
/**
 * A VDP ask is an SE's: the loading (null) catalog and an AE's leave VDP out of search, fetch, run, plan and propose
 * (D-55, P31-3), so those asks are picked from the SE's catalog, the one that offers VDP.
 */
const vdpAsk = (ask: string) => /\bvdp\b/i.test(ask);
const seTools = chatToolsFor(personaOf({ persona: { id: 'se' } } as never));
const catalogFor = (ask: string) => (vdpAsk(ask) ? seTools : tools);
let agreed = 0;

afterAll(() => console.log(`Assistant tool-choice goldens: ${agreed}/${TOOL_CHOICE_CASES.length} agree`));

describe('tool-choice goldens', () => {
  it('cover every tool with 30+ asks, over the eleven served tools', () => {
    expect(TOOL_CHOICE_CASES.length).toBeGreaterThanOrEqual(30);
    expect(tools.map((t) => t.name)).toEqual(CHAT_TOOL_NAMES);
    expect(new Set(TOOL_CHOICE_CASES.map((c) => c.expect))).toEqual(new Set(CHAT_TOOL_NAMES));
  });

  it('every redirect in a description names a tool that exists ("…: use X instead")', () => {
    for (const t of tools) for (const r of redirects(t.description)) expect(CHAT_TOOL_NAMES, `${t.name} → ${r.tool}`).toContain(r.tool);
  });

  it.each(TOOL_CHOICE_CASES.map((c) => [c.ask.slice(0, 70), c] as const))('%s', (_l, c) => {
    const r = pickFirstTool(c.ask, catalogFor(c.ask));
    expect(r.tool, `${c.why}; ranking ${r.ranking.slice(0, 3).map((x) => `${x.name} ${x.score}`).join(', ')}${r.via ? `; via ${r.via}` : ''}`).toBe(c.expect);
    agreed += 1;
  });

  it("the picks hold for an AE's catalog too (fewer views and pages, same tools)", () => {
    const ae = personaOf({ persona: { id: 'ae' } } as never);
    const aeTools = chatToolsFor(ae);
    expect(chatAllowedToolsFor(ae)).toEqual(CHAT_TOOL_NAMES.map((n) => `mcp__chat__${n}`));
    const vdpFree = TOOL_CHOICE_CASES.filter((c) => !vdpAsk(c.ask));
    const miss = vdpFree.filter((c) => pickFirstTool(c.ask, aeTools).tool !== c.expect).map((c) => c.ask);
    expect(miss).toEqual([]);
  });
});

/**
 * Post-2.0: the arguments and results of the picked tool, through the real `callChatTool` over the mock DataSource.
 * A guard that holds a call (SEC-8 remember, SEC-9 run reauth) answers `held`, a neutral row, never a failure.
 */
describe('tool-choice goldens: what the chosen tool does with the ask (post-2.0)', () => {
  let ds: MockDataSource;
  beforeEach(() => {
    ds = mockWith();
  });
  afterEach(() => ds.dispose());
  const resultRow = (steps: Parameters<typeof stepsOf>[0]) => stepsOf(steps, 'tool-result')[0]!;

  it('remember keeps a preference only when the user\'s words ask; otherwise the call is held, not failed', async () => {
    const memory = new MockChatMemory(() => ds.now());
    const { host } = watchedHost(ds, { memory });
    for (const text of ['summarise the Globex thread', 'I log in 15-minute steps', 'what did I decide to remember?']) {
      const { ctx, steps } = turn(host, text);
      const r = await callChatTool(ctx, 'remember', { text: 'User logs time in 15-minute steps', scope: 'preference' });
      expect(r, text).toMatchObject({ ok: false, held: true, summary: 'Not kept (say it in your words)' });
      expect(resultRow(steps), text).toMatchObject({ ok: false, held: true });
    }
    expect(await memory.list('t-evals')).toEqual([]);
    const { ctx, steps } = turn(host, 'from now on, remember that I log in 15-minute steps');
    const kept = await callChatTool(ctx, 'remember', { text: 'User logs time in 15-minute steps', scope: 'preference' });
    expect(kept.ok).toBe(true);
    expect(kept.held).toBeUndefined();
    expect(resultRow(steps).held).toBeUndefined();
  });

  it('a thread note is not a standing preference: it is kept for this thread without the preference test', async () => {
    const memory = new MockChatMemory(() => ds.now());
    const { host } = watchedHost(ds, { memory });
    const r = await callChatTool(turn(host, 'keep a note for this conversation: Dana is out until Monday').ctx, 'remember', { text: 'Dana is out until Monday', scope: 'thread' });
    expect(r.ok).toBe(true);
    expect((await memory.list('another-thread')).filter((e) => e.kind === 'note')).toEqual([]);
  });

  it('"forget that" has no tool: remember only keeps (scope thread | preference), and a forget argument is refused', async () => {
    const remember = CHAT_TOOLS.find((t) => t.name === 'remember')!;
    expect(Object.keys(remember.shape).sort()).toEqual(['pinned', 'scope', 'text']);
    const memory = new MockChatMemory(() => ds.now());
    const { host } = watchedHost(ds, { memory });
    const r = await callChatTool(turn(host, 'forget that').ctx, 'remember', { text: 'forget the 15-minute steps', scope: 'preference', forget: true });
    expect(r).toMatchObject({ ok: false, summary: 'Invalid arguments' });
    expect(await memory.list('t-evals')).toEqual([]);
  });

  it('run reauth starts a sign-in only with a sign-in ask naming the connector; otherwise held', async () => {
    const { host, writes } = watchedHost(ds);
    for (const [text, connector] of [
      ['what is broken on Health?', 'vdp'],
      ['summarise my unread mail', 'gmail'],
      ['sign me in again', 'org62'],
      ['sign me in to gmail again', 'vdp'],
    ] as const) {
      const { ctx, steps } = turn(host, text);
      const r = await callChatTool(ctx, 'run', { kind: 'reauth', connector });
      expect(r, `${text} · ${connector}`).toMatchObject({ ok: false, held: true, summary: 'Sign-in not started (say which connector)' });
      expect(resultRow(steps)).toMatchObject({ held: true });
    }
    expect(writes).toEqual([]);
    const okta = turn(host, 'sign me in to okta again');
    const r = await callChatTool(okta.ctx, 'run', { kind: 'reauth', connector: 'vdp' });
    expect(r.ok).toBe(true);
    expect(r.held).toBeUndefined();
    expect(writes).toEqual(['reauth']);
  });

  it('applied canvases page by appliedOffset: read log_batch passes it through, and its result is marked untrusted (app)', async () => {
    const seen: Array<Parameters<ChatHost['logBatch']>[0]> = [];
    const batch = { available: true, events: 3, hours: 2, updates: 0, approveCount: 3, canvases: [], skipped: [], discrepancies: [], recordTypeKnown: true, ownerKnown: true, applied: { total: 25, offset: 10, items: [] }, appliedNextOffset: 20 };
    const { host, writes } = watchedHost(ds, { logBatch: async (i) => (seen.push(i), batch as never) });
    const { ctx, steps } = turn(host, 'show me the logging batch for Globex past the first ten');
    const r = await callChatTool(ctx, 'read', { route: 'log_batch', query: { appliedOffset: 10 } });
    expect(seen).toEqual([{ appliedOffset: 10 }]);
    expect(r.ok).toBe(true);
    expect(r.text.split('\n')[0]).toBe(untrustedHeader('app'));
    expect(JSON.parse(withoutUntrustedHeader(r.text))).toMatchObject({ appliedNextOffset: 20, note: expect.stringMatching(/nothing is staged/) });
    expect(stepsOf(steps, 'proposal')).toEqual([]);
    expect(writes).toEqual([]);
    // a string offset is not an offset: nothing is guessed
    await callChatTool(turn(host, 'past the first ten').ctx, 'read', { route: 'log_batch', query: { appliedOffset: '10' } });
    expect(seen[1]).toEqual({});
  });

  it('query and read results carry the untrusted marker, on the result and the tool row', async () => {
    const { host } = watchedHost(ds);
    for (const [tool, args] of [
      ['query', { view: 'work_items' }],
      ['read', { route: 'today' }],
    ] as const) {
      const { ctx, steps } = turn(host, 'what is on my list?');
      const r = await callChatTool(ctx, tool, args);
      expect(r.ok, tool).toBe(true);
      expect(r.text.split('\n')[0], tool).toBe(untrustedHeader('app'));
      expect(String(resultRow(steps).result).split('\n')[0], tool).toBe(untrustedHeader('app'));
    }
  });
});

