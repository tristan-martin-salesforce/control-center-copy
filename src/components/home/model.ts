/**
 * Pure helpers for the Home view: selection targets, optimistic cache edits and display formatting.
 * Kept free of React so tests/home can exercise them directly.
 */
import type { HomeCard, HomeClosedNow, HomePayload, HomeRibbonBlock, HomeRow, HomeSectionId, HomeState, NotNowReason } from '@/contract';
import { overlapClusters, overlapsBox, packColumns } from '@/components/domain/lib/lanes';

/** A selectable thing on Home: a Do now card or a section row. j/k walks them in DOM order. */
export interface HomeTarget {
  key: string;
  kind: 'card' | 'row';
  section: HomeSectionId | null;
  title: string;
  entity: { kind: HomeRow['entity']['kind']; id: string; label?: string };
  card?: HomeCard;
  row?: HomeRow;
}

export const cardKey = (c: Pick<HomeCard, 'id'>) => `c:${c.id}`;
export const rowKey = (section: HomeSectionId, r: Pick<HomeRow, 'id'>) => `r:${section}:${r.id}`;

export function homeTargets(h: HomePayload | undefined): HomeTarget[] {
  if (!h) return [];
  const out: HomeTarget[] = h.doNow.cards.map((card) => ({ key: cardKey(card), kind: 'card', section: null, title: card.title, entity: card.entity, card }));
  for (const s of h.sections) for (const row of s.rows) out.push({ key: rowKey(s.id, row), kind: 'row', section: s.id, title: row.title, entity: row.entity, row });
  return out;
}

/**
 * Does this target own the entity open in Details? A card owns its own entity and, for the Outbox card, every
 * ready draft in its queue (`draftIds`): stepping through the drafts keeps the card marked open.
 */
export function targetOwns(t: HomeTarget, entityId: string): boolean {
  return t.entity.id === entityId || (t.card?.draftIds ?? []).includes(entityId);
}

/** The target already shows one of its queue's drafts (not its own entity): j/k, Enter and a click keep it there. */
export const holdsOpen = (t: HomeTarget, openEntityId: string | null | undefined): boolean => !!openEntityId && openEntityId !== t.entity.id && targetOwns(t, openEntityId);

/** The key of the target whose entity is open in Details: the selection when it owns it, else the first owner. */
export function openKeyFor(targets: HomeTarget[], entityId: string | null | undefined, selectedKey: string | null): string | null {
  if (!entityId) return null;
  const sel = selectedKey ? targets.find((t) => t.key === selectedKey) : undefined;
  if (sel && targetOwns(sel, entityId)) return sel.key;
  return targets.find((t) => t.entity.id === entityId)?.key ?? targets.find((t) => targetOwns(t, entityId))?.key ?? null;
}

/** Remove a work item everywhere on Home (optimistic done / snooze). Section counts drop with it. */
export function stripItem(h: HomePayload, itemId: string): HomePayload {
  const hit = (r: HomeRow) => r.item?.id === itemId || r.id === itemId || (r.entity.kind === 'work_item' && r.entity.id === itemId);
  const cards = h.doNow.cards.filter((c) => !(c.kind === 'item' && c.id === itemId)).map((c, i) => ({ ...c, rank: i + 1 }));
  const removedCard = cards.length !== h.doNow.cards.length;
  return {
    ...h,
    doNow: { ...h.doNow, cards, total: Math.max(cards.length, h.doNow.total - (removedCard ? 1 : 0)) },
    looksDone: stripLooksDone(h.looksDone, itemId),
    sections: h.sections.map((s) => {
      const rows = s.rows.filter((r) => !hit(r));
      const gone = s.rows.length - rows.length;
      return gone ? { ...s, rows, count: Math.max(rows.length, s.count - gone), seeAllLabel: s.seeAllLabel.replace(/\d+/, String(Math.max(rows.length, s.count - gone))) } : s;
    }),
  };
}

