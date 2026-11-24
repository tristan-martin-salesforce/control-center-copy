/**
 * `local_files`: read-only access to files on this machine (Claude sessions: `~/.claude/sessions`,
 * `~/.claude/projects`, the desktop app's session index). Four read "tools" and nothing else:
 *
 *   readdir    {path}                    → json: string[]
 *   stat       {path}                    → json: {mtimeMs, size, ino}
 *   read_text  {path}                    → text (utf8)
 *   read_range {path, offset, length}    → json: a Buffer of exactly `length` bytes read from `offset` (zero-padded,
 *                                           the same buffer `fh.read` fills; in process, never serialized)
 *
 * Every path must sit under one of the runtime's roots, lexically (checked before the filesystem is touched) and by its
 * real location (a symlink out of a root is refused, SEC-11).
 * Node's own errors (ENOENT …) pass through unchanged: the fetcher treats a vanished file as it always did.
 */
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type { ConnectorId } from '@/scanner/types';

import { codeOf, guardTool, startTrace, traceCall } from './guard';
import { ZERO_USAGE, type ConnectorRuntime, type RuntimeCallOptions, type RuntimeCallResult } from './types';

export const LOCAL_FILE_TOOLS = ['readdir', 'stat', 'read_text', 'read_range'] as const;

/** A path outside the runtime's roots. Carries `code` like a Node fs error so callers' handling stays the same. */
export class LocalPathRefused extends Error {
  override name = 'LocalPathRefused';
  readonly code = 'EOUTSIDE';
  constructor(readonly path: string) {
    super('local_files runtime: path is outside its roots');
  }
}

export interface LocalFilesRuntimeOptions {
  connector: ConnectorId;
  /** Folders the runtime may read under (absolute). */
  roots: ReadonlyArray<string | null | undefined>;
  readTools?: readonly string[];
}

const within = (p: string, roots: string[]) => {
  const abs = resolve(p);
  return roots.some((r) => abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep));
};

export function localFilesRuntime(o: LocalFilesRuntimeOptions): ConnectorRuntime {
  const roots = o.roots.filter((r): r is string => !!r).map((r) => resolve(r));
  const readTools = o.readTools ?? LOCAL_FILE_TOOLS;
  // SEC-11: a symlink under a root that points elsewhere is refused too: the lexical check runs first (nothing outside is
  // touched), then the path's real location must sit under a root's real location. A missing path keeps Node's ENOENT.
  // P25-9: the roots' real locations are resolved on every call (a handful of realpaths), so a root re-pointed while
  // the worker runs is checked against where it points now.
  const realOf = (r: string) => realpath(r).catch(() => r);
  const pathOf = async (args: Record<string, unknown>) => {
    const p = String(args.path ?? '');
    if (!p || !within(p, roots)) throw new LocalPathRefused(p);
    const [real, realRoots] = await Promise.all([realpath(p), Promise.all(roots.map(realOf))]);
    if (!within(real, realRoots)) throw new LocalPathRefused(p);
    return p;
  };
  const run = async (tool: string, args: Record<string, unknown>): Promise<{ text: string; json: unknown }> => {
    const p = await pathOf(args);
    if (tool === 'readdir') {
      const names = await readdir(p);
      return { text: JSON.stringify(names), json: names };
    }
    if (tool === 'stat') {
      const st = await stat(p);
      const v = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
      return { text: JSON.stringify(v), json: v };
    }
    if (tool === 'read_text') return { text: await readFile(p, 'utf8'), json: null };
    // read_range
    const offset = Math.max(0, Number(args.offset) || 0);
    const length = Math.max(0, Number(args.length) || 0);
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      return { text: `${length} bytes`, json: buf };
    } finally {
      await fh.close();
    }
  };
  return {
    kind: 'local_files',
    connector: o.connector,
    readTools,
    async call(tool: string, args: Record<string, unknown>, opts?: RuntimeCallOptions): Promise<RuntimeCallResult> {
      guardTool(o.connector, readTools, tool);
      const done = startTrace(o.connector, 'local_files', tool);
      try {
        const r = await run(tool, args);
        traceCall(opts, done(true));
        return { ...r, usage: { ...ZERO_USAGE }, cost: { usd: 0, estimated: false } };
      } catch (err) {
        traceCall(opts, done(false, { code: codeOf(err) }));
        throw err;
      }
    },
    estimateUsd: () => 0,
  };
}

/** The typed file port a fetcher reads through, over a `local_files` runtime. */
export interface LocalFilesPort {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number; ino: number }>;
  readText(path: string): Promise<string>;
  /** Exactly `length` bytes from `offset` (zero-padded past the end of the file). */
  readRange(path: string, offset: number, length: number): Promise<Buffer>;
}

export function localFilesPort(rt: ConnectorRuntime): LocalFilesPort {
  return {
    readdir: async (path) => (await rt.call('readdir', { path })).json as string[],
    stat: async (path) => (await rt.call('stat', { path })).json as { mtimeMs: number; size: number; ino: number },
    readText: async (path) => (await rt.call('read_text', { path })).text,
    readRange: async (path, offset, length) => (await rt.call('read_range', { path, offset, length })).json as Buffer,
  };
}
