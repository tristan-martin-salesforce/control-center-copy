/**
 * afd360-estimator adapter (cli). Runs the deterministic engine's `export` with an explicit
 * `--out` inside a Command Center run folder. Without --out the CLI writes an `exports/` folder
 * next to the estimate (verified read-only against the CLI source), so --out is mandatory here.
 *
 * argv comes from the manifest and is passed to spawn() as an array (no shell).
 */
import { spawn } from 'node:child_process';
import { access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { inStateDir } from '@/lib/state-folder';
import type { ToolManifest } from '../manifest';
import { BaseAdapter, ToolError, abortError, expandHome, nowIso, render, type HealthResult, type RunCtx, type ToolResult } from './base';

export function defaultRunsRoot(): string {
  return inStateDir('tool-runs');
}

export class Afd360EstimatorAdapter extends BaseAdapter {
  constructor(manifest: ToolManifest, private readonly runsRoot: string = defaultRunsRoot()) {
    super(manifest);
    if (manifest.launch.kind !== 'cli') throw new Error('afd360-estimator adapter needs a cli manifest');
  }

  private get launch() {
    return this.manifest.launch as Extract<ToolManifest['launch'], { kind: 'cli' }>;
  }

  protected get startCommand() {
    return undefined; // a CLI has nothing to start
  }

  override async health(): Promise<HealthResult> {
    const h = this.manifest.health;
    const checkedAt = nowIso();
    if (h.type !== 'file') return { ok: true, state: 'up', detail: 'no file health check', checkedAt };
    try {
      await access(expandHome(h.path));
      return { ok: true, state: 'up', detail: `${h.path} present`, checkedAt };
    } catch {
      return { ok: false, state: 'down', detail: `${h.path} missing (skill not installed)`, checkedAt };
    }
  }

  private argv(input: Record<string, unknown>, runDir: string): string[] {
    const tpl = { estimatePath: expandHome(String(input.estimatePath)), format: String(input.format), runDir };
    const argv = this.launch.argv.map((a) => render(a, tpl));
    if (input.model) argv.push('--model', String(input.model));
    return argv;
  }

  protected plan(input: Record<string, unknown>): string[] {
    return [`(cd ${this.launch.cwd}) ${this.argv(input, '<runDir>').join(' ')}`];
  }

  protected async execute(input: Record<string, unknown>, ctx: RunCtx): Promise<ToolResult> {
    const est = expandHome(String(input.estimatePath));
    try {
      if (!(await stat(est)).isFile()) throw new Error('not a file');
    } catch {
      throw new ToolError('bad_input', `estimate not found: ${est}`, 'estimate_missing');
    }
    const cwd = expandHome(this.launch.cwd);
    try { await access(cwd); } catch { throw new ToolError('not_running', `estimator skill not found at ${cwd}`, 'skill_missing'); }

    const runDir = ctx.runDir ?? path.join(this.runsRoot, `${this.manifest.id}-${Date.now()}`);
    await mkdir(runDir, { recursive: true });
    const [cmd, ...args] = this.argv(input, runDir) as [string, ...string[]];
    ctx.emit(`running ${cmd} ${args.slice(0, 3).join(' ')} ...`, 5);

    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
      const onAbort = () => child.kill('SIGTERM');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e: NodeJS.ErrnoException) => {
        ctx.signal.removeEventListener('abort', onAbort);
        reject(e.code === 'ENOENT' ? new ToolError('not_running', `cannot run ${cmd}: not installed`, 'cmd_missing') : new ToolError('failed', e.message, 'spawn'));
      });
      child.on('close', (c) => {
        ctx.signal.removeEventListener('abort', onAbort);
        if (ctx.signal.aborted) reject(abortError(ctx.signal)); else resolve({ code: c, stderr: err });
      });
    });
    if (code !== 0) {
      throw new ToolError('failed', `estimator exited ${code}: ${stderr.trim().slice(-300) || 'no stderr'}`, 'nonzero_exit');
    }
    ctx.emit('export complete', 100);
    const tpl = { runDir, format: String(input.format) };
    return {
      links: [],
      artifacts: this.manifest.output.artifacts.map((a) => ({ path: expandHome(render(a.pathTemplate, tpl)), label: a.label, mime: a.mime })),
      summary: `Estimate exported as ${String(input.format)} to ${runDir}.`,
    };
  }
}