function stripLooksDone(g: HomePayload['looksDone'] | undefined, itemId: string): HomePayload['looksDone'] {
  if (!g) return { count: 0, rows: [] };
  const rows = g.rows.filter((r) => r.id !== itemId);
  return rows.length === g.rows.length ? g : { count: Math.max(rows.length, g.count - 1), rows };
}

/**
 * Does this item action take the item off Home at once (the optimistic strip)? Everything does but Wrong account,
 * which only unlinks the account and keeps the item where it is.
 */
export function leavesHome(verb: string, reason?: NotNowReason | null): boolean {
  return !(verb === 'not-now' && reason === 'wrong_account');
}

/**
 * The toast line after a card's "Not now" reason (the same `not-now` action Details runs). `moveShort` is where
 * Later sends it ("Fri"), the day "Move to …" uses; without it the server's default, tomorrow morning.
 */
export function notNowToast(reason: NotNowReason, title: string, moveShort?: string | null): string {
  const t = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  switch (reason) {
    case 'done_elsewhere':
      return `Done elsewhere: ${t}`;
    case 'not_mine':
      return `Not mine, dismissed: ${t}`;
    case 'later':
      return `${moveShort ? `Moved to ${moveShort}` : 'Snoozed until tomorrow'}: ${t}`;
    case 'wrong_account':
      return `Account unlinked: ${t}`;
    default:
      return `Dismissed: ${t}`;
  }
}

/** A Do-now card that was closed for you while Home was open: it stays in its slot with the tag and Undo (HM-05). */
export interface ClosedInPlace {
  card: HomeCard;
  /** Its slot when it left (0-based). */
  index: number;
  closed: HomeClosedNow;
}

/**
 * Pure: the cards closed for you between two payloads. A card that was on screen, is gone from the new payload and is
 * in its `closedNow` list stays where it was; one already kept stays kept until it comes back (reopened) or is undone.
 */
export function closedInPlace(prev: readonly HomeCard[], next: Pick<HomePayload, 'doNow' | 'closedNow'>, kept: readonly ClosedInPlace[]): ClosedInPlace[] {
  const nowIds = new Set(next.doNow.cards.map((c) => c.id));
  const closed = new Map((next.closedNow ?? []).map((c) => [c.id, c]));
  const out = kept.filter((k) => !nowIds.has(k.card.id) && closed.has(k.card.id));
  const have = new Set(out.map((k) => k.card.id));
  prev.forEach((card, index) => {
    const hit = closed.get(card.id);
    if (card.kind === 'item' && hit && !nowIds.has(card.id) && !have.has(card.id)) out.push({ card, index, closed: hit });
  });
  return out;
}

/** The cards to draw: the live cards with the closed ones back in their slots, three at most. */
export function cardsWithClosed(cards: readonly HomeCard[], kept: readonly ClosedInPlace[]): Array<{ card: HomeCard; closed: HomeClosedNow | null }> {
  const keptIds = new Set(kept.map((k) => k.card.id));
  const out: Array<{ card: HomeCard; closed: HomeClosedNow | null }> = cards.filter((c) => !keptIds.has(c.id)).map((card) => ({ card, closed: null }));
  for (const k of [...kept].sort((a, b) => a.index - b.index)) out.splice(Math.min(k.index, out.length), 0, { card: k.card, closed: k.closed });
  return out.slice(0, 3);
}

/** "1h 30m", "45m", "5h". */
export function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function hmIn(iso: string | number, tz: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso));
}

