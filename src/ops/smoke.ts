/**
 * The Claude "Check again" (11 R6/R7, PKG-6): ONE `claude -p "reply OK" --max-turns 1 --model <haiku>`, run only when
 * the user clicks (POST /api/v1/doctor/claude-smoke), never on a schedule, with its cost shown before (about $0.001)
 * and after. It proves what `claude --version` can't: the sign-in, the plan, the model access.
 *
 * It refuses, with nothing run, when no company AI gateway is configured (no apiKeyHelper or gateway env in
 * ~/.claude/settings.json: AUTH.LLM.NO_GATEWAY): the run would bill an account Command Center was not set up for.
 * The result (status, code, cost; never the reply or an error's text) is kept in the state folder for Health ▸ Setup.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ClaudeSmokeResult } from '../contract/health';
import { classifyCode } from '../errors/classify';
import { gatewayConfigured } from '../errors/gateway';
import { render } from '../errors/render';
import { claudeGatewayConfig, scannerEnv } from '../llm/claude-env';
import { SCANNER_MODEL } from '../llm/models';
import { resolveClaudeBin } from './claude-bin';
import { run, type ExecFn } from './exec';
import { stateDir } from './paths';

type Env = Record<string, string | undefined>;

/** A one-word reply on Haiku: about 20 tokens out and a small system prompt in. */
export const SMOKE_ESTIMATE_USD = 0.001;
export const smokePath = (env: Env = process.env) => join(stateDir(env), 'claude-smoke.json');

export type StoredSmoke = Pick<ClaudeSmokeResult, 'status' | 'code' | 'costUsd' | 'checkedAt'>;

export function readSmoke(env: Env = process.env): StoredSmoke | null {
  try {
    const s = JSON.parse(readFileSync(smokePath(env), 'utf8')) as StoredSmoke;
    return s && typeof s.status === 'string' && typeof s.checkedAt === 'string' ? s : null;
  } catch {
    return null;
  }
}

function store(s: StoredSmoke, env: Env): void {
  try {
    const f = smokePath(env);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(`${f}.tmp`, JSON.stringify(s));
    renameSync(`${f}.tmp`, f);
  } catch {
    /* best effort */
  }
}

export interface SmokeDeps {
  exec?: ExecFn;
  env?: Env;
  now?: () => Date;
  claudeBin?: string;
  /** Default: the gateway config in ~/.claude/settings.json (src/errors/gateway.ts). */
  gateway?: boolean;
}

export async function runClaudeSmoke(deps: SmokeDeps = {}): Promise<ClaudeSmokeResult> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const base = { estimateUsd: SMOKE_ESTIMATE_USD, model: SCANNER_MODEL, checkedAt: now };
  if (!(deps.gateway ?? gatewayConfigured())) {
    const r = render('AUTH.LLM.NO_GATEWAY');
    const out: ClaudeSmokeResult = { ...base, status: 'refused', code: r.code, message: r.text, nextStep: r.nextStep, costUsd: null };
    store(out, env);
    return out;
  }
  const gw = claudeGatewayConfig();
  const args = ['-p', 'reply OK', '--max-turns', '1', '--model', SCANNER_MODEL, '--output-format', 'json', ...(gw.apiKeyHelper ? ['--settings', JSON.stringify({ apiKeyHelper: gw.apiKeyHelper })] : [])];
  const r = await (deps.exec ?? run)(deps.claudeBin ?? resolveClaudeBin({ env }), args, { timeoutMs: 60_000, env: scannerEnv(gw.env) as NodeJS.ProcessEnv });
  type CliJson = { is_error?: boolean; result?: string; total_cost_usd?: number };
  let parsed: CliJson | null;
  try {
    parsed = JSON.parse(r.stdout) as CliJson;
  } catch {
    parsed = null;
  }
  const cost = typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
  if (r.code === 0 && parsed && !parsed.is_error && /\bok\b/i.test(String(parsed.result ?? ''))) {
    const out: ClaudeSmokeResult = { ...base, status: 'ok', code: null, message: 'Claude answered.', nextStep: null, costUsd: cost };
    store(out, env);
    return out;
  }
  // the code from the error's text; the text itself never leaves here
  const text = r.spawnError ? `spawn claude ${r.spawnError}` : r.timedOut ? 'timed out' : `${parsed?.result ?? ''} ${r.stderr}`;
  const code = classifyCode('llm', text, { gatewayConfigured: true }).code;
  const e = render(code);
  const out: ClaudeSmokeResult = { ...base, status: 'failed', code: e.code, message: `${e.title}. ${e.text}`, nextStep: e.nextStep, costUsd: cost };
  store(out, env);
  return out;
}

/** Mock mode: the button works, nothing runs. */
export function simulatedSmoke(now: Date): ClaudeSmokeResult {
  return { status: 'simulated', code: null, message: 'Mock mode: nothing was run. On a real install this asks Claude for one word.', nextStep: null, estimateUsd: SMOKE_ESTIMATE_USD, costUsd: null, model: SCANNER_MODEL, checkedAt: now.toISOString() };
}
