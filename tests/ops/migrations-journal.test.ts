/**
 * E5 (audit 2026-11-13, lane E): the migration files, `meta/_journal.json`, the snapshots and the journal times agree.
 *
 * Drizzle's migrator applies a journal entry only when its `when` is newer than the last applied migration's. A lane
 * that generates a migration on an older base and merges after a newer one gets an older `when`: every database that
 * already ran the newer one skips it silently. These checks fail that merge instead. Pure: no database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { bundledJournal, compareSchema, describeSchema, readJournal, type JournalEntry } from '../../src/db/migration-state';

const FOLDER = resolve(__dirname, '..', '..', 'src', 'db', 'migrations');
const journal = readJournal(FOLDER);
const raw = JSON.parse(readFileSync(join(FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
const num = (tag: string) => Number(tag.slice(0, 4));
/**
 * Numbers that were never merged (lanes that renumbered before landing): 0018 and 0019 (the vdp- and time-roundtrip
 * lanes), 0021 (D-65). Renumbering applied migrations would change nothing for drizzle, but keeps no one honest: a new
 * gap fails here and has to be explained in this list.
 */
const KNOWN_GAPS = new Set([18, 19, 21, 28]); // 28: reserved for p0-priority-fixes, which needed no column in the end (2026-11-20)

describe('migration journal hygiene (E5)', () => {
  it('lists entries in the order drizzle applies them (the file order is the idx order)', () => {
    expect(raw.entries.map((e) => e.idx)).toEqual(journal.map((e) => e.idx));
  });

  it('every SQL file has one journal entry, and every entry its SQL file', () => {
    const files = readdirSync(FOLDER).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')).sort();
    expect(files).toEqual(journal.map((e) => e.tag).sort());
    expect(new Set(journal.map((e) => e.tag)).size).toBe(journal.length);
  });

  it('every entry has its snapshot, and the snapshots chain (each prevId is the one before)', () => {
    const snaps = readdirSync(join(FOLDER, 'meta')).filter((f) => f.endsWith('_snapshot.json')).sort();
    expect(snaps).toEqual(journal.map((e) => `${e.tag.slice(0, 4)}_snapshot.json`));
    let prev = '00000000-0000-0000-0000-000000000000';
    for (const f of snaps) {
      const s = JSON.parse(readFileSync(join(FOLDER, 'meta', f), 'utf8')) as { id: string; prevId: string };
      expect(s.prevId, `${f} must follow the snapshot before it`).toBe(prev);
      prev = s.id;
    }
  });

  it('tags are NNNN_name, and idx, number and journal time all strictly increase', () => {
    for (const e of journal) expect(e.tag).toMatch(/^\d{4}_[a-z0-9_]+$/);
    for (let i = 1; i < journal.length; i++) {
      const [a, b] = [journal[i - 1]!, journal[i]!];
      expect(b.idx, `${b.tag} idx`).toBeGreaterThan(a.idx);
      expect(num(b.tag), `${b.tag} number`).toBeGreaterThan(num(a.tag));
      // the one that matters: an older `when` after a newer one is never applied on a migrated database
      expect(b.when, `${b.tag}'s journal time must be newer than ${a.tag}'s, or drizzle skips it on every migrated database`).toBeGreaterThan(a.when);
    }
  });

  it('numbers only skip the known gaps', () => {
    const used = new Set(journal.map((e) => num(e.tag)));
    const max = Math.max(...used);
    const gaps = Array.from({ length: max }, (_, i) => i).filter((n) => !used.has(n));
    expect(gaps.filter((n) => !KNOWN_GAPS.has(n)), 'a new gap in the numbering: renumber the migration, or explain it in KNOWN_GAPS').toEqual([]);
  });

  it('no journal time is in the future (a future one would make every later migration look older)', () => {
    const last = journal.at(-1)!;
    expect(last.when).toBeLessThan(Date.now() + 24 * 3600_000);
  });

  it('the build imports the same journal the folder holds', () => {
    expect(bundledJournal()).toEqual(journal);
  });
});

describe('compareSchema', () => {
  const j: JournalEntry[] = [
    { idx: 0, when: 100, tag: '0000_a' },
    { idx: 1, when: 200, tag: '0001_b' },
    { idx: 2, when: 300, tag: '0002_c' },
  ];

  it('match: every entry applied', () => {
    expect(compareSchema(j, [100, 200, 300])).toMatchObject({ state: 'match', bundled: '0002_c', applied: '0002_c', pending: [] });
  });

  it('empty: nothing applied', () => {
    expect(compareSchema(j, [])).toMatchObject({ state: 'empty', applied: null, pending: ['0000_a', '0001_b', '0002_c'] });
  });

  it('behind: newer entries wait', () => {
    const s = compareSchema(j, [100]);
    expect(s).toMatchObject({ state: 'behind', applied: '0000_a', pending: ['0001_b', '0002_c'], skipped: [] });
    expect(describeSchema(s).fix).toMatch(/npm run update/);
  });

  it('ahead: the database applied a migration this build does not ship', () => {
    const s = compareSchema(j, [100, 200, 300, 400]);
    expect(s).toMatchObject({ state: 'ahead', applied: 'newer than this build', unknown: 1 });
  });

  it('skipped: an entry merged later with an older journal time is never applied', () => {
    // 0003 was generated on an old base (when 250) and merged after 0002 (when 300) ran: drizzle compares 250 with 300
    const merged: JournalEntry[] = [...j, { idx: 3, when: 250, tag: '0003_late' }];
    const s = compareSchema(merged, [100, 200, 300]);
    expect(s).toMatchObject({ state: 'skipped', skipped: ['0003_late'] });
    expect(describeSchema(s).text).toMatch(/0003_late was never applied/);
  });
});
