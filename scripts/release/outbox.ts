/**
 * `npm run release:outbox -- dist/releases/outbox-<version>.json [--port 4327]` (D-90, W12-7): put a staged release's
 * two items in the running app's Outbox, where you Approve them. `npm run release -- <bump> --publish` does this itself
 * when the app is running; this is the way in when it was not (the file is what publish wrote instead).
 *
 *   POST http://127.0.0.1:<port>/api/v1/outbox/releases   one built release → release.drive_upload (a hand-off: no tool
 *                                                          call, ever) + release.announce (a Slack draft; the app's dry
 *                                                          run applies). Idempotent per version: run it twice, still two.
 *
 * Nothing is sent, uploaded or posted from here (*Nothing leaves without approval*): the app only stages drafts. Only
 * this Mac's own app is called (the loopback guard refuses anything else). Port: --port, else CC_APP_PORT, else 4327.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StageReleaseRequest, StageReleaseResult } from '../../src/contract';
import type { ReleaseHandoffInput } from '../../src/outbox/adapters/release-handoff';

export const DEFAULT_APP_PORT = 4327;

export type StageInAppResult =
  | { ok: true; result: StageReleaseResult }
  /** `down`: nothing answered on the port (the app is not running). `refused`: it answered with an error. */
  | { ok: false; reason: 'down' | 'refused'; message: string };

export function appPortFrom(argv: readonly string[], env: Record<string, string | undefined> = process.env): number {
  const i = argv.indexOf('--port');
  const raw = i >= 0 ? argv[i + 1] : env.CC_APP_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_APP_PORT;
}

/** The request the app takes, from what publish staged. */
export function stageRequestOf(i: ReleaseHandoffInput): StageReleaseRequest {
  return {
    version: i.version,
    channel: i.channel,
    artifactName: i.artifactName,
    artifactPath: i.artifactPath,
    feedPath: i.feedPath,
    installShPath: i.installShPath,
    sha256: i.sha256,
    bytes: i.bytes,
    notes: i.notes,
    folderId: i.folderId,
    announceChannel: i.announceChannel,
    announceChannelName: i.announceChannelName ?? '',
  };
}

/** Create (or update) the release's two Outbox items through the running app. Never throws for a down app. */
export async function stageInApp(i: ReleaseHandoffInput, port: number, fetchImpl: typeof fetch = fetch): Promise<StageInAppResult> {
  let res: Response;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/api/v1/outbox/releases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stageRequestOf(i)), signal: AbortSignal.timeout(15_000) });
  } catch {
    return { ok: false, reason: 'down', message: `nothing answered on http://127.0.0.1:${port} (is Command Center running?)` };
  }
  const body = (await res.json().catch(() => null)) as { entity?: StageReleaseResult; error?: { code?: string; message?: string } } | null;
  if (!res.ok || !body?.entity) return { ok: false, reason: 'refused', message: `the app said ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}` };
  return { ok: true, result: body.entity };
}

/** One line per item: what happened to it, and what Approve does. */
export function describeStaged(r: StageReleaseResult): string[] {
  const words = { created: 'created', updated: 'updated (a second publish of this version)', unchanged: 'already there, unchanged', kept: 'already applied: left as it is' } as const;
  return r.drafts.map((d, n) => {
    const what = d.destination.kind === 'action' && d.destination.action === 'release.drive_upload' ? 'release.drive_upload (hand-off: Copy upload instructions, then Mark uploaded)' : 'release.announce (Slack draft: Approve shows the post first)';
    return `  ${n + 1}. ${what}: ${words[r.outcomes[n]!]}`;
  });
}

/** The file publish writes when the app is not running, and the hint that brings it in later. */
export const importHint = (file: string) => `npm run release:outbox -- ${file}`;

async function main() {
  const argv = process.argv.slice(2);
  const say = (m: string) => console.log(`[release:outbox] ${m}`);
  const file = argv.find((a, n) => !a.startsWith('--') && argv[n - 1] !== '--port');
  if (!file) {
    console.error('[release:outbox] usage: npm run release:outbox -- dist/releases/outbox-<version>.json [--port 4327]');
    process.exit(2);
  }
  let staged: { version?: string; input?: ReleaseHandoffInput };
  try {
    staged = JSON.parse(readFileSync(resolve(file), 'utf8')) as typeof staged;
  } catch {
    console.error(`[release:outbox] cannot read ${file}`);
    process.exit(2);
  }
  if (!staged.input) {
    console.error(`[release:outbox] ${file} has no release input (written by an older publish): run npm run release -- --publish --skip-build again`);
    process.exit(2);
  }
  const port = appPortFrom(argv);
  const r = await stageInApp(staged.input, port);
  if (!r.ok) {
    console.error(`[release:outbox] nothing staged: ${r.message}. Start the app (npm run dev, or the LaunchAgent) and run this again.`);
    process.exit(1);
  }
  say(`v${r.result.version}: the two items are in the Outbox (http://localhost:${port}/outbox)${r.result.dryRun ? ', dry run on: Approve renders the post, nothing is sent' : ''}`);
  for (const l of describeStaged(r.result)) console.log(l);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`[release:outbox] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
