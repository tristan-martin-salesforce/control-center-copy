import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ChatSseEvent, Seed } from '@/contract';
import { MockDataSource } from '@/server/datasource/mock';
import type { ChatOps } from '@/server/datasource/mock/chat-runtime';

export const ROOT = path.resolve(__dirname, '../..');
export const EXAMPLE_SEED_PATH = path.join(ROOT, 'src/mock/seed.example.json');
export const rawExampleSeed = (): unknown => JSON.parse(readFileSync(EXAMPLE_SEED_PATH, 'utf8'));
export const seed = Seed.parse(rawExampleSeed());
export const fast = { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 };

export function newDs(): MockDataSource {
  return new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
}

/** The ops a chat script gets (private on the mock; bracket access is deliberate in tests). */
export function opsOf(ds: MockDataSource): ChatOps {
  return (ds as unknown as { chatOps(): ChatOps }).chatOps();
}

export async function ask(ds: MockDataSource, text: string, extra: { threadId?: string; model?: 'sonnet' | 'opus'; context?: { type: string; id: string; label: string }[] } = {}) {
  const events: ChatSseEvent[] = [];
  for await (const ev of ds.chat({ body: { text, context: extra.context ?? [], threadId: extra.threadId, model: extra.model }, signal: new AbortController().signal })) {
    const r = ChatSseEvent.safeParse(ev);
    if (!r.success) throw new Error(`invalid event ${JSON.stringify(ev)}`);
    events.push(ev);
  }
  return events;
}

export const of = <T extends ChatSseEvent['type']>(evs: ChatSseEvent[], t: T) => evs.filter((e): e is Extract<ChatSseEvent, { type: T }> => e.type === t);
