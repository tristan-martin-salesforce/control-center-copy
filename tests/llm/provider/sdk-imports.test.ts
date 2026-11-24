/**
 * The Agent SDK is imported only by the provider adapter (08 R6, decision H-4): the eslint rule errors on any other
 * import, and no app file names the package in a static or dynamic import.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const SDK = '@anthropic-ai/claude-agent-sdk';
const ALLOWED = (rel: string) => rel.startsWith('src/llm/provider/') || rel === 'src/llm/claude-env.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('SDK imports go through the provider', () => {
  it('the lint rule errors on a probe file outside the provider and passes inside it', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const probe = `import { query } from '${SDK}';\nimport type { Options } from '${SDK}';\nexport const q = query;\nexport type O = Options;\n`;
    const [outside] = await eslint.lintText(probe, { filePath: path.join(ROOT, 'src/server/probe.ts') });
    const errors = outside!.messages.filter((m) => m.ruleId === '@typescript-eslint/no-restricted-imports');
    expect(errors).toHaveLength(2);
    expect(errors.every((m) => m.severity === 2)).toBe(true);
    const [inside] = await eslint.lintText(probe, { filePath: path.join(ROOT, 'src/llm/provider/probe.ts') });
    expect(inside!.messages.filter((m) => m.ruleId === '@typescript-eslint/no-restricted-imports')).toEqual([]);
  }, 60_000);

  it('no file under src/ or app/ outside the provider names the SDK package in an import', () => {
    const hits: string[] = [];
    for (const f of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'app'))]) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      if (ALLOWED(rel)) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (new RegExp(`(from\\s+|import\\(\\s*|require\\(\\s*)['"]${SDK.replace('/', '\\/')}['"]`).test(src)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });
});
