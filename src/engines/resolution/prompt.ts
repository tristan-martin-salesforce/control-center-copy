/**
 * The resolution check's prompt (skills/resolve-item.md) and its reply. The system prompt is the skill body only (static,
 * byte-stable: the cached prefix); the user prompt is `now`, `me` and up to 8 packs (items sharing a conversation batch
 * together), each with its own line aliases, so a reply can only cite a line of that item. Never more than the packs.
 */
import { z } from 'zod';

import { extractJsonObject } from '@/engines/nba/prompt/json';

import { packLines, renderPack } from './pack';
import { RESOLUTION_BASES, RESOLUTION_VERDICTS, type ModelVerdict, type PackLine, type ResolutionPack } from './types';

const minute = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';

export function renderBatchPrompt(packs: ResolutionPack[], ctx: { now: Date; me: string }): { user: string; aliases: string[] } {
  const aliases = packs.map((_, i) => `w${i + 1}`);
  const items = packs.map((p, i) => renderPack(p, aliases[i]!));
  return { user: `{"now":${JSON.stringify(minute(ctx.now))},"me":${JSON.stringify(ctx.me)},"items":[${items.join(',')}]}`, aliases };
}

const Reply = z.object({
  verdicts: z.array(
    z.object({
      item: z.string(),
      verdict: z.enum(RESOLUTION_VERDICTS),
      basis: z.enum(RESOLUTION_BASES).nullish().catch(undefined),
      cite: z.string().nullish(),
      confidence: z.coerce.number().min(0).max(1).catch(0),
      needs: z.string().nullish(),
    }),
  ),
});

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The citation rules (Settle's, kept): done cites my line, a file of mine or a session after the ask; done_by_other someone else's line. */
export function citeProblem(v: { verdict: string; cite: PackLine | null; citeAlias?: string | null }, p: ResolutionPack): string | undefined {
  const c = v.cite;
  if (v.citeAlias && !c) return `cited ${v.citeAlias}, which is not a line of this item`;
  const askMs = p.ask?.at ? Date.parse(p.ask.at) : NaN;
  const afterAsk = !!c && c.kind !== 'before' && c.kind !== 'sibling' && (!Number.isFinite(askMs) || !c.at || Date.parse(c.at) >= askMs - 60_000);
  if (v.verdict === 'done' && !(c && c.fromMe && afterAsk) && !(c && (c.kind === 'notes' || c.byAsker) && afterAsk)) return 'done must cite my line, file or session after the ask (or the asker confirming it)';
  if (v.verdict === 'done_by_other' && !(c && !c.fromMe && c.kind !== 'event' && afterAsk)) return "done_by_other must cite someone else's line after the ask";
  if (v.verdict === 'duplicate' && !(c && c.kind === 'sibling')) return 'duplicate must name a sibling';
  if (v.verdict === 'waiting_on_them' && !(c && c.fromMe && afterAsk)) return 'waiting_on_them must cite my question after the ask';
  return undefined;
}

export interface ParsedBatch {
  /** By item alias. */
  verdicts: Map<string, ModelVerdict>;
  error?: string;
}

export function parseBatchReply(text: string, packs: ResolutionPack[], aliases: string[]): ParsedBatch {
  const raw = extractJsonObject(text);
  if (raw.error) return { verdicts: new Map(), error: raw.error };
  // A single-item reply may come back as the object itself.
  const value = raw.value && typeof raw.value === 'object' && !('verdicts' in (raw.value as object)) && 'verdict' in (raw.value as object) ? { verdicts: [{ item: aliases[0], ...(raw.value as object) }] } : raw.value;
  const p = Reply.safeParse(value);
  if (!p.success) return { verdicts: new Map(), error: 'reply does not match {"verdicts":[…]}' };
  const out = new Map<string, ModelVerdict>();
  for (const v of p.data.verdicts) {
    const i = aliases.indexOf(v.item);
    if (i < 0 || out.has(v.item)) continue;
    const pack = packs[i]!;
    const cite = v.cite ? (packLines(pack).get(v.cite) ?? null) : null;
    const problem = citeProblem({ verdict: v.verdict, cite, citeAlias: v.cite ?? null }, pack);
    out.set(v.item, {
      verdict: v.verdict,
      basis: v.basis ?? 'none',
      confidence: v.confidence,
      cite,
      needs: v.needs ? clip(v.needs, 120) : null,
      valid: !problem,
      ...(problem ? { invalidWhy: problem } : {}),
    });
  }
  return { verdicts: out };
}
