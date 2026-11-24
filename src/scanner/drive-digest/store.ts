import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inStateDir } from '@/lib/state-folder';
import type { DigestStore, DriveSample } from './types';

export class MemoryDigestStore implements DigestStore {
  private readonly m = new Map<string, DriveSample[]>();
  async put(s: DriveSample): Promise<void> {
    const arr = this.m.get(s.fileId) ?? [];
    if (!arr.some((x) => x.digest.digestHash === s.digest.digestHash && x.modifiedTime === s.modifiedTime)) arr.push(s);
    arr.sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
    this.m.set(s.fileId, arr);
  }
  async getByHash(fileId: string, h: string): Promise<DriveSample | null> {
    const arr = this.m.get(fileId) ?? [];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i]!.digest.digestHash === h) return arr[i]!;
    return null;
  }
  async latest(fileId: string): Promise<DriveSample | null> {
    const arr = this.m.get(fileId) ?? [];
    return arr[arr.length - 1] ?? null;
  }
  async history(fileId: string, limit = 50): Promise<DriveSample[]> {
    return (this.m.get(fileId) ?? []).slice(-limit);
  }
}

export const defaultDigestDir = () => inStateDir('drive-digests');

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');

/** One JSON file per sample: `<dir>/<fileId>/<sampledAt>_<hash>.json`. State lives outside the repo (CLAUDE.md invariant 6). */
export class FileDigestStore implements DigestStore {
  constructor(private readonly dir: string = defaultDigestDir()) {}

  private fileDir(fileId: string) {
    return join(this.dir, safe(fileId));
  }

  async put(s: DriveSample): Promise<void> {
    const d = this.fileDir(s.fileId);
    await mkdir(d, { recursive: true });
    const name = `${s.sampledAt.replace(/[:.]/g, '-')}_${s.digest.digestHash}.json`;
    const tmp = join(d, `.${name}.tmp`);
    await writeFile(tmp, JSON.stringify(s));
    await rename(tmp, join(d, name));
  }

  async history(fileId: string, limit = 50): Promise<DriveSample[]> {
    let names: string[];
    try {
      names = (await readdir(this.fileDir(fileId))).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
    } catch {
      return [];
    }
    const out: DriveSample[] = [];
    for (const n of names.slice(-limit)) {
      try {
        out.push(JSON.parse(await readFile(join(this.fileDir(fileId), n), 'utf8')) as DriveSample);
      } catch {
        /* skip a corrupt sample */
      }
    }
    return out;
  }

  async latest(fileId: string): Promise<DriveSample | null> {
    const h = await this.history(fileId, 1);
    return h[0] ?? null;
  }

  async getByHash(fileId: string, h: string): Promise<DriveSample | null> {
    const hist = await this.history(fileId, 200);
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i]!.digest.digestHash === h) return hist[i]!;
    return null;
  }
}
