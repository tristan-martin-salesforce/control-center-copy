/**
 * `npm run scan:private` (scripts/private/scan.ts): find private material in what git would publish. The owner's
 * real account, person and opportunity names come from the local database at run time and are never written
 * anywhere; on top of them, id patterns: Org62 15/18-character ids, Slack ids, salesforce.com emails.
 *
 * Pure. The report holds file paths and counts only, never a matched value, so it is safe to paste.
 */
import { brandOf, companyQuery, coreQuery } from '@/lib/vdp/company-name';
import { isOrdinaryNameWord, shortNames } from '@/projections/matching';

export type PrivateCategory = 'accounts' | 'opportunities' | 'people' | 'owner' | 'knownIds' | 'org62Ids' | 'slackIds' | 'emails' | 'placeholderIds';

export const CATEGORY_LABEL: Record<PrivateCategory, string> = {
  accounts: 'account names',
  opportunities: 'opportunity names',
  people: 'people',
  owner: 'owner name/email',
  /** Exact Org62 / Slack ids your database holds: certainly real. */
  knownIds: 'real ids (in your DB)',
  /** Pattern only: real-looking, but fixtures' placeholder ids land here too. */
  org62Ids: 'Org62-id-shaped',
  slackIds: 'Slack-id-shaped',
  emails: 'salesforce.com emails',
  /** Id-shaped, but in a placeholder shape (placeholderShape): counted, never a finding. */
  placeholderIds: 'placeholder-shaped ids',
};

/** The categories that are findings (fail the run); placeholder-shaped ids are reported, not failed. */
export const FINDING_CATEGORIES = (Object.keys(CATEGORY_LABEL) as PrivateCategory[]).filter((c) => c !== 'placeholderIds');

export const CATEGORIES = Object.keys(CATEGORY_LABEL) as PrivateCategory[];

export interface NameLists {
  accounts: readonly string[];
  opportunities: readonly string[];
  people: readonly string[];
  owner: readonly string[];
  /** Org62 and Slack ids from the database (exact matches; 18-character Org62 ids also match their 15-character form). */
  ids?: readonly string[];
}

export type Counts = Partial<Record<PrivateCategory, number>>;

export interface Matcher {
  category: PrivateCategory;
  /** Number of hits in one line. */
  count: (line: string) => number;
}

/** Words that are names of things everyone uses, not customers. */
const STOP = new Set(['salesforce', 'slack', 'google', 'tableau', 'mulesoft', 'heroku', 'test', 'demo', 'example', 'internal', 'unknown', 'none', 'other', 'personal', 'acme', 'globex', 'initech', 'umbrella', 'hooli', 'stark', 'wayne']);

/**
 * Placeholder ids look like placeholders: PLACEHOLDER, EXAMPLE, XXX, 123456, or a run of zeros. Real Org62 ids carry
 * "00000" in their pod/sequence part, so for them only 8+ zeros reads as a placeholder; Slack ids almost never repeat
 * a zero four times.
 */
export function isPlaceholderId(id: string, kind: 'org62' | 'slack' | 'any' = 'any'): boolean {
  if (/PLACE|EXAMPL|XXX|FAKE|DUMMY|SAMPLE|123456/i.test(id)) return true;
  return kind === 'slack' ? /0{4,}/.test(id) : /0{8,}/.test(id);
}

/** Org62 record ids with a known key prefix (account, contact, user, opp, lead, event, task, record type, custom). */
const ORG62_ID = /\b(?:001|003|005|006|00Q|00U|00T|00D|00G|012|0Q0|a[0-9][A-Za-z0-9])[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/g;
/** Slack user / channel / team / file ids ("U01…", "C08…", "F0…"). */
const SLACK_ID = /\b[UCGWTDF]0[A-Z0-9]{7,11}\b/g;
const SF_EMAIL = /[A-Za-z0-9._%+-]+@salesforce\.com\b/gi;
const GENERIC_EMAIL_USER = /^(user|me|someone|example|name|first\.last|firstname\.lastname|you|your\.name|noreply|no-reply|test|owner)@/i;

function digits(s: string): number {
  let n = 0;
  for (const c of s) if (c >= '0' && c <= '9') n++;
  return n;
}

function countMatches(line: string, re: RegExp, keep: (m: string) => boolean): number {
  re.lastIndex = 0;
  let n = 0;
  for (const m of line.matchAll(re)) if (keep(m[0])) n++;
  return n;
}

/** The Salesforce 18-character suffix: per 5-character chunk, a bit per upper-case letter, read as A-Z0-5. */
const CHECKSUM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
export function org62Checksum(id15: string): string {
  let out = '';
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) if (/[A-Z]/.test(id15[chunk * 5 + i] ?? '')) bits |= 1 << i;
    out += CHECKSUM_ALPHABET[bits];
  }
  return out;
}

