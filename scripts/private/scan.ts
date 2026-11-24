/**
 * npm run scan:private [-- --no-history] [--no-db] [--json] [--show-placeholders]
 *
 * Before a push (and before connecting the first remote): does anything git would publish hold private material?
 *   - names: the real account, person and opportunity names in the local database (DATABASE_URL), read at run time
 *     and kept in memory only; placeholders from src/mock/seed.example.json are skipped. Accounts also count by the
 *     short forms people write (core, d/b/a brand, distinctive first word) and by their Org62 parents (D-69 kv);
 *   - ids: Org62 15/18-character record ids, Slack ids, salesforce.com emails.
 *
 * Placeholder ids (P33-4). The repo's tests, eval cases, example seed and sample data are full of id-shaped values,
 * and they are formed in a few fixed ways that real Org62 / Slack ids are not (placeholderShape, src/lib/private-scan):
 *   - sample-data/lib/kit.ts: sfId(prefix, n) = <prefix>SMPL<n, 8 digits>AAA; slackUser/Channel/Dm(n) = U0/C0/D0 SMPL <n>;
 *   - the example seed and hand-written fixtures: `XX` in the Org62 instance characters (001XX0000SEED01AAA, Salesforce's
 *     documentation convention), a placeholder word (TEST, MOCK, SEED, DEMO, CHILD, PARENT), or an 18-character id
 *     whose last three characters are not the case checksum of the first fifteen (Salesforce always writes a valid one);
 *   - Slack fixtures: letters then a zero-led counter (U0DANA0001, C0ACME001), where real ids are random base 36;
 *   - the older markers (PLACEHOLDER, EXAMPLE, XXX, FAKE, 123456, runs of zeros) stay silent, as before.
 * A hit in one of those shapes counts as "placeholder-shaped ids" and does not fail the run; every other id-shaped
 * value stays a hit. Shapes, not a list of values: the fixtures are hand-written (no generator output to read), and
 * a shape rule needs no file to keep in step. The DB pass's exact ids (knownIds) match whatever their shape.
 * It scans every tracked file at HEAD and, unless --no-history, the lines every commit added (git log -p --all)
 * plus commit messages. It prints FILE PATHS AND COUNTS ONLY, never a matched value.
 *
 * Exit code: 0 clean, 2 hits in tracked files (history hits alone exit 0 but say what to do).
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';
import { STATE_FOLDER_DISPLAY } from '../../src/lib/state-folder-name';
import { addCounts, buildMatchers, databaseUrlCandidates, findings, formatCounts, formatHits, scanLine, scanText, skipPath, total, type Counts, type FileHit, type Matcher, type NameLists } from '../../src/lib/private-scan';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const EMPTY: NameLists = { accounts: [], opportunities: [], people: [], owner: [], ids: [] };

/** The database under either of its names (command_center, or control_center on a 1.x install the rename has not reached). */
async function namesFromDb(): Promise<{ lists: NameLists; note: string }> {
  if (has('--no-db')) return { lists: EMPTY, note: 'names: skipped (--no-db)' };
  let last: { lists: NameLists; note: string; ok: boolean } = { lists: EMPTY, note: 'names: no database', ok: false };
  for (const url of databaseUrlCandidates(resolveDatabaseUrl())) {
    last = await namesFromUrl(url);
    if (last.ok) break;
  }
  return { lists: last.lists, note: last.note };
}

async function namesFromUrl(url: string): Promise<{ lists: NameLists; note: string; ok: boolean }> {
  const empty = EMPTY;
  const handle = createDb({ url, max: 1, applicationName: 'command-center-scan-private' });
  try {
    const col = async (q: ReturnType<typeof sql>) => ((await handle.db.execute(q)).rows as Array<{ v: string | null }>).map((r) => r.v).filter((v): v is string => !!v);
    const safe = (q: ReturnType<typeof sql>) => col(q).catch(() => [] as string[]);
    const ids = (
      await Promise.all([
        safe(sql`select org62_account_id as v from accounts`),
        safe(sql`select org62_opportunity_id as v from opportunities`),
        safe(sql`select org62_user_id as v from opportunity_team_members`),
        safe(sql`select org62_event_id as v from org62_events`),
        safe(sql`select org62_dc_id as v from deal_contributions`),
        safe(sql`select external_id as v from person_identities`),
        safe(sql`select external_id as v from channels`),
        safe(sql`select external_id as v from canvases`),
      ])
    )
      .flat()
      .filter((v) => /^[A-Za-z0-9]{8,18}$/.test(v));
    const [accounts, aliases, parents, opportunities, people, me, users] = await Promise.all([
      col(sql`select name as v from accounts`),
      col(sql`select value as v from account_aliases where kind in ('name', 'short_name')`),
      // the Org62 parents above my book (D-69 hierarchy, kv): companies the accounts table never holds
      safe(sql`select n.value ->> 'name' as v from user_settings s, jsonb_each(s.value -> 'nodes') n where s.key = 'cc.org62.account_hierarchy' and jsonb_typeof(s.value -> 'nodes') = 'object'`),
      col(sql`select name as v from opportunities`),
      col(sql`select display_name as v from people where not is_me`),
      col(sql`select display_name as v from people where is_me union select primary_email from people where is_me`),
      col(sql`select display_name as v from users union select email from users`),
    ]);
    const lists: NameLists = { accounts: [...accounts, ...aliases, ...parents], opportunities, people, owner: [...me, ...users], ids };
    return { ok: true, lists, note: `names from ${databaseName(url)}: ${accounts.length} accounts, ${opportunities.length} opportunities, ${people.length} people, ${new Set(ids).size} ids` };
  } catch (err) {
    return { ok: false, lists: empty, note: `names: database unavailable (${err instanceof Error ? err.message.split('\n')[0] : 'error'}); ids only` };
  } finally {
    await handle.close();
  }
}

