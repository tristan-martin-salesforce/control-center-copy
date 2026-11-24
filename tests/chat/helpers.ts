/**
 * BE-CHAT test helpers: a fast mock DataSource whose chat runner is the real Agent SDK runner over the
 * deterministic fake model (src/llm/chat/fake.ts), plus event collectors.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { ChatSseEvent, Seed, type ChatCard } from '@/contract';
import { createFakeChatQuery, type FakeChatOptions } from '@/llm/chat/fake';
import { createAgentSdkChatRunner, type ChatQueryFn, type ChatRunnerOptions } from '@/llm/chat/runner';
import { MockDataSource } from '@/server/datasource/mock';

export const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
export const fast = { enrichMs: 1e8, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };

export interface Seen {
  options?: Options;
  prompt?: string;
  calls: number;
}

/** The fake model, wrapped so a test can see the options and prompt the runner passed. */
export function spyQuery(fake: FakeChatOptions = {}, seen: Seen = { calls: 0 }): ChatQueryFn {
  const q = createFakeChatQuery(fake);
  return (p) => {
    seen.options = p.options;
    seen.prompt = p.prompt;
    seen.calls += 1;
    return q(p);
  };
}

export function mockWith(o: { fake?: FakeChatOptions; runner?: ChatRunnerOptions; seen?: Seen } = {}) {
  const runner = createAgentSdkChatRunner({ scanPollMs: 5, scanFollowMs: 400, ...o.runner, queryFn: spyQuery(o.fake, o.seen) });
  return new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed', chatRunner: runner });
}

export async function collect(it: AsyncIterable<ChatSseEvent>, o: { validate?: boolean; onEvent?: (e: ChatSseEvent) => void } = {}) {
  const out: ChatSseEvent[] = [];
  for await (const ev of it) {
    if (o.validate !== false) {
      const r = ChatSseEvent.safeParse(ev);
      if (!r.success) throw new Error(`invalid event ${JSON.stringify(ev).slice(0, 300)}: ${r.error.message}`);
    }
    out.push(ev);
    o.onEvent?.(ev);
  }
  return out;
}

export const of = <T extends ChatSseEvent['type']>(evs: ChatSseEvent[], t: T) => evs.filter((e): e is Extract<ChatSseEvent, { type: T }> => e.type === t);
export const textOf = (evs: ChatSseEvent[]) => of(evs, 'text-delta').map((e) => e.delta).join('');
export const cards = <K extends ChatCard['kind']>(evs: ChatSseEvent[], kind: K) =>
  of(evs, 'resource')
    .map((e) => e.card)
    .filter((c): c is Extract<ChatCard, { kind: K }> => c?.kind === kind);
