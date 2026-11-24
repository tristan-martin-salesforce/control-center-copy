/**
 * talk-track adapter (http + NDJSON). Local Express app on :4320.
 *
 * Sequence (brief 10 §3.2): create track -> upload the context bundle as a generated .md
 * reference (plus any extra files) -> optional presenter meta -> generate -> follow the NDJSON stream.
 *
 * Mutations are limited to the tool's own talk-tracks/ store. The tool shells out to the local
 * `claude` CLI (LLM); it makes no Slack/Drive/Org62 calls. Cancel stops following the stream;
 * the tool's job is resumable and keeps running, which the summary says explicitly.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolManifest } from '../manifest';
import { BaseAdapter, ToolError, expandHome, readNdjson, render, toolFetch, type RunCtx, type ToolResult } from './base';

const ALLOWED_EXT = new Set(['.txt', '.md', '.pdf']);
const MAX_REF_BYTES = 25 * 1024 * 1024;

export class TalkTrackAdapter extends BaseAdapter {
  constructor(manifest: ToolManifest) {
    super(manifest);
    if (manifest.launch.kind !== 'http') throw new Error('talk-track adapter needs an http manifest');
  }

  private get base(): string {
    return (this.manifest.launch as { baseUrl: string }).baseUrl.replace(/\/$/, '');
  }

  protected plan(input: Record<string, unknown>): string[] {
    const steps = [
      `POST ${this.base}/api/talk-tracks {name, customer}`,
      `POST ${this.base}/api/talk-tracks/<id>/references (context bundle, ${String(input.context ?? '').length} chars, as command-center-context.md)`,
    ];
    const refs = ([] as unknown[]).concat(input.references ?? []);
    if (refs.length) steps.push(`  + ${refs.length} extra reference file(s)`);
    if (input.presenterContext) steps.push(`PUT ${this.base}/api/talk-tracks/<id>/meta {presenterContext}`);
    steps.push(`POST ${this.base}/api/talk-tracks/<id>/generate`, `GET ${this.base}/api/talk-tracks/<id>/jobs/<jobId>/stream (NDJSON)`);
    return steps;
  }

  private async loadReferences(paths: string[]): Promise<{ name: string; data: Buffer }[]> {
    const out: { name: string; data: Buffer }[] = [];
    for (const raw of paths) {
      const p = expandHome(raw);
      const ext = path.extname(p).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) throw new ToolError('bad_input', `reference ${path.basename(p)}: only .txt .md .pdf are supported`, 'bad_reference_type');
      let st;
      try { st = await stat(p); } catch { throw new ToolError('bad_input', `reference not found: ${p}`, 'reference_missing'); }
      if (!st.isFile() || st.size > MAX_REF_BYTES) throw new ToolError('bad_input', `reference ${path.basename(p)} is not a file under 25 MB`, 'bad_reference');
      out.push({ name: path.basename(p), data: await readFile(p) });
    }
    return out;
  }

  protected async execute(input: Record<string, unknown>, ctx: RunCtx): Promise<ToolResult> {
    const http = { fetch: ctx.fetch, signal: ctx.signal, startCommand: this.startCommand };
    const json = { 'content-type': 'application/json' };
    const refs = await this.loadReferences(([] as unknown[]).concat(input.references ?? []).map(String));

    ctx.emit('creating talk track', 2);
    const created = await (await toolFetch(http, `${this.base}/api/talk-tracks`, { method: 'POST', headers: json, body: JSON.stringify({ name: input.name, customer: input.customer }) })).json() as { id?: string };
    const trackId = created.id;
    if (!trackId) throw new ToolError('failed', 'talk-track did not return a track id', 'bad_response');
    const tBase = `${this.base}/api/talk-tracks/${encodeURIComponent(trackId)}`;

    ctx.emit('uploading context bundle', 4);
    const form = new FormData();
    form.append('files', new Blob([String(input.context)], { type: 'text/markdown' }), 'command-center-context.md');
    for (const r of refs) form.append('files', new Blob([new Uint8Array(r.data)]), r.name);
    await toolFetch(http, `${tBase}/references`, { method: 'POST', body: form });

    if (input.presenterContext) {
      await toolFetch(http, `${tBase}/meta`, { method: 'PUT', headers: json, body: JSON.stringify({ presenterContext: input.presenterContext }) });
    }

    ctx.emit('starting generation', 5);
    const gen = await (await toolFetch(http, `${tBase}/generate`, { method: 'POST', headers: json, body: '{}' })).json() as { jobId?: string };
    if (!gen.jobId) throw new ToolError('failed', 'talk-track did not return a job id', 'bad_response');

    const streamPath = render(this.manifest.progress.path ?? '/api/talk-tracks/{{trackId}}/jobs/{{jobId}}/stream', { trackId: encodeURIComponent(trackId), jobId: encodeURIComponent(gen.jobId) });
    const res = await toolFetch(http, `${this.base}${streamPath}`);

    let total = 0;
    let done = 0;
    let failedSegments = 0;
    let finished = false;
    const pct = () => (total ? 5 + (90 * done) / total : 5);

    try {
      for await (const ev of readNdjson(res, ctx.signal)) {
        switch (ev.type) {
          case 'status': ctx.emit(String(ev.message ?? 'working'), pct()); break;
          case 'outline': total = Array.isArray(ev.outline) ? ev.outline.length : total; ctx.emit(`outline ready: ${total} segments`, pct()); break;
          case 'progress': total = Number(ev.total ?? total); done = Number(ev.done ?? done); ctx.emit(`${done}/${total} segments`, pct()); break;
          case 'fill-start': ctx.emit(`writing segment ${Number(ev.index) + 1}${ev.title ? `: ${String(ev.title)}` : ''}`, pct()); break;
          case 'fill-done': done += 1; ctx.emit(`segment ${Number(ev.index) + 1}/${total || '?'} done`, pct()); break;
          case 'fill-failed': failedSegments += 1; ctx.emit(`segment ${Number(ev.index) + 1} failed: ${String(ev.error ?? 'unknown')}`, pct()); break;
          case 'result': finished = true; ctx.emit('talk track ready', 100); break;
          case 'error': throw new ToolError('failed', `talk-track generation failed: ${String(ev.error ?? 'unknown error')} (the job is resumable in the tool)`, 'job_failed');
          default: break; // tick, terminal, unknown: ignore
        }
        if (finished) break;
      }
    } catch (err) {
      // Cancel stops following only; the tool's job is resumable and keeps its own state.
      if (err instanceof ToolError && err.code === 'cancelled') throw new ToolError('failed', 'cancelled (the talk-track job keeps running in the tool; reopen it to follow)', 'cancelled');
      throw err;
    }
    if (!finished) throw new ToolError('failed', 'talk-track stream ended before a result', 'stream_incomplete');

    const tpl = { trackId };
    const out = this.manifest.output;
    return {
      links: out.link ? [{ url: render(out.link.urlTemplate, tpl), label: out.link.label }] : [],
      artifacts: out.artifacts.map((a) => ({ path: expandHome(render(a.pathTemplate, tpl)), label: a.label, mime: a.mime })),
      summary: `Talk track "${String(input.name)}" generated for ${String(input.customer)} (${done}/${total || done} segments${failedSegments ? `, ${failedSegments} failed` : ''}).`,
    };
  }
}
