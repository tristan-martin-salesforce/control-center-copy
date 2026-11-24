/**
 * Which chat runner answers (BE-CHAT):
 *   CC_CHAT_LLM=1 → the Agent SDK runner (Sonnet by default; the thread's model choice). In mock mode it answers over
 *                   the mock's data only: the host has no live reads (no Slack, Org62 or Google), so nothing but the
 *                   model call leaves the machine (D-58: end-to-end checks of the general tools on placeholder data).
 *   otherwise     → the same runner over the deterministic fake model (no LLM, no cost)
 * Without CC_CHAT_LLM the mock uses the fake for the BE-CHAT intents and keeps its scripted demos for the rest.
 */
import { createAgentSdkChatRunner, type ChatRunnerOptions } from '@/llm/chat/runner';
import { createFakeChatQuery, type FakeChatOptions } from '@/llm/chat/fake';
import type { ChatTurnRunner } from '@/llm/chat/types';

export const chatLlmEnabled = (env: NodeJS.ProcessEnv = process.env) => env.CC_CHAT_LLM === '1';

export function chatRunnerFor(kind: 'mock' | 'db', o: { runner?: ChatRunnerOptions; fake?: FakeChatOptions; env?: NodeJS.ProcessEnv } = {}): ChatTurnRunner {
  if (chatLlmEnabled(o.env)) return createAgentSdkChatRunner({ ...o.runner });
  // Dev knob (mock checks of the spend ask): the fake reports this many input tokens per model message, so a small
  // per-message budget in Settings is passed after a step or two. Default: the fake's tiny usage.
  const fakeTokens = Number((o.env ?? process.env).CC_CHAT_FAKE_INPUT_TOKENS);
  const fake = !o.fake?.usage && fakeTokens > 0 ? { ...o.fake, usage: { input_tokens: fakeTokens, output_tokens: Math.round(fakeTokens / 10) } } : o.fake;
  return createAgentSdkChatRunner({ scanPollMs: 300, scanFollowMs: 5000, ...o.runner, queryFn: o.runner?.queryFn ?? createFakeChatQuery(fake) });
}

/**
 * Mock routing: the BE-CHAT intents go to the fake runner (proposal → Apply → receipt, scans, drafts,
 * sessions); every other prompt keeps its scripted demo (src/mock/chat-script.ts).
 */
export function mockWantsRunner(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const t = text.trim().toLowerCase();
  if (t.startsWith('/')) return false;
  // The real model answers everything (CC_CHAT_LLM=1); the scripted demos are for the fake.
  if (chatLlmEnabled(env)) return true;
  return (
    /\bsnooze\b/.test(t) ||
    // Assistant v2: memory (`remember`)
    /^remember\b|\bremember that\b/.test(t) ||
    /\breopen\b/.test(t) ||
    /\b(mark|set)\b.*\bdone\b/.test(t) ||
    /\bpin\b|\bto the top\b/.test(t) ||
    /\bdraft\b/.test(t) ||
    /\b(claude )?session\b|\bclaude code\b/.test(t) ||
    /\btop (3|three)\b/.test(t) ||
    // "Have I done anything for X?" researches live (run research).
    /\bhave i (ever )?(done|worked|met)\b|\b(dig|research|look back)\b|\bin the past\b/.test(t) ||
    // Time-logging questions read the Time page (read time); "log my last meeting" stays the scripted demo.
    (/\b(logged|logging|timesheet)\b|\bto log\b/.test(t) && !/\blog (my |the )?(last|previous) meeting\b/.test(t)) ||
    (/\b(re-?scan|scan)\b/.test(t) && /\b\d+\s*(h|hrs?|hours?|d|days?)\b/.test(t)) ||
    // VDP: use cases, assets, what's missing, "go back and find everything" (read vdp_detail, run vdp_find_assets).
    /\bvdp\b|\buse cases?\b|\bassets?\b|\bgo back\b|\bbackfill\b|\bfind everything\b|\blook through\b/.test(t)
  );
}
