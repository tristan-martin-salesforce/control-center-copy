/**
 * Test helpers for fetch-then-interpret: a fake `claude_relay` runtime (no model, no network) that answers the read
 * tools from recorded-shape fixtures, and an in-memory store with a profile. Placeholder data only.
 */
import { RuntimeCallError, type ConnectorRuntime, type RuntimeUsage } from '@/connectors/runtime/types';
import type { ClassifierModel } from '@/scanner/interpret';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import type { ConnectorId } from '@/scanner/types';

import { loadCorpus, slackSearch, type Corpus } from './runtime/helpers/slack-sim';

export const RELAY_USAGE: RuntimeUsage = { inputTokens: 300, outputTokens: 60, cacheReadTokens: 7_700, cacheWriteTokens: 0, turns: 1, prefixTokens: 8_000, model: 'claude-haiku-5-5' };
export const RELAY_USD = 0.00014;

export interface FakeRelay extends ConnectorRuntime {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

/** A relay runtime whose reads come from `answer`; a thrown `{ code }` becomes the relay's RuntimeCallError. */
export function fakeRelay(connector: ConnectorId, answer: (tool: string, args: Record<string, unknown>) => string): FakeRelay {
  const calls: FakeRelay['calls'] = [];
  return {
    kind: 'claude_relay',
    connector,
    readTools: [],
    calls,
    estimateUsd: () => RELAY_USD,
    async call(tool, args) {
      calls.push({ tool, args });
      let text: string;
      try {
        text = answer(tool, args);
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'unknown';
        throw new RuntimeCallError(connector, tool, code, `fake relay: ${code}`, { ...RELAY_USAGE }, { usd: RELAY_USD, estimated: false });
      }
      return { text, json: null, usage: { ...RELAY_USAGE }, cost: { usd: RELAY_USD, estimated: false } };
    },
  };
}

/** The search queries of scan-slack §2 as the corpus simulator understands them (filters / keywords → its `query`). */
export function corpusSearch(corpus: Corpus, args: Record<string, unknown>): string {
  const kw = Array.isArray(args.keywords) ? args.keywords.map(String) : [];
  const query = String(args.filters ?? kw.join(' ') ?? '').trim();
  const out = slackSearch(corpus, { query, channel_types: String(args.channel_types ?? ''), after: String(args.after ?? ''), before: String(args.before ?? ''), limit: Number(args.limit ?? 20), ...(args.cursor ? { cursor: String(args.cursor) } : {}) });
  return JSON.stringify(out);
}

/** A Slack relay over the placeholder corpus (tests/fixtures/scanner/slack/corpus.v1.json). */
export function corpusRelay(corpus: Corpus = loadCorpus()): FakeRelay {
  return fakeRelay('slack', (tool, args) => {
    if (tool === 'slack_search_public_and_private') return corpusSearch(corpus, args);
    if (tool === 'slack_read_thread') {
      const ts = String(args.message_ts);
      const ch = String(args.channel_id);
      const msgs = corpus.messages.filter((m) => m.channel === ch && (m.ts === ts || m.threadTs === ts)).sort((a, b) => Number(a.ts) - Number(b.ts));
      const line = (m: (typeof msgs)[number]) => `From: ${corpus.people[m.from]!.name} <${corpus.people[m.from]!.email}> (${m.from})\nTime: x\nMessage TS: ${m.ts}\n${m.text}\n`;
      const [parent, ...replies] = msgs;
      return JSON.stringify({ messages: `=== THREAD PARENT MESSAGE ===\n${parent ? line(parent) : ''}\n=== THREAD REPLIES (${replies.length} total) ===\n\n${replies.map((r, i) => `--- Reply ${i + 1} of ${replies.length} ---\n${line(r)}`).join('\n')}` });
    }
    throw Object.assign(new Error('not recorded'), { code: 'no_result' });
  });
}

export function corpusStore(corpus: Corpus = loadCorpus(), now = '2026-11-06T18:00:00.000Z'): InMemoryScannerStore {
  let t = Date.parse(now);
  const store = new InMemoryScannerStore({
    clock: { now: () => new Date(t) },
    profile: { me: { userId: 'u-fti', name: corpus.me.name, email: corpus.me.email, slackId: corpus.me.slackId }, watchList: [], aliases: { accounts: [{ accountId: 'acc-acme', names: ['ACME'] }], channels: [{ channelId: 'C0ACME001', accountId: 'acc-acme', label: '#acme-account' }] } },
  });
  (store as unknown as { __setNow: (iso: string) => void }).__setNow = (iso: string) => {
    t = Date.parse(iso);
  };
  return store;
}

/** A scripted classifier: asks for "?"/"can you" lines, promises for my "I'll"/"going to", my "Done" as a completion. */
export const scriptedClassifier: ClassifierModel = async (req) => {
  const verdicts = [...req.user.matchAll(/^### \[([^\]]+)\] ([^\n]*)\n(?:context:\n(?:- [^\n]*\n)*)?text: ([^\n]*)\n(?:files: [^\n]*\n)?candidates: ([^\n]*)/gm)].map(([, ref, header, text, cands]) => {
    const mine = /from me/.test(header!);
    const first = /^(w\d)\b/.exec(cands!)?.[1] ?? null;
    if (mine && /\b(i'?ll|going to)\b/i.test(text!)) return { ref, v: 'commitment', kind: 'commitment', title: `Do what I promised: ${text!.slice(0, 120)}`, conf: 0.8, cite: text!.slice(0, 80), link: null, why: 'my promise' };
    if (mine && /\bdone\b/i.test(text!)) return { ref, v: 'completion', conf: 0.9, link: first, why: 'my delivery' };
    if (!mine && /\?|can you/i.test(text!)) return { ref, v: 'ask', kind: 'ask', title: `Answer: ${text!.slice(0, 50)}`, conf: 0.9, cite: text!.slice(0, 80), link: null, why: 'a question to me' };
    return { ref, v: 'fyi', conf: 0.8, link: null, why: 'status' };
  });
  return { ok: true, text: JSON.stringify({ verdicts }), costUsd: 0.0004, inputTokens: 900, outputTokens: 120, cacheReadTokens: 2_400, cacheWriteTokens: 0 };
};

export { loadCorpus, type Corpus };
