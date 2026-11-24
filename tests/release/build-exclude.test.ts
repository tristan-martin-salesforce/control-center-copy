/**
 * SEC-2 (17-security-review): what never ships in a compiled release. Next's standalone output copies the checkout's
 * `.env` / `.env.production` next to server.js, so the release build's EXCLUDE list must drop every env file; private
 * docs, tests and sample data stay out too.
 */
import { describe, expect, it } from 'vitest';

import * as _buildRaw from '../../scripts/release/build.mjs';
// plain .mjs: its inferred JS types are too narrow for tests
const { EXCLUDE } = _buildRaw as unknown as { EXCLUDE: RegExp[] };

const excluded = (rel: string) => EXCLUDE.some((re) => re.test(rel));

describe('release EXCLUDE', () => {
  it('drops every env file at any depth', () => {
    for (const p of ['.env', '.env.production', '.env.local', '.env.development.local', 'apps/x/.env', 'node_modules/pkg/.env']) expect(excluded(p), p).toBe(true);
  });

  it('keeps ordinary files whose names only look alike', () => {
    for (const p of ['server.js', 'docs/INSTALL.md', 'src/db/migrations/0001_init.sql', 'node_modules/dotenv/lib/main.js', 'scripts/ops/lib/envfile.mjs', '.environment.json']) expect(excluded(p), p).toBe(false);
  });

  it('drops private docs, tests and sample data', () => {
    for (const p of ['docs/research/x.md', 'docs/README.md', 'tests/ops/a.test.ts', 'sample-data/world.json', 'CLAUDE.md']) expect(excluded(p), p).toBe(true);
  });
});
