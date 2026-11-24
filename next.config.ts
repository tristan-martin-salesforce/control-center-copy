import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The build's version, short git sha and build time (D-57), embedded for GET /version and the sidebar footer, plus
 * (PKG-4) how many files differ from that sha (`git status --porcelain`: a teammate's own fixes show as "modified")
 * and the release channel (CC_CHANNEL=stable|beta when a release is built; any other build from source is "dev").
 */
function buildMeta(): { version: string; sha: string; builtAt: string; dirty: number; channel: string } {
  let version = '0.0.0';
  try {
    version = (JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    /* keep 0.0.0 */
  }
  let sha = '';
  try {
    sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch {
    /* not a git checkout */
  }
  let dirty = 0;
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    dirty = out.split('\n').filter((l) => l.trim()).length;
  } catch {
    /* not a git checkout */
  }
  const channel = process.env.CC_CHANNEL === 'stable' || process.env.CC_CHANNEL === 'beta' ? process.env.CC_CHANNEL : 'dev';
  return { version, sha, builtAt: new Date().toISOString(), dirty, channel };
}

const meta = buildMeta();

/**
 * D-90 / PKG-2: a compiled release (`npm run build:release`, scripts/release/build.mjs) is Next's standalone output:
 * server.js plus only the node_modules files the server needs, so a teammate's install has no devDependencies and no
 * `next` CLI. A source checkout keeps the classic `.next` + `next start` build (`npm run build`, `npm run update`),
 * so CC_STANDALONE=1 turns it on.
 */
const standalone = process.env.CC_STANDALONE === '1';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // the tracing root is this checkout (a worktree nested in another checkout would otherwise pick the outer lockfile)
  ...(standalone ? { output: 'standalone' as const, outputFileTracingRoot: path.resolve(process.cwd()) } : {}),
  // The dev "N" badge covers the utility bar's Capture item.
  devIndicators: false,
  // Server-only packages that must not be bundled (native deps, child processes).
  serverExternalPackages: ['pg', 'pino', '@anthropic-ai/claude-agent-sdk', '@modelcontextprotocol/sdk'],
  env: {
    CC_APP_VERSION: meta.version,
    CC_GIT_SHA: meta.sha,
    CC_BUILT_AT: meta.builtAt,
    CC_GIT_DIRTY: String(meta.dirty),
    CC_BUILD_CHANNEL: meta.channel,
    // the same, under the names the feedback lane's browser code reads (src/components/feedback/context.ts)
    NEXT_PUBLIC_CC_VERSION: meta.version,
    NEXT_PUBLIC_CC_GIT_SHA: meta.sha,
    NEXT_PUBLIC_CC_GIT_DIRTY: String(meta.dirty),
    NEXT_PUBLIC_CC_BUILD_CHANNEL: meta.channel,
  },
};

export default nextConfig;
