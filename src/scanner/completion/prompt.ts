/**
 * The completion check's prompt (skills/check-completion.md) and its JSON verdicts.
 *
 * The system prompt is the skill body only (static, byte-stable, cached across calls). The user prompt is one
 * JSON object with short aliases (`w1`, `s1`) instead of uuids, so the model cannot mistype an id and a reply can
 * only cite a candidate of the same item. Texts are already credential-redacted at ingest and are clipped here.
 */
import { z } from 'zod';

import { extractJsonObject } from '@/engines/nba/prompt/json';

import { BASES, type Candidate, type CompletionItem, type ItemVerdict, type Relation } from './types';
import type { ItemFacts } from './candidates';

const WHERE: Record<Relation, string> = {
  same_thread: 'same thread',
  context_thread: 'a related thread',
  same_dm: 'same DM',
  same_email_thread: 'same email thread',
  to_asker: 'to the asker',
  from_asker: 'from the asker',
  same_channel: 'same channel',
  same_file: "the item's file",
  same_event: 'calendar event',
  same_account: 'same account',
  ack: 'the asker acknowledging my line',
  file_revision: "a revision of the item's file",
  meeting_notes: 'meeting notes',
  session: 'a Claude session',
};

const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const minute = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : iso;
};

export interface BatchEntry {
  item: CompletionItem;
  facts: ItemFacts;
  candidates: Candidate[];
}

/** Alias tables of one rendered batch. */
export interface BatchIds {
  items: Map<string, BatchEntry>;
  /** `s<n>` → the candidate and the item alias it belongs to. */
  sources: Map<string, { itemAlias: string; candidate: Candidate }>;
}

const byLabel = (fromMe: boolean, name: string | undefined) => (fromMe ? 'me' : name?.trim() || 'someone');

function candidateText(c: Candidate): string {
  const s = c.source;
  if (s.connector === 'calendar') {
    const who = (s.participants ?? []).filter((p) => !p.isMe).map((p) => p.name ?? p.email).filter(Boolean).slice(0, 6).join(', ');
    return clip(`Calendar event "${s.title ?? ''}" at ${minute(s.occurredAt)}${who ? ` with ${who}` : ''}. ${s.text ?? ''}`, 500);
  }
  if (s.connector === 'gmail') return clip(`Subject: ${s.title ?? ''}. ${s.text ?? ''}`, 700);
  if (s.connector === 'gemini_notes') return clip(`Meeting notes "${s.title ?? ''}": ${s.text ?? ''}`, 900);
  if (s.connector === 'claude_sessions') return clip(`Claude session "${s.title ?? ''}": ${s.text ?? ''}`, 600);
  if (s.connector === 'drive') return clip(`File revision "${s.title ?? ''}": ${s.text ?? ''}`, 600);
  return clip(s.text || s.title, 700);
}

/** Render one batch. Returns the user prompt and the alias tables to map the reply back. */
export function renderBatch(entries: BatchEntry[], ctx: { now: string; meName: string }): { user: string; ids: BatchIds } {
  const ids: BatchIds = { items: new Map(), sources: new Map() };
  let n = 0;
  const items = entries.map((e, i) => {
    const alias = `w${i + 1}`;
    ids.items.set(alias, e);
    const origin = e.facts.origins[0];
    const candidates = e.candidates.map((c) => {
      n += 1;
      const sAlias = `s${n}`;
      ids.sources.set(sAlias, { itemAlias: alias, candidate: c });
      const files = c.source.fileRefs.slice(0, 3);
      return {
        id: sAlias,
        at: minute(c.source.occurredAt),
        by: byLabel(c.source.fromMe, c.source.author?.name ?? c.source.author?.email),
        where: c.relations.map((r) => WHERE[r]).join(', '),
        text: candidateText(c),
        ...(files.length ? { files } : {}),
      };
    });
    return {
      id: alias,
      kind: e.item.kind,
      title: clip(e.item.title, 160),
      ...(e.item.purpose ? { purpose: clip(e.item.purpose, 160) } : {}),
      ...(e.item.due ? { due: minute(e.item.due) } : {}),
      asker: e.facts.counterpartNames.slice(0, 3).join(', ') || 'unknown',
      askedAt: minute(e.facts.askAtIso),
      ...(origin ? { askBy: byLabel(origin.fromMe, origin.author?.name ?? origin.author?.email), ask: clip(origin.text, 500) } : {}),
      candidates,
    };
  });
  return { user: JSON.stringify({ now: minute(ctx.now), me: ctx.meName, items }), ids };
}

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      item: z.string(),
      verdict: z.enum(['done', 'partial', 'not_done']),
      source: z.string().nullish(),
      confidence: z.coerce.number().min(0).max(1).catch(0),
      basis: z.enum(BASES).nullish().catch(undefined),
      reason: z.string().nullish(),
    }),
  ),
});

export interface ParsedVerdicts {
  verdicts: Array<ItemVerdict & { candidate?: Candidate; itemAlias: string }>;
  /** Entries that cited an unknown item, or a source that is not that item's candidate. */
  invalid: number;
  error?: string;
}

/** Parse a reply. Unknown aliases are dropped; a done/partial citing another item's candidate is invalid. */
export function parseVerdicts(text: string, ids: BatchIds): ParsedVerdicts {
  const raw = extractJsonObject(text);
  if (raw.error) return { verdicts: [], invalid: 0, error: raw.error };
  const p = verdictSchema.safeParse(raw.value);
  if (!p.success) return { verdicts: [], invalid: 0, error: 'reply does not match {"verdicts":[…]}' };
  const out: ParsedVerdicts['verdicts'] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const v of p.data.verdicts) {
    const entry = ids.items.get(v.item);
    if (!entry || seen.has(v.item)) {
      invalid += 1;
      continue;
    }
    seen.add(v.item);
    const src = v.source ? ids.sources.get(v.source) : undefined;
    const cited = src && src.itemAlias === v.item ? src.candidate : undefined;
    if (v.verdict !== 'not_done' && !cited) {
      invalid += 1;
      continue;
    }
    out.push({
      itemAlias: v.item,
      workItemId: entry.item.workItemId,
      verdict: v.verdict,
      ...(cited ? { sourceItemId: cited.source.sourceItemId, candidate: cited } : {}),
      confidence: v.confidence,
      ...(v.basis ? { basis: v.basis } : {}),
      reason: clip(v.reason ?? '', 160),
    });
  }
  return { verdicts: out, invalid };
}
