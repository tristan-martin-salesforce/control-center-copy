/**
 * Whether this Mac routes Claude through a company AI gateway (an `apiKeyHelper` or gateway env in
 * ~/.claude/settings.json; src/llm/claude-env.ts). It decides which sign-in an LLM auth failure asks for: devbar's
 * (the gateway's key) or Claude Code's own /login (CONN-6: a Claude sign-in failure must not say "sign in to devbar").
 * Reads key names only, never a value, at most once a minute.
 */
import { claudeGatewayConfig, type GatewayConfig } from '@/llm/claude-env';

const GATEWAY_ENV = /^ANTHROPIC_(BASE_URL|AUTH_TOKEN|API_KEY)$|^CLAUDE_CODE_USE_(BEDROCK|VERTEX)$/;

export function hasGateway(g: GatewayConfig): boolean {
  return !!g.apiKeyHelper || Object.keys(g.env).some((k) => GATEWAY_ENV.test(k));
}

let cache: { at: number; on: boolean } | null = null;

/** CC_LLM_GATEWAY=1|0 pins the answer (tests, or a machine whose gateway is set up some other way). */
export function gatewayConfigured(now = Date.now(), read: () => GatewayConfig = claudeGatewayConfig, env: Record<string, string | undefined> = process.env): boolean {
  if (env.CC_LLM_GATEWAY === '1') return true;
  if (env.CC_LLM_GATEWAY === '0') return false;
  if (cache && now - cache.at < 60_000) return cache.on;
  let on = false;
  try {
    on = hasGateway(read());
  } catch {
    on = false;
  }
  cache = { at: now, on };
  return on;
}

/** Tests: forget the cached answer. */
export function resetGatewayCache(): void {
  cache = null;
}
