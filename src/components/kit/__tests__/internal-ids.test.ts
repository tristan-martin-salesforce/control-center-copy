/**
 * 01-ui-audit R10 / UI-3: no decision ids ("D-63") or Salesforce API names ("Use_Case__c") in JSX text under
 * src/components. The lint rule (src/components/kit/lint/no-internal-ids.mjs) warns in the editor; this test runs the
 * same rule over every component and fails on a hit that is not grandfathered. It prints the grandfathered hits still
 * present, so the list can shrink.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tsParser from '@typescript-eslint/parser';
import { Linter, type ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { ccPlugin, GRANDFATHERED, internalIdsIn } from '../lint/no-internal-ids.mjs';

const ROOT = join(__dirname, '..', '..', '..', '..');

function lint(code: string, filename: string): Array<{ token: string; line: number }> {
  const linter = new Linter({ configType: 'flat', cwd: ROOT });
  const msgs = linter.verify(
    code,
    [{ files: ['**/*.tsx', '**/*.ts'], languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } }, plugins: { cc: ccPlugin as unknown as ESLint.Plugin }, rules: { 'cc/no-internal-ids-in-jsx': ['error', { all: true }] } }],
    join(ROOT, filename),
  );
  const fatal = msgs.find((m) => m.fatal);
  if (fatal) throw new Error(`${filename}: ${fatal.message}`);
  return msgs.filter((m) => m.ruleId === 'cc/no-internal-ids-in-jsx').map((m) => ({ token: /"([^"]+)"/.exec(m.message)?.[1] ?? '?', line: m.line }));
}

describe('no internal ids in JSX text', () => {
  it('finds ids in text, attributes and rendered expressions, and ignores comments, class names and code', () => {
    const code = `
      // D-12 in a comment is fine
      const KEYS = { Use_Case_Name__c: 'Name' };
      export const A = ({ x }: { x: boolean }) => (
        <div className="D-1" data-x="Stage__c" title="See D-63">
          Each use case is in Org62 (Use_Case__c)
          {x ? 'Pushes first (D-63)' : 'plain'}
          {\`ride along (D-67) \${x}\`}
          <Empty body="From Org62 (Product__c)" />
          {cn('D-9')}
        </div>
      );`;
    expect(lint(code, 'src/components/kit/__fixture__.tsx').map((h) => h.token)).toEqual(['D-63', 'Use_Case__c', 'D-63', 'D-67', 'Product__c']);
    expect(internalIdsIn('MD-5 and D-58b')).toEqual([]);
  });

  it('has no new hits under src/components (grandfathered ones listed)', () => {
    const files = execFileSync('git', ['ls-files', 'src/components/**/*.tsx'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    const found: string[] = [];
    for (const f of files) for (const h of lint(readFileSync(join(ROOT, f), 'utf8'), f)) found.push(`${f}: ${h.token}`);
    const fresh = [...new Set(found.filter((k) => !GRANDFATHERED.has(k)))];
    const old = [...new Set(found.filter((k) => GRANDFATHERED.has(k)))];
    console.info(`internal ids in JSX: ${old.length} grandfathered\n  ${old.join('\n  ')}`);
    expect(fresh, 'say it in plain words (01-ui-audit R10)').toEqual([]);
  }, 60_000);
});