/** "Thursday 5 November" */
export function longDateIn(iso: string, tz: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

/** Whole minutes from `from` to `to`. */
export const minutesFrom = (from: string | number, to: number) => Math.round((to - new Date(from).getTime()) / 60_000);

/** "18m", "3h", "2d" (no "ago": the column says it). */
export function ageShort(iso: string, nowMs: number): string {
  const m = Math.max(0, minutesFrom(iso, nowMs));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/** The glyph paired with a state color (color is never the only signal). */
export function stateGlyph(state: HomeState | null, label: string | null): string {
  switch (state) {
    case 'overdue':
      return '✕';
    case 'blocked':
      return '⊘';
    case 'ready':
      return '✓';
    case 'ai':
      return '✦';
    case 'now':
      return '●';
    case 'risk':
      if (label && /^not started/i.test(label)) return '○';
      if (label && (/^(start|due)\b/i.test(label) || /\d+\s?d$/.test(label))) return '◷';
      return '▲';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Day ribbon layout
// ---------------------------------------------------------------------------

/** Where a ribbon block sits: its lane (row) in the 44px track, and how its label may behave. */
export interface RibbonPlace {
  /** 0-based lane inside its overlap cluster, and the cluster's lane count (1 = full height). */
  lane: number;
  lanes: number;
  /** A short meeting with free track after it lets its label run past its end. Never when anything overlaps it. */
  spill: boolean;
  /** How far a spilling label may run (epoch ms): the next block's start or the window's end. Null without spill. */
  spillTo: number | null;
  /** A meeting of 30 minutes or less. */
  short: boolean;
  /** A declined ghost that shares time with a real block: a thin band under it, never drawn over it. */
  band: boolean;
  /** A real block that shares time with a band: it leaves the band's strip at the bottom free. */
  overBand: boolean;
}

type RibbonBox = { i: number; s: number; e: number; col: number; cols: number };

const SHORT_MS = 30 * 60_000;
const SPILL_ROOM_MS = 55 * 60_000;

/**
 * Lay out the ribbon (pure): real blocks (meetings, agent runs, the open block) that overlap share the track
 * height in lanes, packed like a calendar; declined ghosts stack among themselves, and a ghost cluster that
 * shares time with any real block becomes a thin band beneath it. A short meeting may spill its label into
 * free track after it only when nothing overlaps it and nothing starts within the next hour.
 */
export function ribbonLayout(blocks: Pick<HomeRibbonBlock, 'kind' | 'start' | 'end'>[], windowEnd = Infinity): RibbonPlace[] {
  const box = (i: number): RibbonBox => ({ i, s: Date.parse(blocks[i]!.start), e: Date.parse(blocks[i]!.end), col: 0, cols: 1 });
  const all = blocks.map((_, i) => box(i));
  const solid = all.filter((b) => blocks[b.i]!.kind !== 'declined');
  const ghosts = all.filter((b) => blocks[b.i]!.kind === 'declined');
  packColumns(solid);
  packColumns(ghosts);
  const banded = new Set<number>();
  for (const cluster of overlapClusters(ghosts)) if (cluster.some((g) => solid.some((x) => overlapsBox(g, x)))) for (const g of cluster) banded.add(g.i);
  return all.map((b) => {
    const kind = blocks[b.i]!.kind;
    const band = banded.has(b.i);
    const others = all.filter((x) => x.i !== b.i);
    const overlapped = others.some((x) => overlapsBox(b, x));
    const short = kind === 'meeting' && b.e - b.s <= SHORT_MS;
    const nextStart = others.filter((x) => x.s >= b.e).reduce((m, x) => Math.min(m, x.s), Infinity);
    const spill = short && !overlapped && nextStart - b.e >= SPILL_ROOM_MS;
    return {
      lane: band ? 0 : b.col,
      lanes: band ? 1 : b.cols,
      spill,
      spillTo: spill ? Math.min(nextStart, windowEnd) : null,
      short,
      band,
      overBand: kind !== 'declined' && ghosts.some((g) => banded.has(g.i) && overlapsBox(b, g)),
    };
  });
}

/** The most lanes any cluster needs (bands excluded): the track grows past two. */
export const ribbonMaxLanes = (places: RibbonPlace[]): number => Math.max(1, ...places.filter((p) => !p.band).map((p) => p.lanes));
