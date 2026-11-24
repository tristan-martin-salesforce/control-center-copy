/**
 * R7: the DataSource is one file per domain. Every domain has its db twin, its mock twin and its interface; each is
 * wired into its facade; the shared read views sit beside them. A new domain adds its row here (CONTRIBUTING.md
 * "Where a DataSource method goes").
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ReadModel } from '@/server/datasource/db/model';
import type { Store } from '@/server/datasource/mock/store';
import type { ReadSource } from '@/server/views/source';

const root = path.resolve(__dirname, '../..');
const ds = path.join(root, 'src/server/datasource');
const views = path.join(root, 'src/server/views');

/** The domains of db/domains and mock/domains, and the facade field each is wired as. */
const DOMAINS: Record<string, string> = {
  agents: 'agents',
  briefs: 'briefs',
  calendar: 'calendar',
  canvas: 'canvas',
  chat: 'chats',
  deals: 'deals',
  dev: 'dev',
  drafts: 'drafts',
  engine: 'engine',
  feedback: 'feedback',
  health: 'health',
  history: 'history',
  nba: 'nba',
  needs: 'needs',
  settings: 'settingsDomain',
  time: 'time',
  today: 'today',
  triage: 'triage',
  universal: 'universal',
  vdp: 'vdp',
  work: 'work',
};
/** The engines that kept their own files (db/<engine>.ts, mock/<engine>.ts) still have their interface file. */
const ENGINES = ['attribution', 'use-cases', 'forecast', 'onboarding'];
/** Domains with no route of their own (the engine and scenario writes the worker, chat and dev routes call). */
const NO_ROUTES = ['engine'];
/**
 * The domains whose reads are shared in src/server/views (the rest compute their reads differently per store). Today,
 * Triage, the Time week and the Work lists were the last twins (docs/reviews/2026-11-20-holistic/19-read-twins.md).
 */
const VIEWS = ['agents', 'briefs', 'calendar', 'deals', 'drafts', 'health', 'time', 'today', 'triage', 'universal', 'work'];
/** views/ files that are not a domain: the read source and the link helpers. */
const VIEW_SUPPORT = ['source', 'refs'];

const pascal = (d: string) => d.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
const tsFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();

describe('the DataSource layout (R7)', () => {
  it('db and mock have exactly the same domain files', () => {
    expect(tsFiles(path.join(ds, 'db/domains'))).toEqual(Object.keys(DOMAINS).sort());
    expect(tsFiles(path.join(ds, 'mock/domains'))).toEqual(Object.keys(DOMAINS).sort());
  });

  it('every domain with routes and every engine has its interface in types/, and types.ts extends each one', () => {
    const types = readFileSync(path.join(ds, 'types.ts'), 'utf8');
    const routed = [...Object.keys(DOMAINS).filter((d) => !NO_ROUTES.includes(d)), ...ENGINES];
    for (const d of routed) {
      expect(existsSync(path.join(ds, 'types', `${d}.ts`)), `types/${d}.ts`).toBe(true);
      expect(readFileSync(path.join(ds, 'types', `${d}.ts`), 'utf8')).toContain(`export interface ${pascal(d)}Source {`);
      expect(types).toContain(`${pascal(d)}Source`);
    }
    expect(tsFiles(path.join(ds, 'types')).filter((f) => f !== 'route')).toEqual(routed.sort());
  });

  it('every domain class is exported and constructed with the context in its facade', () => {
    const dbFacade = readFileSync(path.join(ds, 'db/index.ts'), 'utf8');
    const mockFacade = readFileSync(path.join(ds, 'mock/index.ts'), 'utf8');
    for (const [d, field] of Object.entries(DOMAINS)) {
      expect(readFileSync(path.join(ds, 'db/domains', `${d}.ts`), 'utf8')).toContain(`export class Db${pascal(d)} {`);
      expect(readFileSync(path.join(ds, 'mock/domains', `${d}.ts`), 'utf8')).toContain(`export class Mock${pascal(d)} {`);
      expect(dbFacade).toContain(`this.${field} = new Db${pascal(d)}(this.ctx);`);
      expect(mockFacade).toContain(`readonly ${field} = new Mock${pascal(d)}(this.ctx);`);
    }
  });

  it('the shared read views are domain files (plus the read source and the link helpers)', () => {
    expect(tsFiles(views)).toEqual([...VIEWS, ...VIEW_SUPPORT].sort());
    for (const v of VIEWS) expect(Object.keys(DOMAINS)).toContain(v);
  });

  it('no read twins left: neither DataSource keeps a read body of its own in views.ts (only re-exports and store inputs)', () => {
    for (const side of ['db', 'mock']) {
      const src = readFileSync(path.join(ds, side, 'views.ts'), 'utf8');
      expect(src, `${side}/views.ts`).not.toMatch(/export function build\w*\(/);
      expect(src, `${side}/views.ts`).not.toMatch(/function tabMatch\(/);
    }
    for (const side of ['db', 'mock']) expect(readFileSync(path.join(ds, side, 'domains/work.ts'), 'utf8')).toContain('workListView(');
  });

  it("both stores satisfy the views' ReadSource (a compile-time check, run by typecheck)", () => {
    const fromDb = (m: ReadModel): ReadSource => m;
    const fromMock = (s: Store): ReadSource => s;
    expect([typeof fromDb, typeof fromMock]).toEqual(['function', 'function']);
  });

  it('the db implementation loads only through db-entry.ts (mock-only module graphs never reach pg or drizzle)', () => {
    const index = readFileSync(path.join(ds, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/from '\.\/db'/);
    expect(index).not.toMatch(/import\('\.\/db['/]/);
    expect(readFileSync(path.join(ds, 'db-entry.ts'), 'utf8')).toContain("export { createDbDataSource } from './db';");
  });
});