/**
 * Words the repo's placeholders spell out; a real base-62 / base-36 id spells none of them by chance often enough to
 * matter. Org62 ids are case-sensitive, so the word must be upper case there (a real id spelling `tEsT` in mixed case
 * stays a hit, P35-3); Slack ids are upper case, so any case does.
 */
const PLACEHOLDER_WORD_SOURCE = 'SMPL|TEST|MOCK|SEED|DEMO|CHILD|PARENT|OTHER|STRESS|NOBODY|NOISE|PERSON|USER';
const PLACEHOLDER_WORD = { org62: new RegExp(PLACEHOLDER_WORD_SOURCE), slack: new RegExp(PLACEHOLDER_WORD_SOURCE, 'i') };
/**
 * Salesforce writes an id's first fifteen in mixed case; one with no upper-case or no lower-case letter there was
 * typed by hand or had its case changed on the way (a lower-cased URL, an "upper-case all"), so its checksum says
 * nothing and it stays a hit (P35-3).
 */
const mixedCase = (id15: string) => /[A-Z]/.test(id15) && /[a-z]/.test(id15);
/** Keyboard runs a person types for "any id" (U0123ABCD, C0ABCDEF12); 123456 is already a marker. */
const PLACEHOLDER_RUN = /ABCD|0123|1234/;

export type PlaceholderShape = 'marker' | 'sample' | 'xx-pod' | 'checksum' | 'word' | 'run' | 'sequence';

/**
 * Why an id-shaped value is a placeholder, or null when it could be real. Shapes, never a list of values:
 *  - marker: isPlaceholderId (PLACEHOLDER, EXAMPLE, XXX, FAKE, 123456, a run of zeros);
 *  - sample: `SMPL`, the sample-data kit's marker (sfId → 006SMPL00000007AAA; U0SMPL001, C0SMPL004, D0SMPL…);
 *  - xx-pod (Org62): `XX` where the instance characters sit (001XX0000SEED01AAA), Salesforce's own documentation
 *    placeholder; real Org62 ids carry a real instance there;
 *  - checksum (Org62, 18 characters, first fifteen in mixed case): the last three characters are not the case
 *    checksum of the first fifteen. Salesforce always writes a valid one, so a hand-typed …AAA cannot be a real id;
 *    an id in one case only is not judged by it (a real id whose case was changed would fail it);
 *  - word: a placeholder word spelled in the id (TEST, MOCK, SEED, DEMO, CHILD, PARENT, OTHER, STRESS, …; upper case
 *    for Org62);
 *  - run (Slack): a typed run, ABCD, 0123 or 1234 (U0123ABCD, C0ABCDEF12); Org62 sequences hold digit runs, so not there;
 *  - sequence (Slack): letters, then a zero-led counter to the end (U0DANA0001, C0WATCH01, D0DM00011); real Slack ids
 *    are random base 36 and almost never end that way.
 * Pattern hits only: an exact id your database holds (knownIds) is matched whatever its shape.
 */
export function placeholderShape(id: string, kind: 'org62' | 'slack'): PlaceholderShape | null {
  if (isPlaceholderId(id, kind)) return 'marker';
  if (/SMPL/i.test(id)) return 'sample';
  if (PLACEHOLDER_WORD[kind].test(id)) return 'word';
  if (kind === 'slack' && PLACEHOLDER_RUN.test(id)) return 'run';
  if (kind === 'org62') {
    if (id.slice(3, 5) === 'XX') return 'xx-pod';
    if (id.length === 18 && mixedCase(id.slice(0, 15)) && org62Checksum(id.slice(0, 15)) !== id.slice(15).toUpperCase()) return 'checksum';
    return null;
  }
  return /^[A-Z]0[A-Z]{2,}0\d+$/.test(id) ? 'sequence' : null;
}

const isOrg62Shaped = (m: string) => digits(m) >= 4 && /[A-Za-z]/.test(m.slice(3));
const isSlackShaped = (m: string) => digits(m.slice(2)) >= 2 && /[A-Z]/.test(m.slice(2));

export const ID_MATCHERS: readonly Matcher[] = [
  { category: 'org62Ids', count: (l) => countMatches(l, ORG62_ID, (m) => isOrg62Shaped(m) && !placeholderShape(m, 'org62')) },
  { category: 'slackIds', count: (l) => countMatches(l, SLACK_ID, (m) => isSlackShaped(m) && !placeholderShape(m, 'slack')) },
  { category: 'emails', count: (l) => countMatches(l, SF_EMAIL, (m) => !GENERIC_EMAIL_USER.test(m)) },
  {
    category: 'placeholderIds',
    count: (l) =>
      countMatches(l, ORG62_ID, (m) => isOrg62Shaped(m) && !isPlaceholderId(m, 'org62') && !!placeholderShape(m, 'org62')) +
      countMatches(l, SLACK_ID, (m) => isSlackShaped(m) && !isPlaceholderId(m, 'slack') && !!placeholderShape(m, 'slack')),
  },
];

