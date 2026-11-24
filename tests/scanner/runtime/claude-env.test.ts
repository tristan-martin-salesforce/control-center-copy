import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnv, claudeGatewayConfig, gatewayQueryOptions, scannerEnv } from '../../../src/llm/claude-env';

const parent = {
  HOME: '/Users/someone',
  USER: 'someone',
  PATH: '/usr/bin',
  ANTHROPIC_BASE_URL: 'http://parent-host-session',
  CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
  CLAUDE_PID: '123',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'desktop',
  NODE_ENV: 'development',
} as unknown as NodeJS.ProcessEnv;

describe('claude-env (shared child-process env)', () => {
  it('reads the gateway env and apiKeyHelper from the settings file without executing anything', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-env-'));
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ apiKeyHelper: 'example-helper --print', env: { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid', CLAUDE_CODE_USE_BEDROCK: '1', N: 3 } }));
    expect(claudeGatewayConfig(file)).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid', CLAUDE_CODE_USE_BEDROCK: '1' }, apiKeyHelper: 'example-helper --print' });
    expect(claudeGatewayConfig(path.join(dir, 'missing.json'))).toEqual({ env: {} });
  });

  it('childEnv strips host-session and parent-auth vars, then applies the gateway env', () => {
    const env = childEnv({ ANTHROPIC_BASE_URL: 'https://gateway.example.invalid', CLAUDE_CODE_USE_BEDROCK: '1' }, parent);
    expect(env).toMatchObject({ HOME: '/Users/someone', NODE_ENV: 'development', ANTHROPIC_BASE_URL: 'https://gateway.example.invalid', CLAUDE_CODE_USE_BEDROCK: '1' });
    for (const k of ['CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_PID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) expect(env[k]).toBeUndefined();
    expect(childEnv({}, parent).ANTHROPIC_BASE_URL).toBeUndefined(); // the parent's base URL never leaks
  });

  it('scannerEnv is an allowlist plus the gateway env; query options carry the helper', () => {
    const env = scannerEnv({ ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' }, parent);
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_BASE_URL', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'HOME', 'PATH', 'USER']);
    expect(env.PATH).toContain('/Users/someone/.local/bin');
    const o = gatewayQueryOptions({ env: {}, apiKeyHelper: 'example-helper' });
    expect(o.settings).toEqual({ apiKeyHelper: 'example-helper' });
  });
});
