/**
 * The ongoing VDP asset matcher over Postgres (worker hook `vdp.assets`, every few minutes): source items the scanners
 * stored since the last pass (Drive files, Slack messages with links or files, Gmail messages with links, calendar
 * events with attachments) → asset candidates for my VDPs and for engaged accounts without one, through the pure
 * matcher in src/engines/vdp/assets.ts. Deterministic: no model call per item; unsure matches wait for a confirm.
 *
 * Which account: the app's own mapping first (a Drive file's account, a Slack channel mapped to the account), then the
 * projections' account matcher (names, aliases, short names, meeting domains) over the asset's title, then over the
 * message. Re-running a window is free: candidates are keyed by (target, asset) and a sighting only adds its source.
 * Logs carry counts only.
 */
import { sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { featureActive } from '@/personas';
import { linksFromRefs, linksInText, matchAssetItems, type AssetItem, type AssetLink } from '@/engines/vdp/assets';
import { computeVdpGaps } from '@/engines/vdp/gaps';
import { accountMatcher } from '@/projections/run';
import { domainClass } from '@/projections/util';
import { driveUrl, kindFromMime } from '@/projections/assets';
import type { VdpSnapshot } from '@/lib/vdp/types';
import { assetTargets, type DetailTarget } from '@/server/vdp/detail';

import { loadGapEntities, loadVdpRecords } from './vdp';
import { loadPersona } from './persona';
import { upsertCandidates } from './vdp-candidates';
import { projectionStore } from './projections.run';

/** The mirror, my book and the asset targets (my VDPs by account, and engaged accounts without a VDP). */
export async function loadAssetState(db: Db, userId: string): Promise<{ snaps: VdpSnapshot[]; cov: { vdps: ReturnType<typeof computeVdpGaps>['vdps']; unlinked: ReturnType<typeof computeVdpGaps>['unlinked'] }; targets: DetailTarget[]; accounts: Array<{ id: string; name: string }> }> {
  const records = await loadVdpRecords(db, userId);
  const snaps = records.filter((r) => r.snapshot && !r.goneAt && !r.archived).map((r) => r.snapshot!);
  const ents = await loadGapEntities(db, userId);
  const g = computeVdpGaps({ vdps: snaps, accounts: ents.accounts, opps: ents.opps, me: { name: '', email: null }, vdpBaseUrl: null });
  const cov = { vdps: g.vdps, unlinked: g.unlinked };
  return { snaps, cov, targets: assetTargets(cov, snaps, ents.accounts), accounts: ents.accounts };
}

type ItemRow = {
  id: string;
  source: string;
  kind: string;
  external_id: string;
  title: string | null;
  url: string | null;
  body: string | null;
  meta: Record<string, unknown> | null;
  occurred_at: Date;
  last_seen_at: Date;
  channel_id: string | null;
  channel_name: string | null;
  channel_kind: string | null;
  refs: Array<{ kind: string; value: string }> | null;
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const iso = (d: Date | string) => new Date(d).toISOString();

/** Source rows → matcher items (links, the app's own mapping, external domains, a provenance label). */
export function itemsFromRows(
  rows: readonly ItemRow[],
  ctx: {
    drive: ReadonlyMap<string, { title: string | null; url: string | null; mime: string | null; kind: string | null; accountId: string | null; confidence: number | null }>;
    channels: ReadonlyMap<string, { accountId: string; confidence: number }>;
    external: (domain: string) => boolean;
    companyOf: (accountId: string) => string;
  },
): AssetItem[] {
  const out: AssetItem[] = [];
  const titles = new Map([...ctx.drive].map(([id, d]) => [id, { title: d.title, mime: d.mime, url: d.url }]));
  for (const r of rows) {
    const meta = r.meta ?? {};
    const refs = (r.refs ?? []).map((x) => (x.kind === 'drive_file' ? x.value : `url:${x.value}`));
    const domainsOf = () => {
      const emails = [...arr(meta.participants), ...arr(meta.responses)].map((p) => str((p as { email?: unknown }).email)).filter((e): e is string => !!e);
      return [...new Set(emails.map((e) => e.split('@')[1]?.toLowerCase() ?? '').filter((d) => d && ctx.external(d)))];
    };
    const text = [r.title, r.body].filter(Boolean).join(' · ').slice(0, 4000);
    const at = iso(r.occurred_at);
    if (r.source === 'drive') {
      const fileId = str(meta.fileId) ?? r.external_id.split('@')[0] ?? null;
      if (!fileId) continue;
      const d = ctx.drive.get(fileId);
      const mime = str(meta.mimeType) ?? d?.mime ?? null;
      const kind = d?.kind === 'deck' || d?.kind === 'doc' || d?.kind === 'sheet' || d?.kind === 'pdf' ? d.kind : kindFromMime(mime);
      const url = d?.url ?? r.url ?? driveUrl(fileId, kind);
      out.push({
        sourceItemId: r.id,
        source: 'drive',
        title: r.title ?? d?.title ?? null,
        text,
        url,
        at,
        label: 'Drive',
        mapped: d?.accountId ? { accountId: d.accountId, confidence: Math.max(0.7, Math.min(0.9, d.confidence ?? 0.75)), via: `the app maps the file to ${ctx.companyOf(d.accountId)}` } : null,
        domains: [],
        links: [{ url, title: r.title ?? d?.title ?? null, mime }],
      });
      continue;
    }
    const links: AssetLink[] = linksFromRefs(refs, titles);
    if (r.source === 'calendar') {
      for (const a of arr(meta.attachments)) {
        const x = a as { title?: unknown; fileId?: unknown; mimeType?: unknown };
        const fileId = str(x.fileId);
        const title = str(x.title);
        if (!fileId || /notes by gemini/i.test(title ?? '')) continue; // meeting notes are not VDP assets
        const known = ctx.drive.get(fileId);
        links.push({ url: known?.url ?? driveUrl(fileId, kindFromMime(str(x.mimeType))), title: title ?? known?.title ?? null, mime: str(x.mimeType) ?? known?.mime ?? null });
      }
    }
    for (const u of [...arr(meta.urls).map(str).filter((x): x is string => !!x), ...linksInText(`${str(meta.description) ?? ''} ${r.body ?? ''}`)]) if (!links.some((l) => l.url === u)) links.push({ url: u, title: null, mime: null });
    if (!links.length) continue;
    const ch = r.channel_id ? ctx.channels.get(r.channel_id) : undefined;
    const label =
      r.source === 'slack'
        ? r.channel_kind === 'dm' || r.channel_kind === 'group_dm'
          ? 'Slack DM'
          : r.channel_name
            ? `#${r.channel_name}`
            : 'Slack'
        : r.source === 'gmail'
          ? `Gmail · ${(r.title ?? 'mail').slice(0, 80)}`
          : `Calendar · ${(r.title ?? 'meeting').slice(0, 80)}`;
    out.push({
      sourceItemId: r.id,
      source: r.source === 'slack' ? 'slack' : r.source === 'gmail' ? 'gmail' : 'calendar',
      title: r.title,
      text,
      url: r.url,
      at,
      label,
      mapped: ch ? { accountId: ch.accountId, confidence: ch.confidence, via: `the channel is ${ctx.companyOf(ch.accountId)}'s` } : null,
      domains: r.source === 'slack' ? [] : domainsOf(),
      links, // every link of the source (caps audit 2026-11-21: was the first 20); the screen drops what is not an asset
    });
  }
  return out;
}

export interface MatchPassResult {
  items: number;
  candidates: number;
  added: number;
  updated: number;
  /** The newest last_seen_at the pass read (the next pass starts there). */
  through: string | null;
  /** The pass hit its row limit: the next one continues right after `through`, without the overlap. */
  full: boolean;
}

/**
 * One matcher pass over source items seen after `since` (oldest first, at most `limit`). Writes only candidates; no
 * change set is needed (the table is local derived state, like the VDP mirror).
 */
export async function runVdpAssetMatch(db: Db, userId: string, o: { since: Date; now: Date; limit?: number }): Promise<MatchPassResult> {
  const st = await loadAssetState(db, userId);
  if (!st.targets.length) return { items: 0, candidates: 0, added: 0, updated: 0, through: null, full: false };
  const limit = o.limit ?? 500;
  const r = await db.execute<ItemRow>(sql`
    select si.id, si.source::text as source, si.kind::text as kind, si.external_id, si.title, si.url, si.body, si.meta, si.occurred_at, si.last_seen_at,
           si.channel_id, c.name as channel_name, c.kind::text as channel_kind,
           (select json_agg(json_build_object('kind', r.kind, 'value', r.value)) from source_item_refs r where r.source_item_id = si.id) as refs
      from source_items si
      left join channels c on c.id = si.channel_id
     where si.owner_user_id = ${userId}
       and si.source in ('drive', 'slack', 'gmail', 'calendar')
       and si.deleted_upstream_at is null
       and si.last_seen_at > ${o.since.toISOString()}::timestamptz
     order by si.last_seen_at, si.id
     limit ${limit}`);
  const rows = r.rows;
  if (!rows.length) return { items: 0, candidates: 0, added: 0, updated: 0, through: null, full: false };
  const driveIds = new Set<string>();
  for (const x of rows) {
    if (x.source === 'drive') driveIds.add(str(x.meta?.fileId) ?? x.external_id.split('@')[0] ?? '');
    for (const ref of x.refs ?? []) if (ref.kind === 'drive_file') driveIds.add(ref.value.replace(/^drive:/, ''));
    for (const a of arr(x.meta?.attachments)) {
      const f = str((a as { fileId?: unknown }).fileId);
      if (f) driveIds.add(f);
    }
  }
  const ids = [...driveIds].filter(Boolean);
  const drive = new Map<string, { title: string | null; url: string | null; mime: string | null; kind: string | null; accountId: string | null; confidence: number | null }>();
  if (ids.length) {
    const d = await db.execute<{ external_id: string; title: string | null; url: string | null; mime_type: string | null; kind: string | null; account_id: string | null; mapping_confidence: string | null }>(sql`
      select external_id, title, url, mime_type, kind::text as kind, account_id, mapping_confidence from assets
       where owner_user_id = ${userId} and system = 'drive' and external_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    for (const x of d.rows) drive.set(x.external_id, { title: x.title, url: x.url, mime: x.mime_type, kind: x.kind, accountId: x.account_id, confidence: x.mapping_confidence === null ? null : Number(x.mapping_confidence) });
  }
  const ch = await db.execute<{ channel_id: string; account_id: string; confidence: string }>(sql`
    select m.channel_id, m.account_id, m.confidence from channel_account_maps m join channels c on c.id = m.channel_id
     where c.owner_user_id = ${userId} and (m.user_verdict is null or m.user_verdict <> 'rejected')
     order by m.confidence desc`);
  const channels = new Map<string, { accountId: string; confidence: number }>();
  for (const x of ch.rows) if (!channels.has(x.channel_id)) channels.set(x.channel_id, { accountId: x.account_id, confidence: x.confidence === null ? 0.8 : Number(x.confidence) });
  const { matcher, rules } = await accountMatcher(projectionStore(db), userId);
  const names = new Map(st.accounts.map((a) => [a.id, a.name]));
  const items = itemsFromRows(rows, { drive, channels, external: (dom) => domainClass(dom, rules) === 'external', companyOf: (id) => st.targets.find((t) => t.accountId === id)?.companyName ?? names.get(id) ?? 'the account' });
  const drafts = matchAssetItems(items, st.targets, (text, domains) => matcher.resolve(text, domains));
  const res = await upsertCandidates(db, userId, drafts, { origin: 'matcher', now: o.now });
  const through = rows.map((x) => iso(x.last_seen_at)).sort().at(-1) ?? null;
  return { items: items.length, candidates: drafts.length, added: res.added, updated: res.updated, through, full: rows.length >= limit };
}

/** Overlap with the previous pass: a scanner transaction that started earlier but committed later is still read. */
const OVERLAP_MS = 10 * 60_000;
/** A fresh worker looks this far back (older history is what "Find assets" researches). */
const FIRST_LOOKBACK_MS = 3 * 86_400_000;

/** The worker hook: one pass every `everyMs`, from the last pass's watermark (in memory; a restart looks 3 days back). */
export function vdpAssetsHook(db: Db, userId: string, log: (msg: string, f?: Record<string, unknown>) => void, everyMs = 5 * 60_000) {
  let watermark: Date | null = null;
  let full = false;
  return {
    name: 'vdp.assets',
    everyMs,
    run: async (now: Date) => {
      const since = watermark ? new Date(watermark.getTime() - (full ? 0 : OVERLAP_MS)) : new Date(now.getTime() - FIRST_LOOKBACK_MS);
      try {
        // D-55: VDP is a persona feature; while it is inactive (the AE's preset) the matcher does nothing. The watermark
        // stays, so activating it picks up from where it stopped (and the first pass looks back as usual).
        if (!featureActive(await loadPersona(db, userId), 'vdp')) return;
        const r = await runVdpAssetMatch(db, userId, { since, now });
        if (r.through) watermark = new Date(r.through);
        full = r.full;
        if (r.added || r.updated) log('vdp.assets: matched new sources to VDPs', { items: r.items, added: r.added, updated: r.updated });
      } catch (err) {
        log('vdp.assets: pass failed', { code: (err as Error).name });
      }
    },
  };
}