/** Corporate suffixes dropped to get the name people actually write ("Acme Corporation" → "Acme"). */
const SUFFIX = /[\s,]+(inc\.?|llc|l\.l\.c\.|ltd\.?|limited|corp\.?|corporation|company|co\.?|plc|gmbh|ag|s\.a\.|sa|group|holdings?)$/i;

/** The names worth looking for: trimmed, de-duplicated, ≥ 4 characters, not a placeholder or a common word. */
export function usableNames(names: readonly string[], placeholders: ReadonlySet<string> = new Set(), opts: { stripSuffix?: boolean; minWords?: number } = {}): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const variants = [raw.trim()];
    if (opts.stripSuffix) variants.push(raw.trim().replace(SUFFIX, '').trim());
    for (const v of variants) {
      const low = v.toLowerCase();
      if (v.length < 4 || STOP.has(low) || placeholders.has(low)) continue;
      if (opts.minWords && tokens(v).length < opts.minWords) continue;
      out.add(v);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const WORD = /[\p{L}\p{N}]+/gu;
function tokens(s: string): string[] {
  return (s.toLowerCase().match(WORD) ?? []) as string[];
}

/**
 * Whole-word name lookup in linear time: names become token sequences indexed by their first token, and a line's
 * tokens are checked against the candidates that start there (thousands of names stay fast). `capitalOnly`: one-word
 * names that count with a capital first letter only ("Northwind" in prose, never a variable's "northwind"); the
 * longest name still wins, so a brand of two words counts once.
 */
function nameMatcher(category: PrivateCategory, names: readonly string[], capitalOnly: readonly string[] = []): Matcher | null {
  const index = new Map<string, string[][]>();
  const plain = new Set(names.map((n) => tokens(n).join(' ')));
  const cap = new Set(capitalOnly.map((w) => w.toLowerCase()).filter((w) => !plain.has(w)));
  for (const n of [...names, ...cap]) {
    const t = tokens(n);
    if (!t.length) continue;
    const list = index.get(t[0]!) ?? [];
    list.push(t);
    index.set(t[0]!, list);
  }
  if (!index.size) return null;
  for (const list of index.values()) list.sort((a, b) => b.length - a.length);
  return {
    category,
    count: (line) => {
      const raw = line.match(WORD) ?? [];
      const t = raw.map((w) => w.toLowerCase());
      let n = 0;
      for (let i = 0; i < t.length; i++) {
        const cands = index.get(t[i]!);
        if (!cands) continue;
        const hit = cands.find((c) => c.every((w, j) => t[i + j] === w) && !(c.length === 1 && cap.has(c[0]!) && !/^\p{Lu}/u.test(raw[i]!)));
        if (hit) {
          n++;
          i += hit.length - 1;
        }
      }
      return n;
    },
  };
}

/**
 * The short forms people write for an account, derived the way the app derives them: VDP's search text and core
 * ("Northwind Health, Inc." → "Northwind Health", "Northwind"), the d/b/a brand, and the matcher's distinctive first
 * word or letters-into-digits head ("Contoso42Health" → "contoso42"). A full-name scan misses all of these. Acronyms
 * are left out (three letters match too much code), and so are ordinary words ("Horizon", "Blue"). `multi`: forms
 * of two or more words; `single`: one-word forms of five or more characters.
 */
export function accountShortForms(names: readonly string[], placeholders: ReadonlySet<string> = new Set()): { multi: string[]; single: string[] } {
  const multi = new Set<string>();
  const single = new Set<string>();
  const add = (v: string | null | undefined) => {
    const s = (v ?? '').trim();
    const t = tokens(s);
    const low = t.join(' ');
    if (!t.length || STOP.has(low) || placeholders.has(low) || placeholders.has(s.toLowerCase())) return;
    if (t.length > 1) {
      if (s.length >= 4) multi.add(s);
    } else if (t[0]!.length >= 5 && !isOrdinaryNameWord(t[0]!)) single.add(t[0]!);
  };
  for (const raw of names) {
    const brand = brandOf(raw);
    for (const n of brand ? [raw, brand] : [raw]) {
      add(companyQuery(n));
      add(coreQuery(n));
      const own = tokens(n);
      // the first word and the letters-into-digits head start a word of the name; an acronym does not
      for (const [f] of shortNames(n)) if (f && own.some((w) => w.startsWith(f))) add(f);
    }
  }
  return { multi: [...multi], single: [...single] };
}

const ID_TOKEN = /\b[A-Za-z0-9]{8,18}\b/g;

function knownIdMatcher(ids: readonly string[]): Matcher | null {
  const set = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (id.length < 8 || isPlaceholderId(id)) continue;
    set.add(id);
    if (id.length === 18) set.add(id.slice(0, 15));
  }
  if (!set.size) return null;
  return { category: 'knownIds', count: (l) => countMatches(l, ID_TOKEN, (m) => set.has(m) || (m.length === 18 && set.has(m.slice(0, 15)))) };
}

