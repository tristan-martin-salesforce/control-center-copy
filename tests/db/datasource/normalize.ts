/**
 * The documented normalizations applied before comparing mock and db values (see tests/db/datasource/README.md):
 *
 * N1 PersonRefs embedded in records are compared by {id, name}: the db resolves refs from `people`, so a
 *    ref may carry the person's role / isExternal where the mock's snapshot omitted them.
 * N2 Lock lists (userLockedFields) are compared as sets: the db keeps them sorted.
 * N3 Runtime ids (nanoid in the mock, gen_random_uuid in Postgres) and audit ids are replaced by
 *    placeholders in first-seen order; seed ids are translated (translate.ts) before comparing.
 * N4 Timestamps written at request time (audit `at`, updatedAt of rows a mutation touched, receipt ids)
 *    are replaced by placeholders when a test passes `times: true`.
 */
const PERSON_KEYS = new Set(['id', 'name', 'role', 'isManager', 'isExternal']);

function isPersonRef(v: unknown): v is { id: string; name: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.includes('id') && keys.includes('name') && keys.every((k) => PERSON_KEYS.has(k));
}

export function normalizeValue(v: unknown, key: string | null = null): unknown {
  if (Array.isArray(v)) {
    const arr = v.map((x) => normalizeValue(x));
    if (key === 'userLockedFields' || key === 'lockedFields') return [...(arr as string[])].sort();
    return arr;
  }
  if (isPersonRef(v)) return { id: v.id, name: v.name };
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      out[k] = normalizeValue(x, k);
    }
    return out;
  }
  return v;
}

export function normalizeRecord(col: string, r: unknown): unknown {
  if (col === 'people') return r; // the directory itself is compared in full
  return normalizeValue(r);
}

/**
 * N6 Composite row keys carry a seed id after a prefix ("fix:<account>", "gap:connector:<id>"), and a needs row's
 *    baseline lists its subjects ("a,b,c"): the mock side's seed ids in them are translated like plain ids (lists
 *    re-sorted after), so both sides compare on the same keys.
 */
const COMPOSITE = /^((?:fix|ahead|chase|gap:connector|gap:expenses|ini):)(.+)$/;
export function translateComposite(v: unknown, map: ReadonlyMap<string, string>, key: string | null = null): unknown {
  const one = (s: string) => s.replace(COMPOSITE, (_m, p: string, tail: string) => p + (map.get(tail) ?? tail));
  if (typeof v === 'string') {
    if (key === 'subjects') return v.split(',').filter(Boolean).map((s) => map.get(s) ?? s).sort().join(',');
    return key === 'id' || key === 'subjectId' || key === 'subjectIds' ? one(v) : v;
  }
  if (Array.isArray(v)) return v.map((x) => translateComposite(x, map, key === 'subjectIds' ? key : null));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, translateComposite(x, map, k)]));
  return v;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** N3/N4: replace ids not in `stable` and (optionally) instants with first-seen placeholders. */
export function placeholders(v: unknown, stable: Set<string>, opts: { times?: boolean; idPattern?: RegExp } = {}): unknown {
  const seen = new Map<string, string>();
  const idRe = opts.idPattern ?? /^(aud|rcpt|w|ev|nba|dr|dcr|prop|run|tr|scan|watch|chip|msg|tool|att|evt|thread)_[A-Za-z0-9_-]{6,}$/;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      if (stable.has(x)) return x;
      if (UUID.test(x) || idRe.test(x) || /^\d{1,7}$/.test(x)) {
        if (!seen.has(x)) seen.set(x, `<id${seen.size + 1}>`);
        return seen.get(x);
      }
      if (opts.times && ISO.test(x)) return '<at>';
      if (x.startsWith('/')) {
        return x.replace(/[A-Za-z0-9_-]+/g, (tok) => {
          if (stable.has(tok) || !(UUID.test(tok) || idRe.test(tok))) return tok;
          if (!seen.has(tok)) seen.set(tok, `<id${seen.size + 1}>`);
          return seen.get(tok)!;
        });
      }
      return x;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v);
}
