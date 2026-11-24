/** Claude sessions: local files (`local_files`), the registry, the transcripts and the desktop index; no tools, no token. */
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { LOCAL_FILE_TOOLS } from '../runtime/local-files';
import type { ConnectorManifest } from '../runtime/types';

import { deriveStatus } from './status';
import { applyChunk, turnsOfTranscript } from './transcript';

const MIN = 60_000;
const H = 60 * MIN;

/** The folders the sessions fetcher reads (its defaults; the runtime may read nothing else). */
export function claudeSessionDirs(home = homedir()): { sessionsDir: string; projectsDir: string; desktopDir: string } {
  return {
    sessionsDir: join(home, '.claude', 'sessions'),
    projectsDir: join(home, '.claude', 'projects'),
    desktopDir: join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
  };
}

export const claudeSessionsManifest: ConnectorManifest = {
  id: 'claude_sessions',
  label: 'Claude sessions',
  runtime: 'local_files',
  scopes: ['all'],
  auth: { kind: 'none', check: 'none', reauthHint: { handler: null, kind: null, hint: 'Nothing to sign in to' } },
  readTools: LOCAL_FILE_TOOLS,
  windows: { default: 24 * H, max: 14 * 24 * H },
  // the sweep; the file watch is near real time
  cadence: { baseMs: 10 * MIN },
  estimate: { usdPerDay: 0.75 },
  async healthCheck(rt) {
    const dir = claudeSessionDirs().projectsDir;
    const checkedAt = new Date().toISOString();
    try {
      await rt.call('stat', { path: dir });
      return { state: 'ok', checkedAt };
    } catch (e) {
      return { state: 'degraded', errorClass: 'config', detail: `cannot read ${basename(dir)}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`, checkedAt };
    }
  },
  parse: { chunk: applyChunk, turns: turnsOfTranscript, status: deriveStatus },
  failureCodes: ['ENOENT', 'EACCES', 'EOUTSIDE'],
  scan: { mode: 'deterministic', skill: 'scan-claude-sessions', chunkMs: 12 * H, maxItemsPerRun: 25, watcher: true },
};
