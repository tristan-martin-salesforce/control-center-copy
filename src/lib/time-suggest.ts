/**
 * What the app suggests for a Time row that needs an opportunity (Time ▸ Needs you, the row's details, the picker):
 * internal work, or which opportunity, with a short reason and how sure it is. Pure over contract records, so the
 * mock and the db DataSource attach the same suggestion to the same row (GET /time, GET /time/log, PATCH answers).
 *
 * Two passes, the cheap one first:
 *   rules   deterministic, from what the app already knows (src/lib/opp-options.ts ranks the row's opps): the meeting's
 *           own opp; the row's account (its only open opp, else the one you logged to last); an account its evidence
 *           names (attendees, its Drive file); an attendee's email domain or a Slack channel's name that names an
 *           account. Confidence is fixed per rule (RULE_CONFIDENCE), so the same row always reads the same.
 *   ai      the cheap model's answer (`activity.suggest`, src/jobs/handlers/activity-suggest.ts), stored in kv
 *           SUGGESTIONS_KV per row with the hash of the inputs it saw (suggestKey): only for rows the rules don't
 *           settle (below RULES_SETTLE), and only while those inputs are unchanged. It may say Internal.
 *
 * Nothing is applied for you: the UI shows the suggestion with Accept (one click, or Accept for many rows); the
 * owner asked to verify these (2026-11-14). Color: the AI color, the app's guess (rules or model).
 */
import type { Account, ActivityEntry, ActivitySuggestion, AgentRun, Asset, CalendarEvent, OppOption, Opportunity, Person } from '@/contract';
import { RULE_CONFIDENCE, attendeeDomains, rowAttribution, type RowExtras } from '@/engines/attribution/row';
import { groundworkIndex, rowGroundwork } from '@/engines/attribution/target';
import { hasTarget } from '@/lib/time-internal';

export { RULE_CONFIDENCE, attendeeDomains };

/** kv key (db) of the model's stored answers: `{ rows: { [rowId]: StoredSuggestion } }`. */
export const SUGGESTIONS_KV = 'cc.time.suggestions';
/** Bump when the prompt or the inputs change meaning: stored answers made for another version are asked again. */
export const SUGGEST_PROMPT_VERSION = 'activity-suggest@1';
/** A rules suggestion this sure settles the row: no model call. */
export const RULES_SETTLE = 0.75;
/** The model pass asks only about rows of the last this many days (older held rows keep the rules' suggestion). */
export const SUGGEST_LOOKBACK_DAYS = 60;


/** One stored model answer for a row (kv SUGGESTIONS_KV). */
export interface StoredSuggestion {
  /** suggestKey of the row when it was asked (a changed row is asked again). */
  key: string;
  kind: 'opp' | 'internal';
  oppId: string | null;
  /** Internal: the internal type it would take. */
  taskType: string | null;
  confidence: number;
  reason: string;
  model: string;
  at: string;
}

export interface SuggestContext {
  opps: Opportunity[];
  accounts: Account[];
  events: CalendarEvent[];
  people: Person[];
  assets: Asset[];
  runs: AgentRun[];
  workItems: Array<{ id: string; accountId: string | null; oppId: string | null }>;
  activity: ActivityEntry[];
  /** Today, local (YYYY-MM-DD). */
  today: string;
  /** The model's stored answers by row id. */
  stored: Record<string, StoredSuggestion>;
  /** D-64: the persona logs internal-only work (the model may say Internal). */
  internalActivity: boolean;
  /** What the attribution engine reads besides the records (learned rules, the channel map, engagement, covered AEs). */
  attribution?: RowExtras;
}

const LIVE = new Set<ActivityEntry['status']>(['needs_input', 'proposed', 'approved']);

/** The row asks for an opportunity: live, no opp, not internal, not read from Org62, not held on a canvas. */
export function wantsSuggestion(e: ActivityEntry): boolean {
  return LIVE.has(e.status) && !hasTarget(e) && !e.fromOrg62 && !e.canvasDraftId;
}

/** FNV-1a 32-bit, hex: a stable, dependency-free hash (client and server). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The inputs a model answer was made from: the prompt version, what the row says, its account and its sources. */
export function suggestKey(e: Pick<ActivityEntry, 'description' | 'accountName' | 'sources' | 'durationH'>): string {
  const src = e.sources.map((s) => `${s.kind}|${s.label}|${s.externalId ?? ''}`).join('\n');
  return `${SUGGEST_PROMPT_VERSION}:${fnv(`${e.description}\u0000${e.accountName ?? ''}\u0000${src}`)}`;
}

export function storedSuggestionsOf(v: unknown): Record<string, StoredSuggestion> {
  const rows = (v as { rows?: unknown } | null | undefined)?.rows;
  if (!rows || typeof rows !== 'object') return {};
  const out: Record<string, StoredSuggestion> = {};
  for (const [id, x] of Object.entries(rows as Record<string, Partial<StoredSuggestion>>)) {
    if (!x || (x.kind !== 'opp' && x.kind !== 'internal') || typeof x.key !== 'string' || typeof x.confidence !== 'number') continue;
    out[id] = { key: x.key, kind: x.kind, oppId: x.oppId ?? null, taskType: x.taskType ?? null, confidence: Math.max(0, Math.min(1, x.confidence)), reason: String(x.reason ?? '').slice(0, 240), model: String(x.model ?? ''), at: String(x.at ?? '') };
  }
  return out;
}

