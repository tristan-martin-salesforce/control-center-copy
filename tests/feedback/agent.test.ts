/**
 * D-56 · the diagnose agent is read-only and stays inside the repo: Read / Grep / Glob only (no shell, no write), its
 * paths gated to the repo folder and away from private and secret folders, and any other tool aborts the run.
 * The SDK is never called: a scripted query drives the hooks and the in-process tools.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { assertReadOnly } from '../../src/llm/mcp-config';
import {
  CODE_TOOLS,
  checkCodeAccess,
  DENIED_BUILTINS,
  FEEDBACK_ALLOWED_TOOLS,
  FEEDBACK_SERVER,
  feedbackAgentOptions,
  SdkFeedbackAgent,
  type FeedbackQueryFn,
  type FeedbackRunInput,
} from '../../src/server/feedback/agent';
import type { FeedbackReads } from '../../src/server/feedback/reads';

const ROOT = path.resolve(__dirname, '../..');

const reads: FeedbackReads = {
  eventLog: async () => [{ level: 'error', source: 'slack', code: 'parse_drift', message: 'CUSTOMER_1 channel parse failed' }],
  jobs: async () => ({ counts: {}, failing: [] }),
  health: async () => ({ connectors: [] }),
  scans: async () => [],
  trace: async () => null,
  page: async () => ({ read: 'getTime', payload: {} }),
  entity: async () => null,
};

const input = (over: Partial<FeedbackRunInput> = {}): FeedbackRunInput => ({
  runId: 'fb_test',
  systemPrompt: ['skill', 'BOUNDARY', 'run'],
  prompt: 'The Time page is empty',
  reads,
  repoRoot: ROOT,
  costCapUsd: 0.4,
  signal: new AbortController().signal,
  ...over,
});

const pre = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's', transcript_path: '', cwd: ROOT, tool_use_id: 't' }) as never;
const result = (over: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.02, num_turns: 3, modelUsage: {}, permission_denials: [], ...over }) as unknown as SDKMessage;

describe('the allowlist', () => {
  it('is Read, Grep, Glob and the cc_feedback read tools plus feedback_finish: nothing that writes', () => {
    expect([...CODE_TOOLS]).toEqual(['Read', 'Grep', 'Glob']);
    expect(FEEDBACK_ALLOWED_TOOLS).toEqual([
      'Read',
      'Grep',
      'Glob',
      'mcp__cc_feedback__feedback_event_log',
      'mcp__cc_feedback__feedback_jobs',
      'mcp__cc_feedback__feedback_health',
      'mcp__cc_feedback__feedback_scans',
      'mcp__cc_feedback__feedback_trace',
      'mcp__cc_feedback__feedback_page',
      'mcp__cc_feedback__feedback_entity',
      'mcp__cc_feedback__feedback_finish',
    ]);
    expect(() => assertReadOnly(FEEDBACK_ALLOWED_TOOLS)).not.toThrow();
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']) expect(FEEDBACK_ALLOWED_TOOLS).not.toContain(t);
  });

  it('the SDK options load only those built-ins and only the in-process server, in the repo folder', () => {
    const o = feedbackAgentOptions({
      model: 'm',
      systemPrompt: ['x'],
      repoRoot: ROOT,
      server: { type: 'sdk', name: FEEDBACK_SERVER, instance: {} } as never,
      maxTurns: 14,
      costCapUsd: 0.4,
      canUseTool: async () => ({ behavior: 'deny', message: 'x' }),
      preToolUse: async () => ({}),
      gateway: { env: {} },
      executable: '/bin/false',
      abortController: new AbortController(),
    });
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['cc_feedback']);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch']));
    expect(o.disallowedTools).toEqual([...DENIED_BUILTINS]);
    expect(o.cwd).toBe(ROOT);
    expect(o.additionalDirectories).toEqual([]);
    expect(o.maxBudgetUsd).toBe(0.4);
    expect(o.permissionMode).toBe('default');
    expect(o.allowedTools).toBeUndefined();
  });
});

describe('the repo path gate', () => {
  it('allows code under the allowed roots and pins it to an absolute path inside the repo', () => {
    const r = checkCodeAccess(ROOT, 'Read', { file_path: 'src/outbox/transport.ts' });
    expect(r).toEqual({ ok: true, input: { file_path: path.join(fs.realpathSync(ROOT), 'src/outbox/transport.ts') } });
    const g = checkCodeAccess(ROOT, 'Grep', { pattern: 'feedbackRelay' });
    expect(g.ok && g.input.path).toBe(path.join(fs.realpathSync(ROOT), 'src'));
    expect(checkCodeAccess(ROOT, 'Glob', { pattern: '**/*.ts', path: 'docs/ui' }).ok).toBe(true);
    expect(checkCodeAccess(ROOT, 'Read', { file_path: 'package.json' }).ok).toBe(true);
  });

  it('refuses everything outside the repo, private and secret folders, and searches that would walk through them', () => {
    const no = (tool: string, inp: Record<string, unknown>) => {
      const r = checkCodeAccess(ROOT, tool, inp);
      return r.ok ? 'allowed' : r.reason;
    };
    expect(no('Read', { file_path: '/etc/hosts' })).toBe('outside the repo folder');
    expect(no('Read', { file_path: '../../../.ssh/id_rsa' })).toBe('outside the repo folder');
    expect(no('Read', { file_path: path.join(os.homedir(), '.claude.json') })).toBe('outside the repo folder');
    expect(no('Read', { file_path: '.env.local' })).toBe('secret files are never read');
    expect(no('Read', { file_path: 'docs/research/notes.md' })).toBe('private or generated folder');
    expect(no('Read', { file_path: 'tools/activity-autopilot/run.ts' })).toBe('private or generated folder');
    expect(no('Read', { file_path: '.git/config' })).toBe('private or generated folder');
    // node_modules is refused either way: a real folder by the deny list, a symlink out of the tree (agent worktrees
    // link the main checkout's) because it resolves outside the repo. Which reason depends on this checkout.
    const nmInside = !path.relative(fs.realpathSync(ROOT), fs.realpathSync(path.join(ROOT, 'node_modules'))).startsWith('..');
    expect(no('Read', { file_path: 'node_modules/zod/package.json' })).toBe(nmInside ? 'private or generated folder' : 'outside the repo folder');
    expect(no('Grep', { pattern: 'x', path: '.' })).toMatch(/search or read under/);
    expect(no('Grep', { pattern: 'x', path: 'docs' })).toMatch(/holds private folders/);
    expect(no('Grep', { pattern: 'x', path: 'src', glob: '../**' })).toMatch(/may not climb/);
    expect(no('Glob', { pattern: '../../**/*', path: 'src' })).toMatch(/relative to the folder/);
    expect(no('Bash', { command: 'ls' })).toMatch(/not a code-reading tool/);
    expect(no('Write', { file_path: 'src/x.ts' })).toMatch(/not a code-reading tool/);
  });

  it('a real node_modules folder inside the repo is refused as private or generated (whatever this checkout has)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-repo-'));
    fs.mkdirSync(path.join(repo, 'node_modules', 'zod'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'zod', 'package.json'), '{}');
    expect(checkCodeAccess(repo, 'Read', { file_path: 'node_modules/zod/package.json' })).toEqual({ ok: false, reason: 'private or generated folder' });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('follows symlinks: a link inside the repo that points outside is refused', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-repo-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-out-'));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'src', 'link.txt'));
    expect(checkCodeAccess(repo, 'Read', { file_path: 'src/link.txt' })).toEqual({ ok: false, reason: 'outside the repo folder' });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('the run', () => {
  it('the PreToolUse hook gates paths, and a shell call aborts the run', async () => {
    const seen: Array<{ tool: string; out: unknown }> = [];
    const q: FeedbackQueryFn = ({ options }) =>
      (async function* () {
        const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
        const sig = { signal: new AbortController().signal };
        seen.push({ tool: 'Read ok', out: await hook(pre('Read', { file_path: 'src/outbox/transport.ts' }), 't1', sig) });
        seen.push({ tool: 'Read out', out: await hook(pre('Read', { file_path: '/etc/hosts' }), 't2', sig) });
        seen.push({ tool: 'Bash', out: await hook(pre('Bash', { command: 'cat .env' }), 't3', sig) });
        yield { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Bash' }], usage: { input_tokens: 100, output_tokens: 10 } } } as unknown as SDKMessage;
        yield result();
      })();
    const r = await new SdkFeedbackAgent({ queryFn: q }).run(input());
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'disallowed_tool', disallowedTool: 'Bash' });
    expect(seen[0]!.out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { file_path: path.join(fs.realpathSync(ROOT), 'src/outbox/transport.ts') } } });
    expect(seen[1]!.out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'outside the repo folder' } });
    expect(seen[2]!.out).toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('reads the app state through its own tools and finishes with a checked report', async () => {
    const q: FeedbackQueryFn = ({ handlers }) =>
      (async function* () {
        const log = await handlers.feedback_event_log({});
        expect(log.text).toContain('parse_drift');
        const bad = await handlers.feedback_finish({ title: 'Time empty', summary: 'The Time page is empty for CUSTOMER_1.', steps: ['Open Time'], expected: 'Rows', actual: 'None', diagnosis: { cause: 'x', files: ['src/nope/missing.ts'], confidence: 'low' } });
        expect(bad.isError).toBe(true);
        const ok = await handlers.feedback_finish({ title: 'Time empty', summary: 'The Time page is empty for CUSTOMER_1.', steps: ['Open Time'], expected: 'Rows', actual: 'None', diagnosis: { cause: 'buildTime drops rows', files: ['src/components/time/TimePage.tsx'], confidence: 'medium' } });
        expect(ok.isError).toBeUndefined();
        yield result();
      })();
    const r = await new SdkFeedbackAgent({ queryFn: q }).run(input());
    expect(r.ok).toBe(true);
    expect(r.output?.diagnosis.files).toEqual(['src/components/time/TimePage.tsx']);
    expect(r.costUsd).toBe(0.02);
  });

  it('stops at the cost cap', async () => {
    const q: FeedbackQueryFn = () =>
      (async function* () {
        yield { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 2_000_000, output_tokens: 10 } } } as unknown as SDKMessage;
        yield result();
      })();
    const r = await new SdkFeedbackAgent({ queryFn: q }).run(input({ costCapUsd: 0.05 }));
    expect(r.error?.code).toBe('cost_cap');
  });
});
