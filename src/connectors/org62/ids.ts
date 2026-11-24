/**
 * D-98 (DM-6): Org62 record ids, one way. Org62 returns 18-character ids (case-safe), while VDP, canvases, links and
 * older rows carry the 15-character form (case-sensitive): the first 15 characters are the same record. Compare
 * through these helpers in TypeScript, and through the generated `*_id15` columns (0036) in SQL, never by hand.
 * Pure.
 */

/** A Salesforce id: 15 or 18 alphanumerics (optionally of one key prefix: `006` Opportunity, `001` Account, …). */
export function isOrg62Id(v: string | null | undefined, prefix?: string): v is string {
  if (!v || !/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(v)) return false;
  return !prefix || v.startsWith(prefix);
}

/** The 15-character form ('' for none), what the `*_id15` columns hold: `left(id, 15)`. */
export const id15 = (v: string | null | undefined): string => (v ?? '').slice(0, 15);

/** Two ids name the same record (15 vs 18 characters agree). Empty never matches. */
export function sameOrg62Id(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = id15(a);
  return x.length > 0 && x === id15(b);
}

/** A key for maps and sets that must treat the 15- and 18-character forms of an id as one. */
export const org62Key = id15;
