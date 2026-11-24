/**
 * The `smoke` project: the crawl (scripts/test/crawl.ts) against the mock app. Skipped when no browser can launch (the
 * script exits 77). `npm run smoke:crawl -- --mock` runs it by hand, with the one-line-per-page table.
 * The child runs async: a blocking spawn would starve the worker's RPC heartbeat for the whole crawl.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

import { expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function crawl(): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(path.join(ROOT, 'node_modules/.bin/tsx'), ['scripts/test/crawl.ts', '--mock'], { cwd: ROOT, timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number | string }).code as number) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, out: `${stdout}\n${stderr}` });
    });
  });
}

it('every route, Settings section and Activity view loads clean in the mock app', async (ctx) => {
  const r = await crawl();
  if (r.code === 77) return ctx.skip();
  expect(r.code, r.out).toBe(0);
});