/**
 * The rules pass: the attribution engine's answer for the row (src/engines/attribution/row.ts): the legacy rules
 * (moved there unchanged) unless a learned rule or the confirmed channel map says otherwise.
 */
export function ruleSuggestion(e: ActivityEntry, ctx: Omit<SuggestContext, 'stored' | 'internalActivity'> & { internalActivity?: boolean }, opts?: OppOption[]): ActivitySuggestion | null {
  return rowAttribution(e, ctx, { ...(opts ? { options: opts } : {}), internalOk: !!ctx.internalActivity }).suggestion;
}

/** The model's stored answer for the row, when it was made for the row as it is now and its opp still exists. */
export function storedSuggestion(e: ActivityEntry, ctx: Pick<SuggestContext, 'stored' | 'opps' | 'accounts' | 'internalActivity'>): ActivitySuggestion | null {
  const s = ctx.stored[e.id];
  if (!s || s.key !== suggestKey(e)) return null;
  if (s.kind === 'internal') {
    if (!ctx.internalActivity) return null;
    return { kind: 'internal', oppId: null, oppName: null, accountName: null, taskType: s.taskType, confidence: s.confidence, reason: s.reason, basis: 'ai', at: s.at || null };
  }
  const opp = ctx.opps.find((o) => o.id === s.oppId);
  if (!opp) return null;
  return { kind: 'opp', oppId: opp.id, oppName: opp.name, accountName: ctx.accounts.find((a) => a.id === opp.accountId)?.name ?? null, taskType: null, confidence: s.confidence, reason: s.reason, basis: 'ai', at: s.at || null };
}

/** The one suggestion a row shows: a rules answer that settles it, else the model's (when surer), else the rules'. */
export function suggestionFor(e: ActivityEntry, ctx: SuggestContext): ActivitySuggestion | null {
  return suggestionsFor(e, ctx).one;
}

/**
 * The row's suggestion (`one`, null when nothing points anywhere) and the engine's ranked top 3 with it first
 * (`list`: the alternates Accept can take in one click); nothing on rows that don't need one.
 */
export function suggestionsFor(e: ActivityEntry, ctx: SuggestContext): { one: ActivitySuggestion | null; list: ActivitySuggestion[]; learnedOn?: string | null } {
  if (!wantsSuggestion(e)) return { one: null, list: [] };
  const r = rowAttribution(e, ctx, { internalOk: ctx.internalActivity });
  const one = pickOne(e, ctx, r.suggestion);
  const rest = r.suggestions.filter((x) => !one || !(x.kind === one.kind && x.oppId === one.oppId));
  // D-103 (c): a learned rule made the pick: the day it was last used is when I taught it
  const top = r.attribution.top;
  const ruleId = one && top && top.kind === 'opp' && top.oppId === one.oppId ? top.why.find((w) => w.code === 'rule')?.ruleId : undefined;
  const rule = ruleId ? ctx.attribution?.rules?.find((x) => x.id === ruleId) : undefined;
  return { one, list: (one ? [one, ...rest] : rest).slice(0, 3), learnedOn: rule?.lastUsedAt ?? null };
}

/** The rules' answer when it settles the row, else the model's (when surer), else the rules'. */
function pickOne(e: ActivityEntry, ctx: SuggestContext, rule: ActivitySuggestion | null): ActivitySuggestion | null {
  if (rule && rule.confidence >= RULES_SETTLE) return rule;
  const ai = storedSuggestion(e, ctx);
  if (ai && (!rule || ai.confidence >= rule.confidence)) return ai;
  return rule ?? ai;
}

/** Every row with its suggestion (null on rows that don't need one). */
export function withSuggestions(entries: readonly ActivityEntry[], ctx: SuggestContext): ActivityEntry[] {
  const ix = groundworkIndex(ctx);
  return entries.map((e) => {
    const { one, list, learnedOn } = suggestionsFor(e, ctx);
    // D-103 (c): every row says why it logs where it does (src/engines/attribution/target.ts)
    const groundwork = rowGroundwork(e, ix, { suggestedOppId: one?.kind === 'opp' ? one.oppId : null, learnedOn });
    const out = one || e.suggestion || list.length ? { ...e, suggestion: one, suggestions: list } : e;
    return groundwork ? { ...out, groundwork } : out;
  });
}

/** Rows the model pass would ask about: no rules answer that settles them, no stored answer for their inputs. */
export function rowsForModel(entries: readonly ActivityEntry[], ctx: SuggestContext): ActivityEntry[] {
  return entries.filter((e) => {
    if (!wantsSuggestion(e)) return false;
    const rule = ruleSuggestion(e, ctx);
    if (rule && rule.confidence >= RULES_SETTLE) return false;
    return ctx.stored[e.id]?.key !== suggestKey(e);
  });
}
