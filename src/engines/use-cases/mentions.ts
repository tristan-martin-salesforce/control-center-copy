/** Use-case mentions over many sources (the extractor per source, split by certainty). Pure. */
import { extractMentions, type ExtractOptions } from './extract';
import type { UcMention, UcSource } from './types';

/** Every source's mentions, split: the sure ones count as they are; the unsure ones wait for the model. */
export function mentionsOf(sources: readonly UcSource[], o: ExtractOptions = {}): { sure: Map<string, UcMention[]>; unsure: Map<string, UcMention[]> } {
  const sure = new Map<string, UcMention[]>();
  const unsure = new Map<string, UcMention[]>();
  for (const s of sources) {
    const ms = extractMentions(s, o);
    const a = ms.filter((m) => m.certainty === 'sure');
    const b = ms.filter((m) => m.certainty === 'unsure');
    if (a.length) sure.set(s.key, a);
    if (b.length) unsure.set(s.key, b);
  }
  return { sure, unsure };
}
