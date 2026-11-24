/**
 * The Assistant evals' fakes: the mock DataSource (the fake DataSource: placeholder seed, in memory) under the real
 * chat host and the real `callChatTool`, a host whose write methods are watched, and a tool context per user turn.
 * No model and no network: where a turn runs end to end, the model is the deterministic fake (src/llm/chat/fake.ts).
 */
import type { ContextRef } from '@/contract';
import { routeTurn } from '@/llm/chat/router';
import { actTargetNamed, newToolState, type ChatToolCtx } from '@/llm/chat/tools';
import type { ChatHost, ChatRunStep } from '@/llm/chat/types';
import { createChatHost } from '@/server/chat/host';
import type { MockDataSource } from '@/server/datasource/mock';

/** The host methods that change something (in the app; none of them reaches an external system). */
export const WRITES = ['stageChanges', 'applyStaged', 'createDraft', 'draftVdpUpdate', 'stageLogBatch', 'rescan', 'prepareSession', 'reauth', 'startJob', 'findVdpAssets', 'research'] as const;

/**
 * The real chat host over the mock DataSource, with Apply wired (act's allow class) and every write method counted.
 * `over` replaces reads (an injected Slack result, a ledger hit).
 */
export function watchedHost(ds: MockDataSource, over: Partial<ChatHost> = {}): { host: ChatHost; writes: string[]; applied: string[] } {
  const writes: string[] = [];
  const applied: string[] = [];
  const base = createChatHost(ds, { ...ds.be6.backend(), applyStaged: async (pid, d) => (applied.push(pid), (await ds.be6.apply(pid, d))?.receipt ?? null) }, () => ds.now());
  const merged = { ...base, ...over } as ChatHost;
  const host = new Proxy(merged, {
    get(t, k) {
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      if (typeof k === 'string' && (WRITES as readonly string[]).includes(k) && typeof v === 'function') {
        return (...a: unknown[]) => {
          writes.push(k);
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return v;
    },
  });
  return { host, writes, applied };
}

/** One user turn's tool context: the router's reading of `text`, the message's context chips, the emitted steps. */
export function turn(host: ChatHost, text: string, over: Partial<ChatToolCtx> & { context?: ContextRef[] } = {}) {
  const steps: ChatRunStep[] = [];
  const { context = [], ...rest } = over;
  const ctx: ChatToolCtx = {
    host,
    input: { threadId: 't-evals', messageId: 'm-evals', userMessageId: 'u-evals', text, context, model: 'haiku', signal: new AbortController().signal },
    emit: (s) => void steps.push(s),
    state: newToolState(),
    signal: new AbortController().signal,
    route: routeTurn({ text }),
    ...rest,
  };
  return { ctx, steps };
}

export const stepsOf = <T extends ChatRunStep['type']>(steps: ChatRunStep[], t: T) => steps.filter((s): s is Extract<ChatRunStep, { type: T }> => s.type === t);

/** Two open items of the placeholder seed whose titles do not name each other. */
export async function twoOpenItems(ds: MockDataSource) {
  const items = (await ds.listItems({ query: { tab: 'all_open' } } as never)).items;
  const a = items[0]!;
  const b = items.find((x) => x.id !== a.id && !actTargetNamed({ text: a.title }, x.id, x.title) && !actTargetNamed({ text: x.title }, a.id, a.title))!;
  return [a, b] as const;
}