/** Names the committed placeholder seed uses (ACME, Globex, …): never a finding. */
function placeholderNames(): Set<string> {
  const out = new Set<string>();
  try {
    const walk = (v: unknown, key = '') => {
      if (typeof v === 'string') {
        if (/name|title|label|account/i.test(key) && v.length < 120) out.add(v.toLowerCase());
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(JSON.parse(readFileSync(path.join(root, 'src/mock/seed.example.json'), 'utf8')));
  } catch {
    /* no example seed */
  }
  return out;
}

/** Tracked files with findings, and (counted apart, never a finding) files whose only id hits are placeholder-shaped. */
function scanTracked(matchers: readonly Matcher[]): { hits: FileHit[]; placeholders: FileHit[] } {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
  const hits: FileHit[] = [];
  const placeholders: FileHit[] = [];
  for (const f of files) {
    if (skipPath(f)) continue;
    const abs = path.join(root, f);
    try {
      if (statSync(abs).size > 8 << 20) continue;
      const text = readFileSync(abs, 'utf8');
      if (text.includes('\0')) continue; // binary
      const counts = scanText(text, matchers);
      if (findings(counts)) hits.push({ path: f, counts });
      else if (total(counts)) placeholders.push({ path: f, counts });
    } catch {
      /* deleted in the working tree, unreadable */
    }
  }
  return { hits, placeholders };
}

/** Every line a commit added, per path, plus commit messages (as "(commit messages)"). */
async function scanHistory(matchers: readonly Matcher[]): Promise<{ hits: FileHit[]; commits: number; commitsWithHits: number }> {
  const child = spawn('git', ['log', '-p', '--all', '--no-color', '--no-ext-diff', '--format=%x00commit %H%n%B%x00end'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const byPath = new Map<string, { counts: Counts; commits: Set<string> }>();
  const hitCommits = new Set<string>();
  let commit = '';
  let commits = 0;
  let inMessage = false;
  let file: string | null = null;
  const record = (p: string, c: Counts) => {
    if (!findings(c)) return;
    delete c.placeholderIds;
    const e = byPath.get(p) ?? { counts: {}, commits: new Set<string>() };
    addCounts(e.counts, c);
    e.commits.add(commit);
    byPath.set(p, e);
    hitCommits.add(commit);
  };
  for await (const line of rl) {
    if (line.startsWith('\0commit ')) {
      commit = line.slice(8, 48);
      commits++;
      inMessage = true;
      file = null;
      continue;
    }
    if (inMessage) {
      if (line.startsWith('\0end')) inMessage = false;
      else record('(commit messages)', scanLine(line, matchers));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      file = p === '/dev/null' || skipPath(p) ? null : p;
      continue;
    }
    if (file && line.startsWith('+') && !line.startsWith('+++')) record(file, scanLine(line.slice(1), matchers));
  }
  await new Promise((r) => child.on('close', r));
  const hits = [...byPath].map(([p, e]) => ({ path: p, counts: e.counts, commits: e.commits.size }));
  return { hits, commits, commitsWithHits: hitCommits.size };
}

async function main(): Promise<number> {
  const { lists, note } = await namesFromDb();
  const matchers = buildMatchers(lists, placeholderNames());
  const { hits: tracked, placeholders } = scanTracked(matchers);
  const placeholderCount = [...placeholders, ...tracked].reduce((a, h) => a + (h.counts.placeholderIds ?? 0), 0);
  const placeholderFiles = placeholders.length + tracked.filter((h) => h.counts.placeholderIds).length;
  const history = has('--no-history') ? null : await scanHistory(matchers);

  if (has('--json')) {
    console.log(JSON.stringify({ note, tracked, placeholders: { ids: placeholderCount, files: placeholders.map((h) => h.path) }, history }, null, 2));
    return tracked.length ? 2 : 0;
  }
  console.log(`scan:private · ${note}`);
  console.log('  "real ids" and names come from your database; "-shaped" ids match the pattern only; "placeholder-shaped" ids are fixture shapes (SMPL, XX, a bad checksum, …) and never fail the run.');
  console.log(`\nTracked files at HEAD: ${tracked.length ? `${tracked.length} with hits` : 'clean'}`);
  for (const l of formatHits(tracked)) console.log(l);
  if (tracked.length) console.log(`  total: ${formatCounts(tracked.reduce((a, h) => addCounts(a, h.counts), {} as Counts))}`);
  console.log(`Placeholder-shaped ids (not findings): ${placeholderCount} in ${placeholderFiles} file(s)${has('--show-placeholders') ? '' : ' (--show-placeholders lists the files)'}`);
  if (has('--show-placeholders')) for (const l of formatHits(placeholders)) console.log(l);
  if (history) {
    console.log(`\nGit history (${history.commits} commits, every branch): ${history.hits.length ? `${history.hits.length} path(s) with hits in ${history.commitsWithHits} commit(s)` : 'clean'}`);
    for (const l of formatHits(history.hits)) console.log(l);
  }
  console.log('');
  if (tracked.length) console.log(`→ Move or placeholder the files above before pushing (private copies go to ${STATE_FOLDER_DISPLAY}/private/).`);
  if (history?.hits.length) console.log('→ History has hits: when you connect the remote, push a fresh-history snapshot (README ▸ Sharing the repo), not this history.');
  if (!tracked.length && !history?.hits.length) console.log('→ Nothing private found.');
  return tracked.length ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[scan:private] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
