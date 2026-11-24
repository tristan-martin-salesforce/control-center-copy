/**
 * Scanner process settings: pinned CLI, fixed cwd, clean env. The env logic lives in `claude-env.ts`
 * (shared with NBA/chat); `cleanEnv` is kept as the scanner-allowlist alias.
 */
import { inStateDir } from '@/lib/state-folder';
import { claudeExecutable, scannerEnv } from './claude-env';

/** Allowlist env without gateway vars (tests / callers that add their own). */
export function cleanEnv(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return scannerEnv({}, source, extra);
}

/**
 * Pinned CLI (brief 09 §3.9: two binaries with different versions exist): CC_CLAUDE_BIN, else ~/.local/bin/claude,
 * else Homebrew's, else PATH (one resolver with doctor: src/ops/claude-bin.ts).
 */
export function defaultClaudeExecutable(source: NodeJS.ProcessEnv = process.env): string {
  return claudeExecutable(source);
}

/** Fixed scanner cwd so the Claude-sessions source can filter scanner runs trivially (brief 09 §3.8). */
export function defaultScannerCwd(source: NodeJS.ProcessEnv = process.env): string {
  return source.CC_SCANNER_CWD ?? inStateDir('scanner-cwd');
}
