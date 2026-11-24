/**
 * Shadow comparison (lane 07 R8): priority@1.1 and priority@2 rank the same inputs; Health shows how often their Top 3
 * agree and the biggest disagreements. Pure.
 */

/** |A ∩ B| / 3 over the first three of each (1.00 = the same three items, in any order). */
export function agreementAt3(a: readonly string[], b: readonly string[]): number {
  const x = a.slice(0, 3);
  const y = new Set(b.slice(0, 3));
  const n = Math.max(1, Math.min(3, Math.max(x.length, y.size)));
  return Math.round((x.filter((id) => y.has(id)).length / n) * 100) / 100;
}

export interface Disagreement {
  workItemId: string;
  title: string;
  /** 1-based rank under each engine (null = not ranked there). */
  v1Rank: number | null;
  v2Rank: number | null;
  /** |v1Rank − v2Rank| (an item missing from one side counts as one past its end). */
  delta: number;
}

/** The items whose rank differs most between the two orders, among each side's top `window`. */
export function disagreements(v1: readonly string[], v2: readonly string[], titleOf: (id: string) => string, o: { window?: number; limit?: number } = {}): Disagreement[] {
  const window = o.window ?? 10;
  const limit = o.limit ?? 3;
  const ids = [...new Set([...v1.slice(0, window), ...v2.slice(0, window)])];
  const pos = (list: readonly string[], id: string) => {
    const i = list.indexOf(id);
    return i < 0 ? null : i + 1;
  };
  return ids
    .map((id) => {
      const a = pos(v1, id);
      const b = pos(v2, id);
      const delta = Math.abs((a ?? v1.length + 1) - (b ?? v2.length + 1));
      return { workItemId: id, title: titleOf(id), v1Rank: a, v2Rank: b, delta };
    })
    .filter((d) => d.delta > 0)
    .sort((x, y) => y.delta - x.delta || (Math.min(x.v1Rank ?? 99, x.v2Rank ?? 99) - Math.min(y.v1Rank ?? 99, y.v2Rank ?? 99)) || x.workItemId.localeCompare(y.workItemId))
    .slice(0, limit);
}
