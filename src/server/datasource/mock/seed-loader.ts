import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { inStateDir } from '@/lib/state-folder';
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
import { Seed } from '@/contract';
import { scaleSeed, seedScale } from '@/mock/scale';

export const PRIVATE_SEED_PATH = inStateDir('fixtures', 'seed.json');
export const EXAMPLE_SEED_PATH = path.join(process.cwd(), 'src/mock/seed.example.json');

export interface LoadedSeed {
  seed: Seed;
  path: string;
  /** Whole days the seed was shifted so meta.asOf lands on today. */
  shiftedDays: number;
}

/**
 * Resolution order: CC_SEED_PATH → the private fixture (outside the repo) → the committed example.
 * The private fixture holds real data: never copy it into the repo or logs.
 */
export function resolveSeedPath(): string {
  const explicit = process.env.CC_SEED_PATH;
  if (explicit) return explicit;
  if (existsSync(PRIVATE_SEED_PATH)) return PRIVATE_SEED_PATH;
  return EXAMPLE_SEED_PATH;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Shift every ISO instant / calendar day in the JSON tree by `days` (local wall-clock preserved). */
export function shiftDates<T>(value: T, days: number): T {
  if (days === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (INSTANT.test(v)) return addDays(new Date(v), days).toISOString();
      if (DAY.test(v)) return format(addDays(parseISO(v), days), 'yyyy-MM-dd');
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/** Parse + validate a seed object; throws a readable SeedError listing the first issues. */
export function parseSeed(raw: unknown, source = 'seed'): Seed {
  const r = Seed.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.slice(0, 15).map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    const more = r.error.issues.length > 15 ? `\n  … and ${r.error.issues.length - 15} more` : '';
    throw new SeedError(`[mock] ${source} does not match the Seed contract (src/contract/seed.ts):\n${lines.join('\n')}${more}`);
  }
  return r.data;
}

export function loadSeed(opts: { path?: string; rebase?: boolean; today?: Date } = {}): LoadedSeed {
  const file = opts.path ?? resolveSeedPath();
  if (!existsSync(file)) throw new SeedError(`[mock] seed file not found: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SeedError(`[mock] seed file is not valid JSON: ${file} (${(err as Error).message})`);
  }
  const label = file === PRIVATE_SEED_PATH ? 'private fixture seed.json' : path.basename(file);
  // C9: CC_SEED_SCALE=n multiplies the seed (src/mock/scale.ts); 1, the default, leaves it untouched
  const seed = scaleSeed(parseSeed(raw, label), seedScale());
  const rebase = opts.rebase ?? process.env.CC_SEED_REBASE !== '0';
  const shiftedDays = rebase ? differenceInCalendarDays(opts.today ?? new Date(), new Date(seed.meta.asOf)) : 0;
  return { seed: shiftedDays ? parseSeed(shiftDates(seed, shiftedDays), label) : seed, path: file, shiftedDays };
}