export function buildMatchers(lists: NameLists, placeholders: ReadonlySet<string> = new Set()): Matcher[] {
  const ph = new Set([...placeholders].map((p) => p.toLowerCase()));
  const short = accountShortForms(lists.accounts, ph);
  const named = [
    nameMatcher('owner', usableNames(lists.owner)),
    nameMatcher('accounts', usableNames([...lists.accounts, ...short.multi], ph, { stripSuffix: true }), short.single),
    // a one-word opportunity name ("Renewal") is a common word, not a deal
    nameMatcher('opportunities', usableNames(lists.opportunities, ph, { minWords: 2 })),
    // a first name alone is too common to mean anything: people need a full name
    nameMatcher('people', usableNames(lists.people, ph, { minWords: 2 })),
    knownIdMatcher(lists.ids ?? []),
  ].filter((m): m is Matcher => m !== null);
  return [...named, ...ID_MATCHERS];
}

/** Very long lines are minified or encoded blobs: only their head is scanned. */
const MAX_LINE = 4000;

export function scanLine(line: string, matchers: readonly Matcher[], into: Counts = {}): Counts {
  const l = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
  for (const m of matchers) {
    const n = m.count(l);
    if (n) into[m.category] = (into[m.category] ?? 0) + n;
  }
  return into;
}

export function scanText(text: string, matchers: readonly Matcher[]): Counts {
  const out: Counts = {};
  for (const line of text.split('\n')) scanLine(line, matchers, out);
  return out;
}

export const total = (c: Counts) => Object.values(c).reduce((a, b) => a + (b ?? 0), 0);

/** Hits that fail the run: every category but placeholder-shaped ids. */
export const findings = (c: Counts) => FINDING_CATEGORIES.reduce((a, k) => a + (c[k] ?? 0), 0);

export function addCounts(into: Counts, more: Counts): Counts {
  for (const [k, v] of Object.entries(more) as [PrivateCategory, number][]) into[k] = (into[k] ?? 0) + v;
  return into;
}

export function formatCounts(c: Counts): string {
  return CATEGORIES.filter((k) => c[k])
    .map((k) => `${CATEGORY_LABEL[k]} ${c[k]}`)
    .join(' · ');
}

export interface FileHit {
  path: string;
  counts: Counts;
  /** History only: commits whose added lines hit in this path. */
  commits?: number;
}

/** Report lines: a path and its counts, never a matched value. */
export function formatHits(hits: readonly FileHit[]): string[] {
  const sorted = [...hits].sort((a, b) => total(b.counts) - total(a.counts) || a.path.localeCompare(b.path));
  const w = Math.min(64, Math.max(10, ...sorted.map((h) => h.path.length)));
  return sorted.map((h) => `  ${h.path.padEnd(w)}  ${h.commits !== undefined ? `${h.commits} commit${h.commits === 1 ? '' : 's'} · ` : ''}${formatCounts(h.counts)}`);
}

/** Files git would never publish usefully, and that cannot hold names (lockfiles). */
export function skipPath(path: string): boolean {
  return /(^|\/)(package-lock\.json|node_modules\/)/.test(path) || /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz)$/i.test(path);
}

/**
 * The database names Command Center has had (D-101): 1.x installs keep control_center until the rename runs. The scan
 * reads names from whichever one answers, the resolved URL's own name first. Other names (a URL you set) stand alone.
 */
export const DB_NAME_PATTERN = /^(command|control)_center$/;
export function databaseUrlCandidates(url: string): string[] {
  const m = /^(postgres(?:ql)?:\/\/[^/?#]*\/)([^?#]*)(.*)$/.exec(url);
  if (!m || !DB_NAME_PATTERN.test(decodeURIComponent(m[2]!))) return [url];
  const name = decodeURIComponent(m[2]!);
  const other = name === 'command_center' ? 'control_center' : 'command_center';
  return [url, `${m[1]}${other}${m[3]}`];
}
